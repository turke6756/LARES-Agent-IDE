// Save-card SC-WP-3C — finalization service: failure-ordered sequence, boundary-
// unavailable compensation, and the mechanically-defined re-finalization.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/finalization-service.test.js
//
// The ordering / re-finalization / compensation proofs drive the service with an
// in-memory store, a controllable ref writer, and a deterministic member freezer —
// each branch (create / existing-unchanged / superseded / reattach / boundary-
// unavailable / crash-before-txn) is exercised against fakes that faithfully mirror
// the WP-3A/3B accessor semantics. ONE test drives the REAL WP-2J temp-index freeze
// in a throwaway git repo so the frozen manifest's raw + clean-filtered oids are
// genuine, not a fake's echo.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolveInternalGit } from '../git/git-runtime';
import { runGit as realRunGit, runGitBytes as realRunGitBytes } from '../git-checkpoints/git-command';
import type { CommitRepresentationEntry } from './commit-representation';
import type { EncodedGitPath } from '../../shared/commit-candidates';
import {
  finalizePackage,
  finalizeSaveUnit,
  type FinalizationStore,
  type FinalizePackageRequest,
  type FinalizationRefWriter,
  type MemberFreezer,
  type SaveIntentFinalizationStore,
} from './finalization-service';
import type { SaveIntentFinalization } from '../database';
import { finalizationRef } from '../git-checkpoints/finalization-refs';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

// A shared event log per test proves ORDERING (ref write precedes row insert).
type Ev = { kind: 'ref'; ref: string; oid: string } | { kind: 'insert'; id: string } | { kind: 'supersede'; id: string; by: string } | { kind: 'flip-done'; id: string } | { kind: 'set-status'; id: string; status: string };

interface FinalizationRow {
  id: string; packageId: string; packageRevision: number;
  boundaryStatus: string; lifecycleStatus: string; checkpointOid: string | null;
  memberManifestJson: string; supersededByFinalizationId: string | null;
  boundaryRef: string | null; finalizationKind: string; planItemId: string | null;
}

class FakeStore implements FinalizationStore {
  rows = new Map<string, FinalizationRow>();
  workPackages = new Map<string, { id: string; state: string; updatedAt: number }>();
  log: Ev[] = [];
  failNextTransact = false;

  getActivePackageFinalization(packageId: string) {
    const active = [...this.rows.values()]
      .filter((r) => r.packageId === packageId && r.lifecycleStatus === 'active')
      .sort((a, b) => b.packageRevision - a.packageRevision);
    return (active[0] ?? null) as never;
  }
  maxPackageRevision(packageId: string): number {
    return [...this.rows.values()]
      .filter((r) => r.packageId === packageId)
      .reduce((mx, r) => Math.max(mx, r.packageRevision), 0);
  }
  insertPackageFinalization(f: never): void {
    const row = f as unknown as FinalizationRow;
    if (this.rows.has(row.id)) throw new Error(`duplicate id ${row.id}`);
    for (const r of this.rows.values()) {
      if (r.packageId === row.packageId && r.packageRevision === row.packageRevision) {
        throw new Error('unique (package_id, package_revision) violated');
      }
    }
    this.rows.set(row.id, { ...row });
    this.log.push({ kind: 'insert', id: row.id });
  }
  supersedePackageFinalization(id: string, supersededBy: string): void {
    const r = this.rows.get(id);
    if (!r) throw new Error(`no row ${id}`);
    r.lifecycleStatus = 'superseded';
    r.supersededByFinalizationId = supersededBy;
    this.log.push({ kind: 'supersede', id, by: supersededBy });
  }
  setPackageFinalizationBoundaryStatus(id: string, status: never): void {
    const r = this.rows.get(id);
    if (!r) throw new Error(`no row ${id}`);
    r.boundaryStatus = status as unknown as string;
    this.log.push({ kind: 'set-status', id, status: status as unknown as string });
  }
  getPlanWorkPackage(id: string): never {
    return (this.workPackages.get(id) ?? null) as never;
  }
  upsertPlanWorkPackage(pkg: never): void {
    const p = pkg as unknown as { id: string; state: string; updatedAt: number };
    this.workPackages.set(p.id, { id: p.id, state: p.state, updatedAt: p.updatedAt });
    if (p.state === 'done') this.log.push({ kind: 'flip-done', id: p.id });
  }
  transact<T>(fn: () => T): T {
    if (this.failNextTransact) {
      this.failNextTransact = false;
      throw new Error('simulated crash before/within txn');
    }
    // Snapshot for all-or-nothing emulation.
    const snapRows = new Map([...this.rows].map(([k, v]) => [k, { ...v }]));
    const snapWp = new Map([...this.workPackages].map(([k, v]) => [k, { ...v }]));
    const snapLogLen = this.log.length;
    try {
      return fn();
    } catch (err) {
      this.rows = snapRows;
      this.workPackages = snapWp;
      this.log.length = snapLogLen;
      throw err;
    }
  }
}

/** A ref writer that records every write and can be forced to fail. Mirrors the
 *  idempotent force-to-computed-oid contract: re-writing the same ref is fine. */
function makeWriter(store: FakeStore, opts: { fail?: boolean } = {}): FinalizationRefWriter & { created: Map<string, string> } {
  const created = new Map<string, string>();
  const writer = (async (ref: string, oid: string) => {
    if (opts.fail) return { ok: false, error: 'forced ref failure' };
    created.set(ref, oid);
    store.log.push({ kind: 'ref', ref, oid });
    return { ok: true };
  }) as FinalizationRefWriter & { created: Map<string, string> };
  writer.created = created;
  return writer;
}

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

function encPath(rel: string): EncodedGitPath {
  return { pathBytesBase64: Buffer.from(rel, 'utf8').toString('base64'), displayPath: rel, utf8Clean: true };
}
function member(rel: string): CommitRepresentationEntry {
  const p = encPath(rel);
  return { path: p, commitPathspecs: [p], expectedWorktreeState: 'present', rawWorktreeBlobOid: 'raw-' + rel };
}

/** A deterministic freezer echoing a stable representation per path. */
const fakeFreeze: MemberFreezer = async (entry) => ({
  expectedState: entry.expectedWorktreeState,
  rawBlobOid: entry.rawWorktreeBlobOid,
  commitBlobOid: 'commit-' + Buffer.from(entry.path.pathBytesBase64, 'base64').toString('utf8'),
  commitMode: '100644',
});

function planRequest(over: Partial<FinalizePackageRequest> = {}): FinalizePackageRequest {
  return {
    packageId: 'pkg-1', repositoryKey: 'repo-1', finalizationKind: 'plan-package',
    planId: 'plan-1', planItemId: 'wp-1', finalizedBy: 'human-ipc',
    checkpointTurnId: 'turn-1', boundaryOid: OID_A, contractVersion: 1,
    createdFromWorkspaceId: 'ws-1', members: [member('src/a.ts')],
    repoRoot: '/unused', pinnedHeadOid: null,
    ...over,
  };
}

test('v2 task finalization preserves freeze-ref-transaction ordering without a legacy package row', async () => {
  const rows = new Map<string, SaveIntentFinalization>();
  const events: string[] = [];
  const store: SaveIntentFinalizationStore = {
    getActive: (id) => [...rows.values()].find((row) => row.saveUnitId === id && row.lifecycleStatus === 'active') ?? null,
    maxRevision: (id) => Math.max(0, ...[...rows.values()].filter((row) => row.saveUnitId === id).map((row) => row.revision)),
    insert: (row) => { events.push(`insert:${row.id}`); rows.set(row.id, structuredClone(row)); },
    supersede: (id, by) => { const row = rows.get(id)!; rows.set(id, { ...row, lifecycleStatus: 'superseded', supersededByFinalizationId: by }); },
    setBoundaryStatus: (id, status) => { rows.set(id, { ...rows.get(id)!, boundaryStatus: status }); },
    transact: (fn) => fn(),
  };
  const result = await finalizeSaveUnit({
    saveUnitId: 'intent-1', saveUnitKind: 'task', repositoryKey: 'repo-1',
    finalizedBy: 'human-ipc', boundaryOid: OID_A, members: [member('src/a.ts')],
    repoRoot: '/unused', pinnedHeadOid: null,
  }, {
    store, freeze: fakeFreeze, now: () => 100, newId: () => 'intent-fin-1',
    writeRef: async () => { events.push('ref'); return { ok: true }; },
  });
  assert.equal(result.finalization.saveUnitKind, 'task');
  assert.equal(result.finalization.revision, 1);
  assert.deepEqual(events, ['ref', 'insert:intent-fin-1']);
});

// ── ordering + fresh create ──────────────────────────────────────────────────────

test('ordering: ref is created BEFORE the row insert, and the row is ready', async () => {
  const store = new FakeStore();
  const writeRef = makeWriter(store);
  const res = await finalizePackage(planRequest(), { store, writeRef, freeze: fakeFreeze, now: () => 100, newId: () => 'fin-a' });
  assert.equal(res.outcome, 'created');
  assert.equal(res.finalization.boundaryStatus, 'ready');
  assert.equal(res.finalization.packageRevision, 1);
  assert.equal(res.finalization.boundaryRef, finalizationRef('pkg-1', 1));
  const refIdx = store.log.findIndex((e) => e.kind === 'ref');
  const insIdx = store.log.findIndex((e) => e.kind === 'insert');
  assert.ok(refIdx >= 0 && insIdx >= 0 && refIdx < insIdx, 'ref write must precede row insert');
});

test('plan-package create flips the work package to done in the same txn', async () => {
  const store = new FakeStore();
  store.workPackages.set('wp-1', { id: 'wp-1', state: 'executing', updatedAt: 0 });
  const writeRef = makeWriter(store);
  await finalizePackage(planRequest(), { store, writeRef, freeze: fakeFreeze, now: () => 100, newId: () => 'fin-a' });
  assert.equal(store.workPackages.get('wp-1')?.state, 'done');
  assert.ok(store.log.some((e) => e.kind === 'flip-done' && e.id === 'wp-1'));
});

test('fleet-adhoc create never touches a plan work package', async () => {
  const store = new FakeStore();
  const writeRef = makeWriter(store);
  const res = await finalizePackage(
    planRequest({ finalizationKind: 'fleet-adhoc', planId: null, planItemId: null, packageId: 'pkg-fleet' }),
    { store, writeRef, freeze: fakeFreeze, now: () => 100, newId: () => 'fin-f' },
  );
  assert.equal(res.outcome, 'created');
  assert.equal(res.finalization.planItemId, null);
  assert.ok(!store.log.some((e) => e.kind === 'flip-done'));
});

// ── boundary-unavailable compensation ─────────────────────────────────────────────

test('ref-creation failure never inserts a ready row and never flips done', async () => {
  const store = new FakeStore();
  store.workPackages.set('wp-1', { id: 'wp-1', state: 'executing', updatedAt: 0 });
  const writeRef = makeWriter(store, { fail: true });
  const res = await finalizePackage(planRequest(), { store, writeRef, freeze: fakeFreeze, now: () => 100, newId: () => 'fin-bad' });
  assert.equal(res.outcome, 'boundary-unavailable');
  assert.equal(res.finalization.boundaryStatus, 'unavailable');
  assert.equal(res.finalization.lifecycleStatus, 'abandoned');
  assert.ok(res.finalization.failureReason);
  // done NEVER flips on an unavailable boundary.
  assert.equal(store.workPackages.get('wp-1')?.state, 'executing');
  // no active/ready row exists for the package.
  assert.equal(store.getActivePackageFinalization('pkg-1'), null);
});

test('a failed attempt does not supersede the prior active ready finalization', async () => {
  const store = new FakeStore();
  const okWriter = makeWriter(store);
  const first = await finalizePackage(planRequest(), { store, writeRef: okWriter, freeze: fakeFreeze, now: () => 100, newId: () => 'fin-1' });
  assert.equal(first.outcome, 'created');
  // A DIFFERING re-finalize whose ref creation fails must leave the prior row active.
  const failWriter = makeWriter(store, { fail: true });
  const second = await finalizePackage(
    planRequest({ boundaryOid: OID_B }),
    { store, writeRef: failWriter, freeze: fakeFreeze, now: () => 200, newId: () => 'fin-2' },
  );
  assert.equal(second.outcome, 'boundary-unavailable');
  const active = store.getActivePackageFinalization('pkg-1') as unknown as FinalizationRow | null;
  assert.equal(active?.id, 'fin-1');
  assert.equal(active?.boundaryStatus, 'ready');
});

// ── re-finalization ────────────────────────────────────────────────────────────

test('byte-identical re-finalize returns the existing finalization — no bump, no supersede', async () => {
  const store = new FakeStore();
  const writeRef = makeWriter(store);
  const first = await finalizePackage(planRequest(), { store, writeRef, freeze: fakeFreeze, now: () => 100, newId: () => 'fin-1' });
  const before = store.log.length;
  const second = await finalizePackage(planRequest(), { store, writeRef, freeze: fakeFreeze, now: () => 200, newId: () => 'fin-2' });
  assert.equal(second.outcome, 'existing-unchanged');
  assert.equal(second.finalization.id, first.finalization.id);
  assert.equal(second.finalization.packageRevision, 1);
  assert.equal(store.maxPackageRevision('pkg-1'), 1);
  // No ref write, no supersede, no second insert on the no-op path.
  assert.equal(store.log.length, before);
});

test('differing re-finalize bumps the revision and supersedes the prior row atomically', async () => {
  const store = new FakeStore();
  const writeRef = makeWriter(store);
  await finalizePackage(planRequest(), { store, writeRef, freeze: fakeFreeze, now: () => 100, newId: () => 'fin-1' });
  const res = await finalizePackage(
    planRequest({ boundaryOid: OID_B }),
    { store, writeRef, freeze: fakeFreeze, now: () => 200, newId: () => 'fin-2' },
  );
  assert.equal(res.outcome, 'superseded');
  assert.equal(res.finalization.packageRevision, 2);
  assert.equal(res.finalization.boundaryRef, finalizationRef('pkg-1', 2));
  const prior = store.rows.get('fin-1')!;
  assert.equal(prior.lifecycleStatus, 'superseded');
  assert.equal(prior.supersededByFinalizationId, 'fin-2');
  // supersede + insert both landed (atomic same-txn); only one active row remains.
  assert.equal((store.getActivePackageFinalization('pkg-1') as unknown as FinalizationRow).id, 'fin-2');
});

test('a manifest change (same boundary oid) is treated as differing and bumps the revision', async () => {
  const store = new FakeStore();
  const writeRef = makeWriter(store);
  await finalizePackage(planRequest(), { store, writeRef, freeze: fakeFreeze, now: () => 100, newId: () => 'fin-1' });
  const res = await finalizePackage(
    planRequest({ members: [member('src/a.ts'), member('src/b.ts')] }),
    { store, writeRef, freeze: fakeFreeze, now: () => 200, newId: () => 'fin-2' },
  );
  assert.equal(res.outcome, 'superseded');
  assert.equal(res.finalization.packageRevision, 2);
});

test('member order does not affect identity — a reordered manifest is byte-identical', async () => {
  const store = new FakeStore();
  const writeRef = makeWriter(store);
  await finalizePackage(
    planRequest({ members: [member('src/a.ts'), member('src/b.ts')] }),
    { store, writeRef, freeze: fakeFreeze, now: () => 100, newId: () => 'fin-1' },
  );
  const res = await finalizePackage(
    planRequest({ members: [member('src/b.ts'), member('src/a.ts')] }),
    { store, writeRef, freeze: fakeFreeze, now: () => 200, newId: () => 'fin-2' },
  );
  assert.equal(res.outcome, 'existing-unchanged');
  assert.equal(res.finalization.id, 'fin-1');
});

// ── retry-idempotency (crash after ref creation, before the txn) ──────────────────

test('retry after ref-before-txn crash resolves to the same ref and completes once', async () => {
  const store = new FakeStore();
  const writeRef = makeWriter(store);
  // First attempt: ref gets created, then the txn "crashes" (throws) → NO row committed.
  store.failNextTransact = true;
  await assert.rejects(
    finalizePackage(planRequest(), { store, writeRef, freeze: fakeFreeze, now: () => 100, newId: () => 'fin-crash' }),
  );
  assert.equal(store.maxPackageRevision('pkg-1'), 0, 'no row committed by the crashed attempt');
  assert.ok(writeRef.created.has(finalizationRef('pkg-1', 1)), 'ref was force-created before the crash');
  // Retry: max is unchanged → revision 1 again → same ref (idempotent) → txn completes.
  const retry = await finalizePackage(planRequest(), { store, writeRef, freeze: fakeFreeze, now: () => 200, newId: () => 'fin-final' });
  assert.equal(retry.outcome, 'created');
  assert.equal(retry.finalization.packageRevision, 1);
  assert.equal(store.rows.size, 1);
});

// ── reattach a downgraded (ready→unavailable) row on identical re-finalize ─────────

test('identical re-finalize over a downgraded active row re-creates the ref and restores ready', async () => {
  const store = new FakeStore();
  store.workPackages.set('wp-1', { id: 'wp-1', state: 'executing', updatedAt: 0 });
  const writeRef = makeWriter(store);
  await finalizePackage(planRequest(), { store, writeRef, freeze: fakeFreeze, now: () => 100, newId: () => 'fin-1' });
  // Simulate the startup reconciler downgrading the ready row (ref vanished).
  store.rows.get('fin-1')!.boundaryStatus = 'unavailable';
  store.workPackages.set('wp-1', { id: 'wp-1', state: 'executing', updatedAt: 0 }); // pretend not-yet-done
  const res = await finalizePackage(planRequest(), { store, writeRef, freeze: fakeFreeze, now: () => 300, newId: () => 'fin-2' });
  assert.equal(res.outcome, 'reattached-ready');
  assert.equal(res.finalization.id, 'fin-1');
  assert.equal(store.rows.get('fin-1')!.boundaryStatus, 'ready');
  assert.equal(store.maxPackageRevision('pkg-1'), 1, 'no new revision on reattach');
  assert.equal(store.workPackages.get('wp-1')?.state, 'done', 'done restored with the ready boundary');
});

test('reattach failure leaves the row unavailable and reports incomplete', async () => {
  const store = new FakeStore();
  const okWriter = makeWriter(store);
  await finalizePackage(planRequest(), { store, writeRef: okWriter, freeze: fakeFreeze, now: () => 100, newId: () => 'fin-1' });
  store.rows.get('fin-1')!.boundaryStatus = 'unavailable';
  const failWriter = makeWriter(store, { fail: true });
  const res = await finalizePackage(planRequest(), { store, writeRef: failWriter, freeze: fakeFreeze, now: () => 300, newId: () => 'fin-2' });
  assert.equal(res.outcome, 'boundary-unavailable');
  assert.equal(store.rows.get('fin-1')!.boundaryStatus, 'unavailable');
});

// ── validation ────────────────────────────────────────────────────────────────

test('a plan-package finalize requires plan attribution; fleet-adhoc rejects it', async () => {
  const store = new FakeStore();
  const writeRef = makeWriter(store);
  await assert.rejects(finalizePackage(planRequest({ planId: null }), { store, writeRef, freeze: fakeFreeze }));
  await assert.rejects(finalizePackage(
    planRequest({ finalizationKind: 'fleet-adhoc', planId: 'plan-1', planItemId: null }),
    { store, writeRef, freeze: fakeFreeze },
  ));
});

test('a duplicate path in the manifest is rejected before any ref write', async () => {
  const store = new FakeStore();
  const writeRef = makeWriter(store);
  await assert.rejects(finalizePackage(
    planRequest({ members: [member('src/a.ts'), member('src/a.ts')] }),
    { store, writeRef, freeze: fakeFreeze },
  ));
  assert.equal(store.log.length, 0);
});

test('an invalid boundary oid is rejected', async () => {
  const store = new FakeStore();
  const writeRef = makeWriter(store);
  await assert.rejects(finalizePackage(planRequest({ boundaryOid: 'nope' }), { store, writeRef, freeze: fakeFreeze }));
});

// ── real WP-2J temp-index freeze ─────────────────────────────────────────────────

let EXE = '';
const trash: string[] = [];
function mkRepo(): { repo: string; head: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-finsvc-'));
  trash.push(repo);
  const g = (args: string[]) => execFileSync(EXE, args, { cwd: repo }).toString();
  g(['init', '-q']);
  g(['config', 'user.email', 't@lares.local']);
  g(['config', 'user.name', 'Lares Test']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'c1']);
  const head = g(['rev-parse', 'HEAD']).trim();
  // A dirty, present worktree file to freeze.
  fs.writeFileSync(path.join(repo, 'src.txt'), 'hello world\n');
  return { repo, head };
}

test('the default freeze computes a real raw + clean-filtered manifest via the temp index', async () => {
  const { repo, head } = mkRepo();
  const store = new FakeStore();
  const writeRef = makeWriter(store);
  const p = encPath('src.txt');
  const entry: CommitRepresentationEntry = {
    path: p, commitPathspecs: [p], expectedWorktreeState: 'present', rawWorktreeBlobOid: null,
  };
  const res = await finalizePackage(
    planRequest({
      packageId: 'pkg-real', planItemId: 'wp-real', members: [entry],
      repoRoot: repo, pinnedHeadOid: head, boundaryOid: head, gitExe: EXE,
      runGit: realRunGit, runGitBytes: realRunGitBytes,
    }),
    { store, writeRef, freeze: undefined, now: () => 100, newId: () => 'fin-real' },
  );
  assert.equal(res.outcome, 'created');
  const manifest = JSON.parse(res.memberManifestJson) as Array<{ pathBytesBase64: string; commitBlobOid: string | null; commitMode: string | null }>;
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].pathBytesBase64, p.pathBytesBase64);
  // The clean-filtered oid must equal git's own hash-object for the worktree file.
  const expected = execFileSync(EXE, ['hash-object', 'src.txt'], { cwd: repo }).toString().trim();
  assert.equal(manifest[0].commitBlobOid, expected);
  assert.equal(manifest[0].commitMode, '100644');
});

// ── runner ──────────────────────────────────────────────────────────────────────

(async () => {
  const internal = await resolveInternalGit();
  if (!internal) {
    console.error('  SKIP — no compatible git resolved; WP-3C freeze test needs real git.');
    process.exit(1);
  }
  EXE = internal.execPath;

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  for (const d of trash.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
