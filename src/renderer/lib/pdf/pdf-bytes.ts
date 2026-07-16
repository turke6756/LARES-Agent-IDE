// Shared PDF byte source (plan Part 1.2).
//
// `fetchPdfBytes` pulls a document's bytes through the confined `media://`
// transport ONCE per document session and hands the same ArrayBuffer to every
// consumer (the pdf.js text model and, under Candidate A, the PDFium worker),
// so a document is not read from disk twice. A document-byte ceiling bounds the
// denial-of-service pressure an oversized file can put on renderer memory.
//
// NOTE on the "one buffer, two engines" question raised in the plan: pdf.js's
// `getDocument({ data })` and a PDFium `loadDocument(bytes)` each want their own
// view of the bytes and pdf.js may transfer/detach the buffer it is given. To
// stay safe we cache the bytes here and let each engine copy the slice it needs
// (`buffer.slice(0)`), rather than assume a single ArrayBuffer can be shared
// live across both without a second copy.

/** Default per-document byte ceiling: 512 MiB. A file larger than this is
 *  refused rather than buffered whole into renderer memory. */
export const MAX_PDF_DOCUMENT_BYTES = 512 * 1024 * 1024;

export function mediaUrlFor(filePath: string): string {
  return `media://file/${encodeURIComponent(filePath)}`;
}

interface CacheEntry {
  filePath: string;
  bytes: Promise<ArrayBuffer>;
}

// One buffer per document session, keyed by file path. Cleared on `releasePdfBytes`
// (tab close) so a closed document does not pin memory.
const cache = new Map<string, CacheEntry>();

async function readMediaBytes(filePath: string, maxBytes: number): Promise<ArrayBuffer> {
  const response = await fetch(mediaUrlFor(filePath));
  if (!response.ok) {
    throw new Error(`fetchPdfBytes: media:// responded ${response.status} for ${filePath}`);
  }
  // Reject oversized documents up front when the transport reports a length,
  // before buffering the whole body.
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`fetchPdfBytes: document exceeds the ${maxBytes}-byte ceiling (${declared})`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new Error(`fetchPdfBytes: document exceeds the ${maxBytes}-byte ceiling (${buffer.byteLength})`);
  }
  return buffer;
}

/**
 * Fetch (and cache) a document's bytes for the current session. Concurrent
 * callers for the same path await the same in-flight read. A failed read is not
 * cached, so a transient media:// error can be retried.
 */
export function fetchPdfBytes(filePath: string, maxBytes = MAX_PDF_DOCUMENT_BYTES): Promise<ArrayBuffer> {
  const existing = cache.get(filePath);
  if (existing) return existing.bytes;

  const bytes = readMediaBytes(filePath, maxBytes).catch((err) => {
    // Drop the failed entry so the next call re-attempts the read.
    if (cache.get(filePath)?.bytes === bytes) cache.delete(filePath);
    throw err;
  });
  cache.set(filePath, { filePath, bytes });
  return bytes;
}

/** Release the cached buffer for a document (call on tab/document close). */
export function releasePdfBytes(filePath: string): void {
  cache.delete(filePath);
}

/** Test/teardown helper — drop every cached buffer. */
export function clearPdfBytesCache(): void {
  cache.clear();
}
