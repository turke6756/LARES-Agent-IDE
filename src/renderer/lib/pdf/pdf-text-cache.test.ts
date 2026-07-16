// pdf-text-cache LRU tests (plan Part 1.6). Pure — node env vitest.
import { describe, expect, it } from 'vitest';
import { PdfTextCache } from './pdf-text-cache';
import type { NormalizedPageText } from './pdf-text-model';

function page(pageIndex: number): NormalizedPageText {
  return { pageIndex, text: `page ${pageIndex}`, items: [] };
}

describe('PdfTextCache', () => {
  it('round-trips a page keyed by {fingerprint, pageIndex}', () => {
    const c = new PdfTextCache();
    c.set('fp', 2, page(2));
    expect(c.get('fp', 2)?.text).toBe('page 2');
    expect(c.get('fp', 3)).toBeUndefined();
    expect(c.get('other', 2)).toBeUndefined();
  });

  it('evicts least-recently-used entries past the cap', () => {
    const c = new PdfTextCache(2);
    c.set('fp', 0, page(0));
    c.set('fp', 1, page(1));
    c.get('fp', 0); // 0 becomes MRU, 1 is now LRU
    c.set('fp', 2, page(2)); // evicts 1
    expect(c.has('fp', 0)).toBe(true);
    expect(c.has('fp', 1)).toBe(false);
    expect(c.has('fp', 2)).toBe(true);
    expect(c.size).toBe(2);
  });

  it('evictDocument drops only the matching fingerprint', () => {
    const c = new PdfTextCache();
    c.set('a', 0, page(0));
    c.set('a', 1, page(1));
    c.set('b', 0, page(0));
    c.evictDocument('a');
    expect(c.has('a', 0)).toBe(false);
    expect(c.has('a', 1)).toBe(false);
    expect(c.has('b', 0)).toBe(true);
  });
});
