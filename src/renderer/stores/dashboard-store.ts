import { create } from 'zustand';
import type { Agent, AgentStatus, Workspace, HealthCheck, FileActivity, QueryResult, ContextStats, UsageLimitsReading, PathType, FileTab, PanelLayout, Team, TeamMessage, CreateTeamInput, DetachedClosedPayload } from '../../shared/types';
import { evictTabCache, recordRecentWrite } from '../components/fileviewer/useFileContentCache';
import { clearDraft } from '../lib/chat-drafts';

interface WorkspaceHeat {
  activeCount: number;
  workingCount: number;
  waitingCount: number;
}

interface AgentStatusSnapshot {
  workspaceId: string;
  status: AgentStatus;
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
  // Three-mode model (plan §5): 'view' = rendered preview, 'wysiwyg' = the
  // Milkdown canvas, 'source' = CodeMirror raw text (the old 'edit').
  mode: 'view' | 'wysiwyg' | 'source';
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
  // Cross-workspace agent status index (agentId → {workspaceId, status}).
  // Unlike the workspace-scoped `agents` array this sees ALL workspaces: it is
  // seeded once at startup, updated on every statusChanged with no workspace
  // guard, merged on selected-workspace loads/forks, and pruned on
  // agent/workspace deletion. `workspaceHeat` is derived from it.
  agentStatuses: Record<string, AgentStatusSnapshot>;
  contextStats: Record<string, ContextStats>;
  // Account-wide Claude subscription usage-limits reading (singleton, NOT a
  // per-agent map — the data is shared across every session/workspace).
  usageLimits: UsageLimitsReading | null;
  // Supervisor ids that currently own an active orchestration deliberation
  // (e.g. groupthink). Synced from the main process; OR'd into the owner-
  // container pulse so the border keeps animating through the idle gaps
  // between deliberation turns, not just on per-agent status flips.
  deliberatingSupervisorIds: string[];

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
  // Browser pane center-mode flag (WP1-B). Precedence: file viewer wins —
  // opening either pane closes the other.
  browserOpen: boolean;
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
  loadAgentStatuses: () => Promise<void>;
  seedAgentStatuses: (agents: Agent[]) => void;
  updateAgentStatusSnapshot: (agent: Agent) => void;
  removeAgentStatusesForWorkspace: (workspaceId: string) => void;
  updateContextStats: (stats: ContextStats) => void;
  updateUsageLimits: (reading: UsageLimitsReading) => void;
  setDeliberatingSupervisorIds: (ids: string[]) => void;
  forkAgent: (id: string) => Promise<Agent | null>;
  queryAgent: (targetAgentId: string, question: string, sourceAgentId?: string) => Promise<QueryResult | null>;

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
  openToolTab: (toolId: string, label: string, workspaceId?: string) => void;
  closeTab: (tabId: string) => void;
  // Detachable file tabs (detachable-file-tabs-plan §4 1.7).
  detachTab: (tabId: string) => void;
  seedDetachedTab: (meta: DetachedClosedPayload) => void;
  setActiveTab: (tabId: string) => void;
  moveTab: (tabId: string, targetTabId: string) => void;
  setTabColor: (tabId: string, color: string | null) => void;
  closeAllTabs: () => void;
  enterSourceMode: (tabId: string, initialContent: string) => void;
  enterWysiwygMode: (tabId: string, initialContent: string) => void;
  enterViewMode: (tabId: string, initialContent: string) => void;
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
  showBrowser: () => void;
  hideBrowser: () => void;
  showDashboard: () => void;

  // Backward-compat shims
  openFileViewer: (filePath: string, agentId: string) => void;
  closeFileViewer: () => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  workspaces: [],
  agents: [],
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
  agentStatuses: {},
  contextStats: {},
  usageLimits: null,
  deliberatingSupervisorIds: [],
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
  browserOpen: false,
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
      browserOpen: false,
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
      set({ activeTabId: currentActive?.id || tabsForRoot[0].id, fileViewerOpen: true, browserOpen: false });
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
      browserOpen: false,
    }));
  },

  // A non-file "tool" tab (e.g. the Context-Overhead Analyzer) living inside the
  // Files view. One per (workspace, toolId): re-focuses if already open. Empty
  // filePath/rootDirectory so the file header + directory tree never render
  // (FileViewerPanel gates on kind==='tool').
  openToolTab: (toolId, label, workspaceId?) => {
    const { openTabs, selectedWorkspaceId } = get();
    const ws = workspaceId ?? selectedWorkspaceId ?? undefined;
    const existing = openTabs.find(
      (t) => t.kind === 'tool' && t.toolId === toolId && t.workspaceId === ws,
    );
    if (existing) {
      set({ activeTabId: existing.id, fileViewerOpen: true, browserOpen: false });
      return;
    }
    const tab: FileTab = {
      id: nextTabId(),
      filePath: '',
      rootDirectory: '',
      pathType: 'windows',
      workspaceId: ws,
      label,
      kind: 'tool',
      toolId,
    };
    set((state) => ({
      openTabs: [...state.openTabs, tab],
      activeTabId: tab.id,
      fileViewerOpen: true,
      browserOpen: false,
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

  // Remove a tab that has just been torn off into a detached window. Mirrors
  // closeTab's neighbor-activation but with NO dirty prompt — the draft was
  // already saved by the FileTabBar save-before-detach step (plan §1.6), and
  // the detached window now owns the file. Evicts the content cache too.
  detachTab: (tabId) => {
    evictTabCache(tabId);
    set((state) => {
      const idx = state.openTabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return state;
      const newTabs = state.openTabs.filter((t) => t.id !== tabId);
      const { [tabId]: _closedEditState, ...tabEditState } = state.tabEditState;
      let newActive = state.activeTabId;
      if (state.activeTabId === tabId) {
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

  // Atomic seed for a detached renderer (plan §1.7 / Reviewer #7). A fresh
  // renderer starts with selectedWorkspaceId:null and FileViewerPanel filters
  // tabs by the selected workspace, while selectWorkspace() sets
  // fileViewerOpen:false — so the workspace, the single tab, and the open flags
  // must land in ONE update. Deliberately does NOT call selectWorkspace().
  seedDetachedTab: (meta) => set(() => {
    const tab: ColoredFileTab = {
      // Stable id derived from the file path — the detached window holds exactly
      // one tab for its lifetime, so the id never needs to churn.
      id: `detached:${meta.filePath}`,
      filePath: meta.filePath,
      rootDirectory: meta.rootDirectory,
      pathType: meta.pathType,
      workspaceId: meta.workspaceId,
      label: meta.label,
    };
    return {
      selectedWorkspaceId: meta.workspaceId,
      openTabs: [tab],
      activeTabId: tab.id,
      fileViewerOpen: true,
      browserOpen: false,
      tabEditState: {},
    };
  }),

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

  enterSourceMode: (tabId, initialContent) => {
    set((state) => {
      const existing = state.tabEditState[tabId];
      if (existing?.dirty) {
        // Preserve the dirty draft — this is also the wysiwyg → source carry
        // (CodeMirror shows the spliced draft instead of the disk content).
        return {
          tabEditState: {
            ...state.tabEditState,
            [tabId]: { ...existing, mode: 'source', error: null },
          },
        };
      }
      return {
        tabEditState: {
          ...state.tabEditState,
          [tabId]: {
            ...existing,
            mode: 'source',
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

  // Creates the edit session for the WYSIWYG canvas (plan §5: state is
  // created on WYSIWYG mount by FileContentArea, never by the editor
  // component itself, so saveTab always has state to act on). Callers must
  // discard or carry a dirty draft before switching into this mode — the
  // editor only loads original bytes, so a preserved stale draft would be
  // invisible; if one is still present we keep it and only flip the mode,
  // mirroring enterSourceMode.
  enterWysiwygMode: (tabId, initialContent) => {
    set((state) => {
      const existing = state.tabEditState[tabId];
      if (existing?.dirty) {
        return {
          tabEditState: {
            ...state.tabEditState,
            [tabId]: { ...existing, mode: 'wysiwyg', error: null },
          },
        };
      }
      return {
        tabEditState: {
          ...state.tabEditState,
          [tabId]: {
            ...existing,
            mode: 'wysiwyg',
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

  // Pins an explicit 'view' choice for tabs that have no edit session yet
  // (markdown tabs default to WYSIWYG, so "View" must be representable in
  // state). With an existing session this behaves like exitEditMode.
  enterViewMode: (tabId, initialContent) => {
    set((state) => {
      const existing = state.tabEditState[tabId];
      if (existing) {
        return {
          tabEditState: {
            ...state.tabEditState,
            [tabId]: { ...existing, mode: 'view', saving: false, error: null },
          },
        };
      }
      return {
        tabEditState: {
          ...state.tabEditState,
          [tabId]: {
            mode: 'view',
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

    // Write-generation token (plan §5): record what we're about to write
    // *before* the write so the fs-watcher revalidate can drop the echo even
    // when it fires before the post-save state update below lands.
    recordRecentWrite(tabId, draftToSave);
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
        browserOpen: false,
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

  // Browser pane (WP1-B) — mirrors show/hideFileViewer. Opening either center
  // mode closes the other; the file viewer wins when both flags are set.
  showBrowser: () => set({ browserOpen: true, fileViewerOpen: false }),
  hideBrowser: () => set({ browserOpen: false }),

  // Return to the agent-card grid (WP-NAV). Tabs survive — only the view resets.
  showDashboard: () => set({ fileViewerOpen: false, browserOpen: false }),

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
    get().removeAgentStatusesForWorkspace(id);
  },

  loadAgents: async (workspaceId: string) => {
    // Supervisors (structural isSupervisor, and privilege-lane personas) now
    // stay in `agents` so each renders as its own grid card; their launched
    // workers nest beneath them via ownerAgentId (buildAgentForest). No more
    // header-singleton collapse.
    const agents = await window.api.agents.list(workspaceId);
    set((state) => {
      const next: Record<string, AgentStatusSnapshot> = {};
      // Keep every other workspace's entries; replace this workspace's slice.
      for (const [id, snap] of Object.entries(state.agentStatuses)) {
        if (snap.workspaceId !== workspaceId) next[id] = snap;
      }
      for (const a of agents) next[a.id] = { workspaceId: a.workspaceId, status: a.status };
      return { agents, agentStatuses: next };
    });
    get().updateWorkspaceHeat();
  },

  loadAllAgents: async () => {
    // All-workspaces view: same as loadAgents — supervisors are real cards now.
    const agents = await window.api.agents.listAll();
    set({ agents });
    get().updateWorkspaceHeat();
  },

  selectWorkspace: (id) => {
    const { openTabs, activeTabId, terminalPinned } = get();
    // Re-point the file viewer's active tab at something that belongs to the new workspace.
    // Without this, activeTabId can stay on a tab from the previous workspace, so the tree
    // root is wrong and visibleTabs filters out the current workspace's tabs.
    const activeBelongs = openTabs.find((t) => t.id === activeTabId)?.workspaceId === id;
    const nextActiveTabId = activeBelongs
      ? activeTabId
      : openTabs.find((t) => t.workspaceId === id)?.id ?? null;
    // Entering a workspace always lands on the dashboard view (WP-NAV); tabs are
    // preserved so the Files button restores them.

    if (!terminalPinned) {
      set({ selectedWorkspaceId: id, selectedAgentId: null, terminalAgentId: null, activeTabId: nextActiveTabId, fileViewerOpen: false, browserOpen: false });
    } else {
      set({ selectedWorkspaceId: id, selectedAgentId: null, activeTabId: nextActiveTabId, fileViewerOpen: false, browserOpen: false });
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
    // Supervisors are ordinary cards now — upsert them into `agents` like any
    // other agent (no special supervisorAgent branch).
    set((state) => {
      const exists = state.agents.some((a) => a.id === agent.id);
      return {
        agents: exists
          ? state.agents.map((a) => (a.id === agent.id ? agent : a))
          : [...state.agents, agent],
      };
    });
  },

  removeAgent: (id) => {
    clearDraft(id);
    set((state) => {
      const { [id]: _dropped, ...agentStatuses } = state.agentStatuses;
      return {
        agents: state.agents.filter((a) => a.id !== id),
        agentStatuses,
        selectedAgentId: state.selectedAgentId === id ? null : state.selectedAgentId,
        terminalAgentId: state.terminalAgentId === id ? null : state.terminalAgentId,
      };
    });
    get().updateWorkspaceHeat();
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
      set((state) => ({
        agents: [...state.agents, forked],
        agentStatuses: {
          ...state.agentStatuses,
          [forked.id]: { workspaceId: forked.workspaceId, status: forked.status },
        },
      }));
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

  updateContextStats: (stats: ContextStats) => {
    set((state) => ({
      contextStats: { ...state.contextStats, [stats.agentId]: stats },
    }));
  },

  updateUsageLimits: (reading: UsageLimitsReading) => {
    set({ usageLimits: reading });
  },

  // Replace the active-deliberation set wholesale — the main-process payload is
  // authoritative. Skip the state write when the set is unchanged so subscribed
  // components don't re-render on redundant broadcasts.
  setDeliberatingSupervisorIds: (ids: string[]) => {
    set((state) => {
      const prev = state.deliberatingSupervisorIds;
      if (prev.length === ids.length && prev.every((id) => ids.includes(id))) {
        return {};
      }
      return { deliberatingSupervisorIds: ids };
    });
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
    const statuses = get().agentStatuses;
    const heat: Record<string, WorkspaceHeat> = {};
    for (const { workspaceId, status } of Object.values(statuses)) {
      if (status === 'done' || status === 'crashed') continue;
      if (!heat[workspaceId]) {
        heat[workspaceId] = { activeCount: 0, workingCount: 0, waitingCount: 0 };
      }
      heat[workspaceId].activeCount++;
      if (status === 'working') heat[workspaceId].workingCount++;
      if (status === 'waiting') heat[workspaceId].waitingCount++;
    }
    set({ workspaceHeat: heat });
  },

  loadAgentStatuses: async () => {
    const agents = await window.api.agents.listAll();
    get().seedAgentStatuses(agents);
  },

  // Wholesale replace of the index (startup / global reseed).
  seedAgentStatuses: (agents) => {
    const map: Record<string, AgentStatusSnapshot> = {};
    for (const a of agents) map[a.id] = { workspaceId: a.workspaceId, status: a.status };
    set({ agentStatuses: map });
    get().updateWorkspaceHeat();
  },

  // Unguarded upsert — the critical background-workspace path. Reading
  // agent.status is safe (see plan header "Verified safety note").
  updateAgentStatusSnapshot: (agent) => {
    set((state) => ({
      agentStatuses: {
        ...state.agentStatuses,
        [agent.id]: { workspaceId: agent.workspaceId, status: agent.status },
      },
    }));
    get().updateWorkspaceHeat();
  },

  removeAgentStatusesForWorkspace: (workspaceId) => {
    set((state) => {
      const kept = Object.entries(state.agentStatuses).filter(
        ([, v]) => v.workspaceId !== workspaceId,
      );
      if (kept.length === Object.keys(state.agentStatuses).length) return {};
      return { agentStatuses: Object.fromEntries(kept) };
    });
    get().updateWorkspaceHeat();
  },
}));
