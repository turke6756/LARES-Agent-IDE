import { contextBridge, ipcRenderer } from 'electron';
import type { IpcApi } from '../shared/types';

const api: IpcApi = {
  workspaces: {
    list: () => ipcRenderer.invoke('workspace:list'),
    create: (input) => ipcRenderer.invoke('workspace:create', input),
    delete: (id) => ipcRenderer.invoke('workspace:delete', id),
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
    deleteEntry: (entryPath, rootDirectory, pathType, recursive) =>
      ipcRenderer.invoke('files:delete', entryPath, rootDirectory, pathType, recursive),
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
  personas: {
    list: (workspacePath, pathType) => ipcRenderer.invoke('persona:list', workspacePath, pathType),
    create: (workspacePath, pathType, name, customClaudeMd?) => ipcRenderer.invoke('persona:create', workspacePath, pathType, name, customClaudeMd),
  },
  notebooks: {
    ensureServer: () => ipcRenderer.invoke('notebook:ensure-server'),
    listKernelspecs: () => ipcRenderer.invoke('notebook:list-kernelspecs'),
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
