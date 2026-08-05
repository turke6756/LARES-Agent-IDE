// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboardStore } from '../../stores/dashboard-store';

vi.mock('../../hooks/useResize', () => ({ useResize: () => ({ size: 240, isResizing: false, handleMouseDown: vi.fn() }) }));
vi.mock('./FileTabBar', () => ({ default: () => <div data-testid="tabs" /> }));
vi.mock('./FileViewerHeader', () => ({ default: () => null }));
vi.mock('./FileContentArea', () => ({ default: () => null }));
vi.mock('./DirectoryTree', () => ({ default: () => null }));
vi.mock('../layout/ResizeDivider', () => ({ default: () => null }));
vi.mock('../layout/CollapseButton', () => ({ default: () => null }));
vi.mock('../context-overhead/ContextOverheadPanel', () => ({ default: () => null }));
vi.mock('../agent-knowledge/AgentKnowledgePanel', () => ({ default: () => null }));
vi.mock('../skill-analytics/SkillAnalyticsPanel', () => ({ default: () => null }));
vi.mock('../context-optimizer/ContextOptimizerPanel', () => ({ default: () => null }));
vi.mock('../context-optimizer/CapstonePanel', () => ({ default: () => null }));
vi.mock('../plan/PlanSurfaceContainer', () => ({ default: () => null }));
vi.mock('../watchdog/SystemMemoryView', () => ({ default: () => null }));
vi.mock('../context-gauge/ContextWindowWarningPanel', () => ({ default: () => null }));
vi.mock('./useFileContentCache', () => ({ evictTabCache: vi.fn() }));
vi.mock('./saveCoordinator', () => ({ hasUnsavedWork: () => false, requestSave: vi.fn() }));
vi.mock('../orchestration/GroupThinkProvidersPanel', () => ({ default: () => <div>GroupThink provider settings panel</div> }));

import FileViewerPanel from './FileViewerPanel';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  useDashboardStore.setState({
    selectedWorkspaceId: 'ws-1',
    activeTabId: 'groupthink-tab',
    openTabs: [{
      id: 'groupthink-tab', kind: 'tool', toolId: 'groupthink-providers', label: 'GroupThink Providers',
      workspaceId: 'ws-1', filePath: '', rootDirectory: '', pathType: 'windows',
    }],
  } as any);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  useDashboardStore.setState({ selectedWorkspaceId: null, activeTabId: null, openTabs: [] } as any);
});

describe('FileViewerPanel tool dispatch', () => {
  it('renders the dedicated GroupThink providers panel for its tool tab', () => {
    act(() => {
      root = createRoot(container);
      root.render(<FileViewerPanel />);
    });
    expect(container.textContent).toContain('GroupThink provider settings panel');
    expect(container.textContent).not.toContain('Unknown tool');
  });
});
