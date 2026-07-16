// PDF viewer security policy (plan Part 1.11).
//
// PURE, deterministic policy decisions for the PDF viewer surface — no Electron,
// no I/O — so the security boundary is unit-tested (pdf-security.test.ts) without
// booting a browser. The main process (default-session wiring today; a dedicated
// PDF session under Candidate B) consults these to gate navigation, popups, and
// document size. The `media://` transport itself is unchanged (media-protocol.ts,
// realpath confinement); this module governs what a loaded PDF surface may DO.
//
// INVARIANTS (do not relax):
//   • The only URL the surface may load is the EXACT confined media://file/<enc>
//     URL Lares constructed. Any other media:// path, and every file:/javascript:
//     /data:/blob:/chrome:/chrome-extension:/about: navigation, is denied.
//   • Popups are always denied.
//   • External HTTP(S) links are NEVER opened via unrestricted shell.openExternal;
//     they are handed to the existing Lares browser navigation policy, and only
//     after an explicit user gesture.

// ── Pinned native-parser artifact (supply-chain hygiene, plan 1.11 / R4) ─────

export interface PdfiumArtifactPin {
  /** npm dependency providing the PDFium WASM build + JS wrapper. */
  dependency: string;
  version: string;
  /** License of the JS wrapper. */
  wrapperLicense: string;
  /** License of the underlying PDFium core. */
  coreLicense: string;
  /** Where the artifact is sourced from. */
  source: string;
  /** Checksum of the vendored `.wasm`. PLACEHOLDER until the artifact is pinned
   *  at vendoring time; the loader must verify the real bytes against this. */
  sha256: string;
}

/** The chosen PDFium dependency, pinned. PDFium adds a native-parser attack
 *  surface (documented in docs/security.md); this record makes the exact bytes
 *  auditable and upgrade-visible. */
export const PDFIUM_ARTIFACT: PdfiumArtifactPin = {
  dependency: '@hyzyla/pdfium',
  version: '2.1.13',
  wrapperLicense: 'MIT',
  coreLicense: 'BSD-3-Clause',
  source: 'https://www.npmjs.com/package/@hyzyla/pdfium',
  sha256: 'PLACEHOLDER-pin-at-vendoring-time',
};

// ── Document-size ceiling (DoS bound, plan 1.11 / R4) ────────────────────────

/** Mirror of the renderer's `pdf-bytes` ceiling (512 MiB). A document larger
 *  than this — or a malformed/non-finite reported size — is refused before it
 *  is handed to the native parser. */
export const MAX_PDF_DOCUMENT_BYTES = 512 * 1024 * 1024;

/** True only for a real, non-negative size within the ceiling. Malformed sizes
 *  (NaN, Infinity, negative, non-integer) are rejected. */
export function isDocumentSizeAllowed(bytes: number, maxBytes = MAX_PDF_DOCUMENT_BYTES): boolean {
  return Number.isInteger(bytes) && bytes >= 0 && bytes <= maxBytes;
}

/** Throwing guard for the load path. */
export function assertPdfDocumentSize(bytes: number, maxBytes = MAX_PDF_DOCUMENT_BYTES): void {
  if (!isDocumentSizeAllowed(bytes, maxBytes)) {
    throw new Error(`PDF document rejected: size ${bytes} is malformed or exceeds ${maxBytes} bytes`);
  }
}

// ── Confined initial URL ─────────────────────────────────────────────────────

/** Build the one URL the PDF surface is allowed to load, from a confined path.
 *  Matches the renderer's `mediaUrlFor` encoding exactly so comparisons agree. */
export function buildConfinedPdfUrl(filePath: string): string {
  return `media://file/${encodeURIComponent(filePath)}`;
}

/** The initial document load is allowed ONLY when it is byte-for-byte the URL
 *  Lares supplied. No prefix/normalization slack — an attacker-influenced path
 *  that merely starts with the expected origin must not pass. */
export function isAllowedInitialUrl(url: string, expectedUrl: string): boolean {
  return typeof url === 'string' && url.length > 0 && url === expectedUrl;
}

// ── Navigation policy ────────────────────────────────────────────────────────

export type PdfNavigationDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  /** Hand off to the existing Lares browser navigation policy (never a raw
   *  shell.openExternal). Only produced for an http(s) link after a gesture. */
  | { action: 'external'; url: string };

/** Schemes that are always denied inside the PDF surface. */
const DENIED_SCHEMES = new Set([
  'file:',
  'javascript:',
  'data:',
  'blob:',
  'chrome:',
  'chrome-extension:',
  'about:',
  'devtools:',
]);

export interface PdfNavigationContext {
  /** The exact confined media:// URL the surface was opened with. */
  expectedInitialUrl: string;
  /** Whether this navigation was triggered by an explicit user gesture. */
  userGesture?: boolean;
}

/**
 * Decide whether a navigation the PDF surface attempts is allowed, denied, or
 * should be routed externally through the browser policy.
 *
 *  • the exact confined initial URL           → allow
 *  • any OTHER media:// path                   → deny
 *  • file:/javascript:/data:/blob:/chrome:/…   → deny
 *  • http(s) WITH a user gesture               → external (browser policy)
 *  • http(s) WITHOUT a gesture                 → deny
 *  • unparseable / unknown scheme              → deny
 */
export function evaluatePdfNavigation(url: string, ctx: PdfNavigationContext): PdfNavigationDecision {
  if (isAllowedInitialUrl(url, ctx.expectedInitialUrl)) return { action: 'allow' };

  let scheme: string;
  try {
    scheme = new URL(url).protocol.toLowerCase();
  } catch {
    return { action: 'deny', reason: 'unparseable URL' };
  }

  if (scheme === 'media:') {
    // A confined path other than the one we opened — never allowed.
    return { action: 'deny', reason: 'foreign media:// path' };
  }
  if (DENIED_SCHEMES.has(scheme)) {
    return { action: 'deny', reason: `denied scheme ${scheme}` };
  }
  if (scheme === 'http:' || scheme === 'https:') {
    if (!ctx.userGesture) return { action: 'deny', reason: 'external navigation requires a user gesture' };
    return { action: 'external', url };
  }
  return { action: 'deny', reason: `unsupported scheme ${scheme}` };
}

/** Popups are always denied on the PDF surface (windowOpen handler → deny). */
export function shouldDenyPdfPopup(): boolean {
  return true;
}
