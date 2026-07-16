// WP5 — plan-surface HTML sanitizer (security-first, serve/parse path).
//
// The plan render pane is a hardened WebContentsView with JS disabled + strict
// CSP, so script never executes even if it survives. This sanitizer is
// defense-in-depth on the SERVE side (never in the pane): before HTML reaches
// the pane we strip anything script-bearing so a hostile plan file can't rely
// on a CSP gap or a future misconfiguration.
//
// Implementation note (deviation from the WP5 bullet's "using dompurify"):
// DOMPurify requires a live DOM `window`, which in main means jsdom — and jsdom
// is a dev-only dependency that master-plan risk 2 forbids importing into main
// ("resolved by the parse5 decision; do not import jsdom in main"). parse5 is a
// runtime dependency and already parses every plan surface in `section-reader`,
// so we sanitize by walking that same parse5 tree and re-serializing. Same
// security outcome (script / event-handler / javascript:-URL stripping), no
// jsdom.

import { parse, serialize } from 'parse5';

/** Elements dropped outright — they either execute code or embed foreign,
 *  potentially script-bearing content that a plan surface never legitimately
 *  needs. */
const FORBIDDEN_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'noscript', // its contents become live when JS is off
  'base', // can rewrite the pane's relative-URL base
]);

/** URL-bearing attributes whose value we scheme-check. */
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction']);

/** Schemes that can carry executable payloads in a URL attribute. A leading run
 *  of whitespace / control chars (which the parser may preserve — e.g. a tab or
 *  NUL spliced into `java\tscript:`) is stripped before the scheme is compared
 *  case-insensitively. `data:` is dropped wholesale — a data: URL can navigate
 *  to an attacker-controlled document; real plan surfaces link out with http(s)
 *  or in-doc `#anchor`. The class `[\x00- ]` covers control chars 0x00–0x20. */
function isDangerousUrl(value: string): boolean {
  const v = value.replace(/[\x00- ]+/g, '').toLowerCase();
  return v.startsWith('javascript:') || v.startsWith('data:') || v.startsWith('vbscript:');
}

interface P5Attr {
  name: string;
  value: string;
  prefix?: string;
}
interface P5Node {
  nodeName: string;
  tagName?: string;
  attrs?: P5Attr[];
  childNodes?: P5Node[];
}

/** True for an attribute that must be dropped for safety. */
function isDangerousAttr(a: P5Attr): boolean {
  const name = a.name.toLowerCase();
  // Inline event handlers (onclick, onmouseover, …) — strip every on* attr.
  if (name.startsWith('on')) return true;
  // `srcdoc` injects a nested document; drop unconditionally.
  if (name === 'srcdoc') return true;
  // A `style` attribute is dropped only when it carries a scriptable payload.
  if (name === 'style' && /expression\s*\(|javascript:/i.test(a.value)) return true;
  // Dangerous-scheme URLs in url-bearing attributes.
  if (URL_ATTRS.has(name) && isDangerousUrl(a.value)) return true;
  return false;
}

/** Set the `open` attribute on a `<details>` node so it renders expanded.
 *  Idempotent — a details that is already open is left untouched. */
function forceOpen(node: P5Node): void {
  node.attrs = node.attrs ?? [];
  if (!node.attrs.some((a) => a.name.toLowerCase() === 'open')) {
    node.attrs.push({ name: 'open', value: '' });
  }
}

/** Recursively scrub a parse5 node in place: drop forbidden elements and
 *  dangerous attributes from the surviving subtree. */
function scrub(node: P5Node): void {
  if (!node.childNodes || node.childNodes.length === 0) return;
  const kept: P5Node[] = [];
  for (const child of node.childNodes) {
    const tag = (child.tagName ?? '').toLowerCase();
    if (tag && FORBIDDEN_TAGS.has(tag)) continue; // drop the element + its subtree
    if (child.attrs && child.attrs.length > 0) {
      child.attrs = child.attrs.filter((a) => !isDangerousAttr(a));
    }
    // Doctrine: the HUMAN view renders fully expanded. Agent-authored plan
    // documents carry native <details> blocks (JS-free, so they still toggle in
    // the JS-disabled pane). Force every one open during sanitization rather than
    // stripping it, so the disclosure never hides content from the reader.
    if (tag === 'details') forceOpen(child);
    scrub(child);
    kept.push(child);
  }
  node.childNodes = kept;
}

/**
 * Sanitize a plan-surface HTML string for the render pane. Parse-tolerant
 * (parse5 never throws on malformed input); always returns a serializable
 * document. Idempotent — re-sanitizing sanitized output is a no-op.
 */
export function sanitizePlanHtml(html: string): string {
  const doc = parse(html ?? '') as unknown as P5Node;
  scrub(doc);
  return serialize(doc as never);
}
