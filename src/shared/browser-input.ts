// Slice-6 (premium browser) — the SHARED omnibox input resolver.
//
// One source of truth for "what does this typed string mean?", used by BOTH the
// renderer chrome (AddressBar / NewTabPage) and the main-side omnibox suggester
// (omnibox-suggest.ts). Before Slice 6 the AddressBar treated EVERY non-empty
// string as a URL (so "open ai docs" became https://open ai docs) while the NTP
// had a separate, smarter heuristic — this unifies them.
//
// PURE: no Electron, no DOM, no IPC. The main process (M6 scheme/SSRF gate) is
// the enforcement point for what may actually navigate; this only classifies and
// normalizes. The result is always an http(s) URL the caller hands to navigate /
// createTab, where the gate has final say.

export interface ResolvedBrowserInput {
  /** 'url' = the input parses as a host/URL → navigate it directly.
   *  'search' = free text → a web search. */
  kind: 'url' | 'search';
  /** Full http(s) URL handed to navigate/createTab. */
  url: string;
  /** The raw (trimmed) input as typed — display only. */
  display: string;
}

/** Default web-search target for free-text input. Centralized so the omnibox
 *  search row and the resolver agree on the exact URL (dedupe relies on it). */
export function searchUrlFor(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

/** Decide whether a trimmed input looks like a URL/host rather than a search.
 *  Mirrors the (previously NTP-only) heuristic: an explicit scheme, a
 *  protocol-relative "//", localhost, or a space-free host.tld. The space-free
 *  guard is what makes "open ai docs" a search and "github.com" a URL. */
export function looksLikeUrl(input: string): boolean {
  if (!input) return false;
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(input) || // explicit scheme (https://…)
    input.startsWith('//') || // protocol-relative
    /^localhost([:/]|$)/i.test(input) || // bare localhost
    (!/\s/.test(input) && /\.[a-z]{2,}/i.test(input)) // host.tld, no spaces
  );
}

/** Apply the default scheme to a URL-shaped input. Inputs that already carry a
 *  scheme pass through untouched (the main M6 gate decides scheme policy).
 *  Protocol-relative input picks https. */
export function normalizeUrl(input: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return input; // already has a scheme
  if (input.startsWith('//')) return `https:${input}`; // protocol-relative
  return `https://${input}`;
}

/**
 * Resolve a typed omnibox/address-bar string into a concrete navigation target.
 * URL-shaped input is normalized to an http(s) URL; everything else becomes a
 * web search. Empty input resolves to an (empty) search so callers can guard on
 * `display` / a blank query rather than a null.
 */
export function resolveBrowserInput(raw: string): ResolvedBrowserInput {
  const input = raw.trim();
  if (input && looksLikeUrl(input)) {
    return { kind: 'url', url: normalizeUrl(input), display: input };
  }
  return { kind: 'search', url: searchUrlFor(input), display: input };
}
