// Website-access policy store (plans/website-allowlist-design.md §6/§13/§18).
//
// Thin persistence service over the browser_access_* tables (declared in
// src/main/database.ts). Mirrors bookmarks-store.ts: statements are prepared
// per-call (the shared db handle does not exist until initDatabase() runs;
// better-sqlite3 caches prepared statements internally, so this is cheap).
//
// Security: these tables live in the dashboard DB under userData — NOT
// agent-writable. The store is the single normalization/validation point for
// rule + request hostnames (reject '*' / unparseable, require pathPrefix to
// start with '/'). The browser manager calls these; the manager enforces the
// runtime gates. No Electron imports here — but unlike the pure policy module,
// this DOES touch the DB (getDb), so it is not loaded by the pure-policy tests.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../database';
import type {
  AccessRequest,
  AccessRequestStatus,
  AccessRule,
  AccessRuleInput,
  SignedInOrigin,
} from '../../shared/browser';

/** Slice 12: a signed-in origin is "stale" (re-sign-in suggested) when its most
 *  recent activity is older than this. Tunable; deliberately generous. */
export const SIGNED_IN_STALE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/** Default per-agent pending-request cap (§18.1). */
export const DEFAULT_PENDING_REQUEST_CAP = 20;

/** Typed store error so callers (the agent-tool surface) can branch on `code`
 *  rather than parsing messages. */
export class AccessStoreError extends Error {
  constructor(
    readonly code: 'invalid-hostname' | 'invalid-path-prefix' | 'too-many-pending',
    message: string,
  ) {
    super(message);
    this.name = 'AccessStoreError';
  }
}

// ── Normalization / validation (the untrusted-input chokepoint) ──────────────

/**
 * Normalize a raw hostname via new URL().hostname (lowercased, punycode, no
 * trailing dot). Rejects any input containing '*' or that fails to parse — the
 * same guard for manual adds (§6) and agent requests (§18.1). The scheme only
 * picks the URL prefix used for parsing; 'any' parses as https.
 */
export function normalizeHostname(rawHost: string, scheme: 'https' | 'http' | 'any'): string {
  if (typeof rawHost !== 'string' || rawHost.length === 0 || rawHost.includes('*')) {
    throw new AccessStoreError('invalid-hostname', `invalid hostname: ${String(rawHost).slice(0, 100)}`);
  }
  const proto = scheme === 'any' ? 'https' : scheme;
  let host: string;
  try {
    host = new URL(`${proto}://${rawHost}`).hostname;
  } catch {
    throw new AccessStoreError('invalid-hostname', `unparseable hostname: ${rawHost.slice(0, 100)}`);
  }
  if (!host || host.includes('*')) {
    throw new AccessStoreError('invalid-hostname', `invalid hostname: ${rawHost.slice(0, 100)}`);
  }
  return host.replace(/\.$/, '').toLowerCase();
}

/** Validate an optional path prefix (must start with '/'); returns the value
 *  (or undefined). Empty string / '/' is treated as undefined (whole host). */
function normalizePathPrefix(pathPrefix: string | undefined | null): string | undefined {
  if (pathPrefix === undefined || pathPrefix === null || pathPrefix === '' || pathPrefix === '/') {
    return undefined;
  }
  if (!pathPrefix.startsWith('/')) {
    throw new AccessStoreError('invalid-path-prefix', `pathPrefix must start with '/': ${pathPrefix.slice(0, 100)}`);
  }
  return pathPrefix;
}

// ── Signed-in tabs (WI-1): login_url_patterns JSON (de)serialization ──────────

/** Parse the stored `login_url_patterns` JSON column into a string[]. Defensive:
 *  NULL / '' / malformed JSON / a non-array all collapse to undefined, and any
 *  non-string array entries are dropped — the column is trusted-chrome-authored,
 *  but a corrupt row must never throw inside a hot rule-resolution path. */
function parseLoginUrlPatterns(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const out = parsed.filter((p): p is string => typeof p === 'string' && p.length > 0);
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Encode an optional patterns array for the column. Empty/absent → NULL (so the
 *  default-heuristic path reads as "no per-rule tuning"). */
function encodeLoginUrlPatterns(patterns: string[] | undefined | null): string | null {
  if (!patterns || patterns.length === 0) return null;
  const clean = patterns.filter((p) => typeof p === 'string' && p.length > 0);
  return clean.length > 0 ? JSON.stringify(clean) : null;
}

// ── Row mappers ──────────────────────────────────────────────────────────────

function rowToRule(row: any): AccessRule {
  return {
    id: row.id,
    hostname: row.hostname,
    includeSubdomains: row.include_subdomains === 1,
    scheme: row.scheme,
    pathPrefix: row.path_prefix ?? undefined,
    note: row.note ?? undefined,
    allowSignedIn: row.allow_signed_in === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    workspaceId: row.workspace_id ?? null,
    // Signed-in tabs (WI-1): additive, NULL-tolerant for legacy rows.
    consentAckedAt: row.consent_acked_at ?? null,
    loginUrlPatterns: parseLoginUrlPatterns(row.login_url_patterns),
  };
}

function rowToRequest(row: any): AccessRequest {
  return {
    id: row.id,
    hostname: row.hostname,
    includeSubdomains: row.include_subdomains === 1,
    scheme: row.scheme,
    pathPrefix: row.path_prefix ?? undefined,
    wantSignedIn: row.want_signed_in === 1,
    requestedBy: row.requested_by,
    requestedByTitle: row.requested_by_title ?? undefined,
    reason: row.reason ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined,
    workspaceId: row.workspace_id ?? null,
  };
}

// ── Slice-4: workspace scoping ───────────────────────────────────────────────

/**
 * Does a workspace-scoped access row (rule / request) apply to `workspaceId`?
 * A NULL row is the legacy default — it applies to EVERY workspace (back-compat
 * for installs created before the column existed). A non-null row applies only to
 * its own workspace. Shared by the manager's per-workspace rule cache, the UI
 * rule/request lists, and the tests so all three scope identically.
 */
export function rowAppliesToWorkspace(
  rowWorkspaceId: string | null | undefined,
  workspaceId: string | null | undefined,
): boolean {
  return rowWorkspaceId == null || rowWorkspaceId === (workspaceId ?? null);
}

// ── Rules CRUD ───────────────────────────────────────────────────────────────

/** All rules (enabled + disabled), newest first. ONE agent allowlist — the
 *  legacy two-valued `list` column is pinned to 'agent' (§7). */
export function listRules(): AccessRule[] {
  return getDb()
    .prepare('SELECT * FROM browser_access_rules ORDER BY created_at DESC')
    .all()
    .map(rowToRule);
}

/** Insert a rule. Normalizes the hostname and validates the path prefix. The
 *  legacy `list` column is pinned to 'agent' (single-list model, §7). */
export function insertRule(input: AccessRuleInput): AccessRule {
  const db = getDb();
  const hostname = normalizeHostname(input.hostname, input.scheme);
  const pathPrefix = normalizePathPrefix(input.pathPrefix);
  const allowSignedIn = input.allowSignedIn === true;
  const workspaceId = input.workspaceId ?? null;
  // Signed-in tabs (WI-1): consent + login-wall tuning. consentAckedAt is stamped
  // trust-side at toggle-on/approval (WI-5); it is meaningful only for an
  // allow_signed_in rule, but we store whatever the trusted caller passed.
  const consentAckedAt = input.consentAckedAt ?? null;
  const loginUrlPatterns = encodeLoginUrlPatterns(input.loginUrlPatterns);
  const id = uuidv4();
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO browser_access_rules
      (id, list, hostname, include_subdomains, scheme, path_prefix, note, allow_signed_in, enabled, created_at, workspace_id, consent_acked_at, login_url_patterns)
     VALUES (?, 'agent', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    id,
    hostname,
    input.includeSubdomains ? 1 : 0,
    input.scheme,
    pathPrefix ?? null,
    input.note ?? null,
    allowSignedIn ? 1 : 0,
    createdAt,
    workspaceId,
    consentAckedAt,
    loginUrlPatterns,
  );
  return {
    id,
    hostname,
    includeSubdomains: Boolean(input.includeSubdomains),
    scheme: input.scheme,
    pathPrefix,
    note: input.note ?? undefined,
    allowSignedIn,
    enabled: true,
    createdAt,
    workspaceId,
    consentAckedAt,
    loginUrlPatterns: parseLoginUrlPatterns(loginUrlPatterns),
  };
}

export function getRule(id: string): AccessRule | undefined {
  const row = getDb().prepare('SELECT * FROM browser_access_rules WHERE id = ?').get(id);
  return row ? rowToRule(row) : undefined;
}

/** Patch a rule (any subset of input fields + enabled). Re-normalizes the
 *  hostname if hostname or scheme changes. Throws if the id is unknown. */
export function updateRule(
  id: string,
  patch: Partial<AccessRuleInput> & { enabled?: boolean },
): AccessRule {
  const existing = getRule(id);
  if (!existing) throw new Error(`unknown access rule: ${id}`);

  const scheme = patch.scheme ?? existing.scheme;
  const hostname =
    patch.hostname !== undefined ? normalizeHostname(patch.hostname, scheme) : existing.hostname;
  const includeSubdomains =
    patch.includeSubdomains !== undefined ? patch.includeSubdomains : existing.includeSubdomains;
  const pathPrefix =
    patch.pathPrefix !== undefined ? normalizePathPrefix(patch.pathPrefix) : existing.pathPrefix;
  const note = patch.note !== undefined ? patch.note : existing.note;
  const allowSignedIn =
    patch.allowSignedIn !== undefined ? patch.allowSignedIn : existing.allowSignedIn;
  const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;
  // Signed-in tabs (WI-1): consent + login-wall tuning are patchable. consentAckedAt
  // is stamped when the toggle/approval grants signed-in capability (WI-5).
  const consentAckedAt =
    patch.consentAckedAt !== undefined ? patch.consentAckedAt : (existing.consentAckedAt ?? null);
  const loginUrlPatterns =
    patch.loginUrlPatterns !== undefined ? patch.loginUrlPatterns : existing.loginUrlPatterns;
  const loginUrlPatternsCol = encodeLoginUrlPatterns(loginUrlPatterns);

  getDb()
    .prepare(
      `UPDATE browser_access_rules
         SET hostname = ?, include_subdomains = ?, scheme = ?, path_prefix = ?,
             note = ?, allow_signed_in = ?, enabled = ?,
             consent_acked_at = ?, login_url_patterns = ?
       WHERE id = ?`,
    )
    .run(
      hostname,
      includeSubdomains ? 1 : 0,
      scheme,
      pathPrefix ?? null,
      note ?? null,
      allowSignedIn ? 1 : 0,
      enabled ? 1 : 0,
      consentAckedAt,
      loginUrlPatternsCol,
      id,
    );

  return {
    id,
    hostname,
    includeSubdomains,
    scheme,
    pathPrefix,
    note: note ?? undefined,
    allowSignedIn,
    enabled,
    createdAt: existing.createdAt,
    // Slice-4: workspace scope is immutable here — a rule never migrates
    // workspaces via an edit (the UPDATE above leaves workspace_id untouched).
    workspaceId: existing.workspaceId ?? null,
    consentAckedAt,
    loginUrlPatterns: parseLoginUrlPatterns(loginUrlPatternsCol),
  };
}

/** Delete a rule and its tracked signed-in origins (§13: known-origins rows for
 *  a rule are deleted when the rule is deleted). */
export function deleteRule(id: string): void {
  const db = getDb();
  const tx = db.transaction((ruleId: string) => {
    db.prepare('DELETE FROM browser_access_signed_in_origins WHERE rule_id = ?').run(ruleId);
    db.prepare('DELETE FROM browser_access_rules WHERE id = ?').run(ruleId);
  });
  tx(id);
}

// ── Signed-in origins (§13) ──────────────────────────────────────────────────

/** Tracked authenticated origins for a rule (Mechanism-A upserts on handoff-ready). */
export function listSignedInOrigins(ruleId: string): string[] {
  return (
    getDb()
      .prepare('SELECT origin FROM browser_access_signed_in_origins WHERE rule_id = ?')
      .all(ruleId) as Array<{ origin: string }>
  ).map((r) => r.origin);
}

/** Record an authenticated origin for a rule (idempotent). Slice-4: the origin
 *  is transitively workspace-scoped by its rule_id (a rule belongs to one
 *  workspace), but workspace_id is stored too for symmetry / direct queries.
 *  Slice 12: an optional session-age stamp — `signedInAt`/`verifiedAt` from the
 *  handoff-ready commit. They overwrite the prior values when provided (a fresh
 *  hand-off IS the most-recent commit + a verification); null/omitted leaves the
 *  stored value untouched (the legacy two-arg callers/tests stay unchanged). */
export function upsertSignedInOrigin(
  ruleId: string,
  origin: string,
  workspaceId: string | null = null,
  opts: { signedInAt?: number | null; verifiedAt?: number | null } = {},
): void {
  const signedInAt = opts.signedInAt ?? null;
  const verifiedAt = opts.verifiedAt ?? null;
  // Signed-in tabs (WI-1): an upsert IS a (re-)confirmed live session — stamp
  // session_state='active' and clear any prior expiry, so a re-sign-in after a
  // login-wall expiry restores the durable session.
  getDb()
    .prepare(
      `INSERT INTO browser_access_signed_in_origins
         (rule_id, origin, workspace_id, signed_in_at, last_used_at, verified_at, session_state, expired_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', NULL)
       ON CONFLICT(rule_id, origin) DO UPDATE SET
         signed_in_at  = COALESCE(excluded.signed_in_at, signed_in_at),
         verified_at   = COALESCE(excluded.verified_at, verified_at),
         session_state = 'active',
         expired_at    = NULL`,
    )
    .run(ruleId, origin, workspaceId, signedInAt, signedInAt, verifiedAt);
}

/** Signed-in tabs (WI-1): the durable session state for a tracked (rule, origin),
 *  or undefined when no row exists (first-ever / never signed in). This is the
 *  authoritative cold/warm classifier input — `classifyOriginState` reads it.
 *  Keyed on (rule_id, origin), so it is workspace-agnostic by construction (a
 *  rule belongs to exactly one workspace, incl. the legacy NULL default). */
export function getSignedInOriginState(
  ruleId: string,
  origin: string,
): 'active' | 'expired' | undefined {
  const row = getDb()
    .prepare(
      'SELECT session_state FROM browser_access_signed_in_origins WHERE rule_id = ? AND origin = ?',
    )
    .get(ruleId, origin) as { session_state?: string } | undefined;
  if (!row) return undefined;
  return row.session_state === 'expired' ? 'expired' : 'active';
}

/** Signed-in tabs (WI-1): mark a tracked origin's session expired (login-wall
 *  redirect / 401 detected) WITHOUT deleting the row — the durable consent + the
 *  rule survive, so re-sign-in is a refresh, not a re-grant. No-op when no row
 *  exists (an active session was never recorded). */
export function expireSignedInOrigin(
  ruleId: string,
  origin: string,
  expiredAt: number = Date.now(),
): void {
  getDb()
    .prepare(
      `UPDATE browser_access_signed_in_origins
         SET session_state = 'expired', expired_at = ?
       WHERE rule_id = ? AND origin = ?`,
    )
    .run(expiredAt, ruleId, origin);
}

/** Slice 12: stamp last_used_at for every tracked signed-in origin matching an
 *  origin within a workspace (a row is workspace-scoped via its rule). Called on
 *  each authenticated agent drive so the session center can show "last used Nh
 *  ago". Display-only; never gates access. Matches the workspace by equality with
 *  NULL-aware `IS` so a legacy null-workspace row is touched under the null
 *  workspace. No-op when nothing matches. */
export function touchSignedInOrigin(
  origin: string,
  workspaceId: string | null,
  usedAt: number,
): void {
  getDb()
    .prepare(
      `UPDATE browser_access_signed_in_origins
         SET last_used_at = ?
       WHERE origin = ? AND workspace_id IS ?`,
    )
    .run(usedAt, origin, workspaceId);
}

/** Slice 12: the "Sessions shared with agents" snapshot — every tracked
 *  signed-in origin (joined to its rule for hostname + current allowSignedIn)
 *  that applies to `workspaceId` (own rows + legacy null-workspace defaults). A
 *  session is `stale` when its rule no longer grants authenticated-drive OR its
 *  most-recent activity (used / verified / signed-in) is older than
 *  SIGNED_IN_STALE_MS — the UI then offers a re-sign-in chip. */
export function listSharedSignedInOrigins(
  workspaceId: string | null,
  now: number = Date.now(),
): SignedInOrigin[] {
  const rows = getDb()
    .prepare(
      `SELECT s.rule_id, s.origin, s.signed_in_at, s.last_used_at, s.verified_at,
              s.session_state,
              r.hostname, r.allow_signed_in, r.workspace_id AS rule_workspace_id
         FROM browser_access_signed_in_origins s
         JOIN browser_access_rules r ON r.id = s.rule_id
        ORDER BY s.last_used_at DESC, s.signed_in_at DESC`,
    )
    .all() as Array<{
    rule_id: string;
    origin: string;
    signed_in_at: number | null;
    last_used_at: number | null;
    verified_at: number | null;
    session_state: string | null;
    hostname: string;
    allow_signed_in: number;
    rule_workspace_id: string | null;
  }>;

  return rows
    .filter((row) => rowAppliesToWorkspace(row.rule_workspace_id, workspaceId))
    .map((row) => {
      const allowSignedIn = row.allow_signed_in === 1;
      const sessionState: 'active' | 'expired' = row.session_state === 'expired' ? 'expired' : 'active';
      const lastActivity = Math.max(
        row.last_used_at ?? 0,
        row.signed_in_at ?? 0,
        row.verified_at ?? 0,
      );
      const aged = lastActivity > 0 && now - lastActivity > SIGNED_IN_STALE_MS;
      // Signed-in tabs (WI-1): an expired session is also stale (offer re-sign-in).
      const stale = !allowSignedIn || aged || sessionState === 'expired';
      return {
        ruleId: row.rule_id,
        hostname: row.hostname,
        origin: row.origin,
        workspaceId: row.rule_workspace_id ?? null,
        allowSignedIn,
        // Proactive-signin (2026-06-29): a session row is `signed_in` unless it
        // looks stale/expired, in which case the UI offers re-sign-in. `never` is
        // produced only by listSharedSignedInEntries (rules with no row).
        state: stale ? 'expired' : 'signed_in',
        signedInAt: row.signed_in_at ?? null,
        lastUsedAt: row.last_used_at ?? null,
        verifiedAt: row.verified_at ?? null,
        sessionState,
        stale,
      };
    });
}

/** Proactive-signin (2026-06-29): the ALLOWLIST-DRIVEN "Sessions shared with
 *  agents" snapshot. Merges the persisted session rows (listSharedSignedInOrigins)
 *  with EVERY enabled `allow_signed_in` rule applicable to `workspaceId`, so a
 *  site that is allowlisted-for-signed-in but never signed into yet still appears
 *  as a `never` entry the human can proactively sign in to. A rule that already
 *  has a session row keeps that row (no synthetic `never` duplicate); a rule with
 *  no row gets a synthetic `never` entry carrying its ruleId + hostname (all the
 *  beginSigninHandoff flow needs). */
export function listSharedSignedInEntries(
  workspaceId: string | null,
  now: number = Date.now(),
): SignedInOrigin[] {
  const rows = listSharedSignedInOrigins(workspaceId, now);
  const haveRow = new Set(rows.map((r) => r.ruleId));
  const neverEntries: SignedInOrigin[] = listRules()
    .filter(
      (r) =>
        r.enabled &&
        r.allowSignedIn &&
        rowAppliesToWorkspace(r.workspaceId, workspaceId) &&
        !haveRow.has(r.id),
    )
    .map((r) => {
      const scheme = r.scheme === 'any' ? 'https' : r.scheme;
      return {
        ruleId: r.id,
        hostname: r.hostname,
        origin: `${scheme}://${r.hostname}`,
        workspaceId: r.workspaceId ?? null,
        allowSignedIn: true,
        state: 'never' as const,
        signedInAt: null,
        lastUsedAt: null,
        verifiedAt: null,
        sessionState: 'active' as const,
        stale: false,
      };
    });
  return [...rows, ...neverEntries];
}

// ── Agent-initiated requests (§18) ───────────────────────────────────────────

/** Canonical dedup key for a pending request: workspace+host+scheme+subdomains+path.
 *  Slice-4: the workspace is part of the key so the same origin requested by
 *  agents in two different workspaces yields two distinct pending requests. */
function requestKey(r: {
  hostname: string;
  scheme: string;
  includeSubdomains: boolean;
  pathPrefix?: string;
  workspaceId?: string | null;
}): string {
  return `${r.workspaceId ?? ''}|${r.hostname}|${r.scheme}|${r.includeSubdomains ? 1 : 0}|${r.pathPrefix ?? ''}`;
}

export interface InsertRequestInput {
  hostname: string;
  scheme?: 'https' | 'http' | 'any';
  includeSubdomains?: boolean;
  pathPrefix?: string;
  reason?: string;
  wantSignedIn?: boolean;
  requestedBy: string;
  requestedByTitle?: string;
  /** Slice-4: the workspace of the requesting agent, resolved trust-side (the
   *  API layer reads it from the agent registry — never the agent's tool args). */
  workspaceId?: string | null;
}

/**
 * Insert an agent request (§18.1). Normalizes the hostname server-side, dedups
 * a same-origin pending request (returns the existing one, does not stack), and
 * enforces the per-agent pending cap (throws AccessStoreError 'too-many-pending').
 */
export function insertRequest(
  input: InsertRequestInput,
  cap: number = DEFAULT_PENDING_REQUEST_CAP,
): AccessRequest {
  const db = getDb();
  const scheme = input.scheme ?? 'https';
  const hostname = normalizeHostname(input.hostname, scheme);
  const pathPrefix = normalizePathPrefix(input.pathPrefix);
  const includeSubdomains = input.includeSubdomains !== false; // default true
  const wantSignedIn = input.wantSignedIn === true;
  const workspaceId = input.workspaceId ?? null;
  // F6 (DoS/UX hardening, not XSS): clamp the agent-supplied reason so it can't
  // flood/garble the human approval surface. The pending cap bounds count, not
  // size. Stored as opaque data; UI renders it as auto-escaped React text.
  const reason = typeof input.reason === 'string' ? input.reason.slice(0, 500) : undefined;

  // Dedup: an existing pending request for the same canonical origin returns
  // its id rather than stacking a duplicate.
  const pending = db
    .prepare("SELECT * FROM browser_access_requests WHERE status = 'pending'")
    .all()
    .map(rowToRequest);
  const key = requestKey({ hostname, scheme, includeSubdomains, pathPrefix, workspaceId });
  const dup = pending.find((p) => requestKey(p) === key);
  if (dup) return dup;

  // Per-agent pending cap.
  const mine = pending.filter((p) => p.requestedBy === input.requestedBy).length;
  if (mine >= cap) {
    throw new AccessStoreError(
      'too-many-pending',
      `too many pending access requests for this agent (cap ${cap})`,
    );
  }

  const id = uuidv4();
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO browser_access_requests
      (id, list, hostname, include_subdomains, scheme, path_prefix, want_signed_in,
       requested_by, requested_by_title, reason, status, created_at, decided_at, workspace_id)
     VALUES (?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?)`,
  ).run(
    id,
    hostname,
    includeSubdomains ? 1 : 0,
    scheme,
    pathPrefix ?? null,
    wantSignedIn ? 1 : 0,
    input.requestedBy,
    input.requestedByTitle ?? null,
    reason ?? null,
    createdAt,
    workspaceId,
  );
  return {
    id,
    hostname,
    includeSubdomains,
    scheme,
    pathPrefix,
    wantSignedIn,
    requestedBy: input.requestedBy,
    requestedByTitle: input.requestedByTitle ?? undefined,
    reason,
    status: 'pending',
    createdAt,
    workspaceId,
  };
}

/** All requests, pending first then most-recently-decided (UI list). */
export function listRequests(): AccessRequest[] {
  return getDb()
    .prepare(
      `SELECT * FROM browser_access_requests
       ORDER BY (status = 'pending') DESC, created_at DESC`,
    )
    .all()
    .map(rowToRequest);
}

/** A single agent's own requests (for browser_list_my_access_requests, §18.3). */
export function listRequestsByAgent(agentId: string): AccessRequest[] {
  return getDb()
    .prepare('SELECT * FROM browser_access_requests WHERE requested_by = ? ORDER BY created_at DESC')
    .all(agentId)
    .map(rowToRequest);
}

export interface DecideRequestResult {
  request: AccessRequest;
  /** The rule created by an approval, or null for a denial. */
  createdRule: AccessRule | null;
}

/**
 * Decide a pending request (§18.4). In a single transaction: flip the request
 * status, and on approve create the real rule via insertRule (trusted code
 * recomputes the canonical rule from the stored normalized fields — the agent
 * cannot smuggle a different effective origin). 'approve' → allow_signed_in 0;
 * 'approve_signed_in' → 1; 'deny' → no rule. Throws if the id is unknown or the
 * request is not pending.
 */
export function decideRequest(
  id: string,
  decision: 'approve' | 'approve_signed_in' | 'deny',
): DecideRequestResult {
  const db = getDb();
  const decidedAt = Date.now();
  const newStatus: AccessRequestStatus = decision === 'deny' ? 'denied' : 'approved';

  const tx = db.transaction((): DecideRequestResult => {
    const row = db.prepare('SELECT * FROM browser_access_requests WHERE id = ?').get(id);
    if (!row) throw new Error(`unknown access request: ${id}`);
    const request = rowToRequest(row);
    if (request.status !== 'pending') {
      throw new Error(`access request ${id} is already ${request.status}`);
    }

    let createdRule: AccessRule | null = null;
    if (decision !== 'deny') {
      createdRule = insertRule({
        hostname: request.hostname,
        includeSubdomains: request.includeSubdomains,
        scheme: request.scheme,
        pathPrefix: request.pathPrefix,
        note: request.reason ? `Requested by ${request.requestedByTitle ?? request.requestedBy}` : undefined,
        allowSignedIn: decision === 'approve_signed_in',
        // Slice-4: the created rule inherits the request's workspace, so a
        // request approved for workspace A authorizes ONLY workspace A's agent.
        workspaceId: request.workspaceId ?? null,
      });
    }

    db.prepare('UPDATE browser_access_requests SET status = ?, decided_at = ? WHERE id = ?').run(
      newStatus,
      decidedAt,
      id,
    );

    return { request: { ...request, status: newStatus, decidedAt }, createdRule };
  });

  return tx();
}
