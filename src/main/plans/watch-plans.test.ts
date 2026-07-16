// WP4 — reparse pipeline test (F-C/F-B/F-E), fully injected (no DB/fs).
//
// Covers the happy path (mint → backfill write → section_changes → snapshot),
// the parse-failure fallback chain (memory → snapshot blob → empty+parseError),
// the "failed parse writes NO snapshot and NO change rows" rule, and the
// byte-range editTarget matcher.
//
//   npm run build:main
//   node dist/main/main/plans/watch-plans.test.js

import assert from 'node:assert/strict';
import { PlanReparser, type ReparseDeps } from './watch-plans';
import { parsePlanHtml, type PlanProjection } from './section-reader';
import type { PlanSectionRow } from '../database';
import type { Plan } from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

const PLAN: Plan = {
  id: 'plan-1', workspaceId: 'ws-1', path: 'plans/p.html', slug: null, format: 'html',
  runState: null, mtimeMs: 0, sizeBytes: 0, createdAt: 'T', updatedAt: 'T', deletedAt: null,
};

interface Harness {
  deps: ReparseDeps;
  files: Map<string, string>;
  changes: { sectionAnchor: string; blockAnchor: string | null; contentHash: string }[];
  snapshots: { planId: string; html: string }[];
  blobs: Map<string, string>;            // simulated plan_snapshot_blobs (hash→html), for reconstruction
  setLatestBlob(planId: string, html: string): void;
  setParse(fn: (html: string) => PlanProjection): void;
}

function harness(initialHtml: string): Harness {
  const files = new Map<string, string>([['/ws/plans/p.html', initialHtml]]);
  const rows: PlanSectionRow[] = [];
  const changes: Harness['changes'] = [];
  const snapshots: Harness['snapshots'] = [];
  const latestBlob = new Map<string, string>();
  let parseFn = parsePlanHtml;

  const deps: ReparseDeps = {
    resolveAbsolutePath: () => ({ absPath: '/ws/plans/p.html', pathType: 'windows' }),
    readFile: async (absPath) => ({ content: files.get(absPath) ?? '', error: files.has(absPath) ? undefined : 'missing' }),
    writeFile: async (absPath, content) => { files.set(absPath, content); },
    registry: {
      getPlanSections: (planId, opts) => rows.filter((r) => r.planId === planId && (opts?.includeArchived === false ? r.archivedAt === null : true)),
      getPlanSectionByAnchor: (planId, anchor) => rows.find((r) => r.planId === planId && r.anchor === anchor) ?? null,
      insertPlanSection: ({ planId, anchor }) => {
        const e = rows.find((r) => r.planId === planId && r.anchor === anchor);
        if (e) { if (e.archivedAt) e.archivedAt = null; return e.id; }
        const id = 'row-' + (rows.length + 1);
        rows.push({ id, planId, anchor, parentSectionId: null, createdAt: 'T', archivedAt: null });
        return id;
      },
      archivePlanSection: (planId, anchor) => {
        const r = rows.find((x) => x.planId === planId && x.anchor === anchor && x.archivedAt === null);
        if (r) r.archivedAt = 'archived';
      },
    },
    recordPlanSectionChange: (input) => { changes.push({ sectionAnchor: input.sectionAnchor, blockAnchor: input.blockAnchor ?? null, contentHash: input.contentHash }); return 'chg-' + changes.length; },
    recordPlanSnapshot: (planId, html) => { snapshots.push({ planId, html }); return 'snap-' + snapshots.length; },
    getLatestPlanSnapshotHtml: (planId) => latestBlob.get(planId) ?? null,
    parse: (html) => parseFn(html),
    now: () => '2026-07-05T00:00:00.000Z',
  };

  return {
    deps, files, changes, snapshots, blobs: latestBlob,
    setLatestBlob: (planId, html) => latestBlob.set(planId, html),
    setParse: (fn) => { parseFn = fn; },
  };
}

// ── happy path ────────────────────────────────────────────────────────────────

test('reparse mints anchorless sections, writes the backfill, and records a snapshot', async () => {
  const h = harness('<body><section data-zone="research"><h2>R</h2><p>hi</p></section></body>');
  const reparser = new PlanReparser(h.deps);
  const out = await reparser.reparse(PLAN);
  assert.ok(out.ok);
  assert.equal(out.mintedAnchors.length, 1, 'anchorless section minted');
  assert.ok(out.htmlWritten, 'backfilled HTML written back to disk');
  assert.ok(h.files.get('/ws/plans/p.html')!.includes('data-anchor='), 'file now carries the anchor');
  assert.equal(h.snapshots.length, 1, 'boot reparse records the baseline snapshot');
  // First-seen sections seed silently → no change rows on the first reparse.
  assert.equal(h.changes.length, 0, 'first reparse seeds the cache, no spurious change rows');
});

test('a content edit on the second reparse emits exactly one section_changes row', async () => {
  const html1 = '<body><section data-anchor="sec_aaa111" data-zone="r"><p>one</p></section></body>';
  const h = harness(html1);
  const reparser = new PlanReparser(h.deps);
  await reparser.reparse(PLAN);                        // seed
  assert.equal(h.changes.length, 0);
  h.files.set('/ws/plans/p.html', '<body><section data-anchor="sec_aaa111" data-zone="r"><p>two</p></section></body>');
  const out = await reparser.reparse(PLAN);
  assert.deepEqual(out.changedAnchors, ['sec_aaa111']);
  assert.equal(h.changes.length, 1);
  assert.equal(h.snapshots.length, 2, 'the changed content is a new snapshot');
});

test('minting a data-anchor does NOT emit a change row (inner-HTML hash is unaffected)', async () => {
  // Anchorless section → mint patches the OPEN tag only; inner HTML is identical.
  const h = harness('<body><section data-zone="r"><p>same</p></section></body>');
  const reparser = new PlanReparser(h.deps);
  await reparser.reparse(PLAN);       // seeds with the minted anchor's inner hash
  const out = await reparser.reparse(PLAN); // file already patched → no re-mint
  assert.equal(out.mintedAnchors.length, 0);
  assert.equal(h.changes.length, 0, 'no spurious change from the anchor backfill');
});

// ── I-6 Part 2: anchorless notable blocks mint on the existing backfill write ──

test('a reparse over anchorless notable blocks writes the backfill and reports mintedBlockAnchors', async () => {
  // Section already anchored (sec_), but its h3 blocks carry no data-anchor.
  const html = '<body><section data-anchor="sec_dcsion" data-zone="d">'
             + '<h3>One</h3><h3>Two</h3></section></body>';
  const h = harness(html);
  const reparser = new PlanReparser(h.deps);
  const out = await reparser.reparse(PLAN);
  assert.ok(out.ok);
  assert.equal(out.mintedAnchors.length, 0, 'section already anchored → no section mints');
  assert.ok(out.mintedBlockAnchors.length >= 2, 'both anchorless h3 blocks minted');
  assert.ok(out.htmlWritten, 'block backfill rides the single whole-file write');
  const onDisk = h.files.get('/ws/plans/p.html')!;
  assert.ok(onDisk.includes('<h3 data-anchor="blk_'), 'minted blk_ anchors persisted to disk');

  // Re-run over the now-patched file → every block anchored → no re-mint, no write.
  const out2 = await reparser.reparse(PLAN);
  assert.equal(out2.mintedBlockAnchors.length, 0, 'steady state: no further block mints');
  assert.equal(out2.htmlWritten, false, 'steady state: nothing written');
});

// ── byte-range editTarget matcher ─────────────────────────────────────────────

test('resolveEditTargetAnchor maps a native-edit payload to its containing section', async () => {
  const h = harness('<body><section data-anchor="sec_aaa111" data-zone="a"><p>alpha payload</p></section>'
                  + '<section data-anchor="sec_bbb222" data-zone="b"><p>beta zone</p></section></body>');
  const reparser = new PlanReparser(h.deps);
  await reparser.reparse(PLAN);
  assert.equal(reparser.resolveEditTargetAnchor('alpha payload', 'plan-1'), 'sec_aaa111');
  assert.equal(reparser.resolveEditTargetAnchor('beta zone', 'plan-1'), 'sec_bbb222');
  assert.equal(reparser.resolveEditTargetAnchor('nowhere', 'plan-1'), null);
  assert.equal(reparser.resolveEditTargetAnchor(null, 'plan-1'), null);
});

// ── degradation chain (F-E) ───────────────────────────────────────────────────

test('parse failure with a prior good parse serves the last-good MEMORY projection, writes nothing', async () => {
  const h = harness('<body><section data-anchor="sec_aaa111" data-zone="r"><p>good</p></section></body>');
  const reparser = new PlanReparser(h.deps);
  await reparser.reparse(PLAN);                 // good parse → last-good in memory
  const snapsBefore = h.snapshots.length;
  const changesBefore = h.changes.length;
  h.setParse(() => { throw new Error('boom'); });
  h.files.set('/ws/plans/p.html', '<broken');
  const out = await reparser.reparse(PLAN);
  assert.equal(out.ok, false);
  assert.equal(out.degradedFrom, 'memory');
  assert.equal(out.parseError, 'boom');
  assert.equal(h.snapshots.length, snapsBefore, 'NO snapshot written on failed parse');
  assert.equal(h.changes.length, changesBefore, 'NO change rows on failed parse');
  const served = reparser.getServedProjection('plan-1')!;
  assert.equal(served.parseError, 'boom');
  assert.ok(served.sections.some((s) => s.anchor === 'sec_aaa111'), 'last-good content still served');
});

test('parse failure with NO memory reconstructs from the latest snapshot BLOB', async () => {
  const h = harness('<broken');
  h.setLatestBlob('plan-1', '<body><section data-anchor="sec_ccc333" data-zone="r"><p>from blob</p></section></body>');
  h.setParse(() => { throw new Error('corrupt'); });
  const reparser = new PlanReparser(h.deps);
  const out = await reparser.reparse(PLAN);
  assert.equal(out.degradedFrom, 'snapshot');
  assert.equal(out.parseError, 'corrupt');
  const served = reparser.getServedProjection('plan-1')!;
  assert.ok(served.sections.some((s) => s.anchor === 'sec_ccc333'), 'reconstructed from the blob');
  assert.equal(h.snapshots.length, 0, 'reconstruction writes no new snapshot');
});

test('parse failure with neither memory nor blob → EMPTY projection with parseError', async () => {
  const h = harness('<broken');
  h.setParse(() => { throw new Error('nothing left'); });
  const reparser = new PlanReparser(h.deps);
  const out = await reparser.reparse(PLAN);
  assert.equal(out.degradedFrom, 'empty');
  const served = reparser.getServedProjection('plan-1')!;
  assert.equal(served.sections.length, 0);
  assert.equal(served.parseError, 'nothing left');
  assert.equal(h.snapshots.length, 0);
  assert.equal(h.changes.length, 0);
});

// ── Runner ─────────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
