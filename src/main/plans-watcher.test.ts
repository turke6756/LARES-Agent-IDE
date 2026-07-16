// B2 Task D — plans-watcher tests (P1-04) + F-C onPlanSettled fire matrix.
//
// Two layers:
//   1. The PURE reducer `reconcilePlanListing` — fed synthesized listings, no
//      real fs / timing (D6): create, update, rename (dev/ino), soft-delete on
//      grace expiry, and NO false rebind when identity doesn't match.
//   2. The onPlanSettled FIRE MATRIX (F-C): drives `reconcileWorkspace` with the
//      `./database` + `./file-reader` modules stubbed and internal state seeded,
//      asserting the callback fires on boot/created/revived/changed/renamed/
//      adopted and NEVER on soft-delete.
//
//   npm run build:main
//   node dist/main/main/plans-watcher.test.js

import assert from 'node:assert/strict';
import type { PlanFileEntry, PlanFileSnapshot, PlanChange } from './plans-watcher';
import { reconcilePlanListing, inferFormat, PlansWatcher } from './plans-watcher';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

function entry(over: Partial<PlanFileEntry> & { relPath: string }): PlanFileEntry {
  return {
    format: inferFormat(over.relPath), sizeBytes: 10, mtimeMs: 100,
    dev: undefined, ino: undefined, contentHash: undefined, ...over,
  };
}
function snap(over: Partial<PlanFileSnapshot> & { relPath: string; planId: string }): PlanFileSnapshot {
  return { format: inferFormat(over.relPath), sizeBytes: 10, mtimeMs: 100, ...over };
}

// ── 1. pure reducer ───────────────────────────────────────────────────────────

test('inferFormat: html/htm → html; md/markdown → md', () => {
  assert.equal(inferFormat('plans/a.html'), 'html');
  assert.equal(inferFormat('plans/a.htm'), 'html');
  assert.equal(inferFormat('plans/a.md'), 'md');
  assert.equal(inferFormat('plans/a.markdown'), 'md');
});

test('reducer: brand-new file → create action', () => {
  const { actions } = reconcilePlanListing({
    listing: [entry({ relPath: 'plans/new.md' })],
    snapshots: new Map(), pending: new Map(), now: 1000,
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'create');
});

test('reducer: unchanged file → no action', () => {
  const s = snap({ relPath: 'plans/a.md', planId: 'p1', mtimeMs: 100, sizeBytes: 10 });
  const { actions } = reconcilePlanListing({
    listing: [entry({ relPath: 'plans/a.md', mtimeMs: 100, sizeBytes: 10 })],
    snapshots: new Map([['plans/a.md', s]]), pending: new Map(), now: 1000,
  });
  assert.equal(actions.length, 0);
});

test('reducer: mtime/size change → update action (same planId)', () => {
  const s = snap({ relPath: 'plans/a.md', planId: 'p1', mtimeMs: 100, sizeBytes: 10 });
  const { actions } = reconcilePlanListing({
    listing: [entry({ relPath: 'plans/a.md', mtimeMs: 200, sizeBytes: 20 })],
    snapshots: new Map([['plans/a.md', s]]), pending: new Map(), now: 1000,
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'update');
  assert.equal((actions[0] as any).planId, 'p1');
});

test('reducer: unlink+add with same dev/ino in one cycle → rename REBIND (no delete, no create)', () => {
  const s = snap({ relPath: 'plans/foo.md', planId: 'p1', dev: 1, ino: 42 });
  const { actions, pending } = reconcilePlanListing({
    listing: [entry({ relPath: 'plans/bar.md', dev: 1, ino: 42 })],
    snapshots: new Map([['plans/foo.md', s]]), pending: new Map(), now: 1000,
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'rename');
  assert.equal((actions[0] as any).planId, 'p1');
  assert.equal((actions[0] as any).oldRelPath, 'plans/foo.md');
  assert.equal((actions[0] as any).entry.relPath, 'plans/bar.md');
  assert.equal(pending.size, 0, 'matched removal cleared from pending');
});

test('reducer: rename correlates by contentHash when dev/ino absent', () => {
  const s = snap({ relPath: 'plans/foo.md', planId: 'p1', contentHash: 'abc' });
  const { actions } = reconcilePlanListing({
    listing: [entry({ relPath: 'plans/bar.md', contentHash: 'abc' })],
    snapshots: new Map([['plans/foo.md', s]]), pending: new Map(), now: 1000,
  });
  assert.equal(actions[0].kind, 'rename');
});

test('reducer: rename tier-3 (size+mtime) only when exactly one pending shares the ext', () => {
  const s = snap({ relPath: 'plans/foo.md', planId: 'p1', sizeBytes: 55, mtimeMs: 900 });
  const { actions } = reconcilePlanListing({
    listing: [entry({ relPath: 'plans/bar.md', sizeBytes: 55, mtimeMs: 900 })],
    snapshots: new Map([['plans/foo.md', s]]), pending: new Map(), now: 1000,
  });
  assert.equal(actions[0].kind, 'rename', 'single same-ext pending → tier-3 match');
});

test('reducer: absent file goes pending first (grace not expired) → no soft-delete yet', () => {
  const s = snap({ relPath: 'plans/a.md', planId: 'p1' });
  const { actions, pending } = reconcilePlanListing({
    listing: [], snapshots: new Map([['plans/a.md', s]]), pending: new Map(), now: 1000, graceMs: 1500,
  });
  assert.equal(actions.length, 0, 'grace not expired → held, not deleted');
  assert.equal(pending.size, 1);
  assert.equal(pending.get('plans/a.md')!.deadline, 2500);
});

test('reducer: pending removal past grace with no match → soft-delete action', () => {
  const s = snap({ relPath: 'plans/a.md', planId: 'p1' });
  const pending = new Map([['plans/a.md', { snapshot: s, deadline: 500 }]]);
  const { actions } = reconcilePlanListing({
    listing: [], snapshots: new Map(), pending, now: 1000,
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, 'soft-delete');
  assert.equal((actions[0] as any).planId, 'p1');
});

test('reducer: delete + UNRELATED create (no identity match) → soft-delete + create, never rebind', () => {
  // Genuinely unrelated: different dev/ino AND different size+mtime, so no tier
  // (dev/ino, hash, or size+mtime) can correlate them into a rename.
  const s = snap({ relPath: 'plans/gone.md', planId: 'p1', dev: 1, ino: 7, sizeBytes: 10, mtimeMs: 100 });
  const pending = new Map([['plans/gone.md', { snapshot: s, deadline: 500 }]]);
  const { actions } = reconcilePlanListing({
    listing: [entry({ relPath: 'plans/fresh.md', dev: 2, ino: 99, sizeBytes: 777, mtimeMs: 9999 })],
    snapshots: new Map(), pending, now: 1000,
  });
  const kinds = actions.map(a => a.kind).sort();
  assert.deepEqual(kinds, ['create', 'soft-delete']);
});

// ── 2. onPlanSettled FIRE MATRIX (F-C) ─────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('./database') as Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fileReader = require('./file-reader') as Record<string, any>;

const WS = { id: 'ws-1', title: 'WS', path: '/home/x/ws', pathType: 'wsl' };

function planRow(over: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'p1', workspaceId: 'ws-1', path: 'plans/a.md', slug: 'a', format: 'md',
    runState: null, mtimeMs: 100, sizeBytes: 10, createdAt: 't', updatedAt: 't', deletedAt: null, ...over,
  };
}

/** Directory-entry shape as returned by listDirectoryEntriesAsync. */
function de(name: string, over: Record<string, any> = {}): Record<string, any> {
  return { name, path: `/home/x/ws/plans/${name}`, isDirectory: false, size: 10, mtimeMs: 100, dev: 1, ino: 5, ...over };
}

/** Build a watcher with a pre-seeded workspace state so reconcileWorkspace runs
 *  without subscribing / touching real fs. `listing` drives the stubbed lister. */
function makeWatcher(listing: Record<string, any>[], onSettled: Array<[string, PlanChange]>): PlansWatcher {
  fileReader.listDirectoryEntriesAsync = async () => listing;
  const w = new PlansWatcher({
    onPlanSettled: (plan, change) => { onSettled.push([plan.id, change]); },
  });
  (w as any).states.set(WS.id, {
    ws: WS, plansDir: '/home/x/ws/plans', snapshots: new Map(), pending: new Map(),
    unsubscribe: () => {}, debounce: null,
  });
  return w;
}

function installDbStubs(): void {
  db.getPlanByWorkspacePath = () => null;
  db.createOrRevivePlan = (input: any) => planRow({ id: 'p-new', path: input.path });
  db.updatePlan = (id: string, updates: any) => planRow({ id, ...updates });
  db.softDeletePlan = (id: string) => planRow({ id, deletedAt: 't-del' });
  // derivePlanSlug stays real (pure).
}

test('fire matrix: BOOT scan fires "boot" for each discovered plan', async () => {
  installDbStubs();
  const fired: Array<[string, PlanChange]> = [];
  const w = makeWatcher([de('a.md')], fired);
  await (w as any).reconcileWorkspace(WS, true);
  assert.deepEqual(fired, [['p-new', 'boot']]);
});

test('fire matrix: a new plan on a live reconcile fires "created"', async () => {
  installDbStubs();
  const fired: Array<[string, PlanChange]> = [];
  const w = makeWatcher([de('a.md')], fired);
  await (w as any).reconcileWorkspace(WS, false);
  assert.deepEqual(fired, [['p-new', 'created']]);
});

test('fire matrix: reviving a soft-deleted path fires "revived"', async () => {
  installDbStubs();
  db.getPlanByWorkspacePath = () => planRow({ deletedAt: 't-del' });  // tombstone present
  const fired: Array<[string, PlanChange]> = [];
  const w = makeWatcher([de('a.md')], fired);
  await (w as any).reconcileWorkspace(WS, false);
  assert.deepEqual(fired, [['p-new', 'revived']]);
});

test('fire matrix: an mtime/size change fires "changed"', async () => {
  installDbStubs();
  const fired: Array<[string, PlanChange]> = [];
  const w = makeWatcher([de('a.md')], fired);
  // Seed a snapshot so the file is "known", then change its mtime.
  (w as any).states.get(WS.id).snapshots.set('plans/a.md',
    { relPath: 'plans/a.md', format: 'md', sizeBytes: 10, mtimeMs: 100, planId: 'p1' });
  fileReader.listDirectoryEntriesAsync = async () => [de('a.md', { mtimeMs: 999, size: 40 })];
  await (w as any).reconcileWorkspace(WS, false);
  assert.deepEqual(fired, [['p1', 'changed']]);
});

test('fire matrix: a rename fires "renamed"', async () => {
  installDbStubs();
  const fired: Array<[string, PlanChange]> = [];
  const w = makeWatcher([de('bar.md', { dev: 1, ino: 42 })], fired);
  (w as any).states.get(WS.id).snapshots.set('plans/foo.md',
    { relPath: 'plans/foo.md', format: 'md', sizeBytes: 10, mtimeMs: 100, dev: 1, ino: 42, planId: 'p1' });
  await (w as any).reconcileWorkspace(WS, false);
  assert.deepEqual(fired, [['p1', 'renamed']]);
});

test('fire matrix: "adopted" is an accepted change type (WP3 will emit it)', async () => {
  installDbStubs();
  const fired: Array<[string, PlanChange]> = [];
  const w = makeWatcher([], fired);
  await (w as any).fireSettled(planRow({ id: 'p-adopt' }), 'adopted', false);
  assert.deepEqual(fired, [['p-adopt', 'adopted']]);
});

test('fire matrix: SOFT-DELETE fires the DB soft-delete but NEVER onPlanSettled (F-C)', async () => {
  installDbStubs();
  let softDeleted: string | null = null;
  db.softDeletePlan = (id: string) => { softDeleted = id; return planRow({ id, deletedAt: 't-del' }); };
  const fired: Array<[string, PlanChange]> = [];
  const w = makeWatcher([], fired);   // empty listing
  // Seed an already-expired pending removal so the reducer emits soft-delete now.
  (w as any).states.get(WS.id).pending.set('plans/gone.md', {
    snapshot: { relPath: 'plans/gone.md', format: 'md', sizeBytes: 10, mtimeMs: 100, planId: 'p-del' },
    deadline: 1,   // in the past relative to Date.now()
  });
  await (w as any).reconcileWorkspace(WS, false);
  assert.equal(softDeleted, 'p-del', 'soft-delete DID run');
  assert.deepEqual(fired, [], 'onPlanSettled NEVER fires on soft-delete');
});

test('fire matrix: watcher runs callback-less by default (pure B2 behavior, no throw)', async () => {
  installDbStubs();
  fileReader.listDirectoryEntriesAsync = async () => [de('a.md')];
  const w = new PlansWatcher();     // no onPlanSettled
  (w as any).states.set(WS.id, {
    ws: WS, plansDir: '/home/x/ws/plans', snapshots: new Map(), pending: new Map(),
    unsubscribe: () => {}, debounce: null,
  });
  await (w as any).reconcileWorkspace(WS, true);   // must not throw
});

// ── 3. Adoption decision (WP3 C6) — applyCreate via reconcileWorkspace ──────────
// Drives the create-action path with injected readPlanId/patchPlanId so the
// `data-plan-id` adoption ladder runs without real fs: adopt a known same-ws id
// (never remint), mint-and-patch an unknown/absent id, and prove a rename rebinds
// on the snapshot's id (never mints a fresh row).

/** Watcher with a pre-seeded WS state + injected adoption hooks. */
function makeAdoptionWatcher(
  listing: Record<string, any>[],
  onSettled: Array<[string, PlanChange]>,
  extra: Record<string, any>,
): PlansWatcher {
  fileReader.listDirectoryEntriesAsync = async () => listing;
  const w = new PlansWatcher({
    onPlanSettled: (plan: any, change: any) => { onSettled.push([plan.id, change]); },
    ...extra,
  });
  (w as any).states.set(WS.id, {
    ws: WS, plansDir: '/home/x/ws/plans', snapshots: new Map(), pending: new Map(),
    unsubscribe: () => {}, debounce: null,
  });
  return w;
}

test('adoption: embedded data-plan-id naming a live same-workspace plan is ADOPTED (rebind, never remint)', async () => {
  installDbStubs();
  let minted = false;
  db.createOrRevivePlan = () => { minted = true; return planRow({ id: 'p-new' }); };
  let updateArgs: { id: string; updates: any } | null = null;
  db.updatePlan = (id: string, updates: any) => { updateArgs = { id, updates }; return planRow({ id, ...updates }); };
  db.getPlan = (id: string) => (id === 'p-embed' ? planRow({ id: 'p-embed', path: 'plans/old.md' }) : null);
  const fired: Array<[string, PlanChange]> = [];
  const w = makeAdoptionWatcher([de('a.md')], fired, {
    readPlanId: async () => 'p-embed',   // file embeds a known id
  });
  await (w as any).reconcileWorkspace(WS, false);
  assert.deepEqual(fired, [['p-embed', 'adopted']]);
  assert.equal(minted, false, 'adoption must NOT mint a new plan');
  assert.equal(updateArgs!.id, 'p-embed', 'rebinds the adopted plan by its own id');
  assert.equal(updateArgs!.updates.path, 'plans/a.md', 'path rebound to the file');
});

test('adoption: unknown/absent data-plan-id → mint then patch the minted id back into the file', async () => {
  installDbStubs();
  db.getPlan = () => null;                 // embedded id names no live plan
  db.createOrRevivePlan = (input: any) => planRow({ id: 'p-new', path: input.path });
  let patchArgs: [string, string] | null = null;
  const fired: Array<[string, PlanChange]> = [];
  const w = makeAdoptionWatcher([de('a.md')], fired, {
    readPlanId: async () => 'p-stale',     // present but unknown → mint-and-patch
    patchPlanId: async (_ws: any, relPath: string, planId: string) => { patchArgs = [relPath, planId]; return true; },
  });
  await (w as any).reconcileWorkspace(WS, false);
  assert.deepEqual(fired, [['p-new', 'created']]);
  assert.deepEqual(patchArgs, ['plans/a.md', 'p-new'], 'server UUID patched back into the file');
});

test('adoption: a rename rebinds on the snapshot id and NEVER remints (identity preserved)', async () => {
  installDbStubs();
  let minted = false;
  db.createOrRevivePlan = () => { minted = true; return planRow({ id: 'p-new' }); };
  let updateArgs: { id: string; updates: any } | null = null;
  db.updatePlan = (id: string, updates: any) => { updateArgs = { id, updates }; return planRow({ id, ...updates }); };
  const fired: Array<[string, PlanChange]> = [];
  // dev/ino carry identity from the old path's snapshot to the renamed file.
  const w = makeAdoptionWatcher([de('bar.md', { dev: 1, ino: 42 })], fired, {
    readPlanId: async () => 'p-should-be-ignored',  // rename never consults data-plan-id
  });
  (w as any).states.get(WS.id).snapshots.set('plans/foo.md',
    { relPath: 'plans/foo.md', format: 'md', sizeBytes: 10, mtimeMs: 100, dev: 1, ino: 42, planId: 'p1' });
  await (w as any).reconcileWorkspace(WS, false);
  assert.deepEqual(fired, [['p1', 'renamed']]);
  assert.equal(minted, false, 'a rename must NEVER mint a new plan');
  assert.equal(updateArgs!.id, 'p1', 'rebinds the pre-existing id from the snapshot');
  assert.equal(updateArgs!.updates.path, 'plans/bar.md');
});

// ── Run ─────────────────────────────────────────────────────────────────────
(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ✓ ${t.name}`); }
    catch (err) { failed++; console.error(`  ✗ ${t.name}`); console.error(err instanceof Error ? err.stack : String(err)); }
  }
  if (failed > 0) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
  console.log(`\nAll ${tests.length} plans-watcher tests passed`);
})();
