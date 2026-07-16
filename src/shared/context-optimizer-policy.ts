// context-optimizer-policy.ts — the ONE shared source of truth for context-optimizer
// default-surface + actionability policy. Consumed by BOTH the main-side DTO builders
// (agent-dto.ts / agent-dto-build.ts) and the renderer panel
// (ContextOptimizerPanel.tsx), which each hold a full `ContextOptimizerProposal` (the
// panel over the IPC `ContextOptimizerResult`, the DTO builder pre-projection). This
// module is the UI/MCP PARITY mechanism: neither surface may re-derive "is this
// actionable / is this default-visible" on its own — both call these helpers so the
// dashboard and the MCP tools tell the same story for the same dataset.
//
// Additive layer: it does NOT touch `compiler-parity-gate.ts` or the per-proposal
// `suppressedFromAgentSurface` flag. Gate semantics are preserved — a gate-governed
// unverified proposal stays gate-suppressed. What this layer adds is an INDEPENDENT
// default-surface decision: a material (positive-cost, concrete-target) unverified
// subtract becomes default-visible-with-caveat via `isDefaultVisibleProposal`,
// regardless of its gate state.
//
// PURE — imports ONLY `./types`; no IO, no clocks. There is no `sectionKey`; it is not
// a target field.

import type { ContextOptimizerProposal } from './types';

/** Version of the default-surface / actionability policy encoded in THIS module. Bump
 *  whenever the default-visible or actionable predicates change so the shared
 *  `analysisHealth.policyVersion` an agent reads tracks the rules that produced its page
 *  (WP-1C). String so it can carry a semver-ish tag later without a type change. */
export const CONTEXT_OPTIMIZER_POLICY_VERSION = '1';

/** The two cluster dimensions whose evidence key is a bare hash with NO human-readable
 *  label. A proposal derived from one of these is noise to an agent unless it has been
 *  folded into a rollup summary (`target.rollup`, populated by WP-B2). */
function isHashDimension(dimension: string | undefined): boolean {
  return dimension === 'input_shape_hash' || dimension === 'search_signature_hash';
}

/**
 * Does this proposal derive from a hash-only cluster dimension (input_shape_hash /
 * search_signature_hash) — i.e. its evidence key is a bare hash with no human label?
 * Two signals, either sufficient:
 *   - a populated `target.rollup.dimension` that is a hash dimension (WP-B2 rollups), or
 *   - an `add-cluster:<lane>:<dimension>:<key>` id whose dimension segment is a hash dim
 *     (the individual, pre-rollup cluster proposals emitted by `buildClusterProposals`).
 */
export function derivesFromHashDimension(p: ContextOptimizerProposal): boolean {
  if (p.target.rollup && isHashDimension(p.target.rollup.dimension)) return true;
  const m = /^add-cluster:[^:]+:([^:]+):/.exec(p.id);
  return m != null && isHashDimension(m[1]);
}

/** A concrete, addressable target an agent can act on: an MCP toolset/tool, a skill, or
 *  a file span (absPath + a lineStart). A lane-only target (no locus) is NOT concrete. */
export function proposalHasConcreteTarget(p: ContextOptimizerProposal): boolean {
  const t = p.target;
  return !!(t.mcpToolset || t.mcpToolName || t.skillName || (t.absPath && t.lineStart != null));
}

/** Hash-only: derives from a hash dimension AND has not been folded into a rollup. A
 *  rollup row IS the actionable summary of a hash cluster, so it is NOT hash-only. */
export function proposalIsHashOnly(p: ContextOptimizerProposal): boolean {
  return derivesFromHashDimension(p) && !p.target.rollup;
}

/** The agent-actionable-content predicate that drives the DTO `hasActionableContent`
 *  field and the primary sort key: a concrete target that is not hash-only noise. R2
 *  WP-4B: a hash-only cluster ROLLUP is actionable IFF it has drillable members (the
 *  exemplar drill IS the action); a rollup with nothing to drill is a diagnostic, not an
 *  actionable improvement (spec §3 — hasActionableContent:false). */
export function proposalHasActionableContent(p: ContextOptimizerProposal): boolean {
  if (p.target.rollup) return p.target.rollup.hasDrillableMembers === true;
  return proposalHasConcreteTarget(p) && !proposalIsHashOnly(p);
}

/** A human-readable title/key (not an empty or whitespace-only label). */
function hasHumanReadableLabel(p: ContextOptimizerProposal): boolean {
  return typeof p.title === 'string' && p.title.trim().length > 0;
}

/**
 * Per-kind default-surface policy (P1): should this proposal appear on the DEFAULT
 * (no-flag) page/panel view, even if `suppressedFromAgentSurface` is set? Grouped by
 * lever:
 *   - subtract-*        : a concrete target AND a positive cost (weight or resident delta).
 *   - tune / relocate   : a concrete target AND observed behavior (`occurrence === 'occurs'`).
 *   - add               : not hash-only AND a human-readable title/key
 *                         (NO exemplar dependency in B1).
 */
export function isDefaultVisibleProposal(p: ContextOptimizerProposal): boolean {
  switch (p.lever) {
    case 'subtract':
      return proposalHasConcreteTarget(p)
        && (p.tokenTurnsWeight > 0 || p.residentTokenDelta.estimate > 0);
    case 'tune':
    case 'relocate':
      return proposalHasConcreteTarget(p) && p.occurrence === 'occurs';
    case 'add':
      return !proposalIsHashOnly(p) && hasHumanReadableLabel(p);
    default:
      return false;
  }
}

/**
 * The DEFAULT-surface membership test that BOTH the MCP DTO list filter
 * (`buildProposalsPage`) and the dashboard panel default view use: a proposal is
 * surfaced by default unless it is gate-suppressed AND not otherwise made
 * default-visible by policy. This one predicate is the UI/MCP parity contract — the
 * panel's default-visible set must equal the DTO's default-visible set for any dataset.
 */
export function isProposalDefaultSurfaced(p: ContextOptimizerProposal): boolean {
  return !p.suppressedFromAgentSurface || isDefaultVisibleProposal(p);
}
