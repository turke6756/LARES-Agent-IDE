// WP0.1 (plans/embedded-browser-implementation-tasks.md) — M1 API auth
// primitives (plans/embedded-browser-safety-deepdive.md §3 M1).
//
// The dashboard HTTP API is RCE-equivalent (kernel exec, PTY keystrokes,
// agent launch) and binds 0.0.0.0 so WSL agents can reach it via the Windows
// gateway IP. The per-launch bearer token — NOT the bind scope — is the
// security gate. Everything here is pure Node (no Electron) so it can be
// unit-tested with the compiled-node runner.

import crypto from 'crypto';
import { agentCapabilities, type CapabilityClaim } from './agent-capabilities';

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
  /** Authenticated request → route it; echo corsOrigin when a browser sent one.
   *  `capability` is set ONLY when admission came via a minted per-agent
   *  capability token (WP-G2.0); it is absent for the global bearer. It carries
   *  the caller's server-side claim for routes that CHOOSE to check it — it does
   *  NOT change admission scope (a capability is admitted exactly like the global
   *  bearer). Routes that ignore `capability` are unaffected, so a claimed
   *  privilege can never leak into a route that does not consult it. */
  | { kind: 'ok'; corsOrigin: string | undefined; capability?: CapabilityClaim };

/** Extract the token value from an `Authorization: Bearer <token>` header, or
 *  null if the header is missing / not a Bearer header. */
function bearerValue(authorization: string | undefined): string | null {
  if (typeof authorization !== 'string') return null;
  const prefix = 'Bearer ';
  return authorization.startsWith(prefix) ? authorization.slice(prefix.length) : null;
}

/** The whole request-admission decision (M1 + M8 CORS), as a pure function so
 *  the policy is machine-checkable without Electron or sockets. Order is the
 *  spec's: preflight short-circuit → origin allowlist → bearer gate.
 *
 *  WP-G2.0: after the global-bearer check, a token that resolves in the capability
 *  store is ALSO admitted (with its claim attached). Admission is additive — a
 *  minted token grants exactly the global bearer's access; per-route authorization
 *  stays separate (WP-G2.1). `resolveCapability` is injectable for deterministic
 *  unit tests; it defaults to the process-wide capability store. */
export function decideApiAccess(
  method: string,
  origin: string | undefined,
  authorization: string | undefined,
  expectedToken: string,
  resolveCapability?: (token: string) => CapabilityClaim | null,
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
  // Global bearer: admission-only, no claim (unchanged legacy behavior).
  if (isAuthorized(authorization, expectedToken)) return { kind: 'ok', corsOrigin };
  // Capability token: admitted with its claim attached. Falls through to the
  // global-bearer check first so the bearer path is byte-for-byte unchanged.
  const presented = bearerValue(authorization);
  if (presented) {
    const resolver = resolveCapability ?? ((t) => agentCapabilities.resolve(t));
    const claim = resolver(presented);
    if (claim) return { kind: 'ok', corsOrigin, capability: claim };
  }
  return { kind: 'unauthorized', corsOrigin };
}
