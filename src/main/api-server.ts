import http from 'http';
import type { AddressInfo } from 'net';
import { URL } from 'url';
import { getApiToken, decideApiAccess } from './security/api-auth';
import type { AgentSupervisor } from './supervisor';
import {
  getAgent, getAllAgents, getAgentsByWorkspace, getWorkspace,
  getFileActivities,
  createTeam, getTeam, listTeams, updateTeamStatus, saveTeamManifest, getTeamManifest,
  addTeamMember, removeTeamMember, getTeamMembers,
  createChannel, removeChannel, getChannel, listChannels,
  createTeamMessage, getTeamMessages, getRecentMessageCount, getRecentPairMessages,
  createTeamTask, updateTeamTask, getTeamTasks,
  listAgentTemplates, createAgentTemplate, updateAgentTemplate, deleteAgentTemplate, getAgentTemplate,
} from './database';
import {
  executeCell as kernelExecuteCell,
  executeNotebook as kernelExecuteNotebook,
  executeRange as kernelExecuteRange,
  interruptKernel as kernelInterrupt,
  restartKernel as kernelRestart,
  getKernelState as kernelGetState,
} from './jupyter-kernel-client';
import { scanPersonas, scaffoldPersona } from './persona-scanner';
import { TEAM_MAX_MESSAGES_PER_5MIN, TEAM_MAX_ALTERNATIONS, TEAM_ALTERNATION_WINDOW_MS, TEAM_PAIR_COOLDOWN_MS } from '../shared/constants';
import { TeamMessageStatus } from '../shared/types';
import { isKeyName, mapKeyToBytes, SUPPORTED_KEY_NAMES } from './supervisor/key-bytes';
import type { OrchestrationService } from './orchestration/service';
import crypto from 'crypto';

/** Machine-readable failure classes the top-level error serializer is allowed
 *  to expose in JSON bodies. Errors thrown inside routes can carry raw Node
 *  errno strings on `.code` (ENOENT, EACCES, ECONNREFUSED, ...) — those are
 *  internals and must NOT leak to clients as API codes, so the serializer
 *  allowlists instead of forwarding any string. Add new dashboard API codes
 *  here deliberately when a route starts setting them. */
const API_ERROR_CODES = new Set<string>(['submit-not-confirmed', 'delivery-failed', 'browser-policy-denied']);

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
  /** wrapUntrusted applied by the provider (M12). */
  getPageText(tabId: string): Promise<string>;
  /** a11y tree + numbered refs, wrapUntrusted applied (M12). */
  readPage(tabId: string): Promise<string>;
  screenshot(tabId: string): Promise<{ base64Png: string }>;
  /** Act tier — throws PolicyError unless human-enabled; returns the fresh
   *  post-click snapshot. */
  click(tabId: string, ref: number): Promise<string>;
  /** Act tier (WP-C parity). Each returns the fresh post-action snapshot
   *  except closeTab (returns the updated agent tab list) and waitFor (a
   *  server-side bounded poll result). NONE is an eval surface (M10). */
  type(tabId: string, ref: number, text: string): Promise<string>;
  pressKey(tabId: string, key: string): Promise<string>;
  selectOption(tabId: string, ref: number, value: string): Promise<string>;
  scroll(tabId: string, opts: { ref?: number; dy?: number }): Promise<string>;
  goBack(tabId: string): Promise<string>;
  goForward(tabId: string): Promise<string>;
  reload(tabId: string): Promise<string>;
  /** Read tier — bounded poll; returns { found, elapsedMs, snapshot? }. */
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
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
        const url = new URL(req.url || '/', `http://localhost:${this.port}`);
        const result = await this.route(req.method || 'GET', url, req);
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

  private async route(method: string, url: URL, req: http.IncomingMessage): Promise<any> {
    const path = url.pathname;

    // GET /api/agents — list all agents
    if (method === 'GET' && path === '/api/agents') {
      const workspaceId = url.searchParams.get('workspaceId');
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
      const activities = getFileActivities(agentId, operation).slice(0, limit);
      return { agentId, operation: operation || null, activities };
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
      const { text, submit, confirm } = JSON.parse(body);
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

      // Confirmed (handshake) path. `submit: false` is incompatible — an
      // unsubmitted prompt can't start a turn, so there is nothing to confirm.
      if (confirm === true && submit !== false) {
        try {
          const result = await this.supervisor.sendInputConfirmed(agentId, text);
          return { ok: true, agentId, submit: true, ...result };
        } catch (err) {
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
      return { ok: true, agentId, queued: true, submit: submit !== false, message: 'Input queued' };
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
    // Body: { state: 'idle' | 'working' | 'active', source: string, ts?: number }
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

      if (state !== 'idle' && state !== 'working' && state !== 'active') {
        throw Object.assign(
          new Error(`Unsupported state ${JSON.stringify(state)} — only 'idle', 'working', or 'active' accepted`),
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
        state: state as 'idle' | 'working' | 'active',
        source: sourceTag,
        ts: legacy ? Date.now() : (ts as number),
        hookEventName: legacy
          ? (state === 'working' ? 'UserPromptSubmit' : state === 'active' ? 'SessionStart' : 'Stop')
          : (hookEventName as string),
        turnId: typeof parsed.turnId === 'string' ? parsed.turnId : undefined,
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
        legacy,
      };
      const result = this.supervisor.applyHookStatusEvent(agentId, event, 'http');
      return { ok: true, agentId, state, source: sourceTag, result };
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
      const agent = await this.supervisor.launchAgent(input);
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
    // proxies list_orchestrations / run_orchestration / get_orchestration_run /
    // abort_orchestration here. `/catalog` is matched BEFORE the `:runId` regex
    // so the literal "catalog" isn't captured as a runId.

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
      return this.orchestration!.start_run({ name, ...params });
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

    // ── Team routes ──────────────────────────────────────────────────────

    // POST /api/teams — create team
    if (method === 'POST' && path === '/api/teams') {
      const body = await readBody(req);
      const input = JSON.parse(body);
      if (!input.workspaceId || !input.name || !input.members?.length) {
        throw Object.assign(new Error('Missing workspaceId, name, or members'), { statusCode: 400 });
      }
      const team = createTeam(input);
      this.supervisor.emit('teamUpdated', team);
      return team;
    }

    // GET /api/teams?workspaceId=... — list teams
    if (method === 'GET' && path === '/api/teams') {
      const workspaceId = url.searchParams.get('workspaceId');
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
      const workspaceId = url.searchParams.get('workspaceId');
      if (!workspaceId) throw Object.assign(new Error('Missing workspaceId'), { statusCode: 400 });
      const workspace = getWorkspace(workspaceId);
      if (!workspace) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 });
      return scanPersonas(workspace.path, workspace.pathType);
    }

    // POST /api/personas — create persona
    if (method === 'POST' && path === '/api/personas') {
      const body = await readBody(req);
      const { workspaceId, name, claudeMd } = JSON.parse(body);
      if (!workspaceId || !name) throw Object.assign(new Error('Missing workspaceId or name'), { statusCode: 400 });
      const workspace = getWorkspace(workspaceId);
      if (!workspace) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 });
      return scaffoldPersona(workspace.path, workspace.pathType, name, claudeMd);
    }

    // ── Template routes ────────────────────────────────────────────────

    // GET /api/templates?workspaceId=... — list templates
    if (method === 'GET' && path === '/api/templates') {
      const workspaceId = url.searchParams.get('workspaceId') || undefined;
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
      const workspaceId = agent?.workspaceId ?? null;
      try {
        const snapshot = await tools.openUrl(targetUrl, {
          forHuman: forHuman === true,
          workspaceId,
          agentId: agent ? agentId : undefined,
          agentTitle: agent?.title,
        });
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
          return { tabId, text: await tools.getPageText(tabId) };
        }
        return { tabId, page: await tools.readPage(tabId) };
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
        const { base64Png } = await tools.screenshot(tabId);
        return { tabId, base64Png };
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
        return { tabId, snapshot: await tools.click(tabId, ref) };
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
        return { tabId, snapshot: await tools.type(tabId, ref, text) };
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
        return { tabId, snapshot: await tools.pressKey(tabId, key) };
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
        return { tabId, snapshot: await tools.selectOption(tabId, ref, value) };
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
        return { tabId, snapshot: await tools.scroll(tabId, hasRef ? { ref } : { dy }) };
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
        return { tabId, snapshot: await tools.goBack(tabId) };
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
        return { tabId, snapshot: await tools.goForward(tabId) };
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
        return { tabId, snapshot: await tools.reload(tabId) };
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
        const result = (await tools.waitFor(
          tabId,
          { text, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
        )) as Record<string, unknown>;
        return { tabId, ...result };
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
      return { requests: tools.listMyAccessRequests(agentId) };
    }

    throw Object.assign(new Error(`Not found: ${method} ${path}`), { statusCode: 404 });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
