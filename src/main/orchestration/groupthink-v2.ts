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
import { createHash } from 'crypto';
import { Agent, AgentProvider, LaunchAgentInput } from '../../shared/types';
import {
  DashboardClient, OrchestrationRunContext, SendInputConfirmedResult, SubmitRecoveryPolicy,
  OrchestrationRun,
} from './types';
import { withResolvedPlanStamp, type DispatchContext } from '../git-checkpoints/dispatch-context';
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
// T4 §2: grace window to let the synthesizer's plan-file Write flush land after
// its R3 turn-complete chat event before declaring a no_plan_written stall.
const PLAN_WRITE_GRACE_MS = 30000;

const runDispatches = new WeakMap<OrchestrationRun, DispatchContext>();

/** Resolve the orchestration binding once per live run object and reuse that
 * trusted context for kickoff and every relay/follow-up send. Persisted binding
 * fields make a rehydrated run resolve to the same stamp after restart. */
export function getOrchestrationDispatch(run: OrchestrationRun): DispatchContext {
  const existing = runDispatches.get(run);
  if (existing) return existing;
  const mode = run.planBindingMode ?? (run.planId ? 'explicit' : 'agent-default');
  const dispatch = withResolvedPlanStamp(
    { origin: 'orchestration', ownerAgentId: run.supervisorId },
    {
      planId: run.planId ?? null,
      // SC-WP-3A: an explicit plan+item run carries its validated item; a
      // plan-only or default run stays item-less.
      planItemId: run.planItemId ?? null,
      source: mode,
    },
  );
  runDispatches.set(run, dispatch);
  return dispatch;
}

// --- Dropped-submit recovery (handshake robustness) — EXPERIMENT variants ---
// When a worker send returns UNCONFIRMED (no hook + no working flip — the codex
// turn-1 kickoff signature, where usesSubmitConfirmation is false so the dashboard
// never re-pressed), the V1/V2 variants recover a dropped Enter by re-pressing the
// submit-only keystroke while the agent is still demonstrably idle, then re-check.
// Bounded + evidence-gated so a turn that actually started is never re-pressed into.
// These are the production defaults from plans/groupthink-handshake-fix.md §4a; the
// pressure harness overrides them per-run (run.submitRecoveryWindow) so the
// real-time F-F delay sweep runs in milliseconds.
const SUBMIT_RESEND_ATTEMPTS = 3;
const SUBMIT_RESEND_RECHECK_MS = 10_000;  // watch window after each re-press
const SUBMIT_RESEND_POLL_MS = 1_000;
// WP1/BUG-37: after a forced chat-binding recovery at the stall deadline, re-poll
// for this bounded window before conceding the timeout. Chat rebind / ring
// repopulation is seconds (dispatcher ticks are ~1s) — do NOT extend this to a
// full status-check cycle; the goal is to catch a completed-but-blacked-out turn,
// not to wait out a genuinely slow one.
const RECOVERY_REPOLL_MS = 15_000;
// Relaunch budget for a kickoff whose submit is unrecoverable. 2 = one fresh
// relaunch after the first member fails. Relays do NOT relaunch.
const KICKOFF_LAUNCH_ATTEMPTS = 2;

interface RecoveryWindow { attempts: number; recheckMs: number; pollMs: number; }
function recoveryWindow(ctx: OrchestrationRunContext): RecoveryWindow {
  const w = ctx.run.submitRecoveryWindow;
  return {
    attempts: w?.attempts ?? SUBMIT_RESEND_ATTEMPTS,
    recheckMs: w?.recheckMs ?? SUBMIT_RESEND_RECHECK_MS,
    pollMs: w?.pollMs ?? SUBMIT_RESEND_POLL_MS,
  };
}
function recoveryPolicy(ctx: OrchestrationRunContext): SubmitRecoveryPolicy {
  // Production default (2026-07-01): 'recover-fallthrough' — confirmed handshake +
  // evidence-gated dropped-Enter recovery, falling through to waitTurnComplete on
  // exhaustion (never a fast throw; see plans/groupthink-handshake-fix-readiness-review.md).
  // 'raw' (bug-repro baseline) and 'recover-throw' (negative control) are set
  // explicitly only by the pressure harness; they are never request-driven.
  return ctx.run.submitRecoveryPolicy ?? 'recover-fallthrough';
}

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

// --- T1: composite highwater (ts + content hash) tie-break ---
// A same-millisecond turn-complete is no longer dropped unconditionally: it is
// dropped only if its content hash also matches the stored mark. The highwater
// is packed into the existing lastRelayedTs JSON-map value as "<ts><sep><hash>".
const HW_SEP = String.fromCharCode(1);   // U+0001 separator: cannot appear in ISO or agent#NNNN timestamps
function hashContent(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}
function markRelayed(ctx: OrchestrationRunContext, agentId: string, msg: RelayMessage): void {
  ctx.run.lastRelayedTs[agentId] = `${msg.ts}${HW_SEP}${hashContent(msg.content)}`;
}
function parseHighwater(raw?: string): { ts: string; hash?: string } | null {
  if (!raw) return null;
  const i = raw.indexOf(HW_SEP);
  return i === -1 ? { ts: raw } : { ts: raw.slice(0, i), hash: raw.slice(i + 1) };
}

// --- T2: archive a stale pre-existing plan file before a fresh run starts ---
// A leftover plan from an earlier run at the same path would otherwise trip the
// fs.existsSync(planPath) gate after the lead's first turn and complete the run
// on the OLD file with zero deliberation. Archiving (rename, non-destructive)
// runs at start_run BEFORE the run row is persisted, so a failed archive can
// refuse the start before any run exists to error later.
export function archiveStalePlan(planPath: string, runId: string): string | null {
  if (!planPath || !fs.existsSync(planPath)) return null;
  const bak = `${planPath}.stale-${runId}-${Date.now()}.bak`;
  try { fs.renameSync(planPath, bak); return bak; }
  catch (e) {
    throw new Error(`Refusing to start run ${runId}: stale plan at ${planPath} could not be archived (${e instanceof Error ? e.message : e}).`);
  }
}

// --- WP6: done-detection (whole-file existsSync → section-anchor changed) ---
// The legacy deliverable is a fresh plan FILE appearing at planPath; a
// planning-surface run instead edits ONE section of an EXISTING surface (the
// file was written up front by create_plan), so existsSync(planPath) is already
// true at turn 1 and would complete the run with zero deliberation. For a
// rail-carrying run we ask the DB (via the client's plan_section_changes lookup,
// WP4) whether the dispatched section's byte-exact content hash has moved since
// the run started; rail-less runs keep the exact fresh-file semantics.
function planDeliverableReady(client: DashboardClient, ctx: OrchestrationRunContext): boolean {
  const { run } = ctx;
  if (run.planId && run.sectionAnchor) {
    return client.sectionChangedSince(run.planId, run.sectionAnchor, run.startedAt);
  }
  return fs.existsSync(run.planPath);
}

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
  const hw = parseHighwater(ctx.run.lastRelayedTs[agentId]);
  if (hw) {
    if (msg.ts < hw.ts) return null;
    if (msg.ts === hw.ts) {
      // legacy hash-less highwater → preserve old <= behavior; else tie-break on content
      if (!hw.hash || hashContent(msg.content) === hw.hash) return null;
    }
  }
  return msg;
}

/** BUG-06: seed the highwater mark from the latest assistant message so the
 *  first wait blocks on genuinely new content rather than re-relaying a
 *  pre-existing turnComplete (matters after a fresh/BUG-29 launch).
 *
 *  WP2/BUG-37 CAUTION: do NOT call this on resume when a USABLE persisted
 *  highwater already exists. On resume the persisted mark IS the truth; re-seeding
 *  from chat marks the newest turnComplete as already-relayed — and if a Reviewer
 *  turn completed DURING the stall, that turn is precisely the newest one, so
 *  re-seeding swallows it and waitTurnComplete then waits forever for a
 *  working→idle edge that already passed (BUG-37's un-resumability). Resume seeds
 *  only when the mark is absent/corrupt; agents with a usable mark stay protected
 *  by the mark itself, so the BUG-06/BUG-29 stale-content guard still holds. */
async function seedLastRelayedTsFromChat(
  client: DashboardClient, ctx: OrchestrationRunContext, agentId: string, _label: string,
): Promise<void> {
  const msgs = await client.getMessages(agentId, { limit: 1, role: 'assistant' });
  const msg = msgs?.[0];
  if (msg && msg.turnComplete && msg.ts) {
    markRelayed(ctx, agentId, msg);
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
  let recoveryAttempted = false;   // WP1: exactly one recovery cycle per invocation
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
      // status is idle/waiting at the deadline — the BUG-37 chat-blackout
      // signature: the codex turn completed on disk but the reader was never
      // sid-bound, so readNextMessage saw nothing and the working→idle edge that
      // would have reset the stall clock already passed. Before conceding, force
      // ONE chat-binding recovery and re-poll for a bounded window. Exactly one
      // recovery cycle per waitTurnComplete invocation (guarded by
      // recoveryAttempted) so a permanent blackout still times out promptly.
      if (!recoveryAttempted) {
        recoveryAttempted = true;
        client.recoverChatBinding(agentId);
        const repollDeadline = Date.now() + (ctx.run.recoveryRepollMs ?? RECOVERY_REPOLL_MS);
        for (;;) {
          checkAborted(ctx);
          const recovered = await readNextMessage(client, ctx, agentId);
          if (recovered) return recovered;
          const s = client.getAgent(agentId)?.status;
          if (s === 'crashed' || s === 'done') {
            throw new Error(`${label} (${agentId}) exited with status=${s} before completing turn`);
          }
          if (s === 'working') {
            // Status caught up during recovery — the turn is genuinely still
            // running. Reset the clock and rejoin the main loop.
            stallDeadline = Date.now() + timeoutMs;
            lastStatusCheck = Date.now();
            break;
          }
          if (Date.now() >= repollDeadline) {
            // Still empty after recovery — a real stall, not a blackout. Tag the
            // message so post-fix stalls are distinguishable from pre-fix ones.
            throw new Error(`Timeout waiting for ${label} (${agentId}) to complete turn (agent.status=${s}, post-recovery re-poll empty)`);
          }
          await sleep(POLL_INTERVAL_MS);
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      throw new Error(`Timeout waiting for ${label} (${agentId}) to complete turn (agent.status=${status})`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

/** T4 §2: poll for the deliverable over a bounded grace window after the
 *  synthesizer's R3 turn-complete. The write flush (native Edit or fresh-file
 *  Write) trails the turn-complete chat event by a sub-second window, so an
 *  immediate check throws a false no_plan_written stall while the deliverable
 *  lands moments later. Returns true as soon as the deliverable is observed
 *  (WP6: a fresh file for legacy runs, OR the dispatched section's content-hash
 *  change for a plan-rail run — the change row lands only after the watcher
 *  reparses, so this grace window also spans that async gap); false once the
 *  grace deadline passes. Abort stays responsive via per-poll checkAborted. */
async function waitForDeliverable(
  client: DashboardClient, ctx: OrchestrationRunContext, graceMs: number,
): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    if (planDeliverableReady(client, ctx)) return true;
    if (Date.now() >= deadline) return false;
    checkAborted(ctx);
    await sleep(POLL_INTERVAL_MS);
  }
}

// --- Dropped-submit recovery helpers (EXPERIMENT: V1/V2) ---

/** Has the receiver demonstrably moved past `baselineTs` since our send — a turn
 *  started, output began streaming, or the agent died? Any of these means STOP
 *  re-pressing Enter: a re-press into an active/started turn would inject a stray
 *  empty submit. A status flip (working/crashed/done) OR ANY assistant message
 *  newer than baseline (even a not-yet-complete turn) counts. Only a still-idle
 *  agent with no new assistant activity is treated as a genuine dropped Enter.
 *  This is the gate that makes throwing on exhaustion safe: it catches codex's
 *  status lag via the message stream before confirmedSend ever gives up. */
async function submitTookEffect(
  client: DashboardClient, agentId: string, baselineTs: string,
): Promise<boolean> {
  const status = client.getAgent(agentId)?.status;
  if (status === 'working' || status === 'crashed' || status === 'done') return true;
  const msgs = await client.getMessages(agentId, { limit: 1, role: 'assistant' });
  const m = msgs?.[0];
  return !!(m && m.ts > baselineTs);
}

/** Robust worker send (V1/V2). Goes through the confirmed handshake; on an
 *  UNCONFIRMED result it recovers a dropped Enter by re-pressing the submit-only
 *  keystroke while the agent is still idle. RESOLVES once the turn is confirmed
 *  or evidence shows it started. On EXHAUSTION the behavior is policy-dependent:
 *    - 'recover-throw'       → throw a `STALL:`-prefixed delivery error (fast,
 *      explicit, → service maps to 'stalled' + resume hint).
 *    - 'recover-fallthrough' → emit the failure event and RETURN, letting the
 *      caller's waitTurnComplete backstop ride it out (a slow-but-healthy turn
 *      surfaces there; a truly dead prompt burns to turnTimeoutMs).
 *  Hard failures (send threw — delivery-failed / SubmitNotConfirmedError) are
 *  re-raised untouched under BOTH policies so the kickoff caller can relaunch. */
async function confirmedSend(
  client: DashboardClient, ctx: OrchestrationRunContext,
  agentId: string, label: string, text: string,
): Promise<void> {
  const policy = recoveryPolicy(ctx);
  const win = recoveryWindow(ctx);
  // Baseline = the agent's last RELAYED turn ts (seeded pre-kickoff, or set after
  // the previous relay). Any assistant ts beyond it means a new turn started.
  const baselineTs = parseHighwater(ctx.run.lastRelayedTs[agentId])?.ts ?? '';

  let res: SendInputConfirmedResult;
  try {
    res = await client.sendInputConfirmed(agentId, text, getOrchestrationDispatch(ctx.run));
  } catch (err) {
    ctx.emit('delivery_failed', { agentId, label, reason: 'send-threw', error: err instanceof Error ? err.message : String(err) });
    throw err;   // hard failure — re-raise untouched (kickoff relaunches)
  }
  if (res.confirmed) return;   // hook / status-poll proof — turn started

  // UNCONFIRMED — the dropped-submit window. Re-press Enter, but only while the
  // agent is still idle with no new turn; bail the moment the submit took effect.
  for (let attempt = 1; attempt <= win.attempts; attempt++) {
    checkAborted(ctx);
    if (await submitTookEffect(client, agentId, baselineTs)) return;
    console.warn(`[groupthink] ${label} (${agentId}) submit unconfirmed — re-pressing Enter (${attempt}/${win.attempts})`);
    client.resubmitEnter(agentId);
    const deadline = Date.now() + win.recheckMs;
    while (Date.now() < deadline) {
      checkAborted(ctx);
      await sleep(win.pollMs);
      if (await submitTookEffect(client, agentId, baselineTs)) return;
    }
  }
  // Re-press exhausted, still no evidence the turn started.
  ctx.emit('delivery_failed', { agentId, label, reason: 'submit-unconfirmed-after-resend', attempts: win.attempts });
  if (policy === 'recover-throw') {
    throw new Error(`STALL: ${label} input delivery unconfirmed after ${win.attempts} re-press attempts (prompt typed but no turn started)`);
  }
  // 'recover-fallthrough' — let waitTurnComplete be the backstop.
}

/** Single send entry point used by the relay loop. V0 ('raw') keeps the exact
 *  legacy behavior (client.sendInput, no handshake); V1/V2 route through
 *  confirmedSend. Production default is 'recover-fallthrough' (V1), so real runs
 *  take the confirmed-handshake path; only the pressure harness opts into 'raw'. */
async function sendWorker(
  client: DashboardClient, ctx: OrchestrationRunContext,
  agentId: string, label: string, text: string,
): Promise<void> {
  if (recoveryPolicy(ctx) === 'raw') {
    await client.sendInput(agentId, text, getOrchestrationDispatch(ctx.run));
    return;
  }
  await confirmedSend(client, ctx, agentId, label, text);
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
  // Agent-ownership primitive: the supervisor that owns this GroupThink member.
  // Stamped uniformly as run.supervisorId across serial AND parallel modes so
  // the lead/reviewer (or both parallel planners) nest as siblings under their
  // supervisor's owner-container. launchAgent re-validates the edge.
  ownerAgentId?: string;
}

// WP3 (codex-groupthink-reliability-hardening): the codex session-discovery
// prefix derived from the kickoff prompt. CRLF is normalized to LF (guards
// against line-ending divergence between what we paste and what codex records
// in threads.first_user_message) and the prefix is capped at 512 chars — long
// enough to reach past a shared `Topic:` header into run-specific material so
// two concurrent same-cwd same-role runs on different topics get distinct
// prefixes. NO leading trim and NO first-line truncation: the stored first
// user message is the verbatim submitted text, so the prefix must be too.
function kickoffPrefix(s: string): string {
  return s.replace(/\r\n/g, '\n').slice(0, 512);
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
    ownerAgentId: opts.ownerAgentId,
    // notifyOwner mute — GroupThink members stay OWNED by the launching
    // supervisor (grouping, investigation authority, and the terminal-owner
    // structural backstop are all preserved) but their per-turn lifecycle
    // events are suppressed at the EventBridge choke point.
    //
    // Rationale: inside a deliberation, working → idle is the ORCHESTRATOR's
    // signal — it is how this script knows a member finished a turn and it is
    // time to relay the message to the other member. Those flips happen once
    // per round per member and mean nothing to the supervisor, which is not
    // driving the relay. The supervisor's real signals are the run-level ones
    // this orchestration emits itself: the final written artifact, or a stall /
    // failure. Leaving the mute off made every GroupThink run spam its
    // launcher with a dozen turn-end events it must read and discard.
    notifyOwner: false,
    // WP6 planning-surface rail: stamp the run's plan_id/section onto EVERY
    // launched member (lead, reviewer, both parallel planners). The supervisor
    // launch rail (WP1) injects these into AGENT_DASHBOARD_PLAN_ID /
    // _PLAN_SECTION at BOTH env sites (native extraEnv + WSL wslEnvPrefix) so a
    // member's read/edit breadcrumbs and Stop-composed plan_events attribute to
    // the right plan + dispatched section. Undefined for rail-less runs.
    planId: ctx.run.planId,
    planSection: ctx.run.sectionAnchor,
    // WP3: bind codex session discovery to this run's kickoff, so a
    // concurrent same-cwd codex session on a different topic/role can't be
    // mis-bound. Harmless for non-codex providers (ignored downstream).
    firstUserMessagePrefix: kickoffPrefix(kickoffPrompt),
  };

  // V0 ('raw') — legacy path verbatim: launch, waitReady, submit kickoff via
  // sendInput, seed AFTER the send. Reproduces the dropped-kickoff bug.
  if (recoveryPolicy(ctx) === 'raw') {
    const agent = await client.launchAgent(launchInput);
    // All providers get the kickoff as a SUBMITTED message (not a launch-time
    // systemPrompt). A submitted message arms the worker working-status latch;
    // a systemPrompt would not, leaving a supervised card stuck on `idle`.
    await waitReady(client, ctx, agent.id, title);
    await client.sendInput(agent.id, kickoffPrompt, getOrchestrationDispatch(ctx.run));
    await seedLastRelayedTsFromChat(client, ctx, agent.id, title);
    return agent;
  }

  // V1/V2 — kickoff goes through the CONFIRMED handshake with runner-level
  // dropped-Enter recovery + one relaunch. A kickoff whose submit is
  // unrecoverable (hard failure OR — under 'recover-throw' — re-press exhausted
  // with no evidence) tears the member down and launches a fresh one once.
  // confirmedSend throws on both of those; we relaunch while budget remains, then
  // re-raise on the final attempt. The highwater is seeded from the PRE-kickoff
  // snapshot BEFORE the send (BUG-06) so a turn-complete that lands DURING
  // confirmedSend's wait is still relayed by the caller's waitTurnComplete rather
  // than mistaken for an old turn (seeding after would pin the mark on the real
  // kickoff answer → a new stall).
  let lastErr: unknown;
  for (let attempt = 1; attempt <= KICKOFF_LAUNCH_ATTEMPTS; attempt++) {
    const last = attempt === KICKOFF_LAUNCH_ATTEMPTS;
    const agent = await client.launchAgent(launchInput);
    await waitReady(client, ctx, agent.id, title);
    await seedLastRelayedTsFromChat(client, ctx, agent.id, title);
    try {
      await confirmedSend(client, ctx, agent.id, title, kickoffPrompt);
      return agent;   // confirmed, evidence the turn started, or fall-through
    } catch (err) {
      lastErr = err;
      console.warn(`[groupthink] kickoff to ${title} failed (attempt ${attempt}/${KICKOFF_LAUNCH_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}`);
      await client.stopAgent(agent.id).catch(() => {});
      if (last) throw err;   // out of relaunch budget — propagate (→ stalled)
      // else loop: relaunch a fresh member for the kickoff
    }
  }
  // Unreachable (last attempt always returns or throws); satisfies the checker.
  throw new Error(`Kickoff to ${title} exhausted ${KICKOFF_LAUNCH_ATTEMPTS} attempts${lastErr ? `: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` : ''}`);
}

// --- Mode: Serial (groupthink-v2.js:448–547) ---
export async function runSerial(client: DashboardClient, ctx: OrchestrationRunContext): Promise<void> {
  const { run } = ctx;
  const { workspaceId, topic, planPath, sectionAnchor, leadProvider, reviewerProvider, turnTimeoutMs } = run;
  // Resume is signalled by leadId/reviewerId already being set at entry (DB
  // rehydrate or structured resume-id params).
  const resumeLeadId = run.leadId;
  const resumeReviewerId = run.reviewerId;

  // T2 defensive guard (covers direct-runner callers + the pressure tests):
  // archive a stale plan only on a genuinely fresh run, never on resume.
  // WP6: never archive a plan-rail surface — it is the EXISTING create_plan
  // artifact this run edits into, not a leftover to clear.
  if (!resumeLeadId && !resumeReviewerId && !run.planId) archiveStalePlan(planPath, run.runId);

  let lead: Agent;
  let reviewer: Agent | null = null;
  let firstLeadMsg: RelayMessage | null = null;

  if (resumeLeadId) {
    const existing = client.getAgent(resumeLeadId);
    if (!existing) throw new Error(`Resume lead ${resumeLeadId} not found`);
    lead = existing;
    // WP2/BUG-37: seed ONLY when there is no usable persisted highwater. A usable
    // mark (non-empty ts; legacy hashless marks count, blank/separator-only
    // corruption does not) is the resume truth — re-seeding from chat would pin
    // the newest turn as already-relayed and re-stall.
    if (!parseHighwater(run.lastRelayedTs[lead.id])?.ts) {
      await seedLastRelayedTsFromChat(client, ctx, lead.id, 'Lead');
    }
  } else {
    lead = await launchAgentWithKickoff(client, ctx, {
      workspaceId,
      title: 'Lead Planner (GroupThink)',
      roleDescription: 'Lead planner in charge of making the final call. You will receive feedback from a reviewer.',
      provider: leadProvider,
      kickoffPrompt: serialLeadPrompt(topic, planPath, sectionAnchor, run.planId),
      ownerAgentId: run.supervisorId,
    });
    run.leadId = lead.id;
    ctx.persist();
  }

  if (resumeReviewerId) {
    const existing = client.getAgent(resumeReviewerId);
    if (!existing) throw new Error(`Resume reviewer ${resumeReviewerId} not found`);
    reviewer = existing;
    // WP2/BUG-37: seed only when no usable persisted highwater exists (see the Lead
    // resume above). A Reviewer turn that completed during the stall has ts newer
    // than the persisted mark, so the first readNextMessage returns it — the
    // un-resumability is fixed with no idle special-casing.
    if (!parseHighwater(run.lastRelayedTs[reviewer.id])?.ts) {
      await seedLastRelayedTsFromChat(client, ctx, reviewer.id, 'Reviewer');
    }
  } else {
    // BUG-29 mitigation: wait for the Lead's first draft before launching the
    // Reviewer, then launch with that draft as the kickoff.
    firstLeadMsg = await waitTurnComplete(client, ctx, lead.id, 'Lead', turnTimeoutMs);
    markRelayed(ctx, lead.id, firstLeadMsg);
    run.turn = 1;
    ctx.persist();
    ctx.emit('turn', { turn: 1 });

    if (planDeliverableReady(client, ctx)) {
      // Deliverable landed after Lead turn 1 — terminate before launching Reviewer.
      return;
    }

    reviewer = await launchAgentWithKickoff(client, ctx, {
      workspaceId,
      title: 'Reviewer (GroupThink)',
      roleDescription: 'Reviewer agent providing feedback to the Lead Planner.',
      provider: reviewerProvider,
      kickoffPrompt: serialReviewerKickoff(topic, firstLeadMsg.content, sectionAnchor, run.planId),
      ownerAgentId: run.supervisorId,
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
    markRelayed(ctx, reviewer.id, revMsg);
    ctx.persist();

    if (planDeliverableReady(client, ctx)) { planWritten = true; break; }
    await waitReceiverReady(client, ctx, lead.id, 'Lead', turnTimeoutMs);
    await sendWorker(client, ctx, lead.id, 'Lead',
      `Reviewer Feedback:\n\n${revMsg.content}\n\nRespond to this feedback or finalize the plan.`);

    // Lead -> Reviewer
    const leadMsg = await waitTurnComplete(client, ctx, lead.id, 'Lead', turnTimeoutMs);
    markRelayed(ctx, lead.id, leadMsg);
    ctx.persist();

    if (planDeliverableReady(client, ctx)) { planWritten = true; break; }
    await waitReceiverReady(client, ctx, reviewer.id, 'Reviewer', turnTimeoutMs);
    await sendWorker(client, ctx, reviewer.id, 'Reviewer',
      `Feedback from Lead Planner:\n\n${leadMsg.content}\n\nWhat is your review?`);
  }

  if (!planWritten && turn >= MAX_TURNS) {
    throw new Error('STALL: Max turns reached without plan completion.');
  }
}

// --- Mode: Parallel (groupthink-v2.js:550–640) ---
export async function runParallel(client: DashboardClient, ctx: OrchestrationRunContext): Promise<void> {
  const { run } = ctx;
  const { workspaceId, topic, planPath, sectionAnchor, leadProvider, reviewerProvider, turnTimeoutMs } = run;

  // T2 defensive guard: parallel has no resume path, so always archive a stale
  // pre-existing plan before R1 can trip the premature-write existsSync gate.
  // WP6: except for a plan-rail run, whose surface legitimately pre-exists.
  if (!run.planId) archiveStalePlan(planPath, run.runId);

  // R1: both launch with the same prompt; kick off in parallel. The synthesizer
  // is the lead-provider (writes the plan in R3); the peer is the reviewer side.
  const r1Prompt = parallelR1Prompt(topic, sectionAnchor, run.planId);
  const [synthesizer, peer] = await Promise.all([
    launchAgentWithKickoff(client, ctx, {
      workspaceId,
      title: `Synthesizer ${leadProvider} (GroupThink //)`,
      roleDescription: 'Independent planner; will synthesize the final plan in R3.',
      provider: leadProvider,
      kickoffPrompt: r1Prompt,
      ownerAgentId: run.supervisorId,
    }),
    launchAgentWithKickoff(client, ctx, {
      workspaceId,
      title: `Planner ${reviewerProvider} (GroupThink //)`,
      roleDescription: 'Independent planner contributing a cross-provider perspective.',
      provider: reviewerProvider,
      kickoffPrompt: r1Prompt,
      ownerAgentId: run.supervisorId,
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
  markRelayed(ctx, synthesizer.id, synthR1);
  markRelayed(ctx, peer.id, peerR1);
  ctx.persist();

  // Premature-write check: if either agent wrote the plan in R1 treat it as
  // accidental termination rather than clobber it with later rounds.
  if (planDeliverableReady(client, ctx)) return;

  // R2: each sees the other's R1 and reacts (parallel).
  run.round = 2;
  ctx.emit('round', { round: 2 });
  await Promise.all([
    (async () => {
      await waitReceiverReady(client, ctx, synthesizer.id, 'Synthesizer', turnTimeoutMs);
      await sendWorker(client, ctx, synthesizer.id, 'Synthesizer', parallelR2Prompt(peerR1.content, sectionAnchor, run.planId));
    })(),
    (async () => {
      await waitReceiverReady(client, ctx, peer.id, 'Peer', turnTimeoutMs);
      await sendWorker(client, ctx, peer.id, 'Peer', parallelR2Prompt(synthR1.content, sectionAnchor, run.planId));
    })(),
  ]);

  // Only the peer's R2 content is fed into R3, but we must still capture AND mark
  // the synthesizer's R2 highwater (T4 §1): discarding it left synth's mark pinned
  // at synthR1, so R3's waitTurnComplete would return the stale R2 turn-complete as
  // if it were R3 — R3's synthesis output never awaited, plan never written.
  const [synthR2, peerR2] = await Promise.all([
    waitTurnComplete(client, ctx, synthesizer.id, 'Synthesizer R2', turnTimeoutMs),
    waitTurnComplete(client, ctx, peer.id, 'Peer R2', turnTimeoutMs),
  ]);
  markRelayed(ctx, synthesizer.id, synthR2);
  markRelayed(ctx, peer.id, peerR2);
  ctx.persist();

  if (planDeliverableReady(client, ctx)) return;

  // R3: synthesizer-only. Hand it the peer's R2 with synthesis + write-plan
  // instructions; wait for the plan file or its turnComplete.
  run.round = 3;
  ctx.emit('round', { round: 3 });
  await waitReceiverReady(client, ctx, synthesizer.id, 'Synthesizer', turnTimeoutMs);
  await sendWorker(client, ctx, synthesizer.id, 'Synthesizer', parallelSynthesisPrompt(peerR2.content, planPath, sectionAnchor, run.planId));

  const synthR3 = await waitTurnComplete(client, ctx, synthesizer.id, 'Synthesizer R3', turnTimeoutMs);
  markRelayed(ctx, synthesizer.id, synthR3);
  ctx.persist();

  if (!(await waitForDeliverable(client, ctx, PLAN_WRITE_GRACE_MS))) {
    const what = run.planId && sectionAnchor
      ? `no content change in section ${sectionAnchor} of plan ${run.planId}`
      : `no plan file at ${planPath}`;
    throw new Error(`STALL: Synthesizer completed R3 but ${what} after ${PLAN_WRITE_GRACE_MS}ms grace.`);
  }
}
