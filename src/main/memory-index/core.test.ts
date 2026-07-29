// WP-A1 — pure memory-index core unit tests.
//
// Runs as plain Node after `npm run build:main`:
//   node dist/main/main/memory-index/core.test.js
// Registered in scripts/run-main-tests.mjs.
//
// Covers every WP-A1 acceptance criterion that is pure (no filesystem): the
// projection transform, each HARD class + legacy-format, the @scope/pkg
// code-span rules, projection determinism, the byte/line/truncation helpers,
// and the grep-assert that the core imports no `fs`/`realpath`.

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  parseIndex,
  validateParsed,
  projectParsed,
  utf8ByteLength,
  countLines,
  safeUtf8Truncate,
  isValidMemoryId,
  detectBareScopedPkg,
  DISCLOSURE_FORMAT_MARKER,
  MEMORY_INDEX_BUDGET_BYTES,
  MEMORY_INDEX_BUDGET_LINES,
  CAP_PRESSURE_RATIO,
  type Finding,
} from '../../shared/memory-index-core';

const tests: Array<{ name: string; fn: () => void }> = [];
function test(name: string, fn: () => void) { tests.push({ name, fn }); }

const MARKER = DISCLOSURE_FORMAT_MARKER;

/** Build a capsule block from a fields map. */
function capsule(id: string, fields: Record<string, string>): string {
  const lines = [`## ${id}: ${fields.__title ?? 'Title'}`];
  for (const [k, v] of Object.entries(fields)) {
    if (k === '__title') continue;
    lines.push(`- ${k}: ${v}`);
  }
  return lines.join('\n');
}

const ACTIVE = (id: string, over: Record<string, string> = {}) =>
  capsule(id, {
    status: 'active',
    date: '2026-07-28',
    owner: 'super',
    consequence: 'things break silently',
    state: 'constraint X holds',
    'open-loop': 'finish Y',
    'read-if': 'before editing the schema',
    detail: `memory/details/${id}.md`,
    ...over,
  });

function index(...blocks: string[]): string {
  return `${MARKER}\n\n${blocks.join('\n\n')}\n`;
}

const clsSet = (findings: Finding[]) => new Set(findings.map((f) => f.cls));

// ── Projection transform (AC1) ──────────────────────────────────────────────
test('projection: drops only the literal-expired; keeps expires-when + stale-active', () => {
  const expired = ACTIVE('mb-2020-01-01-expired', {
    date: '2020-01-01',
    'open-loop': '',
    expires: '2020-06-01',
  });
  const cond = ACTIVE('mb-2026-07-20-cond', { 'open-loop': '', 'expires-when': 'pi-integration lands' });
  const stale = ACTIVE('mb-2026-06-01-stale', { date: '2026-06-01' }); // age > 14d at now
  const p1 = ACTIVE('mb-2026-07-28-p1');
  const p2 = ACTIVE('mb-2026-07-28-p2');
  const p3 = ACTIVE('mb-2026-07-28-p3');
  const txt = index(expired, cond, stale, p1, p2, p3);

  const parsed = parseIndex(txt);
  const proj = projectParsed(parsed, { nowISO: '2026-07-28T00:00:00Z' });

  assert.deepEqual(proj.dropped, ['mb-2020-01-01-expired'], 'only the literal-expired entry drops');
  assert.deepEqual(proj.conditionReview, ['mb-2026-07-20-cond'], 'expires-when id in conditionReview');
  assert.deepEqual(proj.staleActive, ['mb-2026-06-01-stale'], 'stale id in staleActive');
  // expires-when + stale both remain in injectText; expired is gone.
  assert.ok(!proj.injectText.includes('mb-2020-01-01-expired'), 'expired capsule removed from injectText');
  assert.ok(proj.injectText.includes('mb-2026-07-20-cond'), 'expires-when capsule stays in injectText');
  assert.ok(proj.injectText.includes('mb-2026-06-01-stale'), 'stale-active capsule stays in injectText');
  assert.equal(proj.hard.length, 0, 'the fixture is otherwise HARD-clean');
});

test('projection: expires exactly today is NOT dropped', () => {
  const today = ACTIVE('mb-2026-07-28-today', { 'open-loop': '', expires: '2026-07-28' });
  const proj = projectParsed(parseIndex(index(today)), { nowISO: '2026-07-28T12:00:00Z' });
  assert.deepEqual(proj.dropped, [], 'expiry == today is still live');
  assert.ok(proj.injectText.includes('mb-2026-07-28-today'));
});

test('projection: determinism — identical (input, now) → byte-identical output', () => {
  const txt = index(ACTIVE('mb-2026-07-28-a'), ACTIVE('mb-2020-01-01-b', { 'open-loop': '', expires: '2020-02-01' }));
  const a = projectParsed(parseIndex(txt), { nowISO: '2026-07-28T00:00:00Z' });
  const b = projectParsed(parseIndex(txt), { nowISO: '2026-07-28T00:00:00Z' });
  assert.equal(a.injectText, b.injectText);
  assert.deepEqual(a.dropped, b.dropped);
});

test('projection: does not mutate the input parsed model', () => {
  const parsed = parseIndex(index(ACTIVE('mb-2020-01-01-x', { 'open-loop': '', expires: '2020-02-01' })));
  const before = parsed.normalized;
  projectParsed(parsed, { nowISO: '2026-07-28T00:00:00Z' });
  assert.equal(parsed.normalized, before, 'projection must not touch its input');
});

// ── HARD classes (AC2) ──────────────────────────────────────────────────────
test('hard: legacy-format when the marker is missing', () => {
  const txt = `## mb-2026-07-28-a: T\n- status: active\n- date: 2026-07-28\n- consequence: c\n- state: s\n- open-loop: o\n- read-if: r\n`;
  const v = validateParsed(parseIndex(txt));
  assert.ok(clsSet(v.hard).has('legacy-format'), 'missing marker → legacy-format');
});

test('hard: legacy-format when the marker is mismatched (a different version)', () => {
  const txt = `<!-- disclosure-format: v1 -->\n\n${ACTIVE('mb-2026-07-28-a')}\n`;
  const parsed = parseIndex(txt);
  assert.equal(parsed.hasMarker, false);
  assert.equal(parsed.markerMismatch, true);
  assert.ok(clsSet(validateParsed(parsed).hard).has('legacy-format'));
});

test('hard: malformed-schema for an invalid status', () => {
  const v = validateParsed(parseIndex(index(ACTIVE('mb-2026-07-28-a', { status: 'wibble' }))));
  assert.ok(clsSet(v.hard).has('malformed-schema'));
});

test('hard: malformed-schema for a malformed memory id', () => {
  const v = validateParsed(parseIndex(index(ACTIVE('mb-BADID', {}))));
  assert.ok(clsSet(v.hard).has('malformed-schema'), 'bad id → malformed-schema');
});

test('hard: missing-field for a dropped required field', () => {
  const v = validateParsed(parseIndex(index(ACTIVE('mb-2026-07-28-a', { consequence: '' }))));
  // empty value is treated as absent
  assert.ok(clsSet(v.hard).has('missing-field'));
});

test('hard: missing-field when an active entry names no way to die', () => {
  const v = validateParsed(
    parseIndex(index(ACTIVE('mb-2026-07-28-a', { 'open-loop': '', expires: '', 'expires-when': '' }))),
  );
  assert.ok(
    v.hard.some((f) => f.cls === 'missing-field' && /names no exit/.test(f.message)),
    'active with no expires/expires-when/open-loop → missing-field',
  );
});

test('hard: duplicate-id', () => {
  const v = validateParsed(parseIndex(index(ACTIVE('mb-2026-07-28-dup'), ACTIVE('mb-2026-07-28-dup'))));
  assert.ok(clsSet(v.hard).has('duplicate-id'));
});

test('hard: invalid-handoff when >5 or an unknown id is referenced', () => {
  const handoff = `## handoff-read-first\n1. mb-2026-07-28-nope\n`;
  const txt = `${MARKER}\n\n${handoff}\n${ACTIVE('mb-2026-07-28-a')}\n`;
  const parsed = parseIndex(txt);
  assert.deepEqual(parsed.handoffReadFirst, ['mb-2026-07-28-nope']);
  assert.ok(clsSet(validateParsed(parsed).hard).has('invalid-handoff'), 'unknown handoff id → invalid-handoff');

  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((s, i) => `${i + 1}. mb-2026-07-28-${s}`).join('\n');
  const blocks = ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => ACTIVE(`mb-2026-07-28-${s}`));
  const txt6 = `${MARKER}\n\n## handoff-read-first\n${six}\n\n${blocks.join('\n\n')}\n`;
  assert.ok(clsSet(validateParsed(parseIndex(txt6)).hard).has('invalid-handoff'), '>5 handoff entries → invalid-handoff');
});

test('hard: valid handoff-read-first is clean', () => {
  const txt = `${MARKER}\n\n## handoff-read-first\n1. mb-2026-07-28-a\n2. mb-2026-07-28-b\n\n${ACTIVE('mb-2026-07-28-a')}\n\n${ACTIVE('mb-2026-07-28-b')}\n`;
  const parsed = parseIndex(txt);
  assert.deepEqual(parsed.handoffReadFirst, ['mb-2026-07-28-a', 'mb-2026-07-28-b']);
  assert.ok(!clsSet(validateParsed(parsed).hard).has('invalid-handoff'));
});

test('hard: byte-budget overflow', () => {
  const filler = 'x'.repeat(MEMORY_INDEX_BUDGET_BYTES + 100);
  const v = validateParsed(parseIndex(index(ACTIVE('mb-2026-07-28-a', { state: filler }))));
  assert.ok(clsSet(v.hard).has('byte-budget'));
});

test('hard: line-budget overflow', () => {
  const bigState = 'line\\n'.repeat(0) + Array.from({ length: MEMORY_INDEX_BUDGET_LINES + 5 }, () => 'z').join('\n');
  const txt = `${MARKER}\n${bigState}\n\n${ACTIVE('mb-2026-07-28-a')}\n`;
  assert.ok(clsSet(validateParsed(parseIndex(txt)).hard).has('line-budget'));
});

// ── Advisory (AC2) ──────────────────────────────────────────────────────────
test('advisory: cap-pressure over the ratio, no hard finding', () => {
  const filler = 'y'.repeat(Math.ceil(MEMORY_INDEX_BUDGET_BYTES * CAP_PRESSURE_RATIO) + 200);
  const v = validateParsed(parseIndex(index(ACTIVE('mb-2026-07-28-a', { state: filler }))));
  assert.equal(v.hard.length, 0, 'still under the hard byte budget');
  assert.ok(clsSet(v.advisory).has('cap-pressure'));
});

test('advisory: a clean small index has no findings at all', () => {
  const v = validateParsed(parseIndex(index(ACTIVE('mb-2026-07-28-a'))));
  assert.equal(v.hard.length, 0);
  assert.equal(v.advisory.length, 0);
});

// ── @scope/pkg detection (AC3) ──────────────────────────────────────────────
test('scoped-pkg: bare token in prose is a HARD finding', () => {
  const bad = ACTIVE('mb-2026-07-28-a', { state: 'install @acme/widgets then run it' });
  const v = validateParsed(parseIndex(index(bad)));
  assert.ok(clsSet(v.hard).has('bare-scoped-pkg'));
});

test('scoped-pkg: backticked token is clean', () => {
  const ok = ACTIVE('mb-2026-07-28-a', { state: 'install `@acme/widgets` then run' });
  const v = validateParsed(parseIndex(index(ok)));
  assert.ok(!clsSet(v.hard).has('bare-scoped-pkg'));
});

test('scoped-pkg: fenced + inline code spans are ignored', () => {
  assert.deepEqual(detectBareScopedPkg('```\n@acme/widgets\n```'), [], 'fenced ignored');
  assert.deepEqual(detectBareScopedPkg('use `@acme/widgets` here'), [], 'inline ignored');
  assert.deepEqual(detectBareScopedPkg('bare @acme/widgets here'), ['@acme/widgets'], 'prose caught');
});

// ── Helpers ─────────────────────────────────────────────────────────────────
test('utf8ByteLength counts multibyte correctly', () => {
  assert.equal(utf8ByteLength('abc'), 3);
  assert.equal(utf8ByteLength('é'), 2); // U+00E9
  assert.equal(utf8ByteLength('😀'), 4); // astral
});

test('countLines: CRLF normalized, LF + 1; empty → 1', () => {
  assert.equal(countLines(''), 1);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\r\nb\r\nc'), 3);
});

test('safeUtf8Truncate never splits a multibyte sequence', () => {
  // 'a' + '😀'(4 bytes). Cap at 2 bytes → keep only 'a' (dropping the split emoji).
  const s = 'a😀';
  const t = safeUtf8Truncate(s, 2);
  assert.equal(t, 'a', 'the 4-byte emoji is dropped rather than split');
  assert.ok(utf8ByteLength(t) <= 2);
  // Cap at 5 bytes → whole string fits (1 + 4).
  assert.equal(safeUtf8Truncate(s, 5), 'a😀');
  // No truncation when it already fits.
  assert.equal(safeUtf8Truncate('hello', 100), 'hello');
  assert.equal(safeUtf8Truncate('hello', 0), '');
});

test('isValidMemoryId enforces the frozen grammar', () => {
  assert.ok(isValidMemoryId('mb-2026-07-28-slug'));
  assert.ok(isValidMemoryId('mb-2026-07-28-a-b-9'));
  assert.ok(!isValidMemoryId('mb-2026-7-28-slug'), 'month must be zero-padded');
  assert.ok(!isValidMemoryId('mb-2026-07-28-Slug'), 'uppercase rejected');
  assert.ok(!isValidMemoryId('memory-2026-07-28-slug'));
  assert.ok(!isValidMemoryId('mb-2026-07-28-'), 'empty slug rejected');
});

// ── Grep-assert: the core imports no fs / realpath (AC6) ─────────────────────
test('core module imports no fs / realpath (WP-A2 boundary)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../../../src/shared/memory-index-core.ts'), 'utf8');
  // Strip block AND line comments so the prose ("no `fs`, no `realpath`") does
  // not trip the grep — we assert on actual code, not documentation.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block / JSDoc comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (no `://` in this file)
  assert.ok(!/\bfrom ['"]fs['"]/.test(code), 'must not import from "fs"');
  assert.ok(!/\bfrom ['"]node:fs['"]/.test(code), 'must not import from "node:fs"');
  assert.ok(!/\brequire\((['"])(node:)?fs\1\)/.test(code), 'must not require fs');
  assert.ok(!/realpath/i.test(code), 'must not reference realpath');
});

// ── Runner ──────────────────────────────────────────────────────────────────
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
console.log(`\nmemory-index core: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
