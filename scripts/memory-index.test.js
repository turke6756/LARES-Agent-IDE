// WP-A1 — memory-index CLI exec tests.
//
// Spawns the SHIPPED bytes (MEMORY_INDEX_MJS, the esbuild bundle scaffolded to
// .lares/scripts/memory-index.mjs) via process.execPath against on-disk
// fixtures — zero drift: the bytes under test are the bytes that ship. Modeled
// on scripts/guard-git-discard.test.js. Runs as plain Node after
// `npm run build:main`; registered in scripts/run-main-tests.mjs.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { MEMORY_INDEX_MJS } = require('../dist/main/shared/generated/memory-index-cli.generated.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const MARKER = '<!-- disclosure-format: v2 -->';

// Materialize the CLI once, exactly as the scaffolder would.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-'));
const cliPath = path.join(tmpDir, 'memory-index.mjs');
fs.writeFileSync(cliPath, MEMORY_INDEX_MJS, 'utf-8');

let fixtureSeq = 0;
function writeFixture(body) {
  const p = path.join(tmpDir, `idx-${fixtureSeq++}.md`);
  fs.writeFileSync(p, body, 'utf-8');
  return p;
}

function run(args) {
  const res = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf-8' });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function activeCapsule(id, over = {}) {
  const f = {
    status: 'active',
    date: '2026-07-28',
    owner: 'super',
    consequence: 'things break silently',
    state: 'constraint X holds',
    'open-loop': 'finish Y',
    'read-if': 'before editing the schema',
    detail: `memory/details/${id}.md`,
    ...over,
  };
  const lines = [`## ${id}: Title`];
  for (const [k, v] of Object.entries(f)) if (v !== '') lines.push(`- ${k}: ${v}`);
  return lines.join('\n');
}

function idx(...blocks) {
  return `${MARKER}\n\n${blocks.join('\n\n')}\n`;
}

// ── HARD classes → exit 1 ───────────────────────────────────────────────────
const HARD_FIXTURES = {
  'legacy-format (missing marker)': `## mb-2026-07-28-a: T\n- status: active\n- date: 2026-07-28\n- consequence: c\n- state: s\n- open-loop: o\n- read-if: r\n`,
  'legacy-format (mismatched marker)': `<!-- disclosure-format: v1 -->\n\n${activeCapsule('mb-2026-07-28-a')}\n`,
  'malformed-schema (bad status)': idx(activeCapsule('mb-2026-07-28-a', { status: 'wibble' })),
  'malformed-schema (bad id)': idx(activeCapsule('mb-NOTADATE')),
  'missing-field (no consequence)': idx(activeCapsule('mb-2026-07-28-a', { consequence: '' })),
  'missing-field (active names no exit)': idx(
    activeCapsule('mb-2026-07-28-a', { 'open-loop': '', expires: '', 'expires-when': '' }),
  ),
  'duplicate-id': idx(activeCapsule('mb-2026-07-28-dup'), activeCapsule('mb-2026-07-28-dup')),
  'bare-scoped-pkg (prose)': idx(activeCapsule('mb-2026-07-28-a', { state: 'install @acme/widgets now' })),
  'byte-budget': idx(activeCapsule('mb-2026-07-28-a', { state: 'x'.repeat(25100) })),
  'line-budget': `${MARKER}\n${Array.from({ length: 210 }, () => 'z').join('\n')}\n\n${activeCapsule('mb-2026-07-28-a')}\n`,
  'invalid-handoff': `${MARKER}\n\n## handoff-read-first\n1. mb-2026-07-28-nope\n\n${activeCapsule('mb-2026-07-28-a')}\n`,
};

for (const [label, body] of Object.entries(HARD_FIXTURES)) {
  test(`validate: HARD ${label} → exit 1`, () => {
    const p = writeFixture(body);
    const r = run(['validate', p]);
    assert.equal(r.status, 1, `expected exit 1 for ${label}; got ${r.status}. stderr: ${r.stderr}`);
  });
  test(`project: HARD ${label} → exit 1, no injectText`, () => {
    const p = writeFixture(body);
    const r = run(['project', '--now', '2026-07-28T00:00:00Z', p]);
    assert.equal(r.status, 1, `expected exit 1 for ${label}; got ${r.status}. stderr: ${r.stderr}`);
    assert.equal(r.stdout, '', 'a HARD-invalid index must never be projected');
  });
}

// ── Advisory / clean → exit 0 ───────────────────────────────────────────────
test('validate: cap-pressure advisory → exit 0', () => {
  const p = writeFixture(idx(activeCapsule('mb-2026-07-28-a', { state: 'y'.repeat(20200) })));
  const r = run(['validate', p]);
  assert.equal(r.status, 0, `advisory-only must exit 0; got ${r.status}. stderr: ${r.stderr}`);
  assert.match(r.stderr, /cap-pressure/);
});

test('validate: clean index → exit 0', () => {
  const p = writeFixture(idx(activeCapsule('mb-2026-07-28-a')));
  assert.equal(run(['validate', p]).status, 0);
});

test('validate: backticked @scope/pkg is clean → exit 0', () => {
  const p = writeFixture(idx(activeCapsule('mb-2026-07-28-a', { state: 'install `@acme/widgets` now' })));
  assert.equal(run(['validate', p]).status, 0, 'a backticked package token is clean');
});

test('validate: fenced @scope/pkg is clean → exit 0', () => {
  const body = idx(activeCapsule('mb-2026-07-28-a', { state: 'see the detail file' }))
    .replace(/\n$/, '\n\nsetup:\n```\n@acme/widgets\n```\n');
  const p = writeFixture(body);
  assert.equal(run(['validate', p]).status, 0, 'a fenced package token is clean');
});

// ── Projection semantics + non-mutation (AC4) ───────────────────────────────
test('project: drops the literal-expired entry only; deterministic; file unchanged', () => {
  const body = idx(
    activeCapsule('mb-2026-07-28-live'),
    activeCapsule('mb-2020-01-01-dead', { date: '2020-01-01', 'open-loop': '', expires: '2020-02-01' }),
  );
  const p = writeFixture(body);
  const beforeBytes = fs.readFileSync(p);
  const beforeMtime = fs.statSync(p).mtimeMs;

  const r1 = run(['project', '--now', '2026-07-28T00:00:00Z', p]);
  const r2 = run(['project', '--now', '2026-07-28T00:00:00Z', p]);

  assert.equal(r1.status, 0);
  assert.ok(r1.stdout.includes('mb-2026-07-28-live'), 'live entry kept');
  assert.ok(!r1.stdout.includes('mb-2020-01-01-dead'), 'expired entry dropped');
  assert.match(r1.stderr, /"dropped":\["mb-2020-01-01-dead"\]/);
  assert.equal(r1.stdout, r2.stdout, 'project is deterministic for identical (input, now)');

  const afterBytes = fs.readFileSync(p);
  assert.ok(beforeBytes.equals(afterBytes), 'input file bytes unchanged after project');
  assert.equal(fs.statSync(p).mtimeMs, beforeMtime, 'input file mtime unchanged after project');
});

// ── RUNTIME (exit 2) ────────────────────────────────────────────────────────
test('runtime: nonexistent file → exit 2', () => {
  const r = run(['validate', path.join(tmpDir, 'does-not-exist.md')]);
  assert.equal(r.status, 2, `a read failure must map to exit 2; got ${r.status}`);
});

test('runtime: unknown command → exit 2', () => {
  const p = writeFixture(idx(activeCapsule('mb-2026-07-28-a')));
  assert.equal(run(['frobnicate', p]).status, 2);
});

// ── Runner ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const t of tests) {
  try { t.fn(); passed++; }
  catch (err) {
    console.error(`  FAIL ${t.name}`);
    console.error('       ', err && err.stack ? err.stack : err);
    failed++;
  }
}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\nmemory-index CLI: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
