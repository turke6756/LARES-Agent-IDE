// Tests for `buildTmuxAttachCmd` (src/main/wsl-bridge.ts).
//
// Guards the first-launch race fix documented in
// plans/bug-supervisor-wsl-launch-investigation.md (Bug B): the attach command
// the WslRunner PTY runs MUST poll `tmux has-session` before invoking
// `tmux attach`, so a fresh-launch attach that arrives before the session is
// fully registered self-heals instead of exiting 1 with `can't find session`.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/wsl-attach-cmd.test.js

import assert from 'node:assert/strict';
import { buildTmuxAttachCmd } from '../wsl-bridge';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

const SESSION = 'cad__claude_test_worker__07f27b98';

test('attach cmd polls tmux has-session before attaching', () => {
  const cmd = buildTmuxAttachCmd(SESSION);
  // The whole point of the fix: a `has-session` guard must precede `attach`.
  const hasIdx = cmd.indexOf(`tmux has-session -t '${SESSION}'`);
  const attachIdx = cmd.indexOf(`tmux attach -t '${SESSION}'`);
  assert.ok(hasIdx >= 0, `expected 'tmux has-session -t' in cmd; got: ${cmd}`);
  assert.ok(attachIdx >= 0, `expected 'tmux attach -t' in cmd; got: ${cmd}`);
  assert.ok(
    hasIdx < attachIdx,
    `'tmux has-session' must precede 'tmux attach'; got: ${cmd}`,
  );
});

test('attach cmd bounded poll (no infinite loop)', () => {
  const cmd = buildTmuxAttachCmd(SESSION);
  // A finite literal list keeps the loop bounded and avoids `$(seq ...)`.
  // In the Windows node-pty -> wsl.exe path, command substitution can be
  // expanded before the final `bash -lc` sees the command string, turning
  // `$(seq 1 30)` into newline-separated tokens and crashing with:
  // `bash: -c: line 2: syntax error near unexpected token '2'`.
  assert.ok(/for i in 1 2 3/.test(cmd), `expected bounded literal poll list; got: ${cmd}`);
  assert.ok(!cmd.includes('while true'), `attach cmd must not loop forever; got: ${cmd}`);
  assert.ok(!cmd.includes('$('), `attach cmd must avoid command substitution in PTY path; got: ${cmd}`);
});

test('attach cmd falls through to tmux attach on poll timeout', () => {
  const cmd = buildTmuxAttachCmd(SESSION);
  // If the session genuinely never appears (pane process died inside the
  // wrap before the dashboard ever attached — see investigation candidates
  // 2/3), the attach must still run so the dashboard sees a clean exit-1
  // crash. That means the loop and the attach are joined with `;` (always
  // run attach) rather than `&&` (only run attach if loop succeeded).
  const beforeAttach = cmd.split(`tmux attach -t '${SESSION}'`)[0];
  assert.ok(
    beforeAttach.trimEnd().endsWith(';'),
    `loop must be joined to attach with ';', not '&&', so a timed-out poll ` +
    `still attempts the attach and surfaces a clean exit-1; got: ${cmd}`,
  );
});

test('attach cmd quotes session name in single quotes', () => {
  // Sanity: both invocations of the session name should be single-quoted so
  // shell metacharacters in the name (we hex/underscore-sanitize when
  // generating, but defense in depth) don't get expanded.
  const cmd = buildTmuxAttachCmd(SESSION);
  const hasCount = (cmd.match(new RegExp(`'${SESSION}'`, 'g')) || []).length;
  assert.equal(
    hasCount,
    2,
    `session name should be single-quoted in both has-session and attach calls; got: ${cmd}`,
  );
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
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
})();
