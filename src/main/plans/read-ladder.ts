// WP4 — the read ladder (R2 §4.2). One tool, four modes, plus `blk_` support.
//
// `read_plan_section(plan, anchor, mode?, offset?, limit?)` projects over a
// PlanProjection (section-reader.ts). Blocks share the section anchor namespace,
// so a `blk_` anchor is a valid argument — no separate block tool (N7/N8).
//
//   outline        — child-block headings + `blk_` anchors + tokenEstimate +
//                    one-line excerpts, NO bodies (~150 tokens to navigate).
//   text           — plain-text projection (offset/limit page it).
//   raw            — byte-exact HTML (offset/limit window a giant block; the
//                    window stays a verbatim substring so old_string matches).
//   raw+editWindow — byte-exact `oldString` + its source range + an append point
//                    (for append-only zones). This is `get_section_emit` folded
//                    into a mode (N8). WP-P0B: the mode + its byte-exact window
//                    are PRESERVED; only the obligating edit-discipline text is
//                    removed — `instructions` is now empty (see EDIT_DISCIPLINE).
//
// This module is the clean API surface; WP3 wires it into the MCP tool + records
// the read breadcrumb. It never reaches the DB or fs itself — pure over a
// projection, so it is trivially unit-testable.

import type { PlanProjection, ParsedSection, ParsedBlock } from './section-reader';

export type ReadMode = 'outline' | 'text' | 'raw' | 'raw+editWindow';

/** WP-P0B (ceremony subtraction): the read-before-edit discipline that used to
 *  ride on every editWindow is REMOVED — no read mode obligates a read-before-edit
 *  ritual. The `raw+editWindow` mode still returns its byte-exact `oldString`,
 *  source range, and append point; `instructions` is now the empty string. The
 *  constant is retained (still surfaced as `editWindow.instructions`) so callers
 *  and the shared response shape are unchanged. */
export const EDIT_DISCIPLINE = '';

export interface OutlineChild {
  anchor: string | null;
  tagName: string;
  heading: string | null;
  excerpt: string;      // one line, truncated
  tokenEstimate: number;
}

export interface EditWindow {
  /** Byte-exact fragment to hand native Edit as `old_string`. */
  oldString: string;
  /** Half-open source range the oldString occupies. */
  startOffset: number;
  endOffset: number;
  /** Insertion point for append-only zones (just before the close tag). */
  appendOffset: number;
  instructions: string;
}

export interface ReadResult {
  found: boolean;
  anchor: string;
  kind: 'section' | 'block' | null;
  mode: ReadMode;
  /** outline mode payload. */
  outline?: OutlineChild[];
  /** text/raw payload (windowed by offset/limit when given). */
  content?: string;
  /** The source range `content` was sliced from (raw modes) — for callers that
   *  want to correlate the window back to the file. */
  contentRange?: { startOffset: number; endOffset: number };
  /** raw+editWindow payload. */
  editWindow?: EditWindow;
  /** True when offset/limit truncated the fragment. */
  truncated?: boolean;
  tokenEstimate?: number;
  zone?: string | null;
  error?: string;
}

const EXCERPT_MAX = 120;

function excerpt(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > EXCERPT_MAX ? oneLine.slice(0, EXCERPT_MAX - 1) + '…' : oneLine;
}

/** Find a section or block by anchor across the projection. */
function locate(
  projection: PlanProjection,
  anchor: string,
): { kind: 'section'; node: ParsedSection } | { kind: 'block'; node: ParsedBlock; section: ParsedSection } | null {
  for (const s of projection.sections) {
    if (s.anchor === anchor) return { kind: 'section', node: s };
  }
  for (const s of projection.sections) {
    for (const b of s.blocks) {
      if (b.anchor === anchor) return { kind: 'block', node: b, section: s };
    }
  }
  return null;
}

/** Window a string by [offset, offset+limit). Byte-exact for raw content: the
 *  slice is still a verbatim substring of the source, so old_string matches. */
function window(text: string, offset?: number, limit?: number): { slice: string; truncated: boolean } {
  const start = Math.max(0, offset ?? 0);
  const end = limit !== undefined ? start + Math.max(0, limit) : text.length;
  const slice = text.slice(start, end);
  return { slice, truncated: start > 0 || end < text.length };
}

export function readPlanSection(
  projection: PlanProjection,
  anchor: string,
  opts?: { mode?: ReadMode; offset?: number; limit?: number },
): ReadResult {
  const mode: ReadMode = opts?.mode ?? 'text';
  const hit = locate(projection, anchor);
  if (!hit) {
    return { found: false, anchor, kind: null, mode, error: `anchor "${anchor}" not found in projection` };
  }
  const node = hit.node;
  const zone = hit.kind === 'section' ? hit.node.zone : hit.section.zone;

  if (mode === 'outline') {
    // Outline only makes sense for a section (a block has no child blocks here).
    const children: OutlineChild[] =
      hit.kind === 'section'
        ? hit.node.blocks.map((b) => ({
            anchor: b.anchor,
            tagName: b.tagName,
            heading: b.heading,
            excerpt: excerpt(b.text),
            tokenEstimate: b.tokenEstimate,
          }))
        : [];
    return {
      found: true, anchor, kind: hit.kind, mode, outline: children,
      tokenEstimate: node.tokenEstimate, zone,
    };
  }

  if (mode === 'text') {
    const { slice, truncated } = window(node.text, opts?.offset, opts?.limit);
    return { found: true, anchor, kind: hit.kind, mode, content: slice, truncated, tokenEstimate: node.tokenEstimate, zone };
  }

  // raw / raw+editWindow — slice the byte-exact outer fragment.
  const { slice, truncated } = window(node.raw, opts?.offset, opts?.limit);
  const winStart = node.startOffset + Math.max(0, opts?.offset ?? 0);
  const winEnd = winStart + slice.length;
  const result: ReadResult = {
    found: true, anchor, kind: hit.kind, mode, content: slice, truncated,
    contentRange: { startOffset: winStart, endOffset: winEnd }, tokenEstimate: node.tokenEstimate, zone,
  };

  if (mode === 'raw+editWindow') {
    result.editWindow = {
      oldString: slice,
      startOffset: winStart,
      endOffset: winEnd,
      // Append point is the inner end (just before the close tag) for the FULL
      // fragment — appending to a window mid-fragment is meaningless, so it is
      // always the section/block's own inner end.
      appendOffset: node.innerEndOffset,
      instructions: EDIT_DISCIPLINE,
    };
  }
  return result;
}

/** `list_plan_sections` orientation projection (~200 tokens): anchor + zone +
 *  heading + tokenEstimate per section, no bodies. */
export interface SectionListing {
  anchor: string | null;
  zone: string | null;
  heading: string | null;
  tokenEstimate: number;
  archived?: boolean;
  duplicateAnchor?: boolean;
}

export function listPlanSections(projection: PlanProjection): {
  sections: SectionListing[];
  parseError: string | null;
  warnings: string[];
} {
  return {
    sections: projection.sections.map((s) => ({
      anchor: s.anchor,
      zone: s.zone,
      heading: s.heading,
      tokenEstimate: s.tokenEstimate,
      duplicateAnchor: s.duplicateAnchor || undefined,
    })),
    parseError: projection.parseError,
    warnings: projection.warnings,
  };
}
