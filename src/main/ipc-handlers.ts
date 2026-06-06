import { ipcMain, dialog, shell, BrowserWindow, nativeTheme } from 'electron';
import * as fs from 'fs';
import { persistTheme } from './theme-persistence';
import type { PathType, FsEvent } from '../shared/types';
import { AgentSupervisor } from './supervisor';
import {
  getWorkspaces, createWorkspace, deleteWorkspace, getWorkspace, reorderWorkspaces,
  getAgentsByWorkspace, getAllAgents, getAgent, getFileActivities, getWorkspaceAgentSummary,
  checkAgentMdExists, updateAgentSupervised,
  createTeam, getTeam, listTeams, updateTeamStatus, addTeamMember, removeTeamMember,
  createChannel, removeChannel, getTeamMessages, getTeamTasks, createTeamTask, updateTeamTask,
  listAgentTemplates, createAgentTemplate, updateAgentTemplate, deleteAgentTemplate,
} from './database';
import { openInVSCode, openFileInVSCode, openFileInWorkspace } from './vscode-launcher';
import { getPassiveWslStatus, isTmuxAvailable, isClaudeAvailableInWsl } from './wsl-bridge';
import { execFileSync } from 'child_process';
import { detectPathType, ensureWindowsPath } from './path-utils';
import { readFileContents, listDirectoryEntriesAsync } from './file-reader';
import { writeFileContents, createFile, createDirectory, renameEntry, moveEntry, copyFiles, deleteEntry } from './file-writer';
import { subscribe as subscribeFsWatch } from './fs-watcher';
import { scanPersonas, scaffoldPersona } from './persona-scanner';
import { ensureJupyterServer, listKernelspecs } from './jupyter-server';

function resolveMutationPathType(primaryPath: string, rootDirectory: string, pathType?: PathType): PathType {
  const primaryType = detectPathType(primaryPath);
  const rootType = detectPathType(rootDirectory);
  if (primaryType === rootType) return primaryType;
  return pathType === 'windows' || pathType === 'wsl' ? pathType : primaryType;
}

export function registerIpcHandlers(supervisor: AgentSupervisor, mainWindow: BrowserWindow): void {
  // Workspace handlers
  ipcMain.handle('workspace:list', () => getWorkspaces());
  ipcMain.handle('workspace:create', (_e, input) => createWorkspace(input));
  ipcMain.handle('workspace:delete', (_e, id) => deleteWorkspace(id));
  ipcMain.handle('workspace:reorder', (_e, ids: string[]) => reorderWorkspaces(ids));

  ipcMain.handle('workspace:open-vscode', (_e, id) => {
    const ws = getWorkspace(id);
    if (ws) openInVSCode(ws.path, ws.pathType);
  });

  // Agent handlers
  ipcMain.handle('agent:list', (_e, workspaceId) => getAgentsByWorkspace(workspaceId));
  ipcMain.handle('agent:list-all', () => getAllAgents());
  ipcMain.handle('agent:launch', (_e, input) => supervisor.launchAgent(input));
  ipcMain.handle('agent:stop', (_e, id) => supervisor.stopAgent(id));
  ipcMain.handle('agent:restart', (_e, id) => supervisor.restartAgent(id));
  ipcMain.handle('agent:get-log', (_e, id, lines) => supervisor.getAgentLog(id, lines));
  ipcMain.handle('agent:get-ring-buffer', (_e, id) => supervisor.getAgentRingBuffer(id));
  ipcMain.handle('agent:get', (_e, id) => getAgent(id));
  ipcMain.handle('agent:get-file-activities', (_e, agentId, operation) => getFileActivities(agentId, operation));
  ipcMain.handle('agent:delete', (_e, id) => supervisor.deleteAgent(id));
  ipcMain.handle('agent:fork', (_e, id) => supervisor.forkAgent(id));
  ipcMain.handle('agent:query', (_e, targetAgentId, question, sourceAgentId) => supervisor.queryAgent(targetAgentId, question, sourceAgentId));
  ipcMain.handle('agent:send-input', (_e, agentId, text) => {
    // Mirror the HTTP route's safety gate (api-server.ts) so the IPC path
    // can't bypass it when the renderer's idle detection is eager. Without
    // this, a chat-input Enter against a "looks-idle but actually-busy"
    // agent silently writes into a non-receptive PTY and the message
    // vanishes with no trace anywhere.
    const agent = getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    if (supervisor.isInputInFlight(agentId) || ['working', 'launching'].includes(agent.status)) {
      const reportedStatus = supervisor.isInputInFlight(agentId) ? 'receiving' : agent.status;
      throw new Error(`Agent is "${reportedStatus}" — wait until it's idle before sending.`);
    }
    // Fire-and-forget: the Windows codex/gemini path types one char at a time
    // to dodge paste-burst, so multi-KB sends take 30+ seconds. Returning the
    // delivery promise here would freeze the chat input UI for that whole
    // window. Async failures (PTY closed mid-typing, runner removed, etc.)
    // are surfaced to the renderer via 'agent:send-input-error' so the chat
    // input can render them inline instead of swallowing them.
    supervisor.sendInput(agentId, text).catch((err: Error) => {
      console.error(`[ipc] Background input delivery to ${agentId} failed:`, err);
      mainWindow.webContents.send('agent:send-input-error', {
        agentId,
        error: err.message,
      });
    });
    return { ok: true, queued: true };
  });
  ipcMain.handle('agent:check-agent-md', (_e, workingDirectory, pathType) => checkAgentMdExists(workingDirectory, pathType));
  ipcMain.handle('agent:workspace-heat', () => getWorkspaceAgentSummary());
  ipcMain.handle('agent:get-supervisor', (_e, workspaceId) => supervisor.getSupervisorAgent(workspaceId));
  ipcMain.handle('agent:get-context-stats', (_e, agentId) => supervisor.getContextStats(agentId));

  // Chat pane (session-log-reader)
  ipcMain.handle('agent:get-chat-events', (_e, agentId, sinceUuid) => {
    // BUG-28: the HTTP `/messages` route lazy-recovers a lost Codex
    // resumeSessionId, but the dashboard chat pane renders via this IPC path
    // instead. Mirror the recovery here (and on chat-subscribe) so a codex
    // agent whose post-launch discovery race lost still gets its rollout
    // reader bound — otherwise the pane stays blank even though the rollout
    // JSONL on disk has every assistant turn. No-op for non-codex agents and
    // codex agents that already have a sid.
    supervisor.maybeRecoverCodexSid(agentId);
    return supervisor.getSessionLogReader().getCachedEvents(agentId, sinceUuid);
  });
  ipcMain.handle('agent:chat-subscribe', (_e, agentId) => {
    supervisor.maybeRecoverCodexSid(agentId); // BUG-28: see get-chat-events
    supervisor.getSessionLogReader().addChatSubscriber(agentId);
  });
  ipcMain.handle('agent:chat-unsubscribe', (_e, agentId) => {
    supervisor.getSessionLogReader().removeChatSubscriber(agentId);
  });
  ipcMain.handle('agent:chat-tool-result-full', (_e, agentId, toolUseId) =>
    supervisor.getSessionLogReader().getFullToolResult(agentId, toolUseId));
  ipcMain.handle('agent:update-supervised', (_e, id, supervised) => {
    updateAgentSupervised(id, supervised);
    return getAgent(id);
  });

  // Team handlers
  ipcMain.handle('team:create', (_e, input) => {
    const team = createTeam(input);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
    return team;
  });
  ipcMain.handle('team:get', (_e, teamId) => getTeam(teamId));
  ipcMain.handle('team:list', (_e, workspaceId) => listTeams(workspaceId));
  ipcMain.handle('team:disband', (_e, teamId) => {
    updateTeamStatus(teamId, 'disbanded');
    const team = getTeam(teamId);
    if (team && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
  });
  ipcMain.handle('team:add-member', (_e, teamId, agentId, role) => {
    addTeamMember(teamId, agentId, role || 'member');
    const team = getTeam(teamId);
    if (team && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
  });
  ipcMain.handle('team:remove-member', (_e, teamId, agentId) => {
    removeTeamMember(teamId, agentId);
    const team = getTeam(teamId);
    if (team && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
  });
  ipcMain.handle('team:add-channel', (_e, teamId, fromAgent, toAgent, label) => {
    const channel = createChannel(teamId, fromAgent, toAgent, label);
    const team = getTeam(teamId);
    if (team && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
    return channel;
  });
  ipcMain.handle('team:remove-channel', (_e, teamId, channelId) => {
    removeChannel(channelId);
    const team = getTeam(teamId);
    if (team && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
  });
  ipcMain.handle('team:get-messages', (_e, teamId, agentId) => getTeamMessages(teamId, agentId));
  ipcMain.handle('team:get-tasks', (_e, teamId) => getTeamTasks(teamId));
  ipcMain.handle('team:create-task', (_e, teamId, task) => createTeamTask({ teamId, ...task }));
  ipcMain.handle('team:update-task', (_e, teamId, taskId, updates) => updateTeamTask(taskId, updates));
  ipcMain.handle('team:resurrect', (_e, teamId) => {
    updateTeamStatus(teamId, 'active');
    const team = getTeam(teamId);
    if (team && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
    return team;
  });

  // Persona handlers
  ipcMain.handle('persona:list', (_e, workspacePath, pathType) => scanPersonas(workspacePath, pathType));
  ipcMain.handle('persona:create', (_e, workspacePath, pathType, name, customClaudeMd?) => scaffoldPersona(workspacePath, pathType, name, customClaudeMd));

  // Template handlers
  ipcMain.handle('template:list', (_e, workspaceId) => listAgentTemplates(workspaceId));
  ipcMain.handle('template:create', (_e, data) => createAgentTemplate(data));
  ipcMain.handle('template:update', (_e, id, updates) => updateAgentTemplate(id, updates));
  ipcMain.handle('template:delete', (_e, id) => deleteAgentTemplate(id));

  // Terminal handlers - track attached agents and their data listeners
  // Map<agentId, listenerFunction>
  const activeListeners = new Map<string, (data: string) => void>();
  const attachedAgents = new Set<string>(); // Keep for backward compatibility/quick checks

  ipcMain.handle('terminal:attach', (_e, agentId) => {
    if (activeListeners.has(agentId)) return { ok: true }; // already attached

    try {
      const bridge = supervisor.attachAgent(agentId);

      const listener = (data: string) => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal:data', agentId, data);
        }
      };

      bridge.onData(listener);
      activeListeners.set(agentId, listener);
      attachedAgents.add(agentId);
      return { ok: true };
    } catch (err: any) {
      console.error('Failed to attach:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('terminal:detach', (_e, agentId) => {
    const listener = activeListeners.get(agentId);
    if (listener) {
      supervisor.removeAgentListener(agentId, listener);
      activeListeners.delete(agentId);
    }
    
    // Original detach logic (wsl runner detach)
    supervisor.detachAgent(agentId);
    attachedAgents.delete(agentId);
  });

  ipcMain.handle('terminal:write', (_e, agentId, data) => {
    supervisor.writeToAgent(agentId, data);
  });

  ipcMain.handle('terminal:resize', (_e, agentId, cols, rows) => {
    supervisor.resizeAgent(agentId, cols, rows);
  });

  // System handlers
  ipcMain.handle('system:pick-directory', async (_e, startInWsl?: boolean) => {
    // Don't parent to mainWindow — on multi-monitor setups the dialog
    // can appear on the wrong screen. Let the OS place it centrally.
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
    };
    // When WSL mode is selected, start the dialog in \\wsl.localhost\
    if (startInWsl) {
      opts.defaultPath = '\\\\wsl.localhost\\';
    }
    const result = await dialog.showOpenDialog(opts);
    if (result.canceled) return null;
    return result.filePaths[0] || null;
  });

  ipcMain.handle('system:health-check', async () => {
    const wslStatus = await getPassiveWslStatus();
    let claudeWindowsAvailable = false;
    try {
      const env = { ...process.env };
      delete env.CLAUDECODE;
      execFileSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000, env });
      claudeWindowsAvailable = true;
    } catch {
      // not available
    }

    const wslAvailable = wslStatus.state === 'running';
    const [tmuxAvailable, claudeWslAvailable] = wslAvailable
      ? await Promise.all([
        isTmuxAvailable(),
        isClaudeAvailableInWsl(),
      ])
      : [false, false];

    return { wslAvailable, tmuxAvailable, claudeWindowsAvailable, claudeWslAvailable, wslStatus };
  });

  // Notebook (Jupyter) handlers
  ipcMain.handle('notebook:ensure-server', async () => {
    const info = await ensureJupyterServer();
    return info;
  });
  ipcMain.handle('notebook:list-kernelspecs', async () => {
    return await listKernelspecs();
  });

  // File viewer handlers
  ipcMain.handle('files:read', async (_e, filePath, pathType) => {
    return await readFileContents(filePath, pathType || detectPathType(filePath));
  });

  ipcMain.handle('files:list-directory', async (_e, dirPath, pathType) => {
    try {
      return await listDirectoryEntriesAsync(dirPath, pathType || detectPathType(dirPath));
    } catch (err: any) {
      console.error('files:list-directory error:', err.message || err);
      return [];
    }
  });

  ipcMain.handle('files:write', async (_e, filePath, rootDirectory, pathType, content) => {
    const resolved = resolveMutationPathType(filePath, rootDirectory, pathType);
    return await writeFileContents(filePath, rootDirectory, resolved, content);
  });

  ipcMain.handle('files:create-file', async (_e, parentDir, rootDirectory, pathType, name, template) => {
    const resolved = resolveMutationPathType(parentDir, rootDirectory, pathType);
    return await createFile(parentDir, rootDirectory, resolved, name, template);
  });

  ipcMain.handle('files:mkdir', async (_e, parentDir, rootDirectory, pathType, name) => {
    const resolved = resolveMutationPathType(parentDir, rootDirectory, pathType);
    return await createDirectory(parentDir, rootDirectory, resolved, name);
  });

  ipcMain.handle('files:rename', async (_e, oldPath, rootDirectory, pathType, newName) => {
    const resolved = resolveMutationPathType(oldPath, rootDirectory, pathType);
    return await renameEntry(oldPath, rootDirectory, resolved, newName);
  });

  ipcMain.handle('files:move', async (_e, srcPath, rootDirectory, pathType, destDir) => {
    const resolved = resolveMutationPathType(srcPath, rootDirectory, pathType);
    return await moveEntry(srcPath, rootDirectory, resolved, destDir);
  });

  ipcMain.handle('files:copy', async (_e, sourcePaths, rootDirectory, pathType, destDir) => {
    // Sources are OS-native paths from Explorer drops; the destination
    // decides the path type, not the sources.
    const resolved = resolveMutationPathType(destDir, rootDirectory, pathType);
    return await copyFiles(sourcePaths, rootDirectory, resolved, destDir);
  });

  ipcMain.handle('files:delete', async (_e, entryPath, rootDirectory, pathType, recursive) => {
    const resolved = resolveMutationPathType(entryPath, rootDirectory, pathType);
    return await deleteEntry(entryPath, rootDirectory, resolved, !!recursive);
  });

  ipcMain.handle('files:reveal', async (_e, entryPath: string, pathType?: PathType) => {
    // Resolve a Windows-native path: windows paths pass through, WSL paths
    // become \\wsl$\... / \\wsl.localhost\... UNC paths Explorer can open.
    let winPath: string;
    try {
      winPath = ensureWindowsPath(entryPath, pathType || detectPathType(entryPath));
    } catch (err: any) {
      return { ok: false, error: `Could not resolve a Windows path for "${entryPath}": ${err.message || err}` };
    }
    // Stat decides file vs. folder and catches stale tree entries before
    // handing Explorer a dead path.
    let isDirectory: boolean;
    try {
      isDirectory = (await fs.promises.stat(winPath)).isDirectory();
    } catch {
      return { ok: false, error: `Path no longer exists: ${winPath}` };
    }
    if (isDirectory) {
      // Open the folder itself so the user can drag items in or out of it.
      const error = await shell.openPath(winPath);
      if (error) return { ok: false, error };
    } else {
      // Opens Explorer with the file selected.
      shell.showItemInFolder(winPath);
    }
    return { ok: true };
  });

  // Live file watcher — one entry per subscription id, keyed across renderers.
  // Events are batched per-id with a short debounce so a 1000-file change produces
  // a handful of IPC messages instead of a thousand.
  const activeFileWatches = new Map<string, () => void>();
  const FS_EVENT_BATCH_MS = 50;
  const pendingFsEvents = new Map<string, FsEvent[]>();
  let flushTimer: NodeJS.Timeout | null = null;
  const flushFsEvents = () => {
    flushTimer = null;
    if (mainWindow.isDestroyed()) {
      pendingFsEvents.clear();
      return;
    }
    for (const [id, events] of pendingFsEvents) {
      if (events.length > 0) mainWindow.webContents.send('files:watch-event', { id, events });
    }
    pendingFsEvents.clear();
  };
  ipcMain.handle('files:watch-start', (_e, id: string, dirPath: string, pathType) => {
    if (activeFileWatches.has(id)) return;
    const resolved = pathType || detectPathType(dirPath);
    const unsub = subscribeFsWatch(dirPath, resolved, (event) => {
      if (mainWindow.isDestroyed()) return;
      let queue = pendingFsEvents.get(id);
      if (!queue) {
        queue = [];
        pendingFsEvents.set(id, queue);
      }
      queue.push(event);
      if (flushTimer === null) flushTimer = setTimeout(flushFsEvents, FS_EVENT_BATCH_MS);
    });
    activeFileWatches.set(id, unsub);
  });
  ipcMain.handle('files:watch-stop', (_e, id: string) => {
    const unsub = activeFileWatches.get(id);
    if (unsub) { unsub(); activeFileWatches.delete(id); }
    pendingFsEvents.delete(id);
  });
  mainWindow.on('closed', () => {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    pendingFsEvents.clear();
    for (const unsub of activeFileWatches.values()) {
      try { unsub(); } catch { /* ignore */ }
    }
    activeFileWatches.clear();
  });

  // File open handler
  ipcMain.handle('system:open-file', (_e, filePath, pathType) => {
    openFileInVSCode(filePath, pathType || detectPathType(filePath));
  });

  ipcMain.handle('system:open-file-in-workspace', (_e, filePath, workspaceDir, pathType) => {
    openFileInWorkspace(filePath, workspaceDir, pathType || detectPathType(filePath));
  });

  // Keep native window chrome (title bar / menu bar) in sync with the
  // renderer theme toggle, and persist so the next launch matches pre-paint.
  ipcMain.handle('system:set-theme', (_e, theme: 'dark' | 'light') => {
    if (theme !== 'dark' && theme !== 'light') return;
    nativeTheme.themeSource = theme;
    persistTheme(theme);
    // Recolor the window-controls overlay (min/max/close) so the buttons
    // stay visible against the new chrome color.
    if (process.platform === 'win32' && !mainWindow.isDestroyed()) {
      mainWindow.setTitleBarOverlay({
        color: theme === 'light' ? '#f7f5f0' : '#1e1e1e',
        symbolColor: theme === 'light' ? '#1e1e1e' : '#f7f5f0',
      });
    }
  });

  // Forward supervisor status changes to renderer
  supervisor.on('statusChanged', (data) => {
    if (!mainWindow.isDestroyed()) {
      const agent = getAgent(data.agentId);
      mainWindow.webContents.send('agent:status-changed', { ...data, agent });
    }
  });

  // Forward file activity events to renderer
  supervisor.on('fileActivity', (activity) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:file-activity', activity);
    }
  });

  // Forward context stats changes to renderer
  supervisor.on('contextStatsChanged', (stats) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:context-stats-changed', stats);
    }
  });

  // Forward chat event batches to renderer
  supervisor.on('chatEvents', (batch) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:chat-events', batch);
    }
  });

  // Forward team updates to renderer
  supervisor.on('teamUpdated', (team) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:updated', team);
    }
  });

  supervisor.on('teamMessageCreated', (message) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('team:message-created', message);
    }
  });

  // Forward "open this file in the user's file view" requests
  // (open_file_in_view MCP tool → POST /api/files/open-tab → here) to the
  // renderer, which resolves defaults and calls the store's openTab().
  supervisor.on('openFileInView', (payload) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('file:open-tab', payload);
    }
  });
}
