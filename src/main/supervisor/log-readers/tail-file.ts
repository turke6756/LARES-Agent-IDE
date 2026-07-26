// Memory-hardening WP-2 (B): bounded, async log readers.
//
// The main process used to `fs.readFileSync(agent.logPath, 'utf-8')` whole PTY
// `.log` files (46.9 MB observed) into a single string on every big-history
// request — ~3× file size of transient heap per call. These readers replace
// that with a single `open`+`stat` and short-read loops over `fs/promises`,
// never `existsSync` (ENOENT is handled on `open`).
//
// Three DISTINCT contracts — do not conflate them:
//   readFileTail   rune-aligns the HEAD only when truncated (safe: text tail).
//   readFileRange  EXACT bytes, NO alignment (consecutive pages must join
//                  losslessly for xterm's streaming UTF-8 decoder).
//   readLastLines  backward-paged last-N lines, no scan ceiling.

import { open } from 'fs/promises';

export interface ByteRange {
  bytes: Buffer;
  startOffset: number;
  endOffset: number;
  fileSize: number;
  truncated: boolean;
}

/** The supported `getAgentLog` line contract is a POSITIVE FINITE INTEGER.
 *  Invalid values (zero, negative, `NaN`, non-integer) normalize to the
 *  historical default (50) at the public boundary. WP-2 intentionally replaces
 *  today's accidental `slice(0)` / negative-`slice` behavior with this. */
export const DEFAULT_LOG_LINES = 50;
export function normalizeLines(lines: number): number {
  return Number.isInteger(lines) && lines > 0 ? lines : DEFAULT_LOG_LINES;
}

/** TAIL: up to `maxBytes` ending at `endExclusive` (default EOF). MAY align its
 *  one truncation boundary FORWARD off UTF-8 continuation bytes (0x80–0xBF) and
 *  reports the adjusted `startOffset`. Head-align only when truncated.
 *  ENOENT → empty range. fd always closed. */
export async function readFileTail(filePath: string, maxBytes: number, endExclusive?: number): Promise<ByteRange> {
  let fh;
  try {
    fh = await open(filePath, 'r');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { bytes: Buffer.alloc(0), startOffset: 0, endOffset: 0, fileSize: 0, truncated: false };
    throw e;
  }
  try {
    const { size } = await fh.stat();
    const end = endExclusive === undefined ? size : Math.min(endExclusive, size);
    const start = Math.max(0, end - maxBytes);
    const truncated = start > 0;
    const buf = Buffer.allocUnsafe(end - start);
    let read = 0;
    while (read < buf.length) {
      const { bytesRead } = await fh.read(buf, read, buf.length - read, start + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    let off = 0;
    if (truncated) while (off < read && (buf[off] & 0xc0) === 0x80) off++; // rune-align head
    return { bytes: buf.subarray(off, read), startOffset: start + off, endOffset: start + read, fileSize: size, truncated };
  } finally {
    await fh.close();
  }
}

/** RANGE: EXACT [start, min(end,size)) bytes. NO rune alignment whatsoever —
 *  consecutive pages must join losslessly for xterm's streaming UTF-8 decoder.
 *  ENOENT → empty range. fd always closed. */
export async function readFileRange(filePath: string, start: number, end: number): Promise<ByteRange> {
  let fh;
  try {
    fh = await open(filePath, 'r');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return { bytes: Buffer.alloc(0), startOffset: start, endOffset: start, fileSize: 0, truncated: false };
    throw e;
  }
  try {
    const { size } = await fh.stat();
    const from = Math.max(0, start);
    const to = Math.max(from, Math.min(end, size));
    const buf = Buffer.allocUnsafe(to - from);
    let read = 0;
    while (read < buf.length) {
      const { bytesRead } = await fh.read(buf, read, buf.length - read, from + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    return { bytes: buf.subarray(0, read), startOffset: from, endOffset: from + read, fileSize: size, truncated: false };
  } finally {
    await fh.close();
  }
}

/** Backward-paged last-N lines. NO scan ceiling: a normal line-delimited log
 *  allocates only the requested lines; a pathological newline-free file
 *  necessarily returns a large string under the unchanged public contract.
 *  Decodes from a `\n` boundary (0x0A never splits a UTF-8 rune) → rune-safe.
 *  ENOENT → ''. fd always closed. */
export async function readLastLines(filePath: string, lines: number): Promise<string> {
  let fh;
  try {
    fh = await open(filePath, 'r');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return '';
    throw e;
  }
  try {
    const { size } = await fh.stat();
    const PAGE = 65536;
    let pos = size;
    let newlines = 0;
    const pages: Buffer[] = [];
    while (pos > 0 && newlines <= lines) {
      const len = Math.min(PAGE, pos);
      pos -= len;
      const buf = Buffer.allocUnsafe(len);
      let read = 0;
      while (read < len) {
        const { bytesRead } = await fh.read(buf, read, len - read, pos + read);
        if (!bytesRead) break;
        read += bytesRead;
      }
      pages.unshift(buf.subarray(0, read));
      for (let i = 0; i < read; i++) if (buf[i] === 0x0a) newlines++;
    }
    return Buffer.concat(pages).toString('utf8').split('\n').slice(-lines).join('\n');
  } finally {
    await fh.close();
  }
}
