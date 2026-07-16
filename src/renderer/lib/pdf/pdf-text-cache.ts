// In-memory LRU for extracted page text (plan Part 1.6).
//
// Keyed by {fingerprint, pageIndex}. Extracted text is NEVER persisted to
// SQLite — it is cheap to re-derive from pdf.js and would only bloat the DB.
// The model warms pages by priority: current page → pages visible in the
// viewer → ±1 page → pages holding stored comments → the rest on idle. This
// cache just bounds resident memory; the priority ordering lives in the caller.

import type { NormalizedPageText } from './pdf-text-model';

const DEFAULT_MAX_ENTRIES = 24;

function keyOf(fingerprint: string, pageIndex: number): string {
  return `${fingerprint}:${pageIndex}`;
}

export class PdfTextCache {
  // Map keeps insertion order; we delete+set on read to move an entry to the
  // most-recently-used end, and evict from the least-recently-used front.
  private readonly entries = new Map<string, NormalizedPageText>();

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {}

  get(fingerprint: string, pageIndex: number): NormalizedPageText | undefined {
    const key = keyOf(fingerprint, pageIndex);
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    // Bump to MRU.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(fingerprint: string, pageIndex: number, value: NormalizedPageText): void {
    const key = keyOf(fingerprint, pageIndex);
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  has(fingerprint: string, pageIndex: number): boolean {
    return this.entries.has(keyOf(fingerprint, pageIndex));
  }

  /** Drop every page for one document (call when its fingerprint's tab closes). */
  evictDocument(fingerprint: string): void {
    const prefix = `${fingerprint}:`;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
