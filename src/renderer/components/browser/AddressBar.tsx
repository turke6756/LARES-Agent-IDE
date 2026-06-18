import React, { useEffect, useRef, useState } from 'react';
import { useBrowserStore, normalizeAddressInput, type BrowserTabState } from '../../stores/browser-store';
import * as Icons from 'lucide-react';
import StarMenu from './StarMenu';
import ZoomControl from './ZoomControl';
import AgentActionsToggle from './AgentActionsToggle';

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

  const [value, setValue] = useState(tab?.url ?? '');
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const prevFocusTick = useRef(focusAddressTick);

  // Track the active tab's URL while the user isn't typing.
  useEffect(() => {
    if (!editing) setValue(tab?.url ?? '');
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

  const submit = () => {
    const input = value.trim();
    if (!input) return;
    if (tab) {
      navigate(tab.tabId, input);
    } else {
      // No tab yet — Enter in the empty pane opens a fresh user tab.
      const url = normalizeAddressInput(input);
      if (url) void createTab('user', url);
    }
    setEditing(false);
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

      <input
        ref={inputRef}
        type="text"
        value={value}
        spellCheck={false}
        placeholder="Enter URL — https:// is the default scheme"
        onChange={(e) => {
          setEditing(true);
          setValue(e.target.value);
        }}
        onFocus={(e) => {
          setEditing(true);
          e.currentTarget.select();
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            submit();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setValue(tab?.url ?? '');
            setEditing(false);
            e.currentTarget.blur();
          }
        }}
        className="flex-1 min-w-0 bg-browser-chrome-2 border border-tab-border px-3 py-1.5 text-[12px] text-fg-primary placeholder-fg-muted focus:outline-none focus:border-accent-blue/60"
      />
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
