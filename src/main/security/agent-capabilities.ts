// WP-G2.0 (plans/git-native-implementation-v2.md — Per-agent capability tokens;
// plans/capability-token-regression.md) — in-process capability store.
//
// The shared global bearer (`getApiToken`) is admission-only: any holder is
// admitted, and it binds no identity, so a worker holding it can forge
// `X-Supervisor-Id`. This store mints a per-agent capability token whose
// server-side claims { agentId, workspaceId, privilegeLane } record WHO the
// caller is. The token is injected into that agent's dashboard `--mcp-config`
// (see buildDashboardMcpConfigForLane) in place of the global bearer.
//
// SECURITY (mirrors the bearer's on-disk prohibition):
//   - Tokens are high-entropy secrets (256-bit, base64url), minted server-side.
//   - Claims are minted from AUTHORITATIVE persisted lane state (roleLaneOf /
//     agent record), NEVER from caller input.
//   - Everything lives ONLY in the in-process Maps below — never persisted to
//     disk, never logged. There is no serialization path off this object.
//   - Route-level authorization (rejecting the global bearer on checkpoint
//     routes, requiring a supervisor claim, X-Supervisor-Id == claim.agentId)
//     is WP-G2.1, NOT here. This module only mints/rotates/revokes and resolves
//     a presented token back to its claim for the admission gate.
//
// Pure Node (crypto + Map, no Electron) so it can be unit-tested with the
// compiled-node runner, exactly like api-auth.ts.

import crypto from 'crypto';
import type { AgentRoleLane } from '../../shared/types';

/** The server-side claims bound to a minted capability token. `privilegeLane`
 *  is the agent's AUTHORITATIVE role-lane at launch (roleLaneOf), never
 *  anything the caller asserted. */
export interface CapabilityClaim {
  agentId: string;
  workspaceId: string;
  privilegeLane: AgentRoleLane;
}

/** In-process, per-agent capability-token store. One live token per agent id;
 *  minting again for the same agent ROTATES (revokes the prior token). */
export class AgentCapabilityStore {
  /** token → claim. The token is the map key; lookup is the resolve path. */
  private readonly claimByToken = new Map<string, CapabilityClaim>();
  /** agentId → its current live token, for rotation + revocation by agent. */
  private readonly tokenByAgent = new Map<string, string>();

  /** Mint (or ROTATE) the capability token for an agent. Any prior token for
   *  the same agent is revoked first so a relaunch never leaves a stale token
   *  resolvable. The claim is copied so a later caller mutation can't reach
   *  stored state. Returns the new high-entropy token. */
  mint(claim: CapabilityClaim): string {
    if (!claim.agentId) throw new Error('capability mint requires a non-empty agentId');
    this.revokeAgent(claim.agentId); // rotation: drop the prior token, if any
    const token = crypto.randomBytes(32).toString('base64url');
    this.claimByToken.set(token, { ...claim });
    this.tokenByAgent.set(claim.agentId, token);
    return token;
  }

  /** Resolve a presented token to its claim, or null if it is not a live
   *  capability token. Returns a COPY so callers can't mutate stored claims.
   *  A falsy/empty token never resolves. */
  resolve(token: string | undefined | null): CapabilityClaim | null {
    if (!token) return null;
    const claim = this.claimByToken.get(token);
    return claim ? { ...claim } : null;
  }

  /** Revoke the current token for an agent (stop/delete). Idempotent — returns
   *  true if a token was actually removed, false if the agent had none. */
  revokeAgent(agentId: string): boolean {
    const existing = this.tokenByAgent.get(agentId);
    if (existing === undefined) return false;
    this.claimByToken.delete(existing);
    this.tokenByAgent.delete(agentId);
    return true;
  }

  /** The current live token for an agent, or undefined. Test/diagnostic aid;
   *  production code holds the token from `mint`. */
  tokenForAgent(agentId: string): string | undefined {
    return this.tokenByAgent.get(agentId);
  }

  /** Number of live tokens. Test/diagnostic aid. */
  size(): number {
    return this.claimByToken.size;
  }

  /** Drop all tokens. Test aid — production never wholesale-clears. */
  clear(): void {
    this.claimByToken.clear();
    this.tokenByAgent.clear();
  }
}

/** Process-wide singleton, mirroring `getApiToken`'s module-level state. Every
 *  distribution path (the MCP-config injection at launch, the admission gate's
 *  capability resolution) shares this one instance. */
export const agentCapabilities = new AgentCapabilityStore();
