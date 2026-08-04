// Plans card gallery — cheap description snippet for a plan surface.
//
// The gallery card wants a one-line "what is this plan" blurb. Rather than a new
// parse pass, we reuse whatever PlanProjection the section reader already
// produced (the served last-good projection, or an on-demand
// `parsePlanHtmlSafe`) and pull the SUMMARY zone's prose out of it. The summary
// zone (`data-zone="summary"`) is the legacy plan's landing paragraph by
// convention; absent one we fall back to the first section that carries text.

import type { PlanProjection, ParsedSection } from './section-reader';

/** Max snippet length before an ellipsis (roughly two lines on a card). */
export const PLAN_SNIPPET_MAX_CHARS = 160;

/** Strip a leading heading (`Summary`, etc.) off a section's flattened text so
 *  the snippet is the prose, not the zone label. `section.text` is already
 *  whitespace-normalized by the reader. */
function bodyText(section: ParsedSection): string {
  const text = section.text.trim();
  const heading = section.heading?.trim();
  if (heading && text.startsWith(heading)) {
    return text.slice(heading.length).trim();
  }
  return text;
}

/** Truncate on a word boundary near the limit and append an ellipsis. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * Derive a gallery snippet from a plan projection: the summary-zone prose (else
 * the first non-empty section's prose), truncated to ~160 chars. Returns null
 * when the projection carries no usable text (empty plan, parse error, or a
 * projection that never got served) — the card then shows title + time only.
 */
export function derivePlanSnippet(projection: PlanProjection | null | undefined): string | null {
  if (!projection || projection.sections.length === 0) return null;
  const summary = projection.sections.find(
    (s) => s.zone === 'summary' && s.text.trim().length > 0,
  );
  const source = summary ?? projection.sections.find((s) => bodyText(s).length > 0);
  if (!source) return null;
  const body = bodyText(source);
  if (!body) return null;
  return truncate(body, PLAN_SNIPPET_MAX_CHARS);
}
