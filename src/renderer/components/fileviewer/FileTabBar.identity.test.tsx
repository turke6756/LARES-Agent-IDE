// @vitest-environment jsdom
/**
 * Plan-tab identity (wave-3 Part B). A plan tab must be visually distinct from
 * a file tab and from a tool tab: it carries a purple `Map` glyph, tags its root
 * with data-tab-kind="plan", and — because a plan surface has no editable
 * source — never shows the unsaved-changes dot.
 *
 * Covers:
 *   - a kind:'plan' tab renders [data-testid="plan-tab-icon"];
 *   - a kind:'tool' tab still renders [data-testid="tool-tab-icon"] (BarChart3);
 *   - a plain file tab renders neither glyph;
 *   - the plan tab root carries data-tab-kind="plan" (file tab → "file");
 *   - a dirty plan tab shows NO dirty dot (guards B2's !isPlan exclusion).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FileTabBar from './FileTabBar';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

const storeMock = vi.hoisted(() => {
  const state: any = {
    tabEditState: {} as Record<string, { dirty?: boolean; mode?: string }>,
    selectedWorkspaceId: 'ws-1',
    moveTab: vi.fn(),
    setTabColor: vi.fn(),
    saveTab: vi.fn(async () => true),
    detachTab: vi.fn(),
  };
  const useDashboardStore: any = (selector: (s: typeof state) => unknown) => selector(state);
  useDashboardStore.getState = () => state;
  return { state, useDashboardStore };
});

vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: storeMock.useDashboardStore,
}));

const FILE_TAB = {
  id: 'file-1',
  filePath: 'C:\\ws\\docs\\notes.md',
  rootDirectory: 'C:\\ws',
  pathType: 'windows' as const,
  workspaceId: 'ws-1',
  label: 'notes.md',
};
const TOOL_TAB = {
  id: 'tool-1',
  filePath: '',
  rootDirectory: '',
  pathType: 'windows' as const,
  workspaceId: 'ws-1',
  label: 'Context Overhead',
  kind: 'tool' as const,
  toolId: 'context-overhead',
};
const PLAN_TAB = {
  id: 'plan-1',
  filePath: '',
  rootDirectory: '',
  pathType: 'windows' as const,
  workspaceId: 'ws-1',
  label: 'Auth Plan',
  kind: 'plan' as const,
  planId: 'plan-1',
};

let container: HTMLDivElement;
let root: Root;

function render(tabs: any[]) {
  act(() => {
    root.render(
      React.createElement(FileTabBar, {
        tabs,
        activeTabId: tabs[0]?.id ?? null,
        onSelectTab: () => {},
        onCloseTab: () => {},
      }),
    );
  });
}

const tabRoot = (id: string): HTMLElement =>
  container.querySelector(`[data-tab-id="${id}"]`) as HTMLElement;

beforeEach(() => {
  storeMock.state.tabEditState = {};
  (globalThis as any).window.api = {
    tabs: { detach: vi.fn() },
    system: { openFileInWorkspace: vi.fn() },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('FileTabBar plan-tab identity', () => {
  it('renders the purple Map glyph only on plan tabs; blue chart glyph only on tool tabs', () => {
    render([FILE_TAB, TOOL_TAB, PLAN_TAB]);

    // Plan tab: plan glyph, no tool glyph.
    expect(tabRoot('plan-1').querySelector('[data-testid="plan-tab-icon"]')).not.toBeNull();
    expect(tabRoot('plan-1').querySelector('[data-testid="tool-tab-icon"]')).toBeNull();

    // Tool tab: tool glyph, no plan glyph.
    expect(tabRoot('tool-1').querySelector('[data-testid="tool-tab-icon"]')).not.toBeNull();
    expect(tabRoot('tool-1').querySelector('[data-testid="plan-tab-icon"]')).toBeNull();

    // File tab: neither glyph.
    expect(tabRoot('file-1').querySelector('[data-testid="plan-tab-icon"]')).toBeNull();
    expect(tabRoot('file-1').querySelector('[data-testid="tool-tab-icon"]')).toBeNull();
  });

  it('tags each tab root with data-tab-kind', () => {
    render([FILE_TAB, TOOL_TAB, PLAN_TAB]);
    expect(tabRoot('plan-1').getAttribute('data-tab-kind')).toBe('plan');
    expect(tabRoot('tool-1').getAttribute('data-tab-kind')).toBe('tool');
    expect(tabRoot('file-1').getAttribute('data-tab-kind')).toBe('file');
  });

  it('never shows the dirty dot on a plan tab, even when the store marks it dirty (B2)', () => {
    storeMock.state.tabEditState = { 'plan-1': { dirty: true }, 'file-1': { dirty: true } };
    render([FILE_TAB, PLAN_TAB]);
    // File tab with dirty state shows the dot…
    expect(tabRoot('file-1').querySelector('[title="Unsaved changes"]')).not.toBeNull();
    // …but the plan tab is excluded from the dirty dot.
    expect(tabRoot('plan-1').querySelector('[title="Unsaved changes"]')).toBeNull();
  });
});
