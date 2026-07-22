// Supervisor persona ↔ grant parity — plans/context-overhead-review.md §5.
//
// The regression guard for the v12 persona cut. Two of the largest deletions in
// that pass existed only because a GRANT was trimmed (QW1 removed `teams` and
// `notebooks` from the lane grants) and the resident persona prose was not — the
// supervisor kept paying ~1.5k tokens per session to read documentation for tools
// it cannot call. This test converts "remember to update the persona when you
// change a grant" into a failing test.
//
// It resolves the lane's REAL verb surface from the same CommonJS toolset modules
// the MCP proxy serves (`scripts/mcp-tools-*.js`, keyed exactly as
// context-overhead/ipc-deps.ts TOOLSET_SCRIPT_MAP does) — never a hand-copied list
// — and asserts SUPERVISOR_AGENT_MD names no dashboard verb outside
// `toolsetsForLane('supervisor')`.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/supervisor-persona-capability-parity.test.js

import assert from 'node:assert/strict';
import path from 'node:path';
import { toolsetsForLane } from './mcp-config-builder';
import { DASHBOARD_TOOLSETS } from '../skill-analytics/mcp-toolset-map';
import { SUPERVISOR_AGENT_MD, SUPERVISOR_CONTEXT_ANALYTICS_SKILL } from '../../shared/constants';

interface TestCase {
  name: string;
  run(): void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

// ── The real toolset surface ─────────────────────────────────────────
//
// Mirrors ipc-deps.ts TOOLSET_SCRIPT_MAP. Kept local so the test runs under
// system node without Electron app-path resolution. `observability` is the
// backward-compat union (not granted by name to any lane) and is included so an
// ungranted verb is still recognized as a dashboard verb rather than ignored.
const TOOLSET_SCRIPT_MAP: Record<string, { script: string; fn: string }> = {
  orchestration: { script: 'mcp-tools-orchestration.js', fn: 'getOrchestrationToolDefinitions' },
  teams: { script: 'mcp-tools-teams.js', fn: 'getTeamsToolDefinitions' },
  comms: { script: 'mcp-tools-comms.js', fn: 'getCommsToolDefinitions' },
  observability: { script: 'mcp-tools-observability.js', fn: 'getObservabilityToolDefinitions' },
  'observability-core': { script: 'mcp-tools-observability.js', fn: 'getObservabilityCoreToolDefinitions' },
  // `observability-analytics` is gone: its 13 tools were retired in favour of the
  // on-demand snapshot exporter + the `context-analytics` skill, leaving the
  // toolset empty, so it was unregistered rather than kept as a zero-tool entry.
  // Like the deleted team/context-stats verbs, its verbs can no longer be seen by
  // UNGRANTED_VERBS — the substring guard below is what catches a stale mention.
  notebooks: { script: 'mcp-tools-notebooks.js', fn: 'getNotebooksToolDefinitions' },
  browser: { script: 'mcp-browser-tools.js', fn: 'getBrowserToolDefinitions' },
  'browser-present': { script: 'mcp-browser-present-tools.js', fn: 'getBrowserPresentToolDefinitions' },
  'plans-read': { script: 'mcp-tools-plans.js', fn: 'getPlansReadToolDefinitions' },
  plans: { script: 'mcp-tools-plans.js', fn: 'getPlansToolDefinitions' },
};

/** Repo-root `scripts/` — this file compiles to dist/main/main/supervisor/. */
const SCRIPTS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'scripts');

function verbsOf(toolset: string): string[] {
  const entry = TOOLSET_SCRIPT_MAP[toolset];
  assert.ok(entry, `unknown toolset '${toolset}' — TOOLSET_SCRIPT_MAP is out of sync with ipc-deps.ts`);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(path.join(SCRIPTS_DIR, entry.script)) as Record<string, () => Array<{ name: string }>>;
  const defs = mod[entry.fn]?.();
  assert.ok(Array.isArray(defs) && defs.length > 0, `${entry.script}#${entry.fn} returned no definitions`);
  return defs.map((d) => d.name);
}

const GRANTED_TOOLSETS = toolsetsForLane('supervisor').split(',').filter(Boolean);
const GRANTED_VERBS = new Set(GRANTED_TOOLSETS.flatMap(verbsOf));
const ALL_VERBS = new Set(
  [...DASHBOARD_TOOLSETS, 'observability'].flatMap((t) => (TOOLSET_SCRIPT_MAP[t] ? verbsOf(t) : [])),
);
const UNGRANTED_VERBS = new Set([...ALL_VERBS].filter((v) => !GRANTED_VERBS.has(v)));

/** Every code-form identifier the persona names: \`word_word\` and **word_word**. */
function mentionedIdentifiers(md: string): Set<string> {
  const found = new Set<string>();
  for (const re of [/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g, /\*\*([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\*\*/g]) {
    for (const m of md.matchAll(re)) found.add(m[1]);
  }
  return found;
}

/** Identifiers that look like MCP verbs but intentionally are not lane grants.
 *  Every entry carries a reason — an unexplained allowlist is how drift returns. */
const ALLOWLIST: Record<string, string> = {
  // Team-member tools the persona no longer documents at all; listed here so a
  // deliberate historical/negative mention (e.g. "you have no send_message") does
  // not have to weaken the ungranted check.
  send_message: 'team-member tool; ungranted — allowed only as a negative/historical mention',
  get_messages: 'team-member tool; ungranted — allowed only as a negative/historical mention',
};

/** §5's explicit deny list: the verbs whose documentation this pass removed.
 *  Checked as raw substrings over the whole persona so a mention in prose,
 *  a heading, or an unformatted sentence is caught too. */
const FORBIDDEN_SUBSTRINGS: string[] = [
  // teams (ungranted). get_team / list_teams were the last two team verbs still
  // REGISTERED anywhere (they lived in observability-core, granted but never
  // called); the context-overhead pass deleted them outright, so no team verb
  // exists in any toolset now. They stay listed here so a persona re-mention is
  // caught as prose drift even though the UNGRANTED_VERBS set can no longer see
  // them — re-adding one means re-opening §2.1.
  'create_team', 'disband_team', 'add_team_member', 'remove_team_member',
  'add_channel', 'remove_channel', 'get_team', 'list_teams', 'resurrect_team',
  // Deleted in the MCP context-overhead pass. Same reasoning as the team reads:
  // once a tool is gone from every toolset, UNGRANTED_VERBS cannot flag a stale
  // mention of it, so the substring guard is the only thing standing between the
  // persona and documentation for a tool that does not exist.
  //   get_context_stats  — redundant; `list_agents` returns the same reading inline.
  //   list_orchestrations — one-entry catalog; run_orchestration's own description
  //                         now carries the name + the serial|parallel mode choice.
  'get_context_stats', 'list_orchestrations',
  // The 13 `observability-analytics` tools, retired in favour of the on-demand
  // analytics snapshot exporter + the scaffolded `context-analytics` skill. The
  // whole toolset is unregistered, so — exactly as with the team verbs above —
  // UNGRANTED_VERBS cannot flag a stale mention and this substring guard is the
  // only thing standing between the persona and resident documentation for tools
  // that do not exist. The CAPABILITY is not lost, so a re-mention here is not
  // just stale, it is wrong: it would point the supervisor at a dead MCP surface
  // instead of at the skill that replaced it.
  'get_context_optimizer_proposals', 'get_context_optimizer_proposal',
  'get_context_optimizer_proposal_evidence', 'get_context_optimizer_cluster_exemplars',
  'get_context_optimizer_analyzability', 'get_improvement_proposals',
  'get_improvement_proposal', 'get_skill_usage', 'get_skill_usage_detail',
  'get_mcp_tool_usage', 'get_agent_knowledge', 'get_agent_knowledge_detail',
  'get_file_heat',
  // notebooks (ungranted)
  'execute_cell', 'execute_range', 'execute_notebook',
  'interrupt_kernel', 'restart_kernel', 'get_kernel_state',
  // full browser (researcher-only)
  'browser_read_page', 'browser_click', 'browser_screenshot', 'browser_get_page_text',
  'browser_type', 'browser_press_key', 'browser_scroll',
  // the browser-present schema has no such arg
  'for_human_action',
];

// ── Tests ────────────────────────────────────────────────────────────

test('precondition: the supervisor grant resolves to a non-trivial verb surface', () => {
  assert.ok(GRANTED_TOOLSETS.includes('browser-present'), 'supervisor grant must still include browser-present');
  assert.ok(!GRANTED_TOOLSETS.includes('teams'), 'precondition: teams is NOT granted to the supervisor');
  assert.ok(!GRANTED_TOOLSETS.includes('notebooks'), 'precondition: notebooks is NOT granted to the supervisor');
  assert.ok(!GRANTED_TOOLSETS.includes('browser'), 'precondition: the full browser toolset is NOT granted to the supervisor');
  assert.ok(GRANTED_VERBS.size > 20, `expected a real granted surface; got ${GRANTED_VERBS.size} verbs`);
  assert.ok(UNGRANTED_VERBS.has('create_team'), 'precondition: create_team must be recognized as ungranted');
  assert.ok(UNGRANTED_VERBS.has('execute_cell'), 'precondition: execute_cell must be recognized as ungranted');
  assert.ok(UNGRANTED_VERBS.has('browser_click'), 'precondition: browser_click must be recognized as ungranted');
});

test('every dashboard verb the persona names is in toolsetsForLane("supervisor")', () => {
  const offenders = [...mentionedIdentifiers(SUPERVISOR_AGENT_MD)]
    .filter((id) => UNGRANTED_VERBS.has(id))
    .filter((id) => !(id in ALLOWLIST));
  assert.deepEqual(
    offenders, [],
    `The supervisor persona documents MCP verbs this lane cannot call: ${offenders.join(', ')}. ` +
    `Grant is '${toolsetsForLane('supervisor')}'. Either widen the grant deliberately or delete the prose — ` +
    `resident guidance for ungranted tools is paid for on every single session.`,
  );
});

test('no teams / notebooks / full-browser / deleted verb appears anywhere in the persona', () => {
  const hits = FORBIDDEN_SUBSTRINGS.filter((needle) => SUPERVISOR_AGENT_MD.includes(needle));
  assert.deepEqual(
    hits, [],
    `Persona re-introduced documentation for a removed or deleted tool: ${hits.join(', ')}.`,
  );
});

test('the deleted tools are really gone from every toolset (not merely undocumented)', () => {
  for (const verb of ['get_context_stats', 'list_teams', 'get_team', 'list_orchestrations']) {
    assert.ok(
      !ALL_VERBS.has(verb),
      `${verb} was deleted in the MCP context-overhead pass but is still registered in a toolset — ` +
      `the persona guard above assumes it no longer exists anywhere.`,
    );
  }
  // The capability get_context_stats provided is preserved, not dropped: it now
  // rides inline on list_agents, which the supervisor still holds.
  assert.ok(GRANTED_VERBS.has('list_agents'), 'list_agents must stay granted — it carries the context reading');
});

test('all 13 retired analytics verbs are gone from every toolset, and the replacement skill is scaffolded', () => {
  const RETIRED_ANALYTICS_VERBS = [
    'get_context_optimizer_proposals', 'get_context_optimizer_proposal',
    'get_context_optimizer_proposal_evidence', 'get_context_optimizer_cluster_exemplars',
    'get_context_optimizer_analyzability', 'get_improvement_proposals',
    'get_improvement_proposal', 'get_skill_usage', 'get_skill_usage_detail',
    'get_mcp_tool_usage', 'get_agent_knowledge', 'get_agent_knowledge_detail',
    'get_file_heat',
  ];
  assert.equal(RETIRED_ANALYTICS_VERBS.length, 13, 'the retirement covered exactly 13 tools');
  for (const verb of RETIRED_ANALYTICS_VERBS) {
    assert.ok(
      !ALL_VERBS.has(verb),
      `${verb} was retired with the observability-analytics toolset but is still registered somewhere.`,
    );
    assert.ok(!GRANTED_VERBS.has(verb), `${verb} is retired but still reachable from the supervisor grant.`);
  }
  // …and the toolset itself is unregistered, not merely emptied. An empty
  // registered toolset would keep a zero-tool entry alive in every grant list.
  assert.ok(
    !DASHBOARD_TOOLSETS.includes('observability-analytics'),
    'observability-analytics must be unregistered, not left as an empty toolset',
  );
  assert.ok(
    !toolsetsForLane('supervisor').split(',').includes('observability-analytics'),
    'the supervisor grant must no longer name the retired toolset',
  );

  // THE HALVES LAND TOGETHER. Deleting the tools without shipping the
  // replacement leaves a capability gap, so assert the skill that replaces them
  // is actually scaffolded onto the lane that lost them — and that it still
  // points at the exporter, which is the only thing that makes the deletion safe.
  assert.ok(
    SUPERVISOR_CONTEXT_ANALYTICS_SKILL.includes('name: context-analytics'),
    'the replacement skill must carry its frontmatter name',
  );
  assert.ok(
    SUPERVISOR_CONTEXT_ANALYTICS_SKILL.includes('analytics:snapshot:fast'),
    'the replacement skill must name the exporter command that supplies the retired data',
  );
  for (const surface of ['contextOverhead.json', 'agentKnowledge.json', 'optimizer.json', 'mcp-tool-usage.csv', 'file-heat.csv', 'skill-usage.csv']) {
    assert.ok(
      SUPERVISOR_CONTEXT_ANALYTICS_SKILL.includes(surface),
      `the replacement skill must route the reader to ${surface}`,
    );
  }
  // The skill's own description tells the agent not to go looking for the dead
  // tools — that redirect is the thing that prevents a confused re-add.
  for (const dead of ['get_file_heat', 'get_skill_usage', 'get_context_optimizer_']) {
    assert.ok(
      SUPERVISOR_CONTEXT_ANALYTICS_SKILL.includes(dead),
      `the skill must name the retired tool ${dead} so an agent looking for it is redirected`,
    );
  }
});

test('browser_open_url is the only browser verb, described with the browser-present schema', () => {
  const browserVerbs = [...mentionedIdentifiers(SUPERVISOR_AGENT_MD)].filter((id) => id.startsWith('browser_'));
  assert.deepEqual(browserVerbs, ['browser_open_url'], `unexpected browser verbs: ${browserVerbs.join(', ')}`);
  assert.ok(SUPERVISOR_AGENT_MD.includes('browser_open_url'), 'the OAuth surface-to-human capability must stay documented');
  const presentArgs = verbsOf('browser-present');
  assert.deepEqual(presentArgs, ['browser_open_url'], 'browser-present must still expose exactly one verb');
});

test('the behavior-bearing sections protected by §3 are still resident', () => {
  for (const marker of [
    '## Automatic Events',
    '## Worker handoff handshake',
    'HANDSHAKE OK',
    'HANDSHAKE UNCONFIRMED',
    'HANDSHAKE FAILED',
    '<!-- reorientation-note-v1 -->',
    '<!-- section:research-store v1 -->',
    '<!-- section:planning-surface v1 -->',
    'sec_exectr',
    '`sec_opitem`',
    'One-writer policy',
    'completion writeback',
  ]) {
    assert.ok(SUPERVISOR_AGENT_MD.includes(marker), `v12 must not have dropped: ${marker}`);
  }
});

test('get_my_context is documented exactly once (Re-Orientation dedup)', () => {
  // v12 dropped the duplicate "Additional tool" restatement in the Re-Orientation
  // block; the call-it-FIRST bullet is the single remaining mention.
  const count = SUPERVISOR_AGENT_MD.split('get_my_context').length - 1;
  assert.equal(count, 1, `get_my_context should be documented exactly once, got ${count}`);
  assert.ok(SUPERVISOR_AGENT_MD.includes('get_my_context'), 'the revival ground-truth call must stay documented');
  assert.ok(SUPERVISOR_AGENT_MD.includes('advisory, not authoritative'), 'the distrust-stale-wake-hint action must survive');
  assert.ok(SUPERVISOR_AGENT_MD.includes('`list_agents`'), 'the refresh-list_agents action must survive');
});

// ── Runner ───────────────────────────────────────────────────────────
(() => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      t.run();
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
