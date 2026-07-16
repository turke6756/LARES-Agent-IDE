// @vitest-environment jsdom
/**
 * Usage panel (wave2 MCP-tool observability §2.5 + skill-usage legibility Part E)
 * acceptance: the MCP-tools view renders per-tool rows, the toolset drill expands
 * to its individual tools, the Dead-weight view renders its honest "pending" state,
 * and the scope line reflects the active lane/workspace filters. The two IPC query
 * endpoints (skillAnalytics.query, mcpToolUsage.query) are mocked on window.api.
 *
 *   npm run test:renderer
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  SkillUsageResult, McpToolUsageResult, SkillUsageQueryResult, McpToolUsageQueryResult,
} from '../../../shared/types';
import SkillAnalyticsPanel from './SkillAnalyticsPanel';

function skillResult(over: Partial<SkillUsageResult> = {}): SkillUsageResult {
  return {
    mostUsed: [{ skill: 'alpha', count: 3, avgEffectiveness: 0.9, lastUsedMs: 100 }],
    timeline: [{ tsMs: 100, skill: 'alpha', slug: 's', lane: 'worker', workspaceKey: 'projA', detector: 'tool_use', id: 'i1', jsonlPath: null }],
    timelineTruncated: false,
    byWorkspace: [{ key: 'projA', count: 3 }],
    byAgentType: [{ key: 'worker', count: 3 }],
    byAgentDir: [{ key: '/d', count: 3 }],
    byInvoker: [{ key: 'tool_use', count: 3 }],
    contextSamples: [{ skill: 'alpha', tsMs: 100, slug: 'projA', workingDir: '/d', lane: 'worker', detector: 'tool_use', args: null }],
    effectiveness: [{ skill: 'alpha', observableScore: 0.9, scoredInvocations: 3, positiveWindows: 3, errorWindows: 0, repeatedSearchWindows: 0, endedWithQuestionWindows: 0, heuristic: { userCorrection: 0, workflowFollowed: 0 } }],
    cost: [{ skill: 'alpha', invocations: 3, freshMedian: 1000, freshP25: 900, freshP75: 1100, freshInputMedian: 600, outputMedian: 400, cacheReadMedian: 5000 }],
    totalInvocations: 3,
    scopeMeta: { workspaceKeyIsSlugProxy: true, windowSinceMs: null, windowUntilMs: null, appliedLane: null, appliedSlug: null },
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    ...over,
  };
}

function mcpResult(over: Partial<McpToolUsageResult> = {}): McpToolUsageResult {
  const t1 = { toolName: 'mcp__agent-dashboard__browser_read_page', toolShort: 'browser_read_page', toolset: 'browser', count: 7, distinctStreams: 2, lastTsMs: 100 };
  const t2 = { toolName: 'mcp__agent-dashboard__browser_open_url', toolShort: 'browser_open_url', toolset: 'browser', count: 4, distinctStreams: 1, lastTsMs: 90 };
  return {
    byTool: [t1, t2],
    byToolset: [{ toolset: 'browser', count: 11, distinctStreams: 3, tools: [t1, t2] }],
    byAgent: [{ key: '(unattributed)', label: '(unattributed — session-based)', count: 10, agentId: null }, { key: 'ag-1', label: 'Worker A', count: 1, agentId: 'ag-1' }],
    bySession: [{ key: 's-1', label: 'session s-1', count: 11 }],
    byWorkspace: [{ key: 'projA', label: 'projA', count: 11 }],
    byLane: [{ key: 'worker', label: 'worker', count: 11 }],
    byToolLane: [
      { toolName: t1.toolName, toolShort: t1.toolShort, toolset: 'browser', lane: 'researcher', tier: 'lane-inferred-from-current-grant', count: 7 },
      { toolName: t2.toolName, toolShort: t2.toolShort, toolset: 'browser', lane: '(unattributed)', tier: 'unattributed', count: 4 },
    ],
    tierBreakdown: { 'agent-attributed': 1, 'lane-attributed-explicit': 0, 'lane-inferred-from-current-grant': 6, unattributed: 4 },
    attributedCount: 7,
    unattributedCount: 4,
    attributionCoveragePct: 63.6,
    timeline: [{ tsMs: 90, toolShort: 'browser_open_url', toolset: 'browser' }, { tsMs: 100, toolShort: 'browser_read_page', toolset: 'browser' }],
    timelineTruncated: false,
    totalCalls: 11,
    attributedCalls: 1,
    scopeMeta: { workspaceKeyIsSlugProxy: true, attributionIsSessionBased: true, droppedUnattributedCalls: 0, appliedLane: null, appliedSlug: null, appliedAgentId: null, windowSinceMs: null, windowUntilMs: null },
    generatedAtIso: '2026-07-06T00:00:00.000Z',
    ...over,
  };
}

let skillData = skillResult();
let mcpData = mcpResult();

function installApi(): void {
  (globalThis as any).window.api = {
    skillAnalytics: {
      query: vi.fn(async (): Promise<SkillUsageQueryResult> => ({ ok: true, data: skillData })),
      indexPoll: vi.fn(async () => ({ ready: true })),
      indexStatus: vi.fn(async () => ({ ready: true })),
      onIndexProgress: vi.fn(() => () => {}),
    },
    mcpToolUsage: {
      query: vi.fn(async (): Promise<McpToolUsageQueryResult> => ({ ok: true, data: mcpData })),
    },
  };
}

async function flush(): Promise<void> {
  // Let the mount effects (load + indexPoll) and their promise chains settle.
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

function findButton(container: HTMLElement, text: string): HTMLElement {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`button "${text}" not found`);
  return el as HTMLElement;
}

describe('SkillAnalyticsPanel (Usage)', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    skillData = skillResult();
    mcpData = mcpResult();
    installApi();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it('MCP tools view renders per-tool rows and the toolset drill expands', async () => {
    await act(async () => { root.render(<SkillAnalyticsPanel />); });
    await flush();
    // Switch to the MCP tools view.
    await act(async () => { findButton(container, 'MCP tools').click(); });
    await flush();

    // Per-tool rows (short names) are present.
    expect(container.textContent).toContain('browser_read_page');
    expect(container.textContent).toContain('browser_open_url');
    expect(container.textContent).toContain('Most used MCP tools');

    // Toolset drill: the "browser" toolset row exists; expanding it keeps tool children visible.
    expect(container.textContent).toContain('By toolset');
    const toolsetToggle = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('browser') && b.getAttribute('aria-expanded') !== null);
    expect(toolsetToggle).toBeTruthy();
    await act(async () => { (toolsetToggle as HTMLElement).click(); });
    await flush();
    // After expand the child tool rows render inside the drill (short names, counts).
    expect(container.textContent).toContain('2 tools');
  });

  it('MCP breakdown discloses session-based attribution', async () => {
    await act(async () => { root.render(<SkillAnalyticsPanel />); });
    await flush();
    await act(async () => { findButton(container, 'MCP tools').click(); });
    await flush();
    expect(container.textContent).toContain('MCP breakdown');
    expect(container.textContent?.toLowerCase()).toContain('unattributed');
    // 10/11 calls unattributed → ~91%.
    expect(container.textContent).toContain('91% of calls are unattributed');
  });

  it('MCP scope line discloses calls hidden by a workspace filter (dropped-unattributed)', async () => {
    // A workspace scope that drops unattributable rows must be surfaced, not silent
    // (adversarial-review finding #2 / Tail T2).
    mcpData = mcpResult({
      scopeMeta: {
        workspaceKeyIsSlugProxy: true, attributionIsSessionBased: true, droppedUnattributedCalls: 5,
        appliedLane: null, appliedSlug: null, appliedAgentId: null, windowSinceMs: null, windowUntilMs: null,
      },
    });
    await act(async () => { root.render(<SkillAnalyticsPanel />); });
    await flush();
    // The note is on the always-visible scope line (no view switch needed).
    expect(container.textContent).toContain('5 MCP calls are hidden by this workspace filter');
    expect(container.textContent).toContain('unattributable to any workspace');
  });

  it('MCP scope line shows NO dropped-unattributed note when nothing is dropped', async () => {
    await act(async () => { root.render(<SkillAnalyticsPanel />); });
    await flush();
    // Default fixture has droppedUnattributedCalls: 0 → the note must be absent.
    expect(container.textContent).not.toContain('hidden by this workspace filter');
  });

  it('Dead-weight view renders an honest "pending" state (no fabricated numbers)', async () => {
    await act(async () => { root.render(<SkillAnalyticsPanel />); });
    await flush();
    await act(async () => { findButton(container, 'Dead weight').click(); });
    await flush();
    expect(container.textContent).toContain('Dead-weight MCP tool grants');
    expect(container.textContent?.toLowerCase()).toContain('not yet wired');
  });

  it('scope line reflects the active lane filter', async () => {
    await act(async () => { root.render(<SkillAnalyticsPanel />); });
    await flush();
    // Default scope line discloses the slug proxy.
    expect(container.textContent).toContain('workspace path not yet recorded');
    // Pick the "Worker" agent-type filter.
    await act(async () => { findButton(container, 'Worker').click(); });
    await flush();
    expect(container.textContent).toContain('Showing');
    expect(container.textContent).toContain('Worker');
    // The lane filter is echoed as an active chip too.
    expect(container.textContent).toContain('Agent type: Worker');
  });
});
