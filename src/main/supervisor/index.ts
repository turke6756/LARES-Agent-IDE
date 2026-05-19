import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { execFileSync, execFile, spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { Agent, AgentStatus, ContextStats, LaunchAgentInput, QueryResult, Team } from '../../shared/types';
import {
  TMUX_SESSION_PREFIX, DEFAULT_COMMAND, DEFAULT_COMMAND_WSL, PROVIDER_COMMANDS,
  SUPERVISOR_AGENT_NAME, SUPERVISOR_AGENT_MD, SUPERVISOR_MEMORY_MD,
  SUPERVISOR_CLAUDE_SETTINGS_JSON, SUPERVISOR_RUN_ORCHESTRATION_SKILL, SUPERVISOR_ORCHESTRATION_SPIKE_SKILL,
  SCRIPT_READ_AGENT_LOG, SCRIPT_LIST_AGENTS, SCRIPT_SEND_MESSAGE, SCRIPT_GET_CONTEXT_STATS,
} from '../../shared/constants';
import { EventBridge, EventBridgeDeps } from './event-bridge';
import { TeamMessageDeliveryEngine } from './team-delivery';
import { WindowsRunner } from './windows-runner';
import { WslRunner } from './wsl-runner';
import { StatusMonitor } from './status-monitor';
import type { StatusChangedEvent } from './status-events';
import { ContextStatsMonitor, JsonlFileActivity } from './context-stats-monitor';
import { SessionLogReader } from './session-log-reader';
import { ClaudeJsonlReader } from './log-readers/claude-jsonl-reader';
import { CodexRolloutReader } from './log-readers/codex-rollout-reader';
import { GeminiTranscriptReader } from './log-readers/gemini-transcript-reader';
import { AgentChatService } from './agent-chat-service';
import {
  snapshotCodexSessions,
  discoverNewCodexSession,
  findCodexSessionIdByCwd,
  ensureCodexResumeSessionId,
  shouldDiscoverCodexSession,
} from './session-id-discovery';
import { FileActivityTracker } from './file-activity-tracker';
import {
  createAgent, getAgent, getActiveAgents, getAllAgents, getSupervisorAgent, getWorkspace, updateAgentStatus, updateAgentPid,
  updateAgentExitCode, incrementRestartCount, updateAgentLastOutput,
  updateAgentAttached, addEvent, deleteAgent as dbDeleteAgent,
  updateAgentResumeSessionId, addFileActivity, getTeamMembership, getAgentTemplate
} from '../database';
import { detectPathType, windowsToWslPath, uncToWslPath } from '../path-utils';
import { getScriptPath } from './paths';
import { tmuxListSessions, tmuxSendInput } from '../wsl-bridge';
import { getWindowsSubmitSequence } from './send-input-encoders';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const WINDOWS_SEND_INPUT_ENTER_DELAY_MS = 80;
const WINDOWS_CODEX_TYPING_DELAY_MS = 8;

// Win32 Input Mode CSI sequence for a VK_RETURN keypress (down + up).
// Codex/gemini on Windows enable mode ?9001h and expect submit as a real
// key event, not the auto-converted single KEY_DOWN ConPTY emits for raw '\r'.
// Format: ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _
const WIN32_KEY_ENTER_DOWN = '\x1b[13;28;13;1;0;1_';
const WIN32_KEY_ENTER_UP = '\x1b[13;28;13;0;0;1_';
// Shift+Enter — inserts a newline in codex's prompt without submitting.
// Cs=16 = SHIFT_PRESSED.
const WIN32_KEY_SHIFT_ENTER_DOWN = '\x1b[13;28;13;1;16;1_';
const WIN32_KEY_SHIFT_ENTER_UP = '\x1b[13;28;13;0;16;1_';

/** Recover the workspace root from an agent whose cwd is a persona subdirectory.
 *  Matches both legacy `.claude/agents/<name>` (still used by persona-scanner) and
 *  the new `.dashboard/supervisor` layout. */
function getEffectiveWorkspaceRoot(agent: Agent): string {
  const unixDashboardMatch = agent.workingDirectory.match(/^(.+)\/\.dashboard\/supervisor\/?$/);
  if (unixDashboardMatch) return unixDashboardMatch[1];
  const winDashboardMatch = agent.workingDirectory.match(/^(.+)\\\.dashboard\\supervisor\\?$/);
  if (winDashboardMatch) return winDashboardMatch[1];
  const unixMatch = agent.workingDirectory.match(/^(.+)\/\.claude\/agents\/[^/]+\/?$/);
  if (unixMatch) return unixMatch[1];
  const winMatch = agent.workingDirectory.match(/^(.+)\\\.claude\\agents\\[^\\]+\\?$/);
  if (winMatch) return winMatch[1];
  return agent.workingDirectory;
}

function formatBracketedPaste(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const body = normalized
    .replaceAll(BRACKETED_PASTE_START, '')
    .replaceAll(BRACKETED_PASTE_END, '');
  return `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizeCodexArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--full-auto') {
      out.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (arg === '--ask-for-approval' || arg === '-a') {
      i++;
    } else if (arg.startsWith('--ask-for-approval=')) {
      continue;
    } else {
      out.push(arg);
    }
  }
  return out;
}

function buildCodexResumeArgs(baseArgs: string[], sessionId: string): string[] {
  const args = normalizeCodexArgs(baseArgs).filter((arg) => arg !== 'resume');
  return ['resume', ...args, sessionId];
}

function buildCodexResumeCommand(command: string, sessionId: string): string {
  const parts = command.split(/\s+/).filter(Boolean);
  const cmd = parts[0] || 'codex';
  const args = buildCodexResumeArgs(parts.slice(1), sessionId);
  return [cmd, ...args].map(shellSingleQuote).join(' ');
}

function parseQueryResponse(stdout: string): QueryResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { result: '', sessionId: '', isError: false };
  }

  // Try parsing the whole output as JSON first (works for Windows/clean stdout)
  try {
    const parsed = JSON.parse(trimmed);
    return {
      result: parsed.result || trimmed,
      sessionId: parsed.session_id || '',
      isError: false,
    };
  } catch {
    // WSL: login shell profile scripts may print to stdout before the JSON.
    // Scan backwards for the last line that looks like JSON.
    const lines = trimmed.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{')) {
        try {
          const parsed = JSON.parse(line);
          return {
            result: parsed.result || line,
            sessionId: parsed.session_id || '',
            isError: false,
          };
        } catch {
          continue;
        }
      }
    }
    // No JSON found — return raw output as the result
    return { result: trimmed, sessionId: '', isError: false };
  }
}

function formatQueryError(err: Error | null, stdout: string, stderr: string): QueryResult {
  const parts = [stderr.trim(), stdout.trim(), err?.message || ''].filter(Boolean);
  return {
    result: parts.join('\n') || 'Query failed',
    sessionId: '',
    isError: true,
  };
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function getWindowsSystemPath(...parts: string[]): string {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', ...parts);
}

function findWindowsClaudePath(_env: NodeJS.ProcessEnv): Promise<string> {
  // Use known install path directly — avoids all PATH/shell resolution issues in Electron
  const knownPath = path.join(process.env.USERPROFILE || 'C:\\Users\\turke', '.local', 'bin', 'claude.exe');
  if (fs.existsSync(knownPath)) {
    return Promise.resolve(knownPath);
  }

  // Fallback: try where.exe through cmd.exe
  return new Promise<string>((resolve, reject) => {
    execFile(getWindowsSystemPath('cmd.exe'), ['/c', 'where', 'claude'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message || 'Failed to locate claude'));
        return;
      }

      const match = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => /claude(\.exe)?$/i.test(line));

      if (!match) {
        reject(new Error('Failed to locate claude'));
        return;
      }

      resolve(match);
    });
  });
}

export class AgentSupervisor extends EventEmitter {
  private windowsRunners = new Map<string, WindowsRunner>();
  private wslRunners = new Map<string, WslRunner>();
  private fileTrackers = new Map<string, FileActivityTracker>();
  private monitor: StatusMonitor;
  private contextStatsMonitor: ContextStatsMonitor;
  private sessionLogReader: SessionLogReader;
  private chatService: AgentChatService;
  private logsDir: string;

  // Event bridge — supervisor notification, cooldown, queue, drain state lives here.
  private bridge: EventBridge;

  // Team message delivery
  private teamDeliveryEngine: TeamMessageDeliveryEngine;

  // Per-agent serial input queue. The Windows codex/gemini path types one
  // character at a time at WINDOWS_CODEX_TYPING_DELAY_MS to dodge the
  // paste-burst dialog, so a single send can take 30+ seconds for a few KB
  // of text. We chain sends per agent so two callers can't interleave their
  // typing into a single prompt buffer, and we expose `isInputInFlight` so
  // the HTTP layer can both reject concurrent sends and report status as
  // 'working' while typing is in progress (the status monitor cannot infer
  // 'working' on its own here — typed-char echoes do not count as a
  // "meaningful burst", so it would otherwise read 'idle' the entire time).
  private inputQueues = new Map<string, Promise<void>>();
  private inputInFlight = new Set<string>();

  // BUG-11: epoch-ms of the last user-initiated PTY write per agent. Bumped
  // in `writeToAgent` (the only entrypoint for user-driven bytes — xterm
  // keystrokes, paste, file-drop, query-injection). NOT bumped by
  // `_doSendInput`, which writes through `runner.write` / `tmuxSendInput`
  // directly. The event bridge reads this via `getLastUserPtyWriteAt` to
  // defer auto-submitting events while the user is actively typing.
  private lastUserPtyWriteAt = new Map<string, number>();

  constructor() {
    super();
    const appData = process.env.APPDATA || path.join(process.env.HOME || '', '.config');
    this.logsDir = path.join(appData, 'AgentDashboard', 'logs');
    if (!fs.existsSync(this.logsDir)) fs.mkdirSync(this.logsDir, { recursive: true });

    this.monitor = new StatusMonitor(
      (agent) => this.checkAlive(agent),
      (agentId) => this.getLastMeaningfulBurstTime(agentId),
      (agentId) => getAgent(agentId),
      () => Date.now(),
      // P2-02: PTY ring tail for PromptPatternDetector. Falls back through
      // both runner maps; empty string when no runner exists (terminal /
      // not-yet-launched). The runners' ring buffers are advanced in the
      // same data handler that advances `_lastMeaningfulBurst`.
      (agentId) => {
        const win = this.windowsRunners.get(agentId);
        if (win) return win.getOutputRingTail();
        const wsl = this.wslRunners.get(agentId);
        if (wsl) return wsl.getOutputRingTail();
        return '';
      },
      // BUG-09 §3.5 — raw PTY-byte timestamp keeps a `working` agent alive
      // during Coalescing / spinner-only phases.
      (agentId) => this.getLastRawOutputTime(agentId),
    );

    const bridgeDeps: EventBridgeDeps = {
      getAgent: (id) => getAgent(id),
      getSupervisorForWorker: (worker) => getSupervisorAgent(worker.workspaceId),
      sendInput: (supervisorId, text) => this.sendInput(supervisorId, text),
      addAuditEvent: (agentId, type, payload) => { addEvent(agentId, type, payload); },
      getAgentLog: (agentId, lines) => this.getAgentLog(agentId, lines),
      getContextStats: (agentId) => this.contextStatsMonitor.getStats(agentId),
      now: () => Date.now(),
      scheduleDrain: (ms, fn) => {
        const handle = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(handle) };
      },
      statusMonitor: {
        forceIdle: (agentId, source) => this.monitor.forceIdle(agentId, source),
        forceWaiting: (agentId, kind, excerpt) => this.monitor.forceWaiting(agentId, kind, excerpt),
        forceWorking: (agentId, opts) => this.monitor.forceWorking(agentId, opts),
      },
      getLastUserPtyWriteAt: (id) => this.lastUserPtyWriteAt.get(id),
    };
    this.bridge = new EventBridge(bridgeDeps);

    // Monitor-sourced status changes: forward on the supervisor's public emitter
    // (so IPC handlers, ws-server, and team-delivery still receive them) and
    // feed the bridge with a 'monitor' source tag.
    this.monitor.on('statusChanged', (data) => {
      this.emit('statusChanged', { ...data, source: 'monitor' });
      // Handle auto-restart on crash
      const agent = getAgent(data.agentId);
      if (agent && data.status === 'crashed' && agent.autoRestartEnabled) {
        this.handleAutoRestart(agent);
      }
      void this.bridge.onStatusChanged({ ...data, source: 'monitor' });
    });

    // Direct emits from this supervisor (runner-exit / launch / restart / stop /
    // restart-failed) still need to reach the bridge — those paths bypass
    // StatusMonitor. Dedup against the monitor listener above by skipping
    // events whose source is 'monitor' (or missing, for legacy callers).
    this.on('statusChanged', (data: StatusChangedEvent | undefined) => {
      if (data && data.source && data.source !== 'monitor') {
        void this.bridge.onStatusChanged(data);
      }
    });

    // Typed session-event reader — single source of truth for JSONL tailing.
    // ContextStatsMonitor consumes its 'usage' + 'tool-use' events.
    this.sessionLogReader = new SessionLogReader(() => {
      const agents = getActiveAgents();
      return agents
        .filter(a => a.resumeSessionId || a.provider === 'codex' || a.provider === 'gemini')
        .map(a => ({
          agentId: a.id,
          sessionId: a.resumeSessionId || '',
          workingDirectory: a.workingDirectory,
          provider: a.provider,
          startedAt: a.createdAt,
        }));
    });
    this.sessionLogReader.register(new ClaudeJsonlReader());
    this.sessionLogReader.register(new CodexRolloutReader());
    this.sessionLogReader.register(new GeminiTranscriptReader());
    this.sessionLogReader.on('chat-events', (batch) => {
      this.emit('chatEvents', batch);
      this.bridge.onChatEvents(batch);
    });

    this.contextStatsMonitor = new ContextStatsMonitor(this.sessionLogReader);
    this.chatService = new AgentChatService(this.sessionLogReader);

    this.contextStatsMonitor.on('statsChanged', (stats: ContextStats) => {
      this.emit('contextStatsChanged', stats);
      // Event bridge: check context thresholds for supervised agents
      this.bridge.onContextStatsChanged(stats);
    });

    // JSONL-based file activity tracking (reliable for both Windows and WSL agents)
    this.contextStatsMonitor.on('fileActivity', (activity: JsonlFileActivity) => {
      const dbActivity = addFileActivity(activity.agentId, activity.filePath, activity.operation);
      if (dbActivity) {
        this.emit('fileActivity', dbActivity);
      }
    });

    // Update registry whenever any status changes
    this.on('statusChanged', () => this.writeAgentRegistry());
    this.on('agentDeleted', () => this.writeAgentRegistry());

    // Team message delivery engine
    this.teamDeliveryEngine = new TeamMessageDeliveryEngine(this);
  }

  start(): void {
    this.monitor.start();
    this.contextStatsMonitor.start();
    this.sessionLogReader.start();
    this.teamDeliveryEngine.start();
  }

  stop(): void {
    this.monitor.stop();
    this.contextStatsMonitor.stop();
    this.sessionLogReader.stop();
    this.teamDeliveryEngine.stop();
  }

  getContextStats(agentId: string): ContextStats | null {
    return this.contextStatsMonitor.getStats(agentId);
  }

  getSessionLogReader(): SessionLogReader {
    return this.sessionLogReader;
  }

  getChatService(): AgentChatService {
    return this.chatService;
  }

  getSupervisorAgent(workspaceId: string): Agent | null {
    return getSupervisorAgent(workspaceId);
  }

  /** Write ~/.claude/agent-registry.json so other Claude instances can discover agents */
  private writeAgentRegistry(): void {
    try {
      const agents = getAllAgents();
      const registry = {
        updatedAt: new Date().toISOString(),
        agents: agents
          .filter(a => a.resumeSessionId && a.status !== 'done')
          .map(a => ({
            id: a.id,
            title: a.title,
            status: a.status,
            sessionId: a.resumeSessionId,
            workingDirectory: getEffectiveWorkspaceRoot(a),
            roleDescription: a.roleDescription || '',
          })),
      };
      const registryPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'agent-registry.json');
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    } catch (err) {
      console.error('[registry] Failed to write agent registry:', err);
    }
  }

  async launchAgent(input: LaunchAgentInput): Promise<Agent> {
    const workspace = getWorkspace(input.workspaceId);
    if (!workspace) throw new Error('Workspace not found');

    // Resolve template defaults if launching from a template
    let resolvedInput = { ...input };
    if (input.templateId) {
      const template = getAgentTemplate(input.templateId);
      if (template) {
        resolvedInput = {
          ...resolvedInput,
          roleDescription: input.roleDescription || template.roleDescription || undefined,
          provider: input.provider || template.provider,
          command: input.command || template.command || undefined,
          autoRestartEnabled: input.autoRestartEnabled ?? template.autoRestart,
          isSupervisor: input.isSupervisor ?? template.isSupervisor,
          isSupervised: input.isSupervised ?? template.isSupervised,
          systemPrompt: input.systemPrompt || template.systemPrompt || undefined,
        };
        console.log(`[supervisor] Resolved template "${template.name}" (${template.id}) for agent "${input.title}"`);
      }
    }

    // Prevent duplicate supervisors per workspace
    if (resolvedInput.isSupervisor) {
      const existing = getSupervisorAgent(resolvedInput.workspaceId);
      if (existing && !['done', 'crashed'].includes(existing.status)) {
        throw new Error(`Supervisor already running for this workspace (${existing.id})`);
      }
    }

    let workDir = resolvedInput.workingDirectory || workspace.path;
    const pathType = detectPathType(workDir);
    // Convert UNC WSL paths (\\wsl.localhost\...) to Linux paths (/home/...)
    if (pathType === 'wsl' && workDir.startsWith('\\\\')) {
      workDir = uncToWslPath(workDir);
    }
    const provider = resolvedInput.provider || 'claude';
    const defaultCmd = PROVIDER_COMMANDS[provider][pathType];
    // If the workspace's defaultCommand is one of the framework defaults
    // (Windows or WSL), respect the provider override. Otherwise the workspace
    // has a customized launch command and we use it verbatim.
    const isFrameworkDefault =
      workspace.defaultCommand === DEFAULT_COMMAND || workspace.defaultCommand === DEFAULT_COMMAND_WSL;
    const command = resolvedInput.command || (isFrameworkDefault ? defaultCmd : workspace.defaultCommand);
    const agentId = uuidv4().substring(0, 8);
    const logPath = path.join(this.logsDir, `${agentId}.log`);

    let tmuxSessionName: string | null = null;

    if (pathType === 'wsl') {
      const slug = resolvedInput.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 20);
      tmuxSessionName = `${TMUX_SESSION_PREFIX}${slug}__${agentId}`;
    }

    // Set cwd so Claude Code discovers the agent's CLAUDE.md natively as system
    // instructions (not sent as a user message). Scaffold and MCP config are
    // written using the workspace root (workDir) first.
    //   - persona agents (legacy): .claude/agents/<name>/
    //   - supervisor (new layout per docs/PERSISTENT_AGENT_LAUNCH_CONTRACT.md): .dashboard/supervisor/
    let agentCwd = workDir;
    if (resolvedInput.persona) {
      agentCwd = pathType === 'windows'
        ? path.join(workDir, '.claude', 'agents', resolvedInput.persona)
        : `${workDir}/.claude/agents/${resolvedInput.persona}`;
    } else if (resolvedInput.isSupervisor) {
      agentCwd = pathType === 'windows'
        ? path.join(workDir, '.dashboard', 'supervisor')
        : `${workDir}/.dashboard/supervisor`;
    }

    const agent = createAgent({
      workspaceId: resolvedInput.workspaceId,
      title: resolvedInput.title,
      roleDescription: resolvedInput.roleDescription || '',
      workingDirectory: agentCwd,
      command,
      provider,
      isSupervisor: resolvedInput.isSupervisor,
      isSupervised: resolvedInput.isSupervised,
      tmuxSessionName,
      autoRestartEnabled: resolvedInput.autoRestartEnabled ?? true,
      logPath,
      templateId: resolvedInput.templateId || null,
      systemPrompt: resolvedInput.systemPrompt || null,
    });

    // Assign a session ID for resume/fork/query support (Claude only)
    let sessionId: string | undefined;
    if (provider === 'claude') {
      sessionId = uuidv4();
      updateAgentResumeSessionId(agent.id, sessionId);
      this.sessionLogReader.invalidatePath(agent.id);
    }

    addEvent(agent.id, 'launched');

    // Auto-create .dashboard/supervisor/ scaffold if this is a supervisor launch
    if (resolvedInput.isSupervisor) {
      this.ensureSupervisorScaffold(workDir, pathType);
    }
    // Write .mcp.json to workspace root and agent subdir (if persona or supervisor)
    if (resolvedInput.isSupervisor || resolvedInput.persona) {
      this.ensureMcpConfig(workDir, pathType);
      if (agentCwd !== workDir) {
        this.ensureMcpConfig(agentCwd, pathType);
      }
    }

    // If this agent is a member of an active team, inject team MCP config
    const teamMembership = getTeamMembership(agent.id);
    if (teamMembership) {
      this.ensureTeamMcpConfig(agent.id, teamMembership.teamId, workDir, pathType);
      console.log(`[supervisor] Agent ${agent.title} (${agent.id}) is in team ${teamMembership.teamId} — team MCP injected`);
    }

    // Auto-load agent.md/AGENT.md if present (from workspace root, not agent subdir)
    let agentMdPrompt = this.loadAgentMd(workDir, pathType);

    // For non-supervisor agents with a custom systemPrompt (from template or direct), send as initial message
    if (!resolvedInput.isSupervisor && resolvedInput.systemPrompt && provider === 'claude') {
      agentMdPrompt = agentMdPrompt
        ? `${resolvedInput.systemPrompt}\n\n---\n\n${agentMdPrompt}`
        : resolvedInput.systemPrompt;
      console.log(`[supervisor] Custom system prompt (${resolvedInput.systemPrompt.length} chars) — will send as initial message`);
    }

    // BUG-08: freshSession is a launch-time hint for codex agents to skip
    // post-launch session-id discovery so the new agent isn't bound to any
    // pre-existing rollout in this cwd. No-op for non-codex providers.
    const freshSession = resolvedInput.freshSession === true;

    if (pathType === 'windows') {
      await this.launchWindowsAgent(agent, false, agentMdPrompt, sessionId, undefined, freshSession);
    } else {
      await this.launchWslAgent(agent, false, agentMdPrompt, undefined, sessionId, freshSession);
    }

    return getAgent(agent.id)!;
  }

  /** Scaffold file map: relative path → content.
   *  Scripts get +x on WSL. Layout per docs/PERSISTENT_AGENT_LAUNCH_CONTRACT.md. */
  private static SUPERVISOR_FILES: Record<string, { content: string; executable?: boolean }> = {
    [`.dashboard/supervisor/CLAUDE.md`]:                                              { content: SUPERVISOR_AGENT_MD },
    [`.dashboard/supervisor/.claude/settings.json`]:                                  { content: SUPERVISOR_CLAUDE_SETTINGS_JSON },
    [`.dashboard/supervisor/.claude/skills/run-orchestration/SKILL.md`]:              { content: SUPERVISOR_RUN_ORCHESTRATION_SKILL },
    [`.dashboard/supervisor/.claude/skills/orchestration-spike/SKILL.md`]:            { content: SUPERVISOR_ORCHESTRATION_SPIKE_SKILL },
    [`.dashboard/supervisor/memory/MEMORY.md`]:                                       { content: SUPERVISOR_MEMORY_MD },
    [`.dashboard/supervisor/scripts/read-agent-log.sh`]:                              { content: SCRIPT_READ_AGENT_LOG, executable: true },
    [`.dashboard/supervisor/scripts/list-agents.sh`]:                                 { content: SCRIPT_LIST_AGENTS, executable: true },
    [`.dashboard/supervisor/scripts/send-message.sh`]:                                { content: SCRIPT_SEND_MESSAGE, executable: true },
    [`.dashboard/supervisor/scripts/get-context-stats.sh`]:                           { content: SCRIPT_GET_CONTEXT_STATS, executable: true },
  };

  /** Create the full .dashboard/supervisor/ scaffold in a workspace.
   *  Only writes files that don't already exist — never overwrites user edits. */
  private ensureSupervisorScaffold(workDir: string, pathType: string): void {
    const files = AgentSupervisor.SUPERVISOR_FILES;
    let created = 0;

    if (pathType === 'wsl') {
      for (const [relPath, { content, executable }] of Object.entries(files)) {
        try {
          execFileSync('wsl.exe', ['bash', '-lc', `test -f '${workDir}/${relPath}'`], { timeout: 5000 });
          // File exists, skip
        } catch {
          try {
            const dir = relPath.substring(0, relPath.lastIndexOf('/'));
            // Base64-encode to avoid shell escaping issues with $, backticks, etc.
            const b64 = Buffer.from(content, 'utf-8').toString('base64');
            let cmd = `mkdir -p '${workDir}/${dir}' && echo '${b64}' | base64 -d > '${workDir}/${relPath}'`;
            if (executable) {
              cmd += ` && chmod +x '${workDir}/${relPath}'`;
            }
            execFileSync('wsl.exe', ['bash', '-lc', cmd], { timeout: 5000 });
            created++;
          } catch (err) {
            console.error(`[supervisor] Failed to create ${relPath} in WSL:`, err);
          }
        }
      }
    } else {
      for (const [relPath, { content }] of Object.entries(files)) {
        const fullPath = path.join(workDir, relPath);
        if (fs.existsSync(fullPath)) continue;
        try {
          const dir = path.dirname(fullPath);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(fullPath, content, 'utf-8');
          created++;
        } catch (err) {
          console.error(`[supervisor] Failed to create ${fullPath}:`, err);
        }
      }
    }

    if (created > 0) {
      console.log(`[supervisor] Scaffolded ${created} files in ${workDir}/.dashboard/supervisor/`);
      addEvent('system', 'supervisor_scaffold_created', JSON.stringify({ workDir, filesCreated: created }));
    } else {
      console.log(`[supervisor] Scaffold already exists in ${workDir}`);
    }
  }

  /** Write .mcp.json in the workspace so Claude Code auto-discovers the MCP server.
   *  This enables the supervisor agent to use native MCP tools (list_agents, send_message, etc.)
   *  instead of bash scripts. */
  private ensureMcpConfig(workDir: string, pathType: string): void {
    const mcpScriptPath = getScriptPath('mcp-supervisor.js');
    const mcpConfig = {
      mcpServers: {
        'agent-dashboard': {
          command: 'node',
          args: [mcpScriptPath.replace(/\\/g, '/')],
          env: {
            AGENT_DASHBOARD_API_PORT: '24678',
          },
        },
      },
    };

    const configJson = JSON.stringify(mcpConfig, null, 2);

    if (pathType === 'wsl') {
      try {
        // Convert the Windows script path to a WSL-accessible path
        const wslScriptPath = mcpScriptPath.replace(/\\/g, '/');
        // For WSL, use the Windows path via /mnt/c/... since node runs in WSL
        const driveLetter = wslScriptPath.charAt(0).toLowerCase();
        const restOfPath = wslScriptPath.substring(2); // skip "C:"
        const linuxScriptPath = `/mnt/${driveLetter}${restOfPath}`;

        // Get the Windows host IP that WSL routes to. We want the DEFAULT GATEWAY
        // ("ip route show default" → "default via X.X.X.X dev eth0"), NOT the DNS
        // nameserver in /etc/resolv.conf — those can differ when the user has
        // custom DNS (e.g. nameserver=10.255.255.254 but actual gateway=172.22.208.1).
        // In WSL "mirrored" networking mode there is no separate gateway and 127.0.0.1
        // works directly — the fallback below covers that case.
        //
        // We invoke `ip route show default` rather than piping through awk because
        // wsl.exe pre-processes args and mangles `$2` in `awk '{print $2}'`, which
        // historically caused this code to silently fall back to 127.0.0.1.
        let windowsHostIp = '127.0.0.1';
        try {
          const route = execFileSync('wsl.exe', ['ip', 'route', 'show', 'default'], {
            encoding: 'utf-8', timeout: 5000,
          });
          const match = route.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)/);
          if (match) windowsHostIp = match[1];
        } catch { /* fall back to 127.0.0.1 */ }
        console.log(`[supervisor] WSL → Windows host IP: ${windowsHostIp}`);

        const wslMcpConfig = {
          mcpServers: {
            'agent-dashboard': {
              command: 'node',
              args: [linuxScriptPath],
              env: {
                AGENT_DASHBOARD_API_PORT: '24678',
                AGENT_DASHBOARD_API_HOST: windowsHostIp,
              },
            },
          },
        };

        const b64 = Buffer.from(JSON.stringify(wslMcpConfig, null, 2), 'utf-8').toString('base64');
        execFileSync('wsl.exe', ['bash', '-lc', `echo '${b64}' | base64 -d > '${workDir}/.mcp.json'`], { timeout: 5000 });
        console.log(`[supervisor] Wrote .mcp.json in WSL workspace: ${workDir}`);
      } catch (err) {
        console.error('[supervisor] Failed to write .mcp.json in WSL:', err);
      }
    } else {
      try {
        const fullPath = path.join(workDir, '.mcp.json');
        fs.writeFileSync(fullPath, configJson, 'utf-8');
        console.log(`[supervisor] Wrote .mcp.json in workspace: ${workDir}`);
      } catch (err) {
        console.error('[supervisor] Failed to write .mcp.json:', err);
      }
    }
  }

  /** Write/merge team MCP config into .mcp.json for a team member agent.
   *  Works for all providers (Claude, Gemini, Codex) — they all auto-discover .mcp.json.
   *  If .mcp.json already exists, merges the team server entry without overwriting others. */
  ensureTeamMcpConfig(agentId: string, teamId: string, workDir: string, pathType: string): void {
    const mcpTeamScriptPath = getScriptPath('mcp-team.js');
    const teamServerKey = 'agent-dashboard-team';

    if (pathType === 'wsl') {
      try {
        const wslScriptPath = mcpTeamScriptPath.replace(/\\/g, '/');
        const driveLetter = wslScriptPath.charAt(0).toLowerCase();
        const restOfPath = wslScriptPath.substring(2);
        const linuxScriptPath = `/mnt/${driveLetter}${restOfPath}`;

        // See ensureMcpConfig for why we read the default gateway, not resolv.conf.
        let windowsHostIp = '127.0.0.1';
        try {
          const route = execFileSync('wsl.exe', ['ip', 'route', 'show', 'default'], {
            encoding: 'utf-8', timeout: 5000,
          });
          const match = route.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)/);
          if (match) windowsHostIp = match[1];
        } catch { /* fall back to 127.0.0.1 */ }

        // Read existing .mcp.json to merge
        let existing: any = { mcpServers: {} };
        try {
          const content = execFileSync('wsl.exe', ['bash', '-lc', `cat '${workDir}/.mcp.json'`], {
            encoding: 'utf-8', timeout: 5000,
          });
          existing = JSON.parse(content);
        } catch { /* file doesn't exist or parse error, start fresh */ }

        existing.mcpServers[teamServerKey] = {
          command: 'node',
          args: [linuxScriptPath],
          env: {
            AGENT_ID: agentId,
            TEAM_ID: teamId,
            AGENT_DASHBOARD_API_PORT: '24678',
            AGENT_DASHBOARD_API_HOST: windowsHostIp,
          },
        };

        const b64 = Buffer.from(JSON.stringify(existing, null, 2), 'utf-8').toString('base64');
        execFileSync('wsl.exe', ['bash', '-lc', `echo '${b64}' | base64 -d > '${workDir}/.mcp.json'`], { timeout: 5000 });
        console.log(`[supervisor] Wrote team MCP config for agent ${agentId} in WSL: ${workDir}`);
      } catch (err) {
        console.error('[supervisor] Failed to write team MCP config in WSL:', err);
      }
    } else {
      try {
        const fullPath = path.join(workDir, '.mcp.json');

        // Read existing .mcp.json to merge
        let existing: any = { mcpServers: {} };
        try {
          if (fs.existsSync(fullPath)) {
            existing = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
          }
        } catch { /* parse error, start fresh */ }

        existing.mcpServers[teamServerKey] = {
          command: 'node',
          args: [mcpTeamScriptPath.replace(/\\/g, '/')],
          env: {
            AGENT_ID: agentId,
            TEAM_ID: teamId,
            AGENT_DASHBOARD_API_PORT: '24678',
          },
        };

        fs.writeFileSync(fullPath, JSON.stringify(existing, null, 2), 'utf-8');
        console.log(`[supervisor] Wrote team MCP config for agent ${agentId} in: ${workDir}`);
      } catch (err) {
        console.error('[supervisor] Failed to write team MCP config:', err);
      }
    }
  }

  /** Build --mcp-config JSON for a team member agent (used at launch time).
   *  Returns the JSON string to pass via --mcp-config flag. */
  buildTeamMcpConfigArg(agentId: string, teamId: string, pathType: string): string {
    const mcpTeamScriptPath = getScriptPath('mcp-team.js');

    if (pathType === 'wsl') {
      const wslScriptPath = mcpTeamScriptPath.replace(/\\/g, '/');
      const driveLetter = wslScriptPath.charAt(0).toLowerCase();
      const restOfPath = wslScriptPath.substring(2);
      const linuxScriptPath = `/mnt/${driveLetter}${restOfPath}`;

      // See ensureMcpConfig for why we read the default gateway, not resolv.conf.
      let windowsHostIp = '127.0.0.1';
      try {
        const route = execFileSync('wsl.exe', ['ip', 'route', 'show', 'default'], {
          encoding: 'utf-8', timeout: 5000,
        });
        const match = route.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)/);
        if (match) windowsHostIp = match[1];
      } catch { /* fall back */ }

      return JSON.stringify({
        mcpServers: {
          'agent-dashboard-team': {
            command: 'node',
            args: [linuxScriptPath],
            env: {
              AGENT_ID: agentId,
              TEAM_ID: teamId,
              AGENT_DASHBOARD_API_PORT: '24678',
              AGENT_DASHBOARD_API_HOST: windowsHostIp,
            },
          },
        },
      });
    }

    return JSON.stringify({
      mcpServers: {
        'agent-dashboard-team': {
          command: 'node',
          args: [mcpTeamScriptPath.replace(/\\/g, '/')],
          env: {
            AGENT_ID: agentId,
            TEAM_ID: teamId,
            AGENT_DASHBOARD_API_PORT: '24678',
          },
        },
      },
    });
  }

  private loadAgentMd(workDir: string, pathType: string): string | null {
    const candidates = ['agent.md', 'AGENT.md'];
    const MAX_SIZE = 10 * 1024; // 10KB cap

    if (pathType === 'wsl') {
      for (const name of candidates) {
        try {
          const content = execFileSync('wsl.exe', ['bash', '-lc', `cat '${workDir}/${name}'`], {
            encoding: 'utf-8',
            timeout: 5000,
          });
          if (content && content.trim()) {
            const trimmed = content.substring(0, MAX_SIZE);
            addEvent('system', 'agent_md_loaded', `${workDir}/${name}`);
            return trimmed;
          }
        } catch {
          // File doesn't exist, try next
        }
      }
    } else {
      for (const name of candidates) {
        const fullPath = path.join(workDir, name);
        if (fs.existsSync(fullPath)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            if (content && content.trim()) {
              const trimmed = content.substring(0, MAX_SIZE);
              addEvent('system', 'agent_md_loaded', fullPath);
              return trimmed;
            }
          } catch {
            // Read error, skip
          }
        }
      }
    }
    return null;
  }

  private setupFileTracker(agent: Agent, workingDirectory: string): FileActivityTracker | null {
    // PTY scraping is Claude-specific (matches the `⏺ Read(path)` TUI syntax).
    // Non-Claude providers' file activity comes from their structured JSONL via
    // ContextStatsMonitor; running this tracker on them produces comma-blob junk.
    if (agent.provider !== 'claude') return null;
    const tracker = new FileActivityTracker(agent.id, workingDirectory);
    this.fileTrackers.set(agent.id, tracker);
    tracker.on('activity', (activity) => {
      this.emit('fileActivity', activity);
    });
    return tracker;
  }

  private async launchWindowsAgent(agent: Agent, resume = false, agentMdPrompt?: string | null, sessionId?: string, overrideArgs?: string[], freshSession = false): Promise<void> {
    const runner = new WindowsRunner();
    this.windowsRunners.set(agent.id, runner);

    // Parse command into executable and args
    const parts = agent.command.split(/\s+/);
    const cmd = parts[0];
    let args = overrideArgs || parts.slice(1);

    if (!overrideArgs) {
      const isClaude = agent.provider === 'claude';

      // Supervisor: prompt now goes via positional argument (set in launchAgent).
      // Only inject MCP config via --mcp-config flag here.
      if (agent.isSupervisor && isClaude) {
        const mcpScriptPath = getScriptPath('mcp-supervisor.js').replace(/\\/g, '/');
        const mcpConfig = JSON.stringify({
          mcpServers: {
            'agent-dashboard': {
              command: 'node',
              args: [mcpScriptPath],
              env: { AGENT_DASHBOARD_API_PORT: '24678' },
            },
          },
        });
        args.push('--mcp-config', mcpConfig);
        console.log(`[Windows] Supervisor MCP config injected via --mcp-config`);

        // Workspace-root contract (see docs/PERSISTENT_AGENT_LAUNCH_CONTRACT.md):
        //   --add-dir extends file scope to the workspace and surfaces workspace-shared skills.
        //   --append-system-prompt tells the supervisor where the workspace is, since
        //   --add-dir's value isn't otherwise visible to the agent's context.
        const workspaceRoot = getEffectiveWorkspaceRoot(agent);
        const sysPrompt = `Workspace root: ${workspaceRoot}. cd there for project shell work. Use absolute paths for Read/Edit/Glob.`;
        args.push('--add-dir', workspaceRoot);
        args.push('--append-system-prompt', sysPrompt);
        console.log(`[Windows] Supervisor --add-dir + --append-system-prompt: ${workspaceRoot}`);
      }

      // Add session ID on fresh launch (Claude only)
      if (!resume && sessionId && isClaude) {
        args.push('--session-id', sessionId);
        console.log(`[Windows] Fresh launch ${agent.title} (${agent.id}) with session-id: ${sessionId}`);
      }

      // Resume by explicit session ID. Never fall back to --continue here:
      // when multiple agents share a workdir, --continue picks the most recent
      // session in cwd and silently cross-contaminates restarts. If the ID is
      // missing, treat as a hard error so the supervisor surfaces a 'crashed'.
      if (resume && isClaude && !args.includes('--continue') && !args.includes('-c')) {
        const latest = getAgent(agent.id);
        if (!latest?.resumeSessionId) {
          throw new Error(`Cannot resume ${agent.title} (${agent.id}): no resumeSessionId on record`);
        }
        args.push('--resume', latest.resumeSessionId);
        console.log(`[Windows] Resuming ${agent.title} (${agent.id}) with session: ${latest.resumeSessionId}`);
      }

      // Gemini resume: bare --resume picks the most recent session for this user.
      // Caveat: not scoped to cwd or to this specific agent — if multiple Gemini
      // agents are running, the wrong one's session can be picked. Acceptable for
      // single-Gemini-agent workflows; named-session (--resume <name> via /chat
      // save) is the proper fix and can be layered on later.
      if (resume && agent.provider === 'gemini' && !args.includes('--resume') && !args.includes('-r')) {
        args.push('--resume');
        console.log(`[Windows] Resuming ${agent.title} (${agent.id}) with gemini --resume (most-recent session)`);
      }

      if (resume && agent.provider === 'codex') {
        // BUG-04: `discoverNewCodexSession`'s 10 s post-launch poll often
        // misses the codex `session_meta` flush. Self-heal by falling back to
        // a cwd-match rollout scan the first time we actually need the sid.
        const sid = this.resolveCodexResumeSessionId(agent);
        if (!sid) {
          throw new Error(`Cannot resume ${agent.title} (${agent.id}): no Codex resumeSessionId on record and no cwd-matching rollout found`);
        }
        args = buildCodexResumeArgs(args, sid);
        console.log(`[Windows] Resuming ${agent.title} (${agent.id}) with codex resume ${sid}`);
      }

      // Append agent.md content as final positional argument (Claude only)
      if (agentMdPrompt && !resume && isClaude) {
        args.push(agentMdPrompt);
      }
    }

    // Setup file activity tracker (claude-only; non-claude get null)
    const tracker = this.setupFileTracker(agent, getEffectiveWorkspaceRoot(agent));

    runner.on('data', (data: string) => {
      updateAgentLastOutput(agent.id);
      if (tracker) tracker.processData(data);
    });

    runner.on('exit', (exitCode: number) => {
      updateAgentExitCode(agent.id, exitCode);
      this.windowsRunners.delete(agent.id);
      const status: AgentStatus = exitCode === 0 ? 'done' : 'crashed';
      const prior = getAgent(agent.id)?.status;
      updateAgentStatus(agent.id, status);
      addEvent(agent.id, status, JSON.stringify({ exitCode }));
      this.emit('statusChanged', { agentId: agent.id, status, fromStatus: prior, source: 'runner-exit' } satisfies StatusChangedEvent);

      // Auto-restart
      const latest = getAgent(agent.id);
      if (latest && status === 'crashed' && latest.autoRestartEnabled) {
        this.handleAutoRestart(latest);
      }
    });

    // Use directSpawn when we have a multiline positional argument (prompt text)
    // or when launching a supervisor (whose --append-system-prompt value contains
    // spaces that cmd.exe argument parsing would shred). Without directSpawn,
    // pty-host's cmd.exe wrap now quotes args with whitespace, but supervisor
    // launches still prefer direct-spawn so the load-bearing system prompt never
    // round-trips through cmd.exe parsing at all.
    const hasPromptArg = !!agentMdPrompt && !resume && agent.provider === 'claude';
    const supervisorDirectSpawn = !!agent.isSupervisor && agent.provider === 'claude' && !overrideArgs;
    const needsDirectSpawn = hasPromptArg || supervisorDirectSpawn;
    let launchCmd = cmd;
    if (needsDirectSpawn) {
      try {
        launchCmd = await findWindowsClaudePath(process.env as NodeJS.ProcessEnv);
        console.log(`[Windows] Using direct spawn with: ${launchCmd} (hasPromptArg=${hasPromptArg}, supervisor=${agent.isSupervisor})`);
      } catch (err) {
        console.warn(`[Windows] Could not resolve claude.exe path, falling back to cmd.exe:`, err);
      }
    }
    const useDirectSpawn = needsDirectSpawn && launchCmd !== cmd;

    // BUG-08: `freshSession` opts out of post-launch session-id discovery
    // so the new agent isn't auto-bound to any pre-existing rollout in this cwd.
    const codexSnapshot = shouldDiscoverCodexSession({ provider: agent.provider, resume, freshSession })
      ? await snapshotCodexSessions('windows')
      : null;
    const codexLaunchStartedAt = Date.now();
    if (agent.provider === 'codex' && !resume && freshSession) {
      console.log(`[Windows] freshSession=true — skipping codex session-id discovery for ${agent.title} (${agent.id})`);
    }

    // BUG-13 Path A: disable Claude Code's next-prompt ghost-text suggestion
    // rendering. The grey suggestion bytes (a) flap PTY-fallback status
    // idle↔working and (b) leak verbatim into the supervisor event's `Last
    // output:` field. Documented disable knob:
    // https://code.claude.com/docs/en/interactive-mode
    const extraEnv = agent.provider === 'claude'
      ? { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false' }
      : undefined;
    runner.launch(agent.workingDirectory, launchCmd, args, agent.logPath || '', useDirectSpawn, extraEnv);
    updateAgentPid(agent.id, runner.pid);
    const priorWinLaunch = getAgent(agent.id)?.status;
    updateAgentStatus(agent.id, 'working');
    this.emit('statusChanged', { agentId: agent.id, status: 'working', fromStatus: priorWinLaunch, source: 'launch' } satisfies StatusChangedEvent);

    if (codexSnapshot) {
      this.captureCodexSessionId(agent.id, codexSnapshot, agent.workingDirectory, codexLaunchStartedAt);
    }
  }

  /**
   * Retroactive recovery for codex agents whose `resumeSessionId` was never
   * persisted at launch time — e.g. the app was killed inside the 10 s
   * `discoverNewCodexSession` window, or codex flushed `session_meta` later
   * than the polling timeout. Scans the codex rollout dir for the most recent
   * rollout whose cwd matches and persists its id to the DB.
   *
   * Returns the recovered id, or null when no rollout matches.
   */
  private recoverCodexResumeSessionId(agent: Agent): string | null {
    const home: 'windows' | 'wsl' =
      detectPathType(agent.workingDirectory) === 'windows' ? 'windows' : 'wsl';
    const result = findCodexSessionIdByCwd({
      home,
      workingDirectory: agent.workingDirectory,
    });
    if (!result) return null;
    updateAgentResumeSessionId(agent.id, result.sessionId);
    this.sessionLogReader.invalidatePath(agent.id);
    console.log(
      `[Codex] Recovered session id ${result.sessionId} for agent ${agent.id} via cwd-match (${result.path})`
    );
    return result.sessionId;
  }

  /**
   * Read `resumeSessionId` for a Codex agent, lazy-recovering if it's null.
   * Use this at every site that needs the sid so BUG-04 (post-launch
   * discovery missed the `session_meta` flush) is self-healing instead of
   * requiring a manual recovery call.
   *
   * Returns null only when neither the persisted record nor a cwd-matching
   * rollout produced an id — i.e. the agent truly has no recoverable session.
   */
  private resolveCodexResumeSessionId(agent: Agent): string | null {
    const current = getAgent(agent.id)?.resumeSessionId ?? null;
    return ensureCodexResumeSessionId({
      current,
      recover: () => this.recoverCodexResumeSessionId(agent),
    });
  }

  private captureCodexSessionId(
    agentId: string,
    before: Awaited<ReturnType<typeof snapshotCodexSessions>>,
    workingDirectory: string,
    launchedAfterMs: number
  ): void {
    void discoverNewCodexSession(before, {
      workingDirectory,
      launchedAfterMs,
      timeoutMs: 10_000,
    }).then((result) => {
      if (!result) return;
      const latest = getAgent(agentId);
      if (!latest || latest.resumeSessionId) return; // null-guard: don't overwrite a later restart
      updateAgentResumeSessionId(agentId, result.sessionId);
      this.sessionLogReader.invalidatePath(agentId);
      console.log(`[Codex] Captured session id ${result.sessionId} for agent ${agentId}`);
    }).catch((err) => {
      console.warn(`[Codex] session-id discovery failed for ${agentId}:`, err);
    });
  }

  private async launchWslAgent(agent: Agent, resume = false, agentMdPrompt?: string | null, overrideCommand?: string, sessionId?: string, freshSession = false): Promise<void> {
    if (!agent.tmuxSessionName) throw new Error('No tmux session name');

    const runner = new WslRunner(agent.tmuxSessionName);
    this.wslRunners.set(agent.id, runner);

    // Do not convert log path to WSL; WslRunner runs in Windows Node.js and needs a native path.
    const nativeLogPath = agent.logPath || '';
    const wslWorkDir = agent.workingDirectory; // Already a WSL path

    let command = overrideCommand || agent.command;
    const isClaude = agent.provider === 'claude';

    // BUG-13 Path A: disable Claude Code's next-prompt ghost-text suggestion
    // rendering. The grey suggestion bytes (a) flap PTY-fallback status
    // idle↔working and (b) leak verbatim into the supervisor event's `Last
    // output:` field. Documented disable knob:
    // https://code.claude.com/docs/en/interactive-mode
    // Use `env VAR=value cmd` so the prefix survives the later `exec ${command}`
    // wrap (env consumes the assignment, then exec's ccode with that env).
    if (isClaude) {
      command = `env CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false ${command}`;
    }

    // Supervisor workspace-root contract (see docs/PERSISTENT_AGENT_LAUNCH_CONTRACT.md).
    // Computed up here so it's available both for the bare-command case and for the
    // wrap-with-prompt case below; sysPromptText is non-null iff this is a Claude supervisor.
    let sysPromptText: string | null = null;
    let supervisorWorkspaceRoot: string | null = null;
    if (agent.isSupervisor && isClaude && !overrideCommand) {
      supervisorWorkspaceRoot = getEffectiveWorkspaceRoot(agent);
      sysPromptText = `Workspace root: ${supervisorWorkspaceRoot}. cd there for project shell work. Use absolute paths for Read/Edit/Glob.`;
    }

    if (!overrideCommand) {
      // Supervisor MCP config: rely on .mcp.json file (written by ensureMcpConfig in launchAgent).
      // No --mcp-config flag needed — Claude Code auto-discovers .mcp.json in the workspace.
      if (agent.isSupervisor && isClaude) {
        console.log(`[WSL] Supervisor MCP: relying on .mcp.json auto-discovery in ${wslWorkDir}`);
      }

      // Append --add-dir on the bare command. The --append-system-prompt flag and
      // its value can't go on the bare command — its quoted value would collide
      // with the outer wrap below — so it's handled inside the wrap via SYSPROMPT.
      if (agent.isSupervisor && isClaude && supervisorWorkspaceRoot) {
        command += ` --add-dir '${supervisorWorkspaceRoot}'`;
        console.log(`[WSL] Supervisor --add-dir: ${supervisorWorkspaceRoot}`);
      }

      // Add session ID on fresh launch (Claude only)
      if (!resume && sessionId && isClaude) {
        command += ` --session-id ${sessionId}`;
        console.log(`[WSL] Fresh launch ${agent.title} (${agent.id}) with session-id: ${sessionId}`);
      }

      // Resume by explicit session ID. Never fall back to --continue here:
      // when multiple agents share a workdir, --continue picks the most recent
      // session in cwd and silently cross-contaminates restarts. If the ID is
      // missing, treat as a hard error so the supervisor surfaces a 'crashed'.
      if (resume && isClaude && !command.includes('--continue') && !command.includes('-c ')) {
        const latest = getAgent(agent.id);
        if (!latest?.resumeSessionId) {
          throw new Error(`Cannot resume ${agent.title} (${agent.id}): no resumeSessionId on record`);
        }
        command += ` --resume ${latest.resumeSessionId}`;
        console.log(`[WSL] Resuming ${agent.title} (${agent.id}) with session: ${latest.resumeSessionId}`);
      }

      // Gemini resume: bare --resume picks the most recent session for this user.
      // Caveat: not scoped to cwd or to this specific agent — if multiple Gemini
      // agents are running, the wrong one's session can be picked. Acceptable for
      // single-Gemini-agent workflows; named-session (/chat save <name> + --resume
      // <name>) is the proper fix and can be layered on later.
      if (resume && agent.provider === 'gemini' && !command.includes('--resume') && !command.includes(' -r ')) {
        command += ' --resume';
        console.log(`[WSL] Resuming ${agent.title} (${agent.id}) with gemini --resume (most-recent session)`);
      }

      if (resume && agent.provider === 'codex') {
        // BUG-04: lazy fallback — see launchWindowsAgent for the rationale.
        const sid = this.resolveCodexResumeSessionId(agent);
        if (!sid) {
          throw new Error(`Cannot resume ${agent.title} (${agent.id}): no Codex resumeSessionId on record and no cwd-matching rollout found`);
        }
        command = buildCodexResumeCommand(command, sid);
        console.log(`[WSL] Resuming ${agent.title} (${agent.id}) with codex resume ${sid}`);
      }

      // Wrap the command to load any of:
      //   - agentMdPrompt (workspace agent.md content) → final positional argument
      //   - sysPromptText (supervisor workspace-root preamble) → --append-system-prompt flag value
      // via $(cat tmpfile) substitutions inside the wrap. Required because the outer
      // exec ${command} "$PROMPT" word-splits the unquoted ${command} substitution
      // without re-interpreting embedded quote characters, so quoted values placed
      // directly in the bare command string would be broken into pieces.
      if ((agentMdPrompt || sysPromptText) && !resume && isClaude) {
        const writeWslFile = (relName: string, content: string): string | null => {
          const file = `${wslWorkDir}/.claude/${relName}`;
          try {
            const b64 = Buffer.from(content, 'utf-8').toString('base64');
            execFileSync('wsl.exe', ['bash', '-lc',
              `mkdir -p '${wslWorkDir}/.claude' && echo '${b64}' | base64 -d > '${file}'`
            ], { timeout: 5000 });
            return file;
          } catch (err) {
            console.warn(`[WSL] Failed to write ${relName}:`, err);
            return null;
          }
        };

        const exports: string[] = [];
        const flagSuffix: string[] = [];
        let promptArg = '';

        if (sysPromptText) {
          const sysFile = writeWslFile(`.sysprompt-${agent.id}.txt`, sysPromptText);
          if (sysFile) {
            exports.push(`SYSPROMPT="$(cat '${sysFile}')"`);
            flagSuffix.push(`--append-system-prompt "$SYSPROMPT"`);
          }
        }

        if (agentMdPrompt) {
          const promptFile = writeWslFile(`.prompt-${agent.id}.txt`, agentMdPrompt);
          if (promptFile) {
            exports.push(`PROMPT="$(cat '${promptFile}')"`);
            promptArg = ` "$PROMPT"`;
          } else {
            // Fallback: embed agent.md directly with single-quote escaping
            const escaped = agentMdPrompt.replace(/'/g, "'\\''");
            promptArg = ` '${escaped}'`;
          }
        }

        const exportPrefix = exports.length > 0 ? `${exports.join(' && ')} && ` : '';
        const flags = flagSuffix.length > 0 ? ` ${flagSuffix.join(' ')}` : '';
        command = `cd '${wslWorkDir}' && ${exportPrefix}exec ${command}${flags}${promptArg}`;
        console.log(`[WSL] Wrapped command — sysprompt:${!!sysPromptText} agentMd:${!!agentMdPrompt}`);
      }
    }

    // Setup file activity tracker (claude-only; non-claude get null)
    const tracker = this.setupFileTracker(agent, getEffectiveWorkspaceRoot(agent));

    runner.on('data', (data: string) => {
      updateAgentLastOutput(agent.id);
      if (tracker) tracker.processData(data);
    });

    runner.on('exit', (exitCode: number) => {
      updateAgentExitCode(agent.id, exitCode);
      this.wslRunners.delete(agent.id);
      const status: AgentStatus = exitCode === 0 ? 'done' : 'crashed';
      const prior = getAgent(agent.id)?.status;
      updateAgentStatus(agent.id, status);
      addEvent(agent.id, status, JSON.stringify({ exitCode }));
      this.emit('statusChanged', { agentId: agent.id, status, fromStatus: prior, source: 'runner-exit' } satisfies StatusChangedEvent);

      const latest = getAgent(agent.id);
      if (latest && status === 'crashed' && latest.autoRestartEnabled) {
        this.handleAutoRestart(latest);
      }
    });

    console.log(`[WSL] Launching agent '${agent.tmuxSessionName}' in ${wslWorkDir}`);
    console.log(`[WSL] Command: ${command}`);

    // BUG-08: `freshSession` opts out of post-launch session-id discovery
    // so the new agent isn't auto-bound to any pre-existing rollout in this cwd.
    const codexSnapshot = shouldDiscoverCodexSession({ provider: agent.provider, resume, freshSession })
      ? await snapshotCodexSessions('wsl')
      : null;
    const codexLaunchStartedAt = Date.now();
    if (agent.provider === 'codex' && !resume && freshSession) {
      console.log(`[WSL] freshSession=true — skipping codex session-id discovery for ${agent.title} (${agent.id})`);
    }

    await runner.launch(wslWorkDir, command, nativeLogPath);
    const priorWslLaunch = getAgent(agent.id)?.status;
    updateAgentStatus(agent.id, 'working');
    this.emit('statusChanged', { agentId: agent.id, status: 'working', fromStatus: priorWslLaunch, source: 'launch' } satisfies StatusChangedEvent);

    if (codexSnapshot) {
      this.captureCodexSessionId(agent.id, codexSnapshot, wslWorkDir, codexLaunchStartedAt);
    }
  }

  private async handleAutoRestart(agent: Agent): Promise<void> {
    if (agent.restartCount >= 5) {
      addEvent(agent.id, 'restart_limit_reached');
      return;
    }

    // BUG-09 §3.7 — drop the latch before transitioning to `restarting` so a
    // mid-tool crash does not leave a tool-pending latch alive for 15 min.
    this.monitor.forgetAgent(agent.id);

    const priorRestart = getAgent(agent.id)?.status;
    updateAgentStatus(agent.id, 'restarting');
    addEvent(agent.id, 'restarting');
    this.emit('statusChanged', { agentId: agent.id, status: 'restarting', fromStatus: priorRestart, source: 'restart' } satisfies StatusChangedEvent);
    incrementRestartCount(agent.id);

    setTimeout(async () => {
      const latest = getAgent(agent.id);
      if (!latest || latest.status !== 'restarting') return;

      try {
        const pathType = detectPathType(latest.workingDirectory);
        if (pathType === 'windows') {
          await this.launchWindowsAgent(latest, true);
        } else {
          await this.launchWslAgent(latest, true);
        }
      } catch (err) {
        const priorRestartFail = getAgent(agent.id)?.status;
        updateAgentStatus(agent.id, 'crashed');
        addEvent(agent.id, 'restart_failed', String(err));
        this.emit('statusChanged', { agentId: agent.id, status: 'crashed', fromStatus: priorRestartFail, source: 'restart-failed' } satisfies StatusChangedEvent);
      }
    }, 2000);
  }

  async forkAgent(sourceAgentId: string): Promise<Agent> {
    const source = getAgent(sourceAgentId);
    if (!source) throw new Error('Source agent not found');
    if (source.provider !== 'claude') throw new Error('Fork is only supported for Claude agents');
    if (!source.resumeSessionId) throw new Error('Source agent has no session ID — cannot fork');

    const workspace = getWorkspace(source.workspaceId);
    if (!workspace) throw new Error('Workspace not found');

    const newSessionId = uuidv4();
    const logPath = path.join(this.logsDir, `${uuidv4().substring(0, 8)}.log`);

    let tmuxSessionName: string | null = null;
    const pathType = detectPathType(source.workingDirectory);
    if (pathType === 'wsl') {
      const slug = (source.title + ' fork').toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 20);
      tmuxSessionName = `${TMUX_SESSION_PREFIX}${slug}__${uuidv4().substring(0, 8)}`;
    }

    const newAgent = createAgent({
      workspaceId: source.workspaceId,
      title: source.title + ' (fork)',
      roleDescription: source.roleDescription,
      workingDirectory: source.workingDirectory,
      command: source.command,
      provider: source.provider,
      tmuxSessionName,
      autoRestartEnabled: source.autoRestartEnabled,
      logPath,
    });

    updateAgentResumeSessionId(newAgent.id, newSessionId);
    this.sessionLogReader.invalidatePath(newAgent.id);
    addEvent(newAgent.id, 'forked', JSON.stringify({ sourceAgentId, sourceSessionId: source.resumeSessionId }));

    if (pathType === 'windows') {
      const parts = source.command.split(/\s+/);
      const cmd = parts[0];
      const forkArgs = [...parts.slice(1), '--resume', source.resumeSessionId, '--fork-session', '--session-id', newSessionId];
      await this.launchWindowsAgent(newAgent, false, null, undefined, forkArgs);
    } else {
      const forkCommand = `${source.command} --resume ${source.resumeSessionId} --fork-session --session-id ${newSessionId}`;
      await this.launchWslAgent(newAgent, false, null, forkCommand);
    }

    return getAgent(newAgent.id)!;
  }

  async queryAgent(targetAgentId: string, question: string, sourceAgentId?: string): Promise<QueryResult> {
    const target = getAgent(targetAgentId);
    if (!target) throw new Error('Target agent not found');
    if (target.provider !== 'claude') throw new Error('Inter-agent query is only supported for Claude agents');
    if (!target.resumeSessionId) throw new Error('Target agent has no session ID — cannot query');

    const source = sourceAgentId ? getAgent(sourceAgentId) : null;

    // Strong identity-anchored prompt to prevent history pattern-matching
    const sourceRef = source ? ` ("${source.title}")` : '';
    const prefixedQuestion = [
      `You are "${target.title}" — a Claude Code agent being consulted by another agent${sourceRef} in the same workspace.`,
      '',
      'This is NOT a task. Do NOT perform actions, use tools, run commands, or delegate work.',
      '',
      'You are being asked a question. Answer it directly from what you already know — your conversation history, the files you have read, the context you have built up. Everything you need is already in your memory.',
      '',
      'NOTE: Your conversation history may contain previous /query-agent skill invocations where you queried OTHER agents. Ignore those patterns. You are not running a query right now — you are ANSWERING one.',
      '',
      `Question: ${question}`,
    ].join('\n');

    const pathType = detectPathType(target.workingDirectory);

    const runQuery = (resumeArgs: string[]): Promise<QueryResult> => {
      return new Promise<QueryResult>((resolve) => {
        // Build a clean env: inherit everything but remove vars that block Claude
        const env = { ...process.env };
        delete env.CLAUDECODE;
        delete env.ELECTRON_RUN_AS_NODE;
        // Ensure the env vars are truly absent, not empty strings
        if ('CLAUDECODE' in env) delete env.CLAUDECODE;

        const mode = resumeArgs[0] === '--resume' ? 'resume' : 'continue';
        const resumeValue = resumeArgs[1] || '';

        if (pathType === 'windows') {
          const claudePath = path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe');
          const args = ['-p', prefixedQuestion];
          if (mode === 'resume') {
            args.push('--resume', resumeValue);
          } else {
            args.push('--continue');
          }
          args.push('--fork-session', '--dangerously-skip-permissions', '--max-turns', '1', '--output-format', 'json');

          console.log('[query] Spawning:', claudePath, args.join(' '), 'cwd:', target.workingDirectory);

          // Use spawn so we can close stdin — claude -p hangs if stdin stays open
          const child = spawn(claudePath, args, {
            cwd: target.workingDirectory,
            windowsHide: true,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
          child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

          const timer = setTimeout(() => { child.kill(); }, 60000);

          child.on('close', (code: number | null) => {
            clearTimeout(timer);
            if (code !== 0) {
              console.error('[query] Windows exit code:', code, 'stderr:', stderr, 'stdout:', stdout.substring(0, 200));
              resolve(formatQueryError(new Error(`Exit code ${code}`), stdout, stderr));
              return;
            }
            resolve(parseQueryResponse(stdout));
          });

          child.on('error', (err: Error) => {
            clearTimeout(timer);
            console.error('[query] Windows spawn error:', err.message);
            resolve(formatQueryError(err, '', ''));
          });
        } else {
          // Use spawn with stdin closed — same fix as Windows.
          // claude -p hangs if stdin stays open (execFile keeps it open as a pipe).
          const script = [
            'set -e',
            'cd "$AGENT_DASHBOARD_WORKDIR"',
            'args=(-p "$AGENT_DASHBOARD_QUERY")',
            'if [ "$AGENT_DASHBOARD_RESUME_MODE" = "resume" ]; then',
            '  args+=(--resume "$AGENT_DASHBOARD_RESUME_VALUE")',
            'else',
            '  args+=(--continue)',
            'fi',
            'args+=(--fork-session --dangerously-skip-permissions --max-turns 1 --output-format json)',
            'claude "${args[@]}"',
          ].join('\n');

          // Declare WSLENV so custom env vars reliably propagate into WSL
          // (default sharing can be disabled via /etc/wsl.conf interop settings)
          const queryVars = 'AGENT_DASHBOARD_WORKDIR:AGENT_DASHBOARD_QUERY:AGENT_DASHBOARD_RESUME_MODE:AGENT_DASHBOARD_RESUME_VALUE';
          const currentWslenv = env.WSLENV || '';
          const wslenv = currentWslenv ? `${currentWslenv}:${queryVars}` : queryVars;

          const child = spawn(getWindowsSystemPath('wsl.exe'), ['bash', '-lc', script], {
            windowsHide: true,
            env: {
              ...env,
              WSLENV: wslenv,
              AGENT_DASHBOARD_WORKDIR: target.workingDirectory,
              AGENT_DASHBOARD_QUERY: prefixedQuestion,
              AGENT_DASHBOARD_RESUME_MODE: mode,
              AGENT_DASHBOARD_RESUME_VALUE: resumeValue,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let stdout = '';
          let stderr = '';
          child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
          child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

          const timer = setTimeout(() => { child.kill(); }, 60000);

          child.on('close', (code: number | null) => {
            clearTimeout(timer);
            if (code !== 0) {
              console.error('[query] WSL exit code:', code, 'stderr:', stderr, 'stdout:', stdout.substring(0, 200));
              resolve(formatQueryError(new Error(`Exit code ${code}`), stdout, stderr));
              return;
            }
            resolve(parseQueryResponse(stdout));
          });

          child.on('error', (err: Error) => {
            clearTimeout(timer);
            console.error('[query] WSL spawn error:', err.message);
            resolve(formatQueryError(err, '', ''));
          });
        }
      });
    };

    // Try --resume first; fall back to --continue if session not found
    let result = await runQuery(['--resume', target.resumeSessionId!]);
    if (result.isError && /conversation|session|not found/i.test(result.result)) {
      console.log('[query] --resume failed, falling back to --continue for', target.title);
      result = await runQuery(['--continue']);
    }

    // Auto-inject response into the source agent's terminal so it has context
    if (source && !result.isError && result.result) {
      const injection = `[INTER-AGENT RESPONSE from "${target.title}"]: ${result.result}`;
      const winRunner = this.windowsRunners.get(sourceAgentId!);
      if (winRunner) {
        winRunner.write(injection + '\n');
        console.log('[query] Injected response into', source.title);
      }
      const wslRunner = this.wslRunners.get(sourceAgentId!);
      if (wslRunner) {
        wslRunner.write(injection + '\n');
        console.log('[query] Injected response into', source.title, '(WSL)');
      }
    }

    return result;
  }

  async stopAgent(agentId: string): Promise<void> {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      winRunner.kill();
      this.windowsRunners.delete(agentId);
    }

    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      await wslRunner.kill();
      this.wslRunners.delete(agentId);
    }

    this.fileTrackers.delete(agentId);
    const priorStop = getAgent(agentId)?.status;
    updateAgentStatus(agentId, 'done');
    updateAgentExitCode(agentId, 0);
    addEvent(agentId, 'stopped');
    this.emit('statusChanged', { agentId, status: 'done', fromStatus: priorStop, source: 'stop' } satisfies StatusChangedEvent);
  }

  async deleteAgent(agentId: string): Promise<void> {
    // Stop process if running
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      winRunner.kill();
      this.windowsRunners.delete(agentId);
    }

    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      await wslRunner.kill();
      this.wslRunners.delete(agentId);
    }

    this.fileTrackers.delete(agentId);
    this.bridge.forgetAgent(agentId);
    // BUG-09 §3.7 — drop the latch + hold-until entries so a 15-min
    // tool-pending latch can't survive into a future agent record reusing this id.
    this.monitor.forgetAgent(agentId);
    // BUG-11: drop user-typing timestamp so a reused agent id doesn't
    // inherit a stale "user is typing" gate.
    this.lastUserPtyWriteAt.delete(agentId);
    dbDeleteAgent(agentId);
    this.emit('agentDeleted', { agentId });
  }

  async restartAgent(agentId: string): Promise<void> {
    await this.stopAgent(agentId);
    const agent = getAgent(agentId);
    if (!agent) return;

    // BUG-09 §3.7 — a runner crash mid-tool would otherwise leave a
    // tool-pending latch in place for the full 15-min TTL. Clear it before
    // we transition to `restarting`.
    this.monitor.forgetAgent(agentId);

    const priorRestart = getAgent(agentId)?.status;
    updateAgentStatus(agentId, 'restarting');
    incrementRestartCount(agentId);
    this.emit('statusChanged', { agentId, status: 'restarting', fromStatus: priorRestart, source: 'restart' } satisfies StatusChangedEvent);

    setTimeout(async () => {
      const latest = getAgent(agentId);
      if (!latest) return;
      try {
        const pathType = detectPathType(latest.workingDirectory);
        if (pathType === 'windows') {
          await this.launchWindowsAgent(latest, true);
        } else {
          await this.launchWslAgent(latest, true);
        }
      } catch (err) {
        const priorRestartFail = getAgent(agentId)?.status;
        updateAgentStatus(agentId, 'crashed');
        this.emit('statusChanged', { agentId, status: 'crashed', fromStatus: priorRestartFail, source: 'restart-failed' } satisfies StatusChangedEvent);
      }
    }, 1000);
  }

  attachAgent(agentId: string): { write: (data: string) => void; resize: (cols: number, rows: number) => void; onData: (cb: (data: string) => void) => void } {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      // P1B-03: suppress meaningful-burst advances briefly so the TUI redraw
      // triggered by the new output channel does not flip the agent to
      // 'working' purely from terminal repaint bytes.
      winRunner.markInteractionIgnoreWindow(750);
      updateAgentAttached(agentId, true);
      return {
        write: (data) => winRunner.write(data),
        resize: (cols, rows) => winRunner.resize(cols, rows),
        onData: (cb) => winRunner.on('data', cb),
      };
    }

    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      // P1B-03: same rationale as the Windows branch above.
      wslRunner.markInteractionIgnoreWindow(750);
      wslRunner.attach();
      updateAgentAttached(agentId, true);
      return {
        write: (data) => wslRunner.write(data),
        resize: (cols, rows) => wslRunner.resize(cols, rows),
        onData: (cb) => wslRunner.on('data', cb),
      };
    }

    throw new Error('Agent not found or not running');
  }

  hasRunner(agentId: string): boolean {
    return this.windowsRunners.has(agentId) || this.wslRunners.has(agentId);
  }

  writeToAgent(agentId: string, data: string): void {
    // BUG-11: every byte reaching this path is user-initiated (the
    // `terminal:write` IPC handler is the sole caller, and its renderer-side
    // origins are all user actions — xterm `onData` keystrokes, clipboard
    // paste, file-path drop, the Query Agent dialog injecting a result).
    // Stamping here lets the event bridge defer auto-submits while typing
    // is active. `_doSendInput` goes through `runner.write`/`tmuxSendInput`
    // directly and intentionally does NOT update this map.
    if (data.length > 0) this.lastUserPtyWriteAt.set(agentId, Date.now());

    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) { winRunner.write(data); return; }
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) { wslRunner.write(data); }
  }

  /**
   * Returns true while a send to this agent is queued or actively typing.
   * The HTTP layer uses this to (a) override the agent's reported status to
   * 'working' so callers don't poll a stale 'idle' between enqueue and the
   * agent's first response burst, and (b) reject concurrent POST /input
   * requests with 409. See the inputQueues field comment for context.
   */
  isInputInFlight(agentId: string): boolean {
    return this.inputInFlight.has(agentId);
  }

  /**
   * Public entry point for sending input. Serializes per-agent: if a previous
   * send is still typing, this one waits its turn. Resolves once delivery
   * completes (so internal callers can still `await` for ordering).
   *
   * Callers that want fire-and-forget semantics (i.e. the HTTP layer) should
   * not `await` the returned promise — it stays pending until typing is done.
   * Synchronous validation (agent exists, has a runner) happens before the
   * promise is even chained, so missing-runner errors still throw eagerly.
   *
   * `opts.submit` defaults to true. Set it to false to leave the text in the
   * agent's prompt buffer without pressing Enter (BUG-01: launch_agent's
   * `submit:false` flag).
   */
  sendInput(agentId: string, text: string, opts: { submit?: boolean } = {}): Promise<void> {
    if (!this.windowsRunners.get(agentId) && !this.wslRunners.get(agentId)) {
      return Promise.reject(new Error(`No runner for agent ${agentId}`));
    }
    const submit = opts.submit !== false;
    this.inputInFlight.add(agentId);
    const previous = this.inputQueues.get(agentId) || Promise.resolve();
    const ours: Promise<void> = previous
      .catch(() => undefined) // a prior failed send must not poison the queue
      .then(() => this._doSendInput(agentId, text, submit))
      .then((delivered) => {
        if (submit && delivered) {
          // P2-03: if the agent was waiting on user input, the send just
          // answered the prompt — clear the latch so status flips back to
          // working immediately. Bridge filters the resulting waiting→working
          // emission so the supervisor doesn't get a noise notification.
          // Skip when submit:false — without an Enter the prompt is still
          // unanswered, so the waiting latch must stay set.
          //
          // notifyUserInputDelivered must run FIRST: if the agent was in
          // `waiting`, this clears the waiting latch and emits the specific
          // waiting→working transition with source 'user-input'. Seeding the
          // working latch before would no-op that path.
          this.bridge.notifyUserInputDelivered(agentId);
          // BUG-09 §3.4 (corrected, see plans/bug-09-launch-seed-fix-plan.md):
          // seed a working latch at the actual turn boundary — the moment
          // Enter has been delivered to the PTY. The ce44c2db sighting was a
          // false working→idle event during the ~8 s of spinner-only
          // first-turn API output AFTER sendInput, not at launch. Seeding
          // here covers that window without blocking the launch-poll flow
          // (mcp-supervisor.js launch_agent's 60 s poll-for-idle) or the
          // manual send_message_to_agent path. Gated on `delivered` so the
          // WSL `!runner.isAlive` skip does not seed a phantom latch.
          //
          // BUG-18 Change 2 — seed with `tool-pending` (900 s) instead of
          // `model-pending` (180 s). The first-turn API call has no early
          // chat-event signal (Claude JSONL writes only at message
          // completion; Codex's `task_started` lands after `sendInput`
          // returns), so the seed is the sole source of truth during that
          // window. 180 s was too tight for extended thinking (xhigh effort
          // empirically gaps to 311 s in this workspace); 900 s gives the
          // model room to think before any real refresh can land.
          this.monitor.forceWorking(agentId, {
            source: 'user-input-submitted',
            ttlClass: 'tool-pending',
          });
        }
      });
    this.inputQueues.set(agentId, ours);
    // Clear in-flight only when the chain has fully drained for this agent.
    // If more sends queued behind us, they own the cleanup.
    void ours.finally(() => {
      if (this.inputQueues.get(agentId) === ours) {
        this.inputQueues.delete(agentId);
        this.inputInFlight.delete(agentId);
      }
    });
    return ours;
  }

  private async _doSendInput(agentId: string, text: string, submit: boolean = true): Promise<boolean> {
    // For WSL agents, dispatch by provider. All three providers enable the
    // kitty keyboard protocol on Linux, so a bare `\r` from `tmux send-keys
    // Enter` is dropped — submit must be the kitty CSI form `\x1b[13u`.
    // claude additionally needs bracketed-paste wrapping so multi-line content
    // renders without confusing the input handler; codex/gemini need each
    // embedded `\n` encoded as Shift+Enter (`\x1b[13;2u`) so the final Enter
    // is the only submit event. See `tmuxSendInput` for the encoding.
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      const agent = getAgent(agentId);
      if (agent?.tmuxSessionName) {
        // Guard: don't send input if the runner reports the agent as dead.
        // This prevents typing event payloads into a bare bash shell after Claude Code exits.
        if (!wslRunner.isAlive) {
          console.warn(`[sendInput] Skipping send to ${agent.title} — runner not alive`);
          return false;
        }
        const provider = agent.provider === 'claude' || agent.provider === 'codex' || agent.provider === 'gemini'
          ? agent.provider
          : 'unknown';
        await tmuxSendInput(agent.tmuxSessionName, text, provider, submit);
        this.emitSyntheticUserEcho(agent, text);
        return true;
      }
    }
    // For Windows agents, bracketed-paste the body into Claude Code,
    // then send Enter as a separate PTY write. Sending text + '\r' (or '\n') as
    // one chunk leaves the message typed but unsubmitted in Claude Code v2.x's
    // prompt buffer — the trailing newline is absorbed as part of the paste,
    // so Enter must be delivered as its own input event.
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      const agent = getAgent(agentId);
      if (agent?.provider === 'claude') {
        // Claude Code treats a raw text + Enter chunk as pasted text without a
        // submit, so wrap in bracketed-paste markers and deliver Enter as a
        // separate PTY write.
        winRunner.write(formatBracketedPaste(text));
        if (submit) {
          await new Promise((resolve) => setTimeout(resolve, WINDOWS_SEND_INPUT_ENTER_DELAY_MS));
          winRunner.write(getWindowsSubmitSequence('claude'));
        }
      } else if (agent?.provider === 'codex' || agent?.provider === 'gemini') {
        // Codex/gemini enable Win32 Input Mode (ESC[?9001h). In this mode the
        // TUI expects key events as CSI sequences with both KEY_DOWN and
        // KEY_UP. ConPTY auto-converts incoming bytes into a single KEY_DOWN
        // event, which is enough to render typed characters but not enough to
        // trigger Enter (submit). Type chars at a slow rate so codex's
        // paste-detect doesn't fire, then send a real VK_RETURN down+up pair.
        // Embedded '\n' becomes Shift+Enter (newline-without-submit) so the
        // final plain Enter still triggers submit instead of inserting another
        // line in multi-line input mode.
        const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        for (const ch of normalized) {
          if (ch === '\n') {
            winRunner.write(WIN32_KEY_SHIFT_ENTER_DOWN + WIN32_KEY_SHIFT_ENTER_UP);
          } else {
            winRunner.write(ch);
          }
          await new Promise((resolve) => setTimeout(resolve, WINDOWS_CODEX_TYPING_DELAY_MS));
        }
        if (submit) {
          await new Promise((resolve) => setTimeout(resolve, WINDOWS_SEND_INPUT_ENTER_DELAY_MS));
          winRunner.write(getWindowsSubmitSequence(agent.provider));
        }
        this.emitSyntheticUserEcho(agent, text);
      } else {
        winRunner.write(submit ? `${text}\r` : text);
      }
      return true;
    }
    return false;
  }


  private emitSyntheticUserEcho(agent: Agent, text: string): void {
    if (agent.provider !== 'codex' && agent.provider !== 'gemini') return;
    this.sessionLogReader.appendSyntheticUserText(agent.id, text);
  }

  removeAgentListener(agentId: string, listener: (data: string) => void): void {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      winRunner.off('data', listener);
      return;
    }
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      wslRunner.off('data', listener);
      return;
    }
  }

  resizeAgent(agentId: string, cols: number, rows: number): void {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) { winRunner.resize(cols, rows); return; }
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) { wslRunner.resize(cols, rows); }
  }

  detachAgent(agentId: string): void {
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      wslRunner.detach();
    }
    // Windows runners don't need detach - we just stop forwarding
    updateAgentAttached(agentId, false);
  }

  /**
   * BUG-15: return the entire PTY ring buffer for an agent. The terminal
   * viewer calls this on mount to paint scrollback. For live agents it pulls
   * from the runner's in-memory ring; for `done` agents it falls back to the
   * `.scrollback` file the runner wrote on exit.
   *
   * Distinct from `getAgentLog` which targets MCP / chat consumers — that
   * path reads the raw `.log` file for big history requests, but the raw log
   * replays alt-screen toggles and ends up visually empty in xterm for
   * exited agents. The ring buffer is the same raw bytes, but bounded so we
   * can persist a useful snapshot.
   */
  async getAgentRingBuffer(agentId: string): Promise<string> {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) return winRunner.getFullRing();
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) return wslRunner.getFullRing();

    // Runner is gone (agent stopped / done). Fall back to the persisted
    // scrollback file. The runner writes this on its exit handler / kill().
    const agent = getAgent(agentId);
    if (agent?.logPath) {
      const scrollbackPath = `${agent.logPath}.scrollback`;
      if (fs.existsSync(scrollbackPath)) {
        try {
          return fs.readFileSync(scrollbackPath, 'utf-8');
        } catch (err) {
          console.error(`[getAgentRingBuffer] Failed to read scrollback for ${agentId}:`, err);
        }
      }
      // Last-resort: tail of the raw log file. Same content the old
      // TerminalPanel path used — alt-screen quirks and all — but at least
      // shows *something* for pre-BUG-15 agents that have no .scrollback yet.
      if (fs.existsSync(agent.logPath)) {
        try {
          const content = fs.readFileSync(agent.logPath, 'utf-8');
          if (content.length > 1_000_000) {
            return content.slice(content.length - 1_000_000);
          }
          return content;
        } catch (err) {
          console.error(`[getAgentRingBuffer] Failed to read log for ${agentId}:`, err);
        }
      }
    }
    return '';
  }

  async getAgentLog(agentId: string, lines = 50): Promise<string> {
    const agent = getAgent(agentId);
    if (!agent) return '';

    // If requesting a large history (like TerminalPanel does with 500+ lines),
    // always prefer the raw log file on disk. The log file contains the full,
    // persistent history with all raw ANSI color codes intact.
    // tmux capture-pane strips colors and is limited by the pane buffer.
    // Windows in-memory ring buffer is also limited.
    if (lines >= 500 && agent.logPath && fs.existsSync(agent.logPath)) {
      try {
        const content = fs.readFileSync(agent.logPath, 'utf-8');
        const allLines = content.split('\n');
        return allLines.slice(-lines).join('\n');
      } catch (err) {
        console.error(`[getAgentLog] Failed to read large log from disk for agent ${agentId}:`, err);
      }
    }

    // For WSL agents, try tmux capture first (always current)
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      try {
        return await wslRunner.captureOutput(lines);
      } catch {
        // Fall through to log file
      }
    }

    // For Windows agents, use in-memory ring buffer (instant, avoids file flush delays)
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      return winRunner.captureOutput(lines);
    }

    // Fallback: read from log file
    if (agent.logPath && fs.existsSync(agent.logPath)) {
      const content = fs.readFileSync(agent.logPath, 'utf-8');
      const allLines = content.split('\n');
      return allLines.slice(-lines).join('\n');
    }

    return '';
  }

  private async checkAlive(agent: Agent): Promise<boolean> {
    if (agent.tmuxSessionName) {
      const wslRunner = this.wslRunners.get(agent.id);
      if (!wslRunner) return false;
      return wslRunner.isStillAlive();
    } else {
      return this.windowsRunners.has(agent.id);
    }
  }

  /** BUG-09 §3.5 — meaningful-burst signal (200 B / 3 s gate). Used to
   *  promote `idle → working` in `inferStatus`. */
  private getLastMeaningfulBurstTime(agentId: string): number {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) return winRunner.lastMeaningfulBurstTime;

    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) return wslRunner.lastMeaningfulBurstTime;

    return 0;
  }

  /** BUG-09 §3.5 — raw PTY-byte timestamp. Used to keep an already-working
   *  agent from being downgraded by `inferStatus` during spinner-only
   *  Coalescing windows. */
  private getLastRawOutputTime(agentId: string): number {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) return winRunner.lastRawOutputTime;

    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) return wslRunner.lastRawOutputTime;

    return 0;
  }

  async reconcile(): Promise<void> {
    // Relaunch agents that were running before the app was closed
    const activeAgents = getActiveAgents();
    for (const agent of activeAgents) {
      // These agents were "working"/"idle" when the app closed but their
      // processes are gone. Relaunch with --continue to resume conversations.
      const hasRunner = this.windowsRunners.has(agent.id) || this.wslRunners.has(agent.id);
      if (!hasRunner) {
        const agentForReconnect = getAgent(agent.id);
        console.log(`Reconnecting agent: ${agent.title} (${agent.id}) sessionId=${agentForReconnect?.resumeSessionId || 'NONE'}`);
        try {
          const pathType = detectPathType(agent.workingDirectory);

          // Refresh .mcp.json for supervisors and persona-backed agents.
          // launchAgent() runs ensureMcpConfig() on first launch, but reconcile
          // bypasses that path — so the .mcp.json on disk persists from whenever
          // the agent was originally created. That's how stale script paths
          // (e.g. release/win-unpacked/...) survive past a switch from packaged
          // to dev builds, and how new MCP tools fail to surface to existing
          // supervisors. Rewriting on every reconcile makes this self-healing.
          if (agent.isSupervisor) {
            const ws = getWorkspace(agent.workspaceId);
            if (ws) {
              this.ensureMcpConfig(ws.path, pathType);
              if (agent.workingDirectory && agent.workingDirectory !== ws.path) {
                this.ensureMcpConfig(agent.workingDirectory, pathType);
              }
            }
          }

          if (pathType === 'windows') {
            await this.launchWindowsAgent(agent, true);
          } else {
            await this.launchWslAgent(agent, true);
          }
          addEvent(agent.id, 'reconnected');
        } catch (err) {
          console.error(`Failed to reconnect agent ${agent.id}:`, err);
          const priorReconnect = getAgent(agent.id)?.status;
          updateAgentStatus(agent.id, 'crashed');
          addEvent(agent.id, 'reconnect_failed', String(err));
          this.emit('statusChanged', { agentId: agent.id, status: 'crashed', fromStatus: priorReconnect, source: 'restart-failed' } satisfies StatusChangedEvent);
        }
      }
    }

    // Check for orphaned tmux sessions
    try {
      const sessions = await tmuxListSessions();
      const cadSessions = sessions.filter(s => s.name.startsWith(TMUX_SESSION_PREFIX));
      for (const session of cadSessions) {
        console.log(`Found existing tmux session: ${session.name}`);
      }
    } catch {
      // WSL might not be available
    }

    // Now that agents are active, do an immediate context stats poll
    // so data is available before the first interval tick.
    this.contextStatsMonitor.pollNow();
    this.sessionLogReader.pollNow();
  }
}
