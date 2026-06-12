import { create } from 'zustand';
import type { Agent, Workspace, HealthCheck, FileActivity, QueryResult, ContextStats, PathType, FileTab, PanelLayout, Team, TeamMessage, CreateTeamInput } from '../../shared/types';
import { evictTabCache } from '../components/fileviewer/useFileContentCache';
import { clearDraft } from '../lib/chat-drafts';

interface WorkspaceHeat {
  activeCount: number;
  workingCount: number;
}

// Renderer-side extension of FileTab: `color` is an optional per-tab visual
// marker chosen from the tab context menu. The shared FileTab type stays
// untouched because color never crosses the IPC boundary.
export type ColoredFileTab = FileTab & { color?: string };

const DEFAULT_LAYOUT: PanelLayout = {
  sidebarWidth: 256,
  detailPanelWidth: 384,
  terminalHeight: 300,
  directoryTreeWidth: 250,
  sidebarCollapsed: false,
  detailPanelCollapsed: false,
  terminalCollapsed: false,
  directoryTreeCollapsed: false,
};

function loadLayout(): PanelLayout {
  try {
    const stored = localStorage.getItem('panelLayout');
    if (stored) return { ...DEFAULT_LAYOUT, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return { ...DEFAULT_LAYOUT };
}

function saveLayout(layout: PanelLayout) {
  localStorage.setItem('panelLayout', JSON.stringify(layout));
}

let tabIdCounter = 0;
function nextTabId(): string {
  return `tab-${++tabIdCounter}`;
}

function pathKey(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function pathMatches(targetPath: string, candidatePath: string): boolean {
  const target = pathKey(targetPath);
  const candidate = pathKey(candidatePath);
  return candidate === target || candidate.startsWith(`${target}/`);
}

function labelFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] || filePath;
}

function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath) || /^\\\\/.test(filePath);
}

function resolveAgainstRoot(filePath: string, rootDirectory: string): string {
  if (!filePath || !rootDirectory || isAbsolutePath(filePath)) return filePath;
  const trimmedRoot = rootDirectory.replace(/[\\/]+$/, '');
  const trimmedFile = filePath.replace(/^[\\/]+/, '');
  if (rootDirectory.startsWith('/')) {
    return `${trimmedRoot}/${trimmedFile.replace(/\\/g, '/')}`;
  }
  return `${trimmedRoot}\\${trimmedFile.replace(/\//g, '\\')}`;
}

interface TabEditState {
  mode: 'view' | 'edit';
  draftContent: string;
  originalContent: string;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  externalChange?: boolean;
  pendingDiskContent?: string;
  reloadVersion?: number;
}

interface DashboardState {
  workspaces: Workspace[];
  agents: Agent[];
  supervisorAgent: Agent | null;
  selectedWorkspaceId: string | null;
  selectedAgentId: string | null;
  terminalAgentId: string | null;
  terminalPinned: boolean;
  health: HealthCheck | null;
  healthChecking: boolean;
  loading: boolean;
  detailPane: 0 | 1 | 2;
  fileActivities: FileActivity[];
  workspaceHeat: Record<string, WorkspaceHeat>;
  contextStats: Record<string, ContextStats>;

  // Teams
  teams: Team[];
  teamMessages: Record<string, TeamMessage[]>;

  // Panel layout
  panelLayout: PanelLayout;
  setPanelSize: (key: keyof PanelLayout, value: number) => void;
  togglePanelCollapsed: (key: keyof PanelLayout) => void;
  resetLayout: () => void;

  // Tabbed file viewer
  openTabs: ColoredFileTab[];
  activeTabId: string | null;
  fileViewerOpen: boolean;
  tabEditState: Record<string, TabEditState>;

  // Actions
  loadWorkspaces: () => Promise<void>;
  moveWorkspace: (fromId: string, toId: string | null) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  loadAgents: (workspaceId: string) => Promise<void>;
  loadAllAgents: () => Promise<void>;
  selectWorkspace: (id: string | null) => void;
  selectAgent: (id: string | null) => void;
  setTerminalAgent: (id: string | null) => void;
  toggleTerminalPinned: () => void;
  updateAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;
  deleteAgent: (id: string) => Promise<void>;
  checkHealth: () => Promise<void>;
  setDetailPane: (pane: 0 | 1 | 2) => void;
  setFileActivities: (activities: FileActivity[]) => void;
  addFileActivity: (activity: FileActivity) => void;
  updateWorkspaceHeat: () => void;
  updateContextStats: (stats: ContextStats) => void;
  forkAgent: (id: string) => Promise<Agent | null>;
  queryAgent: (targetAgentId: string, question: string, sourceAgentId?: string) => Promise<QueryResult | null>;
  loadSupervisor: (workspaceId: string) => Promise<void>;
  launchSupervisor: (workspaceId: string) => Promise<Agent | null>;

  // Team actions
  loadTeams: (workspaceId: string) => Promise<void>;
  createTeam: (input: CreateTeamInput) => Promise<Team | null>;
  disbandTeam: (teamId: string) => Promise<void>;
  updateTeam: (team: Team) => void;
  loadTeamMessages: (teamId: string) => Promise<void>;
  addTeamMessage: (message: TeamMessage) => void;

  // Tab actions
  openTab: (filePath: string, rootDirectory: string, pathType: PathType, agentId?: string, workspaceId?: string) => void;
  openDirectoryTab: (rootDirectory: string, pathType: PathType, workspaceId?: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  moveTab: (tabId: string, targetTabId: string) => void;
  setTabColor: (tabId: string, color: string | null) => void;
  closeAllTabs: () => void;
  enterEditMode: (tabId: string, initialContent: string) => void;
  exitEditMode: (tabId: string) => void;
  setDraftContent: (tabId: string, content: string) => void;
  saveTab: (tabId: string) => Promise<boolean>;
  discardTabChanges: (tabId: string) => void;
  markExternalChange: (tabId: string, freshContent: string) => void;
  dismissExternalChange: (tabId: string) => void;
  reloadFromDisk: (tabId: string) => void;
  refreshOriginalContent: (tabId: string, freshContent: string) => void;
  closeTabsForPath: (path: string) => void;
  renameTabPath: (oldPath: string, newPath: string) => void;
  hasDirtyTabForPath: (path: string) => boolean;
  hideFileViewer: () => void;
  showFileViewer: () => void;
  toggleFileViewer: () => void;

  // Backward-compat shims
  openFileViewer: (filePath: string, agentId: string) => void;
  closeFileViewer: () => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  workspaces: [],
  agents: [],
  supervisorAgent: null,
  selectedWorkspaceId: null,
  selectedAgentId: null,
  terminalAgentId: null,
  terminalPinned: false,
  health: null,
  healthChecking: false,
  loading: false,
  detailPane: 2,
  fileActivities: [],
  workspaceHeat: {},
  contextStats: {},
  teams: [],
  teamMessages: {},

  // Panel layout
  panelLayout: loadLayout(),

  setPanelSize: (key, value) => {
    set((state) => {
      const layout = { ...state.panelLayout, [key]: value };
      saveLayout(layout);
      return { panelLayout: layout };
    });
  },

  togglePanelCollapsed: (key) => {
    set((state) => {
      const layout = { ...state.panelLayout, [key]: !state.panelLayout[key] };
      saveLayout(layout);
      return { panelLayout: layout };
    });
  },

  resetLayout: () => {
    const layout = { ...DEFAULT_LAYOUT };
    saveLayout(layout);
    set({ panelLayout: layout });
  },

  // Tabbed file viewer
  openTabs: [],
  activeTabId: null,
  fileViewerOpen: false,
  tabEditState: {},

  openTab: (filePath, rootDirectory, pathType, agentId?, workspaceId?) => {
    const { openTabs, selectedWorkspaceId } = get();
    const ws = workspaceId ?? selectedWorkspaceId ?? undefined;
    // Check if tab already exists for this file+root combo
    const existing = openTabs.find(
      (t) => t.filePath === filePath && t.rootDirectory === rootDirectory
    );
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }

    const normalized = filePath.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    const label = segments[segments.length - 1] || filePath;

    const tab: FileTab = {
      id: nextTabId(),
      filePath,
      rootDirectory,
      pathType,
      agentId,
      workspaceId: ws,
      label,
    };
    set((state) => ({
      openTabs: [...state.openTabs, tab],
      activeTabId: tab.id,
      fileViewerOpen: true,
    }));
  },

  openDirectoryTab: (rootDirectory, pathType, workspaceId?) => {
    const { openTabs, activeTabId, selectedWorkspaceId } = get();
    const ws = workspaceId ?? selectedWorkspaceId ?? undefined;
    // If any tabs already exist for this root, just re-show the file viewer
    // and keep the current active tab if it belongs to this root
    const tabsForRoot = openTabs.filter((t) => t.rootDirectory === rootDirectory);
    if (tabsForRoot.length > 0) {
      const currentActive = tabsForRoot.find((t) => t.id === activeTabId);
      set({ activeTabId: currentActive?.id || tabsForRoot[0].id, fileViewerOpen: true });
      return;
    }

    const normalized = rootDirectory.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    const label = (segments[segments.length - 1] || rootDirectory) + '/';

    const tab: FileTab = {
      id: nextTabId(),
      filePath: '',
      rootDirectory,
      pathType,
      workspaceId: ws,
      label,
    };
    set((state) => ({
      openTabs: [...state.openTabs, tab],
      activeTabId: tab.id,
      fileViewerOpen: true,
    }));
  },

  closeTab: (tabId) => {
    set((state) => {
      const idx = state.openTabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return state;
      const newTabs = state.openTabs.filter((t) => t.id !== tabId);
      const { [tabId]: _closedEditState, ...tabEditState } = state.tabEditState;
      let newActive = state.activeTabId;
      if (state.activeTabId === tabId) {
        // Activate neighbor
        if (newTabs.length === 0) {
          newActive = null;
        } else if (idx < newTabs.length) {
          newActive = newTabs[idx].id;
        } else {
          newActive = newTabs[newTabs.length - 1].id;
        }
      }
      return {
        openTabs: newTabs,
        activeTabId: newActive,
        fileViewerOpen: newTabs.length > 0,
        tabEditState,
      };
    });
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  // Reorder: move `tabId` to the position currently occupied by `targetTabId`.
  // Operates on the full openTabs array; relative order within each
  // workspace's visible subset follows automatically.
  moveTab: (tabId, targetTabId) => {
    if (tabId === targetTabId) return;
    set((state) => {
      const from = state.openTabs.findIndex((t) => t.id === tabId);
      const to = state.openTabs.findIndex((t) => t.id === targetTabId);
      if (from === -1 || to === -1) return state;
      const openTabs = [...state.openTabs];
      const [moved] = openTabs.splice(from, 1);
      openTabs.splice(to, 0, moved);
      return { openTabs };
    });
  },

  setTabColor: (tabId, color) => {
    set((state) => ({
      openTabs: state.openTabs.map((t) =>
        t.id === tabId ? { ...t, color: color ?? undefined } : t
      ),
    }));
  },

  closeAllTabs: () => {
    for (const tab of get().openTabs) {
      evictTabCache(tab.id);
    }
    set({ openTabs: [], activeTabId: null, fileViewerOpen: false, tabEditState: {} });
  },

  enterEditMode: (tabId, initialContent) => {
    set((state) => {
      const existing = state.tabEditState[tabId];
      if (existing?.dirty) {
        return {
          tabEditState: {
            ...state.tabEditState,
            [tabId]: { ...existing, mode: 'edit', error: null },
          },
        };
      }
      return {
        tabEditState: {
          ...state.tabEditState,
          [tabId]: {
            mode: 'edit',
            draftContent: initialContent,
            originalContent: initialContent,
            dirty: false,
            saving: false,
            error: null,
          },
        },
      };
    });
  },

  exitEditMode: (tabId) => {
    set((state) => {
      const existing = state.tabEditState[tabId];
      if (!existing) return state;
      return {
        tabEditState: {
          ...state.tabEditState,
          [tabId]: { ...existing, mode: 'view', saving: false, error: null },
        },
      };
    });
  },

  setDraftContent: (tabId, content) => {
    set((state) => {
      const existing = state.tabEditState[tabId];
      if (!existing) return state;
      return {
        tabEditState: {
          ...state.tabEditState,
          [tabId]: {
            ...existing,
            draftContent: content,
            dirty: content !== existing.originalContent,
            error: null,
          },
        },
      };
    });
  },

  saveTab: async (tabId) => {
    const { openTabs, tabEditState } = get();
    const tab = openTabs.find((t) => t.id === tabId);
    const editState = tabEditState[tabId];
    if (!tab || !tab.filePath || !editState) return false;
    const draftToSave = editState.draftContent;

    set((state) => ({
      tabEditState: {
        ...state.tabEditState,
        [tabId]: { ...editState, saving: true, error: null },
      },
    }));

    const result = await window.api.files.writeFile(
      tab.filePath,
      tab.rootDirectory,
      tab.pathType,
      draftToSave,
    );
    if (tab.pathType === 'wsl') {
      await get().checkHealth();
    }

    if (!result.ok) {
      set((state) => {
        const current = state.tabEditState[tabId];
        if (!current) return state;
        return {
          tabEditState: {
            ...state.tabEditState,
            [tabId]: { ...current, saving: false, error: result.error },
          },
        };
      });
      return false;
    }

    evictTabCache(tabId);
    set((state) => {
      const current = state.tabEditState[tabId];
      if (!current) return state;
      return {
        tabEditState: {
          ...state.tabEditState,
          [tabId]: {
            ...current,
            originalContent: draftToSave,
            dirty: current.draftContent !== draftToSave,
            saving: false,
            error: null,
          },
        },
      };
    });
    return true;
  },

  discardTabChanges: (tabId) => {
    set((state) => {
      const existing = state.tabEditState[tabId];
      if (!existing) return state;
      return {
        tabEditState: {
          ...state.tabEditState,
          [tabId]: {
            ...existing,
            mode: 'view',
            draftContent: existing.originalContent,
            dirty: false,
            saving: false,
            error: null,
            externalChange: false,
            pendingDiskContent: undefined,
          },
        },
      };
    });
  },

  markExternalChange: (tabId, freshContent) => {
    set((state) => {
      const existing = state.tabEditState[tabId];
      if (!existing) return state;
      if (existing.pendingDiskContent === freshContent && existing.externalChange) return state;
      return {
        tabEditState: {
          ...state.tabEditState,
          [tabId]: {
            ...existing,
            externalChange: true,
            pendingDiskContent: freshContent,
          },
        },
      };
    });
  },

  dismissExternalChange: (tabId) => {
    set((state) => {
      const existing = state.tabEditState[tabId];
      if (!existing) return state;
      return {
        tabEditState: {
          ...state.tabEditState,
          [tabId]: {
            ...existing,
            externalChange: false,
            pendingDiskContent: undefined,
          },
        },
      };
    });
  },

  reloadFromDisk: (tabId) => {
    set((state) => {
      const existing = state.tabEditState[tabId];
      if (!existing || existing.pendingDiskContent === undefined) return state;
      const fresh = existing.pendingDiskContent;
      return {
        tabEditState: {
          ...state.tabEditState,
          [tabId]: {
            ...existing,
            draftContent: fresh,
            originalContent: fresh,
            dirty: false,
            error: null,
            externalChange: false,
            pendingDiskContent: undefined,
            reloadVersion: (existing.reloadVersion ?? 0) + 1,
          },
        },
      };
    });
  },

  refreshOriginalContent: (tabId, freshContent) => {
    set((state) => {
      const existing = state.tabEditState[tabId];
      if (!existing) return state;
      if (existing.dirty) return state;
      if (existing.originalContent === freshContent) return state;
      return {
        tabEditState: {
          ...state.tabEditState,
          [tabId]: {
            ...existing,
            originalContent: freshContent,
            draftContent: freshContent,
          },
        },
      };
    });
  },

  closeTabsForPath: (targetPath) => {
    set((state) => {
      const closedTabs = state.openTabs.filter((tab) => tab.filePath && pathMatches(targetPath, tab.filePath));
      if (closedTabs.length === 0) return state;
      const closedIds = new Set(closedTabs.map((tab) => tab.id));
      for (const tab of closedTabs) {
        evictTabCache(tab.id);
      }
      const openTabs = state.openTabs.filter((tab) => !closedIds.has(tab.id));
      const tabEditState = { ...state.tabEditState };
      for (const id of closedIds) {
        delete tabEditState[id];
      }
      let activeTabId = state.activeTabId;
      if (activeTabId && closedIds.has(activeTabId)) {
        activeTabId = openTabs[0]?.id ?? null;
      }
      return {
        openTabs,
        activeTabId,
        fileViewerOpen: openTabs.length > 0,
        tabEditState,
      };
    });
  },

  renameTabPath: (oldPath, newPath) => {
    set((state) => ({
      openTabs: state.openTabs.map((tab) => {
        if (!tab.filePath || !pathMatches(oldPath, tab.filePath)) return tab;
        const suffix = pathKey(tab.filePath) === pathKey(oldPath)
          ? ''
          : tab.filePath.replace(/\\/g, '/').slice(oldPath.replace(/\\/g, '/').replace(/\/+$/, '').length);
        const renamedPath = suffix ? `${newPath.replace(/\/+$/, '')}${suffix}` : newPath;
        return {
          ...tab,
          filePath: renamedPath,
          label: labelFromPath(renamedPath),
        };
      }),
    }));
  },

  hasDirtyTabForPath: (targetPath) => {
    const { openTabs, tabEditState } = get();
    return openTabs.some((tab) => {
      if (!tab.filePath || !pathMatches(targetPath, tab.filePath)) return false;
      return !!tabEditState[tab.id]?.dirty;
    });
  },

  // Hide file viewer without destroying tabs (for back navigation)
  hideFileViewer: () => set({ fileViewerOpen: false }),

  // Show file viewer — restore existing tabs for the current workspace, or open its directory
  showFileViewer: () => {
    const { openTabs, activeTabId, selectedWorkspaceId, workspaces } = get();
    const wsTabs = openTabs.filter((t) => t.workspaceId === selectedWorkspaceId);
    if (wsTabs.length > 0) {
      const activeBelongs = wsTabs.some((t) => t.id === activeTabId);
      set({
        fileViewerOpen: true,
        activeTabId: activeBelongs ? activeTabId : wsTabs[0].id,
      });
    } else {
      const workspace = workspaces.find((w) => w.id === selectedWorkspaceId);
      if (workspace) {
        get().openDirectoryTab(workspace.path, workspace.pathType, workspace.id);
      }
    }
  },

  toggleFileViewer: () => {
    if (get().fileViewerOpen) {
      get().hideFileViewer();
    } else {
      get().showFileViewer();
    }
  },

  // Backward-compat shim: openFileViewer calls openTab
  openFileViewer: (filePath, agentId) => {
    const agent = get().agents.find((a) => a.id === agentId);
    if (!agent) return;
    const workspace = get().workspaces.find((w) => w.id === agent.workspaceId);
    const pathType = workspace?.pathType || 'wsl';
    get().openTab(resolveAgainstRoot(filePath, agent.workingDirectory), agent.workingDirectory, pathType, agentId, agent.workspaceId);
  },

  closeFileViewer: () => get().closeAllTabs(),

  loadWorkspaces: async () => {
    const workspaces = await window.api.workspaces.list();
    set({ workspaces });
  },

  // Drag-reorder: move `fromId` to `toId`'s position (toId null = end of
  // list). Optimistic — updates the array immediately, then persists.
  moveWorkspace: async (fromId: string, toId: string | null) => {
    const { workspaces } = get();
    const fromIdx = workspaces.findIndex((w) => w.id === fromId);
    if (fromIdx < 0 || fromId === toId) return;
    const next = [...workspaces];
    const [moved] = next.splice(fromIdx, 1);
    const toIdx = toId === null ? next.length : next.findIndex((w) => w.id === toId);
    if (toIdx < 0) return;
    next.splice(toIdx, 0, moved);
    set({ workspaces: next });
    try {
      await window.api.workspaces.reorder(next.map((w) => w.id));
    } catch (err) {
      console.error('Failed to persist workspace order:', err);
      await get().loadWorkspaces();
    }
  },

  deleteWorkspace: async (id: string) => {
    await window.api.workspaces.delete(id);
    const { selectedWorkspaceId } = get();
    if (selectedWorkspaceId === id) {
      set({ selectedWorkspaceId: null, agents: [], selectedAgentId: null, terminalAgentId: null });
    }
    await get().loadWorkspaces();
    get().updateWorkspaceHeat();
  },

  loadAgents: async (workspaceId: string) => {
    const allAgents = await window.api.agents.list(workspaceId);
    const agents = allAgents.filter((a) => !a.isSupervisor);
    const supervisorAgent = allAgents.find((a) => a.isSupervisor) || null;
    set({ agents, supervisorAgent });
    get().updateWorkspaceHeat();
  },

  loadAllAgents: async () => {
    const allAgents = await window.api.agents.listAll();
    const agents = allAgents.filter((a) => !a.isSupervisor);
    set({ agents });
    get().updateWorkspaceHeat();
  },

  selectWorkspace: (id) => {
    const { openTabs, activeTabId, fileViewerOpen, terminalPinned } = get();
    // Re-point the file viewer's active tab at something that belongs to the new workspace.
    // Without this, activeTabId can stay on a tab from the previous workspace, so the tree
    // root is wrong and visibleTabs filters out the current workspace's tabs.
    const activeBelongs = openTabs.find((t) => t.id === activeTabId)?.workspaceId === id;
    const nextActiveTabId = activeBelongs
      ? activeTabId
      : openTabs.find((t) => t.workspaceId === id)?.id ?? null;
    // If the new workspace has no tabs and the viewer was open, hide it — otherwise the
    // panel would render blank.
    const nextFileViewerOpen = fileViewerOpen && nextActiveTabId !== null;

    if (!terminalPinned) {
      set({ selectedWorkspaceId: id, selectedAgentId: null, terminalAgentId: null, activeTabId: nextActiveTabId, fileViewerOpen: nextFileViewerOpen });
    } else {
      set({ selectedWorkspaceId: id, selectedAgentId: null, activeTabId: nextActiveTabId, fileViewerOpen: nextFileViewerOpen });
    }
    if (id) {
      get().loadAgents(id);
      get().loadTeams(id);
    }
  },

  selectAgent: (id) =>
    set((state) => ({
      selectedAgentId: id,
      // Attaching to a (different) agent always lands on the Chat tab —
      // never inherit the tab the previous agent's pane was left on.
      detailPane: id && id !== state.selectedAgentId ? 2 : state.detailPane,
    })),

  setTerminalAgent: (id) => set({ terminalAgentId: id }),
  
  toggleTerminalPinned: () => set((state) => ({ terminalPinned: !state.terminalPinned })),

  updateAgent: (agent) => {
    const { selectedWorkspaceId } = get();
    if (agent.workspaceId !== selectedWorkspaceId) return;
    if (agent.isSupervisor) {
      set({ supervisorAgent: agent });
    } else {
      set((state) => {
        const exists = state.agents.some((a) => a.id === agent.id);
        return {
          agents: exists
            ? state.agents.map((a) => (a.id === agent.id ? agent : a))
            : [...state.agents, agent],
        };
      });
    }
  },

  removeAgent: (id) => {
    clearDraft(id);
    set((state) => ({
      agents: state.agents.filter((a) => a.id !== id),
      supervisorAgent: state.supervisorAgent?.id === id ? null : state.supervisorAgent,
      selectedAgentId: state.selectedAgentId === id ? null : state.selectedAgentId,
      terminalAgentId: state.terminalAgentId === id ? null : state.terminalAgentId,
    }));
  },

  deleteAgent: async (id) => {
    await window.api.agents.delete(id);
    get().removeAgent(id);
    get().updateWorkspaceHeat();
  },

  checkHealth: async () => {
    set({ healthChecking: true });
    try {
      const health = await window.api.system.healthCheck();
      set({ health, healthChecking: false });
    } catch (err) {
      console.error('Health check failed:', err);
      set({
        health: {
          wslAvailable: false,
          tmuxAvailable: false,
          claudeWindowsAvailable: false,
          claudeWslAvailable: false,
          wslStatus: {
            state: 'unavailable',
            distros: [],
            error: err instanceof Error ? err.message : 'Health check failed',
          },
        },
        healthChecking: false,
      });
    }
  },

  setDetailPane: (pane) => set({ detailPane: pane }),

  setFileActivities: (activities) => set({ fileActivities: activities }),

  addFileActivity: (activity) => {
    set((state) => ({
      fileActivities: [activity, ...state.fileActivities],
    }));
  },

  forkAgent: async (id) => {
    try {
      const forked = await window.api.agents.fork(id);
      set((state) => ({ agents: [...state.agents, forked] }));
      get().updateWorkspaceHeat();
      return forked;
    } catch (err) {
      console.error('Fork failed:', err);
      return null;
    }
  },

  queryAgent: async (targetAgentId, question, sourceAgentId?) => {
    try {
      return await window.api.agents.query(targetAgentId, question, sourceAgentId);
    } catch (err) {
      console.error('Query failed:', err);
      return null;
    }
  },

  loadSupervisor: async (workspaceId: string) => {
    try {
      const sup = await window.api.agents.getSupervisor(workspaceId);
      set({ supervisorAgent: sup });
    } catch (err) {
      console.error('Failed to load supervisor:', err);
    }
  },

  launchSupervisor: async (workspaceId: string) => {
    const workspace = get().workspaces.find((w) => w.id === workspaceId);
    // If one already exists and is alive, just select it
    const existing = get().supervisorAgent;
    if (existing && !['done', 'crashed'].includes(existing.status)) {
      get().selectAgent(existing.id);
      get().setTerminalAgent(existing.id);
      return existing;
    }

    try {
      const agent = await window.api.agents.launch({
        workspaceId,
        title: 'Supervisor',
        roleDescription: 'Autonomous supervisor agent — coordinates workers, approves continuations, manages context.',
        isSupervisor: true,
        provider: 'claude',
        autoRestartEnabled: true,
      });
      set({ supervisorAgent: agent });
      if (workspace?.pathType === 'wsl') {
        await get().checkHealth();
      }
      return agent;
    } catch (err) {
      console.error('Failed to launch supervisor:', err);
      // Refresh in case it was already running but our state was stale
      await get().loadSupervisor(workspaceId);
      if (workspace?.pathType === 'wsl') {
        await get().checkHealth();
      }
      return null;
    }
  },

  updateContextStats: (stats: ContextStats) => {
    set((state) => ({
      contextStats: { ...state.contextStats, [stats.agentId]: stats },
    }));
  },

  // ── Team actions ───────────────────────────────────────────────────────

  loadTeams: async (workspaceId: string) => {
    try {
      const teams = await window.api.teams.list(workspaceId);
      set({ teams });
    } catch (err) {
      console.error('Failed to load teams:', err);
    }
  },

  createTeam: async (input: CreateTeamInput) => {
    try {
      const team = await window.api.teams.create(input);
      set((state) => ({ teams: [team, ...state.teams] }));
      return team;
    } catch (err) {
      console.error('Failed to create team:', err);
      return null;
    }
  },

  disbandTeam: async (teamId: string) => {
    try {
      await window.api.teams.disband(teamId);
      set((state) => ({
        teams: state.teams.map((t) =>
          t.id === teamId ? { ...t, status: 'disbanded' as const } : t
        ),
      }));
    } catch (err) {
      console.error('Failed to disband team:', err);
    }
  },

  updateTeam: (team: Team) => {
    set((state) => {
      const exists = state.teams.some((t) => t.id === team.id);
      if (exists) {
        return { teams: state.teams.map((t) => (t.id === team.id ? team : t)) };
      }
      return { teams: [team, ...state.teams] };
    });
  },

  loadTeamMessages: async (teamId: string) => {
    try {
      const messages = await window.api.teams.getMessages(teamId);
      set((state) => ({
        teamMessages: { ...state.teamMessages, [teamId]: messages },
      }));
    } catch (err) {
      console.error('Failed to load team messages:', err);
    }
  },

  addTeamMessage: (message: TeamMessage) => {
    set((state) => {
      const existing = state.teamMessages[message.teamId] || [];
      return {
        teamMessages: {
          ...state.teamMessages,
          [message.teamId]: [message, ...existing],
        },
      };
    });
  },

  updateWorkspaceHeat: () => {
    const agents = get().agents;
    const heat: Record<string, WorkspaceHeat> = {};
    for (const agent of agents) {
      if (agent.status === 'done' || agent.status === 'crashed') continue;
      if (!heat[agent.workspaceId]) {
        heat[agent.workspaceId] = { activeCount: 0, workingCount: 0 };
      }
      heat[agent.workspaceId].activeCount++;
      if (agent.status === 'working') {
        heat[agent.workspaceId].workingCount++;
      }
    }
    set({ workspaceHeat: heat });
  },
}));
