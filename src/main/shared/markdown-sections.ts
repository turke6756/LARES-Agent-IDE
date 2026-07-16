// Shared markdown section splitter (Wave-2 §B).
//
// Splits a CLAUDE.md / config markdown into heading-bounded sections so the
// context-overhead config-weight classifier (and any later behavioral consumer)
// share ONE parser with identical 1-based line numbering rather than drifting
// private splitters.
//
// Pure: no fs, no Electron, no DB (matches `frontmatter-split.ts` conventions).
// CRLF→LF + BOM normalization is byte-identical to `frontmatter-split.ts`.

export interface MarkdownSection {
  heading: string;     // '(preamble)' for content before the first heading
  level: number;       // 0 for preamble, else 1..3
  startLine: number;   // 1-based
  endLine: number;     // 1-based, inclusive
  text: string;        // full section text incl. heading line
}

/** Strip a leading BOM and normalize CRLF→LF before any scan (mirrors
 *  `frontmatter-split.ts:normalize`). */
function normalize(content: string): string {
  const noBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return noBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

const HEADING_RE = /^(#{1,3})\s+/;

/** Split `content` into heading-bounded sections.
 *
 *  Rules (Wave-2 §B):
 *  - A heading is a line matching `/^#{1,3}\s+/` (levels 1..3; 4+ `#` are not headings).
 *  - Content before the first heading becomes one `'(preamble)'` section (`level: 0`).
 *    A file with no headings is a single preamble spanning the whole file.
 *  - A section runs from its heading line to the line before the next heading of the
 *    SAME OR HIGHER level (i.e. equal-or-smaller `#` count); deeper subsections stay
 *    nested inside their parent's span. Capped at EOF.
 *  - `startLine`/`endLine` are 1-based and inclusive. */
export function splitIntoSections(content: string): MarkdownSection[] {
  const text = normalize(content);
  const lines = text.split('\n');
  const n = lines.length;

  const headings: Array<{ index: number; level: number }> = [];
  for (let i = 0; i < n; i++) {
    const m = HEADING_RE.exec(lines[i]);
    if (m) headings.push({ index: i, level: m[1].length });
  }

  const sections: MarkdownSection[] = [];

  // Preamble: everything before the first heading (whole file when there are none).
  const firstHeadingIndex = headings.length > 0 ? headings[0].index : n;
  if (firstHeadingIndex > 0) {
    sections.push({
      heading: '(preamble)',
      level: 0,
      startLine: 1,
      endLine: firstHeadingIndex, // 1-based line before the first heading
      text: lines.slice(0, firstHeadingIndex).join('\n'),
    });
  }

  for (let k = 0; k < headings.length; k++) {
    const { index, level } = headings[k];
    // Section ends just before the next heading of the same-or-higher level.
    let endExclusive = n;
    for (let j = k + 1; j < headings.length; j++) {
      if (headings[j].level <= level) {
        endExclusive = headings[j].index;
        break;
      }
    }
    sections.push({
      heading: lines[index].replace(HEADING_RE, '').trim(),
      level,
      startLine: index + 1,
      endLine: endExclusive, // 1-based inclusive last line == 0-based (endExclusive-1)+1
      text: lines.slice(index, endExclusive).join('\n'),
    });
  }

  return sections;
}
