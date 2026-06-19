import { ipcMain, dialog, shell, BrowserWindow, nativeTheme } from 'electron';
import type { WebContents } from 'electron';
import * as fs from 'fs';
import { persistTheme } from './theme-persistence';
import type { PathType, FsEvent, DetachRequest, DetachResult } from '../shared/types';
import { TAB_CHANNELS } from '../shared/types';
import { createDetachedWindow, canWrite, handleDetachedCloseReply, type DetachedWindowDeps } from './detached-windows';
import { AgentSupervisor } from './supervisor';
import {
  getWorkspaces, createWorkspace, deleteWorkspace, getWorkspace, reorderWorkspaces,
  getAgentsByWorkspace, getAllAgents, getAgent, getFileActivities, getWorkspaceAgentSummary,
  checkAgentMdExists, updateAgentSupervised,
  createTeam, getTeam, listTeams, updateTeamStatus, addTeamMember, removeTeamMember,
  createChannel, removeChannel, getTeamMessages, getTeamTasks, createTeamTask, updateTeamTask,
  listAgentTemplates, createAgentTemplate, updateAgentTemplate, deleteAgentTemplate,
  createSelectionComment, getSelectionComment, listSelectionComments, updateSelectionComment,
  deleteSelectionComment, resolveSelectionComment,
  markSelectionCommentsQueued, markSelectionCommentsSent, markSelectionCommentsSendFailed,
} from './database';
import { sendSelectionComments } from './selection-comments-send';
import { getApiToken } from './security/api-auth';
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

export function registerIpcHandlers(
  supervisor: AgentSupervisor,
  mainWindow: BrowserWindow,
  detachedWindowDeps: DetachedWindowDeps,
): void {
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

  // Selection comment handlers (WP-P5-A) — CRUD next to the DB; `comments:send`
  // runs the queued/sent/send_failed status machine in main (plan §1.8).
  ipcMain.handle('comments:create', (_e, input) => createSelectionComment(input));
  ipcMain.handle('comments:list', (_e, workspaceId, filePath) => listSelectionComments(workspaceId, filePath));
  ipcMain.handle('comments:update', (_e, id, updates) => updateSelectionComment(id, updates));
  ipcMain.handle('comments:delete', (_e, id) => deleteSelectionComment(id));
  ipcMain.handle('comments:resolve', (_e, id) => resolveSelectionComment(id));
  ipcMain.handle('comments:send', (_e, request) =>
    sendSelectionComments(
      {
        getComment: getSelectionComment,
        getAgent,
        isInputInFlight: (agentId) => supervisor.isInputInFlight(agentId),
        sendInput: (agentId, text) => supervisor.sendInput(agentId, text),
        launchAgent: (input) => supervisor.launchAgent(input),
        markQueued: markSelectionCommentsQueued,
        markSent: markSelectionCommentsSent,
        markSendFailed: markSelectionCommentsSendFailed,
        // Async delivery failures share the chat-input error surface (the
        // renderer chat input already renders these inline).
        onAsyncSendError: (payload) => {
          console.error(`[comments] Background send to ${payload.agentId} failed:`, payload.error);
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('agent:send-input-error', payload);
          }
        },
        onCommentsChanged: (commentIds) => {
          if (!mainWindow.isDestroyed()) {
            const comments = commentIds
              .map((id) => getSelectionComment(id))
              .filter((c): c is NonNullable<typeof c> => c !== null);
            mainWindow.webContents.send('comments:changed', { comments });
          }
        },
      },
      request,
    ));

  // Persona handlers
  ipcMain.handle('persona:list', (_e, workspacePath, pathType) => scanPersonas(workspacePath, pathType));
  ipcMain.handle('persona:create', (_e, workspacePath, pathType, name, roleDescription?, lane?) => scaffoldPersona(workspacePath, pathType, name, roleDescription, lane));

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

  // Detachable file tabs (detachable-file-tabs-plan §4 1.4) — spawn a trusted,
  // editable detached window that owns the dragged-out file.
  ipcMain.handle(TAB_CHANNELS.detach, (_e, req: DetachRequest): DetachResult =>
    createDetachedWindow(req, detachedWindowDeps));

  // Phase 2 dirty-on-close: the detached renderer replies here with the user's
  // decision after a close-query. 'save' arrives only after the renderer has
  // persisted the buffer; main just closes (or keeps open on 'cancel').
  ipcMain.handle(
    TAB_CHANNELS.closeReply,
    (_e, requestId: string, decision: 'save' | 'discard' | 'cancel') =>
      handleDetachedCloseReply(requestId, decision),
  );

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

  ipcMain.handle('files:write', async (event, filePath, rootDirectory, pathType, content) => {
    // Single-writer enforcement (detachable-file-tabs-plan §1 Claim 2): if the
    // file is owned by a detached window, only that webContents may write it.
    // The authoritative backstop behind the best-effort focus-existing UX.
    if (!canWrite(filePath, event.sender.id)) {
      return { ok: false, error: 'File is open in a detached window; edit it there.' };
    }
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
  //
  // Per-sender routing (detachable-file-tabs-plan §4 1.4 / Reviewer #3): each
  // entry remembers the subscribing webContents so a detached window receives
  // its OWN fs-watch updates (the old code flushed only to mainWindow, so a
  // detached renderer got none). A sender that is destroyed (window closed
  // without an explicit watch-stop) is unsubscribed and dropped.
  const activeFileWatches = new Map<string, { unsub: () => void; sender: WebContents }>();
  const FS_EVENT_BATCH_MS = 50;
  const pendingFsEvents = new Map<string, FsEvent[]>();
  let flushTimer: NodeJS.Timeout | null = null;
  const flushFsEvents = () => {
    flushTimer = null;
    for (const [id, events] of pendingFsEvents) {
      const entry = activeFileWatches.get(id);
      if (entry && !entry.sender.isDestroyed() && events.length > 0) {
        entry.sender.send('files:watch-event', { id, events });
      }
    }
    pendingFsEvents.clear();
  };
  const stopWatch = (id: string) => {
    const entry = activeFileWatches.get(id);
    if (entry) {
      try { entry.unsub(); } catch { /* ignore */ }
      activeFileWatches.delete(id);
    }
    pendingFsEvents.delete(id);
  };
  ipcMain.handle('files:watch-start', (event, id: string, dirPath: string, pathType) => {
    if (activeFileWatches.has(id)) return;
    const sender = event.sender;
    const resolved = pathType || detectPathType(dirPath);
    const unsub = subscribeFsWatch(dirPath, resolved, (fsEvent) => {
      if (sender.isDestroyed()) return;
      let queue = pendingFsEvents.get(id);
      if (!queue) {
        queue = [];
        pendingFsEvents.set(id, queue);
      }
      queue.push(fsEvent);
      if (flushTimer === null) flushTimer = setTimeout(flushFsEvents, FS_EVENT_BATCH_MS);
    });
    activeFileWatches.set(id, { unsub, sender });
    // Covers a detached-window close that never sends watch-stop. Guarded so it
    // won't double-unsub if watch-stop already replaced/removed this entry.
    sender.once('destroyed', () => {
      if (activeFileWatches.get(id)?.sender === sender) stopWatch(id);
    });
  });
  ipcMain.handle('files:watch-stop', (_e, id: string) => {
    stopWatch(id);
  });
  mainWindow.on('closed', () => {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    pendingFsEvents.clear();
    for (const { unsub } of activeFileWatches.values()) {
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

  // WP0.2 (M1): the renderer's direct HTTP calls to the dashboard API
  // (useNotebookActions.ts) need the per-launch bearer token. IPC is the
  // distribution channel — the token never appears in any URL or page markup.
  ipcMain.handle('system:get-api-token', () => getApiToken());

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

  // WP-P2 — async initial-prompt delivery failures surface through the same
  // renderer channel as chat-input send failures (see 'agent:send-input' above).
  supervisor.on('sendInputError', (payload) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:send-input-error', payload);
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
