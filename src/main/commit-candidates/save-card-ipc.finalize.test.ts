// SC-WP-3E — fleet-adhoc mark-done finalization channel.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/save-card-ipc.finalize.test.js
//
// Proves the DISTINCT explicit fleet mark-done channel: it pins
// `finalizationKind='fleet-adhoc'` with NULL plan attribution itself, drives the
// shared WP-3C `finalizePackage` core, and always surfaces the captured
// `boundary_ref`. An in-memory store / controllable ref writer / deterministic
// freezer mirror the WP-3A/3B accessor semantics without touching git or the DB.

import assert from 'node:assert/strict';

import {
  registerSaveCardFinalizeIpc,
  SaveCardFinalizeRefusalError,
  SAVECARD_FINALIZE_CHANNEL,
  type FleetAdhocBoundaryContext,
  type IpcLike,
  type SaveCardFinalizeRoutes,
  type SaveCardFleetAdhocMarkDoneResponse,
} from './save-card-ipc';
import {
  type FinalizationStore,
  type FinalizationRefWriter,
  type MemberFreezer,
} from './finalization-service';
import type { CommitRepresentationEntry } from './commit-representation';
import type { EncodedGitPath } from '../../shared/commit-candidates';
import { finalizationRef } from '../git-checkpoints/finalization-refs';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void { tests.push({ name, run }); }

type Handler = (event: unknown, ...args: unknown[]) => unknown;

class FakeIpc implements IpcLike {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, listener: Handler): void { this.handlers.set(channel, listener); }
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  }
}

// ── in-memory finalization store (mirrors the WP-3A/3B accessor semantics) ─────

interface FinalizationRow {
  id: string; packageId: string; packageRevision: number;
  boundaryStatus: string; lifecycleStatus: string; checkpointOid: string | null;
  memberManifestJson: string; supersededByFinalizationId: string | null;
  boundaryRef: string | null; finalizationKind: string; planId: string | null; planItemId: string | null;
}

class FakeStore implements FinalizationStore {
  rows = new Map<string, FinalizationRow>();
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
    this.rows.set(row.id, { ...row });
  }
  supersedePackageFinalization(id: string, supersededBy: string): void {
    const r = this.rows.get(id);
    if (!r) throw new Error(`no row ${id}`);
    r.lifecycleStatus = 'superseded';
    r.supersededByFinalizationId = supersededBy;
  }
  setPackageFinalizationBoundaryStatus(id: string, status: never): void {
    const r = this.rows.get(id);
    if (!r) throw new Error(`no row ${id}`);
    r.boundaryStatus = status as unknown as string;
  }
  getPlanWorkPackage(): never { return null as never; }
  upsertPlanWorkPackage(): void { throw new Error('fleet-adhoc must never touch a plan work package'); }
  transact<T>(fn: () => T): T { return fn(); }
}

function makeWriter(store: FakeStore, opts: { fail?: boolean } = {}): FinalizationRefWriter & { created: Map<string, string> } {
  const created = new Map<string, string>();
  const writer = (async (ref: string, oid: string) => {
    if (opts.fail) return { ok: false, error: 'forced ref failure' };
    created.set(ref, oid);
    return { ok: true };
  }) as FinalizationRefWriter & { created: Map<string, string> };
  writer.created = created;
  return writer;
}

const OID_A = 'a'.repeat(40);

function encPath(rel: string): EncodedGitPath {
  return { pathBytesBase64: Buffer.from(rel, 'utf8').toString('base64'), displayPath: rel, utf8Clean: true };
}
function member(rel: string): CommitRepresentationEntry {
  const p = encPath(rel);
  return { path: p, commitPathspecs: [p], expectedWorktreeState: 'present', rawWorktreeBlobOid: 'raw-' + rel };
}
const fakeFreeze: MemberFreezer = async (entry) => ({
  expectedState: entry.expectedWorktreeState,
  rawBlobOid: entry.rawWorktreeBlobOid,
  commitBlobOid: 'commit-' + Buffer.from(entry.path.pathBytesBase64, 'base64').toString('utf8'),
  commitMode: '100644',
});

/** A finalize context for `pkg-fleet`. Note: NO finalizationKind / plan fields —
 *  the channel pins those, so the provider physically cannot supply them. */
function boundaryContext(over: Partial<FleetAdhocBoundaryContext> = {}): FleetAdhocBoundaryContext {
  return {
    packageId: 'pkg-fleet', repositoryKey: 'repo-1', finalizedBy: 'human-ipc',
    checkpointTurnId: 'turn-1', boundaryOid: OID_A, contractVersion: 1,
    createdFromWorkspaceId: 'ws-1', members: [member('src/a.ts')],
    repoRoot: '/unused', pinnedHeadOid: null,
    ...over,
  };
}

function makeRoutes(store: FakeStore, opts: { fail?: boolean } = {}, over: Partial<FleetAdhocBoundaryContext> = {}): SaveCardFinalizeRoutes {
  return {
    resolveBoundary: async (req) => boundaryContext({ packageId: req.packageId, ...over }),
    finalizeDeps: {
      store,
      writeRef: makeWriter(store, opts),
      freeze: fakeFreeze,
      now: () => 100,
      newId: () => 'fin-fleet',
    },
  };
}

// ── ACCEPT: fleet-adhoc mark-done creates a distinct finalization with boundary_ref

test('fleet-adhoc mark-done creates a distinct finalization that captures boundary_ref', async () => {
  const ipc = new FakeIpc();
  const store = new FakeStore();
  registerSaveCardFinalizeIpc(ipc, () => makeRoutes(store));

  const res = (await ipc.invoke(
    SAVECARD_FINALIZE_CHANNEL,
    { packageId: 'pkg-fleet', ignoredRendererField: 'not-forwarded' },
  )) as Exclude<SaveCardFleetAdhocMarkDoneResponse, { ok: false }>;

  assert.equal(res.finalizationKind, 'fleet-adhoc');
  assert.equal(res.outcome, 'created');
  assert.equal(res.packageId, 'pkg-fleet');
  assert.equal(res.packageRevision, 1);
  // boundary_ref is ALWAYS captured.
  assert.equal(res.boundaryRef, finalizationRef('pkg-fleet', 1));
  assert.equal(res.boundaryStatus, 'ready');

  // A distinct finalization row exists, with NULL plan attribution.
  const row = store.rows.get('fin-fleet');
  assert.ok(row, 'the mark-done minted a finalization row');
  assert.equal(row!.finalizationKind, 'fleet-adhoc');
  assert.equal(row!.planId, null);
  assert.equal(row!.planItemId, null);
  assert.equal(row!.boundaryRef, finalizationRef('pkg-fleet', 1));
});

test('the mark-done channel is DISTINCT — it registers its own mutating channel name', () => {
  const ipc = new FakeIpc();
  registerSaveCardFinalizeIpc(ipc, () => null);
  assert.equal(SAVECARD_FINALIZE_CHANNEL, 'savecard:markDoneFleetAdhoc');
  assert.deepEqual([...ipc.handlers.keys()], ['savecard:markDoneFleetAdhoc']);
  // It is not the read-only inventory channel.
  assert.notEqual(SAVECARD_FINALIZE_CHANNEL, 'savecard:getInventory');
});

test('a boundary-unavailable outcome still surfaces the ref it could not pin', async () => {
  const ipc = new FakeIpc();
  const store = new FakeStore();
  registerSaveCardFinalizeIpc(ipc, () => makeRoutes(store, { fail: true }));

  const res = (await ipc.invoke(
    SAVECARD_FINALIZE_CHANNEL,
    { packageId: 'pkg-fleet' },
  )) as Exclude<SaveCardFleetAdhocMarkDoneResponse, { ok: false }>;

  assert.equal(res.finalizationKind, 'fleet-adhoc');
  assert.equal(res.outcome, 'boundary-unavailable');
  assert.equal(res.boundaryStatus, 'unavailable');
  // Even when the pin fails, boundary_ref is captured (the ref it failed to create).
  assert.equal(res.boundaryRef, finalizationRef('pkg-fleet', 1));
});

test('rejects a malformed mark-done request before resolving the boundary', async () => {
  const ipc = new FakeIpc();
  let resolved = 0;
  registerSaveCardFinalizeIpc(ipc, () => ({
    resolveBoundary: async (req) => { resolved++; return boundaryContext({ packageId: req.packageId }); },
  }));

  await assert.rejects(() => ipc.invoke(SAVECARD_FINALIZE_CHANNEL, null), /non-empty packageId/i);
  await assert.rejects(() => ipc.invoke(SAVECARD_FINALIZE_CHANNEL, { packageId: '' }), /non-empty packageId/i);
  assert.equal(resolved, 0);
});

test('an unwired finalization engine answers unavailable honestly', async () => {
  const ipc = new FakeIpc();
  registerSaveCardFinalizeIpc(ipc, () => null);
  await assert.rejects(
    () => ipc.invoke(SAVECARD_FINALIZE_CHANNEL, { packageId: 'pkg-fleet' }),
    /unavailable|bootstrapping/i,
  );
});

test('a no-repository boundary failure returns a typed refusal and never finalizes', async () => {
  const ipc = new FakeIpc();
  const store = new FakeStore();
  registerSaveCardFinalizeIpc(ipc, () => ({
    resolveBoundary: async () => {
      throw new SaveCardFinalizeRefusalError(
        "No git repository — cannot pin/commit from workspace 'Computer Root'.",
        'save-card-no-repository',
        '54ad9887',
        'Computer Root',
      );
    },
    finalizeDeps: {
      store,
      writeRef: makeWriter(store),
      freeze: fakeFreeze,
      now: () => 100,
      newId: () => 'must-not-finalize',
    },
  }));

  const response = await ipc.invoke(
    SAVECARD_FINALIZE_CHANNEL,
    { packageId: 'component:proposal' },
  );
  assert.deepEqual(response, {
    ok: false,
    code: 'save-card-no-repository',
    message: "No git repository — cannot pin/commit from workspace 'Computer Root'.",
    workspaceId: '54ad9887',
    workspaceTitle: 'Computer Root',
  });
  assert.equal(store.rows.size, 0, 'a typed refusal never reaches finalization');
});

test('an unknown workspace boundary failure is also returned as a typed refusal', async () => {
  const ipc = new FakeIpc();
  registerSaveCardFinalizeIpc(ipc, () => ({
    resolveBoundary: async () => {
      throw new SaveCardFinalizeRefusalError(
        'Cannot pin this package because it references an unknown workspace: missing-ws.',
        'save-card-unknown-workspace',
        'missing-ws',
        'missing-ws',
      );
    },
  }));

  assert.deepEqual(
    await ipc.invoke(SAVECARD_FINALIZE_CHANNEL, { packageId: 'pkg-orphaned' }),
    {
      ok: false,
      code: 'save-card-unknown-workspace',
      message: 'Cannot pin this package because it references an unknown workspace: missing-ws.',
      workspaceId: 'missing-ws',
      workspaceTitle: 'missing-ws',
    },
  );
});

test('unexpected boundary failures still reject the IPC invocation', async () => {
  const ipc = new FakeIpc();
  registerSaveCardFinalizeIpc(ipc, () => ({
    resolveBoundary: async () => { throw new Error('unexpected freezer failure'); },
  }));
  await assert.rejects(
    () => ipc.invoke(SAVECARD_FINALIZE_CHANNEL, { packageId: 'pkg-fleet' }),
    /unexpected freezer failure/,
  );
});

(async () => {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      console.log(`  ✓ ${entry.name}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${entry.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} save-card-ipc.finalize tests passed`);
})();
