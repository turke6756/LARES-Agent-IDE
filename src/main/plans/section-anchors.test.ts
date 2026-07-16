// WP4 — section-anchors unit test (mint shape, backfill idempotence, diff,
// DB-backed register/archive/un-archive via an in-memory fake registry).
//
//   npm run build:main
//   node dist/main/main/plans/section-anchors.test.js

import assert from 'node:assert/strict';
import { parsePlanHtml } from './section-reader';
import {
  mintSectionAnchor, mintBlockAnchor, isValidAnchor, ANCHOR_SHAPE,
  patchAnchorlessSections, patchAnchorlessBlocks, diffSectionAnchors,
  registerSectionsFromHtml, registerBlocksFromHtml, type SectionRegistryDeps,
} from './section-anchors';
import type { PlanSectionRow } from '../database';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// ── in-memory fake registry (mirrors the DB helpers' semantics) ──────────────
function fakeRegistry() {
  const rows: PlanSectionRow[] = [];
  const deps: SectionRegistryDeps = {
    getPlanSections: (planId, opts) => rows.filter(
      (r) => r.planId === planId && (opts?.includeArchived === false ? r.archivedAt === null : true)),
    getPlanSectionByAnchor: (planId, anchor) =>
      rows.find((r) => r.planId === planId && r.anchor === anchor) ?? null,
    insertPlanSection: ({ planId, anchor, createdAt }) => {
      const existing = rows.find((r) => r.planId === planId && r.anchor === anchor);
      if (existing) { if (existing.archivedAt) existing.archivedAt = null; return existing.id; }
      const id = 'row-' + (rows.length + 1);
      rows.push({ id, planId, anchor, parentSectionId: null, createdAt: createdAt ?? 'T', archivedAt: null });
      return id;
    },
    archivePlanSection: (planId, anchor, archivedAt) => {
      const r = rows.find((x) => x.planId === planId && x.anchor === anchor && x.archivedAt === null);
      if (r) r.archivedAt = archivedAt ?? 'archived';
    },
  };
  return { deps, rows };
}

// deterministic mint sequences for assertions
function seqMint(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}_zzz${String(++n).padStart(3, '0')}`;
}

// ── mint shape ────────────────────────────────────────────────────────────────

test('mintSectionAnchor / mintBlockAnchor satisfy the F-D anchor shape', () => {
  for (let i = 0; i < 200; i++) {
    const s = mintSectionAnchor();
    const b = mintBlockAnchor();
    assert.ok(ANCHOR_SHAPE.test(s), `section anchor ${s} matches /^(sec|blk)_[a-z0-9]{6}$/`);
    assert.ok(ANCHOR_SHAPE.test(b), `block anchor ${b} matches shape`);
    assert.ok(isValidAnchor(s) && isValidAnchor(b));
  }
  assert.ok(!isValidAnchor('sec_ABCDEF'), 'uppercase rejected');
  assert.ok(!isValidAnchor('sec_toolong1'), 'wrong length rejected');
});

// ── backfill patching + idempotence ──────────────────────────────────────────

test('patchAnchorlessSections inserts data-anchor and is idempotent on re-run', () => {
  const html = '<body><section data-zone="a"><h2>A</h2></section><section data-anchor="sec_keep00" data-zone="b">B</section></body>';
  const proj = parsePlanHtml(html);
  const { html: patched, minted } = patchAnchorlessSections(html, proj, seqMint('sec'));
  assert.equal(minted.length, 1, 'one anchorless section minted');
  assert.ok(patched.includes('<section data-anchor="sec_zzz001" data-zone="a">'), 'anchor inserted after <section');
  assert.ok(patched.includes('sec_keep00'), 'existing anchor untouched');
  // Re-parse the patched HTML → nothing anchorless → idempotent no-op.
  const proj2 = parsePlanHtml(patched);
  const again = patchAnchorlessSections(patched, proj2, seqMint('sec'));
  assert.equal(again.minted.length, 0, 'second pass mints nothing');
  assert.equal(again.html, patched, 'second pass leaves HTML unchanged');
});

test('multiple anchorless sections patch right-to-left, all fragments stay byte-exact', () => {
  const html = '<body><section data-zone="a">A</section><section data-zone="b">B</section></body>';
  const proj = parsePlanHtml(html);
  const { html: patched, minted } = patchAnchorlessSections(html, proj, seqMint('sec'));
  assert.equal(minted.length, 2);
  const proj2 = parsePlanHtml(patched);
  // Both sections now anchored and their raw fragments re-slice verbatim.
  for (const s of proj2.sections) {
    assert.ok(s.anchor, 'anchored');
    assert.equal(patched.slice(s.startOffset, s.endOffset), s.raw);
  }
});

// ── diff ──────────────────────────────────────────────────────────────────────

test('diffSectionAnchors reports appeared + disappeared', () => {
  const d = diffSectionAnchors(['sec_a', 'sec_b', 'sec_c'], ['sec_b', 'sec_c', 'sec_d']);
  assert.deepEqual(d.appeared, ['sec_d']);
  assert.deepEqual(d.disappeared, ['sec_a']);
});

// ── DB-backed register (insert + archive + un-archive), via fake registry ─────

test('registerSectionsFromHtml inserts anchored, mints anchorless, and patches HTML', () => {
  const { deps, rows } = fakeRegistry();
  const html = '<body><section data-anchor="sec_aaa111" data-zone="x">X</section><section data-zone="y">Y</section></body>';
  const res = registerSectionsFromHtml(deps, 'plan-1', html);
  assert.equal(res.mintedAnchors.length, 1, 'the anchorless section was minted');
  assert.ok(res.htmlChanged, 'HTML patched with the mint');
  assert.equal(rows.length, 2, 'both sections registered');
  assert.ok(rows.every((r) => r.archivedAt === null));
});

test('a disappeared anchor is soft-archived (never deleted); plan_events untouched by design', () => {
  const { deps, rows } = fakeRegistry();
  const withBoth = '<body><section data-anchor="sec_aaa111" data-zone="x">X</section><section data-anchor="sec_bbb222" data-zone="y">Y</section></body>';
  registerSectionsFromHtml(deps, 'plan-1', withBoth);
  assert.equal(rows.length, 2);
  // sec_bbb222 disappears from the HTML.
  const withoutB = '<body><section data-anchor="sec_aaa111" data-zone="x">X</section></body>';
  const res = registerSectionsFromHtml(deps, 'plan-1', withoutB);
  assert.deepEqual(res.archivedAnchors, ['sec_bbb222']);
  const bbb = rows.find((r) => r.anchor === 'sec_bbb222')!;
  assert.ok(bbb, 'row NOT deleted');
  assert.ok(bbb.archivedAt, 'archived_at set');
});

test('a reappeared archived anchor un-archives (prose came back)', () => {
  const { deps, rows } = fakeRegistry();
  const both = '<body><section data-anchor="sec_aaa111" data-zone="x">X</section><section data-anchor="sec_bbb222" data-zone="y">Y</section></body>';
  const onlyA = '<body><section data-anchor="sec_aaa111" data-zone="x">X</section></body>';
  registerSectionsFromHtml(deps, 'plan-1', both);
  registerSectionsFromHtml(deps, 'plan-1', onlyA); // archives bbb
  assert.ok(rows.find((r) => r.anchor === 'sec_bbb222')!.archivedAt);
  registerSectionsFromHtml(deps, 'plan-1', both);  // bbb returns
  assert.equal(rows.find((r) => r.anchor === 'sec_bbb222')!.archivedAt, null, 'un-archived');
});

test('registerSectionsFromHtml is idempotent — re-registering identical HTML mints/archives nothing', () => {
  const { deps } = fakeRegistry();
  const html = '<body><section data-anchor="sec_aaa111" data-zone="x">X</section></body>';
  registerSectionsFromHtml(deps, 'plan-1', html);
  const res = registerSectionsFromHtml(deps, 'plan-1', html);
  assert.equal(res.mintedAnchors.length, 0);
  assert.equal(res.archivedAnchors.length, 0);
  assert.equal(res.htmlChanged, false);
});

// ── lazy block minting ────────────────────────────────────────────────────────

test('registerBlocksFromHtml mints blk_ for notable anchorless blocks only', () => {
  const html = '<body><section data-anchor="sec_aaa111" data-zone="x"><h2>H</h2><p>x</p></section></body>';
  const res = registerBlocksFromHtml('sec_aaa111', html, seqMint('blk'));
  assert.equal(res.minted.length, 1, 'the heading is a notable block; the short <p> is not');
  assert.ok(res.html.includes('<h2 data-anchor="blk_zzz001">'));
});

// ── I-6 Part 2: patchAnchorlessBlocks (mint only-when-missing) ────────────────

// A zone with an author-anchored h3 (must stay byte-identical), an anchorless h3
// (mint target), and an anchorless notable div (mint target).
const BLK_MIXED =
  '<body><section data-anchor="sec_dcsion" data-zone="decisions">'
  + '<h2>Decisions</h2>'
  + '<h3 data-anchor="dec_ident">Identity</h3>'
  + '<h3>Fresh heading</h3>'
  + '<div data-block-type="artifact"><p>artifact body</p></div>'
  + '</section></body>';

test('patchAnchorlessBlocks mints ONLY for anchorless notable blocks; author anchors untouched', () => {
  const proj = parsePlanHtml(BLK_MIXED);
  const { html: patched, minted } = patchAnchorlessBlocks(BLK_MIXED, proj, seqMint('blk'));
  // Anchorless notable blocks: <h2>Decisions</h2>, the <h3>Fresh heading</h3>, and
  // the artifact <div> → 3 mints. The author-anchored dec_ident h3 is skipped.
  assert.equal(minted.length, 3, 'the h2 + fresh h3 + artifact div are minted; dec_ident is not');
  // The author-anchored h3 stays byte-identical — no SECOND data-anchor inserted.
  assert.ok(patched.includes('<h3 data-anchor="dec_ident">Identity</h3>'), 'dec_ident tag byte-identical');
  const decOccurrences = patched.split('<h3 data-anchor="dec_ident"').length - 1;
  assert.equal(decOccurrences, 1, 'dec_ident heading never gains a duplicate data-anchor');
  // The two anchorless blocks now carry blk_ anchors.
  assert.ok(patched.includes('<h3 data-anchor="blk_zzz'), 'anchorless heading minted');
  // The mint is inserted just after `<div`, so it precedes the existing attr.
  assert.ok(patched.includes('<div data-anchor="blk_zzz'), 'anchorless artifact minted');
  assert.ok(patched.includes('data-block-type="artifact"'), 'existing attr preserved');
});

test('patched HTML re-parses with every notable block anchored; patchAnchorlessBlocks is idempotent', () => {
  const proj = parsePlanHtml(BLK_MIXED);
  const { html: patched } = patchAnchorlessBlocks(BLK_MIXED, proj, seqMint('blk'));
  const proj2 = parsePlanHtml(patched);
  const sec = proj2.sections.find((s) => s.anchor === 'sec_dcsion')!;
  for (const b of sec.blocks) {
    assert.ok(b.anchor, `block ${b.tagName} is anchored after the patch`);
    assert.equal(patched.slice(b.startOffset, b.endOffset), b.raw, 'block raw stays byte-exact');
  }
  // Second pass over already-patched HTML → no targets → no-op.
  const again = patchAnchorlessBlocks(patched, proj2, seqMint('blk'));
  assert.equal(again.minted.length, 0, 'second pass mints nothing');
  assert.equal(again.html, patched, 'second pass returns HTML unchanged');
});

test('registerSectionsFromHtml returns mintedBlockAnchors, and mintedAnchors stays blk_-free', () => {
  const { deps } = fakeRegistry();
  const res = registerSectionsFromHtml(deps, 'plan-1', BLK_MIXED);
  assert.ok(res.mintedBlockAnchors.length >= 2, 'anchorless notable blocks minted into mintedBlockAnchors');
  assert.ok(res.mintedBlockAnchors.every((a) => a.startsWith('blk_')), 'all block mints are blk_');
  assert.ok(res.mintedAnchors.every((a) => !a.startsWith('blk_')), 'section-mint list carries NO blk_');
  assert.ok(res.htmlChanged, 'block backfill changed the HTML');
  // Re-registering the patched HTML mints no more blocks (idempotent steady state).
  const res2 = registerSectionsFromHtml(deps, 'plan-1', res.html);
  assert.equal(res2.mintedBlockAnchors.length, 0, 'steady state: zero further block mints');
  assert.equal(res2.htmlChanged, false, 'steady state: no write');
});

test('registerSectionsFromHtml over an ALREADY-fully-anchored plan writes nothing (idempotency)', () => {
  const { deps } = fakeRegistry();
  const anchored =
    '<body><section data-anchor="sec_dcsion" data-zone="d">'
    + '<h3 data-anchor="dec_ident">Identity</h3></section></body>';
  const res = registerSectionsFromHtml(deps, 'plan-1', anchored);
  assert.equal(res.mintedBlockAnchors.length, 0, 'author-anchored h3 is never re-stamped');
  assert.equal(res.mintedAnchors.length, 0);
  assert.equal(res.htmlChanged, false);
  assert.equal(res.html, anchored, 'HTML byte-identical');
});

// ── Runner ─────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
