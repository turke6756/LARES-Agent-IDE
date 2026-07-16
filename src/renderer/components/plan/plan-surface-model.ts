// WP5 — plan surface view-model (pure, framework-free, unit-tested).
//
// The disclosure-tier UI (C7 tiers 1–2) and the trusted/claimed visual grammar
// (R2 §2.6) are driven entirely by these pure functions so the React components
// stay thin and the security-load-bearing rules — claimed is NEVER merged into
// trusted; orphan events are NEVER dropped; a parse error ALWAYS surfaces a
// banner — are testable without a DOM.
//
// Tier 1 = the collapsed section chip (count + last-activity). Tier 2 = the
// per-agent activity rows split into a TRUSTED roll-up (resolver-attributed:
// observed_via + confidence) and a visually distinct CLAIMED payload (the
// agent's self-report, diagnostics-only). Tier 3 (full log) is deferred.

import type { RepoActivityDigest, RepoActivityDetail } from '../../../shared/types';

export type { RepoActivityDigest, RepoActivityDetail } from '../../../shared/types';

// ── provenance vocabulary (mirrors src/main/plans/plan-events.ts §2.6) ─────────

export type AttributionConfidence = 'high' | 'medium' | 'low';

export type ObservedVia =
  | 'edit-target'
  | 'fs-diff'
  | 'diff∩intent'
  | 'multi-section'
  | 'intent-only'
  | 'dispatched-fallback';

export type MismatchReason =
  | 'intent-effect-divergence'
  | 'dispatch-drift'
  | 'multi-section'
  | null;

/** A live section as served by `read_plan_projection` (tier-1 orient). */
export interface PlanSectionView {
  anchor: string | null;
  heading: string | null;
  zone: string | null;
  archived: boolean;
  eventCount: number;
  lastEventAt: string | null;
  /** GT-A WP-A3.1 — the reshaped rollup's write/presence split, plumbed straight
   *  from the projection payload (`buildPlanActivityProjection`). `writeCount` = turns
   *  that actually wrote this section (fanned across every written anchor, D-4/D-6);
   *  `presenceCount` = no-op deliberation turns keyed to this section. Optional so a
   *  pre-A2.3 projection (or a hand-built section) still type-checks. */
  writeCount?: number;
  presenceCount?: number;
  /** Fix-4 §6 — witnessed per-section repo rollup, plumbed straight from the
   *  projection's `PlanActivitySection` (server-computed `getPlanEventRollup`
   *  fan-out, I-8). Optional so a pre-fix-4 projection still type-checks (treated
   *  as `0`). tests/commit fields are inert in cut 1 but carried for forward-compat. */
  repoFilesRead?: number;
  repoFilesEdited?: number;
  repoFilesCreated?: number;
  testsRun?: number;
  testsPassed?: number;
  testsFailed?: number;
  lastCommit?: string | null;
}

/** One trusted `plan_events` row + its (kept-separate) claimed self-report. */
export interface PlanEventView {
  id: string;
  agentId: string;
  agentTitle?: string | null;
  createdAt: string;
  /** Resolver winner — the section this activity attaches to (derived). */
  observedSectionAnchor: string | null;
  /** Frozen launch fact (trusted). */
  dispatchedSectionAnchor: string | null;
  observedVia: ObservedVia | null;
  attributionConfidence: AttributionConfidence | null;
  sectionMismatch: boolean;
  mismatchReason: MismatchReason;
  /** From the sentinel — CLAIMED, diagnostics-only, never drives the join. */
  claimedSectionAnchor?: string | null;
  /** Arbitrary self-reported payload — rendered distinctly, never trusted. */
  claimedPayload?: Record<string, unknown> | null;
  /** GT-C §3.2 — RAW fs-diff change cardinality (mirrors the DB `change_count`).
   *  Drives the write-vs-presence split (I-3); `0` = a no-op deliberation turn.
   *  Data-plumbing only in Wave 6a — the write/presence classifiers + sidebar
   *  render land in Wave 6c. */
  changeCount: number;
  /** GT-C §3.2 — the resolver's audit candidate list; feeds the "spanned N sections"
   *  hint (render side of I-2) until GT-A's roll-up fan-out lands. */
  observedCandidates?: string[];
  /** GT-A WP-A3.1 — the turn's EFFECT set (anchors it actually wrote, `uniq(changed)`;
   *  mirrors the DB `written_section_anchors_json`). Empty = presence/no-op turn. Drives
   *  the fan-out in `groupEventsBySection` (each write turn appears under EVERY written
   *  section, fixing I-2) and the "wrote N sections" affordance (D-5: length, NOT
   *  `changeCount`). Optional so a pre-A2.2 render row still type-checks (treated as `[]`). */
  writtenSectionAnchors?: string[];
  /** Fix-4 §6 (Tier-2) — the witnessed repo-activity digest for this turn: COUNTS
   *  ONLY (no file list), as `toTier2Digest` serves it. `null`/absent = pre-fix-4 /
   *  not captured. The capped file list is fetched on-expand at Tier-3 via
   *  `onFetchEventDetail`, never carried here. */
  repoActivityDigest?: RepoActivityDigest | null;
}

/** The projection envelope WP4 serves (F-E degradation fields included). */
export interface PlanProjectionView {
  parseError: string | null;
  warnings: string[];
  /** Which fallback the served projection came from, when degraded. */
  degradedFrom?: 'memory' | 'snapshot' | 'empty' | null;
}

// ── the synthetic "Archived section" identity (F-E) ────────────────────────────

/** Sentinel anchor for the group that collects orphan events — those whose
 *  observed anchor points at an archived or now-absent section. Never a real
 *  `sec_` anchor, so it can't collide with a live section. */
export const ARCHIVED_GROUP_ANCHOR = '__archived__';
export const ARCHIVED_GROUP_HEADING = 'Archived section';

/** Stable DOM id for a section group, so the side nav can scroll-to it. Anchors
 *  are `sec_…` / `blk_…` / the archived sentinel — all safe id fragments. */
export function sectionDomId(anchor: string): string {
  return `plan-section-${anchor}`;
}

// ── tier-1: section grouping ───────────────────────────────────────────────────

export interface SectionGroup {
  anchor: string;
  heading: string;
  zone: string | null;
  archived: boolean;
  /** Every event bucketed here (writes + presence), in stream order. */
  events: PlanEventView[];
  /** GT-A WP-A3.3 — the write/presence split. Presence rows collapse into one
   *  muted line and never interleave with writes (fixes I-3). */
  writeEvents: PlanEventView[];
  presenceEvents: PlanEventView[];
  writeCount: number;
  presenceCount: number;
  eventCount: number;
  lastEventAt: string | null;
  /** Fix-4 §6 — witnessed repo counts for the section chip, carried verbatim from
   *  the source `PlanSectionView` (server-computed rollup, I-8). The synthetic
   *  Archived group has no section rollup, so these stay `0` there. */
  repoFilesRead: number;
  repoFilesEdited: number;
  repoFilesCreated: number;
}

// ── write-vs-presence classification (GT-A A3.3 + GT-C §3.2) ───────────────────

/** GT-C §3.2 — a "write" turn actually mutated the file (`change_count > 0`); a
 *  presence turn (`0`) is a no-op deliberation/review turn. Equivalent in practice
 *  to `writtenSectionAnchors.length > 0` (both derive from the same fs-diff), but
 *  keyed on the raw cardinality per the GT-C spec. */
export function isWrite(ev: PlanEventView): boolean {
  return ev.changeCount > 0;
}

/** GT-A A3.3 — the authoritative write/presence classifier for the section split.
 *  Keyed on the EFFECT set (`writtenSectionAnchors`), so it stays consistent with
 *  the fan-out in `groupEventsBySection`. */
export function classifyEvent(ev: PlanEventView): 'write' | 'presence' {
  return (ev.writtenSectionAnchors?.length ?? 0) > 0 ? 'write' : 'presence';
}

/** GT-C §3.2 — the claim-first headline datum: the agent's self-reported status /
 *  result / next, string-coerced from the claimed payload (else nulls). Diagnostics
 *  only — never trusted, never merged into attribution. */
export interface ClaimHeadline {
  status: string | null;
  result: string | null;
  next: string | null;
}

function coerceClaimStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : String(v);
}

export function toClaimHeadline(ev: PlanEventView): ClaimHeadline {
  const p = ev.claimedPayload;
  if (!p || typeof p !== 'object') return { status: null, result: null, next: null };
  const rec = p as Record<string, unknown>;
  return {
    status: coerceClaimStr(rec.status),
    result: coerceClaimStr(rec.result),
    next: coerceClaimStr(rec.next),
  };
}

/** GT-C §3.2 — the "Story" view model: the whole run as one flat, chronological
 *  (oldest-first) list, ignoring section structure. Stable sort so equal timestamps
 *  keep their stream order. */
export function buildRunStory(events: PlanEventView[]): PlanEventView[] {
  return [...events].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
}

/**
 * Tier-1 grouping with GT-A A3.2 fan-out. A write turn is pushed into EVERY live
 * section it wrote (`writtenSectionAnchors`), deduped per group by event id — so a
 * turn that wrote Summary + Research + Questions appears under all three (fixes
 * I-2). A presence turn (empty written set) buckets under `dispatchedSectionAnchor
 * ?? observedSectionAnchor` (D-6 — "holding the rail" attaches to the dispatched
 * section). Any target anchor that is archived or absent from the live set folds
 * into the single named "Archived section" group (F-E: never dropped). Sections
 * with no events still appear (zero-count chip) so the structure is always visible.
 */
export function groupEventsBySection(
  sections: PlanSectionView[],
  events: PlanEventView[],
): SectionGroup[] {
  const make = (over: Partial<SectionGroup> & Pick<SectionGroup, 'anchor' | 'heading' | 'zone' | 'archived'>): SectionGroup => ({
    events: [],
    writeEvents: [],
    presenceEvents: [],
    writeCount: 0,
    presenceCount: 0,
    eventCount: 0,
    lastEventAt: null,
    repoFilesRead: 0,
    repoFilesEdited: 0,
    repoFilesCreated: 0,
    ...over,
  });

  const live = new Map<string, SectionGroup>();
  for (const s of sections) {
    if (!s.anchor || s.archived) continue; // archived live rows fold into the orphan group
    live.set(s.anchor, make({
      anchor: s.anchor,
      heading: s.heading ?? s.anchor,
      zone: s.zone,
      archived: false,
      // Carry the server-computed per-section repo rollup straight onto the chip (I-8);
      // never re-summed from event digests on the render side.
      repoFilesRead: s.repoFilesRead ?? 0,
      repoFilesEdited: s.repoFilesEdited ?? 0,
      repoFilesCreated: s.repoFilesCreated ?? 0,
    }));
  }

  const archivedGroup = make({
    anchor: ARCHIVED_GROUP_ANCHOR,
    heading: ARCHIVED_GROUP_HEADING,
    zone: null,
    archived: true,
  });

  // Dedup the fan-out: a write turn must appear at most once per group even if its
  // written set (defensively) repeats an anchor.
  const seen = new Map<string, Set<string>>();
  const pushOnce = (g: SectionGroup, ev: PlanEventView): void => {
    let ids = seen.get(g.anchor);
    if (!ids) { ids = new Set(); seen.set(g.anchor, ids); }
    if (ids.has(ev.id)) return;
    ids.add(ev.id);
    g.events.push(ev);
  };

  for (const ev of events) {
    const written = ev.writtenSectionAnchors ?? [];
    if (written.length > 0) {
      // Write turn — fan into every live section it wrote; orphan only if NONE are live.
      const liveTargets = written.filter((a) => live.has(a));
      if (liveTargets.length === 0) pushOnce(archivedGroup, ev);
      else for (const a of liveTargets) pushOnce(live.get(a)!, ev);
    } else {
      // Presence turn — bucket dispatched-first (D-6), orphan if that anchor is gone.
      const key = ev.dispatchedSectionAnchor ?? ev.observedSectionAnchor;
      pushOnce(key && live.has(key) ? live.get(key)! : archivedGroup, ev);
    }
  }

  const finalize = (g: SectionGroup): SectionGroup => {
    g.writeEvents = g.events.filter((e) => classifyEvent(e) === 'write');
    g.presenceEvents = g.events.filter((e) => classifyEvent(e) === 'presence');
    g.writeCount = g.writeEvents.length;
    g.presenceCount = g.presenceEvents.length;
    g.eventCount = g.events.length;
    g.lastEventAt = g.events.reduce<string | null>(
      (max, e) => (max === null || e.createdAt > max ? e.createdAt : max),
      null,
    );
    return g;
  };

  const groups = [...live.values()].map(finalize);
  if (archivedGroup.events.length > 0) groups.push(finalize(archivedGroup));
  return groups;
}

// ── tier-2: trusted row + claimed payload ──────────────────────────────────────

/** Human label for the confidence badge (tier-2). */
export function confidenceLabel(c: AttributionConfidence | null): string {
  switch (c) {
    case 'high': return 'High confidence';
    case 'medium': return 'Medium confidence';
    case 'low': return 'Low confidence';
    default: return 'Unattributed';
  }
}

/** Human label for how the resolver attributed the activity (tier-2). */
export function observedViaLabel(v: ObservedVia | null): string {
  switch (v) {
    case 'edit-target': return 'Observed via native edit';
    case 'fs-diff': return 'Observed via file diff';
    case 'diff∩intent': return 'Observed via diff + read intent';
    case 'multi-section': return 'Spanned multiple sections';
    case 'intent-only': return 'Inferred from read intent';
    case 'dispatched-fallback': return 'Fell back to dispatched section';
    default: return 'No attribution signal';
  }
}

/** Human label for a section-mismatch flag (tier-2). Null when no mismatch. */
export function mismatchLabel(reason: MismatchReason): string | null {
  switch (reason) {
    case 'intent-effect-divergence': return 'Read one section, changed another';
    case 'dispatch-drift': return 'Worked outside the dispatched section';
    case 'multi-section': return 'Touched several sections';
    default: return null;
  }
}

/** The trusted-row view derived purely from resolver facts. */
export interface TrustedRowView {
  id: string;
  agentId: string;
  agentTitle: string;
  createdAt: string;
  observedSectionAnchor: string | null;
  observedViaLabel: string;
  confidence: AttributionConfidence | null;
  confidenceLabel: string;
  /** Present only when `sectionMismatch` is set — a visible flag, never hidden. */
  mismatchLabel: string | null;
  dispatchedSectionAnchor: string | null;
}

export function toTrustedRow(ev: PlanEventView): TrustedRowView {
  return {
    id: ev.id,
    agentId: ev.agentId,
    agentTitle: ev.agentTitle ?? ev.agentId,
    createdAt: ev.createdAt,
    observedSectionAnchor: ev.observedSectionAnchor,
    observedViaLabel: observedViaLabel(ev.observedVia),
    confidence: ev.attributionConfidence,
    confidenceLabel: confidenceLabel(ev.attributionConfidence),
    mismatchLabel: ev.sectionMismatch ? mismatchLabel(ev.mismatchReason) ?? 'Section mismatch' : null,
    dispatchedSectionAnchor: ev.dispatchedSectionAnchor,
  };
}

/** The claimed-payload view — the agent's self-report, kept STRICTLY separate
 *  from the trusted roll-up. `present:false` means the agent made no claim
 *  ("no self-report"), which the UI states plainly rather than inventing one. */
export interface ClaimedPayloadView {
  present: boolean;
  claimedSectionAnchor: string | null;
  /** Flat key/value pairs for display; never interpreted, never merged. */
  entries: Array<{ key: string; value: string }>;
  /** True when the agent's claimed anchor disagrees with the observed one — a
   *  claimed-vs-observed divergence worth surfacing (diagnostics only). */
  divergesFromObserved: boolean;
}

export function toClaimedPayload(ev: PlanEventView): ClaimedPayloadView {
  const claimedAnchor = ev.claimedSectionAnchor ?? null;
  const payload = ev.claimedPayload ?? null;
  const entries: Array<{ key: string; value: string }> = [];
  if (payload && typeof payload === 'object') {
    for (const [key, raw] of Object.entries(payload)) {
      entries.push({ key, value: typeof raw === 'string' ? raw : JSON.stringify(raw) });
    }
  }
  const present = claimedAnchor !== null || entries.length > 0;
  const divergesFromObserved =
    claimedAnchor !== null &&
    ev.observedSectionAnchor !== null &&
    claimedAnchor !== ev.observedSectionAnchor;
  return { present, claimedSectionAnchor: claimedAnchor, entries, divergesFromObserved };
}

// ── Fix-4 §6: witnessed repo-activity (Tier-2 digest line + Tier-3 expander) ────

/** The evidence line to render for an event's witnessed repo activity. Never
 *  re-synthesizes the digest from counts — it uses the frozen, server-formatted
 *  `digest.line` verbatim (I-6/I-9). Contract (§6):
 *   - missing / `not-captured` → the honest pre-fix-4 disclosure string;
 *   - `captured` with a `line` → that line verbatim;
 *   - `captured` but no activity (`line === null`) → `null` (nothing to show). */
export function repoDigestLabel(digest: RepoActivityDigest | null | undefined): string | null {
  if (!digest || digest.status === 'not-captured') return 'witnessed: not captured (pre-fix-4)';
  return digest.line; // null means captured, but no repo activity worth displaying
}

/** Whether the Tier-3 drill-down expander should be offered for an event. Only a
 *  `captured` digest with a non-empty `line` has detail-worthy witnessed files;
 *  not-captured / captured-empty rows expose no expander (§6). */
export function hasRepoDetail(digest: RepoActivityDigest | null | undefined): boolean {
  return !!digest && digest.status === 'captured' && !!digest.line;
}

/** True when a section group has any witnessed repo counts worth chipping. Zero →
 *  the chip is hidden/muted (§6). */
export function sectionHasRepoActivity(g: Pick<SectionGroup, 'repoFilesRead' | 'repoFilesEdited' | 'repoFilesCreated'>): boolean {
  return g.repoFilesRead > 0 || g.repoFilesEdited > 0 || g.repoFilesCreated > 0;
}

/** Human-readable one-file evidence descriptor for the Tier-3 detail list:
 *  `path · ops · counts` (§6). Pure so the row component stays thin and this is
 *  unit-testable without a DOM. */
export function repoFileItemLine(item: RepoActivityDetail['files']['items'][number]): {
  path: string;
  ops: string;
  counts: string;
} {
  const c = item.counts;
  const countParts: string[] = [];
  if (c.read > 0) countParts.push(`${c.read} read`);
  if (c.write > 0) countParts.push(`${c.write} edit`);
  if (c.create > 0) countParts.push(`${c.create} create`);
  return {
    path: item.path === '' ? '(workspace root)' : item.path,
    ops: item.operations.join(', '),
    counts: countParts.join(', '),
  };
}

/** The count of files elided by the Tier-3 cap, for the "+N more (capped)"
 *  affordance. Uses the pre-cap `totals.distinctFiles` minus what shipped. */
export function repoDetailOverflow(detail: RepoActivityDetail): number {
  return Math.max(0, detail.totals.distinctFiles - detail.files.items.length);
}

// ── F-E degradation: banner state ──────────────────────────────────────────────

export type BannerKind = 'none' | 'parse-error' | 'anchor-repair';

export interface BannerState {
  kind: BannerKind;
  /** Rendered over WHATEVER projection is served (F-E). */
  message: string | null;
  /** The anchor-repair warnings (missing/duplicate data-anchor), if any. */
  warnings: string[];
  /** Severity drives styling: 'error' for a failed parse, 'warn' for repairs. */
  severity: 'error' | 'warn' | null;
}

/**
 * Select the banner to render over the served projection (F-E). A parse error
 * dominates — it renders over the last-good (memory/snapshot) or empty
 * projection and names the source so the human knows the render may be stale.
 * Absent a parse error, surfaced anchor-repair warnings become a softer banner.
 */
export function selectBannerState(projection: PlanProjectionView): BannerState {
  if (projection.parseError) {
    const from = projection.degradedFrom;
    let message: string;
    if (from === 'memory') {
      message = 'Could not parse the latest plan file — showing the last good render.';
    } else if (from === 'snapshot') {
      message = 'Could not parse the latest plan file — restored from the most recent snapshot.';
    } else {
      message = 'Could not render this plan — no previous version is available yet.';
    }
    return { kind: 'parse-error', message, warnings: projection.warnings ?? [], severity: 'error' };
  }
  if (projection.warnings && projection.warnings.length > 0) {
    return {
      kind: 'anchor-repair',
      message: 'Some section anchors needed repair — the render may be approximate.',
      warnings: projection.warnings,
      severity: 'warn',
    };
  }
  return { kind: 'none', message: null, warnings: [], severity: null };
}
