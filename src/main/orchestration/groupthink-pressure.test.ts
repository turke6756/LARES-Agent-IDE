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
import { DashboardClient, OrchestrationRun, OrchestrationRunContext, SubmitRecoveryPolicy } from './types';

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
  // HEALTHY-but-slow model (F-F): the Enter landed and the turn genuinely
  // started, but it only becomes OBSERVABLE once real wall-clock passes this
  // absolute Date.now() value. null when not in slow mode. getMessages reveals it
  // by real time (not by getCalls), so the recovery windows race REAL elapsed.
  slowArmAt: number | null;
  // WP1/BUG-37 chat-blackout: true once recoverChatBinding(id) has rebound the
  // reader. The chatBlackout predicate may consult this to model a RECOVERABLE
  // blackout (clears on rebind) vs a PERMANENT one (ignores it).
  chatBound: boolean;
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
  // --- Dropped-submit fault knobs (EXPERIMENT) ---
  /** Simulate a dropped Enter: the body is delivered but no turn arms. Honored by
   *  BOTH paths — raw sendInput (V0: bug reproduces) and sendInputConfirmed
   *  (V1/V2: returns {confirmed:false, mode:'unconfirmed'}, recovery decides). */
  dropSubmit?: (a: FakeAgent, text: string) => boolean;
  /** Simulate a hard delivery failure (no runner accepted the bytes). */
  throwSend?: (a: FakeAgent, text: string) => Error | null;
  /** Model a re-press that ALSO fails to submit (a dead prompt): resubmitEnter
   *  records the event but does NOT arm the turn. F-B / F-E. */
  deadResubmit?: (a: FakeAgent) => boolean;
  /** HEALTHY-but-slow (F-F): the Enter landed; the turn arms after the returned
   *  real-ms delay D. null ⇒ this send is not slow. */
  slowArm?: (a: FakeAgent, text: string) => number | null;
  /** Fake handshake watch window (models the dashboard's HANDSHAKE_CONFIRM_WINDOW_MS):
   *  a slow turn that surfaces within this real-ms window is caught inside
   *  sendInputConfirmed → confirmed, no re-press. Default 0. */
  handshakeMs?: number;
  /** WP1/BUG-37 chat-blackout fault: while this returns true for an agent, its
   *  getMessages returns [] even though the turn may be complete on disk (the
   *  codex lost-discovery-race signature). A RECOVERABLE blackout returns
   *  `!a.chatBound` so waitTurnComplete's deadline recoverChatBinding clears it; a
   *  PERMANENT one ignores chatBound so recovery reveals nothing and the run
   *  still times out. */
  chatBlackout?: (a: FakeAgent) => boolean;
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
    a.slowArmAt = null;
    state.events.push(`turn:${a.id}#${a.counter}`);
    cfg.onTurn?.(a, state);
  };

  const client: DashboardClient = {
    launchAgent: async (input) => {
      const id = `agent-${++agentSeq}`;
      const a: FakeAgent = {
        id, title: input.title || id, provider: String(input.provider),
        status: 'idle', latest: null, counter: 0, pending: false, getCalls: 0, revealAt: 1, sendCount: 0,
        slowArmAt: null, chatBound: false,
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
      if (!cfg.frozen) {
        if (a.slowArmAt != null) {
          // HEALTHY-but-slow: reveal strictly by REAL elapsed wall-clock so the
          // recovery windows race actual time, not poll count.
          if (Date.now() >= a.slowArmAt) reveal(a);
        } else if (a.pending && a.getCalls >= a.revealAt) {
          reveal(a);
        }
      }
      // WP1/BUG-37: the turn may be complete on disk (a.latest set) yet invisible
      // until the codex sid is rebound. Gate AFTER reveal so "completed on disk"
      // and "readable" are decoupled — exactly the blackout the runner recovers.
      if (cfg.chatBlackout?.(a)) return [];
      return a.latest ? [{ ...a.latest }] : [];
    },
    sendInput: async (id, text) => {
      const a = state.agents.get(id);
      if (!a) throw new Error(`sendInput to unknown agent ${id}`);
      a.sendCount++;
      state.sendInputCalls.push({ id, text });
      const rawErr = cfg.throwSend?.(a, text);
      if (rawErr) throw rawErr;   // V0 has no relaunch — a hard failure crashes the run
      // RAW path (V0 / default policy). A dropped Enter arms NOTHING — there is no
      // recovery, so the next waitTurnComplete polls to turnTimeoutMs: the
      // reproduced codex-kickoff bug.
      if (cfg.dropSubmit?.(a, text)) { cfg.onSend?.(a, text, state); return; }
      // First send is the kickoff, immediately followed by the highwater seed
      // read (getCall #1) → reveal on #2. Later sends are relay feedback with
      // no intervening seed → reveal on the first poll (#1).
      const isKickoff = a.sendCount === 1;
      arm(a, isKickoff ? 2 : 1);
      cfg.onSend?.(a, text, state);
    },
    // --- Confirmed-handshake seam (V1/V2) ---
    sendInputConfirmed: async (id, text) => {
      const a = state.agents.get(id);
      if (!a) throw new Error(`sendInputConfirmed to unknown agent ${id}`);
      a.sendCount++;
      state.sendInputCalls.push({ id, text });
      const e = cfg.throwSend?.(a, text);
      if (e) throw e;                                   // F-C: hard delivery failure
      const d = cfg.slowArm?.(a, text) ?? null;
      if (d != null) {
        // HEALTHY-but-slow (F-F): the Enter landed; the turn arms after D real ms.
        a.pending = true;
        a.slowArmAt = Date.now() + d;
        const hsDeadline = Date.now() + (cfg.handshakeMs ?? 0);
        while (Date.now() < hsDeadline) {
          if (Date.now() >= a.slowArmAt) { reveal(a); return { delivered: true, confirmed: true, mode: 'status-poll' as const }; }
          await realSleep(1);
        }
        return { delivered: true, confirmed: false, mode: 'unconfirmed' as const };
      }
      if (cfg.dropSubmit?.(a, text)) {
        // Dropped Enter: prompt typed but unsubmitted — NO turn armed.
        return { delivered: true, confirmed: false, mode: 'unconfirmed' as const };
      }
      // Seed read already happened pre-send (§4c) → reveal on the first poll.
      arm(a, 1);
      cfg.onSend?.(a, text, state);
      return { delivered: true, confirmed: true, mode: 'hook' as const };
    },
    resubmitEnter: (id) => {
      const a = state.agents.get(id);
      if (!a) return;
      state.events.push(`resubmit:${id}`);
      if (a.slowArmAt != null) return;          // HEALTHY-slow: turn already scheduled — a spurious no-op re-press
      if (cfg.deadResubmit?.(a)) return;        // dead prompt: the re-press also fails to submit
      // The re-press lands: arm the turn the dropped Enter failed to start.
      if (!a.pending) arm(a, 1);
    },
    recoverChatBinding: (id) => {
      const a = state.agents.get(id);
      if (!a) return;
      state.events.push(`recover:${id}`);
      a.chatBound = true;   // clears a RECOVERABLE blackout; permanent ones ignore it
    },
    isInputInFlight: (id) => (cfg.inFlight ? cfg.inFlight(id) : false),
    stopAgent: async () => {},
    sectionChangedSince: () => false,   // WP6: pressure harness runs legacy fresh-file path
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
    // WP1/BUG-37: scale the deadline chat-binding re-poll window to ms (same role
    // as submitRecoveryWindow) so the many stall-to-timeout probes here don't each
    // pay the production RECOVERY_REPOLL_MS (15s real). Individual cases override.
    recoveryRepollMs: 50,
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

// ═════════════════════════════════════════════════════════════════════
// WP1 (BUG-37) — the codex chat-blackout belt-and-suspenders. When the codex
// Reviewer is idle at the stall deadline with a blacked-out chat (lost discovery
// race: turn complete on disk, reader never sid-bound), waitTurnComplete fires a
// one-shot recoverChatBinding + bounded re-poll before conceding the timeout.
//   K4-a  RECOVERABLE blackout → the run rides through, exactly one recovery.
//   K4-b  PERMANENT blackout   → still times out, tagged post-recovery, one recovery.
//   K4-c  no blackout          → recovery is never invoked (happy path untouched).
// ═════════════════════════════════════════════════════════════════════

const recoveries = (state: FakeState) => state.events.filter((e) => e.startsWith('recover:'));

test('INVARIANT-K4-a serial: a blacked-out Reviewer whose turn is on disk is recovered at the deadline and the run completes (exactly one recovery)', async () => {
  const run = makeRun({ turnTimeoutMs: 150, recoveryRepollMs: 300 });
  const { client, state } = makeFake({
    // RECOVERABLE: the Reviewer's chat is blank until recoverChatBinding rebinds it.
    chatBlackout: (a) => a.title.startsWith('Reviewer') && !a.chatBound,
    // Complete the run: the lead's turn-2 (its response to the recovered review)
    // writes the plan file.
    onTurn: (a) => {
      if (a.title.startsWith('Lead') && a.counter === 2) fs.writeFileSync(run.planPath, 'plan after recovered review');
    },
  });
  const { ctx } = makeCtx(run);

  try {
    await runSerial(client, ctx);   // resolves — the blackout was recovered, not stalled
    const reviewer = byTitle(state, 'Reviewer');
    assert.deepEqual(recoveries(state), [`recover:${reviewer.id}`],
      'exactly one recoverChatBinding, for the blacked-out Reviewer');
    assert.ok(state.sendInputCalls.some((c) => /Reviewer Feedback/.test(c.text)),
      'the recovered review WAS relayed back to the Lead');
  } finally {
    rm(run.planPath);
  }
});

test('INVARIANT-K4-b serial: a PERMANENT Reviewer blackout still times out — tagged post-recovery re-poll empty, exactly one recovery', async () => {
  const run = makeRun({ turnTimeoutMs: 150, recoveryRepollMs: 120 });
  const { client, state } = makeFake({
    // PERMANENT: recovery rebinds but the chat stays blank regardless.
    chatBlackout: (a) => a.title.startsWith('Reviewer'),
  });
  const { ctx } = makeCtx(run);

  try {
    const msg = await rejectsMatching(runSerial(client, ctx), /post-recovery re-poll empty/);
    assert.match(msg, /agent\.status=idle/, 'stall still reports the idle-at-deadline status');
    const reviewer = byTitle(state, 'Reviewer');
    assert.deepEqual(recoveries(state), [`recover:${reviewer.id}`],
      'recovery attempted exactly once even for a permanent blackout');
  } finally {
    rm(run.planPath);
  }
});

test('INVARIANT-K4-c serial: a healthy run never invokes chat-binding recovery (happy path unchanged)', async () => {
  const run = makeRun({ turnTimeoutMs: 150 });
  const { client, state } = makeFake({
    onTurn: (a) => { if (a.title.startsWith('Lead') && a.counter === 2) fs.writeFileSync(run.planPath, 'plan'); },
  });
  const { ctx } = makeCtx(run);

  try {
    await runSerial(client, ctx);
    assert.deepEqual(recoveries(state), [], 'no recoverChatBinding on a run that never blacks out');
  } finally {
    rm(run.planPath);
  }
});

// ═════════════════════════════════════════════════════════════════════
// HANDSHAKE-FIX VARIANT MATRIX (experiment exp/gt-handshake-pressure)
//
// Races three dropped-submit recovery variants against the F-A..F-G fault
// matrix. Variants (run.submitRecoveryPolicy):
//   V0 'raw'                — baseline; client.sendInput, no handshake/recovery.
//   V1 'recover-fallthrough'— confirmed handshake + evidence-gated re-press; on
//                             exhaustion fall through to waitTurnComplete.
//   V2 'recover-throw'      — same, but THROW STALL on relay exhaustion.
//
// All windows are scaled to milliseconds (real wall-clock) so the F-F delay sweep
// races the recovery window in real time while turnTimeoutMs stays small. Crossover
// FF_CROSSOVER_MS ≈ handshake(30) + attempts(3)×recheck(40) = 150ms.
// ═════════════════════════════════════════════════════════════════════

const WINDOW = { attempts: 3, recheckMs: 40, pollMs: 5 };
const HANDSHAKE_MS = 30;
const FF_CROSSOVER_MS = HANDSHAKE_MS + WINDOW.attempts * WINDOW.recheckMs;   // ≈150ms
const TURN_TIMEOUT_MS = 600;   // real ms; fast-stall (~150ms) ≪ this ≪ slow-stall

const VARIANTS: SubmitRecoveryPolicy[] = ['raw', 'recover-fallthrough', 'recover-throw'];
const VLABEL: Record<string, string> = { 'raw': 'V0', 'recover-fallthrough': 'V1', 'recover-throw': 'V2' };
const FAULTS = ['F-A', 'F-B', 'F-C', 'F-D', 'F-E', 'F-G'] as const;

/** End a recovering serial run: the lead's 2nd turn writes the plan. */
function planTerminator(run: OrchestrationRun) {
  return (a: FakeAgent) => {
    if (a.title.startsWith('Lead') && a.counter === 2) {
      try { fs.writeFileSync(run.planPath, 'plan'); } catch { /* ignore */ }
    }
  };
}

function faultCfg(fault: string, run: OrchestrationRun, D = 0, handshakeMs = HANDSHAKE_MS): FakeConfig {
  const onTurn = planTerminator(run);
  switch (fault) {
    case 'F-A': {   // kickoff dropped-Enter, recovers on first re-press
      const dropped = new Set<string>();
      return { onTurn, dropSubmit: (a) => {
        if (a.title.startsWith('Reviewer') && !dropped.has(a.id)) { dropped.add(a.id); return true; }
        return false;
      } };
    }
    case 'F-B':     // kickoff dropped-Enter, never recovers (dead re-press)
      return { onTurn,
        dropSubmit: (a) => a.title.startsWith('Reviewer'),
        deadResubmit: (a) => a.title.startsWith('Reviewer') };
    case 'F-C': {   // hard delivery failure on kickoff (first reviewer instance only)
      let fails = 0;
      return { onTurn, throwSend: (a) => {
        if (a.title.startsWith('Reviewer') && fails < 1) {
          fails++;
          return Object.assign(new Error('Input delivery failed — no runner accepted the bytes'), { code: 'delivery-failed' });
        }
        return null;
      } };
    }
    case 'F-D': {   // relay dropped-Enter, recovers on re-press
      let dropped = false;
      return { onTurn, dropSubmit: (a, text) => {
        if (a.title.startsWith('Lead') && /Reviewer Feedback/.test(text) && !dropped) { dropped = true; return true; }
        return false;
      } };
    }
    case 'F-E':     // relay dropped-Enter, never recovers
      return { onTurn,
        dropSubmit: (a, text) => a.title.startsWith('Lead') && /Reviewer Feedback/.test(text),
        deadResubmit: (a) => a.title.startsWith('Lead') };
    case 'F-F': {   // HEALTHY-but-slow codex kickoff: Enter landed, turn arms after D real ms
      const slowed = new Set<string>();
      return { onTurn, handshakeMs, slowArm: (a) => {
        if (a.title.startsWith('Reviewer') && !slowed.has(a.id)) { slowed.add(a.id); return D; }
        return null;
      } };
    }
    case 'F-G':     // claude happy path (confirmed instantly)
    default:
      return { onTurn };
  }
}

interface CaseResult {
  variant: SubmitRecoveryPolicy; fault: string; D: number;
  outcome: string; elapsedMs: number; resubmits: number; reviewerLaunches: number;
  threw: boolean; msg: string;
}

function classify(r: { fault: string; threw: boolean; msg: string; reviewerLaunches: number }): string {
  if (!r.threw) {
    if (r.fault === 'F-F') return r.reviewerLaunches > 1 ? 'relaunched' : 'rode-out';
    return r.reviewerLaunches > 1 ? 'relaunched' : 'recovered';
  }
  if (/STALL: .*input delivery unconfirmed/.test(r.msg)) return r.fault === 'F-F' ? 'FALSE-STALL' : 'fast-stall';
  if (/Timeout/.test(r.msg)) return 'slow-stall';
  if (/delivery-failed|no runner/.test(r.msg)) return 'crash(delivery)';
  return 'error';
}

interface CaseOpts { window?: { attempts: number; recheckMs: number; pollMs: number }; turnTimeoutMs?: number; handshakeMs?: number; }
async function runCase(variant: SubmitRecoveryPolicy, fault: string, D = 0, opts: CaseOpts = {}): Promise<CaseResult> {
  const win = opts.window ?? WINDOW;
  const run = makeRun({
    leadProvider: 'claude', reviewerProvider: 'codex', turnTimeoutMs: opts.turnTimeoutMs ?? TURN_TIMEOUT_MS,
    submitRecoveryPolicy: variant,
    submitRecoveryWindow: { attempts: win.attempts, recheckMs: win.recheckMs, pollMs: win.pollMs },
  });
  const cfg = faultCfg(fault, run, D, opts.handshakeMs ?? HANDSHAKE_MS);
  const { client, state } = makeFake(cfg);
  const { ctx } = makeCtx(run);
  const start = Date.now();
  let threw = false, msg = '';
  try { await runSerial(client, ctx); } catch (err: any) { threw = true; msg = err?.message || String(err); }
  const elapsedMs = Date.now() - start;
  rm(run.planPath);
  const resubmits = state.events.filter((e) => e.startsWith('resubmit:')).length;
  const reviewerLaunches = state.launchInputs.filter((i) => /Reviewer/.test(i.title)).length;
  const outcome = classify({ fault, threw, msg, reviewerLaunches });
  return { variant, fault, D, outcome, elapsedMs, resubmits, reviewerLaunches, threw, msg };
}

// ── PROBE-V0: pin the reproduced bug (codex turn-1 dropped Enter → timeout stall) ──
test('PROBE-V0: a raw codex kickoff with a dropped Enter STALLs on the turn-timeout with no recovery', async () => {
  const r = await runCase('raw', 'F-A');
  assert.equal(r.outcome, 'slow-stall', 'V0 has no recovery — the dropped kickoff polls to the turn-timeout');
  assert.match(r.msg, /Timeout/, 'classifies as a timeout stall');
  assert.equal(r.resubmits, 0, 'V0 never re-presses Enter');
  assert.ok(r.elapsedMs >= TURN_TIMEOUT_MS, `slow-stall burned the full turn-timeout (${r.elapsedMs}ms ≥ ${TURN_TIMEOUT_MS}ms)`);
});

// ── INVARIANT-K1: V1 AND V2 recover a dropped codex KICKOFF in place (Q1) ──
test('INVARIANT-K1: V1 & V2 recover a dropped codex kickoff (F-A) in place via a re-press, no relaunch', async () => {
  for (const v of ['recover-fallthrough', 'recover-throw'] as SubmitRecoveryPolicy[]) {
    const r = await runCase(v, 'F-A');
    assert.equal(r.outcome, 'recovered', `${VLABEL[v]} recovered F-A (got ${r.outcome}: ${r.msg})`);
    assert.ok(r.resubmits >= 1, `${VLABEL[v]} re-pressed Enter to recover`);
    assert.equal(r.reviewerLaunches, 1, `${VLABEL[v]} recovered in place — no relaunch`);
  }
});

// ── INVARIANT-K1b: V1 AND V2 recover a dropped RELAY (F-D) in place (Q1) ──
test('INVARIANT-K1b: V1 & V2 recover a dropped relay (F-D) in place via a re-press', async () => {
  for (const v of ['recover-fallthrough', 'recover-throw'] as SubmitRecoveryPolicy[]) {
    const r = await runCase(v, 'F-D');
    assert.equal(r.outcome, 'recovered', `${VLABEL[v]} recovered F-D (got ${r.outcome}: ${r.msg})`);
    assert.ok(r.resubmits >= 1, `${VLABEL[v]} re-pressed Enter to recover the relay`);
  }
});

// ── INVARIANT-K2: a hard delivery-failed kickoff (F-C) relaunches & recovers ──
test('INVARIANT-K2: V1 & V2 relaunch a fresh member after a hard delivery-failed kickoff (F-C) and recover', async () => {
  for (const v of ['recover-fallthrough', 'recover-throw'] as SubmitRecoveryPolicy[]) {
    const r = await runCase(v, 'F-C');
    assert.equal(r.outcome, 'relaunched', `${VLABEL[v]} relaunched on F-C (got ${r.outcome}: ${r.msg})`);
    assert.equal(r.reviewerLaunches, 2, `${VLABEL[v]} relaunched the reviewer exactly once`);
  }
  // V0 has no relaunch — the hard failure crashes the run.
  const v0 = await runCase('raw', 'F-C');
  assert.equal(v0.outcome, 'crash(delivery)', 'V0 crashes on a hard delivery failure (no relaunch path)');
});

// ── INVARIANT-K3: dead prompt (F-E) — V2 fails FAST, V1 rides to the timeout;
//    both reach a 'stalled' end-state (Q3) ──
test('INVARIANT-K3: dead relay (F-E) — V2 STALLs fast, V1 slow-stalls; both map to stalled', async () => {
  const v1 = await runCase('recover-fallthrough', 'F-E');
  const v2 = await runCase('recover-throw', 'F-E');
  assert.equal(v2.outcome, 'fast-stall', `V2 threw a fast STALL (got ${v2.outcome})`);
  assert.match(v2.msg, /STALL: .*input delivery unconfirmed/, 'V2 throws the explicit delivery STALL');
  assert.equal(v1.outcome, 'slow-stall', `V1 rode to the turn-timeout (got ${v1.outcome})`);
  assert.match(v1.msg, /Timeout/, 'V1 falls through to the waitTurnComplete timeout');
  // Both end-states map to 'stalled' under service.ts (STALL prefix / Timeout substring).
  assert.ok(/STALL/.test(v2.msg) || /Timeout/.test(v2.msg), 'V2 → stalled');
  assert.ok(/STALL/.test(v1.msg) || /Timeout/.test(v1.msg), 'V1 → stalled');
  // V2 is dramatically faster to the same resumable end-state.
  assert.ok(v2.elapsedMs < v1.elapsedMs, `V2 (${v2.elapsedMs}ms) fails faster than V1 (${v1.elapsedMs}ms)`);
  assert.ok(v2.elapsedMs < TURN_TIMEOUT_MS, `V2 fast-stall ≪ turnTimeoutMs (${v2.elapsedMs}ms < ${TURN_TIMEOUT_MS}ms)`);
});

// ── PROBE-F-F-crossover: the regression probe (Q2). Past the crossover, V2's
//    fast-throw FALSE-STALLs a HEALTHY-but-slow codex turn that V1 rides out. ──
test('PROBE-F-F: past the recovery window, V2 FALSE-STALLs a healthy-slow codex turn that V1 rides out', async () => {
  const D = FF_CROSSOVER_MS + 250;   // comfortably past the crossover, still < turnTimeoutMs
  const v1 = await runCase('recover-fallthrough', 'F-F', D);
  const v2 = await runCase('recover-throw', 'F-F', D);
  assert.equal(v1.outcome, 'rode-out', `V1 rode out the slow-but-healthy turn (got ${v1.outcome}: ${v1.msg})`);
  assert.equal(v2.outcome, 'FALSE-STALL', `V2 false-stalled the healthy turn (got ${v2.outcome}: ${v2.msg})`);
  assert.match(v2.msg, /STALL: .*input delivery unconfirmed/, 'V2 throws the delivery STALL on a turn that was actually healthy');
});

// ── INVARIANT-F-F-gate: within the handshake window, evidence-gating fires ZERO
//    stray re-presses into a promptly-observable healthy turn — in BOTH variants. ──
test('INVARIANT-F-F-gate: a healthy turn observable within the handshake window draws no re-press (both variants)', async () => {
  const D = 10;   // < HANDSHAKE_MS → caught inside sendInputConfirmed, before any re-press
  for (const v of ['recover-fallthrough', 'recover-throw'] as SubmitRecoveryPolicy[]) {
    const r = await runCase(v, 'F-F', D);
    assert.equal(r.resubmits, 0, `${VLABEL[v]} fired no stray re-press into a promptly-observable healthy turn`);
    assert.ok(r.outcome === 'rode-out' || r.outcome === 'recovered', `${VLABEL[v]} completed (got ${r.outcome})`);
  }
});

// ── INVARIANT-F-G-clean: a confirmed (happy-path) run never re-presses Enter ──
test('INVARIANT-F-G-clean: a clean confirmed run (F-G) never re-presses Enter, any variant', async () => {
  for (const v of VARIANTS) {
    const r = await runCase(v, 'F-G');
    assert.equal(r.resubmits, 0, `${VLABEL[v]} happy path fired no re-press`);
    assert.equal(r.outcome, 'recovered', `${VLABEL[v]} completed cleanly (got ${r.outcome})`);
  }
});

// ── Matrix table printer (informational — feeds the RESULTS writeup) ──
test('MATRIX: print the variant×fault table and the F-F delay sweep', async () => {
  const rows: CaseResult[] = [];
  for (const v of VARIANTS) for (const f of FAULTS) rows.push(await runCase(v, f));
  // F-F at a representative past-crossover delay for the main table.
  const ffD = FF_CROSSOVER_MS + 250;
  for (const v of VARIANTS) rows.push(await runCase(v, 'F-F', ffD));

  const cell = (r: CaseResult) => `${r.outcome}/${r.elapsedMs}ms/rp${r.resubmits}${r.reviewerLaunches > 1 ? `/L${r.reviewerLaunches}` : ''}`;
  const faultCols = [...FAULTS, 'F-F'];
  console.log('\n=== VARIANT × FAULT MATRIX  (outcome / elapsed / re-presses [/ launches if relaunched]) ===');
  console.log(`F-F shown at D=${ffD}ms (crossover≈${FF_CROSSOVER_MS}ms, turnTimeout=${TURN_TIMEOUT_MS}ms)`);
  const header = ['variant'.padEnd(8), ...faultCols.map((f) => f.padEnd(26))].join(' | ');
  console.log(header);
  for (const v of VARIANTS) {
    const byFault: Record<string, CaseResult> = {};
    for (const r of rows.filter((x) => x.variant === v)) byFault[r.fault] = byFault[r.fault] && r.fault === 'F-F' ? byFault[r.fault] : r;
    const line = [VLABEL[v].padEnd(8), ...faultCols.map((f) => cell(byFault[f]).padEnd(26))].join(' | ');
    console.log(line);
  }

  console.log('\n=== F-F DELAY SWEEP  (HEALTHY-but-slow codex kickoff; crossover≈' + FF_CROSSOVER_MS + 'ms) ===');
  console.log(['D(ms)'.padEnd(8), 'V1 (recover-fallthrough)'.padEnd(34), 'V2 (recover-throw)'.padEnd(34)].join(' | '));
  for (const D of [10, 60, 100, FF_CROSSOVER_MS + 250, FF_CROSSOVER_MS + 450]) {
    const v1 = await runCase('recover-fallthrough', 'F-F', D);
    const v2 = await runCase('recover-throw', 'F-F', D);
    const fmt = (r: CaseResult) => `${r.outcome} (rp${r.resubmits}, ${r.elapsedMs}ms${r.reviewerLaunches > 1 ? `, L${r.reviewerLaunches}` : ''})`;
    console.log([String(D).padEnd(8), fmt(v1).padEnd(34), fmt(v2).padEnd(34)].join(' | '));
  }
  console.log('');
});

// ── F-F REAL-TIME SWEEP (opt-in: GT_FF_REALTIME=1) ────────────────────
// The matrix above scales the recovery window to milliseconds so the suite stays
// fast (~2s). This opt-in case instead uses the PRODUCTION recovery window from
// plans/groupthink-handshake-fix.md (3 re-press attempts × 10s recheck ⇒ ≈32s of
// genuine re-press watching) and sweeps the HEALTHY-but-slow codex delay D across
// 5s / 20s / 40s / 60s in REAL wall-clock — the literal protocol the experiment
// asks for. It answers Q2 against real constants: the crossover at which V2's
// fast-throw begins FALSE-STALLing a healthy-slow turn that V1 rides out is the
// re-press window (~32s), so D≤20s rides out under both variants and D≥40s
// false-stalls only under V2. Gated because the 4 real-second waits make it a
// ~4-minute run; the fast scaled matrix is the regression gate.
const PROD_WINDOW = { attempts: 3, recheckMs: 10_000, pollMs: 1_000 };   // plan §4a defaults
const PROD_HANDSHAKE_MS = 2_000;     // realistic confirm-watch; immaterial since every D ≫ it
const PROD_TURN_TIMEOUT_MS = 600_000;
const PROD_CROSSOVER_MS = PROD_HANDSHAKE_MS + PROD_WINDOW.attempts * PROD_WINDOW.recheckMs;  // ≈32s

if (process.env.GT_FF_REALTIME === '1') {
  test('PROBE-F-F-realtime: production-window F-F sweep at 5s/20s/40s/60s real elapsed', async () => {
    const opts: CaseOpts = { window: PROD_WINDOW, turnTimeoutMs: PROD_TURN_TIMEOUT_MS, handshakeMs: PROD_HANDSHAKE_MS };
    const Ds = [5_000, 20_000, 40_000, 60_000];
    console.log('\n=== F-F REAL-TIME SWEEP  (production recovery window: 3×10s re-press ⇒ crossover≈' + Math.round(PROD_CROSSOVER_MS / 1000) + 's) ===');
    console.log(['D'.padEnd(6), 'V1 (recover-fallthrough)'.padEnd(40), 'V2 (recover-throw)'.padEnd(40)].join(' | '));
    const fmt = (r: CaseResult) => `${r.outcome} (rp${r.resubmits}, ${(r.elapsedMs / 1000).toFixed(1)}s${r.reviewerLaunches > 1 ? `, L${r.reviewerLaunches}` : ''})`;
    const sweep: Array<{ D: number; v1: CaseResult; v2: CaseResult }> = [];
    for (const D of Ds) {
      const v1 = await runCase('recover-fallthrough', 'F-F', D, opts);
      const v2 = await runCase('recover-throw', 'F-F', D, opts);
      sweep.push({ D, v1, v2 });
      console.log([`${D / 1000}s`.padEnd(6), fmt(v1).padEnd(40), fmt(v2).padEnd(40)].join(' | '));
    }
    console.log('');
    // Invariants the sweep must hold: below the window both ride out; above it
    // only V2 false-stalls (V1 always rides out a genuinely-healthy turn).
    for (const { D, v1, v2 } of sweep) {
      assert.equal(v1.outcome, 'rode-out', `V1 must ride out a healthy-slow turn at D=${D}ms (got ${v1.outcome})`);
      if (D <= PROD_CROSSOVER_MS) {
        assert.equal(v2.outcome, 'rode-out', `V2 should also ride out within the recovery window at D=${D}ms (got ${v2.outcome})`);
      } else {
        assert.equal(v2.outcome, 'FALSE-STALL', `V2 should FALSE-STALL past the recovery window at D=${D}ms (got ${v2.outcome})`);
      }
    }
  });
}

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
