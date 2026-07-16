// WP5 — sandboxed plan render pane (security-first decisions, Electron-free).
//
// The plan surface renders in a `WebContentsView` created with the same hardened
// factory the browser panes use (`buildBrowserWebPreferences`) but with
// JavaScript DISABLED — a plan surface is a static document, never an app. This
// module owns the *decisions* that make the pane safe (web preferences, CSP,
// document wrapper, the served data: URL) so they are pure and unit-testable;
// the thin Electron lifecycle (create/attach/loadURL/refresh) lives in the
// manager that consumes them.
//
// Defense in depth, three independent layers, any one of which blocks script:
//   1. `sanitizePlanHtml` strips <script>/on*/javascript: on the SERVE side.
//   2. `javascript: false` in web preferences — the pane's V8 can't run JS.
//   3. A strict CSP meta with no script-src — even injected script won't load.

import { sanitizePlanHtml } from './sanitize-plan-html';

/** Web preferences for the plan pane: the hardened browser-pane baseline plus
 *  `javascript:false`. Declared structurally (Electron-free) so this module and
 *  its test stay import-light; the manager spreads it into
 *  `new WebContentsView({ webPreferences: { ...PLAN_PANE_WEB_PREFERENCES, session } })`. */
export interface PlanPaneWebPreferences {
  sandbox: boolean;
  contextIsolation: boolean;
  nodeIntegration: boolean;
  nodeIntegrationInSubFrames: boolean;
  webSecurity: boolean;
  allowRunningInsecureContent: boolean;
  webviewTag: boolean;
  preload: undefined;
  /** The plan-pane-specific hardening: a static document never runs JS. */
  javascript: false;
  backgroundThrottling: boolean;
}

export const PLAN_PANE_WEB_PREFERENCES: PlanPaneWebPreferences = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  preload: undefined,
  javascript: false, // WP5: plan surfaces are static — no script execution, ever
  backgroundThrottling: true,
};

/** Strict Content-Security-Policy for a plan surface. No `script-src` (falls
 *  back to `default-src 'none'` → scripts blocked). Inline styles are permitted
 *  because plan HTML carries benign presentational `style=` attributes; images
 *  and fonts are allowed as `data:`/https so a plan can embed diagrams. `base`,
 *  `form-action`, and framing are all locked to nothing. */
export function planSurfaceCsp(): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data: https:",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The pane's own document CSS: make the surface fill (and scroll within) the
 * WebContentsView viewport rather than growing past it. `html,body { height:100% }`
 * pins the scroll container to the pane's clamped bounds so a plan taller than the
 * pane scrolls INSIDE it (the bounds clamp keeps the view on-screen; this keeps
 * the long document reachable). `overflow-x:hidden` + `max-width:100%` on wide
 * children stops a stray table/pre from forcing a horizontal scrollbar. Inline —
 * the CSP already allows `style-src 'unsafe-inline'`. `viewport` meta was dropped:
 * a data: document has no responsive scaling need and it kept the pane from
 * honouring the pixel bounds.
 *
 * THEME-AWARE (wave-5 fix #1): the pane is a sandboxed WebContentsView — it never
 * sees the renderer's `.light` class or its `--color-*` custom properties, so the
 * document can't inherit the app theme through the DOM. Instead the app drives
 * `nativeTheme.themeSource` (src/main/index.ts, ipc-handlers.ts) and Electron
 * propagates that to every WebContents' `prefers-color-scheme`. The base rules
 * carry the LIGHT/"paper" palette (an EXPLICIT solid background — never
 * `transparent`, which previously composited pale text over the light shell and
 * read as washed-out) and a `@media (prefers-color-scheme: dark)` block overrides
 * to the VS-Code dark palette. Both palettes are lifted from the app's token
 * values in src/renderer/styles/globals.css so the surface reads as part of the
 * app in either theme. `prefers-color-scheme` always resolves to light or dark,
 * so an explicit solid background is guaranteed in both. */
export const PLAN_SURFACE_DOCUMENT_CSS = [
  'html,body{height:100%;}',
  // Base = light/"paper" palette (globals.css `.light`: surface-1 / fg-primary).
  'body{margin:0;overflow-y:auto;overflow-x:hidden;box-sizing:border-box;' +
    'font:14px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#211f1c;background:#fbfaf7;}',
  '*,*::before,*::after{box-sizing:border-box;}',
  'body>*{max-width:760px;margin-left:auto;margin-right:auto;padding-left:28px;padding-right:28px;}',
  'body>*:first-child{padding-top:24px;}',
  'body>*:last-child{padding-bottom:32px;}',
  'h1,h2{color:#000000;}', // fg-bright (light)
  'h1{font-size:1.55rem;line-height:1.25;margin:0 0 .6em;}',
  'h2{font-size:1.15rem;line-height:1.3;margin:1.4em 0 .5em;}',
  'section[data-anchor]{margin:0 0 1.1em;}',
  'p{margin:0 0 .8em;}',
  'ul,ol{margin:0 0 .8em;padding-left:1.4em;}',
  'li{margin:.2em 0;}',
  'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:rgba(0,0,0,.06);padding:.1em .35em;border-radius:4px;}',
  'pre{background:rgba(0,0,0,.04);padding:12px 14px;border-radius:8px;overflow-x:auto;}',
  'pre code{background:none;padding:0;}',
  'table{border-collapse:collapse;width:100%;}',
  'th,td{border:1px solid #e3ded3;padding:6px 8px;text-align:left;}', // surface-3 (light)
  '.zone-hint{color:#8e887a;font-style:italic;}', // fg-muted (light)
  'img,svg,video,canvas,table,pre{max-width:100%;}',
  'summary{cursor:pointer;padding-inline-start:1.2rem;}', // if WP0=H3 (native <summary> marker)
  'summary::marker{color:#1462ad;}', // accent-blue (light)
  // Dark override (globals.css `:root` default: surface-0 / fg-primary / fg-bright).
  '@media (prefers-color-scheme: dark){' +
    'body{color:#cccccc;background:#1e1e1e;}' +
    'h1,h2{color:#ffffff;}' +
    'code{background:rgba(255,255,255,.08);}' +
    'pre{background:rgba(255,255,255,.05);}' +
    'th,td{border-color:#3e3e42;}' +
    '.zone-hint{color:#9aa0a6;}' +
    'summary::marker{color:#6aa7ff;}' +
  '}',
].join('');

/**
 * Wrap already-sanitized surface HTML in a minimal, CSP-carrying document. The
 * CSP `<meta>` is a belt-and-suspenders companion to the pane's disabled JS and
 * the session-level CSP the manager may also set — a plan file opened directly
 * still can't run script. The inline `<style>` makes the document scroll inside
 * the pane (see PLAN_SURFACE_DOCUMENT_CSS).
 */
export function wrapPlanSurfaceDocument(sanitizedInnerHtml: string): string {
  return [
    '<!doctype html>',
    '<html><head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${planSurfaceCsp()}">`,
    '<meta name="referrer" content="no-referrer">',
    `<style>${PLAN_SURFACE_DOCUMENT_CSS}</style>`,
    '</head><body>',
    sanitizedInnerHtml,
    '</body></html>',
  ].join('');
}

/** A pane rectangle (renderer-streamed host rect / a WebContentsView bounds). */
export interface PlanPaneRect { x: number; y: number; width: number; height: number; }

/**
 * Clamp a streamed host rect to the visible window content area so the pane's
 * WebContentsView never extends past the bottom/right edge of the window. Without
 * this a fully-expanded pane paints its lower half below the screen: because the
 * view's viewport equals its (unclamped, content-tall) bounds, nothing overflows
 * and there is no scrollbar — the tail is simply unreachable. Clamping the height
 * to the visible region turns the long document back into an overflow that scrolls
 * inside the pane. Pure so it can be unit-tested without Electron.
 */
export function clampPaneBoundsToContent(
  bounds: PlanPaneRect,
  content: { width: number; height: number },
): PlanPaneRect {
  const x = Math.max(0, Math.round(bounds.x));
  const y = Math.max(0, Math.round(bounds.y));
  const width = Math.max(0, Math.min(Math.round(bounds.width), content.width - x));
  const height = Math.max(0, Math.min(Math.round(bounds.height), content.height - y));
  return { x, y, width, height };
}

/**
 * The full serve pipeline for a plan surface: sanitize the raw source, wrap it
 * in a CSP document, and encode it as a `data:` URL the pane loads via
 * `loadURL`. A `data:` URL has an opaque (null) origin, so the surface can reach
 * nothing on the network beyond what the CSP already allows. Returns the URL and
 * the intermediate HTML (the manager may prefer to render the HTML another way).
 */
export function buildPlanSurfaceDataUrl(rawSourceHtml: string): { html: string; dataUrl: string } {
  const html = wrapPlanSurfaceDocument(sanitizePlanHtml(rawSourceHtml ?? ''));
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  return { html, dataUrl };
}
