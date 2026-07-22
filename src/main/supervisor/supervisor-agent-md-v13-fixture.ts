// Frozen fragments for reconstructing the pristine v13 `.dashboard/supervisor/CLAUDE.md`
// from the shipped v14 constant.
//
// v14 is the MCP context-overhead cut: `get_context_stats` and
// `list_orchestrations` were deleted as MCP tools, so the persona's resident
// documentation for them went with them. Three edits, each captured as a
// V14_/V13_ pair (or a lone V14_ fragment that v13 did not have):
//
//   1. the `list_agents` bullet gained the inline-context clause, because that
//      is where the per-agent context reading now comes from;
//   2. the `get_context_stats` bullet was deleted outright;
//   3. `## Multi-agent orchestration` dropped "Discover with `list_orchestrations`".
//
// The migration test undoes exactly these to rebuild v13 and pins the result to
// SUPERVISOR_AGENT_MD_V13_HASH, so any drift in either the constant or these
// fragments fails loudly rather than silently `.bak`-ing real workspaces.

/** v14 `list_agents` bullet — names the inline context block as the surface that
 *  replaced the deleted `get_context_stats`. */
export const V14_LIST_AGENTS_BULLET =
  "- **list_agents** — List all agents with status, metadata, and each agent's context reading inline "
  + '(`context: {percentage, tokensUsed, turns, model}`) — this is the context-usage surface; '
  + 'there is no separate per-agent stats tool';

/** The v13 `list_agents` bullet it replaced. */
export const V13_LIST_AGENTS_BULLET =
  '- **list_agents** — List all agents with status, context usage, metadata';

/** The whole v13 `get_context_stats` bullet line (including its trailing
 *  newline), deleted in v14. */
export const V13_CONTEXT_STATS_BULLET =
  '- **get_context_stats** — Get token usage, context %, model, turns (args: agent_id)\n';

/** v14 orchestration tail — no catalog-discovery clause. */
export const V14_ORCH_SKILL_POINTER =
  'synthesize). Start / poll / abort / resume per the **run-orchestration skill**,\n'
  + 'which holds every call signature, mode, polling, and stall-recovery detail —\n'
  + "don't restate it here.";

/** The v13 orchestration tail it replaced (opened with `list_orchestrations`). */
export const V13_ORCH_SKILL_POINTER =
  'synthesize). Discover with `list_orchestrations`; start / poll / abort / resume\n'
  + 'per the **run-orchestration skill**, which holds every call signature, mode,\n'
  + "polling, and stall-recovery detail — don't restate it here.";
