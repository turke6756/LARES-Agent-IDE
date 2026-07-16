// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { Agent, Workspace } from '../../shared/types';
import { useDashboardStore } from './dashboard-store';

const workspace = {
  id: 'ws-1',
  path: 'C:\\repo',
  pathType: 'windows',
} as Workspace;

const supervisor = {
  id: 'supervisor-1',
  workspaceId: workspace.id,
  workingDirectory: 'C:\\repo\\.dashboard\\supervisor',
} as Agent;

beforeEach(() => {
  useDashboardStore.setState({
    agents: [supervisor],
    workspaces: [workspace],
    selectedWorkspaceId: workspace.id,
    openTabs: [],
    activeTabId: null,
    fileViewerOpen: false,
    browserOpen: false,
  });
});

describe('chat file-link resolution', () => {
  it('resolves relative links against the workspace root, not the agent scaffold cwd', () => {
    useDashboardStore.getState().openFileViewer('plans/context-optimizer-r2-wp1b-brief.md', supervisor.id);

    const [tab] = useDashboardStore.getState().openTabs;
    expect(tab.filePath).toBe('C:\\repo\\plans\\context-optimizer-r2-wp1b-brief.md');
    expect(tab.rootDirectory).toBe('C:\\repo');
    expect(useDashboardStore.getState().fileViewerOpen).toBe(true);
  });

  it('leaves absolute links unchanged', () => {
    useDashboardStore.getState().openFileViewer('D:\\other\\notes.md', supervisor.id);

    const [tab] = useDashboardStore.getState().openTabs;
    expect(tab.filePath).toBe('D:\\other\\notes.md');
    expect(tab.rootDirectory).toBe('C:\\repo');
  });

  it('falls back to the agent cwd when the workspace record is unavailable', () => {
    useDashboardStore.setState({ workspaces: [] });

    useDashboardStore.getState().openFileViewer('notes/local.md', supervisor.id);

    const [tab] = useDashboardStore.getState().openTabs;
    expect(tab.filePath).toBe('C:\\repo\\.dashboard\\supervisor\\notes\\local.md');
    expect(tab.rootDirectory).toBe(supervisor.workingDirectory);
  });
});
