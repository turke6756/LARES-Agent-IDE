// WP5 — plan-surface sanitizer unit test (security-first serve path).
//
// Proves the parse5 tree-walk strips script-bearing constructs before HTML
// reaches the render pane: <script>, inline on* handlers, javascript:/data:
// URLs, srcdoc, and foreign-content embeds — while leaving legitimate plan
// markup (headings, links, data-anchor/data-zone attrs) intact.
//
//   npm run build:main
//   node dist/main/main/plans/sanitize-plan-html.test.js

import assert from 'node:assert/strict';
import { sanitizePlanHtml } from './sanitize-plan-html';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const lc = (s: string): string => s.toLowerCase();

test('drops <script> elements and their contents', () => {
  const out = sanitizePlanHtml('<p>before</p><script>alert(1)</script><p>after</p>');
  assert.ok(!lc(out).includes('<script'), 'no script tag survives');
  assert.ok(!out.includes('alert(1)'), 'script body is gone');
  assert.ok(out.includes('before') && out.includes('after'), 'surrounding text kept');
});

test('strips inline event-handler attributes', () => {
  const out = sanitizePlanHtml('<div onclick="steal()" onmouseover="x()">hi</div>');
  assert.ok(!lc(out).includes('onclick'), 'onclick removed');
  assert.ok(!lc(out).includes('onmouseover'), 'onmouseover removed');
  assert.ok(out.includes('hi'), 'element + text kept');
});

test('neutralizes javascript: URLs in href/src', () => {
  const out = sanitizePlanHtml('<a href="javascript:alert(1)">x</a><img src="JavaScript:evil()">');
  assert.ok(!lc(out).includes('javascript:'), 'no javascript: scheme survives');
  assert.ok(out.includes('<a'), 'the anchor element itself is kept (only the href dropped)');
});

test('drops data: URLs (attacker-controlled navigation target)', () => {
  const out = sanitizePlanHtml('<a href="data:text/html,<script>x</script>">y</a>');
  assert.ok(!lc(out).includes('data:'), 'data: href removed');
});

test('tolerates whitespace/control-char obfuscation of the scheme', () => {
  const out = sanitizePlanHtml('<a href="  java\tscript:alert(1)">x</a>');
  assert.ok(!lc(out).includes('alert(1)'), 'obfuscated javascript: still caught');
});

test('drops iframe/object/embed/noscript/base', () => {
  const out = sanitizePlanHtml(
    '<iframe src="http://x"></iframe><object></object><embed><noscript>n</noscript><base href="http://x"><p>keep</p>',
  );
  for (const tag of ['<iframe', '<object', '<embed', '<noscript', '<base']) {
    assert.ok(!lc(out).includes(tag), `${tag} removed`);
  }
  assert.ok(out.includes('keep'), 'legitimate content kept');
});

test('drops srcdoc and scriptable style, keeps benign style', () => {
  const evil = sanitizePlanHtml('<div srcdoc="<script>x</script>" style="width:expression(alert(1))">a</div>');
  assert.ok(!lc(evil).includes('srcdoc'), 'srcdoc removed');
  assert.ok(!lc(evil).includes('expression'), 'expression() style removed');
  const benign = sanitizePlanHtml('<div style="color:red">a</div>');
  assert.ok(lc(benign).includes('color:red'), 'benign inline style preserved');
});

test('preserves legitimate plan markup: headings, anchors, data-* attrs', () => {
  const src = '<section data-anchor="sec_a1" data-zone="goal"><h2>Goal</h2><a href="https://ok.dev">link</a></section>';
  const out = sanitizePlanHtml(src);
  assert.ok(out.includes('data-anchor="sec_a1"'), 'data-anchor kept (load-bearing for provenance)');
  assert.ok(out.includes('data-zone="goal"'), 'data-zone kept');
  assert.ok(out.includes('<h2>') && out.includes('Goal'), 'heading kept');
  assert.ok(out.includes('https://ok.dev'), 'http(s) link kept');
});

test('force-opens <details> (human view renders fully expanded)', () => {
  const out = sanitizePlanHtml('<details><summary>More</summary><p>body</p></details>');
  assert.ok(/<details[^>]*\sopen(\s|=|>)/i.test(out), '<details> gains the open attribute');
  assert.ok(out.includes('More') && out.includes('body'), 'summary + body content kept');
});

test('force-opens nested <details>', () => {
  const out = sanitizePlanHtml(
    '<details><summary>Outer</summary><details><summary>Inner</summary><p>x</p></details></details>',
  );
  const opens = out.match(/<details[^>]*\sopen(\s|=|>)/gi) ?? [];
  assert.equal(opens.length, 2, 'both the outer and the inner details are opened');
});

test('leaves an already-open <details> idempotent (no duplicate attr)', () => {
  const once = sanitizePlanHtml('<details open><summary>s</summary><p>b</p></details>');
  assert.equal((lc(once).match(/\sopen/g) ?? []).length, 1, 'a single open attribute survives');
  const twice = sanitizePlanHtml(once);
  assert.equal(twice, once, 're-sanitizing an opened details changes nothing');
});

test('is idempotent — sanitizing sanitized output is a no-op', () => {
  const once = sanitizePlanHtml('<p onclick="x()">hi<script>y</script></p>');
  const twice = sanitizePlanHtml(once);
  assert.equal(twice, once, 'second pass changes nothing');
});

test('is parse-tolerant on malformed / empty input', () => {
  assert.doesNotThrow(() => sanitizePlanHtml(''));
  assert.doesNotThrow(() => sanitizePlanHtml('<div><span>unclosed'));
  assert.doesNotThrow(() => sanitizePlanHtml('<<>>not really html'));
});

// ── Runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
