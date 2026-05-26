// BUG-22 Step 1: verify tmuxNewSession returns structured success/failure
// data instead of throw-or-void. The diagnostic pipeline depends on the
// caller (WslRunner.launch) being able to inspect exitCode + stderr + the
// rendered outer tmux command without catching exceptions.
//
// The bridge's tmuxNewSession accepts an injectable exec function so this
// test can stub wslExec without spawning wsl.exe.
//
// Run via:
//   npm run build:main
//   node dist/main/main/supervisor/wsl-bridge-tmux-new-session.test.js

import assert from 'node:assert/strict';
import {
  buildTmuxNewSessionCommand,
  tmuxNewSession,
  WslExecResult,
} from '../wsl-bridge';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

function fakeExec(result: WslExecResult): (cmd: string, timeout: number) => Promise<WslExecResult> {
  return async () => result;
}

test('BUG-22: success returns ok:true with exit code 0 and renders tmuxCommand', async () => {
  const calls: { cmd: string; timeout: number }[] = [];
  const exec = async (cmd: string, timeout: number): Promise<WslExecResult> => {
    calls.push({ cmd, timeout });
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const result = await tmuxNewSession('cad__sup__abc', '/home/u/proj', 'claude --foo', exec);
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, '');
  // tmuxCommand should be the rendered outer `tmux new-session ...` envelope
  // — same shape `buildTmuxNewSessionCommand` would produce, captured for
  // diagnostic logging.
  const expectedCmd = buildTmuxNewSessionCommand('cad__sup__abc', '/home/u/proj', 'claude --foo');
  assert.equal(result.tmuxCommand, expectedCmd);
  // exec must be called with the rendered tmuxCommand and a sensible timeout.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, expectedCmd);
  assert.ok(calls[0].timeout > 0, 'timeout passed through to exec');
});

test('BUG-22: non-zero exit returns ok:false with stderr (does not throw)', async () => {
  const exec = fakeExec({
    stdout: '',
    stderr: 'tmux: bash: syntax error near unexpected token `)\'',
    exitCode: 1,
  });
  let threw: unknown = null;
  let result: Awaited<ReturnType<typeof tmuxNewSession>> | null = null;
  try {
    result = await tmuxNewSession('s', '/wd', 'echo hi', exec);
  } catch (err) {
    threw = err;
  }
  assert.equal(threw, null, 'must NOT throw on non-zero exit — the caller needs structured data');
  assert.ok(result, 'must return a structured result');
  assert.equal(result!.ok, false);
  assert.equal(result!.exitCode, 1);
  assert.match(result!.stderr, /syntax error/);
});

test('BUG-22: tmuxCommand is populated even on failure (for post-mortem)', async () => {
  const exec = fakeExec({ stdout: '', stderr: 'boom', exitCode: 2 });
  const result = await tmuxNewSession('s', '/wd', 'echo hi', exec);
  assert.equal(result.ok, false);
  // The whole point of the diagnostic: tmuxCommand must be captured so
  // post-mortems can see the exact outer command the bridge handed to wsl.exe.
  assert.match(result.tmuxCommand, /^setsid tmux new-session -d -s 's' -c '\/wd' -- bash -lic /);
  assert.match(result.tmuxCommand, /\| base64 -d\)"$/);
});

test('BUG-22: non-zero exit with empty stderr still returns structured shape', async () => {
  // Edge case — tmux can exit non-zero with nothing on stderr (e.g. signaled).
  // The diagnostic still needs the exit code; stderr is just empty data.
  const exec = fakeExec({ stdout: '', stderr: '', exitCode: 137 });
  const result = await tmuxNewSession('s', '/wd', 'cmd', exec);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 137);
  assert.equal(result.stderr, '');
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
