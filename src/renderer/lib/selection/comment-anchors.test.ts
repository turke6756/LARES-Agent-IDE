// @vitest-environment jsdom
// WP-P5-B: anchor capture + reattach ladder units.
import { describe, it, expect } from 'vitest';
import {
  findBestMatch,
  computeSourceAnchor,
  captureSelectionDetail,
  findQuoteInDom,
} from './comment-anchors';

describe('findBestMatch', () => {
  it('finds an exact occurrence', () => {
    const m = findBestMatch('alpha beta gamma', 'beta');
    expect(m).toEqual({ start: 6, end: 10, fuzzy: false });
  });

  it('is whitespace-tolerant across line wraps', () => {
    const m = findBestMatch('alpha beta\n  gamma delta', 'beta gamma');
    expect(m).not.toBeNull();
    expect(m!.fuzzy).toBe(false);
    expect('alpha beta\n  gamma delta'.slice(m!.start, m!.end)).toBe('beta\n  gamma');
  });

  it('disambiguates repeated quotes by prefix/suffix', () => {
    const text = 'first stop here. second stop there.';
    const m = findBestMatch(text, 'stop', 'second ', ' there');
    expect(text.slice(0, m!.start)).toBe('first stop here. second ');
  });

  it('falls back to a fuzzy prefix→suffix bridge when the quote is gone', () => {
    const text = 'before MANGLED-CONTENT after';
    const m = findBestMatch(text, 'original words', 'before ', ' after');
    expect(m).not.toBeNull();
    expect(m!.fuzzy).toBe(true);
    expect(text.slice(m!.start, m!.end)).toBe('MANGLED-CONTENT');
  });

  it('returns null when nothing anchors', () => {
    expect(findBestMatch('totally different text', 'missing', 'gone', 'also gone')).toBeNull();
    expect(findBestMatch('anything', '   ')).toBeNull();
  });
});

describe('computeSourceAnchor', () => {
  const source = 'line one\nline two with target words\nline three\n';

  it('derives offsets and 1-based line numbers', () => {
    const a = computeSourceAnchor(source, 'target words');
    expect(a).not.toBeNull();
    expect(source.slice(a!.anchorStart, a!.anchorEnd)).toBe('target words');
    expect(a!.lineStart).toBe(2);
    expect(a!.lineEnd).toBe(2);
  });

  it('spans multi-line quotes', () => {
    const a = computeSourceAnchor(source, 'line two with target words line three');
    expect(a).not.toBeNull();
    expect(a!.lineStart).toBe(2);
    expect(a!.lineEnd).toBe(3);
  });

  it('returns null for fuzzy-only matches (no false offsets)', () => {
    expect(computeSourceAnchor(source, 'no such words', 'line two ', ' line three')).toBeNull();
  });
});

describe('DOM capture + reattach', () => {
  function buildDoc(html: string): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  }

  it('captureSelectionDetail returns surrounding text across elements', () => {
    const el = buildDoc('<p>the quick <b>brown fox</b> jumps over the lazy dog</p>');
    const bold = el.querySelector('b')!.firstChild as Text;
    const range = document.createRange();
    range.setStart(bold, 6); // "fox"
    range.setEnd(bold, 9);
    const detail = captureSelectionDetail(range, el);
    expect(detail.prefix.endsWith('the quick brown ')).toBe(true);
    expect(detail.suffix.startsWith(' jumps over')).toBe(true);
    el.remove();
  });

  it('findQuoteInDom reattaches across inline element boundaries', () => {
    const el = buildDoc('<p>alpha <em>beta</em> gamma</p><p>second paragraph</p>');
    const m = findQuoteInDom(el, 'beta gamma');
    expect(m).not.toBeNull();
    expect(m!.fuzzy).toBe(false);
    expect(m!.range.toString().replace(/\s+/g, ' ')).toBe('beta gamma');
    el.remove();
  });

  it('findQuoteInDom uses context to pick among duplicates', () => {
    const el = buildDoc('<p>one match here</p><p>two match there</p>');
    const m = findQuoteInDom(el, 'match', 'two ', ' there');
    expect(m).not.toBeNull();
    // The picked range lives in the second paragraph.
    const secondP = el.querySelectorAll('p')[1];
    expect(secondP.contains(m!.range.startContainer)).toBe(true);
    el.remove();
  });

  it('findQuoteInDom returns null when the quote was mangled beyond context', () => {
    const el = buildDoc('<p>entirely new content</p>');
    expect(findQuoteInDom(el, 'old quote', 'old prefix', 'old suffix')).toBeNull();
    el.remove();
  });

  it('findQuoteInDom reports fuzzy when only the context survives', () => {
    const el = buildDoc('<p>before SOMETHING-ELSE after</p>');
    const m = findQuoteInDom(el, 'the original quote', 'before ', ' after');
    expect(m).not.toBeNull();
    expect(m!.fuzzy).toBe(true);
    el.remove();
  });
});
