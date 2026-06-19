// Slice 13 (user-only downloads) — PURE filename/path chokepoint tests. NO
// Electron and NO database: only normalizeDownloadFilename / isPathWithinDir are
// exercised here (they touch only `node:path`; the DB-backed store functions in
// the same module are never called, so better-sqlite3 is never required). The
// runtime decision gate (agent allowlist / user confirm) lives in
// browser-manager.test.ts where the manager fakes exist.
//
//   npm run build:main
//   node dist/main/main/browser/downloads.test.js

import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeDownloadFilename, isPathWithinDir } from './downloads-store';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const DIR = path.resolve('/app/browser-downloads');

// ── normalizeDownloadFilename: the traversal chokepoint ──────────────────────

test('strips directory components (POSIX) → basename only', () => {
  assert.equal(normalizeDownloadFilename('../../etc/passwd'), 'passwd');
});

test('a deep POSIX traversal keeps only the final segment', () => {
  assert.equal(normalizeDownloadFilename('../../../../tmp/evil.sh'), 'evil.sh');
});

test('a Windows-style traversal keeps only the final segment', () => {
  assert.equal(normalizeDownloadFilename('..\\..\\Windows\\System32\\evil.dll'), 'evil.dll');
  assert.equal(normalizeDownloadFilename('C:\\Users\\me\\report.pdf'), 'report.pdf');
});

test('pure-dot names collapse to the default', () => {
  for (const raw of ['', '.', '..', '...', '   ', '/', '\\']) {
    assert.equal(normalizeDownloadFilename(raw), 'download', `"${raw}" → default`);
  }
});

test('leading dots are stripped (no hidden-file / residual-traversal surprise)', () => {
  assert.equal(normalizeDownloadFilename('.htaccess'), 'htaccess');
  assert.equal(normalizeDownloadFilename('..foo'), 'foo');
});

test('illegal / control characters become underscores', () => {
  assert.equal(normalizeDownloadFilename('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
  assert.equal(normalizeDownloadFilename('tab\tname.txt'), 'tab_name.txt');
});

test('non-string input → default', () => {
  assert.equal(normalizeDownloadFilename(undefined), 'download');
  assert.equal(normalizeDownloadFilename(null), 'download');
  assert.equal(normalizeDownloadFilename(42), 'download');
});

test('an over-long name is capped while preserving the extension', () => {
  const long = 'a'.repeat(500) + '.pdf';
  const out = normalizeDownloadFilename(long);
  assert.ok(out.length <= 200, `length ${out.length} <= 200`);
  assert.ok(out.endsWith('.pdf'), 'extension preserved');
});

test('a normal name passes through unchanged', () => {
  assert.equal(normalizeDownloadFilename('Quarterly Report 2026.pdf'), 'Quarterly Report 2026.pdf');
});

test('the normalized result, joined to the dir, is ALWAYS within the dir', () => {
  for (const raw of ['../../etc/passwd', '..\\..\\x', '.', '..', '/abs/evil', 'C:\\evil.exe', '....//....//x']) {
    const safe = normalizeDownloadFilename(raw);
    assert.ok(!safe.includes('/') && !safe.includes('\\'), `"${raw}" → no separator (${safe})`);
    assert.ok(isPathWithinDir(path.join(DIR, safe), DIR), `"${raw}" stays inside the dir`);
  }
});

// ── isPathWithinDir: defense-in-depth confinement ────────────────────────────

test('a child path is within the dir', () => {
  assert.equal(isPathWithinDir(path.join(DIR, 'file.txt'), DIR), true);
  assert.equal(isPathWithinDir(path.join(DIR, 'sub', 'file.txt'), DIR), true);
});

test('the dir itself is NOT "within" the dir', () => {
  assert.equal(isPathWithinDir(DIR, DIR), false);
});

test('a parent / sibling escape is rejected', () => {
  assert.equal(isPathWithinDir(path.join(DIR, '..', 'evil.txt'), DIR), false);
  assert.equal(isPathWithinDir(path.resolve('/app', 'other', 'x'), DIR), false);
});

// ── Run ──────────────────────────────────────────────────────────────────────

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
console.log(`\nAll ${tests.length} downloads (pure-helper) tests passed`);
