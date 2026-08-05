// Tests for BUG-02 (named-key → PTY byte sequence mapping).
//
// Verifies that `mapKeyToBytes` returns the right byte sequence for every
// supported (key, provider, pathType) combination. The provider/host matrix
// matters most for `enter` and `shift-enter`, where claude differs from
// codex and Windows differs from WSL — get this wrong and Enter
// silently fails (renders as text without submitting).
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/key-bytes.test.js

import assert from 'node:assert/strict';
import { mapKeyToBytes, isKeyName, SUPPORTED_KEY_NAMES } from './key-bytes';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

// ── Enter: the provider+host-sensitive case ─────────────────────────────────

test('enter: claude/windows → bare CR', () => {
  assert.equal(mapKeyToBytes('enter', 'claude', 'windows'), '\r');
});

test('enter: claude/wsl → bare CR', () => {
  assert.equal(mapKeyToBytes('enter', 'claude', 'wsl'), '\r');
});

test('enter: codex/windows → Win32 VK_RETURN down+up', () => {
  assert.equal(
    mapKeyToBytes('enter', 'codex', 'windows'),
    '\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_',
  );
});

test('enter: grok/windows → bare CR (shares the Claude-on-Windows encoding)', () => {
  // Source-verified: grok submits on a bare crossterm KeyCode::Enter/NONE over
  // ConPTY (grok-phase0-probe-results.md §0.1). Must be CR, not the codex
  // Win32 VK_RETURN pair.
  assert.equal(mapKeyToBytes('enter', 'grok', 'windows'), '\r');
  assert.equal(
    mapKeyToBytes('enter', 'grok', 'windows'),
    mapKeyToBytes('enter', 'claude', 'windows'),
  );
  assert.notEqual(
    mapKeyToBytes('enter', 'grok', 'windows'),
    mapKeyToBytes('enter', 'codex', 'windows'),
  );
});

test('enter: agy/windows → bare CR submit, never LF', () => {
  // Empirically proven with the dashboard's node-pty/ConPTY transport:
  // C:/Users/turke/Projects/plans/agy-phase0-probe-results.md §0.1.
  assert.equal(mapKeyToBytes('enter', 'agy', 'windows'), '\r');
  assert.notEqual(mapKeyToBytes('enter', 'agy', 'windows'), '\n');
  assert.equal(
    mapKeyToBytes('enter', 'agy', 'windows'),
    mapKeyToBytes('enter', 'claude', 'windows'),
  );
});

test('enter: codex/wsl → kitty CSI-u \\x1b[13u', () => {
  assert.equal(mapKeyToBytes('enter', 'codex', 'wsl'), '\x1b[13u');
});

// ── Shift-Enter: newline-without-submit, also provider+host-sensitive ──────

test('shift-enter: claude/windows → LF', () => {
  assert.equal(mapKeyToBytes('shift-enter', 'claude', 'windows'), '\n');
});

test('shift-enter: codex/windows → Win32 Shift+Enter down+up', () => {
  assert.equal(
    mapKeyToBytes('shift-enter', 'codex', 'windows'),
    '\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_',
  );
});

test('shift-enter: grok/windows → backslash-continuation (`\\` + CR), not a Shift byte', () => {
  // Grok has NO distinct Shift+Enter byte over ConPTY — both are CR — so a
  // synthesized Shift+VK_RETURN/kitty sequence is inert. Its newline-without-
  // submit is backslash-continuation. Source: route_enter mod.rs:2110 &
  // 2134-2139 (grok-phase0-probe-results.md §0.1).
  assert.equal(mapKeyToBytes('shift-enter', 'grok', 'windows'), '\\\r');
  assert.notEqual(
    mapKeyToBytes('shift-enter', 'grok', 'windows'),
    mapKeyToBytes('shift-enter', 'codex', 'windows'),
  );
});

test('shift-enter: agy/windows → LF newline without submit', () => {
  // Probe §0.1 observed zero turn-start markers after LF and a two-line prompt.
  assert.equal(mapKeyToBytes('shift-enter', 'agy', 'windows'), '\n');
  assert.notEqual(
    mapKeyToBytes('shift-enter', 'agy', 'windows'),
    mapKeyToBytes('enter', 'agy', 'windows'),
  );
});

test('shift-enter: codex/wsl → kitty \\x1b[13;2u', () => {
  assert.equal(mapKeyToBytes('shift-enter', 'codex', 'wsl'), '\x1b[13;2u');
});

// ── Provider-agnostic keys ──────────────────────────────────────────────────

test('esc → \\x1b for every provider/host', () => {
  for (const provider of ['claude', 'codex'] as const) {
    for (const pathType of ['windows', 'wsl'] as const) {
      assert.equal(mapKeyToBytes('esc', provider, pathType), '\x1b',
        `esc/${provider}/${pathType} should be \\x1b`);
    }
  }
});

test('tab → \\t for every provider/host', () => {
  for (const provider of ['claude', 'codex'] as const) {
    for (const pathType of ['windows', 'wsl'] as const) {
      assert.equal(mapKeyToBytes('tab', provider, pathType), '\t');
    }
  }
});

test('arrow keys → standard CSI sequences for every provider/host', () => {
  for (const provider of ['claude', 'codex'] as const) {
    for (const pathType of ['windows', 'wsl'] as const) {
      assert.equal(mapKeyToBytes('up', provider, pathType), '\x1b[A');
      assert.equal(mapKeyToBytes('down', provider, pathType), '\x1b[B');
      assert.equal(mapKeyToBytes('right', provider, pathType), '\x1b[C');
      assert.equal(mapKeyToBytes('left', provider, pathType), '\x1b[D');
    }
  }
});

test('backspace → DEL (\\x7f), not BS (\\x08)', () => {
  // Readline/blessed/ink all treat 0x7f as backspace; 0x08 typically
  // shows up as ^H instead.
  assert.equal(mapKeyToBytes('backspace', 'claude', 'windows'), '\x7f');
  assert.equal(mapKeyToBytes('backspace', 'codex', 'wsl'), '\x7f');
});

test('ctrl-c → \\x03 for every provider/host', () => {
  for (const provider of ['claude', 'codex'] as const) {
    for (const pathType of ['windows', 'wsl'] as const) {
      assert.equal(mapKeyToBytes('ctrl-c', provider, pathType), '\x03');
    }
  }
});

test('ctrl-d → \\x04 for every provider/host', () => {
  for (const provider of ['claude', 'codex'] as const) {
    for (const pathType of ['windows', 'wsl'] as const) {
      assert.equal(mapKeyToBytes('ctrl-d', provider, pathType), '\x04');
    }
  }
});

test('space → " "', () => {
  assert.equal(mapKeyToBytes('space', 'claude', 'windows'), ' ');
});

// ── Guard rails ────────────────────────────────────────────────────────────

test('isKeyName accepts every supported name', () => {
  for (const name of SUPPORTED_KEY_NAMES) {
    assert.equal(isKeyName(name), true, `${name} should be a valid key name`);
  }
});

test('isKeyName rejects unknown / non-string input', () => {
  assert.equal(isKeyName('return'), false);  // not in the enum
  assert.equal(isKeyName('Enter'), false);   // case-sensitive
  assert.equal(isKeyName(''), false);
  assert.equal(isKeyName(undefined), false);
  assert.equal(isKeyName(null), false);
  assert.equal(isKeyName(13), false);
});

test('every supported key resolves to non-empty bytes for every combo', () => {
  for (const key of SUPPORTED_KEY_NAMES) {
    for (const provider of ['claude', 'codex'] as const) {
      for (const pathType of ['windows', 'wsl'] as const) {
        const bytes = mapKeyToBytes(key, provider, pathType);
        assert.ok(
          typeof bytes === 'string' && bytes.length > 0,
          `${key}/${provider}/${pathType} returned empty bytes`,
        );
      }
    }
  }
});

// ── Run ────────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
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
  console.log(`\nAll ${tests.length} key-bytes tests passed`);
})();
