import { ipcMain, dialog, shell, BrowserWindow, nativeTheme, app } from 'electron';
import type { WebContents } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { persistTheme } from './theme-persistence';
import type { PathType, WslStatus, FsEvent, DetachRequest, DetachResult, ViewDetachRequest, ScanOverheadRequest, ScanOverheadResult, ExtractKnowledgeRequest, ExtractKnowledgeResult, SkillUsageQuery, SkillUsageQueryResult, McpToolUsageQuery, McpToolUsageQueryResult, PriorSessionChat, ContextOptimizerQuery, ContextOptimizerQueryResult, MarkOptimizerActionAppliedRequest, MarkOptimizerActionAppliedResult, SignOptimizerDerivationRequest, SignOptimizerDerivationResult } from '../shared/types';
import { TAB_CHANNELS, VIEW_CHANNELS } from '../shared/types';
import { createDetachedWindow, createDetachedViewWindow, broadcastToDetachedViews, canWrite, handleDetachedCloseReply, type DetachedWindowDeps } from './detached-windows';
import { handleFlushReply } from './close-flush';
import type { FlushReplyPayload } from '../shared/types';
import { AgentSupervisor } from './supervisor';
import { resolveAgentChatEvents } from './supervisor/agent-chat-history';
import {
  getWorkspaces, createWorkspace, deleteWorkspace, getWorkspace, reorderWorkspaces,
  getAgentsByWorkspace, getAllAgents, getAgent, getFileActivities, getWorkspaceAgentSummary,
  checkAgentMdExists, updateAgentSupervised, getAgentSessions,
  createTeam, getTeam, listTeams, updateTeamStatus, addTeamMember, removeTeamMember,
  createChannel, removeChannel, getTeamMessages, getTeamTasks, createTeamTask, updateTeamTask,
  listAgentTemplates, createAgentTemplate, updateAgentTemplate, deleteAgentTemplate,
  createSelectionComment, getSelectionComment, listSelectionComments, updateSelectionComment,
  deleteSelectionComment, resolveSelectionComment,
  markSelectionCommentsQueued, markSelectionCommentsSent, markSelectionCommentsSendFailed,
} from './database';
import { sendSelectionComments } from './selection-comments-send';
import { assertPlanRailFree } from './orchestration/plan-ownership';
import { getApiToken } from './security/api-auth';
import { openInVSCode, openFileInVSCode, openFileInWorkspace } from './vscode-launcher';
import { getPassiveWslStatus, isTmuxAvailable, isClaudeAvailableInWsl } from './wsl-bridge';
import { execFileSync } from 'child_process';
import { detectPathType, ensureWindowsPath, toAgentPath } from './path-utils';
import { saveImage, pruneImages } from './pasted-image-store';
import { readFileContents, listDirectoryEntriesAsync } from './file-reader';
import { writeFileContents, createFile, createDirectory, renameEntry, moveEntry, copyFiles, deleteEntry } from './file-writer';
import { createMarkdownFromDocx } from './docx-converter';
import { subscribe as subscribeFsWatch } from './fs-watcher';
import { scanPersonas, scaffoldPersona, setPersonaLane } from './persona-scanner';
import { ensureJupyterServer, listKernelspecs } from './jupyter-server';
import { runOverheadScan } from './context-overhead/ipc-deps';
import { runKnowledgeExtract } from './agent-knowledge/knowledge-extract-runner';
import {
  runOptimizerAnalyze,
  markOptimizerActionApplied,
  signOptimizerDerivation,
  type OptimizerWriterDb,
} from './context-optimizer/optimizer-surface';
import { buildAssembleContext, assembleAllLaneInputs } from './context-optimizer/optimizer-assemble';
import { makeProductionBirthdayResolver } from './context-optimizer/optimizer-production';
import type { PipelineDb } from './context-optimizer/optimizer-pipeline';
import { getSharedParseManager, setParseManagerProgressSink } from './skill-analytics/parse-manager-factory';
import { querySkillUsage, type QueryDb } from './skill-analytics/queries';
import { queryMcpToolUsage } from './skill-analytics/mcp-tool-usage-queries';
import { getDb } from './database';

// Managed temp dir for clipboard-bitmap pastes. Dropped OS files inject their
// OWN on-disk path (converted) and never land here — only screenshots do.
const PASTED_IMAGE_DIR = path.join(app.getPath('temp'), 'lares-pasted-images');

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
  ipcMain.handle('agent:launch', (_e, input) => {
    // GT-C §O.2 — the renderer "Launch Agent" IPC path must apply the SAME
    // one-writer-per-plan guard as `POST /api/agents` so the two dispatch routes
    // cannot drift. Normalizes both the camelCase and snake_case plan bindings.
    const planId = input?.planId ?? input?.plan_id;
    if (typeof planId === 'string' && planId !== '') assertPlanRailFree(planId);
    return supervisor.launchAgent(input);
  });
  // 'agent:stop' is registered by registerLifecycleIpc (lifecycle/lifecycle-ipc.ts)
  // so that every stop endpoint assigns its own reason in ONE place and a
  // renderer can never supply one (§B9).
  ipcMain.handle('agent:restart', (_e, id) => supervisor.restartAgent(id));
  ipcMain.handle('agent:get-log', (_e, id, lines) => supervisor.getAgentLog(id, lines));
  ipcMain.handle('agent:get-ring-buffer', (_e, id) => supervisor.getAgentRingBuffer(id));
  ipcMain.handle('agent:get', (_e, id) => getAgent(id));
  ipcMain.handle('agent:get-file-activities', (_e, agentId, operation, currentOnly) => getFileActivities(agentId, operation, currentOnly));
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

  // Account-wide Claude subscription usage limits (singleton, not per-agent).
  ipcMain.handle('usage:get-limits', () => supervisor.getUsageLimits());

  // ── D4 startup orphan sweep (incident-2026-07-11 §5) ──
  // `list` enumerates leftover CLI process trees from prior app epochs (+ current
  // terminal rows) without killing anything; `reap` bulk-terminates the selected
  // ones (each re-verified before any kill; unverifiable owners left in place).
  // Renderer UI is a follow-on — these are the main-process contract.
  ipcMain.handle('ownership:list-orphans', () => supervisor.listOrphanCandidates());
  ipcMain.handle('ownership:reap-orphans', (_e, agentIds: string[]) => supervisor.reapOrphans(agentIds ?? []));

  // ── A6 (wp2b §5) — skill-analytics indexing contract ──
  // Lazily constructed on first query so the corpus walk / cursor reads happen only
  // when a panel actually asks. `index-status` is the contract entrypoint: it kicks the
  // first-run cooperative backfill (returns {indexing, progress} immediately) and, once
  // complete, tail-parses within the steady-state budget. Progress is ALSO pushed to the
  // renderer via `skill-analytics:index-progress` for panels mounted mid-backfill.
  // Shared with the MCP/HTTP read route (api-server) so a fresh-install backfill is
  // never kicked twice. The renderer progress-push sink is layered on here, where
  // `mainWindow` lives.
  setParseManagerProgressSink((p) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('skill-analytics:index-progress', p);
  });
  const getParseManager = getSharedParseManager;
  ipcMain.handle('skill-analytics:index-status', () => getParseManager().ensureIndexed());
  ipcMain.handle('skill-analytics:index-poll', () => getParseManager().status());

  // WP3 (§P2.2) — read-only Skill Usage Analytics query. Parse-first (§P2.1):
  // `ensureIndexed()` kicks the first-run backfill (non-blocking) or tail-parses
  // within budget in steady state, THEN we run pure SQL over the freshest rows.
  // During an in-progress backfill this returns partial data (honest, not an
  // error) — the panel also renders indexing progress off the index contract.
  ipcMain.handle('skill-analytics:query', (_e, req: SkillUsageQuery): SkillUsageQueryResult => {
    try {
      getParseManager().ensureIndexed();
      const data = querySkillUsage(getDb() as unknown as QueryDb, req ?? {});
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // wave2-mcp-tool-observability §2.2 — per-MCP-tool usage query. Same parse-first
  // contract as skill-analytics:query (ensureIndexed → pure SQL over the freshest
  // rows). Separate handler + DTO so the MCP tab lazy-loads without dragging the
  // skill-effectiveness engine, and the agent-facing read tool can reuse the engine.
  ipcMain.handle('mcp-tool-usage:query', (_e, req: McpToolUsageQuery): McpToolUsageQueryResult => {
    try {
      getParseManager().ensureIndexed();
      const data = queryMcpToolUsage(getDb() as unknown as QueryDb, req ?? {});
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

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
    // A `done`/`crashed` agent's ring has been released (`forgetAgent`) and can
    // never be refilled — `resolveAgentChatEvents` re-reads its history from the
    // provider's session log on disk instead, and reports `source` so the pane
    // can distinguish "frozen history" from "provider has no disk reader".
    const reader = supervisor.getSessionLogReader();
    return resolveAgentChatEvents(
      {
        getAgent,
        getCachedEvents: (id, since) => reader.getCachedEvents(id, since),
        pollNow: (id) => reader.pollNow(id),
        readPriorSessionEvents: (p, wd, sid) => reader.readPriorSessionEvents(p, wd, sid),
      },
      agentId,
      { sinceUuid },
    );
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

  // Context-brick Phase 2 — durable, read-only prior-session chat.
  // `get-agent-sessions` returns the cheap DB lineage (no JSONL read) so the
  // pane knows whether a prior session exists and which lineage row id to walk
  // back to next. `get-prior-session-chat` reads exactly ONE session's `.jsonl`
  // from disk on demand and NEVER throws: a pruned/missing file degrades to
  // `unavailable`, and a row id with no earlier session degrades to `atHead`.
  ipcMain.handle('agent:get-agent-sessions', (_e, agentId) => getAgentSessions(agentId));
  ipcMain.handle('agent:get-prior-session-chat', (_e, agentId, sessionRowId): PriorSessionChat => {
    // Look up the requested lineage row (Phase 1). Keyed on dashboard_agent_id,
    // so a shared-cwd sibling's session can never be returned for this agent.
    const row = getAgentSessions(agentId).find((r) => r.id === sessionRowId);
    if (!row) return { atHead: true };
    const events = supervisor
      .getSessionLogReader()
      .readPriorSessionEvents(row.provider, row.workingDirectory, row.sessionId);
    if (events === null) {
      // JSONL pruned/missing — degrade, never throw.
      return { sessionRowId: row.id, sessionId: row.sessionId, unavailable: true };
    }
    return {
      sessionRowId: row.id,
      sessionId: row.sessionId,
      generation: row.generation,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      outOfContext: true,
      events,
    };
  });
  ipcMain.handle('agent:update-supervised', (_e, id, supervised) => {
    updateAgentSupervised(id, supervised);
    return getAgent(id);
  });

  // Per-agent continuation control (Edward 2026-07-05). Both back the pinned
  // preload contract; the supervisor methods own the persist / force logic.
  ipcMain.handle('agent:set-continuation-enabled', (_e, id, enabled) =>
    supervisor.setContinuationEnabled(id, enabled));
  ipcMain.handle('agent:force-continuation-handoff', (_e, id) =>
    supervisor.forceContinuationHandoff(id));
  // Slice 2 — hydration read for the live handoff phases (the broadcast is
  // registered with the other supervisor forwards below, on the `emit` helper
  // so detached dashboard windows get it too).
  ipcMain.handle('agent:list-continuation-phases', () => supervisor.listContinuationPhases());

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
  ipcMain.handle('persona:setLane', (_e, workspacePath, pathType, name, lane) => setPersonaLane(workspacePath, pathType, name, lane));

  // Template handlers
  ipcMain.handle('template:list', (_e, workspaceId) => listAgentTemplates(workspaceId));
  ipcMain.handle('template:create', (_e, data) => createAgentTemplate(data));
  ipcMain.handle('template:update', (_e, id, updates) => updateAgentTemplate(id, updates));
  ipcMain.handle('template:delete', (_e, id) => deleteAgentTemplate(id));

  // Terminal handlers - track attached agents and their data listeners
  // Map<agentId, listenerFunction>
  const activeListeners = new Map<string, (data: string) => void>();
  const attachedAgents = new Set<string>(); // Keep for backward compatibility/quick checks

  // BUG-38 — terminal attachment service. A same-id PTY swap (continuation,
  // manual restart, auto-restart) kills the old runner and spawns a new one
  // under the same dashboard agent id, but nothing tears down the live attach:
  // TerminalPanel keeps its cached xterm bound to the retired (dead) bridge and
  // takes no new output until a full app restart. The supervisor fires the swap
  // but must NOT reach into these listener maps (that would require importing
  // the supervisor into this module or exporting the maps — either creates a
  // cycle). Instead we inject this callback; the supervisor calls it by handle.
  //
  // rebound() mirrors terminal:detach's listener teardown, then clears the
  // attach short-circuit state (so the renderer's re-invoked terminal:attach is
  // NOT no-op'd) and tells the renderer to rebuild onto the fresh PTY. The map
  // deletes are idempotent, so a double-notify is safe.
  const terminalAttach = {
    rebound(agentId: string): void {
      const listener = activeListeners.get(agentId);
      if (listener) {
        // The old runner is already gone; removeAgentListener targets the new
        // runner (a no-op there) — harmless, and mirrors terminal:detach.
        supervisor.removeAgentListener(agentId, listener);
        activeListeners.delete(agentId);
      }
      attachedAgents.delete(agentId);
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:rebound', agentId);
      }
    },
  };
  supervisor.setTerminalReboundNotifier(terminalAttach.rebound);

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
    // Only probe WSL if the user actually has a wsl-typed workspace. On a
    // Windows-only machine `wsl.exe` can trigger Windows' "install WSL" flow,
    // and this handler fires on startup and on every workspace select / Sidebar
    // / DirectoryTree mount — so an unconditional probe means repeated popups.
    const hasWslWorkspace = getWorkspaces().some((w) => w.pathType === 'wsl');
    const wslStatus: WslStatus = hasWslWorkspace
      ? await getPassiveWslStatus()
      : { state: 'unavailable', distros: [] };
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

  // Detachable top-level views — spawn a trusted window that renders one view
  // (Dashboard, …) full-screen. Reuses the same trust deps as the file factory.
  ipcMain.handle(VIEW_CHANNELS.detach, (_e, req: ViewDetachRequest): DetachResult =>
    createDetachedViewWindow(req, detachedWindowDeps));

  // Phase 2 dirty-on-close: the detached renderer replies here with the user's
  // decision after a close-query. 'save' arrives only after the renderer has
  // persisted the buffer; main just closes (or keeps open on 'cancel').
  ipcMain.handle(
    TAB_CHANNELS.closeReply,
    (_e, requestId: string, decision: 'save' | 'discard' | 'cancel') =>
      handleDetachedCloseReply(requestId, decision),
  );

  // Edit-loss §4.3 close-flush handshake: a renderer answered a flush request
  // (main-window/app close) with its per-tab outcomes.
  ipcMain.handle(TAB_CHANNELS.flushReply, (_e, payload: FlushReplyPayload) =>
    handleFlushReply(payload));

  // Context-Overhead Analyzer — trusted main-process scan (plan §2.5). Always
  // returns the ScanOverheadResult discriminated union (R1).
  ipcMain.handle('context-overhead:scan', async (_e, req: ScanOverheadRequest): Promise<ScanOverheadResult> => {
    try {
      const model = runOverheadScan(req.workspaceId);
      return { ok: true, model };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // "What This Agent Knows" — deterministic knowledge extraction (P3.2 / WP4).
  // Additive sibling of the overhead scan; same discriminated-result contract.
  ipcMain.handle('agent-knowledge:extract', async (_e, req: ExtractKnowledgeRequest): Promise<ExtractKnowledgeResult> => {
    try {
      const graph = runKnowledgeExtract(req.workspaceId, req.agentId);
      return { ok: true, graph };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // ── Context Optimizer (WP6) — behavior-grounded proposal surface. ──
  // Read-only analyze; production supplies no per-lane inputs yet (acceptance leg),
  // so this returns the engine's honest EMPTY result rather than a blank panel.
  ipcMain.handle('context-optimizer:analyze', async (_e, req: ContextOptimizerQuery): Promise<ContextOptimizerQueryResult> => {
    try {
      // Resolve the workspace to analyze: explicit `workspaceId`, else the agent's own
      // workspace, else none (→ honest EMPTY result, unchanged from the pre-wiring path).
      const workspaceId = req.workspaceId ?? (req.agentId ? getAgent(req.agentId)?.workspaceId : undefined);
      const base = { generatedAtIso: new Date().toISOString(), nowMs: Date.now(), query: req };
      if (!workspaceId) {
        return { ok: true, data: runOptimizerAnalyze(base) };
      }
      // Live pipeline: assemble one RawLaneInputs per real persona lane over the
      // workspace scaffold + DB spine, and date brand-new sections via the git-backed
      // birthday resolver (backfill→classify ordering enforced inside runOptimizerPipeline).
      const db = getDb() as unknown as PipelineDb;
      const ctx = buildAssembleContext({ workspaceId, db });
      const nodePath = require('node:path') as typeof import('node:path');
      const repoDir = nodePath.resolve(__dirname, '..', '..', '..');
      const data = runOptimizerAnalyze({
        ...base,
        lanes: assembleAllLaneInputs(ctx),
        db,
        backfillTargets: ctx.residentTargets,
        birthdayResolver: makeProductionBirthdayResolver(repoDir),
      });
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // "Mark applied" — records a human-intent row in optimizer_actions. NEVER edits a
  // config file (the human owns the actual edit); guarded by an explicit confirm in
  // the renderer. Stamps §4.6 `unverified_at_apply` when the proposal was unverified.
  ipcMain.handle('context-optimizer:mark-applied', async (_e, req: MarkOptimizerActionAppliedRequest): Promise<MarkOptimizerActionAppliedResult> => {
    try {
      const out = markOptimizerActionApplied(getDb() as unknown as OptimizerWriterDb, req, Date.now());
      return { ok: true, ...out };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // G2 sign-off (classifier addendum §5.4) — UI/IPC-only. Inserts a `verified`
  // derivation row when Edward clicks; no MCP path, no auto-sign.
  ipcMain.handle('context-optimizer:sign-derivation', async (_e, req: SignOptimizerDerivationRequest): Promise<SignOptimizerDerivationResult> => {
    try {
      const out = signOptimizerDerivation(getDb() as unknown as OptimizerWriterDb, req, Date.now());
      return { ok: true, ...out };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // File viewer handlers
  ipcMain.handle('files:read', async (_e, filePath, pathType) => {
    return await readFileContents(filePath, pathType || detectPathType(filePath));
  });

  ipcMain.handle('files:convert-docx-to-markdown', async (_e, filePath, rootDirectory, pathType) => {
    const resolved = resolveMutationPathType(filePath, rootDirectory, pathType);
    return await createMarkdownFromDocx(filePath, rootDirectory, resolved);
  });

  ipcMain.handle('files:list-directory', async (_e, dirPath, pathType) => {
    try {
      return await listDirectoryEntriesAsync(dirPath, pathType || detectPathType(dirPath));
    } catch (err: any) {
      console.error('files:list-directory error:', err.message || err);
      return [];
    }
  });

  ipcMain.handle('files:write', async (event, filePath, rootDirectory, pathType, content, expectedHash) => {
    // Single-writer enforcement (detachable-file-tabs-plan §1 Claim 2): if the
    // file is owned by a detached window, only that webContents may write it.
    // The authoritative backstop behind the best-effort focus-existing UX.
    if (!canWrite(filePath, event.sender.id)) {
      return { ok: false, error: 'File is open in a detached window; edit it there.' };
    }
    const resolved = resolveMutationPathType(filePath, rootDirectory, pathType);
    return await writeFileContents(filePath, rootDirectory, resolved, content, expectedHash);
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

  // ── Pasted / dropped image support ──
  // Startup prune (fire-and-forget): drop any temp images left over past the
  // age / count / byte caps from prior app runs.
  pruneImages(PASTED_IMAGE_DIR, Date.now()).catch(() => {});

  // Clipboard bitmap (screenshot) → managed temp file → agent-space path. No
  // file exists on disk for a screenshot, so we persist the bytes and convert
  // the written native path into the agent's path space (Windows or WSL).
  ipcMain.handle('files:write-image-temp',
    async (_e, bytes: Uint8Array, mime: string, workingDirectory: string) => {
      const saved = await saveImage(PASTED_IMAGE_DIR, bytes, mime, Date.now());
      if (!saved.ok) return saved;
      return toAgentPath(saved.path, workingDirectory); // {ok,path} | {ok:false,error}
    });

  // Dropped OS image FILES → agent-space paths. Batch, per-path result so one
  // bad entry doesn't kill the rest. Injects each file's OWN on-disk path
  // (converted); does NOT copy into the temp dir.
  ipcMain.handle('files:resolve-image-drops',
    async (_e, nativePaths: string[], workingDirectory: string) => {
      const results = await Promise.all((nativePaths || []).map(async (p) => {
        if (!/\.(png|jpe?g)$/i.test(p)) {
          return { ok: false, error: `Unsupported file (only .png/.jpg/.jpeg): ${p}` };
        }
        // stat().isFile() — access() succeeds on a DIRECTORY named picture.png,
        // which would then be injected as a bad path (addendum D).
        try {
          const st = await fs.promises.stat(p);
          if (!st.isFile()) return { ok: false, error: `Not a file: ${p}` };
        } catch {
          return { ok: false, error: `File not found: ${p}` };
        }
        return toAgentPath(p, workingDirectory);
      }));
      return results; // Array<{ok:true,path}|{ok:false,error}>
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
        // surface-base — match the renderer TopBar shade (see createWindow).
        color: theme === 'light' ? '#edeae3' : '#181818',
        symbolColor: theme === 'light' ? '#1e1e1e' : '#f7f5f0',
      });
    }
  });

  // Broadcast a main→renderer push to the shell AND every detached view window.
  // The shell's data feeds are otherwise main-window-only; a torn-off Dashboard
  // grid needs the same stream (status, deletions, context stats, heat) to stay
  // live. Only the dashboard-relevant feeds below use `emit`; per-window feeds
  // (chat, terminal, file:open-tab) stay mainWindow-only.
  const emit = (channel: string, ...args: unknown[]) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
    broadcastToDetachedViews(channel, ...args);
  };

  // Forward supervisor status changes to renderer
  supervisor.on('statusChanged', (data) => {
    const agent = getAgent(data.agentId);
    emit('agent:status-changed', { ...data, agent });
  });

  // Forward agent deletions so the cross-workspace status map (sidebar waiting
  // outline / heat) drops the entry. deleteAgent emits `agentDeleted`, NOT a
  // `statusChanged`, so without this a background-workspace agent that was
  // `waiting` at delete time would strand its red outline forever.
  supervisor.on('agentDeleted', ({ agentId }: { agentId: string }) => {
    emit('agent:deleted', { agentId });
  });

  // WP-P2 — async initial-prompt delivery failures surface through the same
  // renderer channel as chat-input send failures (see 'agent:send-input' above).
  supervisor.on('sendInputError', (payload) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent:send-input-error', payload);
    }
  });

  // Forward file activity events to renderer (+ detached views — drives the
  // grid's per-agent heat, which a torn-off Dashboard shows too).
  supervisor.on('fileActivity', (activity) => {
    emit('agent:file-activity', activity);
  });

  // Forward continuation handoff phases (+ detached views — a torn-off
  // Dashboard renders the same cards, and a handoff started in one window must
  // light the glow in both). Rides `emit` for exactly that reason.
  supervisor.on('continuationPhaseChanged', (signal: ContinuationPhaseSignal) => {
    emit('continuation:phase', signal);
  });

  // Forward context stats changes to renderer (+ detached views — the grid
  // cards render a per-agent context bar off this feed).
  supervisor.on('contextStatsChanged', (stats) => {
    emit('agent:context-stats-changed', stats);
  });

  // Forward account-wide usage-limits changes to renderer
  supervisor.on('usageLimitsChanged', (reading) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('usage:limits-changed', reading);
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
