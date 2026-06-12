// Tests for repairClaudeJsonContent — the pure repair core of the startup
// ~/.claude.json validate+repair backstop (Task 3 of
// plans/claude-json-corruption-mitigation-v2.md).
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/claude-config-repair.test.js

import assert from 'node:assert/strict';
import { repairClaudeJsonContent } from './claude-config-repair';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

// ── valid input ──────────────────────────────────────────────────────────────

test('valid JSON passes through untouched', () => {
  const result = repairClaudeJsonContent('{"a":1,"b":[1,2,3]}', []);
  assert.equal(result.action, 'valid');
  assert.equal(result.content, undefined, 'valid input needs no replacement content');
});

// ── trailing garbage → truncated ─────────────────────────────────────────────

test('trailing garbage is truncated at the parse-error position', () => {
  const good = '{"a":1,"b":[1,2,3],"c":"x"}';
  const corrupted = good + '],"history":["stale tail of an older, longer file"]}';
  const result = repairClaudeJsonContent(corrupted, []);
  assert.equal(result.action, 'truncated');
  assert.ok(result.content, 'expected repaired content');
  assert.deepEqual(JSON.parse(result.content!), JSON.parse(good));
  assert.equal(result.content, JSON.stringify(JSON.parse(result.content!)),
    'output must be canonical');
});

// ── splice signature → grafted ───────────────────────────────────────────────

// The real corruption shape: a newer rewrite cut mid-string with an older
// file's tail still present past the cut. Truncation can't fix this (no
// prefix parses); the graft keeps the newer prefix up to the last key
// boundary and completes it with that key's tail from a valid backup.
const SPLICE_BACKUP = '{"a":1,"history":["old1","old2"],"z":9}';
const SPLICE_CORRUPTED = '{"a":2,"history":["new1","ne,"zzz":{"q":1}}';

test('splice signature grafts the backup tail onto the newer prefix', () => {
  const result = repairClaudeJsonContent(SPLICE_CORRUPTED, [SPLICE_BACKUP]);
  assert.equal(result.action, 'grafted');
  const parsed = JSON.parse(result.content!);
  assert.equal(parsed.a, 2, 'newer prefix value must survive the graft');
  assert.deepEqual(parsed.history, ['old1', 'old2'], 'tail comes from the backup');
  assert.equal(parsed.z, 9);
  assert.equal(result.content, JSON.stringify(parsed), 'output must be canonical');
});

test('graft skips a non-parsing newest backup and uses the next valid one', () => {
  const result = repairClaudeJsonContent(SPLICE_CORRUPTED, ['{"broken', SPLICE_BACKUP]);
  assert.equal(result.action, 'grafted');
  assert.deepEqual(JSON.parse(result.content!).history, ['old1', 'old2']);
});

// ── duplicate keys from a graft → canonical, duplicate-free output ───────────

test('graft producing duplicate keys emits canonical duplicate-free JSON with a telltale', () => {
  // Prefix already carries a fat "blob" before the cut key; the backup tail
  // grafted at "history" re-introduces "blob", so the merged text parses but
  // holds the key twice. Canonicalization must drop the dead first copy.
  const fat = 'x'.repeat(200);
  const backup = `{"a":1,"history":["old1"],"blob":"${fat}","z":9}`;
  const corrupted = `{"a":2,"blob":"${fat}","history":["new1","ne,"zzz":{"q":1}}`;
  const result = repairClaudeJsonContent(corrupted, [backup]);
  assert.equal(result.action, 'grafted');
  const content = result.content!;
  const parsed = JSON.parse(content);
  assert.equal(content, JSON.stringify(parsed), 'output must be canonical');
  assert.equal(content.split('"blob"').length - 1, 1,
    'duplicate "blob" key must be collapsed to a single occurrence');
  assert.equal(parsed.blob, fat);
  assert.ok(result.detail && result.detail.includes('duplicate-key telltale'),
    `material canonicalization shrink must be flagged in detail; got: ${result.detail}`);
});

test('repairs without duplicates carry no duplicate-key telltale', () => {
  const result = repairClaudeJsonContent(SPLICE_CORRUPTED, [SPLICE_BACKUP]);
  assert.ok(!result.detail || !result.detail.includes('duplicate-key telltale'),
    `clean graft must not flag a telltale; got: ${result.detail}`);
});

// ── key missing from backups → restored ──────────────────────────────────────

test('graft key absent from every backup falls back to wholesale restore', () => {
  // Corrupted file's only graftable keys ("a", "newkey") never appear in the
  // backups, so the graft loop exhausts and the newest valid backup wins.
  const corrupted = '{"a":2,"newkey":["new1","ne,"zzz":{"q":1}}';
  const newestBackup = '{"b":1,"other":true}';
  const olderBackup = '{"b":0}';
  const result = repairClaudeJsonContent(corrupted, [newestBackup, olderBackup]);
  assert.equal(result.action, 'restored');
  assert.deepEqual(JSON.parse(result.content!), JSON.parse(newestBackup),
    'restore must use the newest valid backup');
  assert.equal(result.content, JSON.stringify(JSON.parse(result.content!)),
    'output must be canonical');
});

test('restore skips non-parsing backups', () => {
  const corrupted = '{"a":2,"newkey":["new1","ne,"zzz":{"q":1}}';
  const result = repairClaudeJsonContent(corrupted, ['{"broken', '{"b":1}']);
  assert.equal(result.action, 'restored');
  assert.deepEqual(JSON.parse(result.content!), { b: 1 });
});

// ── no valid backup → unrepairable ───────────────────────────────────────────

test('no backups at all → unrepairable', () => {
  const result = repairClaudeJsonContent('{"a":2,"newkey":["new1","ne,"zzz":{"q":1}}', []);
  assert.equal(result.action, 'unrepairable');
  assert.equal(result.content, undefined);
});

test('only invalid backups → unrepairable', () => {
  const result = repairClaudeJsonContent(
    '{"a":2,"newkey":["new1","ne,"zzz":{"q":1}}',
    ['{"broken', 'not json either'],
  );
  assert.equal(result.action, 'unrepairable');
  assert.equal(result.content, undefined);
});

// ── Run ─────────────────────────────────────────────────────────────────────

(() => {
  let failed = 0;
  for (const t of tests) {
    try {
      t.run();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(err instanceof Error ? err.stack : String(err));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} claude-config-repair tests passed`);
})();
