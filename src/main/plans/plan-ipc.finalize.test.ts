// Save-card SC-WP-3D — plan-package `done` finalization wiring.
//
//   npm run build:main
//   node dist/main/main/plans/plan-ipc.finalize.test.js
//
// WP-3D is wiring, not machinery: the explicit plan-item `done` transition must mint
// a `finalization_kind='plan-package'` finalization through the WP-3C service, deriving
// planId + workspace from the work package's own row and forwarding the caller-supplied
// boundary oid + members. These tests prove the request WP-3D builds and — driving the
// REAL WP-3C service against an in-memory store — that `done` actually creates a
// plan-package finalization AND flips the work package to `done` in the same txn.
// (Eligibility / member computation are proven in WP-3C + the 3G integration, not here.)

import assert from 'node:assert/strict';

import {
  finalizePlanItemDone,
  planPackageId,
  type FinalizePlanItemDoneRequest,
} from './plan-ipc';
import {
  finalizePackage,
  type FinalizationStore,
  type FinalizePackageRequest,
  type FinalizePackageResult,
  type FinalizationRefWriter,
  type MemberFreezer,
} from '../commit-candidates/finalization-service';
import { finalizationRef } from '../git-checkpoints/finalization-refs';
import type { CommitRepresentationEntry } from '../commit-candidates/commit-representation';
import type { EncodedGitPath } from '../../shared/commit-candidates';
import type { PlanWorkPackage, PackageFinalization, FinalizationBoundaryStatus } from '../database';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

const OID_A = 'a'.repeat(40);

function encPath(rel: string): EncodedGitPath {
  return { pathBytesBase64: Buffer.from(rel, 'utf8').toString('base64'), displayPath: rel, utf8Clean: true };
}
function member(rel: string): CommitRepresentationEntry {
  const p = encPath(rel);
  return { path: p, commitPathspecs: [p], expectedWorktreeState: 'present', rawWorktreeBlobOid: 'raw-' + rel };
}

function workPackage(over: Partial<PlanWorkPackage> = {}): PlanWorkPackage {
  return {
    id: 'wp-1', workspaceId: 'ws-1', planId: 'plan-1', title: 'Do the thing',
    acceptanceCondition: null, state: 'executing', assigneeAgentId: null,
    revision: 1, createdAt: 0, updatedAt: 0,
    ...over,
  };
}

function doneRequest(over: Partial<FinalizePlanItemDoneRequest> = {}): FinalizePlanItemDoneRequest {
  return {
    planItemId: 'wp-1', repositoryKey: 'repo-1', boundaryOid: OID_A,
    members: [member('src/a.ts')], checkpointTurnId: 'turn-1', finalizedBy: 'human-ipc',
    contractVersion: 1, repoRoot: '/unused', pinnedHeadOid: null,
    ...over,
  };
}

// ── the request WP-3D builds ──────────────────────────────────────────────────────

test('done builds a plan-package finalize request from the work package row', async () => {
  let seen: FinalizePackageRequest | null = null;
  const fakeFinalize = async (req: FinalizePackageRequest): Promise<FinalizePackageResult> => {
    seen = req;
    return { finalization: {} as PackageFinalization, outcome: 'created', memberManifestJson: '[]' };
  };
  await finalizePlanItemDone(doneRequest(), {
    getPlanWorkPackage: () => workPackage(),
    finalize: fakeFinalize,
  });
  assert.ok(seen, 'finalize was called');
  const req = seen as unknown as FinalizePackageRequest;
  assert.equal(req.finalizationKind, 'plan-package');
  assert.equal(req.packageId, planPackageId('wp-1'));
  // plan attribution comes from the work package's own row, never the wire.
  assert.equal(req.planId, 'plan-1');
  assert.equal(req.planItemId, 'wp-1');
  // caller-supplied boundary + members are forwarded verbatim.
  assert.equal(req.boundaryOid, OID_A);
  assert.equal(req.members.length, 1);
  assert.equal(req.checkpointTurnId, 'turn-1');
  // provenance defaults to the work package's workspace when the caller omits it.
  assert.equal(req.createdFromWorkspaceId, 'ws-1');
});

test('planPackageId is a pure function of the item id (stable across revisions)', () => {
  assert.equal(planPackageId('wp-1'), planPackageId('wp-1'));
  assert.notEqual(planPackageId('wp-1'), planPackageId('wp-2'));
});

test('an explicit createdFromWorkspaceId overrides the work package workspace', async () => {
  let seen: FinalizePackageRequest | null = null;
  await finalizePlanItemDone(doneRequest({ createdFromWorkspaceId: 'ws-other' }), {
    getPlanWorkPackage: () => workPackage(),
    finalize: async (req) => { seen = req; return { finalization: {} as PackageFinalization, outcome: 'created', memberManifestJson: '[]' }; },
  });
  assert.equal((seen as unknown as FinalizePackageRequest).createdFromWorkspaceId, 'ws-other');
});

test('a done transition on an unknown work package throws (never fabricates a finalization)', async () => {
  let called = false;
  await assert.rejects(
    finalizePlanItemDone(doneRequest({ planItemId: 'ghost' }), {
      getPlanWorkPackage: () => null,
      finalize: async (req) => { called = true; return { finalization: {} as PackageFinalization, outcome: 'created', memberManifestJson: JSON.stringify(req) }; },
    }),
  );
  assert.equal(called, false, 'finalize must not be called for a missing package');
});

// ── end-to-end through the REAL WP-3C finalization service ──────────────────────────

// A minimal in-memory FinalizationStore mirroring the WP-3A/3B accessor semantics,
// enough to drive finalizePackage's create path deterministically.
class FakeStore implements FinalizationStore {
  rows = new Map<string, PackageFinalization>();
  workPackages = new Map<string, PlanWorkPackage>();
  getActivePackageFinalization(packageId: string): PackageFinalization | null {
    const active = [...this.rows.values()]
      .filter((r) => r.packageId === packageId && r.lifecycleStatus === 'active')
      .sort((a, b) => b.packageRevision - a.packageRevision);
    return active[0] ?? null;
  }
  maxPackageRevision(packageId: string): number {
    return [...this.rows.values()]
      .filter((r) => r.packageId === packageId)
      .reduce((mx, r) => Math.max(mx, r.packageRevision), 0);
  }
  insertPackageFinalization(f: PackageFinalization): void { this.rows.set(f.id, { ...f }); }
  supersedePackageFinalization(id: string, supersededBy: string): void {
    const r = this.rows.get(id);
    if (r) { r.lifecycleStatus = 'superseded'; r.supersededByFinalizationId = supersededBy; }
  }
  setPackageFinalizationBoundaryStatus(id: string, status: FinalizationBoundaryStatus): void {
    const r = this.rows.get(id);
    if (r) r.boundaryStatus = status;
  }
  getPlanWorkPackage(id: string): PlanWorkPackage | null { return this.workPackages.get(id) ?? null; }
  upsertPlanWorkPackage(pkg: PlanWorkPackage): void { this.workPackages.set(pkg.id, { ...pkg }); }
  transact<T>(fn: () => T): T { return fn(); }
}

const okWriter: FinalizationRefWriter = async () => ({ ok: true });
const fakeFreeze: MemberFreezer = async (entry) => ({
  expectedState: entry.expectedWorktreeState,
  rawBlobOid: entry.rawWorktreeBlobOid,
  commitBlobOid: 'commit-' + entry.path.pathBytesBase64,
  commitMode: '100644',
});

test('done creates a plan-package finalization and flips the work package to done', async () => {
  const store = new FakeStore();
  store.workPackages.set('wp-1', workPackage({ state: 'executing' }));

  const res = await finalizePlanItemDone(doneRequest(), {
    getPlanWorkPackage: (id) => store.getPlanWorkPackage(id),
    // Drive the REAL WP-3C service, only its DB/ref/freeze seams faked.
    finalize: (req) => finalizePackage(req, {
      store, writeRef: okWriter, freeze: fakeFreeze, now: () => 100, newId: () => 'fin-d',
    }),
  });

  assert.equal(res.outcome, 'created');
  assert.equal(res.finalization.finalizationKind, 'plan-package');
  assert.equal(res.finalization.planId, 'plan-1');
  assert.equal(res.finalization.planItemId, 'wp-1');
  assert.equal(res.finalization.packageId, planPackageId('wp-1'));
  assert.equal(res.finalization.boundaryStatus, 'ready');
  assert.equal(res.finalization.checkpointOid, OID_A);
  assert.equal(res.finalization.boundaryRef, finalizationRef(planPackageId('wp-1'), 1));
  // the active row is queryable under the derived package id.
  assert.equal(store.getActivePackageFinalization(planPackageId('wp-1'))?.id, res.finalization.id);
  // the work package flipped to done inside the service txn.
  assert.equal(store.workPackages.get('wp-1')?.state, 'done');
});

test('a boundary-unavailable finalize leaves the work package NOT done', async () => {
  const store = new FakeStore();
  store.workPackages.set('wp-1', workPackage({ state: 'executing' }));
  const failWriter: FinalizationRefWriter = async () => ({ ok: false, error: 'forced' });

  const res = await finalizePlanItemDone(doneRequest(), {
    getPlanWorkPackage: (id) => store.getPlanWorkPackage(id),
    finalize: (req) => finalizePackage(req, {
      store, writeRef: failWriter, freeze: fakeFreeze, now: () => 100, newId: () => 'fin-bad',
    }),
  });

  assert.equal(res.outcome, 'boundary-unavailable');
  assert.equal(store.workPackages.get('wp-1')?.state, 'executing', 'done never flips on an unavailable boundary');
  assert.equal(store.getActivePackageFinalization(planPackageId('wp-1')), null);
});

// ── runner ──────────────────────────────────────────────────────────────────────

(async () => {
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
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
