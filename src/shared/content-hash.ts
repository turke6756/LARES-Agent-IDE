// The ONE hash function for content identity, shared by renderer AND main
// (edit-loss plan §4.0). Moved verbatim from
// src/renderer/components/fileviewer/markdownSplice.ts (WP1-B task 8), which
// re-exports it for compatibility. Consumers: the write-generation ledger
// (useFileContentCache), the save coordinator's expectedDiskHash (B1), the
// conditional-write CAS check in src/main/file-writer.ts, and the future
// selection-comment doc_hash. All of them MUST consume this export, never
// reimplement it, so hashes computed on either side of the IPC boundary
// always compare. Pure module: no DOM, no Node, no renderer imports.

/**
 * Pure, fast, non-cryptographic 53-bit hash (cyrb53) of the exact string —
 * no EOL or whitespace normalization, byte-identity only. Returns a fixed
 * 14-char lowercase hex string.
 */
export function contentHash(content: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const h = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return h.toString(16).padStart(14, '0');
}
