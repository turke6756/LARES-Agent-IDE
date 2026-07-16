// GT-C Decision 1 (§1.10) — execution-trail render tests (pure, no I/O).
//
//   npm run build:main
//   node dist/main/main/plans/execution-trail.test.js

import assert from 'node:assert/strict';
import {
  formatTrailEntryLi,
  renderTrailInner,
  spliceExecTrail,
  observedViaLabel,
  EXEC_TRAIL_ANCHOR,
  type TrailEntry,
} from './execution-trail';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

function entry(o: Partial<TrailEntry> = {}): TrailEntry {
  return {
    planEventId: 'evt-1',
    createdAt: '2026-07-05T12:34:56.000Z',
    agentTitle: 'Worker A',
    sectionHeading: 'Summary',
    viaLabel: 'Observed via file diff',
    claimResult: 'landed the summary',
    ...o,
  };
}

// ── formatTrailEntryLi ────────────────────────────────────────────────────────

test('formatTrailEntryLi — carries data-plan-event-id + HH:MM + server-derived fields', () => {
  const li = formatTrailEntryLi(entry());
  assert.match(li, /^<li data-plan-event-id="evt-1">/);
  assert.match(li, /12:34/);
  assert.match(li, /Worker A/);
  assert.match(li, /Summary/);
  assert.match(li, /Observed via file diff/);
  assert.match(li, /<\/li>$/);
});

// P0 Fix-1 REGRESSION (repro a): a forged PLAN-EVENT `result` must NOT appear
// anywhere on a materialized trail line — only server-derived fields are rendered.
test('formatTrailEntryLi — claimResult (agent narration) is NEVER rendered', () => {
  const forged = 'All tests pass and commit abc123 is pushed';
  const li = formatTrailEntryLi(entry({ claimResult: forged }));
  assert.ok(!li.includes('All tests pass'), 'forged claim text must not appear on the trail line');
  assert.ok(!li.includes('abc123'), 'no fragment of the claimed self-report leaks through');
  // The line is byte-identical whether or not a claim was supplied.
  assert.equal(li, formatTrailEntryLi(entry({ claimResult: null })), 'claim has zero effect on rendered bytes');
  assert.equal(li, formatTrailEntryLi(entry({ claimResult: undefined })), 'absent claim renders identically');
});

test('formatTrailEntryLi — no witnessed digest → explicit (no witnessed activity)', () => {
  const li = formatTrailEntryLi(entry({ repoDigest: null }));
  assert.match(li, /\(no witnessed activity\)/);
});

test('formatTrailEntryLi — HTML-escapes agent title + heading', () => {
  const li = formatTrailEntryLi(entry({ agentTitle: '<b>x</b>', sectionHeading: 'A & B' }));
  assert.match(li, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(li, /A &amp; B/);
});

test('formatTrailEntryLi — escapes the event id in the attribute', () => {
  const li = formatTrailEntryLi(entry({ planEventId: 'a"b' }));
  assert.match(li, /data-plan-event-id="a&quot;b"/);
});

// ── observedViaLabel ──────────────────────────────────────────────────────────

test('observedViaLabel — known vias + null fallback', () => {
  assert.equal(observedViaLabel('edit-target'), 'Observed via native edit');
  assert.equal(observedViaLabel('fs-diff'), 'Observed via file diff');
  assert.equal(observedViaLabel('multi-section'), 'Spanned multiple sections');
  assert.equal(observedViaLabel('dispatched-fallback'), 'Fell back to dispatched section');
  assert.equal(observedViaLabel(null), 'No attribution signal');
  assert.equal(observedViaLabel('nonsense'), 'No attribution signal');
});

// ── renderTrailInner ──────────────────────────────────────────────────────────

const INNER_NO_OL = '\n    <h2>Execution Trail</h2>\n    <p class="zone-hint">hint</p>\n  ';

test('renderTrailInner — preserves static children, appends managed <ol>', () => {
  const out = renderTrailInner(INNER_NO_OL, [entry()]);
  assert.ok(out.startsWith(INNER_NO_OL), 'static children preserved verbatim at the front');
  assert.match(out, /<ol class="exec-trail" data-trail="1">/);
  assert.match(out, /data-plan-event-id="evt-1"/);
  assert.match(out, /<\/ol>$/);
});

test('renderTrailInner — replaces a prior data-trail <ol>, keeps other children', () => {
  const withOl = INNER_NO_OL + '<ol class="exec-trail" data-trail="1">\n    <li data-plan-event-id="old">old</li>\n  </ol>';
  const out = renderTrailInner(withOl, [entry({ planEventId: 'new-1' })]);
  assert.ok(!out.includes('data-plan-event-id="old"'), 'prior trail entries are gone');
  assert.match(out, /data-plan-event-id="new-1"/);
  assert.ok(out.includes('<h2>Execution Trail</h2>'), 'static heading kept');
  // exactly one managed ol
  assert.equal(out.match(/data-trail="1"/g)?.length, 1);
});

test('renderTrailInner — tolerant of reversed attribute order in the prior <ol>', () => {
  const withOl = INNER_NO_OL + '<ol data-trail="1" class="exec-trail"><li data-plan-event-id="old">o</li></ol>';
  const out = renderTrailInner(withOl, [entry({ planEventId: 'new-9' })]);
  assert.ok(!out.includes('"old"'));
  assert.match(out, /data-plan-event-id="new-9"/);
});

test('renderTrailInner — idempotent: rendering twice yields identical bytes', () => {
  const once = renderTrailInner(INNER_NO_OL, [entry(), entry({ planEventId: 'evt-2' })]);
  const twice = renderTrailInner(once, [entry(), entry({ planEventId: 'evt-2' })]);
  assert.equal(twice, once);
});

// ── renderTrailInner — manual (author-written) entry preservation ─────────────

// The data-loss scenario: a mis-dispatched agent hand-appended <li>s (no
// data-plan-event-id) inside the managed system <ol>.
const OL_WITH_MANUAL =
  INNER_NO_OL +
  '<ol class="exec-trail" data-trail="1">' +
  '\n    <li data-plan-event-id="sys-1">system row</li>' +
  '\n    <li>P0 worker hand-wrote this</li>' +
  '\n    <li>P1 worker note</li>' +
  '\n  </ol>';

// P0 Fix (repro c): a hand-appended manual <li> must land in the QUARANTINE block —
// a separately-headed `data-unverified-manual-trail` container — never unlabelled
// beside the trusted system rows, and never silently discarded.
test('renderTrailInner — quarantines hand-appended <li>s under the Unverified manual notes heading', () => {
  const out = renderTrailInner(OL_WITH_MANUAL, [entry({ planEventId: 'sys-2' })]);
  // System list regenerated from entries only.
  assert.ok(!out.includes('data-plan-event-id="sys-1"'), 'stale system row regenerated away');
  assert.match(out, /data-plan-event-id="sys-2"/);
  // The quarantine container + its explicit warning heading are present.
  assert.match(out, /<div class="unverified-manual-trail" data-unverified-manual-trail="1">/);
  assert.match(out, /data-unverified-manual-heading="1"/);
  assert.match(out, /Unverified manual notes — hand-written, NOT system-verified/);
  assert.match(out, /<ul class="exec-trail-manual" data-trail-manual="1">/);
  // Manual entries survive verbatim, relocated INTO the quarantine container.
  const container = out.match(/<div class="unverified-manual-trail"[\s\S]*?<\/div>/)![0];
  assert.ok(container.includes('<li>P0 worker hand-wrote this</li>'), 'P0 manual entry preserved inside quarantine');
  assert.ok(container.includes('<li>P1 worker note</li>'), 'P1 manual entry preserved inside quarantine');
  // The manual <li>s must NOT remain inside the trusted system <ol>.
  const ol = out.match(/<ol class="exec-trail" data-trail="1">[\s\S]*?<\/ol>/)![0];
  assert.ok(!ol.includes('P0 worker'), 'system ol contains only system rows');
  assert.ok(!ol.includes('P1 worker'), 'system ol contains only system rows');
});

test('renderTrailInner — manual preservation is idempotent (second pass = identical bytes)', () => {
  const once = renderTrailInner(OL_WITH_MANUAL, [entry({ planEventId: 'sys-2' })]);
  const twice = renderTrailInner(once, [entry({ planEventId: 'sys-2' })]);
  assert.equal(twice, once, 'renderTrailInner(renderTrailInner(x,E),E) === renderTrailInner(x,E)');
});

test('renderTrailInner — manual block alone (no system ol) round-trips idempotently', () => {
  const withManualOnly =
    INNER_NO_OL +
    '<ol class="exec-trail" data-trail="1">\n  </ol>' +
    '<ul class="exec-trail-manual" data-trail-manual="1">\n    <li>lone manual note</li>\n  </ul>';
  const once = renderTrailInner(withManualOnly, [entry({ planEventId: 'e' })]);
  assert.ok(once.includes('<li>lone manual note</li>'), 'existing manual-block entry preserved');
  const twice = renderTrailInner(once, [entry({ planEventId: 'e' })]);
  assert.equal(twice, once);
});

test('renderTrailInner — mixed: existing manual block entries kept first, new orphans appended', () => {
  const mixed =
    INNER_NO_OL +
    '<ol class="exec-trail" data-trail="1">' +
    '\n    <li data-plan-event-id="s">sys</li>' +
    '\n    <li>fresh orphan in ol</li>' +
    '\n  </ol>' +
    '<ul class="exec-trail-manual" data-trail-manual="1">\n    <li>older manual A</li>\n  </ul>';
  const out = renderTrailInner(mixed, [entry({ planEventId: 's2' })]);
  const manualBlock = out.match(/<ul class="exec-trail-manual"[\s\S]*?<\/ul>/)![0];
  // Existing manual-block entry first, then the newly-relocated orphan.
  assert.ok(manualBlock.indexOf('older manual A') < manualBlock.indexOf('fresh orphan in ol'),
    'existing manual entries retain position, orphans append after');
  // And it stabilizes on the next pass.
  const twice = renderTrailInner(out, [entry({ planEventId: 's2' })]);
  assert.equal(twice, out, 'ordering stabilizes → idempotent');
});

test('renderTrailInner — a manual <li> mentioning data-plan-event-id in its BODY is still preserved', () => {
  const html =
    INNER_NO_OL +
    '<ol class="exec-trail" data-trail="1">\n    <li>note about data-plan-event-id attributes</li>\n  </ol>';
  const out = renderTrailInner(html, [entry()]);
  assert.ok(out.includes('<li>note about data-plan-event-id attributes</li>'),
    'body mention is not misclassified as a system row');
});

test('renderTrailInner — malformed manual <li> (nested li) degrades to a safe escaped form, no corruption', () => {
  const html =
    INNER_NO_OL +
    '<ol class="exec-trail" data-trail="1">\n    <li>broken <li> nested</li>\n  </ol>';
  const out = renderTrailInner(html, [entry()]);
  // The dangerous nested <li> is not re-emitted raw; it appears escaped.
  assert.ok(!/<li>broken <li> nested<\/li>/.test(out), 'raw nested <li> not re-emitted verbatim');
  assert.match(out, /&lt;li&gt;/, 'degraded to an escaped safe form');
  // Structure is intact: exactly one system ol and one manual ul.
  assert.equal(out.match(/data-trail="1"/g)?.length, 1, 'one system ol');
  assert.equal(out.match(/data-trail-manual="1"/g)?.length, 1, 'one manual ul');
  // And it stays idempotent (escaped form re-classifies as flat → verbatim).
  const twice = renderTrailInner(out, [entry()]);
  assert.equal(twice, out);
});

test('renderTrailInner — a manual <li> with NO closing tag is dropped, never corrupts the splice', () => {
  const html =
    INNER_NO_OL +
    '<ol class="exec-trail" data-trail="1">\n    <li data-plan-event-id="s">sys</li>\n    <li>unterminated\n  </ol>';
  const out = renderTrailInner(html, [entry({ planEventId: 's2' })]);
  assert.match(out, /data-plan-event-id="s2"/, 'system row regenerated fine');
  assert.ok(!out.includes('exec-trail-manual'), 'unterminated li matched nothing → no manual block');
  assert.equal(out.match(/data-trail="1"/g)?.length, 1, 'splice structurally intact');
});

test('renderTrailInner — no manual entries → no manual block emitted (byte-compat with prior behavior)', () => {
  const out = renderTrailInner(INNER_NO_OL, [entry()]);
  assert.ok(!out.includes('exec-trail-manual'), 'no sibling block when there is nothing to preserve');
  assert.ok(out.endsWith('</ol>'), 'ends with the system ol exactly as before');
});

// ── spliceExecTrail ───────────────────────────────────────────────────────────

const HTML = [
  '<!DOCTYPE html><html><body data-plan-id="p1">',
  '<section data-zone="summary" data-anchor="sec_summry"><h2>Summary</h2><p>keep me</p></section>',
  '<section data-zone="execution-trail" data-anchor="sec_exectr"><h2>Execution Trail</h2><p class="zone-hint">hint</p></section>',
  '<section data-zone="open-items" data-anchor="sec_opitem"><h2>Open Items</h2><p>tail</p></section>',
  '</body></html>',
].join('\n');

test('spliceExecTrail — replaces only sec_exectr inner; bytes outside untouched', () => {
  const out = spliceExecTrail(HTML, [entry()]);
  const anchorIdx = HTML.indexOf('data-anchor="sec_exectr"');
  const innerStart = HTML.indexOf('>', anchorIdx) + 1; // after the section open tag
  // Everything strictly before the sec_exectr open tag is byte-identical.
  const before = HTML.slice(0, anchorIdx);
  assert.ok(out.startsWith(HTML.slice(0, HTML.indexOf('<section data-zone="execution-trail"'))),
    'summary section + doc head byte-identical');
  assert.ok(out.includes('<p>keep me</p>'), 'other section content preserved');
  assert.ok(out.includes('<p>tail</p>'), 'trailing section preserved');
  assert.match(out, /data-plan-event-id="evt-1"/);
  void innerStart; void before;
});

test('spliceExecTrail — the Open Items section is byte-identical after splice', () => {
  const out = spliceExecTrail(HTML, [entry()]);
  const tailSection = '<section data-zone="open-items" data-anchor="sec_opitem"><h2>Open Items</h2><p>tail</p></section>';
  assert.ok(out.includes(tailSection), 'the section AFTER sec_exectr survives unchanged');
});

test('spliceExecTrail — idempotent: running twice on same entries → identical bytes', () => {
  const once = spliceExecTrail(HTML, [entry(), entry({ planEventId: 'evt-2' })]);
  const twice = spliceExecTrail(once, [entry(), entry({ planEventId: 'evt-2' })]);
  assert.equal(twice, once);
});

test('spliceExecTrail — missing sec_exectr section → html unchanged', () => {
  const noTrail = '<!DOCTYPE html><html><body><section data-anchor="sec_summry"><h2>S</h2></section></body></html>';
  assert.equal(spliceExecTrail(noTrail, [entry()]), noTrail);
});

test('spliceExecTrail — a prior trail <ol> is replaced, static children preserved', () => {
  const first = spliceExecTrail(HTML, [entry({ planEventId: 'a' })]);
  const second = spliceExecTrail(first, [entry({ planEventId: 'b' })]);
  assert.ok(!second.includes('data-plan-event-id="a"'), 'stale entry replaced');
  assert.match(second, /data-plan-event-id="b"/);
  assert.ok(second.includes('<p class="zone-hint">hint</p>'), 'zone-hint preserved');
  assert.equal(second.match(/data-trail="1"/g)?.length, 1, 'exactly one managed ol survives');
});

test('spliceExecTrail — anchor constant matches the seed zone', () => {
  assert.equal(EXEC_TRAIL_ANCHOR, 'sec_exectr');
});

test('spliceExecTrail — preserves hand-appended manual <li>s across a materialization + idempotent', () => {
  // sec_exectr already carries a system ol with a mis-dispatched agent's manual row.
  const withManual = [
    '<!DOCTYPE html><html><body data-plan-id="p1">',
    '<section data-zone="summary" data-anchor="sec_summry"><h2>Summary</h2><p>keep me</p></section>',
    '<section data-zone="execution-trail" data-anchor="sec_exectr"><h2>Execution Trail</h2>' +
      '<ol class="exec-trail" data-trail="1"><li data-plan-event-id="old">old sys</li>' +
      '<li>HAND WRITTEN by P3</li></ol></section>',
    '<section data-zone="open-items" data-anchor="sec_opitem"><h2>Open Items</h2><p>tail</p></section>',
    '</body></html>',
  ].join('\n');
  const out = spliceExecTrail(withManual, [entry({ planEventId: 'fresh' })]);
  assert.ok(!out.includes('data-plan-event-id="old"'), 'system row regenerated');
  assert.match(out, /data-plan-event-id="fresh"/);
  assert.ok(out.includes('<li>HAND WRITTEN by P3</li>'), 'manual entry survives the materialization');
  assert.ok(out.includes('data-trail-manual="1"'), 'relocated into the manual sibling block');
  assert.ok(out.includes('<p>keep me</p>') && out.includes('<p>tail</p>'), 'sibling sections untouched');
  // Idempotency through the full parse+splice path.
  const twice = spliceExecTrail(out, [entry({ planEventId: 'fresh' })]);
  assert.equal(twice, out, 'second materialization is byte-identical');
});

// ── Fix-4 §5: witnessed repo digest is the sole evidentiary payload (I-1) ─────
// (Reworked for P0 Fix-1: the digest replaces — never rides beside — the claim.)

test('fix4 §5b — witnessed digest is the trailing payload, single escaped <li>', () => {
  const li = formatTrailEntryLi(entry({ repoDigest: 'witnessed: 3 repo files edited' }));
  assert.equal(li.match(/<li /g)?.length, 1, 'exactly one <li>');
  assert.match(li, /Observed via file diff — witnessed: 3 repo files edited<\/li>$/,
    'digest is the payload after the server-derived metadata');
});

test('fix4 §5b (I-1) — an entry with repoDigest double-renders byte-identical', () => {
  const e = entry({ planEventId: 'evt-d', repoDigest: 'witnessed: 9 repo files edited; 2 read' });
  const once = renderTrailInner(INNER_NO_OL, [e]);
  const twice = renderTrailInner(once, [e]);
  assert.equal(twice, once, 'digest lives in the escaped text node → idempotent');
});

test('fix4 §5b — truncation order: long metadata is soft-capped, the digest survives intact', () => {
  const longHeading = 'H'.repeat(400);
  const digest = 'witnessed: 42 repo files edited; 7 created; 13 read';
  const li = formatTrailEntryLi(entry({ sectionHeading: longHeading, repoDigest: digest }));
  assert.match(li, /…/, 'the over-long server metadata is soft-capped with an ellipsis');
  assert.ok(li.includes(digest), 'the digest clause is present in full — never the part cut');
  assert.ok(li.indexOf('…') < li.indexOf(digest), 'ellipsis precedes the surviving digest');
});

test('fix4 §5b — repoDigest null / empty → explicit (no witnessed activity), claim-independent', () => {
  const base = formatTrailEntryLi(entry());
  assert.equal(formatTrailEntryLi(entry({ repoDigest: null })), base, 'null digest → base');
  assert.equal(formatTrailEntryLi(entry({ repoDigest: '   ' })), base, 'whitespace-only digest → base');
  assert.equal(formatTrailEntryLi(entry({ repoDigest: undefined })), base, 'absent digest → base');
  assert.match(base, / — \(no witnessed activity\)<\/li>$/, 'no digest renders the explicit fallback');
});

test('fix4 §5b — a digest containing < / & is entity-escaped (proves the escape path)', () => {
  const li = formatTrailEntryLi(entry({ repoDigest: 'witnessed: <b> & more' }));
  assert.ok(!li.includes('<b>'), 'raw < must not ride into the HTML');
  assert.match(li, /witnessed: &lt;b&gt; &amp; more/, 'digest escaped with the rest of the text node');
});

// ── Runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.run(); passed++; }
  catch (err) { failed++; console.error(`✗ ${t.name}\n  ${(err as Error).message}`); }
}
console.log(`\nexecution-trail: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
