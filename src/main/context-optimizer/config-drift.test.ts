// config-drift unit tests (design §5.2 A5) — the static, log-free three-way
// toolset drift cross-join. Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/context-optimizer/config-drift.test.js
//
// Coverage: the two ACCEPTANCE cases (notebook-persona → documented-but-not-granted;
// decommissioned team member tool → documented-but-decommissioned) with ZERO log
// data; whole-toolset decommission; granted-but-undocumented; CSV-string grant
// ingestion (real toolsetsForLane form); coarse server-grant + non-mcp tool skips;
// member↔toolset re-association by shared source anchor; observed-safe by
// construction; deterministic ordering; legacy lane skipped.

import assert from 'node:assert/strict';
import type { AgentRoleLane, PersonaLane } from '../../shared/types';
import type { PredictedAction, PredicateKind, Derivability } from './guidance-action-model';
import { detectConfigDrift, type ConfigDriftDeps, type DriftFinding } from './config-drift';

// ── fixture builders ─────────────────────────────────────────────────────────

let anchorLine = 0;

/** Build one resolved `mcp:` node's compiled action group: a toolset-usage plus one
 *  tool-invocation per member, all sharing a `source` anchor (how the compiler
 *  emits them — the module re-associates members by that shared anchor). */
function mcpGrant(opts: {
  toolset: string;
  lanes: AgentRoleLane[];
  tools?: string[];
  absPath?: string;
  line?: number;
}): PredictedAction[] {
  const absPath = opts.absPath ?? `/w/.dashboard/${opts.lanes[0]}/CLAUDE.md`;
  const line = opts.line ?? ++anchorLine;
  const base = {
    source: { absPath, line },
    sourceKind: 'tool' as PredictedAction['sourceKind'],
    lanes: opts.lanes,
    derivability: 'exact' as Derivability,
    residentTokens: 50,
    sourceSectionKey: 'markdown_section:/w:tools',
    sourceEpochId: 'e1',
    requiresDerivationGate: true,
  };
  const usage: PredictedAction = {
    ...base,
    id: `${opts.toolset}-usage`,
    kind: 'toolset-usage' as PredicateKind,
    params: { toolset: opts.toolset },
  };
  const members: PredictedAction[] = (opts.tools ?? []).map((t) => ({
    ...base,
    id: `${opts.toolset}-${t}`,
    kind: 'tool-invocation' as PredicateKind,
    params: { toolName: t },
  }));
  return [usage, ...members];
}

/** A stand-alone action (for coarse-server / non-mcp / legacy edge cases). */
function action(over: Partial<PredictedAction>): PredictedAction {
  return {
    id: 'x',
    source: { absPath: '/w/.dashboard/worker/CLAUDE.md', line: ++anchorLine },
    sourceKind: 'tool',
    lanes: ['worker'] as AgentRoleLane[],
    kind: 'tool-invocation' as PredicateKind,
    params: {},
    derivability: 'exact' as Derivability,
    residentTokens: 10,
    sourceSectionKey: '',
    sourceEpochId: '',
    requiresDerivationGate: true,
    ...over,
  };
}

// Real registered toolset universe (ipc-deps TOOLSET_SCRIPT_MAP keys).
const REGISTERED = ['orchestration', 'teams', 'comms', 'observability', 'notebooks', 'browser', 'browser-present'];

// Real grants on disk (mcp-config-builder toolsetsForLane) — CSV strings, verbatim
// form, so the test exercises the string-ingestion path.
const GRANTS: Record<PersonaLane, string> = {
  supervisor: 'orchestration,comms,observability,browser-present', // QW1: teams removed
  worker: 'comms,observability,browser-present',                   // QW1: notebooks removed
  researcher: 'browser',
};

function deps(over: Partial<ConfigDriftDeps> = {}): ConfigDriftDeps {
  const memberMap: Record<string, string[]> = {
    orchestration: ['launch_agent', 'run_orchestration'],
    teams: ['create_team', 'list_teams'],
    comms: ['send_message_to_agent'],
    observability: ['read_agent_chat'],
    notebooks: ['execute_notebook'],
    browser: ['browser_open_url'],
    'browser-present': ['browser_present_url'],
  };
  return {
    grantedToolsetsFor: (lane) => GRANTS[lane] ?? '',
    registeredToolsets: () => REGISTERED,
    registeredToolNamesFor: (t) => (t in memberMap ? memberMap[t] : null),
    ...over,
  };
}

// ── harness ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error('       ', err instanceof Error ? err.message : err);
    failed++;
  }
}

function find(fs: DriftFinding[], kind: DriftFinding['kind'], toolset: string, lane?: PersonaLane, toolName?: string): DriftFinding | undefined {
  return fs.find((f) => f.kind === kind && f.toolset === toolset && (lane === undefined || f.lane === lane) && (toolName === undefined || f.toolName === toolName));
}

// ── ACCEPTANCE 1: notebook-persona drift → documented-but-not-granted ──────────

check('ACCEPTANCE: worker persona documents notebooks, lane not granted → documented-but-not-granted', () => {
  // worker docs the notebooks toolset; QW1 trimmed it from the worker grant.
  const actions = mcpGrant({ toolset: 'notebooks', lanes: ['worker'], tools: ['execute_notebook'] });
  const fs = detectConfigDrift(actions, deps());
  const f = find(fs, 'documented-but-not-granted', 'notebooks', 'worker');
  assert.ok(f, 'must flag notebooks documented-but-not-granted for worker');
  assert.equal(f!.evidenceTier, 'observed-safe');
  assert.equal(f!.sources.length, 1);
  // notebooks IS registered + members live → no decommission finding.
  assert.equal(find(fs, 'documented-but-decommissioned', 'notebooks'), undefined);
});

// ── ACCEPTANCE 2: decommissioned team member tool → documented-but-decommissioned ──

check('ACCEPTANCE: documented team member tool absent from live defs → documented-but-decommissioned (member)', () => {
  // supervisor docs teams + a member tool that no longer exists in the live defs.
  const actions = mcpGrant({ toolset: 'teams', lanes: ['supervisor'], tools: ['create_team', 'archive_team'] });
  // Grant teams here to ISOLATE the decommission finding from a not-granted one.
  const fs = detectConfigDrift(actions, deps({ grantedToolsetsFor: (l) => (l === 'supervisor' ? 'orchestration,teams,comms' : GRANTS[l]) }));
  const f = find(fs, 'documented-but-decommissioned', 'teams', 'supervisor', 'archive_team');
  assert.ok(f, 'must flag archive_team as decommissioned');
  assert.equal(f!.evidenceTier, 'observed-safe');
  // create_team is live → not flagged.
  assert.equal(find(fs, 'documented-but-decommissioned', 'teams', 'supervisor', 'create_team'), undefined);
});

check('decommissioned member fires even when the toolset itself is NOT granted (registration-gated, not grant-gated)', () => {
  // Real tree: teams removed from supervisor grant AND has decommissioned members.
  const actions = mcpGrant({ toolset: 'teams', lanes: ['supervisor'], tools: ['create_team', 'archive_team'] });
  const fs = detectConfigDrift(actions, deps()); // supervisor grant lacks teams
  assert.ok(find(fs, 'documented-but-not-granted', 'teams', 'supervisor'), 'teams not granted → not-granted finding');
  assert.ok(find(fs, 'documented-but-decommissioned', 'teams', 'supervisor', 'archive_team'), 'decommissioned member still surfaces');
});

// ── whole-toolset decommission ─────────────────────────────────────────────────

check('documented toolset absent from the live defs → documented-but-decommissioned (whole toolset)', () => {
  const actions = mcpGrant({ toolset: 'ghost-toolset', lanes: ['supervisor'], tools: ['some_tool'] });
  const fs = detectConfigDrift(actions, deps());
  const f = find(fs, 'documented-but-decommissioned', 'ghost-toolset', 'supervisor');
  assert.ok(f, 'unregistered toolset → decommissioned');
  assert.equal(f!.toolName, undefined, 'whole-toolset finding has no toolName');
  // Unregistered → no per-member decommission fan-out (we only enumerate live members).
  assert.equal(fs.filter((x) => x.kind === 'documented-but-decommissioned' && x.toolset === 'ghost-toolset' && x.toolName).length, 0);
});

// ── granted-but-undocumented ───────────────────────────────────────────────────

check('granted toolset that no persona documents → granted-but-undocumented (empty sources)', () => {
  const fs = detectConfigDrift([], deps()); // nothing documented at all
  const f = find(fs, 'granted-but-undocumented', 'orchestration', 'supervisor');
  assert.ok(f, 'orchestration granted to supervisor, undocumented');
  assert.deepEqual(f!.sources, []);
  // Every real grant across the three lanes surfaces when nothing is documented.
  assert.ok(find(fs, 'granted-but-undocumented', 'browser', 'researcher'));
  assert.ok(find(fs, 'granted-but-undocumented', 'comms', 'worker'));
});

check('a documented+granted toolset does NOT surface as undocumented', () => {
  const actions = mcpGrant({ toolset: 'orchestration', lanes: ['supervisor'], tools: ['launch_agent'] });
  const fs = detectConfigDrift(actions, deps());
  assert.equal(find(fs, 'granted-but-undocumented', 'orchestration', 'supervisor'), undefined);
  // ...and being documented for supervisor doesn't suppress the finding for OTHER lanes.
  assert.equal(find(fs, 'documented-but-not-granted', 'orchestration', 'supervisor'), undefined);
});

// ── clean config → silence ─────────────────────────────────────────────────────

check('a fully documented + granted + registered lane produces no drift', () => {
  const actions = [
    ...mcpGrant({ toolset: 'orchestration', lanes: ['supervisor'], tools: ['launch_agent'] }),
    ...mcpGrant({ toolset: 'comms', lanes: ['supervisor'], tools: ['send_message_to_agent'] }),
    ...mcpGrant({ toolset: 'observability', lanes: ['supervisor'], tools: ['read_agent_chat'] }),
    ...mcpGrant({ toolset: 'browser-present', lanes: ['supervisor'], tools: ['browser_present_url'] }),
  ];
  const fs = detectConfigDrift(actions, deps({ grantedToolsetsFor: (l) => (l === 'supervisor' ? GRANTS.supervisor : '') }));
  // Only the supervisor lane is under test (others have no grant here) → zero drift.
  assert.deepEqual(fs, []);
});

// ── ingestion + edge-case skips ────────────────────────────────────────────────

check('grant resolver accepts a pre-split list as well as a CSV string', () => {
  const actions = mcpGrant({ toolset: 'notebooks', lanes: ['worker'], tools: ['execute_notebook'] });
  const listDeps = deps({ grantedToolsetsFor: (l) => (l === 'worker' ? ['comms', 'observability', 'browser-present'] : []) });
  const fs = detectConfigDrift(actions, listDeps);
  assert.ok(find(fs, 'documented-but-not-granted', 'notebooks', 'worker'));
});

check('coarse toolset-usage with only {server} (no {toolset}) is skipped', () => {
  const a = action({ kind: 'toolset-usage', params: { server: 'Some MCP Server' }, lanes: ['worker'] });
  const fs = detectConfigDrift([a], deps({ grantedToolsetsFor: () => '' }));
  assert.equal(fs.filter((f) => f.kind !== 'granted-but-undocumented').length, 0, 'coarse server grant yields no documented-side drift');
});

check('a lone non-mcp tool-invocation (no sibling toolset-usage) is NOT flagged decommissioned', () => {
  const a = action({ kind: 'tool-invocation', params: { toolName: 'Read' }, lanes: ['worker'] });
  const fs = detectConfigDrift([a], deps({ grantedToolsetsFor: () => '' }));
  assert.deepEqual(fs, [], 'built-in tools are not grant-gated and must not drift');
});

check('legacy lane in action.lanes is skipped (no grant to compare against)', () => {
  const actions = mcpGrant({ toolset: 'notebooks', lanes: ['legacy'], tools: ['execute_notebook'] });
  const fs = detectConfigDrift(actions, deps({ grantedToolsetsFor: () => '' }));
  assert.equal(fs.filter((f) => f.kind !== 'granted-but-undocumented').length, 0);
});

// ── re-association + multi-lane ────────────────────────────────────────────────

check('member tools re-associate to their toolset via the shared source anchor', () => {
  // Two toolsets documented at DIFFERENT anchors; members must not cross-contaminate.
  const actions = [
    ...mcpGrant({ toolset: 'teams', lanes: ['supervisor'], tools: ['dead_team_tool'], absPath: '/w/a.md', line: 1 }),
    ...mcpGrant({ toolset: 'orchestration', lanes: ['supervisor'], tools: ['launch_agent'], absPath: '/w/b.md', line: 9 }),
  ];
  const fs = detectConfigDrift(actions, deps({ grantedToolsetsFor: (l) => (l === 'supervisor' ? 'teams,orchestration' : '') }));
  assert.ok(find(fs, 'documented-but-decommissioned', 'teams', 'supervisor', 'dead_team_tool'));
  // orchestration's live member must not be dragged into teams' decommission check.
  assert.equal(find(fs, 'documented-but-decommissioned', 'orchestration'), undefined);
});

check('a toolset documented by multiple lanes yields a not-granted finding per lane', () => {
  const actions = mcpGrant({ toolset: 'notebooks', lanes: ['worker', 'supervisor'], tools: ['execute_notebook'] });
  const fs = detectConfigDrift(actions, deps());
  assert.ok(find(fs, 'documented-but-not-granted', 'notebooks', 'worker'));
  assert.ok(find(fs, 'documented-but-not-granted', 'notebooks', 'supervisor'));
});

// ── WP-2A: fromProse resolution + synthetic-node exclusion ─────────────────────

check('WP-2A: a fromProse tool mention resolving uniquely → DOCUMENTED (documented-but-not-granted)', () => {
  // A resident-markdown prose mention `create_team` (compiler emits fromProse:'1'). It
  // resolves uniquely to the `teams` toolset via the reverse index; supervisor is not
  // granted teams → documented-but-not-granted, carrying its code-name provenance.
  const a = action({
    kind: 'tool-invocation', params: { toolName: 'create_team', fromProse: '1' },
    lanes: ['supervisor'], sourceSectionKey: 'markdown_section:/w:teams',
    source: { absPath: '/w/.dashboard/supervisor/CLAUDE.md', line: 7 },
  });
  const fs = detectConfigDrift([a], deps()); // supervisor grant lacks teams
  const f = find(fs, 'documented-but-not-granted', 'teams', 'supervisor');
  assert.ok(f, 'create_team resolves uniquely to teams → documented, not granted');
  assert.equal(f!.resolutionConfidence, 'code-name');
  assert.equal(f!.mentionedToolName, 'create_team');
  assert.equal(fs.filter((x) => x.kind === 'documented-unresolved-toolset').length, 0, 'a unique resolution is NOT unresolved');
});

check('WP-2A: a fromProse tool name in >1 toolset → documented-unresolved-toolset (ambiguous, never a subtract)', () => {
  const a = action({
    kind: 'tool-invocation', params: { toolName: 'shared_tool', fromProse: '1' },
    lanes: ['supervisor'], sourceSectionKey: 'markdown_section:/w:x',
    source: { absPath: '/w/.dashboard/supervisor/CLAUDE.md', line: 3 },
  });
  const ambDeps = deps({
    grantedToolsetsFor: () => '',
    registeredToolsets: () => ['teams', 'orchestration'],
    registeredToolNamesFor: (t) => (t === 'teams' || t === 'orchestration' ? ['shared_tool'] : null),
  });
  const fs = detectConfigDrift([a], ambDeps);
  const f = find(fs, 'documented-unresolved-toolset', 'shared_tool', 'supervisor');
  assert.ok(f, 'ambiguous mention surfaced as documented-unresolved-toolset');
  assert.deepEqual(f!.candidateToolsets, ['teams', 'orchestration'], 'both candidate toolsets carried, registered order');
  assert.equal(f!.mentionedToolName, 'shared_tool');
  // NEVER a subtract candidate.
  assert.equal(fs.filter((x) => x.kind === 'documented-but-not-granted' || x.kind === 'documented-but-decommissioned').length, 0);
});

check('WP-2A: a fromProse tool name in NO registered toolset → documented-unresolved-toolset (unresolved)', () => {
  const a = action({
    kind: 'tool-invocation', params: { toolName: 'ghost_tool', fromProse: '1' },
    lanes: ['worker'], sourceSectionKey: 'markdown_section:/w:x',
    source: { absPath: '/w/.dashboard/worker/CLAUDE.md', line: 5 },
  });
  const fs = detectConfigDrift([a], deps({ grantedToolsetsFor: () => '' }));
  const f = find(fs, 'documented-unresolved-toolset', 'ghost_tool', 'worker');
  assert.ok(f, 'unresolved mention surfaced');
  assert.deepEqual(f!.candidateToolsets, [], 'no candidate toolsets for an unresolved name');
});

check('WP-2A: a synthetic inventory node (empty sourceSectionKey) is excluded from DOCUMENTED', () => {
  // A toolset-usage with NO resident section identity = knowledge-extractor's synthetic MCP
  // inventory node (built FROM grants, source = toolset script line 1). It must NOT count as
  // documentation — otherwise DOCUMENTED fills with fakes and every grant reads as documented.
  const synthetic = action({
    kind: 'toolset-usage', params: { toolset: 'notebooks' },
    lanes: ['worker'], sourceSectionKey: '',
    source: { absPath: '/w/toolset-script.js', line: 1 },
  });
  const fs = detectConfigDrift([synthetic], deps()); // worker grant lacks notebooks
  assert.equal(find(fs, 'documented-but-not-granted', 'notebooks', 'worker'), undefined,
    'synthetic inventory node must not create a documented-but-not-granted finding');
  // The resident-markdown version (sourceSectionKey set) DOES count.
  const real = { ...synthetic, sourceSectionKey: 'markdown_section:/w:tools' };
  const fs2 = detectConfigDrift([real], deps());
  assert.ok(find(fs2, 'documented-but-not-granted', 'notebooks', 'worker'),
    'a resident-markdown toolset-usage still counts as DOCUMENTED');
});

// ── invariants ─────────────────────────────────────────────────────────────────

check('EVERY finding is observed-safe by construction', () => {
  const actions = [
    ...mcpGrant({ toolset: 'notebooks', lanes: ['worker'], tools: ['execute_notebook'] }),
    ...mcpGrant({ toolset: 'ghost', lanes: ['supervisor'], tools: ['g'] }),
  ];
  const fs = detectConfigDrift(actions, deps());
  assert.ok(fs.length > 0);
  assert.ok(fs.every((f) => f.evidenceTier === 'observed-safe'));
});

check('output is deterministic and ordered (kind, then lane, then toolset, then toolName)', () => {
  const actions = [
    ...mcpGrant({ toolset: 'notebooks', lanes: ['worker'], tools: ['execute_notebook'] }),
    ...mcpGrant({ toolset: 'teams', lanes: ['supervisor'], tools: ['zzz_dead', 'aaa_dead'] }),
  ];
  const run = () => detectConfigDrift(actions, deps({ grantedToolsetsFor: (l) => (l === 'supervisor' ? 'teams' : GRANTS[l]) }));
  const a = run();
  const b = run();
  assert.deepEqual(a, b, 'stable across runs');
  const kinds = a.map((f) => f.kind);
  // not-granted (0) findings precede decommissioned (1) precede undocumented (2).
  const ranks = kinds.map((k) => ({ 'documented-but-not-granted': 0, 'documented-but-decommissioned': 1, 'granted-but-undocumented': 2, 'documented-unresolved-toolset': 3 }[k]));
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y), 'kind order is monotonic');
  // within teams-decommissioned, toolName sorts ascending: aaa_dead before zzz_dead.
  const teamDead = a.filter((f) => f.kind === 'documented-but-decommissioned' && f.toolset === 'teams').map((f) => f.toolName);
  assert.deepEqual(teamDead, ['aaa_dead', 'zzz_dead']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
