// TEST FIXTURE — the four prose spans rewritten by the v12 → v13 supervisor
// event-noise bump.
//
// Kept verbatim so scaffold-version-migration.test.ts can RECONSTRUCT the pristine
// v12 CLAUDE.md byte-exactly and prove it hashes to SUPERVISOR_AGENT_MD_V12_HASH —
// the registered previousHashes entry that makes v12 → v13 a SILENT upgrade instead
// of a .bak + overwrite of every existing workspace.
//
// Each V13_* / V12_* pair is a plain string swap (first occurrence), not a regex:
// these spans contain backticks and em dashes, and a regex over them is a
// maintenance trap. The CP-0 hash pin is what proves the swaps actually landed.
//
// This file is test data, not guidance. The V12_* strings are SUPERSEDED wording —
// they describe the pre-bump behavior (three context tiers, `done` events) that no
// longer exists. Never copy them back into a persona.

/* eslint-disable */

/** v13: the Automatic-Events turn-end bullet. `done` is no longer delivered at
 *  all, so the bullet names only `idle` and says so explicitly. */
export const V13_TURN_END_BULLET = `- **idle**: A worker finished a turn (working → idle). This is the ONLY turn-end event you get — a clean process exit (\`done\`) is deliberately silent, because the idle event already carried the hand-off. Read the agent's final assistant message via \`read_agent_chat(agent_id, role: 'assistant', limit: 1)\` — clean structured chat, no PTY noise.`;

/** v12: the same bullet when `done` still produced its own event. */
export const V12_TURN_END_BULLET = `- **idle/done**: Read the agent's final assistant message via \`read_agent_chat(agent_id, role: 'assistant', limit: 1)\` — clean structured chat, no PTY noise.`;

/** v13: the single 95% ADVISORY context tier. */
export const V13_CONTEXT_BULLET = `- **context threshold (95%)**: **Advisory, not a deadline.** 100% context is not a literal cutoff — nothing breaks when an agent fills its window and a handoff is never strictly required. This is a cost/efficiency signal: a bloated context makes every remaining turn more expensive. So judge by what the agent is doing. **Idle or between tasks** → hand off: read its log, \`launch_agent\` a successor whose role description carries the compacted context (accomplished / current state / next), then \`stop_agent\` the old one. **Mid-task and genuinely close to done** → let it finish; tearing down near-complete work costs more than the context does. Hand off after it lands.`;

/** v12: the 80/90/95 tier, worded as an unconditional compact order. */
export const V12_CONTEXT_BULLET = `- **context threshold (80%+)**: Compact the agent — read its log to summarize progress, launch a new agent via \`launch_agent\` with a role description containing the compacted context (what was accomplished, current state, what's next), then stop the old agent via \`stop_agent\`. This gives the work a fresh context window without losing continuity.`;

/** v13: the Tier-1 decision line, following the notification tier to 95%. */
export const V13_TIER1_LINE = `**Tier 1 — Automatic:** Approve routine continuations, handle rate limits, weigh a handoff at context ≥ 95%`;

/** v12: the same line at the old 80% flag point. */
export const V12_TIER1_LINE = `**Tier 1 — Automatic:** Approve routine continuations, handle rate limits, flag context > 80%`;

/** v13 ONLY: the muted-orchestration-members paragraph appended to
 *  `## Multi-agent orchestration`. Reconstructing v12 removes it outright, so
 *  there is no v12 counterpart. Leading blank line included so the removal
 *  leaves the surrounding paragraphs correctly spaced. */
export const V13_MUTED_MEMBERS_PARA = `

Orchestration members are **muted**: you will NOT get per-turn \`idle\` events from
the agents a run launches, even though their cards visibly flip status. That is
intentional — inside a deliberation, working → idle is the ORCHESTRATOR's relay
signal, not yours, and forwarding it would bury you in turn-end noise you cannot
act on. The run tells you what matters through its own run-level events
(\`groupthink.complete\` with the written artifact, \`…stalled\`, \`…aborted\`). If you
want a member's state before then, pull it: \`get_orchestration_run\` or
\`read_agent_chat\`. The members stay owned by you throughout, so you keep full
investigation and \`stop_agent\` authority.`;
