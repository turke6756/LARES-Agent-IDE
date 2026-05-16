// Typed event union produced by SessionLogReader (main) and consumed by
// ChatPane (renderer). The reader tails the Claude Code JSONL session log at
// ~/.claude/projects/<slug>/<session-id>.jsonl and emits these events.
//
// Intentionally a leaf module: no imports from main/renderer so both sides
// can import freely. Covered by tsconfig.main.json and the renderer tsconfig
// via their respective src/shared/** includes.

export interface BaseEvent {
  uuid: string;
  timestamp: string; // ISO8601
  agentId: string;
}

export interface UserTextEvent extends BaseEvent {
  type: 'user-text';
  text: string;
}

export interface AssistantTextEvent extends BaseEvent {
  type: 'assistant-text';
  text: string;
  model?: string;
  // Metadata for orchestration and structured extraction
  turnComplete?: boolean;
  stopReason?: string;
  // Set by P2-01 (Phase 2). Until then this is always undefined; the bridge's
  // dispatch table still branches on it so M3 wiring is a no-op when it lands.
  endsWithQuestion?: boolean;
}

/**
 * Retroactive amendment to an `assistant-text` already in the ring buffer.
 *
 * Background: Codex split-batches can deliver `task_complete` in a later
 * poll than the preceding `assistant-text`. The reader's in-batch walk-back
 * can't see those events anymore. Patch events carry a fresh uuid (so the
 * dispatcher dedupe accepts them) plus the `targetUuid` of the event to
 * mutate; the dispatcher applies the patch in-place to the ring and pushes
 * the patch through to subscribers so chat consumers re-read the mutation.
 */
export interface AssistantTextPatchEvent extends BaseEvent {
  type: 'assistant-text-patch';
  targetUuid: string;
  turnComplete?: boolean;
  stopReason?: string;
  endsWithQuestion?: boolean;
}

/**
 * Marks the start of a new assistant turn. Emitted by Codex on
 * `event_msg/task_started`. The status latch needs an explicit "new turn"
 * signal to clear stale idle/waiting state cleanly.
 */
export interface TaskStartedEvent extends BaseEvent {
  type: 'task-started';
}

export interface ThinkingEvent extends BaseEvent {
  type: 'thinking';
  text: string;
}

export interface ToolUseEvent extends BaseEvent {
  type: 'tool-use';
  toolUseId: string;
  toolName: string;
  input: unknown; // tool-specific JSON; refined by per-tool blocks in phase 7
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool-result';
  toolUseId: string;
  content: string; // truncated to ~20KB by SessionLogReader
  truncated: boolean;
  isError?: boolean;
}

export interface UsageEvent extends BaseEvent {
  type: 'usage';
  sessionId: string;
  model: string;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  cumulativeContextTokens: number;
  contextWindowMax: number;
  contextPercentage: number;
  // Additive (Codex/Gemini): Anthropic-shaped readers leave these undefined.
  // Phase 6 will redesign this surface with required `provider` and per-provider fields.
  cachedTokens?: number;
  totalTokens?: number;
}

export interface SystemInitEvent extends BaseEvent {
  type: 'system-init';
  model: string;
  cwd?: string;
}

export type SessionEvent =
  | UserTextEvent
  | AssistantTextEvent
  | AssistantTextPatchEvent
  | TaskStartedEvent
  | ThinkingEvent
  | ToolUseEvent
  | ToolResultEvent
  | UsageEvent
  | SystemInitEvent;

export interface ChatEventBatch {
  agentId: string;
  events: SessionEvent[];
  initialLoad?: boolean;
  truncated?: boolean; // true if ring buffer cache evicted older events
}
