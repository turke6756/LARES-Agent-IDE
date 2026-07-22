import type {
  InsertPlanEventInput,
  PlanSectionTouchRow,
  PlanSectionChangeRow,
} from '../database';
import type { FileActivity } from '../../shared/types';
import { PENDING_EDIT_ANCHOR, ORIENTATION_ANCHOR } from './plan-touch-tracker';
import { rollupRepoActivity, serializeRepoActivityEvidence } from './repo-activity';

/**
 * WP2 provenance spine — the Stop-time resolver + trusted-event composer.
 *
 * `resolveTargetAnchor` is the R2 §2.5 ladder VERBATIM: it derives the section a
 * turn actually acted on from four TRUSTED signals — resolved edit targets,
 * fs-diff effects, read intent, and the dispatched launch fact — degrading down
 * the ladder as signals thin out (transcripts are incomplete by design; §0).
 *
 * `composePlanEvent` assembles those signals from DB facts over the turn window,
 * scrapes the optional `<!--PLAN-EVENT …-->` sentinel (tolerant — a scrape
 * failure NEVER blocks insertion), mirrors the diagnostics-only
 * `claimed_section_anchor` (F-D; explicitly EXCLUDED from resolver inputs), and
 * inserts one `plan_events` row.
 */

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

/** One read-intent anchor with its strength (`raw+editWindow` reads rank above
 *  plain reads — a stronger edit-intent signal, §2.5). */
export interface IntentAnchor {
  anchor: string;
  strong: boolean;
}

/** All-trusted resolver inputs (§2.5). `claimed_section_anchor` is deliberately
 *  absent — it never drives the join (F-D). */
export interface ResolveInputs {
  /** Native-edit targets resolved to anchors (may be empty when unresolved). */
  editTargets: string[];
  /** Effect anchors changed in the window (fs-diff), most-recent last. */
  changed: string[];
  /** Read-intent anchors in the window (orientation `'*'` reads excluded). */
  intent: IntentAnchor[];
  /** Frozen `agents.plan_section` — the dispatched launch fact. */
  dispatched: string | null;
}

export interface ResolveResult {
  observedSectionAnchor: string | null;
  observedVia: ObservedVia | null;
  attributionConfidence: AttributionConfidence | null;
  observedCandidates: string[];
  readIntentAnchor: string | null;
  editTargetAnchor: string | null;
  sectionMismatch: boolean;
  mismatchReason: MismatchReason;
}

/** Highest-ranked intent anchor: a `raw+editWindow` read outranks a plain read;
 *  ties break on order (earliest strong, else earliest). Returns null if none. */
function topIntent(intent: IntentAnchor[]): string | null {
  if (intent.length === 0) return null;
  const strong = intent.find((i) => i.strong);
  return (strong ?? intent[0]).anchor;
}

function uniq(anchors: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of anchors) {
    if (!a) continue;
    if (seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

/**
 * The resolution ladder (R2 §2.5) — first match wins; every considered anchor is
 * recorded in `observedCandidates`.
 */
export function resolveTargetAnchor(inputs: ResolveInputs): ResolveResult {
  const editTargets = uniq(inputs.editTargets);
  const changed = uniq(inputs.changed);
  const intentAnchors = uniq(inputs.intent.map((i) => i.anchor));
  const dispatched = inputs.dispatched ?? null;

  const candidates = uniq([...editTargets, ...changed, ...intentAnchors, dispatched]);
  const readIntentAnchor = topIntent(inputs.intent);
  const editTargetAnchor = editTargets.length > 0 ? editTargets[0] : null;

  let observed: string | null = null;
  let via: ObservedVia | null = null;
  let confidence: AttributionConfidence | null = null;

  if (editTargets.length === 1) {
    // 1. editTargets resolves to exactly one anchor.
    observed = editTargets[0];
    via = 'edit-target';
    confidence = 'high';
  } else if (changed.length === 1) {
    // 2. changed is exactly one anchor. Corroborated by an editTarget or intent
    //    on the same anchor → high; else medium.
    observed = changed[0];
    via = 'fs-diff';
    const corroborated = editTargets.includes(observed) || intentAnchors.includes(observed);
    confidence = corroborated ? 'high' : 'medium';
  } else if (changed.length > 1) {
    // 3. changed has >1 anchor → changed ∩ intent if exactly one; else pick
    //    editTargets[0] if present else the most-recent changed anchor.
    const intersection = changed.filter((a) => intentAnchors.includes(a));
    if (intersection.length === 1) {
      observed = intersection[0];
      via = 'diff∩intent';
      confidence = 'medium';
    } else {
      observed = editTargets.length > 0 ? editTargets[0] : changed[changed.length - 1];
      via = 'multi-section';
      confidence = 'low';
    }
  } else if (readIntentAnchor) {
    // 4. No effect signal → the highest-ranked intent anchor.
    observed = readIntentAnchor;
    via = 'intent-only';
    confidence = 'low';
  } else {
    // 5. Nothing → dispatched fallback.
    observed = dispatched;
    via = 'dispatched-fallback';
    confidence = 'low';
  }

  // Flags (§2.5).
  const sectionMismatch = observed !== null && dispatched !== null && observed !== dispatched;
  let mismatchReason: MismatchReason = null;
  const effectDerived = via === 'edit-target' || via === 'fs-diff' || via === 'diff∩intent';
  if (via === 'multi-section') {
    mismatchReason = 'multi-section';
  } else if (
    effectDerived &&
    readIntentAnchor !== null &&
    observed !== null &&
    readIntentAnchor !== observed
  ) {
    // "fetched scaffold for A, edited B" — attribute to the change (B) but surface
    // the divergence from stated intent (A), never hide it by letting intent win.
    mismatchReason = 'intent-effect-divergence';
  } else if (sectionMismatch) {
    mismatchReason = 'dispatch-drift';
  }

  return {
    observedSectionAnchor: observed,
    observedVia: via,
    attributionConfidence: confidence,
    observedCandidates: candidates,
    readIntentAnchor,
    editTargetAnchor,
    sectionMismatch,
    mismatchReason,
  };
}

// ── Sentinel scrape (tolerant) + claimed self-report (F-D) ───────────────────

const SENTINEL_RE = /<!--\s*PLAN-EVENT\s*([\s\S]*?)-->/i;
const ANCHOR_SHAPE = /^(sec|blk)_[a-z0-9]{6}$/;

export interface ScrapedSentinel {
  /** Raw parsed JSON payload (whatever the worker emitted), or null. */
  payload: Record<string, unknown> | null;
  /** Shape-validated claimed anchor (diagnostics-only), or null. */
  claimedSectionAnchor: string | null;
}

/** Scrape the LAST `<!--PLAN-EVENT …-->` block from a message. Never throws:
 *  a missing / malformed sentinel yields `{ payload: null, claimedSectionAnchor: null }`. */
export function scrapePlanEventSentinel(message: string | null | undefined): ScrapedSentinel {
  const empty: ScrapedSentinel = { payload: null, claimedSectionAnchor: null };
  if (!message || typeof message !== 'string') return empty;
  // Prefer the last sentinel if several are present (final self-report wins).
  let match: RegExpExecArray | null = null;
  const global = new RegExp(SENTINEL_RE.source, 'ig');
  let m: RegExpExecArray | null;
  while ((m = global.exec(message)) !== null) match = m;
  if (!match) return empty;
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(match[1].trim());
    payload = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    payload = null;
  }
  return { payload, claimedSectionAnchor: validateClaimedAnchor(payload) };
}

/** Shape-validate the optional `claimed_section_anchor` — accept iff it matches
 *  `/^(sec|blk)_[a-z0-9]{6}$/`, else coerce to null. Never throws (F-D). */
export function validateClaimedAnchor(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  const raw = payload['claimed_section_anchor'] ?? payload['claimedSectionAnchor'];
  if (typeof raw !== 'string') return null;
  return ANCHOR_SHAPE.test(raw) ? raw : null;
}

// ── composePlanEvent ─────────────────────────────────────────────────────────

export interface ComposePlanEventDeps {
  /** Frozen plan rail for the agent. */
  getAgentPlan(agentId: string): { planId: string | null; planSection: string | null } | null;
  getTurnSectionTouches(agentId: string, sinceIso: string, untilIso: string): PlanSectionTouchRow[];
  getTurnSectionChanges(planId: string, sinceIso: string, untilIso: string): PlanSectionChangeRow[];
  insertPlanEvent(input: InsertPlanEventInput): string;
  /** Fix-4 — witnessed repo activity for the turn window (BOTH optional; capture
   *  requires both wired). `getTurnRepoActivity` is the DB window query;
   *  `getRepoActivityContext` resolves the plan's workspace root + relative path
   *  for path normalization/exclusion. A throwing dep, a null context, or an
   *  absent dep degrades the evidence blob to NULL — it NEVER blocks the insert
   *  (I-4), exactly like the sentinel scrape. */
  getTurnRepoActivity?(agentId: string, sinceIso: string, untilIso: string): FileActivity[];
  getRepoActivityContext?(planId: string): { workspaceRoot: string; planRelPath: string | null } | null;
  /** WP4's byte-range matcher: map an edit-target touch's `resolvePayload` to a
   *  concrete anchor against the pre-edit section ranges. Optional — until WP4
   *  wires it, PENDING edit-targets simply don't resolve and the ladder degrades. */
  resolveEditTargetAnchor?(payload: string | null, planId: string): string | null;
  /** GT-C §1.5 — a WRITE-turn trigger signal (fires only when `changes.length > 0`),
   *  NEVER the source of materialized truth. The Execution-Trail materializer always
   *  re-derives its entries from the DB (`listTrailEntries`), so this payload and the
   *  file content cannot diverge. Best-effort: a throwing hook never affects the
   *  returned plan_events id. */
  onWriteEvent?(e: {
    planId: string;
    planEventId: string;
    agentId: string;
    observedSectionAnchor: string | null;
    observedVia: ObservedVia | null;
    attributionConfidence: AttributionConfidence | null;
    observedCandidates: string[];
    changeCount: number;
    claimedPayload: Record<string, unknown> | null;
    createdAt: string;
  }): void;
}

export interface ComposePlanEventArgs {
  agentId: string;
  turnId?: string | null;
  sinceIso: string;
  untilIso: string;
  eventType?: string;
  /** The worker's final assistant message, for the sentinel scrape. Optional. */
  finalMessage?: string | null;
  /** Wall-clock ISO for the row; defaults to now. */
  createdAt?: string;
}

/**
 * Compose and insert one `plan_events` row for an accepted, non-duplicate turn.
 * Returns the row id, or null when the agent has no plan rail (nothing to
 * attribute). Tolerant throughout — the sentinel scrape never gates insertion.
 */
export function composePlanEvent(deps: ComposePlanEventDeps, args: ComposePlanEventArgs): string | null {
  const rail = deps.getAgentPlan(args.agentId);
  const planId = rail?.planId ?? null;
  if (!planId) return null; // no plan → no plan_events row (R1 risk 7)
  const dispatched = rail?.planSection ?? null;

  const touches = safe(() => deps.getTurnSectionTouches(args.agentId, args.sinceIso, args.untilIso), []);
  const changes = safe(() => deps.getTurnSectionChanges(planId, args.sinceIso, args.untilIso), []);

  // Assemble resolver inputs from trusted facts.
  const editTargets: string[] = [];
  const intent: IntentAnchor[] = [];
  for (const t of touches) {
    if (t.kind === 'edit-target') {
      // Resolve PENDING native edits to an anchor via WP4's matcher (if wired);
      // an already-concrete anchor is used directly.
      let anchor: string | null = null;
      if (t.sectionAnchor && t.sectionAnchor !== PENDING_EDIT_ANCHOR) {
        anchor = t.sectionAnchor;
      } else if (deps.resolveEditTargetAnchor) {
        anchor = safe(() => deps.resolveEditTargetAnchor!(t.resolvePayload, planId), null);
      }
      if (anchor) editTargets.push(anchor);
    } else if (t.kind === 'read') {
      if (t.sectionAnchor && t.sectionAnchor !== ORIENTATION_ANCHOR) {
        intent.push({ anchor: t.sectionAnchor, strong: t.readMode === 'raw+editWindow' });
      }
    }
  }
  const changed = changes.map((c) => c.sectionAnchor);
  // GT-A WP-A1 (§2 A1.3) — the EFFECT set only: uniq(changed). editTargets are
  // attribution/audit signals (they live in edit_target_anchor / candidates) and
  // are NEVER counted as writes (D-4 — counting attempt/intent would re-create the
  // I-3 no-op noise). `[]` for a no-write turn.
  const written = uniq(changed);

  const resolved = resolveTargetAnchor({ editTargets, changed, intent, dispatched });

  // Claimed self-report (F-D) — diagnostics only, EXCLUDED from the resolver above.
  const sentinel = scrapePlanEventSentinel(args.finalMessage ?? null);

  // GT-C §1.5 — compute the wall-clock ONCE and thread the SAME value into the row
  // and the onWriteEvent trigger, so no second timestamp can be synthesized.
  const createdAt = args.createdAt ?? new Date().toISOString();

  // Fix-4 (I-4) — freeze the turn's witnessed repo evidence into a capped blob.
  // Best-effort: a throwing dep / rollup, a null context, or absent deps degrades
  // to NULL (via `safe(...)`), and the plan_events row still inserts unchanged.
  const repoActivityJson = safe<string | null>(() => {
    if (!deps.getTurnRepoActivity || !deps.getRepoActivityContext) return null;
    const ctx = deps.getRepoActivityContext(planId);
    if (!ctx) return null;
    const rows = deps.getTurnRepoActivity(args.agentId, args.sinceIso, args.untilIso);
    const evidence = rollupRepoActivity(rows, {
      sinceIso: args.sinceIso,
      untilIso: args.untilIso,
      workspaceRoot: ctx.workspaceRoot,
      planRelPath: ctx.planRelPath,
      excludeDirs: ['.lares', '.dashboard'],
    });
    return serializeRepoActivityEvidence(evidence);
  }, null);

  const trustedEnvelope = {
    agentId: args.agentId,
    planId,
    turnId: args.turnId ?? null,
    dispatchedSectionAnchor: dispatched,
    observedSectionAnchor: resolved.observedSectionAnchor,
    observedVia: resolved.observedVia,
    attributionConfidence: resolved.attributionConfidence,
    window: { since: args.sinceIso, until: args.untilIso },
    touchCount: touches.length,
    changeCount: changes.length,
  };

  const id = deps.insertPlanEvent({
    planId,
    agentId: args.agentId,
    eventType: args.eventType ?? 'turn-end',
    dispatchedSectionAnchor: dispatched,
    observedSectionAnchor: resolved.observedSectionAnchor,
    observedVia: resolved.observedVia,
    attributionConfidence: resolved.attributionConfidence,
    observedCandidatesJson: JSON.stringify(resolved.observedCandidates),
    readIntentAnchor: resolved.readIntentAnchor,
    editTargetAnchor: resolved.editTargetAnchor,
    sectionMismatch: resolved.sectionMismatch,
    mismatchReason: resolved.mismatchReason,
    trustedEnvelopeJson: JSON.stringify(trustedEnvelope),
    claimedPayloadJson: sentinel.payload ? JSON.stringify(sentinel.payload) : null,
    claimedSectionAnchor: sentinel.claimedSectionAnchor,
    // GT-A WP-A1 — effect set (uniq(changed), never editTargets) + RAW cardinality.
    writtenSectionAnchorsJson: JSON.stringify(written),
    changeCount: changes.length,
    // Fix-4 — frozen witnessed repo evidence (NULL when not captured); I-6.
    repoActivityJson,
    createdAt,
  });

  // GT-C §1.5 — fire the write-turn trigger AFTER a successful insert, only on a
  // real write (changes.length > 0). Tolerant: a throwing hook never affects `id`.
  if (changes.length > 0) {
    safe(() => {
      deps.onWriteEvent?.({
        planId,
        planEventId: id,
        agentId: args.agentId,
        observedSectionAnchor: resolved.observedSectionAnchor,
        observedVia: resolved.observedVia,
        attributionConfidence: resolved.attributionConfidence,
        observedCandidates: resolved.observedCandidates,
        changeCount: changes.length,
        claimedPayload: sentinel.payload,
        createdAt,
      });
    }, undefined);
  }

  return id;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// ── Turn-scoped compose idempotency (planning-surface demo fix, 2026-07-06) ───
//
// A turn's plan_events row must be composed AT MOST ONCE. The status pipeline
// already dedupes hook events on `{ts, hookEventName, turnId}`, but that guard
// is BYPASSED for `legacy` events and can't collapse a genuine second idle
// delivery that carries a fresh `ts` (e.g. a codex Stop re-fire / a legacy
// transport). Those slip through to the idle-path compose and produce TWO
// identical plan_events milliseconds apart (observed for codex turns; claude's
// native single-fire Stop never exposed it). This guard makes the compose
// idempotent PER TURN regardless of how the duplicate idle arrives.
//
// A turn is exactly one working→idle window, so the key is the turn id when the
// transport supplies one, else the window-start timestamp (stable across the
// duplicate deliveries of a single turn because no new working hook fires
// between them). A later, genuinely-new turn gets a fresh working hook → a new
// window start → a new key → composes normally.

/** Turn identity key for compose dedup: the turn id when present, else the
 *  working→idle window-start ms. Pure + deterministic. */
export function planEventTurnKey(turnId: string | null | undefined, windowStartMs: number): string {
  return turnId && turnId.length > 0 ? `t:${turnId}` : `w:${windowStartMs}`;
}

/** Per-agent "last composed turn" tracker. `shouldSkip` records the key and
 *  returns true iff it equals the agent's immediately-preceding composed key —
 *  i.e. a duplicate idle delivery for the SAME turn. Must be consulted
 *  SYNCHRONOUSLY (before any await) so a sibling idle event landing microseconds
 *  later is suppressed before its own async compose is scheduled. */
export class TurnComposeGuard {
  private last = new Map<string, string>();
  shouldSkip(agentId: string, turnKey: string): boolean {
    if (this.last.get(agentId) === turnKey) return true;
    this.last.set(agentId, turnKey);
    return false;
  }
  /** Drop an agent's entry (on stop/cleanup) so the map doesn't grow unbounded. */
  forget(agentId: string): void {
    this.last.delete(agentId);
  }
}
