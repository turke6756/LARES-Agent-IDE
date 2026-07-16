// WP3 — the seed plan-surface template (R1 F0 / C11).
//
// DEFAULT_SURFACE_TEMPLATE is the six-zone HTML skeleton every created plan
// starts from. Each seed `<section>` carries:
//   - a baked, immutable `data-anchor` (`sec_…`) — the provenance key the read
//     ladder + reparse register into `plan_sections`. Baked (not per-plan minted)
//     because `plan_sections` is keyed by (plan_id, anchor): the same anchor
//     string on two different plans is two distinct rows, so seed anchors are
//     safely deterministic and the create path never needs to mint.
//   - a mutable `data-zone` semantic label (agents may reword it).
// The root `<body>` carries a `data-plan-id` placeholder interpolated to the
// server-minted plan UUID at create time (adoption reconciles the file to the
// server id, C6).
//
// Full HTML templates live HERE, in src/main/plans/templates/, NOT in the
// already-heavy src/shared/constants.ts (C11).

export interface SeedZone {
  /** Mutable semantic label (`data-zone`). */
  zone: string;
  /** Immutable provenance key (`data-anchor`, `sec_` + 6 [a-z0-9]). */
  anchor: string;
  /** Human heading rendered at the top of the zone. */
  heading: string;
  /** Placeholder prose shown until an agent fills the zone. */
  hint: string;
}

/**
 * The six seed zones (R1 F0 / brief §2 progressive disclosure), in document
 * order: `summary` is the landing zone, `open-items` the follow-up tracker.
 * Each anchor satisfies /^(sec|blk)_[a-z0-9]{6}$/ (the F-D shape).
 */
export const SEED_ZONES: readonly SeedZone[] = [
  { zone: 'summary',         anchor: 'sec_summry', heading: 'Summary',
    hint: 'One-paragraph statement of what this plan is and its current status.' },
  { zone: 'questions',       anchor: 'sec_quests', heading: 'Open Questions',
    hint: 'Questions that need a decider before or during execution.' },
  { zone: 'research',        anchor: 'sec_resrch', heading: 'Research',
    hint: 'Findings, links, and context gathered for this plan.' },
  { zone: 'decisions',       anchor: 'sec_dcsion', heading: 'Decisions',
    hint: 'Settled decisions — build against these, do not relitigate.' },
  { zone: 'execution-trail', anchor: 'sec_exectr', heading: 'Execution Trail',
    hint: 'Auto-generated from verified plan activity — do not edit or dispatch a writer here; it is regenerated from trusted write events.' },
  { zone: 'open-items',      anchor: 'sec_opitem', heading: 'Open Items',
    hint: 'Follow-ups and loose ends still to be closed out. When an item lands, the worker flips its &#9744; to &#9745; here (native edit of this section).' },
] as const;

/** The interpolation placeholders present in DEFAULT_SURFACE_TEMPLATE. */
export const PLAN_ID_PLACEHOLDER = '{{PLAN_ID}}';
export const TITLE_PLACEHOLDER = '{{TITLE}}';

/** Minimal HTML-attribute/text escaping for the interpolated title + id. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderZone(z: SeedZone): string {
  return (
    `  <section data-zone="${z.zone}" data-anchor="${z.anchor}">\n` +
    `    <h2>${escapeHtml(z.heading)}</h2>\n` +
    `    <p class="zone-hint">${escapeHtml(z.hint)}</p>\n` +
    `  </section>`
  );
}

/**
 * The raw seed template carrying `{{PLAN_ID}}` / `{{TITLE}}` placeholders, with
 * baked anchors + baked zones. Exported as a constant for inspection + tests;
 * callers should interpolate through `renderDefaultSurface`.
 */
export const DEFAULT_SURFACE_TEMPLATE =
  `<!DOCTYPE html>\n` +
  `<html lang="en">\n` +
  `<head>\n` +
  `  <meta charset="utf-8">\n` +
  `  <title>${TITLE_PLACEHOLDER}</title>\n` +
  `</head>\n` +
  `<body data-plan-id="${PLAN_ID_PLACEHOLDER}">\n` +
  `  <h1 class="plan-title">${TITLE_PLACEHOLDER}</h1>\n` +
  SEED_ZONES.map(renderZone).join('\n') + `\n` +
  `</body>\n` +
  `</html>\n`;

/**
 * Interpolate a plan's server-minted UUID + title into the seed template. Title
 * (and, defensively, the id) are HTML-escaped. Every occurrence of each
 * placeholder is replaced (split/join, not a regex, so `$`-sequences in the
 * title never trigger replacement specials).
 */
export function renderDefaultSurface(planId: string, title: string): string {
  const safeTitle = escapeHtml(title);
  const safeId = escapeHtml(planId);
  return DEFAULT_SURFACE_TEMPLATE
    .split(TITLE_PLACEHOLDER).join(safeTitle)
    .split(PLAN_ID_PLACEHOLDER).join(safeId);
}
