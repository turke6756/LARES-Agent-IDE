import type { SessionEvent, ChatEventBatch } from './session-events';
import type { PdfSelectionAnchorV1, SelectionAnchorType } from './pdf-annotations';
import type {
  AccessHandoffResult,
  AccessRequest,
  AccessRequestDecision,
  AccessRule,
  AccessRuleInput,
  AccessSiteStatus,
  AgentActionsCommand,
  AgentActionsState,
  AgentDrivingRevoked,
  Bookmark,
  BookmarkPatch,
  BrowserAuditEntry,
  BrowserBounds,
  BrowserContextMenuParams,
  BrowserCreateTabOptions,
  BrowserDownload,
  BrowserDownloadPrompt,
  BrowserFindOptions,
  BrowserFindResult,
  BrowserOpenRequest,
  BrowserShortcut,
  BrowserTabSnapshotEntry,
  BrowserTabState,
  HistoryEntry,
  HistoryQuery,
  OmniboxSuggestion,
  ReaderArticle,
  SharedAgentSessions,
  SigninPendingOpened,
  SigninResolved,
} from './browser';

export type PathType = 'windows' | 'wsl';
export type AgentProvider = 'claude' | 'gemini' | 'codex' | 'grok' | 'agy';

// Hardcoded first-class app role-lanes. 'researcher' is a third lane alongside
// 'supervisor' and 'worker' (browser-parity-and-capability-isolation §0); see
// roleLaneOf() in src/main/supervisor/index.ts for the flag→lane mapping.
export type AgentRoleLane = 'legacy' | 'supervisor' | 'worker' | 'researcher';

// Behavior-grounded optimizer confidence ladder (behavior-grounded-optimizer-design.md
// §6/§7.1). Ordered best→worst: `observed-safe` is the flagship "clean lane-level
// dead signal" tier, minted ONLY by attribution.ts (occurrence-classifier's local
// 3-tier ConfidenceTier lifts into this via evidence). The final proposal tier is
// `min(evidenceTier, attributionTier)` on this ladder — see attribution.ts.
export type BehaviorEvidenceTier = 'observed-safe' | 'observed' | 'inferred' | 'heuristic';

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

// ── Idle-agent lifecycle (plans/terminal-history-and-idle-agent-lifecycle-impl.md §B1) ──
//
// The stop engine's vocabulary. Defined once here so the main process, the IPC
// layer and the renderer all agree on what a stop reason / outcome / exclusion
// is. Several of these are consumed only by later legs (guards & eligibility,
// bulk stop, the stale-idle sweep, settings) — they are declared now so those
// legs never have to re-litigate the shape.

/** Why an agent was stopped. Persisted on the row (`last_stop_reason`) and
 *  surfaced as a card badge. NEVER a renderer input — the IPC handler assigns
 *  it per endpoint, so a renderer can't claim `automatic-stale-idle`,
 *  `supervisor`, `restart` or `terminal-capture-failure`. */
export type AgentStopReason =
  | 'supervisor'
  | 'manual-card'
  | 'manual-selection'
  | 'manual-stale-idle'
  | 'automatic-stale-idle'
  | 'restart'
  | 'terminal-capture-failure';

export const AGENT_STOP_REASONS: readonly AgentStopReason[] = [
  'supervisor',
  'manual-card',
  'manual-selection',
  'manual-stale-idle',
  'automatic-stale-idle',
  'restart',
  'terminal-capture-failure',
] as const;

/** `'explicit'` = the user named these agents (guards become warnings);
 *  `'stale-idle'` = the sweep/preview picked them (guards are fail-closed). */
export type StopEligibilityMode = 'explicit' | 'stale-idle';

export type StopExclusionCode =
  | 'not_idle'
  | 'threshold_not_met'
  | 'active_child'
  | 'active_orchestration'
  | 'pending_delivery'
  | 'human_attention'
  | 'browser_lease'
  | 'detached_process'
  | 'ownership_unverified'
  | 'lifecycle_busy'
  | 'guard_unavailable'
  | 'not_found';

export interface StopEligibility {
  agentId: string;
  eligible: boolean;
  exclusions: StopExclusionCode[];
  warnings: StopExclusionCode[];
  idleSince: string | null;
}

/** `'failed'` is the honest-failure outcome: the runner did not confirm exit
 *  AND verified termination could not confirm the tree is gone. The agent keeps
 *  its live status — the UI must never say "Stopped" while the process may
 *  still be running. */
export type StopOutcome = 'stopped' | 'already_stopped' | 'normalized' | 'failed' | 'not_found';

export interface StopResult {
  agentId: string;
  outcome: StopOutcome;
  killedRunner: boolean;
  reason: AgentStopReason;
}

/** reason is assigned main-side per endpoint — deliberately absent here. */
export interface BulkStopRequest {
  agentIds: string[];
  mode: StopEligibilityMode;
  confirmActive?: boolean;
}

export interface BulkStopItemResult {
  agentId: string;
  result: 'stopped' | 'skipped' | 'failed' | 'not_found';
  codes: StopExclusionCode[];
  outcome?: StopOutcome;
}

export interface BulkStopResult {
  items: BulkStopItemResult[];
}

export type AutoStopThreshold = 'never' | '6h' | '12h' | '24h' | '3d' | '7d';

export interface StaleIdlePreview {
  thresholdLabel: AutoStopThreshold;
  eligible: Array<{ agentId: string; idleSince: string }>;
  excluded: Array<{ agentId: string; codes: StopExclusionCode[] }>;
  estimatedReclaimBytes: number | null;
  /** true ⇔ every eligible agent had a resolved tree in the estimate; false ⇒
   *  `estimatedReclaimBytes` is a known-partial sum ("at least"); null ⇒ no
   *  estimate at all (estimator absent / attribution cold). */
  reclaimEstimateComplete: boolean | null;
}

export interface LifecycleSettings {
  autoStopIdleThreshold: AutoStopThreshold;
  // Terminal-log retention target — the on-disk budget below which the retention
  // sweep leaves managed logs alone. User-selectable enum; 'unlimited' disables
  // deletion (never observability). Validated INDEPENDENTLY of
  // autoStopIdleThreshold so a corrupt or absent value defaults this field
  // WITHOUT disturbing the sibling threshold.
  //
  // OPTIONAL at the type level so existing single-field `{ autoStopIdleThreshold }`
  // literals stay valid (additive boundary); loadLifecycleSettings /
  // saveLifecycleSettings ALWAYS populate it at runtime, so consumers reading a
  // loaded/saved value receive a concrete cap.
  logRetentionCap?: LogRetentionCap;
}

export const DEFAULT_LIFECYCLE_SETTINGS: LifecycleSettings = {
  autoStopIdleThreshold: '24h',
  logRetentionCap: '2gib',
};

// ── Terminal-log retention (locked shared types) ──
//
// Timestamps are ISO strings END-TO-END — no epoch/Date.parse conversion
// anywhere — so `reclaimedAt: NaN` is impossible. The reclaimed marker is the
// verbatim column value.

export type LogRetentionCap = '1gib' | '2gib' | '5gib' | 'unlimited';

export type HistoryNotice = null | { kind: 'retention-reclaimed'; reclaimedAt: string };

export interface LogRetentionState {
  lastFullScanAt: string | null;
  firstSweepNotice: { completedAt: string; agents: number; bytes: number; acknowledgedAt: string | null } | null;
}

export interface RetentionExecutionResult {
  agentId: string;
  outcome: 'removed' | 'partial' | 'no-files' | 'skipped';
  skipReason?: 'missing-row' | 'non-terminal' | 'live-runner' | 'invalid-path' | 'shared-reference' | 'runner-check-failed';
  removed: Array<{ path: string; bytes: number }>;
  failed: Array<{ path: string; code: string }>;
}

/** Minimum age (from newest managed file mtime) before a bundle is sweep-eligible. */
export const LOG_RETENTION_MIN_AGE_MS = 7 * 24 * 3600 * 1000;

/** Cap enum → bytes. Uses `2 ** 30`; 'unlimited' → +∞ (deletion disabled). */
export const LOG_RETENTION_CAP_BYTES: Record<LogRetentionCap, number> = {
  '1gib': 1 * 2 ** 30,
  '2gib': 2 * 2 ** 30,
  '5gib': 5 * 2 ** 30,
  unlimited: Number.POSITIVE_INFINITY,
};

// ── Context-gauge settings (user-configurable context-window warning caps) ──

/** The three fixed app role-lanes a gauge cap can be configured for. Custom
 *  personas get their own per-name entry in `ContextWindowCaps.personas`. */
export type ContextGaugeFixedRole = 'worker' | 'supervisor' | 'researcher';

/** The resolved per-agent role key the cap lookup uses: a fixed role, or
 *  `persona:<name>` for an agent launched from `.lares/agents/<name>/`. */
export type ContextGaugeRoleKey = ContextGaugeFixedRole | `persona:${string}`;

/** Per-role token counts at which the context gauge reads 100%. The effective
 *  cap for an agent is always `min(configured, real model window)` — a cap can
 *  narrow the gauge below the model's window, never widen it past it. */
export interface ContextWindowCaps {
  worker: number;
  supervisor: number;
  researcher: number;
  /** Custom personas by name (subdirectory under `.lares/agents/`). A persona
   *  with no entry falls back to the default cap, not to its lane's cap. */
  personas: Record<string, number>;
}

export interface ContextGaugeSettings {
  contextWindowCaps: ContextWindowCaps;
}

/** Hard cap on a single bulk-stop request (dedupe first, then cap). */
export const BULK_STOP_MAX = 200;

/** The statuses that may be written to `agents.status`. `receiving` is a
 *  PROJECTION-ONLY overlay (see AgentStatus) and must never be persisted —
 *  enforced by this type at compile time AND by a runtime throw in
 *  `applyStatusTransition`. */
export type PersistedAgentStatus = Exclude<AgentStatus, 'receiving'>;

const STOP_REASON_SET: ReadonlySet<string> = new Set<string>(AGENT_STOP_REASONS);

export function isAgentStopReason(v: unknown): v is AgentStopReason {
  return typeof v === 'string' && STOP_REASON_SET.has(v);
}

export function isStopEligibilityMode(v: unknown): v is StopEligibilityMode {
  return v === 'explicit' || v === 'stale-idle';
}

/** DB → TS boundary for `last_stop_reason`: an unknown/garbage value reads as
 *  null rather than leaking an unmapped string into the UI. */
export function parseStopReason(raw: string | null | undefined): AgentStopReason | null {
  return raw && isAgentStopReason(raw) ? raw : null;
}

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

// ── WP1 (G1): installation-owned snapshot launcher ──
/** `.lares/installation.json` — the workspace's pointer back to the Lares
 *  installation that manages it. Written at workspace registration and
 *  refreshed on every lane launch (the unconditional workspace-script refresh
 *  path); healed by full-payload comparison whenever any field other than
 *  `writtenAt` differs from the current installation. Consumed at runtime by
 *  `.lares/scripts/analytics-snapshot.mjs`, which spawns
 *  `invocation.command` with `invocation.argsPrefix + argv` (array args, no
 *  shell — spaces-in-path safe). */
export interface InstallationDescriptor {
  descriptorVersion: number;
  /** 'source' = dev checkout (command is the installation's Electron binary,
   *  argsPrefix carries the absolute dist CLI path); 'packaged' = installed
   *  build (command is the app binary, argsPrefix is ['--analytics-snapshot']). */
  mode: 'source' | 'packaged';
  invocation: {
    command: string;
    argsPrefix: string[];
  };
  installRoot: string;
  appVersion: string;
  /** WSL-spawnable form of `invocation.command` (e.g. /mnt/c/...), present on
   *  Windows installations so the shim works from inside a WSL distro. */
  wsl?: { commandWslPath: string };
  /** Diagnostic only — excluded from the heal comparison. */
  writtenAt: string;
}

// ── B2: Plans data layer ──
export type PlanFormat = 'html' | 'md' | string;

export interface Plan {
  id: string;            // stable uuid; never slug/path-derived (D-01)
  workspaceId: string;
  path: string;          // mutable; relative to workspace root, e.g. "plans/auth.html"
  slug: string | null;   // mutable display/lookup alias; never the PK
  format: PlanFormat;
  runState: string | null;   // nullable; populated later by the planning surface
  mtimeMs: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;  // soft-delete marker (D-05)
}

/** A plan row plus a cheap gallery snippet. Returned by `plans.list` for the
 *  card gallery: the snippet is the summary-zone prose (~160 chars), null when
 *  unavailable or for non-`html` (markdown-adopted) rows. */
export interface PlanListItem extends Plan {
  snippet: string | null;
}

// WP-P6B-query — live mission-board card DTOs. Package state is the structured
// SC-WP-3A value. Open-turn activity is separate and has no `done` value.
export type MissionBoardPackageState =
  | 'ready' | 'executing' | 'blocked' | 'done' | 'archived';

export interface MissionBoardTouch {
  path: string;
  op: string;
}

export type MissionBoardEvidenceAssociation = 'package-stamp' | 'planned-path';

export interface MissionBoardLiveActivity {
  turnId: string;
  workspaceId: string;
  turnSeq: number;
  agentId: string | null;
  taskLabel: string | null;
  startedAt: number | null;
  planId: string | null;
  planItemId: string | null;
  planStampSource: string | null;
  planStampStatus: 'verified' | 'unstamped' | 'unverified';
  touched: MissionBoardTouch[];
  association: MissionBoardEvidenceAssociation;
  /** Activity evidence only; never a package lifecycle/completion state. */
  isActive: boolean;
}

export interface MissionBoardDurableTurn {
  turnId: string;
  workspaceId: string;
  turnSeq: number;
  agentId: string | null;
  taskLabel: string | null;
  startedAt: number | null;
  endedAt: number | null;
  planId: string | null;
  planItemId: string | null;
  planStampSource: string | null;
  planStampStatus: 'verified' | 'unstamped' | 'unverified';
  touched: MissionBoardTouch[];
  association: MissionBoardEvidenceAssociation;
  diffStats: unknown | null;
  compactDiff: string | null;
  compactDiffProvenance: string | null;
}

export interface MissionBoardRecoveryOperation {
  operationId: string;
  workspaceId: string;
  kind: 'restore_paths' | 'revert_turn';
  actor: string;
  sourceTurnId: string | null;
  status: string;
  requestedPaths: unknown | null;
  completedPaths: unknown | null;
  result: string | null;
  failureReason: string | null;
  createdAt: number | null;
  endedAt: number | null;
  association: 'source-turn';
}

export interface MissionBoardPlannedPath {
  path: string;
  intentKind: string | null;
}

export interface MissionBoardCard {
  packageId: string;
  workspaceId: string;
  planId: string;
  title: string;
  acceptanceCondition: string | null;
  /** Verbatim `plan_work_packages.state`; never inferred from activity. */
  state: MissionBoardPackageState;
  assigneeAgentId: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  plannedPaths: MissionBoardPlannedPath[];
  /** Current open-turn evidence. This field can light a card, never complete it. */
  liveActivity: MissionBoardLiveActivity[];
  durableTurns: MissionBoardDurableTurn[];
  recoveryOperations: MissionBoardRecoveryOperation[];
}

// WP-P6D-timeline: the package history combines the non-terminal planning
// ledger with SC-owned finalizations. Only the finalization variant can carry
// `done`; consumers therefore never have to infer completion from activity.
export interface MissionBoardLifecycleTimelineEvent {
  source: 'lifecycle';
  eventId: string;
  packageId: string;
  occurredAt: number;
  fromState: string;
  toState: Exclude<MissionBoardPackageState, 'done'>;
  actor: string;
  reason: string | null;
}

export interface MissionBoardFinalizationTimelineEvent {
  source: 'finalization';
  eventId: string;
  packageId: string;
  occurredAt: number;
  toState: 'done';
  actor: string;
  packageRevision: number;
  checkpointTurnId: string | null;
  boundaryStatus: 'ready' | 'unavailable' | 'pruned';
  lifecycleStatus: 'active' | 'superseded' | 'committed';
}

export type MissionBoardTimelineEvent =
  | MissionBoardLifecycleTimelineEvent
  | MissionBoardFinalizationTimelineEvent;

export interface MissionBoardPackageTimeline {
  packageId: string;
  events: MissionBoardTimelineEvent[];
}

// WP-P7C: conservative file-level contribution evidence. These names avoid
// authorship language deliberately: a witnessed touch or linked commit supports
// contribution, never ownership of an exact line.
export type BlameIntentConfidence = 'high' | 'medium' | 'low';

export interface BlameIntentPlanRef {
  id: string;
  path: string;
  slug: string | null;
}

export interface BlameIntentContributor {
  turnId: string;
  agentId: string | null;
  taskLabel: string | null;
  plan: BlameIntentPlanRef | null;
  confidence: BlameIntentConfidence;
  evidence: 'blamed-commit-exact-path' | 'blamed-commit' | 'turn-witness';
  commitOids: string[];
  /** True for all blame-ledger evidence: mixed-path commits remain commit-level. */
  commitLevelOnly: boolean;
}

export interface BlameToIntentRequest {
  workspaceId: string;
  /** Workspace-relative POSIX path. File-level only in v1. */
  path: string;
}

export interface BlameToIntentResult {
  workspaceId: string;
  path: string;
  confidence: BlameIntentConfidence | null;
  contributors: BlameIntentContributor[];
  conflictingContributors: BlameIntentContributor[];
  ledgerStrengthening: 'applied' | 'unavailable' | 'no-linked-commits';
  /** Stable UI framing; consumers must not substitute line-authorship language. */
  framing: 'These plans and turns contributed to this file.';
  warnings: string[];
}

// ── WP-P2L-proj — planning-intent ledger read model ─────────────────────────

export type PlanIntentStatus = 'active' | 'withdrawn' | 'superseded';
export type PlanIntentRung = 'marked' | 'ran' | 'returned' | 'folded-in';
export type PlanIntentRunState = 'dispatched' | 'running' | 'returned' | 'abandoned';

export interface PlanIntentOutputProjection {
  relPath: string;
  orchestrationId: string | null;
  presentOnDisk: boolean;
  disposition: 'active' | 'superseded' | 'withdrawn';
  foldedIn: boolean;
}

export interface PlanIntentRunProjection {
  orchestrationId: string;
  state: PlanIntentRunState;
  /** Raw server-witnessed orchestration status, retained for diagnostics. */
  orchestrationStatus: string;
  returnedOutputExists: boolean;
}

export interface PlanIntentProjection {
  intentId: string;
  status: PlanIntentStatus;
  withdrawn: boolean;
  superseded: boolean;
  rung: PlanIntentRung;
  integrationNote: string | null;
  /** True only when the composite plan/intent orchestration join finds a row. */
  ran: boolean;
  runs: PlanIntentRunProjection[];
  returned: boolean;
  fullyFoldedIn: boolean;
  open: boolean;
  /** Historical output rows remain independent; missing rows are never collapsed. */
  outputs: PlanIntentOutputProjection[];
}

export interface PlanIntentConfidenceProjection {
  markedIntents: number;
  satisfiedIntents: number;
  openIntents: number;
  deliberationsRun: number;
  finalPlanExists: boolean;
}

/** Mid-altitude, read-only planning confidence projection. Every value is derived
 * from the ledger, the orchestration join, or a current disk observation. */
export interface PlanIntentsProjection {
  planId: string;
  intents: PlanIntentProjection[];
  confidence: PlanIntentConfidenceProjection;
}

// ── WP-P3C′ — proposal-promotion IPC result contracts (§P3-GAP) ───────────────
// The renderer-facing shape of `proposal:promote`. A discriminated union over the
// two ACCEPTED outcomes the Promote dialog must transition between: an already
// -adopted plan (return the plan directly), or a promotion still in flight (the
// dialog then polls `proposal:promotionStatus` until the plan surfaces). The
// rejecting outcomes (non-supervisor, duplicate, foreign, launch-failed) are NOT
// members — they are surfaced as a thrown IPC error, never a silent status. There
// is NO document-selection field anywhere (§P3-GAP: the Promote dialog is a
// supervisor picker only).
export type PromoteProposalResult =
  | { status: 'adopted'; plan: Plan }
  | { status: 'promotion-pending'; promotionRequestId: string; planArtifactId: string };

/** The renderer-facing shape of `proposal:promotionStatus` — a runtime read over
 *  the durable `promotion_requests` row (+ the adopted `plans` row when present),
 *  NOT a private durable skill format. The Promote dialog polls this after a
 *  `promotion-pending` result, transitioning to the plan once `state==='adopted'`
 *  surfaces a non-null `plan`. */
export interface PromotionStatus {
  promotionRequestId: string;
  /** The durable request state — mirrors `promotion_requests.state`. */
  state: 'pending' | 'adopted' | 'failed';
  planArtifactId: string;
  /** The adopted plan row, present ONLY once enrichment has flipped the request to
   *  `adopted` and the `plans` row exists; null while pending/failed. */
  plan: Plan | null;
  /** Mirrors `promotion_requests.failure_reason` — non-null only when `failed`. */
  failureReason: string | null;
  /** Mirrors `promotion_requests.attempt_count`. */
  attemptCount: number;
}

export interface SupervisorFocus {
  supervisorId: string;
  planId: string;
  focusedAt: string;
  lastAttendedAt: string;
  notes: string | null;
  plan?: Plan;           // joined projection on GET (includes deletedAt for "[deleted]" UI)
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
  // .lares/workers/<provider>/, gets the turn-boundary hook scaffold, and has
  // PTY inference + chat-event status disabled — but unlike isSupervised it does
  // NOT notify a supervisor. isSupervised implies the worker lane; isWorker alone
  // is the default for user-launched claude/codex agents.
  isWorker: boolean;
  // Researcher role-lane (browser-parity-and-capability-isolation §0, D-1). A
  // third first-class hardcoded app lane alongside supervisor/worker: scaffolded
  // into .lares/researcher, browser MCP wired in, native dangerous tools
  // (Bash/Edit/NotebookEdit) withheld. Mutually exclusive with the other lanes.
  isResearcher: boolean;
  // Persona privilege lane (#19 supervisor-tools-for-personas). A persona that
  // declares the 'supervisor' lane is NOT the structural workspace supervisor:
  // isSupervisor stays false so it renders as its own card under
  // .lares/agents/<name>/. This field ONLY grants the supervisor-tier MCP
  // toolset, via roleLaneOf (which prefers it). Persisted so the grant survives
  // relaunch (the MCP-injection sites read the persisted record, not the launch
  // input). Only 'supervisor' exists — researcher/worker already render as cards
  // through their own flags, so they need no privilege-lane decoupling.
  privilegeLane?: 'supervisor';
  // Bug 2 / Edit 2.6 — codex-persona hook parity. True when this agent was
  // launched with the dashboard codex hook profile (provider==='codex' AND
  // worker-lane OR a persona). Persisted so the runner's hook-env gate
  // (roleLaneOf(agent) !== 'legacy' || isCodexHookPersona(agent)) is
  // re-derivable from the stored row on reconcile/respawn — a *pure* codex
  // persona is roleLaneOf==='legacy', so without this flag it would relaunch
  // hookless (no AGENT_ID → the codex hook script bails at `if (!agentId)`).
  wantsCodexHooks?: boolean;
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
  /** WP2 (hook-absence-resilience) — DERIVED from hookStatus, non-persisted.
   *  True when the status-hook transport is unavailable for this agent — either
   *  the launch canary proved it dead ('broken') or the command could not be
   *  instrumented ('degraded'). Drives the card badge and degraded-mode
   *  fallbacks. NOT a database authority — always projected from hook_status via
   *  deriveHookAvailability(); never written directly. */
  hooksUnavailable?: boolean;
  hooksUnavailableReason?: 'canary-timeout' | 'instrumentation-unavailable';
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
  /** WP5 (hook-absence-resilience) — the three-state outcome of the most recent
   *  submit to this agent. Supersedes `lastSendError` as consumers migrate: a
   *  `failed` or `delivered-unconfirmed` outcome is the surface pollers
   *  (MCP/HTTP/GroupThink) read to see a swallowed delivery/confirmation gap, and
   *  a later `confirmed` outcome supersedes an earlier `delivered-unconfirmed`
   *  (UI upgrade, never a re-send). Persisted; projected via rowToAgent. */
  lastSend?: SendOutcome | null;
  isAttached: boolean;
  restartCount: number;
  /** Inc 4: continuation handoff generation — bumped only by the atomic
   *  continuation-relaunch transaction; crash restarts use restartCount.
   *  Optional so partial Agent fixtures stay valid; absent ⇒ 0. */
  continuationGeneration?: number;
  /** Per-agent continuation toggle (Edward 2026-07-05). true (default) = the
   *  continuation watcher may open a handoff attempt for this agent; false = the
   *  watcher's `continuation-disabled` blocker holds it back. Optional so partial
   *  Agent fixtures stay valid; absent ⇒ enabled. Serialized into every agent
   *  payload reaching the renderer via rowToAgent. */
  continuationEnabled?: boolean;
  lastExitCode: number | null;
  pid: number | null;
  logPath: string | null;
  templateId: string | null;
  systemPrompt: string | null;
  createdAt: string;
  updatedAt: string;
  lastOutputAt: string | null;
  lastAttachedAt: string | null;
  // Agent-ownership primitive: the launcher of this child agent. The child's
  // lifecycle events resolve to this owner (via getOwnerForWorker) before
  // falling back to the structural workspace supervisor. NULL for
  // dashboard-internal / unowned launches.
  ownerAgentId: string | null;
  // notifyOwner mute: DECOUPLES ownership from lifecycle-event subscription.
  // undefined/true = owner-directed lifecycle events are delivered (default,
  // preserves all prior behavior); false = the agent stays OWNED (ownerAgentId
  // intact, grouping + investigation authority preserved) but its owner-directed
  // events are SUPPRESSED at the EventBridge choke point. The terminal-owner
  // structural backstop is NOT muted — see EventBridge.recipientFor.
  notifyOwner?: boolean;
  // Planning surface WP1: frozen-at-launch plan rail. planId references an
  // existing plans row; planSection is the target section anchor the launcher
  // bound this agent to. NULL for unbound launches. Injected into the agent env
  // (AGENT_DASHBOARD_PLAN_ID / _PLAN_SECTION) at both the extraEnv and WSL sites.
  planId?: string | null;
  planSection?: string | null;
  // ── Idle-agent lifecycle bookkeeping (§B2/§B3.1) ──
  /** When `status` last CHANGED (not merely when the row was touched).
   *  Informational/diagnostic ONLY — never an eligibility clock. Non-null at
   *  this boundary (coalesced from `updated_at ?? created_at` on read). */
  statusChangedAt?: string;
  /** When the agent entered `idle`, or null if it is not idle. THE sole
   *  stale-idle eligibility clock. Preserved across idle→idle writes, cleared
   *  the moment the agent leaves idle. */
  idleSince?: string | null;
  /** When the last real stop landed (a transition carrying a stop reason). */
  stoppedAt?: string | null;
  /** Why the last real stop happened; null when never stopped or unmapped. */
  lastStopReason?: AgentStopReason | null;
  // ── Terminal-log retention ──
  /** ISO timestamp when this agent's terminal history was reclaimed to free disk
   *  space, else null. Written once (idempotent; first non-null value preserved)
   *  and SURVIVES revival — the marker is the sole authority for the
   *  history-reclaimed disclosure. NEVER an eligibility clock.
   *
   *  OPTIONAL at the type level so existing full-Agent fixtures stay valid —
   *  WP-1's rollback boundary is additive-only, and a required property would be
   *  a breaking change to a widely-constructed interface. rowToAgent ALWAYS
   *  populates it (NULL→null), so every DB-sourced Agent carries a concrete
   *  `string | null`; the downstream notice accessor guards for a non-empty
   *  string, tolerating an absent field on a hand-built fixture. */
  terminalHistoryReclaimedAt?: string | null;
}

/** WP5 (hook-absence-resilience) — the unified three-state disposition of a
 *  submit. `confirmed`: a turn provably started (hook, session-log turn, or a
 *  `working` status flip). `delivered-unconfirmed`: the runner accepted the
 *  bytes but no start evidence arrived before the confirmation deadline — this
 *  is NOT a failure (a hookless provider can start a turn invisibly), so it must
 *  never be rendered as "Send failed". `failed`: no runner accepted the bytes,
 *  or a provider-specific preflight rejected a blocking interactive screen
 *  before delivery, so nothing was typed. Hook absence must NEVER be converted
 *  into `failed`. */
export type SendDisposition = 'confirmed' | 'delivered-unconfirmed' | 'failed';

export interface SendOutcome {
  disposition: SendDisposition;
  agentId: string;
  /** True when the runner accepted the bytes (delivered-unconfirmed + confirmed);
   *  false only for `failed` (including a pre-delivery prompt guard). */
  delivered: boolean;
  /** Which independent evidence source proved the turn started (confirmed only). */
  confirmationSource?: 'hook' | 'session-log' | 'status';
  reason?: 'delivery-failed' | 'confirmation-timeout' | 'interactive-prompt';
  /** Populated when the WP4 PTY classifier recognized a blocking prompt on a
   *  `delivered-unconfirmed` outcome or a provider-specific pre-delivery guard,
   *  so surfaces can name what the terminal is waiting on. */
  prompt?: { kind: string; label: string; excerpt: string };
  completedAt: number;
}

/** Supervisor-privilege predicate — the single source of truth for "this agent
 *  gets supervisor-tier treatment" across the continuation pipeline, the
 *  X-Supervisor-Id identity rail, and the renderer controls. An agent qualifies
 *  when it is the structural workspace supervisor (`isSupervisor`) OR a custom
 *  persona launched on the 'supervisor' PRIVILEGE lane (#19 — `isSupervisor`
 *  stays false so it renders as its own card, but roleLaneOf still grants it the
 *  supervisor MCP toolset). Kept as one shared function so the predicate cannot
 *  drift between the ~half-dozen gate sites that must agree on it. */
export function hasSupervisorPrivilege(a: { isSupervisor?: boolean; privilegeLane?: 'supervisor' }): boolean {
  return a.isSupervisor === true || a.privilegeLane === 'supervisor';
}

/** WP2 (hook-absence-resilience) — project the DERIVED, non-persisted
 *  `hooksUnavailable` / `hooksUnavailableReason` DTO fields from the persisted
 *  `hook_status` (the sole authority — no new column). Both `'broken'` (launch
 *  canary expired with no hook) and `'degraded'` (command couldn't be
 *  instrumented) count as unavailable for UI/fallback purposes; the distinct
 *  reason keeps the card tooltip accurate. Called at every Agent projection so
 *  cards, list endpoints, and fallbacks all agree. */
export function deriveHookAvailability(
  hookStatus: Agent['hookStatus'] | null | undefined,
): { hooksUnavailable: boolean; hooksUnavailableReason?: 'canary-timeout' | 'instrumentation-unavailable' } {
  if (hookStatus === 'broken') return { hooksUnavailable: true, hooksUnavailableReason: 'canary-timeout' };
  if (hookStatus === 'degraded') return { hooksUnavailable: true, hooksUnavailableReason: 'instrumentation-unavailable' };
  return { hooksUnavailable: false, hooksUnavailableReason: undefined };
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
  /** Context-brick Phase 4 — the session/generation this activity was stamped
   *  under, so the UI can partition current vs prior session. `sessionId` is the
   *  true partition key (a `/clear` can mint a same-generation sibling);
   *  `generation` is a display label only. `sessionId` is null for legacy rows
   *  written before the migration. */
  generation: number;
  sessionId: string | null;
}

/** Context-brick Phase 1 — one row per (dashboard agent, session) in the
 *  durable session lineage. One dashboard agent id spans many sessions across
 *  continuations and `/clear` rotations; this table is the durable map from an
 *  agent id to its ordered generations→session ids.
 *
 *  Keyed UNIQUE(dashboardAgentId, sessionId) — NOT generation. `generation` is
 *  an ordering HINT that may legitimately REPEAT (a `/clear` rotation mints a
 *  new session WITHOUT bumping the generation), so it is never a partition or
 *  identity key. Order lineage by `startedAt` then row `id`; partition current
 *  vs prior by `sessionId`. `workingDirectory` exists ONLY to recompute the
 *  JSONL slug — never an identity key (many agents share one cwd/slug). */
export interface AgentSessionRow {
  id: number;
  dashboardAgentId: string;
  generation: number;
  sessionId: string;
  workingDirectory: string;
  provider: AgentProvider;
  startedAt: string;
  endedAt: string | null;
  /** best-effort: 1 present, 0 pruned, NULL unknown (backfilled rows). */
  jsonlPresent: number | null;
}

/** Context-brick Phase 2 — the result of reading a *prior* session's structured
 *  chat from disk (read-only, explicitly out of the current context window).
 *  Never thrown: a pruned/missing JSONL degrades to `unavailable`, and the head
 *  of the lineage (no earlier session) degrades to `atHead`. Identity is stamped
 *  per-SESSION (`sessionId`) — `generation` is only an informational label that
 *  may repeat across a `/clear`, so it is never used to disambiguate. */
export type PriorSessionChat =
  | {
      sessionRowId: number;
      sessionId: string;
      generation: number;
      startedAt: string;
      endedAt: string | null;
      outOfContext: true;
      events: SessionEvent[];
    }
  | { sessionRowId: number; sessionId: string; unavailable: true }
  | { atHead: true };

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
  // Launch class (plans/cross-workspace-collaboration.md WP4). 'worker' (the
  // default) is today's behavior exactly — the owner-edge / lane derivation below
  // is unchanged. 'supervisor-peer' creates a TOP-LEVEL supervisor with NO owner
  // edge (a peer, not a child): launchAgent canonicalizes it BEFORE lane/cwd
  // derivation (forces isSupervisor, clears isSupervised/isWorker/ownerAgentId)
  // and rejects a researcher/persona combination with `peer-mode-incompatible`.
  // Foreign-workspace launches are permitted ONLY in this mode, supervisor-gated
  // at the route; the MCP `launch_agent` tool exposes it as `mode`, and never
  // exposes a caller-controlled ownerAgentId.
  launchMode?: 'worker' | 'supervisor-peer';
  // Persona privilege lane (#19). Set by applyPersonaLaneToLaunchInput when a
  // persona declares the 'supervisor' lane: grants the supervisor MCP toolset
  // WITHOUT the structural supervisor role (isSupervisor stays false). Persisted
  // onto the agent record so the grant survives relaunch.
  privilegeLane?: 'supervisor';
  // Agent-ownership primitive: the launcher of this child. Set only by a TRUSTED
  // dashboard path (MCP authenticated caller identity / the §4.1-validated
  // AGENT_DASHBOARD_SELF_ID forwarded over POST /api/agents), never by a blindly
  // trusted caller field. launchAgent re-validates it (exists + same workspace +
  // non-terminal) and drops the edge with a warning if invalid (never throws).
  ownerAgentId?: string;
  // notifyOwner mute (default true). When false, the launched agent stays owned
  // but its owner-directed lifecycle events are suppressed. Threaded through
  // launchAgent → createAgent and inherited by forkAgent from its source.
  notifyOwner?: boolean;
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
  // WP3 (codex-groupthink-reliability-hardening): per-launch codex
  // session-discovery tiebreaker, matched against `threads.first_user_message`
  // in ~/.codex/state_5.sqlite. Explicit prefix of the first user message the
  // launcher will submit; lets discovery bind the right rollout when several
  // concurrent same-cwd codex sessions exist. Ignored for non-codex providers.
  firstUserMessagePrefix?: string;
  // WP-A.2 (browser-parity-and-capability-isolation F9): when launching an
  // agent that should join a team immediately, pass the team id (+ optional
  // role) so `launchAgent` records the membership BEFORE the per-launch MCP
  // injection runs — the team `--mcp-config` is then injected inline at launch
  // instead of being merged into a token-bearing root `.mcp.json` after the
  // fact. Used by team resurrect.
  teamId?: string;
  teamRole?: string;
  // Planning surface WP1 (planning-surface-master-implementation.md §3): optional
  // launch rail binding this agent to a plan surface and a specific section anchor.
  // Frozen at launch onto the agent row (agents.plan_id / agents.plan_section) and
  // injected into the agent env (AGENT_DASHBOARD_PLAN_ID / _PLAN_SECTION) at BOTH
  // the extraEnv and WSL wslEnvPrefix sites. planId must reference an existing
  // plans row — the launch route rejects an unknown plan_id with 400.
  planId?: string;
  planSection?: string;
}

/** A declarable persona lane — every value of AgentRoleLane except 'legacy'
 *  (a declared lane can never be the no-lane default). #18 / D7. */
export type PersonaLane = Exclude<AgentRoleLane, 'legacy'>; // 'supervisor' | 'worker' | 'researcher'

export interface AgentPersona {
  name: string;          // subdirectory name, e.g. "researcher"
  directory: string;     // full path to the persona directory
  hasMemory: boolean;    // whether memory/MEMORY.md exists
  isSupervisor: boolean; // true if name matches SUPERVISOR_AGENT_NAME
  lane?: PersonaLane;    // declared in .lares/agents/<name>/persona.json (#18)
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

/** How badly a missing prerequisite hurts. The tiers are a promise to the user
 *  as much as a data field — the first-run UI groups by them, so getting one
 *  wrong is how "you're missing Git" turns into "this app is broken".
 *
 *  - `agent-cli`     at least ONE of claude/codex/gemini is needed to launch
 *                    agents. Never all three; no surface may imply otherwise.
 *  - `wsl-feature`   only matters for WSL-backed workspaces / persistent
 *                    WSL terminals.
 *  - `optional`      feature-dependent. Git, Python and an external Node all
 *                    live here: Lares opens ordinary directories fine without
 *                    them, and Phase 3 means Lares's own helpers no longer
 *                    need a system Node at all. */
export type PrerequisiteTier = 'agent-cli' | 'wsl-feature' | 'optional';

export type PrerequisiteStatus =
  /** Found, and at the path a launch would actually use. */
  | 'available'
  /** Looked for it properly and it isn't there. */
  | 'missing'
  /** Present but not running (WSL specifically). */
  | 'stopped'
  /** Deliberately not probed — e.g. WSL internals with no WSL workspace.
   *  Distinct from `missing`: we do NOT know, and must not claim to. */
  | 'not-checked';

// ── Git-Native capability DTOs (WP-G0.1) ─────────────────────────────────────
// Pure types, renderer-safe. Two INDEPENDENT resolutions (agent-shell PATH-first
// vs Lares-internal) plus the probed repo capability. Protected-root is a
// boolean flag carried ALONGSIDE the underlying `reason` — never a reason value;
// WP-G0.3 and WP-G1.3a gate on the boolean.
export type GitSource = 'system' | 'bundled';
export type GitRepoState =
  'repo' | 'non-repo' | 'unborn' | 'nested' | 'spans-boundary' | 'unsupported-wsl';
export type GitCapabilityReason =
  'ok' | 'missing' | 'too-old' | 'unsafe-directory' | 'broken' | 'timeout'
  | 'unsupported-layout' | 'unsupported-path';   // protected-root is a boolean flag, NOT a reason
export interface GitResolution {                 // two independent resolutions
  agentShell: { source: GitSource | null; note: string };  // PTY resolves PATH-first, bundled appended
  internal:   { source: GitSource; execPath: string;
                semver: { major: number; minor: number; patch: number } } | null;
}
export interface GitCapability {
  resolution: GitResolution;
  repoState: GitRepoState | null;
  commonDir: string | null;          // CANONICAL real path (diagnostics + git ops)
  commonDirQueueKey: string | null;  // case-folded on Windows — serialization key ONLY
  repoRoot: string | null;
  workspacePrefix: string | null;    // '' when workspace === repoRoot; POSIX, top-anchored
  protectedRoot: boolean;            // agenda §8 — set alongside the underlying reason
  reason: GitCapabilityReason;
  detail: string | null;             // human-actionable
}

export interface PrerequisiteCheck {
  id: string;
  label: string;
  status: PrerequisiteStatus;
  tier: PrerequisiteTier;
  /** Absolute path the launcher resolved, when we have one. */
  path?: string;
  version?: string;
  /** What does NOT work while this is missing. Plain language, user-facing. */
  impact: string;
  /** What to do about it. Plain language, user-facing. */
  remediation: string;
  docsUrl?: string;
  installCommand?: string;
  installShell?: string;
  altCommand?: string;
  /** Caveat for `installCommand` itself (e.g. "requires Node.js"). */
  installNote?: string;
  /** Date `installCommand` was last checked; rendered so staleness is visible. */
  verifiedOn?: string;
  /** Diagnostic detail (a timeout, a probe error). Never the whole story. */
  detail?: string;
  /** Git-Native (WP-G0.1): the richer git capability state. The `status` field
   *  above still drives the row; this carries resolution/repo/protected-root
   *  detail. Populated only for the git optional-tool check. */
  git?: GitCapability;
}

export interface RuntimePrerequisiteReport {
  appVersion: string;
  checkedAt: number;
  /** claude / codex / gemini, always all three, always independent entries. */
  providers: PrerequisiteCheck[];
  /** True when AT LEAST ONE provider resolved. The single flag the UI should
   *  branch on for "can this user launch an agent at all". */
  anyProviderAvailable: boolean;
  /** Feature-dependent tools. Never gates startup. */
  optional: PrerequisiteCheck[];
  /** WSL and everything inside it. Entries are `not-checked` unless the user
   *  actually has a WSL workspace — probing WSL on a Windows-only machine can
   *  raise Windows' "install WSL" dialog (regression guard for 8eaa103). */
  wsl: PrerequisiteCheck[];
  /** Whether the WSL group was probed at all. */
  wslChecked: boolean;
  wslStatus: WslStatus;
}

/** The original startup health shape, kept because the Sidebar ticker and the
 *  store both read it. It is now DERIVED from the same detector that produces
 *  RuntimePrerequisiteReport (see main/runtime-prerequisites.ts) rather than
 *  doing its own PATH lookup, so the ticker and the first-run dialog cannot
 *  contradict each other. */
export interface HealthCheck {
  wslAvailable: boolean;
  tmuxAvailable: boolean;
  claudeWindowsAvailable: boolean;
  claudeWslAvailable: boolean;
  wslStatus: WslStatus;
  /** The full report the legacy booleans were derived from. Optional so old
   *  consumers and tests constructing a bare HealthCheck still compile. */
  prerequisites?: RuntimePrerequisiteReport;
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
  /** Device id + inode — stable file identity across a same-volume rename
   *  (B2 D1: rename correlation). Undefined when unavailable. */
  dev?: number;
  ino?: number;
}

export type FsEvent =
  | { type: 'add'; path: string; parentDir: string; isDirectory: boolean; size: number; mtimeMs?: number; dev?: number; ino?: number }
  | { type: 'unlink'; path: string; parentDir: string }
  | { type: 'change'; path: string; parentDir: string; mtimeMs?: number; dev?: number; ino?: number };

export interface FileContent {
  path: string;
  content: string;
  encoding: string;
  size: number;
  error?: string;
  contentKind?: 'text' | 'html';
  warnings?: string[];
}

export type FileMutationResult =
  | { ok: true; path?: string }
  | { ok: false; error: string };

// ── Conditional writes (edit-loss plan §4.1, R6) ────────────────────────────
// Dedicated result type for `files:write` ONLY — the general FileMutationResult
// above stays untouched for every other file mutation. `expectedHash` on the
// write is a compare-and-swap guard: the writer reads the current file, hashes
// it with the shared contentHash (src/shared/content-hash.ts), and refuses to
// write on a mismatch, returning the fresh disk bytes so the renderer can
// raise the external-change banner without a second read.

export type WriteErrorCode = 'too-large' | 'permission' | 'not-found' | 'io';

export type ConditionalWriteResult =
  | { ok: true; path: string }
  | { ok: false; conflict: true; freshContent: string }
  | { ok: false; conflict?: false; error: string; code?: WriteErrorCode };

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
  filePath: string;        // empty string for directory-only AND tool tabs
  rootDirectory: string;   // tree root (agent workingDirectory or workspace path); empty for tool tabs
  pathType: PathType;
  agentId?: string;
  workspaceId?: string;    // scopes the tab to a workspace; unset for legacy/orphan tabs
  label: string;           // display name (filename or dirname/)
  kind?: 'file' | 'directory' | 'tool' | 'plan';  // default 'file' when undefined
  toolId?: string;         // set when kind==='tool' (e.g. 'context-overhead')
  planId?: string;         // set when kind==='plan' — the plan surface this tab renders
  // Per-tab tool params (base plan §3.5). Part of the tool-tab dedup key, so a
  // per-agent tool (e.g. agent-knowledge-graph with { agentId }) opens one tab
  // per distinct params instead of collapsing into a single shared tab.
  params?: Record<string, string>;
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
  // Edit-loss §4.3 close-flush handshake (main-window/app close):
  flushRequest: 'tab-sync:flush-request',   // main → every editing renderer (with requestId)
  flushReply: 'tab-sync:flush-reply',       // renderer → main (invoke, carries FlushResult[])
} as const;

// ── Close-flush handshake (edit-loss plan §4.3) ─────────────────────────
// Main-window/app close must never silently discard dirty editor tabs: main
// intercepts the close, asks every relevant renderer (the main window AND
// every detached file window) to flush via saveCoordinator.flushAll, and only
// closes once every outcome is saved/pristine — anything else raises a native
// dialog (Keep waiting / Overwrite anyway / Discard and close / Cancel).

export interface FlushRequestPayload {
  requestId: string;
  /** How long the renderer may spend before reporting 'timeout' per tab. */
  deadlineMs: number;
  /** 'flush' = every editing tab; 'retry' = re-save the listed tabs;
   *  'force' = unconditional re-save of CONFLICT tabs only (the dialog's
   *  explicitly labeled "Overwrite anyway"). */
  action: 'flush' | 'retry' | 'force';
  tabIds?: string[];
}

export interface FlushResult {
  tabId: string;
  /** basename, for the close dialog */
  fileName: string;
  outcome: 'saved' | 'pristine' | 'conflict' | 'error' | 'timeout';
  error?: string;
}

export interface FlushReplyPayload {
  requestId: string;
  results: FlushResult[];
}

// ── Detachable (tear-off) top-level VIEWS ───────────────────────────────
// A sibling of the file-tab tear-off (above): the whole center VIEW (the
// Dashboard grid, etc.) is dragged out of the shell header into its own OS
// window. Unlike a file tab there is nothing to save, so there is NO
// dirty-on-close protocol — the window closes immediately and main fires
// VIEW_CHANNELS.closed so the shell un-hollows the button and re-activates the
// view. Ownership is keyed by the view id ('view:dashboard') so at most one
// window exists per view; a duplicate detach focuses the existing one.
//
// v1 ships Dashboard only. `files`/`browser`/`plans` are reserved in the union
// so the registry/IPC/type surface is forward-compatible, but their buttons are
// left non-draggable (see MainContent.tsx and the patch summary for why).
export type DetachableView = 'dashboard' | 'files' | 'browser' | 'plans';

export interface ViewDetachRequest {
  view: DetachableView;
  workspaceId: string;   // the view pins to the workspace it was detached from (v1)
  label: string;         // window title (workspace title, for context)
  x: number;             // screen coords (cursor at release)
  y: number;
}

// main→shell when a detached view window closes, so the shell un-hollows the
// button and makes the view activatable again.
export interface ViewDetachedClosedPayload {
  view: DetachableView;
  workspaceId: string;
}

export const VIEW_CHANNELS = {
  detach: 'view:detach',   // shell → main (invoke, returns DetachResult)
  closed: 'view:closed',   // main → shell when the detached view window closes
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
  /** 'text' (markdown/plaintext, the default for every legacy row) or 'pdf'
   *  (page/coordinate anchor carried in `pdfAnchor`). See plan Part 1.3/1.5. */
  anchorType: SelectionAnchorType;
  /** Durable PDF anchor; null for text comments and for malformed stored JSON
   *  (parsed defensively in `rowToSelectionComment`). */
  pdfAnchor: PdfSelectionAnchorV1 | null;
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
  /** Defaults to 'text' so every existing markdown caller is unchanged. Pass
   *  'pdf' with a `pdfAnchor` to persist a PDF page/coordinate anchor. */
  anchorType?: SelectionAnchorType;
  pdfAnchor?: PdfSelectionAnchorV1 | null;
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
  /** Repoint a comment at a new PDF anchor (reattach ladder writes these). Pass
   *  'text'/null to clear a PDF anchor; omit to leave the anchor untouched. */
  anchorType?: SelectionAnchorType;
  pdfAnchor?: PdfSelectionAnchorV1 | null;
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

// ── Claude subscription usage-limits (account-wide) ──────────────────────
// Captured passively from the Claude Code statusLine blob's `rate_limits`
// (five_hour / seven_day windows, each independently absent). See
// plans/usage-limits-mcp-and-ui.md.

/** Raw record written by the statusline script to
 *  `<ws>/.lares/usage/latest.json` — observed windows only, no derived
 *  fields. `resets_at` is stored exactly as received from the harness. */
export interface UsageLimitsRawRecord {
  schema: 1;
  source: 'claude_statusline';
  captured_at: number; // ms
  session_id: string | null;
  agent_id: string | null;
  claude_project_dir: string | null;
  five_hour?: { used_percentage: number; resets_at: number };
  seven_day?: { used_percentage: number; resets_at: number };
}

/** Per-window derived reading (IPC/API only — never persisted). */
export interface UsageWindowReading {
  used_percentage: number;
  resets_at: number;      // as received (may be seconds)
  resets_at_ms: number;   // normalized to ms
  resets_in_seconds: number;
  captured_at: number;
  age_seconds: number;
  stale: boolean;
}

/** Account-wide usage reading returned by the watcher / API / MCP tool. */
export interface UsageLimitsReading {
  available: boolean;
  account_wide: true;
  source?: 'claude_statusline';
  reason?: 'no_reading_yet';
  captured_at?: number;
  age_seconds?: number;
  stale?: boolean;
  session_id?: string | null;
  five_hour?: UsageWindowReading | null;
  seven_day?: UsageWindowReading | null;
}

/** WP5 render-refresh nudge broadcast after each WP4 reparse of a plan file.
 *  The renderer re-fetches `/api/plans/:id/projection` and full-re-renders.
 *  `parseError`/`degradedFrom` mirror the reparse outcome so the surface can
 *  show the F-E degradation banner without a second round-trip. */
export interface PlanSurfaceChangedEvent {
  planId: string;
  parseError: string | null;
  degradedFrom: 'memory' | 'snapshot' | 'empty' | null;
}

/** One section row of the WP5 activity projection (mirrors the server-side
 *  `buildPlanActivityProjection`). Shared so the plan-pane IPC passthrough and
 *  the renderer container agree on the shape. */
export interface PlanActivitySection {
  anchor: string | null;
  zone: string | null;
  heading: string | null;
  tokenEstimate: number;
  archived: boolean;
  eventCount: number;
  lastEventAt: string | null;
  // ── Fix-4: witnessed repo-activity rollup (tests/commit fields inert in cut 1) ──
  repoFilesRead: number;
  repoFilesEdited: number;
  repoFilesCreated: number;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  lastCommit: string | null;
}

/** One trusted `plan_events` row + its (kept-separate) claimed self-report, as
 *  served for render. Field-for-field the renderer's `PlanEventView`. */
export interface PlanActivityEvent {
  id: string;
  agentId: string;
  agentTitle?: string | null;
  createdAt: string;
  observedSectionAnchor: string | null;
  dispatchedSectionAnchor: string | null;
  observedVia: string | null;
  attributionConfidence: string | null;
  sectionMismatch: boolean;
  mismatchReason: string | null;
  claimedSectionAnchor?: string | null;
  claimedPayload?: Record<string, unknown> | null;
  // Fix-4: Tier-2 witnessed digest (counts only, no file list). null = not captured.
  repoActivityDigest?: RepoActivityDigest | null;
}

/** The full projection the WP5 surface renders — sections + degradation fields,
 *  plus the trusted event trail when requested (`events=full`). Returned by the
 *  `plan:projection` IPC (an in-process mirror of
 *  GET /api/plans/:id/projection?events=full). */
export interface PlanActivityProjection {
  planId: string;
  sections: PlanActivitySection[];
  parseError: string | null;
  warnings: string[];
  events?: PlanActivityEvent[];
  // Fix-4: Tier-3 drill-down — one event's capped witnessed file list. Present
  // only when the projection was requested with an `eventDetailId`.
  eventDetail?: RepoActivityDetail | null;
}

// ── Fix-4: witnessed repo-activity evidence (V1, versioned) ──────────────────
export interface RepoActivityFileItem {
  path: string;                                   // workspace-relative, forward-slash
  operations: Array<'read' | 'write' | 'create'>; // distinct ops seen this turn
  counts: { read: number; write: number; create: number };
  firstAt: string;                                // ISO (normalized in rollup)
  lastAt: string;                                 // ISO (normalized in rollup)
  outsideWorkspace?: boolean;                     // path could not be relativized
}

export interface RepoActivityEvidenceV1 {
  schemaVersion: 1;
  status: 'captured';
  window: { sinceIso: string; untilIso: string };
  totals: {
    filesRead: number;  filesEdited: number;  filesCreated: number;
    fileEvents: number; distinctFiles: number;
    testsRun: number;   testsPassed: number;  testsFailed: number; // always 0 in cut 1
  };
  files:   { truncated: boolean; items: RepoActivityFileItem[] };
  tests:   { truncated: boolean; items: never[] };  // RESERVED — always [] in cut 1
  commits: { truncated: boolean; items: never[] };  // RESERVED — always [] in cut 1
  caps: { fileDetailMax: number };
}

export interface RepoActivityDigest {   // Tier-2 (counts only, no file list)
  status: 'captured' | 'not-captured';
  totals: RepoActivityEvidenceV1['totals'] | null;
  line: string | null;                  // formatRepoDigest(...) output; null = captured but no activity
}
export interface RepoActivityDetail {   // Tier-3 (one event's capped files)
  planEventId: string;
  files: RepoActivityEvidenceV1['files'];
  totals: RepoActivityEvidenceV1['totals'];
  window: RepoActivityEvidenceV1['window'];
}

/** A6 (wp2b §5) — skill-analytics indexing progress pushed to the renderer. */
export interface IndexProgressDto {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  rowsAdded: number;
  currentFile: string;
}
/** A6 (wp2b §5) — `indexing` IPC contract result. `ready:false` → render
 *  "indexing… N of M files" off `progress`; `stale:true` → a large tail is
 *  re-indexing in the background while the current (stale) index is served. */
export type IndexStatusDto =
  | { ready: false; status: 'indexing'; progress: IndexProgressDto }
  | { ready: true; stale?: boolean; status?: 'indexing' };

/** Result of resolving pasted/dropped image bytes or paths into an agent-space
 *  absolute path (see files.writeImageTemp / files.resolveImageDrops). */
export type ImagePathResult = { ok: true; path: string } | { ok: false; error: string };

/** Why a forced continuation handoff was refused. The press used to return a
 *  blanket `{ok:true}` even when the watcher would never visit the agent, so a
 *  press on a stopped supervisor was indistinguishable from a working one.
 *  Every rejection now carries a stable code the renderer can explain and a
 *  field report can quote. Defined HERE (the shared contract) so main, preload
 *  and the renderer share exactly one definition. */
export type ForceContinuationCode =
  | 'continuation-not-watched'
  | 'continuation-disabled'
  | 'continuation-watcher-unavailable';

export interface ForceContinuationResult {
  ok: boolean;
  code?: ForceContinuationCode;
  error?: string;
}

/** Slice 2 — the continuation handoff's live lifecycle, as the card renders it.
 *  Between the press and the fresh session the cycle can run 30–150 s (and up to
 *  ~8 minutes on the note-timeout + backoff path) during which the app used to
 *  tell the UI NOTHING; the card sat looking idle and the transfer glow only lit
 *  for the sub-second `restarting` window at the very end.
 *
 *  Deliberate omissions:
 *   - `requesting-note` — sub-second on the happy path; it would only flicker,
 *     so it collapses into `awaiting-note`.
 *   - `aborted` — the 180 s note timeout SCHEDULES A RETRY, so it emits
 *     `backoff` carrying the abort message + `retryAt`. A terminal-sounding
 *     state overwritten one frame later is both wrong and a guaranteed flicker.
 *   - anything on `AgentStatus` — continuation phases are a separate axis and
 *     must never widen the status union. */
export type ContinuationPhase =
  | 'queued'           // force accepted; waiting for the next tick
  | 'opening'          // attempt-open in flight
  | 'awaiting-note'    // note requested; polling for the brick (up to 180 s)
  | 'note-committed'   // brick landed
  | 'waiting-for-idle' // post-note grace: author finishing its turn
  | 'relaunching'      // relaunch route called (stop → session mint)
  | 'launching'        // launch tail running
  | 'backoff'          // this attempt failed; automatic retry at retryAt
  | 'failed';          // no automatic retry (launch-tail failure)

export interface ContinuationPhaseState {
  agentId: string;
  phase: ContinuationPhase;
  attemptId?: string;
  /** Why, in card-sized prose. Carried by `backoff` and `failed`. */
  message?: string;
  /** Epoch ms the automatic retry is due (backoff only). The renderer runs its
   *  own 1 s display timer off this — main sends NO countdown events. */
  retryAt?: number;
  updatedAt: number;
}

/** One phase broadcast. `phase: null` is the CLEAR signal (the cycle finished
 *  successfully, or the agent's entry was dropped) — it is not a phase. */
export type ContinuationPhaseSignal = ContinuationPhaseState | { agentId: string; phase: null };

/** P0.2 — legacy `launch.vbs` security notice (EDR-safety hardening).
 *  Mirror of the main-process shape in workspace-state-dir.ts. */
export interface WorkspaceSecurityNotice {
  workspaceRoot: string;
  filePath: string;
  sha256: string;
  title: string;
  detail: string;
  /** Inert scaffold-migration `.bak` files still quoting the old hidden-launch
   *  recipe text — reported only, never part of the removal action. */
  inertBackups: string[];
}

// ── Git-Native WP-G2.2: renderer checkpoint IPC contract ────────────────────────
// Wire DTOs for the HUMAN renderer's checkpoint recovery surface. They mirror the
// main-process shapes (TurnCheckpointSummary in api-server.ts; DiffResult /
// CheckpointPreviewResult / RestoreOutcome in git-checkpoints/checkpoint-service.ts)
// field-for-field, but live here because the renderer cannot import from src/main.
// The engine's human-routes adapter (engine-bootstrap.ts) returns the concrete
// main-process objects, which must stay STRUCTURALLY ASSIGNABLE to these — so any
// drift in the source shapes is a compile error at the adapter, not a silent gap.

/** One turn's checkpoint state as the renderer list surface returns it. Witnessed
 *  PATHS only — never worktree bytes. */
export interface CheckpointTurnSummary {
  turnId: string;
  turnSeq: number;
  agentId: string | null;
  agentTitle: string | null;
  taskLabel: string | null;
  status: string;
  startedAt: number | null;
  endedAt: number | null;
  beforeReady: boolean;
  afterReady: boolean;
  beforeQuality: string | null;
  afterQuality: string | null;
  /** Witnessed write/create paths — the ONLY revertable set for this turn. */
  witnessedPaths: string[];
  failureReason: string | null;
  /** BEFORE-edge CONTENT-semantics diagnostic (turn_records.before_raw_filter_bypassed).
   *  True when the before-snapshot captured on-disk bytes of a filter-managed path
   *  (LFS / git-crypt) rather than its managed form — so a restore rewrites those
   *  on-disk bytes and does NOT reconstruct the managed representation. Optional so
   *  the WP-G2.2 main summary (which does not yet carry it) stays structurally
   *  assignable; RestoreDialog surfaces the content-semantics warning when true. */
  beforeRawFilterBypassed?: boolean;
}

/** One side of a turn diff: the witnessed (attributed) changes OR the separately
 *  labeled raw window ("unattributed changes in this window"). Carries text, not
 *  the raw blobs. */
export interface CheckpointDiffEntry {
  available: boolean;
  reason: string | null;
  /** Human label — witnessed vs. "unattributed changes in this window". */
  label: string;
  text: string | null;
  provenance?: 'witnessed' | 'raw-window';
}

/** The list route's envelope: the resolved workspace + its turns. */
export interface CheckpointListResult {
  workspaceId: string;
  turns: CheckpointTurnSummary[];
}

/** A turn diff: witnessed changes PLUS the separately-labeled raw window. */
export interface CheckpointDiffResult {
  workspaceId: string;
  turnId: string;
  witnessed: CheckpointDiffEntry;
  window: CheckpointDiffEntry;
}

/** Restore preview: the witnessed set + per-path anti-TOCTOU tokens (current
 *  worktree OID, or an ABSENT sentinel) the renderer echoes back to restore/revert.
 *  `contention` lists any OTHER open turn currently witnessing a requested path —
 *  the signal that gates a human `force`. Carries NO worktree bytes. */
export interface CheckpointPreviewResult {
  available: boolean;
  reason: string | null;
  turnId: string;
  witnessedSet: string[];
  tokens: Record<string, string>;
  validatedPaths: string[];
  rejectedPaths: string[];
  contention: { path: string; turnId: string }[];
}

/** Outcome of a restore/revert (path-scoped, partial-recoverable). A human `force`
 *  refused because an active turn witnesses a requested path surfaces here as
 *  `status: 'failed'` + `failureReason: 'active-turn-witnesses-path'` with the
 *  offending turns in `contention` (no mutation happened). */
export interface CheckpointRestoreResult {
  status: 'completed' | 'partial' | 'failed';
  operationId: string;
  kind: 'restore_paths' | 'revert_turn';
  preRef: string | null;
  preOid: string | null;
  requestedPaths: string[];
  completedPaths: string[];
  rejectedPaths: string[];
  failures: { path: string; reason: string }[];
  contention: { path: string; turnId: string }[];
  failureReason: string | null;
}

/** Renderer → main restore request. `force` (stale-preview override) is IPC-ONLY
 *  and only honored when no active turn witnesses a requested path. */
export interface CheckpointRestoreRequest {
  workspaceId: string;
  turnId: string;
  /** A subset of the turn's witnessed set. */
  paths: string[];
  /** path → OID seen at preview time (the anti-TOCTOU tokens). */
  previewTokens?: Record<string, string>;
  force?: boolean;
}

/** Renderer → main revert request (the turn's full witnessed set). */
export interface CheckpointRevertRequest {
  workspaceId: string;
  turnId: string;
  previewTokens?: Record<string, string>;
  force?: boolean;
}

// ── Git-Native WP-G3.1: file-history contract ───────────────────────────────────
// One version = one retained turn that WITNESSED a write/create to the queried
// canonical relative path AND whose before-edge ref is LIVE-verified right now
// (same rev-parse discipline as diff/restore). A pruned/dead-ref edge is never
// listed — the presence of a version is itself the restorable guarantee. The
// restore path reuses the WP-G2.4 preview-required flow (RestoreDialog); this
// surface only names the versions.

/** One per-turn/per-agent version of a single path. Mirrors the main-process
 *  FileHistoryVersion (git-checkpoints/checkpoint-service.ts) field-for-field so
 *  the engine adapter stays structurally assignable. Carries witnessed PATHS only,
 *  never worktree bytes. */
export interface CheckpointFileHistoryVersion {
  turnId: string;
  turnSeq: number;
  agentId: string | null;
  agentTitle: string | null;
  taskLabel: string | null;
  status: string;
  startedAt: number | null;
  endedAt: number | null;
  beforeReady: boolean;
  afterReady: boolean;
  beforeQuality: string | null;
  afterQuality: string | null;
  /** The canonical (repo-relative) witnessed path this version covers — the exact
   *  path that will be restored (a subset-of-one of the turn's witnessed set). */
  witnessedPath: string;
  /** The witnessed op for this path in this turn. */
  op: 'write' | 'create';
  /** True when the AFTER edge is also live-verified → a turn diff is available. The
   *  BEFORE edge is ALWAYS live-verified for a listed version (the restorable
   *  source), so a pruned edge is simply absent from the list. */
  afterVerified: boolean;
  /** BEFORE-edge CONTENT-semantics diagnostic (turn_records.before_raw_filter_bypassed).
   *  RestoreDialog surfaces the LFS/git-crypt warning when true. */
  beforeRawFilterBypassed: boolean;
}

/** The file-history route/IPC envelope: the resolved workspace + queried path + its
 *  live-verified versions (newest first). */
export interface CheckpointFileHistoryResult {
  workspaceId: string;
  path: string;
  versions: CheckpointFileHistoryVersion[];
}

/** Stage 1 Save-card IPC has one read-only inventory route. */
export const SAVECARD_CHANNELS = {
  getInventory: 'savecard:getInventory',
} as const;

/** Renderer request for the repository inventory containing this workspace. */
export interface SaveCardInventoryRequest {
  workspaceId: string;
}

/** Human identity attached by the main-process Save-card DB adapter. */
export interface SaveCardBundleIdentity {
  groupingKey: string;
  source: 'supervisor' | 'agent' | 'mixed';
  agentId: string | null;
  name: string;
  roleDescription: string;
  startedAt: number | null;
  endedAt: number | null;
  workerUnits: SaveCardWorkerUnit[];
}

/** A contributing agent shown inside its supervisor-unit package. */
export interface SaveCardWorkerUnit {
  agentId: string | null;
  name: string;
  roleDescription: string;
  kind: 'supervisor' | 'worker' | 'agent';
  startedAt: number | null;
  endedAt: number | null;
  turnCount: number;
  memberEntryIds: string[];
}

/** One renderer-safe WorkBundle DTO element returned by the read-only service. */
export interface SaveCardBundle {
  bundleId: string;
  kind: 'component' | 'unattributed';
  label: string;
  labels: string[];
  repositoryKey: string;
  workspaces: Array<{ workspaceId: string; workspacePrefix: string }>;
  component: import('./commit-candidates').ConflictComponent | null;
  members: Array<{
    entry: import('./commit-candidates').DirtyEntry;
    protection: import('./commit-candidates').ProtectionRung;
  }>;
  captureHealth: import('./commit-candidates').BundleCaptureHealth;
  weakestProtection: import('./commit-candidates').ProtectionRung | null;
  identity: SaveCardBundleIdentity | null;
}

/**
 * Read-only Save-card inventory response. Carries the renderer-safe WorkBundle
 * DTOs plus the SC-WP-2L retention quota-weakening warning (null unless the pin
 * quota is forcing the release of a still-dirty recovery edge).
 */
export interface SaveCardInventoryResponse {
  bundles: SaveCardBundle[];
  quotaWeakening: import('./commit-candidates').SaveCardQuotaWeakening | null;
}

// ── SC-WP-N2 — checkpoint-expiry attention signal ─────────────────────────────
//
// A LIGHTWEIGHT attention channel, deliberately kept OUT of `SAVECARD_CHANNELS`
// (whose Stage ① audit test asserts exactly one read-only inventory route) —
// mirroring how the preview + mark-done channels stay separate. It lets the Save
// entry ILLUMINATE without running the expensive full inventory probe: the notice
// is emitted straight from the retention pass's ACTUAL retained-pin selection.
export const SAVECARD_ATTENTION_CHANNEL = 'savecard:getAttention' as const;
export const SAVECARD_ATTENTION_CHANGED_CHANNEL = 'savecard:attentionChanged' as const;

/**
 * The checkpoint-expiry attention notice: the retained recovery edges whose pin
 * extension expires within `expiresWithinMs` of `observedAt`. Built from the
 * retention pass's real selection (never re-derived from turn age); each edge
 * carries the exact `expiresAt` and the renderer-safe `affectedEntryIds` (dirty-
 * entry identities, never raw paths) so the Save pane can group edges onto bundles.
 */
export interface SaveCardCheckpointExpiryNotice {
  observedAt: number;
  expiresWithinMs: number;
  edges: Array<{
    repositoryKey: string;
    turnId: string;
    edge: 'before' | 'after';
    expiresAt: number;
    affectedEntryIds: string[];
  }>;
}

/** Renderer request for the checkpoint-expiry attention for one workspace. */
export interface SaveCardAttentionRequest {
  workspaceId: string;
}

/** Main → renderer push carrying the freshest per-workspace attention notice
 *  (null when the workspace has no edge expiring soon). */
export interface SaveCardAttentionChangedPayload {
  workspaceId: string;
  notice: SaveCardCheckpointExpiryNotice | null;
}

// ── SC-WP-3H — Save-lens candidate preview channel ────────────────────────────
//
// A SECOND Save-card channel, deliberately kept OUT of `SAVECARD_CHANNELS` (whose
// Stage ① audit test asserts exactly one read-only inventory route) — mirroring
// how WP-3E kept its mutating `savecard:markDoneFleetAdhoc` channel separate. The
// preview channel is itself read-only: it assembles a `CommitCandidate` /
// `SelectionPreview` (WP-3G) for an explicit selection and returns the renderer-
// safe verdicts plus server-derived, READ-ONLY `Lares-*` trailer previews. It
// mutates nothing.
export const SAVECARD_PREVIEW_CHANNEL = 'savecard:preview' as const;

/** Renderer request to preview a candidate for one explicit selection. Component
 *  ids expand server-side to ALL their entries; unattributed entries are
 *  independent atoms; `finalizationIds` is the requested coverage set (empty ⇒ a
 *  `SelectionPreview`, never a committable candidate). */
export interface SaveCardPreviewRequest {
  workspaceId: string;
  selectedComponentIds: string[];
  selectedUnattributedEntryIds: string[];
  finalizationIds: string[];
}

/**
 * Renderer-safe result of a Save-lens preview. `candidate` is the WP-3G
 * `CommitCandidate` (finalization-backed) or `SelectionPreview` (unfinalized) —
 * the renderer reads its per-member `packageVerification` verdicts and
 * `eligibility` directly. `laresTrailers` are server-derived commit-message
 * trailer previews from the immutable snapshot; the renderer renders them
 * READ-ONLY and MUST NEVER let a user trailer override a `Lares-*` line. The
 * message body (`defaultMessageBody`) is a server suggestion the user may edit.
 */
export interface SaveCardPreviewResponse {
  candidate:
    | import('./commit-candidates').CommitCandidate
    | import('./commit-candidates').SelectionPreview;
  /** True when `candidate` is a finalization-backed `CommitCandidate`; false for a
   *  `SelectionPreview` (no finalization requested). Never one-click when false. */
  isCandidate: boolean;
  /** Server-derived, READ-ONLY `Lares-*` trailer previews from the immutable
   *  snapshot (turns/plans/finalizations). Rendered verbatim; never user-editable. */
  laresTrailers: string[];
  /** Server-suggested, user-EDITABLE commit-message body. */
  defaultMessageBody: string;
  /** True when any selected component fused ≥2 owners/plans and needs an overlap
   *  acknowledgement before a one-click save (renderer-side ack gate). */
  requiresOverlapAck: boolean;
  /** Selected unattributed entry ids that each need an individual acknowledgement
   *  before a one-click save (renderer-side ack gate). */
  unacknowledgedUnattributedEntryIds: string[];
}

// ── SC-WP-3E — fleet-adhoc mark-done route ────────────────────────────────

/** Kept separate from the Stage-1 read-only channel map because this explicit
 * action mints a durable fleet-adhoc finalization boundary. */
export const SAVECARD_FINALIZE_CHANNEL = 'savecard:markDoneFleetAdhoc' as const;

export interface SaveCardFleetAdhocMarkDoneRequest {
  packageId: string;
}

export type SaveCardFinalizeOutcome =
  | 'created'
  | 'existing-unchanged'
  | 'superseded'
  | 'reattached-ready'
  | 'boundary-unavailable';

export interface SaveCardFleetAdhocMarkDoneResponse {
  finalizationId: string;
  packageId: string;
  finalizationKind: 'fleet-adhoc';
  outcome: SaveCardFinalizeOutcome;
  boundaryRef: string | null;
  boundaryStatus: 'ready' | 'unavailable' | 'pruned';
  packageRevision: number;
}

// ── SC-WP-4E — shared commit-coordinator consume route ───────────────────────

/** Lens-neutral consume channel shared by the Save and Plan surfaces. */
export const COMMIT_COORDINATOR_CHANNEL = 'commit-coordinator:consume' as const;

/** Only stable candidate identity, its opaque token, and the editable message
 * body cross the wire. Lares trailers and commit members remain main-owned. */
export interface CommitCoordinatorConsumeRequest {
  candidateId: string;
  tokenId: string;
  message: string;
}

export interface CommitCoordinatorClosureResult {
  finalizationId: string;
  closed: boolean;
  lifecycleStatus: 'active' | 'committed';
  members: Array<{
    pathBytesBase64: string;
    disposition: import('./commit-candidates').FinalizationMemberDisposition | null;
  }>;
}

type CommittedCoordinatorOutcome = Extract<
  import('./commit-candidates').CommitOutcome,
  { status: 'committed' }
>;
type NonCommittedCoordinatorOutcome = Exclude<
  import('./commit-candidates').CommitOutcome,
  { status: 'committed' }
>;

/** `saved` is deliberately a distinct terminal envelope: main emits it only after
 * WP-4G has verified the marked parent/tree, persisted exact links, and evaluated
 * every frozen finalization manifest. */
export type CommitCoordinatorConsumeResponse =
  | { kind: 'token-unresolved' }
  | { kind: 'invalid-message'; reason: string }
  | { kind: 'compose-in-flight' }
  | { kind: 'outcome'; outcome: NonCommittedCoordinatorOutcome }
  | {
      kind: 'reconciliation-error';
      outcome: CommittedCoordinatorOutcome;
      error: { code: string; message: string };
    }
  | {
      kind: 'saved';
      outcome: CommittedCoordinatorOutcome;
      finalizations: CommitCoordinatorClosureResult[];
    };

// ── SC-WP-3I — Plan-lens candidate preview channel ────────────────────────────
//
// The plan lens's OWN read-only preview transport, deliberately kept SEPARATE from
// the save-lens channel (mirroring how each Save-card channel stays distinct). It
// resolves a plan-scoped selection main-side and runs the SAME WP-3G `buildCandidate`
// service the save lens uses, so the assembled `candidateId` + member verdicts are
// IDENTICAL across both lenses for the same effective selection (contract §14). The
// plan lens only FILTERS / ANNOTATES whole components (D-1): it forwards whole
// component ids and NEVER carves a sub-candidate out of a component that connects to
// other plans, and it recomputes NO topology (identity lives solely in the 3G
// service). It mutates nothing.
export const PLAN_PREVIEW_CHANNEL = 'plan:previewCandidate' as const;

/** Renderer request to preview a plan-lens candidate. The selection fields mirror
 *  `SaveCardPreviewRequest` (component ids expand server-side to ALL their entries;
 *  unattributed entries are independent atoms; empty `finalizationIds` ⇒ a preview,
 *  never a committable candidate). `planId` scopes the D-1 filter / annotation; an
 *  empty `selectedComponentIds` defaults to the plan's own whole components. */
export interface PlanCandidatePreviewRequest {
  workspaceId: string;
  planId: string;
  selectedComponentIds: string[];
  selectedUnattributedEntryIds: string[];
  finalizationIds: string[];
}

/**
 * Renderer-safe result of a plan-lens preview. `candidate` is the WP-3G
 * `CommitCandidate` / `SelectionPreview` from the SAME assembler the save lens uses
 * — identical `candidateId` + member verdicts. `selection` echoes the D-1-filtered
 * WHOLE-component selection the plan lens resolved, so the renderer can hand it to
 * the shared `CandidatePreview` component (which fetches the save-lens preview for
 * the editable message body + READ-ONLY `Lares-*` trailer previews). Never carves a
 * component subset.
 */
export interface PlanCandidatePreviewResponse {
  candidate:
    | import('./commit-candidates').CommitCandidate
    | import('./commit-candidates').SelectionPreview;
  /** True when `candidate` is a finalization-backed `CommitCandidate`. */
  isCandidate: boolean;
  /** The resolved, D-1-filtered whole-component selection (echoed for the renderer). */
  selection: {
    selectedComponentIds: string[];
    selectedUnattributedEntryIds: string[];
    finalizationIds: string[];
  };
}

// ── WP-P7A-proj — conservative plan-review projection ────────────────────────

/** A review diff is identified by its execution run and witnessed path set, never
 * by the Save-card candidate id. The patch compares the pinned execution baseline
 * to current worktree bytes; `unborn` means the run began before the first commit. */
export interface PlanReviewBaselineDiff {
  executionRunId: string;
  baseline:
    | { kind: 'head'; ref: string; headOid: string }
    | { kind: 'unborn' };
  witnessedPaths: string[];
  repositoryPaths: string[];
  patch: string;
}

export interface PlanReviewMixedAuthorshipAnnotation {
  componentId: string;
  planIds: Array<string | null>;
  otherPlanIds: Array<string | null>;
  contributingTurnIds: string[];
  reasons: Array<'multiple-plans' | 'unattributed-contributor' | 'multiple-agents'>;
  /** Conservative wording: component evidence cannot establish byte/line authorship. */
  currentBytesMayContainMixedAuthorship: true;
}

export interface PlanReviewCaptureGapAnnotation {
  source: 'component-capture' | 'plan-stamp';
  componentId: string | null;
  turnIds: string[];
  pathsWithoutFinalizationEdge: string[];
  reasons: Array<'capture-outage' | 'incomplete-edge' | 'unstamped-turn' | 'unverified-turn'>;
}

/**
 * Primary plan-review DTO. This is deliberately NOT a candidate model: the only
 * candidate identity remains inside the unchanged SC object. Baseline-diff path
 * identity and Save-lens membership are separate fields and must not be equated.
 */
export interface PlanReviewProjection {
  workspaceId: string;
  planId: string;
  baselineDiff: PlanReviewBaselineDiff;
  scObject:
    | import('./commit-candidates').CommitCandidate
    | import('./commit-candidates').SelectionPreview;
  annotations: {
    mixedAuthorship: PlanReviewMixedAuthorshipAnnotation[];
    captureGaps: PlanReviewCaptureGapAnnotation[];
  };
  /** Activity and diff evidence are review aids only; they never assert completion. */
  evidenceSemantics: 'activity-only-never-completion';
}

/** IPC channel names for the renderer checkpoint surface — one source of truth for
 *  preload, the main registrar, and the contract test. */
export const CHECKPOINT_CHANNELS = {
  list: 'checkpoint:list',
  diff: 'checkpoint:diff',
  preview: 'checkpoint:preview',
  restore: 'checkpoint:restore',
  revert: 'checkpoint:revert',
  // WP-G3.1 — per-path version history (view/diff/restore one file).
  fileHistory: 'checkpoint:fileHistory',
  // WP-G3.4 — human-only `git init` consent action for a non-repo workspace.
  // Renderer IPC ONLY (like the force override path): never an agent MCP tool,
  // never a capability-token HTTP route.
  gitInit: 'checkpoint:gitInit',
  // WP-G3.5 — the explicit "delete my checkpoint refs" command. `prune` is the
  // workspace-scoped op mirrored from the supervisor MCP tool / capability route.
  // `pruneRepoWidePlan` + `pruneRepoWide` are the DISTINCT human-only, explicitly-
  // confirmed pre-`filter-repo` purge that names every affected workspace first;
  // they are deliberately renderer-IPC ONLY (never an MCP tool / HTTP route).
  prune: 'checkpoint:prune',
  pruneRepoWidePlan: 'checkpoint:pruneRepoWidePlan',
  pruneRepoWide: 'checkpoint:pruneRepoWide',
} as const;

/** WP-G3.5 — outcome of the workspace-scoped prune: both encoded namespaces
 *  (`refs/lares/checkpoints/<enc(ws)>/*` + `refs/lares/recovery/<enc(ws)>/*`) deleted
 *  in one atomic batch, with the deleted-ref count. Objects are left for normal git
 *  maintenance (no gc/prune). */
export interface CheckpointPruneResult {
  workspaceId: string;
  deletedRefs: number;
}

/** WP-G3.5 — one workspace whose `refs/lares/*` live in the repo a repo-wide purge
 *  would clear. `known` is false when the decoded id no longer maps to a registered
 *  workspace (a stale/foreign scope in a shared repo) — still named, so the human
 *  sees the full blast radius. */
export interface RepoWidePurgeWorkspace {
  workspaceId: string;
  /** The registered workspace title, or null when the id is no longer known. */
  workspaceTitle: string | null;
  workspacePath: string | null;
  known: boolean;
  refCount: number;
}

/** WP-G3.5 — the enumerated blast radius of a repo-wide purge: the repo, every
 *  affected workspace NAMED, the total ref count, and any undecodable Lares refs. A
 *  purge clears ALL of them; this is shown BEFORE the human confirms. `executed`
 *  distinguishes the plan (confirm=false / preview) from the applied purge. */
export interface RepoWidePurgeResult {
  repoRoot: string;
  totalRefs: number;
  affectedWorkspaces: RepoWidePurgeWorkspace[];
  undecodableRefCount: number;
  /** True only after an explicitly-confirmed purge actually deleted the refs. */
  executed: boolean;
  /** Refs deleted (0 when only planning). */
  deletedRefs: number;
}

/** WP-G3.4 — outcome of the human-only `git init` consent action. A non-repo
 *  workspace is the honest-disabled state (no silent `.git`); this action, driven
 *  by an explicit human click, either creates the repository or refuses with an
 *  honest reason. `ok` is true ONLY for `initialized`; every other status is a
 *  no-op that left NO partial state on disk. */
export interface GitInitResult {
  ok: boolean;
  status: 'initialized' | 'already-repo' | 'protected-root' | 'unusable-git' | 'error';
  /** Plain-language, user-facing sentence for the consent UI to render verbatim. */
  message: string;
  /** Optional diagnostic detail (probe reason / git stderr tail). */
  detail?: string;
}

/** WP-3a: result of `terminal:attach`. `snapshotCutoff` is an atomic byte
 *  offset into the append-only `.log` proven durable at attach time (live path:
 *  the write barrier's contiguous flushed prefix; dead path: the file size).
 *  `terminalEpoch` is the current epoch (null if never launched this process).
 *  `degraded` is true when a log-write error this epoch invalidated the
 *  offset↔file mapping — recovery uses the ring snapshot, not `.log` replay. */
export interface TerminalAttachResult {
  ok: boolean;
  live?: boolean;
  terminalEpoch?: string | null;
  snapshotCutoff?: number;
  degraded?: boolean;
  error?: string;
  /** WP-6: reclaimed-history disclosure sourced solely from the DB marker (for
   *  both live and dead agents). `null`/absent = nothing reclaimed. */
  historyNotice?: HistoryNotice;
}

/** WP-3a: exact byte range from an agent's `.log` (NO rune alignment). */
export interface TerminalLogRange {
  bytes: Uint8Array;
  startOffset: number;
  endOffset: number;
  fileSize: number;
  /** WP-6: marker fetched AFTER the bounded read, so a read racing a deletion
   *  returns empty bytes PLUS this structured notice. */
  historyNotice?: HistoryNotice;
}

/** WP-3a: tail bytes from an agent's `.log`; head rune-aligned when truncated. */
export interface TerminalLogTail {
  bytes: Uint8Array;
  startOffset: number;
  endOffset: number;
  truncated: boolean;
  /** WP-6: marker fetched AFTER the bounded read (see `TerminalLogRange`). */
  historyNotice?: HistoryNotice;
}

/** WP-3a: atomic ring-text + logical PTY cursor for degraded recovery. */
export interface TerminalRingSnapshot {
  text: string;
  logicalCutoff: number;
}

/** WP-3b: a validated checkpoint returned by `terminal:load-checkpoint`.
 *  `serialized` is the `@xterm/addon-serialize` buffer; `appliedOffset` is the
 *  `.log` byte offset already reflected in it (the renderer resumes paging from
 *  there). null (not this shape) means no valid checkpoint. */
export interface TerminalCheckpointLoad {
  serialized: string;
  appliedOffset: number;
}

/** WP-3c: dead-agent replay snapshot with STRUCTURED truncation metadata.
 *  `truncated` is true when earlier history was provably dropped (the bounded
 *  `.scrollback` is smaller than the raw `.log`, or a no-scrollback `.log` tail
 *  hit its byte budget) — the renderer surfaces it as a visible banner. */
export interface TerminalDeadSnapshot {
  text: string;
  truncated: boolean;
  retainedBytes: number;
  /** WP-6: true ONLY when BOTH `.scrollback` and `.log` are absent (ENOENT via
   *  `sizeOrNull`). NEVER inferred from `snapshotCutoff === 0` / `retainedBytes`
   *  — an empty-but-present log is size 0 yet `missing:false`. Drives the
   *  renderer's separate `history-unavailable` warning, distinct from the
   *  `retention-reclaimed` notice. */
  missing: boolean;
  /** WP-6: reclaimed-history disclosure fetched AFTER the bounded read. */
  historyNotice?: HistoryNotice;
}

export interface IpcApi {
  workspaces: {
    list: () => Promise<Workspace[]>;
    create: (input: CreateWorkspaceInput) => Promise<Workspace>;
    delete: (id: string) => Promise<void>;
    reorder: (ids: string[]) => Promise<void>;
    openInVSCode: (id: string) => Promise<void>;
    /** P0.2 legacy-launcher sweep: pending notices for this session. */
    getSecurityNotices: () => Promise<WorkspaceSecurityNotice[]>;
    /** Explicit, user-authorized move-to-Recycle-Bin of a flagged launcher. */
    removeLegacyLauncher: (
      filePath: string
    ) => Promise<{ removed: boolean; sha256?: string; reason?: string }>;
    onSecurityNotice: (callback: (notice: WorkspaceSecurityNotice) => void) => () => void;
  };
  agents: {
    list: (workspaceId: string) => Promise<Agent[]>;
    listAll: () => Promise<Agent[]>;
    launch: (input: LaunchAgentInput) => Promise<Agent>;
    /** Main assigns the stop reason per endpoint (§B9) — never the renderer. */
    stop: (id: string) => Promise<BulkStopResult>;
    stopBulk: (req: BulkStopRequest) => Promise<BulkStopResult>;
    stopStaleIdle: () => Promise<BulkStopResult>;
    previewStaleIdle: () => Promise<StaleIdlePreview>;
    restart: (id: string) => Promise<void>;
    getLog: (id: string, lines?: number) => Promise<string>;
    getRingBuffer: (id: string) => Promise<string>;
    delete: (id: string) => Promise<void>;
    checkAgentMd: (workingDirectory: string, pathType: PathType) => Promise<{ found: boolean; fileName: string | null }>;
    getFileActivities: (agentId: string, operation?: FileOperation, currentOnly?: boolean) => Promise<FileActivity[]>;
    onFileActivity: (callback: (activity: FileActivity) => void) => () => void;
    getContextStats: (agentId: string) => Promise<ContextStats | null>;
    onContextStatsChanged: (callback: (stats: ContextStats) => void) => () => void;
    /** `source` distinguishes a live ring read from a dead agent's history
     *  re-read off disk, and flags the one case the pane must NOT render as an
     *  empty chat: `'unavailable'` — the agent is terminal and its history
     *  cannot be recovered (provider without a one-shot session reader, or a
     *  pruned/missing session file). Optional so a stale preload still typechecks. */
    getChatEvents: (agentId: string, sinceUuid?: string) => Promise<{ events: SessionEvent[]; truncated: boolean; source?: 'live' | 'disk' | 'unavailable' }>;
    chatSubscribe: (agentId: string) => Promise<void>;
    chatUnsubscribe: (agentId: string) => Promise<void>;
    getFullToolResult: (agentId: string, toolUseId: string) => Promise<string | null>;
    onChatEvents: (callback: (batch: ChatEventBatch) => void) => () => void;
    // Context-brick Phase 2 — durable, read-only prior-session chat. `getAgentSessions`
    // returns the cheap DB lineage (no JSONL read); `getPriorSessionChat` reads one
    // prior session's `.jsonl` from disk on demand (lazy walk-back by lineage row id).
    getAgentSessions: (agentId: string) => Promise<AgentSessionRow[]>;
    getPriorSessionChat: (agentId: string, sessionRowId: number) => Promise<PriorSessionChat>;
    fork: (id: string) => Promise<Agent>;
    query: (targetAgentId: string, question: string, sourceAgentId?: string) => Promise<QueryResult>;
    sendInput: (agentId: string, text: string) => Promise<void>;
    onSendInputError: (callback: (data: { agentId: string; error: string }) => void) => () => void;
    onSendInputResult: (callback: (outcome: SendOutcome) => void) => () => void;
    getSupervisor: (workspaceId: string) => Promise<Agent | null>;
    updateSupervised: (id: string, supervised: boolean) => Promise<Agent>;
    // Per-agent continuation control (Edward 2026-07-05). setContinuationEnabled
    // persists the toggle (false → the watcher's `continuation-disabled` blocker);
    // forceContinuationHandoff makes the watcher open an attempt on its next tick,
    // bypassing the trigger conditions but running the normal attempt cycle
    // (rejects a disabled agent; idempotent when an attempt is already open).
    setContinuationEnabled: (agentId: string, enabled: boolean) => Promise<{ ok: boolean }>;
    forceContinuationHandoff: (agentId: string) => Promise<ForceContinuationResult>;
    /** Slice 2 — HYDRATION, not just events. A renderer reload (or a detached
     *  dashboard opened) mid-cycle would otherwise recreate the exact defect
     *  being fixed: a 180 s wait with no label. Main holds the authoritative
     *  in-memory map; this reads it on mount. */
    listContinuationPhases: () => Promise<ContinuationPhaseState[]>;
    onContinuationPhaseChanged: (callback: (signal: ContinuationPhaseSignal) => void) => () => void;
  };
  terminal: {
    // WP-3a: attach resolves to an atomic snapshot cutoff + epoch so the
    // renderer's exact-once rehydrate knows which `.log` bytes are durable.
    // `live:false` is a dead agent (no runner); `terminalEpoch` is null if the
    // agent was never launched this process. `ok:false` carries `error`.
    attach: (agentId: string) => Promise<TerminalAttachResult>;
    // WP-3d: `expectedEpoch` scopes the detach — main no-ops it when a fresh
    // reattach has already registered a listener under a newer epoch (an
    // eviction under a retired epoch must not tear down the live one). Omitted
    // by legacy callers ⇒ unconditional detach.
    detach: (agentId: string, expectedEpoch?: string | null) => Promise<void>;
    write: (agentId: string, data: string) => Promise<void>;
    resize: (agentId: string, cols: number, rows: number) => Promise<void>;
    // WP-3a: `endOffset` is the chunk's logical end offset in the append-only
    // `.log`. Optional so existing 2-arg callbacks stay compatible.
    onData: (callback: (agentId: string, data: string, endOffset?: number) => void) => () => void;
    // WP-3a: exact byte-range read (NO rune alignment; pages join losslessly).
    readLogRange: (agentId: string, start: number, end: number) => Promise<TerminalLogRange>;
    // WP-3a: tail up to `maxBytes` ending at `endExclusive` (default EOF),
    // rune-aligned at the head when truncated.
    readLogTail: (agentId: string, maxBytes: number, endExclusive?: number) => Promise<TerminalLogTail>;
    // WP-3a: atomic ring-text + logical cursor from the LIVE runner (degraded
    // recovery only). null when there is no live runner.
    getRingSnapshot: (agentId: string) => Promise<TerminalRingSnapshot | null>;
    // WP-3c: dead-agent replay snapshot (`.scrollback` else a capped `.log`
    // tail) WITH truncation metadata, for the dead-reopen banner.
    readDeadAgentSnapshot: (agentId: string) => Promise<TerminalDeadSnapshot>;
    // WP-3b: persist a serialized xterm checkpoint on LRU eviction. Resolves
    // false when main rejects it (stale epoch, or a degraded epoch whose
    // offsets can't be trusted). Reload it on the next open.
    saveCheckpoint: (agentId: string, epoch: string, serialized: string, appliedOffset: number) => Promise<boolean>;
    // WP-3b: load the checkpoint for an exact-once rehydrate. Resolves null when
    // no checkpoint matches the current epoch + attach cutoff.
    loadCheckpoint: (agentId: string, snapshotCutoff: number) => Promise<TerminalCheckpointLoad | null>;
    // BUG-38: fired when a same-id PTY swap (continuation, manual restart,
    // auto-restart) replaces the runner. The renderer disposes the retired
    // xterm and re-attaches to the fresh PTY. Returns an unsubscribe fn.
    onRebound: (callback: (agentId: string) => void) => () => void;
  };
  files: {
    readFile: (filePath: string, pathType: PathType) => Promise<FileContent>;
    convertDocxToMarkdown: (
      filePath: string,
      rootDirectory: string,
      pathType: PathType
    ) => Promise<FileMutationResult>;
    listDirectory: (dirPath: string, pathType: PathType) => Promise<DirectoryEntry[]>;
    /** Conditional write (edit-loss §4.1): `expectedHash` = contentHash of
     *  the bytes the caller believes are on disk (`null` = expect the file
     *  absent); omit it for an unconditional write (force / non-CAS callers). */
    writeFile: (
      filePath: string,
      rootDirectory: string,
      pathType: PathType,
      content: string,
      expectedHash?: string | null
    ) => Promise<ConditionalWriteResult>;
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
    /** Persist a clipboard image blob to a managed temp file; returns an absolute
     *  path in the agent's path space (Windows or WSL). */
    writeImageTemp: (bytes: Uint8Array, mime: string, workingDirectory: string) => Promise<ImagePathResult>;
    /** Resolve dropped OS image FILE paths into the agent's path space (their own
     *  on-disk paths; no copy). One result per input, in order. */
    resolveImageDrops: (nativePaths: string[], workingDirectory: string) => Promise<ImagePathResult[]>;
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
  contextOverhead: {
    scan: (req: ScanOverheadRequest) => Promise<ScanOverheadResult>;
  };
  agentKnowledge: {
    extract: (req: ExtractKnowledgeRequest) => Promise<ExtractKnowledgeResult>;
  };
  contextOptimizer: {
    analyze: (req: ContextOptimizerQuery) => Promise<ContextOptimizerQueryResult>;
    markApplied: (req: MarkOptimizerActionAppliedRequest) => Promise<MarkOptimizerActionAppliedResult>;
    signDerivation: (req: SignOptimizerDerivationRequest) => Promise<SignOptimizerDerivationResult>;
  };
  system: {
    pickDirectory: (startInWsl?: boolean) => Promise<string | null>;
    healthCheck: () => Promise<HealthCheck>;
    getRuntimePrerequisites: (force?: boolean) => Promise<RuntimePrerequisiteReport>;
    openExternal: (url: string) => Promise<boolean>;
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
    create: (workspacePath: string, pathType: PathType, name: string, roleDescription?: string, lane?: PersonaLane) => Promise<AgentPersona>;
    setLane: (workspacePath: string, pathType: PathType, name: string, lane: PersonaLane | null) => Promise<void>;
  };
  notebooks: {
    ensureServer: () => Promise<JupyterServerInfo>;
    listKernelspecs: () => Promise<KernelspecsResponse>;
  };
  /** WP1-A — embedded browser pane. FROZEN WP1 contract: payload shapes and
   *  channel names live in src/shared/browser.ts; WP1-B consumes this
   *  namespace. Changes require both workers + a plans-doc progress-log note. */
  lifecycle: {
    getSettings: () => Promise<LifecycleSettings>;
    /** WP-7: accepts a PARTIAL — a single control (auto-stop threshold OR
     *  terminal-history cap) sends only its own field; main loads current,
     *  merges the patch, validates each field independently, and returns the
     *  full persisted settings. */
    setSettings: (settings: Partial<LifecycleSettings>) => Promise<LifecycleSettings>;
    onSettingsChanged: (cb: (settings: LifecycleSettings) => void) => () => void;
  };
  contextGauge: {
    getSettings: () => Promise<ContextGaugeSettings>;
    /** Returns the settings actually stored (sanitized + clamped main-side). */
    setSettings: (settings: ContextGaugeSettings) => Promise<ContextGaugeSettings>;
    onSettingsChanged: (cb: (settings: ContextGaugeSettings) => void) => () => void;
  };
  /** WP-8 — terminal-log retention first-sweep notice surface. `getState` is a
   *  PULL (a renderer mounting after the sweep still sees the notice);
   *  `onStateChanged` is the push; `acknowledgeNotice` dismisses the durable
   *  banner (persists, then rebroadcasts) and returns the new state. */
  logRetention: {
    getState: () => Promise<LogRetentionState>;
    onStateChanged: (cb: (state: LogRetentionState) => void) => () => void;
    acknowledgeNotice: () => Promise<LogRetentionState>;
  };
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
    // Slice 15: stateful find — per-tab query/state, immediate next/prev, restore
    // on tab switch. `find` starts/updates the search (stores query+opts);
    // findNext/findPrev step using the stored query with no debounce; stopFind
    // clears the stored query + the native highlight for the (active) tab.
    find: (tabId: string, query: string, opts?: BrowserFindOptions) => Promise<void>;
    findNext: (tabId: string) => Promise<void>;
    findPrev: (tabId: string) => Promise<void>;
    stopFind: (tabId: string) => Promise<void>;
    setZoom: (tabId: string, zoomFactor: number) => Promise<void>;
    // Slice 15: reset zoom to 100% AND clear the persisted per-origin row (USER
    // tabs) so the origin reverts to default on future visits.
    resetZoomForOrigin: (tabId: string) => Promise<void>;
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

    // ── Slice 13: user-only downloads with a premium shelf. Trusted chrome only.
    //    The decision gate runs in main: agent downloads are allowlist-gated
    //    (denied → no record, only an audit row); USER downloads are blocked
    //    until downloadConfirm(promptId) is called for an onDownloadPrompt token.
    //    Lifecycle events each carry the full BrowserDownload record so the shelf
    //    renders without a follow-up fetch. ────────────────────────────────────
    /** Newest-first records for the shelf's first paint. */
    downloadList: () => Promise<BrowserDownload[]>;
    /** Approve a pending USER download (an onDownloadPrompt token); main
     *  re-initiates and allows the write. */
    downloadConfirm: (id: string) => Promise<void>;
    /** Open the saved file via the OS; resolves false if unknown / OS error. */
    downloadOpenFile: (id: string) => Promise<boolean>;
    /** Reveal the saved file in the OS file manager. */
    downloadShowInFolder: (id: string) => Promise<void>;
    /** Re-initiate a failed/cancelled download (re-runs the decision gate). */
    downloadRetry: (id: string) => Promise<void>;
    /** Remove a record from the shelf (does NOT delete the saved file). */
    downloadRemove: (id: string) => Promise<void>;

    // ── Slice 14: reading mode. Trusted chrome only. Extract + sanitize the live
    //    article of an http(s) USER tab in main; rejects agent / non-user /
    //    non-http(s) tabs. The returned `html` is DOMPurify-sanitized (no scripts,
    //    no on* handlers, no javascript: URLs) but is still untrusted content. ───
    enterReadingMode: (tabId: string) => Promise<ReaderArticle>;
    /** A download began writing (already confined + recorded). */
    onDownloadStarted: (callback: (rec: BrowserDownload) => void) => () => void;
    /** Byte progress for an in-flight download. */
    onDownloadProgress: (callback: (rec: BrowserDownload) => void) => () => void;
    /** A download completed successfully. */
    onDownloadDone: (callback: (rec: BrowserDownload) => void) => () => void;
    /** A download failed or was cancelled. */
    onDownloadFailed: (callback: (rec: BrowserDownload) => void) => () => void;
    /** A USER download is blocked awaiting trusted-chrome confirmation
     *  (downloadConfirm). NEVER fired for agent downloads. */
    onDownloadPrompt: (callback: (prompt: BrowserDownloadPrompt) => void) => () => void;

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
      // Phase 3 (§D line 264): read-only per-rule visit + login status for the
      // current workspace (sourced from the workspace-exact grant, never a bare
      // row). Optional so older preload shapes without the channel still satisfy.
      siteStatus?: () => Promise<AccessSiteStatus[]>;
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
      // WI-E "Import my session": copy the human's persist:user cookies for the
      // rule's origin into the workspace agent partition. HUMAN-CHROME-ONLY.
      importUserSession: (ruleId: string) => Promise<{ imported: number; origin: string }>;
      // ── Signed-in tabs (WI-5): JIT sign-in banner events + cancel + WI-8
      //    config. The *-opened / *-resolved channels are main→renderer pushes
      //    that drive the JIT banner; the rest are trusted-chrome invokes. ──────
      onSigninPendingOpened: (callback: (payload: SigninPendingOpened) => void) => () => void;
      onSigninResolved: (callback: (payload: SigninResolved) => void) => () => void;
      signinPendingCancel: (tabId: string) => Promise<void>;
      // Phase 4 item 4: explicit human re-arm of a run-scoped signin_unavailable latch.
      signinReArm: (workspaceId: string | null, origin: string) => Promise<boolean>;
      getSigninHoldTimeoutMs: () => Promise<number>;
      setSigninHoldTimeoutMs: (ms: number) => Promise<void>;
      setSigninUnattended: (workspaceId: string | null, unattended: boolean) => Promise<void>;
      isSigninUnattended: (workspaceId: string | null) => Promise<boolean>;
    };
  };
  // Detachable (tear-off) file tabs — plans/detachable-file-tabs-plan.md §4.
  tabs: {
    detach: (req: DetachRequest) => Promise<DetachResult>;
    onDetachedClosed: (callback: (payload: DetachedClosedPayload) => void) => () => void;
    // Phase 2 dirty-on-close protocol — declared now, wired in Phase 2.
    onCloseQuery: (callback: (req: { requestId: string }) => void) => () => void;
    closeReply: (requestId: string, decision: 'save' | 'discard' | 'cancel') => Promise<void>;
    // Edit-loss §4.3 close-flush handshake: main asks every editing renderer
    // to flush its dirty tabs before the main window / app closes.
    onFlushRequest: (callback: (req: FlushRequestPayload) => void) => () => void;
    flushReply: (payload: FlushReplyPayload) => Promise<void>;
  };
  // Detachable (tear-off) top-level views — mirrors `tabs` above, minus the
  // dirty-on-close protocol (a view has nothing to save).
  views: {
    detach: (req: ViewDetachRequest) => Promise<DetachResult>;
    onClosed: (callback: (payload: ViewDetachedClosedPayload) => void) => () => void;
  };
  /** Account-wide Claude subscription usage limits (singleton, not per-agent).
   *  See plans/usage-limits-mcp-and-ui.md. */
  usage: {
    getLimits: () => Promise<UsageLimitsReading>;
    onLimitsChanged: (callback: (reading: UsageLimitsReading) => void) => () => void;
  };
  /** A6 (wp2b §5) — skill-analytics indexing. `indexStatus` is the contract
   *  entrypoint (kicks first-run backfill, returns progress); `indexPoll` is a
   *  no-parse status read for panels mounting mid-backfill; `onIndexProgress`
   *  subscribes to the push stream. */
  skillAnalytics: {
    indexStatus: () => Promise<IndexStatusDto>;
    indexPoll: () => Promise<IndexStatusDto>;
    onIndexProgress: (callback: (progress: IndexProgressDto) => void) => () => void;
    // WP3 (§P2.2) — read-only usage rollup. Ensures the index first, then queries.
    query: (req: SkillUsageQuery) => Promise<SkillUsageQueryResult>;
  };
  /** wave2-mcp-tool-observability §2.2 — per-MCP-tool usage rollup. Separate
   *  endpoint/DTO from skillAnalytics so the MCP tab lazy-loads; same parse-first
   *  contract (ensureIndexed → pure SQL). */
  mcpToolUsage: {
    query: (req: McpToolUsageQuery) => Promise<McpToolUsageQueryResult>;
  };
  /** WP5 plan render surface. `onSurfaceChanged` fires after each WP4 reparse
   *  (fs change → reparse → re-render) so the renderer re-fetches the served
   *  projection and does a full re-render — NOT a second `plans/` fs
   *  subscription (F-C: plans-watcher owns the only one). */
  plans: {
    onSurfaceChanged: (callback: (payload: PlanSurfaceChangedEvent) => void) => () => void;
    /** List a workspace's plans for the "Plans" card gallery. Each row carries a
     *  cheap description snippet (summary-zone prose) for `html` surfaces. */
    list: (workspaceId?: string) => Promise<PlanListItem[]>;
    /** One row per valid folder in `<workspaceStateDir()>/plans/`. */
    listPromotedFolders: (
      workspaceId: string,
      workspaceRoot: string,
      pathType?: PathType,
    ) => Promise<PromotedPlanFolderListResult>;
    /** WP-P2C/P2D — the unified Plans-gallery projection: proposals + structured
     *  folder plans + legacy `format='html'` plans (md rows NEVER projected). */
    gallery: (workspaceId: string, opts?: PlanGalleryOptions) => Promise<PlanGalleryResult>;
    /** WP-P2C/P2D — read one proposal's markdown by its proposals-row id, with
     *  read-time containment + byte-cap re-validation. `{ error }` on failure. */
    readProposal: (proposalId: string) => Promise<ProposalReadResult | { error: string }>;
    /** WP-P4A — live folder-native tab projection and guarded body read. */
    documents: (planId: string) => Promise<PlanDocumentsModel | null>;
    readDocument: (
      planId: string,
      ref: PlanDocumentRef,
    ) => Promise<PlanDocumentReadResult | { error: string }>;
    /** Full activity projection (sections + trusted event trail) — the in-process
     *  mirror of GET /api/plans/:id/projection?events=full. `null` if unknown. */
    getProjection: (planId: string, opts?: { eventDetailId?: string }) => Promise<PlanActivityProjection | null>;
    /** WP-P2L-proj — ledger/orchestration/disk-derived intent confidence read. */
    listIntents: (planId: string) => Promise<PlanIntentsProjection | null>;
    /** WP-P7C - file-level contribution evidence; never exact-line authorship. */
    blameToIntent: (request: BlameToIntentRequest) => Promise<BlameToIntentResult | null>;
    /** WP-P4C-backend — the stored, supervisor-authored per-tab overview for
     *  the stable `PlanTabKey`. Read is open (any renderer); `null` when the key
     *  is unset or the id/tab is invalid. */
    getOverview: (planId: string, tab: PlanTabKey) => Promise<PlanTabOverview | null>;
    /** WP-P4C-backend — write (revision-bumping) the per-tab overview. Gated
     *  SERVER-side by `hasSupervisorPrivilege` + same-workspace membership;
     *  rejects (throws) for a non-supervisor or an unknown plan/agent. */
    setOverview: (input: {
      planId: string;
      tab: PlanTabKey;
      body: string | null;
      supervisorId: string;
    }) => Promise<PlanTabOverview>;
    /** Sandboxed render-pane lifecycle, same bounds-handoff as the browser pane:
     *  the renderer streams the pane rectangle while main drives the view. */
    paneShow: (planId: string) => Promise<void>;
    paneHide: () => Promise<void>;
    paneSetBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>;
    /** Visibility-only pane toggle (no document reload) — lets a renderer overlay
     *  such as the Plans gallery temporarily hide the native pane so DOM wins. */
    paneSetVisible: (visible: boolean) => Promise<void>;
    /** SC-WP-3I — plan-lens candidate preview (read-only). Runs the SAME WP-3G
     *  `buildCandidate` service as the save lens, so it returns identical identity +
     *  member verdicts plus the D-1-filtered whole-component selection for the shared
     *  `CandidatePreview` component. Rejects until the engine route is injected. */
    previewCandidate: (req: PlanCandidatePreviewRequest) => Promise<PlanCandidatePreviewResponse>;
    /** WP-P3C′ — promote a proposal into a plan (supervisor picker, §P3-GAP: NO
     *  document selection). Returns promptly with the discriminated
     *  `PromoteProposalResult`; NEVER blocks on the folder watcher. Rejects
     *  (throws) when the supervisor is not a privileged same-workspace agent, or on
     *  a duplicate/foreign/launch-failed outcome. */
    promote: (input: { proposalId: string; supervisorId: string }) => Promise<PromoteProposalResult>;
    /** WP-P3C′ — the concrete status path a `promotion-pending` result resolves
     *  through: a runtime read over `promotion_requests` (+ the adopted `plans`
     *  row). The dialog polls this with bounded backoff. Rejects on an unknown id. */
    promotionStatus: (input: { promotionRequestId: string }) => Promise<PromotionStatus>;
    /** WP-P4D-proj / WP-P4E — the plan-comment projection that backs the comments
     *  rail: every comment on the plan (across its registered external documents
     *  AND its folder-doc logical targets) rolled up with its reply thread and a
     *  resolved target descriptor. `null` for a malformed/empty plan id. */
    listComments: (planId: string) => Promise<PlanCommentsProjection | null>;
    /** WP-P4D-create / WP-P4E — create a comment on a plan document. The renderer
     *  supplies ONLY the `planId`, an opaque `PlanDocumentRef`, and a body (+
     *  optional display anchors); the server picks the recipient (the plan's
     *  current responsible supervisor) and builds the durable `file_path`. */
    createComment: (req: PlanCommentCreateRequest) => Promise<PlanCommentCreateResult>;
    /** WP-P4D-reply / WP-P4E — answer a plan comment with a companion reply. The
     *  service revalidates `callerAgentId` against the plan's current responsible
     *  supervisor server-side; a non-responsible id is rejected. */
    replyComment: (req: AnswerPlanCommentRequest) => Promise<AnswerPlanCommentResult>;
  };
  /** WP-P1B: read-only planning reader. `list` enumerates bare proposals + §R0
   *  plan folders and is a pure mount/refresh read (emits NO demand-probe);
   *  `read` fetches one document by its OPAQUE server-issued manifest id. A
   *  voluntary open is instrumented separately via `demandProbe.record`. */
  planningReader: {
    list: (workspaceRoot: string, pathType?: PathType) => Promise<PlanningReaderListResult>;
    read: (docId: string, pathType?: PathType) => Promise<PlanningReaderReadResult | { error: string }>;
  };
  /** WP-P0PRE: voluntary demand-probe recorder. `source` is stamped in main from
   *  the transport, never from this payload; `workspaceId` selects the sink. */
  demandProbe: {
    record: (req: {
      workspaceId: string;
      kind: 'proposal_authored' | 'promotion_requested' | 'reader_open' | 'savecard_open';
      feature_exercise?: boolean;
      manual_class?: string;
      eventId?: string;
    }) => Promise<{ appended: boolean; duplicate: boolean; reason?: string; eventId?: string; file?: string }>;
  };
  onAgentStatusChanged: (callback: (data: { agentId: string; status: AgentStatus; agent: Agent; source?: string }) => void) => () => void;
  onAgentDeleted: (callback: (data: { agentId: string }) => void) => () => void;
  onOpenFileTab: (callback: (payload: OpenFileTabRequest) => void) => () => void;
  onTeamUpdated: (callback: (team: Team) => void) => () => void;
  onTeamMessageCreated: (callback: (message: TeamMessage) => void) => () => void;
  // Supervisor ids that currently own an active (starting/running) orchestration
  // deliberation (e.g. groupthink). The owner-container border keeps pulsing for
  // these supervisors even while their planner agents are idle between turns.
  listActiveOrchestrations: () => Promise<string[]>;
  onOrchestrationActiveChanged: (callback: (supervisorIds: string[]) => void) => () => void;
  /** Memory watchdog (incident-2026-07-11 §5 D5). Renderer-facing read surface:
   *  the status-bar meter/banner poll `getSnapshot` + subscribe to `onPressure`;
   *  the orphan-sweep panel lists candidates, estimates reclaimable bytes, and
   *  reaps. Read-only except `reapOrphans` (each tree re-verified before any kill). */
  memory: {
    getSnapshot: () => Promise<MemorySnapshotDto | null>;
    getAttribution: () => Promise<AttributionDto | null>;
    /** Composed System-Memory view: live registry rows joined to attribution +
     *  the commit-charge breakdown (System-Memory polish Part 2). */
    getSystemView: () => Promise<SystemMemoryViewDto | null>;
    onPressure: (callback: (snap: MemorySnapshotDto) => void) => () => void;
    listOrphans: () => Promise<OrphanCandidateDto[]>;
    reapOrphans: (agentIds: string[]) => Promise<ReapOrphansResultDto[]>;
    /** Best-effort working-set bytes for a PID set (the "reap now" estimate). */
    reapEstimate: (pids: number[]) => Promise<number>;
  };
  /** Memory & Lessons v2 review surface (WP-H1). A renderer-only Electron IPC
   *  read of the per-workspace review queue + persisted index-invalid/runtime
   *  state. NOT an MCP tool and NOT an api-server route — no agent can reach it. */
  memoryReview: {
    listReview: (workspaceId: string) => Promise<MemoryReviewSummaryDto>;
    /** WP-H2 — the deterministic janitor brief for the workspace (no launch). */
    generateJanitorBrief: (workspaceId: string) => Promise<MemoryJanitorBriefDto>;
    /** WP-H2 — dispatch a janitor agent via the user launch path, brief as its
     *  initial prompt. Renderer-only; never an MCP tool or api-server route. */
    dispatchJanitor: (workspaceId: string) => Promise<MemoryJanitorDispatchDto>;
    /** WP-H3 — human-only: APPROVE == apply a graduation proposal into its
     *  workspace-root doc (the only applier; CAS-guarded, under the workspace
     *  lock). Renderer-only; never an MCP tool or api-server route. */
    graduationApprove: (workspaceId: string, proposalId: string) => Promise<MemoryGraduationApplyDto>;
    /** WP-H3 — human-only: reject a graduation proposal (DB status only). */
    graduationReject: (workspaceId: string, proposalId: string) => Promise<MemoryIpcOkDto>;
    /** WP-H3 — human-only: record a migration approval (snapshot + table hash)
     *  that WP-I2's signed migration consumes. Renderer-only. */
    migrationApprove: (
      workspaceId: string,
      snapshotId: string,
      tableHash: string,
    ) => Promise<MemoryIpcOkDto>;
  };
  /** Detached-process transparency (incident-2026-07-11 §5 Wave 5). Lists the
   *  agent-launched detached processes that self-registered under
   *  <workspaceRoot>/.lares/detached/, each verified against its live PID. */
  detached: {
    list: (workspaceRoot: string) => Promise<DetachedProcessDto[]>;
  };
  /** Git-Native WP-G2.2 — the HUMAN renderer's checkpoint recovery surface,
   *  workspace-scoped. Mirrors the capability-bound HTTP routes (WP-G2.1) for
   *  agents, but this path is TRUSTED (it's the renderer, no capability token)
   *  while reusing the same domain checks (witnessed-subset, preview token) via the
   *  shared engine/service surface. `restore`/`revert` accept a `force`
   *  (stale-preview override) that is IPC-ONLY and refused while an active turn
   *  witnesses a requested path. */
  /** Lens-neutral commit consume surface used by both Save and Plan. Main-process
   *  flag enforcement remains authoritative even for direct IPC invocation. */
  commitCoordinator: {
    commit: (req: CommitCoordinatorConsumeRequest) => Promise<CommitCoordinatorConsumeResponse>;
  };
  /** Save card: read-only dirty inventory (Stage ①) + the SC-WP-3H Save-lens
   *  candidate preview (also read-only — verdicts + read-only `Lares-*` trailer
   *  previews). No mutating method is exposed here. */
  saveCard: {
    getInventory: (req: SaveCardInventoryRequest) => Promise<SaveCardInventoryResponse>;
    preview: (req: SaveCardPreviewRequest) => Promise<SaveCardPreviewResponse>;
    /** Explicitly freeze and pin a fleet-adhoc package boundary. */
    markDone: (
      req: SaveCardFleetAdhocMarkDoneRequest,
    ) => Promise<SaveCardFleetAdhocMarkDoneResponse>;
    /** SC-WP-N2 — lightweight checkpoint-expiry attention read (no full inventory
     *  probe). Resolves the freshest notice for the workspace, or null. */
    getAttention: (req: SaveCardAttentionRequest) => Promise<SaveCardCheckpointExpiryNotice | null>;
    /** SC-WP-N2 — subscribe to per-workspace attention pushes. Returns an unsubscribe. */
    onAttentionChanged: (
      callback: (payload: SaveCardAttentionChangedPayload) => void,
    ) => () => void;
  };
  checkpoints: {
    list: (workspaceId: string, opts?: { agentId?: string }) => Promise<CheckpointListResult>;
    diff: (workspaceId: string, turnId: string) => Promise<CheckpointDiffResult>;
    preview: (workspaceId: string, turnId: string, paths?: string[]) => Promise<CheckpointPreviewResult>;
    restore: (req: CheckpointRestoreRequest) => Promise<CheckpointRestoreResult>;
    revert: (req: CheckpointRevertRequest) => Promise<CheckpointRestoreResult>;
    /** WP-G3.1 — versions of ONE canonical path across retained, live-verified
     *  turns (file right-click → History). */
    fileHistory: (workspaceId: string, path: string, opts?: { agentId?: string }) => Promise<CheckpointFileHistoryResult>;
    /** WP-G3.4 — human-only consent action: `git init` a non-repo workspace to
     *  enable checkpoints. Refuses honestly when the workspace is already a repo,
     *  a protected root, or git is unusable. */
    gitInit: (workspaceId: string) => Promise<GitInitResult>;
    /** WP-G3.5 — delete this workspace's checkpoint + recovery refs (both encoded
     *  namespaces) in one atomic batch; objects are left for normal git maintenance.
     *  Same semantics as the supervisor MCP tool / capability route. */
    prune: (workspaceId: string) => Promise<CheckpointPruneResult>;
    /** WP-G3.5 — the DISTINCT human-only pre-`filter-repo` purge. `pruneRepoWidePlan`
     *  enumerates and NAMES every affected workspace in the (possibly shared) repo
     *  WITHOUT deleting; `pruneRepoWide` applies it only under `confirm: true`. Never
     *  an MCP tool / HTTP route — there is no unscoped `--all` on the agent surface. */
    pruneRepoWidePlan: (workspaceId: string) => Promise<RepoWidePurgeResult>;
    pruneRepoWide: (req: { workspaceId: string; confirm: boolean }) => Promise<RepoWidePurgeResult>;
  };
}

// ───────────────────────── Context-Overhead Analyzer ─────────────────────────
// Produced by the trusted main-process OverheadService (src/main/context-overhead/).
// The React panel is a PURE CONSUMER of OverheadModel (preserves the Option-C seam:
// a future browser-pane render reuses this same projection unchanged).

export type TokenCountMethod =
  | 'anthropic-count-tokens'   // exact; Phase 3, only when a client is injected
  | 'tiktoken-approx'          // js-tiktoken cl100k_base (Phase-1 default)
  | 'chars-heuristic';         // ceil(chars/3.5) fallback when encoder unavailable

export interface TokenEstimate {
  tokens: number;
  bytes: number;
  chars: number;
  method: TokenCountMethod;
  approximate: boolean;        // true unless method === 'anthropic-count-tokens'
}

// ── WP2 (G2) — provider-aware guidance-source model ──────────────────────────
// AGENTS.md becomes a first-class guidance surface WITHOUT touching Claude
// walk-up semantics. Every guidance file carries WHO loads it
// (`audienceProviders`), UNDER WHICH model it applies (`applicability`), and HOW
// confident we are in the loading semantics claim. `'unknown'` audiences can
// never support `complete` capture coverage nor a resolved recommendation
// target — the explicit, disclosed state, never a silent default.

export type GuidanceFileKind = 'claude-md' | 'claude-local-md' | 'agents-md';

/** How a guidance file reaches an agent's context:
 *  - `walk-up-chain`   — the Claude CLAUDE.md walk-up (UNCHANGED semantics).
 *  - `directory-chain` — AGENTS.md on the chain from workspace root to the
 *    launch cwd of a captured stream; deeper files override applicable parent
 *    guidance. Applicability is never inferred from launch cwd alone for
 *    below-cwd files.
 *  - `inventory-only`  — a below-cwd / off-chain file: costed and listed (WP7),
 *    NEVER fed to per-agent costing or liveness until a captured task/file
 *    scope proves applicability. */
export type GuidanceApplicabilityModel = 'walk-up-chain' | 'directory-chain' | 'inventory-only';

export interface GuidanceSource {
  /** Absolute path of the guidance file. */
  path: string;
  fileKind: GuidanceFileKind;
  /** Provider identifiers ('claude', 'codex', …) whose loading of this file is
   *  documented for the lane context, or the explicit literal 'unknown'. */
  audienceProviders: string[] | 'unknown';
  applicability: {
    model: GuidanceApplicabilityModel;
    /** The next guidance file UP the same chain (directory-chain only). */
    chainParent?: string;
  };
  /** Confidence in the loading-semantics claim behind `audienceProviders`. */
  loadingSemanticsConfidence: 'documented' | 'assumed' | 'unknown';
}

/** WP2 capture-coverage state for audience-scoped liveness records.
 *  `observed` = ≥1 captured stream whose provider is in the audience (PRESENCE,
 *  not completeness); `partial`/`none` per measured overlap; `complete` is
 *  emitted ONLY when a measured denominator exists (the capture source
 *  enumerates the analysis window's streams). Only `complete` may support a
 *  dead verdict — every other state forces the fail-closed
 *  `capture-incomplete` downgrade. */
export type GuidanceCaptureCoverage = 'complete' | 'observed' | 'partial' | 'none' | 'unknown';

export type OverheadSourceKind =
  | 'agent-claude' | 'inherited-claude' | 'claude-local' | 'user-claude'
  | 'managed-policy' | 'rules' | 'memory' | 'behavioral'
  // WP2 (G2): an AGENTS.md on the root→cwd directory chain, applicable to this
  // agent's provider. Only emitted for agents whose provider is in the file's
  // documented audience — never a Claude-resident target (resident-inventory).
  | 'agents-md'
  // Memory costing split (Wave-2 §1), mirroring skill-header/skill-body. `memory-index`
  // = resident head actually injected (0 today: autoMemoryEnabled:false + manual read);
  // `memory-body` = on-demand pool (measured size, NOT injected each session). Legacy
  // `'memory'` kept for external consumers but NO LONGER emitted by walk-up.
  | 'memory-index' | 'memory-body'
  | 'settings-hooks'
  // Skill costing split (P1.1). `skill-header` = resident YAML frontmatter
  // (counted in the always-on baseline); `skill-body` = on-invoke body (scenario
  // overlay, excluded from the header-view baseline). Legacy `'skill'` is kept in
  // the union for external consumers but is NO LONGER emitted by walk-up.
  | 'skill' | 'skill-header' | 'skill-body'
  | 'import' | 'mcp-tool-schema'
  | 'system-baseline' | 'unknown';

// NOTE (R3): naming is unified on `managed` (matches the legitimacy report's
// "managed policy" terminology). R1's `enterprise` term is retired — do NOT use it.
export type InheritanceScope =
  | 'agent' | 'workspace-ancestor' | 'parent-ancestor'
  | 'user' | 'managed' | 'additional-dir' | 'unknown';

export interface OverheadSource {
  id: string;                  // stable: `${dedupeKey}#${kind}`
  kind: OverheadSourceKind;
  label: string;
  resolvedPath: string | null; // absolute; null for synthetic (MCP server total, baseline)
  dedupeKey: string;           // resolvedPath ?? synthetic key — drives de-dup + memo
  sourceScope: InheritanceScope;
  openable: boolean;           // DERIVED: resolvedPath != null && a viewable file kind
  exists: boolean;
  inherited: boolean;          // pulled via walk-up, not the agent's own dir
  estimate: TokenEstimate;
  // How this source was produced (P1.2). `frontmatter-split` marks the two skill
  // rows emitted from a single SKILL.md via `splitFrontmatter`.
  origin: 'walk-up' | 'import' | 'glob' | 'frontmatter-split';
  // Skill rows only: which disclosure tier this row represents. Drives the
  // evidence badge (neutral wording until the Phase-0 gate validates injection).
  disclosureState?: 'advertised-header' | 'scenario-body';
  // Disclosure tier for truthful accounting (Wave-2 §1). `resident` = injected into
  // context every session (counts toward the overhead headline). `on-demand` = disclosed
  // only when read/invoked (shown in a separate pool, NEVER in the headline).
  // skill-header/memory-index → resident; skill-body/memory-body → on-demand; all other
  // kinds → resident. Optional at the type level so pre-existing OverheadSource fixtures
  // outside this pipeline still compile; the analyzer/walk-up populate it on every source
  // (a missing value is treated as `resident` by consumers).
  disclosureTier?: 'resident' | 'on-demand';
  // Edit-safety class for the mutability badge (§3.1). Inlined union rather than
  // importing the main-side `MutabilityClass` so `shared/` stays dependency-free.
  mutable: 'user-owned' | 'scaffold-managed' | 'generated-vendor';
  children?: OverheadSource[]; // @import subgraph nested under the importing source
  warnings?: string[];
  // WP2 (G2): the provider-aware guidance-source record behind this row. Populated
  // by the analyzer for CLAUDE-family and agents-md sources; optional so external
  // fixtures compile unchanged.
  guidanceSource?: GuidanceSource;
}

// Section weight status (Wave-2 req 3). SIX values — never collapse to binary dead/live.
// This plan's structural classifier emits ONLY the last four; `live`/`dead` require behavior
// data (a later plan) and are defined here so the type is stable and the UI can render them
// when populated.
//   live                  — observed behavior exercises this guidance (needs behavior corpus).
//   dead                  — sufficient exposure exists but guidance is never exercised (needs corpus).
//   structurally-broken   — a concrete reference provably does not resolve (missing file /
//                           absent skill / ungranted toolset). Actionable dead weight, provable now.
//   insufficient-evidence — has references that DO resolve, but no behavior data to judge live/dead.
//   unobservable          — pure prose with no mechanical predicate; cannot be judged either axis.
//   not-analyzed          — classification did not run (file too large, read failed, etc.).
export type SectionWeightClass =
  | 'live' | 'dead' | 'structurally-broken'
  | 'insufficient-evidence' | 'unobservable' | 'not-analyzed';

export interface ConfigSectionWeight {
  sourcePath: string;          // absolute path of the CLAUDE.md/config file
  sourceLabel: string;         // walk-up row label
  scope: InheritanceScope;
  heading: string;             // section heading text ('(preamble)' for pre-heading content)
  startLine: number;           // 1-based; for click-through highlight
  endLine: number;
  tokens: number;              // resident cost of this section
  weightClass: SectionWeightClass;
  // Structural-resolution facts ONLY. Feeds the tooltip. Never itself a verdict.
  evidence: string[];
  // WP2 (G2): the guidance source this section was cut from. Optional so
  // pre-existing fixtures compile; the classifier populates it whenever the
  // owning OverheadSource carries one.
  guidanceSource?: GuidanceSource;
  // WP5 (G5, v2-optional): the shared section-identity key
  // (`${targetType}:${targetKey}:${rawAnchor}`, shared/section-identity.ts) —
  // the SAME key occurrence verdicts carry (`sourceSectionKey`), so the
  // behavior join is a key-equality join, never a reconstruction. Embeds an
  // absolute path; DTO projections strip it (overhead-dto redactRollup).
  sectionKey?: string;
  // WP5 (G5, v2-optional): the SEPARATE behavior axis (section-liveness.ts).
  // Structural `weightClass` is untouched — a structurally-broken + observed
  // section exports BOTH axes. Absent ⇒ the behavior join did not run / could
  // not key this section (never a claim of deadness).
  behaviorStatus?: SectionBehaviorStatus;
  // WP5 (G5, v2-optional): per-provider-cohort statuses — ALWAYS exported
  // alongside `behaviorStatus` when the join ran (cohort disagreement forces
  // the top-level status to 'mixed', but the map keeps the per-cohort truth).
  behaviorStatusByCohort?: Record<string, SectionBehaviorStatus>;
}

// WP5 (G5) — the behavior-status axis for config sections. STRICT lattice
// (section-liveness.ts): `dead` requires every analyzable node dead via the
// fail-closed never-gates AND captureCoverage `complete` AND zero
// unmatchable/unobservable nodes; anything less fails closed.
export type SectionBehaviorStatus =
  | 'live' | 'dead' | 'mixed' | 'unobservable'
  | 'capture-incomplete' | 'insufficient-evidence' | 'not-analyzed';

/** WP5 (G5, v2-optional): one joined behavior record per section identity —
 *  identifiers + counts only (redaction-safe by construction; the embedded
 *  `sectionKey` path is redacted/stripped at every emission boundary). */
export interface SectionBehaviorRecord {
  sectionKey: string;
  behaviorStatus: SectionBehaviorStatus;
  behaviorStatusByCohort: Record<string, SectionBehaviorStatus>;
  nodeCounts: {
    total: number;
    observed: number;
    /** `never` verdicts that PASSED the fail-closed never-gates (`evidenceState
     *  === 'auditable'`) — the only nodes that may support dead. */
    deadFailClosed: number;
    unobservable: number;
    captureIncomplete: number;
    /** Actions with no verdict (analysis gap) — bars `dead`, disclosed. */
    unpaired: number;
  };
}

export interface ConfigWeightRollup {
  sections: ConfigSectionWeight[];
  // Token totals bucketed by status; all six keys always present (0 when empty) so the UI
  // never has to guess a missing bucket.
  // WP2 (G2): this rollup NEVER sums across `fileKind` — it covers only the
  // Claude-config sections (the pre-WP2 population). AGENTS.md sections appear
  // exclusively in `tokensByClassByFileKind['agents-md']`.
  tokensByClass: Record<SectionWeightClass, number>;
  // WP2 (G2, v2-optional): per-fileKind buckets. Keys are GuidanceFileKind values
  // plus 'claude-config' for legacy non-GuidanceSource config surfaces
  // (rules/settings). Consumers must never sum buckets across keys.
  tokensByClassByFileKind?: Record<string, Record<SectionWeightClass, number>>;
  // WP5 (G5, v2-optional): token totals bucketed by the SEPARATE behavior axis
  // (config-weight `rollupTokensByBehavior`, parallel to `tokensByClass`).
  // Present only after the section-liveness join ran. Sections without a
  // joined `behaviorStatus` count under 'not-analyzed'; agents-md sections are
  // excluded (never summed across fileKind), mirroring `tokensByClass`.
  tokensByBehavior?: Record<SectionBehaviorStatus, number>;
}

export interface InheritanceFrame {
  dir: string;                 // absolute ancestor directory
  scope: InheritanceScope;
  distanceFromAgentCwd: number;// 0 = agent dir; ancestors POSITIVE; user = -1, managed = -2 (R4)
  included: boolean;           // found AND actually inherited (false if shadowed/gated-out)
  sources: OverheadSource[];   // CLAUDE.md / CLAUDE.local.md / .claude/CLAUDE.md / rules / imports here
}

export type McpSchemaSource =
  | 'dashboard-module'         // static get*ToolDefinitions() in scripts/
  | 'config-named-only'        // named in ~/.claude.json; schema NOT sourced
  | 'plugin-manifest' | 'live-server' | 'unknown';

export interface McpToolOverhead {
  name: string;
  descriptionTokens: number;   // estimate of name + '\n' + description
  inputSchemaTokens: number;   // estimate of JSON.stringify(inputSchema)
  estimate: TokenEstimate;     // total serialized {name,description,input_schema}
  schemaSource: McpSchemaSource;
}

export interface McpServerOverhead {
  id: string;
  displayName: string;
  source: 'dashboard-injected' | 'user-global' | 'plugin' | 'unknown';
  configPath: string | null;   // click target when present (D-2); openability is DERIVED from this (R6)
  grantedToAgent: boolean;
  excludedByStrictMode: boolean;// true ⇒ counted 0 for this agent (strict lane)
  schemaSourced: boolean;      // false ⇒ named-but-not-measured (warning)
  total: TokenEstimate;        // 0-valued estimate when excludedByStrictMode
  tools: McpToolOverhead[];
  warnings: string[];
}
// (R6) McpServerOverhead intentionally has NO `openable` field — the renderer
// derives clickability as `configPath != null` so the two can never drift.

export interface AgentContextOverhead {
  id: string;
  name: string;
  kind: 'builtin-supervisor' | 'builtin-researcher' | 'builtin-worker' | 'persona';
  lane: AgentRoleLane;         // reuse existing shared type; drives strict-mode
  workingDir: string;
  pathType: PathType;
  sidecarPath?: string;
  inheritanceChain: InheritanceFrame[];  // nearest→root, then user, then managed
  mcpServers: McpServerOverhead[];
  flatSources: OverheadSource[];         // denormalized for chart stacking
  total: TokenEstimate;                  // agent-variable overhead (EXCLUDES systemBaseline & strict-excluded MCP)
  // Header-view baseline (P1.2/P1.3): all skill *headers* + non-skill always-on
  // overhead, i.e. `total` with every skill body excluded. Additive field; the
  // `total`-changing behavior itself is gated behind the Phase-0 disclosure
  // validation (see context-overhead-analyzer.ts PHASE0_DISCLOSURE_VALIDATED).
  totalHeaderView: TokenEstimate;
  // Truthful split (Wave-2 §1). `residentTotal` = every resident-tier source + counted MCP
  // (what actually enters context each session; this is the panel headline). `onDemandTotal`
  // = on-demand sources (skill bodies, memory body) — shown as a labeled pool, never in the
  // headline. `total` stays = residentTotal + onDemandTotal (worst case) for back-compat.
  // Optional so external OverheadSource/AgentContextOverhead fixtures compile; the analyzer
  // always populates all three.
  residentTotal?: TokenEstimate;
  onDemandTotal?: TokenEstimate;
  // Section-level weight classification for this agent's resident config (§D).
  configWeight?: ConfigWeightRollup;
  // WP2 (G2): every guidance source composed for this agent — the Claude walk-up
  // chain (unchanged semantics) plus the AGENTS.md directory chain. Includes
  // chain files NOT applicable to this agent's provider (they are listed but
  // never costed); optional so external fixtures compile.
  guidanceSources?: GuidanceSource[];
  // WP2 (G2): the provider identifier this agent's lane context runs under
  // ('claude', 'codex', …). Drives audience-filtered per-agent costing.
  provider?: string;
  exactness: 'exact' | 'mixed' | 'estimated';
  warnings: string[];
}

export interface OverheadModel {
  workspaceId: string;
  workspaceRoot: string;
  pathType: PathType;
  generatedAt: string;         // ISO; stamped by the IPC/caller layer, NOT the pure service
  estimatorMethod: TokenCountMethod;
  systemBaseline?: TokenEstimate;        // OPTIONAL/synthetic; shown separately, never per-agent
  agents: AgentContextOverhead[];
  // Per-workspace dead/live aggregate across all agents (§C3). Union of workspace-scoped
  // config sections, deduped by (sourcePath, heading).
  workspaceConfigWeight?: ConfigWeightRollup;
  globalWarnings: string[];
}

export interface ScanOverheadRequest {
  workspaceId: string;
  countTokens?: boolean;       // Phase-3 opt-in for exact path; ignored until implemented
}

// (R1) Typed, discriminated IPC result. Used CONSISTENTLY by handler + preload + panel.
export type ScanOverheadResult =
  | { ok: true; model: OverheadModel }
  | { ok: false; error: string };

// ── "What This Agent Knows" — knowledge graph (base plan P3 / master WP4) ──────
//
// DETERMINISTIC extraction from an agent's resolved config surfaces (the P1
// walk-up inheritance chain + `mcpInventory.forLane`) — NO LLM anywhere in the
// pipeline. Nodes are markdown-structure facts with a click-through provenance
// pointer back to the source line.
export type KnowledgeNodeType =
  | 'capability' | 'constraint' | 'tool' | 'memory' | 'workflow' | 'file-reference';

// ── Wave-2 knowledge ⇄ behavior linkage (§WP1) ─────────────────────────────────
//
// Precise, human-facing provenance role — distinct from `InheritanceScope` (which
// answers "which walk-up tier") because the feedback's north star is "WHICH
// CLAUDE.md" (this agent's own vs the workspace root vs an ancestor).
export type KnowledgeSourceRole =
  | 'agent-claude'      // this worker template's own CLAUDE.md
  | 'workspace-claude'  // repo-root CLAUDE.md (frame.dir === workspaceRoot)
  | 'ancestor-claude'   // other inherited CLAUDE.md up the walk-up
  | 'user-claude' | 'managed' | 'import' | 'skill' | 'mcp' | 'memory'
  // WP2 (G2): an applicable AGENTS.md on the root→cwd directory chain.
  | 'agents-md'
  | 'other';

// A byte-span back into the source file. `lineEnd` powers the WP4 highlight (a
// heading spans to the next same-or-higher heading; a bullet/path is a single line).
export interface KnowledgeSourceSpan { absPath: string; lineStart: number; lineEnd: number }

export type KnowledgeBehaviorStatus =
  | 'observed'               // a matching behavior predicate fired ≥1× in-window
  | 'never-observed'         // observable + enough lane exposure, but 0 matches (likely stale)
  | 'insufficient-exposure'  // observable but the lane has too little corpus to judge
  | 'unobservable';          // no mechanical predicate (pure prose) — not judgeable

export interface KnowledgeBehaviorEvidence {
  status: KnowledgeBehaviorStatus;
  actionKinds: string[];       // PredictedAction kinds the node compiled to
  occurrences: number;
  distinctStreams: number;
  distinctSlugs: number;
  lastObservedMs: number | null;
  exposureTurns: number;       // denominator from exposureForLane
  windowDays: number;          // recency window the counts cover (default 30)
  explanation: string;         // one-line, panel tooltip (definition + scope)
}

export interface KnowledgeFileReferenceStats {
  touches: number; reads: number; writes: number; executes: number;
  distinctStreams: number; lastTouchedMs: number | null; windowDays: number;
}

export interface KnowledgeNode {
  type: KnowledgeNodeType;
  label: string;                 // verbatim heading / bullet / token text (bounded)
  detail?: string;               // synopsis (first sentence) or surrounding context
  source: KnowledgeSourceSpan;   // 1-based span; absPath '' for path-less MCP servers (WP2)
  // Provenance: the walk-up `sourceScope` the node was inherited through (A11).
  sourceScope?: InheritanceScope;
  sourceRole: KnowledgeSourceRole;       // WP2 — precise agent-vs-workspace attribution
  sourceKind?: OverheadSourceKind;       // exact walk-up kind
  behavior?: KnowledgeBehaviorEvidence;  // WP3 — load-bearing vs stale
  fileReferenceStats?: KnowledgeFileReferenceStats; // WP3 (file-reference nodes only)
  // WP2 (G2): the owning guidance source's audience — providers documented to
  // load the file this node came from, or the explicit 'unknown'. Absent on
  // nodes from sources without a GuidanceSource record (MCP rows, fixtures).
  audienceProviders?: string[] | 'unknown';
}

export interface KnowledgeSourceFile {
  absPath: string;
  scope: InheritanceScope;
  kind: OverheadSourceKind;
  label: string;                 // walk-up row label (e.g. `CLAUDE.md`, `.claude/skills/foo/SKILL.md`)
  nodeCount: number;
}

export interface AgentKnowledgeGraph {
  agentId: string;
  agentName: string;
  nodes: KnowledgeNode[];
  sourceFiles: KnowledgeSourceFile[];
  generatedAtIso: string;        // stamped by the IPC/caller layer, not the pure extractor
}

export interface ExtractKnowledgeRequest {
  // `workspaceId` is additive vs the base-plan `{ agentId }` sketch — the main
  // process needs it to run the same walk-up scan the picker was populated from.
  workspaceId: string;
  agentId: string;
}

export type ExtractKnowledgeResult =
  | { ok: true; graph: AgentKnowledgeGraph }
  | { ok: false; error: string };

// ── Skill Usage Analytics — query layer results (base plan §P2 / master WP3) ───
//
// Read-only rollups over the WP2 parse foundation. TWO HARD RULES the shape
// encodes: (1) effectiveness is TWO TIERS never blended into one number — the
// advisory `observableScore` comes from the observable tier only, with every raw
// input surfaced beside it; the heuristic tier is shown but never folded in.
// (2) COST (A8) is a SEPARATE dimension rendered beside effectiveness, never
// blended into the composite.
export interface SkillUsageQuery {
  // WP-D fix leg: scope by the authoritative agents-join (session_id → agents.workspace_id),
  // NOT the structurally-NULL skill_invocations.workspace_root (A10 deferred). Mirrors the
  // vetted sibling McpToolUsageQuery.workspaceId. Unattributed rows are disclosed via
  // scopeMeta.droppedUnattributedCount, never silently hidden.
  workspaceId?: string;
  slug?: string;
  agentId?: string;         // reserved: historical rows are NOT per-agent (CLAUDE.md invariant)
  lane?: AgentRoleLane | 'unknown'; // NEW (skill-legibility A1) — agent-type scope via stream_lane_stats.lane
  sinceMs?: number;
  untilMs?: number;
  // WP-2B — workspace scope policy (parity with McpToolUsageQuery). Defaults to 'strict'
  // here (skill usage's vetted default is the honest agents-join scope); 'include-proxy'
  // is opt-in and admits slug-proxy rows ONLY when the slug uniquely maps to workspaceId.
  scopeMode?: WorkspaceScopeMode;
  /** Set by the scope resolver (NOT the raw caller): true when `slug` uniquely maps to
   *  `workspaceId`, which unlocks the slug-proxy leg of 'include-proxy'. */
  slugUniqueToWorkspace?: boolean;
}

export interface SkillMostUsedRow {
  skill: string;
  count: number;
  avgEffectiveness: number | null;   // mean observable composite; null when no scorable window
  lastUsedMs: number | null;
}

// Enriched (skill-legibility A2) so the timeline click-drill can show a real
// source identifier per invocation, and Agent-type / Workspace / Detection
// columns without any renderer-side lane derivation.
export interface SkillTimelineRow {
  tsMs: number;
  skill: string;
  slug: string | null;
  lane: string;                 // NEW — sls.lane (may be 'unknown')
  workspaceKey: string;         // NEW — COALESCE(workspace_root, si.slug, sls.slug, '(unknown)')
  detector: string;             // NEW — 'tool_use' | 'slash_command'
  id: string;                   // NEW — skill_invocations.id (source identifier)
  jsonlPath: string | null;     // NEW — source jsonl (shown, not opened)
}

export interface SkillGroupRow { key: string; count: number; }

export interface SkillContextSample {
  skill: string;
  tsMs: number;
  slug: string | null;
  workingDir: string | null;
  lane: string;                      // NEW (skill-legibility D7) — COALESCE(sls.lane,'unknown')
  detector: string;                  // 'tool_use' | 'slash_command'
  args: string | null;
}

// §P2.4 — per-skill two-tier effectiveness. `observableScore` is the ONLY scored
// number; the heuristic counts and every observable raw input are surfaced so the
// score never hides its inputs.
export interface SkillEffectiveness {
  skill: string;
  observableScore: number | null;    // ∈ [0,1] from the observable tier ONLY
  scoredInvocations: number;         // finalized windows that fed the composite
  positiveWindows: number;           // ≥1 non-error tool_result AND a clean end_turn
  errorWindows: number;              // window_error_results > 0
  repeatedSearchWindows: number;
  endedWithQuestionWindows: number;
  heuristic: { userCorrection: number; workflowFollowed: number };  // NEVER folded in
}

// A8 — per-skill token cost rollup (median + spread). Fresh input/output kept
// SEPARATE from cache reads (four-field spend model). Never blended into effectiveness.
export interface SkillCostRollup {
  skill: string;
  invocations: number;               // windows that carried usage
  freshMedian: number;               // median (input+cache_creation+output) per invocation
  freshP25: number;
  freshP75: number;
  freshInputMedian: number;          // input + cache_creation
  outputMedian: number;
  cacheReadMedian: number;           // resident re-read — reported separately, never spend
}

export interface SkillUsageResult {
  mostUsed: SkillMostUsedRow[];
  timeline: SkillTimelineRow[];
  timelineTruncated: boolean;        // true when the timeline hit its cap (no silent truncation)
  byWorkspace: SkillGroupRow[];      // COALESCE(workspace_root, si.slug, sls.slug, '(unknown)')
  byAgentType: SkillGroupRow[];      // NEW (skill-legibility A4) — COALESCE(sls.lane,'unknown')
  byAgentDir: SkillGroupRow[];       // COALESCE(working_dir, sls.working_dir, '(unknown)')
  byInvoker: SkillGroupRow[];        // detector — relabeled "Detection" in the UI
  contextSamples: SkillContextSample[];
  effectiveness: SkillEffectiveness[];
  cost: SkillCostRollup[];
  totalInvocations: number;
  // NEW (skill-legibility A4/req#5) — truthful accounting of the active scope.
  scopeMeta: {
    workspaceKeyIsSlugProxy: boolean; // true while workspace_root is unpopulated (today: always true)
    windowSinceMs: number | null;
    windowUntilMs: number | null;
    appliedLane: string | null;
    appliedSlug: string | null;
    // WP-D fix leg — honest workspace scoping (agents-join). Optional so the many
    // literal SkillUsageResult builders in tests need not all be updated; queries.ts
    // always populates them.
    appliedWorkspaceId?: string | null;
    /** Rows matching the base (lane/slug/window) filter that attribute to NO workspace
     *  and so can never match the workspace scope — disclosed, never silently hidden.
     *  0 when no workspace scope is applied. Mirrors the sibling MCP surface. */
    droppedUnattributedCount?: number;
    /** Whether `skill_invocations` holds ANY row at all — lets the DTO reserve the
     *  `empty_not_instrumented` state for a truly empty table (WB-01: don't assert an
     *  unproven cause) and distinguish it from a scope/window artifact. */
    hasAnyInvocations?: boolean;
    // WP-2B — workspace scope policy disclosure (parity with the MCP surface). Optional
    // so existing literal builders need not update; queries.ts always populates them.
    appliedScopeMode?: WorkspaceScopeMode;
    /** Rows admitted into a workspace scope ONLY via the slug-proxy leg (real id NULL,
     *  slug matches, slug uniquely maps). 0 outside 'include-proxy'. */
    proxyIncludedCount?: number;
  };
  generatedAtIso: string;
}

export type SkillUsageQueryResult =
  | { ok: true; data: SkillUsageResult }
  | { ok: false; error: string };

// ── MCP tool-level usage engine (wave2-mcp-tool-observability §2.1) ────────────
//
// The MCP usage surface OWNS per-tool MCP attribution — separate module + DTO so
// the MCP tab lazy-loads and an agent-facing read tool can reuse it without the
// skill effectiveness engine. Per-agent attribution is SESSION-BASED: a call is
// tied to a dashboard agent only when `session_id → agent_sessions → agents`
// hits (LEFT JOIN). Unmatched streams keep their rows in an honest
// "(unattributed)" bucket — never dropped, never implied to be a specific agent
// (CLAUDE.md shared-cwd invariant). Live corpus: ~93% of MCP calls are
// unattributed, so that bucket is first-class, not an edge case.
// ── Workspace-LEVEL attribution (Priority 0 / WP-2B) ──────────────────────────
//
// SEPARATE from the four LANE tiers below (which classify agent/lane attribution
// WITHIN a workspace population). A behavior row's WORKSPACE identity degrades
// through its own honesty ladder, strongest first:
//   - workspace-explicit             — a direct launch-time association wrote the id
//                                       (reserved; not emitted until launch metadata
//                                       is wired — the resolver never CLAIMS it).
//   - workspace-from-launch-session  — session → agent → workspace join resolves.
//   - workspace-from-root            — the launch cwd folded to a root owned by
//                                       EXACTLY one workspace (root is redacted, never
//                                       disclosed across the API boundary).
//   - workspace-slug-proxy           — no id, only the Claude project slug (a
//                                       workspace-LEVEL proxy, not a stable identity).
//   - workspace-unattributed         — no workspace signal at all; first-class, visible.
export type WorkspaceAttribution =
  | { tier: 'workspace-explicit'; workspaceId: string }
  | { tier: 'workspace-from-launch-session'; workspaceId: string }
  | { tier: 'workspace-from-root'; workspaceId: string } // root intentionally omitted
  | { tier: 'workspace-slug-proxy'; slug: string }
  | { tier: 'workspace-unattributed' };

export type WorkspaceAttributionTier = WorkspaceAttribution['tier'];
export type WorkspaceAttributionBreakdown = Record<WorkspaceAttributionTier, number>;

/** Scope-mode for a workspace-scoped behavior query (Priority 0 / WP-2B). Governs
 *  which workspace tiers are admitted into the scoped population:
 *   - 'strict'            — only rows with a REAL workspace identity (launch-session or
 *                           folded-root id). No slug proxy.
 *   - 'include-proxy'     — DEFAULT. Adds slug-proxy rows, but ONLY when the caller's
 *                           slug uniquely maps to the caller workspace (otherwise it
 *                           degrades to 'strict' to avoid cross-workspace leakage).
 *   - 'global-diagnostic' — no workspace filter; every row, with proxy/unattributed
 *                           counts reported separately. Diagnostics only. */
export type WorkspaceScopeMode = 'strict' | 'include-proxy' | 'global-diagnostic';

export interface McpToolUsageQuery {
  workspaceId?: string; // matched against the resolved workspace expr (see queries)
  slug?: string;
  agentId?: string;     // dashboard_agent_id (only attributed streams match)
  lane?: string;        // stream_lane_stats.lane
  sinceMs?: number;
  untilMs?: number;
  // WP-2B — workspace scope policy. Defaults to 'include-proxy'.
  scopeMode?: WorkspaceScopeMode;
  /** Set by the API/scope resolver (NOT the raw caller): true when `slug` uniquely maps
   *  to `workspaceId`, which is what unlocks the slug-proxy leg of 'include-proxy'. */
  slugUniqueToWorkspace?: boolean;
}

export interface McpToolRow {
  toolName: string;            // full mcp__agent-dashboard__browser_read_page
  toolShort: string;           // browser_read_page (server prefix stripped)
  toolset: string | null;      // browser (null = unknown / unresolved MCP tool)
  count: number;
  distinctStreams: number;
  lastTsMs: number | null;
}

export interface McpToolsetRollup {
  toolset: string | null;
  count: number;
  distinctStreams: number;
  tools: McpToolRow[];
}

// by lane / workspace / agent / session. `label` carries the human name
// (agent title / workspace title / '(unattributed)'); `key` is the group value.
export interface McpUsageGroupRow {
  key: string;
  label: string;
  count: number;
  agentId?: string | null;     // present on byAgent rows (nullable — unattributed)
}

// ── Attribution as a confidence-bearing product output (WP-C / P2) ────────────
//
// Four-tier honest attribution for an MCP call. Precedence, strongest first:
//   1. agent-attributed                  — session/agent metadata resolves to ONE
//                                          agent (session-based; still capped by the
//                                          cwd-uniqueness invariant, never "direct").
//   2. lane-attributed-explicit          — runner / terminal / session lane metadata
//                                          (stream_lane_stats.lane) is present.
//   3. lane-inferred-from-current-grant  — no explicit lane, but the tool's toolset is
//                                          granted to EXACTLY ONE lane today
//                                          (`toolsetsForLane`). Lower confidence,
//                                          carries a reason. NEVER emitted for a toolset
//                                          granted to > 1 lane. True grant-epoch history
//                                          (config_epochs) is explicitly deferred.
//   4. unattributed                      — retained, visible, never dropped, never
//                                          implied to be a single agent.
export type AttributionTier =
  | 'agent-attributed'
  | 'lane-attributed-explicit'
  | 'lane-inferred-from-current-grant'
  | 'unattributed';

/** Per-tier call counts. The four tier counts sum to totalCalls. */
export type AttributionTierBreakdown = Record<AttributionTier, number>;

/** Lane-coverage confidence band — applies to LANE-tier claims ONLY. A per-agent
 *  claim is NEVER promoted to 'direct' on coverage strength; the cwd-uniqueness
 *  invariant caps per-agent confidence regardless of coverage. */
export type AttributionCoverageBand = 'direct' | 'cautioned' | 'provisional' | 'diagnostic';

/** One cell of the tool × lane cross-tab: how many calls of a given MCP tool
 *  resolved to a given lane, and by which attribution tier. `lane` is
 *  '(unattributed)' for the tier-4 bucket, which is kept first-class. */
export interface McpToolLaneCell {
  toolName: string;
  toolShort: string;
  toolset: string | null;
  lane: string;
  tier: AttributionTier;
  count: number;
}

export interface McpToolUsageResult {
  byTool: McpToolRow[];
  byToolset: McpToolsetRollup[];
  byAgent: McpUsageGroupRow[];    // unmatched streams collapse to '(unattributed)'
  bySession: McpUsageGroupRow[];  // group by stream_id — "session / agent run"
  byWorkspace: McpUsageGroupRow[];
  byLane: McpUsageGroupRow[];
  timeline: Array<{ tsMs: number; toolShort: string; toolset: string | null }>;
  timelineTruncated: boolean;
  totalCalls: number;
  attributedCalls: number;        // calls whose session resolved to a dashboard agent
  // ── Four-tier attribution (WP-C / P2). byToolLane / tierBreakdown / coverage live
  //    on this shared enriched result so the IPC panel and the lean MCP-route DTO
  //    tell the same story. ──
  byToolLane: McpToolLaneCell[];  // tool × lane cross-tab, honest four-tier
  tierBreakdown: AttributionTierBreakdown;
  attributedCount: number;        // tiers 1–3 — an agent OR a lane signal resolved
  unattributedCount: number;      // tier 4 — no agent, no lane, no exclusive-grant
  attributionCoveragePct: number; // attributedCount / totalCalls × 100 (0 if none)
  scopeMeta: {
    // stream_lane_stats.workspace_id/workspace_root are unpopulated today, so
    // the workspace dimension degrades to the Claude project slug — disclosed.
    workspaceKeyIsSlugProxy: boolean;
    attributionIsSessionBased: true;
    // When a workspace scope is applied, MCP calls that attribute to NO workspace
    // (session-based attribution missed and stream_lane_stats.workspace_id is
    // unpopulated) can never match any workspaceId and are silently excluded by
    // the filter. This is the count of those hidden rows, so the panel can
    // disclose them instead of breaking "attributed + unattributed = total".
    // 0 when no workspace scope is applied.
    droppedUnattributedCalls: number;
    appliedLane: string | null;
    appliedSlug: string | null;
    appliedAgentId: string | null;
    windowSinceMs: number | null;
    windowUntilMs: number | null;
    // ── WP-2B workspace-lineage disclosure. Optional so the many literal scopeMeta
    //    builders (DTO layer + tests) need not all be updated; the query always
    //    populates them. ──
    /** The scope-mode actually applied (defaults to 'include-proxy'). */
    appliedScopeMode?: WorkspaceScopeMode;
    /** Per-workspace-tier call counts over the base (non-workspace-filtered)
     *  population — how every matching row attributes to a workspace, so proxy /
     *  unattributed rows are reported SEPARATELY from the real-identity tiers. Sums to
     *  totalCalls before the workspace filter. */
    workspaceAttribution?: WorkspaceAttributionBreakdown;
    /** Rows admitted into a scoped result ONLY via the slug-proxy leg of 'include-proxy'
     *  (i.e. they carried no real workspace id). 0 under 'strict'/'global-diagnostic' or
     *  when no proxy leg fired — lets the panel disclose "N of these are slug-proxy". */
    proxyIncludedCalls?: number;
  };
  generatedAtIso: string;
}

export type McpToolUsageQueryResult =
  | { ok: true; data: McpToolUsageResult }
  | { ok: false; error: string };

/** Lean MCP-route rollup (WP-C / P2). The `get_mcp_tool_usage` MCP tool returns THIS
 *  (inside the AgentDtoResponse envelope) instead of the full `McpToolUsageResult`:
 *  top-line totals, top-N `byTool`, a capped `byToolLane` cross-tab, the four-tier
 *  `tierBreakdown` + coverage %, a capped timeline, and a next-drill hint. Full
 *  per-session detail moves behind an explicit pagination/filter param. Target
 *  ≤ ~15k serialized chars. The IPC panel keeps the enriched `McpToolUsageResult`. */
export interface McpToolUsageRollupDTO {
  totalCalls: number;
  attributedCount: number;
  unattributedCount: number;
  attributionCoveragePct: number;
  /** Confidence band for the LANE coverage figure only (never a per-agent claim). */
  laneCoverageBand: AttributionCoverageBand;
  tierBreakdown: AttributionTierBreakdown;
  byTool: McpToolRow[];              // top-N by count
  byToolLane: McpToolLaneCell[];     // capped tool × lane cross-tab
  byLane: McpUsageGroupRow[];
  timeline: Array<{ tsMs: number; toolShort: string; toolset: string | null }>;
  timelineTruncated: boolean;
  scopeMeta: McpToolUsageResult['scopeMeta'];
  /** Human hint for the next honest drill (e.g. which lane/tool to filter, or that
   *  coverage is too low for a lane-specific claim). */
  nextDrill: string;
  generatedAtIso: string;
}

// ── MCP tool-grant dead-weight (wave2-mcp-tool-observability §3.1) ─────────────
//
// Granted-but-uninvoked MCP tools per lane, gated by exposure so a tool with too
// few turns to judge is 'insufficient-exposure', not falsely 'dead'. Schema
// tokens reuse the same estimator the tool-schemas view sizes with, so the
// reclaim figure matches. Lives in the analytics layer, never in the static scan.
export interface DeadMcpToolGrantRow {
  lane: string;
  toolset: string;
  toolName: string;            // full mcp__agent-dashboard__<name>
  toolShort: string;
  schemaTokens: number;        // per-tool resident schema cost
  exposureTurns: number;       // Σ stream_lane_stats.turn_count for the lane/scope
  exposureStreams: number;
  status: 'dead' | 'insufficient-exposure';
  suggestedAction: string;     // "Exclude '<toolShort>' from the <lane> MCP grant."
}

export type McpDeadWeightResult =
  | { ok: true; data: DeadMcpToolGrantRow[] }
  | { ok: false; error: string };

// ── Resident assets (context-optimizer R2 WP-3 / Priority 1) ───────────────────
//
// First-class model for the two largest unmodeled subtract opportunities: an
// advertised skill HEADER (resident every session so the agent can discover the
// skill) and a granted MCP tool SCHEMA. Both already carry a token estimate in the
// static scan (skill-header sources; McpServerOverhead per-tool + per-toolset totals);
// this promotes them from lane-total line-items to individually rankable assets so the
// engine can size an unused-skill/-toolset subtract by its REAL schema/header cost.
//
// Scope discipline (spec risk): the target is always the LANE/workspace advertisement
// or grant, NEVER a global "delete the skill". `Lane` == the existing `AgentRoleLane`.
export type ResidentAsset =
  | { kind: 'skill-advertisement'; skillName: string; headerTokens: number;
      lanes: AgentRoleLane[]; sourcePath: string }
  | { kind: 'mcp-tool-schema'; toolset: string; toolName: string;
      schemaTokens: number; lane: AgentRoleLane }
  | { kind: 'mcp-toolset'; toolset: string; schemaTokens: number;
      lane: AgentRoleLane; members: string[] };

/** A resident asset joined to observed usage over the lane's workspace-lineage-aware,
 *  strict-tier behavior spine (WP-2B). Carries the honest coverage/recency signals the
 *  ranking + gating consume. `usageCoveragePct` low ⇒ the backing proposal stays
 *  UNVERIFIED (indirect/provider-specific invocation can hide real usage — spec risk).
 *  `eligibleExposureTurns` is the ranking denominator (exposure only across sessions
 *  where the asset was actually advertised/granted, or the conservative approximation
 *  with `exposureApproximate:true` when advertisement/grant epochs are not derivable). */
export interface ResidentAssetUsage {
  asset: ResidentAsset;
  observedUses: number;          // member/skill invocations attributed to the lane (strict)
  eligibleExposureTurns: number; // ranking denominator (see note)
  exposureApproximate: boolean;  // true ⇒ conservative epoch approximation, proposal unverified
  usageCoveragePct: number;      // capture coverage over the exposure window (0–100)
  lastUsedAt: number | null;     // ms of the most recent attributed use, null if never
  zeroUseWindow: { sinceMs: number | null; untilMs: number | null }; // the dead window observed
  /** Scope disclosure mirroring the usage-query surface (WP-2B): what workspace policy
   *  the join ran under, so a proxy/slug-degraded population is never silently trusted. */
  scopeMeta: {
    appliedScopeMode: WorkspaceScopeMode;
    workspaceKeyIsSlugProxy: boolean;
    proxyIncluded: boolean;
  };
}

// ── Context optimizer — unified proposal engine DTO (design §7; master WP6b) ────
//
// A DEDICATED internal DTO (design §7.1): it carries concepts the capstone
// `ImprovementProposal` does not express — occurrence classification, derivability,
// the exposure denominator, the shared-cwd attribution caveat, and a resident-token
// basis. It is mapped into `ImprovementProposal` only at the capstone boundary
// (context-optimizer.ts CAPSTONE_KIND_MAP). Hardened per classifier addendum
// §4.5/§4.6: `verification` (per-lane parity state + staleReasons), `phraseGap`,
// `actionability`, `costEvidence`, and a redacted `fileHeat` rollup on the result.
export type ContextOptimizerProposalKind =
  | 'subtract-unused-toolset' | 'subtract-dead-guidance'
  // WP-E (P4): grant-mismatch — guidance for a tool the lane no longer holds. A
  // deadness class behavior-only detectors structurally cannot see (the tool is
  // absent, so never observed either way); verified-by-construction from config drift.
  | 'subtract-grant-mismatch'
  // R2 WP-3 (Priority 1): an advertised skill HEADER that is resident in a lane's
  // discovery surface but never invoked in this workspace. The action removes the skill
  // from THIS lane's advertised surface (or shortens its description) — NEVER a global
  // "delete the skill" ("never used here" ≠ "globally useless").
  | 'subtract-unused-skill-advertisement'
  // R2 WP-3 (Priority 1, stretch): split a broad toolset along a workflow boundary when
  // schema savings clear a minimum bar and some members are used (mixed toolset).
  | 'tune-split-toolset'
  | 'add-improvisation-support' | 'add-missing-guidance'
  | 'tune-skill-trigger' | 'tune-split-section' | 'relocate-to-progressive-disclosure';

/** The four levers (panel groups SUBTRACT / ADD / TUNE·RELOCATE). */
export type ContextOptimizerLever = 'subtract' | 'add' | 'tune' | 'relocate';

export type GuidanceOccurrence = 'occurs' | 'never' | 'insufficient-exposure' | 'unobservable';

// Inlined so `shared/` stays dependency-free — mirrors compiler-parity-gate
// `ParityVerificationState` / `ProposalVerification` (main-side).
export type ProposalVerificationStateDTO =
  | 'verified' | 'unverified' | 'stale' | 'mismatch' | 'unverified-no-reference';

export interface ProposalVerificationDTO {
  state: ProposalVerificationStateDTO;
  verified: boolean;
  requiresDerivationGate: boolean;
  staleReasons?: string[];
  verifiedAsOf?: string;
}

/** §4.6 display state. A gate-governed proposal that is NOT derivation-verified is a
 *  `candidate-unverified` (shown, badged, never silently suppressed from the panel;
 *  it IS excluded from the WP7 agent actionable list — `suppressedFromAgentSurface`).
 *  A cluster/bypass proposal is `actionable` regardless of gate state. */
export type ProposalActionability = 'actionable' | 'candidate-unverified' | 'watch-only';

/** A9 phrase-gap evidence (later leg fills it; the field exists here so the DTO is
 *  stable). Terms + counts only — never raw snippet sentences. */
export interface ProposalPhraseGap {
  terms: Array<{ term: string; bypassCount: number; invocationCount: number;
                 gapBps: number; liftBps: number }>;
}

/** A8 cost evidence — cited only where it strengthens the case. Rates normalized
 *  per-100-turns, never raw counts (master WP6 A8 / A4 rule). */
export interface ProposalCostEvidence {
  improvisedPathTokensPer100Turns?: number;   // tune cards: improvised path cost
  skillPathTokensPerInvocation?: number;       // tune cards: skill path cost
  residentTokensTimesExposure?: number;        // SUBTRACT: the tokenTurnsWeight surfaced (no new math)
  note?: string;
}

/** R2 WP-3 (Priority 1) — asset-backed coverage/recency evidence for a resident-asset
 *  subtract (skill-advertisement today; toolset later). Additive + optional: present
 *  ONLY on asset-derived rows, so the surface can show honest coverage/recency without a
 *  parser-version bump. Mirrors the `ResidentAssetUsage` join signals the ranking + gate
 *  consumed. `exposureApproximate:true` (advertisement/grant epoch not derivable) is why
 *  the backing proposal is surfaced UNVERIFIED (candidate) — see `scopeMeta` for the
 *  workspace-scope disclosure (a slug proxy while WP-2B leaves workspace_id unpopulated). */
export interface ProposalAssetEvidence {
  usageCoveragePct: number;      // capture coverage over the exposure window (0–100)
  lastUsedAt: number | null;     // ms of the most recent attributed use, null if never
  zeroUseWindow: { sinceMs: number | null; untilMs: number | null };
  exposureApproximate: boolean;  // true ⇒ conservative epoch approximation → proposal unverified
  scopeMeta: {
    appliedScopeMode: WorkspaceScopeMode;
    workspaceKeyIsSlugProxy: boolean;
    proxyIncluded: boolean;
  };
}

/** WP-1A (Priority 0) — the auditable, same-generation non-occurrence evidence
 *  behind a `never`/subtract verdict. Mirrors main-side `OccurrenceEvidenceV1`
 *  (occurrence-classifier.ts) but `predicate` is loosened to a structural shape so
 *  `shared/` stays dependency-free (no import of main-side `BehaviorPredicate`).
 *  Carries ONLY identifiers + counts — never raw path text or snippets — so it is
 *  redaction-safe by construction. `evidenceState` on the proposal says whether this
 *  object survived the fail-closed gates (`auditable`) or a gate failed (`partial`). */
export interface OccurrenceEvidenceDTO {
  predicate: { kind: string } & Record<string, unknown>;
  matcherVersion: string;
  normalizedMatcher: Record<string, unknown>;
  epoch: { id?: string; sinceMs?: number; untilMs?: number; confidence: string };
  denominator: {
    turns: number; streams: number; slugs: number;
    sampledStreams: Array<{ streamId: string; turns: number; lane: string }>;   // capped
  };
  numerator: {
    occurrences: number; streams: number;
    sampledEvents: Array<{ streamId: string; entryUuid: string; blockIndex: number; byteOffset: number }>; // capped
  };
  captureCoverage: {
    providers: Record<string, { streams: number; pathEventsSupported: boolean }>;
    unknownToolEvents: number;
    unresolvedPathEvents: number;
  };
  exclusions: { subagents: boolean; reasons: string[] };
}

/** WP-1A fail-closed audit state for a proposal's `never` verdict.
 *  `auditable` = the fail-closed gates passed AND a reproducible evidence object with
 *  ≥1 denominator sample is attached; `partial` = a provisional-never downgraded
 *  (capture-incomplete) — evidence attached so the reason is auditable, but the
 *  subtract is not asserted as safe; `unavailable` = legacy / static-config /
 *  non-`never` rows that carry no behavior audit trail. */
export type ProposalEvidenceState = 'auditable' | 'partial' | 'unavailable';

// ─────────────────────────────────────────────────────────────────────────────
// WP3 (G3) — friction → recommendation chain, joinable evidence only.
//
// A `RecommendationDraft` is a template-constrained, human-review-required draft
// attached to an ADD proposal. Honesty boundaries (plan WP3):
//   - `claim` is rendered from a deterministic template; every substituted slot
//     mechanically cites a row, and a denylist of causal tokens ("because",
//     "in order to", "so that") is test-enforced. NO causal/intent language.
//   - `evidence` entries are SAME-SURFACE (optimizer) rows joined by
//     `generationId` + row ids. Cross-surface evidence is barred at construction
//     until WP8 provenance exists.
//   - `command_family` evidence may only support workspace-level candidates
//     (`target.unresolved` — never a specific file) until WP9's
//     `associatedCommandFamilies` join lands (generationId-gated, prospective).
//   - The target-selection policy consumes WP2 `GuidanceSource.audienceProviders`:
//     a file target only when the observing cohort maps to exactly ONE applicable
//     guidance source; ambiguous/unknown → `{ unresolved, reason }`. NEVER a
//     CLAUDE.md default.
// ─────────────────────────────────────────────────────────────────────────────

export type RecommendationEvidenceKind =
  | 'file-heat' | 'coverage-check' | 'phrase-gap' | 'bypass' | 'command_family';

/** One joinable evidence entry: rows on the SAME optimizer surface, joined by
 *  `generationId` + row ids. Nothing else (no free text, no cross-surface refs). */
export interface RecommendationEvidence {
  kind: RecommendationEvidenceKind;
  rowIds: string[];
  generationId: string;
  /** WP8 (v2-optional, capability 'surface-provenance'): the comparabilityKey of
   *  the surface the cited rows live on — stamped by the analytics exporter at
   *  snapshot time (all draft evidence is optimizer-surface by construction).
   *  Does NOT lift WP3's cross-surface bar; a future cross-surface join would
   *  have to match this key. */
  comparabilityKey?: string;
}

export type RecommendationTarget =
  | { file: string; section?: string }
  | { unresolved: true; reason: string };

export interface RecommendationDraft {
  target: RecommendationTarget;
  /** Template-constrained claim — every slot cites a row; causal tokens denied. */
  claim: string;
  evidence: RecommendationEvidence[];
  /** Optional deterministic template output — never free-form prose. */
  suggestedBulletText?: string;
  /** ALWAYS true: no draft is ever auto-applied. */
  humanReviewRequired: true;
}

export interface ContextOptimizerProposal {
  id: string;
  kind: ContextOptimizerProposalKind;
  lever: ContextOptimizerLever;
  title: string;
  rationale: string;
  target: { absPath?: string; lineStart?: number; lineEnd?: number;
            mcpToolset?: string; mcpToolName?: string; skillName?: string;
            lane?: AgentRoleLane;
            // WP-B2 hash-only cluster rollup: when present, this proposal is the ONE
            // actionable summary standing in for `count` hash-only clusters along
            // `dimension` (so it is NOT treated as hash-only noise). B1 only READS this;
            // B2 populates it. Optional + additive — prevents a cross-package break.
            // R2 WP-4B extends it (additive) with capped OPAQUE member refs + top-K
            // member summaries (never raw keys) + totalOccurrences/distinctStreams so the
            // rollup carries drillable evidence, and `hasDrillableMembers` so a rollup
            // with nothing to drill surfaces as a diagnostic (hasActionableContent:false).
            rollup?: { count: number; dimension: 'input_shape_hash' | 'search_signature_hash';
                       memberRefs?: string[];
                       topMembers?: Array<{ ref: string; count: number; distinctStreams: number }>;
                       totalOccurrences?: number; distinctStreams?: number;
                       hasDrillableMembers?: boolean };
            // Inlined MutabilityClass (shared/ stays dependency-free — cf. OverheadSource).
            mutable: 'user-owned' | 'scaffold-managed' | 'generated-vendor' };
  residentTokenDelta: { estimate: number;      // labeled estimate (cl100k proxy)
                        basis: 'remove-resident' | 'add-resident' | 'relocate-to-disclosure' | 'header-only' };
  tokenTurnsWeight: number;                     // residentTokens × exposureTurns (ranking, §7.3)
  occurrence: GuidanceOccurrence;
  confidence: BehaviorEvidenceTier;
  epochConfidence: 'high' | 'low' | 'unknown';  // classifier down-rank within tier (§7.3)
  attribution: { lane?: AgentRoleLane; slug?: string; streamIds: string[];
                 sharedCwdRisk: 'none' | 'possible' | 'high'; caveat?: string };
  exposure: { turns: number; streams: number; slugs: number };
  citations: Array<{ source: 'staticOverheadModel' | 'historicalChatLogAnalytics';
                     absPath?: string; line?: number; streamId?: string;
                     byteOffset?: number; entryUuid?: string; blockIndex?: number }>;
  costEvidence?: ProposalCostEvidence;
  phraseGap?: ProposalPhraseGap;
  /** R2 WP-3 (Priority 1) — asset-backed coverage/recency evidence. Present ONLY on
   *  resident-asset subtracts (skill-advertisement); additive + optional (no parser bump). */
  assetEvidence?: ProposalAssetEvidence;
  proposedEdit?: { summary: string; patch?: string };   // unified diff, NOT auto-applied
  verification: ProposalVerificationDTO;
  actionability: ProposalActionability;
  derivationVerified: boolean;                  // false until Phase-E gate cleared → UI "candidate"
  suppressedFromAgentSurface: boolean;          // §4.6: gate-governed + unverified → off the agent list
  // WP-E (P4): the per-lane insight this proposal serves — the "insight bar" label
  // (`grant-mismatch` | `dead-guidance` | `unused-toolset-grant` | …). Additive; every
  // SUBTRACT carries one so the surface can frame WHICH lane insight it answers. Its
  // verification class lives on `verification` / `confidence` / `actionability`.
  laneInsight?: string;
  // WP-1A (Priority 0) — fail-closed, auditable `never` verdicts. Split from
  // `citations` (which prove residency); `behaviorEvidence` is the NON-OCCURRENCE
  // audit trail behind a `never`/subtract, derived in the SAME analysis generation as
  // the verdict (never a second pass). Absent on non-behavioral / legacy rows.
  behaviorEvidence?: OccurrenceEvidenceDTO;
  /** REQUIRED on every proposal (default `'unavailable'`). `auditable` = fail-closed
   *  gates passed with samples; `partial` = capture-incomplete; `unavailable` =
   *  legacy / static-config (drift) / non-`never`. */
  evidenceState: ProposalEvidenceState;
  /** Drill key for `GET /api/context-optimizer/proposals/:id/evidence` (== the
   *  proposal id today). Present only when `behaviorEvidence` is attached. */
  evidenceRef?: string;
  /** R2 WP-4B (Phase 4) — the benefit model that orders an ADD/TUNE/RELOCATE proposal
   *  WITHIN its confidence tier (never blended across tiers). `tokenTurnsWeight=0` is
   *  correct for subtraction math but inadequate as the sole ordering key for additions,
   *  so improvements carry an explicit benefit magnitude instead. Absent on subtracts
   *  (they rank by `tokenTurnsWeight`). Additive + optional (no parser bump). */
  benefitModel?: ProposalBenefitModel;
  /** R2 WP-4B — the exemplar-drill key for a hash-only cluster rollup: pass to
   *  `GET /api/context-optimizer/proposals/:id/cluster-exemplars`. Present only on a
   *  rollup proposal that has drillable members. */
  clusterExemplarRef?: string;
  /** WP3 (G3) — template-constrained, human-review-required recommendation draft
   *  with joinable same-surface evidence. Present only on ADD proposals whose
   *  evidence rows exist on this analysis generation. Additive + optional. */
  recommendationDraft?: RecommendationDraft;
}

/** R2 WP-4B (Phase 4) — benefit model for improve-lever proposals. The magnitude orders
 *  WITHIN a confidence tier only; it is NEVER combined with the evidence tier (hard
 *  confidence grouping is preserved). One of three additive benefit kinds:
 *   - `repeated-cost-avoided`     : tokens re-derived by a repeated improvisation.
 *   - `failure-rate-reduced`      : count of failed/unknown/discoverability events a
 *                                   documented grant would relieve.
 *   - `resident-tokens-relocated` : resident tokens moved off the always-on surface. */
export interface ProposalBenefitModel {
  kind: 'repeated-cost-avoided' | 'failure-rate-reduced' | 'resident-tokens-relocated';
  magnitude: number;
  basis: string;
}

export type ContextOptimizerQuery = { lane?: AgentRoleLane; agentId?: string;
  sinceMs?: number; untilMs?: number; minEligibleTurns?: number;
  // WP6 acceptance leg: the workspace whose scaffold the pipeline analyzes. Optional
  // + additive — when absent the handler resolves it from `agentId`, else returns the
  // honest EMPTY result (no lanes ⇒ engine's empty-lane surface, never a crash).
  workspaceId?: string;
  // WP-4A (Phase 4): workspace-scope policy for the file-heat corpus (parity with
  // McpToolUsageQuery). `slug` unlocks the include-proxy leg; `scopeMode` defaults to
  // 'strict' in the file-touch query layer. `includeOperationalNoise` widens the
  // guidance-gaps view to include low-value roles (build-generated / vendor / test).
  slug?: string;
  scopeMode?: WorkspaceScopeMode;
  includeOperationalNoise?: boolean };

/** WP-4A (Phase 4) — repository-relative path ROLE (spec 260-271). Classified BEFORE
 *  coverage so file-heat can separate honest implementation/generated activity from a
 *  real guidance gap. Roles are VERBATIM from the spec. */
export type PathRole =
  | 'product-source'
  | 'guidance-or-config'
  | 'test-or-fixture'
  | 'build-generated'
  | 'dependency-or-vendor'
  | 'skill-owned'
  | 'external'
  | 'unknown';

/** WP-4A — the ONE canonical heat score components (spec 273). Published on every
 *  rollup row so BOTH engine and DTO sort by the SAME value (killing the old
 *  engine-vs-DTO disagreement). `score` = weighted sum; components are the raw parts. */
export interface FileHeatScoreComponents {
  reads: number;
  writes: number;
  executes: number;
  distinctStreams: number;
}

/** WP-4A — the canonical heat-score version. Bump when the weighting changes so a
 *  consumer can tell two score generations apart. */
export const FILE_HEAT_SCORE_VERSION = 1;

/** WP-4A — workspace-scope disclosure for the file-heat surface, mirroring MCP-usage
 *  `scopeMeta` (spec risk 3: a smaller visible dataset disclosed with counts, never
 *  silence). Summed across the analyzed lanes of ONE run. */
export interface FileHeatScopeMeta {
  /** True when a real workspaceId scope was applied (scopeMode !== 'global-diagnostic'). */
  workspaceScoped: boolean;
  appliedScopeMode: WorkspaceScopeMode;
  /** The workspace dimension degraded to the slug proxy (no row carried a real id). */
  workspaceKeyIsSlugProxy: boolean;
  /** file_touch rows the workspace filter dropped (no workspace identity, not proxy-rescued). */
  droppedUnattributedTouches: number;
  /** file_touch rows admitted ONLY via the include-proxy slug leg. */
  proxyIncludedTouches: number;
  /** Per-workspace-tier counts over the base (pre-filter) population. */
  workspaceAttribution: WorkspaceAttributionBreakdown;
}

/** WP-4A — per-lane scope counts from the workspace-scoped file-touch query. Summed
 *  across lanes into `FileHeatScopeMeta`. */
export interface FileTouchScopeCounts {
  droppedUnattributed: number;
  proxyIncluded: number;
  breakdown: WorkspaceAttributionBreakdown;
  /** Rows carrying any REAL workspace id (explicit/launch-session/root) → drives the
   *  honest slug-proxy flag when 0 across the run. */
  realIdCount: number;
}

/** WP-4A — the workspace scope a file-touch query runs under (parity with
 *  `McpToolUsageQuery` scope fields). `slugUniqueToWorkspace` is resolver-set. */
export interface FileTouchScope {
  workspaceId?: string;
  slug?: string;
  scopeMode?: WorkspaceScopeMode;
  slugUniqueToWorkspace?: boolean;
}

/** File-heat rollup row (§5.6-redacted): `pathDisplay`/`pathHash` carry the
 *  redaction-ready path; no usernames/home prefixes. `uncovered` marks an ADD
 *  candidate (hot-but-uncovered). */
export interface FileHeatRollupEntry {
  lane: AgentRoleLane;
  pathDisplay: string; pathHash: string;
  coverage: string;    // CoverageBucket (inlined)
  reads: number; writes: number; executes: number; distinctStreams: number;
  matchConfidence?: 'exact' | 'suffix' | 'basename';
  uncovered: boolean;
  // ── WP-4A (Phase 4) additive projections. Absent ⇒ pre-Phase-4 shape (honest degrade). ──
  /** Repository-relative path role (spec 260-271). */
  role?: PathRole;
  /** WHY this role was chosen (explainable rules, spec risk 2). */
  roleReason?: string;
  /** Canonical heat score (spec 273) — the SAME value engine + DTO sort by. */
  score?: number;
  /** Raw components behind `score`. */
  scoreComponents?: FileHeatScoreComponents;
  /** True when this row met the guidance-gap-candidate bar (spec 273). A strict subset
   *  of uncovered rows: workflow-level artifact + repeated cross-stream + no coverage. */
  guidanceGapCandidate?: boolean;
  /** True for low-value operational-noise roles excluded from the default guidance-gaps
   *  view (build-generated / dependency-or-vendor / test-or-fixture). Kept in diagnostics;
   *  surfaced only under `includeOperationalNoise` (spec 271). */
  operationalNoise?: boolean;
  /** WP3 (G3) — hot UNCOVERED workflow file on the explicit role allowlist whose path
   *  matched NO guidance file-access prediction (coverageChecks.matched === 0). The
   *  ADD-candidate signal behind file-targeted recommendation drafts. */
  hotUncoveredCandidate?: boolean;
  /** WP3 (G3) — the BOUNDED record of the predicate sweep behind the candidate bar:
   *  totals + a capped sample of predicate refs + truncation metadata, never the full
   *  predicate list. Inlined shape (shared/ stays dependency-free — cf. `mutable`). */
  coverageChecks?: { totalPredicatesTested: number; matched: number; sample: string[];
                     truncated: boolean; limit: number };
}

/** WP-E (P4) suppress-only diagnostics — a SUBTRACT the engine chose NOT to surface as
 *  an actionable proposal, with the reason. NEVER a proposal kind (the P4 non-goal:
 *  no `detector-mismatch` kind is introduced). Two suppress paths:
 *   - `grant-mismatch-contradiction`: a related capability-family signal contradicts
 *     deadness (e.g. the planning-surface sentinel is flagged dead but plans-read tools
 *     ARE used — 55 calls). The subtract is withheld and the counter-evidence attached.
 *   - `coverage-insufficient`: a behavioral subtract for a lane with insufficient
 *     attributed sample (researcher, n≈1) — labelled `insufficient-sample`, never
 *     actionable. */
/** WP-2A (Priority 0) — the typed verdict every `subtract-grant-mismatch` CANDIDATE
 *  receives, whether or not it became a live row. A defaults-only proposals call reads
 *  the per-verdict histogram (`meta.diagnosticCounts`) to distinguish "0 rows because N
 *  were suppressed" from "0 candidates detected".
 *   - `emitted`                  — a live `subtract-grant-mismatch` row was produced.
 *   - `suppressed-counterevidence` — capability-family usage contradicts deadness.
 *   - `unresolved-documentation` — a resident section names a capability area but no
 *                                  code-form tool name inside it resolved to a toolset
 *                                  (heading-only, inferred → human-review, never subtracted).
 *   - `ambiguous-toolset`        — a documented tool name maps to MULTIPLE toolsets;
 *                                  ambiguity SUPPRESSES, never guesses.
 *   - `section-not-resident`     — no resident section text resolved for the anchor.
 *   - `zero-token-estimate`      — a section resolved but the estimate was 0. */
export type GrantMismatchVerdict =
  | 'emitted'
  | 'suppressed-counterevidence'
  | 'unresolved-documentation'
  | 'ambiguous-toolset'
  | 'section-not-resident'
  | 'zero-token-estimate';

export interface ContextOptimizerDiagnostic {
  kind: 'grant-mismatch-contradiction' | 'coverage-insufficient' | 'capture-incomplete'
    | 'grant-mismatch-evaluation'
    // R2 WP-4B (Phase 4): the aggregated `granted-but-undocumented` findings that carry
    // NO behavioral-need signal — demoted from individual zero-weight `add-missing-guidance`
    // proposals to ONE config-completeness lane card (never adds resident tokens for
    // grant↔doc symmetry). `undocumentedCount` + `undocumentedToolsets` carry the roll-up.
    | 'config-completeness';
  lane: AgentRoleLane;
  detail: string;
  /** The withheld subtract's proposal id (so the surface can cross-reference). */
  relatedProposalId?: string;
  /** contradiction: the capability family whose live usage contradicts deadness. */
  capabilityFamily?: string;
  /** contradiction: observed usage count of that family (the counter-evidence). */
  counterEvidenceCalls?: number;
  /** coverage-insufficient: the conservative evidence label (pre-C signal). */
  evidence?: 'insufficient-sample';
  /** coverage-insufficient: the attributed stream count that fell short. */
  sampleStreams?: number;
  // ── WP-2A (Priority 0) grant-mismatch-evaluation: one per candidate, typed. ──
  /** grant-mismatch-evaluation: the typed verdict for this candidate. */
  grantMismatchVerdict?: GrantMismatchVerdict;
  /** grant-mismatch-evaluation: the toolset the candidate concerns. */
  toolset?: string;
  /** grant-mismatch-evaluation: the toolset a documented tool name resolved to (unique). */
  resolvedToolset?: string;
  /** grant-mismatch-evaluation: the code-form tool name mentioned in resident markdown. */
  mentionedToolName?: string;
  /** grant-mismatch-evaluation: how the toolset was resolved — a `code-name` match is the
   *  only observed-safe basis for a subtract; `heading` stays inferred/human-review. */
  resolutionConfidence?: 'code-name' | 'heading';
  /** grant-mismatch-evaluation (ambiguous): the multiple toolsets a name resolved to. */
  candidateToolsets?: string[];
  /** grant-mismatch-evaluation: the resident-section token estimate used to size (or 0). */
  tokenEstimate?: number;
  /** grant-mismatch-evaluation: the grant epoch topology the evaluation was run against —
   *  current-grant topology is NOT historical truth (spec risk), so the evidence carries it. */
  grantEpoch?: string;
  // WP-1A (Priority 0) capture-incomplete: a provisional-`never` that FAILED a
  // fail-closed gate (matcher not exact/canonical, capture unsupported, or the
  // unresolved-path rate crossed the declared threshold) → the subtract is withheld
  // and downgraded rather than asserted. The reason is auditable via these fields.
  /** capture-incomplete: fraction of unresolved-path events in the denominator window. */
  unresolvedPathRate?: number;
  /** capture-incomplete: whether the matcher was exact/canonical (false ⇒ glob/legacy). */
  matcherCanonical?: boolean;
  // ── R2 WP-4B (Phase 4) config-completeness: aggregated symmetry-only undocumented grants. ──
  /** config-completeness: how many `granted-but-undocumented` findings (no behavioral
   *  need) were folded into this ONE lane card. */
  undocumentedCount?: number;
  /** config-completeness: the folded findings — toolset key + the drift one-liner. Never
   *  a proposal; the card is a completeness note, not a recommendation to add tokens. */
  undocumentedToolsets?: Array<{ toolset: string; detail: string }>;
}

// ── R2 WP-4C: section-level analyzability diagnostic. ──────────────────────────
// Explains WHY a section is not analyzable in ACTIONABLE terms (a stable reason
// `code` + an advisory `suggestedDetector`) and FIXES the notAnalyzable dedupe bug:
// a section is deduped by section identity + LANE SET, so a section shared across
// lanes is counted ONCE carrying BOTH lanes (never mislabeled to the first lane
// seen). `suggestedDetector` is ADVISORY ONLY — it informs authoring; WP-4C adds no
// classification-changing detector (spec Risk: heuristics never drive actionable
// subtraction). Additive: the legacy per-action `notAnalyzable[]` array is retained.
export type AnalyzabilityReasonCode =
  | 'pure-prose'          // imperative prose / derivability unmatchable
  | 'sequence-deferred'   // temporal workflow: ordered events, not a countMatching predicate
  | 'branch-deferred'     // decision branch / policy-constraint: no behavior-store predicate
  | 'capture-missing'     // path we could not resolve, or a fail-closed capture-incomplete withhold
  | 'exposure-low'        // insufficient exposure to observe (watch-item)
  | 'matcher-ambiguous';  // named tool/coarse server grant with no fine resolver

export interface AnalyzabilityDiagnostic {
  /** Section identity (epoch `sourceSectionKey`, or `absPath:line` when unresolved). */
  sectionKey: string;
  source: { absPath: string; lineStart: number; lineEnd: number };
  /** The FULL set of lanes this section appears under (the dedupe fix). */
  lanes: AgentRoleLane[];
  /** Cost of the smallest enclosing section — the trapped-cost unit. */
  residentTokens: number;
  /** Max exposure (turns) across the lanes it appears under — the route's sort co-factor. */
  exposureTurns: number;
  /** How many rejected actions this section carries (report BOTH section and action counts). */
  actionCount: number;
  reasons: Array<{ code: AnalyzabilityReasonCode; count: number; suggestedDetector?: string }>;
}

export interface ContextOptimizerResult {
  generatedAtIso: string;
  proposals: ContextOptimizerProposal[];       // ranked: hard tier groups, tokenTurnsWeight within
  fileHeat: FileHeatRollupEntry[];             // top-N per lane passthrough (A1)
  modelStats: {
    residentTokensByLane: Array<{ lane: AgentRoleLane; total: number; claude: number;
      mcp: number; skillHeaders: number; exposureTurns: number }>;
    behaviorEvents: number;
    attributionWarnings: number;
    notAnalyzable: Array<{ absPath: string; line: number; label: string; lane?: AgentRoleLane }>;
    /** R2 WP-4C: section-level, deduped-by-section+laneSet diagnostic (the dedupe-bug
     *  fix + the actionable reason taxonomy). Additive sibling of `notAnalyzable`. */
    analyzability?: AnalyzabilityDiagnostic[];
  };
  meta: { tierGroups: BehaviorEvidenceTier[]; unverifiedSuppressedCount: number;
    /** WP-4A (Phase 4): workspace-scope disclosure for the file-heat surface. Absent on
     *  a run with no workspace scope (honest lane-global heat). */
    fileHeatScope?: FileHeatScopeMeta;
    /** WP3 (G3): the analysis-generation id every `recommendationDraft.evidence` entry
     *  in THIS result is keyed by (the join key for same-surface evidence rows).
     *  Present only when ≥1 proposal carries a draft (honest absence). */
    recommendationGenerationId?: string;
    /** WP6 (G6): total CLASSIFIED (non-ignored) file-heat population across lanes
     *  BEFORE the per-lane top-N slice — the exporter's `populationAvailable`.
     *  Present only when EVERY lane with coverage disclosed its pre-slice
     *  population (honest absence: a partially-known total would understate). */
    fileHeatPopulation?: number };
  /** WP-E (P4) suppress-only guardrail + sample-gate diagnostics (additive). */
  diagnostics?: ContextOptimizerDiagnostic[];
  /** WP5 (G5, v2-optional): occurrence verdicts joined per section identity —
   *  the input to the config-weight behavior-axis annotation (section-liveness).
   *  Present only when ≥1 section-keyed action was analyzed (honest absence). */
  sectionBehavior?: SectionBehaviorRecord[];
}

export type ContextOptimizerQueryResult =
  | { ok: true; data: ContextOptimizerResult }
  | { ok: false; error: string };

// ─────────────────────────────────────────────────────────────────────────────
// WP6 human-surface writers. BOTH are UI/IPC-only, human-gated, additive.
// NEITHER auto-writes a config file: "Mark applied" records an INTENT row in
// `optimizer_actions` (via outcome-tracker buildOptimizerActionTarget); the G2
// sign-off inserts a `verified` row in `optimizer_derivation_verifications` only
// when Edward clicks. No MCP path exists to either (classifier addendum §5.4).
// ─────────────────────────────────────────────────────────────────────────────

/** "Mark applied" request. The renderer supplies what the proposal already carries;
 *  the snapshotted matchers (`epochRefs`) are optional — an empty intent row is the
 *  honest state until the acceptance leg enriches them. */
export interface MarkOptimizerActionAppliedRequest {
  proposalId: string;
  kind: ContextOptimizerProposalKind;
  lane: AgentRoleLane;
  target: ContextOptimizerProposal['target'];
  proposedEdit: { summary: string; patchHash?: string; beforeHash?: string; afterHash?: string };
  /** Lanes the watch recompute pools over (§3.3). */
  watchLanes: AgentRoleLane[];
  /** MUST equal the original verdict's basis (Bug-4): true for toolset/tool grants,
   *  false for persona/CLAUDE guidance. */
  includeSubagents: boolean;
  /** §4.6: the proposal was `candidate-unverified` when the human clicked. Stamped
   *  into the row note so a later reconciliation knows the gate had not cleared. */
  unverifiedAtApply: boolean;
  note?: string;
  epochRefs?: Array<{ sectionKey: string; epochId: string; contentHash: string;
                      sourcePath: string; lineStart?: number; lineEnd?: number }>;
}

export type MarkOptimizerActionAppliedResult =
  | { ok: true; actionId: string; targetPredicateHash: string }
  | { ok: false; error: string };

/** G2 sign-off request — inserts/updates a `verified` derivation row. Every column
 *  the parity artifact produced is supplied by the caller (the acceptance leg builds
 *  the artifact); this writer NEVER re-derives or auto-signs. */
export interface SignOptimizerDerivationRequest {
  gateName: string;
  lane: AgentRoleLane;
  parserVersion: number;
  compilerVersion: number;
  corpusFingerprint: string;
  configFingerprint: string;
  toolsetInventoryFingerprint: string;
  empiricalReportFingerprint: string;
  signedHistogramJson: string;
  signedSplitJson: string;
  artifactPath: string;
  artifactSha256: string;
  signedOffBy?: string;
  notes?: string;
}

export type SignOptimizerDerivationResult =
  | { ok: true; gateName: string }
  | { ok: false; error: string };

// ───────────────────── Memory Watchdog (incident-2026-07-11 §5 D5) ─────────────────────
// Renderer-facing DTOs — the IPC contract for the status-bar meter / pressure
// banner / orphan-sweep panel. Structural mirrors of the main-process watchdog
// types (src/main/watchdog/*, src/main/supervisor/ownership/orphan-sweep.ts);
// kept here so the renderer never imports from `main/`.

export type WatchdogPressureLevel = 'normal' | 'warn' | 'critical';

export interface MemorySnapshotDto {
  level: WatchdogPressureLevel;
  /** false ⇒ commit sampler failed this tick; meter shows "unknown". */
  commitKnown: boolean;
  /** Commit charge as % of commit limit (0–100), null when commitKnown is false. */
  commitPercent: number | null;
  commitLimitBytes: number | null;
  commitChargeBytes: number | null;
  appProcessCount: number;
  appMemoryBytes: number;
  liveAgentCount: number;
  agentViewCount: number;
  staticCapsOnly: boolean;
  at: number;
}

export interface AgentMemoryUsageDto {
  agentId: string;
  transport: 'conpty' | 'wsl';
  cliTreeBytes: number;
  cliCommitBytes: number;
  pidCount: number;
  source: 'job' | 'tree-walk' | 'none';
}

export interface AppOwnedTotalsDto {
  electronProcessCount: number;
  electronBytes: number;
  ownedCliProcessCount: number;
  ownedCliBytes: number;
  totalOwnedProcessCount: number;
  totalOwnedBytes: number;
}

export interface AttributionDto {
  perAgent: AgentMemoryUsageDto[];
  totals: AppOwnedTotalsDto;
  at: number;
}

// ── Composed System-Memory view (System-Memory polish Part 2) ──
// Structural mirrors of src/main/watchdog/system-memory-view.ts — the renderer
// imports only from shared. Composed main-side from the live registry
// (getActiveAgents), the attribution rollup and the sampler snapshot.

/** A commit-byte category: the sum of every PID that resolved, plus whether
 *  EVERY expected PID resolved. `complete: false` means the true figure is
 *  ≥ `bytes` — the shortfall must never be attributed to "other/system". */
export interface CommitCategoryDto { bytes: number; complete: boolean }

export interface LiveAgentMemoryRowDto {
  agentId: string;
  title: string;                      // registry title; never blank — falls back to agentId
  status: string;                     // AgentStatus at composition time
  idleSince: string | null;           // registry idleSince (SQLite UTC string)
  transport: 'conpty' | 'wsl' | null; // null ⇒ no ownership row for this live agent
  source: 'job' | 'tree-walk' | 'none' | null;
  workingSetBytes: number | null;     // null ⇒ unattributable (no row / source none)
  commitBytes: number | null;
  commitComplete: boolean;
  pidCount: number;
}

export interface CommitBreakdownDto {
  commitChargeBytes: number | null;        // null ⇔ sampler commitKnown false
  electron: CommitCategoryDto | null;
  liveAgents: CommitCategoryDto | null;    // sum over LIVE rows only
  unattributedLiveAgentCount: number;      // live rows with commitBytes === null or !commitComplete
  /** Exact only when charge known AND both categories complete AND every live
   *  agent attributed; otherwise null — UI labels the remainder
   *  "Other/system + unattributed". */
  otherSystemBytes: number | null;
  /** True when the exact residual was negative within tolerance (clamped), or
   *  attribution `at` is > 60 s older than the commit sample. */
  approximate: boolean;
  attributionAt: number | null;
  sampleAt: number | null;
}

export interface SystemMemoryViewDto {
  liveAgents: LiveAgentMemoryRowDto[]; // exactly one row per registry live agent
  liveAgentCount: number;              // === liveAgents.length, by construction
  /** Ownership rows whose agentId is NOT in the live registry (prior-epoch /
   *  terminal). Kept visible: memory-consuming trees must not silently vanish
   *  from a memory view — the orphan sweep is where they get reclaimed. */
  unregisteredTrees: Array<{ agentId: string; transport: string; workingSetBytes: number; commitBytes: number; pidCount: number; source: string }>;
  breakdown: CommitBreakdownDto;
  at: number;
}

export interface OrphanCandidateDto {
  agentId: string;
  instanceEpoch: string;
  transport: 'conpty' | 'wsl';
  rootPid: number | null;
  tmuxSession: string | null;
  priorEpoch: boolean;
  status: 'tree' | 'no-tree' | 'unverifiable' | 'wsl';
  pids: number[];
}

export interface ReapOrphansResultDto {
  agentId: string;
  action: string;
  pids: number[];
}

// ── Memory & Lessons v2 — review read surface (WP-H1) ──
// The renderer-only display DTOs for the memory review queue + the persisted
// index-invalid/runtime state that WP-C writes. These ride a renderer-only
// Electron IPC channel (`memory:listReview`) — NEVER an MCP toolset tool or an
// api-server route, so no agent can reach them.

/** One pending review-queue finding, projected for display. `kind` is opaque
 *  (WP-B treats it as a string): 'hard-invalid', 'cap-pressure', 'stale-active',
 *  'condition-review', 'never-recalled', 'never-fired', 'evidence-unavailable', … */
export interface MemoryReviewItemDto {
  findingId: string;
  kind: string;
  /** null for whole-index findings (hard-invalid, cap-pressure, …). */
  entryId: string | null;
  reason: string | null;
  /** The concrete lookup for a `condition-review` (`expires-when: …`) entry. */
  exitCondition: string | null;
  firstSeen: string;
  lastSeen: string;
}

/** The one workspace-level signal the user sees ("Memory index: N entries
 *  pending review, cap at P%"). Derived main-side from WP-B's review queue +
 *  WP-C's persisted `memory_index_state`. */
export interface MemoryReviewSummaryDto {
  /** Count of `pending` findings for the workspace. */
  pendingCount: number;
  /** A pending `cap-pressure` finding exists (index over the cap ratio). */
  capPressure: boolean;
  /** Byte/line budget usage of the last-known-good source, 0–100 (rounded),
   *  or null when no valid source has been persisted yet. */
  capPercent: number | null;
  /** A pending whole-index `hard-invalid` finding exists (the live MEMORY.md
   *  failed hard validation at last launch; WP-C fell back or banner-only'd). */
  hardInvalid: boolean;
  /** The durable last runtime (read/parse threw) error state from WP-C, or null. */
  lastRuntimeError: string | null;
  lastRuntimeErrorAt: string | null;
  /** Every pending finding, for the detail panel. */
  items: MemoryReviewItemDto[];
}

/** The deterministic janitor brief for a workspace (WP-H2). Generated on demand
 *  from the review queue + a fresh lesson-firing check; renderer-only. `ok:false`
 *  (empty `brief`) is returned for a blank workspace id. */
export interface MemoryJanitorBriefDto {
  ok: boolean;
  brief: string;
}

/** The result of dispatching a janitor agent (WP-H2). On success carries the
 *  launched agent id + the brief delivered as its initial prompt; a blank
 *  workspace id is rejected with `code:'invalid_workspace'` and no launch. */
export interface MemoryJanitorDispatchDto {
  ok: boolean;
  agentId?: string;
  brief?: string;
  code?: string;
}

/** A pending graduation proposal (memory → CLAUDE.md/AGENTS.md). Recorded by
 *  WP-F2's `propose_graduation`; approved/applied via WP-H3's renderer-only IPC.
 *  Declared here (WP-H1 owns the review-surface types) so WP-H3 reuses it. */
export interface MemoryGraduationProposalDto {
  proposalId: string;
  target: string;
  text: string | null;
  rationale: string | null;
  status: string;
}

/** The result of applying (approving) a graduation proposal (WP-H3). Renderer-only
 *  — no agent can reach the apply path. On success `applied` is false when the
 *  text was already present inside the managed markers (idempotent no-op). On a
 *  CAS mismatch `code:'needs_reapproval'` carries the new `currentHash`. */
export interface MemoryGraduationApplyDto {
  ok: boolean;
  proposalId?: string;
  target?: string;
  applied?: boolean;
  code?: string;
  message?: string;
  currentHash?: string;
}

/** A minimal structured ack for the human-only graduation-reject / migration-
 *  approval channels (WP-H3). `ok:false` carries a `code`; there is no payload. */
export interface MemoryIpcOkDto {
  ok: boolean;
  code?: string;
}

// ── Detached-process transparency (incident-2026-07-11 §5 Wave 5) ──
// Agent-launched detached OS processes self-register JSON descriptors under
// <workspace>/.lares/detached/*.json. The main-side registry
// (src/main/detached-process-registry.ts) verifies each descriptor's PID before
// trusting its `running` flag, since a hard kill can't update the file.
export type DetachedLiveness = 'running' | 'ended' | 'dead' | 'reused' | 'unknown';

export interface DetachedProcessDto {
  /** Absolute path of the source descriptor JSON. */
  file: string;
  pid: number | null;
  /** Full recorded command line. */
  command: string | null;
  /** Launching AGENT_ID, when the descriptor recorded one. */
  agentId: string | null;
  /** Epoch-ms start time (parsed from a number or ISO string). */
  startTime: number | null;
  phase: string | null;
  stateFile: string | null;
  logFile: string | null;
  stopFile: string | null;
  /** The `running` flag exactly as recorded in the file (untrusted). */
  runningFlag: boolean;
  /** Verified verdict — never trusts `runningFlag` alone. */
  liveness: DetachedLiveness;
  /** Live command line of the PID when probed (drives the reuse check). */
  actualCommand: string | null;
  /** Set when the descriptor was unreadable / malformed (display-only row). */
  error: string | null;
}

// ── WP-P1A: planning-reader (bounded enumeration + safe read IPC) ──
//
// A read-only filesystem surface over the planning artifacts: flat bare
// proposals (`.lares/proposals/*.md`) and §R0 folder-per-plan structures under
// `<workspaceStateDir()>/plans/<sku>/`. Every document the renderer can open is
// identified ONLY by an OPAQUE server-issued manifest document id (`docId`); no
// raw absolute path ever crosses the IPC boundary, and reads re-validate
// containment + reparse-point safety at read time.

/** The four Amendment-16 lifecycle rungs. `ran` is disk-invisible pre-ledger. */
export type PlanningRung = 'marked' | 'ran' | 'returned' | 'folded-in';

/** One deliberation/research output observed in a plan folder (disk-derived). */
export interface PlanningIntentOutputView {
  /** In-folder relative path of the output (POSIX separators). */
  relPath: string;
  /** The output's declared intent linkage (frontmatter). */
  intentId: string;
  /** SELF-DECLARED orchestration id (frontmatter) — never authoritative for `ran`. */
  orchestrationIdSelfDeclared: string | null;
  /** Currently present on disk (a missing prior output would be false; readers
   *  only surface present outputs here). */
  presentOnDisk: boolean;
  /** From the matching PLAN-INTEGRATION record; default `active`. */
  disposition: 'active' | 'superseded' | 'withdrawn';
  /** True ONLY when present AND a normalized `plan.md` Markdown link resolves
   *  (containment + existence) to this exact output. Substring is insufficient. */
  foldedIn: boolean;
  /** What the integration record says this output changed (display only). */
  integrationNote: string | null;
}

/** One PLAN-INTENT with its disk-derived lifecycle for display. */
export interface PlanningIntentView {
  intentId: string;
  part: string | null;
  kind: string;
  targets: Array<{ provider?: string; model?: string }>;
  reason: string | null;
  supersedesIntentId: string | null;
  /** `active` normally; `superseded` when a newer intent supersedes it. */
  status: 'active' | 'withdrawn' | 'superseded';
  /** marked = a valid PLAN-INTENT sentinel exists (always true for a listed intent). */
  marked: true;
  /** `ran` is NOT derivable from disk pre-ledger; always this sentinel string. */
  ran: 'unavailable-pre-ledger';
  /** ≥1 currently-present `active` output whose frontmatter matches. */
  returned: boolean;
  /** Every present `active` returned output is referenced by a resolved link. */
  fullyFoldedIn: boolean;
  /** Per-output history (each result listed independently). */
  outputs: PlanningIntentOutputView[];
}

export type PlanningEntryKind = 'proposal' | 'plan-folder';

/** A single document in a plan folder's bounded manifest (or the lone proposal). */
export interface PlanningReaderDocument {
  /** OPAQUE server-issued id — the ONLY handle the renderer uses to read. */
  docId: string;
  /** Basename for display. */
  name: string;
  category: 'plan' | 'arc' | 'deliberation' | 'research' | 'supplement' | 'proposal' | 'other';
  sizeBytes: number;
  mtimeMs: number;
}

/** One row in the planning reader — a bare proposal or a plan folder. */
export interface PlanningReaderEntry {
  /** OPAQUE server-issued id for the entry. */
  entryId: string;
  kind: PlanningEntryKind;
  /** Display title (slug for a proposal; plan title/sku for a folder). */
  title: string;
  /** Bounded document manifest (proposal → one doc; folder → several). */
  documents: PlanningReaderDocument[];
  /** Max mtime across the entry's source documents. */
  mtimeMs: number;
  // ── plan-folder only ──
  planArtifactId?: string | null;
  planSku?: string | null;
  /** Disk-derived intent lifecycle (folders only; empty when nothing marked). */
  intents?: PlanningIntentView[];
  /** Per-entry diagnostics (caps hit, unreadable output, malformed markup…). */
  warnings?: string[];
}

export interface PlanningReaderListResult {
  entries: PlanningReaderEntry[];
  /** List-level diagnostics (skipped stray dirs, caps hit at the top level…). */
  warnings: string[];
}

export interface PlanningReaderReadResult {
  docId: string;
  name: string;
  content: string;
  /** True when the file exceeded the per-file byte cap and was truncated. */
  truncated: boolean;
  sizeBytes: number;
}

// ── WP-P4A: folder-native plan document tabs ──

/** Stable tab identity. Display labels are deliberately a renderer concern. */
export type PlanTabKey =
  | 'overview'
  | 'proposal'
  | 'plan'
  | 'deliberations'
  | 'research'
  | 'supplements'
  | 'packages'
  | 'legacy-html';

/** The `PlanTabKey` domain as a runtime array — the single source of truth the
 *  membership guard iterates so the type and the runtime set cannot drift. */
export const PLAN_TAB_KEYS: readonly PlanTabKey[] = [
  'overview',
  'proposal',
  'plan',
  'deliberations',
  'research',
  'supplements',
  'packages',
  'legacy-html',
];

/** Runtime membership guard for the stable `PlanTabKey` domain. Used at the IPC
 *  boundary so a renderer-supplied `tab` is validated before it keys a row. */
export function isPlanTabKey(value: unknown): value is PlanTabKey {
  return typeof value === 'string' && (PLAN_TAB_KEYS as readonly string[]).includes(value);
}

/** WP-P4C-backend — a stored, supervisor-authored per-tab overview, revisioned.
 *  Keyed by (planId, tab) where `tab` is a stable `PlanTabKey`; `body` is the
 *  plain-language summary rendered above the tab's document(s). The `overview`
 *  key carries the summary shown above `ARC.md`. Read is open; write is
 *  supervisor-privileged. `revision` bumps on every rewrite of the same key. */
export interface PlanTabOverview {
  planId: string;
  tab: PlanTabKey;
  body: string | null;
  revision: number;
  /** The agent id that last wrote the row (the revalidated supervisor). */
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A document handle issued by main. Neither variant contains a filesystem path. */
export type PlanDocumentRef =
  | { source: 'folder'; documentId: string }
  | { source: 'registered'; documentId: string };

export interface PlanTabDocument {
  ref: PlanDocumentRef;
  name: string;
  kind: 'arc' | 'plan' | 'deliberation' | 'research' | 'supplement' | 'proposal' | 'legacy-html';
  sizeBytes: number;
  mtimeMs: number | null;
}

export interface PlanDocumentTab {
  key: PlanTabKey;
  /** True only when a real document/overview exists, or Packages has real rows. */
  populated: boolean;
  documents: PlanTabDocument[];
  /** Present only for the synthetic, deliberately-unpopulated Packages tab. */
  placeholder?: string;
}

export interface PlanDocumentsModel {
  planId: string;
  tabs: PlanDocumentTab[];
  warnings: string[];
}

export interface PlanDocumentReadResult {
  ref: PlanDocumentRef;
  name: string;
  content: string;
  truncated: boolean;
  sizeBytes: number;
}

// ── WP-P4D-create — plan-comment create + routing ─────────────────────────────
// The renderer supplies ONLY a `planId`, an opaque `PlanDocumentRef` (folder- or
// registered-manifest handle — never a filesystem path), and a `body` (+ optional
// display anchors). The server picks the recipient (the plan's current
// responsible supervisor), builds the durable `file_path` (a `lares-plan-doc:v1:`
// logical key for a folder target; an ordinary physical path for a registered
// external doc), creates the row, and routes it through the existing send path.
// The renderer can inject neither recipient, nor file, nor logical key.

export interface PlanCommentCreateRequest {
  planId: string;
  ref: PlanDocumentRef;
  body: string;
  /** Optional display/reattach fields — never a file path or recipient. */
  quotedText?: string;
  lineStart?: number;
  lineEnd?: number;
  anchorStart?: number;
  anchorEnd?: number;
  prefix?: string;
  suffix?: string;
  docHash?: string;
}

export type PlanCommentCreateErrorCode =
  | 'plan-comment-bad-request'
  | 'plan-not-found'
  | 'workspace-not-found'
  | 'document-not-in-plan';

export type PlanCommentCreateResult =
  | {
      ok: true;
      comment: SelectionComment;
      /** The server-selected responsible supervisor the comment was routed to,
       *  or null when the plan has no current responsible supervisor (the row
       *  still persists and can be routed later). */
      recipientId: string | null;
      /** The outcome of the send/notification path, or null when there was no
       *  recipient to route to. */
      send: SendSelectionCommentsResult | null;
    }
  | { ok: false; code: PlanCommentCreateErrorCode; error: string };

// ── WP-P4D-reply — companion reply (answer) service ───────────────────────────
// A reply is a COMPANION row keyed to its question comment. It never overwrites
// `selection_comments.body` and never overloads that row's delivery-status
// `status` machine — the question row is left untouched. The agent-callable
// `answer_plan_comment(comment_id, body)` surface validates that the answering
// caller IS the plan's current responsible supervisor (resolved server-side from
// the comment → plan, never renderer-asserted). `authorAgentId` is nullable
// (system/undeclared replies), `createdAt` a service-owned epoch-ms INTEGER.

export interface SelectionCommentReply {
  id: string;
  commentId: string;
  body: string;
  authorAgentId: string | null;
  /** Service-owned creation time, epoch milliseconds (the companion table's
   *  `created_at INTEGER`) — distinct from `selection_comments`' text datetime. */
  createdAt: number;
}

export interface CreateSelectionCommentReplyInput {
  commentId: string;
  body: string;
  authorAgentId?: string | null;
  /** Defaults to the current epoch-ms when omitted. */
  createdAt?: number;
}

/** The agent-callable answer request. `callerAgentId` is the SERVER-established
 *  identity of the answering agent — the service revalidates it against the
 *  plan's durable responsible supervisor, exactly as `plan:setOverview`
 *  revalidates its `supervisorId`; a self-asserted non-responsible id is
 *  rejected, never trusted. */
export interface AnswerPlanCommentRequest {
  commentId: string;
  body: string;
  callerAgentId: string;
}

export type AnswerPlanCommentErrorCode =
  | 'reply-bad-request'
  | 'comment-not-found'
  | 'plan-not-found'
  | 'not-responsible-supervisor';

export type AnswerPlanCommentResult =
  | { ok: true; reply: SelectionCommentReply }
  | { ok: false; code: AnswerPlanCommentErrorCode; error: string };

// ── WP-P4D-proj — plan-comment projection (dual-source; logical-key resolution) ─
// The read surface for the comments rail. It rolls up EVERY comment on a plan —
// across its registered external documents (ordinary physical `file_path`) AND its
// folder-doc logical targets (`lares-plan-doc:v1:` keys) — each with its reply
// thread and a resolved target descriptor telling the renderer which tab/document
// it belongs to. Folder-doc keys are parsed ONLY in the exact `v1:` form and
// resolved through the plan's CURRENT folder (a folder rename keeps them attached
// via the durable `plan_artifact_id`). A key whose in-folder document no longer
// resolves — or a malformed / bad-rel-path `v1:` key — surfaces as an explicit
// ORPHANED plan-document target, never a filesystem path and never silently
// dropped. A key that cannot be attributed to a plan at all (unknown version,
// unparseable payload, missing artifact id) is a member of no plan.

/** Where a listed comment attaches to the plan. A `registered` target is an
 *  external proposal / legacy-html document (ordinary physical `file_path`); a
 *  `folder-doc` target resolved to a live in-folder document (opaque manifest doc
 *  id); an `orphaned` target is a folder-doc logical key whose document no longer
 *  resolves through the current plan folder. */
export type PlanCommentTarget =
  | {
      kind: 'registered';
      /** The `plan_documents` row id (opaque handle for the renderer). */
      documentId: string;
      tab: PlanTabKey; // 'proposal' | 'legacy-html'
      /** Basename for display. */
      name: string;
    }
  | {
      kind: 'folder-doc';
      /** The CURRENT manifest doc id (opaque; the renderer reads it by id). */
      documentId: string;
      tab: PlanTabKey; // 'plan' | 'overview' | 'deliberations' | 'research' | 'supplements'
      /** In-folder POSIX rel path the comment is durably keyed to. */
      docRelPath: string;
      /** Basename for display. */
      name: string;
    }
  | {
      kind: 'orphaned';
      /** The in-folder rel path from the logical key when decodable, else null. */
      docRelPath: string | null;
    };

/** One question comment rolled up with its companion reply thread and target. */
export interface PlanCommentThread {
  comment: SelectionComment;
  /** The companion `selection_comment_replies` rows, oldest first. */
  replies: SelectionCommentReply[];
  target: PlanCommentTarget;
}

export interface PlanCommentsProjection {
  planId: string;
  threads: PlanCommentThread[];
  /** Non-fatal diagnostics (folder manifest unavailable, workspace missing…). */
  warnings: string[];
}

// ── WP-P2C — unified gallery projection ───────────────────────────────────────
// A single server projection that unions three durable row kinds for the Plans
// gallery: filesystem-owned proposals, folder-per-plan `structured` plans, and
// legacy `format='html'` plans (labeled "Legacy Plan"). `format='md'` rows are
// preserved historical records and are NEVER projected here.

export type PlanGalleryRowType = 'proposal' | 'structured' | 'legacy';

/** Witnessed-first author attribution. Proposals carry their witnessed author
 *  (or `unknown`); structured-folder rows are ALWAYS `unknown` here unless
 *  authorship was separately witnessed — responsibility is never relabeled as
 *  authorship. Legacy rows carry no author. */
export interface PlanGalleryAuthor {
  role: 'supervisor' | 'worker' | 'unknown';
  display: string | null;
}

/** Responsible-supervisor / OWNER chip for a structured folder row, sourced from
 *  the plan folder's `plan.json` responsibility history (last `assigned` event).
 *  This is an ownership signal, explicitly NOT an author attribution. */
export interface PlanGalleryOwner {
  display: string | null;
  agentId: string | null;
  /** Provenance of the last assignment ('manual-skill' | 'promotion-service' | …). */
  source: string | null;
}

export interface PlanGalleryRow {
  /** Underlying source-row id (proposal id or plan id). */
  id: string;
  type: PlanGalleryRowType;
  /** Type badge label — 'Proposal' | 'Plan' | 'Legacy Plan'. */
  typeLabel: string;
  title: string;
  /** State chip: proposal|promoted|archived for proposals; the plan's run_state
   *  (nullable) for structured/legacy rows. */
  state: string | null;
  /** YYYY-MM-DD grouping bucket derived from the row's creation timestamp. */
  dateGroup: string;
  createdAt: string | number;
  updatedAt: string | number;
  mtimeMs: number | null;
  sizeBytes: number | null;
  /** Workspace-relative plan-folder path (structured rows only; else null). */
  folderRelPath: string | null;
  /** True iff this is a structured row backed by a plan folder on disk. */
  hasFolder: boolean;
  author: PlanGalleryAuthor;
  /** Owner chip (structured folder rows only; null for proposals/legacy). */
  owner: PlanGalleryOwner | null;
}

export interface PlanGalleryResult {
  rows: PlanGalleryRow[];
  /** Projection-level diagnostics (unreadable plan.json, resolution failures…). */
  warnings: string[];
}

/** Filesystem-first row for the Plans pane's promoted-plan tier. */
export interface PromotedPlanFolder {
  planArtifactId: string;
  /** Adopted database id consumed by the existing full planning surface. */
  planId: string;
  folderName: string;
  title: string;
  status: string;
  archived: boolean;
  updatedAt: string | number | null;
  responsibleSupervisor: PlanGalleryOwner | null;
}

export interface PromotedPlanFolderListResult {
  plans: PromotedPlanFolder[];
  warnings: string[];
}

/** Options for the gallery projection. By default the projection HIDES proposals
 *  in the `archived` and `promoted` states (still counted, never shown). */
export interface PlanGalleryOptions {
  includeArchived?: boolean;
  includePromoted?: boolean;
}

/** Result of `proposal:read` — one proposal's markdown, containment-validated and
 *  byte-capped. `{ error }` for an unknown id or a path that fails re-validation. */
export interface ProposalReadResult {
  id: string;
  name: string;
  content: string;
  truncated: boolean;
  sizeBytes: number;
}

declare global {
  interface Window {
    api: IpcApi;
  }
}
