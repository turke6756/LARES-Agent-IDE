import http from 'http';
import type { AddressInfo } from 'net';
import { URL } from 'url';
import { getApiToken, decideApiAccess } from './security/api-auth';
import { sendOutcomeMessage } from '../shared/send-outcome-copy';
import { workspaceStateDir } from './workspace-state-dir';
import type { AgentSupervisor } from './supervisor';
import {
  getAgent, getAllAgents, getAgentsByWorkspace, getAgentsByOwner, getWorkspace, getSupervisorAgent,
  getFileActivities, findSelectionCommentsByPath,
  createTeam, getTeam, listTeams, updateTeamStatus, saveTeamManifest, getTeamManifest,
  addTeamMember, removeTeamMember, getTeamMembers,
  createChannel, removeChannel, getChannel, listChannels,
  createTeamMessage, getTeamMessages, getRecentMessageCount, getRecentPairMessages,
  createTeamTask, updateTeamTask, getTeamTasks,
  listAgentTemplates, createAgentTemplate, updateAgentTemplate, deleteAgentTemplate, getAgentTemplate,
  createContinuationHandoffAttempt, getOpenContinuationAttempt, getLatestContinuationAttempt,
  getContinuationAttempt, getContinuationEscapeBudget, closeContinuationHandoffAttempt, insertContinuationBrick,
  getLatestBrickForAttempt, hasRunningOrchestrationForSupervisor,
  getPlans, getPlan, getPlanByWorkspacePath, createOrRevivePlan, updatePlan, softDeletePlan, derivePlanSlug,
  getSupervisorFocus, upsertSupervisorFocus, deleteSupervisorFocus,
  bumpSupervisorFocusAttended, getSupervisorFocusedPlans,
  recordPlanSectionTouch, getPlanSections, getPlanEventRollup, getPlanEventsForRender,
  getPlanEventRepoActivity,
} from './database';
import { toTier2Digest, toTier3Detail } from './plans/repo-activity';
import { assertPlanRailFree } from './orchestration/plan-ownership';
import { createPlanSurface } from './plans/create-plan';
import { readPlanSection, listPlanSections, type ReadMode } from './plans/read-ladder';
import { parsePlanHtmlSafe, type PlanProjection } from './plans/section-reader';
import { getServedPlanProjection } from './plans/watch-plans';
import { readFileContents } from './file-reader';
import {
  executeCell as kernelExecuteCell,
  executeNotebook as kernelExecuteNotebook,
  executeRange as kernelExecuteRange,
  interruptKernel as kernelInterrupt,
  restartKernel as kernelRestart,
  getKernelState as kernelGetState,
} from './jupyter-kernel-client';
import { scanPersonas, scaffoldPersona } from './persona-scanner';
import { applyContextGaugeSettings, type ContextGaugeIpcDeps } from './context-gauge/context-gauge-ipc';
import { TEAM_MAX_MESSAGES_PER_5MIN, TEAM_MAX_ALTERNATIONS, TEAM_ALTERNATION_WINDOW_MS, TEAM_PAIR_COOLDOWN_MS, CONTINUATION_BRICK_MAX_BYTES, CONTINUATION_ESCAPE_MAX_ATTEMPTS, CONTINUATION_ESCAPE_MAX_ALIVE_MS } from '../shared/constants';
import { TeamMessageStatus, hasSupervisorPrivilege } from '../shared/types';
import type { Agent, Workspace, PlanActivityEvent, RepoActivityDetail } from '../shared/types';
import fs from 'fs';
import * as nodePath from 'path';
import type { SigninPendingResult, SigninPendingEntry } from '../shared/browser';
import { isKeyName, mapKeyToBytes, SUPPORTED_KEY_NAMES } from './supervisor/key-bytes';
import type { OrchestrationService } from './orchestration/service';
import crypto from 'crypto';
import os from 'os';
// ── WP7 agent-facing read-only optimizer surface (additive; GET-only). ──
import { getDb, getWorkspace as getWorkspaceRecord } from './database';
import type { PipelineDb } from './context-optimizer/optimizer-pipeline';
import { runLiveOptimizerAnalyze } from './context-optimizer/optimizer-live-analyze';
import {
  buildProposalsPage, buildProposalDetail, buildProposalEvidence, buildFileHeatPage,
  buildClusterExemplars, buildAnalyzabilityPage,
  IMPROVEMENT_ROUTE, IMPROVEMENT_LEVERS,
} from './context-optimizer/agent-dto-build';
import { BehaviorStore } from './context-optimizer/behavior-store';
import {
  buildSkillUsagePage, buildSkillUsageDetail,
  buildAgentKnowledgePage, buildAgentKnowledgeDetail,
  buildMcpToolUsagePage,
} from './context-optimizer/agent-observability-build';
import { errResponse, type AgentDtoResponse, type RedactionRoots } from './context-optimizer/agent-dto';
import { querySkillUsage, type QueryDb } from './skill-analytics/queries';
import { getSharedParseManager } from './skill-analytics/parse-manager-factory';
import { queryMcpToolUsage } from './skill-analytics/mcp-tool-usage-queries';
import { runKnowledgeExtract } from './agent-knowledge/knowledge-extract-runner';
import { runOverheadScan } from './context-overhead/ipc-deps';
import { buildOverheadSnapshot, scrubPaths } from './context-overhead/overhead-dto';
import type { AgentRoleLane, BehaviorEvidenceTier, ContextOptimizerProposalKind, ContextOptimizerResult, AgentKnowledgeGraph, SkillUsageResult, McpToolUsageRollupDTO, WorkspaceScopeMode, PathRole, OverheadModel } from '../shared/types';

/** Machine-readable failure classes the top-level error serializer is allowed
 *  to expose in JSON bodies. Errors thrown inside routes can carry raw Node
 *  errno strings on `.code` (ENOENT, EACCES, ECONNREFUSED, ...) — those are
 *  internals and must NOT leak to clients as API codes, so the serializer
 *  allowlists instead of forwarding any string. Add new dashboard API codes
 *  here deliberately when a route starts setting them. */
const API_ERROR_CODES = new Set<string>([
  'submit-not-confirmed', 'delivery-failed', 'browser-policy-denied',
  // Context-brick Inc 1 identity layer — resolveIdentity / resolveWorkspaceScope
  // attach these to their 403s. Without the allowlist entry the serializer would
  // strip `err.code`, so a caller could not machine-distinguish an unknown-workspace
  // assertion from a scope mismatch.
  'unknown-workspace', 'workspace-scope-mismatch',
  // Context-brick Inc 2 (≡ P1-10a) — resolveIdentity's X-Supervisor-Id
  // validation attaches these to its 403s.
  'unknown-supervisor', 'supervisor-workspace-mismatch', 'not-a-supervisor',
  // Context-brick Inc 4 (4.4) — continuation attempt/brick/relaunch gates.
  'continuation-open-attempt-exists', 'continuation-no-open-attempt',
  'continuation-note-too-large', 'continuation-attempt-not-committed',
  'continuation-no-tool-brick',
  'continuation-input-in-flight', 'continuation-awaiting-human',
  'continuation-orchestration-running',
  // WP7 agent-facing read-only optimizer surface — non-GET to a GET-only route.
  'method-not-allowed',
  // Context-brick Inc 5 (5B) — the note-less empty-memo escape's gates. The
  // escape is gated on the durable EFFORT BUDGET (aborts / alive-time), NOT a
  // context percentage, so the not-yet-authorized code is budget-not-exhausted.
  'continuation-attempt-not-open', 'continuation-budget-not-exhausted',
  'continuation-escape-has-brick',
  // BUG-39 (WP1) — self-busy gate: the target agent's OWN turn must be complete
  // before its PTY is killed (belt to the watcher's advisory post-note grace).
  'continuation-self-busy',
  // D5-lite memory watchdog admission control (incident-2026-07-11 §5). A new
  // agent launch / agent tab is refused under Critical commit pressure
  // (`memory-critical`) or at a static cap (`memory-capacity`) so the calling
  // agent/orchestrator receives a machine-readable "no" instead of degrading.
  // Full-D5 (Wave 4) adds `memory-budget` — the per-agent budget refusal, same
  // family, surfaced identically to the API/MCP caller.
  'memory-critical', 'memory-capacity', 'memory-budget',
  // GET /api/context-overhead — a request that resolves to no workspace scope.
  'invalid-argument',
]);

/** Strip absolute paths out of an error message before it crosses the API
 *  boundary. A failed overhead scan can surface an unreadable-file error whose
 *  message embeds a full path; the route must not become a path-disclosure side
 *  channel. Delegates to the one redaction implementation shared with the
 *  exporter rather than keeping a second copy of the patterns. */
function sanitizeErrorMessage(msg: string): string {
  return scrubPaths(msg || '');
}

/** Context-brick Inc 1 — the identity an inbound request asserts via headers,
 *  resolved once per request between the admission gate and route(). This is an
 *  ATTRIBUTION layer on TOP of the Bearer-token admission (decideApiAccess), not
 *  a first line of defense. Backward-compat is load-bearing: a caller sending no
 *  `X-Workspace-Id` header resolves to `asserted:false` with nulls and rides the
 *  exact pre-brick code path. Inc 2 (≡ P1-10a): when `X-Supervisor-Id` is present
 *  it is validated (exists + in-workspace + is_supervisor, else 403) and the
 *  asserted caller lands in `supervisor`, overriding the best-effort
 *  getSupervisorAgent LIMIT-1 fallback (which survives for callers that assert
 *  only a workspace). */
interface IdentityContext {
  workspaceId: string | null;
  supervisor: Agent | null;
  asserted: boolean;
  projectId: string | null;
  supervisorId: string | null;
}

/** WP2 frozen browser-tool provider contract (plans/embedded-browser-
 *  implementation-tasks.md §WP2-B). WP2-A implements this as
 *  `browserManager.tools`; this file only consumes it — never import from
 *  src/main/browser/* here. The concrete TabSnapshot/TabInfo shapes are
 *  WP2-A's; they're typed structurally loose (JSON-serializable `unknown`)
 *  so WP2-A's implementation satisfies the interface without coupling.
 *
 *  Error contract: policy denials (M9/M10/M11/M12 act-tier gate, sensitive
 *  origins, SSRF, actions-toggle-off) must arrive as errors whose
 *  `name === 'PolicyError'` — the routes map exactly those to HTTP 403 with
 *  the policy message intact. Everything else surfaces as 500. */
export interface BrowserToolProvider {
  /** forHuman → visible persist:user tab, never CDP (M9). Resolves once the
   *  page is ready — the navigateAndWait lives server-side so MCP proxy
   *  scripts stay dumb (M10 page-ready note). */
  openUrl(
    url: string,
    opts: {
      forHuman?: boolean;
      workspaceId?: string | null;
      /** Slice-2: agent identity resolved trust-side from the agent registry
       *  (display only — stamped on the tab, never read back to the agent). */
      agentId?: string;
      agentTitle?: string;
    },
  ): Promise<unknown>;
  listTabs(): unknown[];
  // WI-4 (signed-in tabs): every page-producing / action verb may now resolve to
  // the `SigninPendingResult` envelope (`{ ok:false, status:'pending_signin' |
  // 'signin_unavailable', … }`) INSTEAD of content / acting, when the tab's
  // committed origin needs a human sign-in. This is a NORMAL structured result,
  // NOT a PolicyError — the routes pass it straight through (no 403). The shim
  // JSON-prints the whole envelope; the researcher polls on it.
  /** wrapUntrusted applied by the provider (M12). */
  getPageText(tabId: string): Promise<string | SigninPendingResult>;
  /** a11y tree + numbered refs, wrapUntrusted applied (M12). */
  readPage(tabId: string): Promise<string | SigninPendingResult>;
  screenshot(tabId: string): Promise<{ base64Png: string } | SigninPendingResult>;
  /** Act tier — throws PolicyError unless human-enabled; returns the fresh
   *  post-click snapshot. */
  click(tabId: string, ref: number): Promise<string | SigninPendingResult>;
  /** Act tier (WP-C parity). Each returns the fresh post-action snapshot
   *  except closeTab (returns the updated agent tab list) and waitFor (a
   *  server-side bounded poll result). NONE is an eval surface (M10). */
  type(tabId: string, ref: number, text: string): Promise<string | SigninPendingResult>;
  pressKey(tabId: string, key: string): Promise<string | SigninPendingResult>;
  selectOption(tabId: string, ref: number, value: string): Promise<string | SigninPendingResult>;
  scroll(tabId: string, opts: { ref?: number; dy?: number }): Promise<string | SigninPendingResult>;
  goBack(tabId: string): Promise<string | SigninPendingResult>;
  goForward(tabId: string): Promise<string | SigninPendingResult>;
  reload(tabId: string): Promise<string | SigninPendingResult>;
  /** Read tier — bounded poll; returns { found, elapsedMs, snapshot? } or the
   *  signin envelope. */
  waitFor(tabId: string, input: { text: string; timeoutMs?: number }): Promise<unknown>;
  /** Act tier — returns the updated agent tab list (no impossible snapshot). */
  closeTab(tabId: string): Promise<unknown>;
  /** §18 agent-initiated access request. INERT — writes a pending request for a
   *  human to approve in trusted chrome; grants ZERO access. Returns
   *  { requestId, status }.
   *
   *  IDENTITY (F5 accepted risk): `requestedBy` is supplied in the request BODY,
   *  not stamped by this layer. The MCP proxy (scripts/mcp-browser-tools.js)
   *  injects `requestedBy: AGENT_ID` from its per-agent launch env, so the agent
   *  *model* cannot forge it via tool args. But the dashboard API token is a
   *  single per-launch secret SHARED by every agent (security/api-auth.ts) — the
   *  HTTP layer has NO per-connection agent identity, so a token-holding agent
   *  that bypasses its proxy could set any `requestedBy`. Accepted because the
   *  request grants no access (a human approves) and the blast radius is limited
   *  to attribution spoofing / pending-cap griefing / cross-agent request-history
   *  disclosure — not an M9 escalation. `requestedByTitle` IS resolved trust-side
   *  from the agent registry (display only). If per-agent API tokens ever land,
   *  derive `requestedBy`/`agentId` from the connection and ignore body/query. */
  requestSiteAccess(input: {
    hostname: string;
    scheme?: string;
    includeSubdomains?: boolean;
    pathPrefix?: string;
    reason?: string;
    wantSignedIn?: boolean;
    requestedBy: string;
    requestedByTitle?: string;
    /** Slice-4: requesting agent's workspace, resolved trust-side here. */
    workspaceId?: string | null;
  }): unknown;
  /** §18 outcome read — a single agent's own requests + statuses. */
  listMyAccessRequests(agentId: string): unknown[];
  /** WI-4 — the workspace-scoped `signin_pending` rollup that rides alongside
   *  `requests` in the browser_list_my_access_requests payload. workspaceId is
   *  resolved trust-side (agentId → workspace) by this layer. */
  listSigninPending(workspaceId: string | null): SigninPendingEntry[];
}

/** WP-2B — parse the optional `scopeMode` query param for workspace-scoped usage
 *  routes. Unknown/absent → undefined, so the query layer applies its 'include-proxy'
 *  default. */
function parseScopeMode(raw: string | null): WorkspaceScopeMode | undefined {
  return raw === 'strict' || raw === 'include-proxy' || raw === 'global-diagnostic' ? raw : undefined;
}

/**
 * Lightweight HTTP API server that exposes supervisor methods.
 * The MCP server script (scripts/mcp-supervisor.js) calls these endpoints
 * to fulfill tool requests from the supervisor agent.
 */
export class ApiServer {
  private server: http.Server | null = null;
  private supervisor: AgentSupervisor;
  private port: number;

  /** Context-brick Inc 4 (4.4) — injectable awaiting-human predicate for the
   *  continuation-relaunch gate. Conservative stub: defaults to false so the
   *  gate never blocks on it until Inc 5 wires the real endsWithQuestion
   *  cache (supervisor.lastEndsWithQuestion). TODO(Inc 5): inject the real
   *  predicate; the fail-safe direction there is keep-alive (return true when
   *  the latest turn ended with a question). Tests may override directly. */
  public isAwaitingHuman: (agentId: string) => boolean = () => false;

  /** `bindHost` defaults to 0.0.0.0 deliberately (WP0.1 bind decision): WSL
   *  agents reach the API via the Windows-host gateway IP, so a loopback-only
   *  bind breaks them. The per-launch bearer token is the network gate, not
   *  the bind scope. Tests pass '127.0.0.1' (+ port 0 for ephemeral binds). */
  constructor(
    supervisor: AgentSupervisor,
    port = 24678,
    private orchestration?: OrchestrationService,
    private bindHost: string = '0.0.0.0',
    private browserTools?: BrowserToolProvider,
  ) {
    this.supervisor = supervisor;
    this.port = port;
  }

  /** Late injection for the WP2 browser-tool provider. Production must use
   *  this rather than the constructor param: BrowserManager is constructed
   *  AFTER the awaited start() (its M2 loopback filter needs the actually-
   *  bound port), so the provider can't exist when ApiServer is built.
   *  Tests inject a fake via the constructor. Until one of the two happens,
   *  every /api/browser/* route answers 503. */
  setBrowserTools(provider: BrowserToolProvider): void {
    this.browserTools = provider;
  }

  /** Context Window Warning: late-injected settings deps (same object the IPC
   *  surface uses, so both write paths sanitize/persist/broadcast identically).
   *  Until wired, the /api/settings/context-gauge routes answer 503. */
  private contextGaugeDeps?: ContextGaugeIpcDeps;
  setContextGaugeDeps(deps: ContextGaugeIpcDeps): void {
    this.contextGaugeDeps = deps;
  }

  private requireBrowserTools(): BrowserToolProvider {
    if (!this.browserTools) {
      throw Object.assign(
        new Error(
          'Browser tools unavailable: this dashboard has no embedded-browser tool provider wired in '
          + '(the browser pane is missing or predates Phase 2). The browser_* MCP tools cannot work here.',
        ),
        { statusCode: 503 },
      );
    }
    return this.browserTools;
  }

  /** Map WP2-A policy denials (err.name === 'PolicyError') to HTTP 403 with
   *  the policy message passed through so the agent reads WHY it was denied
   *  (actions toggle off, sensitive origin, SSRF, …). Anything else rethrows
   *  unchanged and falls into the generic 500 path. */
  private static rethrowBrowserError(err: unknown): never {
    if (err instanceof Error && err.name === 'PolicyError') {
      throw Object.assign(err, { statusCode: 403, code: 'browser-policy-denied' });
    }
    throw err;
  }

  /** WI-4 (signed-in tabs): a page-producing/action verb may resolve to the
   *  `SigninPendingResult` envelope (`{ ok:false, status:'pending_signin' |
   *  'signin_unavailable', … }`) when the tab's committed origin needs a human
   *  sign-in. This is a NORMAL structured result — NOT a PolicyError/403 — so the
   *  routes detect it here and forward the WHOLE envelope as the JSON body
   *  instead of treating it as content. The MCP shim JSON-prints it; the
   *  researcher polls on `status`. */
  private static isSigninEnvelope(r: unknown): r is SigninPendingResult {
    return !!r && typeof r === 'object' && 'ok' in r && (r as { ok: unknown }).ok === false;
  }

  /** Resolves with the actually-bound port once listening — surviving the
   *  EADDRINUSE auto-increment — so callers never read a stale pre-retry
   *  port (the old getPort()/start() race). Rejects on non-recoverable
   *  listen errors. */
  start(): Promise<number> {
    this.server = http.createServer(async (req, res) => {
      // M1 + M8 admission gate (WP0.1, security spec §3) — runs BEFORE route():
      // preflight short-circuit, origin allowlist (403), bearer token (401).
      // Fail closed: no token, no service — the bind is 0.0.0.0 for WSL.
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const decision = decideApiAccess(req.method || 'GET', origin, req.headers.authorization, getApiToken());
      if (decision.kind !== 'forbidden-origin' && decision.corsOrigin !== undefined) {
        // Per-origin echo, never `*`; never Access-Control-Allow-Credentials.
        res.setHeader('Access-Control-Allow-Origin', decision.corsOrigin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        // Context-brick Inc 1 (A5) — allow the identity attribution headers so the
        // renderer preflight does not silently block a header-carrying request.
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Workspace-Id, X-Supervisor-Id, X-Project-Id');
      }
      if (decision.kind === 'preflight') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (decision.kind === 'forbidden-origin') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Origin not allowed' }));
        return;
      }
      if (decision.kind === 'unauthorized') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid API token (Authorization: Bearer <AGENT_DASHBOARD_API_TOKEN>)' }));
        return;
      }

      try {
        // Context-brick Inc 1 (A1) — resolve asserted identity between the
        // admission gate and route(). Inside the try so a 403 (unknown workspace)
        // maps to HTTP via the err.statusCode catch below.
        const identity = this.resolveIdentity(req);
        const url = new URL(req.url || '/', `http://localhost:${this.port}`);
        const result = await this.route(req.method || 'GET', url, req, identity);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        const status = err.statusCode || 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        // Include the machine-readable failure class when one was attached,
        // but ONLY if it's a known dashboard API code (see API_ERROR_CODES) —
        // an fs/network error escaping a route would otherwise leak its Node
        // errno (e.g. ENOENT) to clients as if it were an API failure class.
        // No unit-test seam exists for this inline serializer (no api-server
        // test file in the suite); the allowlist contract lives here and in
        // the API_ERROR_CODES doc comment.
        const errBody: { error: string; code?: string } = { error: err.message || 'Internal error' };
        if (typeof err.code === 'string' && API_ERROR_CODES.has(err.code)) errBody.code = err.code;
        res.end(JSON.stringify(errBody));
      }
    });

    const server = this.server;
    return new Promise<number>((resolve, reject) => {
      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[api-server] Port ${this.port} in use, trying ${this.port + 1}`);
          this.port++;
          server.listen(this.port, this.bindHost);
        } else {
          console.error('[api-server] Error:', err);
          // No-op if already listening (runtime error after startup);
          // before 'listening' it fails start() so boot surfaces the fault.
          reject(err);
        }
      });
      server.on('listening', () => {
        // Read the kernel-assigned port (port: 0 ephemeral binds, EADDRINUSE
        // increments) so getPort() can never return a stale pre-retry value.
        this.port = (server.address() as AddressInfo).port;
        console.log(`[api-server] Listening on http://${this.bindHost}:${this.port}`);
        resolve(this.port);
      });
      server.listen(this.port, this.bindHost);
    });
  }

  /** Only meaningful once start() has resolved. */
  getPort(): number {
    return this.port;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  /**
   * Overlay the transient `receiving` status while an input send is in flight.
   * The status monitor cannot infer activity from typed-char echoes, so the DB
   * still reads `idle` for the duration of a slow per-char Win32 send. Without
   * this overlay, callers (and other agents polling `list_agents`) would see
   * `idle` and think their message landed before any of it had been typed.
   *
   * `receiving` — not `working` — because this reflects "a message is arriving
   * at this agent," distinct from "the model is generating." It is never
   * persisted and never rides a `statusChanged` event; it exists only on the
   * read projection and clears the instant delivery finishes.
   */
  private withInputInFlight<T extends { id: string; status: string }>(agent: T): T {
    if (
      this.supervisor.isInputInFlight(agent.id) &&
      (agent.status === 'idle' || agent.status === 'waiting')
    ) {
      return { ...agent, status: 'receiving' };
    }
    return agent;
  }

  /** Context-brick Inc 1 (A1) — resolve the caller's asserted identity from the
   *  request headers. Runs BETWEEN the admission gate and route(), inside the
   *  try/catch so a thrown 403 maps to HTTP via the existing err.statusCode idiom.
   *
   *  Backward-compat contract (load-bearing): no `X-Workspace-Id` header →
   *  `asserted:false` + all nulls → today's exact code path, byte-identical. A
   *  present `X-Workspace-Id` naming an unknown workspace → 403 (attribution can't
   *  proceed against a phantom scope). Inc 2 (≡ P1-10a) validates the supervisor
   *  rail — see the inline comment below. A supervisor assertion REQUIRES a
   *  workspace assertion: the launch-env injection guarantees SUPERVISOR_ID is
   *  always accompanied by WORKSPACE_ID, so an X-Supervisor-Id arriving without
   *  X-Workspace-Id has no scope to validate against and rides the non-asserted
   *  early return (ignored, never trusted). NOTE (Gap 2, Inc 2): `X-Self-Id` is
   *  deliberately NOT read here — it is reserved for the ownership path
   *  (owner_agent_id stamping in the launch body); resolveIdentity must never
   *  read it. */
  private resolveIdentity(req: http.IncomingMessage): IdentityContext {
    const h = req.headers;
    const hdr = (name: string): string | null => {
      const v = h[name];
      return typeof v === 'string' && v.length > 0 ? v : null;
    };
    const workspaceId = hdr('x-workspace-id');
    if (workspaceId === null) {
      // Header absent → non-asserted. Every existing UI/IPC/curl caller lands here.
      return { workspaceId: null, supervisor: null, asserted: false, projectId: null, supervisorId: null };
    }
    const workspace = getWorkspace(workspaceId);
    if (!workspace) {
      throw Object.assign(
        new Error(`Unknown workspace asserted in X-Workspace-Id: ${workspaceId}`),
        { statusCode: 403, code: 'unknown-workspace' },
      );
    }
    // Inc 2 (2.2, ≡ P1-10a) — the supervisor rail. Header absent → best-effort
    // LIMIT-1 fallback (today's non-asserted supervisor attribution, unchanged).
    // Header present → validate (exists + in the asserted workspace +
    // is_supervisor, else 403) and let the asserted caller OVERRIDE the
    // fallback: in a multi-supervisor workspace LIMIT-1 would misattribute
    // every older supervisor's calls to the newest one.
    const supervisorId = hdr('x-supervisor-id');
    let supervisor: Agent | null;
    if (supervisorId === null) {
      supervisor = getSupervisorAgent(workspaceId);
    } else {
      const caller = getAgent(supervisorId);
      if (!caller) {
        throw Object.assign(
          new Error(`Unknown agent asserted in X-Supervisor-Id: ${supervisorId}`),
          { statusCode: 403, code: 'unknown-supervisor' },
        );
      }
      if (caller.workspaceId !== workspaceId) {
        throw Object.assign(
          new Error(`X-Supervisor-Id '${supervisorId}' is not an agent of workspace '${workspaceId}'`),
          { statusCode: 403, code: 'supervisor-workspace-mismatch' },
        );
      }
      // Supervisor-privilege gate (#19): the structural workspace supervisor OR a
      // privilegeLane:'supervisor' persona. Both already receive the full
      // supervisor MCP toolset (roleLaneOf → toolsetsForLane 'supervisor'), so the
      // rail admits both — a persona calling save_continuation_brick /
      // get_my_context / list_my_agents authenticates as its own id. A plain
      // worker/researcher still 403s. Every downstream caller of resolveIdentity
      // scopes strictly by identity.supervisor.id (owned-agents, focus rows, brick
      // author) — none assumes THE single workspace supervisor — so loosening the
      // predicate here is safe; see the resolveIdentity callers audited for #19.
      if (!hasSupervisorPrivilege(caller)) {
        throw Object.assign(
          new Error(`X-Supervisor-Id '${supervisorId}' is not a supervisor-privileged agent`),
          { statusCode: 403, code: 'not-a-supervisor' },
        );
      }
      supervisor = caller;
    }
    return {
      workspaceId,
      supervisor,
      asserted: true,
      projectId: hdr('x-project-id'),
      supervisorId,
    };
  }

  /** Context-brick Inc 1 (A2) — reconcile an asserted identity with an explicit
   *  `workspaceId` query/body value. Matrix:
   *    - not asserted            → return the caller-supplied value (today's behavior)
   *    - asserted + no explicit  → the asserted workspace (self-scope)
   *    - asserted + matching     → that workspace
   *    - asserted + mismatched   → 403 (a supervisor may not reach across workspaces) */
  private resolveWorkspaceScope(identity: IdentityContext, explicit: string | null): string | null {
    if (!identity.asserted) return explicit;
    if (explicit === null || explicit === '') return identity.workspaceId;
    if (explicit === identity.workspaceId) return explicit;
    throw Object.assign(
      new Error(`workspaceId '${explicit}' does not match asserted X-Workspace-Id '${identity.workspaceId}'`),
      { statusCode: 403, code: 'workspace-scope-mismatch' },
    );
  }

  /** Planning-surface focus auto-subscribe: when the caller resolves to an
   *  asserted supervisor (validated X-Supervisor-Id → identity.supervisorId), record
   *  a supervisor_focus row so the plan resurfaces in its get_my_context orientation
   *  after a /clear. Silent no-op for non-supervisor callers (workers/humans, whose
   *  supervisorId is null) and NEVER throws — focus attribution must never turn an
   *  otherwise-valid create/dispatch into a 4xx. Notes are left untouched on an
   *  existing row (upsert COALESCEs a null note). */
  private autoFocusPlan(identity: IdentityContext, planId: string | null | undefined): void {
    try {
      if (!identity.supervisorId || !planId) return;
      upsertSupervisorFocus({ supervisorId: identity.supervisorId, planId, notes: null });
    } catch (err) {
      console.warn('[api-server] auto-focus upsert failed (non-fatal):', err);
    }
  }

  /** Attended-bump on a plan read (P1-07 wiring): when an asserted supervisor reads a
   *  plan it already focuses, freshen last_attended_at so the orientation ordering
   *  reflects real attention. No focus row → the helper UPDATEs zero rows and returns
   *  null (never auto-creates one). Best-effort — never fails the read. */
  private bumpFocusOnRead(identity: IdentityContext, planId: string): void {
    try {
      if (identity.supervisorId) bumpSupervisorFocusAttended(identity.supervisorId, planId);
    } catch { /* best-effort — a focus bump must never gate the content (R2 §0) */ }
  }

  // ── WP7 agent-facing read-only optimizer surface (helpers). ──
  // READ-ONLY: these only READ. No route below writes a DB row, marks an action
  // applied, or signs a derivation (those stay UI/IPC-only — classifier §5.4). Every
  // path here is GET; a non-GET to a matched path 405s (see the route block).

  /** Run the live optimizer analyze scoped to the caller's workspace (§5.6 default).
   *  Mirrors ipc-handlers' composition via the shared runLiveOptimizerAnalyze helper. */
  private runOptimizerForRequest(identity: IdentityContext, url: URL): ContextOptimizerResult {
    const workspaceId = this.resolveWorkspaceScope(identity, url.searchParams.get('workspaceId')) ?? undefined;
    const laneParam = (url.searchParams.get('lane') as AgentRoleLane | null) ?? undefined;
    const repoDir = nodePath.resolve(__dirname, '..', '..', '..');
    // WP-4A — file-heat is now workspace-scoped at the query layer. `slug` unlocks the
    // include-proxy leg; `scopeMode` defaults to 'strict' in queryFileTouchesScoped.
    const slug = url.searchParams.get('slug') ?? undefined;
    const scopeMode = parseScopeMode(url.searchParams.get('scopeMode'));
    const includeOperationalNoise = url.searchParams.get('includeOperationalNoise') === 'true';
    return runLiveOptimizerAnalyze({
      workspaceId,
      db: getDb() as unknown as PipelineDb,
      repoDir,
      generatedAtIso: new Date().toISOString(),
      nowMs: Date.now(),
      query: { lane: laneParam, workspaceId, slug, scopeMode, includeOperationalNoise },
    });
  }

  /** Overhead scan scoped to the caller's workspace. READ-ONLY: runOverheadScan is a
   *  filesystem + estimator composition with no DB writes (ipc-deps.ts:251-275). */
  private runOverheadForRequest(identity: IdentityContext, url: URL): OverheadModel {
    const workspaceId = this.resolveWorkspaceScope(identity, url.searchParams.get('workspaceId'));
    if (!workspaceId) {
      throw Object.assign(
        new Error('context-overhead requires a resolvable workspace scope'),
        { statusCode: 400, code: 'invalid-argument' },
      );
    }
    return runOverheadScan(workspaceId);
  }

  /** R2 WP-4B (Step 3) — the live BehaviorStore backing the cluster-exemplar drill. Built
   *  UNSCOPED (`new BehaviorStore(getDb())`), mirroring how optimizer-assemble builds the
   *  store for `improvisationClusters`, so the drill sees the SAME folded members the
   *  rollup did (a workspace-scoped store would drift from the rollup's member set). */
  private buildClusterExemplarStore(_identity: IdentityContext, _url: URL): BehaviorStore {
    return new BehaviorStore(getDb() as unknown as import('./context-optimizer/behavior-store').QueryDb);
  }

  /** Redaction roots (§5.6) for the caller's workspace. `absPath` is never populated on
   *  this MCP/API path — only pathDisplay/pathScope/pathHash cross the boundary. */
  private buildRedactionRoots(identity: IdentityContext, url: URL): RedactionRoots {
    const workspaceId = this.resolveWorkspaceScope(identity, url.searchParams.get('workspaceId'));
    const workspaceRoot = workspaceId ? getWorkspaceRecord(workspaceId)?.path : undefined;
    return {
      workspaceRoot,
      dashboardRoot: workspaceRoot ? workspaceStateDir(workspaceRoot) : undefined,
      homeDir: os.homedir(),
      // SEAM: per-skill roots (`$SKILL/<name>`) require a scaffold scan; without it a
      // skill path falls back to $DASHBOARD/$WORKSPACE (still username/drive-free — safe).
    };
  }

  /** Parse an optional integer query param; undefined when absent/malformed (the DTO
   *  layer then applies the per-tool default). */
  private intParam(url: URL, name: string): number | undefined {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === '') return undefined;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? undefined : n;
  }

  /** Run the WP3 skill-usage rollup scoped to the caller's workspace (§5.6). WP-D fix
   *  leg: scope by the authoritative agents-join `workspaceId` — NOT the structurally-
   *  NULL `workspace_root` (which excluded every row, reading as "skills unused"). Also
   *  parse-first parity with the IPC panel: on a fresh install the backfill marker is
   *  unset, so kick `ensureIndexed()` (gated behind the cheap marker check — a no-op in
   *  steady state) and signal `indexing` so the surface reads 'indexing', not empty. */
  private runSkillUsageForRequest(identity: IdentityContext, url: URL): { usage: SkillUsageResult; indexing: boolean } {
    const workspaceId = this.resolveWorkspaceScope(identity, url.searchParams.get('workspaceId')) ?? undefined;
    const slug = url.searchParams.get('slug') ?? undefined;
    const mgr = getSharedParseManager();
    let indexing = false;
    if (!mgr.isBackfillComplete()) {
      mgr.ensureIndexed();   // non-blocking; kicks the cooperative first-run backfill
      indexing = true;
    }
    // WP-2B — workspace scope policy. Defaults to 'strict' in the skill-usage query
    // layer (its vetted honest agents-join scope); 'include-proxy' is opt-in via ?scopeMode=.
    const scopeMode = parseScopeMode(url.searchParams.get('scopeMode'));
    const usage = querySkillUsage(getDb() as unknown as QueryDb, { workspaceId, slug, scopeMode });
    return { usage, indexing };
  }

  /** Run the wave2 per-MCP-tool usage rollup scoped to the caller (§2.3), projected to
   *  the lean four-tier attribution rollup DTO (WP-C / P2). Workspace scope degrades
   *  honestly: `workspaceId` matches attributed streams via the agents-join, and
   *  callers scope the honest (unattributed-inclusive) view via `slug`. Attribution is
   *  honest four-tier (agent > explicit-lane > exclusive-grant > unattributed) — the
   *  DTO carries the tierBreakdown + coverage %; the raw enriched result stays on IPC
   *  for the panel. */
  private runMcpToolUsageForRequest(identity: IdentityContext, url: URL): AgentDtoResponse<McpToolUsageRollupDTO> {
    const workspaceId = this.resolveWorkspaceScope(identity, url.searchParams.get('workspaceId')) ?? undefined;
    const slug = url.searchParams.get('slug') ?? undefined;
    const lane = url.searchParams.get('lane') ?? undefined;
    const agentId = url.searchParams.get('agentId') ?? undefined;
    // WP-2B — workspace scope policy. Defaults to 'include-proxy' in the query layer,
    // which self-determines slug↔workspace uniqueness before admitting any proxy row.
    const scopeMode = parseScopeMode(url.searchParams.get('scopeMode'));
    const result = queryMcpToolUsage(getDb() as unknown as QueryDb, { workspaceId, slug, lane, agentId, scopeMode });
    return buildMcpToolUsagePage(result, { full: url.searchParams.get('full') === 'true' });
  }

  /** Run the WP4 agent-knowledge extraction for the caller-scoped workspace + a required
   *  `agentId`. Throws a 400/404-mapped error the top-level serializer turns into an
   *  AgentDtoError-shaped body; on a missing agent the pure runner throws, so we surface
   *  it as INVALID_ARGUMENT rather than a raw 500. */
  private runAgentKnowledgeForRequest(identity: IdentityContext, url: URL): AgentKnowledgeGraph {
    const workspaceId = this.resolveWorkspaceScope(identity, url.searchParams.get('workspaceId'));
    const agentId = url.searchParams.get('agentId');
    if (!workspaceId) {
      throw Object.assign(new Error('agent-knowledge requires a resolvable workspace scope'),
        { statusCode: 400, code: 'invalid-argument' });
    }
    if (!agentId) {
      throw Object.assign(new Error('agent-knowledge requires an agentId query param'),
        { statusCode: 400, code: 'invalid-argument' });
    }
    return runKnowledgeExtract(workspaceId, agentId);
  }

  private async route(method: string, url: URL, req: http.IncomingMessage, identity: IdentityContext): Promise<any> {
    const path = url.pathname;

    // GET /api/agents — list all agents
    if (method === 'GET' && path === '/api/agents') {
      // Inc 1 (A3): header-scoped when asserted, else today's optional ?workspaceId.
      const workspaceId = this.resolveWorkspaceScope(identity, url.searchParams.get('workspaceId'));
      const agents = workspaceId ? getAgentsByWorkspace(workspaceId) : getAllAgents();
      // Enrich with context stats
      return agents.map(a => this.withInputInFlight({
        ...a,
        contextStats: this.supervisor.getContextStats(a.id),
      }));
    }

    // GET /api/agents/:id — get single agent
    const agentGetMatch = path.match(/^\/api\/agents\/([^/]+)$/);
    if (method === 'GET' && agentGetMatch) {
      const agent = getAgent(agentGetMatch[1]);
      if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
      return this.withInputInFlight({
        ...agent,
        contextStats: this.supervisor.getContextStats(agent.id),
      });
    }

    // GET /api/agents/:id/log — read agent log
    const logMatch = path.match(/^\/api\/agents\/([^/]+)\/log$/);
    if (method === 'GET' && logMatch) {
      const lines = parseInt(url.searchParams.get('lines') || '50', 10);
      const log = await this.supervisor.getAgentLog(logMatch[1], lines);
      return { agentId: logMatch[1], lines, log };
    }

    // GET /api/agents/:id/context-stats — get context stats
    const ctxMatch = path.match(/^\/api\/agents\/([^/]+)\/context-stats$/);
    if (method === 'GET' && ctxMatch) {
      const stats = this.supervisor.getContextStats(ctxMatch[1]);
      if (!stats) return { agentId: ctxMatch[1], stats: null };
      return { agentId: ctxMatch[1], stats };
    }

    // ── Context Window Warning settings (per-role gauge caps) ───────────
    // GET returns the current settings; POST replaces them (sanitized +
    // clamped main-side, same path the IPC setter uses). 503 until wired.
    if (path === '/api/settings/context-gauge' && (method === 'GET' || method === 'POST')) {
      if (!this.contextGaugeDeps) {
        throw Object.assign(new Error('Context-gauge settings not wired'), { statusCode: 503 });
      }
      if (method === 'GET') return this.contextGaugeDeps.loadSettings();
      const body = await readBody(req);
      return applyContextGaugeSettings(JSON.parse(body), this.contextGaugeDeps);
    }

    // GET /api/usage-limits — account-wide Claude subscription usage reading.
    // Canonical contract: always returns a UsageLimitsReading (with `available`
    // and `account_wide: true`). Consumed verbatim by the MCP get_usage_limits tool.
    if (method === 'GET' && path === '/api/usage-limits') {
      return this.supervisor.getUsageLimits();
    }

    // ══ WP7 agent-facing read-only optimizer surface (classifier addendum §5). ══
    // Lean summary lists + detail-on-demand, in the AgentDtoResponse envelope. GET-only:
    // a non-GET to any matched path 405s (read-only audit — test 29). Cursor/empty/
    // unverified states ride the envelope as ok:true|false, NOT as HTTP errors (§5.1).
    // The observability MCP tools (Module 3) call these localhost routes.
    const optProposalsList = path === '/api/context-optimizer/proposals';
    // WP-1A: the evidence-drill sub-route is MORE SPECIFIC than the detail route and
    // MUST be matched first (its `/evidence` suffix means the detail regex — anchored on
    // a single trailing segment — never matches it, but order the dispatch explicitly).
    const optProposalEvidence = path.match(/^\/api\/context-optimizer\/proposals\/([^/]+)\/evidence$/);
    // R2 WP-4B: the cluster-exemplar drill sub-route, like /evidence, is MORE SPECIFIC than
    // the detail route (its `/cluster-exemplars` suffix means the single-trailing-segment
    // detail regex never matches it) — match + dispatch it before optProposalDetail.
    const optClusterExemplars = path.match(/^\/api\/context-optimizer\/proposals\/([^/]+)\/cluster-exemplars$/);
    const optProposalDetail = path.match(/^\/api\/context-optimizer\/proposals\/([^/]+)$/);
    const optFileHeat = path === '/api/context-optimizer/file-heat';
    // R2 WP-4C — the capped section-level analyzability detail route (explains + ranks the
    // notAnalyzable blind spot by trapped cost). GET-only, same read-only envelope.
    const optAnalyzability = path === '/api/context-optimizer/analyzability';
    if (optProposalsList || optProposalEvidence || optClusterExemplars || optProposalDetail
        || optFileHeat || optAnalyzability) {
      if (method !== 'GET') {
        throw Object.assign(
          new Error('This is a read-only GET surface; agents propose edits via chat, not by writing here.'),
          { statusCode: 405, code: 'method-not-allowed' },
        );
      }
      const result = this.runOptimizerForRequest(identity, url);
      if (optProposalEvidence) {
        return buildProposalEvidence(result, decodeURIComponent(optProposalEvidence[1]));
      }
      if (optClusterExemplars) {
        return buildClusterExemplars(
          result, this.buildClusterExemplarStore(identity, url),
          decodeURIComponent(optClusterExemplars[1]),
          { cursor: url.searchParams.get('cursor') ?? undefined, limit: this.intParam(url, 'limit') });
      }
      if (optProposalDetail) {
        return buildProposalDetail(result, decodeURIComponent(optProposalDetail[1]), {
          includePatch: url.searchParams.get('includePatch') === 'true',
        });
      }
      if (optFileHeat) {
        // WP-4A — surface the guidance-gap split + role/coverage/access filters. The
        // corpus is workspace-scoped at the query layer (runOptimizerForRequest threads
        // slug/scopeMode/includeOperationalNoise into the analyze query); these params
        // shape the DTO projection (view split, filters, operational-noise widening).
        return buildFileHeatPage(result, this.buildRedactionRoots(identity, url), {
          lane: (url.searchParams.get('lane') as AgentRoleLane | null) ?? undefined,
          limit: this.intParam(url, 'limit'),
          cursor: url.searchParams.get('cursor') ?? undefined,
          view: (url.searchParams.get('view') as 'hot' | 'guidance-gaps' | null) ?? undefined,
          role: (url.searchParams.get('role') as PathRole | null) ?? undefined,
          coverage: url.searchParams.get('coverage') ?? undefined,
          accessMode: (url.searchParams.get('accessMode') as 'read' | 'write' | 'executed' | null) ?? undefined,
          includeOperationalNoise: url.searchParams.get('includeOperationalNoise') === 'true',
          allWorkspaces: url.searchParams.get('allWorkspaces') === 'true',
        });
      }
      if (optAnalyzability) {
        return buildAnalyzabilityPage(result, this.buildRedactionRoots(identity, url), {
          lane: (url.searchParams.get('lane') as AgentRoleLane | null) ?? undefined,
          limit: this.intParam(url, 'limit'),
          cursor: url.searchParams.get('cursor') ?? undefined,
        });
      }
      return buildProposalsPage(result, {
        lane: (url.searchParams.get('lane') as AgentRoleLane | null) ?? undefined,
        kind: (url.searchParams.get('kind') as ContextOptimizerProposalKind | null) ?? undefined,
        minTier: (url.searchParams.get('minTier') as BehaviorEvidenceTier | null) ?? undefined,
        limit: this.intParam(url, 'limit'),
        cursor: url.searchParams.get('cursor') ?? undefined,
        includeUnverified: url.searchParams.get('includeUnverified') === 'true',
      });
    }

    // ══ WP7 Module 2: skill-usage / agent-knowledge / improvement-proposals ══
    // Same envelope, same GET-only read-only guarantee (405 on non-GET — test 29).
    // skill-usage + agent-knowledge are backed by WP3/WP4 read layers (NOT the
    // optimizer engine); improvement-proposals is the SAME live analyze filtered to
    // the ADD/TUNE/RELOCATE levers (Task 1b, supervisor-endorsed).
    const optSkillUsageList = path === '/api/context-optimizer/skill-usage';
    const optSkillUsageDetail = path.match(/^\/api\/context-optimizer\/skill-usage\/([^/]+)$/);
    const optMcpToolUsage = path === '/api/context-optimizer/mcp-tool-usage';
    const optKnowledgeList = path === '/api/context-optimizer/agent-knowledge';
    const optKnowledgeDetail = path.match(/^\/api\/context-optimizer\/agent-knowledge\/([^/]+)$/);
    const optImproveList = path === '/api/context-optimizer/improvement-proposals';
    const optImproveDetail = path.match(/^\/api\/context-optimizer\/improvement-proposals\/([^/]+)$/);
    if (optSkillUsageList || optSkillUsageDetail || optMcpToolUsage || optKnowledgeList || optKnowledgeDetail
        || optImproveList || optImproveDetail) {
      if (method !== 'GET') {
        throw Object.assign(
          new Error('This is a read-only GET surface; agents propose edits via chat, not by writing here.'),
          { statusCode: 405, code: 'method-not-allowed' },
        );
      }
      // Per-MCP-tool usage (wave2 §2.3 / WP-C P2) — the lean four-tier attribution
      // rollup DTO (top-N byTool, capped byToolLane cross-tab, tierBreakdown +
      // coverage %, capped timeline, next-drill hint) in the AgentDtoResponse envelope.
      if (optMcpToolUsage) {
        return this.runMcpToolUsageForRequest(identity, url);
      }
      // Improvement proposals reuse the optimizer analyze + proposal builders.
      if (optImproveList || optImproveDetail) {
        const result = this.runOptimizerForRequest(identity, url);
        if (optImproveDetail) {
          return buildProposalDetail(result, decodeURIComponent(optImproveDetail[1]), {
            includePatch: url.searchParams.get('includePatch') === 'true',
          });
        }
        return buildProposalsPage(result, {
          lane: (url.searchParams.get('lane') as AgentRoleLane | null) ?? undefined,
          kind: (url.searchParams.get('kind') as ContextOptimizerProposalKind | null) ?? undefined,
          minTier: (url.searchParams.get('minTier') as BehaviorEvidenceTier | null) ?? undefined,
          limit: this.intParam(url, 'limit'),
          cursor: url.searchParams.get('cursor') ?? undefined,
          includeUnverified: url.searchParams.get('includeUnverified') === 'true',
        }, { route: IMPROVEMENT_ROUTE, levers: IMPROVEMENT_LEVERS });
      }
      // Skill usage (WP3).
      if (optSkillUsageList || optSkillUsageDetail) {
        const { usage, indexing } = this.runSkillUsageForRequest(identity, url);
        if (optSkillUsageDetail) return buildSkillUsageDetail(usage, decodeURIComponent(optSkillUsageDetail[1]));
        return buildSkillUsagePage(usage, {
          limit: this.intParam(url, 'limit'),
          cursor: url.searchParams.get('cursor') ?? undefined,
        }, { indexing });
      }
      // Agent knowledge (WP4). Scope-mismatch (403) still throws; a missing/unknown
      // agent is returned as an INVALID_ARGUMENT envelope, never a raw 500.
      const roots = this.buildRedactionRoots(identity, url);
      let graph: AgentKnowledgeGraph;
      try {
        graph = this.runAgentKnowledgeForRequest(identity, url);
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        if (e.statusCode === 403) throw e; // scope violation must not be masked
        return errResponse({
          code: 'INVALID_ARGUMENT',
          message: e.message || 'agent-knowledge extraction failed',
          retriable: false,
        });
      }
      if (optKnowledgeDetail) return buildAgentKnowledgeDetail(graph, roots, decodeURIComponent(optKnowledgeDetail[1]));
      return buildAgentKnowledgePage(graph, roots, {
        limit: this.intParam(url, 'limit'),
        cursor: url.searchParams.get('cursor') ?? undefined,
      });
    }

    // ══ Context-Overhead read surface — closes the IPC-only gap (work item §4.1). ══
    // Same GET-only, read-only envelope as the optimizer family: 405 on non-GET.
    // Reuses runOverheadScan() unchanged — the same call the panel's IPC handler makes
    // (ipc-handlers.ts:512). No write path exists here.
    if (path === '/api/context-overhead') {
      if (method !== 'GET') {
        throw Object.assign(
          new Error('This is a read-only GET surface; agents propose edits via chat, not by writing here.'),
          { statusCode: 405, code: 'method-not-allowed' },
        );
      }
      try {
        return buildOverheadSnapshot(
          this.runOverheadForRequest(identity, url),
          this.buildRedactionRoots(identity, url),
        );
      } catch (err) {
        const e = err as Error & { statusCode?: number };
        if (e.statusCode === 403) throw e;            // scope violation must not be masked
        if (e.statusCode === 400) throw e;
        return errResponse({
          code: 'INVALID_ARGUMENT',
          message: sanitizeErrorMessage(e.message),
          retriable: false,
        });
      }
    }

    // GET /api/agents/:id/messages — read structured agent chat
    const messagesMatch = path.match(/^\/api\/agents\/([^/]+)\/messages$/);
    if (method === 'GET' && messagesMatch) {
      const agentId = messagesMatch[1];
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const role = url.searchParams.get('role') as 'assistant' | 'user' | undefined;
      // BUG-28: lazy-recover Codex resumeSessionId on chat-read so a discovery
      // race-loss doesn't permanently blank the chat for callers (the dashboard
      // UI, MCP read_agent_chat, groupthink relay loop).
      this.supervisor.maybeRecoverCodexSid(agentId);
      const messages = await this.supervisor.getChatService().getMessages(agentId, { limit, role });
      return { agentId, limit, messages };
    }

    // GET /api/agents/:id/file-activities — files the agent has read/written/created.
    // Powers the Context and Outputs dashboard tabs; exposed to MCP so the
    // supervisor can answer "has this agent already touched file X?" cheaply.
    const filesMatch = path.match(/^\/api\/agents\/([^/]+)\/file-activities$/);
    if (method === 'GET' && filesMatch) {
      const agentId = filesMatch[1];
      const op = url.searchParams.get('operation');
      const operation = op === 'read' || op === 'write' || op === 'create' ? op : undefined;
      const limit = parseInt(url.searchParams.get('limit') || '200', 10);
      // Default returns ALL retained sessions ("has any prior session touched
      // X?"); current_only=true narrows to the agent's live session.
      const currentOnly = url.searchParams.get('current_only') === 'true';
      const activities = getFileActivities(agentId, operation, currentOnly).slice(0, limit);
      return { agentId, operation: operation || null, activities };
    }

    // GET /api/comments?file_path=...&include_resolved=... — markdown-editor
    // selection comments for a file. Backs the in-process `read_comments` MCP
    // tool that replaces the pure-Python .lares/scripts/read-comments.py, so a
    // machine with no real Python (clean Windows VMs ship only a 0-byte Store
    // stub) can still read comments. Global, forgiving path-based lookup — the
    // stored file path is the disambiguator, not a workspace scope (matches the
    // script's semantics).
    if (method === 'GET' && path === '/api/comments') {
      const filePath = url.searchParams.get('file_path');
      if (!filePath) {
        throw Object.assign(new Error('Missing "file_path" query parameter'), { statusCode: 400 });
      }
      const includeResolved = url.searchParams.get('include_resolved') === 'true';
      const { comments, matchedByFilename } = findSelectionCommentsByPath(filePath, includeResolved);
      const items = comments.map((c) => ({
        id: c.id,
        lineStart: c.lineStart,
        lineEnd: c.lineEnd,
        quotedText: c.quotedText,
        body: c.body,
        status: c.status,
        kind: c.kind,
        createdAt: c.createdAt,
        filePath: c.filePath,
      }));
      return { filePath, matchedByFilename, count: items.length, comments: items };
    }

    // POST /api/agents/:id/input — queue a message for delivery and return.
    // Default delivery is fire-and-forget: the Windows codex/gemini path types
    // one character at a time at WINDOWS_CODEX_TYPING_DELAY_MS to dodge the
    // paste-burst dialog, so multi-KB sends can take 30+ seconds. Holding
    // the HTTP request open that long invariably breaks callers' timeouts.
    // The supervisor serializes per-agent and surfaces `isInputInFlight` so
    // subsequent GETs see the agent as 'working' until typing finishes.
    //
    // Handoff handshake: pass `confirm: true` to instead BLOCK until the
    // worker's turn provably started (UserPromptSubmit hook / status flip to
    // 'working'), via `sendInputConfirmed`. Response carries `confirmed` +
    // `mode` ('hook' | 'status-poll' | 'unconfirmed'). A definitive submit
    // failure (confirm-and-retry exhausted) returns HTTP 502 with
    // code 'submit-not-confirmed'. Used by the MCP supervisor's
    // send_message_to_agent / launch_agent so a supervisor can't believe a
    // handoff worked when the worker never started.
    const inputMatch = path.match(/^\/api\/agents\/([^/]+)\/input$/);
    if (method === 'POST' && inputMatch) {
      const agentId = inputMatch[1];
      const body = await readBody(req);
      const { text, submit, confirm, senderAgentId, sender_agent_id } = JSON.parse(body);
      const senderId: string | undefined = senderAgentId ?? sender_agent_id;
      if (!text) throw Object.assign(new Error('Missing "text" in request body'), { statusCode: 400 });

      const agent = getAgent(agentId);
      if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });

      // Safety gate: only send to idle/waiting agents. `isInputInFlight`
      // covers the window between enqueue and the agent's first response
      // burst, where the DB still reads 'idle' but typing is in progress.
      if (this.supervisor.isInputInFlight(agentId) || ['working', 'launching'].includes(agent.status)) {
        const reportedStatus = this.supervisor.isInputInFlight(agentId) ? 'receiving' : agent.status;
        throw Object.assign(
          new Error(`Cannot send input to agent in "${reportedStatus}" state. Wait until it is idle or waiting.`),
          { statusCode: 409 }
        );
      }

      // Transient one-turn subscription: a submitted cross-agent send auto-
      // subscribes the sender to ONE turn outcome of the target. Sits AFTER the
      // 409 gate (a busy-target throw exits before this → never registers) and
      // BEFORE delivery. All eligibility (privilege, liveness, self-check, owner
      // dedup, per-target cap) is enforced inside the registry; this layer does
      // only body-derived gating (submitted + a present sender id).
      let transientSubscription: { registered: boolean; reason?: string } = { registered: false };
      const wantsSub = submit !== false && typeof senderId === 'string' && senderId.length > 0;
      if (wantsSub) {
        transientSubscription = this.supervisor.registerTransientTurnSubscription({
          targetAgentId: agentId, subscriberAgentId: senderId!,
        });
      }

      // Confirmed (handshake) path. `submit: false` is incompatible — an
      // unsubmitted prompt can't start a turn, so there is nothing to confirm.
      if (confirm === true && submit !== false) {
        try {
          const result = await this.supervisor.sendInputConfirmed(agentId, text);
          // WP8 — bytes were accepted (delivery-failed would have thrown below),
          // so an unconfirmed turn start is `delivered-unconfirmed`, NOT a
          // failure: HTTP 200, plus the mandatory terminal-check guidance so an
          // MCP/HTTP caller relays the same instruction every other surface does.
          const message = result.confirmed
            ? undefined
            : sendOutcomeMessage({
                disposition: 'delivered-unconfirmed', agentId, delivered: true,
                reason: 'confirmation-timeout', completedAt: Date.now(),
              }).text;
          return { ok: true, agentId, submit: true, ...result, message, transientSubscription };
        } catch (err) {
          // A delivery/confirm throw means no turn will start — drop the
          // just-registered subscription so it can't consume an unrelated idle.
          if (transientSubscription.registered && senderId) {
            this.supervisor.cancelTransientTurnSubscriptionsForPair(agentId, senderId);
          }
          const e = err as Error & { statusCode?: number; code?: string };
          if (e.name === 'SubmitNotConfirmedError') {
            e.statusCode = 502;
            e.code = 'submit-not-confirmed';
          } else if (e.statusCode === undefined) {
            e.statusCode = 502;
            e.code = 'delivery-failed';
          }
          throw e;
        }
      }

      // `submit` (optional, default true): pass false to leave the text in
      // the agent's prompt buffer without pressing Enter. Used by
      // launch_agent's `submit:false` flag (BUG-01).
      const opts = submit === false ? { submit: false } : undefined;

      // Don't await — typing happens in the background. Errors are logged
      // because there's no caller to return them to once we've responded.
      this.supervisor.sendInput(agentId, text, opts).catch((err) => {
        console.error(`[api] Background input delivery to ${agentId} failed:`, err);
      });
      return { ok: true, agentId, queued: true, submit: submit !== false, message: 'Input queued', transientSubscription };
    }

    // POST /api/agents/:id/keys — write keystroke bytes to the agent's PTY.
    // Bypasses the bracketed-paste wrapping that `:id/input` applies (intentional —
    // pickers and other widgets need bytes dispatched as key events, not as one
    // pasted blob). Synchronous: a single PTY write per call, no typing loop,
    // no per-agent queue. Concurrent calls race like any keyboard input — that
    // matches the dashboard xterm panel's behavior, which uses the same channel
    // (`Supervisor.writeToAgent`, see `terminal:write` IPC handler).
    //
    // Accepts either:
    //   { key: <name>, count?: number }  — named key (preferred). Resolves
    //     to the right byte sequence for the agent's provider+host. See
    //     `key-bytes.ts` for the table. BUG-02.
    //   { keys: <raw string> }           — raw bytes (advanced fallback).
    //     Sent verbatim. Use only when no named key fits.
    // Both forms can be combined: `key` bytes are sent first, then `keys`.
    const keysMatch = path.match(/^\/api\/agents\/([^/]+)\/keys$/);
    if (method === 'POST' && keysMatch) {
      const agentId = keysMatch[1];
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const rawKeys: unknown = parsed.keys;
      const keyName: unknown = parsed.key;
      const countRaw: unknown = parsed.count;

      if (keyName !== undefined && !isKeyName(keyName)) {
        throw Object.assign(
          new Error(
            `Unknown "key" value: ${JSON.stringify(keyName)}. ` +
            `Supported: ${SUPPORTED_KEY_NAMES.join(', ')}`,
          ),
          { statusCode: 400 },
        );
      }
      if (keyName === undefined && rawKeys === undefined) {
        throw Object.assign(
          new Error('Request body must include either "key" (named) or "keys" (raw bytes)'),
          { statusCode: 400 },
        );
      }
      if (rawKeys !== undefined && typeof rawKeys !== 'string') {
        throw Object.assign(new Error('"keys" must be a string when provided'), { statusCode: 400 });
      }
      let count = 1;
      if (countRaw !== undefined) {
        if (typeof countRaw !== 'number' || !Number.isInteger(countRaw) || countRaw < 1 || countRaw > 100) {
          throw Object.assign(
            new Error('"count" must be an integer in [1, 100] when provided'),
            { statusCode: 400 },
          );
        }
        count = countRaw;
      }

      const agent = getAgent(agentId);
      if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
      if (!this.supervisor.hasRunner(agentId)) {
        throw Object.assign(new Error('Agent has no live runner (likely crashed or stopped)'), { statusCode: 409 });
      }

      let toSend = '';
      let resolvedFrom: 'key' | 'keys' | 'key+keys' | null = null;
      if (keyName !== undefined) {
        const workspace = getWorkspace(agent.workspaceId);
        const pathType = workspace?.pathType ?? 'windows';
        toSend += mapKeyToBytes(keyName, agent.provider, pathType).repeat(count);
        resolvedFrom = 'key';
      }
      if (typeof rawKeys === 'string' && rawKeys.length > 0) {
        toSend += rawKeys;
        resolvedFrom = resolvedFrom === 'key' ? 'key+keys' : 'keys';
      }

      // Empty payload is a no-op rather than an error — easier to script.
      if (toSend.length === 0) {
        return { ok: true, agentId, bytes: 0, message: 'No bytes to send' };
      }

      this.supervisor.writeToAgent(agentId, toSend);
      return {
        ok: true,
        agentId,
        bytes: toSend.length,
        resolvedFrom,
        ...(keyName !== undefined ? { key: keyName, count } : {}),
      };
    }

    // POST /api/agents/:id/status — class IV worker hook receive endpoint.
    // The supervised-worker Stop hook (state='idle'), UserPromptSubmit hook
    // (state='working'), and SessionStart hook (state='active') post here.
    // The Notification hook (state='waiting') posts here too — it carries an
    // optional excerpt + notificationType and drives the waiting latch.
    // Body: { state: 'idle' | 'working' | 'active' | 'waiting', source: string, ts?: number }
    // 'idle'/'working' flip the agent's StatusMonitor latch (the EventBridge →
    // supervisor notification pipeline picks up the change); 'active' updates
    // hook health only and never changes status. See
    // plans/class-iv-worker-hook-scaffold.md and HOOK_SYSTEM_DESIGN.md §A.
    const statusMatch = path.match(/^\/api\/agents\/([^/]+)\/status$/);
    if (method === 'POST' && statusMatch) {
      const agentId = statusMatch[1];
      const agent = getAgent(agentId);
      if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });

      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const state: unknown = parsed.state;
      const source: unknown = parsed.source;

      if (state !== 'idle' && state !== 'working' && state !== 'active' && state !== 'waiting') {
        throw Object.assign(
          new Error(`Unsupported state ${JSON.stringify(state)} — only 'idle', 'working', 'active', or 'waiting' accepted`),
          { statusCode: 400 },
        );
      }
      const sourceTag = typeof source === 'string' && source.length > 0 ? source : 'hook';
      // P1 (plans/p1-hook-spool-multi-transport.md §2) — parse optional v7
      // meta and hand the event to the central applier
      // (AgentSupervisor.applyHookStatusEvent), which owns validation, dedupe,
      // freshness, ordering, stamping, and dispatch for every transport.
      // Back-compat: a body without hookEventName/ts (v≤6 script) synthesizes
      // ts = Date.now() + an argv-style event name and is flagged legacy →
      // dedupe/freshness/ordering bypassed, exactly the pre-P1 behavior.
      const hookEventName: unknown = parsed.hookEventName;
      const ts: unknown = parsed.ts;
      const legacy = !(typeof hookEventName === 'string' && hookEventName.length > 0
        && typeof ts === 'number' && Number.isFinite(ts));
      const event = {
        agentId: typeof parsed.agentId === 'string' ? parsed.agentId : undefined,
        state: state as 'idle' | 'working' | 'active' | 'waiting',
        source: sourceTag,
        ts: legacy ? Date.now() : (ts as number),
        hookEventName: legacy
          ? (state === 'working' ? 'UserPromptSubmit' : state === 'active' ? 'SessionStart' : state === 'waiting' ? 'Notification' : 'Stop')
          : (hookEventName as string),
        turnId: typeof parsed.turnId === 'string' ? parsed.turnId : undefined,
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
        waitingExcerpt: typeof parsed.excerpt === 'string' ? parsed.excerpt : undefined,
        notificationType: typeof parsed.notificationType === 'string' ? parsed.notificationType : undefined,
        legacy,
      };
      const result = this.supervisor.applyHookStatusEvent(agentId, event, 'http');
      return { ok: true, agentId, state, source: sourceTag, result };
    }

    // POST /api/agents/:id/codex-session — Layer A codex SessionStart-hook bind.
    // The codex SessionStart hook carries codex's own session_id; this endpoint
    // is the dedicated, authed surface that binds it env-direct (agentId from
    // the URL, resolved from the hook's AGENT_ID launcher env — race-free under
    // the shared-cwd invariant). Body: { sessionId: string }. The bind logic +
    // null-guard live in supervisor.bindCodexSessionFromHook, which the /status
    // multi-transport path also drives; this route maps its decision to HTTP.
    const codexBindMatch = path.match(/^\/api\/agents\/([^/]+)\/codex-session$/);
    if (method === 'POST' && codexBindMatch) {
      const agentId = codexBindMatch[1];
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const sessionId: unknown = parsed.sessionId;
      const decision = this.supervisor.bindCodexSessionFromHook(
        agentId,
        typeof sessionId === 'string' ? sessionId : undefined,
      );
      if (decision.action === 'bind') {
        return { ok: true, agentId, bound: true, sessionId: decision.sessionId };
      }
      // Ignore reasons → HTTP: unknown agent 404; wrong provider / sibling-owned
      // sid 409 (conflict); empty sid 400. 'already-bound' is an idempotent
      // no-op — 200 with bound:false so a retrying hook never sees an error.
      if (decision.reason === 'already-bound') {
        return { ok: true, agentId, bound: false, reason: decision.reason };
      }
      const statusCode =
        decision.reason === 'unknown-agent' ? 404 :
        decision.reason === 'empty-session-id' ? 400 :
        409; // non-codex | session-owned-by-sibling
      throw Object.assign(
        new Error(`codex-session bind ignored: ${decision.reason}`),
        { statusCode },
      );
    }

    // POST /api/agents — launch a new agent
    if (method === 'POST' && path === '/api/agents') {
      const body = await readBody(req);
      const input = JSON.parse(body);
      // Researcher role-lane (browser-parity-and-capability-isolation §0):
      // accept the snake_case `is_researcher` form (used by the launch_agent MCP
      // tool / raw HTTP callers) and normalize it to the camelCase
      // `isResearcher` LaunchAgentInput field the supervisor reads.
      if (input && input.is_researcher !== undefined && input.isResearcher === undefined) {
        input.isResearcher = input.is_researcher;
      }
      // Agent-ownership primitive (§4.2): normalize the snake_case owner edge for the
      // script-on-behalf path (the launch_agent MCP handler forwards its trusted
      // AGENT_DASHBOARD_SELF_ID as owner_agent_id). launchAgent re-validates it (§4.1)
      // before persisting, so an untrusted/foreign id is dropped, never trusted blindly.
      if (input && input.owner_agent_id !== undefined && input.ownerAgentId === undefined) {
        input.ownerAgentId = input.owner_agent_id;
      }
      // notifyOwner mute: normalize the snake_case form, mirroring owner_agent_id
      // above. undefined/true = notify (default); false = mute owner-directed events.
      if (input && input.notify_owner !== undefined && input.notifyOwner === undefined) {
        input.notifyOwner = input.notify_owner;
      }
      // Planning surface WP1: normalize the snake_case launch-rail plan binding
      // (plan_id/plan_section) used by the launch_agent MCP tool / raw HTTP callers
      // to the camelCase LaunchAgentInput fields the supervisor reads.
      if (input && input.plan_id !== undefined && input.planId === undefined) {
        input.planId = input.plan_id;
      }
      if (input && input.plan_section !== undefined && input.planSection === undefined) {
        input.planSection = input.plan_section;
      }
      // Validate the plan binding before launch: an unknown plan_id is a 400 (a
      // plans row must exist so agents.plan_id's FK resolves and the frozen stamp
      // is meaningful). Empty/omitted planId is fine — the rail is optional.
      if (input && input.planId !== undefined && input.planId !== null && input.planId !== '') {
        if (typeof input.planId !== 'string' || getPlan(input.planId) === null) {
          throw Object.assign(
            new Error(`Unknown plan_id '${input.planId}' — a plan surface must exist before launching an agent bound to it`),
            { statusCode: 400 },
          );
        }
        // GT-C §O.2 — one-writer-per-plan guard on the named `launch_agent` (MCP)
        // dispatch path (I-10). 409s on an active run, an actively-working plan-bound
        // agent, or an in-flight trail materialization. Idle plan-bound agents do NOT
        // reserve the plan (amended ownership model, §4.4), so keeping a seed worker
        // idle across phases stays legal.
        assertPlanRailFree(input.planId);
      }
      // Inc 1 (B4 server side): self-scope launches. Asserted caller + no
      // workspaceId → fill from header; matching → ok; mismatch → 403. No header
      // + no workspaceId → unchanged (launchAgent enforces as before).
      const scopedWorkspaceId = this.resolveWorkspaceScope(identity, (input?.workspaceId as string) ?? null);
      if (scopedWorkspaceId) input.workspaceId = scopedWorkspaceId;
      const agent = await this.supervisor.launchAgent(input);
      // Planning-surface P1: a plan-bound dispatch auto-subscribes the dispatching
      // supervisor to that plan (best-effort; no-op for non-supervisor callers).
      if (input && input.planId) this.autoFocusPlan(identity, input.planId as string);
      return agent;
    }

    // DELETE /api/agents/:id — stop an agent
    const stopMatch = path.match(/^\/api\/agents\/([^/]+)$/);
    if (method === 'DELETE' && stopMatch) {
      await this.supervisor.stopAgent(stopMatch[1]);
      return { ok: true, agentId: stopMatch[1], message: 'Agent stopped' };
    }

    // POST /api/agents/:id/fork — fork an agent
    const forkMatch = path.match(/^\/api\/agents\/([^/]+)\/fork$/);
    if (method === 'POST' && forkMatch) {
      const newAgent = await this.supervisor.forkAgent(forkMatch[1]);
      return newAgent;
    }

    // ── Orchestration routes ─────────────────────────────────────────────
    // Dashboard-owned orchestration runs (groupthink). The MCP supervisor
    // proxies run_orchestration / get_orchestration_run / abort_orchestration
    // here. `/catalog` is matched BEFORE the `:runId` regex so the literal
    // "catalog" isn't captured as a runId. (The `list_orchestrations` MCP tool
    // was deleted in the context-overhead pass — the catalog route stays, it is
    // just no longer exposed as a resident tool schema.)

    // GET /api/orchestrations/catalog — descriptors for the catalog
    if (method === 'GET' && path === '/api/orchestrations/catalog') {
      return { orchestrations: this.orchestration!.listCatalog() };
    }

    // GET /api/orchestrations[?status=…] — list runs
    if (method === 'GET' && path === '/api/orchestrations') {
      const status = url.searchParams.get('status');
      return { runs: this.orchestration!.listRuns().filter(r => !status || r.status === status) };
    }

    // POST /api/orchestrations — start a run (detached; returns {runId})
    if (method === 'POST' && path === '/api/orchestrations') {
      const { name, params } = JSON.parse(await readBody(req));
      if (!name || !params?.workspaceId || !params?.supervisorId) {
        throw Object.assign(
          new Error('name, params.workspaceId, params.supervisorId required'),
          { statusCode: 400 },
        );
      }
      const run = this.orchestration!.start_run({ name, ...params });
      // Planning-surface P1: a plan-bound orchestration run auto-subscribes the
      // dispatching supervisor to that plan (best-effort; no-op for non-supervisors).
      if (params.planId) this.autoFocusPlan(identity, params.planId as string);
      return run;
    }

    const orchOne = path.match(/^\/api\/orchestrations\/([^/]+)$/);
    // GET /api/orchestrations/:runId — run status/progress
    if (method === 'GET' && orchOne) {
      const run = this.orchestration!.getRun(orchOne[1]);
      if (!run) throw Object.assign(new Error('Run not found'), { statusCode: 404 });
      return run;
    }
    // DELETE /api/orchestrations/:runId — abort + clean up members
    if (method === 'DELETE' && orchOne) return this.orchestration!.abort(orchOne[1]);

    // GET /api/supervisor/context — Inc 1 (A4): the self-orientation summary a
    // supervisor pulls (get_my_context) on revival. Workspace comes from the
    // asserted X-Workspace-Id header or an explicit ?workspaceId=. No scope at all
    // → 400; unknown workspace → 404.
    //
    // Inc 2 (2.3, ≡ P1-10a): when the caller asserts X-Supervisor-Id,
    // `supervisor` is the header-validated caller itself (resolveIdentity
    // overrode the LIMIT-1 fallback) and `supervisorId` echoes its id. Without
    // the header, `supervisor` stays the best-effort getSupervisorAgent
    // (ORDER BY created_at DESC LIMIT 1) read — which may misattribute in a
    // multi-supervisor workspace — and `supervisorId` is null.
    if (method === 'GET' && path === '/api/supervisor/context') {
      const workspaceId = this.resolveWorkspaceScope(identity, url.searchParams.get('workspaceId'));
      if (!workspaceId) {
        throw Object.assign(
          new Error('workspaceId required (send X-Workspace-Id header or ?workspaceId=)'),
          { statusCode: 400 },
        );
      }
      const workspace = getWorkspace(workspaceId);
      if (!workspace) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 });
      // identity.supervisor is set whenever the workspace was asserted (validated
      // caller, or LIMIT-1 fallback); the explicit-?workspaceId= path (no header)
      // keeps the LIMIT-1 read.
      const supervisor = identity.supervisor ?? getSupervisorAgent(workspaceId);
      const agents = getAgentsByWorkspace(workspaceId);
      // Inc 3 (3.3): owned-agent COUNTS only — the full list stays
      // list_my_agents's job (GET /api/supervisor/owned-agents). Attribution
      // follows the same `supervisor` as the rest of this response (asserted
      // caller when X-Supervisor-Id was sent, else the LIMIT-1 best-effort).
      const ownedRows = supervisor ? getAgentsByOwner(supervisor.id, { includeTerminal: true }) : [];
      const counts = {
        total: agents.length,
        // "live" = not in a terminal status. Mirrors getWorkspaceAgentSummary's
        // active filter (done/crashed are the terminal states).
        live: agents.filter(a => a.status !== 'done' && a.status !== 'crashed').length,
        supervised: agents.filter(a => a.isSupervised).length,
        owned: {
          live: ownedRows.filter(a => a.status !== 'done' && a.status !== 'crashed').length,
          terminal: ownedRows.filter(a => a.status === 'done' || a.status === 'crashed').length,
        },
      };
      // Planning-surface P1: the plans this asserted supervisor is subscribed to
      // (supervisor_focus → plans), most-recently-attended first, deleted plans
      // excluded, capped at 10. This is the /clear-heal — a revived supervisor
      // re-learns the surfaces it minted/dispatched. Header-less callers get NO
      // `plans` key at all (consistent with supervisorId: null); only an asserted
      // caller can be attributed a subscription.
      const plans = identity.supervisorId ? getSupervisorFocusedPlans(identity.supervisorId, 10) : undefined;
      return {
        workspaceId,
        workspaceTitle: workspace.title,
        // Inc 2 (2.3): the asserted caller's own id when X-Supervisor-Id was
        // present (validated in resolveIdentity); null for header-less callers.
        supervisorId: identity.supervisorId,
        supervisor: supervisor
          ? { id: supervisor.id, title: supervisor.title, provider: supervisor.provider, status: supervisor.status }
          : null,
        counts,
        ...(plans ? { plans } : {}),
      };
    }

    // GET /api/supervisor/owned-agents — Inc 3 (3.2): the calling supervisor's
    // own launched agents (owner edge), newest first. Live set by default;
    // ?includeTerminal=true adds done/crashed rows (the graveyard window).
    // The owner comes EXCLUSIVELY from the validated X-Supervisor-Id
    // (resolveIdentity): an explicit agent-id/owner param is rejected with 400
    // so a caller can never name another supervisor's fleet, and a missing
    // assertion is 400 — the LIMIT-1 fallback never substitutes here (it may
    // misattribute in a multi-supervisor workspace). Pull-only surface: this
    // data is never snapshotted into a brick/prompt artifact.
    if (method === 'GET' && path === '/api/supervisor/owned-agents') {
      const ownerParams = ['agentId', 'agent_id', 'ownerAgentId', 'owner_agent_id', 'owner', 'supervisorId', 'supervisor_id']
        .filter(p => url.searchParams.has(p));
      if (ownerParams.length > 0) {
        throw Object.assign(
          new Error(`owner is derived from X-Supervisor-Id; remove query param(s): ${ownerParams.join(', ')}`),
          { statusCode: 400 },
        );
      }
      if (!identity.supervisorId || !identity.supervisor) {
        throw Object.assign(
          new Error('supervisor identity required (send X-Supervisor-Id header)'),
          { statusCode: 400 },
        );
      }
      const includeTerminal = url.searchParams.get('includeTerminal') === 'true';
      let owned = getAgentsByOwner(identity.supervisor.id, { includeTerminal });
      const limit = parseInt(url.searchParams.get('limit') || '0', 10);
      if (limit > 0) owned = owned.slice(0, limit);
      return {
        ownerId: identity.supervisor.id,
        includeTerminal,
        agents: owned.map(a => this.withInputInFlight({
          ...a,
          contextStats: this.supervisor.getContextStats(a.id),
        })),
      };
    }

    // ── Context-brick Inc 4 (4.4) — continuation attempt / brick / relaunch ──

    // POST /api/agents/:id/continuation-attempt — mint a handoff attempt.
    // Server allocates successorGen (= agent gen + 1); the attempt OWNS it.
    // One open attempt per agent (409 on a second).
    const contAttemptMatch = path.match(/^\/api\/agents\/([^/]+)\/continuation-attempt$/);
    if (method === 'POST' && contAttemptMatch) {
      const agentId = contAttemptMatch[1];
      const agent = getAgent(agentId);
      if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
      const body = await readBody(req);
      const input = body ? JSON.parse(body) : {};
      const open = getOpenContinuationAttempt(agentId);
      if (open) {
        throw Object.assign(
          new Error(`agent already has an open continuation attempt (${open.id})`),
          { statusCode: 409, code: 'continuation-open-attempt-exists' },
        );
      }
      const attempt = createContinuationHandoffAttempt(agentId, {
        reason: typeof input.reason === 'string' ? input.reason : undefined,
        thresholdContextPct: typeof input.thresholdContextPct === 'number' ? input.thresholdContextPct : undefined,
      });
      return { attemptId: attempt.id, successorGen: attempt.generation };
    }

    // POST /api/supervisor/continuation-brick { note } — author is derived
    // EXCLUSIVELY from the validated X-Supervisor-Id (resolveIdentity already
    // rejected an out-of-workspace / non-supervisor assertion with 403). Any
    // body-supplied agent id is rejected so a caller can never write another
    // agent's brick. Reject-never-truncate on the byte cap.
    if (method === 'POST' && path === '/api/supervisor/continuation-brick') {
      const body = await readBody(req);
      const input = body ? JSON.parse(body) : {};
      const bodyAgentKeys = ['agent_id', 'agentId', 'dashboard_agent_id', 'dashboardAgentId']
        .filter(k => k in input);
      if (bodyAgentKeys.length > 0) {
        throw Object.assign(
          new Error(`author is derived from X-Supervisor-Id; remove body field(s): ${bodyAgentKeys.join(', ')}`),
          { statusCode: 400 },
        );
      }
      if (!identity.supervisorId || !identity.supervisor) {
        throw Object.assign(
          new Error('supervisor identity required (send X-Supervisor-Id header)'),
          { statusCode: 400 },
        );
      }
      const note = input.note;
      if (typeof note !== 'string' || note.trim().length === 0) {
        throw Object.assign(new Error('note (non-empty string) required'), { statusCode: 400 });
      }
      const attempt = getOpenContinuationAttempt(identity.supervisor.id);
      if (!attempt) {
        throw Object.assign(
          new Error('no open continuation attempt for this supervisor — the watcher opens one before requesting the note'),
          { statusCode: 409, code: 'continuation-no-open-attempt' },
        );
      }
      const bytes = Buffer.byteLength(note, 'utf8');
      if (bytes > CONTINUATION_BRICK_MAX_BYTES) {
        throw Object.assign(
          new Error(`note is ${bytes} bytes; max is ${CONTINUATION_BRICK_MAX_BYTES}. Trim prose to pointers (file paths, plan ids, owned-agent ids) and resend — the note is never silently truncated.`),
          { statusCode: 413, code: 'continuation-note-too-large' },
        );
      }
      const id = insertContinuationBrick({
        agentId: identity.supervisor.id,
        handoffAttemptId: attempt.id,
        generation: attempt.generation,
        note,
        noteSource: 'tool',
      });
      closeContinuationHandoffAttempt(attempt.id, 'committed');
      return { id };
    }

    // GET /api/supervisor/continuation-brick?agentId=&attemptId=&source=tool
    // — the watcher's commit-observation read (poll the DB row, not the tool
    // response).
    if (method === 'GET' && path === '/api/supervisor/continuation-brick') {
      const agentId = url.searchParams.get('agentId');
      const attemptId = url.searchParams.get('attemptId');
      if (!agentId || !attemptId) {
        throw Object.assign(new Error('agentId and attemptId query params required'), { statusCode: 400 });
      }
      const source = url.searchParams.get('source');
      if (source && source !== 'tool' && source !== 'scrape') {
        throw Object.assign(new Error("source must be 'tool' or 'scrape'"), { statusCode: 400 });
      }
      const brick = getLatestBrickForAttempt(agentId, attemptId, source ? { source: source as 'tool' | 'scrape' } : undefined);
      return { agentId, attemptId, brick };
    }

    // POST /api/agents/:id/continuation-relaunch — the ONLY kill path. Every
    // gate re-checks server-side against fresh reads (the watcher's local view
    // is advisory); any fail → 409/425 with NO kill. Kill authorization is
    // exactly one thing: a note_source='tool' brick for the CURRENT committed
    // attempt written after the attempt opened.
    const contRelaunchMatch = path.match(/^\/api\/agents\/([^/]+)\/continuation-relaunch$/);
    if (method === 'POST' && contRelaunchMatch) {
      const agentId = contRelaunchMatch[1];
      const agent = getAgent(agentId);
      if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
      const body = await readBody(req);
      const input = body ? JSON.parse(body) : {};

      // Phase 5B (Option B) — note-less empty-memo escape. Explicit caller
      // opt-in; valid ONLY when the attempt is still OPEN (no note ever
      // committed), no tool brick exists, and the durable EFFORT BUDGET is
      // exhausted (enough aborted attempts OR the cycle alive past the cap).
      // NO context-percentage anywhere: 100% context is a cost metric, not a
      // cliff. This second authorization path is gated server-side like the
      // first so an idle supervisor that never authors a note is eventually
      // freed rather than left alive+expensive forever.
      const emptyMemoEscape = input.emptyMemoEscape === true;
      const expectedGen = (agent.continuationGeneration ?? 0) + 1;
      let attempt: ReturnType<typeof getContinuationAttempt>;
      let brickRow: ReturnType<typeof getLatestBrickForAttempt> = null;
      if (!emptyMemoEscape) {
        // Gate 1 — a committed attempt at the current successor generation.
        attempt = typeof input.attemptId === 'string'
          ? getContinuationAttempt(input.attemptId)
          : getLatestContinuationAttempt(agentId, 'committed');
        if (!attempt || attempt.dashboardAgentId !== agentId
            || attempt.status !== 'committed' || attempt.generation !== expectedGen) {
          throw Object.assign(
            new Error('no committed continuation attempt at the current generation for this agent'),
            { statusCode: 409, code: 'continuation-attempt-not-committed' },
          );
        }

        // Gate 2 — kill authorization: a tool-sourced brick for THIS attempt,
        // written after the attempt opened. A scrape never authorizes.
        brickRow = getLatestBrickForAttempt(agentId, attempt.id, { source: 'tool' });
        if (!brickRow || !(brickRow.writtenAt > attempt.startedAt)) {
          throw Object.assign(
            new Error('no tool-authored brick committed for this attempt — relaunch is not authorized'),
            { statusCode: 425, code: 'continuation-no-tool-brick' },
          );
        }
      } else {
        // Gate 1e — an OPEN attempt at the current successor generation.
        attempt = typeof input.attemptId === 'string'
          ? getContinuationAttempt(input.attemptId)
          : getOpenContinuationAttempt(agentId);
        if (!attempt || attempt.dashboardAgentId !== agentId
            || attempt.status !== 'open' || attempt.generation !== expectedGen) {
          throw Object.assign(
            new Error('empty-memo escape requires an open continuation attempt at the current generation'),
            { statusCode: 409, code: 'continuation-attempt-not-open' },
          );
        }
        // Gate 2e-a — the escape is for the NO-note case only; with a tool
        // brick present the normal (authorized) path must be used instead.
        const toolBrick = getLatestBrickForAttempt(agentId, attempt.id, { source: 'tool' });
        if (toolBrick && toolBrick.writtenAt > attempt.startedAt) {
          throw Object.assign(
            new Error('a tool-authored brick exists for this attempt — use the normal relaunch path'),
            { statusCode: 409, code: 'continuation-escape-has-brick' },
          );
        }
        // Gate 2e-b — the durable effort budget must be exhausted (Phase 5B).
        // Scoped to this successor generation's attempts since the last relaunch:
        // escape iff abortedCount ≥ MAX OR the cycle has been alive past the cap.
        // No context-percentage. Timestamps are UTC 'YYYY-MM-DD HH:MM:SS.fff';
        // convert to epoch ms as UTC for the alive-time clock.
        const budget = getContinuationEscapeBudget(agentId, expectedGen);
        const firstMs = budget.firstAttemptStartedAt !== null
          ? Date.parse(budget.firstAttemptStartedAt.replace(' ', 'T') + 'Z')
          : null;
        const aliveExhausted = firstMs !== null && (Date.now() - firstMs) >= CONTINUATION_ESCAPE_MAX_ALIVE_MS;
        const budgetExhausted = budget.abortedCount >= CONTINUATION_ESCAPE_MAX_ATTEMPTS || aliveExhausted;
        if (!budgetExhausted) {
          throw Object.assign(
            new Error(`empty-memo escape requires the effort budget exhausted (aborts ${budget.abortedCount}/${CONTINUATION_ESCAPE_MAX_ATTEMPTS}, alive ${firstMs !== null ? Math.round((Date.now() - firstMs) / 1000) : 0}s/${Math.round(CONTINUATION_ESCAPE_MAX_ALIVE_MS / 1000)}s) — abort-don't-kill until then`),
            { statusCode: 425, code: 'continuation-budget-not-exhausted' },
          );
        }
      }

      // Gate 2s (BUG-39 WP1) — self busy: re-check the TARGET agent's OWN raw DB
      // status against a fresh read. The watcher's post-note grace loop is
      // advisory (like every other gate); a mid-turn author must never be
      // relaunched out from under its closing message / transcript tail /
      // in-flight session-subagent. 'waiting' is deliberately ABSENT — the
      // awaiting-human gate (Gate 5) owns that case, and a waiting author must
      // not double-block the committedReady retry path.
      const selfBusyBlocklist = new Set(['working', 'launching', 'restarting']);
      const selfStatus = getAgent(agentId)?.status;
      if (selfStatus && selfBusyBlocklist.has(selfStatus)) {
        throw Object.assign(
          new Error(`target agent's own turn is not complete (status ${selfStatus})`),
          { statusCode: 409, code: 'continuation-self-busy' },
        );
      }

      // Owned-busy no longer blocks (Edward 2026-07-05): a continuation
      // transfer is ALLOWED while owned agents work — their dashboard events
      // queue by agent id and land in the successor session. Only the explicit
      // in-flight guard below (Gate 4) still consults the owned set.
      const owned = getAgentsByOwner(agentId, { includeTerminal: false });

      // Gate 4 — explicit in-flight guard, separately from the status set:
      // catches a mid-delivery PTY for every owned agent AND :id itself (a
      // supervisor mid-'receiving' must not be relaunched out from under an
      // in-flight delivery).
      const inFlight = [...owned.map(a => a.id), agentId]
        .filter(id => this.supervisor.isInputInFlight(id));
      if (inFlight.length > 0) {
        throw Object.assign(
          new Error(`input delivery in flight for: ${inFlight.join(', ')}`),
          { statusCode: 425, code: 'continuation-input-in-flight' },
        );
      }

      // Gate 5 — awaiting-human (injectable predicate; conservative stub
      // defaults to false until Inc 5 wires the endsWithQuestion cache).
      if (this.isAwaitingHuman(agentId)) {
        throw Object.assign(
          new Error('agent is awaiting a human answer — keep-alive'),
          { statusCode: 409, code: 'continuation-awaiting-human' },
        );
      }

      // Gate 6 — no live orchestration owned by :id ('starting'|'running';
      // stalled/aborted are ended-but-resumable and do not block).
      if (hasRunningOrchestrationForSupervisor(agentId)) {
        throw Object.assign(
          new Error('an orchestration owned by this supervisor is starting/running'),
          { statusCode: 409, code: 'continuation-orchestration-running' },
        );
      }

      // Escape mode ships a synthetic "none" Block C plus a Block A advisory
      // (rides `reason`) telling the successor to self-orient from tools.
      const brick = brickRow
        ? {
            handoffAttemptId: attempt.id,
            noteId: brickRow.id,
            reason: attempt.reason ?? undefined,
            note: brickRow.note,
            workspaceId: agent.workspaceId,
          }
        : {
            handoffAttemptId: attempt.id,
            noteId: 'none',
            reason: `${attempt.reason ?? 'effort budget exhausted'} — no note captured; self-orient fully via get_my_context/list_my_agents`,
            note: 'none',
            workspaceId: agent.workspaceId,
          };
      await this.supervisor.continuationRelaunch(agentId, brick);
      return { agentId, attemptId: attempt.id, generation: attempt.generation, noteId: brick.noteId };
    }

    // ── Team routes ──────────────────────────────────────────────────────

    // POST /api/teams — create team
    if (method === 'POST' && path === '/api/teams') {
      const body = await readBody(req);
      const input = JSON.parse(body);
      // Inc 1 (B4 server side): asserted caller may omit workspaceId (filled from
      // header); an explicit mismatch → 403.
      const scopedTeamWs = this.resolveWorkspaceScope(identity, input.workspaceId ?? null);
      if (scopedTeamWs) input.workspaceId = scopedTeamWs;
      if (!input.workspaceId || !input.name || !input.members?.length) {
        throw Object.assign(new Error('Missing workspaceId, name, or members'), { statusCode: 400 });
      }
      const team = createTeam(input);
      this.supervisor.emit('teamUpdated', team);
      return team;
    }

    // GET /api/teams?workspaceId=... — list teams
    if (method === 'GET' && path === '/api/teams') {
      // Inc 1 (A3): asserted + no ?workspaceId is a DELIBERATE relaxation from the
      // old 400 to header-scoped (RECORDED AS INTENDED — do not restore the 400).
      const workspaceId = this.resolveWorkspaceScope(identity, url.searchParams.get('workspaceId'));
      if (!workspaceId) throw Object.assign(new Error('Missing workspaceId'), { statusCode: 400 });
      return listTeams(workspaceId);
    }

    // GET /api/teams/:id — get team with members, channels, messages, tasks
    const teamGetMatch = path.match(/^\/api\/teams\/([^/]+)$/);
    if (method === 'GET' && teamGetMatch) {
      const team = getTeam(teamGetMatch[1]);
      if (!team) throw Object.assign(new Error('Team not found'), { statusCode: 404 });
      const messages = getTeamMessages(team.id, undefined, 20);
      const tasks = getTeamTasks(team.id);
      return { ...team, recentMessages: messages, tasks };
    }

    // DELETE /api/teams/:id — disband team
    const teamDisbandMatch = path.match(/^\/api\/teams\/([^/]+)$/);
    if (method === 'DELETE' && teamDisbandMatch) {
      const team = getTeam(teamDisbandMatch[1]);
      if (!team) throw Object.assign(new Error('Team not found'), { statusCode: 404 });
      // Save manifest before disbanding
      const members = getTeamMembers(team.id);
      const channels = listChannels(team.id);
      const tasks = getTeamTasks(team.id);
      const recentMessages = getTeamMessages(team.id, undefined, 20);
      const manifest = JSON.stringify({
        version: 1,
        members: members.map(m => {
          const agent = getAgent(m.agentId);
          return {
            agentId: m.agentId,
            title: agent?.title || m.title || '',
            provider: agent?.provider || m.provider || 'claude',
            roleDescription: agent?.roleDescription || '',
            workingDirectory: agent?.workingDirectory || '',
            command: agent?.command || '',
            resumeSessionId: agent?.resumeSessionId || null,
            role: m.role,
          };
        }),
        channels: channels.map(c => ({ fromAgent: c.fromAgent, toAgent: c.toAgent, label: c.label })),
        tasks: tasks.map(t => ({ title: t.title, description: t.description, status: t.status, assignedTo: t.assignedTo })),
        recentMessages,
      });
      saveTeamManifest(team.id, manifest);
      updateTeamStatus(team.id, 'disbanded');
      const updated = getTeam(team.id);
      this.supervisor.emit('teamUpdated', updated);
      return { ok: true, teamId: team.id, message: 'Team disbanded' };
    }

    // POST /api/teams/:id/members — add member
    const memberAddMatch = path.match(/^\/api\/teams\/([^/]+)\/members$/);
    if (method === 'POST' && memberAddMatch) {
      const body = await readBody(req);
      const { agentId, role } = JSON.parse(body);
      if (!agentId) throw Object.assign(new Error('Missing agentId'), { statusCode: 400 });
      addTeamMember(memberAddMatch[1], agentId, role || 'member');
      const team = getTeam(memberAddMatch[1]);
      this.supervisor.emit('teamUpdated', team);
      return { ok: true, teamId: memberAddMatch[1], agentId };
    }

    // DELETE /api/teams/:id/members/:agentId — remove member
    const memberRemoveMatch = path.match(/^\/api\/teams\/([^/]+)\/members\/([^/]+)$/);
    if (method === 'DELETE' && memberRemoveMatch) {
      removeTeamMember(memberRemoveMatch[1], memberRemoveMatch[2]);
      const team = getTeam(memberRemoveMatch[1]);
      this.supervisor.emit('teamUpdated', team);
      return { ok: true, teamId: memberRemoveMatch[1], agentId: memberRemoveMatch[2] };
    }

    // POST /api/teams/:id/channels — add channel
    const channelAddMatch = path.match(/^\/api\/teams\/([^/]+)\/channels$/);
    if (method === 'POST' && channelAddMatch) {
      const body = await readBody(req);
      const { fromAgent, toAgent, label } = JSON.parse(body);
      if (!fromAgent || !toAgent) throw Object.assign(new Error('Missing fromAgent or toAgent'), { statusCode: 400 });
      const channel = createChannel(channelAddMatch[1], fromAgent, toAgent, label);
      const team = getTeam(channelAddMatch[1]);
      this.supervisor.emit('teamUpdated', team);
      return channel;
    }

    // DELETE /api/teams/:id/channels/:channelId — remove channel
    const channelRemoveMatch = path.match(/^\/api\/teams\/([^/]+)\/channels\/([^/]+)$/);
    if (method === 'DELETE' && channelRemoveMatch) {
      removeChannel(channelRemoveMatch[2]);
      const team = getTeam(channelRemoveMatch[1]);
      this.supervisor.emit('teamUpdated', team);
      return { ok: true, teamId: channelRemoveMatch[1], channelId: channelRemoveMatch[2] };
    }

    // POST /api/teams/:id/messages — send message (with channel enforcement + loop detection)
    const msgSendMatch = path.match(/^\/api\/teams\/([^/]+)\/messages$/);
    if (method === 'POST' && msgSendMatch) {
      const teamId = msgSendMatch[1];
      const body = await readBody(req);
      const { fromAgent, toAgent, subject, status, summary, detail, need } = JSON.parse(body);
      if (!fromAgent || !toAgent || !subject || !summary) {
        throw Object.assign(new Error('Missing required fields: fromAgent, toAgent, subject, summary'), { statusCode: 400 });
      }

      // Channel enforcement
      const channel = getChannel(teamId, fromAgent, toAgent);
      if (!channel) {
        throw Object.assign(
          new Error(`No channel from ${fromAgent} to ${toAgent} in this team. Communication not authorized.`),
          { statusCode: 403 }
        );
      }

      // Loop detection tier 1: global cap
      const recentCount = getRecentMessageCount(teamId, 5);
      if (recentCount >= TEAM_MAX_MESSAGES_PER_5MIN) {
        throw Object.assign(
          new Error(`Team message rate limit exceeded (${TEAM_MAX_MESSAGES_PER_5MIN} messages per 5 minutes). Wait before sending more.`),
          { statusCode: 429 }
        );
      }

      // Loop detection tier 2: low-content filter
      const summaryHash = crypto.createHash('md5').update(summary.substring(0, 200)).digest('hex');
      const pairRecent = getRecentPairMessages(teamId, fromAgent, toAgent, 3);
      const duplicateCount = pairRecent.filter(m =>
        m.fromAgent === fromAgent &&
        crypto.createHash('md5').update(m.summary.substring(0, 200)).digest('hex') === summaryHash
      ).length;
      if (duplicateCount >= 3) {
        throw Object.assign(
          new Error('Low-content repetition detected. Your last 3 messages to this agent had the same content.'),
          { statusCode: 429 }
        );
      }

      // Loop detection tier 3: pair alternation
      const pairHistory = getRecentPairMessages(teamId, fromAgent, toAgent, 12);
      let alternations = 0;
      for (let i = 0; i < pairHistory.length - 1; i++) {
        if (pairHistory[i].fromAgent !== pairHistory[i + 1].fromAgent) {
          alternations++;
        }
      }
      if (alternations >= TEAM_MAX_ALTERNATIONS) {
        throw Object.assign(
          new Error(`Communication loop detected between you and the recipient (${alternations} alternations). Pause and work independently, or escalate to supervisor.`),
          { statusCode: 429 }
        );
      }

      const message = createTeamMessage({
        teamId, fromAgent, toAgent, subject,
        status: (status || 'update') as TeamMessageStatus,
        summary, detail, need,
      });
      this.supervisor.emit('teamMessageCreated', message);
      return message;
    }

    // GET /api/teams/:id/messages — get messages
    const msgGetMatch = path.match(/^\/api\/teams\/([^/]+)\/messages$/);
    if (method === 'GET' && msgGetMatch) {
      const agentId = url.searchParams.get('agentId') || undefined;
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      return getTeamMessages(msgGetMatch[1], agentId, limit);
    }

    // POST /api/teams/:id/tasks — create task
    const taskCreateMatch = path.match(/^\/api\/teams\/([^/]+)\/tasks$/);
    if (method === 'POST' && taskCreateMatch) {
      const body = await readBody(req);
      const { title, description, assignedTo, blockedBy, createdBy } = JSON.parse(body);
      if (!title || !createdBy) throw Object.assign(new Error('Missing title or createdBy'), { statusCode: 400 });
      const task = createTeamTask({
        teamId: taskCreateMatch[1], title, description, assignedTo, blockedBy, createdBy,
      });
      return task;
    }

    // GET /api/teams/:id/tasks — list tasks
    const taskListMatch = path.match(/^\/api\/teams\/([^/]+)\/tasks$/);
    if (method === 'GET' && taskListMatch) {
      return getTeamTasks(taskListMatch[1]);
    }

    // PATCH /api/teams/:id/tasks/:taskId — update task
    const taskUpdateMatch = path.match(/^\/api\/teams\/([^/]+)\/tasks\/([^/]+)$/);
    if (method === 'PATCH' && taskUpdateMatch) {
      const body = await readBody(req);
      const updates = JSON.parse(body);
      const task = updateTeamTask(taskUpdateMatch[2], updates);
      if (!task) throw Object.assign(new Error('Task not found'), { statusCode: 404 });
      return task;
    }

    // POST /api/teams/:id/resurrect — resurrect disbanded team from manifest
    const resurrectMatch = path.match(/^\/api\/teams\/([^/]+)\/resurrect$/);
    if (method === 'POST' && resurrectMatch) {
      const teamId = resurrectMatch[1];
      const team = getTeam(teamId);
      if (!team) throw Object.assign(new Error('Team not found'), { statusCode: 404 });
      if (team.status !== 'disbanded') {
        throw Object.assign(new Error('Can only resurrect disbanded teams'), { statusCode: 400 });
      }

      const manifestJson = getTeamManifest(teamId);
      if (!manifestJson) {
        // No manifest — just reactivate without relaunching
        updateTeamStatus(teamId, 'active');
        const updated = getTeam(teamId);
        this.supervisor.emit('teamUpdated', updated);
        return updated;
      }

      const manifest = JSON.parse(manifestJson);
      const idMap = new Map<string, string>(); // old agent ID → new agent ID

      // Relaunch each member agent
      for (const member of manifest.members) {
        try {
          const isClaude = member.provider === 'claude';

          // Build rehydration context for non-Claude agents
          let rehydrationPrompt: string | undefined;
          if (!isClaude) {
            const taskSummary = (manifest.tasks || [])
              .map((t: any) => `  [${t.status}] ${t.title}${t.assignedTo ? ` (assigned: ${t.assignedTo})` : ''}`)
              .join('\n');
            const msgSummary = (manifest.recentMessages || []).slice(0, 10)
              .map((m: any) => `  ${m.fromTitle || m.fromAgent} → ${m.toTitle || m.toAgent}: "${m.subject}" [${m.status}]`)
              .join('\n');
            rehydrationPrompt = [
              `You are being resurrected into team "${team.name}".`,
              `Your role: ${member.role}`,
              member.roleDescription ? `Role description: ${member.roleDescription}` : '',
              taskSummary ? `\nTask Board:\n${taskSummary}` : '',
              msgSummary ? `\nRecent Messages:\n${msgSummary}` : '',
              '\nUse your MCP tools (send_message, get_messages, get_tasks, update_task, get_team_info) to coordinate with teammates.',
            ].filter(Boolean).join('\n');
          }

          const newAgent = await this.supervisor.launchAgent({
            workspaceId: team.workspaceId,
            title: member.title,
            roleDescription: member.roleDescription || '',
            workingDirectory: member.workingDirectory,
            command: member.command,
            provider: member.provider,
            autoRestartEnabled: true,
            isSupervised: true,
            // WP-A.2 (F9): join the team BEFORE launch so the team `--mcp-config`
            // is injected inline at launch (off-disk) instead of being merged
            // into a token-bearing root `.mcp.json` after the agent is running.
            teamId,
            teamRole: member.role,
          });

          idMap.set(member.agentId, newAgent.id);

          // For non-Claude agents, send rehydration prompt after a brief delay
          if (rehydrationPrompt) {
            setTimeout(async () => {
              try {
                await this.supervisor.sendInput(newAgent.id, rehydrationPrompt!);
              } catch { /* agent may not be idle yet — delivery engine will handle queued messages */ }
            }, 5000);
          }
        } catch (err: any) {
          console.error(`[resurrect] Failed to relaunch member ${member.title}:`, err.message);
          // Continue with remaining members
        }
      }

      // Reactivate team and clear old members
      updateTeamStatus(teamId, 'active');

      // Remove old members. New members were already added to the team inside
      // launchAgent (via the `teamId` arg) so the inline team --mcp-config could
      // be injected at launch (WP-A.2/F9) — do NOT re-add them here.
      for (const member of manifest.members) {
        try { removeTeamMember(teamId, member.agentId); } catch { /* may not exist */ }
      }

      // Remove old channels, re-create with new IDs
      const oldChannels = listChannels(teamId);
      for (const ch of oldChannels) {
        removeChannel(ch.id);
      }
      for (const ch of manifest.channels) {
        const newFrom = idMap.get(ch.fromAgent);
        const newTo = idMap.get(ch.toAgent);
        if (newFrom && newTo) {
          createChannel(teamId, newFrom, newTo, ch.label);
        }
      }

      // Re-create tasks with new assignee IDs
      for (const task of (manifest.tasks || [])) {
        const newAssignee = task.assignedTo ? idMap.get(task.assignedTo) || null : null;
        createTeamTask({
          teamId,
          title: task.title,
          description: task.description || '',
          assignedTo: newAssignee || undefined,
          createdBy: 'system',
        });
      }

      // WP-A.2 (F9): team MCP config is injected inline at launch (the agents
      // joined the team via launchAgent's `teamId` arg before they launched), so
      // there is no post-launch root-`.mcp.json` merge to do here. Writing the
      // bearer token to disk after the fact was the removed leak.

      const updated = getTeam(teamId);
      this.supervisor.emit('teamUpdated', updated);
      return {
        ...updated,
        resurrected: true,
        agentMapping: Object.fromEntries(idMap),
        membersLaunched: idMap.size,
        membersFailed: manifest.members.length - idMap.size,
      };
    }

    // ── Notebook live-kernel routes (Phase 1) ──────────────────────────
    // These talk to the same jupyter-server the iframe uses, attaching to
    // the notebook's existing session rather than spawning a parallel kernel.

    // POST /api/notebooks/kernel/execute-cell
    if (method === 'POST' && path === '/api/notebooks/kernel/execute-cell') {
      const body = await readBody(req);
      const { notebookPath, cellId, timeout } = JSON.parse(body);
      if (!notebookPath || !cellId) {
        throw Object.assign(new Error('Missing notebookPath or cellId'), { statusCode: 400 });
      }
      return await kernelExecuteCell(notebookPath, cellId, { timeoutSec: timeout });
    }

    // POST /api/notebooks/kernel/execute-range
    if (method === 'POST' && path === '/api/notebooks/kernel/execute-range') {
      const body = await readBody(req);
      const { notebookPath, fromCellId, toCellId, timeout } = JSON.parse(body);
      if (!notebookPath || !fromCellId || !toCellId) {
        throw Object.assign(new Error('Missing notebookPath, fromCellId, or toCellId'), { statusCode: 400 });
      }
      return await kernelExecuteRange(notebookPath, fromCellId, toCellId, { timeoutSec: timeout });
    }

    // POST /api/notebooks/kernel/execute-notebook
    if (method === 'POST' && path === '/api/notebooks/kernel/execute-notebook') {
      const body = await readBody(req);
      const { notebookPath, timeout } = JSON.parse(body);
      if (!notebookPath) {
        throw Object.assign(new Error('Missing notebookPath'), { statusCode: 400 });
      }
      return await kernelExecuteNotebook(notebookPath, { timeoutSec: timeout });
    }

    // POST /api/notebooks/kernel/interrupt
    if (method === 'POST' && path === '/api/notebooks/kernel/interrupt') {
      const body = await readBody(req);
      const { notebookPath } = JSON.parse(body);
      if (!notebookPath) throw Object.assign(new Error('Missing notebookPath'), { statusCode: 400 });
      return await kernelInterrupt(notebookPath);
    }

    // POST /api/notebooks/kernel/restart
    if (method === 'POST' && path === '/api/notebooks/kernel/restart') {
      const body = await readBody(req);
      const { notebookPath } = JSON.parse(body);
      if (!notebookPath) throw Object.assign(new Error('Missing notebookPath'), { statusCode: 400 });
      return await kernelRestart(notebookPath);
    }

    // GET /api/notebooks/kernel/state?notebookPath=…
    if (method === 'GET' && path === '/api/notebooks/kernel/state') {
      const notebookPath = url.searchParams.get('notebookPath');
      if (!notebookPath) throw Object.assign(new Error('Missing notebookPath query param'), { statusCode: 400 });
      return await kernelGetState(notebookPath);
    }

    // ── File-view routes ────────────────────────────────────────────────

    // POST /api/files/open-tab — ask the renderer to open a file as a tab in
    // the user's file viewer. Backs the `open_file_in_view` MCP tool so an
    // agent can surface a doc/image/CSV/etc. to the human. Main only
    // validates and enriches (workspace root + pathType when the workspace
    // is known); the renderer resolves remaining defaults against the
    // currently selected workspace and calls the store's openTab().
    // Delivery rides the supervisor EventEmitter → ipc-handlers.ts forwards
    // it to the renderer as `file:open-tab` (same pattern as teamUpdated).
    if (method === 'POST' && path === '/api/files/open-tab') {
      const body = await readBody(req);
      const { filePath, pathType, workspaceId, agentId } = JSON.parse(body);
      if (!filePath || typeof filePath !== 'string') {
        throw Object.assign(new Error('Missing "filePath" in request body'), { statusCode: 400 });
      }
      if (pathType !== undefined && pathType !== 'windows' && pathType !== 'wsl') {
        throw Object.assign(new Error('"pathType" must be "windows" or "wsl" when provided'), { statusCode: 400 });
      }
      const payload: Record<string, unknown> = { filePath };
      if (pathType) payload.pathType = pathType;
      if (agentId) {
        const agent = getAgent(agentId);
        if (!agent) throw Object.assign(new Error('Agent not found'), { statusCode: 404 });
        payload.agentId = agentId;
        if (!workspaceId) payload.workspaceId = agent.workspaceId;
      }
      if (workspaceId) payload.workspaceId = workspaceId;
      if (payload.workspaceId) {
        const workspace = getWorkspace(payload.workspaceId as string);
        if (!workspace) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 });
        payload.rootDirectory = workspace.path;
        if (!payload.pathType) payload.pathType = workspace.pathType;
      }
      this.supervisor.emit('openFileInView', payload);
      return { ok: true, ...payload };
    }

    // ── Persona routes ──────────────────────────────────────────────────

    // GET /api/personas?workspaceId=... — list personas
    if (method === 'GET' && path === '/api/personas') {
      // Inc 1 (A3): asserted + no ?workspaceId relaxes from 400 to header-scoped
      // (RECORDED AS INTENDED — mirrors the teams relaxation).
      const workspaceId = this.resolveWorkspaceScope(identity, url.searchParams.get('workspaceId'));
      if (!workspaceId) throw Object.assign(new Error('Missing workspaceId'), { statusCode: 400 });
      const workspace = getWorkspace(workspaceId);
      if (!workspace) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 });
      return scanPersonas(workspace.path, workspace.pathType);
    }

    // POST /api/personas — create persona
    if (method === 'POST' && path === '/api/personas') {
      const body = await readBody(req);
      const { workspaceId: bodyWorkspaceId, name, claudeMd, roleDescription, lane } = JSON.parse(body);
      // Inc 1 (B4 server side): asserted caller may omit workspaceId (filled from
      // header); an explicit mismatch → 403.
      const workspaceId = this.resolveWorkspaceScope(identity, bodyWorkspaceId ?? null);
      if (!workspaceId || !name) throw Object.assign(new Error('Missing workspaceId or name'), { statusCode: 400 });
      const workspace = getWorkspace(workspaceId);
      if (!workspace) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 });
      // scaffoldPersona throws on an invalid lane → surface as 400.
      try {
        return scaffoldPersona(workspace.path, workspace.pathType, name, roleDescription ?? claudeMd, lane);
      } catch (e) {
        throw Object.assign(e as Error, { statusCode: (e as any).statusCode ?? 400 });
      }
    }

    // ── Template routes ────────────────────────────────────────────────

    // GET /api/templates?workspaceId=... — list templates
    if (method === 'GET' && path === '/api/templates') {
      // Inc 1 (A3): header-scoped when asserted, else today's optional filter.
      const workspaceId = this.resolveWorkspaceScope(identity, url.searchParams.get('workspaceId')) || undefined;
      return listAgentTemplates(workspaceId);
    }

    // GET /api/templates/:id — get single template
    const templateGetMatch = path.match(/^\/api\/templates\/([^/]+)$/);
    if (method === 'GET' && templateGetMatch) {
      const template = getAgentTemplate(templateGetMatch[1]);
      if (!template) throw Object.assign(new Error('Template not found'), { statusCode: 404 });
      return template;
    }

    // POST /api/templates — create template
    if (method === 'POST' && path === '/api/templates') {
      const body = await readBody(req);
      const input = JSON.parse(body);
      return createAgentTemplate(input);
    }

    // PATCH /api/templates/:id — update template
    const templateUpdateMatch = path.match(/^\/api\/templates\/([^/]+)$/);
    if (method === 'PATCH' && templateUpdateMatch) {
      const body = await readBody(req);
      const updates = JSON.parse(body);
      return updateAgentTemplate(templateUpdateMatch[1], updates);
    }

    // DELETE /api/templates/:id — delete template
    const templateDeleteMatch = path.match(/^\/api\/templates\/([^/]+)$/);
    if (method === 'DELETE' && templateDeleteMatch) {
      deleteAgentTemplate(templateDeleteMatch[1]);
      return { ok: true };
    }

    // ── Browser routes (Phase 2 WP2-B; spec M10 tool surface) ────────────
    // Thin by design: validate → provider call → serialize. ALL browser
    // policy (M9 partition discipline, M11 URL/SSRF allowlist, M12 act-tier
    // gating) lives in WP2-A's provider behind the frozen contract — a
    // PolicyError from it becomes a 403 carrying the policy message. These
    // routes are bearer-token-gated like everything else by the admission
    // preamble in start(); no provider injected → 503. The browser API surface
    // (open-url / tabs / text / page / screenshot / click / type / press-key /
    // select-option / scroll / go-back / go-forward / reload / wait-for /
    // close) is COMPLETE — no raw-eval / Runtime.evaluate route may ever be
    // added here (M10).

    // POST /api/browser/open-url — { url, forHuman? }. forHuman opens a
    // visible persist:user tab for the human (never CDP); resolves once the
    // page is ready (the wait lives in the provider, not in proxy scripts).
    if (method === 'POST' && path === '/api/browser/open-url') {
      const tools = this.requireBrowserTools();
      const { url: targetUrl, forHuman, agentId } = JSON.parse(await readBody(req));
      if (!targetUrl || typeof targetUrl !== 'string') {
        throw Object.assign(new Error('Missing "url" in request body'), { statusCode: 400 });
      }
      if (forHuman !== undefined && typeof forHuman !== 'boolean') {
        throw Object.assign(new Error('"forHuman" must be a boolean when provided'), { statusCode: 400 });
      }
      // Per-workspace isolation: stamp the tab with the calling agent's
      // workspace so it lands in that workspace's browser strip rather than
      // leaking into whichever workspace the human happens to be viewing.
      // Slice-2: resolve the calling agent's workspace + display title trust-side
      // from the registry. The agent model cannot forge these via tool args; they
      // attribute the tab ("Opened by <title>") and raise the attention flash.
      const agent = typeof agentId === 'string' && agentId ? getAgent(agentId) : undefined;
      const openOpts: Parameters<BrowserToolProvider['openUrl']>[1] = {
        forHuman: forHuman === true,
        workspaceId: agent?.workspaceId ?? null,
      };
      // Only stamp identity when a real agent resolved from the registry —
      // never emit undefined-valued keys, and never forge from body args.
      if (agent) {
        openOpts.agentId = agentId;
        openOpts.agentTitle = agent.title;
      }
      try {
        const snapshot = await tools.openUrl(targetUrl, openOpts);
        // WI-4: a signin envelope is a normal structured result, NOT a 403 —
        // forward it whole so the agent sees `pending_signin`/`signin_unavailable`.
        if (ApiServer.isSigninEnvelope(snapshot)) return snapshot;
        return { ok: true, forHuman: forHuman === true, snapshot };
      } catch (err) {
        ApiServer.rethrowBrowserError(err);
      }
    }

    // GET /api/browser/tabs — read tier
    if (method === 'GET' && path === '/api/browser/tabs') {
      const tools = this.requireBrowserTools();
      try {
        return { tabs: tools.listTabs() };
      } catch (err) {
        ApiServer.rethrowBrowserError(err);
      }
    }

    // GET /api/browser/:tabId/text | /api/browser/:tabId/page — read tier
    // (innerText vs a11y tree + refs; both wrapUntrusted'd by the provider).
    const browserReadMatch = path.match(/^\/api\/browser\/([^/]+)\/(text|page)$/);
    if (method === 'GET' && browserReadMatch) {
      const tools = this.requireBrowserTools();
      const tabId = browserReadMatch[1];
      try {
        if (browserReadMatch[2] === 'text') {
          const r = await tools.getPageText(tabId);
          if (ApiServer.isSigninEnvelope(r)) return r;
          return { tabId, text: r };
        }
        const r = await tools.readPage(tabId);
        if (ApiServer.isSigninEnvelope(r)) return r;
        return { tabId, page: r };
      } catch (err) {
        ApiServer.rethrowBrowserError(err);
      }
    }

    // POST /api/browser/:tabId/screenshot — read tier (base64 PNG)
    const browserShotMatch = path.match(/^\/api\/browser\/([^/]+)\/screenshot$/);
    if (method === 'POST' && browserShotMatch) {
      const tools = this.requireBrowserTools();
      const tabId = browserShotMatch[1];
      try {
        const r = await tools.screenshot(tabId);
        if (ApiServer.isSigninEnvelope(r)) return r;
        return { tabId, base64Png: r.base64Png };
      } catch (err) {
        ApiServer.rethrowBrowserError(err);
      }
    }

    // POST /api/browser/:tabId/click — { ref } — act tier (M12-gated)
    const browserClickMatch = path.match(/^\/api\/browser\/([^/]+)\/click$/);
    if (method === 'POST' && browserClickMatch) {
      const tools = this.requireBrowserTools();
      const tabId = browserClickMatch[1];
      const { ref } = JSON.parse(await readBody(req));
      if (typeof ref !== 'number' || !Number.isInteger(ref)) {
        throw Object.assign(
          new Error('"ref" must be an integer ref from the latest browser_read_page snapshot'),
          { statusCode: 400 },
        );
      }
      try {
        const r = await tools.click(tabId, ref);
        if (ApiServer.isSigninEnvelope(r)) return r;
        return { tabId, snapshot: r };
      } catch (err) {
        ApiServer.rethrowBrowserError(err);
      }
    }

    // POST /api/browser/:tabId/type — { ref, text } — act tier. Replaces the
    // field's content by default (provider-side focus → select-all → insert).
    const browserTypeMatch = path.match(/^\/api\/browser\/([^/]+)\/type$/);
    if (method === 'POST' && browserTypeMatch) {
      const tools = this.requireBrowserTools();
      const tabId = browserTypeMatch[1];
      const { ref, text } = JSON.parse(await readBody(req));
      if (typeof ref !== 'number' || !Number.isInteger(ref)) {
        throw Object.assign(
          new Error('"ref" must be an integer ref from the latest browser_read_page snapshot'),
          { statusCode: 400 },
        );
      }
      if (typeof text !== 'string') {
        throw Object.assign(new Error('"text" must be a string'), { statusCode: 400 });
      }
      try {
        const r = await tools.type(tabId, ref, text);
        if (ApiServer.isSigninEnvelope(r)) return r;
        return { tabId, snapshot: r };
      } catch (err) {
        ApiServer.rethrowBrowserError(err);
      }
    }

    // POST /api/browser/:tabId/press-key — { key } — act tier (focused element)
    const browserPressKeyMatch = path.match(/^\/api\/browser\/([^/]+)\/press-key$/);
    if (method === 'POST' && browserPressKeyMatch) {
      const tools = this.requireBrowserTools();
      const tabId = browserPressKeyMatch[1];
      const { key } = JSON.parse(await readBody(req));
      if (typeof key !== 'string' || key.length === 0) {
        throw Object.assign(new Error('"key" must be a non-empty string'), { statusCode: 400 });
      }
      try {
        const r = await tools.pressKey(tabId, key);
        if (ApiServer.isSigninEnvelope(r)) return r;
        return { tabId, snapshot: r };
      } catch (err) {
        ApiServer.rethrowBrowserError(err);
      }
    }

    // POST /api/browser/:tabId/select-option — { ref, value } — act tier (ARIA)
    const browserSelectMatch = path.match(/^\/api\/browser\/([^/]+)\/select-option$/);
    if (method === 'POST' && browserSelectMatch) {
      const tools = this.requireBrowserTools();
      const tabId = browserSelectMatch[1];
      const { ref, value } = JSON.parse(await readBody(req));
      if (typeof ref !== 'number' || !Number.isInteger(ref)) {
        throw Object.assign(
          new Error('"ref" must be an integer ref from the latest browser_read_page snapshot'),
          { statusCode: 400 },
        );
      }
      if (typeof value !== 'string') {
        throw Object.assign(new Error('"value" must be a string'), { statusCode: 400 });
      }
      try {
        const r = await tools.selectOption(tabId, ref, value);
        if (ApiServer.isSigninEnvelope(r)) return r;
        return { tabId, snapshot: r };
      } catch (err) {
        ApiServer.rethrowBrowserError(err);
      }
    }

    // POST /api/browser/:tabId/scroll — { ref? , dy? } — exactly one — act tier
    const browserScrollMatch = path.match(/^\/api\/browser\/([^/]+)\/scroll$/);
    if (method === 'POST' && browserScrollMatch) {
      const tools = this.requireBrowserTools();
      const tabId = browserScrollMatch[1];
      const { ref, dy } = JSON.parse(await readBody(req));
      const hasRef = ref !== undefined;
      const hasDy = dy !== undefined;
      if (hasRef === hasDy) {
        throw Object.assign(
          new Error('scroll requires exactly one of "ref" or "dy"'),
          { statusCode: 400 },
        );
      }
      if (hasRef && (typeof ref !== 'number' || !Number.isInteger(ref))) {
        throw Object.assign(new Error('"ref" must be an integer'), { statusCode: 400 });
      }
      if (hasDy && typeof dy !== 'number') {
        throw Object.assign(new Error('"dy" must be a number'), { statusCode: 400 });
      }
      try {
        const r = await tools.scroll(tabId, hasRef ? { ref } : { dy });
        if (ApiServer.isSigninEnvelope(r)) return r;
        return { tabId, snapshot: r };
      } catch (err) {
        ApiServer.rethrowBrowserError(err);
      }
    }

    // POST /api/browser/:tabId/go-back — act tier (NAV_AWAY-exempt server-side)
    const browserGoBackMatch = path.match(/^\/api\/browser\/([^/]+)\/go-back$/);
    if (method === 'POST' && browserGoBackMatch) {
      const tools = this.requireBrowserTools();
      const tabId = browserGoBackMatch[1];
      try {
        const r = await tools.goBack(tabId);
        if (ApiServer.isSigninEnvelope(r)) return r;
        return { tabId, snapshot: r };
      } catch (err) {
        ApiServer.rethrowBrowserError(err);
      }
    }

    // POST /api/browser/:tabId/go-forward — act tier (NAV_AWAY-exempt)
    const browserGoForwardMatch = path.match(/^\/api\/browser\/([^/]+)\/go-forward$/);
    if (method === 'POST' && browserGoForwardMatch) {
      const tools = this.requireBrowserTools();
      const tabId = browserGoForwardMatch[1];
      try {
        const r = await tools.goForward(tabId);
        if (ApiServer.isSigninEnvelope(r)) return r;
        return { tabId, snapshot: r };
      } catch (err) {
        ApiServer.rethrowBrowserError(err);
      }
    }

    // POST /api/browser/:tabId/reload — act tier (stays denied on sensitive)
    const browserReloadMatch = path.match(/^\/api\/browser\/([^/]+)\/reload$/);
    if (method === 'POST' && browserReloadMatch) {
      const tools = this.requireBrowserTools();
      const tabId = browserReloadMatch[1];
      try {
        const r = await tools.reload(tabId);
        if (ApiServer.isSigninEnvelope(r)) return r;
        return { tabId, snapshot: r };
      } catch (err) {
        ApiServer.rethrowBrowserError(err);
      }
    }

    // POST /api/browser/:tabId/wait-for — { text, timeoutMs? } — read tier,
    // server-side bounded poll (≤30s clamp lives in the provider).
    const browserWaitMatch = path.match(/^\/api\/browser\/([^/]+)\/wait-for$/);
    if (method === 'POST' && browserWaitMatch) {
      const tools = this.requireBrowserTools();
      const tabId = browserWaitMatch[1];
      const { text, timeoutMs } = JSON.parse(await readBody(req));
      if (typeof text !== 'string' || text.length === 0) {
        throw Object.assign(new Error('"text" must be a non-empty string'), { statusCode: 400 });
      }
      if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs))) {
        throw Object.assign(new Error('"timeoutMs" must be an integer when provided'), { statusCode: 400 });
      }
      try {
        const result = await tools.waitFor(
          tabId,
          { text, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
        );
        if (ApiServer.isSigninEnvelope(result)) return result;
        return { tabId, ...(result as Record<string, unknown>) };
      } catch (err) {
        ApiServer.rethrowBrowserError(err);
      }
    }

    // POST /api/browser/:tabId/close — act tier; returns the updated tab list.
    const browserCloseMatch = path.match(/^\/api\/browser\/([^/]+)\/close$/);
    if (method === 'POST' && browserCloseMatch) {
      const tools = this.requireBrowserTools();
      const tabId = browserCloseMatch[1];
      try {
        const result = (await tools.closeTab(tabId)) as Record<string, unknown>;
        return { tabId, ...result };
      } catch (err) {
        ApiServer.rethrowBrowserError(err);
      }
    }

    // POST /api/browser/access/request — §18 agent-initiated access request.
    // INERT: writes a pending request a human must approve; grants no access.
    // Always permitted (independent of the act-tier toggle) since it's harmless.
    // F5 accepted risk: `requestedBy` is read from the body — the shared
    // per-launch API token gives this layer NO per-connection agent identity to
    // derive it from. Spoofable across token-holding agents, but bounded to
    // attribution/grief (no access granted). See requestSiteAccess() doc above.
    if (method === 'POST' && path === '/api/browser/access/request') {
      const tools = this.requireBrowserTools();
      const parsed = JSON.parse(await readBody(req));
      const { hostname, scheme, includeSubdomains, pathPrefix, reason, wantSignedIn, requestedBy } =
        parsed;
      if (!hostname || typeof hostname !== 'string') {
        throw Object.assign(new Error('Missing "hostname" in request body'), { statusCode: 400 });
      }
      if (!requestedBy || typeof requestedBy !== 'string') {
        throw Object.assign(new Error('Missing "requestedBy" (agent id) in request body'), {
          statusCode: 400,
        });
      }
      // Title resolved by trusted code from the agent registry (display only).
      // Guarded: a missing registry row / uninitialized DB must not 500 — the
      // request is still valid without a display title.
      // Slice-4: the agent's workspace is resolved here from the same registry
      // row (trust-side, never the agent's tool args), so the rule created on
      // approval is scoped to that workspace — a request approved for workspace A
      // authorizes ONLY workspace A's agent.
      let requestedByTitle: string | undefined;
      let requestWorkspaceId: string | null = null;
      try {
        const requestingAgent = getAgent(requestedBy);
        requestedByTitle = requestingAgent?.title;
        requestWorkspaceId = requestingAgent?.workspaceId ?? null;
      } catch {
        requestedByTitle = undefined;
        requestWorkspaceId = null;
      }
      try {
        const result = tools.requestSiteAccess({
          hostname,
          scheme,
          includeSubdomains,
          pathPrefix,
          reason,
          wantSignedIn,
          requestedBy,
          requestedByTitle,
          workspaceId: requestWorkspaceId,
        }) as Record<string, unknown>;
        return { ok: true, ...result };
      } catch (err) {
        // Hostname-normalization / per-agent-cap rejections are the agent's to
        // fix — surface the message as a 400, not a 500.
        throw Object.assign(err as Error, { statusCode: 400 });
      }
    }

    // GET /api/browser/access/my-requests?agentId=… — §18 outcome read.
    // F5 accepted risk: `agentId` is a query param, not a trusted connection
    // identity (no per-agent token), so a token-holding agent can read another
    // agent's request history. Bounded disclosure; no access granted.
    if (method === 'GET' && path === '/api/browser/access/my-requests') {
      const tools = this.requireBrowserTools();
      const agentId = url.searchParams.get('agentId') || '';
      if (!agentId) {
        throw Object.assign(new Error('Missing "agentId" query parameter'), { statusCode: 400 });
      }
      // WI-4: resolve the agent's workspace trust-side (same as open-url) so the
      // signin_pending rollup is scoped to that workspace's runtime SigninSession
      // registry. A missing registry row / uninitialized DB must not 500 — fall
      // back to the unscoped (null) workspace.
      let workspaceId: string | null = null;
      try {
        workspaceId = getAgent(agentId)?.workspaceId ?? null;
      } catch {
        workspaceId = null;
      }
      return {
        requests: tools.listMyAccessRequests(agentId),
        signin_pending: tools.listSigninPending(workspaceId),
      };
    }

    // ── Plan routes (B2 P1-02) — rail-independent; NO header reads (R1) ──
    // GET /api/plans?workspaceId=&includeDeleted=
    if (method === 'GET' && path === '/api/plans') {
      return getPlans({
        workspaceId: url.searchParams.get('workspaceId') || undefined,
        includeDeleted: url.searchParams.get('includeDeleted') === 'true',
      });
    }

    // GET /api/plans/:id
    const planGet = path.match(/^\/api\/plans\/([^/]+)$/);
    if (method === 'GET' && planGet) {
      const p = getPlan(planGet[1]);
      if (!p) throw Object.assign(new Error('Plan not found'), { statusCode: 404 });
      return p;
    }

    // POST /api/plans
    //   Create branch (WP3, R1 F0): { workspace_id, title } + no `path` → mint a
    //     new surface from DEFAULT_SURFACE_TEMPLATE (createPlanSurface).
    //   Register branch (B2): { workspace_id, path, format, … } → register an
    //     existing file. Rename stays PATCH-only.
    if (method === 'POST' && path === '/api/plans') {
      const b = JSON.parse(await readBody(req));
      rejectMarkdownMigration(b); // F-F: markdown migration is deferred out of v1
      if ('id' in b) throw Object.assign(new Error('id is server-generated; do not supply it'), { statusCode: 400 }); // R2
      const workspaceId = pickBody<string>(b, 'workspace_id', 'workspaceId');

      // Create branch: a title with no explicit file path mints a fresh surface.
      const title = pickBody<string>(b, 'title', 'title');
      if (title !== undefined && b.path === undefined) {
        if (!workspaceId) throw Object.assign(new Error('Missing workspace_id'), { statusCode: 400 });
        const created = createPlanSurface({ workspaceId, title }); // seedMarkdown intentionally not threaded (F-F)
        // Planning-surface P1: auto-subscribe the creating supervisor so the freshly
        // minted surface survives its /clear (best-effort; no-op for non-supervisors).
        this.autoFocusPlan(identity, created.planId);
        const plan = getPlan(created.planId);
        return plan ?? created;
      }

      const relPath = normalizePlanPath(b.path);
      const format = b.format;
      if (!workspaceId || !format) throw Object.assign(new Error('Missing workspace_id or format'), { statusCode: 400 });
      const ws = getWorkspace(workspaceId);
      if (!ws) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 });
      let mtimeMs = coerceNum(pickBody(b, 'mtime_ms', 'mtimeMs'));
      let sizeBytes = coerceNum(pickBody(b, 'size_bytes', 'sizeBytes'));
      if (mtimeMs === undefined || sizeBytes === undefined) {           // DEC-2
        const stat = await statPlanMeta(ws, relPath);
        if (!stat) throw Object.assign(new Error('Cannot stat plan file; supply mtime_ms and size_bytes'), { statusCode: 400 });
        mtimeMs ??= stat.mtimeMs; sizeBytes ??= stat.sizeBytes;
      }
      return createOrRevivePlan({
        workspaceId, path: relPath, format,
        slug: pickBody(b, 'slug', 'slug'), runState: pickBody(b, 'run_state', 'runState'),
        mtimeMs, sizeBytes,
      });
    }

    // PATCH /api/plans/:id  { run_state?, mtime_ms?, size_bytes?, format?, path?, slug? }
    const planPatch = path.match(/^\/api\/plans\/([^/]+)$/);
    if (method === 'PATCH' && planPatch) {
      const b = JSON.parse(await readBody(req));
      const updates: any = {
        runState: pickBody(b, 'run_state', 'runState'), format: b.format,
        mtimeMs: coerceNum(pickBody(b, 'mtime_ms', 'mtimeMs')),
        sizeBytes: coerceNum(pickBody(b, 'size_bytes', 'sizeBytes')),
        slug: pickBody(b, 'slug', 'slug'),
      };
      if (b.path !== undefined) {
        updates.path = normalizePlanPath(b.path);                       // rename rebind
        if (updates.slug === undefined) updates.slug = derivePlanSlug(updates.path); // DEC-4 recompute
      }
      const updated = updatePlan(planPatch[1], updates);               // may throw 409 (DEC-1)
      if (!updated) throw Object.assign(new Error('Plan not found'), { statusCode: 404 });
      return updated;
    }

    // DELETE /api/plans/:id  (soft)
    const planDel = path.match(/^\/api\/plans\/([^/]+)$/);
    if (method === 'DELETE' && planDel) {
      const deleted = softDeletePlan(planDel[1]);
      if (!deleted) throw Object.assign(new Error('Plan not found'), { statusCode: 404 });
      return { ok: true, planId: deleted.id, deletedAt: deleted.deletedAt };
    }

    // ── Plan read ladder (WP3 — backs the mcp-tools-plans.js read tools) ──
    // Every read handler records a `source:'handler'` breadcrumb BEFORE returning
    // content (R2 §2.2); attribution is best-effort (never gates the content).

    // GET /api/plans/:id/sections — list_plan_sections orientation (~200 tokens).
    const planSectionsList = path.match(/^\/api\/plans\/([^/]+)\/sections$/);
    if (method === 'GET' && planSectionsList) {
      const resolved = await resolvePlanProjection(planSectionsList[1]);
      if (!resolved) throw Object.assign(new Error('Plan not found'), { statusCode: 404 });
      // One `'*'` orientation touch for the whole list (R2 §2.2), before content.
      recordPlanReadBreadcrumb(req, resolved.plan.id, { sectionAnchor: '*', tool: 'list_plan_sections' });
      this.bumpFocusOnRead(identity, resolved.plan.id); // P1-07: freshen an existing focus row
      return listPlanSections(resolved.projection);
    }

    // GET /api/plans/:id/projection — read_plan_projection: trusted activity
    // roll-up joined from plan_events, per live section.
    const planProjection = path.match(/^\/api\/plans\/([^/]+)\/projection$/);
    if (method === 'GET' && planProjection) {
      const resolved = await resolvePlanProjection(planProjection[1]);
      if (!resolved) throw Object.assign(new Error('Plan not found'), { statusCode: 404 });
      recordPlanReadBreadcrumb(req, resolved.plan.id, { sectionAnchor: '*', tool: 'read_plan_projection' });
      this.bumpFocusOnRead(identity, resolved.plan.id); // P1-07: freshen an existing focus row
      const includeEvents = url.searchParams.get('events') === 'full';
      const eventsLimit = queryNum(url.searchParams, 'events_limit');       // reuse I-5 helper
      const eventsSectionAnchor = url.searchParams.get('section_anchor') || undefined;
      const eventDetailId = url.searchParams.get('event_detail_id') || undefined;  // Fix-4 Tier-3
      return buildPlanActivityProjection(resolved.plan.id, resolved.projection,
        { includeEvents, eventsLimit, eventsSectionAnchor, eventDetailId });
    }

    // GET /api/plans/:id/sections/:anchor?mode=&offset=&limit= — read_plan_section.
    const planSectionRead = path.match(/^\/api\/plans\/([^/]+)\/sections\/([^/]+)$/);
    if (method === 'GET' && planSectionRead) {
      const anchor = decodeURIComponent(planSectionRead[2]);
      const resolved = await resolvePlanProjection(planSectionRead[1]);
      if (!resolved) throw Object.assign(new Error('Plan not found'), { statusCode: 404 });
      this.bumpFocusOnRead(identity, resolved.plan.id); // P1-07: freshen an existing focus row
      const mode = (url.searchParams.get('mode') || undefined) as ReadMode | undefined;
      const offset = queryNum(url.searchParams, 'offset');
      const limit = queryNum(url.searchParams, 'limit');
      const result = readPlanSection(resolved.projection, anchor, { mode, offset, limit });
      // Breadcrumb BEFORE returning content — record the RESOLVED anchor (section
      // vs block) so a `blk_` read is attributed to its owning section.
      if (result.found) {
        const sectionAnchor = result.kind === 'block' ? sectionAnchorOfBlock(resolved.projection, anchor) : anchor;
        recordPlanReadBreadcrumb(req, resolved.plan.id, {
          sectionAnchor: sectionAnchor ?? anchor,
          blockAnchor: result.kind === 'block' ? anchor : null,
          tool: 'read_plan_section', readMode: result.mode,
        });
      }
      return result;
    }

    // ── Supervisor-focus routes (B2 P1-03) — explicit supervisor_id; NO ACL (R1/R4) ──
    // GET /api/supervisor-focus?supervisorId=&workspaceId=
    if (method === 'GET' && path === '/api/supervisor-focus') {
      return getSupervisorFocus({
        supervisorId: url.searchParams.get('supervisorId') || undefined,
        workspaceId: url.searchParams.get('workspaceId') || undefined,
      });
    }

    // POST /api/supervisor-focus  { supervisor_id|supervisorId, plan_id|planId, notes? }
    if (method === 'POST' && path === '/api/supervisor-focus') {
      const b = JSON.parse(await readBody(req));
      const supervisorId = pickBody<string>(b, 'supervisor_id', 'supervisorId');
      const planId = pickBody<string>(b, 'plan_id', 'planId');
      if (!supervisorId || !planId) throw Object.assign(new Error('Missing supervisor_id or plan_id'), { statusCode: 400 });
      if (!getAgent(supervisorId)) throw Object.assign(new Error('Supervisor agent not found'), { statusCode: 404 });
      if (!getPlan(planId)) throw Object.assign(new Error('Plan not found'), { statusCode: 404 });
      return upsertSupervisorFocus({ supervisorId, planId, notes: pickBody(b, 'notes', 'notes') }); // DEC-3 full row
    }

    // ── Identity-scoped focus (planning-surface P1) — the calling supervisor
    //    subscribes/unsubscribes ITSELF (focus_plan / unfocus_plan MCP tools). The
    //    supervisor is derived from the validated X-Supervisor-Id, never a body/path
    //    param, so an agent can never focus on another supervisor's behalf. A
    //    non-supervisor caller (no identity.supervisorId) is rejected — this is the
    //    server-side gate behind the supervisor-only `plans` toolset.

    // POST /api/supervisor-focus/self  { plan_id|planId, notes? }
    if (method === 'POST' && path === '/api/supervisor-focus/self') {
      if (!identity.supervisorId) {
        throw Object.assign(new Error('supervisor identity required to focus a plan (send X-Supervisor-Id header)'),
          { statusCode: 403, code: 'not-a-supervisor' });
      }
      const b = JSON.parse(await readBody(req));
      const planId = pickBody<string>(b, 'plan_id', 'planId');
      if (!planId) throw Object.assign(new Error('Missing plan_id'), { statusCode: 400 });
      if (!getPlan(planId)) throw Object.assign(new Error('Plan not found'), { statusCode: 404 });
      return upsertSupervisorFocus({ supervisorId: identity.supervisorId, planId, notes: pickBody(b, 'notes', 'notes') });
    }

    // DELETE /api/supervisor-focus/self/:plan_id — matched BEFORE the generic
    // :supervisor_id/:plan_id delete so the literal "self" is never captured as a
    // supervisor id.
    const focusSelfDel = path.match(/^\/api\/supervisor-focus\/self\/([^/]+)$/);
    if (method === 'DELETE' && focusSelfDel) {
      if (!identity.supervisorId) {
        throw Object.assign(new Error('supervisor identity required to unfocus a plan (send X-Supervisor-Id header)'),
          { statusCode: 403, code: 'not-a-supervisor' });
      }
      const planId = decodeURIComponent(focusSelfDel[1]);
      deleteSupervisorFocus(identity.supervisorId, planId);
      return { ok: true, supervisorId: identity.supervisorId, planId };
    }

    // DELETE /api/supervisor-focus/:supervisor_id/:plan_id
    const focusDel = path.match(/^\/api\/supervisor-focus\/([^/]+)\/([^/]+)$/);
    if (method === 'DELETE' && focusDel) {
      deleteSupervisorFocus(decodeURIComponent(focusDel[1]), decodeURIComponent(focusDel[2]));
      return { ok: true, supervisorId: decodeURIComponent(focusDel[1]), planId: decodeURIComponent(focusDel[2]) };
    }

    throw Object.assign(new Error(`Not found: ${method} ${path}`), { statusCode: 404 });
  }
}

// ── B2 plan-route helpers (P1-02) ──────────────────────────────────────────────

/** Normalizes a plan path: '\'→'/', rejects absolute / '..' segments, requires a
 *  leading 'plans/' segment. Throws {statusCode:400} otherwise. */
function normalizePlanPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw Object.assign(new Error('path is required'), { statusCode: 400 });
  }
  const norm = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^([a-zA-Z]:\/|\/)/.test(norm)) {
    throw Object.assign(new Error('path must be workspace-relative, not absolute'), { statusCode: 400 });
  }
  const segments = norm.split('/');
  if (segments.some(s => s === '..')) {
    throw Object.assign(new Error("path must not contain '..' segments"), { statusCode: 400 });
  }
  if (segments[0] !== 'plans') {
    throw Object.assign(new Error("path must be under the 'plans/' directory"), { statusCode: 400 });
  }
  return norm;
}

/** Number passthrough; undefined when absent/non-numeric (DEC-6 casing handled by pickBody). */
function coerceNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Parse a numeric query param; undefined when absent/empty/non-finite. Distinct
 *  from coerceNum(Number(param)) which turns a MISSING param into 0
 *  (Number(null)===0) and silently windows a section to empty (I-5). */
export function queryNum(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** F-F: markdown→zones migration is DEFERRED out of v1. The create/register
 *  boundary must REJECT any markdown-migration input rather than 200-with-silent
 *  ignore (which would fabricate migration success). `seedMarkdown` is inert in
 *  `createPlanSurface`, but the boundary never advertises or accepts it. */
const MARKDOWN_MIGRATION_FIELDS = [
  'seed_markdown', 'seedMarkdown', 'markdown',
  'migrate', 'migrate_from', 'migrateFrom', 'migrate_md', 'migrateMd',
];
function rejectMarkdownMigration(b: any): void {
  if (b == null || typeof b !== 'object') return;
  for (const f of MARKDOWN_MIGRATION_FIELDS) {
    if (b[f] !== undefined) {
      throw Object.assign(
        new Error('markdown migration is not supported in v1 (deferred)'),
        { statusCode: 400 },
      );
    }
  }
}

/** Join a workspace-relative `plans/…` path onto the workspace root (host sep). */
function absPlanPath(ws: Workspace, relPath: string): string {
  const sep = ws.pathType === 'wsl' ? '/' : (ws.path.includes('\\') ? '\\' : '/');
  const base = ws.path.replace(/[\\/]+$/, '');
  return `${base}${sep}${relPath.replace(/\//g, sep)}`;
}

/** Resolve the projection a read tool serves for a plan (WP3). Prefers WP4's
 *  in-memory last-good projection; falls back to reading + parsing the file on
 *  disk (the reparser may not have run yet — e.g. right after create, or in
 *  tests where it is unconfigured). Returns null for a missing/deleted plan. */
export async function resolvePlanProjection(planId: string): Promise<{ plan: import('../shared/types').Plan; projection: PlanProjection } | null> {
  const plan = getPlan(planId);
  if (!plan || plan.deletedAt) return null;
  const served = getServedPlanProjection(planId);
  if (served) return { plan, projection: served };
  const ws = getWorkspace(plan.workspaceId);
  if (!ws) return { plan, projection: { sections: [], parseError: 'workspace not found', warnings: [], source: '' } };
  try {
    const fc = await readFileContents(absPlanPath(ws, plan.path), ws.pathType);
    if (fc.error || typeof fc.content !== 'string') {
      return { plan, projection: { sections: [], parseError: fc.error ?? 'no content', warnings: [], source: '' } };
    }
    return { plan, projection: parsePlanHtmlSafe(fc.content) };
  } catch (err) {
    return { plan, projection: { sections: [], parseError: err instanceof Error ? err.message : String(err), warnings: [], source: '' } };
  }
}

/** The owning section anchor of a `blk_` block within a projection (else null). */
function sectionAnchorOfBlock(projection: PlanProjection, blockAnchor: string): string | null {
  for (const s of projection.sections) {
    if (s.blocks.some((blk) => blk.anchor === blockAnchor)) return s.anchor;
  }
  return null;
}

/** Record a `source:'handler'` read breadcrumb BEFORE returning content (R2
 *  §2.2). The calling agent is the forwarded `X-Self-Id` (workers) falling back
 *  to `X-Supervisor-Id`. Tolerant: never throws, never gates the read. */
function recordPlanReadBreadcrumb(
  req: http.IncomingMessage,
  planId: string,
  args: { sectionAnchor: string; blockAnchor?: string | null; tool: string; readMode?: string | null },
): void {
  try {
    const hdr = (name: string): string | null => {
      const v = req.headers[name];
      return typeof v === 'string' && v.length > 0 ? v : null;
    };
    const agentId = hdr('x-self-id') ?? hdr('x-supervisor-id');
    if (!agentId) return; // no attributable caller → skip (best-effort provenance)
    recordPlanSectionTouch({
      agentId, planId,
      sectionAnchor: args.sectionAnchor,
      blockAnchor: args.blockAnchor ?? null,
      tool: args.tool, kind: 'read',
      readMode: args.readMode ?? null,
      source: 'handler',
      toolUseId: hdr('x-tool-use-id'),
    });
  } catch { /* provenance is best-effort — never fail the read (R2 §0) */ }
}

/** read_plan_projection payload: each live section's structure + its trusted
 *  `plan_events` activity roll-up (count + last event). With
 *  `opts.includeEvents`, also attach the per-event trusted rows (WP5 tier-2:
 *  observed_via / attribution_confidence / section_mismatch + the kept-separate
 *  claimed self-report) so the render surface can show the trusted/claimed
 *  split. Omitted by default to keep the tier-1 orient payload small (C7). */
export function buildPlanActivityProjection(
  planId: string,
  projection: PlanProjection,
  opts?: { includeEvents?: boolean; eventsLimit?: number; eventsSectionAnchor?: string; eventDetailId?: string },
) {
  const rollup = new Map(getPlanEventRollup(planId).map((r) => [r.sectionAnchor, r]));
  const archived = new Set(
    getPlanSections(planId, { includeArchived: true })
      .filter((s) => s.archivedAt)
      .map((s) => s.anchor),
  );
  const sections = projection.sections.map((s) => {
    const act = s.anchor ? rollup.get(s.anchor) : undefined;
    return {
      anchor: s.anchor,
      zone: s.zone,
      heading: s.heading,
      tokenEstimate: s.tokenEstimate,
      archived: s.anchor ? archived.has(s.anchor) : false,
      // GT-A WP-A2.3 — surface the write/presence split from the reshaped rollup
      // (D-4/D-6). eventCount/lastEventAt kept for back-compat; no route change.
      writeCount: act?.writeCount ?? 0,
      presenceCount: act?.presenceCount ?? 0,
      lastWriteAt: act?.lastWriteAt ?? null,
      eventCount: act?.eventCount ?? 0,
      lastEventAt: act?.lastEventAt ?? null,
      // Fix-4 §4a — witnessed repo rollup fields (the section literal is
      // UNANNOTATED, so these must be added deliberately). tests*/lastCommit are
      // inert in cut 1 (no capture) but present so the DTO shape is stable.
      repoFilesRead: act?.repoFilesRead ?? 0,
      repoFilesEdited: act?.repoFilesEdited ?? 0,
      repoFilesCreated: act?.repoFilesCreated ?? 0,
      testsRun: act?.testsRun ?? 0,
      testsPassed: act?.testsPassed ?? 0,
      testsFailed: act?.testsFailed ?? 0,
      lastCommit: act?.lastCommit ?? null,
    };
  });
  // I-7 — events are opt-in and BOUNDED. A cap (eventsLimit) or a section filter
  // (eventsSectionAnchor) attaches eventsTruncated/eventsOmitted metadata; a bare
  // ?events=full (no cap, no filter) stays byte-identical to the pre-I-7 payload
  // so the dashboard rail is unaffected.
  let eventsOut = opts?.includeEvents ? getPlanEventsForRender(planId) : undefined;
  const bounded = opts?.eventsLimit !== undefined || !!opts?.eventsSectionAnchor;
  let eventsTruncated = false, eventsOmitted = 0;
  if (eventsOut) {
    if (opts?.eventsSectionAnchor) {
      const a = opts.eventsSectionAnchor;
      // P0 Fix-1 (planning-surface-hardening-review) — section-scoped membership is
      // an EFFECT-SET / DISPATCHED-fact predicate ONLY. `claimedSectionAnchor` is an
      // untrusted, agent-supplied value; admitting it here let a forged sentinel
      // select an event into a section's "trusted" projection. It is deliberately
      // excluded, with NO replacement diagnostics filter in this pass.
      eventsOut = eventsOut.filter((e) =>
        e.observedSectionAnchor === a || e.dispatchedSectionAnchor === a);
    }
    if (opts?.eventsLimit !== undefined) {
      const lim = Math.max(0, Math.floor(opts.eventsLimit)); // clamp: non-negative integer
      if (eventsOut.length > lim) {
        eventsOmitted = eventsOut.length - lim;
        eventsOut = eventsOut.slice(eventsOut.length - lim);  // keep the latest N; rows stay oldest-first
        eventsTruncated = true;
      }
    }
  }
  // Fix-4 §4a — Tier-2 strip: map events into a SEPARATE typed payload so the heavy
  // `repoActivity` blob NEVER rides the wire (dropped here) and each event instead
  // carries a counts-only `repoActivityDigest`. Tier-2 events carrying a digest is
  // the fix itself — the payload is NOT byte-identical to pre-fix-4; no test asserts
  // it is. The events_limit/section_anchor bounded-metadata behavior is unchanged.
  const eventsPayload: PlanActivityEvent[] | undefined = eventsOut?.map((e) => {
    const { repoActivity, ...rest } = e;
    return { ...rest, repoActivityDigest: toTier2Digest(repoActivity ?? null) };
  });
  // Fix-4 §4a — Tier-3 drill-down: one event's capped witnessed file list, fetched
  // ONLY when event_detail_id was requested. `plan_id` in the DB WHERE prevents
  // cross-plan id probing; a bad/foreign id yields `null` (not an error).
  let eventDetail: RepoActivityDetail | null = null;
  if (opts?.eventDetailId) {
    const ev = getPlanEventRepoActivity(planId, opts.eventDetailId);
    eventDetail = ev ? toTier3Detail(opts.eventDetailId, ev) : null;
  }
  return {
    planId, sections, parseError: projection.parseError, warnings: projection.warnings,
    events: eventsPayload,
    // metadata ONLY when a cap/filter was requested → bare ?events=full stays byte-identical
    ...(eventsPayload && bounded ? { eventsTruncated, eventsOmitted } : {}),
    // eventDetail key present ONLY when a drill-down was requested (opt-in cost).
    ...(opts?.eventDetailId ? { eventDetail } : {}),
  };
}

/** Best-effort file stat for DEC-2 metadata fill. Windows: statSync(join(ws.path, rel)).
 *  WSL: skip → null (the watcher supplies real values; the POST caller must pass them). */
async function statPlanMeta(ws: Workspace, relPath: string): Promise<{ mtimeMs: number; sizeBytes: number } | null> {
  if (ws.pathType !== 'windows') return null;
  try {
    const stat = fs.statSync(nodePath.join(ws.path, relPath));
    return { mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
  } catch {
    return null;
  }
}

/** DEC-6 alias tolerance: snake_case is canonical, camelCase accepted. */
function pickBody<T>(b: any, snake: string, camel: string): T | undefined {
  if (b == null) return undefined;
  if (b[snake] !== undefined) return b[snake] as T;
  if (b[camel] !== undefined) return b[camel] as T;
  return undefined;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
