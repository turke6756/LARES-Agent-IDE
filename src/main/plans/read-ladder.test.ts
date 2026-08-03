// WP-P0B — read-ladder ceremony-subtraction unit test.
//
// Proves the two halves of the ceremony strip at the read-ladder seam:
//   1. `EDIT_DISCIPLINE` no longer carries any read-before-edit obligation — it
//      is now the empty string (grep the emitted value, not just the symbol).
//   2. The `raw+editWindow` MODE and its byte-exact response are PRESERVED: the
//      window still returns an `oldString` that is a verbatim substring of the
//      source (so native Edit's `old_string` matches), plus its source range and
//      the append point.
//
//   npm run build:main
//   node dist/main/main/plans/read-ladder.test.js

import assert from 'node:assert/strict';
import { parsePlanHtml } from './section-reader';
import { readPlanSection, EDIT_DISCIPLINE } from './read-ladder';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const HTML = [
  '<!doctype html><html><body>',
  '<section data-anchor="sec_aaa111" data-zone="plan">',
  '  <h2>Plan</h2>',
  '  <p>a section body worth editing</p>',
  '</section>',
  '</body></html>',
].join('\n');

// ── 1. EDIT_DISCIPLINE ceremony is stripped ───────────────────────────────────

test('EDIT_DISCIPLINE is empty — no read-before-edit obligation survives', () => {
  assert.equal(EDIT_DISCIPLINE, '', 'the obligating edit-discipline text is removed');
});

test('EDIT_DISCIPLINE emitted value carries none of the retired discipline phrasing', () => {
  for (const ceremony of ['replace ONLY', 'data-anchor', 'Read that section', 'raw+editWindow']) {
    assert.ok(!EDIT_DISCIPLINE.includes(ceremony), `retired phrase "${ceremony}" must be absent`);
  }
});

// ── 2. raw+editWindow mode + byte-exact response are preserved ─────────────────

test('mode:raw+editWindow still returns a byte-exact oldString + source range + append point', () => {
  const proj = parsePlanHtml(HTML);
  const res = readPlanSection(proj, 'sec_aaa111', { mode: 'raw+editWindow' });
  assert.ok(res.found && res.editWindow, 'the editWindow mode is still supported');
  const ew = res.editWindow!;
  // Byte-exact: oldString is exactly source[start:end] and appears verbatim in the source.
  assert.equal(ew.oldString, HTML.slice(ew.startOffset, ew.endOffset), 'oldString == source[start:end]');
  assert.ok(HTML.includes(ew.oldString), 'oldString matches the source verbatim → native Edit old_string would match');
  // Append point sits just before the closing tag of the fragment.
  assert.ok(HTML.slice(ew.appendOffset).trimStart().startsWith('</section>'), 'append point precedes the close tag');
});

test('editWindow.instructions surfaces the (now empty) EDIT_DISCIPLINE — response shape unchanged', () => {
  const proj = parsePlanHtml(HTML);
  const res = readPlanSection(proj, 'sec_aaa111', { mode: 'raw+editWindow' });
  assert.equal(res.editWindow!.instructions, EDIT_DISCIPLINE, 'instructions still wired to EDIT_DISCIPLINE');
  assert.equal(res.editWindow!.instructions, '', 'and it emits no obligation');
});

test('mode:raw still yields a verbatim-substring content window (unchanged)', () => {
  const proj = parsePlanHtml(HTML);
  const res = readPlanSection(proj, 'sec_aaa111', { mode: 'raw' });
  assert.ok(res.found && res.content);
  assert.equal(res.content, HTML.slice(res.contentRange!.startOffset, res.contentRange!.endOffset));
});

// ── Runner ─────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
