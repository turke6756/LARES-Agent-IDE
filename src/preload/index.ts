import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcApi, DetachRequest, DetachedClosedPayload } from '../shared/types';
import { TAB_CHANNELS } from '../shared/types';
import { BROWSER_CHANNELS } from '../shared/browser';
import type {
  AccessRequestDecision,
  AccessRuleInput,
  Bookmark,
  BrowserContextMenuParams,
  BrowserFindResult,
  BrowserOpenRequest,
  BrowserShortcut,
  BrowserTabSnapshotEntry,
  BrowserTabState,
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
    getFileActivities: (agentId, operation) => ipcRenderer.invoke('agent:get-file-activities', agentId, operation),
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
    onChatEvents: (callback) => {
      const listener = (_event: any, batch: any) => callback(batch);
      ipcRenderer.on('agent:chat-events', listener);
      return () => ipcRenderer.removeListener('agent:chat-events', listener);
    },
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
  },
  files: {
    readFile: (filePath, pathType) => ipcRenderer.invoke('files:read', filePath, pathType),
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
    create: (workspacePath, pathType, name, customClaudeMd?) => ipcRenderer.invoke('persona:create', workspacePath, pathType, name, customClaudeMd),
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
    findInPage: (tabId, text, opts) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.findInPage, tabId, text, opts),
    stopFindInPage: (tabId) => ipcRenderer.invoke(BROWSER_CHANNELS.stopFindInPage, tabId),
    setZoom: (tabId, zoomFactor) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.setZoom, tabId, zoomFactor),
    contextMenuRequest: (tabId, params) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.contextMenuRequest, tabId, params),
    bookmarkList: () => ipcRenderer.invoke(BROWSER_CHANNELS.bookmarkList),
    bookmarkAdd: (input) => ipcRenderer.invoke(BROWSER_CHANNELS.bookmarkAdd, input),
    bookmarkRemove: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.bookmarkRemove, id),
    bookmarkReorder: (orderedIds) =>
      ipcRenderer.invoke(BROWSER_CHANNELS.bookmarkReorder, orderedIds),
    historyList: (query) => ipcRenderer.invoke(BROWSER_CHANNELS.historyList, query),
    historyDelete: (id) => ipcRenderer.invoke(BROWSER_CHANNELS.historyDelete, id),
    historyClear: () => ipcRenderer.invoke(BROWSER_CHANNELS.historyClear),
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

    // ── Website-access policy (plans/website-allowlist-simplification.md).
    //    Trusted shell chrome only — never reachable from page/model output. ──
    access: {
      list: () => ipcRenderer.invoke(BROWSER_CHANNELS.accessRuleList),
      add: (input: AccessRuleInput) => ipcRenderer.invoke(BROWSER_CHANNELS.accessRuleAdd, input),
      update: (id: string, patch: Partial<AccessRuleInput> & { enabled?: boolean }) =>
        ipcRenderer.invoke(BROWSER_CHANNELS.accessRuleUpdate, id, patch),
      remove: (id: string) => ipcRenderer.invoke(BROWSER_CHANNELS.accessRuleRemove, id),
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
};

contextBridge.exposeInMainWorld('api', api);
