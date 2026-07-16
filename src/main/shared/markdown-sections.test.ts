// Shared markdown section splitter — unit tests (Wave-2 §B).
//   npm run build:main
//   node dist/main/main/shared/markdown-sections.test.js
//
// Custom runner (matches the other context-overhead suites) so the file also runs
// under `node --test`.

import assert from 'node:assert/strict';
import { splitIntoSections } from './markdown-sections';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

test('content before the first heading becomes one (preamble) section', () => {
  const md = ['Intro prose line one.', 'Intro line two.', '', '# First', 'body'].join('\n');
  const secs = splitIntoSections(md);
  assert.equal(secs[0].heading, '(preamble)');
  assert.equal(secs[0].level, 0);
  assert.equal(secs[0].startLine, 1);
  assert.equal(secs[0].endLine, 3, 'preamble ends on the line before the first heading');
  assert.ok(secs[0].text.startsWith('Intro prose'));
  assert.equal(secs[1].heading, 'First');
  assert.equal(secs[1].level, 1);
  assert.equal(secs[1].startLine, 4);
});

test('a file with no headings → a single preamble spanning the whole file', () => {
  const md = ['just', 'prose', 'no headings'].join('\n');
  const secs = splitIntoSections(md);
  assert.equal(secs.length, 1);
  assert.equal(secs[0].heading, '(preamble)');
  assert.equal(secs[0].startLine, 1);
  assert.equal(secs[0].endLine, 3);
  assert.equal(secs[0].text, md);
});

test('a nested subsection stays inside its parent span; correct line boundaries', () => {
  const md = [
    '# Parent',     // 1
    'intro',        // 2
    '## Child',     // 3
    'child body',   // 4
    '# Sibling',    // 5
    'sib body',     // 6
  ].join('\n');
  const secs = splitIntoSections(md);
  const parent = secs.find((s) => s.heading === 'Parent')!;
  const child = secs.find((s) => s.heading === 'Child')!;
  const sibling = secs.find((s) => s.heading === 'Sibling')!;

  // Parent runs to the line before the next SAME-OR-HIGHER (level-1) heading.
  assert.equal(parent.startLine, 1);
  assert.equal(parent.endLine, 4, 'parent extends over its deeper child, stopping before the sibling');
  assert.ok(parent.text.includes('## Child'), 'the child heading is nested inside the parent text');

  // Child is emitted too, and its span sits inside the parent span.
  assert.equal(child.startLine, 3);
  assert.equal(child.endLine, 4);
  assert.ok(child.startLine >= parent.startLine && child.endLine <= parent.endLine,
    'child span is contained by the parent span');

  assert.equal(sibling.startLine, 5);
  assert.equal(sibling.endLine, 6, 'sibling runs to EOF');
});

test('deeper heading closes at the next same-or-higher heading, not at a shallower-only rule', () => {
  const md = [
    '## A',    // 1
    'a body',  // 2
    '### A1',  // 3
    'a1 body', // 4
    '### A2',  // 5
    'a2 body', // 6
    '## B',    // 7
  ].join('\n');
  const secs = splitIntoSections(md);
  const a = secs.find((s) => s.heading === 'A')!;
  const a1 = secs.find((s) => s.heading === 'A1')!;
  const a2 = secs.find((s) => s.heading === 'A2')!;
  assert.equal(a.endLine, 6, 'A (level 2) extends over A1/A2 (level 3), stopping before B');
  assert.equal(a1.startLine, 3);
  assert.equal(a1.endLine, 4, 'A1 stops before its level-3 sibling A2');
  assert.equal(a2.startLine, 5);
  assert.equal(a2.endLine, 6);
});

test('4+ hashes are not treated as headings (level cap is 3); CRLF is normalized', () => {
  const md = ['# Top\r\n', 'body\r\n', '#### Not A Heading\r\n', 'more'].join('');
  const secs = splitIntoSections(md);
  assert.equal(secs.length, 1, 'only the level-1 heading splits');
  assert.equal(secs[0].heading, 'Top');
  assert.ok(secs[0].text.includes('#### Not A Heading'), '4-hash line stays as body content');
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
