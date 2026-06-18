// Slice-6 (premium browser) — the omnibox suggester.
//
// `suggest(query, workspaceId, limit)` returns a ranked, URL-de-duped list of
// OmniboxSuggestion rows drawn from, in priority order:
//   1. open VISIBLE tabs   (kind:'tab')      — switch-to-tab
//   2. bookmarks           (kind:'bookmark') — title/url substring
//   3. history             (kind:'history')  — visit_count DESC then recency
//   4. trailing fallback   (kind:'search')   — always a web-search safety net
//      + a direct-URL row  (kind:'url')      — when the input parses as a host
//
// USER-PARTITION SOURCES ONLY. Agent-partition URLs are never surfaced (cross-
// cutting rule #1: never return user/agent page state across the boundary — here
// the omnibox is trusted human chrome, so it must never leak AGENT browsing into
// it either). Two guards enforce this: the manager's source provider only feeds
// user tabs, and `suggest()` independently drops any non-'user' tab.
//
// PURE + SYNC. The ranking/dedup logic takes its data from an injected source
// provider (configureOmniboxSources) so it unit-tests without Electron or a live
// SQLite handle; in the app the manager wires the provider to the real stores
// (bookmarks-store / history-store) and its own open-tab map.

import type { Bookmark, HistoryEntry, OmniboxSuggestion } from '../../shared/browser';
import { resolveBrowserInput, searchUrlFor } from '../../shared/browser-input';

/** A single open user tab, as the omnibox sees it (no WebContentsView). */
export interface OmniboxOpenTab {
  tabId: string;
  url: string;
  title: string;
  partition: 'user' | 'agent';
  workspaceId: string | null;
}

/** The USER-PARTITION sources the ranker reads. `history` is expected to be
 *  pre-filtered + ranked by the provider (indexed LIKE in SQL); `bookmarks` and
 *  `openTabs` are filtered in-memory here. */
export interface OmniboxSources {
  openTabs: OmniboxOpenTab[];
  bookmarks: Bookmark[];
  history: HistoryEntry[];
}

/** The provider takes the query so the history source can use an indexed LIKE
 *  rather than loading every row. Defaults to empty (suggest → [] until wired). */
type OmniboxSourceProvider = (query: string) => OmniboxSources;

let sourceProvider: OmniboxSourceProvider = () => ({
  openTabs: [],
  bookmarks: [],
  history: [],
});

/** Wire the live sources (called once by the browser manager at construction).
 *  Tests call this with fixtures, then reset with the same hook. */
export function configureOmniboxSources(provider: OmniboxSourceProvider): void {
  sourceProvider = provider;
}

// Base scores per source. Higher = ranked first. A switch-to-tab beats a direct
// URL (you already have it open); both beat bookmarks, which beat history, which
// beats the bare search fallback. Prefix matches add a bonus on top.
const BASE = {
  tab: 1000,
  url: 800,
  bookmark: 600,
  history: 400,
  search: 50,
} as const;

const PREFIX_BONUS = 250;
const SUBSTRING_BONUS = 60;

/** Match-quality bonus: a prefix hit on the title OR the host outranks a mere
 *  substring hit anywhere in title/url. */
function matchBonus(title: string, url: string, ql: string): number {
  const t = title.toLowerCase();
  const host = hostOf(url);
  const u = url.toLowerCase();
  if (t.startsWith(ql) || host.startsWith(ql) || stripScheme(u).startsWith(ql)) {
    return PREFIX_BONUS;
  }
  return SUBSTRING_BONUS;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Scheme-stripped form used both for `display` (inline completion) and as the
 *  dedupe key — "https://github.com/" and "github.com" collapse to one row. */
function stripScheme(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');
}

function dedupeKey(url: string): string {
  return stripScheme(url).toLowerCase();
}

function matches(title: string, url: string, ql: string): boolean {
  return `${title} ${url}`.toLowerCase().includes(ql);
}

/**
 * Ranked, URL-de-duped omnibox suggestions for `query` scoped to `workspaceId`.
 * Returns [] for an empty query.
 */
export function suggest(
  query: string,
  workspaceId: string | null,
  limit = 8,
): OmniboxSuggestion[] {
  const q = query.trim();
  if (!q) return [];
  const ql = q.toLowerCase();
  const { openTabs, bookmarks, history } = sourceProvider(q);

  const rows: OmniboxSuggestion[] = [];

  // 1. open VISIBLE tabs — USER partition, current workspace, matching the query.
  //    The partition guard is defense-in-depth: never surface an agent tab even
  //    if the provider mistakenly includes one.
  for (const t of openTabs) {
    if (t.partition !== 'user') continue;
    if ((t.workspaceId ?? null) !== (workspaceId ?? null)) continue;
    if (!t.url || !matches(t.title, t.url, ql)) continue;
    rows.push({
      kind: 'tab',
      title: t.title || hostOf(t.url) || t.url,
      url: t.url,
      display: stripScheme(t.url),
      score: BASE.tab + matchBonus(t.title, t.url, ql),
    });
  }

  // 2. bookmarks (title/url substring).
  for (const b of bookmarks) {
    if (!matches(b.title, b.url, ql)) continue;
    rows.push({
      kind: 'bookmark',
      title: b.title || hostOf(b.url) || b.url,
      url: b.url,
      display: stripScheme(b.url),
      score: BASE.bookmark + matchBonus(b.title, b.url, ql),
    });
  }

  // 3. history (already ranked frequency-then-recency by the provider). A small
  //    positional decay preserves that ordering through the final global sort.
  history.forEach((h, i) => {
    if (!matches(h.title, h.url, ql)) return;
    rows.push({
      kind: 'history',
      title: h.title || hostOf(h.url) || h.url,
      url: h.url,
      display: stripScheme(h.url),
      score: BASE.history + matchBonus(h.title, h.url, ql) + Math.max(0, 50 - i),
    });
  });

  // 4. direct-URL row when the input parses as a host, then the search fallback.
  const resolved = resolveBrowserInput(q);
  if (resolved.kind === 'url') {
    rows.push({
      kind: 'url',
      title: q,
      url: resolved.url,
      display: stripScheme(resolved.url),
      score: BASE.url,
    });
  }
  rows.push({
    kind: 'search',
    title: `Search the web for “${q}”`,
    url: searchUrlFor(q),
    display: q,
    score: BASE.search,
  });

  // Dedupe by URL, keeping the highest-scored row. The search row has no real
  // URL to collide with, so it gets its own key.
  const byKey = new Map<string, OmniboxSuggestion>();
  for (const row of rows) {
    const key = row.kind === 'search' ? `search:${row.url}` : dedupeKey(row.url);
    const existing = byKey.get(key);
    if (!existing || row.score > existing.score) byKey.set(key, row);
  }

  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
