import { describe, it, expect } from 'vitest';
import { buildQuotedPrompt } from './quoted-prompt';

const fileCtx = (lineStart?: number, lineEnd?: number) => ({
  targetType: 'file' as const,
  sourceLabel: 'C:\\ws\\docs\\doc.md',
  file: { filePath: 'C:\\ws\\docs\\doc.md', lineStart, lineEnd },
});

const chatCtx = {
  targetType: 'chat-message' as const,
  sourceLabel: 'agent chat with "Builder"',
};

describe('buildQuotedPrompt', () => {
  it('collapses a single comment-less item: header + Source + bare blockquote, no numbering', () => {
    const out = buildQuotedPrompt(chatCtx, [{ quote: 'just this text' }]);
    expect(out).toBe(
      '[SELECTION COMMENT]\n' +
      'Source: agent chat with "Builder"\n' +
      '\n' +
      '> just this text',
    );
  });

  it('preserves line breaks in multi-line quotes (collapsed form)', () => {
    const out = buildQuotedPrompt(chatCtx, [{ quote: 'line one\nline two\nline three' }]);
    expect(out).toContain('> line one\n> line two\n> line three');
  });

  it('renders a single item WITH a comment in the numbered form', () => {
    const out = buildQuotedPrompt(fileCtx(), [
      { quote: 'check me', comment: 'fact check this section' },
    ]);
    expect(out).toBe(
      '[SELECTION COMMENT]\n' +
      'Source: file C:\\ws\\docs\\doc.md\n' +
      '\n' +
      '1) > check me\n' +
      '   Comment: fact check this section',
    );
  });

  it('numbers multiple items, aligns continuation lines, and marks comment-less items', () => {
    const out = buildQuotedPrompt(fileCtx(), [
      { quote: 'quoted text,\npreserving line breaks', comment: 'fact check this section' },
      { quote: 'another quote' },
    ]);
    expect(out).toBe(
      '[SELECTION COMMENT]\n' +
      'Source: file C:\\ws\\docs\\doc.md\n' +
      '\n' +
      '1) > quoted text,\n' +
      '   > preserving line breaks\n' +
      '   Comment: fact check this section\n' +
      '\n' +
      '2) > another quote\n' +
      '   (no comment — act on this text directly)',
    );
  });

  it('includes Lines: for files with a known range', () => {
    const out = buildQuotedPrompt(fileCtx(41, 58), [{ quote: 'q' }]);
    expect(out).toContain('Source: file C:\\ws\\docs\\doc.md\nLines: 41-58\n');
  });

  it('renders a single-line range without a dash', () => {
    const out = buildQuotedPrompt(fileCtx(41, 41), [{ quote: 'q' }]);
    expect(out).toContain('\nLines: 41\n');
    expect(out).not.toContain('41-41');
  });

  it('omits Lines: when the range is unknown', () => {
    expect(buildQuotedPrompt(fileCtx(), [{ quote: 'q' }])).not.toContain('Lines:');
    // file anchor entirely absent
    expect(
      buildQuotedPrompt(
        { targetType: 'file', sourceLabel: 'C:\\ws\\a.md' },
        [{ quote: 'q' }],
      ),
    ).not.toContain('Lines:');
  });

  it('omits Lines: for non-file targets', () => {
    const out = buildQuotedPrompt(
      { ...chatCtx, file: { filePath: 'x', lineStart: 3, lineEnd: 4 } },
      [{ quote: 'q' }],
    );
    expect(out).not.toContain('Lines:');
  });

  it('uses the note sourceLabel verbatim', () => {
    const out = buildQuotedPrompt(
      { targetType: 'note', sourceLabel: 'note "ideas.md"' },
      [{ quote: 'q' }],
    );
    expect(out).toContain('Source: note "ideas.md"');
  });

  it('throws on an empty item list', () => {
    expect(() => buildQuotedPrompt(chatCtx, [])).toThrow();
  });
});
