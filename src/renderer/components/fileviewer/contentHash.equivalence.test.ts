/**
 * §4.0 hash-vector equivalence: the shared content-hash module and the
 * markdownSplice re-export must be the SAME function with the SAME pinned
 * vectors, so the renderer ledger, the coordinator's B1 expectedDiskHash, and
 * the main process's CAS check (src/main/file-writer.ts) can never diverge.
 * The main-suite twin (src/shared/content-hash.test.ts) pins the same vectors
 * on the compiled main-process side.
 */
import { describe, it, expect } from 'vitest';
import { contentHash as sharedContentHash } from '../../../shared/content-hash';
import { contentHash as reExportedContentHash } from './markdownSplice';

// Pinned vectors — must match src/shared/content-hash.test.ts exactly.
const VECTORS: Array<[string, string]> = [
  ['', '0bdcb81aee8d83'],
  ['a', '1c2ba782c97901'],
  ['x', '0189af1820c6f5'],
  ['# Title\r\n\r\nbody\r\n', '1a5e5c66d79fa7'],
  ['a\nb', '1de594bc8e1ca1'],
  ['a\r\nb', '18f8363ee0e6b6'],
  ['hello world', '0b9417d15d1014'],
];

describe('content-hash §4.0 move', () => {
  it('markdownSplice re-exports the shared function (move, not fork)', () => {
    expect(reExportedContentHash).toBe(sharedContentHash);
  });

  it('pinned hash vectors', () => {
    for (const [input, expected] of VECTORS) {
      expect(sharedContentHash(input), JSON.stringify(input)).toBe(expected);
    }
  });
});
