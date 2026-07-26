// @vitest-environment jsdom
//
// Context-overhead per-tool drill-down (feat: analytics-ui). The MCP tool-schema
// group rows (orchestration, comms, …) are expandable: collapsed by default and
// pixel-identical to before; when expanded they list each tool's name + estimated
// schema token cost, sorted DESCENDING by tokens. Groups that carry no per-tool
// detail (named-only servers) stay exactly as before — no chevron, no drill.
//
// The single IPC endpoint the panel reads (contextOverhead.scan) is mocked on
// window.api; the dashboard store supplies selectedWorkspaceId so the mount scan
// fires.
//
//   npm run test:renderer
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ContextOverheadPanel from './ContextOverheadPanel';
import { useDashboardStore } from '../../stores/dashboard-store';
import type {
  AgentContextOverhead, McpServerOverhead, McpToolOverhead, OverheadModel,
  ScanOverheadResult, TokenEstimate,
} from '../../../shared/types';

function est(tokens: number): TokenEstimate {
  return { tokens, bytes: tokens * 4, chars: tokens * 4, method: 'tiktoken-approx', approximate: true };
}

function tool(name: string, tokens: number): McpToolOverhead {
  return { name, descriptionTokens: Math.round(tokens / 2), inputSchemaTokens: Math.round(tokens / 2), estimate: est(tokens), schemaSource: 'dashboard-module' };
}

// Deliberately UNSORTED, to prove the panel sorts descending by tokens itself.
const ORCH_TOOLS: McpToolOverhead[] = [
  tool('run_orchestration', 493),
  tool('launch_agent', 963),
  tool('stop_agent', 49),
  tool('send_keys_to_agent', 884),
  tool('create_persona', 146),
  tool('abort_orchestration', 45),
  tool('fork_agent', 56),
  tool('get_orchestration_run', 48),
];

function server(over: Partial<McpServerOverhead> = {}): McpServerOverhead {
  return {
    id: 'orchestration',
    displayName: 'orchestration',
    source: 'dashboard-injected',
    configPath: null,
    grantedToAgent: true,
    excludedByStrictMode: false,
    schemaSourced: true,
    total: est(2684),
    tools: ORCH_TOOLS,
    warnings: [],
    ...over,
  };
}

function agent(over: Partial<AgentContextOverhead> = {}): AgentContextOverhead {
  return {
    id: 'ag-1',
    name: 'Supervisor',
    kind: 'builtin-supervisor',
    lane: 'supervisor',
    workingDir: '/ws/.lares/supervisor',
    pathType: 'windows',
    inheritanceChain: [],
    mcpServers: [server()],
    flatSources: [],
    total: est(3000),
    totalHeaderView: est(3000),
    residentTotal: est(3000),
    onDemandTotal: est(0),
    exactness: 'estimated',
    warnings: [],
    ...over,
  };
}

function model(agents: AgentContextOverhead[]): OverheadModel {
  return {
    workspaceId: 'ws',
    workspaceRoot: '/ws',
    pathType: 'windows',
    generatedAt: '2026-07-26T00:00:00.000Z',
    estimatorMethod: 'tiktoken-approx',
    agents,
    globalWarnings: [],
  };
}

let scanResult: ScanOverheadResult;
let container: HTMLDivElement;
let root: Root | null;

function installApi(): void {
  (window as any).api = {
    contextOverhead: {
      scan: vi.fn(async (): Promise<ScanOverheadResult> => scanResult),
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

async function render(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(<ContextOverheadPanel />);
  });
  await flush();
}

/** Expand a top-level agent drill-down by its visible name, then return the panel. */
async function openAgent(name: string): Promise<void> {
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(name) && b.textContent?.includes('tok'));
  if (!btn) throw new Error(`agent drill-down button "${name}" not found`);
  await act(async () => { (btn as HTMLElement).click(); });
  await flush();
}

/** The chevron toggle for an MCP group row, found by its aria-expanded + title. */
function toolToggle(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-expanded') !== null && (b.getAttribute('title') ?? '').includes('per-tool schema costs'),
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
  scanResult = { ok: true, model: model([agent()]) };
  installApi();
  useDashboardStore.setState({ selectedWorkspaceId: 'ws' } as any);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
  useDashboardStore.setState({ selectedWorkspaceId: null } as any);
});

describe('ContextOverheadPanel — per-tool drill-down', () => {
  it('MCP group rows are collapsed by default: no tool names visible, chevron present', async () => {
    await render();
    await openAgent('Supervisor');

    // The group row itself renders (toolset name + total), with a per-tool chevron.
    expect(container.textContent).toContain('orchestration');
    expect(container.textContent).toContain('MCP tool schemas');
    expect(toolToggle()).toBeTruthy();

    // Collapsed: individual tool names are NOT yet rendered.
    expect(container.textContent).not.toContain('launch_agent');
    expect(container.textContent).not.toContain('send_keys_to_agent');
  });

  it('expanding a group lists its tools sorted DESCENDING by token estimate', async () => {
    await render();
    await openAgent('Supervisor');
    await act(async () => { toolToggle()!.click(); });
    await flush();

    // All eight tools now render.
    for (const t of ORCH_TOOLS) expect(container.textContent).toContain(t.name);

    // The rendered order of the tool names is strictly descending by tokens.
    const text = container.textContent ?? '';
    const order = ORCH_TOOLS
      .map((t) => ({ name: t.name, tokens: t.estimate.tokens, at: text.indexOf(t.name) }))
      .sort((a, b) => a.at - b.at);
    // Expected: launch_agent 963, send_keys_to_agent 884, run_orchestration 493,
    // create_persona 146, fork_agent 56, stop_agent 49, get_orchestration_run 48,
    // abort_orchestration 45.
    expect(order.map((o) => o.name)).toEqual([
      'launch_agent', 'send_keys_to_agent', 'run_orchestration', 'create_persona',
      'fork_agent', 'stop_agent', 'get_orchestration_run', 'abort_orchestration',
    ]);
    // Tokens are non-increasing down the list.
    for (let i = 1; i < order.length; i++) expect(order[i].tokens).toBeLessThanOrEqual(order[i - 1].tokens);
  });

  it('collapse hides the tool rows again (toggle is reversible)', async () => {
    await render();
    await openAgent('Supervisor');
    await act(async () => { toolToggle()!.click(); });
    await flush();
    expect(container.textContent).toContain('launch_agent');

    await act(async () => { toolToggle()!.click(); });
    await flush();
    expect(container.textContent).not.toContain('launch_agent');
  });

  it('a group with NO per-tool detail renders exactly as before — no chevron, no drill', async () => {
    // Named-only server: tools:[] (schema requires a live MCP connection).
    scanResult = {
      ok: true,
      model: model([agent({ mcpServers: [server({ id: 'namedonly', displayName: 'namedonly', tools: [], schemaSourced: false })] })]),
    };
    await render();
    await openAgent('Supervisor');

    // The group still renders, but there is no per-tool toggle for it.
    expect(container.textContent).toContain('namedonly');
    expect(toolToggle()).toBeUndefined();
  });
});
