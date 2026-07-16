// agent-dto-observability page-builder tests — WP7 skill-usage + agent-knowledge
// surfaces (lean list + detail, cursor paging, §5.6 path redaction).
//   npm run build:main
//   node dist/main/main/context-optimizer/agent-dto-observability.test.js

import assert from 'node:assert/strict';
import type { AgentKnowledgeGraph, McpToolUsageResult, SkillUsageResult } from '../../shared/types';
import type { RedactionRoots } from './agent-dto';
import {
  buildSkillUsagePage, buildSkillUsageDetail,
  buildAgentKnowledgePage, buildAgentKnowledgeDetail,
  buildMcpToolUsagePage,
} from './agent-observability-build';

let passed = 0;
function ok(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok - ${name}`); }

function skillResult(over: Partial<SkillUsageResult> = {}): SkillUsageResult {
  return {
    mostUsed: [
      { skill: 'alpha', count: 5, avgEffectiveness: 0.8, lastUsedMs: 100 },
      { skill: 'beta', count: 3, avgEffectiveness: null, lastUsedMs: 50 },
    ],
    timeline: [
      { tsMs: 100, skill: 'alpha', slug: 's', lane: 'worker', workspaceKey: 's', detector: 'tool_use', id: 'a', jsonlPath: null },
      { tsMs: 50, skill: 'beta', slug: 's', lane: 'worker', workspaceKey: 's', detector: 'tool_use', id: 'b', jsonlPath: null },
    ],
    timelineTruncated: false,
    byWorkspace: [], byAgentType: [], byAgentDir: [], byInvoker: [],
    contextSamples: [{ skill: 'alpha', tsMs: 100, slug: 's', workingDir: null, lane: 'worker', detector: 'tool_use', args: null }],
    effectiveness: [{
      skill: 'alpha', observableScore: 0.8, scoredInvocations: 5, positiveWindows: 4,
      errorWindows: 1, repeatedSearchWindows: 0, endedWithQuestionWindows: 0,
      heuristic: { userCorrection: 0, workflowFollowed: 0 },
    }],
    cost: [{
      skill: 'alpha', invocations: 5, freshMedian: 1000, freshP25: 800, freshP75: 1200,
      freshInputMedian: 600, outputMedian: 400, cacheReadMedian: 5000,
    }],
    totalInvocations: 8,
    scopeMeta: {
      workspaceKeyIsSlugProxy: true, windowSinceMs: null, windowUntilMs: null,
      appliedLane: null, appliedSlug: null,
      appliedWorkspaceId: null, droppedUnattributedCount: 0, hasAnyInvocations: true,
    },
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    ...over,
  };
}

const ROOTS: RedactionRoots = {
  workspaceRoot: 'C:/ws', dashboardRoot: 'C:/ws/.dashboard', homeDir: 'C:/Users/someone',
};

function knowledgeGraph(over: Partial<AgentKnowledgeGraph> = {}): AgentKnowledgeGraph {
  return {
    agentId: 'ag-1', agentName: 'Worker',
    nodes: [
      { type: 'capability', label: 'Can do X', detail: 'x'.repeat(400), source: { absPath: 'C:/ws/CLAUDE.md', lineStart: 10, lineEnd: 10 }, sourceScope: 'workspace-ancestor', sourceRole: 'workspace-claude' },
      { type: 'tool', label: 'Bash', detail: 'run commands', source: { absPath: 'C:/ws/.dashboard/workers/claude/CLAUDE.md', lineStart: 5, lineEnd: 5 }, sourceRole: 'agent-claude' },
      { type: 'constraint', label: 'No commits', source: { absPath: 'C:/Users/someone/.claude/CLAUDE.md', lineStart: 2, lineEnd: 2 }, sourceRole: 'user-claude' },
    ],
    sourceFiles: [{ absPath: 'C:/ws/CLAUDE.md', scope: 'workspace-ancestor', kind: 'inherited-claude', label: 'CLAUDE.md', nodeCount: 1 }],
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    ...over,
  };
}

// ── skill usage ──────────────────────────────────────────────────────────────────
ok('skill-usage list: lean rows, count DESC, effectiveness+cost folded in', () => {
  const page = buildSkillUsagePage(skillResult(), {});
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.deepEqual(page.data.skills.map((s) => s.id), ['alpha', 'beta']);
  assert.equal(page.data.skills[0].observableScore, 0.8);
  assert.equal(page.data.skills[0].freshMedian, 1000);
  assert.equal(page.data.skills[1].observableScore, null, 'beta has no effectiveness row');
  assert.equal(page.data.skills[1].freshMedian, 0);
  assert.equal(page.data.timeline.length, 2);
  assert.equal(page.meta.dataState, 'ready');
});

ok('skill-usage cursor pages then STALE across a count change', () => {
  const res = skillResult();
  const p1 = buildSkillUsagePage(res, { limit: 1 });
  assert.equal(p1.ok && p1.data.skills.map((s) => s.id).join(','), 'alpha');
  assert.equal(p1.ok && p1.page?.hasMore, true);
  const cur = (p1.ok && p1.page?.nextCursor) as string;
  const p2 = buildSkillUsagePage(res, { limit: 1, cursor: cur });
  assert.equal(p2.ok && p2.data.skills.map((s) => s.id).join(','), 'beta');
  // Regenerate: change a count → new generationId → stale cursor.
  const res2 = skillResult({ mostUsed: [
    { skill: 'alpha', count: 9, avgEffectiveness: 0.8, lastUsedMs: 100 },
    { skill: 'beta', count: 3, avgEffectiveness: null, lastUsedMs: 50 },
  ] });
  const stale = buildSkillUsagePage(res2, { limit: 1, cursor: cur });
  assert.equal(stale.ok === false && stale.error.code, 'CURSOR_STALE');
});

// WP-D fix leg — an empty page NEVER emits a bare 'empty'; it carries an honest
// dataState + dataStateReason + a typed warning distinguishing the empty cause.
ok('skill-usage empty (no filters, table non-empty) → empty_no_events + typed warning', () => {
  const page = buildSkillUsagePage(skillResult({ mostUsed: [], totalInvocations: 0 }), {});
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(page.meta.dataState, 'empty_no_events');
  assert.ok(page.meta.dataStateReason && page.meta.dataStateReason.length > 0, 'carries a human reason');
  assert.equal(page.warnings.some((w) => w.code === 'SKILL_USAGE_NO_EVENTS'), true);
});

ok('skill-usage empty (workspace-scoped, corpus non-empty) → empty_out_of_scope + SCOPED_OUT + dropped count', () => {
  const page = buildSkillUsagePage(skillResult({
    mostUsed: [], totalInvocations: 0,
    scopeMeta: {
      workspaceKeyIsSlugProxy: true, windowSinceMs: null, windowUntilMs: null,
      appliedLane: null, appliedSlug: null,
      appliedWorkspaceId: 'ws-uuid', droppedUnattributedCount: 126, hasAnyInvocations: true,
    },
  }), {});
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(page.meta.dataState, 'empty_out_of_scope');
  const w = page.warnings.find((x) => x.code === 'SKILL_USAGE_SCOPED_OUT');
  assert.ok(w, 'emits the scoped-out warning');
  assert.equal(w!.details?.droppedUnattributedCount, 126, 'discloses the dropped-unattributed count');
});

ok('skill-usage empty (truly empty table) → empty_not_instrumented', () => {
  const page = buildSkillUsagePage(skillResult({
    mostUsed: [], totalInvocations: 0,
    scopeMeta: {
      workspaceKeyIsSlugProxy: true, windowSinceMs: null, windowUntilMs: null,
      appliedLane: null, appliedSlug: null,
      appliedWorkspaceId: null, droppedUnattributedCount: 0, hasAnyInvocations: false,
    },
  }), {});
  assert.equal(page.ok && page.meta.dataState, 'empty_not_instrumented');
  assert.equal(page.ok && page.warnings.some((w) => w.code === 'SKILL_USAGE_NOT_INSTRUMENTED'), true);
});

ok('skill-usage empty (time window) → empty_outside_window', () => {
  const page = buildSkillUsagePage(skillResult({
    mostUsed: [], totalInvocations: 0,
    scopeMeta: {
      workspaceKeyIsSlugProxy: true, windowSinceMs: 1000, windowUntilMs: 2000,
      appliedLane: null, appliedSlug: null,
      appliedWorkspaceId: null, droppedUnattributedCount: 0, hasAnyInvocations: true,
    },
  }), {});
  assert.equal(page.ok && page.meta.dataState, 'empty_outside_window');
  assert.equal(page.ok && page.warnings.some((w) => w.code === 'SKILL_USAGE_OUTSIDE_WINDOW'), true);
});

ok('skill-usage empty (fresh install, backfill marker unset) → indexing, not "unused"', () => {
  const page = buildSkillUsagePage(skillResult({ mostUsed: [], totalInvocations: 0 }), {}, { indexing: true });
  assert.equal(page.ok && page.meta.dataState, 'indexing');
  // No misleading empty warning while indexing is still building.
  assert.equal(page.ok && page.warnings.some((w) => String(w.code).startsWith('SKILL_USAGE_')), false);
});

ok('skill-usage detail: full effectiveness/cost/timeline; unknown id → INVALID_ARGUMENT', () => {
  const d = buildSkillUsageDetail(skillResult(), 'alpha');
  assert.equal(d.ok, true);
  if (d.ok) {
    assert.equal(d.data.effectiveness?.observableScore, 0.8);
    assert.equal(d.data.cost?.freshMedian, 1000);
    assert.equal(d.data.timeline.every((t) => t.skill === 'alpha'), true);
    assert.equal(d.data.contextSamples.length, 1);
  }
  const miss = buildSkillUsageDetail(skillResult(), 'nope');
  assert.equal(miss.ok === false && miss.error.code, 'INVALID_ARGUMENT');
});

// ── agent knowledge ────────────────────────────────────────────────────────────
ok('knowledge list: redacted paths (no username/drive), truncated detail, ≤2 citations', () => {
  const page = buildAgentKnowledgePage(knowledgeGraph(), ROOTS, {});
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(page.data.agentName, 'Worker');
  assert.equal(page.data.nodes.length, 3);
  for (const n of page.data.nodes) {
    assert.equal(n.citations.length <= 2, true);
    for (const c of n.citations) {
      assert.match(c.pathDisplay, /^(\$WORKSPACE|\$DASHBOARD|~|external)/, `scoped: ${c.pathDisplay}`);
      assert.doesNotMatch(c.pathDisplay, /C:|Users|someone/, `no drive/username: ${c.pathDisplay}`);
    }
  }
  const capNode = page.data.nodes.find((n) => n.type === 'capability');
  assert.equal((capNode?.detail?.length ?? 0) <= 240, true, 'list detail truncated');
  assert.equal(capNode?.detail?.endsWith('…'), true);
});

ok('knowledge detail: full untruncated detail; unknown id → INVALID_ARGUMENT', () => {
  const list = buildAgentKnowledgePage(knowledgeGraph(), ROOTS, {});
  assert.equal(list.ok, true);
  if (!list.ok) return;
  const id = list.data.nodes.find((n) => n.type === 'capability')!.id;
  const d = buildAgentKnowledgeDetail(knowledgeGraph(), ROOTS, id);
  assert.equal(d.ok, true);
  assert.equal(d.ok && d.data.detail?.length, 400, 'detail route carries full text');
  const miss = buildAgentKnowledgeDetail(knowledgeGraph(), ROOTS, 'deadbeef');
  assert.equal(miss.ok === false && miss.error.code, 'INVALID_ARGUMENT');
});

ok('knowledge node ids are stable + cursor pages', () => {
  const a = buildAgentKnowledgePage(knowledgeGraph(), ROOTS, {});
  const b = buildAgentKnowledgePage(knowledgeGraph(), ROOTS, {});
  assert.deepEqual(a.ok && a.data.nodes.map((n) => n.id), b.ok && b.data.nodes.map((n) => n.id));
  const p1 = buildAgentKnowledgePage(knowledgeGraph(), ROOTS, { limit: 2 });
  assert.equal(p1.ok && p1.page?.hasMore, true);
  const cur = (p1.ok && p1.page?.nextCursor) as string;
  const p2 = buildAgentKnowledgePage(knowledgeGraph(), ROOTS, { limit: 2, cursor: cur });
  assert.equal(p2.ok && p2.data.nodes.length, 1);
});

// ── mcp tool usage (WP-C / P2: lean four-tier rollup) ──────────────────────────────

function mcpUsageResult(over: Partial<McpToolUsageResult> = {}): McpToolUsageResult {
  // A deliberately LARGE, noisy corpus so the caps + payload budget are exercised:
  // 60 distinct tools, a wide tool×lane cross-tab, and a 500-row timeline.
  const byTool = Array.from({ length: 60 }, (_, i) => ({
    toolName: `mcp__agent-dashboard__tool_number_${i}_with_a_long_descriptive_name`,
    toolShort: `tool_number_${i}_with_a_long_descriptive_name`,
    toolset: i % 3 === 0 ? 'observability' : i % 3 === 1 ? 'browser' : null,
    count: 1000 - i,
    distinctStreams: 5,
    lastTsMs: 10_000 + i,
  }));
  const lanes = ['worker', 'supervisor', 'researcher', '(unattributed)'];
  const tiers = ['agent-attributed', 'lane-attributed-explicit', 'lane-inferred-from-current-grant', 'unattributed'] as const;
  const byToolLane = byTool.flatMap((t, i) =>
    lanes.map((lane, li) => ({
      toolName: t.toolName, toolShort: t.toolShort, toolset: t.toolset,
      lane, tier: tiers[li], count: 100 - i - li,
    })),
  );
  const tierBreakdown = { 'agent-attributed': 96, 'lane-attributed-explicit': 480, 'lane-inferred-from-current-grant': 240, unattributed: 184 };
  const attributedCount = 96 + 480 + 240; // 816
  const total = attributedCount + 184;    // 1000
  return {
    byTool,
    byToolset: [],
    byAgent: [],
    bySession: [],
    byWorkspace: [],
    byLane: lanes.map((l, i) => ({ key: l, label: l, count: 250 - i })),
    byToolLane,
    tierBreakdown,
    attributedCount,
    unattributedCount: 184,
    attributionCoveragePct: Math.round((attributedCount / total) * 1000) / 10,
    timeline: Array.from({ length: 500 }, (_, i) => ({ tsMs: i, toolShort: `tool_number_${i % 60}`, toolset: 'observability' })),
    timelineTruncated: false,
    totalCalls: total,
    attributedCalls: 96,
    scopeMeta: {
      workspaceKeyIsSlugProxy: true, attributionIsSessionBased: true,
      droppedUnattributedCalls: 0, appliedLane: null, appliedSlug: null,
      appliedAgentId: null, windowSinceMs: null, windowUntilMs: null,
    },
    generatedAtIso: '2026-07-09T00:00:00.000Z',
    ...over,
  };
}

ok('mcp-tool-usage: lean rollup carries the FULL four-tier disclosure + coverage band', () => {
  const page = buildMcpToolUsagePage(mcpUsageResult(), {});
  assert.equal(page.ok, true);
  if (!page.ok) return;
  const d = page.data;
  // All four tiers present (honest four-tier disclosure), even after capping.
  assert.deepEqual(
    Object.keys(d.tierBreakdown).sort(),
    ['agent-attributed', 'lane-attributed-explicit', 'lane-inferred-from-current-grant', 'unattributed'],
  );
  assert.equal(d.attributedCount, 816);
  assert.equal(d.unattributedCount, 184);
  assert.equal(d.attributionCoveragePct, 81.6);
  assert.equal(d.laneCoverageBand, 'direct'); // >80%
  assert.ok(d.nextDrill.length > 0, 'a next-drill hint is present');
  assert.equal(page.meta.dataState, 'ready');
});

ok('mcp-tool-usage: default payload is capped and stays ≤ ~15k chars', () => {
  const page = buildMcpToolUsagePage(mcpUsageResult(), {});
  assert.equal(page.ok, true);
  if (!page.ok) return;
  const d = page.data;
  assert.ok(d.byTool.length <= 15, `byTool capped (got ${d.byTool.length})`);
  assert.ok(d.byToolLane.length <= 40, `byToolLane capped (got ${d.byToolLane.length})`);
  assert.ok(d.timeline.length <= 100, `timeline capped (got ${d.timeline.length})`);
  const chars = JSON.stringify(d).length;
  assert.ok(chars <= 15000, `default payload ${chars} chars must be ≤ 15000`);
});

ok('mcp-tool-usage: a low-coverage corpus reports the diagnostic band, not a lane verdict', () => {
  const page = buildMcpToolUsagePage(mcpUsageResult({
    tierBreakdown: { 'agent-attributed': 96, 'lane-attributed-explicit': 0, 'lane-inferred-from-current-grant': 0, unattributed: 904 },
    attributedCount: 96, unattributedCount: 904, attributionCoveragePct: 9.6,
    totalCalls: 1000,
  }), {});
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(page.data.attributionCoveragePct, 9.6);
  assert.equal(page.data.laneCoverageBand, 'diagnostic');
  assert.ok(/coverage diagnostic|too low/i.test(page.data.nextDrill), 'hint frames it as a coverage diagnostic');
});

ok('mcp-tool-usage: empty corpus → dataState empty, 0% coverage', () => {
  const page = buildMcpToolUsagePage(mcpUsageResult({
    byTool: [], byToolLane: [], byLane: [], timeline: [],
    tierBreakdown: { 'agent-attributed': 0, 'lane-attributed-explicit': 0, 'lane-inferred-from-current-grant': 0, unattributed: 0 },
    attributedCount: 0, unattributedCount: 0, attributionCoveragePct: 0, totalCalls: 0, attributedCalls: 0,
  }), {});
  assert.equal(page.ok && page.meta.dataState, 'empty');
  assert.equal(page.ok && page.data.attributionCoveragePct, 0);
});

console.log(`\nagent-dto-observability: ${passed} passed`);
