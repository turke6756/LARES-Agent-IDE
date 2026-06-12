// WP0.1 (plans/embedded-browser-implementation-tasks.md) — M1 API auth
// primitives (plans/embedded-browser-safety-deepdive.md §3 M1).
//
// The dashboard HTTP API is RCE-equivalent (kernel exec, PTY keystrokes,
// agent launch) and binds 0.0.0.0 so WSL agents can reach it via the Windows
// gateway IP. The per-launch bearer token — NOT the bind scope — is the
// security gate. Everything here is pure Node (no Electron) so it can be
// unit-tested with the compiled-node runner.

import crypto from 'crypto';

let token: string | null = null;

/** Crypto-random per-launch API token. Minted lazily on first call and
 *  stable for the process lifetime — every distribution path (ApiServer
 *  gate, supervisor env injection, system:get-api-token IPC) shares it. */
export function getApiToken(): string {
  if (!token) token = crypto.randomBytes(32).toString('base64url');
  return token;
}

/** Dashboard's own renderer origins ('null' = file:// in prod) + Vite dev ports. */
const ALLOWED_ORIGINS = new Set<string>([
  'null', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175',
]);

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true; // headless Node MCP/proxy scripts send no Origin
  return ALLOWED_ORIGINS.has(origin);
}

/** Constant-time check of an `Authorization: Bearer <token>` header value.
 *  Fail closed: missing header, wrong scheme, or mismatch → false. */
export function isAuthorized(authorizationHeader: string | undefined, expectedToken: string): boolean {
  if (typeof authorizationHeader !== 'string') return false;
  const prefix = 'Bearer ';
  if (!authorizationHeader.startsWith(prefix)) return false;
  const presented = Buffer.from(authorizationHeader.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  if (presented.length !== expected.length) return false;
  return crypto.timingSafeEqual(presented, expected);
}

export type ApiAccessDecision =
  /** OPTIONS from an allowed origin → 204, echo corsOrigin (never `*`). */
  | { kind: 'preflight'; corsOrigin: string | undefined }
  /** Disallowed Origin header → 403, no CORS headers. */
  | { kind: 'forbidden-origin' }
  /** Origin fine but bearer token missing/wrong → 401. */
  | { kind: 'unauthorized'; corsOrigin: string | undefined }
  /** Authenticated request → route it; echo corsOrigin when a browser sent one. */
  | { kind: 'ok'; corsOrigin: string | undefined };

/** The whole request-admission decision (M1 + M8 CORS), as a pure function so
 *  the policy is machine-checkable without Electron or sockets. Order is the
 *  spec's: preflight short-circuit → origin allowlist → bearer gate. */
export function decideApiAccess(
  method: string,
  origin: string | undefined,
  authorization: string | undefined,
  expectedToken: string,
): ApiAccessDecision {
  const originAllowed = isAllowedOrigin(origin);
  // Echo the origin back only when a browser sent one AND it's allowlisted.
  // Headless Node clients (no Origin) need no CORS headers at all.
  const corsOrigin = origin !== undefined && originAllowed ? origin : undefined;
  if (method === 'OPTIONS') {
    // Preflights carry no Authorization by design; the actual request is
    // still bearer-gated. Disallowed origins don't even get the preflight.
    return originAllowed ? { kind: 'preflight', corsOrigin } : { kind: 'forbidden-origin' };
  }
  if (!originAllowed) return { kind: 'forbidden-origin' };
  if (!isAuthorized(authorization, expectedToken)) return { kind: 'unauthorized', corsOrigin };
  return { kind: 'ok', corsOrigin };
}
