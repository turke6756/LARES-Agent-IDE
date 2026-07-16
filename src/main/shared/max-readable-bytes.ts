// Shared max-readable-file-size cap (base plan §3.4).
//
// Promoted out of `context-overhead/ipc-deps.ts` (was the private `READ_CAP`)
// so every reader that has to bound a file read — the overhead FileReader and
// the frontmatter splitter's oversize-body guard — shares one number and one
// deterministic, UTF-8-safe truncation. Pure: no Electron, no DB, no fs.

/** Max bytes any overhead/analytics reader will pull from a single file (1 MB).
 *  Overhead/skill files are small; anything larger is truncated deterministically
 *  and flagged so the UI can show a "truncated" badge. */
export const MAX_READABLE_BYTES = 1024 * 1024;

export interface TruncateResult {
  /** The (possibly truncated) text. */
  text: string;
  /** True when the input exceeded `maxBytes` and was cut. Drives the UI badge. */
  truncated: boolean;
  /** UTF-8 byte length of the ORIGINAL input (before any truncation). */
  originalBytes: number;
}

/** Deterministically truncate `text` to at most `maxBytes` UTF-8 bytes without
 *  splitting a multi-byte sequence. Truncation is a pure function of the input
 *  (no locale/encoding drift), so repeated passes over the same file agree. */
export function truncateToMaxBytes(text: string, maxBytes: number = MAX_READABLE_BYTES): TruncateResult {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) {
    return { text, truncated: false, originalBytes: buf.length };
  }
  // Back off `end` off any trailing UTF-8 continuation byte (0b10xxxxxx) so the
  // slice ends on a character boundary. `\n` and ASCII are single-byte, so this
  // only ever trims a partial multi-byte codepoint.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true, originalBytes: buf.length };
}
