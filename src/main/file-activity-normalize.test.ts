// Checkpoint Surface Hardening WP1 — parser + canonicalizer fixtures for the
// shared file-activity normalizer.
//
//   npm run build:main
//   node dist/main/main/file-activity-normalize.test.js
//
// Byte-exact synthetic fixtures are the blocking gate (see the plan). ESC (0x1b)
// and BEL (0x07) are written as explicit escapes so the fixtures are unambiguous
// on disk regardless of editor / line-ending handling.

import assert from 'node:assert/strict';
import {
  unwrapOsc8,
  stripTerminalEscapes,
  canonicalizeToAbsolute,
  looksPolluted,
} from './file-activity-normalize';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const ESC = '\x1b';
const BEL = '\x07';
const ST = ESC + '\\'; // string terminator

// ── unwrapOsc8: intact ST / intact BEL / ESC-eaten degraded / ambiguous ───────

test('passthrough: a clean path with no OSC-8 marker is returned verbatim', () => {
  const r = unwrapOsc8('C:\\repo\\src\\main.ts');
  assert.deepEqual(r, { text: 'C:\\repo\\src\\main.ts' });
});

test('intact ST: display text (human path) is recovered', () => {
  const raw = `${ESC}]8;id=9;file:///C:/repo/src/main.ts${ST}C:\\repo\\src\\main.ts${ESC}]8;;${ST}`;
  assert.deepEqual(unwrapOsc8(raw), { text: 'C:\\repo\\src\\main.ts' });
});

test('intact BEL: display text is recovered', () => {
  const raw = `${ESC}]8;id=9;file:///C:/repo/a.ts${BEL}C:\\repo\\a.ts${ESC}]8;;${BEL}`;
  assert.deepEqual(unwrapOsc8(raw), { text: 'C:\\repo\\a.ts' });
});

test('intact ST with empty params: still recovers display', () => {
  const raw = `${ESC}]8;;file:///C:/repo/b.ts${ST}C:\\repo\\b.ts${ESC}]8;;${ST}`;
  assert.deepEqual(unwrapOsc8(raw), { text: 'C:\\repo\\b.ts' });
});

test('ESC-eaten degraded: display boundary lost → recovers the file: URI', () => {
  // Exactly what the OLD BEL-only stripAnsi leaves from an ST-terminated link:
  // every ESC removed, each ST collapsed to a bare `\` residue.
  const raw = `]8;id=9;file:///C:/repo/src/main.ts\\C:\\repo\\src\\main.ts]8;;\\`;
  assert.deepEqual(unwrapOsc8(raw), { text: 'file:///C:/repo/src/main.ts' });
});

test('ambiguous — nested / multiple links → dropped', () => {
  const raw =
    `${ESC}]8;id=1;file:///C:/a${ST}A${ESC}]8;id=2;file:///C:/b${ST}B${ESC}]8;;${ST}`;
  assert.deepEqual(unwrapOsc8(raw), { ambiguous: true });
});

test('ambiguous — unbalanced (opener, no closer) → dropped', () => {
  const raw = `${ESC}]8;id=1;file:///C:/a${ST}somedisplay`;
  assert.deepEqual(unwrapOsc8(raw), { ambiguous: true });
});

test('ambiguous — both display and uri empty → dropped', () => {
  const raw = `${ESC}]8;;${ST}${ESC}]8;;${ST}`;
  assert.deepEqual(unwrapOsc8(raw), { ambiguous: true });
});

test('ambiguous — second marker is not a real closer (path tail) → dropped', () => {
  const raw = `${ESC}]8;id=1;file:///C:/a${ST}A${ESC}]8;x;more/path`;
  assert.deepEqual(unwrapOsc8(raw), { ambiguous: true });
});

// ── full ingress pipeline (unwrap → strip → canonicalize), mirroring addFileActivity ──

function ingress(raw: string, ctx: { cwd?: string; home?: string } = {}): string | null {
  const clean = unwrapOsc8(raw);
  if ('ambiguous' in clean) return null;
  const abs = canonicalizeToAbsolute(stripTerminalEscapes(clean.text), ctx);
  return abs === '' ? null : abs;
}

test('pipeline: intact ST polluted path → clean absolute native path', () => {
  const raw = `${ESC}]8;id=9;file:///C:/repo/src/main.ts${ST}C:\\repo\\src\\main.ts${ESC}]8;;${ST}`;
  assert.equal(ingress(raw), 'C:\\repo\\src\\main.ts');
});

test('pipeline: ESC-eaten degraded → file: URI decoded to native path', () => {
  const raw = `]8;id=9;file:///C:/repo/src/main.ts\\C:\\repo\\src\\main.ts]8;;\\`;
  assert.equal(ingress(raw), 'C:\\repo\\src\\main.ts');
});

test('pipeline: ambiguous value is dropped (null)', () => {
  const raw = `${ESC}]8;id=1;file:///C:/a${ST}A${ESC}]8;id=2;file:///C:/b${ST}B${ESC}]8;;${ST}`;
  assert.equal(ingress(raw), null);
});

// ── canonicalizeToAbsolute coverage matrix ────────────────────────────────────

const HOME = 'C:\\Users\\me';
const CWD = 'C:\\repo';

test('~ whole leading segment expands to home', () => {
  assert.equal(canonicalizeToAbsolute('~', { home: HOME }), 'C:\\Users\\me');
  assert.equal(canonicalizeToAbsolute('~/foo/bar', { home: HOME }), 'C:\\Users\\me\\foo\\bar');
  assert.equal(canonicalizeToAbsolute('~\\foo', { home: HOME }), 'C:\\Users\\me\\foo');
});

test('~foo is NOT home (treated as a relative segment)', () => {
  assert.equal(canonicalizeToAbsolute('~foo', { cwd: CWD, home: HOME }), 'C:\\repo\\~foo');
});

test('relative path resolves against cwd', () => {
  assert.equal(canonicalizeToAbsolute('src/main.ts', { cwd: CWD }), 'C:\\repo\\src\\main.ts');
});

test('relative path with no cwd is left normalized (not dropped)', () => {
  assert.equal(canonicalizeToAbsolute('src/main.ts', {}), 'src/main.ts');
});

test('absolute passthrough + normalize collapses ..', () => {
  assert.equal(canonicalizeToAbsolute('C:\\repo\\src\\..\\main.ts', {}), 'C:\\repo\\main.ts');
});

test('separator normalization to native (forward → back)', () => {
  assert.equal(canonicalizeToAbsolute('C:/repo/x.ts', {}), 'C:\\repo\\x.ts');
});

test('drive-letter upcasing', () => {
  assert.equal(canonicalizeToAbsolute('c:\\repo\\x.ts', {}), 'C:\\repo\\x.ts');
});

test('file:// drive URI → native path', () => {
  assert.equal(canonicalizeToAbsolute('file:///C:/repo/x.ts', {}), 'C:\\repo\\x.ts');
});

test('file:// URI percent-decoding', () => {
  assert.equal(canonicalizeToAbsolute('file:///C:/repo/a%20b.ts', {}), 'C:\\repo\\a b.ts');
});

test('file:// UNC URI → \\\\server\\share', () => {
  assert.equal(canonicalizeToAbsolute('file://server/share/x.ts', {}), '\\\\server\\share\\x.ts');
});

test('file:// POSIX URI preserved as POSIX', () => {
  assert.equal(canonicalizeToAbsolute('file:///home/u/x', {}), '/home/u/x');
});

test('UNC path passthrough', () => {
  assert.equal(canonicalizeToAbsolute('\\\\server\\share\\x', {}), '\\\\server\\share\\x');
});

test('POSIX-absolute (WSL) preserved as POSIX, not flipped to backslashes', () => {
  assert.equal(canonicalizeToAbsolute('/home/u/../u/x', {}), '/home/u/x');
});

test('empty / control-only → empty string', () => {
  assert.equal(canonicalizeToAbsolute('', {}), '');
  assert.equal(canonicalizeToAbsolute('   ', {}), '');
  assert.equal(canonicalizeToAbsolute(`${ESC}${BEL}`, {}), '');
});

test('out-of-workspace is NOT rejected here', () => {
  assert.equal(canonicalizeToAbsolute('D:\\somewhere\\else\\file.ts', {}), 'D:\\somewhere\\else\\file.ts');
});

// ── idempotency: f(f(x)) === f(x) across the matrix ───────────────────────────

test('canonicalizeToAbsolute is idempotent', () => {
  const inputs: Array<[string, { cwd?: string; home?: string }]> = [
    ['~/foo/bar', { home: HOME }],
    ['~foo', { cwd: CWD, home: HOME }],
    ['src/main.ts', { cwd: CWD }],
    ['src/main.ts', {}],
    ['C:\\repo\\src\\..\\main.ts', {}],
    ['C:/repo/x.ts', {}],
    ['c:\\repo\\x.ts', {}],
    ['file:///C:/repo/x.ts', {}],
    ['file:///C:/repo/a%20b.ts', {}],
    ['file://server/share/x.ts', {}],
    ['file:///home/u/x', {}],
    ['\\\\server\\share\\x', {}],
    ['/home/u/../u/x', {}],
    ['D:\\somewhere\\else\\file.ts', {}],
  ];
  for (const [input, ctx] of inputs) {
    const once = canonicalizeToAbsolute(input, ctx);
    const twice = canonicalizeToAbsolute(once, ctx);
    assert.equal(twice, once, `not idempotent for ${JSON.stringify(input)}: ${once} → ${twice}`);
  }
});

// ── looksPolluted prefilter ───────────────────────────────────────────────────

test('looksPolluted flags ESC / OSC marker / embedded file: URI', () => {
  assert.equal(looksPolluted(`${ESC}]8;x`), true);
  assert.equal(looksPolluted(']8;id=1;file:///C:/a'), true);
  assert.equal(looksPolluted('C:\\repo\\;file:///x'), true);
  assert.equal(looksPolluted('C:\\repo\\src\\main.ts'), false);
  assert.equal(looksPolluted('/home/u/x'), false);
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
      console.error('       ', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
