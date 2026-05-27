// BUG-22 Step 3: cover the silent-reconnect path in WslRunner that absorbs
// phantom `wsl.exe tmux attach` exits while the tmux session is still alive.
// We exercise `_handleHostExit` directly through a small `TestRunner`
// subclass that overrides the two side-effect seams (respawn + JSONL write)
// and feeds in a deterministic `isTmuxSessionAlive` + clock.
//
// Run via:
//   npm run build:main
//   node dist/main/main/supervisor/wsl-runner-phantom-reconnect.test.js

import assert from 'node:assert/strict';
import { WslRunner } from './wsl-runner';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

/** Minimal subclass that:
 *  - skips the real `spawnPtyHost` (no Node process spawn) by overriding the
 *    `respawnForPhantomExit` seam — just records call count instead.
 *  - skips the real `writeLaunchRecord` (no filesystem) by overriding it —
 *    records every call so tests can assert the silent path doesn't fire it.
 *
 *  Casts where needed so tests can poke private state without exposing it on
 *  the production class. We also need `_handleHostExit` (private) and
 *  `_alive` reachable; both are exercised via `(runner as any)`.
 */
class TestRunner extends WslRunner {
  respawnCalls = 0;
  writeLaunchRecordCalls: Array<{ exitCode: number | null; signal: string | null }> = [];

  protected respawnForPhantomExit(): void {
    this.respawnCalls++;
  }

  protected writeLaunchRecord(exitCode: number | null, signal: string | null): void {
    this.writeLaunchRecordCalls.push({ exitCode, signal });
  }
}

interface ExitEvent { code: number; signal: string | null; }

function makeRunner(opts: {
  tmuxAlive: boolean | (() => boolean);
  now?: () => number;
}): { runner: TestRunner; exits: ExitEvent[] } {
  const tmuxAliveFn = typeof opts.tmuxAlive === 'function'
    ? opts.tmuxAlive
    : () => opts.tmuxAlive as boolean;
  const runner = new TestRunner('cad__test__abc', {
    isTmuxSessionAlive: async (_name: string) => tmuxAliveFn(),
    now: opts.now,
  });
  // Prime the runner into "launched" state without actually spawning anything.
  // `_alive` gates entry to `_handleHostExit`; `_logPath` is what
  // `respawnForPhantomExit` would pass through to `spawnPtyHost`.
  (runner as any)._alive = true;
  (runner as any)._logPath = '/tmp/fake.log';
  const exits: ExitEvent[] = [];
  runner.on('exit', (code: number, signal: string | null) => {
    exits.push({ code, signal });
  });
  return { runner, exits };
}

async function callHandleHostExit(
  runner: TestRunner,
  exitCode: number | null,
  signal: string | null,
  source: 'host' | 'inner-pty',
): Promise<void> {
  await (runner as any)._handleHostExit(exitCode, signal, source);
}

// ── Test 1: phantom-reconnect path ───────────────────────────────────────

test('BUG-22 Step 3: phantom inner-PTY exit (code 0, tmux alive) silently reconnects', async () => {
  const { runner, exits } = makeRunner({ tmuxAlive: true });

  await callHandleHostExit(runner, 0, null, 'inner-pty');

  assert.equal(runner.respawnCalls, 1, 'respawnForPhantomExit must fire exactly once');
  assert.equal(exits.length, 0, "no `exit` event must be emitted on silent reconnect");
  assert.equal(
    runner.writeLaunchRecordCalls.length, 0,
    'writeLaunchRecord must NOT fire on silent reconnect (no JSONL noise)',
  );
  // _alive stays true so consumers see the agent as still running through
  // the brief reconnect gap.
  assert.equal((runner as any)._alive, true, '_alive must remain true on silent reconnect');
});

test('BUG-22 Step 3: phantom host-process exit (code 1, tmux alive) silently reconnects too', async () => {
  // Same code path but driven from the host-process `.on("exit")` side —
  // covers the case where the host process dies before sending an `exit`
  // message (e.g. wsl.exe terminated externally) while tmux survives.
  const { runner, exits } = makeRunner({ tmuxAlive: true });

  await callHandleHostExit(runner, 1, null, 'host');

  assert.equal(runner.respawnCalls, 1);
  assert.equal(exits.length, 0);
  assert.equal(runner.writeLaunchRecordCalls.length, 0);
});

// ── Test 2: true-crash path ─────────────────────────────────────────────

test('BUG-22 Step 3: true crash (exit 1, tmux dead) emits exit + writes JSONL with real code', async () => {
  const { runner, exits } = makeRunner({ tmuxAlive: false });

  await callHandleHostExit(runner, 1, null, 'inner-pty');

  assert.equal(runner.respawnCalls, 0, 'no silent reconnect when tmux is dead');
  assert.equal(exits.length, 1, 'exactly one `exit` event must fire');
  assert.equal(exits[0].code, 1, 'exit code must pass through unmangled — no `|| 137` disguise');
  assert.equal(
    runner.writeLaunchRecordCalls.length, 1,
    'writeLaunchRecord must fire exactly once on a real crash',
  );
  assert.equal(runner.writeLaunchRecordCalls[0].exitCode, 1);
  assert.equal((runner as any)._alive, false, '_alive must flip to false on real teardown');
});

test('BUG-22 Step 3: clean exit (code 0) with tmux dead also surfaces as real exit (no 137 disguise)', async () => {
  // Confirms the coercion strip: a legitimately clean exit (rare for an
  // agent process, but possible if the user types /exit and the pane closes
  // cleanly) now reports `0` instead of being remapped to 137 by the prior
  // `((code ?? 1) || 137)` expression. The dashboard reads code 0 as 'done',
  // which is correct here because tmux is also gone.
  const { runner, exits } = makeRunner({ tmuxAlive: false });

  await callHandleHostExit(runner, 0, null, 'inner-pty');

  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 0, 'clean exit must report code 0, not 137');
});

// ── Test 3: intentional-kill path ───────────────────────────────────────

test('BUG-22 Step 3: intentional kill reports code 0 even if tmux is somehow still alive', async () => {
  // The supervisor sets `_intentionalKill` before tearing down; the
  // silent-reconnect check must be skipped (we don't want to keep an
  // intentionally-killed agent alive) and the emitted code must be 0 to
  // preserve the existing "clean stop" semantics.
  const { runner, exits } = makeRunner({ tmuxAlive: true });
  (runner as any)._intentionalKill = true;

  await callHandleHostExit(runner, 137, 'SIGKILL', 'inner-pty');

  assert.equal(runner.respawnCalls, 0, 'intentional kill must NOT silently reconnect');
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 0, 'intentional kill reports code 0');
  assert.equal(runner.writeLaunchRecordCalls.length, 1);
});

// ── Test 4: reconnect-loop bound ────────────────────────────────────────

test('BUG-22 Step 3: 4 phantom exits within 1s — first 3 reconnect, 4th falls through to crash', async () => {
  // The cap protects against an infinite spin if tmux is alive but the
  // attach is reliably terminating. After MAX_PHANTOM_RECONNECTS_PER_MIN
  // (=3) reconnects inside the rolling 60s window, the next phantom exit
  // must emit a real `exit` instead.
  let tNow = 1_000_000_000_000; // some plausible epoch ms
  const { runner, exits } = makeRunner({
    tmuxAlive: true,
    now: () => tNow,
  });

  // Three phantom exits, spaced 100ms apart — all under the cap → all reconnect.
  for (let i = 0; i < 3; i++) {
    await callHandleHostExit(runner, 0, null, 'inner-pty');
    tNow += 100;
  }
  assert.equal(runner.respawnCalls, 3, 'first 3 phantoms must all silently reconnect');
  assert.equal(exits.length, 0, 'no exit emitted while under the cap');
  assert.equal(runner.writeLaunchRecordCalls.length, 0);

  // 4th phantom inside the same 60s window → cap hit → real crash emit.
  await callHandleHostExit(runner, 0, null, 'inner-pty');
  assert.equal(runner.respawnCalls, 3, '4th phantom must NOT trigger another respawn');
  assert.equal(exits.length, 1, '4th phantom must emit a real exit event');
  assert.equal(exits[0].code, 0, 'the real exit carries the actual exit code');
  assert.equal(runner.writeLaunchRecordCalls.length, 1);
});

test('BUG-22 Step 3: rolling window forgets reconnects older than 60s', async () => {
  // Three phantoms back-to-back, then advance the clock past the 60s
  // window, then a fourth — should still reconnect because the first three
  // have aged out of the rolling window.
  let tNow = 1_000_000_000_000;
  const { runner, exits } = makeRunner({
    tmuxAlive: true,
    now: () => tNow,
  });

  for (let i = 0; i < 3; i++) {
    await callHandleHostExit(runner, 0, null, 'inner-pty');
    tNow += 100;
  }
  assert.equal(runner.respawnCalls, 3);

  // Advance past the 60s rolling window.
  tNow += 60_001;

  await callHandleHostExit(runner, 0, null, 'inner-pty');
  assert.equal(runner.respawnCalls, 4, 'old reconnects must age out of the window');
  assert.equal(exits.length, 0, 'still no exit emitted — the older entries no longer count');
});

// ── Test 5: state guard — double exit doesn't double-emit ───────────────

test('BUG-22 Step 3: after a real crash, a second exit call is a no-op (no duplicate emit)', async () => {
  // The host-process exit and inner-PTY 'exit' message can both fire for the
  // same launch (host script exits after sending the inner-PTY exit). The
  // earlier handler tears down, the later one must see `_alive=false` and
  // bail without re-emitting.
  const { runner, exits } = makeRunner({ tmuxAlive: false });

  await callHandleHostExit(runner, 1, null, 'inner-pty');
  await callHandleHostExit(runner, 1, null, 'host');

  assert.equal(exits.length, 1, 'second handler call must NOT emit a duplicate exit');
  assert.equal(runner.writeLaunchRecordCalls.length, 1, 'writeLaunchRecord must remain single-fire');
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
