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
// Also covers the length-safety contract from
// plans/wsl-codex-relay-length-bug-2026-06-10.md: the body must travel via the
// builder's `stdin` field (consumed by `tmux load-buffer -`), never inside the
// command string, so large GroupThink drafts can't overflow tmux's
// command-length limit or Windows CreateProcess's ~32 KB argv cap.
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
  const input = buildTmuxSendInputCmd(SESSION, BODY, 'claude', true);
  assert.ok(input, 'expected a command');
  assert.ok(input.cmd.includes(TMUX_KITTY_ENTER_HEX),
    `claude submit=true cmd should include kitty Enter (${TMUX_KITTY_ENTER_HEX}); got: ${input.cmd}`);
  assert.equal(input.stdin, BODY, 'body must travel via stdin');
});

test('WSL claude: submit=false omits the kitty Enter', () => {
  const input = buildTmuxSendInputCmd(SESSION, BODY, 'claude', false);
  assert.ok(input, 'expected a command');
  assert.ok(!input.cmd.includes(TMUX_KITTY_ENTER_HEX),
    `claude submit=false cmd should NOT include kitty Enter; got: ${input.cmd}`);
  // Body still goes through: load-buffer + paste-buffer with stdin payload.
  assert.ok(input.cmd.includes('load-buffer'), `expected load-buffer; got: ${input.cmd}`);
  assert.equal(input.stdin, BODY, 'body must travel via stdin');
});

test('WSL claude: paste is explicitly bracketed and newline-preserving (-r)', () => {
  // The pane must receive \x1b[200~ + body-with-LF + \x1b[201~, byte-identical
  // to the previous explicit send-keys wrapping. The markers are sent as
  // unconditional `send-keys -H` hex (NOT `paste-buffer -p`, which skips them
  // when the app hasn't requested bracketed-paste mode), and `-r` stops the
  // default LF→CR translation.
  const input = buildTmuxSendInputCmd(SESSION, 'a\nb', 'claude', true);
  assert.ok(input, 'expected a command');
  const bpStart = input.cmd.indexOf('1b 5b 32 30 30 7e');
  const paste = input.cmd.indexOf('paste-buffer');
  const bpEnd = input.cmd.indexOf('1b 5b 32 30 31 7e');
  assert.ok(bpStart !== -1 && paste !== -1 && bpEnd !== -1 && bpStart < paste && paste < bpEnd,
    `claude cmd must wrap the paste in explicit BP markers; got: ${input.cmd}`);
  assert.ok(/paste-buffer [^&]*-r/.test(input.cmd),
    `claude paste must preserve LF (-r); got: ${input.cmd}`);
  assert.ok(!/paste-buffer [^&]*-p/.test(input.cmd),
    `claude must not rely on conditional paste-buffer -p; got: ${input.cmd}`);
});

test('WSL codex: submit=true appends the kitty Enter', () => {
  const input = buildTmuxSendInputCmd(SESSION, BODY, 'codex', true);
  assert.ok(input, 'expected a command');
  assert.ok(input.cmd.includes(TMUX_KITTY_ENTER_HEX),
    `codex submit=true cmd should include kitty Enter; got: ${input.cmd}`);
  assert.equal(input.stdin, BODY, 'body must travel via stdin');
});

test('WSL codex: submit=false omits the kitty Enter (body still pasted)', () => {
  const input = buildTmuxSendInputCmd(SESSION, BODY, 'codex', false);
  assert.ok(input, 'expected a command (body must still be pasted)');
  assert.ok(!input.cmd.includes(TMUX_KITTY_ENTER_HEX),
    `codex submit=false cmd should NOT include kitty Enter; got: ${input.cmd}`);
  assert.ok(input.cmd.includes('load-buffer') && input.cmd.includes('paste-buffer'),
    `codex submit=false cmd should still paste the body; got: ${input.cmd}`);
  assert.equal(input.stdin, BODY, 'body must travel via stdin');
});

test('WSL codex: raw paste — no bracketed-paste flag, no per-line send-keys', () => {
  // The verified-live shape: raw paste-buffer (default LF→CR translation),
  // body entirely on stdin. A per-line `send-keys -l` chain is the bug.
  const multiline = 'line one\nline two\nline three';
  const input = buildTmuxSendInputCmd(SESSION, multiline, 'codex', true);
  assert.ok(input, 'expected a command');
  assert.ok(!/paste-buffer [^&]*-p/.test(input.cmd),
    `codex paste must be raw (no -p); got: ${input.cmd}`);
  assert.ok(!input.cmd.includes('send-keys -t') || input.cmd.indexOf('send-keys') > input.cmd.indexOf('paste-buffer'),
    `only the trailing submit may use send-keys; got: ${input.cmd}`);
  assert.ok(!input.cmd.includes('-l '),
    `codex cmd must not contain a literal send-keys -l chain; got: ${input.cmd}`);
  assert.equal(input.stdin, multiline, 'multiline body must travel via stdin verbatim');
  assert.ok(!input.cmd.includes('line one'),
    `body text must not appear in the command string; got: ${input.cmd}`);
});

test('WSL gemini: submit=true appends the kitty Enter', () => {
  const input = buildTmuxSendInputCmd(SESSION, BODY, 'gemini', true);
  assert.ok(input, 'expected a command');
  assert.ok(input.cmd.includes(TMUX_KITTY_ENTER_HEX),
    `gemini submit=true cmd should include kitty Enter; got: ${input.cmd}`);
});

test('WSL gemini: submit=false omits the kitty Enter', () => {
  const input = buildTmuxSendInputCmd(SESSION, BODY, 'gemini', false);
  assert.ok(input, 'expected a command (body must still be pasted)');
  assert.ok(!input.cmd.includes(TMUX_KITTY_ENTER_HEX),
    `gemini submit=false cmd should NOT include kitty Enter; got: ${input.cmd}`);
});

test('WSL codex: submit=true with empty body still sends Enter (submit-only)', () => {
  const input = buildTmuxSendInputCmd(SESSION, '', 'codex', true);
  assert.ok(input, 'expected a command');
  assert.ok(input.cmd.includes(TMUX_KITTY_ENTER_HEX),
    `empty-body submit=true should send a bare kitty Enter; got: ${input.cmd}`);
  assert.equal(input.stdin, undefined, 'submit-only command carries no stdin');
  assert.ok(!input.cmd.includes('load-buffer'),
    `submit-only command must not paste; got: ${input.cmd}`);
});

test('WSL codex: submit=false with empty body is a no-op (returns null)', () => {
  const input = buildTmuxSendInputCmd(SESSION, '', 'codex', false);
  assert.equal(input, null,
    'empty body + submit=false should produce nothing to send');
});

test('WSL: command length is constant regardless of payload size (length-safety)', () => {
  // The original bug: a ~20 KB / 300-line draft expanded into a >32 KB
  // per-line send-keys chain, overflowing tmux's command-length limit and the
  // Windows CreateProcess argv cap. The fix moves the body to stdin, so the
  // command must stay small and payload-independent.
  const draft = Array.from({ length: 312 }, (_, i) =>
    `## Section ${i}: some draft text with 'quotes', $vars, \`backticks\` and unicode R² → ρ`).join('\n');
  assert.ok(draft.length > 20000, 'fixture should exceed 20 KB');
  for (const provider of ['claude', 'codex', 'gemini'] as const) {
    const input = buildTmuxSendInputCmd(SESSION, draft, provider, true);
    assert.ok(input, 'expected a command');
    assert.ok(input.cmd.length < 512,
      `${provider} cmd must stay small (got ${input.cmd.length} chars): ${input.cmd}`);
    assert.equal(input.stdin, draft, `${provider} stdin must carry the full draft verbatim`);
  }
});

test('WSL: special characters and CRLF normalize into stdin untouched otherwise', () => {
  const tricky = "R² ρ → em—dash curly 'quotes' `backticks` $(sub) \"double\"\r\nnext\rline";
  const input = buildTmuxSendInputCmd(SESSION, tricky, 'codex', true);
  assert.ok(input, 'expected a command');
  assert.equal(input.stdin,
    "R² ρ → em—dash curly 'quotes' `backticks` $(sub) \"double\"\nnext\nline",
    'CRLF/CR must normalize to LF; all other characters pass through');
});

test('WSL: nested bracketed-paste markers are stripped from the body', () => {
  const hostile = 'before\x1b[201~injected\x1b[200~after';
  for (const provider of ['claude', 'codex'] as const) {
    const input = buildTmuxSendInputCmd(SESSION, hostile, provider, true);
    assert.ok(input, 'expected a command');
    assert.equal(input.stdin, 'beforeinjectedafter',
      `${provider} stdin must have \\x1b[200~/\\x1b[201~ stripped`);
  }
});

test('WSL: submit chain orders paste before sleep before kitty Enter', () => {
  const input = buildTmuxSendInputCmd(SESSION, BODY, 'codex', true);
  assert.ok(input, 'expected a command');
  const paste = input.cmd.indexOf('paste-buffer');
  const sleep = input.cmd.indexOf('sleep');
  const enter = input.cmd.indexOf(TMUX_KITTY_ENTER_HEX);
  assert.ok(paste !== -1 && sleep !== -1 && enter !== -1 && paste < sleep && sleep < enter,
    `expected paste-buffer && sleep && kitty-Enter ordering; got: ${input.cmd}`);
});

test('WSL: unknown provider returns null (legacy tmuxSendKeys path)', () => {
  assert.equal(buildTmuxSendInputCmd(SESSION, BODY, 'unknown', true), null);
  // Grok is deliberately NOT a TmuxProvider: grok on WSL is refused at launch
  // (index.ts), so the tmux transport never encodes grok. The `unknown` fallback
  // is what a non-whitelisted provider collapses to here.
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

test('Windows grok submit sequence is CR (matches Claude-on-Windows, not codex/gemini Win32)', () => {
  // Source-verified: grok submits on a bare crossterm KeyCode::Enter/NONE over
  // ConPTY (grok-phase0-probe-results.md §0.1). Explicitly listed, not the CR
  // fall-through — and must equal the claude sequence, never the Win32 pair.
  assert.equal(getWindowsSubmitSequence('grok'), '\r');
  assert.equal(getWindowsSubmitSequence('grok'), getWindowsSubmitSequence('claude'));
  assert.notEqual(getWindowsSubmitSequence('grok'), getWindowsSubmitSequence('codex'));
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
