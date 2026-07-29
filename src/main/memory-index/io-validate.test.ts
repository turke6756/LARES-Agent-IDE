// WP-A2 — I/O validation layer tests.
//
// Runs as plain Node after `npm run build:main`:
//   node dist/main/main/memory-index/io-validate.test.js
// Registered in scripts/run-main-tests.mjs.
//
// Covers every WP-A2 acceptance criterion, each with a real on-disk fixture:
//   • a nonexistent `detail:` pointer               → detail-missing HARD + CLI exit 1
//   • a symlink/junction escaping the details dir    → detail-escape HARD  + CLI exit 1
//   • an orphan detail file                          → orphan-details HARD + CLI exit 1
//   • a pointer beneath MEMORY_DETAILS_DIR           → passes (no I/O HARD) + CLI exit 0
//   • a pointer under memory/ but OUTSIDE details/   → detail-escape HARD (rejected)
//   • readValidateProject returns pure + I/O findings combined, plus projection
//   • the shipped CLI bundle still exits 0 for a stray flat fixture (pure-only)
//
// The CLI cases spawn the SHIPPED bytes (MEMORY_INDEX_MJS, the esbuild bundle
// scaffolded to .lares/scripts/memory-index.mjs) so the exit codes under test are
// the exact bytes that ship. The drift/byte-identity of that bundle is guarded
// separately by scripts/memory-index-cli-generated.test.js.

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  validateIO,
  readValidateProject,
  deriveWorkspaceRootFromIndexPath,
} from './io';
import { parseIndex, DISCLOSURE_FORMAT_MARKER } from '../../shared/memory-index-core';
import { MEMORY_INDEX_MJS } from '../../shared/generated/memory-index-cli.generated';

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) { tests.push({ name, fn }); }

const MARKER = DISCLOSURE_FORMAT_MARKER;

// A well-formed active capsule; `detail` defaults to the canonical location.
function ACTIVE(id: string, over: Record<string, string> = {}): string {
  const f: Record<string, string> = {
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

function idx(...blocks: string[]): string {
  return `${MARKER}\n\n${blocks.join('\n\n')}\n`;
}

// ── Filesystem scaffolding ────────────────────────────────────────────────────
const roots: string[] = [];

/** A fresh workspace with the canonical .lares/supervisor/memory/details layout. */
function makeWorkspace(): { root: string; memoryDir: string; detailsDir: string; memoryMd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-io-'));
  roots.push(root);
  const memoryDir = path.join(root, '.lares', 'supervisor', 'memory');
  const detailsDir = path.join(memoryDir, 'details');
  fs.mkdirSync(detailsDir, { recursive: true });
  return { root, memoryDir, detailsDir, memoryMd: path.join(memoryDir, 'MEMORY.md') };
}

function writeIndex(memoryMd: string, body: string): void {
  fs.writeFileSync(memoryMd, body, 'utf8');
}

/** Write the canonical detail body for `id` so its pointer resolves cleanly. */
function writeDetail(detailsDir: string, id: string): void {
  fs.writeFileSync(path.join(detailsDir, `${id}.md`), `# ${id}\nclosed history\n`, 'utf8');
}

const clsList = (findings: Array<{ cls: string }>) => findings.map((f) => f.cls);

// ── validateIO: nonexistent detail pointer (AC1) ──────────────────────────────
test('validateIO: a nonexistent detail pointer → detail-missing HARD', () => {
  const { root, memoryMd, detailsDir } = makeWorkspace();
  const id = 'mb-2026-07-28-gone';
  writeIndex(memoryMd, idx(ACTIVE(id))); // no detail file on disk
  void detailsDir;
  const io = validateIO(parseIndex(fs.readFileSync(memoryMd, 'utf8')), root);
  assert.ok(
    io.hard.some((f) => f.cls === 'detail-missing' && f.id === id),
    `expected detail-missing for ${id}; got ${JSON.stringify(clsList(io.hard))}`,
  );
});

// ── validateIO: a pointer beneath details passes (AC2) ────────────────────────
test('validateIO: a pointer resolving beneath MEMORY_DETAILS_DIR passes clean', () => {
  const { root, memoryMd, detailsDir } = makeWorkspace();
  const id = 'mb-2026-07-28-ok';
  writeIndex(memoryMd, idx(ACTIVE(id)));
  writeDetail(detailsDir, id);
  const io = validateIO(parseIndex(fs.readFileSync(memoryMd, 'utf8')), root);
  assert.deepEqual(io.hard, [], `a contained, existing pointer must be clean; got ${JSON.stringify(clsList(io.hard))}`);
});

// ── validateIO: a pointer under memory/ but OUTSIDE details/ is rejected (AC2) ─
test('validateIO: a pointer under memory/ but outside details/ → detail-escape', () => {
  const { root, memoryMd, memoryDir } = makeWorkspace();
  const id = 'mb-2026-07-28-outside';
  // A real file living directly under memory/ (NOT under details/).
  fs.writeFileSync(path.join(memoryDir, 'notes.md'), 'loose\n', 'utf8');
  writeIndex(memoryMd, idx(ACTIVE(id, { detail: 'memory/notes.md' })));
  const io = validateIO(parseIndex(fs.readFileSync(memoryMd, 'utf8')), root);
  assert.ok(
    io.hard.some((f) => f.cls === 'detail-escape' && f.id === id),
    `a pointer under memory/ but outside details/ must be rejected; got ${JSON.stringify(clsList(io.hard))}`,
  );
});

// ── validateIO: a symlink/junction escaping details is rejected (AC1) ──────────
test('validateIO: a symlink whose realpath escapes the details dir → detail-escape', () => {
  const { root, memoryMd, detailsDir } = makeWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-io-out-'));
  roots.push(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'exfiltrated\n', 'utf8');

  // Prefer a real file symlink; on a Windows host without symlink privilege,
  // fall back to a directory junction (no privilege required). A junction is a
  // reparse point that realpath follows just like a symlink — same escape.
  let pointer: string;
  try {
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(detailsDir, 'leak.md'), 'file');
    pointer = 'memory/details/leak.md';
  } catch {
    fs.symlinkSync(outside, path.join(detailsDir, 'leakdir'), 'junction');
    pointer = 'memory/details/leakdir/secret.md';
  }

  const id = 'mb-2026-07-28-leak';
  writeIndex(memoryMd, idx(ACTIVE(id, { detail: pointer })));
  const io = validateIO(parseIndex(fs.readFileSync(memoryMd, 'utf8')), root);
  assert.ok(
    io.hard.some((f) => f.cls === 'detail-escape' && f.id === id),
    `a symlink/junction escape must be rejected; got ${JSON.stringify(clsList(io.hard))}`,
  );
});

// ── validateIO: an orphan detail file is rejected (AC1) ───────────────────────
test('validateIO: a detail file with no index entry → orphan-details HARD', () => {
  const { root, memoryMd, detailsDir } = makeWorkspace();
  const id = 'mb-2026-07-28-kept';
  writeIndex(memoryMd, idx(ACTIVE(id)));
  writeDetail(detailsDir, id); // referenced — clean
  // An extra file no entry points at.
  fs.writeFileSync(path.join(detailsDir, 'mb-2026-01-01-orphan.md'), 'nobody points here\n', 'utf8');

  const io = validateIO(parseIndex(fs.readFileSync(memoryMd, 'utf8')), root);
  assert.ok(
    io.hard.some((f) => f.cls === 'orphan-details' && /mb-2026-01-01-orphan\.md/.test(f.message)),
    `an unreferenced detail file must be flagged orphan; got ${JSON.stringify(io.hard)}`,
  );
  // The referenced file must NOT be flagged.
  assert.ok(!io.hard.some((f) => f.cls === 'orphan-details' && new RegExp(`${id}\\.md`).test(f.message)));
});

test('validateIO: no details dir at all yields no orphans (only per-pointer findings)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-io-bare-'));
  roots.push(root);
  const memoryDir = path.join(root, '.lares', 'supervisor', 'memory');
  fs.mkdirSync(memoryDir, { recursive: true }); // NB: no details/ subdir
  const memoryMd = path.join(memoryDir, 'MEMORY.md');
  writeIndex(memoryMd, idx(ACTIVE('mb-2026-07-28-a')));
  const io = validateIO(parseIndex(fs.readFileSync(memoryMd, 'utf8')), root);
  assert.ok(!io.hard.some((f) => f.cls === 'orphan-details'), 'a missing details dir has no orphans');
  assert.ok(io.hard.some((f) => f.cls === 'detail-missing'), 'the declared pointer still resolves to nothing');
});

// ── readValidateProject: pure + I/O combined, plus projection (AC3) ────────────
test('readValidateProject: combines pure + I/O findings and carries the projection', () => {
  const { root, memoryMd } = makeWorkspace();
  // entry A: valid schema but a dangling detail (I/O HARD).
  // entry B: bad status (pure HARD). No detail files written.
  const a = ACTIVE('mb-2026-07-28-a');
  const b = ACTIVE('mb-2026-07-28-b', { status: 'wibble' });
  writeIndex(memoryMd, idx(a, b));

  const r = readValidateProject(root, '2026-07-28T00:00:00Z');
  const classes = clsList(r.hard);
  assert.ok(classes.includes('malformed-schema'), `expected the pure class; got ${JSON.stringify(classes)}`);
  assert.ok(classes.includes('detail-missing'), `expected the I/O class; got ${JSON.stringify(classes)}`);
  assert.ok(r.projection && typeof r.projection.injectText === 'string', 'projection is present');
  assert.equal(r.injectText, '', 'a HARD index (pure OR I/O) must never carry inject bytes');
});

test('readValidateProject: an I/O-only HARD (pure-clean) still zeroes injectText', () => {
  // The projection only knows the PURE HARD classes, so a schema-clean index with
  // a dangling detail pointer yields a non-empty projection.injectText — the
  // combined HARD gate is the only thing that suppresses it here.
  const { root, memoryMd } = makeWorkspace();
  writeIndex(memoryMd, idx(ACTIVE('mb-2026-07-28-a'))); // schema-clean, detail file absent
  const r = readValidateProject(root, '2026-07-28T00:00:00Z');
  assert.deepEqual(clsList(r.hard), ['detail-missing'], 'only the I/O class is HARD here');
  assert.ok(r.projection.injectText.length > 0, 'the pure projection still produced inject bytes');
  assert.equal(r.injectText, '', 'the combined HARD gate must suppress an I/O-invalid index');
});

test('readValidateProject: a fully-clean index injects and reports no HARD findings', () => {
  const { root, memoryMd, detailsDir } = makeWorkspace();
  const id = 'mb-2026-07-28-clean';
  writeIndex(memoryMd, idx(ACTIVE(id)));
  writeDetail(detailsDir, id);
  const r = readValidateProject(root, '2026-07-28T00:00:00Z');
  assert.deepEqual(r.hard, [], `clean index must have no HARD findings; got ${JSON.stringify(r.hard)}`);
  assert.ok(r.injectText.includes(id), 'a clean index carries its capsule in injectText');
});

test('readValidateProject: a missing MEMORY.md throws (caller maps to RUNTIME)', () => {
  const { root } = makeWorkspace();
  fs.rmSync(path.join(root, '.lares', 'supervisor', 'memory', 'MEMORY.md'), { force: true });
  assert.throws(() => readValidateProject(root, '2026-07-28T00:00:00Z'), /ENOENT/);
});

// ── deriveWorkspaceRootFromIndexPath ──────────────────────────────────────────
test('deriveWorkspaceRootFromIndexPath: canonical path → root; stray path → null', () => {
  const root = path.resolve(os.tmpdir(), 'ws-derive');
  const canonical = path.join(root, '.lares', 'supervisor', 'memory', 'MEMORY.md');
  assert.equal(deriveWorkspaceRootFromIndexPath(canonical), root);
  assert.equal(deriveWorkspaceRootFromIndexPath(path.join(os.tmpdir(), 'idx-0.md')), null);
});

// ── CLI (shipped bytes): I/O classes drive exit 1; stray fixture stays exit 0 ──
const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-io-cli-'));
roots.push(cliDir);
const cliPath = path.join(cliDir, 'memory-index.mjs');
fs.writeFileSync(cliPath, MEMORY_INDEX_MJS, 'utf8');

function runCli(args: string[]): { status: number | null; stderr: string } {
  const res = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf-8' });
  return { status: res.status, stderr: res.stderr || '' };
}

test('CLI: canonical index with a nonexistent detail pointer → exit 1', () => {
  const { memoryMd } = makeWorkspace();
  writeIndex(memoryMd, idx(ACTIVE('mb-2026-07-28-a'))); // no detail file
  const r = runCli(['validate', memoryMd]);
  assert.equal(r.status, 1, `dangling pointer must exit 1; got ${r.status}. stderr: ${r.stderr}`);
  assert.match(r.stderr, /detail-missing/);
});

test('CLI: canonical index with an orphan detail file → exit 1', () => {
  const { memoryMd, detailsDir } = makeWorkspace();
  const id = 'mb-2026-07-28-a';
  writeIndex(memoryMd, idx(ACTIVE(id)));
  writeDetail(detailsDir, id);
  fs.writeFileSync(path.join(detailsDir, 'mb-2026-01-01-orphan.md'), 'orphan\n', 'utf8');
  const r = runCli(['validate', memoryMd]);
  assert.equal(r.status, 1, `orphan detail must exit 1; got ${r.status}. stderr: ${r.stderr}`);
  assert.match(r.stderr, /orphan-details/);
});

test('CLI: a fully-clean canonical index → exit 0', () => {
  const { memoryMd, detailsDir } = makeWorkspace();
  const id = 'mb-2026-07-28-a';
  writeIndex(memoryMd, idx(ACTIVE(id)));
  writeDetail(detailsDir, id);
  const r = runCli(['validate', memoryMd]);
  assert.equal(r.status, 0, `a clean canonical index must exit 0; got ${r.status}. stderr: ${r.stderr}`);
});

test('CLI: a stray flat fixture with a dangling pointer stays pure-only → exit 0', () => {
  // Not in the .lares/supervisor/memory layout ⇒ NO I/O validation (pre-WP-A2
  // behavior), so the WP-A1 CLI suite of flat fixtures keeps passing.
  const p = path.join(cliDir, 'stray-idx.md');
  fs.writeFileSync(p, idx(ACTIVE('mb-2026-07-28-a')), 'utf8'); // detail file absent
  const r = runCli(['validate', p]);
  assert.equal(r.status, 0, `a stray flat fixture must not gain I/O validation; got ${r.status}. stderr: ${r.stderr}`);
});

// ── Runner ────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    passed++;
  } catch (err) {
    console.error(`  FAIL ${t.name}`);
    console.error('       ', err instanceof Error ? err.stack : err);
    failed++;
  }
}
for (const r of roots) {
  try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(`\nmemory-index io-validate: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
