// GT-C Decision 1 (§1.3) — the pure, no-I/O render layer for the Execution Trail.
//
// `sec_exectr` is **system-owned**: no agent ever edits it. The Execution Trail is
// a materialized cache of `plan_events`, regenerated wholesale (never incrementally
// appended) at true quiescence. Full regeneration is the idempotency mechanism —
// replays / retries / duplicate triggers all converge to identical bytes.
//
// The writer manages TWO elements inside `sec_exectr`: the system
// `<ol class="exec-trail" data-trail="1">` (regenerated wholesale from
// `plan_events`; every row carries `data-plan-event-id`) and a sibling QUARANTINE
// block `<div class="unverified-manual-trail" data-unverified-manual-trail="1">`
// that carries an explicit "Unverified manual notes" heading plus a
// `<ul class="exec-trail-manual" data-trail-manual="1">` PRESERVING any `<li>` a
// mis-dispatched agent hand-appended (rows WITHOUT `data-plan-event-id`) — these
// would otherwise be erased by wholesale regeneration. The quarantine heading is
// the P0 fix (planning-surface-hardening-review §"direct writes"): manual/orphan
// content is never discarded, but it is visually and structurally separated from
// the trusted system rows so a human cannot read hand-written narration as
// witnessed. ALL other children (the `<h2>`, the `zone-hint` paragraph, and any
// future static content) are preserved verbatim. The system list never balloons
// past the last ≤200 write-events.

import { parsePlanHtmlSafe } from './section-reader';
import type { ObservedVia } from './plan-events';

export const EXEC_TRAIL_ANCHOR = 'sec_exectr';
export const EXEC_TRAIL_MAX_ENTRIES = 200;

/** Target line length for a rendered `<li>` (§1.3 — soft cap on the server-derived
 *  metadata to keep the line legible; escaping happens AFTER truncation). */
const TRAIL_LINE_TARGET = 160;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface TrailEntry {
  planEventId: string;
  createdAt: string; // ISO
  agentTitle: string;
  sectionHeading: string; // observed section's heading (else the anchor)
  viaLabel: string; // observedViaLabel(observed_via)
  /**
   * @deprecated RETIRED (P0 Fix-1, planning-surface-hardening-review). The claimed
   * self-report is agent narration and is NEVER rendered onto a system-owned trail
   * line — a forged `result` must not sit beside trusted attribution. The field is
   * retained (optional, IGNORED by the materializer) only so existing callers and
   * fixtures keep compiling; it has no effect on the rendered bytes.
   */
  claimResult?: string | null;
  // Fix-4 §5a — the witnessed repo digest (counts only, e.g. "witnessed: 9 repo
  // files edited; 2 read"), or null when the turn captured no repo activity. This
  // is server-derived and is the ONLY free-text payload on a trail line. Appended
  // AFTER the soft cap so the evidence clause is never truncated (I-1).
  repoDigest?: string | null;
}

/** Human label for an `observed_via` value, mirroring the renderer's
 *  `observedViaLabel` (plan-surface-model.ts) so both surfaces read identically.
 *  Kept here (main-side, pure) so the trail writer can label without importing
 *  renderer code. */
export function observedViaLabel(v: ObservedVia | string | null | undefined): string {
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

/** Extract `HH:MM` from an ISO timestamp WITHOUT constructing a Date (TZ-stable —
 *  the ISO string is already UTC). Falls back to the raw value if it doesn't match. */
function hhmm(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

/**
 * One `<li data-plan-event-id="…">…</li>` for a single write-event, every field
 * HTML-escaped. Text shape (soft cap `TRAIL_LINE_TARGET`):
 *   "HH:MM · <agent> · <section heading> · <via-label> — <witnessed digest | (no witnessed activity)>"
 *
 * P0 Fix-1 (planning-surface-hardening-review): the claimed self-report is agent
 * narration and is NEVER rendered here. Every field on the line is server-derived —
 * the timestamp, the resolved attribution (agent / observed section / observed-via)
 * and the witnessed repo digest. `e.claimResult` is deliberately ignored.
 */
export function formatTrailEntryLi(e: TrailEntry): string {
  const time = hhmm(e.createdAt);
  // Server-derived metadata only. `agentTitle` / `sectionHeading` are free-form
  // (agent titles, plan headings), so soft-cap the metadata for legibility; the
  // ellipsis is added before escaping so it never splits an entity.
  const meta = `${time} · ${e.agentTitle} · ${e.sectionHeading} · ${e.viaLabel}`;
  const capped = meta.length > TRAIL_LINE_TARGET
    ? meta.slice(0, Math.max(0, TRAIL_LINE_TARGET - 1)) + '…'
    : meta;
  // Fix-4 §5b (I-1) — the witnessed digest is the sole evidentiary payload, appended
  // AFTER the soft cap so it is never the clause that gets truncated. An absent
  // digest renders an explicit "(no witnessed activity)" so a bare line can't be
  // misread as "nothing happened, and that is verified". Everything stays inside the
  // single escaped text node (no raw HTML / no <details>) so byte-idempotency holds.
  const digest = e.repoDigest && e.repoDigest.trim().length > 0
    ? e.repoDigest.trim()
    : '(no witnessed activity)';
  const text = `${capped} — ${digest}`;
  return `<li data-plan-event-id="${escapeHtml(e.planEventId)}">${escapeHtml(text)}</li>`;
}

// A prior trail `<ol …data-trail="1"…>…</ol>`, tolerant of attribute order and case.
// Global + non-greedy so every prior trail block is removed before regeneration.
const TRAIL_OL_RE = /<ol\b[^>]*\bdata-trail="1"[^>]*>[\s\S]*?<\/ol>/gi;

// The QUARANTINE container that holds relocated manual (author-written) entries under
// its explicit "Unverified manual notes" heading. Kept distinct from the system
// `<ol>` (a `<div>` + `data-unverified-manual-trail="1"`) so the trusted list stays
// 100% materializer-owned. Non-greedy to the first `</div>`; safe because
// collectManualLis escapes any preserved `<li>` that carries a raw structural close
// (`</div>`/`</ul>`/`</ol>`/nested `<li>`), so the container's own `</div>` is always
// the first one reached. `data-trail="1"` is NOT a substring of
// `data-unverified-manual-trail="1"` nor `data-trail-manual="1"`, so the managed
// blocks never cross-match.
const TRAIL_MANUAL_CONTAINER_RE =
  /<div\b[^>]*\bdata-unverified-manual-trail="1"[^>]*>[\s\S]*?<\/div>/gi;

// LEGACY (pre-quarantine) bare `<ul …data-trail-manual="1">…</ul>` — plans minted
// before the quarantine heading existed carry the manual list with no container.
// Matched only OUTSIDE a container (the container is stripped first) so entries are
// migrated into the headed block exactly once, never double-collected.
const TRAIL_MANUAL_UL_LEGACY_RE = /<ul\b[^>]*\bdata-trail-manual="1"[^>]*>[\s\S]*?<\/ul>/gi;

// The fixed, system-owned heading that labels the quarantine block. Emitted verbatim
// (never escaped) — it contains no agent-controlled content.
const MANUAL_TRAIL_HEADING =
  '<h3 class="unverified-manual-trail-heading" data-unverified-manual-heading="1">'
  + 'Unverified manual notes — hand-written, NOT system-verified</h3>';

/** True when an `<li>`'s attribute string carries a `data-plan-event-id=` attribute
 *  (system-generated). Matches the attribute NAME, so a manual `<li>` that merely
 *  mentions the string in a value/body is not misclassified. */
function isSystemLiAttrs(attrs: string): boolean {
  return /\bdata-plan-event-id\s*=/i.test(attrs);
}

/** A raw structural open/close tag (`li`/`ul`/`ol`/`div`) inside a manual `<li>`'s
 *  body means preserving it verbatim could break the quarantine container / list
 *  splice. Such an `<li>` is degraded to a safe escaped form instead. */
const STRUCTURAL_TAG_RE = /<\/?(?:li|ul|ol|div)\b/i;

/**
 * Collect the MANUAL (author-written) `<li>`s from a chunk of prior managed markup
 * — those without a `data-plan-event-id` attribute. System-generated `<li>`s are
 * skipped (they are regenerated from `entries`, never preserved).
 *
 * Re-emission policy (documented, load-bearing for idempotency):
 *  - A well-formed FLAT `<li …>…</li>` (its inner HTML contains no nested/unbalanced
 *    `<li>`/`</li>`) is preserved **verbatim** — it was already valid HTML sitting
 *    inside a managed list, so re-emitting it byte-for-byte is safe and keeps the
 *    second pass identical.
 *  - A malformed `<li>` whose inner contains a raw structural tag (`li`/`ul`/`ol`/
 *    `div`) degrades to a **safe escaped** `<li>${escapeHtml(fullMatch)}</li>` rather
 *    than risk breaking the splice OR the quarantine container's `</div>` boundary.
 *    The escaped form has no literal structural tag inside, so on the next pass it
 *    re-classifies as flat → verbatim → identical bytes (still idempotent).
 *  - An `<li>` with no closing tag never matches, so it is simply dropped (the old
 *    lossy behavior for that edge) — it can never corrupt surrounding markup.
 */
function collectManualLis(chunk: string): string[] {
  const out: string[] = [];
  for (const m of chunk.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
    const [full, attrs, inner] = m;
    if (isSystemLiAttrs(attrs)) continue; // system-owned → regenerated, not preserved
    if (STRUCTURAL_TAG_RE.test(inner)) out.push(`<li>${escapeHtml(full)}</li>`); // malformed → safe escaped
    else out.push(full); // flat + well-formed → verbatim
  }
  return out;
}

/**
 * Regenerate `sec_exectr`'s inner HTML from ordered entries (oldest→newest, already
 * sliced to ≤maxEntries by the caller): preserve ALL existing non-trail inner HTML
 * verbatim EXCEPT the managed blocks (the system `<ol …data-trail="1">`, the
 * quarantine `<div …data-unverified-manual-trail="1">`, and any LEGACY bare
 * `<ul …data-trail-manual="1">`), then append a freshly regenerated system `<ol>`
 * plus — only if any exist — the quarantine container carrying the preserved
 * author-written entries under an explicit "Unverified manual notes" heading.
 *
 * Manual-entry QUARANTINE (P0 fix, planning-surface-hardening-review §"direct
 * writes"): before regeneration, any `<li>` WITHOUT a `data-plan-event-id` — i.e.
 * hand-appended by a mis-dispatched or malicious agent, whether it landed in the
 * system `<ol>`, the quarantine container, or a legacy manual `<ul>` — is collected
 * and relocated into the headed quarantine block. It is never silently discarded and
 * never sits unlabelled beside the trusted system rows. Existing quarantined/legacy
 * entries are kept first (stable position), then any newly-found orphans from the
 * system `<ol>` are appended.
 *
 * Idempotent: containers are collected then removed from a residual copy BEFORE the
 * legacy `<ul>` / system `<ol>` scans, so a quarantined entry is counted exactly once
 * across passes. All managed blocks are stripped (no surrounding whitespace absorbed)
 * and regenerated deterministically. On a second pass the system `<ol>` holds only
 * `data-plan-event-id` rows (no orphans) and the quarantine block holds the same set
 * → identical bytes, so renderTrailInner(renderTrailInner(x, E), E) === renderTrailInner(x, E).
 */
export function renderTrailInner(existingInnerHtml: string, entries: TrailEntry[]): string {
  // Collect manual entries BEFORE stripping, in a stable order: already-quarantined
  // entries first, then legacy bare-<ul> entries, then any orphans still living in
  // the system <ol>. Containers are removed from `residual` first so a container's
  // inner <ul> is NOT re-counted by the legacy-<ul> scan (which would duplicate).
  const manual: string[] = [];
  for (const m of existingInnerHtml.matchAll(TRAIL_MANUAL_CONTAINER_RE)) manual.push(...collectManualLis(m[0]));
  const residual = existingInnerHtml.replace(TRAIL_MANUAL_CONTAINER_RE, '');
  for (const m of residual.matchAll(TRAIL_MANUAL_UL_LEGACY_RE)) manual.push(...collectManualLis(m[0]));
  for (const m of residual.matchAll(TRAIL_OL_RE)) manual.push(...collectManualLis(m[0]));

  const stripped = existingInnerHtml
    .replace(TRAIL_MANUAL_CONTAINER_RE, '')
    .replace(TRAIL_MANUAL_UL_LEGACY_RE, '')
    .replace(TRAIL_OL_RE, '');
  const lis = entries.map((e) => '\n    ' + formatTrailEntryLi(e)).join('');
  const ol = `<ol class="exec-trail" data-trail="1">${lis}\n  </ol>`;
  const manualBlock = manual.length > 0
    ? '<div class="unverified-manual-trail" data-unverified-manual-trail="1">'
      + '\n    ' + MANUAL_TRAIL_HEADING
      + '\n    <ul class="exec-trail-manual" data-trail-manual="1">'
      + manual.map((li) => '\n      ' + li).join('')
      + '\n    </ul>'
      + '\n  </div>'
    : '';
  return stripped + ol + manualBlock;
}

/**
 * Locate `sec_exectr` via `parsePlanHtmlSafe` and splice ONLY its inner range
 * [innerStartOffset, innerEndOffset) in `projection.source`. Returns `html`
 * unchanged if the section is absent OR the projection has a `parseError` (F-E:
 * never write against an untrusted parse).
 */
export function spliceExecTrail(html: string, entries: TrailEntry[]): string {
  const p = parsePlanHtmlSafe(html);
  if (p.parseError) return html;
  const s = p.sections.find((x) => x.anchor === EXEC_TRAIL_ANCHOR);
  if (!s) return html;
  const inner = p.source.slice(s.innerStartOffset, s.innerEndOffset);
  const newInner = renderTrailInner(inner, entries);
  return p.source.slice(0, s.innerStartOffset) + newInner + p.source.slice(s.innerEndOffset);
}
