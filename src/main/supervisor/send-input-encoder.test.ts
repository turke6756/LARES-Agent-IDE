// Tests for BUG-01 (launch_agent auto-submits the initial prompt).
//
// Covers the two building blocks that AgentSupervisor._doSendInput now uses to
// decide whether to press Enter after writing the prompt body:
//
//   - WSL agents → tmuxSendInput → buildTmuxSendInputCmd(name, text, provider, submit)
//     The kitty Enter byte sequence `\x1b[13u` (hex `1b 5b 31 33 75`) MUST be
//     present in the generated `tmux send-keys -H ...` command when submit=true
//     and absent when submit=false.
//
//   - Windows agents → getWindowsSubmitSequence(provider) returns the bytes
//     that get written to the PTY after the body when submit=true. _doSendInput
//     skips that write entirely when submit=false.
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/send-input-encoder.test.js

import assert from 'node:assert/strict';
import { buildTmuxSendInputCmd, TMUX_KITTY_ENTER_HEX } from '../wsl-bridge';
import { getWindowsSubmitSequence } from './send-input-encoders';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

const SESSION = 'agentd_test__abc123';
const BODY = 'hello world';

// ── WSL path: tmuxSendInput command builder ─────────────────────────────────

test('WSL claude: submit=true appends the kitty Enter', () => {
  const cmd = buildTmuxSendInputCmd(SESSION, BODY, 'claude', true);
  assert.ok(cmd, 'expected a cmd string');
  assert.ok(cmd.includes(TMUX_KITTY_ENTER_HEX),
    `claude submit=true cmd should include kitty Enter (${TMUX_KITTY_ENTER_HEX}); got: ${cmd}`);
});

test('WSL claude: submit=false omits the kitty Enter', () => {
  const cmd = buildTmuxSendInputCmd(SESSION, BODY, 'claude', false);
  assert.ok(cmd, 'expected a cmd string');
  assert.ok(!cmd.includes(TMUX_KITTY_ENTER_HEX),
    `claude submit=false cmd should NOT include kitty Enter; got: ${cmd}`);
  // Body still goes through: bracketed-paste start hex must be there.
  assert.ok(cmd.includes('1b 5b 32 30 30 7e'),
    `claude submit=false cmd should still send the body (bracketed-paste start); got: ${cmd}`);
});

test('WSL codex: submit=true appends the kitty Enter', () => {
  const cmd = buildTmuxSendInputCmd(SESSION, BODY, 'codex', true);
  assert.ok(cmd, 'expected a cmd string');
  assert.ok(cmd.includes(TMUX_KITTY_ENTER_HEX),
    `codex submit=true cmd should include kitty Enter; got: ${cmd}`);
});

test('WSL codex: submit=false omits the kitty Enter (body still typed)', () => {
  const cmd = buildTmuxSendInputCmd(SESSION, BODY, 'codex', false);
  assert.ok(cmd, 'expected a cmd string (body must still be typed)');
  assert.ok(!cmd.includes(TMUX_KITTY_ENTER_HEX),
    `codex submit=false cmd should NOT include kitty Enter; got: ${cmd}`);
  assert.ok(cmd.includes(BODY),
    `codex submit=false cmd should still type the body; got: ${cmd}`);
});

test('WSL gemini: submit=true appends the kitty Enter', () => {
  const cmd = buildTmuxSendInputCmd(SESSION, BODY, 'gemini', true);
  assert.ok(cmd, 'expected a cmd string');
  assert.ok(cmd.includes(TMUX_KITTY_ENTER_HEX),
    `gemini submit=true cmd should include kitty Enter; got: ${cmd}`);
});

test('WSL gemini: submit=false omits the kitty Enter', () => {
  const cmd = buildTmuxSendInputCmd(SESSION, BODY, 'gemini', false);
  assert.ok(cmd, 'expected a cmd string (body must still be typed)');
  assert.ok(!cmd.includes(TMUX_KITTY_ENTER_HEX),
    `gemini submit=false cmd should NOT include kitty Enter; got: ${cmd}`);
});

test('WSL codex: submit=true with empty body still sends Enter (submit-only)', () => {
  const cmd = buildTmuxSendInputCmd(SESSION, '', 'codex', true);
  assert.ok(cmd, 'expected a cmd string');
  assert.ok(cmd.includes(TMUX_KITTY_ENTER_HEX),
    `empty-body submit=true should send a bare kitty Enter; got: ${cmd}`);
});

test('WSL codex: submit=false with empty body is a no-op (returns null)', () => {
  const cmd = buildTmuxSendInputCmd(SESSION, '', 'codex', false);
  assert.equal(cmd, null,
    'empty body + submit=false should produce nothing to send');
});

// ── Windows path: getWindowsSubmitSequence ──────────────────────────────────

const WIN32_KEY_ENTER_DOWN = '\x1b[13;28;13;1;0;1_';
const WIN32_KEY_ENTER_UP = '\x1b[13;28;13;0;0;1_';

test('Windows claude submit sequence is CR', () => {
  assert.equal(getWindowsSubmitSequence('claude'), '\r');
});

test('Windows codex submit sequence is VK_RETURN down+up pair', () => {
  assert.equal(
    getWindowsSubmitSequence('codex'),
    WIN32_KEY_ENTER_DOWN + WIN32_KEY_ENTER_UP,
  );
});

test('Windows gemini submit sequence is VK_RETURN down+up pair', () => {
  assert.equal(
    getWindowsSubmitSequence('gemini'),
    WIN32_KEY_ENTER_DOWN + WIN32_KEY_ENTER_UP,
  );
});

test('Windows unknown provider falls back to CR', () => {
  assert.equal(getWindowsSubmitSequence('unknown'), '\r');
});

// ── Run ─────────────────────────────────────────────────────────────────────

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
  console.log(`\nAll ${tests.length} send-input-encoder tests passed`);
})();
