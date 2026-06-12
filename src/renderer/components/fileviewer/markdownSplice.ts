/**
 * markdownSplice — save-path fidelity for the WYSIWYG markdown editor.
 *
 * Design: docs/MARKDOWN_CANVAS_PLAN.md §6 (v3.1). Guarantee: untouched
 * *top-level* blocks are byte-identical after save. Editing any part of a
 * container block (list, blockquote, table) reserializes that whole container.
 *
 * Pure module: no React, no DOM imports. All normalization on both the load
 * and save sides goes through the single remark pipeline owned by this file —
 * it must be self-consistent, it does not need to byte-match Crepe's
 * serializer (alignment only ever compares this module's normalizations to
 * each other).
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import { diffArrays } from 'diff';
import type { Node, Parent, Root } from 'mdast';

export type Eol = '\n' | '\r\n';

export interface SpliceBlock {
  /** Exact original bytes of this top-level block (pre-EOL-normalization). */
  sourceText: string;
  /** This module's normalization of the block — the alignment key. */
  normText: string;
  ordinal: number;
}

export interface SpliceBaseline {
  originalContent: string;
  eol: Eol;
  trailingNewline: boolean;
  /** LF-normalized text to hand to the editor. */
  editorContent: string;
  blocks: SpliceBlock[];
  /** Original bytes before the first block (blank lines only). */
  leadingSep: string;
  /** Original bytes between top-level block i and i+1. */
  betweenSeps: string[];
  /** Original bytes after the last block (trailing newline lives here). */
  trailingSep: string;
  /** Doc contains link-reference or footnote definitions anywhere. */
  hasRefDefinitions: boolean;
}

export type SpliceFallbackReason =
  | 'parse-error'
  | 'dangling-references'
  | 'internal-error';

export interface SpliceOutcome {
  content: string;
  fallback: boolean;
  fallbackReason?: SpliceFallbackReason;
}

export class SpliceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpliceError';
  }
}

// ---------------------------------------------------------------------------
// Fallback counter hook (plan §6.2 step 6) — fallback frequency gates the
// default-on rollout. WP1-B surfaces this in dev tools.
// ---------------------------------------------------------------------------

export type SpliceFallbackListener = (reason: SpliceFallbackReason) => void;

let fallbackCount = 0;
const fallbackListeners = new Set<SpliceFallbackListener>();

export function getSpliceFallbackCount(): number {
  return fallbackCount;
}

export function onSpliceFallback(listener: SpliceFallbackListener): () => void {
  fallbackListeners.add(listener);
  return () => fallbackListeners.delete(listener);
}

function recordFallback(reason: SpliceFallbackReason): void {
  fallbackCount += 1;
  for (const listener of fallbackListeners) {
    try {
      listener(reason);
    } catch {
      // listeners must never break the save path
    }
  }
}

// ---------------------------------------------------------------------------
// The one remark pipeline
// ---------------------------------------------------------------------------

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkStringify);

function parseRoot(text: string): Root {
  return processor.parse(text) as Root;
}

function stringifyRoot(root: Root): string {
  return processor.stringify(root) as string;
}

/** Canonical form of one block: parse standalone, re-stringify, trim the
 * trailing newline(s) remark-stringify appends. */
function normalizeBlock(lfSlice: string): string {
  return stringifyRoot(parseRoot(lfSlice)).replace(/\n+$/, '');
}

// ---------------------------------------------------------------------------
// EOL handling (plan §6.1)
// ---------------------------------------------------------------------------

export function detectEol(content: string): Eol {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const loneLf = (content.match(/\n/g) ?? []).length - crlf;
  return crlf > loneLf ? '\r\n' : '\n';
}

function normalizeEol(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function convertEol(lfText: string, eol: Eol): string {
  return eol === '\n' ? lfText : lfText.replace(/\n/g, '\r\n');
}

/**
 * Normalized offsets where a CRLF was collapsed to LF (the offset of the
 * surviving `\n` in the normalized string). Lone `\r` → `\n` keeps length, so
 * only CRLF collapses shift offsets.
 */
function crlfCollapseOffsets(original: string): number[] {
  const collapses: number[] = [];
  let from = 0;
  let removed = 0;
  for (;;) {
    const i = original.indexOf('\r\n', from);
    if (i === -1) break;
    collapses.push(i - removed);
    removed += 1;
    from = i + 2;
  }
  return collapses;
}

/** Map an offset in the LF-normalized string back to the original bytes. */
function toOriginalOffset(normalizedOffset: number, collapses: number[]): number {
  // count collapses strictly before normalizedOffset
  let lo = 0;
  let hi = collapses.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (collapses[mid] < normalizedOffset) lo = mid + 1;
    else hi = mid;
  }
  return normalizedOffset + lo;
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

interface OffsetRange {
  start: number;
  end: number;
}

function blockOffsets(root: Root): OffsetRange[] {
  return root.children.map((child) => {
    const start = child.position?.start?.offset;
    const end = child.position?.end?.offset;
    if (start === undefined || end === undefined) {
      throw new SpliceError(`top-level ${child.type} block has no source position`);
    }
    return { start, end };
  });
}

function visit(node: Node, fn: (node: Node, parent: Node | null) => void, parent: Node | null = null): void {
  fn(node, parent);
  const children = (node as Parent).children;
  if (Array.isArray(children)) {
    for (const child of children) visit(child, fn, node);
  }
}

function hasRefOrFootnoteDefinitions(root: Root): boolean {
  let found = false;
  visit(root, (node) => {
    if (node.type === 'definition' || node.type === 'footnoteDefinition') found = true;
  });
  return found;
}

/**
 * Identifiers of link/image/footnote references that RESOLVE in this tree.
 * Note: micromark only materializes reference nodes when a matching
 * definition exists in the same document — a dangling `[x][y]` parses as
 * plain text. So reference nodes can only be harvested from a doc where they
 * resolve (the editor output), never from a doc where they dangle.
 */
function referencedIds(root: Root): Set<string> {
  const referenced = new Set<string>();
  visit(root, (node) => {
    const type = node.type;
    if (type === 'linkReference' || type === 'imageReference' || type === 'footnoteReference') {
      const id = (node as { identifier?: string }).identifier;
      if (id !== undefined) referenced.add(id);
    }
  });
  return referenced;
}

function definedIds(root: Root): Set<string> {
  const defined = new Set<string>();
  visit(root, (node) => {
    if (node.type === 'definition' || node.type === 'footnoteDefinition') {
      const id = (node as { identifier?: string }).identifier;
      if (id !== undefined) defined.add(id);
    }
  });
  return defined;
}

// ---------------------------------------------------------------------------
// Load side (plan §6.1 + §6.2 step 1)
// ---------------------------------------------------------------------------

/**
 * Capture everything the save-side splice needs. Source slices are taken from
 * the ORIGINAL bytes (pre-EOL-normalization) — the v3 fix — so untouched
 * blocks keep stray per-line EOLs verbatim. The editor gets `editorContent`
 * (LF-normalized).
 *
 * Throws SpliceError on impossible input; callers route through
 * sniffWysiwygCompatibility() first, which catches parse failures.
 */
export function prepareSpliceBaseline(originalContent: string): SpliceBaseline {
  const editorContent = normalizeEol(originalContent);
  const collapses = crlfCollapseOffsets(originalContent);
  const root = parseRoot(editorContent);
  const offsets = blockOffsets(root);

  const blocks: SpliceBlock[] = offsets.map((range, ordinal) => ({
    sourceText: originalContent.slice(
      toOriginalOffset(range.start, collapses),
      toOriginalOffset(range.end, collapses),
    ),
    normText: normalizeBlock(editorContent.slice(range.start, range.end)),
    ordinal,
  }));

  const betweenSeps: string[] = [];
  for (let i = 0; i + 1 < offsets.length; i++) {
    betweenSeps.push(
      originalContent.slice(
        toOriginalOffset(offsets[i].end, collapses),
        toOriginalOffset(offsets[i + 1].start, collapses),
      ),
    );
  }

  return {
    originalContent,
    eol: detectEol(originalContent),
    trailingNewline: /\r?\n$/.test(originalContent),
    editorContent,
    blocks,
    leadingSep: offsets.length > 0
      ? originalContent.slice(0, toOriginalOffset(offsets[0].start, collapses))
      : originalContent,
    betweenSeps,
    trailingSep: offsets.length > 0
      ? originalContent.slice(toOriginalOffset(offsets[offsets.length - 1].end, collapses))
      : '',
    hasRefDefinitions: hasRefOrFootnoteDefinitions(root),
  };
}

// ---------------------------------------------------------------------------
// Save side (plan §6.2 steps 2–6)
// ---------------------------------------------------------------------------

interface NewBlock {
  /** Raw slice of the editor's serialized doc — emitted for changed/inserted
   * blocks. Already normalized (it came from the editor's serializer) and,
   * unlike a standalone re-stringify, keeps cross-block references intact. */
  slice: string;
  /** Alignment key (parse-standalone canonical form) — never emitted. */
  normText: string;
}

function fallbackOutcome(
  baseline: SpliceBaseline,
  editedMarkdown: string,
  reason: SpliceFallbackReason,
): SpliceOutcome {
  recordFallback(reason);
  return {
    content: applyEolPolicy(normalizeEol(editedMarkdown), baseline),
    fallback: true,
    fallbackReason: reason,
  };
}

/** Whole-doc write: dominant EOL + original trailing-newline presence. */
function applyEolPolicy(lfText: string, baseline: SpliceBaseline): string {
  let text = lfText.replace(/\n+$/, '');
  if (baseline.trailingNewline && text.length > 0) text += '\n';
  return convertEol(text, baseline.eol);
}

/**
 * Splice the editor's serialized markdown against the load-time baseline.
 * Unchanged top-level blocks emit their original byte slices; changed or
 * inserted blocks emit this module's normalization converted to the dominant
 * EOL. Any error falls back to a whole-doc write (never lose data) and bumps
 * the fallback counter.
 */
export function spliceMarkdown(baseline: SpliceBaseline, editedMarkdown: string): SpliceOutcome {
  try {
    return spliceInner(baseline, editedMarkdown);
  } catch {
    return fallbackOutcome(baseline, editedMarkdown, 'internal-error');
  }
}

function spliceInner(baseline: SpliceBaseline, editedMarkdown: string): SpliceOutcome {
  const editedLf = normalizeEol(editedMarkdown);

  let newRoot: Root;
  let newOffsets: OffsetRange[];
  try {
    newRoot = parseRoot(editedLf);
    newOffsets = blockOffsets(newRoot);
  } catch {
    return fallbackOutcome(baseline, editedMarkdown, 'parse-error');
  }

  if (newOffsets.length === 0) {
    // Editor emptied the document — nothing to splice.
    return { content: applyEolPolicy(editedLf, baseline), fallback: false };
  }

  const newBlocks: NewBlock[] = newOffsets.map((range) => {
    const slice = editedLf.slice(range.start, range.end);
    return { slice, normText: normalizeBlock(slice) };
  });

  const oldNorms = baseline.blocks.map((b) => b.normText);
  const newNorms = newBlocks.map((b) => b.normText);

  // --- Align (plan §6.2 step 3) ---
  const parts = diffArrays(oldNorms, newNorms);
  const oldIdxOfNew = new Map<number, number>();
  {
    let oi = 0;
    let ni = 0;
    for (const part of parts) {
      const len = part.value.length;
      if (part.added) ni += len;
      else if (part.removed) oi += len;
      else {
        for (let k = 0; k < len; k++) oldIdxOfNew.set(ni + k, oi + k);
        oi += len;
        ni += len;
      }
    }
  }
  const anyChange =
    oldIdxOfNew.size !== oldNorms.length || oldIdxOfNew.size !== newNorms.length;

  // --- Duplicate-ambiguity tie-breakers (plan §6.2 step 3) ---
  const countIn = (arr: string[]) => {
    const m = new Map<string, number>();
    for (const v of arr) m.set(v, (m.get(v) ?? 0) + 1);
    return m;
  };
  const oldCount = countIn(oldNorms);
  const newCount = countIn(newNorms);
  const matchedCount = new Map<string, number>();
  for (const ni of oldIdxOfNew.keys()) {
    const v = newNorms[ni];
    matchedCount.set(v, (matchedCount.get(v) ?? 0) + 1);
  }
  const oldSpellings = new Map<string, Set<string>>();
  for (const b of baseline.blocks) {
    let set = oldSpellings.get(b.normText);
    if (!set) oldSpellings.set(b.normText, (set = new Set()));
    set.add(b.sourceText);
  }

  const lastNew = newNorms.length - 1;
  const lastOld = oldNorms.length - 1;

  const neighborsAgree = (ni: number, oi: number): boolean => {
    const prevOk = ni === 0 ? oi === 0 : oldIdxOfNew.get(ni - 1) === oi - 1;
    const nextOk = ni === lastNew ? oi === lastOld : oldIdxOfNew.get(ni + 1) === oi + 1;
    return prevOk && nextOk;
  };

  /** A matched pair may emit original bytes only when the pairing is
   * unambiguous; ambiguous duplicates are treated as changed. */
  const acceptedAsUnchanged = (ni: number): boolean => {
    const oi = oldIdxOfNew.get(ni);
    if (oi === undefined) return false;
    const v = newNorms[ni];
    const co = oldCount.get(v) ?? 0;
    const cn = newCount.get(v) ?? 0;
    if (co === 1 && cn === 1) return true;
    // all old occurrences spelled identically — any pairing is byte-equivalent
    if ((oldSpellings.get(v)?.size ?? 0) === 1) return true;
    // every occurrence matched on both sides — in-order pairing is unique
    if (co === cn && matchedCount.get(v) === co) return true;
    // ordinal/neighbor tie-breaker
    return neighborsAgree(ni, oi);
  };

  // --- Emit (plan §6.2 step 4) ---
  const defaultSep = baseline.eol + baseline.eol;
  let out = baseline.leadingSep;
  for (let ni = 0; ni < newBlocks.length; ni++) {
    if (ni > 0) {
      const prevOld = oldIdxOfNew.get(ni - 1);
      const thisOld = oldIdxOfNew.get(ni);
      const adjacentUnchanged =
        acceptedAsUnchanged(ni - 1) &&
        acceptedAsUnchanged(ni) &&
        prevOld !== undefined &&
        thisOld === prevOld + 1;
      out += adjacentUnchanged ? baseline.betweenSeps[prevOld] : defaultSep;
    }
    if (acceptedAsUnchanged(ni)) {
      out += baseline.blocks[oldIdxOfNew.get(ni)!].sourceText;
    } else {
      out += convertEol(newBlocks[ni].slice, baseline.eol);
    }
  }
  out += baseline.trailingSep;

  // --- Cross-block reference guard (plan §6.2 step 5) ---
  // References the editor output resolves must still resolve post-splice.
  // (Refs that dangle in the editor output itself are user intent — they
  // parse as plain text and never enter `referenced`, so they're exempt.)
  if (anyChange && (baseline.hasRefDefinitions || hasRefOrFootnoteDefinitions(newRoot))) {
    const referenced = referencedIds(newRoot);
    if (referenced.size > 0) {
      const definedInSplice = definedIds(parseRoot(normalizeEol(out)));
      for (const id of referenced) {
        if (!definedInSplice.has(id)) {
          return fallbackOutcome(baseline, editedMarkdown, 'dangling-references');
        }
      }
    }
  }

  return { content: out, fallback: false };
}

// ---------------------------------------------------------------------------
// Compatibility sniffer (plan §6.3) — WP1-A calls this at the FileContentArea
// dispatch; it never reimplements the rules.
// ---------------------------------------------------------------------------

/**
 * Size cap for WYSIWYG routing. Set by the Gate 2 large-doc probe
 * (docs/reviews/markdown-canvas-spike-report.md): headless Crepe create()
 * measured ~1.9s at 100KB, ~8.3s at 500KB, ~21s at 1MB (upstream milkdown
 * #1193). 200KB keeps the worst-case open cost in the low seconds; the
 * human gate should re-measure in-app and tune.
 */
export const WYSIWYG_MAX_BYTES = 200 * 1024;

export type SniffReason = 'mdx' | 'frontmatter' | 'raw-html' | 'too-large' | 'parse-failure';

export type SniffResult = { ok: true } | { ok: false; reason: SniffReason };

const ESM_LINE = /^(?:import\s+(?:.+\s+from\s+)?['"][^'"]+['"]|export\s+(?:default\s|const\s|let\s|var\s|function\s|class\s|\{))/;

/**
 * Pure routing decision: can this markdown open in WYSIWYG, or does it stay on
 * the old renderer? `.mdx` is normally routed by extension at the dispatch;
 * pass `opts.filePath` to let the sniffer own that rule too. Content-level MDX
 * (top-level ESM import/export lines) is caught heuristically either way.
 */
export function sniffWysiwygCompatibility(
  content: string,
  sizeBytes: number,
  opts?: { filePath?: string; maxBytes?: number },
): SniffResult {
  if (opts?.filePath && /\.mdx$/i.test(opts.filePath)) return { ok: false, reason: 'mdx' };
  if (sizeBytes > (opts?.maxBytes ?? WYSIWYG_MAX_BYTES)) return { ok: false, reason: 'too-large' };
  if (/^---[ \t]*(\r?\n|$)/.test(content)) return { ok: false, reason: 'frontmatter' };

  let root: Root;
  let lf: string;
  try {
    lf = normalizeEol(content);
    root = parseRoot(lf);
  } catch {
    return { ok: false, reason: 'parse-failure' };
  }

  // MDX heuristic: a top-level paragraph whose first line is an ESM statement.
  for (const child of root.children) {
    if (child.type !== 'paragraph') continue;
    const start = child.position?.start?.offset;
    if (start === undefined) continue;
    const lineEnd = lf.indexOf('\n', start);
    const firstLine = lf.slice(start, lineEnd === -1 ? undefined : lineEnd);
    if (ESM_LINE.test(firstLine)) return { ok: false, reason: 'mdx' };
  }

  // Block-level raw HTML anywhere (top level, or nested in lists/quotes).
  // Inline HTML (parent is paragraph/heading/etc.) is allowed.
  let rawHtmlBlock = false;
  visit(root, (node, parent) => {
    if (node.type !== 'html' || parent === null) return;
    const t = parent.type;
    if (t === 'root' || t === 'blockquote' || t === 'listItem') rawHtmlBlock = true;
  });
  if (rawHtmlBlock) return { ok: false, reason: 'raw-html' };

  return { ok: true };
}
