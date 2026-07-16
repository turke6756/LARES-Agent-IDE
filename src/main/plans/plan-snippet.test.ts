// Plans card gallery — snippet derivation test.
//
//   npm run build:main
//   node dist/main/main/plans/plan-snippet.test.js

import assert from 'node:assert/strict';
import { parsePlanHtml, type PlanProjection } from './section-reader';
import { derivePlanSnippet, PLAN_SNIPPET_MAX_CHARS } from './plan-snippet';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

function projfrom(html: string): PlanProjection {
  return parsePlanHtml(html);
}

test('prefers the summary zone prose and strips the heading', () => {
  const proj = projfrom(
    `<body>
       <section data-zone="summary" data-anchor="sec_summry"><h2>Summary</h2><p>Ship the planning surface gallery.</p></section>
       <section data-zone="decisions" data-anchor="sec_dcsion"><h2>Decisions</h2><p>Use cards.</p></section>
     </body>`,
  );
  assert.equal(derivePlanSnippet(proj), 'Ship the planning surface gallery.');
});

test('falls back to the first section with text when there is no summary zone', () => {
  const proj = projfrom(
    `<body>
       <section data-zone="research" data-anchor="sec_resrch"><h2>Research</h2><p>Prior art on card layouts.</p></section>
     </body>`,
  );
  assert.equal(derivePlanSnippet(proj), 'Prior art on card layouts.');
});

test('truncates near the limit on a word boundary with an ellipsis', () => {
  const long = 'word '.repeat(80).trim(); // 80 * 5 - 1 = 399 chars
  const proj = projfrom(
    `<body><section data-zone="summary" data-anchor="sec_summry"><h2>Summary</h2><p>${long}</p></section></body>`,
  );
  const snippet = derivePlanSnippet(proj)!;
  assert.ok(snippet.endsWith('…'), 'ends with ellipsis');
  assert.ok(snippet.length <= PLAN_SNIPPET_MAX_CHARS + 1, 'stays within the limit (+ ellipsis)');
  assert.ok(!snippet.slice(0, -1).endsWith(' '), 'no trailing space before the ellipsis');
});

test('returns null for an empty / textless / null projection', () => {
  assert.equal(derivePlanSnippet(null), null);
  assert.equal(derivePlanSnippet(undefined), null);
  assert.equal(derivePlanSnippet({ sections: [], parseError: null, warnings: [], source: '' }), null);
  const empty = projfrom(
    `<body><section data-zone="summary" data-anchor="sec_summry"><h2>Summary</h2></section></body>`,
  );
  assert.equal(derivePlanSnippet(empty), null, 'a heading-only section yields no prose');
});

// ── Runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
