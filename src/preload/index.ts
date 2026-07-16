import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcApi, DetachRequest, DetachedClosedPayload, ViewDetachRequest, ViewDetachedClosedPayload } from '../shared/types';
import { TAB_CHANNELS, VIEW_CHANNELS } from '../shared/types';
import { BROWSER_CHANNELS } from '../shared/browser';
import type {
  AccessRequestDecision,
  AccessRuleInput,
  AgentActionsCommand,
  AgentActionsState,
  AgentDrivingRevoked,
  Bookmark,
  BrowserAuditEntry,
  BrowserContextMenuParams,
  BrowserDownload,
  BrowserDownloadPrompt,
  BrowserFindResult,
  BrowserOpenRequest,
  BrowserShortcut,
  BrowserTabSnapshotEntry,
  BrowserTabState,
  SigninPendingOpened,
  SigninResolved,
} from '../shared/browser';

const api: IpcApi = {
  workspaces: {
    list: () => ipcRenderer.invoke('workspace:list'),
    create: (input) => ipcRenderer.invoke('workspace:create', input),
    delete: (id) => ipcRenderer.invoke('workspace:delete', id),
    reorder: (ids) => ipcRenderer.invoke('workspace:reorder', ids),
    openInVSCode: (id) => ipcRenderer.invoke('workspace:open-vscode', id),
  },
  agents: {
    list: (workspaceId) => ipcRenderer.invoke('agent:list', workspaceId),
    listAll: () => ipcRenderer.invoke('agent:list-all'),
    launch: (input) => ipcRenderer.invoke('agent:launch', input),
    stop: (id) => ipcRenderer.invoke('agent:stop', id),
    restart: (id) => ipcRenderer.invoke('agent:restart', id),
    getLog: (id, lines) => ipcRenderer.invoke('agent:get-log', id, lines),
    getRingBuffer: (id) => ipcRenderer.invoke('agent:get-ring-buffer', id),
    delete: (id) => ipcRenderer.invoke('agent:delete', id),
    checkAgentMd: (workingDirectory, pathType) => ipcRenderer.invoke('agent:check-agent-md', workingDirectory, pathType),
    getFileActivities: (agentId, operation, currentOnly) => ipcRenderer.invoke('agent:get-file-activities', agentId, operation, currentOnly),
    fork: (id) => ipcRenderer.invoke('agent:fork', id),
    query: (targetAgentId, question, sourceAgentId) => ipcRenderer.invoke('agent:query', targetAgentId, question, sourceAgentId),
    sendInput: (agentId, text) => ipcRenderer.invoke('agent:send-input', agentId, text),
    onSendInputError: (callback) => {
      const listener = (_event: any, data: { agentId: string; error: string }) => callback(data);
      ipcRenderer.on('agent:send-input-error', listener);
      return () => ipcRenderer.removeListener('agent:send-input-error', listener);
    },
    getSupervisor: (workspaceId) => ipcRenderer.invoke('agent:get-supervisor', workspaceId),
    updateSupervised: (id, supervised) => ipcRenderer.invoke('agent:update-supervised', id, supervised),
    setContinuationEnabled: (agentId, enabled) => ipcRenderer.invoke('agent:set-continuation-enabled', agentId, enabled),
    forceContinuationHandoff: (agentId) => ipcRenderer.invoke('agent:force-continuation-handoff', agentId),
    onFileActivity: (callback) => {
      const listener = (_event: any, activity: any) => callback(activity);
      ipcRenderer.on('agent:file-activity', listener);
      return () => ipcRenderer.removeListener('agent:file-activity', listener);
    },
    getContextStats: (agentId) => ipcRenderer.invoke('agent:get-context-stats', agentId),
    onContextStatsChanged: (callback) => {
      const listener = (_event: any, stats: any) => callback(stats);
      ipcRenderer.on('agent:context-stats-changed', listener);
      return () => ipcRenderer.removeListener('agent:context-stats-changed', listener);
    },
    getChatEvents: (agentId, sinceUuid) => ipcRenderer.invoke('agent:get-chat-events', agentId, sinceUuid),
    chatSubscribe: (agentId) => ipcRenderer.invoke('agent:chat-subscribe', agentId),
    chatUnsubscribe: (agentId) => ipcRenderer.invoke('agent:chat-unsubscribe', agentId),
    getFullToolResult: (agentId, toolUseId) => ipcRenderer.invoke('agent:chat-tool-result-full', agentId, toolUseId),
    getAgentSessions: (agentId) => ipcRenderer.invoke('agent:get-agent-sessions', agentId),
    getPriorSessionChat: (agentId, sessionRowId) => ipcRenderer.invoke('agent:get-prior-session-chat', agentId, sessionRowId),
    onChatEvents: (callback) => {
      const listener = (_event: any, batch: any) => callback(batch);
      ipcRenderer.on('agent:chat-events', listener);
      return () => ipcRenderer.removeListener('agent:chat-events', listener);
    },
  },
  usage: {
    getLimits: () => ipcRenderer.invoke('usage:get-limits'),
    onLimitsChanged: (callback) => {
      const listener = (_event: any, reading: any) => callback(reading);
      ipcRenderer.on('usage:limits-changed', listener);
      return () => ipcRenderer.removeListener('usage:limits-changed', listener);
    },
  },
  skillAnalytics: {
    indexStatus: () => ipcRenderer.invoke('skill-analytics:index-status'),
    indexPoll: () => ipcRenderer.invoke('skill-analytics:index-poll'),
    onIndexProgress: (callback) => {
      const listener = (_event: any, progress: any) => callback(progress);
      ipcRenderer.on('skill-analytics:index-progress', listener);
      return () => ipcRenderer.removeListener('skill-analytics:index-progress', listener);
    },
    query: (req) => ipcRenderer.invoke('skill-analytics:query', req),
  },
  mcpToolUsage: {
    query: (req) => ipcRenderer.invoke('mcp-tool-usage:query', req),
  },
  // Memory watchdog (incident-2026-07-11 §5 D5): status-bar meter/banner +
  // orphan-sweep panel. `memory:*` handles live in index.ts (own the sampler +
  // attribution service); `ownership:*` handles live in ipc-handlers.ts.
  memory: {
    getSnapshot: () => ipcRenderer.invoke('memory:get-snapshot'),
    getAttribution: () => ipcRenderer.invoke('memory:attribution'),
    onPressure: (callback) => {
      const listener = (_event: any, snap: any) => callback(snap);
      ipcRenderer.on('memory:pressure', listener);
      return () => ipcRenderer.removeListener('memory:pressure', listener);
    },
    listOrphans: () => ipcRenderer.invoke('ownership:list-orphans'),
    reapOrphans: (agentIds) => ipcRenderer.invoke('ownership:reap-orphans', agentIds),
    reapEstimate: (pids) => ipcRenderer.invoke('memory:reap-estimate', pids),
  },
  // Detached-process transparency (incident-2026-07-11 §5 Wave 5): lists the
  // agent-launched detached processes that self-registered under the workspace's
  // .dashboard/detached/ dir; each row is PID-verified in main. Handle in index.ts.
  detached: {
    list: (workspaceRoot) => ipcRenderer.invoke('detached:list', workspaceRoot),
  },
  plans: {
    // WP5: fires after each WP4 reparse so the renderer re-fetches the served
    // projection and full-re-renders (no in-place DOM patching). Rides the
    // reparse path, not a second fs subscription (F-C).
    onSurfaceChanged: (callback) => {
      const listener = (_event: any, payload: any) => callback(payload);
      ipcRenderer.on('plan-surface:changed', listener);
      return () => ipcRenderer.removeListener('plan-surface:changed', listener);
    },
    // WP5 mount: data reads + render-pane lifecycle (registerPlanIpc, main).
    list: (workspaceId) => ipcRenderer.invoke('plan:list', workspaceId),
    getProjection: (planId, opts) => ipcRenderer.invoke('plan:projection', planId, opts),
    paneShow: (planId) => ipcRenderer.invoke('plan-pane:show', planId),
    paneHide: () => ipcRenderer.invoke('plan-pane:hide'),
    paneSetBounds: (bounds) => ipcRenderer.invoke('plan-pane:setBounds', bounds),
    paneSetVisible: (visible) => ipcRenderer.invoke('plan-pane:setVisible', visible),
  },
  terminal: {
    attach: (agentId) => ipcRenderer.invoke('terminal:attach', agentId),
    detach: (agentId) => ipcRenderer.invoke('terminal:detach', agentId),
    write: (agentId, data) => ipcRenderer.invoke('terminal:write', agentId, data),
    resize: (agentId, cols, rows) => ipcRenderer.invoke('terminal:resize', agentId, cols, rows),
    onData: (callback) => {
      const listener = (_event: any, agentId: string, data: string) => callback(agentId, data);
      ipcRenderer.on('terminal:data', listener);
      return () => ipcRenderer.removeListener('terminal:data', listener);
    },
    // BUG-38: same-id PTY swap notice. Main fires this after a successful
    // continuation / restart relaunch so the renderer can dispose the retired
    // xterm and re-attach to the fresh PTY.
    onRebound: (callback) => {
      const listener = (_event: any, agentId: string) => callback(agentId);
      ipcRenderer.on('terminal:rebound', listener);
      return () => ipcRenderer.removeListener('terminal:rebound', listener);
    },
  },
  contextOverhead: {
    scan: (req) => ipcRenderer.invoke('context-overhead:scan', req),
  },
  agentKnowledge: {
    extract: (req) => ipcRenderer.invoke('agent-knowledge:extract', req),
  },
  contextOptimizer: {
    analyze: (req) => ipcRenderer.invoke('context-optimizer:analyze', req),
    markApplied: (req) => ipcRenderer.invoke('context-optimizer:mark-applied', req),
    signDerivation: (req) => ipcRenderer.invoke('context-optimizer:sign-derivation', req),
  },
  files: {
    readFile: (filePath, pathType) => ipcRenderer.invoke('files:read', filePath, pathType),
    convertDocxToMarkdown: (filePath, rootDirectory, pathType) =>
      ipcRenderer.invoke('files:convert-docx-to-markdown', filePath, rootDirectory, pathType),
    listDirectory: (dirPath, pathType) => ipcRenderer.invoke('files:list-directory', dirPath, pathType),
    writeFile: (filePath, rootDirectory, pathType, content) =>
      ipcRenderer.invoke('files:write', filePath, rootDirectory, pathType, content),
    createFile: (parentDir, rootDirectory, pathType, name, template) =>
      ipcRenderer.invoke('files:create-file', parentDir, rootDirectory, pathType, name, template),
    mkdir: (parentDir, rootDirectory, pathType, name) =>
      ipcRenderer.invoke('files:mkdir', parentDir, rootDirectory, pathType, name),
    rename: (oldPath, rootDirectory, pathType, newName) =>
      ipcRenderer.invoke('files:rename', oldPath, rootDirectory, pathType, newName),
    move: (srcPath, rootDirectory, pathType, destDir) =>
      ipcRenderer.invoke('files:move', srcPath, rootDirectory, pathType, destDir),
    copy: (sourcePaths, rootDirectory, pathType, destDir) =>
      ipcRenderer.invoke('files:copy', sourcePaths, rootDirectory, pathType, destDir),
    // Synchronous, stays in the preload process — webUtils resolves the
    // native path of a dropped File (Electron 41 removed File.path).
    // Cast: the IpcApi contract uses a structural File stand-in because
    // shared types compile without the DOM lib (tsconfig.main.json).
    getPathForFile: (file) => webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]),
    deleteEntry: (entryPath, rootDirectory, pathType, recursive) =>
      ipcRenderer.invoke('files:delete', entryPath, rootDirectory, pathType, recursive),
    reveal: (entryPath, pathType) =>
      ipcRenderer.invoke('files:reveal', entryPath, pathType),
    watchDirectory: (dirPath, pathType, callback) => {
      const id = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const listener = (_event: any, msg: { id: string; events: any[] }) => {
        if (msg.id !== id || !Array.isArray(msg.events)) return;
        for (const ev of msg.events) callback(ev);
      };
      ipcRenderer.on('files:watch-event', listener);
      ipcRenderer.invoke('files:watch-start', id, dirPath, pathType);
      return () => {
        ipcRenderer.removeListener('files:watch-event', listener);
        ipcRenderer.invoke('files:watch-stop', id);
      };
    },
  },
  system: {
    pickDirectory: (startInWsl?: boolean) => ipcRenderer.invoke('system:pick-directory', startInWsl),
    healthCheck: () => ipcRenderer.invoke('system:health-check'),
    openFile: (filePath, pathType) => ipcRenderer.invoke('system:open-file', filePath, pathType),
    openFileInWorkspace: (filePath, workspaceDir, pathType) =>
      ipcRenderer.invoke('system:open-file-in-workspace', filePath, workspaceDir, pathType),
    setTheme: (theme) => ipcRenderer.invoke('system:set-theme', theme),
    getApiToken: () => ipcRenderer.invoke('system:get-api-token'),
  },
  teams: {
    create: (input) => ipcRenderer.invoke('team:create', input),
    get: (teamId) => ipcRenderer.invoke('team:get', teamId),
    list: (workspaceId) => ipcRenderer.invoke('team:list', workspaceId),
    disband: (teamId) => ipcRenderer.invoke('team:disband', teamId),
    addMember: (teamId, agentId, role) => ipcRenderer.invoke('team:add-member', teamId, agentId, role),
    removeMember: (teamId, agentId) => ipcRenderer.invoke('team:remove-member', teamId, agentId),
    addChannel: (teamId, fromAgent, toAgent, label) => ipcRenderer.invoke('team:add-channel', teamId, fromAgent, toAgent, label),
    removeChannel: (teamId, channelId) => ipcRenderer.invoke('team:remove-channel', teamId, channelId),
    getMessages: (teamId, agentId) => ipcRenderer.invoke('team:get-messages', teamId, agentId),
    getTasks: (teamId) => ipcRenderer.invoke('team:get-tasks', teamId),
    createTask: (teamId, task) => ipcRenderer.invoke('team:create-task', teamId, task),
    updateTask: (teamId, taskId, updates) => ipcRenderer.invoke('team:update-task', teamId, taskId, updates),
    resurrect: (teamId) => ipcRenderer.invoke('team:resurrect', teamId),
  },
  templates: {
    list: (workspaceId) => ipcRenderer.invoke('template:list', workspaceId),
    create: (input) => ipcRenderer.invoke('template:create', input),
    update: (id, updates) => ipcRenderer.invoke('template:update', id, updates),
    delete: (id) => ipcRenderer.invoke('template:delete', id),
  },
  // WP-P5-A — persisted selection comments.
  comments: {
    create: (input) => ipcRenderer.invoke('comments:create', input),
    list: (workspaceId, filePath) => ipcRenderer.invoke('comments:list', workspaceId, filePath),
    update: (id, updates) => ipcRenderer.invoke('comments:update', id, updates),
    delete: (id) => ipcRenderer.invoke('comments:delete', id),
    resolve: (id) => ipcRenderer.invoke('comments:resolve', id),
    send: (request) => ipcRenderer.invoke('comments:send', request),
    onChanged: (callback) => {
      const listener = (_event: any, payload: any) => callback(payload);
      ipcRenderer.on('comments:changed', listener);
      return () => ipcRenderer.removeListener('comments:changed', listener);
    },
  },
  personas: {
    list: (workspacePath, pathType) => ipcRenderer.invoke('persona:list', workspacePath, pathType),
    create: (workspacePath, pathType, name, roleDescription?, lane?) => ipcRenderer.invoke('persona:create', workspacePath, pathType, name, roleDescription, lane),
    setLane: (workspacePath, pathType, name, lane) => ipcRenderer.invoke('persona:setLane', workspacePath, pathType, name, lane),
  },
  notebooks: {
    ensureServer: () => ipcRenderer.invoke('notebook:ensure-server'),
    listKernelspecs: () => ipcRenderer.invoke('notebook:list-kernelspecs'),
  },
  // WP1-A — embedded browser pane, frozen WP1 contract (src/shared/browser.ts).
  browser: {
    createTab: (opts) => ipcRenderer.invoke(BROWSER_CHANNELS.createTab, opts),
    closeTab: (tabId) => ipcRenderer.invoke(BROWSER_CHANNELS.closeTab, tabId),
    navigate: (tabId, url) => ipcRenderer.invoke(BROWSER_CHANNELS.navigate, tabId, url),
    goBack: (tabId) => ipcRenderer.invoke(BROWSER_CHANNELS.goBack, tabId),
    goForward: (tabId) => ipcRenderer.invoke(BROWSER_CHANNELS.goForward, tabId),
    reload: (tabId) => ipcRenderer.invoke(BROWSER_CHANNELS.reload, tabId),
    stop: (tabId) => ipcRenderer.invoke(BROWSER_CHANNELS.stop, tabId),
    setActiveTab: (tabId) => ipcRenderer.invoke(BROWSER_CHANNELS.setActiveTab, tabId),
    setBounds: (bounds) => ipcRenderer.invoke(BROWSER_CHANNELS.setBounds, bounds),
    setVisible: (visible) => ipcRenderer.invoke(BROWSER_CHANNELS.setVisible, visible),
    setActiveWorkspace: (workspaceId) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.setActiveWorkspace, workspaceId),
    getActionsEnabled: () => ipcRenderer.invoke(BROWSER_CHANNELS.getActionsEnabled),
    setActionsEnabled: (enabled) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.setActionsEnabled, enabled),
    // Slice 12: armed-state agent-actions gate.
    getActionsState: (): Promise<AgentActionsState> =>
      ipcRenderer.invoke(BROWSER_CHANNELS.getActionsState),
    setActionsState: (cmd: AgentActionsCommand): Promise<AgentActionsState> =>
      ipcRenderer.invoke(BROWSER_CHANNELS.setActionsState, cmd),
    onActionsStateChanged: (callback: (state: AgentActionsState) => void) => {
      const listener = (_event: any, state: AgentActionsState) => callback(state);
      ipcRenderer.on(BROWSER_CHANNELS.actionsStateChanged, listener);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS.actionsStateChanged, listener);
    },
    onTabState: (callback) => {
      const listener = (_event: any, state: BrowserTabState) => callback(state);
      ipcRenderer.on(BROWSER_CHANNELS.tabState, listener);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS.tabState, listener);
    },
    onOpenRequest: (callback) => {
      const listener = (_event: any, request: BrowserOpenRequest) => callback(request);
      ipcRenderer.on(BROWSER_CHANNELS.openRequest, listener);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS.openRequest, listener);
    },
    // ── Overhaul (WP0) — additive plumbing. Bookmarks/history are USER-PARTITION
    //    ONLY by contract (main gates partition; renderer cannot bypass). ──────
    reorderTab: (tabId, toOrder) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.reorderTab, tabId, toOrder),
    setTabPinned: (tabId, pinned) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.setTabPinned, tabId, pinned),
    reopenClosedTab: () => ipcRenderer.invoke(BROWSER_CHANNELS.reopenClosedTab),
    // Slice 10/11 — session restore (PULL, idempotent) + idle-discard threshold.
    sessionRestore: () => ipcRenderer.invoke(BROWSER_CHANNELS.sessionRestore),
    setDiscardThreshold: (ms) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.browserDiscardThreshold, ms),
    findInPage: (tabId, text, opts) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.findInPage, tabId, text, opts),
    stopFindInPage: (tabId) => ipcRenderer.invoke(BROWSER_CHANNELS.stopFindInPage, tabId),
    // Slice 15: stateful find — per-tab query/state, immediate next/prev, restore.
    find: (tabId, query, opts) => ipcRenderer.invoke(BROWSER_CHANNELS.find, tabId, query, opts),
    findNext: (tabId) => ipcRenderer.invoke(BROWSER_CHANNELS.findNext, tabId),
    findPrev: (tabId) => ipcRenderer.invoke(BROWSER_CHANNELS.findPrev, tabId),
    stopFind: (tabId) => ipcRenderer.invoke(BROWSER_CHANNELS.stopFind, tabId),
    setZoom: (tabId, zoomFactor) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.setZoom, tabId, zoomFactor),
    // Slice 15: reset zoom to 100% + clear the persisted per-origin row (USER).
    resetZoomForOrigin: (tabId) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.resetZoomForOrigin, tabId),
    contextMenuRequest: (tabId, params) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.contextMenuRequest, tabId, params),
    bookmarkList: () => ipcRenderer.invoke(BROWSER_CHANNELS.bookmarkList),
    bookmarkAdd: (input) => ipcRenderer.invoke(BROWSER_CHANNELS.bookmarkAdd, input),
    bookmarkRemove: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.bookmarkRemove, id),
    bookmarkUpdate: (id, patch) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.bookmarkUpdate, id, patch),
    bookmarkReorder: (orderedIds) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.bookmarkReorder, orderedIds),
    omniboxSuggest: (query) => ipcRenderer.invoke(BROWSER_CHANNELS.omniboxSuggest, query),
    historyList: (query) => ipcRenderer.invoke(BROWSER_CHANNELS.historyList, query),
    historyDelete: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.historyDelete, id),
    historyClear: () => ipcRenderer.invoke(BROWSER_CHANNELS.historyClear),
    historyTopSites: (limit) => ipcRenderer.invoke(BROWSER_CHANNELS.historyTopSites, limit),
    onTabsSnapshot: (callback) => {
      const listener = (_event: any, entries: BrowserTabSnapshotEntry[]) => callback(entries);
      ipcRenderer.on(BROWSER_CHANNELS.tabsSnapshot, listener);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS.tabsSnapshot, listener);
    },
    onShortcutCommand: (callback) => {
      const listener = (_event: any, shortcut: BrowserShortcut, ctx: { tabId: string }) =>
        callback(shortcut, ctx);
      ipcRenderer.on(BROWSER_CHANNELS.shortcutCommand, listener);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS.shortcutCommand, listener);
    },
    onFoundInPage: (callback) => {
      const listener = (_event: any, result: BrowserFindResult) => callback(result);
      ipcRenderer.on(BROWSER_CHANNELS.foundInPage, listener);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS.foundInPage, listener);
    },
    onContextMenuCommand: (callback) => {
      const listener = (_event: any, action: string, params: BrowserContextMenuParams) =>
        callback(action, params);
      ipcRenderer.on(BROWSER_CHANNELS.contextMenuCommand, listener);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS.contextMenuCommand, listener);
    },
    onBookmarksChanged: (callback) => {
      const listener = (_event: any, bookmarks: Bookmark[]) => callback(bookmarks);
      ipcRenderer.on(BROWSER_CHANNELS.bookmarksChanged, listener);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS.bookmarksChanged, listener);
    },
    // ── Slice-3: denial toasts + live Activity/Audit drawer. TRUSTED CHROME. ───
    auditRecent: (limit) => ipcRenderer.invoke(BROWSER_CHANNELS.auditRecent, limit),
    onAuditEvent: (callback) => {
      const listener = (_event: any, entry: BrowserAuditEntry) => callback(entry);
      ipcRenderer.on(BROWSER_CHANNELS.auditEvent, listener);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS.auditEvent, listener);
    },

    // ── Slice 12: handoff / session center. Live handed tabs + persisted
    //    signed-in origins (with session-age + stale flags); plus the off-origin
    //    auto-revoke notification. Trusted chrome only. ──────────────────────────
    getSharedSessions: () => ipcRenderer.invoke(BROWSER_CHANNELS.getSharedSessions),
    onAgentDrivingRevoked: (callback) => {
      const listener = (_event: any, payload: AgentDrivingRevoked) => callback(payload);
      ipcRenderer.on(BROWSER_CHANNELS.agentDrivingRevoked, listener);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS.agentDrivingRevoked, listener);
    },

    // ── Slice 13: user-only downloads. Lifecycle events + the confirm prompt
    //    are main → renderer pushes; the invokes manage records + confirm. ─────
    downloadList: () => ipcRenderer.invoke(BROWSER_CHANNELS.downloadList),
    downloadConfirm: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.downloadConfirm, id),
    downloadOpenFile: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.downloadOpenFile, id),
    downloadShowInFolder: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.downloadShowInFolder, id),
    downloadRetry: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.downloadRetry, id),
    downloadRemove: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.downloadRemove, id),
    // ── Slice 14: reading mode. Trusted chrome only; main self-gates to http(s)
    //    USER tabs and sanitizes the article HTML before it returns. ───────────
    enterReadingMode: (tabId) => ipcRenderer.invoke(BROWSER_CHANNELS.enterReadingMode, tabId),
    onDownloadStarted: (callback) => {
      const listener = (_event: any, rec: BrowserDownload) => callback(rec);
      ipcRenderer.on(BROWSER_CHANNELS.downloadStarted, listener);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS.downloadStarted, listener);
    },
    onDownloadProgress: (callback) => {
      const listener = (_event: any, rec: BrowserDownload) => callback(rec);
      ipcRenderer.on(BROWSER_CHANNELS.downloadProgress, listener);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS.downloadProgress, listener);
    },
    onDownloadDone: (callback) => {
      const listener = (_event: any, rec: BrowserDownload) => callback(rec);
      ipcRenderer.on(BROWSER_CHANNELS.downloadDone, listener);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS.downloadDone, listener);
    },
    onDownloadFailed: (callback) => {
      const listener = (_event: any, rec: BrowserDownload) => callback(rec);
      ipcRenderer.on(BROWSER_CHANNELS.downloadFailed, listener);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS.downloadFailed, listener);
    },
    onDownloadPrompt: (callback) => {
      const listener = (_event: any, prompt: BrowserDownloadPrompt) => callback(prompt);
      ipcRenderer.on(BROWSER_CHANNELS.downloadPrompt, listener);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS.downloadPrompt, listener);
    },

    // ── Website-access policy (plans/website-allowlist-simplification.md).
    //    Trusted shell chrome only — never reachable from page/model output. ──
    access: {
      list: () => ipcRenderer.invoke(BROWSER_CHANNELS.accessRuleList),
      add: (input: AccessRuleInput) => ipcRenderer.invoke(BROWSER_CHANNELS.accessRuleAdd, input),
      update: (id: string, patch: Partial<AccessRuleInput> & { enabled?: boolean }) =>
        ipcRenderer.invoke(BROWSER_CHANNELS.accessRuleUpdate, id, patch),
      remove: (id: string) => ipcRenderer.invoke(BROWSER_CHANNELS.accessRuleRemove, id),
      siteStatus: () => ipcRenderer.invoke(BROWSER_CHANNELS.accessSiteStatus),
      onChanged: (callback: () => void) => {
        const listener = () => callback();
        ipcRenderer.on(BROWSER_CHANNELS.accessChanged, listener);
        return () => ipcRenderer.removeListener(BROWSER_CHANNELS.accessChanged, listener);
      },
      requestList: () => ipcRenderer.invoke(BROWSER_CHANNELS.accessRequestList),
      requestDecide: (id: string, decision: AccessRequestDecision) =>
        ipcRenderer.invoke(BROWSER_CHANNELS.accessRequestDecide, id, decision),
      onRequestsChanged: (callback: () => void) => {
        const listener = () => callback();
        ipcRenderer.on(BROWSER_CHANNELS.accessRequestsChanged, listener);
        return () => ipcRenderer.removeListener(BROWSER_CHANNELS.accessRequestsChanged, listener);
      },
      handoffSignin: (ruleId: string) =>
        ipcRenderer.invoke(BROWSER_CHANNELS.accessHandoffSignin, ruleId),
      handoffReady: (tabId: string) =>
        ipcRenderer.invoke(BROWSER_CHANNELS.accessHandoffReady, tabId),
      tabHandToAgent: (tabId: string) =>
        ipcRenderer.invoke(BROWSER_CHANNELS.accessTabHandToAgent, tabId),
      tabReturnToHuman: (tabId: string) =>
        ipcRenderer.invoke(BROWSER_CHANNELS.accessTabReturnToHuman, tabId),
      clearSiteSession: (ruleId: string) =>
        ipcRenderer.invoke(BROWSER_CHANNELS.accessClearSiteSession, ruleId),
      // WI-E "Import my session": copy the human's persist:user cookies for the
      // rule's origin into the agent partition. HUMAN-CHROME-ONLY (never agent).
      importUserSession: (ruleId: string) =>
        ipcRenderer.invoke(BROWSER_CHANNELS.accessImportUserSession, ruleId),

      // ── Signed-in tabs (WI-5): JIT sign-in banner events + cancel + WI-8 config.
      //    The *-opened / *-resolved channels are main→renderer pushes that drive
      //    the JIT banner; signinPendingCancel is the banner's "Cancel" invoke. ──
      onSigninPendingOpened: (callback: (payload: SigninPendingOpened) => void) => {
        const listener = (_e: any, payload: SigninPendingOpened) => callback(payload);
        ipcRenderer.on(BROWSER_CHANNELS.signinPendingOpened, listener);
        return () => ipcRenderer.removeListener(BROWSER_CHANNELS.signinPendingOpened, listener);
      },
      onSigninResolved: (callback: (payload: SigninResolved) => void) => {
        const listener = (_e: any, payload: SigninResolved) => callback(payload);
        ipcRenderer.on(BROWSER_CHANNELS.signinResolved, listener);
        return () => ipcRenderer.removeListener(BROWSER_CHANNELS.signinResolved, listener);
      },
      signinPendingCancel: (tabId: string) =>
        ipcRenderer.invoke(BROWSER_CHANNELS.signinPendingCancel, tabId),
      // Phase 4 item 4: explicit human re-arm of a run-scoped signin_unavailable
      // latch for one (workspace, origin) → the next agent nav reopens ONE setup tab.
      signinReArm: (workspaceId: string | null, origin: string): Promise<boolean> =>
        ipcRenderer.invoke(BROWSER_CHANNELS.signinReArm, workspaceId, origin),
      getSigninHoldTimeoutMs: () => ipcRenderer.invoke(BROWSER_CHANNELS.getSigninHoldTimeoutMs),
      setSigninHoldTimeoutMs: (ms: number) =>
        ipcRenderer.invoke(BROWSER_CHANNELS.setSigninHoldTimeoutMs, ms),
      setSigninUnattended: (workspaceId: string | null, unattended: boolean) =>
        ipcRenderer.invoke(BROWSER_CHANNELS.setSigninUnattended, workspaceId, unattended),
      isSigninUnattended: (workspaceId: string | null) =>
        ipcRenderer.invoke(BROWSER_CHANNELS.isSigninUnattended, workspaceId),
    },
  },
  // Detachable (tear-off) file tabs — plans/detachable-file-tabs-plan.md §4.
  tabs: {
    detach: (req: DetachRequest) => ipcRenderer.invoke(TAB_CHANNELS.detach, req),
    onDetachedClosed: (cb: (p: DetachedClosedPayload) => void) => {
      const l = (_e: any, p: DetachedClosedPayload) => cb(p);
      ipcRenderer.on(TAB_CHANNELS.closed, l);
      return () => ipcRenderer.removeListener(TAB_CHANNELS.closed, l);
    },
    // Phase 2 dirty-on-close protocol — declared now, behavior wired in Phase 2.
    onCloseQuery: (cb: (req: { requestId: string }) => void) => {
      const l = (_e: any, req: { requestId: string }) => cb(req);
      ipcRenderer.on(TAB_CHANNELS.closeQuery, l);
      return () => ipcRenderer.removeListener(TAB_CHANNELS.closeQuery, l);
    },
    closeReply: (requestId: string, decision: 'save' | 'discard' | 'cancel') =>
      ipcRenderer.invoke(TAB_CHANNELS.closeReply, requestId, decision),
  },
  // Detachable (tear-off) top-level views — sibling of `tabs`, no dirty-close.
  views: {
    detach: (req: ViewDetachRequest) => ipcRenderer.invoke(VIEW_CHANNELS.detach, req),
    onClosed: (cb: (p: ViewDetachedClosedPayload) => void) => {
      const l = (_e: any, p: ViewDetachedClosedPayload) => cb(p);
      ipcRenderer.on(VIEW_CHANNELS.closed, l);
      return () => ipcRenderer.removeListener(VIEW_CHANNELS.closed, l);
    },
  },
  onOpenFileTab: (callback) => {
    const listener = (_event: any, payload: any) => callback(payload);
    ipcRenderer.on('file:open-tab', listener);
    return () => ipcRenderer.removeListener('file:open-tab', listener);
  },
  onAgentStatusChanged: (callback) => {
    const listener = (_event: any, data: any) => callback(data);
    ipcRenderer.on('agent:status-changed', listener);
    return () => ipcRenderer.removeListener('agent:status-changed', listener);
  },
  onAgentDeleted: (callback) => {
    const listener = (_event: any, data: { agentId: string }) => callback(data);
    ipcRenderer.on('agent:deleted', listener);
    return () => ipcRenderer.removeListener('agent:deleted', listener);
  },
  onTeamUpdated: (callback) => {
    const listener = (_event: any, team: any) => callback(team);
    ipcRenderer.on('team:updated', listener);
    return () => ipcRenderer.removeListener('team:updated', listener);
  },
  onTeamMessageCreated: (callback) => {
    const listener = (_event: any, message: any) => callback(message);
    ipcRenderer.on('team:message-created', listener);
    return () => ipcRenderer.removeListener('team:message-created', listener);
  },
  listActiveOrchestrations: () => ipcRenderer.invoke('orchestration:list-active'),
  onOrchestrationActiveChanged: (callback) => {
    const listener = (_event: any, supervisorIds: string[]) => callback(supervisorIds);
    ipcRenderer.on('orchestration:active-changed', listener);
    return () => ipcRenderer.removeListener('orchestration:active-changed', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
