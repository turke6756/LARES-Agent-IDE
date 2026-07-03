// GroupThink runner tests (plan §7) — drive runSerial/runParallel against a
// scripted DashboardClient fake (no HTTP, no real agents). Asserts the behaviors
// the in-process port must preserve verbatim from scripts/groupthink-v2.js:
//   • BUG-29 launch ordering — Reviewer launches only AFTER the Lead's turn-1.
//   • Unified kickoff path — every provider (claude included) is launched,
//     waitReady'd, then kicked off via a submitted sendInput (status-gap fix).
//   • Turn-timeout → STALL throw.
//   • BUG-06 no-replay — seedLastRelayedTsFromChat seeds the highwater mark so a
//     pre-existing turnComplete is never re-relayed.
//   • Receiver-ready gate respects isInputInFlight.
//   • Parallel R1→R2→R3 order + premature-write termination.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/orchestration/groupthink-v2.test.js
//
// The runner's sleeps are real setTimeout calls; we clamp the global to ≤2ms so
// the poll loops spin fast while Date.now()-based timeouts still measure real
// elapsed time (needed for the STALL / gate assertions).

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
  events: string[];     // ordered log of launch:/turn: markers
}

interface FakeConfig {
  frozen?: boolean;                          // pending turns never materialize
  inFlight?: (id: string) => boolean;        // isInputInFlight override
  onTurn?: (a: FakeAgent, state: FakeState) => void;  // hook on each revealed turn
  seedAgents?: Array<{ id: string; title: string; provider: string; latest: RelayMessage | null }>;
}

let agentSeq = 0;

function makeFake(cfg: FakeConfig = {}): { client: DashboardClient; state: FakeState } {
  const state: FakeState = { agents: new Map(), launchInputs: [], sendInputCalls: [], events: [] };

  for (const s of cfg.seedAgents ?? []) {
    state.agents.set(s.id, {
      id: s.id, title: s.title, provider: s.provider, status: 'idle',
      latest: s.latest, counter: 0, pending: false, getCalls: 0, revealAt: 1, sendCount: 0,
    });
  }

  const arm = (a: FakeAgent, revealAt: number) => { a.pending = true; a.getCalls = 0; a.revealAt = revealAt; };

  const reveal = (a: FakeAgent) => {
    a.counter++;
    a.latest = {
      content: `${a.title} :: turn ${a.counter}`,
      ts: `${a.id}#${String(a.counter).padStart(4, '0')}`,
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
      // No provider is kicked off at launch anymore — every agent (claude
      // included) gets its kickoff via a submitted sendInput, armed below.
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
      // First send to a launched agent (any provider) is its kickoff, immediately
      // followed by a seed read (getCall #1) → reveal on #2. Every other send is
      // relay feedback with no intervening seed → reveal on the first poll (#1).
      const isKickoff = a.sendCount === 1;
      arm(a, isKickoff ? 2 : 1);
    },
    // These tests run the default 'raw' policy, so the runner never calls the
    // confirmed-handshake seams — present only so the widened DashboardClient
    // interface compiles.
    sendInputConfirmed: async (id, text) => {
      const a = state.agents.get(id);
      if (!a) throw new Error(`sendInputConfirmed to unknown agent ${id}`);
      a.sendCount++;
      state.sendInputCalls.push({ id, text });
      arm(a, 1);
      return { delivered: true, confirmed: true, mode: 'hook' as const };
    },
    resubmitEnter: () => {},
    recoverChatBinding: () => {},
    isInputInFlight: (id) => (cfg.inFlight ? cfg.inFlight(id) : false),
    stopAgent: async () => {},
  };

  return { client, state };
}

// ── Run/context fakes ────────────────────────────────────────────────

let planSeq = 0;
function freshPlanPath(): string {
  return path.join(os.tmpdir(), `gt-test-plan-${process.pid}-${++planSeq}.md`);
}

function makeRun(overrides: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return {
    runId: 'run-test',
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
    // WP1/BUG-37: scale the deadline chat-binding re-poll to ms so idle-timeout
    // tests don't each pay the production RECOVERY_REPOLL_MS (15s real).
    recoveryRepollMs: 30,
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

async function rejectsMatching(p: Promise<unknown>, re: RegExp): Promise<void> {
  try { await p; } catch (err: any) {
    assert.match(err?.message || String(err), re);
    return;
  }
  throw new Error(`expected rejection matching ${re}`);
}

function rm(p: string): void { try { fs.unlinkSync(p); } catch { /* ignore */ } }

// ── Serial: BUG-29 ordering + kickoff path ───────────────────────────

test('serial: reviewer launches only after lead turn-1; claude AND codex via sendInput', async () => {
  const run = makeRun();
  const { client, state } = makeFake({
    // Terminate the relay loop by writing the plan after the Lead's 2nd turn.
    onTurn: (a) => { if (a.title.startsWith('Lead') && a.counter === 2) fs.writeFileSync(run.planPath, 'plan'); },
  });
  const { ctx } = makeCtx(run);

  try {
    await runSerial(client, ctx);

    // Launch ordering: Lead first, Reviewer second.
    assert.equal(state.launchInputs.length, 2, 'lead + reviewer launched');
    assert.match(state.launchInputs[0].title, /Lead/, 'lead launched first');
    assert.match(state.launchInputs[1].title, /Reviewer/, 'reviewer launched second');

    // Owner-edge stamping (owner-as-container §3.1): every launch input carries
    // ownerAgentId === run.supervisorId, so lead + reviewer nest as siblings
    // under the supervisor's container.
    for (const input of state.launchInputs) {
      assert.equal(input.ownerAgentId, run.supervisorId,
        `launch input ${input.title} stamped with the supervisor as owner`);
    }

    // BUG-29 ordering: reviewer launch event comes AFTER the lead's first turn.
    const leadId = state.launchInputs[0] && Array.from(state.agents.values()).find((a) => a.title.startsWith('Lead'))!.id;
    const leadTurn1Idx = state.events.indexOf(`turn:${leadId}#1`);
    const reviewerLaunchIdx = state.events.findIndex((e) => e.startsWith('launch:Reviewer'));
    assert.ok(leadTurn1Idx >= 0, 'lead turn-1 recorded');
    assert.ok(reviewerLaunchIdx > leadTurn1Idx, 'reviewer launched strictly after lead turn-1');

    // Kickoff path: claude lead via sendInput (no systemPrompt at launch). The
    // FIRST send to the lead is its kickoff; later sends are relay feedback.
    assert.ok(!state.launchInputs[0].systemPrompt, 'lead (claude) launched WITHOUT systemPrompt');
    const leadKickoff = state.sendInputCalls.find((c) => c.id === leadId);
    assert.ok(leadKickoff, 'lead (claude) kicked off via sendInput');
    assert.match(leadKickoff!.text, /You are the Lead Planner/, 'lead kickoff is the lead prompt');

    // Kickoff path: codex reviewer via sendInput (no systemPrompt at launch),
    // and the kickoff embeds the Lead's turn-1 content (proves after-turn-1).
    const reviewerId = Array.from(state.agents.values()).find((a) => a.title.startsWith('Reviewer'))!.id;
    assert.ok(!state.launchInputs[1].systemPrompt, 'reviewer (codex) launched WITHOUT systemPrompt');
    const reviewerKickoff = state.sendInputCalls.find((c) => c.id === reviewerId);
    assert.ok(reviewerKickoff, 'reviewer kicked off via sendInput');
    assert.match(reviewerKickoff!.text, /You are the Reviewer/, 'reviewer kickoff is the reviewer prompt');
    assert.match(reviewerKickoff!.text, /turn 1/, 'reviewer kickoff embeds the lead turn-1 draft');
  } finally {
    rm(run.planPath);
  }
});

// ── Serial: turn-timeout → STALL throw ───────────────────────────────

test('serial: a lead turn that never completes throws a Timeout (→ STALL)', async () => {
  const run = makeRun({ turnTimeoutMs: 150 });
  const { client } = makeFake({ frozen: true });   // no turn ever materializes
  const { ctx } = makeCtx(run);
  await rejectsMatching(runSerial(client, ctx), /Timeout/);
});

// ── Serial: BUG-06 no-replay on resume ───────────────────────────────

test('serial resume: a pre-existing reviewer turnComplete is NOT re-relayed (BUG-06)', async () => {
  const run = makeRun({ turnTimeoutMs: 150, leadId: 'lead-r', reviewerId: 'rev-r' });
  const { client, state } = makeFake({
    seedAgents: [
      { id: 'lead-r', title: 'Lead (resumed)', provider: 'claude',
        latest: { content: 'old lead', ts: 'lead-r#0001', turnComplete: true } },
      { id: 'rev-r', title: 'Reviewer (resumed)', provider: 'codex',
        latest: { content: 'STALE reviewer feedback', ts: 'rev-r#0001', turnComplete: true } },
    ],
  });
  const { ctx } = makeCtx(run);

  // No NEW reviewer turn is produced, so the loop must time out waiting — and it
  // must NOT relay the stale pre-existing reviewer message to the lead.
  await rejectsMatching(runSerial(client, ctx), /Timeout/);
  assert.ok(!state.sendInputCalls.some((c) => /STALE reviewer feedback/.test(c.text)),
    'stale reviewer turn was not replayed to the lead');
  assert.equal(state.sendInputCalls.length, 0, 'no relay happened at all');
});

// ── WP2 (BUG-37): resume keeps a usable persisted highwater; seed only when absent ──
// On resume, re-seeding the highwater from chat marks the newest turnComplete as
// already-relayed. A Reviewer turn that completed DURING the stall IS that newest
// turn, so an unconditional re-seed swallows it and the run re-stalls forever
// (BUG-37's un-resumability). WP2 guards each resume seed on a parsed, USABLE mark
// (non-empty ts): a usable mark is the resume truth; only a missing/corrupt mark
// re-seeds (preserving the BUG-06/BUG-29 stale-content guard for those agents).
const HW_SEP = String.fromCharCode(1);
const composite = (ts: string, hash = 'abcdef0123456789') => `${ts}${HW_SEP}${hash}`;

test('WP2-a serial resume: a Reviewer turn that completed during the stall is relayed once and the run completes', async () => {
  const run = makeRun({
    turnTimeoutMs: 150, leadId: 'lead-r', reviewerId: 'rev-r',
    // Persisted pre-stall highwater for both members — USABLE composite marks.
    lastRelayedTs: { 'lead-r': composite('lead-r#0000'), 'rev-r': composite('rev-r#0002') },
  });
  const { client, state } = makeFake({
    seedAgents: [
      { id: 'lead-r', title: 'Lead (resumed)', provider: 'claude',
        latest: { content: 'old lead draft', ts: 'lead-r#0000', turnComplete: true } },
      { id: 'rev-r', title: 'Reviewer (resumed)', provider: 'codex',
        // Completed DURING the stall: ts newer than the persisted mark, visible now.
        latest: { content: 'DURING-STALL review', ts: 'rev-r#0005', turnComplete: true } },
    ],
    // The Lead's response to the relayed review writes the plan and ends the run.
    onTurn: (a) => { if (a.title.startsWith('Lead') && a.counter === 1) fs.writeFileSync(run.planPath, 'final plan'); },
  });
  const { ctx } = makeCtx(run);

  try {
    await runSerial(client, ctx);   // resolves — the during-stall turn was NOT swallowed by a re-seed
    assert.equal(state.sendInputCalls.filter((c) => /DURING-STALL review/.test(c.text)).length, 1,
      'the during-stall review was relayed to the Lead exactly once');
    assert.ok(fs.existsSync(run.planPath), 'run reached plan completion');
  } finally {
    rm(run.planPath);
  }
});

test('WP2-b serial resume: a Reviewer turn already relayed pre-stall is NOT re-relayed', async () => {
  const run = makeRun({
    turnTimeoutMs: 150, leadId: 'lead-r', reviewerId: 'rev-r',
    // Reviewer mark is NEWER than its visible turn → the turn is already accounted for.
    lastRelayedTs: { 'lead-r': composite('lead-r#0000'), 'rev-r': composite('rev-r#0009') },
  });
  const { client, state } = makeFake({
    seedAgents: [
      { id: 'lead-r', title: 'Lead (resumed)', provider: 'claude',
        latest: { content: 'old lead', ts: 'lead-r#0000', turnComplete: true } },
      { id: 'rev-r', title: 'Reviewer (resumed)', provider: 'codex',
        latest: { content: 'already-relayed review', ts: 'rev-r#0005', turnComplete: true } },
    ],
  });
  const { ctx } = makeCtx(run);

  await rejectsMatching(runSerial(client, ctx), /Timeout/);
  assert.ok(!state.sendInputCalls.some((c) => /already-relayed review/.test(c.text)),
    'the already-relayed reviewer turn was not re-relayed');
});

test('WP2-c serial fresh launch: seeding path unchanged (run launches both members and completes)', async () => {
  const run = makeRun();
  const { client, state } = makeFake({
    onTurn: (a) => { if (a.title.startsWith('Lead') && a.counter === 2) fs.writeFileSync(run.planPath, 'plan'); },
  });
  const { ctx } = makeCtx(run);

  try {
    await runSerial(client, ctx);
    assert.equal(state.launchInputs.length, 2, 'fresh launch: lead + reviewer launched (no resume shortcut)');
    assert.ok(fs.existsSync(run.planPath), 'fresh run completed');
  } finally {
    rm(run.planPath);
  }
});

test('WP2-d serial resume: a legacy hashless highwater is usable — the during-stall turn is still relayed (no re-seed)', async () => {
  const run = makeRun({
    turnTimeoutMs: 150, leadId: 'lead-r', reviewerId: 'rev-r',
    // HASHLESS marks (ts only, no HW_SEP) — the legacy format. Must count as usable.
    lastRelayedTs: { 'lead-r': 'lead-r#0000', 'rev-r': 'rev-r#0002' },
  });
  const { client, state } = makeFake({
    seedAgents: [
      { id: 'lead-r', title: 'Lead (resumed)', provider: 'claude',
        latest: { content: 'old lead draft', ts: 'lead-r#0000', turnComplete: true } },
      { id: 'rev-r', title: 'Reviewer (resumed)', provider: 'codex',
        latest: { content: 'DURING-STALL review', ts: 'rev-r#0005', turnComplete: true } },
    ],
    onTurn: (a) => { if (a.title.startsWith('Lead') && a.counter === 1) fs.writeFileSync(run.planPath, 'final plan'); },
  });
  const { ctx } = makeCtx(run);

  try {
    await runSerial(client, ctx);   // hashless mark was treated as usable → no re-seed swallowed the turn
    assert.equal(state.sendInputCalls.filter((c) => /DURING-STALL review/.test(c.text)).length, 1,
      'during-stall review relayed once despite the hashless (separator-free) mark');
  } finally {
    rm(run.planPath);
  }
});

test('WP2-e serial resume: a separator-only (corrupt) mark is NOT usable — seeding still occurs and guards the pre-existing turn', async () => {
  const run = makeRun({
    turnTimeoutMs: 150, leadId: 'lead-r', reviewerId: 'rev-r',
    // Reviewer mark is separator-only (blank ts) — corruption, NOT usable → re-seed.
    lastRelayedTs: { 'lead-r': composite('lead-r#0000'), 'rev-r': `${HW_SEP}deadbeef` },
  });
  const { client, state } = makeFake({
    seedAgents: [
      { id: 'lead-r', title: 'Lead (resumed)', provider: 'claude',
        latest: { content: 'old lead', ts: 'lead-r#0000', turnComplete: true } },
      { id: 'rev-r', title: 'Reviewer (resumed)', provider: 'codex',
        latest: { content: 'pre-existing review', ts: 'rev-r#0005', turnComplete: true } },
    ],
  });
  const { ctx } = makeCtx(run);

  // Seeding re-marks rev-r#0005 as relayed → no NEW turn → times out, and the
  // pre-existing turn is NOT relayed (BUG-06 protection preserved for corrupt marks).
  await rejectsMatching(runSerial(client, ctx), /Timeout/);
  assert.ok(!state.sendInputCalls.some((c) => /pre-existing review/.test(c.text)),
    'seeding on a corrupt mark still guards the pre-existing turn from replay');
});

// ── Serial: receiver-ready gate respects isInputInFlight ─────────────

test('serial: relay to lead is gated while isInputInFlight(lead) is true', async () => {
  const run = makeRun({ turnTimeoutMs: 150 });
  let leadId = '';
  const { client, state } = makeFake({
    // Lead never accepts input: isInputInFlight stays true → waitReceiverReady
    // must time out before any feedback send to the lead.
    inFlight: (id) => id === leadId,
  });
  // Resolve the lead id once it is launched.
  const origLaunch = client.launchAgent;
  (client as any).launchAgent = async (input: any) => {
    const a = await origLaunch(input);
    if (/Lead/.test(input.title || '')) leadId = a.id;   // resolve the lead id by title
    return a;
  };
  const { ctx } = makeCtx(run);

  await rejectsMatching(runSerial(client, ctx), /Timeout|ready for relay/);
  // The reviewer produced a turn, but the gate blocked the relay to the lead.
  assert.ok(!state.sendInputCalls.some((c) => c.id === leadId && /Reviewer Feedback/.test(c.text)),
    'no feedback was relayed to the lead while it was in-flight');
});

// ── Parallel: R1→R2→R3 order + plan written ──────────────────────────

test('parallel: rounds run R1→R2→R3 and synthesizer writes the plan', async () => {
  const run = makeRun({ mode: 'parallel' });
  const { client, state } = makeFake({
    onTurn: (a) => { if (a.title.startsWith('Synthesizer') && a.counter === 3) fs.writeFileSync(run.planPath, 'plan'); },
  });
  const { ctx, rounds } = makeCtx(run);

  try {
    await runParallel(client, ctx);
    assert.deepEqual(rounds, [1, 2, 3], 'rounds emitted in R1→R2→R3 order');

    const synth = Array.from(state.agents.values()).find((a) => a.title.startsWith('Synthesizer'))!;
    const peer = Array.from(state.agents.values()).find((a) => a.title.startsWith('Planner'))!;
    assert.ok(synth && peer, 'both planners launched');
    assert.equal(synth.counter, 3, 'synthesizer ran 3 turns (R1, R2, R3)');

    // Owner-edge stamping (owner-as-container §3.1): in parallel mode both
    // planners launch concurrently, so neither can own the other — the
    // supervisor is the uniform owner stamped on every launch input.
    assert.equal(state.launchInputs.length, 2, 'two planners launched');
    for (const input of state.launchInputs) {
      assert.equal(input.ownerAgentId, run.supervisorId,
        `launch input ${input.title} stamped with the supervisor as owner`);
    }

    // Both planners (claude synth + codex peer) kicked off via sendInput, no
    // systemPrompt at launch.
    assert.ok(!state.launchInputs.find((i) => i.title.startsWith('Synthesizer')).systemPrompt, 'synth launched WITHOUT systemPrompt');
    assert.ok(!state.launchInputs.find((i) => i.title.startsWith('Planner')).systemPrompt, 'peer launched WITHOUT systemPrompt');
    const synthKickoff = state.sendInputCalls.find((c) => c.id === synth.id);
    assert.ok(synthKickoff && /independent planners/.test(synthKickoff.text), 'synth (claude) kicked off via sendInput');

    // The synthesizer's last send is the synthesis prompt carrying the plan path.
    const synthSends = state.sendInputCalls.filter((c) => c.id === synth.id);
    assert.ok(synthSends.length >= 3, 'synthesizer received kickoff + R2 + R3 sends');
    assert.match(synthSends[synthSends.length - 1].text, new RegExp(run.planPath.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')),
      'final synthesizer relay is the synthesis prompt with the plan path');
    assert.ok(fs.existsSync(run.planPath), 'plan file written');
  } finally {
    rm(run.planPath);
  }
});

// ── Parallel: premature-write termination ────────────────────────────

test('parallel: a plan written during R1 terminates before R2', async () => {
  const run = makeRun({ mode: 'parallel' });
  const { client, state } = makeFake({
    onTurn: (a) => { if (a.title.startsWith('Synthesizer') && a.counter === 1) fs.writeFileSync(run.planPath, 'early'); },
  });
  const { ctx, rounds } = makeCtx(run);

  try {
    await runParallel(client, ctx);
    assert.deepEqual(rounds, [1], 'only R1 ran; premature plan write terminated the run');
    // No R2 relay prompts were sent (R2 prompt text is distinctive).
    assert.ok(!state.sendInputCalls.some((c) => /Compare it to your own draft/.test(c.text)),
      'no R2 relay after premature write');
  } finally {
    rm(run.planPath);
  }
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
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
