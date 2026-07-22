// recommendation-draft.ts — WP3 (G3) friction → recommendation chain, joinable
// evidence only.
//
// Constructs the `RecommendationDraft` attached to ADD proposals. Every honesty
// boundary is a CODE-LEVEL check at construction (throwing `RecommendationDraftError`),
// not a convention:
//
//   1. CLAIMS are rendered from deterministic templates. Every substituted slot
//      mechanically cites a row id that must appear in the draft's evidence; a
//      denylist of causal tokens ("because", "in order to", "so that") rejects any
//      claim/bullet that smuggles causal or intent language in.
//   2. EVIDENCE entries are `{ kind, rowIds, generationId }` ONLY — same-surface
//      (optimizer) rows joined by generationId + row ids. Cross-surface evidence
//      REMAINS barred at construction (WP8 landed surface provenance and stamps a
//      v2-optional `comparabilityKey` onto each stored evidence entry at snapshot
//      time — analytics-exporter.ts stampRecommendationEvidenceComparability —
//      but that stamp does NOT lift this bar; it is the key any future
//      cross-surface join would have to match).
//   3. `command_family` evidence may only support WORKSPACE-LEVEL candidates
//      (`target.unresolved`) — attaching it to a specific file throws, UNLESS the
//      caller supplies a WP9 `associatedCommandFamilies` join entry for that exact
//      file, from the SAME analysis generation, meeting the WP9 minimum stream
//      support. The generationId equality makes the lift PROSPECTIVE ONLY: a draft
//      from an older generation can never retroactively gain the join.
//   4. TARGET-SELECTION consumes WP2 `GuidanceSource.audienceProviders`: a file
//      target only when the observing cohort's audience maps to exactly ONE
//      applicable guidance source; ambiguous/unknown → `{ unresolved, reason }`.
//      There is NO CLAUDE.md default anywhere in this module.
//   5. `humanReviewRequired` is the literal `true` on every draft.
//
// Pure. No IO, no clocks, no DB.

import type {
  GuidanceSource,
  RecommendationDraft,
  RecommendationEvidence,
  RecommendationEvidenceKind,
  RecommendationTarget,
} from '../../shared/types';
import { appliesToAgent } from '../context-overhead/guidance-sources';
import type { CoverageChecks } from './file-coverage';
import {
  FILE_SEQUENCES_MIN_SUPPORT_STREAMS,
  type AssociatedCommandFamilyV1,
} from './behavior-sequences';

// ─────────────────────────────────────────────────────────────────────────────
// Errors + denylist
// ─────────────────────────────────────────────────────────────────────────────

export class RecommendationDraftError extends Error {
  constructor(message: string) {
    super(`recommendation-draft: ${message}`);
    this.name = 'RecommendationDraftError';
  }
}

/** Causal/intent tokens NEVER allowed in a generated claim or bullet (test-enforced). */
export const CAUSAL_TOKEN_DENYLIST = ['because', 'in order to', 'so that'] as const;

/** The ONLY surface a draft's evidence may cite until WP8 provenance exists. */
export const RECOMMENDATION_EVIDENCE_SURFACE = 'optimizer';

/** Return the first denied causal token found in `text` (word-boundary,
 *  case-insensitive), or null when clean. */
export function findCausalToken(text: string): string | null {
  const lower = text.toLowerCase();
  for (const token of CAUSAL_TOKEN_DENYLIST) {
    const re = new RegExp(`(^|[^a-z])${token.replace(/ /g, '[\\s]+')}([^a-z]|$)`);
    if (re.test(lower)) return token;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim templates — every substituted slot mechanically cites a row
// ─────────────────────────────────────────────────────────────────────────────

export interface ClaimSlot {
  value: string | number;
  /** The evidence row this slot's value comes from — MUST appear in the draft's
   *  evidence rowIds (mechanical citation, checked at construction). */
  citedRowId: string;
}

export interface ClaimTemplate {
  /** `{slotName}` placeholders only; no free interpolation. */
  template: string;
  slots: Record<string, ClaimSlot>;
}

/** Render a template, enforcing: every placeholder has a slot, every slot cites a
 *  row present in `citableRowIds`, and no placeholder survives unreplaced. */
export function renderClaim(t: ClaimTemplate, citableRowIds: ReadonlySet<string>): string {
  let out = t.template;
  for (const [name, slot] of Object.entries(t.slots)) {
    if (!citableRowIds.has(slot.citedRowId)) {
      throw new RecommendationDraftError(
        `claim slot '${name}' cites row '${slot.citedRowId}', which is not in the draft's evidence rowIds`);
    }
    if (!out.includes(`{${name}}`)) {
      throw new RecommendationDraftError(`claim slot '${name}' has no {${name}} placeholder in the template`);
    }
    out = out.split(`{${name}}`).join(String(slot.value));
  }
  const leftover = /\{[a-zA-Z0-9_-]+\}/.exec(out);
  if (leftover) {
    throw new RecommendationDraftError(`claim template placeholder '${leftover[0]}' has no slot`);
  }
  return out;
}

/** WP3 point 1/2 — the deterministic claim for a hot uncovered file: file heat +
 *  bounded coverage-check summary. Descriptive only; no causal verbs. */
export function hotUncoveredClaimTemplate(row: {
  pathDisplay: string;
  pathHash: string;
  reads: number;
  writes: number;
  executes: number;
  distinctStreams: number;
  coverageChecks: CoverageChecks;
}): ClaimTemplate {
  return {
    template:
      'Agents touched {path} across {streams} stream(s) ({reads} reads, {writes} writes, '
      + '{executes} executes); {tested} guidance path prediction(s) were tested against it and '
      + '{matched} matched.',
    slots: {
      path: { value: row.pathDisplay, citedRowId: row.pathHash },
      streams: { value: row.distinctStreams, citedRowId: row.pathHash },
      reads: { value: row.reads, citedRowId: row.pathHash },
      writes: { value: row.writes, citedRowId: row.pathHash },
      executes: { value: row.executes, citedRowId: row.pathHash },
      tested: { value: row.coverageChecks.totalPredicatesTested, citedRowId: row.pathHash },
      matched: { value: row.coverageChecks.matched, citedRowId: row.pathHash },
    },
  };
}

/** WP3 point 2 — the deterministic claim for a workspace-level command-family
 *  candidate. Workspace-level ONLY (the file-target bar is code-enforced). */
export function commandFamilyClaimTemplate(c: {
  family: string;
  count: number;
  distinctStreams: number;
  /** The optimizer-surface row (the cluster proposal id) this claim cites. */
  rowId: string;
}): ClaimTemplate {
  return {
    template:
      "The command family '{family}' ran {count} time(s) across {streams} stream(s); "
      + 'no guidance node covers it.',
    slots: {
      family: { value: c.family, citedRowId: c.rowId },
      count: { value: c.count, citedRowId: c.rowId },
      streams: { value: c.distinctStreams, citedRowId: c.rowId },
    },
  };
}

/** Optional deterministic bullet for a hot-uncovered draft. Template output only. */
export function hotUncoveredSuggestedBullet(row: { pathDisplay: string; distinctStreams: number }): string {
  return `- \`${row.pathDisplay}\` is repeatedly touched (${row.distinctStreams} stream(s)) and no guidance covers it — document its workflow after human review.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Target-selection policy (WP3 point 3) — consumes WP2 audienceProviders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Choose the guidance-file target for a recommendation. A FILE target is returned
 * ONLY when the observing cohort's provider audience maps to exactly one applicable
 * `GuidanceSource` (WP2 `audienceProviders` membership via `appliesToAgent`, which
 * also excludes `inventory-only` files and `'unknown'` audiences). Every other case
 * — no inventory, no attributed provider, a provider with no applicable source, no
 * single source covering the whole cohort, or more than one — is
 * `{ unresolved, reason }`. NEVER a CLAUDE.md default.
 */
export function selectRecommendationTarget(input: {
  guidanceSources?: GuidanceSource[];
  observingProviders?: string[];
}): RecommendationTarget {
  const providers = [...new Set((input.observingProviders ?? []).filter(Boolean))].sort();
  if (providers.length === 0) {
    return { unresolved: true, reason: 'observing cohort has no attributed provider — audience mapping is unknown' };
  }
  const sources = input.guidanceSources ?? [];
  if (sources.length === 0) {
    return { unresolved: true, reason: 'no guidance-source inventory available for the observing cohort' };
  }

  // Applicable-to-the-whole-cohort = applies to EVERY observing provider.
  let intersection: GuidanceSource[] | null = null;
  for (const provider of providers) {
    const applicable = sources.filter((s) => appliesToAgent(s, provider));
    if (applicable.length === 0) {
      return { unresolved: true, reason: `no applicable guidance source for provider '${provider}'` };
    }
    intersection = intersection === null
      ? applicable
      : intersection.filter((s) => applicable.some((a) => a.path === s.path));
  }
  const paths = [...new Set((intersection ?? []).map((s) => s.path))].sort();
  if (paths.length === 0) {
    return { unresolved: true, reason: `no single guidance source is applicable to every observing provider (${providers.join(', ')})` };
  }
  if (paths.length > 1) {
    return { unresolved: true, reason: `ambiguous: ${paths.length} guidance sources apply to the observing cohort` };
  }
  return { file: paths[0] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction — every bar is a code-level check
// ─────────────────────────────────────────────────────────────────────────────

/** Evidence INPUT carries a `surface` tag the constructor verifies and strips —
 *  the stored entry is `{ kind, rowIds, generationId }` only. */
export interface RecommendationEvidenceInput {
  kind: RecommendationEvidenceKind;
  rowIds: string[];
  generationId: string;
  /** Which surface the rows live on. MUST be `'optimizer'` (cross-surface barred
   *  at construction until WP8). */
  surface: string;
}

export interface BuildRecommendationDraftInput {
  target: RecommendationTarget;
  claimTemplate: ClaimTemplate;
  evidence: RecommendationEvidenceInput[];
  /** The analysis-generation id every evidence entry must carry (the join key). */
  generationId: string;
  suggestedBulletText?: string;
  /** WP9 — the ONLY thing that can lift the command_family file-target bar: the
   *  `associatedCommandFamilies` join entries (behavior-sequences.ts) recorded
   *  for THIS analysis generation. A file target with command_family evidence is
   *  accepted iff ≥1 entry names exactly `target.file`, carries the draft's own
   *  `generationId` (prospective only — an older draft's generation can never
   *  match), and meets `FILE_SEQUENCES_MIN_SUPPORT_STREAMS`. */
  associatedCommandFamilies?: AssociatedCommandFamilyV1[];
}

export function targetIsFile(t: RecommendationTarget): t is { file: string; section?: string } {
  return (t as { file?: unknown }).file !== undefined && !(t as { unresolved?: unknown }).unresolved;
}

/** Path equality for the WP9 lift: association paths are stored normalized
 *  (LOWER, from behavior_events.arg_path); compare separator- and case-folded. */
function sequencePathsEqual(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * WP9 (milestone gate 5) — does a recorded `associatedCommandFamilies` join lift
 * the command_family file-target bar for `file` under `generationId`? True iff
 * ≥1 entry names exactly that file, carries EXACTLY that generation
 * (generationId-gated → prospective only), and meets the WP9 minimum stream
 * support. Anything less keeps the bar (fail-closed).
 */
export function associationLiftsCommandFamilyBar(
  associations: AssociatedCommandFamilyV1[] | undefined,
  file: string,
  generationId: string,
): boolean {
  return (associations ?? []).some((a) =>
    a.generationId === generationId
    && a.streamsSupporting >= FILE_SEQUENCES_MIN_SUPPORT_STREAMS
    && sequencePathsEqual(a.path, file));
}

export function buildRecommendationDraft(input: BuildRecommendationDraftInput): RecommendationDraft {
  if (input.evidence.length === 0) {
    throw new RecommendationDraftError('a draft requires at least one evidence entry (no claim without a recorded join)');
  }
  for (const ev of input.evidence) {
    // (2) Same-surface only — cross-surface evidence barred until WP8 exists.
    if (ev.surface !== RECOMMENDATION_EVIDENCE_SURFACE) {
      throw new RecommendationDraftError(
        `cross-surface evidence ('${ev.surface}') is barred at construction until WP8 surface provenance exists`);
    }
    // Same-generation join — evidence from another generation is not joinable.
    if (ev.generationId !== input.generationId) {
      throw new RecommendationDraftError(
        `evidence generationId '${ev.generationId}' does not match the draft's analysis generation '${input.generationId}'`);
    }
    if (ev.rowIds.length === 0) {
      throw new RecommendationDraftError(`a '${ev.kind}' evidence entry cites no rows`);
    }
    // (3) command_family evidence supports workspace-level candidates ONLY —
    // unless a WP9 associatedCommandFamilies join entry for exactly this file,
    // this generation (prospective only), at ≥ min stream support, lifts the bar.
    if (ev.kind === 'command_family' && targetIsFile(input.target)
      && !associationLiftsCommandFamilyBar(
        input.associatedCommandFamilies, input.target.file, input.generationId)) {
      throw new RecommendationDraftError(
        'command_family evidence may only support workspace-level candidates (target.unresolved) — '
        + "a file target is liftable only by WP9's associatedCommandFamilies join "
        + `(same generationId, streamsSupporting ≥ ${FILE_SEQUENCES_MIN_SUPPORT_STREAMS}, `
        + 'path matching the target file)');
    }
  }

  // (1) Template-constrained claim: every slot cites an evidence row; denylist enforced.
  const citable = new Set(input.evidence.flatMap((e) => e.rowIds));
  const claim = renderClaim(input.claimTemplate, citable);
  const badClaim = findCausalToken(claim);
  if (badClaim) {
    throw new RecommendationDraftError(`claim contains the denied causal token '${badClaim}'`);
  }
  if (input.suggestedBulletText !== undefined) {
    const badBullet = findCausalToken(input.suggestedBulletText);
    if (badBullet) {
      throw new RecommendationDraftError(`suggestedBulletText contains the denied causal token '${badBullet}'`);
    }
  }

  const evidence: RecommendationEvidence[] = input.evidence.map((e) => ({
    kind: e.kind,
    rowIds: [...e.rowIds],
    generationId: e.generationId,
  }));

  return {
    target: input.target,
    claim,
    evidence,
    ...(input.suggestedBulletText !== undefined ? { suggestedBulletText: input.suggestedBulletText } : {}),
    humanReviewRequired: true,
  };
}
