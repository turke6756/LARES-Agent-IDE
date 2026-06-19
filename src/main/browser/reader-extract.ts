// Slice 14 — Reading mode (MAIN side). Trusted, user-tab-only article
// extraction + sanitization. This module is PURE (raw HTML string in →
// ReaderArticle out) so it can be unit-tested without a live WebContentsView,
// and so the security-critical sanitize step is exercised directly.
//
// SECURITY: the input HTML is the live page's own markup — i.e. UNTRUSTED
// content. Every code path here treats it as hostile: we extract a candidate
// article subtree, then run it through DOMPurify (configured below) so that NO
// <script>, NO inline event handler (on*), and NO `javascript:` URL can survive
// into the renderer reader overlay. The renderer injects the returned `html`
// into its own trusted DOM, so this sanitize is load-bearing — do not weaken it.

import { JSDOM } from 'jsdom';
import DOMPurify from 'dompurify';
import type { ReaderArticle } from '../../shared/browser';

/** Tags that never belong in a reader view and are stripped outright (DOMPurify
 *  already removes <script>; we also drop active/embedding + styling tags so the
 *  overlay renders clean, inert article text). */
const FORBID_TAGS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'svg',
  'canvas',
  'audio',
  'video',
];

/** Attributes dropped beyond DOMPurify's defaults. `style` is removed so page
 *  CSS can't leak in; DOMPurify already strips every on* handler + javascript:
 *  URL, which is the security guarantee this slice's tests assert. */
const FORBID_ATTR = ['style'];

function pickTitle(doc: Document): string {
  const og = doc.querySelector('meta[property="og:title"], meta[name="og:title"]');
  const ogContent = og?.getAttribute('content')?.trim();
  if (ogContent) return ogContent;
  const docTitle = doc.title?.trim();
  if (docTitle) return docTitle;
  const h1 = doc.querySelector('h1')?.textContent?.trim();
  return h1 || '';
}

function pickByline(doc: Document): string | null {
  const metaSelectors = [
    'meta[name="author"]',
    'meta[property="article:author"]',
    'meta[name="byl"]',
    'meta[name="twitter:creator"]',
  ];
  for (const sel of metaSelectors) {
    const content = doc.querySelector(sel)?.getAttribute('content')?.trim();
    if (content) return content;
  }
  const elSelectors = ['[rel="author"]', '.byline', '.author', '[itemprop="author"]'];
  for (const sel of elSelectors) {
    const text = doc.querySelector(sel)?.textContent?.trim();
    if (text) return text.replace(/\s+/g, ' ');
  }
  return null;
}

/** Heuristic main-content pick: a semantic <article>/<main>/[role=main] if
 *  present, otherwise the block with the most paragraph text, else <body>. No
 *  external dependency (we deliberately don't pull in Readability) — extraction
 *  quality is best-effort; the SANITIZE step is what's load-bearing + tested. */
function pickContent(doc: Document): Element | null {
  const semantic =
    doc.querySelector('article') ??
    doc.querySelector('main') ??
    doc.querySelector('[role="main"]');
  if (semantic && (semantic.textContent ?? '').trim().length > 0) return semantic;

  // Score candidate containers by the length of text held in their <p> children.
  let best: Element | null = null;
  let bestScore = 0;
  for (const candidate of Array.from(doc.querySelectorAll('div, section, main, article'))) {
    let score = 0;
    for (const p of Array.from(candidate.querySelectorAll(':scope > p'))) {
      score += (p.textContent ?? '').trim().length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best) return best;
  return doc.body ?? null;
}

/**
 * Extract a readable article from a page's raw HTML and return a SANITIZED
 * result. `baseUrl` (the tab's committed URL) lets jsdom resolve relative
 * links/images during parsing; it is never trusted for control flow.
 */
export function extractReaderArticle(rawHtml: string, baseUrl?: string): ReaderArticle {
  const dom = new JSDOM(rawHtml || '<!doctype html><html><body></body></html>', {
    url: baseUrl && /^https?:/i.test(baseUrl) ? baseUrl : undefined,
  });
  const { window } = dom;
  const doc = window.document;

  const title = pickTitle(doc);
  const byline = pickByline(doc);
  const contentEl = pickContent(doc);
  const rawContentHtml = contentEl ? contentEl.innerHTML : '';

  // jsdom's window satisfies DOMPurify's WindowLike at runtime; the DOM lib's
  // `Window` type is structurally narrower than the @types/dompurify param, so
  // bridge it through the factory's own parameter type.
  const purify = DOMPurify(window as unknown as Parameters<typeof DOMPurify>[0]);
  const html = purify.sanitize(rawContentHtml, {
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    // DOMPurify forbids on* handler attributes and javascript:/data: script URLs
    // by default; these options only ADD to that baseline. Never set
    // ADD_ATTR/ADD_TAGS for scriptable content here.
  });

  // Reading-time source: count visible characters that SURVIVED sanitization, so
  // the estimate reflects what the reader will actually render.
  const measure = doc.createElement('div');
  measure.innerHTML = html;
  const textLength = (measure.textContent ?? '').replace(/\s+/g, ' ').trim().length;

  return { title, byline, html, textLength };
}
