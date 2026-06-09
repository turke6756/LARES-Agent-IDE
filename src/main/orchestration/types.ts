import { Agent, LaunchAgentInput } from '../../shared/types';

export type OrchestrationName = 'groupthink';
export type OrchestrationMode = 'serial' | 'parallel';
export type RunStatus = 'starting' | 'running' | 'complete' | 'stalled' | 'aborted' | 'error';

/** Catalog entry returned by list_orchestrations. */
export interface OrchestrationDescriptor {
  name: OrchestrationName;
  title: string;
  description: string;
  modes: OrchestrationMode[];
  params: Record<string, {
    type: 'string' | 'number' | 'boolean';
    required?: boolean;
    default?: unknown;
    description: string;
  }>;
}

/** Caller-supplied request for a groupthink run. */
export interface RunOrchestrationRequest {
  name: OrchestrationName;
  workspaceId: string;
  supervisorId: string;
  mode?: OrchestrationMode;          // default 'serial'
  topic?: string;
  planPath?: string;                 // resolved against workspace root
  leadProvider?: string;             // default 'claude'
  reviewerProvider?: string;         // default 'codex'
  turnTimeoutMs?: number;            // default 600000
  keepAgents?: boolean;
  // Resume inputs (any one):
  resumeRunId?: string;              // preferred — rehydrate from DB
  resumeLeadId?: string;             // structured legacy (serial only)
  resumeReviewerId?: string;
  legacyCommand?: string;            // a full `node scripts/groupthink-v2.js …` string
}

/** Live + persisted run record (one row in `orchestrations`). */
export interface OrchestrationRun {
  runId: string;
  name: OrchestrationName;
  mode: OrchestrationMode;
  status: RunStatus;
  workspaceId: string;
  supervisorId: string;
  topic: string;
  planPath: string;                  // absolute
  leadProvider: string;
  reviewerProvider: string;
  turnTimeoutMs: number;
  leadId?: string;
  reviewerId?: string;
  turn?: number;
  round?: number;
  lastRelayedTs: Record<string, string>;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  error?: string;
}

export interface OrchestrationEvent {
  runId: string;
  ts: string;
  kind: 'started' | 'turn' | 'round' | 'complete' | 'stalled' | 'aborted' | 'error' | 'delivery_failed';
  payload: unknown;
}

/** The narrow surface the runner needs from the dashboard — keeps the ported
 *  logic decoupled and unit-testable with a fake. Concretely implemented by
 *  dashboard-client.ts. */
export interface DashboardClient {
  launchAgent(input: LaunchAgentInput): Promise<Agent>;
  getAgent(id: string): Agent | null;
  getMessages(id: string, opts: { limit: number; role?: 'assistant' | 'user' }):
    Promise<Array<{ content: string; ts: string; turnComplete?: boolean }>>;
  sendInput(id: string, text: string): Promise<void>;
  isInputInFlight(id: string): boolean;
  // Source-reality reconciliation: the standalone script cleaned members up via
  // `DELETE /api/agents/:id`, which maps to `AgentSupervisor.stopAgent` (marks
  // the agent `done` + kills its process but KEEPS the DB record so run history
  // stays browsable). We name the seam `stopAgent` to match that semantics — not
  // `deleteAgent`, which fully purges the row.
  stopAgent(id: string): Promise<void>;
}

/** Per-run hooks the runner calls to persist progress + emit events. */
export interface OrchestrationRunContext {
  run: OrchestrationRun;
  signal: AbortSignal;
  persist(): void;
  emit(kind: OrchestrationEvent['kind'], payload: unknown): void;
}

/** Runner dispatch surface. Injectable into OrchestrationService so the service
 *  lifecycle (detach / persist / deliver / abort / boot-reconcile) is unit
 *  testable without the real groupthink relay loop. */
export type OrchestrationRunner =
  (client: DashboardClient, ctx: OrchestrationRunContext) => Promise<void>;
