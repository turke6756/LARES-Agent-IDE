// GroupThink PRESSURE harness — deterministic fault-injection probes that drive
// runSerial/runParallel against a scripted DashboardClient fake. Companion to
// experiments/groupthink-pressure-test/PROTOCOL.md (Tier 1). Costs zero tokens.
//
// Two kinds of cases, encoded in the test name:
//
//   INVARIANT-* — behavior the runner MUST keep. A failure here means a
//                 regression was introduced. Fix the runner, not the test.
//
//   PROBE-*     — a demonstrated WEAKNESS. The assertion pins the runner's
//                 current (undesirable) behavior so it is reproducible on
//                 demand. If a PROBE fails, the weakness may have been FIXED:
//                 verify, flip the probe into an INVARIANT asserting the new
//                 behavior, and record the change in
//                 experiments/groupthink-pressure-test/findings.md.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/orchestration/groupthink-pressure.test.js
//
// The runner's sleeps are real setTimeout calls; we clamp the global to ≤2ms so
// the poll loops spin fast while Date.now()-based timeouts still measure real
// elapsed time (same trick as groupthink-v2.test.ts).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSerial, runParallel } from './groupthink-v2';
import { Agent } from '../../shared/types';
import { DashboardClient, OrchestrationRun, OrchestrationRunContext } from './types';

// ── Clamp setTimeout so 2000ms polls fire in ≤2ms ────────────────────
const realSetTimeout = global.setTimeout;
(global as any).setTimeout = ((fn: any, ms?: number, ...rest: any[]) =>
  realSetTimeout(fn, Math.min(typeof ms === 'number' ? ms : 0, 2), ...rest)) as typeof setTimeout;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => realSetTimeout(resolve, ms));
}

interface RelayMessage { content: string; ts: string; turnComplete?: boolean }

interface FakeAgent {
  id: string;
  title: string;
  provider: string;
  status: string;
  latest: RelayMessage | null;
  counter: number;
  pending: boolean;     // an armed turn that has not yet been revealed
  getCalls: number;     // getMessages calls since the last arm
  revealAt: number;     // reveal the pending turn on the Nth getMessages call
  sendCount: number;
}

interface FakeState {
  agents: Map<string, FakeAgent>;
  launchInputs: any[];
  sendInputCalls: Array<{ id: string; text: string }>;
  events: string[];
}

interface FakeConfig {
  frozen?: boolean;                                    // pending turns never materialize
  inFlight?: (id: string) => boolean;
  onTurn?: (a: FakeAgent, state: FakeState) => void;   // hook on each revealed turn
  onSend?: (a: FakeAgent, text: string, state: FakeState) => void;  // hook on each sendInput
  tsFor?: (a: FakeAgent, counter: number) => string;   // override turn timestamps
}

let agentSeq = 0;

function makeFake(cfg: FakeConfig = {}): { client: DashboardClient; state: FakeState } {
  const state: FakeState = { agents: new Map(), launchInputs: [], sendInputCalls: [], events: [] };

  const arm = (a: FakeAgent, revealAt: number) => { a.pending = true; a.getCalls = 0; a.revealAt = revealAt; };

  const reveal = (a: FakeAgent) => {
    a.counter++;
    a.latest = {
      content: `${a.title} :: turn ${a.counter}`,
      ts: cfg.tsFor ? cfg.tsFor(a, a.counter) : `${a.id}#${String(a.counter).padStart(4, '0')}`,
      turnComplete: true,
    };
    a.pending = false;
    state.events.push(`turn:${a.id}#${a.counter}`);
    cfg.onTurn?.(a, state);
  };

  const client: DashboardClient = {
    launchAgent: async (input) => {
      const id = `agent-${++agentSeq}`;
      const a: FakeAgent = {
        id, title: input.title || id, provider: String(input.provider),
        status: 'idle', latest: null, counter: 0, pending: false, getCalls: 0, revealAt: 1, sendCount: 0,
      };
      state.agents.set(id, a);
      state.launchInputs.push(input);
      state.events.push(`launch:${a.title}`);
      return { id, status: 'idle' } as unknown as Agent;
    },
    getAgent: (id) => (state.agents.get(id) as unknown as Agent) ?? null,
    getMessages: async (id) => {
      const a = state.agents.get(id);
      if (!a) return [];
      a.getCalls++;
      if (!cfg.frozen && a.pending && a.getCalls >= a.revealAt) reveal(a);
      return a.latest ? [{ ...a.latest }] : [];
    },
    sendInput: async (id, text) => {
      const a = state.agents.get(id);
      if (!a) throw new Error(`sendInput to unknown agent ${id}`);
      a.sendCount++;
      state.sendInputCalls.push({ id, text });
      // First send is the kickoff, immediately followed by the highwater seed
      // read (getCall #1) → reveal on #2. Later sends are relay feedback with
      // no intervening seed → reveal on the first poll (#1).
      const isKickoff = a.sendCount === 1;
      arm(a, isKickoff ? 2 : 1);
      cfg.onSend?.(a, text, state);
    },
    isInputInFlight: (id) => (cfg.inFlight ? cfg.inFlight(id) : false),
    stopAgent: async () => {},
  };

  return { client, state };
}

function byTitle(state: FakeState, prefix: string): FakeAgent {
  const a = Array.from(state.agents.values()).find((x) => x.title.startsWith(prefix));
  if (!a) throw new Error(`no fake agent titled ${prefix}*`);
  return a;
}

// ── Run/context fakes ────────────────────────────────────────────────

let planSeq = 0;
function freshPlanPath(): string {
  return path.join(os.tmpdir(), `gt-pressure-plan-${process.pid}-${++planSeq}.md`);
}

function makeRun(overrides: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return {
    runId: 'run-pressure',
    name: 'groupthink',
    mode: 'serial',
    status: 'running',
    workspaceId: 'ws-1',
    supervisorId: 'sup-1',
    topic: 'Plan a thing',
    planPath: freshPlanPath(),
    leadProvider: 'claude',
    reviewerProvider: 'codex',
    turnTimeoutMs: 600000,
    lastRelayedTs: {},
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface CtxBundle { ctx: OrchestrationRunContext; rounds: number[]; turns: number[]; }
function makeCtx(run: OrchestrationRun, signal?: AbortSignal): CtxBundle {
  const rounds: number[] = [];
  const turns: number[] = [];
  const ctx: OrchestrationRunContext = {
    run,
    signal: signal ?? new AbortController().signal,
    persist: () => {},
    emit: (kind, payload: any) => {
      if (kind === 'round') rounds.push(payload?.round);
      if (kind === 'turn') turns.push(payload?.turn);
    },
  };
  return { ctx, rounds, turns };
}

// ── Test harness ─────────────────────────────────────────────────────
interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

async function rejectsMatching(p: Promise<unknown>, re: RegExp): Promise<string> {
  try { await p; } catch (err: any) {
    const msg = err?.message || String(err);
    assert.match(msg, re);
    return msg;
  }
  throw new Error(`expected rejection matching ${re}`);
}

function rm(p: string): void { try { fs.unlinkSync(p); } catch { /* ignore */ } }

// ═════════════════════════════════════════════════════════════════════
// INVARIANT-T1 — a same-ts reviewer turn with NEW content is still relayed
//                (content-hash tie-break)
//
// readNextMessage used to filter `msg.ts <= lastRelayedTs[agentId]` (string
// compare), so a reviewer turn-complete carrying a ts equal to its previous one
// (observed in the 2026-06-08 B2 run log: distinct lifecycle events on the SAME
// millisecond) was filtered forever and the run died as a timeout stall. The fix
// packs a content hash into the highwater: a same-ts turn is dropped only if its
// content hash ALSO matches, so genuinely-new same-ts content is relayed.
//
// Deviation note vs. the hardening plan's literal recipe: the plan said to write
// the plan at Reviewer counter===2, but the serial loop checks existsSync(plan)
// immediately after markRelayed(reviewer) and BEFORE the feedback sendInput to
// the lead — so a synchronous write there breaks before turn-2 is relayed,
// yielding feedbackRelays===1 and contradicting the plan's own feedbackRelays===2
// assertion. The plan is instead written at Lead counter===3 (the lead's response
// to reviewer turn-2), which lets turn-2 relay first and then completes the run.
// This proves the identical fix while satisfying all three stated assertions.
// ═════════════════════════════════════════════════════════════════════
test('INVARIANT-T1 serial: a same-ts reviewer turn with new content is still relayed (content-hash tie-break)', async () => {
  const run = makeRun({ turnTimeoutMs: 150 });
  const { client, state } = makeFake({
    // Reviewer timestamps never advance; lead's are monotonic.
    tsFor: (a, counter) => a.title.startsWith('Reviewer') ? `${a.id}#FIXED` : `${a.id}#${counter}`,
    // Complete the run deterministically once reviewer turn-2 has been relayed:
    // the lead's turn-3 (its response to reviewer turn-2) writes the plan file.
    onTurn: (a) => {
      if (a.title.startsWith('Lead') && a.counter === 3) {
        fs.writeFileSync(run.planPath, 'consensus plan after reviewer turn 2');
      }
    },
  });
  const { ctx } = makeCtx(run);

  try {
    await runSerial(client, ctx);   // resolves — the same-ts turn-2 was relayed, no timeout stall

    const reviewer = byTitle(state, 'Reviewer');
    assert.equal(reviewer.counter, 2, 'reviewer produced a second (same-ts) turn');
    const feedbackRelays = state.sendInputCalls.filter((c) => /Reviewer Feedback/.test(c.text));
    assert.equal(feedbackRelays.length, 2, 'both reviewer turns were relayed to the lead');
    assert.ok(state.sendInputCalls.some((c) => /Reviewer.*turn 2/.test(c.text)),
      'reviewer turn-2 content (same ts, new content) IS relayed — the tie-break fix');
  } finally {
    rm(run.planPath);
  }
});

// ═════════════════════════════════════════════════════════════════════
// INVARIANT-T2 — a stale pre-existing plan file is archived at start, and the
//                run deliberates instead of completing on it
//
// start_run/runSerial used to treat a leftover plan file at planPath as "plan
// written → done" after the lead's turn-1, completing the run with zero
// deliberation on the OLD file. The fix archives any pre-existing planPath at the
// start of a fresh run (rename to `${planPath}.stale-<runId>-<ts>.bak`), so the
// existsSync gate sees no file, the reviewer launches, and the run completes only
// on a freshly-written plan. (makeRun sets runId: 'run-pressure'.)
// ═════════════════════════════════════════════════════════════════════
test('INVARIANT-T2 serial: a stale pre-existing plan is archived at start and the run deliberates instead of completing on it', async () => {
  const run = makeRun();
  fs.writeFileSync(run.planPath, 'STALE CONTENT from a previous run');
  const { client, state } = makeFake({
    // Once the reviewer takes its first turn, write a FRESH plan so the run
    // completes via the normal relay-loop existsSync gate (not the stale file).
    onTurn: (a) => {
      if (a.title.startsWith('Reviewer') && a.counter === 1) {
        fs.writeFileSync(run.planPath, 'FRESH consensus plan');
      }
    },
  });
  const { ctx } = makeCtx(run);

  const dir = path.dirname(run.planPath);
  const base = path.basename(run.planPath);
  const findBak = (): string | undefined =>
    fs.readdirSync(dir).find((f) => f.startsWith(`${base}.stale-run-pressure-`) && f.endsWith('.bak'));

  try {
    await runSerial(client, ctx);   // resolves on the FRESH plan, not the stale file

    assert.equal(state.launchInputs.length, 2, 'reviewer WAS launched → deliberation happened');
    assert.notEqual(fs.readFileSync(run.planPath, 'utf8'), 'STALE CONTENT from a previous run',
      'the deliverable is the fresh plan, not the archived stale file');

    const bak = findBak();
    assert.ok(bak, 'the stale plan was archived to a .stale-run-pressure-*.bak sibling');
    assert.equal(fs.readFileSync(path.join(dir, bak!), 'utf8'), 'STALE CONTENT from a previous run',
      'the archived sibling holds the original stale content (non-destructive rename)');
  } finally {
    rm(run.planPath);
    const bak = findBak();
    if (bak) rm(path.join(dir, bak));
  }
});

// ═════════════════════════════════════════════════════════════════════
// PROBE-T3 — liveness hole: status stuck 'working' resets the stall clock
//            forever; abort is the only exit
//
// waitTurnComplete extends stallDeadline whenever agent.status === 'working'.
// That is by design (codex turns can legitimately exceed the timeout) but it
// means a PTY wedged in 'working' with no message stream produces an UNBOUNDED
// wait — no stall event ever fires and the run hangs silently until aborted.
// Hardening candidate: a hard wall-clock cap (e.g. 6× turnTimeoutMs) that
// stalls with reason 'working_no_output' instead of looping forever.
// ═════════════════════════════════════════════════════════════════════
test('PROBE-T3 serial: lead stuck status=working with no output outlives 12× the stall timeout; only abort ends it', async () => {
  const run = makeRun({ turnTimeoutMs: 100 });
  const { client } = makeFake({
    frozen: true,                                  // no turn ever materializes
    onSend: (a) => { a.status = 'working'; },      // kickoff flips it to working forever
  });
  const controller = new AbortController();
  const { ctx } = makeCtx(run, controller.signal);

  const started = Date.now();
  let settled = false;
  const p = runSerial(client, ctx).then(
    () => { settled = true; },
    (err) => { settled = true; return Promise.reject(err); },
  );

  await realSleep(1200);   // 12× turnTimeoutMs
  assert.equal(settled, false,
    'runner is still waiting — no stall fired despite 12× the timeout (the weakness this probe pins)');

  controller.abort();
  await rejectsMatching(p, /Orchestration run aborted/);
  assert.ok(Date.now() - started >= 1200, 'survived the whole observation window');
});

// ═════════════════════════════════════════════════════════════════════
// INVARIANT-T4 — a plan written shortly after the R3 turn-complete is detected
//                within the grace window (no false stall)
//
// The synthesizer's plan-file Write tool-call flush trails its R3 turn-complete
// chat event by a sub-second window (observed live 2026-06-08 B2, 2026-06-11
// d9a423ac). The runner used to check fs.existsSync(planPath) immediately after
// the R3 turn-complete and throw a false 'no_plan_written' STALL while the
// deliverable landed moments later. The fix polls planPath for a bounded grace
// window (PLAN_WRITE_GRACE_MS) before declaring the stall — so a plan written
// 60ms after the turn-complete is detected well inside the window.
// (The clamped setTimeout keeps polls at ~2ms while Date.now() measures real
// elapsed time, so the 30s grace is never actually waited out here.)
// ═════════════════════════════════════════════════════════════════════
test('INVARIANT-T4 parallel: a plan written shortly after the R3 turn-complete is detected within the grace window (no false stall)', async () => {
  const run = makeRun({ mode: 'parallel' });
  const { client } = makeFake({
    onTurn: (a) => {
      if (a.title.startsWith('Synthesizer') && a.counter === 3) {
        // The write happens AFTER the turn-complete — 60ms later, like a real
        // synthesizer whose Write tool-call follows its analysis message.
        realSetTimeout(() => { try { fs.writeFileSync(run.planPath, 'late but fine'); } catch { /* ignore */ } }, 60);
      }
    },
  });
  const { ctx } = makeCtx(run);

  try {
    await runParallel(client, ctx);   // resolves — the grace poll finds the file ~60ms in
    assert.ok(fs.existsSync(run.planPath),
      'the plan landed shortly after the R3 turn-complete and the grace poll detected it (no false stall)');
  } finally {
    rm(run.planPath);
  }
});

// ═════════════════════════════════════════════════════════════════════
// INVARIANT-T5 — a crashed receiver mid-relay must fail fast and clearly
// (waitReceiverReady's crashed/done bail). Note: the service classifies this
// as 'error', not 'stalled' — the message contains neither STALL nor Timeout.
// ═════════════════════════════════════════════════════════════════════
test('INVARIANT-T5 serial: lead crashing before it can accept the relay throws exited-with-status', async () => {
  const run = makeRun({ turnTimeoutMs: 150 });
  const { client, state } = makeFake({
    onTurn: (a, st) => {
      if (a.title.startsWith('Reviewer') && a.counter === 1) {
        byTitle(st, 'Lead').status = 'crashed';
      }
    },
  });
  const { ctx } = makeCtx(run);

  try {
    const msg = await rejectsMatching(runSerial(client, ctx), /status=crashed before accepting relay/);
    assert.ok(!msg.startsWith('STALL') && !msg.includes('Timeout'),
      'crash message classifies as error (not stall) under service.ts string-matching');
    assert.ok(!state.sendInputCalls.some((c) => /Reviewer Feedback/.test(c.text)),
      'no relay was attempted into the crashed lead');
  } finally {
    rm(run.planPath);
  }
});

// ═════════════════════════════════════════════════════════════════════
// INVARIANT-T6 — serial: a plan written during lead turn-1 terminates the run
// BEFORE the reviewer is launched (premature-write containment). This is the
// same fs.existsSync gate that PROBE-T2 shows is a footgun for stale files —
// if you harden T2, keep this passing.
// ═════════════════════════════════════════════════════════════════════
test('INVARIANT-T6 serial: plan written on lead turn-1 ends the run with no reviewer launch', async () => {
  const run = makeRun();
  const { client, state } = makeFake({
    onTurn: (a) => { if (a.title.startsWith('Lead') && a.counter === 1) fs.writeFileSync(run.planPath, 'early plan'); },
  });
  const { ctx, turns } = makeCtx(run);

  try {
    await runSerial(client, ctx);
    assert.equal(state.launchInputs.length, 1, 'reviewer never launched');
    assert.deepEqual(turns, [1], 'terminated at turn 1');
    assert.equal(state.sendInputCalls.length, 1, 'only the lead kickoff was ever sent');
  } finally {
    rm(run.planPath);
  }
});

// ═════════════════════════════════════════════════════════════════════
// INVARIANT-T7 — abort must interrupt a mid-poll wait promptly
// (checkAborted runs every poll iteration; the service relies on this for
// abort_orchestration and for shutdown).
// ═════════════════════════════════════════════════════════════════════
test('INVARIANT-T7 serial: aborting mid-wait rejects with AbortError well before any timeout', async () => {
  const run = makeRun({ turnTimeoutMs: 600000 });
  const { client } = makeFake({ frozen: true });
  const controller = new AbortController();
  const { ctx } = makeCtx(run, controller.signal);

  const started = Date.now();
  const p = runSerial(client, ctx);
  realSetTimeout(() => controller.abort(), 50);

  await rejectsMatching(p, /Orchestration run aborted/);
  assert.ok(Date.now() - started < 2000, 'abort took effect promptly');
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
  const failedProbes: string[] = [];
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
      if (t.name.startsWith('PROBE-')) failedProbes.push(t.name);
    }
  }
  if (failedProbes.length) {
    console.log('\nNOTE: failing PROBE-* cases may mean a known weakness was FIXED, not that the');
    console.log('runner regressed. Verify the new behavior, flip the probe to an INVARIANT, and');
    console.log('record it in experiments/groupthink-pressure-test/findings.md:');
    for (const n of failedProbes) console.log(`  - ${n}`);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
