import { create } from 'zustand';
import type { Agent, AgentStatus, Workspace, HealthCheck, RuntimePrerequisiteReport, FileActivity, QueryResult, ContextStats, ContinuationPhaseSignal, ContinuationPhaseState, UsageLimitsReading, PathType, FileTab, PanelLayout, Team, TeamMessage, CreateTeamInput, DetachedClosedPayload, DetachableView, WriteErrorCode, CheckpointTurnSummary, CheckpointPreviewResult, CheckpointRestoreRequest, CheckpointRevertRequest, CheckpointRestoreResult, CheckpointFileHistoryVersion } from '../../shared/types';
import { beginWrite, evictTabCache } from '../components/fileviewer/useFileContentCache';
import { contentHash } from '../components/fileviewer/markdownSplice';
import { diag, diagBasename, diagHash } from '../components/fileviewer/editLossDiag';
import { clearDraft } from '../lib/chat-drafts';
import {
  nextPhaseMap,
  prunePhasesForAgents,
} from '../components/agent/continuation-phase-view';

/** Which app version's first-run prerequisite modal this user has already
 *  seen. Versioned rather than boolean so a future release that adds a new
 *  prerequisite gets one fresh chance to explain it. */
const PREREQ_SEEN_VERSION_KEY = 'lares.onboarding.prereqSeenVersion';


interface WorkspaceHeat {
  activeCount: number;
  workingCount: number;
  waitingCount: number;
}

interface AgentStatusSnapshot {
  workspaceId: string;
  status: AgentStatus;
}

// WP4 — a transient request to scroll/highlight a source span when a tab opens or
// re-activates. Pure renderer UI state (like `color`, below): it never crosses the
// IPC boundary, so it lives on the renderer extension, not the shared FileTab.
// `nonce` makes a repeat click on an already-open tab re-fire the scroll effect.
export interface TabFocusRange {
  lineStart: number;
  lineEnd: number;
  mode?: 'source';
  reason?: string;
  nonce: number;
}

// Renderer-side extension of FileTab: `color` is an optional per-tab visual
// marker chosen from the tab context menu. The shared FileTab type stays
// untouched because color never crosses the IPC boundary.
export type ColoredFileTab = FileTab & { color?: string; focusRange?: TabFocusRange };

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

// B2 (smarter resolution): before blindly joining a relative prose path under
// the workspace root, prefer an absolute path the agent actually touched. Chat
// text often names a file loosely (`index.ts`, or a truncated `README.md`); if
// the agent read/wrote a file matching that reference, opening the real file it
// touched beats fabricating a root-relative path that may not exist. Returns
// null when nothing matches, so the caller falls back to the root join.
//
// Matching is basename-anchored, most-recent-first (fileActivities is stored
// newest-first): a full relative-suffix match wins over a bare basename match to
// avoid opening an unrelated same-named file when the reference carries dirs.
function findTouchedFileMatch(
  activities: FileActivity[],
  agentId: string,
  relPath: string,
): string | null {
  const relKey = relPath.replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase();
  if (!relKey) return null;
  const base = relKey.split('/').pop();
  if (!base) return null;
  const mine = activities.filter((a) => a.agentId === agentId);
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const suffixHit = mine.find((a) => {
    const k = norm(a.filePath);
    return k === relKey || k.endsWith(`/${relKey}`);
  });
  if (suffixHit) return suffixHit.filePath;
  const baseHit = mine.find((a) => norm(a.filePath).split('/').pop() === base);
  return baseHit ? baseHit.filePath : null;
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
  /** CAS guard for conditional writes (edit-loss §4.1): contentHash of the
   *  bytes we believe are on disk; `null` = expect the file absent. Usually
   *  tracks hash(originalContent), EXCEPT after dismissExternalChange, which
   *  advances it to hash(pendingDiskContent) — acknowledging the external
   *  bytes so the next conditional save may overwrite them, while still
   *  conflicting if disk moved on again. `undefined` = pre-4.1 session state;
   *  consumers fall back to contentHash(originalContent). */
  expectedDiskHash?: string | null;
  /** Writer-classified code for the last failed save (edit-loss §4.4):
   *  'too-large'/'permission' stop autosave retries immediately; 'io' (and
   *  unclassified failures) follow the 5s → 15s → stop backoff. Cleared
   *  whenever `error` clears. */
  errorCode?: WriteErrorCode | null;
}

// Per-workspace snapshot of "what the user was looking at" (view-state
// persistence). Captured on leaving a workspace and restored on return, so a
// workspace comes back exactly as it was left — attached agent chat, terminal,
// open file/browser view, and detail pane — instead of resetting to the
// dashboard grid. In-memory only; not persisted across app restarts.
interface WorkspaceViewState {
  selectedAgentId: string | null;
  terminalAgentId: string | null;
  activeTabId: string | null;
  fileViewerOpen: boolean;
  browserOpen: boolean;
  // SC-WP-1I — the read-only Save-card center surface. A peer of the file
  // viewer / browser panes: at most one center surface is open at a time, and
  // this flag is snapshotted/restored per workspace like the others.
  saveCardOpen: boolean;
  // Plans center pane; snapshotted/restored per workspace like the other
  // center-surface flags.
  plansOpen: boolean;
  detailPane: 0 | 1 | 2;
}

interface DashboardState {
  workspaces: Workspace[];
  agents: Agent[];
  // WP5 — cross-workspace "@"-mention catalog. A SEPARATE slice from `agents`
  // (which is intentionally selected-workspace-only — `updateAgent` discards
  // foreign events), so the mention picker's workspace rail can target agents in
  // any workspace without globalizing the selected-workspace view. Null until the
  // picker first opens; loaded/refreshed on each open (see loadMentionCatalog).
  mentionCatalog: { agents: Agent[]; workspaces: Workspace[]; loading: boolean } | null;
  selectedWorkspaceId: string | null;
  selectedAgentId: string | null;
  terminalAgentId: string | null;
  terminalPinned: boolean;
  // Per-workspace view-state snapshots (keyed by workspace id). See
  // WorkspaceViewState + selectWorkspace for the snapshot/restore contract.
  workspaceViewState: Record<string, WorkspaceViewState>;
  health: HealthCheck | null;
  healthChecking: boolean;
  // ── Runtime prerequisites (packaging plan §6.3) ──
  // The full report behind `health`. Null until the first load.
  prerequisites: RuntimePrerequisiteReport | null;
  prerequisitesChecking: boolean;
  /** First-run modal visibility. Opened once per app version when no provider
   *  is installed, and on demand from Help > Check prerequisites. */
  prerequisitesDialogOpen: boolean;
  /** The non-modal status card was dismissed this session. Deliberately NOT
   *  persisted: dismissing the card hides a reminder, it should not
   *  permanently hide the fact that agents cannot launch. */
  prerequisitesCardDismissed: boolean;
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
  // Live continuation handoff phase per agent — the gold "snake" border AND the
  // per-phase label line. Main-authoritative: hydrated from
  // agents.listContinuationPhases() on mount and kept live by the
  // 'continuation:phase' broadcast, so a renderer reload or a detached window
  // opened mid-cycle shows the same state (see continuation-phase-view.ts).
  // Absent id = no handoff running.
  continuationPhases: Record<string, ContinuationPhaseState>;

  // Git-Native WP-G2.4 — per-agent checkpoint time-rail data. Keyed by agentId
  // (NOT cwd/slug — the CLAUDE.md invariant: many agents share one working dir).
  // Loaded lazily when a card's rail is expanded, refreshed after a restore/revert.
  // Witnessed PATHS only — never worktree bytes.
  checkpointTurns: Record<string, CheckpointTurnSummary[]>;
  checkpointLoading: Record<string, boolean>;
  loadCheckpointTurns: (workspaceId: string, agentId: string) => Promise<void>;
  // Git-Native WP-G3.2 — WORKSPACE-WIDE turns (all agents), keyed by workspaceId.
  // Feeds the richer attribution UI (cross-agent contention, filtering, stats).
  // Loaded via the same WP-G2.2 `list` route with NO agentId (the route returns
  // every agent's turns for the workspace). Presentation-only; no new IPC.
  workspaceCheckpointTurns: Record<string, CheckpointTurnSummary[]>;
  workspaceCheckpointLoading: Record<string, boolean>;
  loadWorkspaceCheckpointTurns: (workspaceId: string) => Promise<void>;
  /** Fetch a restore preview (witnessed set + anti-TOCTOU tokens + open-turn
   *  contention). RestoreDialog REQUIRES this before a restore can be confirmed. */
  previewCheckpointRestore: (
    workspaceId: string,
    turnId: string,
    paths?: string[],
  ) => Promise<CheckpointPreviewResult>;
  /** Path-scoped restore, then refresh the agent's rail (a restore always leaves a
   *  recoverable pre-restore checkpoint that should appear). */
  restoreCheckpointPaths: (
    req: CheckpointRestoreRequest,
    agentId: string,
  ) => Promise<CheckpointRestoreResult>;
  /** Whole-turn "undo", then refresh the agent's rail. */
  revertCheckpointTurn: (
    req: CheckpointRevertRequest,
    agentId: string,
  ) => Promise<CheckpointRestoreResult>;
  /** WP-G3.1 — versions of ONE canonical path across retained, live-verified turns
   *  (file right-click → History). Returns the versions (newest first) or `null` when
   *  the engine is unavailable, so FileHistoryView can render an honest empty state
   *  rather than throw. Restore of a version reuses the preview-gated RestoreDialog. */
  loadFileHistory: (
    workspaceId: string,
    path: string,
  ) => Promise<CheckpointFileHistoryVersion[] | null>;

  // Teams
  teams: Team[];
  teamMessages: Record<string, TeamMessage[]>;

  // Panel layout
  panelLayout: PanelLayout;
  setPanelSize: (key: keyof PanelLayout, value: number) => void;
  togglePanelCollapsed: (key: keyof PanelLayout) => void;
  toggleSidePanels: () => void;
  resetLayout: () => void;

  // Tabbed file viewer
  openTabs: ColoredFileTab[];
  activeTabId: string | null;
  fileViewerOpen: boolean;
  // Browser pane center-mode flag (WP1-B). Precedence: file viewer wins —
  // opening either pane closes the other.
  browserOpen: boolean;
  // Save-card center-surface flag (SC-WP-1I). A peer of fileViewerOpen /
  // browserOpen; the show* actions are mutually exclusive and the center
  // dispatch resolves precedence file viewer > browser > save card > dashboard.
  saveCardOpen: boolean;
  // WP-P1S — one-shot "the Save card was opened by a user gesture" signal.
  // `showSaveCard()` sets it true; SaveCard consumes it on mount to emit exactly
  // one `savecard_open` demand probe. Session-restore reopens (switchWorkspace)
  // leave it false, so a restore-driven mount stays silent. Transient — NOT part
  // of the per-workspace view snapshot.
  saveCardOpenGesture: boolean;
  // Plans center-pane flag. A first-class peer of fileViewerOpen, browserOpen,
  // and saveCardOpen. Plans is an inline center surface, never a popup/overlay.
  plansOpen: boolean;
  tabEditState: Record<string, TabEditState>;

  // Actions
  loadWorkspaces: () => Promise<void>;
  moveWorkspace: (fromId: string, toId: string | null) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  loadAgents: (workspaceId: string) => Promise<void>;
  loadAllAgents: () => Promise<void>;
  /** WP5 — load/refresh the cross-workspace mention catalog. Called when the
   *  "@" picker opens. Uses window.api.agents.listAll() for the agents and the
   *  already-loaded `workspaces` for the rail. */
  loadMentionCatalog: () => Promise<void>;
  selectWorkspace: (id: string | null) => void;
  selectAgent: (id: string | null) => void;
  setTerminalAgent: (id: string | null) => void;
  toggleTerminalPinned: () => void;
  updateAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;
  deleteAgent: (id: string) => Promise<void>;
  checkHealth: () => Promise<void>;
  loadPrerequisites: (force?: boolean) => Promise<RuntimePrerequisiteReport | null>;
  /** Load the report and open the modal only if this app version has not shown
   *  it yet AND no provider is available. Called once on startup. */
  maybeShowFirstRunPrerequisites: () => Promise<void>;
  openPrerequisitesDialog: () => void;
  closePrerequisitesDialog: () => void;
  dismissPrerequisitesCard: () => void;
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
  hydrateContinuationPhases: (phases: ContinuationPhaseState[]) => void;
  applyContinuationPhase: (signal: ContinuationPhaseSignal) => void;
  setOptimisticContinuationQueued: (agentId: string) => void;
  clearOptimisticContinuationPhase: (agentId: string) => void;
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
  openTab: (filePath: string, rootDirectory: string, pathType: PathType, agentId?: string, workspaceId?: string, focusRange?: TabFocusRange) => void;
  openDirectoryTab: (rootDirectory: string, pathType: PathType, workspaceId?: string) => void;
  openToolTab: (toolId: string, label: string, opts?: { workspaceId?: string; params?: Record<string, string> }) => void;
  openPlanTab: (planId: string, label: string, workspaceId?: string) => void;
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
  // The single write executor (edit-loss Phase 2): echo token + evictTabCache
  // + saving/error state live here. `opts` is passed ONLY by the save
  // coordinator (saveCoordinator.ts) — `content` writes the coordinator's
  // captured snapshot instead of the live draft (and leaves `dirty` untouched
  // so the store can never blip clean under an in-flight edit; the
  // coordinator recomputes dirty after its completion gates). Every save is
  // CONDITIONAL (edit-loss §4.1): `expectedDiskHash` becomes the writer's CAS
  // guard; `force: true` maps to an unconditional write (close-dialog
  // "Overwrite anyway" and tests only). A CAS refusal resolves 'conflict' —
  // banner raised, draft/dirty/revision preserved, nothing written.
  saveTab: (
    tabId: string,
    opts?: { content?: string; revision?: number; expectedDiskHash?: string | null; force?: boolean },
  ) => Promise<boolean | 'conflict'>;
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
  showSaveCard: () => void;
  // Activate the Plans center pane (closes the other panes).
  showPlans: () => void;
  // WP-P1S — consume the one-shot gesture signal after SaveCard has witnessed it.
  consumeSaveCardGesture: () => void;

  // Detachable (tear-off) top-level views. `detachedViews` holds the views
  // currently torn off into their own OS windows; their toolbar buttons render
  // as hollowed-out ghosts and are non-activatable until the external window
  // closes. Mirrors the file-tab detach registry (main owns the windows).
  detachedViews: DetachableView[];
  markViewDetached: (view: DetachableView) => void;
  undetachView: (view: DetachableView) => void;

  // Backward-compat shims
  openFileViewer: (filePath: string, agentId: string) => void;
  closeFileViewer: () => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  workspaces: [],
  agents: [],
  mentionCatalog: null,
  selectedWorkspaceId: null,
  selectedAgentId: null,
  terminalAgentId: null,
  terminalPinned: false,
  workspaceViewState: {},
  health: null,
  healthChecking: false,
  prerequisites: null,
  prerequisitesChecking: false,
  prerequisitesDialogOpen: false,
  prerequisitesCardDismissed: false,
  loading: false,
  detailPane: 2,
  fileActivities: [],
  workspaceHeat: {},
  agentStatuses: {},
  contextStats: {},
  usageLimits: null,
  deliberatingSupervisorIds: [],
  continuationPhases: {},
  checkpointTurns: {},
  checkpointLoading: {},
  workspaceCheckpointTurns: {},
  workspaceCheckpointLoading: {},
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

  toggleSidePanels: () => {
    set((state) => {
      const collapsed = !(
        state.panelLayout.sidebarCollapsed && state.panelLayout.detailPanelCollapsed
      );
      const layout = {
        ...state.panelLayout,
        sidebarCollapsed: collapsed,
        detailPanelCollapsed: collapsed,
      };
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
  saveCardOpen: false,
  saveCardOpenGesture: false,
  plansOpen: false,
  tabEditState: {},

  openTab: (filePath, rootDirectory, pathType, agentId?, workspaceId?, focusRange?) => {
    const { openTabs, selectedWorkspaceId } = get();
    const ws = workspaceId ?? selectedWorkspaceId ?? undefined;
    // Check if tab already exists for this file+root combo
    const existing = openTabs.find(
      (t) => t.filePath === filePath && t.rootDirectory === rootDirectory
    );
    if (existing) {
      // WP4: a repeat click carrying a fresh focusRange re-scrolls/re-highlights the
      // already-open tab (nonce forces the CodeMirror effect to re-run).
      if (focusRange) {
        set((state) => ({
          activeTabId: existing.id,
          fileViewerOpen: true,
          browserOpen: false,
          openTabs: state.openTabs.map((t) => (t.id === existing.id ? { ...t, focusRange } : t)),
        }));
      } else {
        set({ activeTabId: existing.id });
      }
      return;
    }

    const normalized = filePath.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    const label = segments[segments.length - 1] || filePath;

    const tab: ColoredFileTab = {
      id: nextTabId(),
      filePath,
      rootDirectory,
      pathType,
      agentId,
      workspaceId: ws,
      label,
      focusRange,
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
  // Files view. Deduped by (workspace, toolId, params): re-focuses if already
  // open. `params` (base plan §3.5) lets per-agent tools open one tab per agent
  // instead of collapsing into a single shared tab. Empty filePath/rootDirectory
  // so the file header + directory tree never render (FileViewerPanel gates on
  // kind==='tool').
  openToolTab: (toolId, label, opts) => {
    const { openTabs, selectedWorkspaceId } = get();
    const ws = opts?.workspaceId ?? selectedWorkspaceId ?? undefined;
    const params = opts?.params;
    const paramsKey = JSON.stringify(params ?? {});
    const existing = openTabs.find(
      (t) =>
        t.kind === 'tool' &&
        t.toolId === toolId &&
        t.workspaceId === ws &&
        JSON.stringify(t.params ?? {}) === paramsKey,
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
      ...(params ? { params } : {}),
    };
    set((state) => ({
      openTabs: [...state.openTabs, tab],
      activeTabId: tab.id,
      fileViewerOpen: true,
      browserOpen: false,
    }));
  },

  // A plan surface tab (kind==='plan'). Like tool tabs it owns its full content
  // region — empty filePath/rootDirectory so no file header/tree renders — but
  // is deduped by (workspace, planId) so opening the same plan re-focuses its
  // existing tab. The content is a sandboxed WebContentsView driven by the main
  // process; PlanSurfaceContainer streams the pane bounds and the provenance rail.
  openPlanTab: (planId, label, workspaceId) => {
    // A detached Plans view owns the single plan pane (main-process WebContentsView).
    // Opening a plan tab in the main window would fight the detached window over
    // that one pane, so it's inert here until the detached window closes — mirrors
    // showFileViewer's detach guard.
    if (get().detachedViews.includes('plans')) return;
    const { openTabs, selectedWorkspaceId } = get();
    const ws = workspaceId ?? selectedWorkspaceId ?? undefined;
    const existing = openTabs.find((t) => t.kind === 'plan' && t.planId === planId && t.workspaceId === ws);
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
      kind: 'plan',
      planId,
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
            expectedDiskHash: contentHash(initialContent),
          },
        },
      };
    });
  },

  // Creates the edit session for the WYSIWYG canvas (plan §5: state is
  // created on WYSIWYG mount by FileContentArea, never by the editor
  // component itself, so saveTab always has state to act on). A dirty draft
  // is preserved — mode flips, everything else is kept — and the canvas
  // mounts FROM the preserved draft (edit-loss Phase 1), so this is the
  // source → wysiwyg carry, mirroring enterSourceMode. Callers gate
  // incompatible drafts via sniffWysiwygCompatibility(draftContent) before
  // switching in.
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
            expectedDiskHash: contentHash(initialContent),
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
            expectedDiskHash: contentHash(initialContent),
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
            errorCode: null,
          },
        },
      };
    });
  },

  saveTab: async (tabId, opts) => {
    const { openTabs, tabEditState } = get();
    const tab = openTabs.find((t) => t.id === tabId);
    const editState = tabEditState[tabId];
    if (!tab || !tab.filePath || !editState) return false;
    // Coordinator path: write the captured snapshot, not the live draft (a
    // draft that moves mid-write must not change what this write puts on
    // disk — the coordinator's gates decide what happens next).
    const fromCoordinator = opts?.content !== undefined;
    const draftToSave = opts?.content ?? editState.draftContent;
    // Conditional write (edit-loss §4.1): every normal save carries the CAS
    // guard — the coordinator's captured hash when present, else the store
    // field, else (pre-4.1 session state) derived from originalContent.
    // `force` maps to an UNCONDITIONAL write (expectedHash omitted): the
    // close-dialog "Overwrite anyway" and tests only, never a banner button.
    const expectedHash = opts?.force
      ? undefined
      : opts?.expectedDiskHash !== undefined
        ? opts.expectedDiskHash
        : editState.expectedDiskHash !== undefined
          ? editState.expectedDiskHash
          : contentHash(editState.originalContent);

    set((state) => ({
      tabEditState: {
        ...state.tabEditState,
        [tabId]: { ...editState, saving: true, error: null },
      },
    }));

    // Write-ledger token (edit-loss Phase 3 §3.2): open a generation token
    // *before* the write so the fs-watcher revalidate can drop the echo even
    // when it fires before the post-save state update below lands. Committed
    // on success; invalidated on failure so a failed write never suppresses
    // an identical EXTERNAL write as our own echo (R5).
    const writeToken = beginWrite(tabId, contentHash(draftToSave));
    const result = await window.api.files.writeFile(
      tab.filePath,
      tab.rootDirectory,
      tab.pathType,
      draftToSave,
      expectedHash,
    );
    if (tab.pathType === 'wsl') {
      await get().checkHealth();
    }

    if (!result.ok) {
      // R5: the bytes never reached disk — drop this exact generation's
      // token so an identical external write is surfaced, not swallowed.
      writeToken.invalidate();
      if (result.conflict) {
        // CAS refusal (§4.1): disk moved since our baseline. Raise the banner
        // with the fresh bytes the writer already read; draft, dirty, and the
        // coordinator's revision are all preserved — nothing was written.
        // DIAG(edit-loss): conditional write refused by the CAS check.
        diag('store-save-conflict', {
          tabId,
          file: diagBasename(tab.filePath),
          expectedHash,
          freshHash: diagHash(result.freshContent),
        });
        set((state) => {
          const current = state.tabEditState[tabId];
          if (!current) return state;
          return {
            tabEditState: {
              ...state.tabEditState,
              [tabId]: { ...current, saving: false },
            },
          };
        });
        get().markExternalChange(tabId, result.freshContent);
        return 'conflict';
      }
      set((state) => {
        const current = state.tabEditState[tabId];
        if (!current) return state;
        return {
          tabEditState: {
            ...state.tabEditState,
            [tabId]: { ...current, saving: false, error: result.error, errorCode: result.code ?? null },
          },
        };
      });
      return false;
    }

    writeToken.commit();
    evictTabCache(tabId);
    // DIAG(edit-loss): save success — what reached disk vs the live draft
    // (a draft that moved during the write leaves dirty=true below).
    diag('store-save-success', {
      tabId,
      file: diagBasename(tab.filePath),
      writtenHash: diagHash(draftToSave),
      revision: opts?.revision,
      liveDraftHash: diagHash(get().tabEditState[tabId]?.draftContent),
    });
    set((state) => {
      const current = state.tabEditState[tabId];
      if (!current) return state;
      return {
        tabEditState: {
          ...state.tabEditState,
          [tabId]: {
            ...current,
            // B1 install: disk truth is what THIS write put there.
            originalContent: draftToSave,
            expectedDiskHash: contentHash(draftToSave),
            // Coordinator writes leave `dirty` untouched: the coordinator
            // recomputes it after its revision/serialization gates, so the
            // store never blips clean while a raced edit is still live only
            // in the editor (edit-loss Phase 2 §2.1).
            dirty: fromCoordinator ? current.dirty : current.draftContent !== draftToSave,
            saving: false,
            error: null,
            errorCode: null,
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
            // Explicit discard is unambiguous user intent: bump reloadVersion
            // (the same supersession gate the editor cleanup honors for
            // reloadFromDisk) so the dying mount's cleanup flushDirtyDraft()
            // cannot resurrect the discarded draft (edit-loss Phase 2
            // pre-task).
            reloadVersion: (existing.reloadVersion ?? 0) + 1,
          },
        },
      };
    });
  },

  markExternalChange: (tabId, freshContent) => {
    // DIAG(edit-loss): the banner trigger — what the store believed at the
    // moment the external change was surfaced.
    {
      const es = get().tabEditState[tabId];
      diag('store-mark-external-change', {
        tabId,
        freshHash: diagHash(freshContent),
        storeDirty: !!es?.dirty,
        draftHash: diagHash(es?.draftContent),
        originalHash: diagHash(es?.originalContent),
        alreadyBannered: !!es?.externalChange,
      });
    }
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
            // "Keep my changes" acknowledges the external bytes: ADVANCE the
            // CAS guard to hash(pendingDiskContent) so the next conditional
            // save may overwrite them — but conflicts again if disk moved on
            // yet again (edit-loss §4.1). originalContent stays: it is the
            // splice/EOL baseline, not the CAS guard.
            expectedDiskHash:
              existing.pendingDiskContent !== undefined
                ? contentHash(existing.pendingDiskContent)
                : existing.expectedDiskHash,
          },
        },
      };
    });
  },

  reloadFromDisk: (tabId) => {
    // DIAG(edit-loss): the draft-destroying path — pendingDiskContent replaces
    // the draft permanently.
    {
      const es = get().tabEditState[tabId];
      diag('store-reload-from-disk', {
        tabId,
        pendingHash: diagHash(es?.pendingDiskContent),
        draftHash: diagHash(es?.draftContent),
        storeDirty: !!es?.dirty,
        reloadVersion: es?.reloadVersion ?? 0,
      });
    }
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
            expectedDiskHash: contentHash(fresh),
          },
        },
      };
    });
  },

  refreshOriginalContent: (tabId, freshContent) => {
    // DIAG(edit-loss): baseline refresh after a clean 'fallback' swap — the
    // H5 path rebaselines the store here.
    {
      const es = get().tabEditState[tabId];
      diag('store-refresh-original', {
        tabId,
        freshHash: diagHash(freshContent),
        storeDirty: !!es?.dirty,
        originalHash: diagHash(es?.originalContent),
        applied: !!es && !es.dirty && es.originalContent !== freshContent,
      });
    }
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
            expectedDiskHash: contentHash(freshContent),
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
    // A detached Files view is non-activatable in the main window (view-detach
    // §5) — no-op so the ghost button + swipe gesture stay inert.
    if (get().detachedViews.includes('files')) return;
    const { openTabs, activeTabId, selectedWorkspaceId, workspaces } = get();
    const wsTabs = openTabs.filter((t) => t.workspaceId === selectedWorkspaceId);
    if (wsTabs.length > 0) {
      const activeBelongs = wsTabs.some((t) => t.id === activeTabId);
      set({
        fileViewerOpen: true,
        browserOpen: false,
        saveCardOpen: false,
        plansOpen: false,
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
  showBrowser: () => set({ browserOpen: true, fileViewerOpen: false, saveCardOpen: false, plansOpen: false }),
  hideBrowser: () => set({ browserOpen: false }),

  // Save-card center surface (SC-WP-1I). Peer of the file viewer / browser
  // panes — opening it closes the others (explicit mutual exclusion). Read-only
  // inspect surface; there is no writer, so this only swaps what the center
  // renders. Not detachable (Stage ① non-goal), so no detached-view guard.
  showSaveCard: () =>
    set({ saveCardOpen: true, saveCardOpenGesture: true, fileViewerOpen: false, browserOpen: false, plansOpen: false }),

  // Activate Plans as an inline peer of the other center panes. No portal or
  // component-local open state participates in top-level navigation.
  showPlans: () =>
    set({ plansOpen: true, fileViewerOpen: false, browserOpen: false, saveCardOpen: false }),

  // WP-P1S — SaveCard calls this on mount once it has recorded the voluntary-open
  // demand probe, so a later re-render / StrictMode remount can't re-fire it.
  consumeSaveCardGesture: () => set({ saveCardOpenGesture: false }),

  // Return to the agent-card grid (WP-NAV). Tabs survive — only the view resets.
  // A detached Dashboard cannot be reactivated in the main window — no-op so the
  // ghost button stays inert (MainContent renders a placeholder instead).
  showDashboard: () => {
    if (get().detachedViews.includes('dashboard')) return;
    set({ fileViewerOpen: false, browserOpen: false, saveCardOpen: false, plansOpen: false });
  },

  // Detachable views registry (renderer mirror of main's view-window registry).
  detachedViews: [],
  markViewDetached: (view) =>
    set((state) =>
      state.detachedViews.includes(view)
        ? state
        : { detachedViews: [...state.detachedViews, view] },
    ),
  undetachView: (view) =>
    set((state) => ({ detachedViews: state.detachedViews.filter((v) => v !== view) })),

  // Backward-compat shim: openFileViewer calls openTab
  openFileViewer: (filePath, agentId) => {
    const agent = get().agents.find((a) => a.id === agentId);
    if (!agent) return;
    const workspace = get().workspaces.find((w) => w.id === agent.workspaceId);
    const pathType = workspace?.pathType || 'windows';
    // Paths mentioned in chat are normally workspace-relative (for example
    // `plans/foo.md` or `src/main/index.ts`). Supervisors and managed workers
    // run from scaffold directories under `.lares`, so resolving those
    // references against the agent cwd incorrectly produces paths such as
    // `.lares/supervisor/plans/foo.md`. Use the workspace root when it is
    // available; retain the agent cwd as a compatibility fallback for agents
    // whose workspace record has not hydrated yet.
    const rootDirectory = workspace?.path || agent.workingDirectory;
    // B2: for a relative reference, prefer a real file this agent touched whose
    // name matches before falling back to a workspace-root join (which can
    // point at a path that never existed). Absolute references are honored
    // as-is. See findTouchedFileMatch.
    let resolved = resolveAgainstRoot(filePath, rootDirectory);
    if (!isAbsolutePath(filePath)) {
      const touched = findTouchedFileMatch(get().fileActivities, agentId, filePath);
      if (touched) resolved = touched;
    }
    get().openTab(resolved, rootDirectory, pathType, agentId, agent.workspaceId);
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
      // A generic agent refresh must NOT clear a continuation phase. The old
      // reconcile did (it dropped any agent not currently 'restarting'), which
      // is why the transfer flag only ever survived the sub-second swap window.
      // The single thing this refresh proves is that an agent is GONE — and
      // only for THIS workspace, since the list is workspace-scoped.
      const present = new Set(agents.map((a) => a.id));
      const phases = prunePhasesForAgents(
        state.continuationPhases,
        present,
        (id) => state.agentStatuses[id]?.workspaceId === workspaceId,
      );
      return phases === state.continuationPhases
        ? { agents, agentStatuses: next }
        : { agents, agentStatuses: next, continuationPhases: phases };
    });
    get().updateWorkspaceHeat();
  },

  loadAllAgents: async () => {
    // All-workspaces view: same as loadAgents — supervisors are real cards now.
    const agents = await window.api.agents.listAll();
    set((state) => {
      // Authoritative across every workspace, so absence really does mean gone.
      const present = new Set(agents.map((a) => a.id));
      const phases = prunePhasesForAgents(state.continuationPhases, present);
      return phases === state.continuationPhases
        ? { agents }
        : { agents, continuationPhases: phases };
    });
    get().updateWorkspaceHeat();
  },

  loadMentionCatalog: async () => {
    // Keep any previously-loaded agents visible while refreshing so reopening
    // the picker doesn't flash empty; snapshot the currently-loaded workspaces.
    set((s) => ({
      mentionCatalog: {
        agents: s.mentionCatalog?.agents ?? [],
        workspaces: get().workspaces,
        loading: true,
      },
    }));
    try {
      const agents = await window.api.agents.listAll();
      set(() => ({
        mentionCatalog: { agents, workspaces: get().workspaces, loading: false },
      }));
    } catch {
      // Honest failure: drop the loading flag, keep whatever agents we had.
      set((s) => ({
        mentionCatalog: {
          agents: s.mentionCatalog?.agents ?? [],
          workspaces: get().workspaces,
          loading: false,
        },
      }));
    }
  },

  // ── Git-Native WP-G2.4 — checkpoint time rail ──────────────────────────────
  loadCheckpointTurns: async (workspaceId, agentId) => {
    set((s) => ({ checkpointLoading: { ...s.checkpointLoading, [agentId]: true } }));
    try {
      const res = await window.api.checkpoints.list(workspaceId, { agentId });
      set((s) => ({
        checkpointTurns: { ...s.checkpointTurns, [agentId]: res.turns },
        checkpointLoading: { ...s.checkpointLoading, [agentId]: false },
      }));
    } catch (err) {
      // Honest failure: the engine may be unavailable (no usable git / still
      // bootstrapping). Clear the spinner and leave any prior turns in place; the
      // rail renders the empty/unavailable state rather than throwing.
      console.error('Failed to load checkpoint turns:', err);
      set((s) => ({ checkpointLoading: { ...s.checkpointLoading, [agentId]: false } }));
    }
  },

  // Git-Native WP-G3.2 — load ALL of a workspace's turns for the attribution UI.
  // Same list route, no agentId → every agent's turns. Honest-degrade on failure.
  loadWorkspaceCheckpointTurns: async (workspaceId) => {
    set((s) => ({
      workspaceCheckpointLoading: { ...s.workspaceCheckpointLoading, [workspaceId]: true },
    }));
    try {
      const res = await window.api.checkpoints.list(workspaceId);
      set((s) => ({
        workspaceCheckpointTurns: { ...s.workspaceCheckpointTurns, [workspaceId]: res.turns },
        workspaceCheckpointLoading: { ...s.workspaceCheckpointLoading, [workspaceId]: false },
      }));
    } catch (err) {
      console.error('Failed to load workspace checkpoint turns:', err);
      set((s) => ({
        workspaceCheckpointLoading: { ...s.workspaceCheckpointLoading, [workspaceId]: false },
      }));
    }
  },

  previewCheckpointRestore: (workspaceId, turnId, paths) =>
    window.api.checkpoints.preview(
      workspaceId,
      turnId,
      paths && paths.length > 0 ? paths : undefined,
    ),

  restoreCheckpointPaths: async (req, agentId) => {
    const result = await window.api.checkpoints.restore(req);
    // Refresh AFTER the mutation regardless of outcome: a completed/partial
    // restore changes the witnessed state, and even a failed force leaves the
    // rail's contention view worth re-deriving.
    await get().loadCheckpointTurns(req.workspaceId, agentId);
    return result;
  },

  revertCheckpointTurn: async (req, agentId) => {
    const result = await window.api.checkpoints.revert(req);
    await get().loadCheckpointTurns(req.workspaceId, agentId);
    return result;
  },

  loadFileHistory: async (workspaceId, path) => {
    try {
      const res = await window.api.checkpoints.fileHistory(workspaceId, path);
      return res.versions;
    } catch (err) {
      // Honest failure: the engine may be unavailable (no usable git / still
      // bootstrapping). FileHistoryView renders the empty/unavailable state.
      console.error('Failed to load file history:', err);
      return null;
    }
  },

  // Switch workspaces with per-workspace view-state persistence: snapshot the
  // OUTGOING workspace's view (attached agent chat, terminal, open file/browser
  // view, active tab, detail pane) then restore the INCOMING workspace's
  // snapshot — so a workspace comes back exactly as it was left. A never-before-
  // visited workspace falls back to the dashboard grid (today's defaults). The
  // remembered agent is restored optimistically and reconciled once loadAgents
  // returns (it may have been stopped/removed while the user was away).
  selectWorkspace: (id) => {
    const state = get();
    const outgoing = state.selectedWorkspaceId;
    const { openTabs, terminalPinned } = state;

    // Re-selecting the current workspace is a no-op for the view — just refresh
    // its agents/teams. (Snapshotting-then-restoring here would round-trip the
    // live view through a stale snapshot.)
    if (id === outgoing) {
      if (id) {
        get().loadAgents(id);
        get().loadTeams(id);
      }
      return;
    }

    // 1. Snapshot what the user was looking at in the outgoing workspace.
    const workspaceViewState = { ...state.workspaceViewState };
    if (outgoing) {
      workspaceViewState[outgoing] = {
        selectedAgentId: state.selectedAgentId,
        terminalAgentId: state.terminalAgentId,
        activeTabId: state.activeTabId,
        fileViewerOpen: state.fileViewerOpen,
        browserOpen: state.browserOpen,
        saveCardOpen: state.saveCardOpen,
        plansOpen: state.plansOpen,
        detailPane: state.detailPane,
      };
    }

    // 2. Compute the incoming view — restore the snapshot if we have one, else
    // fall back to the dashboard grid.
    const snap = id ? workspaceViewState[id] : undefined;
    // Re-point the file viewer's active tab at something that belongs to the new
    // workspace, so the tree root is right and visibleTabs isn't filtered empty.
    const fallbackTabId = openTabs.find((t) => t.workspaceId === id)?.id ?? null;

    let nextSelectedAgentId: string | null;
    let nextTerminalAgentId: string | null;
    let nextActiveTabId: string | null;
    let nextFileViewerOpen: boolean;
    let nextBrowserOpen: boolean;
    let nextSaveCardOpen: boolean;
    let nextPlansOpen: boolean;
    let nextDetailPane: 0 | 1 | 2;

    if (snap) {
      nextSelectedAgentId = snap.selectedAgentId;
      nextTerminalAgentId = snap.terminalAgentId;
      nextFileViewerOpen = snap.fileViewerOpen;
      nextBrowserOpen = snap.browserOpen;
      nextSaveCardOpen = snap.saveCardOpen;
      nextPlansOpen = snap.plansOpen;
      nextDetailPane = snap.detailPane;
      // The remembered tab may have been closed while away; validate it still
      // exists and belongs to this workspace, else re-point to any of its tabs.
      const tabOk = openTabs.some((t) => t.id === snap.activeTabId && t.workspaceId === id);
      nextActiveTabId = tabOk ? snap.activeTabId : fallbackTabId;
    } else {
      // Fresh workspace: land on the dashboard grid.
      nextSelectedAgentId = null;
      nextTerminalAgentId = null;
      nextFileViewerOpen = false;
      nextBrowserOpen = false;
      nextSaveCardOpen = false;
      nextPlansOpen = false;
      nextDetailPane = state.detailPane;
      nextActiveTabId = fallbackTabId;
    }

    // A pinned terminal stays attached across workspace switches regardless of
    // either workspace's snapshot — that's the whole point of pinning.
    if (terminalPinned) {
      nextTerminalAgentId = state.terminalAgentId;
    }

    set({
      selectedWorkspaceId: id,
      selectedAgentId: nextSelectedAgentId,
      terminalAgentId: nextTerminalAgentId,
      activeTabId: nextActiveTabId,
      fileViewerOpen: nextFileViewerOpen,
      browserOpen: nextBrowserOpen,
      saveCardOpen: nextSaveCardOpen,
      plansOpen: nextPlansOpen,
      detailPane: nextDetailPane,
      workspaceViewState,
    });

    if (id) {
      const targetId = id;
      // loadAgents refreshes `agents` async; once it returns, drop any restored
      // selection/terminal whose agent no longer exists (stopped/removed while
      // away). Guard on the workspace still being current so a fast A→B→A switch
      // doesn't let a stale reconcile clobber the newer view.
      get()
        .loadAgents(targetId)
        .then(() => {
          if (get().selectedWorkspaceId !== targetId) return;
          const cur = get();
          const patch: Partial<DashboardState> = {};
          if (cur.selectedAgentId && !cur.agents.some((a) => a.id === cur.selectedAgentId)) {
            patch.selectedAgentId = null;
          }
          if (
            !cur.terminalPinned &&
            cur.terminalAgentId &&
            !cur.agents.some((a) => a.id === cur.terminalAgentId)
          ) {
            patch.terminalAgentId = null;
          }
          if (Object.keys(patch).length > 0) set(patch);
        });
      get().loadTeams(targetId);
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
      // The health check is a projection of the full prerequisite report, so a
      // refresh of one refreshes the other — the sidebar ticker and the
      // prerequisites dialog can never show contradictory answers.
      set({ health, healthChecking: false, ...(health.prerequisites ? { prerequisites: health.prerequisites } : {}) });
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

  // ── Runtime prerequisites (packaging plan §6.3) ──

  loadPrerequisites: async (force) => {
    set({ prerequisitesChecking: true });
    try {
      const report = await window.api.system.getRuntimePrerequisites(force);
      set({ prerequisites: report, prerequisitesChecking: false });
      return report;
    } catch (err) {
      // A failed probe must never blank the last known answer — stale truth
      // beats an empty panel that reads as "nothing is installed".
      console.error('Prerequisite check failed:', err);
      set({ prerequisitesChecking: false });
      return get().prerequisites;
    }
  },

  maybeShowFirstRunPrerequisites: async () => {
    const report = await get().loadPrerequisites();
    if (!report) return;
    // Display policy, settled in the plan: show the modal ONCE per app version,
    // not on every launch while no provider is installed. Re-nagging someone
    // who deliberately chose "Continue without agents" is a worse failure than
    // under-informing them — the non-modal card and Help ▸ Check prerequisites
    // keep it rediscoverable, and a real launch attempt always errors clearly.
    if (report.anyProviderAvailable) return;
    let seen: string | null = null;
    try {
      seen = window.localStorage.getItem(PREREQ_SEEN_VERSION_KEY);
    } catch {
      /* storage unavailable — fall through and show it */
    }
    if (seen === report.appVersion) return;
    try {
      window.localStorage.setItem(PREREQ_SEEN_VERSION_KEY, report.appVersion);
    } catch {
      /* best effort */
    }
    set({ prerequisitesDialogOpen: true });
  },

  openPrerequisitesDialog: () => set({ prerequisitesDialogOpen: true }),
  closePrerequisitesDialog: () => set({ prerequisitesDialogOpen: false }),
  dismissPrerequisitesCard: () => set({ prerequisitesCardDismissed: true }),

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

  // ── Continuation handoff phases (main-authoritative) ───────────────────

  /** Replace the map wholesale from listContinuationPhases(). Called once on
   *  mount by every window that renders cards — this is what stops a renderer
   *  reload mid-180-s-wait from recreating the original "nothing happened"
   *  defect. */
  hydrateContinuationPhases: (phases: ContinuationPhaseState[]) => {
    const next: Record<string, ContinuationPhaseState> = {};
    for (const p of phases) next[p.agentId] = p;
    set({ continuationPhases: next });
  },

  /** Fold one authoritative broadcast in. `phase: null` deletes (completion).
   *  The reducer returns the same object reference on a no-op so only cards
   *  whose own entry changed re-render. */
  applyContinuationPhase: (signal: ContinuationPhaseSignal) => {
    set((state) => {
      const next = nextPhaseMap(state.continuationPhases, signal);
      return next === state.continuationPhases ? {} : { continuationPhases: next };
    });
  },

  /** Paint `queued` the instant the button is pressed, BEFORE awaiting IPC.
   *  The authoritative `queued` event lands milliseconds later and replaces
   *  this identical-looking entry; on rejection the caller clears it. */
  setOptimisticContinuationQueued: (agentId: string) => {
    set((state) => ({
      continuationPhases: {
        ...state.continuationPhases,
        [agentId]: { agentId, phase: 'queued', updatedAt: Date.now() },
      },
    }));
  },

  /** Roll back an optimistic `queued` after a rejected press. Deliberately
   *  narrow: it only drops an entry still sitting at `queued`, so it can never
   *  erase a real phase the authoritative rail has since advanced to. */
  clearOptimisticContinuationPhase: (agentId: string) => {
    set((state) => {
      if (state.continuationPhases[agentId]?.phase !== 'queued') return {};
      const next = { ...state.continuationPhases };
      delete next[agentId];
      return { continuationPhases: next };
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
