// frontmatter-split unit tests (base plan §3.3). Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/shared/frontmatter-split.test.js
//
// One case per branch of the confidence ladder (test strategy §"Frontmatter split").

import assert from 'node:assert/strict';
import { splitFrontmatter } from './frontmatter-split';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

test('exact: valid fence → header is the fence block, body is the remainder', () => {
  const md = '---\nname: foo\ndescription: does a thing\n---\n# Foo\n\nbody text\n';
  const r = splitFrontmatter(md);
  assert.equal(r.confidence, 'exact');
  assert.ok(r.header.startsWith('---\n'));
  assert.ok(r.header.includes('description: does a thing'));
  assert.equal(r.body, '# Foo\n\nbody text\n');
  assert.equal(r.hasDescription, true);
  assert.equal(r.descriptionConfidence, 'exact');
  assert.equal(r.approximate, false);
});

test('empty description: structurally exact but descriptionConfidence low', () => {
  const md = '---\nname: foo\ndescription:\n---\nbody\n';
  const r = splitFrontmatter(md);
  assert.equal(r.confidence, 'exact');
  assert.equal(r.hasDescription, false);
  assert.equal(r.descriptionConfidence, 'low');
});

test('quoted description parsed; quote-only treated as empty', () => {
  const yes = splitFrontmatter('---\ndescription: "hi"\n---\nb');
  assert.equal(yes.hasDescription, true);
  const no = splitFrontmatter('---\ndescription: ""\n---\nb');
  assert.equal(no.hasDescription, false);
});

test('low: no fence → synthesized header + first paragraph, body is full file', () => {
  const md = '# Title\n\nfirst para here\n\nsecond para\n';
  const r = splitFrontmatter(md);
  assert.equal(r.confidence, 'low');
  assert.equal(r.header, '# Title\n\nfirst para here');
  assert.equal(r.body, md);
  assert.equal(r.descriptionConfidence, 'low');
});

test('low: unterminated fence falls back (no closing ---)', () => {
  const md = '---\nname: foo\nno closing fence here\n';
  const r = splitFrontmatter(md);
  assert.equal(r.confidence, 'low');
  assert.equal(r.body, md);
});

test('low: opts.name drives the synthesized title', () => {
  const r = splitFrontmatter('just prose, no heading', { name: 'my-skill.md' });
  assert.ok(r.header.startsWith('# my-skill.md'));
});

test('low: empty file → untitled header, empty body', () => {
  const r = splitFrontmatter('');
  assert.equal(r.confidence, 'low');
  assert.equal(r.header, '# untitled');
  assert.equal(r.body, '');
});

test('CRLF normalized before fence scan → still exact', () => {
  const md = '---\r\nname: foo\r\ndescription: d\r\n---\r\nbody\r\n';
  const r = splitFrontmatter(md);
  assert.equal(r.confidence, 'exact');
  assert.ok(!r.header.includes('\r'));
  assert.equal(r.body, 'body\n');
});

test('BOM stripped before fence scan', () => {
  const md = '﻿---\ndescription: d\n---\nbody';
  const r = splitFrontmatter(md);
  assert.equal(r.confidence, 'exact');
  assert.ok(r.header.startsWith('---\n'));
});

test('oversize body → truncated + approximate flagged', () => {
  const big = 'x'.repeat(50);
  const md = `---\ndescription: d\n---\n${big}`;
  const r = splitFrontmatter(md, { maxBytes: 10 });
  assert.equal(r.approximate, true);
  assert.ok(Buffer.byteLength(r.body, 'utf8') <= 10);
});

let passed = 0; let failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
