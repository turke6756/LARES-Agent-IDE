// WP4 — section-reader + read-ladder unit test.
//
// The load-bearing property: section/block `raw` fragments are byte-exact
// substrings of the source, so they match native Edit's `old_string`. Also
// covers lazy blk thresholds, anchorless/duplicate repair warnings, editWindow
// oldString + append point, offset/limit windowing, and parse-failure safety.
//
//   npm run build:main
//   node dist/main/main/plans/section-reader.test.js

import assert from 'node:assert/strict';
import { parsePlanHtml, parsePlanHtmlSafe, LAZY_BLOCK_BYTE_THRESHOLD } from './section-reader';
import { readPlanSection, listPlanSections, EDIT_DISCIPLINE } from './read-ladder';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// A representative surface: two zones, one with a heading + an over-threshold
// artifact block, one anchorless (mint candidate).
const bigBody = 'x'.repeat(LAZY_BLOCK_BYTE_THRESHOLD + 50);
const HTML = [
  '<!doctype html><html><body>',
  '<section data-anchor="sec_aaa111" data-zone="research">',
  '  <h2>Research Notes</h2>',
  `  <div data-block-type="artifact" data-anchor="blk_bbb222"><p>${bigBody}</p></div>`,
  '  <p>short prose</p>',
  '</section>',
  '<section data-zone="plan"><h2>Plan</h2><p>anchorless zone</p></section>',
  '</body></html>',
].join('\n');

// ── byte-exact fragments ──────────────────────────────────────────────────────

test('section raw fragment is a verbatim substring of the source (Edit old_string semantics)', () => {
  const proj = parsePlanHtml(HTML);
  const sec = proj.sections.find((s) => s.anchor === 'sec_aaa111')!;
  assert.ok(sec, 'section located by anchor');
  assert.equal(HTML.slice(sec.startOffset, sec.endOffset), sec.raw, 'raw is exactly source[start:end]');
  assert.ok(sec.raw.startsWith('<section data-anchor="sec_aaa111"'), 'opening tag verbatim');
  assert.ok(sec.raw.endsWith('</section>'), 'closing tag verbatim');
  assert.ok(HTML.includes(sec.raw), 'raw appears verbatim in source → Edit old_string would match');
});

test('inner range excludes the open/close tags', () => {
  const proj = parsePlanHtml(HTML);
  const sec = proj.sections.find((s) => s.anchor === 'sec_aaa111')!;
  const inner = HTML.slice(sec.innerStartOffset, sec.innerEndOffset);
  assert.ok(!inner.startsWith('<section'), 'inner starts after the open tag');
  assert.ok(!inner.endsWith('</section>'), 'inner ends before the close tag');
  assert.ok(inner.includes('Research Notes'));
});

// ── lazy block thresholds (R2 §4.3) ───────────────────────────────────────────

test('heading + over-threshold artifact become notable blocks; short prose does not', () => {
  const proj = parsePlanHtml(HTML);
  const sec = proj.sections.find((s) => s.anchor === 'sec_aaa111')!;
  const tags = sec.blocks.map((b) => b.tagName);
  assert.ok(tags.includes('h2'), 'heading is a notable block');
  assert.ok(tags.includes('div'), 'artifact/over-threshold div is a notable block');
  assert.ok(!tags.includes('p'), 'the short <p> stays section-level (below threshold, not notable)');
  const artifact = sec.blocks.find((b) => b.tagName === 'div')!;
  assert.equal(artifact.anchor, 'blk_bbb222', 'existing blk_ anchor preserved');
  assert.ok(artifact.isLazyCandidate);
  assert.equal(HTML.slice(artifact.startOffset, artifact.endOffset), artifact.raw, 'block raw is byte-exact too');
});

// ── I-6 Part 1: reader surfaces author-authored (non-blk_) block anchors ───────

// Mirrors the dogfood plan's Decisions/Open-Items zone: h3s already carry
// human-readable author anchors (dec_*, opi_*), one h3 has none, and a div
// carries a non-heading author anchor.
const MIXED = [
  '<body>',
  '<section data-anchor="sec_dcsion" data-zone="decisions">',
  '  <h2>Decisions</h2>',
  '  <h3 data-anchor="dec_ident">Identity model</h3>',
  '  <h3 data-anchor="opi_p0">Open P0</h3>',
  '  <h3>Unanchored heading</h3>',
  '  <div data-anchor="foo"><p>author-anchored non-heading block</p></div>',
  '</section>',
  '</body>',
].join('\n');

test('reader SURFACES an author-authored dec_ anchor on an h3 (I-6 Part 1, no writes)', () => {
  const proj = parsePlanHtml(MIXED);
  const sec = proj.sections.find((s) => s.anchor === 'sec_dcsion')!;
  const dec = sec.blocks.find((b) => b.heading === 'Identity model')!;
  assert.equal(dec.anchor, 'dec_ident', 'author anchor surfaced as-is, not discarded');
  assert.ok(dec.isLazyCandidate, 'author-anchored heading is still an outline candidate');
});

test('an anchorless heading surfaces anchor:null but stays isLazyCandidate (mint candidate)', () => {
  const proj = parsePlanHtml(MIXED);
  const sec = proj.sections.find((s) => s.anchor === 'sec_dcsion')!;
  const bare = sec.blocks.find((b) => b.heading === 'Unanchored heading')!;
  assert.equal(bare.anchor, null, 'no data-anchor → null → Part 2 mint candidate');
  assert.ok(bare.isLazyCandidate);
});

test('a <div> with a non-blk_ author anchor is notable via the broadened rule', () => {
  const proj = parsePlanHtml(MIXED);
  const sec = proj.sections.find((s) => s.anchor === 'sec_dcsion')!;
  const div = sec.blocks.find((b) => b.tagName === 'div')!;
  assert.ok(div, 'div became a notable block purely because it carries a data-anchor');
  assert.equal(div.anchor, 'foo', 'the non-blk_ anchor is surfaced verbatim');
  assert.ok(div.isLazyCandidate);
});

test('outline over the mixed zone returns a non-null anchor for every AUTHORED child', () => {
  const proj = parsePlanHtml(MIXED);
  const res = readPlanSection(proj, 'sec_dcsion', { mode: 'outline' });
  assert.ok(res.found && res.outline);
  const anchors = res.outline!.map((o) => o.anchor);
  assert.ok(anchors.includes('dec_ident') && anchors.includes('opi_p0') && anchors.includes('foo'),
    'author anchors are addressable in outline mode');
  // The one unanchored h3 is still null pre-mint (Part 2 fills it on registration).
  assert.ok(anchors.includes(null), 'the anchorless heading shows null until minted');
});

test('read_plan_section by an author anchor resolves the block (opaque-anchor namespace)', () => {
  const proj = parsePlanHtml(MIXED);
  const res = readPlanSection(proj, 'dec_ident', { mode: 'raw' });
  assert.ok(res.found, 'author anchor is a valid read argument');
  assert.equal(res.kind, 'block');
  assert.equal(res.content, MIXED.slice(res.contentRange!.startOffset, res.contentRange!.endOffset));
});

// ── anchorless / duplicate repair warnings (F-E) ──────────────────────────────

test('anchorless section is surfaced (null anchor) with a repair warning, never crashes', () => {
  const proj = parsePlanHtml(HTML);
  const anchorless = proj.sections.find((s) => s.zone === 'plan')!;
  assert.equal(anchorless.anchor, null);
  assert.ok(proj.warnings.some((w) => w.includes('missing data-anchor')));
});

test('duplicate data-anchor flags both sections + emits a warning', () => {
  const dup = '<body><section data-anchor="sec_dup000" data-zone="a">A</section>'
            + '<section data-anchor="sec_dup000" data-zone="b">B</section></body>';
  const proj = parsePlanHtml(dup);
  const dups = proj.sections.filter((s) => s.duplicateAnchor);
  assert.equal(dups.length, 2, 'both colliding sections flagged');
  assert.ok(proj.warnings.some((w) => w.includes('duplicate data-anchor')));
});

// ── read ladder modes ─────────────────────────────────────────────────────────

test('mode:raw+editWindow returns byte-exact oldString + append point + discipline text', () => {
  const proj = parsePlanHtml(HTML);
  const res = readPlanSection(proj, 'sec_aaa111', { mode: 'raw+editWindow' });
  assert.ok(res.found && res.editWindow);
  assert.equal(res.editWindow!.oldString, HTML.slice(res.editWindow!.startOffset, res.editWindow!.endOffset));
  assert.ok(HTML.includes(res.editWindow!.oldString), 'oldString matches source verbatim');
  assert.equal(res.editWindow!.instructions, EDIT_DISCIPLINE);
  // Append point sits before the closing </section>.
  assert.ok(HTML.slice(res.editWindow!.appendOffset).trimStart().startsWith('</section>'));
});

test('mode:outline lists child blocks with anchors + excerpts, no bodies', () => {
  const proj = parsePlanHtml(HTML);
  const res = readPlanSection(proj, 'sec_aaa111', { mode: 'outline' });
  assert.ok(res.found && res.outline);
  const anchors = res.outline!.map((o) => o.anchor);
  assert.ok(anchors.includes('blk_bbb222'));
  for (const o of res.outline!) assert.ok(o.excerpt.length <= 121, 'excerpt is one truncated line');
});

test('a blk_ anchor is a valid read argument (blocks share the namespace)', () => {
  const proj = parsePlanHtml(HTML);
  const res = readPlanSection(proj, 'blk_bbb222', { mode: 'raw' });
  assert.ok(res.found);
  assert.equal(res.kind, 'block');
  assert.equal(res.content, HTML.slice(res.contentRange!.startOffset, res.contentRange!.endOffset));
});

test('offset/limit window a raw fragment and the window stays a verbatim substring', () => {
  const proj = parsePlanHtml(HTML);
  const res = readPlanSection(proj, 'sec_aaa111', { mode: 'raw', offset: 5, limit: 20 });
  assert.ok(res.found && res.truncated);
  assert.equal(res.content!.length, 20);
  assert.ok(HTML.includes(res.content!), 'the windowed slice still matches source verbatim');
});

test('unknown anchor returns found:false, no throw', () => {
  const proj = parsePlanHtml(HTML);
  const res = readPlanSection(proj, 'sec_nope00', { mode: 'raw' });
  assert.equal(res.found, false);
  assert.ok(res.error);
});

test('listPlanSections is a bodyless orientation projection', () => {
  const proj = parsePlanHtml(HTML);
  const listing = listPlanSections(proj);
  assert.equal(listing.sections.length, 2);
  assert.equal(listing.parseError, null);
  assert.ok(listing.sections.some((s) => s.anchor === 'sec_aaa111' && s.zone === 'research'));
});

// ── parse-failure safety (F-E) ────────────────────────────────────────────────

test('parsePlanHtmlSafe never throws; parse5 leniency yields a projection', () => {
  const proj = parsePlanHtmlSafe('<section data-zone="x"><h2>unclosed');
  assert.equal(proj.parseError, null, 'parse5 recovers from unclosed tags → still a projection');
  assert.ok(proj.sections.length >= 1);
});

// ── Runner ─────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
