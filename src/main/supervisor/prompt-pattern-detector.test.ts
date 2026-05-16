// Tests for PromptPatternDetector — covers the §2.3.2 pattern set.
//
//   npm run build:main
//   node dist/main/main/supervisor/prompt-pattern-detector.test.js

import assert from 'node:assert/strict';
import { match } from './prompt-pattern-detector';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

test('matches (y/N) at end of tail', () => {
  const m = match('Do you want to proceed? (y/N) ');
  assert.ok(m);
  assert.equal(m.kind, 'y-n');
  assert.match(m.excerpt, /\(y\/N\)/);
});

test('matches [Y/n]', () => {
  const m = match('Confirm [Y/n]');
  assert.ok(m);
  assert.equal(m.kind, 'y-n');
});

test('matches "Press Enter to continue"', () => {
  const m = match('-- More -- Press Enter to continue');
  assert.ok(m);
  assert.equal(m.kind, 'enter');
});

test('matches "press RETURN"', () => {
  const m = match('press RETURN');
  assert.ok(m);
  assert.equal(m.kind, 'enter');
});

test('matches numbered choice list with ≥2 items', () => {
  const tail = 'Pick one:\n  1) Apple\n  2) Banana\n  3) Cherry\n> ';
  const m = match(tail);
  assert.ok(m);
  assert.equal(m.kind, 'choice');
});

test('matches "Choose an option"', () => {
  const m = match('Choose an option:');
  assert.ok(m);
  assert.equal(m.kind, 'choice');
});

test('matches "Approve?"', () => {
  const m = match('  Approve?');
  assert.ok(m);
  assert.equal(m.kind, 'approve');
});

test('does NOT match shell prompt with bare cursor', () => {
  // The plan explicitly removed the bare `❯` pattern. Bash-style $ also shouldn't trip.
  assert.equal(match('user@host:~$ '), null);
  assert.equal(match('❯ '), null);
});

test('does NOT match plain text without a prompt', () => {
  assert.equal(match('All done. Goodbye.'), null);
});

test('matches only within last 512 bytes (stale prompt past tail is ignored)', () => {
  // Build a prompt followed by >512 bytes of subsequent output.
  const prompt = 'Proceed? (y/N)';
  const filler = '\n' + 'x'.repeat(600);
  const tail = prompt + filler;
  assert.equal(match(tail), null, 'stale prompt beyond 512-byte window is ignored');
});

test('handles empty string', () => {
  assert.equal(match(''), null);
});

(async () => {
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
})();
