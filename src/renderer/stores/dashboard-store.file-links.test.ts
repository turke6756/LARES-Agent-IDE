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

describe('chat file-link resolution — prefer files the agent actually touched (B2)', () => {
  const activity = (id: number, filePath: string) => ({
    id,
    agentId: supervisor.id,
    filePath,
    operation: 'edit',
    timestamp: '2026-07-18T00:00:00Z',
    generation: 0,
    sessionId: null,
  });

  it('opens the real touched file when a relative reference matches its suffix', () => {
    useDashboardStore.setState({
      fileActivities: [activity(1, 'C:\\repo\\src\\main\\index.ts')] as any,
    });

    // The reference `main/index.ts` resolves against root to a path that is a
    // suffix of the touched absolute path — prefer the real file.
    useDashboardStore.getState().openFileViewer('main/index.ts', supervisor.id);

    const [tab] = useDashboardStore.getState().openTabs;
    expect(tab.filePath).toBe('C:\\repo\\src\\main\\index.ts');
  });

  it('rescues a bare-basename match when the referenced directory is wrong', () => {
    useDashboardStore.setState({
      fileActivities: [activity(1, 'C:\\repo\\src\\main\\index.ts')] as any,
    });

    // `README/index.ts` (an unfixable merged capture) resolves against root to a
    // non-existent dir; the touched file with a matching basename wins.
    useDashboardStore.getState().openFileViewer('README/index.ts', supervisor.id);

    const [tab] = useDashboardStore.getState().openTabs;
    expect(tab.filePath).toBe('C:\\repo\\src\\main\\index.ts');
  });

  it('prefers the most recent touch when several files share a basename', () => {
    // fileActivities is stored newest-first (addFileActivity prepends).
    useDashboardStore.setState({
      fileActivities: [
        activity(2, 'C:\\repo\\packages\\b\\index.ts'),
        activity(1, 'C:\\repo\\packages\\a\\index.ts'),
      ] as any,
    });

    useDashboardStore.getState().openFileViewer('somewhere/index.ts', supervisor.id);

    const [tab] = useDashboardStore.getState().openTabs;
    expect(tab.filePath).toBe('C:\\repo\\packages\\b\\index.ts');
  });

  it('ignores touched files belonging to a different agent', () => {
    useDashboardStore.setState({
      fileActivities: [
        { ...activity(1, 'C:\\repo\\other\\index.ts'), agentId: 'someone-else' },
      ] as any,
    });

    useDashboardStore.getState().openFileViewer('main/index.ts', supervisor.id);

    const [tab] = useDashboardStore.getState().openTabs;
    // No match for this agent -> plain workspace-root join.
    expect(tab.filePath).toBe('C:\\repo\\main\\index.ts');
  });

  it('does not override an absolute reference', () => {
    useDashboardStore.setState({
      fileActivities: [activity(1, 'C:\\repo\\src\\main\\index.ts')] as any,
    });

    useDashboardStore.getState().openFileViewer('D:\\elsewhere\\index.ts', supervisor.id);

    const [tab] = useDashboardStore.getState().openTabs;
    expect(tab.filePath).toBe('D:\\elsewhere\\index.ts');
  });
});
