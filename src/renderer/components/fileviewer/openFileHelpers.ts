import { useCallback } from 'react';
import type { MouseEvent } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useBrowserStore } from '../../stores/browser-store';
import type { OpenFileTabRequest, PathType } from '../../../shared/types';

/**
 * Shared helpers for opening files in the tabbed file viewer from places
 * other than the directory tree:
 *  - `openExternalFileTab` — main-process `file:open-tab` IPC events (the
 *    `open_file_in_view` MCP tool → api-server → ipc-handlers pipeline).
 *  - `useModifierPathOpen` — Ctrl/Cmd+click on file-path-looking text inside
 *    rendered documents (MarkdownRenderer links/inline code, CsvRenderer cells).
 *
 * Path resolution mirrors dashboard-store's private resolveAgainstRoot —
 * duplicated here (with `..` handling added) to keep the store untouched.
 */

export function isAbsolutePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath) || /^\\\\/.test(filePath);
}

/** Infer the filesystem namespace from the path shape, falling back when ambiguous. */
export function inferPathType(filePath: string, fallback: PathType): PathType {
  if (filePath.startsWith('/')) return 'wsl';
  if (/^[A-Za-z]:[\\/]/.test(filePath) || /^\\\\/.test(filePath)) return 'windows';
  return fallback;
}

/** Join a relative path onto a base directory, collapsing `.` / `..` segments. */
function joinAndNormalize(baseDir: string, relPath: string): string {
  const isUnix = baseDir.startsWith('/');
  const parts = baseDir.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  for (const seg of relPath.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // Never pop past the drive letter ('C:') or the unix root ('').
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const joined = parts.join('/');
  return isUnix ? joined : joined.replace(/\//g, '\\');
}

/** Directory containing `filePath`, or null when it has no parent segment. */
function dirnameOf(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return null;
  const dir = normalized.slice(0, idx);
  return filePath.includes('\\') ? dir.replace(/\//g, '\\') : dir;
}

/**
 * Decide whether a piece of rendered text plausibly names a file, and clean
 * it up (strip wrapping quotes, `#fragment`, trailing `:line:col`, trailing
 * prose punctuation). Returns null when the text doesn't look like a path.
 *
 * Deliberately conservative: rejects URLs, anchors, anything containing
 * whitespace, and bare separator-less words without an extension — false
 * positives would hijack ordinary Ctrl+clicks.
 */
export function extractFilePathCandidate(raw: string): string | null {
  if (!raw) return null;
  let text = raw.trim();
  if (!text || text.length > 512) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null; // http://, file://, …
  if (/^(mailto|tel|data):/i.test(text)) return null;
  if (text.startsWith('#')) return null; // in-page anchor
  const hashIdx = text.indexOf('#');
  if (hashIdx > 0) text = text.slice(0, hashIdx); // docs/foo.md#section
  text = text.replace(/^["'`<]+/, '').replace(/[>"'`]+$/, '');
  text = text.replace(/:\d+(?::\d+)?$/, ''); // src/foo.ts:12:3
  text = text.replace(/[),.;:!?]+$/, ''); // trailing prose punctuation
  if (!text || /\s/.test(text)) return null;
  const hasSeparator = /[\\/]/.test(text);
  const hasExtension = /\.[A-Za-z0-9]{1,10}$/.test(text);
  if (!hasSeparator && !hasExtension) return null;
  // "and/or"-style prose: a separator alone isn't enough unless the path is
  // anchored (absolute or ./..-relative) or ends in an extension.
  if (!hasExtension && !isAbsolutePath(text) && !/^\.{1,2}[\\/]/.test(text)) return null;
  return text;
}

/** Resolve a (possibly relative) candidate against the viewing context. */
function resolveCandidate(candidate: string, currentFilePath: string, rootDirectory: string): string {
  if (isAbsolutePath(candidate)) return candidate;
  // `./x` and `../x` are author-relative to the document itself; everything
  // else is treated as workspace-root-relative.
  if (/^\.{1,2}[\\/]/.test(candidate)) {
    const docDir = currentFilePath ? dirnameOf(currentFilePath) : null;
    if (docDir) return joinAndNormalize(docDir, candidate);
  }
  return joinAndNormalize(rootDirectory, candidate);
}

/**
 * Hook for renderers: returns a click handler that, on Ctrl/Cmd+click over
 * text that looks like a file path, opens it as a tab in the file viewer
 * (resolved against the current tab's rootDirectory/pathType) and returns
 * true. Plain clicks and non-path text return false and are left untouched.
 */
export function useModifierPathOpen(tabId?: string) {
  const openTab = useDashboardStore((s) => s.openTab);
  const tab = useDashboardStore((s) => (tabId ? s.openTabs.find((t) => t.id === tabId) : undefined));

  return useCallback(
    (e: MouseEvent, text: string | undefined): boolean => {
      if (!e.ctrlKey && !e.metaKey) return false;
      if (!text || !tab) return false;
      const candidate = extractFilePathCandidate(text);
      if (!candidate) return false;
      e.preventDefault();
      e.stopPropagation();
      const resolved = resolveCandidate(candidate, tab.filePath, tab.rootDirectory);
      openTab(resolved, tab.rootDirectory, inferPathType(resolved, tab.pathType), tab.agentId, tab.workspaceId);
      return true;
    },
    [openTab, tab],
  );
}

/** True when `text` is an http(s) URL — the only scheme we open in the internal
 *  browser pane. `extractFilePathCandidate` deliberately REJECTS these (so a URL
 *  is never mis-resolved as a file path); this is its inverse, kept separate. */
export function isHttpUrl(text: string): boolean {
  return /^https?:\/\//i.test(text.trim());
}

/**
 * Pure decision for a click on a markdown link: on ANY left-click over an
 * http(s) href, prevent the default navigation (which would otherwise be
 * externalized to the OS browser by the shell's will-navigate handler — see
 * installExternalNavHandlers), open the URL in the internal browser pane via
 * `openInternal`, and return true. Non-http hrefs (file paths, mailto:, …)
 * return false and are left untouched (callers fall through to file-path
 * handling, then to the default external-open behavior). Kept React-free so
 * it's unit-testable.
 *
 * Note: this fires for every plain left-click — the modifier requirement was
 * dropped so a single click on a web link in a rendered doc lands in the
 * dashboard's own browser, not the OS browser.
 */
export function handleMarkdownUrlClick(
  e: Pick<MouseEvent, 'preventDefault' | 'stopPropagation'>,
  href: string | undefined,
  openInternal: (url: string) => void,
): boolean {
  if (!href || !isHttpUrl(href)) return false;
  e.preventDefault();
  e.stopPropagation();
  openInternal(href.trim());
  return true;
}

/**
 * Hook for the markdown renderer: returns a click handler that opens an http(s)
 * link in the internal browser pane on a plain left-click (new user-partition
 * tab + switch the center view to the browser), returning true; non-http clicks
 * return false so the caller can fall through to file-path handling. One rule
 * across the surface: clicking a web link opens it inside the dashboard.
 */
export function useUrlOpen() {
  return useCallback(
    (e: MouseEvent, href: string | undefined): boolean =>
      handleMarkdownUrlClick(e, href, (url) => {
        void useBrowserStore.getState().createTab('user', url);
        useDashboardStore.getState().showBrowser();
      }),
    [],
  );
}

/**
 * Handle a `file:open-tab` IPC event from the main process (MCP
 * `open_file_in_view`). Resolves defaults — workspace falls back to the one
 * currently selected in the UI — then opens the tab via the store, switching
 * the selected workspace first when the target tab belongs to another one
 * (otherwise the new tab would be filtered out of the visible set).
 */
export function openExternalFileTab(payload: OpenFileTabRequest): void {
  const store = useDashboardStore.getState();
  const workspaceId = payload.workspaceId ?? store.selectedWorkspaceId ?? undefined;
  const workspace = workspaceId ? store.workspaces.find((w) => w.id === workspaceId) : undefined;
  const rootDirectory = payload.rootDirectory ?? workspace?.path;
  if (!payload.filePath || !rootDirectory) {
    // (Prefix avoids square brackets around "file:open-tab" — Tailwind's
    // source scanner would treat that as an arbitrary-property class.)
    console.warn('open-file-tab: dropped request — no workspace root to resolve against', payload);
    return;
  }
  const resolved = isAbsolutePath(payload.filePath)
    ? payload.filePath
    : joinAndNormalize(rootDirectory, payload.filePath);
  const pathType = payload.pathType ?? inferPathType(resolved, workspace?.pathType ?? 'wsl');
  if (workspace && workspace.id !== store.selectedWorkspaceId) {
    store.selectWorkspace(workspace.id);
  }
  store.openTab(resolved, rootDirectory, pathType, payload.agentId, workspaceId);
}
