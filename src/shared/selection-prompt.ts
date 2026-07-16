// Canonical [SELECTION COMMENT] prompt builder, shared between processes.
// plans/selection-to-agent-primitive-plan.md §4 — every surface emits this one
// format; multi-item support exists so "send all" (slice 2) needs no second
// template.
//
// WP-P5-A: this is a byte-identical port of the slice-1 builder in
// src/renderer/lib/selection/quoted-prompt.ts, hoisted here because the
// main-process `comments:send` path builds prompts next to the DB. The
// renderer module keeps its own import path; WP-P5-B may flip it to a
// re-export of this file (renderer files are B's to edit, not A's).
// Until then any semantic change MUST land in both files.

export type SelectionPromptTargetType = 'file' | 'chat-message' | 'note';

// A normalized (0..1) region for a coordinate-only PDF note — mirrors PdfRect
// but kept local so this pure builder stays free of the anchor module.
export interface PromptRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

// One quote+comment pair. A send of N persisted comments produces N items in
// a single prompt. PDF comments additionally carry per-quote page context so a
// multi-comment send across pages 3 and 7 is unambiguous (plan Part 1.7).
export interface QuoteItem {
  quote: string;
  comment?: string;
  /** 0-based PHYSICAL page; presence marks this item as a PDF anchor. */
  pageIndex?: number;
  /** Descriptive page label, rendered only when it differs from the number. */
  pageLabel?: string;
  /** Coordinate-only region (scanned/image page, no extractable text). The
   *  `quote` is then a synthetic marker like "[Area on PDF page 3]". */
  region?: PromptRegion;
}

// The builder only needs the source identity, not a live selection — quotes
// arrive via `items` so multi-item sends don't pretend one selection.
export interface QuotedPromptSource {
  targetType: SelectionPromptTargetType;
  // Human line for the prompt, e.g. the file path or `agent chat with "Builder"`.
  sourceLabel: string;
  file?: { filePath: string; lineStart?: number; lineEnd?: number };
  // Set when the quoted text was selected from a PRIOR (out-of-context) chat
  // session so the Source: line can attribute the quote to that specific
  // session. `generation` is a display label that may repeat across a `/clear`;
  // `sessionId` is the real disambiguator (shortened in the rendered line).
  priorSession?: { generation: number; sessionId: string };
}

const HEADER = '[SELECTION COMMENT]';

// Short, human-scannable slice of a session id for the Source: line — mirrors
// the divider caption in ChatPane so provenance reads consistently.
function shortSessionId(sessionId: string): string {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

function sourceLine(ctx: QuotedPromptSource): string {
  // File surfaces pass the bare path as sourceLabel; the format shows
  // `Source: file C:\...\doc.md`. Chat/note surfaces bake their own phrasing
  // into sourceLabel (`agent chat with "Builder"`, `note "ideas.md"`).
  if (ctx.targetType === 'file') return `Source: file ${ctx.sourceLabel}`;
  const base = `Source: ${ctx.sourceLabel}`;
  // A quote lifted from a prior session gets an explicit out-of-context tag so
  // the receiving (live) agent knows it is not quoting its current transcript.
  if (ctx.priorSession) {
    const { generation, sessionId } = ctx.priorSession;
    return `${base} — PREVIOUS SESSION (gen ${generation}, session ${shortSessionId(sessionId)}, not in current context)`;
  }
  return base;
}

function linesLine(ctx: QuotedPromptSource): string | null {
  // Files only, when known; omit otherwise.
  if (ctx.targetType !== 'file' || !ctx.file) return null;
  const { lineStart, lineEnd } = ctx.file;
  if (lineStart == null) return null;
  if (lineEnd == null || lineEnd === lineStart) return `Lines: ${lineStart}`;
  return `Lines: ${lineStart}-${lineEnd}`;
}

function blockquote(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? `> ${line}` : `${indent}> ${line}`))
    .join('\n');
}

// A PDF item is one carrying a physical page index. Page numbers rendered to
// agents are ALWAYS one-based; the stored index is 0-based identity.
function isPdfItem(item: QuoteItem): boolean {
  return item.pageIndex != null;
}

function pageDescriptor(item: QuoteItem): string {
  const oneBased = (item.pageIndex ?? 0) + 1;
  // Show the descriptive label only when it disagrees with the plain number
  // (e.g. front-matter "iv" or a supplement "S3"), never dumping raw anchors.
  if (item.pageLabel && item.pageLabel !== String(oneBased)) {
    return `${oneBased} (labeled "${item.pageLabel}")`;
  }
  return `${oneBased}`;
}

// Header-level `Page: N` for a single-quote PDF send — the page analogue of the
// `Lines:` header (one page per prompt only makes sense for one quote).
function pageHeadLine(items: QuoteItem[]): string | null {
  if (items.length !== 1 || !isPdfItem(items[0])) return null;
  return `Page: ${pageDescriptor(items[0])}`;
}

function regionLine(region: PromptRegion): string {
  const f = (n: number): string => n.toFixed(3);
  return `Region: x=${f(region.x)} y=${f(region.y)} w=${f(region.width)} h=${f(region.height)} (normalized, unrotated)`;
}

export function buildQuotedPrompt(ctx: QuotedPromptSource, items: QuoteItem[]): string {
  if (items.length === 0) {
    throw new Error('buildQuotedPrompt: items must be non-empty');
  }

  // A single send is either all-text or all-PDF; mixing the two would make the
  // page context ambiguous (some quotes anchored to pages, some not).
  const pdfFlags = items.map(isPdfItem);
  if (pdfFlags.some(Boolean) && pdfFlags.some((f) => !f)) {
    throw new Error('buildQuotedPrompt: cannot mix text and PDF anchors in one send');
  }
  const isPdf = pdfFlags[0];

  const head: string[] = [HEADER, sourceLine(ctx)];
  // `Lines:` is a text-source concept; PDF sends carry `Page:` instead.
  const lines = isPdf ? null : linesLine(ctx);
  if (lines) head.push(lines);
  const pageHead = pageHeadLine(items);
  if (pageHead) head.push(pageHead);

  // Single item, no comment, no coordinate-only region → collapse: header +
  // Source(+Lines/Page) + bare blockquote, no numbering, no parenthetical.
  if (items.length === 1 && !items[0].comment && !items[0].region) {
    return `${head.join('\n')}\n\n${blockquote(items[0].quote, '')}`;
  }

  const multi = items.length > 1;
  const rendered = items.map((item, idx) => {
    const num = `${idx + 1}) `;
    const indent = ' '.repeat(num.length);
    // Coordinate-only region notes have no real text — render the synthetic
    // marker as a plain line, not a blockquote.
    const bodyHead = item.region
      ? `${num}${item.quote}`
      : `${num}${blockquote(item.quote, indent)}`;
    const extra: string[] = [];
    // Per-quote page context only for multi-item PDF sends (single sends carry
    // the header `Page:` line instead, avoiding duplication).
    if (multi && isPdfItem(item)) extra.push(`${indent}Anchor: page ${pageDescriptor(item)}`);
    if (item.region) extra.push(`${indent}${regionLine(item.region)}`);
    extra.push(item.comment
      ? `${indent}Comment: ${item.comment}`
      : `${indent}(no comment — act on this text directly)`);
    return [bodyHead, ...extra].join('\n');
  });

  return `${head.join('\n')}\n\n${rendered.join('\n\n')}`;
}
