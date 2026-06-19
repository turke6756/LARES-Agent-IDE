import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  useBrowserStore,
  resolveBrowserInput,
  type BrowserTabState,
  type OmniboxSuggestion,
} from '../../stores/browser-store';
import * as Icons from 'lucide-react';
import StarMenu from './StarMenu';
import ZoomControl from './ZoomControl';
import AgentActionsToggle from './AgentActionsToggle';
import { useBrowserSuspension } from './useBrowserSuspension';

const LISTBOX_ID = 'omnibox-listbox';
const optionId = (i: number) => `omnibox-option-${i}`;

// WP1-TABS: token-backed address bar (.browser-toolbar) so it works in light
// mode. Anti-spoof invariant (M9/WP2): the URL is rendered ONLY from the active
// tab's committed state in this shell chrome — never from page or model output,
// and never from tab.title. Do not change that.
//
// Reserved insertion slots for later WPs (left empty/present on purpose):
//   • STAR slot  — left of the URL field; WP3 (StarMenu) renders here, gated to
//     user-partition tabs.
//   • ZOOM slot  — right side, after the partition badge; WP5 (ZoomControl).

interface Props {
  tab: BrowserTabState | null;
}

export default function AddressBar({ tab }: Props) {
  const navigate = useBrowserStore((s) => s.navigate);
  const createTab = useBrowserStore((s) => s.createTab);
  const goBack = useBrowserStore((s) => s.goBack);
  const goForward = useBrowserStore((s) => s.goForward);
  const reload = useBrowserStore((s) => s.reload);
  const stop = useBrowserStore((s) => s.stop);
  const openHistory = useBrowserStore((s) => s.openHistory);
  const toggleBookmarkBar = useBrowserStore((s) => s.toggleBookmarkBar);
  const focusAddressTick = useBrowserStore((s) => s.focusAddressTick);
  const openAccessView = useBrowserStore((s) => s.openAccessView);
  const pendingRequestCount = useBrowserStore(
    (s) => s.accessRequests.filter((r) => r.status === 'pending').length,
  );
  // Slice-3: Activity drawer entry + unread-denial badge (mirror of the Access
  // pending-request badge above).
  const openAuditDrawer = useBrowserStore((s) => s.openAuditDrawer);
  const unreadDenials = useBrowserStore((s) => s.auditUnreadDenials);

  // ── Slice-6 omnibox state ──────────────────────────────────────────────────
  const omniboxResults = useBrowserStore((s) => s.omniboxResults);
  const activeIndex = useBrowserStore((s) => s.omniboxActiveIndex);
  const fetchOmnibox = useBrowserStore((s) => s.fetchOmnibox);
  const clearOmnibox = useBrowserStore((s) => s.clearOmnibox);
  const setActiveIndex = useBrowserStore((s) => s.setOmniboxActiveIndex);
  const navError = useBrowserStore((s) => s.navError);
  const clearNavError = useBrowserStore((s) => s.clearNavError);

  // `typed` is the user's effective text (what the omnibox + raw-Enter use);
  // `displayed` is the input value, which may carry an inline completion suffix
  // that is rendered selected. They differ only while a completion is showing.
  const [typed, setTyped] = useState(tab?.url ?? '');
  const [displayed, setDisplayed] = useState(tab?.url ?? '');
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const prevFocusTick = useRef(focusAddressTick);
  // Whether the last edit permits autocompletion (forward typing, not deletion).
  const allowCompleteRef = useRef(false);
  // Pending selection range to apply after a completion render (start..end).
  const pendingSelRef = useRef<{ start: number; end: number } | null>(null);

  const dropdownOpen = editing && typed.trim().length > 0 && omniboxResults.length > 0;
  const completionActive = displayed.length > typed.length;

  // Track the active tab's URL while the user isn't typing.
  useEffect(() => {
    if (!editing) {
      setTyped(tab?.url ?? '');
      setDisplayed(tab?.url ?? '');
    }
  }, [tab?.tabId, tab?.url, editing]);

  // Ctrl+L (the main-side 'focus-address' shortcut) bumps focusAddressTick →
  // focus + select the URL field. Guard the initial value so mount never steals
  // focus from elsewhere.
  useEffect(() => {
    if (focusAddressTick === prevFocusTick.current) return;
    prevFocusTick.current = focusAddressTick;
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, [focusAddressTick]);

  // Inline completion: when the top suggestion's display extends the typed text
  // (typed is a case-insensitive prefix of it), fill the remainder and mark it
  // for selection. Only on forward typing — never while deleting.
  useEffect(() => {
    if (!editing) return;
    const top = omniboxResults[0];
    if (
      allowCompleteRef.current &&
      typed &&
      top?.display &&
      top.display.toLowerCase().startsWith(typed.toLowerCase()) &&
      top.display.length > typed.length
    ) {
      const completed = typed + top.display.slice(typed.length);
      setDisplayed(completed);
      pendingSelRef.current = { start: typed.length, end: completed.length };
    } else {
      setDisplayed(typed);
      pendingSelRef.current = null;
    }
  }, [omniboxResults, typed, editing]);

  // Apply the queued completion selection after the value renders.
  useLayoutEffect(() => {
    const sel = pendingSelRef.current;
    const el = inputRef.current;
    if (sel && el && document.activeElement === el) {
      el.setSelectionRange(sel.start, sel.end);
    }
    pendingSelRef.current = null;
  }, [displayed]);

  const closeEdit = () => {
    setEditing(false);
    clearOmnibox();
    setTyped(tab?.url ?? '');
    setDisplayed(tab?.url ?? '');
  };

  // Navigate to a concrete input (raw text or a suggestion URL). store.navigate
  // resolves through the shared resolveBrowserInput; for the no-tab case we open
  // a fresh user tab on the resolved target.
  const go = (input: string) => {
    const text = input.trim();
    if (!text) return;
    if (tab) {
      navigate(tab.tabId, text);
    } else {
      const resolved = resolveBrowserInput(text);
      if (resolved.display) void createTab('user', resolved.url);
    }
    setEditing(false);
    clearOmnibox();
    inputRef.current?.blur();
  };

  const choose = (index: number) => {
    const row = omniboxResults[index];
    if (row) go(row.url);
  };

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.currentTarget.value;
    // Forward typing (incl. replacing a selected completion) grows past `typed`;
    // backspacing the selected completion lands back at `typed` (equal length).
    allowCompleteRef.current = next.length > typed.length;
    setEditing(true);
    setTyped(next);
    setDisplayed(next);
    clearNavError();
    fetchOmnibox(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const lastIndex = omniboxResults.length - 1;
    if (e.key === 'ArrowDown' && dropdownOpen) {
      e.preventDefault();
      setActiveIndex(activeIndex >= lastIndex ? -1 : activeIndex + 1);
    } else if (e.key === 'ArrowUp' && dropdownOpen) {
      e.preventDefault();
      setActiveIndex(activeIndex <= -1 ? lastIndex : activeIndex - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey) {
        // Ctrl+Enter wraps the typed text as www.<text>.com.
        go(`www.${typed.trim()}.com`);
      } else if (activeIndex >= 0 && omniboxResults[activeIndex]) {
        choose(activeIndex);
      } else if (completionActive && omniboxResults[0]) {
        go(omniboxResults[0].url);
      } else {
        go(typed);
      }
    } else if (e.key === 'Escape') {
      // First Esc closes the dropdown; a second cancels the edit entirely.
      if (dropdownOpen || completionActive) {
        e.preventDefault();
        clearOmnibox();
        setDisplayed(typed);
      } else {
        closeEdit();
        e.currentTarget.blur();
      }
    }
  };

  return (
    <div className="browser-toolbar shrink-0">
      <button
        onClick={() => tab && goBack(tab.tabId)}
        disabled={!tab?.canGoBack}
        className="ui-btn ui-btn-ghost p-1.5 disabled:opacity-30"
        title="Back"
      >
        <Icons.ArrowLeft className="w-4 h-4" />
      </button>
      <button
        onClick={() => tab && goForward(tab.tabId)}
        disabled={!tab?.canGoForward}
        className="ui-btn ui-btn-ghost p-1.5 disabled:opacity-30"
        title="Forward"
      >
        <Icons.ArrowRight className="w-4 h-4" />
      </button>
      {tab?.loading ? (
        <button
          onClick={() => stop(tab.tabId)}
          className="ui-btn ui-btn-ghost p-1.5"
          title="Stop loading"
        >
          {/* Slice-1: spinner in the reload slot while the page loads (click to
              stop). Electron has no load percentage, so this is indeterminate. */}
          <Icons.Loader2 className="w-4 h-4 animate-spin text-accent-blue" />
        </button>
      ) : (
        <button
          onClick={() => tab && reload(tab.tabId)}
          disabled={!tab}
          className="ui-btn ui-btn-ghost p-1.5 disabled:opacity-30"
          title="Reload"
        >
          <Icons.RotateCw className="w-4 h-4" />
        </button>
      )}

      {/* ── STAR (WP3 StarMenu) — left of the URL field; self-gates to
          user-partition tabs (renders null otherwise). ── */}
      <StarMenu />

      {/* ── SECURITY GLYPH (Slice-1) — connection-security indicator from the
          committed URL scheme, left of the URL input. Lock = https, ShieldAlert
          = http, Globe = internal/NTP. aria-label + tooltip for a11y. ── */}
      {tab && <SecurityGlyph secureState={tab.secureState} />}

      {/* ── OMNIBOX (Slice-6) — combobox input + suggestions dropdown. The
          relative wrapper anchors the absolutely-positioned dropdown/error. ── */}
      <div className="relative flex-1 min-w-0">
        <input
          ref={inputRef}
          type="text"
          value={displayed}
          spellCheck={false}
          role="combobox"
          aria-expanded={dropdownOpen}
          aria-controls={LISTBOX_ID}
          aria-autocomplete="both"
          aria-activedescendant={
            dropdownOpen && activeIndex >= 0 ? optionId(activeIndex) : undefined
          }
          placeholder="Search the web or enter a URL"
          onChange={onInputChange}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => {
            // mousedown on a row preventDefaults to keep focus, so a blur here
            // means focus genuinely left the omnibox → close it.
            setEditing(false);
            clearOmnibox();
          }}
          onKeyDown={onKeyDown}
          className="w-full bg-browser-chrome-2 border border-tab-border px-3 py-1.5 text-[12px] text-fg-primary placeholder-fg-muted focus:outline-none focus:border-accent-blue/60"
        />
        {dropdownOpen && (
          <OmniboxDropdown
            results={omniboxResults}
            activeIndex={activeIndex}
            onPick={choose}
            onHover={setActiveIndex}
          />
        )}
        {!dropdownOpen && navError && (
          <div
            role="alert"
            className="absolute left-0 right-0 top-full mt-1 z-20 flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] bg-accent-red/10 border border-accent-red/40 text-accent-red"
          >
            <Icons.AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{navError}</span>
          </div>
        )}
      </div>
      {tab && (
        <span
          className={`text-[10px] px-1.5 py-0.5 font-semibold uppercase shrink-0 ${
            tab.partition === 'agent'
              ? 'text-accent-orange bg-accent-orange/10'
              : 'text-accent-blue bg-accent-blue/10'
          }`}
          title={
            tab.partition === 'agent'
              ? 'Agent partition (persist:agent) — isolated from your sign-ins'
              : 'Your partition (persist:user) — sign-ins persist here'
          }
        >
          {tab.partition}
        </span>
      )}

      {/* ── ZOOM (WP5 ZoomControl) — after the partition badge; self-gates
          (renders null on the NTP / when there's no tab). ── */}
      <ZoomControl />

      {/* ── READER (Slice 14) — enters the reader overlay; self-gates to
          http(s) USER tabs (renders null otherwise), mirroring main's gating
          contract so an ineligible tab never triggers a rejection. ── */}
      <ReaderToolbarButton />

      <button
        onClick={() => toggleBookmarkBar()}
        className="ui-btn ui-btn-ghost p-1.5 shrink-0"
        title="Toggle bookmarks bar"
      >
        <Icons.BookMarked className="w-4 h-4" />
      </button>
      <button
        onClick={() => openHistory()}
        className="ui-btn ui-btn-ghost p-1.5 shrink-0"
        title="History (Ctrl+H)"
      >
        <Icons.History className="w-4 h-4" />
      </button>

      {/* ── ACTIVITY (Slice-3) — opens the live Activity/Audit drawer (the M16
          action-audit feed). Badge = unread denials since the drawer was last
          opened. Mirror of the Access badge pattern. ── */}
      <button
        onClick={() => openAuditDrawer()}
        className="ui-btn ui-btn-ghost relative flex items-center gap-1.5 px-1.5 py-1 shrink-0"
        title="Activity — recent agent browser actions & denials"
      >
        <Icons.ScrollText className="w-4 h-4 text-fg-secondary" />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-secondary hidden md:inline">
          Activity
        </span>
        {unreadDenials > 0 && (
          <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-bold bg-accent-red text-white">
            {unreadDenials > 99 ? '99+' : unreadDenials}
          </span>
        )}
      </button>

      {/* ── ACCESS — opens the website-access policy overlay (single agent
          allowlist + pending agent requests). Trusted shell chrome only.
          Badge = pending agent requests awaiting human approval. ── */}
      <button
        onClick={() => openAccessView()}
        className="ui-btn ui-btn-ghost relative flex items-center gap-1.5 px-1.5 py-1 shrink-0"
        title="Website access — agent allowlist & pending agent requests"
      >
        <Icons.ShieldCheck className="w-4 h-4 text-fg-secondary" />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-secondary hidden md:inline">
          Access
        </span>
        {pendingRequestCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-bold bg-accent-orange text-white">
            {pendingRequestCount}
          </span>
        )}
      </button>

      {/* ── AGENT ACTIONS (M12 coarse gate) — flips the dashboard-global runtime
          act-tier toggle; unobtrusive, rightmost in the chrome toolbar. ── */}
      <AgentActionsToggle />
    </div>
  );
}

// ── Slice 14 reader toolbar button ───────────────────────────────────────────
// Self-gates to http(s) USER tabs (mirrors ZoomControl's self-gate and main's
// gating contract: enterReadingMode REJECTS agent / non-user / non-http(s)
// tabs). On click it asks the store to extract+sanitize the article in main and
// open the reader overlay; the store swallows a rejection, so an edge-case click
// is a graceful no-op rather than a crash.
function ReaderToolbarButton() {
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const tabs = useBrowserStore((s) => s.tabs);
  const enterReadingMode = useBrowserStore((s) => s.enterReadingMode);
  const readerLoading = useBrowserStore((s) => s.readerLoading);

  const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? null;

  // Visible only for an http(s) USER tab with a live view. The New Tab page, a
  // frozen/discarded snapshot, an agent tab, and non-http(s) schemes are all
  // ineligible (and would be rejected by main).
  if (!activeTab) return null;
  if (activeTab.partition !== 'user') return null;
  if (activeTab.isNewTab || activeTab.frozen) return null;
  if (!/^https?:\/\//i.test(activeTab.url ?? '')) return null;

  return (
    <button
      onClick={() => void enterReadingMode(activeTab.tabId)}
      disabled={readerLoading}
      className="ui-btn ui-btn-ghost p-1.5 shrink-0 disabled:opacity-40"
      title="Reading mode"
      aria-label="Reading mode"
    >
      {readerLoading ? (
        <Icons.Loader2 className="w-4 h-4 animate-spin text-accent-blue" />
      ) : (
        <Icons.BookOpen className="w-4 h-4" />
      )}
    </button>
  );
}

// ── Slice-1 connection-security glyph ────────────────────────────────────────
// Purely reflects the committed URL's scheme (main computes secureState off the
// scheme — never page content). 'internal' (NTP/empty) is the safe default for
// a missing value.
function SecurityGlyph({ secureState }: { secureState?: 'secure' | 'insecure' | 'internal' }) {
  const state = secureState ?? 'internal';
  const config =
    state === 'secure'
      ? { Icon: Icons.Lock, label: 'Secure connection (HTTPS)', className: 'text-accent-green' }
      : state === 'insecure'
        ? { Icon: Icons.ShieldAlert, label: 'Not secure (HTTP)', className: 'text-accent-orange' }
        : { Icon: Icons.Globe, label: 'Internal page', className: 'text-fg-muted' };
  const { Icon, label, className } = config;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`shrink-0 flex items-center justify-center px-1 ${className}`}
    >
      <Icon className="w-3.5 h-3.5" />
    </span>
  );
}

// ── Slice-6 omnibox suggestions dropdown ─────────────────────────────────────
// Renderer-DOM popover anchored under the address input. It overlaps the
// WebContentsView, so per cross-cutting rule #3 it suspends the pane for its
// lifetime via useBrowserSuspension() (mounted only while open). ARIA listbox;
// the input is the combobox owner and drives aria-activedescendant.
const KIND_ICON: Record<OmniboxSuggestion['kind'], keyof typeof Icons> = {
  tab: 'AppWindow',
  bookmark: 'Bookmark',
  history: 'History',
  search: 'Search',
  url: 'Globe',
};

function OmniboxDropdown({
  results,
  activeIndex,
  onPick,
  onHover,
}: {
  results: OmniboxSuggestion[];
  activeIndex: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
}) {
  // Overlaps the native view → must suspend it while open.
  useBrowserSuspension();
  // Collision-aware vertical flip: the dropdown is width-pinned to the input
  // (left-0/right-0), so it can't overflow horizontally, but near the bottom of
  // a short window it should open UPWARD instead of clipping. Measure once and
  // flip when there isn't room below and there's more room above.
  const listRef = useRef<HTMLUListElement | null>(null);
  const [placeAbove, setPlaceAbove] = useState(false);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || typeof window === 'undefined') return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.top;
    const spaceAbove = rect.top - rect.height - 8;
    setPlaceAbove(rect.height + 8 > spaceBelow && spaceAbove > spaceBelow);
  }, [results.length]);
  return (
    <ul
      ref={listRef}
      id={LISTBOX_ID}
      role="listbox"
      aria-label="Address suggestions"
      className={`browser-popover browser-popover-anim absolute left-0 right-0 z-20 max-h-80 overflow-y-auto py-1 ${
        placeAbove ? 'bottom-full mb-1' : 'top-full mt-1'
      }`}
    >
      {results.map((row, i) => {
        const Icon = Icons[KIND_ICON[row.kind]] as React.ComponentType<{ className?: string }>;
        const active = i === activeIndex;
        return (
          <li
            key={`${row.kind}:${row.url}:${i}`}
            id={optionId(i)}
            role="option"
            aria-selected={active}
            // Keep focus on the input so the click lands before blur closes us.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(i)}
            className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[12px] ${
              active ? 'bg-accent-blue/15' : 'hover:bg-browser-chrome-1'
            }`}
          >
            <Icon className="w-3.5 h-3.5 shrink-0 text-fg-muted" />
            <span className="truncate text-fg-primary">{row.title}</span>
            {row.kind !== 'search' && (
              <span className="truncate text-[11px] text-fg-muted ml-auto pl-2">{row.display}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
