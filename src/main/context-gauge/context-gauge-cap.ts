// Context Window Warning — per-role gauge-cap resolution.
//
// PURE module (no electron import) so the log-readers and their tests can use
// it directly. The persisted-settings side lives in context-gauge-settings.ts;
// production wires the two together in src/main/index.ts via
// setContextGaugeCapResolver. Until (or unless) a resolver is installed, every
// lookup answers the historical CONTEXT_GAUGE_CAP_TOKENS (200K), so nothing
// changes for tests or a partially-wired boot.

import {
  CONTEXT_GAUGE_CAP_TOKENS,
  CONTEXT_GAUGE_CAP_MIN_TOKENS,
  CONTEXT_GAUGE_CAP_MAX_TOKENS,
} from '../../shared/constants';
import type { ContextGaugeRoleKey, ContextGaugeSettings } from '../../shared/types';

/** Clamp a configured cap into the legal slider range; anything non-numeric
 *  falls back to the 200K default. A corrupt settings file must never be able
 *  to zero (or explode) the gauge denominator. */
export function clampGaugeCap(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return CONTEXT_GAUGE_CAP_TOKENS;
  return Math.min(CONTEXT_GAUGE_CAP_MAX_TOKENS, Math.max(CONTEXT_GAUGE_CAP_MIN_TOKENS, Math.round(value)));
}

/** Pure lookup: role key → configured cap. Unknown persona names (and the
 *  absent role of an internally-synthesized reader session) fall back to the
 *  default 200K cap — the pre-feature behavior. */
export function capForRoleKey(
  settings: ContextGaugeSettings,
  roleKey: ContextGaugeRoleKey | undefined,
): number {
  if (!roleKey) return CONTEXT_GAUGE_CAP_TOKENS;
  const caps = settings.contextWindowCaps;
  if (roleKey.startsWith('persona:')) {
    const name = roleKey.slice('persona:'.length);
    return clampGaugeCap(caps.personas[name] ?? CONTEXT_GAUGE_CAP_TOKENS);
  }
  return clampGaugeCap(caps[roleKey as 'worker' | 'supervisor' | 'researcher']);
}

/**
 * Classify an agent into its gauge-cap role key.
 *
 * Precedence mirrors the launch-time role knowledge: the structural
 * supervisor flag, then the researcher lane, then a custom persona (cwd under
 * `<state-dir>/agents/<name>/` — the same layout match getEffectiveWorkspaceRoot
 * already relies on), else worker. NOTE this is a ROLE classification, not an
 * agent identity: every agent launched from one persona folder shares that
 * persona's cap by design, so the shared-cwd invariant (CLAUDE.md) is not
 * violated — no per-agent state is keyed off the cwd here.
 */
export function contextGaugeRoleKeyOf(agent: {
  isSupervisor?: boolean;
  isResearcher?: boolean;
  privilegeLane?: 'supervisor';
  workingDirectory: string;
}): ContextGaugeRoleKey {
  if (agent.isSupervisor) return 'supervisor';
  if (agent.isResearcher) return 'researcher';
  const wd = agent.workingDirectory;
  // .lares/agents/<name>, legacy .dashboard/agents/<name>, or the pre-relocation
  // .claude/agents/<name> layout still carried by old persisted rows.
  const m =
    wd.match(/[/\\]\.(?:lares|dashboard|claude)[/\\]agents[/\\]([^/\\]+)[/\\]?$/);
  if (m) return `persona:${m[1]}`;
  // A persona elevated to the supervisor PRIVILEGE lane but not launched from a
  // persona dir (defensive — normally the cwd match above wins) reads the
  // supervisor cap; everything else is the worker/default row.
  if (agent.privilegeLane === 'supervisor') return 'supervisor';
  return 'worker';
}

// ── Injectable live resolver (readers → current settings) ────────────────────

export type ContextGaugeCapResolver = (roleKey: ContextGaugeRoleKey | undefined) => number;

let resolver: ContextGaugeCapResolver | null = null;

/** Install the production resolver (settings-backed). Pass null to restore the
 *  flat 200K default (tests). */
export function setContextGaugeCapResolver(fn: ContextGaugeCapResolver | null): void {
  resolver = fn;
}

/** The cap the readers apply at window-resolution time. Callers take
 *  `min(model window, resolveContextGaugeCap(role))`, so a configured cap can
 *  never exceed the model's real window. */
export function resolveContextGaugeCap(roleKey: ContextGaugeRoleKey | undefined): number {
  if (!resolver) return CONTEXT_GAUGE_CAP_TOKENS;
  return clampGaugeCap(resolver(roleKey));
}
