/**
 * Gate 1 fixture matrix (plan §6.4). Pass = byte-identical untouched
 * top-level blocks across every fixture, and correct exclusion routing.
 *
 * The "editor" is simulated with the same kind of remark pipeline a WYSIWYG
 * serializer uses: parse + stringify normalizes the whole document (the exact
 * failure mode the splice exists to absorb). Runs in node env — no CSS, no DOM.
 */
import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import remarkGfm from 'remark-gfm';
import {
  prepareSpliceBaseline,
  spliceMarkdown,
  sniffWysiwygCompatibility,
  detectEol,
  getSpliceFallbackCount,
  onSpliceFallback,
  type SpliceBaseline,
} from './markdownSplice';

const editorPipeline = unified().use(remarkParse).use(remarkGfm).use(remarkStringify);

/** Simulate a WYSIWYG load → serialize cycle: full-document normalization. */
function editorRoundtrip(markdown: string): string {
  return editorPipeline.stringify(editorPipeline.parse(markdown)) as string;
}

/** Load fixture, run an untouched editor session, save. */
function noOpSave(fixture: string) {
  const baseline = prepareSpliceBaseline(fixture);
  return spliceMarkdown(baseline, editorRoundtrip(baseline.editorContent));
}

/** Load fixture, apply a text edit to the editor's serialized doc, save. */
function editAndSave(fixture: string, edit: (editorDoc: string) => string) {
  const baseline = prepareSpliceBaseline(fixture);
  const editorDoc = editorRoundtrip(baseline.editorContent);
  const edited = edit(editorDoc);
  expect(edited).not.toBe(editorDoc); // guard against fixtures drifting under the edit
  return { baseline, result: spliceMarkdown(baseline, edited) };
}

// ---------------------------------------------------------------------------
// §6.4 fixtures
// ---------------------------------------------------------------------------

const FIXTURES: Record<string, string> = {
  crlf: '# Title\r\n\r\nFirst para.\r\n\r\n- alpha\r\n- beta\r\n\r\nLast para.\r\n',

  mixedEol: '# Head\n\npara A\r\npara A line2\n\n- item1\r\n- item2\n\nclosing para\n',

  noTrailingNewline: '# T\n\nmiddle para\n\nfinal para',

  nestedLists: [
    '# Lists',
    '',
    '- alpha',
    '  1. one',
    '  2. two',
    '     - [ ] task open',
    '     - [x] task done',
    '- beta',
    '',
    'after the list',
    '',
  ].join('\n'),

  blockquote: [
    'intro para',
    '',
    '> quote line one',
    '>',
    '> - nested item',
    '>   continued line',
    '>',
    '> closing quote line',
    '',
    'outro para',
    '',
  ].join('\n'),

  setext: ['Top Title', '=========', '', 'Section', '-------', '', 'body para', ''].join('\n'),

  duplicateSpellings: '*dup text*\n\nmiddle para\n\n_dup text_\n',

  refLinks: [
    'See [the docs][ref] for details.',
    '',
    'Other para.',
    '',
    '[ref]: https://example.com',
    '',
  ].join('\n'),

  footnotes: [
    'Body with a footnote[^1].',
    '',
    'Another para.',
    '',
    '[^1]: The note text.',
    '',
  ].join('\n'),

  tables: [
    'before table',
    '',
    '|left|right|',
    '|-|-|',
    '|1|2|',
    '',
    'after table',
    '',
  ].join('\n'),

  fences: [
    '# Code',
    '',
    '````md',
    '```',
    '# not a heading, fenced',
    '```',
    '````',
    '',
    'after fence',
    '',
  ].join('\n'),

  altStyles: '_emphasis_ and __strong__\n\n1) first\n2) second\n\ntail para\n',

  boilerplate: [
    'Repeated boilerplate paragraph.',
    '',
    'Repeated boilerplate paragraph.',
    '',
    'unique middle',
    '',
    'Repeated boilerplate paragraph.',
    '',
  ].join('\n'),
};

// ---------------------------------------------------------------------------
// Gate 1 core invariant: a no-op editor session saves byte-identically
// ---------------------------------------------------------------------------

describe('no-op save is byte-identical (whole file)', () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(name, () => {
      const result = noOpSave(fixture);
      expect(result.fallback).toBe(false);
      expect(result.content).toBe(fixture);
    });
  }
});

// ---------------------------------------------------------------------------
// Targeted edits: untouched top-level blocks stay byte-identical
// ---------------------------------------------------------------------------

describe('untouched blocks survive edits byte-identically', () => {
  it('crlf: editing one paragraph preserves CRLF everywhere else', () => {
    const { result } = editAndSave(FIXTURES.crlf, (doc) =>
      doc.replace('First para.', 'First para, edited.'),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toBe(
      '# Title\r\n\r\nFirst para, edited.\r\n\r\n- alpha\r\n- beta\r\n\r\nLast para.\r\n',
    );
  });

  it('mixedEol: stray CRLFs inside untouched blocks survive verbatim', () => {
    const { result } = editAndSave(FIXTURES.mixedEol, (doc) =>
      doc.replace('# Head', '# Head Edited'),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toContain('para A\r\npara A line2');
    expect(result.content).toContain('- item1\r\n- item2');
    expect(result.content).toContain('# Head Edited');
  });

  it('mixedEol: editor receives LF-only text', () => {
    const baseline = prepareSpliceBaseline(FIXTURES.mixedEol);
    expect(baseline.editorContent).not.toContain('\r');
  });

  it('noTrailingNewline: editing the final block does not grow a newline', () => {
    const { result } = editAndSave(FIXTURES.noTrailingNewline, (doc) =>
      doc.replace('final para', 'final para!!'),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toBe('# T\n\nmiddle para\n\nfinal para!!');
  });

  it('nestedLists: editing a sibling paragraph leaves the list bytes alone', () => {
    const { result } = editAndSave(FIXTURES.nestedLists, (doc) =>
      doc.replace('after the list', 'after the list, edited'),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toContain(
      '- alpha\n  1. one\n  2. two\n     - [ ] task open\n     - [x] task done\n- beta',
    );
  });

  it('blockquote: editing outro leaves the quote container verbatim', () => {
    const { result } = editAndSave(FIXTURES.blockquote, (doc) =>
      doc.replace('outro para', 'outro para v2'),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toContain(
      '> quote line one\n>\n> - nested item\n>   continued line\n>\n> closing quote line',
    );
  });

  it('setext: untouched setext headings keep their spelling', () => {
    const { result } = editAndSave(FIXTURES.setext, (doc) =>
      doc.replace('body para', 'body para changed'),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toContain('Top Title\n=========');
    expect(result.content).toContain('Section\n-------');
  });

  it('setext: an edited setext heading reserializes (ATX) without touching the other', () => {
    const { result } = editAndSave(FIXTURES.setext, (doc) =>
      doc.replace('# Section', '# Section Two'),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toContain('Top Title\n=========');
    expect(result.content).toContain('# Section Two');
  });

  it('refLinks: definitions and references survive an unrelated edit', () => {
    const { result } = editAndSave(FIXTURES.refLinks, (doc) =>
      doc.replace('Other para.', 'Other para. Edited.'),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toContain('See [the docs][ref] for details.');
    expect(result.content).toContain('[ref]: https://example.com');
  });

  it('refLinks: user deleting the definition is intent, not a splice fallback', () => {
    const { result } = editAndSave(FIXTURES.refLinks, (doc) =>
      doc.replace('[ref]: https://example.com\n', ''),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toContain('See [the docs][ref] for details.');
    expect(result.content).not.toContain('[ref]: https://example.com');
  });

  it('refLinks: editing the reference-using block keeps the reference intact', () => {
    const { result } = editAndSave(FIXTURES.refLinks, (doc) =>
      doc.replace('for details.', 'for more details.'),
    );
    expect(result.fallback).toBe(false);
    // the changed block must emit the editor's slice verbatim — no escaping
    // of [..][..] from a standalone re-parse
    expect(result.content).toContain('See [the docs][ref] for more details.');
    expect(result.content).not.toContain('\\[');
    expect(result.content).toContain('[ref]: https://example.com');
  });

  it('footnotes: note definition survives an unrelated edit', () => {
    const { result } = editAndSave(FIXTURES.footnotes, (doc) =>
      doc.replace('Another para.', 'Another para. More.'),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toContain('Body with a footnote[^1].');
    expect(result.content).toContain('[^1]: The note text.');
  });

  it('tables: sloppy table spelling survives an unrelated edit', () => {
    const { result } = editAndSave(FIXTURES.tables, (doc) =>
      doc.replace('after table', 'after table, edited'),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toContain('|left|right|\n|-|-|\n|1|2|');
  });

  it('fences: nested-backtick fence survives an unrelated edit', () => {
    const { result } = editAndSave(FIXTURES.fences, (doc) =>
      doc.replace('after fence', 'after fence, edited'),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toContain('````md\n```\n# not a heading, fenced\n```\n````');
  });

  it('altStyles: _em_ and 1) spellings survive an unrelated edit', () => {
    const { result } = editAndSave(FIXTURES.altStyles, (doc) =>
      doc.replace('tail para', 'tail para, edited'),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toContain('_emphasis_ and __strong__');
    expect(result.content).toContain('1) first\n2) second');
  });

  it('altStyles: editing the 1) list reserializes only that container', () => {
    const { result } = editAndSave(FIXTURES.altStyles, (doc) =>
      doc.replace('first', 'first!'),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toContain('_emphasis_ and __strong__'); // untouched block keeps spelling
    expect(result.content).toContain('1. first!'); // touched container normalizes
    expect(result.content).toContain('2. second');
    expect(result.content).not.toContain('1) first');
  });

  it('boilerplate: editing one of three identical paragraphs keeps the others', () => {
    const { result } = editAndSave(FIXTURES.boilerplate, (doc) =>
      doc.replace('unique middle', 'unique middle, edited'),
    );
    expect(result.fallback).toBe(false);
    const occurrences = result.content.split('Repeated boilerplate paragraph.').length - 1;
    expect(occurrences).toBe(3);
  });

  it('insertion: a new paragraph lands between untouched neighbours', () => {
    const { result } = editAndSave(FIXTURES.crlf, (doc) =>
      doc.replace('First para.', 'First para.\n\nBrand new para.'),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toBe(
      '# Title\r\n\r\nFirst para.\r\n\r\nBrand new para.\r\n\r\n- alpha\r\n- beta\r\n\r\nLast para.\r\n',
    );
  });

  it('deletion: removing a block keeps remaining blocks byte-identical', () => {
    const { result } = editAndSave(FIXTURES.crlf, (doc) =>
      doc.replace('First para.\n\n', ''),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toContain('# Title');
    expect(result.content).toContain('- alpha\r\n- beta');
    expect(result.content).toContain('Last para.');
    expect(result.content).not.toContain('First para.');
  });
});

// ---------------------------------------------------------------------------
// Duplicate-block ambiguity (plan §6.2 step 3 tie-breakers)
// ---------------------------------------------------------------------------

describe('duplicate blocks with different source spelling', () => {
  it('no-op save preserves both spellings (equal counts, full match)', () => {
    const result = noOpSave(FIXTURES.duplicateSpellings);
    expect(result.fallback).toBe(false);
    expect(result.content).toBe(FIXTURES.duplicateSpellings);
  });

  it('ambiguous survivor of adjacent duplicates is treated as changed', () => {
    const fixture = '_dup_\n\n*dup*\n';
    const baseline = prepareSpliceBaseline(fixture);
    // editor deletes one of the two occurrences — which one survived is ambiguous
    const result = spliceMarkdown(baseline, '*dup*\n');
    expect(result.fallback).toBe(false);
    // must NOT gamble on '_dup_': emit the new normalized serialization
    expect(result.content).toBe('*dup*\n');
  });

  it('neighbor tie-breaker keeps an unambiguous duplicate verbatim', () => {
    const fixture = [
      'anchor A',
      '',
      '_dup_',
      '',
      'anchor B',
      '',
      '*dup*',
      '',
      'anchor C',
      '',
    ].join('\n');
    const { result } = editAndSave(fixture, (doc) =>
      // delete the second occurrence only; the first is pinned by its neighbors
      doc.replace('anchor B\n\n*dup*\n\n', 'anchor B\n\n'),
    );
    expect(result.fallback).toBe(false);
    expect(result.content).toContain('_dup_');
    expect(result.content).not.toContain('*dup*');
  });
});

// ---------------------------------------------------------------------------
// Fallback containment (plan §6.2 step 6) + reference guard (step 5)
// ---------------------------------------------------------------------------

describe('whole-doc fallback', () => {
  it('internal errors fall back to a whole-doc write and bump the counter', () => {
    const baseline = prepareSpliceBaseline('# A\r\n\r\npara\r\n');
    (baseline as { blocks: unknown }).blocks = null; // corrupt → internal throw
    const before = getSpliceFallbackCount();
    const seen: string[] = [];
    const off = onSpliceFallback((reason) => seen.push(reason));
    const result = spliceMarkdown(baseline as SpliceBaseline, '# A\n\npara changed\n');
    off();
    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe('internal-error');
    expect(getSpliceFallbackCount()).toBe(before + 1);
    expect(seen).toEqual(['internal-error']);
    // whole-doc write: dominant EOL + trailing-newline policy applied, no data loss
    expect(result.content).toBe('# A\r\n\r\npara changed\r\n');
  });

  it('a splice-introduced dangling reference falls back to whole-doc', () => {
    // Synthetic baseline: the matched block's *source spelling* defines [a],
    // but its normText claims [b] — emitting source bytes would orphan [b].
    const baseline: SpliceBaseline = {
      originalContent: '[a]: /x\n\nuse [b][b]\n',
      eol: '\n',
      trailingNewline: true,
      editorContent: '[a]: /x\n\nuse [b][b]\n',
      blocks: [
        { sourceText: '[a]: /x', normText: '[b]: /x', ordinal: 0 },
        { sourceText: 'use [b][b]', normText: 'use [b][b]', ordinal: 1 },
      ],
      leadingSep: '',
      betweenSeps: ['\n\n'],
      trailingSep: '\n',
      hasRefDefinitions: true,
    };
    const result = spliceMarkdown(baseline, '[b]: /x\n\nuse [b][b]\n\nnew para\n');
    expect(result.fallback).toBe(true);
    expect(result.fallbackReason).toBe('dangling-references');
    // fallback writes the editor output whole — reference still resolves
    expect(result.content).toContain('[b]: /x');
  });
});

// ---------------------------------------------------------------------------
// EOL detection
// ---------------------------------------------------------------------------

describe('detectEol', () => {
  it('majority CRLF wins', () => {
    expect(detectEol('a\r\nb\r\nc\n')).toBe('\r\n');
  });
  it('LF default, including on ties', () => {
    expect(detectEol('a\nb')).toBe('\n');
    expect(detectEol('a\r\nb\n')).toBe('\n');
    expect(detectEol('no newlines')).toBe('\n');
  });
});

// ---------------------------------------------------------------------------
// Exclusion routing (plan §6.3) — sniffWysiwygCompatibility
// ---------------------------------------------------------------------------

describe('sniffWysiwygCompatibility', () => {
  const ok = { ok: true };

  it('plain markdown is compatible', () => {
    expect(sniffWysiwygCompatibility(FIXTURES.nestedLists, 100)).toEqual(ok);
    expect(sniffWysiwygCompatibility(FIXTURES.refLinks, 100)).toEqual(ok);
  });

  it('frontmatter routes to the old renderer', () => {
    expect(sniffWysiwygCompatibility('---\ntitle: x\n---\n\n# Body\n', 50)).toEqual({
      ok: false,
      reason: 'frontmatter',
    });
    expect(sniffWysiwygCompatibility('---\r\ntitle: x\r\n---\r\n', 50)).toEqual({
      ok: false,
      reason: 'frontmatter',
    });
  });

  it('a mid-document thematic break is NOT frontmatter', () => {
    expect(sniffWysiwygCompatibility('# T\n\n---\n\npara\n', 50)).toEqual(ok);
  });

  it('raw HTML blocks route to the old renderer', () => {
    expect(sniffWysiwygCompatibility('# T\n\n<div>\nhello\n</div>\n', 50)).toEqual({
      ok: false,
      reason: 'raw-html',
    });
  });

  it('raw HTML blocks nested in lists are caught', () => {
    expect(sniffWysiwygCompatibility('- item\n\n  <div>x</div>\n', 50)).toEqual({
      ok: false,
      reason: 'raw-html',
    });
  });

  it('inline HTML is allowed', () => {
    expect(sniffWysiwygCompatibility('Press <kbd>Ctrl</kbd> to win.\n', 50)).toEqual(ok);
  });

  it('mdx by file extension', () => {
    expect(sniffWysiwygCompatibility('# fine content\n', 50, { filePath: 'C:/docs/page.MDX' }))
      .toEqual({ ok: false, reason: 'mdx' });
  });

  it('mdx by content (top-level ESM import)', () => {
    expect(
      sniffWysiwygCompatibility("import Chart from './chart'\n\nSome text.\n", 60),
    ).toEqual({ ok: false, reason: 'mdx' });
  });

  it('prose starting with the word import is not mdx', () => {
    expect(sniffWysiwygCompatibility('import duties are high this year.\n', 50)).toEqual(ok);
  });

  it('files over the cap are too-large', () => {
    expect(sniffWysiwygCompatibility('# small text, huge file', 2 * 1024 * 1024)).toEqual({
      ok: false,
      reason: 'too-large',
    });
    expect(
      sniffWysiwygCompatibility('# fits custom cap', 600, { maxBytes: 500 }),
    ).toEqual({ ok: false, reason: 'too-large' });
  });

  it('parse failures are contained, not thrown', () => {
    const bogus = {} as unknown as string; // .replace explodes inside the pipeline
    expect(sniffWysiwygCompatibility(bogus, 10)).toEqual({ ok: false, reason: 'parse-failure' });
  });
});
