// Embedded-browser native context-menu template builder (overhaul WP6-CTX-MAIN).
//
// PURE function — no Electron runtime calls, only the `Electron.MenuItemConstructorOptions`
// type (a global namespace from electron's types, erased at compile). The
// browser manager is the only impure glue: it calls Menu.buildFromTemplate on
// this template, pops it, and maps clicked item ids to either a direct
// main-side action or a `contextMenuCommand` event back to the renderer.
//
// No `click` handlers are attached here (keeps it testable). Items whose action
// lives in the renderer carry a stable `id` the manager maps to a command:
//   'open-link-new-tab' · 'copy-link' · 'search-selection' · 'bookmark-page'
//
// Security shape (mirrors the WP6 plan):
//   - NO Save/Download item (M7 — downloads are denied).
//   - NO Inspect/DevTools on the agent partition (M9 — openDevTools would
//     detach a debugger on a persist:agent path; inspect is user-only).
//   - "Bookmark this page" only on the user partition (bookmarks are
//     user-partition-only persistence).

import { BrowserContextMenuParams } from '../../shared/browser';

export function buildContextMenuTemplate(
  params: BrowserContextMenuParams,
  ctx: { partition: 'user' | 'agent' },
): Electron.MenuItemConstructorOptions[] {
  const template: Electron.MenuItemConstructorOptions[] = [];

  // ── Navigation (handled fully in main) ──────────────────────────────────
  template.push({ id: 'nav-back', label: 'Back', enabled: params.canGoBack });
  template.push({ id: 'nav-forward', label: 'Forward', enabled: params.canGoForward });
  template.push({ id: 'reload', label: 'Reload' });

  // ── Link items (only when right-clicking a link) ────────────────────────
  if (params.linkURL) {
    template.push({ type: 'separator' });
    // renderer-side action → contextMenuCommand
    template.push({ id: 'open-link-new-tab', label: 'Open Link in New Tab' });
    // renderer-side action → contextMenuCommand (writes to clipboard)
    template.push({ id: 'copy-link', label: 'Copy Link Address' });
  }

  // ── Selection items (only when text is selected) ────────────────────────
  if (params.selectionText) {
    template.push({ type: 'separator' });
    template.push({ id: 'copy', label: 'Copy' }); // handled in main
    // renderer-side action → contextMenuCommand
    template.push({ id: 'search-selection', label: 'Search selection' });
  }

  // ── Bookmark (USER PARTITION ONLY) ──────────────────────────────────────
  if (ctx.partition === 'user') {
    template.push({ type: 'separator' });
    // renderer-side action → contextMenuCommand
    template.push({ id: 'bookmark-page', label: 'Bookmark this page' });
  }

  // ── Inspect / DevTools (USER PARTITION ONLY — omitted on agent, M9) ──────
  if (ctx.partition === 'user') {
    template.push({ type: 'separator' });
    template.push({ id: 'inspect', label: 'Inspect' });
  }

  // NOTE: deliberately NO Save / Download item (M7).

  return template;
}
