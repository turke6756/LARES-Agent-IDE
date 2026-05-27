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
  tmuxWaitForSession,
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

// ── BUG-22 Step 2: tmuxWaitForSession ─────────────────────────────────────

test('BUG-22 Step 2: wait returns ok:true on first poll when session is already registered', async () => {
  const calls: string[] = [];
  const exec = async (cmd: string, _timeout: number): Promise<WslExecResult> => {
    calls.push(cmd);
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  let nowVal = 1000;
  const now = () => nowVal;
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => { sleeps.push(ms); nowVal += ms; };

  const result = await tmuxWaitForSession('cad__sup__abc', 2000, exec, sleep, now);
  assert.equal(result.ok, true);
  assert.equal(result.waitedMs, 0, 'first-poll success must report ~0ms waited');
  assert.equal(calls.length, 1, 'first-poll success must not retry');
  assert.equal(sleeps.length, 0, 'first-poll success must not sleep');
  assert.match(calls[0], /tmux has-session -t 'cad__sup__abc'/);
});

test('BUG-22 Step 2: wait returns ok:true once exec stub flips exit_code to 0', async () => {
  // Simulate the race: first two polls return exit 1 (session not yet
  // queryable), the third returns 0. The function must return ok:true with
  // a waitedMs that reflects the two ~20ms intervals.
  let pollCount = 0;
  const exec = async (_cmd: string, _timeout: number): Promise<WslExecResult> => {
    pollCount += 1;
    if (pollCount < 3) {
      return { stdout: '', stderr: `can't find session: cad__sup__abc`, exitCode: 1 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  let nowVal = 5000;
  const now = () => nowVal;
  const sleeps: number[] = [];
  const sleep = async (ms: number): Promise<void> => { sleeps.push(ms); nowVal += ms; };

  const result = await tmuxWaitForSession('cad__sup__abc', 2000, exec, sleep, now);
  assert.equal(result.ok, true);
  assert.equal(pollCount, 3, 'must poll until exit_code flips to 0');
  assert.equal(sleeps.length, 2, 'two sleeps between three polls');
  assert.deepEqual(sleeps, [20, 20], 'poll cadence should be ~20ms');
  assert.equal(result.waitedMs, 40, 'waitedMs reflects elapsed sleeps');
});

test('BUG-22 Step 2: wait returns ok:false after timeout when session never registers', async () => {
  let pollCount = 0;
  const exec = async (_cmd: string, _timeout: number): Promise<WslExecResult> => {
    pollCount += 1;
    return { stdout: '', stderr: `can't find session: cad__sup__abc`, exitCode: 1 };
  };
  let nowVal = 0;
  const now = () => nowVal;
  const sleep = async (ms: number): Promise<void> => { nowVal += ms; };

  const result = await tmuxWaitForSession('cad__sup__abc', 100, exec, sleep, now);
  assert.equal(result.ok, false);
  assert.ok(result.waitedMs >= 100, `waitedMs must be >= timeout; got ${result.waitedMs}`);
  assert.ok(pollCount >= 2, `must poll at least twice before timing out; got ${pollCount}`);
  assert.match(result.lastError ?? '', /can't find session/);
});

test('BUG-22 Step 2: wait never throws (stays on the structured-result contract)', async () => {
  // wslExec itself never throws, but defend the wait function's signature so
  // callers (WslRunner.launch) can rely on `{ok, waitedMs}` without try/catch.
  const exec = async (_cmd: string, _timeout: number): Promise<WslExecResult> => {
    return { stdout: '', stderr: 'wsl unavailable', exitCode: 1 };
  };
  let nowVal = 0;
  const now = () => nowVal;
  const sleep = async (ms: number): Promise<void> => { nowVal += ms; };

  let threw: unknown = null;
  let result: Awaited<ReturnType<typeof tmuxWaitForSession>> | null = null;
  try {
    result = await tmuxWaitForSession('s', 50, exec, sleep, now);
  } catch (err) {
    threw = err;
  }
  assert.equal(threw, null, 'wait must never throw');
  assert.ok(result);
  assert.equal(result!.ok, false);
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
