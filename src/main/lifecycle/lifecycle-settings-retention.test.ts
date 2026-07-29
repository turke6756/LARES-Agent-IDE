// Terminal-log retention WP-1 — lifecycle-settings PER-FIELD independence.
//
// loadLifecycleSettings / saveLifecycleSettings validate autoStopIdleThreshold
// and logRetentionCap SEPARATELY and merge each with its own default: an invalid
// (or absent) value for one field must default ONLY that field and never discard
// a valid sibling. Joint validation — where one bad field nukes the whole object
// to defaults — is the mutation this suite kills.
//
//   npm run build:main
//   node dist/main/main/lifecycle/lifecycle-settings-retention.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadLifecycleSettings, saveLifecycleSettings, lifecycleSettingsPath } from './lifecycle-settings';
import { DEFAULT_LIFECYCLE_SETTINGS } from '../../shared/types';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lares-retention-settings-'));
}
function writeRaw(dir: string, json: string): void {
  fs.writeFileSync(lifecycleSettingsPath(dir), json, 'utf8');
}

test('the defaults carry a retention cap of 2gib', () => {
  assert.equal(DEFAULT_LIFECYCLE_SETTINGS.logRetentionCap, '2gib');
});

test('valid auto-stop + INVALID retention → keep auto-stop, default the retention only', () => {
  const dir = tmpDir();
  writeRaw(dir, JSON.stringify({ autoStopIdleThreshold: '7d', logRetentionCap: 'bogus' }));
  assert.deepEqual(loadLifecycleSettings(dir), { autoStopIdleThreshold: '7d', logRetentionCap: '2gib' });
});

test('INVALID auto-stop + valid retention → default the auto-stop only, keep the retention', () => {
  const dir = tmpDir();
  writeRaw(dir, JSON.stringify({ autoStopIdleThreshold: 'forever', logRetentionCap: '5gib' }));
  assert.deepEqual(loadLifecycleSettings(dir), {
    autoStopIdleThreshold: DEFAULT_LIFECYCLE_SETTINGS.autoStopIdleThreshold,
    logRetentionCap: '5gib',
  });
});

test('an old one-field JSON reads back as a two-field defaulted object', () => {
  const dir = tmpDir();
  writeRaw(dir, JSON.stringify({ autoStopIdleThreshold: '6h' }));
  assert.deepEqual(loadLifecycleSettings(dir), { autoStopIdleThreshold: '6h', logRetentionCap: '2gib' });
});

test('both fields valid → both preserved', () => {
  const dir = tmpDir();
  writeRaw(dir, JSON.stringify({ autoStopIdleThreshold: '3d', logRetentionCap: '1gib' }));
  assert.deepEqual(loadLifecycleSettings(dir), { autoStopIdleThreshold: '3d', logRetentionCap: '1gib' });
});

test('save persists BOTH fields atomically (temp file renamed, both readable)', () => {
  const dir = tmpDir();
  const saved = saveLifecycleSettings({ autoStopIdleThreshold: '12h', logRetentionCap: 'unlimited' }, dir);
  assert.deepEqual(saved, { autoStopIdleThreshold: '12h', logRetentionCap: 'unlimited' });
  // Atomic write leaves no .tmp behind and the on-disk JSON carries both fields.
  assert.deepEqual(fs.readdirSync(dir), ['lifecycle-settings.json'], 'the .tmp staging file is renamed, never left');
  const onDisk = JSON.parse(fs.readFileSync(lifecycleSettingsPath(dir), 'utf8'));
  assert.equal(onDisk.autoStopIdleThreshold, '12h');
  assert.equal(onDisk.logRetentionCap, 'unlimited');
  // Round-trips back through the validating load.
  assert.deepEqual(loadLifecycleSettings(dir), { autoStopIdleThreshold: '12h', logRetentionCap: 'unlimited' });
});

test('save defaults EACH invalid field independently without discarding the valid sibling', () => {
  const dir = tmpDir();
  // Invalid retention, valid threshold → threshold kept, retention defaulted.
  const a = saveLifecycleSettings({ autoStopIdleThreshold: '7d', logRetentionCap: 'huge' as never }, dir);
  assert.deepEqual(a, { autoStopIdleThreshold: '7d', logRetentionCap: '2gib' });
  // Invalid threshold, valid retention → retention kept, threshold defaulted.
  const b = saveLifecycleSettings({ autoStopIdleThreshold: 'forever' as never, logRetentionCap: '5gib' }, dir);
  assert.deepEqual(b, {
    autoStopIdleThreshold: DEFAULT_LIFECYCLE_SETTINGS.autoStopIdleThreshold,
    logRetentionCap: '5gib',
  });
});

test('a wholly malformed file falls back to the full defaults', () => {
  const dir = tmpDir();
  for (const junk of ['', '{', 'null', '[]', '42']) {
    writeRaw(dir, junk);
    assert.deepEqual(loadLifecycleSettings(dir), DEFAULT_LIFECYCLE_SETTINGS, `junk: ${junk}`);
  }
});

// ── Runner ───────────────────────────────────────────────────────────────────
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
