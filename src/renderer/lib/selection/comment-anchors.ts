// Anchor capture + reattachment for persisted selection comments (WP-P5-B,
// plans/selection-to-agent-primitive-plan.md §5 / §7 WP-P5).
//
// A comment stores the quoted text plus ~32 chars of surrounding context
// (prefix/suffix), best-effort character offsets into the markdown source,
// and line numbers when derivable. On reopen the ladder runs:
//   exact offset + doc_hash match → exact text search → fuzzy via
//   prefix/suffix → orphaned.
// All searching is whitespace-tolerant: rendered DOM text and markdown source
// disagree about line wrapping, so matching happens in a whitespace-collapsed
// space with an index map back to raw offsets.

export const ANCHOR_CONTEXT_CHARS = 32;

// ---------------------------------------------------------------------------
// Whitespace-normalized matching core (pure strings)
// ---------------------------------------------------------------------------

interface NormalizedText {
  norm: string;
  /** map[i] = raw index of norm[i] */
  map: number[];
}

function normalizeWithMap(text: string): NormalizedText {
  const norm: string[] = [];
  const map: number[] = [];
  let inWs = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!inWs) {
        norm.push(' ');
        map.push(i);
        inWs = true;
      }
    } else {
      norm.push(ch);
      map.push(i);
      inWs = false;
    }
  }
  return { norm: norm.join(''), map };
}

function normalizeFlat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/** Chars of agreement between the candidate's surroundings and the stored
 * prefix/suffix — used to pick among multiple occurrences of the quote. */
function contextScore(
  norm: string,
  start: number,
  end: number,
  normPrefix: string,
  normSuffix: string,
): number {
  let score = 0;
  for (let i = 1; i <= normPrefix.length; i++) {
    if (norm[start - i] === normPrefix[normPrefix.length - i]) score++;
    else break;
  }
  for (let i = 0; i < normSuffix.length; i++) {
    if (norm[end + i] === normSuffix[i]) score++;
    else break;
  }
  return score;
}

export interface TextMatch {
  /** Raw character offsets into the searched text. */
  start: number;
  end: number;
  /** True when the quote itself was not found and the span was inferred from
   * prefix/suffix alone — the underlying text likely changed. */
  fuzzy: boolean;
}

/**
 * Locate `quote` inside `rawText`, whitespace-tolerantly. Multiple
 * occurrences are disambiguated by prefix/suffix agreement (first wins on a
 * tie). When the quote is gone entirely, falls back to bridging
 * prefix→suffix; returns null when nothing anchors.
 */
export function findBestMatch(
  rawText: string,
  quote: string,
  prefix = '',
  suffix = '',
): TextMatch | null {
  const trimmedQuote = quote.trim();
  if (!trimmedQuote) return null;

  const { norm, map } = normalizeWithMap(rawText);
  const normQuote = normalizeFlat(trimmedQuote);
  const normPrefix = normalizeFlat(prefix);
  const normSuffix = normalizeFlat(suffix);

  const rawEndOf = (normEnd: number): number => {
    // norm index normEnd-1 is the last quote char; its raw index + 1 is the
    // exclusive raw end (a collapsed-whitespace last char maps to the run's
    // first raw char — acceptable for an end bound on a trimmed quote).
    return map[normEnd - 1] + 1;
  };

  // Exact (whitespace-normalized) occurrences.
  const occurrences: number[] = [];
  let at = norm.indexOf(normQuote);
  while (at !== -1) {
    occurrences.push(at);
    at = norm.indexOf(normQuote, at + 1);
  }

  if (occurrences.length > 0) {
    let best = occurrences[0];
    if (occurrences.length > 1) {
      let bestScore = -1;
      for (const occ of occurrences) {
        const score = contextScore(norm, occ, occ + normQuote.length, normPrefix, normSuffix);
        if (score > bestScore) {
          bestScore = score;
          best = occ;
        }
      }
    }
    return { start: map[best], end: rawEndOf(best + normQuote.length), fuzzy: false };
  }

  // Fuzzy: quote text changed — bridge from prefix to suffix if both still
  // exist in order, within a window of ~2× the quote's length. Untrimmed
  // collapsed context keeps boundary whitespace out of the bridged span.
  if (normPrefix.trim() && normSuffix.trim()) {
    const pIdx = norm.indexOf(normPrefix);
    if (pIdx !== -1) {
      const spanStart = pIdx + normPrefix.length;
      const sIdx = norm.indexOf(normSuffix, spanStart);
      if (sIdx !== -1 && sIdx - spanStart <= Math.max(normQuote.length * 2, 64)) {
        if (sIdx === spanStart) return null; // nothing left between them
        return { start: map[spanStart], end: rawEndOf(sIdx), fuzzy: true };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Source anchors (markdown source string)
// ---------------------------------------------------------------------------

export interface SourceAnchor {
  anchorStart: number;
  anchorEnd: number;
  lineStart: number;
  lineEnd: number;
}

function lineOfOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/**
 * Best-effort offsets + 1-based line numbers of the quote inside the
 * markdown SOURCE. Rendered selections over formatted spans (bold, links…)
 * won't match the raw source — returns null then; the comment still
 * reattaches in the DOM via prefix/suffix.
 */
export function computeSourceAnchor(
  source: string,
  quote: string,
  prefix = '',
  suffix = '',
): SourceAnchor | null {
  const match = findBestMatch(source, quote, prefix, suffix);
  if (!match || match.fuzzy) return null;
  return {
    anchorStart: match.start,
    anchorEnd: match.end,
    lineStart: lineOfOffset(source, match.start),
    lineEnd: lineOfOffset(source, Math.max(match.start, match.end - 1)),
  };
}

// ---------------------------------------------------------------------------
// DOM capture + reattachment
// ---------------------------------------------------------------------------

interface CollectedText {
  text: string;
  /** Text nodes in document order with their start offset in `text`. */
  nodes: Array<{ node: Text; start: number }>;
}

function collectText(container: Node): CollectedText {
  const doc = container.ownerDocument ?? (container as Document);
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number }> = [];
  const parts: string[] = [];
  let length = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    nodes.push({ node: t, start: length });
    parts.push(t.data);
    length += t.data.length;
  }
  return { text: parts.join(''), nodes };
}

function absoluteOffsetOf(collected: CollectedText, node: Node, offset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const entry = collected.nodes.find((e) => e.node === node);
    return entry ? entry.start + offset : null;
  }
  // Element boundary: resolve to the start of the offset-th child's first
  // text node (or the end of the collected text when past the last child).
  const children = node.childNodes;
  for (let i = offset; i < children.length; i++) {
    const sub = collectFirstTextNode(children[i]);
    if (sub) {
      const entry = collected.nodes.find((e) => e.node === sub);
      if (entry) return entry.start;
    }
  }
  return collected.text.length;
}

function collectFirstTextNode(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text;
  for (let i = 0; i < node.childNodes.length; i++) {
    const found = collectFirstTextNode(node.childNodes[i]);
    if (found) return found;
  }
  return null;
}

export interface SelectionCaptureDetail {
  prefix: string;
  suffix: string;
}

/**
 * ~32 chars of text on each side of the live selection range, in the
 * container's concatenated-text-node space.
 */
export function captureSelectionDetail(range: Range, container: Node): SelectionCaptureDetail {
  const collected = collectText(container);
  const start = absoluteOffsetOf(collected, range.startContainer, range.startOffset);
  const end = absoluteOffsetOf(collected, range.endContainer, range.endOffset);
  if (start == null || end == null) return { prefix: '', suffix: '' };
  return {
    prefix: collected.text.slice(Math.max(0, start - ANCHOR_CONTEXT_CHARS), start),
    suffix: collected.text.slice(end, end + ANCHOR_CONTEXT_CHARS),
  };
}

export interface DomQuoteMatch {
  range: Range;
  fuzzy: boolean;
}

/**
 * Reattach a stored quote to the live DOM: whitespace-tolerant text search
 * over the container's text nodes, disambiguated by prefix/suffix, fuzzy
 * prefix→suffix bridge as a last resort. Null = orphaned.
 */
export function findQuoteInDom(
  container: HTMLElement,
  quote: string,
  prefix = '',
  suffix = '',
): DomQuoteMatch | null {
  const collected = collectText(container);
  if (!collected.nodes.length) return null;
  const match = findBestMatch(collected.text, quote, prefix, suffix);
  if (!match) return null;

  const positionFor = (absolute: number, isEnd: boolean): { node: Text; offset: number } | null => {
    for (let i = collected.nodes.length - 1; i >= 0; i--) {
      const entry = collected.nodes[i];
      const within = absolute - entry.start;
      const max = entry.node.data.length;
      if (within >= 0 && (isEnd ? within <= max && within > 0 : within < max)) {
        return { node: entry.node, offset: within };
      }
      if (within >= 0 && within <= max) {
        return { node: entry.node, offset: within };
      }
    }
    return null;
  };

  const startPos = positionFor(match.start, false);
  const endPos = positionFor(match.end, true);
  if (!startPos || !endPos) return null;

  const doc = container.ownerDocument!;
  const range = doc.createRange();
  range.setStart(startPos.node, startPos.offset);
  range.setEnd(endPos.node, endPos.offset);
  return { range, fuzzy: match.fuzzy };
}
