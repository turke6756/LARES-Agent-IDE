// In-process port of scripts/groupthink-v2.js — the GroupThink relay loop run
// against a DashboardClient (no HTTP, no module-global state). All the WSL/port
// probing the script needed is gone; the runner calls dashboard primitives
// directly. Per-run mutable state (highwater marks, current turn/round) lives on
// ctx.run; progress + members persist through ctx.persist()/ctx.emit().
//
// PRESERVED EXACTLY from the script:
//   • BUG-29 launch ordering — Reviewer launches only after the Lead's first
//     turn-complete. (Kickoff delivery is now unified across providers: every
//     agent is launched, waitReady'd, then sent the kickoff via sendInput as a
//     submitted message — see launchAgentWithKickoff for the status-gap fix.)
//   • BUG-06 highwater seeding — seedLastRelayedTsFromChat seeds the per-agent
//     mark on (re)attach so a pre-existing turnComplete is never re-relayed.
//   • The receiver-ready gate — READY_STATUSES plus the in-process equivalent of
//     the HTTP 409 latch (client.isInputInFlight).
//   • Turn-timeout STALL semantics — message-stream-as-source-of-truth with the
//     status-as-stall-reset logic.

import fs from 'fs';
import { Agent, AgentProvider, LaunchAgentInput } from '../../shared/types';
import { DashboardClient, OrchestrationRunContext } from './types';
import {
  serialLeadPrompt, serialReviewerKickoff,
  parallelR1Prompt, parallelR2Prompt, parallelSynthesisPrompt,
} from './groupthink-v2-prompts';

// --- Configuration (mirrors groupthink-v2.js:39–43) ---
const READY_STATUSES = new Set<string>(['idle', 'waiting']);
const MAX_TURNS = 10;
const POLL_INTERVAL_MS = 2000;
const MIN_READY_POLLS = 3;
const STATUS_CHECK_INTERVAL_MS = 10000;

/** Thrown when the run's AbortSignal fires mid-poll. The service swallows it
 *  (it checks controller.signal.aborted), so the name is for clarity only. */
class AbortError extends Error {
  constructor() { super('Orchestration run aborted'); this.name = 'AbortError'; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function checkAborted(ctx: OrchestrationRunContext): void {
  if (ctx.signal.aborted) throw new AbortError();
}

interface RelayMessage { content: string; ts: string; turnComplete?: boolean }

// --- Idle / ready helpers (groupthink-v2.js:170–201) ---

/** Triple-confirm idle/waiting loop — guards against a status that flickers
 *  idle for a single poll before the agent actually starts working. */
async function waitReady(
  client: DashboardClient, ctx: OrchestrationRunContext,
  agentId: string, label: string, timeoutMs = 300000,
): Promise<Agent> {
  const deadline = Date.now() + timeoutMs;
  let readyCount = 0;
  while (Date.now() < deadline) {
    checkAborted(ctx);
    const agent = client.getAgent(agentId);
    if (agent && READY_STATUSES.has(agent.status)) {
      readyCount++;
      if (readyCount >= MIN_READY_POLLS) return agent;
    } else {
      readyCount = 0;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timeout waiting for ${label} (${agentId}) to reach idle`);
}

/** Gate before relaying to a receiver: crashed/done bail + idle/waiting gate,
 *  PLUS the in-process equivalent of the HTTP 409 latch — an in-flight send
 *  means the receiver isn't ready to accept the next relay (plan §1c). */
async function waitReceiverReady(
  client: DashboardClient, ctx: OrchestrationRunContext,
  agentId: string, label: string, timeoutMs = 600000,
): Promise<Agent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    checkAborted(ctx);
    const agent = client.getAgent(agentId);
    const status = agent?.status;
    if (status === 'crashed' || status === 'done') {
      throw new Error(`${label} (${agentId}) exited with status=${status} before accepting relay`);
    }
    if (agent && status && READY_STATUSES.has(status) && !client.isInputInFlight(agentId)) {
      return agent;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`STALL: Timeout waiting for ${label} (${agentId}) to become ready for relay`);
}

// --- Message helpers (groupthink-v2.js:204–267) ---

async function readNextMessage(
  client: DashboardClient, ctx: OrchestrationRunContext, agentId: string,
): Promise<RelayMessage | null> {
  const msgs = await client.getMessages(agentId, { limit: 1, role: 'assistant' });
  const msg = msgs?.[0];
  if (!msg || !msg.turnComplete) return null;
  const hw = ctx.run.lastRelayedTs[agentId];
  if (hw && msg.ts <= hw) return null;
  return msg;
}

/** BUG-06: seed the highwater mark from the latest assistant message so the
 *  first wait blocks on genuinely new content rather than re-relaying a
 *  pre-existing turnComplete (matters on resume + after BUG-29 launch). */
async function seedLastRelayedTsFromChat(
  client: DashboardClient, ctx: OrchestrationRunContext, agentId: string, _label: string,
): Promise<void> {
  const msgs = await client.getMessages(agentId, { limit: 1, role: 'assistant' });
  const msg = msgs?.[0];
  if (msg && msg.turnComplete && msg.ts) {
    ctx.run.lastRelayedTs[agentId] = msg.ts;
  }
}

/** Wait for the next NEW turn-complete assistant message. Source of truth is the
 *  message stream's turnComplete flag, not agent.status (status lags by minutes
 *  on codex); status is consulted only as a crashed/done hard-exit and to reset
 *  the stall clock while the agent is demonstrably still working. */
async function waitTurnComplete(
  client: DashboardClient, ctx: OrchestrationRunContext,
  agentId: string, label: string, timeoutMs = 600000,
): Promise<RelayMessage> {
  let stallDeadline = Date.now() + timeoutMs;
  let lastStatusCheck = 0;
  for (;;) {
    checkAborted(ctx);
    const msg = await readNextMessage(client, ctx, agentId);
    if (msg) return msg;

    const now = Date.now();
    if (now - lastStatusCheck >= STATUS_CHECK_INTERVAL_MS) {
      lastStatusCheck = now;
      const status = client.getAgent(agentId)?.status;
      if (status === 'crashed' || status === 'done') {
        throw new Error(`${label} (${agentId}) exited with status=${status} before completing turn`);
      }
      if (status === 'working') {
        stallDeadline = now + timeoutMs;
      }
    }

    if (Date.now() > stallDeadline) {
      const status = client.getAgent(agentId)?.status;
      lastStatusCheck = Date.now();
      if (status === 'crashed' || status === 'done') {
        throw new Error(`${label} (${agentId}) exited with status=${status} before completing turn`);
      }
      if (status === 'working') {
        stallDeadline = lastStatusCheck + timeoutMs;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      throw new Error(`Timeout waiting for ${label} (${agentId}) to complete turn (agent.status=${status})`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// --- Agent launch with kickoff (groupthink-v2.js:339–372) ---
//
// Every provider gets its kickoff the SAME way: launch (NO systemPrompt), then
// waitReady, then sendInput(kickoffPrompt). The kickoff MUST arrive as a
// submitted message — that's what arms the worker "working" status latch (which
// fires on a parsed user-text chat event). A launch-time systemPrompt is
// appended as a system prompt and never submitted as a turn, so a supervised
// agent would run its first turn while its dashboard card stays stuck on `idle`
// (PTY status inference is OFF for workers, so nothing corrects it). This is the
// status-gap fix. BUG-29 (stale-session discovery) is a Codex/Gemini-only
// concern handled by launch ordering, NOT by Claude's kickoff path. Every agent
// is freshSession + isSupervised so the worker-lane hook status + the
// [DASHBOARD EVENT] relay are active.
interface LaunchOpts {
  workspaceId: string;
  title: string;
  roleDescription: string;
  provider: string;
  kickoffPrompt: string;
}

async function launchAgentWithKickoff(
  client: DashboardClient, ctx: OrchestrationRunContext, opts: LaunchOpts,
): Promise<Agent> {
  const { workspaceId, title, roleDescription, provider, kickoffPrompt } = opts;

  const launchInput: LaunchAgentInput = {
    workspaceId,
    title,
    roleDescription,
    provider: provider as AgentProvider,
    freshSession: true,
    isSupervised: true,
  };

  const agent = await client.launchAgent(launchInput);

  // All providers get the kickoff as a SUBMITTED message (not a launch-time
  // systemPrompt). A submitted message arms the worker working-status latch;
  // a systemPrompt would not, leaving a supervised card stuck on `idle`.
  await waitReady(client, ctx, agent.id, title);
  await client.sendInput(agent.id, kickoffPrompt);

  await seedLastRelayedTsFromChat(client, ctx, agent.id, title);
  return agent;
}

// --- Mode: Serial (groupthink-v2.js:448–547) ---
export async function runSerial(client: DashboardClient, ctx: OrchestrationRunContext): Promise<void> {
  const { run } = ctx;
  const { workspaceId, topic, planPath, leadProvider, reviewerProvider, turnTimeoutMs } = run;
  // Resume is signalled by leadId/reviewerId already being set at entry (DB
  // rehydrate or structured resume-id params).
  const resumeLeadId = run.leadId;
  const resumeReviewerId = run.reviewerId;

  let lead: Agent;
  let reviewer: Agent | null = null;
  let firstLeadMsg: RelayMessage | null = null;

  if (resumeLeadId) {
    const existing = client.getAgent(resumeLeadId);
    if (!existing) throw new Error(`Resume lead ${resumeLeadId} not found`);
    lead = existing;
    await seedLastRelayedTsFromChat(client, ctx, lead.id, 'Lead');
  } else {
    lead = await launchAgentWithKickoff(client, ctx, {
      workspaceId,
      title: 'Lead Planner (GroupThink)',
      roleDescription: 'Lead planner in charge of making the final call. You will receive feedback from a reviewer.',
      provider: leadProvider,
      kickoffPrompt: serialLeadPrompt(topic, planPath),
    });
    run.leadId = lead.id;
    ctx.persist();
  }

  if (resumeReviewerId) {
    const existing = client.getAgent(resumeReviewerId);
    if (!existing) throw new Error(`Resume reviewer ${resumeReviewerId} not found`);
    reviewer = existing;
    await seedLastRelayedTsFromChat(client, ctx, reviewer.id, 'Reviewer');
  } else {
    // BUG-29 mitigation: wait for the Lead's first draft before launching the
    // Reviewer, then launch with that draft as the kickoff.
    firstLeadMsg = await waitTurnComplete(client, ctx, lead.id, 'Lead', turnTimeoutMs);
    run.lastRelayedTs[lead.id] = firstLeadMsg.ts;
    run.turn = 1;
    ctx.persist();
    ctx.emit('turn', { turn: 1 });

    if (fs.existsSync(planPath)) {
      // Plan written after Lead turn 1 — terminate before launching Reviewer.
      return;
    }

    reviewer = await launchAgentWithKickoff(client, ctx, {
      workspaceId,
      title: 'Reviewer (GroupThink)',
      roleDescription: 'Reviewer agent providing feedback to the Lead Planner.',
      provider: reviewerProvider,
      kickoffPrompt: serialReviewerKickoff(topic, firstLeadMsg.content),
    });
    run.reviewerId = reviewer.id;
    ctx.persist();
  }

  if (!reviewer) throw new Error('Reviewer unavailable after launch');

  // Relay loop. Fresh launch already did Lead turn 1 + delivered it as the
  // Reviewer kickoff, so the loop starts at "wait for Reviewer". Resume seeds
  // both highwater marks and starts at the Reviewer-first edge.
  let turn = firstLeadMsg ? 1 : 0;
  let planWritten = false;

  while (turn < MAX_TURNS) {
    turn++;
    run.turn = turn;
    ctx.emit('turn', { turn });

    // Reviewer -> Lead
    const revMsg = await waitTurnComplete(client, ctx, reviewer.id, 'Reviewer', turnTimeoutMs);
    run.lastRelayedTs[reviewer.id] = revMsg.ts;
    ctx.persist();

    if (fs.existsSync(planPath)) { planWritten = true; break; }
    await waitReceiverReady(client, ctx, lead.id, 'Lead', turnTimeoutMs);
    await client.sendInput(lead.id,
      `Reviewer Feedback:\n\n${revMsg.content}\n\nRespond to this feedback or finalize the plan.`);

    // Lead -> Reviewer
    const leadMsg = await waitTurnComplete(client, ctx, lead.id, 'Lead', turnTimeoutMs);
    run.lastRelayedTs[lead.id] = leadMsg.ts;
    ctx.persist();

    if (fs.existsSync(planPath)) { planWritten = true; break; }
    await waitReceiverReady(client, ctx, reviewer.id, 'Reviewer', turnTimeoutMs);
    await client.sendInput(reviewer.id,
      `Feedback from Lead Planner:\n\n${leadMsg.content}\n\nWhat is your review?`);
  }

  if (!planWritten && turn >= MAX_TURNS) {
    throw new Error('STALL: Max turns reached without plan completion.');
  }
}

// --- Mode: Parallel (groupthink-v2.js:550–640) ---
export async function runParallel(client: DashboardClient, ctx: OrchestrationRunContext): Promise<void> {
  const { run } = ctx;
  const { workspaceId, topic, planPath, leadProvider, reviewerProvider, turnTimeoutMs } = run;

  // R1: both launch with the same prompt; kick off in parallel. The synthesizer
  // is the lead-provider (writes the plan in R3); the peer is the reviewer side.
  const r1Prompt = parallelR1Prompt(topic);
  const [synthesizer, peer] = await Promise.all([
    launchAgentWithKickoff(client, ctx, {
      workspaceId,
      title: `Synthesizer ${leadProvider} (GroupThink //)`,
      roleDescription: 'Independent planner; will synthesize the final plan in R3.',
      provider: leadProvider,
      kickoffPrompt: r1Prompt,
    }),
    launchAgentWithKickoff(client, ctx, {
      workspaceId,
      title: `Planner ${reviewerProvider} (GroupThink //)`,
      roleDescription: 'Independent planner contributing a cross-provider perspective.',
      provider: reviewerProvider,
      kickoffPrompt: r1Prompt,
    }),
  ]);
  run.leadId = synthesizer.id;     // synthesizer maps to the 'lead' member slot
  run.reviewerId = peer.id;        // peer maps to the 'reviewer' member slot
  run.round = 1;
  ctx.persist();
  ctx.emit('round', { round: 1 });

  const [synthR1, peerR1] = await Promise.all([
    waitTurnComplete(client, ctx, synthesizer.id, 'Synthesizer R1', turnTimeoutMs),
    waitTurnComplete(client, ctx, peer.id, 'Peer R1', turnTimeoutMs),
  ]);
  run.lastRelayedTs[synthesizer.id] = synthR1.ts;
  run.lastRelayedTs[peer.id] = peerR1.ts;
  ctx.persist();

  // Premature-write check: if either agent wrote the plan in R1 treat it as
  // accidental termination rather than clobber it with later rounds.
  if (fs.existsSync(planPath)) return;

  // R2: each sees the other's R1 and reacts (parallel).
  run.round = 2;
  ctx.emit('round', { round: 2 });
  await Promise.all([
    (async () => {
      await waitReceiverReady(client, ctx, synthesizer.id, 'Synthesizer', turnTimeoutMs);
      await client.sendInput(synthesizer.id, parallelR2Prompt(peerR1.content));
    })(),
    (async () => {
      await waitReceiverReady(client, ctx, peer.id, 'Peer', turnTimeoutMs);
      await client.sendInput(peer.id, parallelR2Prompt(synthR1.content));
    })(),
  ]);

  // Only the peer's R2 content is needed for R3; the synthesizer's R2 is already
  // in its own context.
  const [, peerR2] = await Promise.all([
    waitTurnComplete(client, ctx, synthesizer.id, 'Synthesizer R2', turnTimeoutMs),
    waitTurnComplete(client, ctx, peer.id, 'Peer R2', turnTimeoutMs),
  ]);
  run.lastRelayedTs[peer.id] = peerR2.ts;
  ctx.persist();

  if (fs.existsSync(planPath)) return;

  // R3: synthesizer-only. Hand it the peer's R2 with synthesis + write-plan
  // instructions; wait for the plan file or its turnComplete.
  run.round = 3;
  ctx.emit('round', { round: 3 });
  await waitReceiverReady(client, ctx, synthesizer.id, 'Synthesizer', turnTimeoutMs);
  await client.sendInput(synthesizer.id, parallelSynthesisPrompt(peerR2.content, planPath));

  const synthR3 = await waitTurnComplete(client, ctx, synthesizer.id, 'Synthesizer R3', turnTimeoutMs);
  run.lastRelayedTs[synthesizer.id] = synthR3.ts;
  ctx.persist();

  if (!fs.existsSync(planPath)) {
    throw new Error(`STALL: Synthesizer completed R3 but no plan file at ${planPath}.`);
  }
}
