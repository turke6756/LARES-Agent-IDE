import type { SessionEvent, ChatEventBatch } from './session-events';
import type {
  AccessHandoffResult,
  AccessRequest,
  AccessRequestDecision,
  AccessRule,
  AccessRuleInput,
  AgentActionsCommand,
  AgentActionsState,
  AgentDrivingRevoked,
  Bookmark,
  BookmarkPatch,
  BrowserAuditEntry,
  BrowserBounds,
  BrowserContextMenuParams,
  BrowserCreateTabOptions,
  BrowserFindResult,
  BrowserOpenRequest,
  BrowserShortcut,
  BrowserTabSnapshotEntry,
  BrowserTabState,
  HistoryEntry,
  HistoryQuery,
  OmniboxSuggestion,
  SharedAgentSessions,
} from './browser';

export type PathType = 'windows' | 'wsl';
export type AgentProvider = 'claude' | 'gemini' | 'codex';

// Hardcoded first-class app role-lanes. 'researcher' is a third lane alongside
// 'supervisor' and 'worker' (browser-parity-and-capability-isolation §0); see
// roleLaneOf() in src/main/supervisor/index.ts for the flag→lane mapping.
export type AgentRoleLane = 'legacy' | 'supervisor' | 'worker' | 'researcher';

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
  // Researcher role-lane (browser-parity-and-capability-isolation §0, D-1). A
  // third first-class hardcoded app lane alongside supervisor/worker: scaffolded
  // into .dashboard/researcher, browser MCP wired in, native dangerous tools
  // (Bash/Edit/NotebookEdit) withheld. Mutually exclusive with the other lanes.
  isResearcher: boolean;
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
  // Researcher role-lane (browser-parity-and-capability-isolation §0, D-1).
  // Claude-only (D-2); mutually exclusive with the other lane flags.
  isResearcher?: boolean;
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
  // WP-P2 (plans/selection-to-agent-primitive-plan.md §1.6/§7): optional first
  // USER message, delivered by the supervisor exactly once when the agent
  // first reaches an input-accepting status (idle|waiting|done). Deliberately
  // separate from systemPrompt/agent.md launch framing — that positional-arg
  // path must stay byte-identical whether or not this field is set.
  initialUserPrompt?: string;
  // WP-A.2 (browser-parity-and-capability-isolation F9): when launching an
  // agent that should join a team immediately, pass the team id (+ optional
  // role) so `launchAgent` records the membership BEFORE the per-launch MCP
  // injection runs — the team `--mcp-config` is then injected inline at launch
  // instead of being merged into a token-bearing root `.mcp.json` after the
  // fact. Used by team resurrect.
  teamId?: string;
  teamRole?: string;
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

// ── Detachable (tear-off) file tabs ─────────────────────────────────────
// plans/detachable-file-tabs-plan.md §4. A DetachRequest is the renderer→main
// payload when a file tab is dragged out of the strip onto empty desktop; main
// spawns a trusted, editable detached BrowserWindow that owns the file.

export interface DetachRequest {
  filePath: string;
  rootDirectory: string;
  pathType: PathType;
  workspaceId: string;
  label: string;
  x: number;   // screen coords (cursor at release)
  y: number;
}

// main→shell when a detached window closes, so the shell can re-add the tab
// from disk (the closing window saves/discards in-window before emitting this).
export interface DetachedClosedPayload {
  filePath: string;
  rootDirectory: string;
  pathType: PathType;
  workspaceId: string;
  label: string;
}

export interface DetachResult {
  ok: boolean;
  focusedExisting?: boolean;
  error?: string;
}

export const TAB_CHANNELS = {
  detach: 'tabs:detach',
  closed: 'tab-sync:closed',
  // Phase 2 dirty-on-close request/response:
  closeQuery: 'tab-sync:close-query',       // main → detached renderer (with requestId)
  closeReply: 'tab-sync:close-reply',       // detached renderer → main (invoke, returns decision)
} as const;

// ── Selection comments (WP-P5) ──────────────────────────────────────────
// plans/selection-to-agent-primitive-plan.md §5 (schema) / §7 WP-P5-A.
// Persisted file-target comments; chat/note targets keep the discriminator
// but have no columns or implementation until a slice builds them.

export type SelectionCommentTargetType = 'file' | 'chat-message' | 'note';

// A row is either a comment (has a body, can be sent to an agent) or a plain
// highlight (no body — just a persisted, painted marker over the quoted text).
// Both share the anchor/reattach machinery; the kind only changes how the
// gutter renders the row.
export type SelectionCommentKind = 'comment' | 'highlight';

export type SelectionCommentStatus =
  | 'draft'
  | 'queued'
  | 'sent'
  | 'send_failed'
  | 'needs-review'
  | 'resolved'
  | 'orphaned';

export interface SelectionComment {
  id: string;
  workspaceId: string;
  targetType: SelectionCommentTargetType;
  /** 'comment' (default) or 'highlight'. */
  kind: SelectionCommentKind;
  // File target columns (the only implemented target). Null for hypothetical
  // future chat/note rows.
  filePath: string | null;
  pathType: PathType | null;
  rootDirectory: string | null;
  // Reattach anchors (plan §7 WP-P5-B does the reattach; rows just carry them).
  docHash: string | null;
  anchorStart: number | null;
  anchorEnd: number | null;
  lineStart: number | null;
  lineEnd: number | null;
  prefix: string | null;
  suffix: string | null;
  quotedText: string;
  body: string;
  status: SelectionCommentStatus;
  sentToAgentId: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  resolvedAt: string | null;
}

export interface CreateSelectionCommentInput {
  workspaceId: string;
  /** Defaults to 'file' — the only target persisted in slice 2. */
  targetType?: SelectionCommentTargetType;
  /** Defaults to 'comment'. 'highlight' rows carry an empty body. */
  kind?: SelectionCommentKind;
  filePath: string;
  pathType?: PathType;
  rootDirectory?: string;
  docHash?: string;
  anchorStart?: number;
  anchorEnd?: number;
  lineStart?: number;
  lineEnd?: number;
  /** ~32 chars of context either side of the quote, for reattach. */
  prefix?: string;
  suffix?: string;
  quotedText: string;
  body: string;
}

export interface UpdateSelectionCommentInput {
  body?: string;
  quotedText?: string;
  /** Reattach bookkeeping ('orphaned'/'needs-review') is set through here. */
  status?: SelectionCommentStatus;
  docHash?: string | null;
  anchorStart?: number | null;
  anchorEnd?: number | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  prefix?: string | null;
  suffix?: string | null;
}

export type SelectionCommentSendTarget =
  | { kind: 'new' }
  | { kind: 'existing'; agentId: string };

export interface SendSelectionCommentsRequest {
  /** One or many comment ids; a multi-id send builds ONE numbered
   *  [SELECTION COMMENT] prompt (plan §4). All ids must share a file. */
  commentIds: string[];
  target: SelectionCommentSendTarget;
}

/** Result of `comments:send`. `ok: true` means the rows went `queued` and
 *  delivery is in flight in the main process (rows transition to
 *  `sent`/`send_failed` there; listen on `comments.onChanged`). All
 *  `ok: false` cases except 'launch-failed' are synchronous gates that left
 *  the rows untouched (still `draft`). 'agent-busy' carries the built prompt
 *  so the renderer can run the slice-1 prompt-staging fallback verbatim. */
export type SendSelectionCommentsResult =
  | { ok: true; agentId: string; launched: boolean }
  | { ok: false; code: 'agent-busy'; error: string; prompt: string }
  | { ok: false; code: 'agent-not-found' | 'comment-not-found' | 'invalid-request' | 'launch-failed'; error: string };

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
    /** WP0.2 (M1): per-launch bearer token for the dashboard HTTP API. */
    getApiToken: () => Promise<string>;
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
  /** WP-P5-A — persisted selection comments (file-target only). */
  comments: {
    create: (input: CreateSelectionCommentInput) => Promise<SelectionComment>;
    list: (workspaceId: string, filePath: string) => Promise<SelectionComment[]>;
    update: (id: string, updates: UpdateSelectionCommentInput) => Promise<SelectionComment | null>;
    delete: (id: string) => Promise<void>;
    resolve: (id: string) => Promise<SelectionComment | null>;
    send: (request: SendSelectionCommentsRequest) => Promise<SendSelectionCommentsResult>;
    /** Fired by main when async send transitions land (queued → sent /
     *  send_failed). Payload carries the fresh rows. */
    onChanged: (callback: (payload: { comments: SelectionComment[] }) => void) => () => void;
  };
  personas: {
    list: (workspacePath: string, pathType: PathType) => Promise<AgentPersona[]>;
    create: (workspacePath: string, pathType: PathType, name: string, customClaudeMd?: string) => Promise<AgentPersona>;
  };
  notebooks: {
    ensureServer: () => Promise<JupyterServerInfo>;
    listKernelspecs: () => Promise<KernelspecsResponse>;
  };
  /** WP1-A — embedded browser pane. FROZEN WP1 contract: payload shapes and
   *  channel names live in src/shared/browser.ts; WP1-B consumes this
   *  namespace. Changes require both workers + a plans-doc progress-log note. */
  browser: {
    createTab: (opts: BrowserCreateTabOptions) => Promise<{ tabId: string }>;
    closeTab: (tabId: string) => Promise<void>;
    navigate: (tabId: string, url: string) => Promise<void>;
    goBack: (tabId: string) => Promise<void>;
    goForward: (tabId: string) => Promise<void>;
    reload: (tabId: string) => Promise<void>;
    stop: (tabId: string) => Promise<void>;
    /** null = hide all views. */
    setActiveTab: (tabId: string | null) => Promise<void>;
    /** DIP, window-content-relative. */
    setBounds: (bounds: BrowserBounds) => Promise<void>;
    /** Pane suspension so renderer overlays aren't painted over. */
    setVisible: (visible: boolean) => Promise<void>;
    /** Per-workspace isolation: tell main which workspace the human is viewing
     *  so the tab strip / visibility / new-tab stamping scope to it. */
    setActiveWorkspace: (workspaceId: string | null) => Promise<void>;
    /** M12 coarse act-tier gate (dashboard-global runtime flag). Reads current
     *  state; the setter echoes the resulting state. Not persisted. */
    getActionsEnabled: () => Promise<boolean>;
    setActionsEnabled: (enabled: boolean) => Promise<boolean>;
    /** Slice 12: armed-state agent-actions gate (disabled | armed + armedUntil +
     *  lastChangedAt). getActionsState reads, setActionsState applies a popover
     *  command and echoes the resulting state, onActionsStateChanged streams flips
     *  AND auto-expiry. Not persisted. */
    getActionsState: () => Promise<AgentActionsState>;
    setActionsState: (cmd: AgentActionsCommand) => Promise<AgentActionsState>;
    onActionsStateChanged: (callback: (state: AgentActionsState) => void) => () => void;
    onTabState: (callback: (state: BrowserTabState) => void) => () => void;
    onOpenRequest: (callback: (request: BrowserOpenRequest) => void) => () => void;

    // ── Overhaul (WP0) — additive plumbing (frozen shapes in ./browser). ──────
    // Tab management (WP7) — main authoritative for order/pin/closed-tab stack.
    reorderTab: (tabId: string, toOrder: number) => Promise<void>;
    setTabPinned: (tabId: string, pinned: boolean) => Promise<void>;
    reopenClosedTab: () => Promise<{ tabId: string } | null>;
    // Slice 10/11 — session restore (PULL, idempotent → [] on a second call) +
    // idle-discard threshold setter (ms, or null = Never).
    sessionRestore: () => Promise<BrowserTabState[]>;
    setDiscardThreshold: (ms: number | null) => Promise<void>;
    // Find-in-page + zoom (WP5).
    findInPage: (
      tabId: string,
      text: string,
      opts?: { forward?: boolean; findNext?: boolean },
    ) => Promise<void>;
    stopFindInPage: (tabId: string) => Promise<void>;
    setZoom: (tabId: string, zoomFactor: number) => Promise<void>;
    // Native context menu (WP6) — renderer forwards coords; main pops the menu.
    contextMenuRequest: (tabId: string, params: BrowserContextMenuParams) => Promise<void>;
    // Bookmarks (WP3) — USER-PARTITION ONLY.
    bookmarkList: () => Promise<Bookmark[]>;
    bookmarkAdd: (input: { title: string; url: string }) => Promise<Bookmark>;
    bookmarkRemove: (id: string) => Promise<void>;
    // Slice-7 — edit title/favicon/folder; preserves id + sort order.
    bookmarkUpdate: (id: string, patch: BookmarkPatch) => Promise<Bookmark>;
    bookmarkReorder: (orderedIds: string[]) => Promise<void>;
    // Omnibox suggestions (Slice-6) — TRUSTED CHROME ONLY, USER-PARTITION sources.
    omniboxSuggest: (query: string) => Promise<OmniboxSuggestion[]>;
    // History (WP4) — USER-PARTITION ONLY.
    historyList: (query?: HistoryQuery) => Promise<HistoryEntry[]>;
    historyDelete: (id: string) => Promise<void>;
    historyClear: () => Promise<void>;
    /** Slice-8: most-visited user sites (consumed by the NTP in Slice-9). */
    historyTopSites: (limit?: number) => Promise<HistoryEntry[]>;
    // Event subscriptions (main → renderer); each returns an unsubscribe fn.
    onTabsSnapshot: (callback: (entries: BrowserTabSnapshotEntry[]) => void) => () => void;
    onShortcutCommand: (
      callback: (shortcut: BrowserShortcut, ctx: { tabId: string }) => void,
    ) => () => void;
    onFoundInPage: (callback: (result: BrowserFindResult) => void) => () => void;
    onContextMenuCommand: (
      callback: (action: string, params: BrowserContextMenuParams) => void,
    ) => () => void;
    onBookmarksChanged: (callback: (bookmarks: Bookmark[]) => void) => () => void;

    // ── Slice-3: denial toasts + live Activity/Audit drawer. TRUSTED CHROME. ───
    // auditRecent primes the drawer with the JSONL tail; onAuditEvent pushes
    // every fresh record. Both carry BrowserAuditEntry (never argsHash).
    auditRecent: (limit?: number) => Promise<BrowserAuditEntry[]>;
    onAuditEvent: (callback: (entry: BrowserAuditEntry) => void) => () => void;

    // ── Slice 12: handoff / session center. getSharedSessions returns the live
    //    handed tabs + persisted signed-in origins (with session-age + stale
    //    flags) for the "Sessions shared with agents" UI; onAgentDrivingRevoked
    //    streams the off-origin auto-revoke notification. Trusted chrome only. ───
    getSharedSessions: () => Promise<SharedAgentSessions>;
    onAgentDrivingRevoked: (callback: (payload: AgentDrivingRevoked) => void) => () => void;

    // ── Website-access policy (plans/website-allowlist-simplification.md) ──────
    // ONE agent allowlist; enforcement keyed to the Agent Actions toggle (no
    // per-list mode). Trusted shell chrome only. Mutations invalidate the
    // main-side access cache and emit `accessChanged`; request decisions also
    // emit `accessRequestsChanged`.
    access: {
      list: () => Promise<AccessRule[]>;
      add: (input: AccessRuleInput) => Promise<AccessRule>;
      update: (
        id: string,
        patch: Partial<AccessRuleInput> & { enabled?: boolean },
      ) => Promise<AccessRule>;
      remove: (id: string) => Promise<void>;
      onChanged: (callback: () => void) => () => void;
      // Agent-initiated requests (§18).
      requestList: () => Promise<AccessRequest[]>;
      requestDecide: (id: string, decision: AccessRequestDecision) => Promise<void>;
      onRequestsChanged: (callback: () => void) => () => void;
      // Authenticated-drive handoff IPCs (§14). Trusted-chrome only.
      handoffSignin: (ruleId: string) => Promise<AccessHandoffResult>;
      handoffReady: (tabId: string) => Promise<void>;
      tabHandToAgent: (tabId: string) => Promise<void>;
      tabReturnToHuman: (tabId: string) => Promise<void>;
      clearSiteSession: (ruleId: string) => Promise<void>;
    };
  };
  // Detachable (tear-off) file tabs — plans/detachable-file-tabs-plan.md §4.
  tabs: {
    detach: (req: DetachRequest) => Promise<DetachResult>;
    onDetachedClosed: (callback: (payload: DetachedClosedPayload) => void) => () => void;
    // Phase 2 dirty-on-close protocol — declared now, wired in Phase 2.
    onCloseQuery: (callback: (req: { requestId: string }) => void) => () => void;
    closeReply: (requestId: string, decision: 'save' | 'discard' | 'cancel') => Promise<void>;
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
