// WP-A.2 (plans/groupthink/foundation-and-role-lane.md STEP 4 / D-5) — pure,
// testable builders for per-lane dashboard MCP injection.
//
// These are deliberately Electron-free and side-effect-free so they can be
// unit-tested under the system-Node runner (`node dist/.../mcp-config-builder.test.js`)
// without spawning wsl.exe, opening the DB, or resolving Electron paths. The
// AgentSupervisor methods supply the impure inputs (script path, bound API
// port, the per-process bearer token, the WSL→host gateway IP) and call these.
//
// SECURITY (D-4/F9/F10): the API bearer token lives ONLY inside the inline
// `--mcp-config` JSON these functions return, which is passed to the child
// process in-memory at launch. It must NEVER be written to disk or echoed to a
// log. `redactMcpToken` is the choke point that scrubs it from any rendered
// command string before that string is logged or persisted.

import type { AgentRoleLane } from '../../shared/types';

/** Map a role-lane to its `DASHBOARD_MCP_TOOLSETS` grant — the comma-separated
 *  module list the parameterized `mcp-dashboard.js` proxy lazily `require`s.
 *
 *  Per the human-confirmed design (browser-parity-and-capability-isolation §0):
 *  the supervisor INTENTIONALLY gets orchestration/comms/observability (+ plans)
 *  only — NO full browser, NO notebooks (those move to the researcher/worker
 *  lanes). `teams` was ALSO removed (QW1 — see the per-case note below); the
 *  authoritative grant is always the string `toolsetsForLane` returns, not this
 *  overview. Legacy agents get no dashboard MCP at all (empty grant).
 *
 *  EXCEPTION (human-confirmed): the supervisor and worker additionally get the
 *  minimal `browser-present` toolset — a single open-only `browser_open_url`
 *  that pulls a page up as a VISIBLE human (persist:user) tab with no readback
 *  and no read/act tools. It lets them surface a webpage FOR the user without
 *  any ability to read or drive it. The full read/click/type `browser` surface
 *  stays researcher-only. */
export function toolsetsForLane(lane: AgentRoleLane): string {
  switch (lane) {
    case 'supervisor':
      // QW1 (context-optimizer §3): `teams` removed — 0 team tool calls across
      // 176 supervisor sessions and several member tools are partly
      // decommissioned. Re-add the day a workflow needs it — grants are one-line.
      // Planning-surface acceptance demo (2026-07-06) found `plans` registered in
      // the TOOLSET_REGISTRY but granted to NO lane; supervisor gets the full
      // `plans` toolset here (create_plan + the read ladder). GT-A WP-A4 (I-1):
      // workers get the read-only `plans-read` subset (below) — they orient/read/
      // observe the plan surface via MCP and still write by editing the HTML
      // natively; create_plan + write stay supervisor-native.
      // WP-F (P5): `observability` split into `observability-core` (operational)
      // + `observability-analytics` (context-optimizer / agent-knowledge /
      // file-heat / skill-usage deep analytics). The supervisor keeps BOTH; the
      // worker keeps only core (below). Justified by the P2 tool-usage surface:
      // analytics tools showed real per-lane usage concentrated in the
      // context-overhead supervisor, not the worker lane.
      return 'orchestration,comms,observability-core,observability-analytics,plans,browser-present';
    case 'worker':
      // QW1 (context-optimizer §3): `notebooks` removed — 0 notebook tool
      // invocations corpus-wide in the 546-file worker matrix. This is a rent
      // decision, not a value judgment (notebook use is event-driven). Re-add
      // the day a workflow needs it — grants are one-line.
      // GT-A WP-A4 (I-1): workers now get the read-only `plans-read` subset
      // (list/read/projection — no create_plan) so a plan-bound worker can orient
      // on and read its dispatched section via ToolSearch under --strict-mcp-config
      // (which otherwise starved the plan-read breadcrumb trail). Writes stay
      // native Edits; there is no plan-write MCP tool.
      // WP-F (P5): `observability-analytics` dropped from the worker grant — the
      // deep context-optimizer/analytics tools are a supervisor concern (observed
      // near-zero worker usage on the P2 surface). Preserves the QW1 precedent
      // (trim on observed-zero; one-line re-add the day a worker workflow needs it).
      return 'comms,observability-core,browser-present,plans-read';
    case 'researcher':
      return 'browser';
    case 'legacy':
    default:
      return '';
  }
}

/** Does this role-lane launch with `--strict-mcp-config`?
 *
 *  `--strict-mcp-config` makes claude ignore EVERY globally-configured MCP
 *  server and see ONLY the servers arriving via inline `--mcp-config` flags.
 *  That is the containment contract we want for the worker and researcher
 *  lanes — they get exactly their injected dashboard toolset (+ team config if
 *  any) and nothing else.
 *
 *  The supervisor MUST NOT be strict: it still gets its inline dashboard
 *  `--mcp-config` (orchestration/teams/comms/observability), but it also relies
 *  on its globally-configured MCP servers (Gmail / Calendar / Drive /
 *  claude-in-chrome). Strict mode would strip all of those.
 *
 *  Legacy gets no dashboard `--mcp-config` at all and is likewise never strict
 *  (legacy team members still receive their team `--mcp-config` inline, but
 *  WITHOUT strict so their global MCPs survive). */
export function laneUsesStrictMcp(lane: AgentRoleLane): boolean {
  return lane === 'worker' || lane === 'researcher';
}

/** Inputs to the Windows direct-spawn gate. Pure mirror of the inline const in
 *  AgentSupervisor.launchWindowsAgent so the boolean is unit-testable without
 *  spawning claude.exe / opening the DB. */
export interface DirectSpawnParams {
  /** The agent's resolved role-lane — the result of `roleLaneOf(agent)`. The
   *  direct-spawn decision keys off the lane (not the raw isSupervisor/…
   *  booleans) so it stays in lockstep with the MCP-injection condition, which is
   *  also `lane !== 'legacy'`. Keying off the booleans is what crash-looped the
   *  privilege-lane persona: it was injected on the lane (roleLaneOf →
   *  'supervisor' via privilegeLane) but cmd.exe-wrapped on the booleans
   *  (isSupervisor/isSupervised/isWorker/isResearcher all false), so the wrap's
   *  quoteForCmd() doubled every `"` in the inline JSON. Lane-keying covers
   *  privilegeLane:'supervisor' for free (roleLaneOf maps it to 'supervisor'). */
  lane: AgentRoleLane;
  /** Agent provider ('claude' | 'codex' | …). Only claude agents direct-spawn. */
  provider: string;
  /** True when a multiline positional prompt arg is present
   *  (agentMdPrompt && !resume && provider === 'claude'). */
  hasPromptArg: boolean;
  /** Truthy when the caller supplies explicit override args (suppresses the
   *  persistent-lane spawn, mirroring `!overrideArgs`). */
  overrideArgs?: boolean;
}

/** Should a Windows claude launch bypass the `cmd.exe /c` wrap and spawn
 *  claude.exe directly?
 *
 *  Two reasons to direct-spawn:
 *   1. `hasPromptArg` — a multiline positional prompt would be shredded by
 *      cmd.exe argument parsing.
 *   2. Any non-legacy claude lane (supervisor / worker / researcher — and any
 *      privilege-lane persona, which roleLaneOf folds into the supervisor lane)
 *      — these pass a load-bearing `--append-system-prompt` AND an inline
 *      `--mcp-config <JSON>`. Under the cmd.exe wrap, pty-host quoteForCmd()
 *      doubles every `"` in the JSON, so it no longer starts with `{` and
 *      claude.exe mistakes it for a missing file path ("MCP config file not
 *      found"). The predicate is `lane !== 'legacy'` — deliberately the SAME
 *      predicate that gates the inline-MCP injection (index.ts), so the two can
 *      never diverge (the divergence that crash-looped the privilege-lane
 *      persona: injected but not direct-spawned). */
export function shouldDirectSpawn(p: DirectSpawnParams): boolean {
  const persistentAgent =
    p.lane !== 'legacy' &&
    p.provider === 'claude' &&
    !p.overrideArgs;
  return p.hasPromptArg || persistentAgent;
}

/** WP-B (STEP 5 / Gate-0 default) — the researcher lane's native built-in tool
 *  boundary, passed as `--tools <list>`. The researcher browses + researches and
 *  writes findings, but never edits code, runs a shell, executes notebooks, or
 *  launches dashboard agents.
 *
 *  - WebSearch / WebFetch / Read / Grep / Glob / Task / Skill are Claude
 *    built-ins (Task spawns ephemeral in-process subagents, NOT dashboard agents).
 *  - Write is offered but path-confined to .dashboard/research/inbox/ by the
 *    scaffolded PreToolUse(Write) guard (RESEARCH_WRITE_GUARD_MJS).
 *  - mcp__agent-dashboard__browser_* are the dashboard browser tools, which
 *    arrive via the injected `browser` MCP toolset (toolsetsForLane).
 *
 *  Gate-RB (live human gate) confirms `--tools` actually removes the omitted
 *  built-ins (Bash/Edit/MultiEdit/NotebookEdit) under --dangerously-skip-
 *  permissions; RESEARCHER_DISALLOWED_TOOLS below is the belt-and-suspenders. */
export const RESEARCHER_ALLOWED_TOOLS: readonly string[] = [
  'WebSearch',
  'WebFetch',
  'Read',
  'Grep',
  'Glob',
  'Task',
  'Skill',
  'Write',
  // PRIMARY browser: the embedded agent-dashboard browser_* pane, always wired
  // in via the injected `browser` MCP toolset. This is the researcher's default
  // and the ONLY browser used to test/verify the embedded browser itself.
  'mcp__agent-dashboard__browser_*',
  // claude-in-chrome MCP — de-emphasized LAST-RESORT FALLBACK, granted to the
  // RESEARCHER lane ONLY (this --tools list is researcher-specific; no other
  // lane grants cic). The server is activated by the `--chrome` flag the
  // researcher branch appends in index.ts and survives the researcher's
  // --strict-mcp-config (CLI-flag injection, not config-file discovery). The
  // lane doc (RESEARCHER_AGENT_MD) steers the researcher away from reaching for
  // it unless native browser_* genuinely cannot accomplish the task.
  'mcp__claude-in-chrome__*',
];

/** WP-B (STEP 5) — dangerous built-ins explicitly removed from the researcher
 *  via `--disallowedTools` (belt-and-suspenders behind `--tools`). */
export const RESEARCHER_DISALLOWED_TOOLS: readonly string[] = [
  'Bash',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
];

export interface DashboardMcpConfigParams {
  /** Comma-separated toolset grant (see toolsetsForLane). */
  toolsets: string;
  /** 'windows' | 'wsl' — selects path rewrite + gateway-IP injection. */
  pathType: string;
  /** Windows-native path to scripts/mcp-dashboard.js (back-slashes ok; they are
   *  normalized to forward slashes / `/mnt/<drive>` form here). */
  scriptPath: string;
  /** The real bound API server port. */
  apiPort: number;
  /** The per-process bearer token. Lives only in the returned JSON. */
  apiToken: string;
  /** WSL→Windows-host gateway IP. Required for the wsl path; ignored on windows.
   *  Defaults to 127.0.0.1 (mirrored-mode WSL) when omitted. */
  wslHostIp?: string;
  /** GT-A WP-A4 (D-2) — the calling agent's identity rail, forwarded into the
   *  MCP sidecar's env so the `plans-read` env-default (AGENT_DASHBOARD_PLAN_ID)
   *  and the CALLER_HEADERS identity spread (X-Self-Id / X-Workspace-Id /
   *  X-Supervisor-Id) resolve from an EXPLICIT env dict rather than depending on
   *  parent-process inheritance. Spread FIRST in every branch so the fixed API
   *  keys (token / host / port / toolsets) always override — a hostile identityEnv
   *  can never clobber them. */
  identityEnv?: Record<string, string>;
}

/** Build the inline `--mcp-config` JSON string for the parameterized dashboard
 *  MCP proxy, keyed on `DASHBOARD_MCP_TOOLSETS`. Mirrors `buildTeamMcpConfigArg`
 *  (the existing off-disk model) incl. the WSL `/mnt/<drive>` rewrite and the
 *  gateway-IP `AGENT_DASHBOARD_API_HOST`, but points at `mcp-dashboard.js` with
 *  the lane's toolset grant. The server key is `agent-dashboard` so the tool
 *  names the model sees are unchanged from the monolithic server. */
export function buildDashboardMcpConfigArg(params: DashboardMcpConfigParams): string {
  const { toolsets, pathType, scriptPath, apiPort, apiToken, wslHostIp, identityEnv } = params;
  const winScript = scriptPath.replace(/\\/g, '/');

  if (pathType === 'wsl') {
    const driveLetter = winScript.charAt(0).toLowerCase();
    const restOfPath = winScript.substring(2); // skip "C:"
    const linuxScriptPath = `/mnt/${driveLetter}${restOfPath}`;
    return JSON.stringify({
      mcpServers: {
        'agent-dashboard': {
          command: 'node',
          args: [linuxScriptPath],
          env: {
            // identityEnv FIRST so the fixed API keys below always override it —
            // a hostile identityEnv can never clobber token/host/port/toolsets.
            ...identityEnv,
            DASHBOARD_MCP_TOOLSETS: toolsets,
            AGENT_DASHBOARD_API_PORT: String(apiPort),
            AGENT_DASHBOARD_API_HOST: wslHostIp ?? '127.0.0.1',
            AGENT_DASHBOARD_API_TOKEN: apiToken,
          },
        },
      },
    });
  }

  return JSON.stringify({
    mcpServers: {
      'agent-dashboard': {
        command: 'node',
        args: [winScript],
        env: {
          // identityEnv FIRST so the fixed API keys below always override it —
          // a hostile identityEnv can never clobber token/port/toolsets.
          ...identityEnv,
          DASHBOARD_MCP_TOOLSETS: toolsets,
          AGENT_DASHBOARD_API_PORT: String(apiPort),
          AGENT_DASHBOARD_API_TOKEN: apiToken,
        },
      },
    },
  });
}

/** Scrub the API bearer token from any rendered command / log line (D-4/F10).
 *  Belt-and-suspenders: replaces the literal token value AND any
 *  `AGENT_DASHBOARD_API_TOKEN":"…"` / `AGENT_DASHBOARD_API_TOKEN=…` occurrence
 *  (so a rotated/mismatched token still can't leak via the key name). Returns
 *  the input unchanged when `token` is empty/falsy except for the key-based
 *  passes, which always run. */
export function redactMcpToken(s: string, token: string): string {
  const PLACEHOLDER = '***REDACTED***';
  let out = s;
  if (token) {
    // Literal value (covers the JSON value, any future env-prefix form, etc.).
    out = out.split(token).join(PLACEHOLDER);
  }
  // JSON form: "AGENT_DASHBOARD_API_TOKEN":"<value>"
  out = out.replace(
    /("AGENT_DASHBOARD_API_TOKEN"\s*:\s*")[^"]*(")/g,
    `$1${PLACEHOLDER}$2`,
  );
  // Shell env-prefix form: AGENT_DASHBOARD_API_TOKEN=<value>
  out = out.replace(
    /(AGENT_DASHBOARD_API_TOKEN=)[^\s'"]+/g,
    `$1${PLACEHOLDER}`,
  );
  // WSL tmux envelope: `echo <base64> | base64 -d` (inner payload) OR the new
  // outer `printf %s <base64> | base64 -d | bash` quote-free boundary wrapper
  // both embed the ENTIRE agent command (incl. the inline --mcp-config token) as
  // base64, so the literal-token pass above cannot see it. Strip the payload
  // outright — the plaintext (already-redacted) command is preserved in a
  // sibling field, so no diagnostic value is lost and the token can't be
  // base64-decoded back out of a serialized tmux command (e.g. launches.log
  // `tmux_command`).
  out = out.replace(
    /(?:echo|printf %s)\s+[A-Za-z0-9+/=]+\s*\|\s*base64\s+-d/g,
    `printf %s ${PLACEHOLDER}_BASE64 | base64 -d`,
  );
  return out;
}
