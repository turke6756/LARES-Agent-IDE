// WP4 — the plan-surface parser (R1 WP4 ⊕ R2 §4.2/§4.3).
//
// Parses a plan's HTML into a structural PlanProjection: a flat list of sections
// (the `data-zone` / `data-anchor` zones) and, lazily, the notable child blocks
// inside each. Every fragment is **byte-exact**: a verbatim substring of the
// source string, sliced from parse5's `sourceCodeLocationInfo` offsets — so a
// section's `raw` (and an editWindow's `oldString`) matches native Edit's
// `old_string` semantics WITHOUT a second full Read (§3.6, load-bearing).
//
// This module NEVER infers trust from HTML: it only projects structure + text.
// Anchors are server-minted downstream (section-anchors.ts); the reader merely
// reports which sections are anchorless (backfill candidates) and flags
// missing/duplicate `data-anchor` as repair warnings (F-E), never crashing.
//
// parse5 is a pure-JS dep (dependencies, not devDependencies); jsdom stays
// dev-only and is never imported in main (§7 risk 2).

import { parse } from 'parse5';

// ── lazy-block thresholds (R2 §4.3) ──────────────────────────────────────────
// A direct child of a section becomes a *notable block* (a `blk_` mint / outline
// candidate) when it is a heading, an artifact/review/task block, or exceeds a
// byte threshold. Default granularity stays section-level; blocks are opt-in.
export const LAZY_BLOCK_BYTE_THRESHOLD = 2000;
const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const NOTABLE_BLOCK_TYPES = new Set(['artifact', 'review', 'task']);

// ── parse5 tree shapes (minimal, adapter-agnostic) ───────────────────────────
interface P5Attr { name: string; value: string; }
interface P5Location {
  startOffset: number;
  endOffset: number;
  startTag?: { startOffset: number; endOffset: number } | null;
  endTag?: { startOffset: number; endOffset: number } | null;
}
interface P5Node {
  nodeName: string;
  tagName?: string;
  value?: string; // #text
  attrs?: P5Attr[];
  childNodes?: P5Node[];
  sourceCodeLocation?: P5Location | null;
}

// ── public projection types ──────────────────────────────────────────────────

export interface RawFragment {
  /** Verbatim outer HTML — a substring of the source; matches Edit's old_string. */
  raw: string;
  /** Half-open outer range [startOffset, endOffset) into the source string. */
  startOffset: number;
  endOffset: number;
  /** Half-open inner range (between the open tag's `>` and the close tag's `<`).
   *  Equal to the outer range when parse5 can't locate the tags. */
  innerStartOffset: number;
  innerEndOffset: number;
  /** Byte length of `raw` (UTF-8) — for snapshot/observability sizing. */
  byteSize: number;
}

export interface ParsedBlock extends RawFragment {
  /** Existing `data-anchor` (author-authored `dec_*`/`opi_*` or server-minted
   *  `blk_`) if the block already carries one, else null (mint candidate). */
  anchor: string | null;
  tagName: string;
  /** First heading/label text inside the block (for `outline` mode). */
  heading: string | null;
  /** Whitespace-normalized text projection. */
  text: string;
  tokenEstimate: number;
  /** True when R2 §4.3 says this block warrants a `blk_` anchor. */
  isLazyCandidate: boolean;
}

export interface ParsedSection extends RawFragment {
  /** `data-anchor` (`sec_…`) if present, else null → backfill candidate (F-E). */
  anchor: string | null;
  /** `data-zone` semantic label (mutable; never a key). */
  zone: string | null;
  tagName: string;
  heading: string | null;
  text: string;
  tokenEstimate: number;
  blocks: ParsedBlock[];
  /** This section's `data-anchor` collided with another section's (F-E). */
  duplicateAnchor: boolean;
}

export interface PlanProjection {
  sections: ParsedSection[];
  /** Non-null when the live parse could not be trusted (F-E). The caller decides
   *  whether this projection is a live parse, a last-good, or an empty fallback. */
  parseError: string | null;
  /** Human-facing anchor-repair warnings (missing/duplicate `data-anchor`). */
  warnings: string[];
  /** Full source the fragments index into (so callers can re-slice / editWindow). */
  source: string;
}

// ── attribute / text helpers ─────────────────────────────────────────────────

function attr(node: P5Node, name: string): string | null {
  const a = node.attrs?.find((x) => x.name === name);
  return a ? a.value : null;
}

/** A section-level zone: carries `data-zone` or a `sec_` `data-anchor`. */
function isSectionNode(node: P5Node): boolean {
  if (!node.tagName) return false;
  if (attr(node, 'data-zone') !== null) return true;
  const anchor = attr(node, 'data-anchor');
  return anchor !== null && anchor.startsWith('sec_');
}

function collectText(node: P5Node, out: string[]): void {
  if (node.nodeName === '#text' && typeof node.value === 'string') {
    out.push(node.value);
    return;
  }
  for (const c of node.childNodes ?? []) collectText(c, out);
}

function textOf(node: P5Node): string {
  const parts: string[] = [];
  collectText(node, parts);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function firstHeadingText(node: P5Node): string | null {
  for (const c of node.childNodes ?? []) {
    if (c.tagName && HEADING_TAGS.has(c.tagName)) {
      const t = textOf(c);
      if (t) return t;
    }
  }
  return null;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function makeFragment(source: string, node: P5Node): RawFragment | null {
  const loc = node.sourceCodeLocation;
  if (!loc || typeof loc.startOffset !== 'number' || typeof loc.endOffset !== 'number') return null;
  const startOffset = loc.startOffset;
  const endOffset = loc.endOffset;
  const raw = source.slice(startOffset, endOffset);
  // Inner range: after the open tag, before the close tag. Fall back to outer.
  const innerStartOffset = loc.startTag ? loc.startTag.endOffset : startOffset;
  const innerEndOffset = loc.endTag ? loc.endTag.startOffset : endOffset;
  return {
    raw,
    startOffset,
    endOffset,
    innerStartOffset,
    innerEndOffset,
    byteSize: Buffer.byteLength(raw, 'utf8'),
  };
}

// ── block extraction (lazy candidates, R2 §4.3) ──────────────────────────────

function blockIsNotable(node: P5Node): boolean {
  if (node.tagName && HEADING_TAGS.has(node.tagName)) return true;
  // Any existing data-anchor (author-minted dec_*/opi_* or server-minted blk_)
  // makes the block notable — an author who anchored a block wants it addressable
  // (I-6). The mint filter (`!b.anchor`) is what protects it from re-stamping.
  if (attr(node, 'data-anchor')) return true;
  const blockType = attr(node, 'data-block-type');
  if (blockType && NOTABLE_BLOCK_TYPES.has(blockType)) return true;
  const cls = attr(node, 'class') ?? '';
  if (cls.split(/\s+/).some((c) => NOTABLE_BLOCK_TYPES.has(c))) return true;
  return false;
}

function extractBlocks(source: string, section: P5Node): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  for (const child of section.childNodes ?? []) {
    if (!child.tagName) continue; // skip text / comments
    const frag = makeFragment(source, child);
    if (!frag) continue;
    const notable = blockIsNotable(child);
    const overThreshold = frag.byteSize >= LAZY_BLOCK_BYTE_THRESHOLD;
    if (!notable && !overThreshold) continue; // default stays section-level
    const text = textOf(child);
    const anchor = attr(child, 'data-anchor');
    blocks.push({
      ...frag,
      // Surface ANY existing data-anchor (author-authored dec_*/opi_* or minted
      // blk_) so the outline is addressable with zero writes (I-6 Part 1); only a
      // genuinely anchorless notable block becomes a mint candidate (Part 2).
      anchor: anchor && anchor.trim() ? anchor : null,
      tagName: child.tagName,
      heading: HEADING_TAGS.has(child.tagName) ? text : firstHeadingText(child),
      text,
      tokenEstimate: estimateTokens(text),
      isLazyCandidate: notable || overThreshold,
    });
  }
  return blocks;
}

// ── section walk (flat; a section never nests inside another section) ─────────

function collectSections(source: string, node: P5Node, out: ParsedSection[]): void {
  if (node.tagName && isSectionNode(node)) {
    const frag = makeFragment(source, node);
    if (frag) {
      const text = textOf(node);
      out.push({
        ...frag,
        anchor: attr(node, 'data-anchor'),
        zone: attr(node, 'data-zone'),
        tagName: node.tagName,
        heading: firstHeadingText(node),
        text,
        tokenEstimate: estimateTokens(text),
        blocks: extractBlocks(source, node),
        duplicateAnchor: false, // filled in a second pass
      });
      return; // do not descend — nested zones are blocks, not sibling sections
    }
  }
  for (const c of node.childNodes ?? []) collectSections(source, c, out);
}

// ── the parse entrypoint ─────────────────────────────────────────────────────

/**
 * Parse plan HTML into a structural projection. Throws only on a genuinely
 * unusable parse (parse5 is famously lenient, so this is rare); callers that
 * need degradation should use `parsePlanHtmlSafe` which converts a throw into a
 * `parseError` projection (F-E).
 */
export function parsePlanHtml(source: string): PlanProjection {
  const doc = parse(source, { sourceCodeLocationInfo: true }) as unknown as P5Node;
  const sections: ParsedSection[] = [];
  collectSections(source, doc, sections);

  // Anchor-repair pass (F-E): flag duplicates + missing, never crash.
  const warnings: string[] = [];
  const seen = new Map<string, number>();
  for (const s of sections) {
    if (s.anchor) seen.set(s.anchor, (seen.get(s.anchor) ?? 0) + 1);
  }
  for (const s of sections) {
    if (s.anchor && (seen.get(s.anchor) ?? 0) > 1) s.duplicateAnchor = true;
  }
  for (const [anchor, count] of seen) {
    if (count > 1) warnings.push(`duplicate data-anchor "${anchor}" on ${count} sections (backfill left untouched; repair needed)`);
  }
  const anchorless = sections.filter((s) => !s.anchor).length;
  if (anchorless > 0) {
    warnings.push(`${anchorless} section(s) missing data-anchor (will be server-minted on registration)`);
  }

  return { sections, parseError: null, warnings, source };
}

/** Degradation-friendly wrapper (F-E): never throws — a failed parse returns an
 *  empty projection carrying `parseError`. The reparse pipeline layers the
 *  last-good (memory → snapshot blob → empty) fallback on top of this. */
export function parsePlanHtmlSafe(source: string): PlanProjection {
  try {
    return parsePlanHtml(source);
  } catch (err) {
    return {
      sections: [],
      parseError: err instanceof Error ? err.message : String(err),
      warnings: [],
      source,
    };
  }
}
