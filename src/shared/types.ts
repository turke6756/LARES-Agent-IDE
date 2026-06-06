import type { SessionEvent, ChatEventBatch } from './session-events';

export type PathType = 'windows' | 'wsl';
export type AgentProvider = 'claude' | 'gemini' | 'codex';

// ── Team types ──────────────────────────────────────────────────────────
export type TeamStatus = 'active' | 'paused' | 'disbanded';
export type TeamTemplate = 'mesh' | 'pipeline' | 'custom';
export type TeamTaskStatus = 'todo' | 'in_progress' | 'done' | 'blocked';
export type TeamMessageStatus = 'request' | 'question' | 'complete' | 'blocked' | 'update';

export type AgentStatus =
  | 'launching'
  | 'working'
  | 'idle'
  | 'waiting'
  | 'done'
  | 'crashed'
  | 'restarting'
  // Projection-only, transient. Never persisted to the DB and never carried on
  // a `statusChanged` event — the API/IPC read layer overlays it while a send
  // is actively being typed into the agent's PTY (a message is arriving, e.g.
  // from another agent). Self-clears the instant delivery finishes. See
  // `ApiServer.withInputInFlight` and docs/AGENT_STATUS_LANES_AND_SUBMIT_RECOVERY.md §1.
  | 'receiving';

export interface Workspace {
  id: string;
  title: string;
  path: string;
  pathType: PathType;
  description: string;
  defaultCommand: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
}

export interface Agent {
  id: string;
  workspaceId: string;
  title: string;
  slug: string;
  roleDescription: string;
  workingDirectory: string;
  command: string;
  provider: AgentProvider;
  isSupervisor: boolean;
  isSupervised: boolean;
  // Hook-based status lane (orthogonal to isSupervised). A worker launches from
  // .dashboard/workers/<provider>/, gets the turn-boundary hook scaffold, and has
  // PTY inference + chat-event status disabled — but unlike isSupervised it does
  // NOT notify a supervisor. isSupervised implies the worker lane; isWorker alone
  // is the default for user-launched claude/codex agents.
  isWorker: boolean;
  tmuxSessionName: string | null;
  autoRestartEnabled: boolean;
  resumeSessionId: string | null;
  status: AgentStatus;
  // Hook-scaffold health, orthogonal to `status` (HOOK_SYSTEM_DESIGN.md §5.4).
  //   'unknown'  — no hook event seen yet (launch default)
  //   'healthy'  — at least one hook event has reached the dashboard
  //   'broken'   — launch canary expired with no hook event (scaffold absent/misconfigured)
  //   'degraded' — a worker-lane codex command we couldn't safely instrument (B2)
  // Surfaced for visibility only — a 'broken'/'degraded' status NEVER re-enables
  // PTY inference for worker-lane agents.
  hookStatus?: 'unknown' | 'healthy' | 'broken' | 'degraded';
  // Wall-clock (ms) of the most recent hook event from this agent, any source.
  lastHookEventAt?: number;
  // C1 (plans/global-hook-rollout-and-submit-confirmation.md §2.1/§3.1) — the
  // last synchronous-submit-confirmation failure. Set when the send chokepoint's
  // confirm-and-retry EXHAUSTS for a contract provider (a prompt was delivered
  // but no turn ever started), cleared on the next confirmed submit. Surfaced on
  // the status/GET-agents projection so fire-and-forget pollers (MCP/HTTP/
  // GroupThink) can see a swallowed delivery failure instead of an agent that
  // silently never goes `working`.
  lastSendError?: { message: string; ts: number } | null;
  isAttached: boolean;
  restartCount: number;
  lastExitCode: number | null;
  pid: number | null;
  logPath: string | null;
  templateId: string | null;
  systemPrompt: string | null;
  createdAt: string;
  updatedAt: string;
  lastOutputAt: string | null;
  lastAttachedAt: string | null;
}

export interface AgentEvent {
  id: number;
  agentId: string;
  eventType: string;
  payload: string | null;
  createdAt: string;
}

export type FileOperation = 'read' | 'write' | 'create';

export interface FileActivity {
  id: number;
  agentId: string;
  filePath: string;
  operation: FileOperation;
  timestamp: string;
}

export interface CreateWorkspaceInput {
  title: string;
  path: string;
  pathType: PathType;
  description?: string;
  defaultCommand?: string;
}

export interface LaunchAgentInput {
  workspaceId: string;
  title: string;
  roleDescription?: string;
  workingDirectory?: string;
  command?: string;
  provider?: AgentProvider;
  autoRestartEnabled?: boolean;
  isSupervisor?: boolean;
  isSupervised?: boolean;
  isWorker?: boolean;
  templateId?: string;
  systemPrompt?: string;
  persona?: string;
  // Codex-only hint: launch without `codex resume` so the codex CLI mints a
  // fresh conversation rather than inheriting a prior rollout in this
  // workspace. The dashboard still discovers and binds the new session id
  // (BUG-26: the pre-BUG-26 behavior also skipped discovery, which left
  // resumeSessionId null and forced CodexRolloutReader to fall back to
  // cwd-as-identity proxy — mis-attributing events under concurrent
  // same-cwd launches). No-op for non-codex providers.
  freshSession?: boolean;
}

export interface AgentPersona {
  name: string;          // subdirectory name, e.g. "researcher"
  directory: string;     // full path to the persona directory
  hasMemory: boolean;    // whether memory/MEMORY.md exists
  isSupervisor: boolean; // true if name matches SUPERVISOR_AGENT_NAME
}

export interface AgentTemplate {
  id: string;
  workspaceId: string | null;
  name: string;
  description: string;
  systemPrompt: string | null;
  roleDescription: string;
  provider: AgentProvider;
  command: string | null;
  autoRestart: boolean;
  isSupervisor: boolean;
  isSupervised: boolean;
  isWorker: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentTemplateInput {
  workspaceId?: string | null;
  name: string;
  description?: string;
  systemPrompt?: string | null;
  roleDescription?: string;
  provider?: AgentProvider;
  command?: string | null;
  autoRestart?: boolean;
  isSupervisor?: boolean;
  isSupervised?: boolean;
  isWorker?: boolean;
}

export interface QueryResult {
  result: string;
  sessionId: string;
  isError: boolean;
}

export type WslPassiveState = 'running' | 'stopped' | 'unavailable' | 'no-distro' | 'unknown';

export interface WslDistroStatus {
  name: string;
  state: 'Running' | 'Stopped' | string;
  version?: string;
  default: boolean;
}

export interface WslStatus {
  state: WslPassiveState;
  defaultDistro?: string;
  distros: WslDistroStatus[];
  error?: string;
}

export interface HealthCheck {
  wslAvailable: boolean;
  tmuxAvailable: boolean;
  claudeWindowsAvailable: boolean;
  claudeWslAvailable: boolean;
  wslStatus: WslStatus;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  /** Last-modified time, ms since epoch. Undefined when stat failed. */
  mtimeMs?: number;
  /** Creation time, ms since epoch. On WSL this is status-change time —
   *  find(1) has no birth-time printf — which matches creation for new files. */
  birthtimeMs?: number;
}

export type FsEvent =
  | { type: 'add'; path: string; parentDir: string; isDirectory: boolean; size: number }
  | { type: 'unlink'; path: string; parentDir: string }
  | { type: 'change'; path: string; parentDir: string };

export interface FileContent {
  path: string;
  content: string;
  encoding: string;
  size: number;
  error?: string;
}

export type FileMutationResult =
  | { ok: true; path?: string }
  | { ok: false; error: string };

/**
 * Result of `files:copy`. Distinguishes full success, validation failures
 * (nothing copied — `failed` lists the offending sources), and partial
 * failures (`copied` holds destination paths that did land).
 */
export type FileCopyResult =
  | { ok: true; copied: string[] }
  | {
      ok: false;
      error: string;
      copied?: string[];
      failed?: Array<{ sourcePath: string; error: string }>;
    };

/**
 * Minimal structural stand-in for the DOM `File` type. Shared types also
 * compile in the main process (tsconfig.main.json has no DOM lib), so the
 * real `File` name is unavailable here. Real `File` objects from the
 * renderer are structurally assignable.
 */
export interface RendererFile {
  readonly name: string;
}

export interface FileTab {
  id: string;
  filePath: string;        // empty string for directory-only tabs
  rootDirectory: string;   // tree root (agent workingDirectory or workspace path)
  pathType: PathType;
  agentId?: string;
  workspaceId?: string;    // scopes the tab to a workspace; unset for legacy/orphan tabs
  label: string;           // display name (filename or dirname/)
}

/**
 * Payload of the `file:open-tab` IPC event (main → renderer). Produced by
 * POST /api/files/open-tab (the `open_file_in_view` MCP tool) and consumed
 * by the renderer, which resolves missing fields against the currently
 * selected workspace and calls the dashboard store's openTab().
 */
export interface OpenFileTabRequest {
  filePath: string;          // absolute, or relative to rootDirectory
  pathType?: PathType;       // inferred from the path / workspace when unset
  workspaceId?: string;      // defaults to the workspace selected in the UI
  rootDirectory?: string;    // enriched by main when workspaceId resolves
  agentId?: string;
}

// ── Team interfaces ─────────────────────────────────────────────────────

export interface Team {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  template: TeamTemplate | null;
  status: TeamStatus;
  createdAt: string;
  updatedAt: string;
  disbandedAt: string | null;
  // Populated on fetch:
  members?: TeamMember[];
  channels?: TeamChannel[];
}

export interface TeamMember {
  teamId: string;
  agentId: string;
  role: string;
  joinedAt: string;
  // Enriched from agent table:
  title?: string;
  provider?: string;
  status?: AgentStatus;
}

export interface TeamChannel {
  id: string;
  teamId: string;
  fromAgent: string;
  toAgent: string;
  label: string | null;
}

export interface TeamMessage {
  id: number;
  teamId: string;
  fromAgent: string;
  toAgent: string;
  subject: string;
  status: TeamMessageStatus;
  summary: string;
  detail: string | null;
  need: string | null;
  deliveredAt: string | null;
  createdAt: string;
  // Enriched:
  fromTitle?: string;
  toTitle?: string;
}

export interface TeamTask {
  id: string;
  teamId: string;
  title: string;
  description: string;
  status: TeamTaskStatus;
  assignedTo: string | null;
  blockedBy: string[];
  createdBy: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTeamInput {
  workspaceId: string;
  name: string;
  description?: string;
  template?: TeamTemplate;
  members: { agentId: string; role?: string }[];
  channels?: { from: string; to: string; label?: string }[];
}

export interface TeamManifest {
  version: 1;
  members: Array<{
    agentId: string;
    title: string;
    provider: string;
    roleDescription: string;
    workingDirectory: string;
    command: string;
    resumeSessionId: string | null;
    role: string;
  }>;
  channels: Array<{ fromAgent: string; toAgent: string; label: string | null }>;
  tasks: Array<{ title: string; description: string; status: string; assignedTo: string | null }>;
  recentMessages: TeamMessage[];
}

export interface PanelLayout {
  sidebarWidth: number;
  detailPanelWidth: number;
  terminalHeight: number;
  directoryTreeWidth: number;
  sidebarCollapsed: boolean;
  detailPanelCollapsed: boolean;
  terminalCollapsed: boolean;
  directoryTreeCollapsed: boolean;
}

export interface JupyterServerInfo {
  baseUrl: string;
  token: string;
  ready: boolean;
}

export interface KernelspecInfo {
  name: string;
  spec: {
    language?: string;
    display_name?: string;
    argv?: string[];
  };
  resources?: Record<string, string>;
}

export interface KernelspecsResponse {
  default: string;
  kernelspecs: Record<string, KernelspecInfo>;
}

export interface ContextStats {
  agentId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalOutputTokens: number;
  totalContextTokens: number;
  contextWindowMax: number;
  contextPercentage: number;
  turnCount: number;
  lastUpdatedAt: string;
}

export interface IpcApi {
  workspaces: {
    list: () => Promise<Workspace[]>;
    create: (input: CreateWorkspaceInput) => Promise<Workspace>;
    delete: (id: string) => Promise<void>;
    reorder: (ids: string[]) => Promise<void>;
    openInVSCode: (id: string) => Promise<void>;
  };
  agents: {
    list: (workspaceId: string) => Promise<Agent[]>;
    listAll: () => Promise<Agent[]>;
    launch: (input: LaunchAgentInput) => Promise<Agent>;
    stop: (id: string) => Promise<void>;
    restart: (id: string) => Promise<void>;
    getLog: (id: string, lines?: number) => Promise<string>;
    getRingBuffer: (id: string) => Promise<string>;
    delete: (id: string) => Promise<void>;
    checkAgentMd: (workingDirectory: string, pathType: PathType) => Promise<{ found: boolean; fileName: string | null }>;
    getFileActivities: (agentId: string, operation?: FileOperation) => Promise<FileActivity[]>;
    onFileActivity: (callback: (activity: FileActivity) => void) => () => void;
    getContextStats: (agentId: string) => Promise<ContextStats | null>;
    onContextStatsChanged: (callback: (stats: ContextStats) => void) => () => void;
    getChatEvents: (agentId: string, sinceUuid?: string) => Promise<{ events: SessionEvent[]; truncated: boolean }>;
    chatSubscribe: (agentId: string) => Promise<void>;
    chatUnsubscribe: (agentId: string) => Promise<void>;
    getFullToolResult: (agentId: string, toolUseId: string) => Promise<string | null>;
    onChatEvents: (callback: (batch: ChatEventBatch) => void) => () => void;
    fork: (id: string) => Promise<Agent>;
    query: (targetAgentId: string, question: string, sourceAgentId?: string) => Promise<QueryResult>;
    sendInput: (agentId: string, text: string) => Promise<void>;
    onSendInputError: (callback: (data: { agentId: string; error: string }) => void) => () => void;
    getSupervisor: (workspaceId: string) => Promise<Agent | null>;
    updateSupervised: (id: string, supervised: boolean) => Promise<Agent>;
  };
  terminal: {
    attach: (agentId: string) => Promise<void>;
    detach: (agentId: string) => Promise<void>;
    write: (agentId: string, data: string) => Promise<void>;
    resize: (agentId: string, cols: number, rows: number) => Promise<void>;
    onData: (callback: (agentId: string, data: string) => void) => () => void;
  };
  files: {
    readFile: (filePath: string, pathType: PathType) => Promise<FileContent>;
    listDirectory: (dirPath: string, pathType: PathType) => Promise<DirectoryEntry[]>;
    writeFile: (
      filePath: string,
      rootDirectory: string,
      pathType: PathType,
      content: string
    ) => Promise<FileMutationResult>;
    createFile: (
      parentDir: string,
      rootDirectory: string,
      pathType: PathType,
      name: string,
      template?: 'text' | 'markdown' | 'notebook'
    ) => Promise<FileMutationResult>;
    mkdir: (
      parentDir: string,
      rootDirectory: string,
      pathType: PathType,
      name: string
    ) => Promise<FileMutationResult>;
    rename: (
      oldPath: string,
      rootDirectory: string,
      pathType: PathType,
      newName: string
    ) => Promise<FileMutationResult>;
    move: (
      srcPath: string,
      rootDirectory: string,
      pathType: PathType,
      destDir: string
    ) => Promise<FileMutationResult>;
    copy: (
      sourcePaths: string[],
      rootDirectory: string,
      pathType: PathType,
      destDir: string
    ) => Promise<FileCopyResult>;
    /** Native filesystem path of a dropped OS file, via Electron webUtils
     *  (Electron 41 removed the non-standard File.path). */
    getPathForFile: (file: RendererFile) => string;
    deleteEntry: (
      entryPath: string,
      rootDirectory: string,
      pathType: PathType,
      recursive: boolean
    ) => Promise<FileMutationResult>;
    /** Show the entry in Windows Explorer: files open their parent folder
     *  with the file selected, directories open as a folder window. Main
     *  stats the path itself, so stale tree entries return a clear error. */
    reveal: (entryPath: string, pathType: PathType) => Promise<FileMutationResult>;
    watchDirectory: (dirPath: string, pathType: PathType, callback: (event: FsEvent) => void) => () => void;
  };
  system: {
    pickDirectory: (startInWsl?: boolean) => Promise<string | null>;
    healthCheck: () => Promise<HealthCheck>;
    openFile: (filePath: string, pathType: PathType) => Promise<void>;
    openFileInWorkspace: (filePath: string, workspaceDir: string, pathType: PathType) => Promise<void>;
    setTheme: (theme: 'dark' | 'light') => Promise<void>;
  };
  teams: {
    create: (input: CreateTeamInput) => Promise<Team>;
    get: (teamId: string) => Promise<Team>;
    list: (workspaceId: string) => Promise<Team[]>;
    disband: (teamId: string) => Promise<void>;
    addMember: (teamId: string, agentId: string, role?: string) => Promise<void>;
    removeMember: (teamId: string, agentId: string) => Promise<void>;
    addChannel: (teamId: string, fromAgent: string, toAgent: string, label?: string) => Promise<TeamChannel>;
    removeChannel: (teamId: string, channelId: string) => Promise<void>;
    getMessages: (teamId: string, agentId?: string) => Promise<TeamMessage[]>;
    getTasks: (teamId: string) => Promise<TeamTask[]>;
    createTask: (teamId: string, task: { title: string; description?: string; assignedTo?: string; blockedBy?: string[]; createdBy: string }) => Promise<TeamTask>;
    updateTask: (teamId: string, taskId: string, updates: { status?: TeamTaskStatus; assignedTo?: string; notes?: string }) => Promise<TeamTask>;
    resurrect: (teamId: string) => Promise<Team>;
  };
  templates: {
    list: (workspaceId?: string) => Promise<AgentTemplate[]>;
    create: (input: CreateAgentTemplateInput) => Promise<AgentTemplate>;
    update: (id: string, updates: Partial<CreateAgentTemplateInput>) => Promise<AgentTemplate>;
    delete: (id: string) => Promise<void>;
  };
  personas: {
    list: (workspacePath: string, pathType: PathType) => Promise<AgentPersona[]>;
    create: (workspacePath: string, pathType: PathType, name: string, customClaudeMd?: string) => Promise<AgentPersona>;
  };
  notebooks: {
    ensureServer: () => Promise<JupyterServerInfo>;
    listKernelspecs: () => Promise<KernelspecsResponse>;
  };
  onAgentStatusChanged: (callback: (data: { agentId: string; status: AgentStatus; agent: Agent }) => void) => () => void;
  onOpenFileTab: (callback: (payload: OpenFileTabRequest) => void) => () => void;
  onTeamUpdated: (callback: (team: Team) => void) => () => void;
  onTeamMessageCreated: (callback: (message: TeamMessage) => void) => () => void;
}

declare global {
  interface Window {
    api: IpcApi;
  }
}
