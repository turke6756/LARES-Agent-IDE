// Frontmatter splitter (base plan §3.3).
//
// Splits a SKILL.md / CLAUDE.md into the resident *header* (YAML frontmatter
// Claude keeps loaded) and the *body* (loaded on demand). Deliberately does NOT
// reuse `research/frontmatter.ts` — that validator assumes research-specific keys.
// This one is a confidence ladder tolerant of real-world skill files.
//
// Pure: no fs, no Electron, no DB. Oversize bodies are truncated via the shared
// max-readable cap (§3.4) so token estimates stay bounded and deterministic.

import { MAX_READABLE_BYTES, truncateToMaxBytes } from './max-readable-bytes';

export type SplitConfidence = 'exact' | 'low';

export interface FrontmatterSplit {
  /** Resident portion: the leading YAML fence (exact) or a synthesized summary (low). */
  header: string;
  /** On-demand portion: remainder after the fence (exact) or the full file (low). */
  body: string;
  /** Structural confidence of the split. */
  confidence: SplitConfidence;
  /** A non-empty `description:` was parsed from the frontmatter. */
  hasDescription: boolean;
  /** `low` when the description is empty/missing → description-derived signals are unreliable. */
  descriptionConfidence: SplitConfidence;
  /** The body exceeded the max-readable cap and was deterministically truncated. */
  approximate: boolean;
}

export interface SplitOptions {
  /** Fallback title for the synthesized header when there is no fence. */
  name?: string;
  /** Byte cap for the body before truncation. Defaults to `MAX_READABLE_BYTES`. */
  maxBytes?: number;
}

/** Strip a leading BOM and normalize CRLF→LF before any fence scan (§3.3). */
function normalize(content: string): string {
  const noBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return noBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Read a scalar `key:` value out of a YAML frontmatter block (first match). */
function scalarValue(yaml: string, key: string): string | null {
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm');
  const m = re.exec(yaml);
  if (!m) return null;
  // Strip surrounding quotes; treat an empty/quote-only value as absent.
  return m[1].trim().replace(/^["']|["']$/g, '').trim();
}

/** First `# heading` line, or null. */
function firstHeading(text: string): string | null {
  const m = /^#[ \t]+.*$/m.exec(text);
  return m ? m[0].trim() : null;
}

/** First non-empty paragraph that is not a heading line, or null. */
function firstParagraph(text: string): string | null {
  for (const block of text.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (trimmed && !/^#{1,6}[ \t]/.test(trimmed) && !trimmed.startsWith('---')) return trimmed;
  }
  return null;
}

function bound(body: string, maxBytes: number): { body: string; approximate: boolean } {
  const t = truncateToMaxBytes(body, maxBytes);
  return { body: t.text, approximate: t.truncated };
}

/** Split `content` into resident header + on-demand body with a confidence ladder:
 *  1. Valid leading `---`…`---` YAML fence → header = fence block, body = remainder, `exact`.
 *  2. No / unterminated / malformed fence → header = `# <name>` + first paragraph,
 *     body = full file, `low`.
 *  3. Empty `description:` → structurally `exact` but `descriptionConfidence:'low'`.
 *  4. Oversize body → truncated (§3.4), `approximate:true`. */
export function splitFrontmatter(content: string, opts: SplitOptions = {}): FrontmatterSplit {
  const maxBytes = opts.maxBytes ?? MAX_READABLE_BYTES;
  const text = normalize(content);

  // A valid leading fence: `---` on line 1, a later closing `---` on its own line.
  const fence = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (fence) {
    const yaml = fence[1];
    const header = text.slice(0, fence[0].length);
    const rawBody = text.slice(fence[0].length);
    const { body, approximate } = bound(rawBody, maxBytes);
    const description = scalarValue(yaml, 'description');
    const hasDescription = description !== null && description.length > 0;
    return {
      header,
      body,
      confidence: 'exact',
      hasDescription,
      descriptionConfidence: hasDescription ? 'exact' : 'low',
      approximate,
    };
  }

  // Fallback: no usable fence. Synthesize a header, keep the whole file as body.
  const title = opts.name ? `# ${opts.name}` : (firstHeading(text) ?? '# untitled');
  const para = firstParagraph(text);
  const header = para ? `${title}\n\n${para}` : title;
  const { body, approximate } = bound(text, maxBytes);
  return {
    header,
    body,
    confidence: 'low',
    hasDescription: false,
    descriptionConfidence: 'low',
    approximate,
  };
}
