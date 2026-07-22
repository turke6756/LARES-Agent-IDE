// Hash-vector tests for the shared content identity hash (edit-loss plan
// §4.0). The vectors are PINNED: the renderer's write-generation ledger, the
// save coordinator's B1 expectedDiskHash, and the main process's
// conditional-write CAS check all consume this one function — a change to any
// of these values would silently break echo suppression and CAS comparisons
// across the IPC boundary. The renderer-side equivalence test
// (src/renderer/components/fileviewer/contentHash.equivalence.test.ts) pins
// the SAME vectors against the markdownSplice re-export.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/shared/content-hash.test.js

import assert from 'node:assert/strict';
import { contentHash } from './content-hash';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// Pinned vectors — must match contentHash.equivalence.test.ts exactly.
const VECTORS: Array<[string, string]> = [
  ['', '0bdcb81aee8d83'],
  ['a', '1c2ba782c97901'],
  ['x', '0189af1820c6f5'],
  ['# Title\r\n\r\nbody\r\n', '1a5e5c66d79fa7'],
  ['a\nb', '1de594bc8e1ca1'],
  ['a\r\nb', '18f8363ee0e6b6'],
  ['hello world', '0b9417d15d1014'],
];

test('pinned hash vectors', () => {
  for (const [input, expected] of VECTORS) {
    assert.equal(contentHash(input), expected, `contentHash(${JSON.stringify(input)})`);
  }
});

test('deterministic, fixed-width lowercase hex', () => {
  const h = contentHash('# Title\r\n\r\nbody\r\n');
  assert.equal(h, contentHash('# Title\r\n\r\nbody\r\n'));
  assert.match(h, /^[0-9a-f]{14}$/);
  assert.match(contentHash(''), /^[0-9a-f]{14}$/);
});

test('byte-identity: EOL flavor, whitespace, and case all matter', () => {
  assert.notEqual(contentHash('a\r\nb'), contentHash('a\nb'));
  assert.notEqual(contentHash('a b'), contentHash('a  b'));
  assert.notEqual(contentHash('Heading'), contentHash('heading'));
  assert.notEqual(contentHash('x'), contentHash('y'));
  assert.notEqual(contentHash(''), contentHash(' '));
});

// ── Runner ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ok  ${t.name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${t.name}`);
    console.error('       ', err instanceof Error ? err.stack || err.message : err);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
