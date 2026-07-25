// design §4.3 — MCP tool_name → toolset reverse map.
//
// Built once from the same toolset definitions P1 sizes
// (`ToolsetDefsProvider.defsFor(toolset)`, see mcp-tool-inventory.ts:17). A logged
// `mcp__agent-dashboard__<t>` resolves to its toolset for `behavior_events.mcp_toolset`;
// an unresolved `mcp__…` name → `null` ("unknown MCP tool"). Pure + IO-free: the defs
// provider is injected so this is unit-testable under system node (the real provider
// require()s the CommonJS scripts/ and is wired in ipc-deps).

/** Minimal slice of ToolsetDefsProvider needed here (name is all we key on). */
export interface ToolsetDefsLike {
  defsFor(toolset: string): Array<{ name: string }> | null;
}

/** Server name all dashboard-injected toolsets are exposed under (mcp-dashboard.js). */
export const DASHBOARD_MCP_SERVER = 'agent-dashboard';

/** Canonical dashboard toolsets (mirrors ipc-deps TOOLSET_SCRIPT_MAP keys).
 *
 *  L1.1 registry-drift fix (wave2-mcp-tool-observability §1.1): `plans` was
 *  missing here even though `toolsetsForLane('supervisor')` grants it, so every
 *  logged `mcp__agent-dashboard__<plansTool>` resolved to a NULL toolset
 *  (verified live: `read_plan_projection` → null `mcp_toolset`). It is included
 *  now so the parse reverse-map attributes plans calls to the `plans` toolset.
 *  The defs for `plans` are supplied by `makePlansAwareDefsProvider`
 *  (plans-toolset-defs.ts), since the base context-overhead provider still omits
 *  it. */
// FIRST-WINS ORDERING (GT-A WP-A4.5): the reverse map is name-only and the first
// toolset to claim a tool name wins. `plans-read` MUST precede `plans` so the
// three shared read-tool names (list_plan_sections / read_plan_section /
// read_plan_projection) resolve to `plans-read`, while `create_plan` — present
// only in `plans` — resolves to `plans`.
export const DASHBOARD_TOOLSETS: readonly string[] = [
  'orchestration',
  'teams',
  'comms',
  // WP-F (P5): observability split. `observability-core` is shared (supervisor +
  // worker) → no lane inference. `observability-analytics` was here too, and was
  // the one supervisor-EXCLUSIVE observability toolset, so a logged analytics
  // tool could be lane-inferred to supervisor; it is gone now — its 13 tools were
  // retired in favour of the on-demand snapshot exporter + the `context-analytics`
  // skill, so no such tool can be logged again. Historical rows are unaffected:
  // they keep their stored `observability-analytics` toolset value, which is read
  // from the column and never re-resolved through this map.
  // The bare `observability` union is intentionally NOT listed here so new
  // ingestion resolves to the split names.
  'observability-core',
  'notebooks',
  'browser',
  'browser-present',
  'plans-read',
  'plans',
  // WP-G2.3 (Git-Native): supervisor-lane-only checkpoint recovery toolset. Its
  // verbs (list_checkpoints/diff_turn/restore_paths/revert_turn/prune_checkpoints)
  // are unique, so a logged `mcp__agent-dashboard__<verb>` resolves to
  // `checkpoints` instead of a null toolset; supervisor-exclusive → lane-inferable.
  'checkpoints',
];

export interface McpToolsetResolver {
  /** toolset for a logged `mcp__server__tool` name, or null when unresolved / not MCP. */
  resolve(toolName: string): string | null;
  /** number of distinct MCP tool names mapped (for diagnostics / tests). */
  readonly size: number;
}

/**
 * Build the reverse map once. `defsFor(toolset)` is called for each known toolset;
 * every `def.name` becomes `mcp__<serverName>__<name> → toolset`. First toolset to
 * claim a name wins (deterministic given a stable toolset order).
 */
export function buildMcpToolsetReverseMap(
  defs: ToolsetDefsLike,
  opts?: { toolsets?: readonly string[]; serverName?: string },
): McpToolsetResolver {
  const serverName = opts?.serverName ?? DASHBOARD_MCP_SERVER;
  const toolsets = opts?.toolsets ?? DASHBOARD_TOOLSETS;
  const map = new Map<string, string>();
  for (const toolset of toolsets) {
    const toolDefs = defs.defsFor(toolset);
    if (!toolDefs) continue;
    for (const tool of toolDefs) {
      if (!tool || typeof tool.name !== 'string' || !tool.name) continue;
      const full = `mcp__${serverName}__${tool.name}`;
      if (!map.has(full)) map.set(full, toolset);
    }
  }
  return {
    get size() {
      return map.size;
    },
    resolve(toolName: string): string | null {
      if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) return null;
      return map.get(toolName) ?? null;
    },
  };
}
