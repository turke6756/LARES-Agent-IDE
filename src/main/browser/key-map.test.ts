// WP-C C6 (plans/groupthink/browser-parity-and-research-store.md) — pure unit
// tests for the press_key / select-all CDP key map. NO Electron imports.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/browser/key-map.test.js

import assert from 'node:assert/strict';
import {
  NAMED_KEYS,
  SELECT_ALL,
  SUPPORTED_BROWSER_KEYS,
  resolveKey,
} from './key-map';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

// ── Named keys → expected VK codes ──────────────────────────────────────────

test('each named key carries the expected windowsVirtualKeyCode', () => {
  const expected: Record<string, number> = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34,
  };
  for (const [name, vk] of Object.entries(expected)) {
    const k = NAMED_KEYS[name];
    assert.ok(k, `${name} present`);
    assert.equal(k.windowsVirtualKeyCode, vk, name);
    assert.equal(k.key, name, `${name} key field matches its name`);
  }
  // The table contains exactly these keys (no stray entries).
  assert.deepEqual(SUPPORTED_BROWSER_KEYS.sort(), Object.keys(expected).sort());
});

test('Enter and Tab carry their character; other keys do not', () => {
  assert.equal(NAMED_KEYS.Enter.text, '\r');
  assert.equal(NAMED_KEYS.Tab.text, '\t');
  for (const name of ['Escape', 'Backspace', 'Delete', 'ArrowUp', 'Home', 'PageDown']) {
    assert.equal(NAMED_KEYS[name].text, undefined, `${name} carries no text`);
  }
});

// ── resolveKey ──────────────────────────────────────────────────────────────

test('resolveKey is case-insensitive and returns the exact payload', () => {
  assert.equal(resolveKey('Enter'), NAMED_KEYS.Enter);
  assert.equal(resolveKey('enter'), NAMED_KEYS.Enter);
  assert.equal(resolveKey('ENTER'), NAMED_KEYS.Enter);
  assert.equal(resolveKey('arrowdown'), NAMED_KEYS.ArrowDown);
  assert.equal(resolveKey('PAGEUP'), NAMED_KEYS.PageUp);
});

test('resolveKey returns null for unknown / non-string names', () => {
  assert.equal(resolveKey('F13'), null);
  assert.equal(resolveKey('a'), null); // not in the named set (select-all is internal)
  assert.equal(resolveKey(''), null);
  // @ts-expect-error — runtime guard against non-string input
  assert.equal(resolveKey(42), null);
  // @ts-expect-error — runtime guard against null
  assert.equal(resolveKey(null), null);
});

// ── SELECT_ALL (type() replace path) ────────────────────────────────────────

test('SELECT_ALL is Ctrl+A carrying the named selectAll editor command', () => {
  assert.equal(SELECT_ALL.modifiers, 2);
  assert.equal(SELECT_ALL.key, 'a');
  assert.equal(SELECT_ALL.code, 'KeyA');
  assert.equal(SELECT_ALL.windowsVirtualKeyCode, 65);
  // The command array is what actually selects (input-type-agnostic); the VK
  // and modifier are fidelity only.
  assert.deepEqual(SELECT_ALL.commands, ['selectAll']);
});

// ── Run ─────────────────────────────────────────────────────────────────────

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
console.log(`\nAll ${tests.length} key-map tests passed`);
