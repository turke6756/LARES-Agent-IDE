import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  useBrowserStore,
  agentSignedInRuleForUrl,
} from '../../stores/browser-store';
import { suspendBrowserPane, resumeBrowserPane } from './useBrowserSuspension';
import {
  selectTabGroups,
  tabLabel,
  prettyHost,
  type OrderedTab,
} from './tab-groups';
import TabGroupChip from './TabGroupChip';
import TabGroupDropdown from './TabGroupDropdown';
import TabHoverCard, { type TabHoverCardProps } from './TabHoverCard';
import { clampToViewport } from './popover-position';
import * as Icons from 'lucide-react';

// User-partition vs agent-partition tabs are visually distinct (M9 partition
// discipline made legible): agent tabs carry an orange Bot badge, user tabs a
// blue accent. Agent-attention (plan §4 UX) pulses the tab until selected.
//
// WP1-TABS: Chrome/Arc rounded tabs via the WP1-THEME token-backed classes
// (.browser-tab / .browser-tab-active). The partition accent (orange = agent,
// blue = user) is applied to the ACTIVE tab through the data-partition attribute
// the theme keys off (.browser-tab-active[data-partition=...]::before).
//
// WP7-TABMGMT-UI (C-WIRE): tab ORDER + pin state come from the main-authoritative
// `snapshot` (pinned cluster left); display data (title/favicon/loading) is looked
// up from the `tabs` map by tabId. Interactions are intents sent to main, never
// local view re-parenting.
//
// TAB-GROUPS: agent tabs pile up, so the unpinned tabs are derived into at most
// two groups (Agent / Your tabs) by `selectTabGroups`. A collapsed group renders
// as one TabGroupChip — expandable inline (chip body) or as a vertical list
// (TabGroupDropdown). Grouping is pure UI on top of the ordered list; pinned tabs
// stay hoisted + ungrouped. Hover shows a human-readable TabHoverCard, not the URL.

interface HoverState extends TabHoverCardProps {}

// ── Slice-1 tab favicon (real favicon + glyph fallback + loading overlay) ─────
// User tabs show the real favicon when present, falling back to a Globe glyph
// when it is absent OR fails to load (onError). Agent tabs keep the orange Bot
// identity glyph (partition legibility wins over the favicon). While the tab is
// loading, a small spinner overlays the icon (rather than replacing it).
function TabIcon({ tab }: { tab: OrderedTab['tab'] }) {
  const [imgFailed, setImgFailed] = useState(false);
  // A new page may carry a working favicon — reset the failed flag when the
  // favicon URL changes so a prior 404 doesn't permanently pin the fallback.
  useEffect(() => setImgFailed(false), [tab.favicon]);

  const base =
    tab.partition === 'agent' ? (
      <Icons.Bot className="w-3.5 h-3.5 text-accent-orange" />
    ) : tab.favicon && !imgFailed ? (
      <img
        src={tab.favicon}
        alt=""
        className="w-3.5 h-3.5"
        onError={() => setImgFailed(true)}
      />
    ) : (
      <Icons.Globe className="w-3.5 h-3.5 text-fg-muted" />
    );

  return (
    <span className="relative inline-flex items-center justify-center w-3.5 h-3.5 shrink-0">
      {base}
      {tab.loading && (
        <span className="absolute inset-0 flex items-center justify-center rounded-sm bg-browser-chrome/70">
          <Icons.Loader2 className="w-2.5 h-2.5 animate-spin text-fg-muted" />
        </span>
      )}
    </span>
  );
}

// ── Slice-5 tab right-click context menu (accessible, viewport-clamped) ───────
// The menu is renderer chrome that can overflow into the host region, so it is
// rendered while the pane is suspended (see overlayOpen below). This component
// owns the a11y + positioning correctness the audit flagged:
//   • coordinates are clamped to the viewport so the menu never renders
//     partially off-screen (e.g. right-click near the bottom/right edge),
//   • Esc dismisses it, focus is trapped, and Arrow/Home/End move between items,
//   • role="menu"/"menuitem" expose it to assistive tech.
function TabContextMenu({
  x,
  y,
  handed,
  canHand,
  onReturn,
  onHandoff,
  onClose,
}: {
  x: number;
  y: number;
  handed: boolean;
  canHand: boolean;
  onReturn: () => void;
  onHandoff: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Start at the raw cursor point, then clamp once the real size is known.
  const [pos, setPos] = useState<{ left: number; top: number; origin: string }>({
    left: x,
    top: y,
    origin: 'top left',
  });

  // Clamp to the viewport after layout (size is unknown until mounted) via the
  // shared collision-aware helper, so the menu never renders partly off-screen.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = clampToViewport({ x, y }, { width: rect.width, height: rect.height });
    setPos((prev) =>
      prev.left === next.left && prev.top === next.top && prev.origin === next.origin
        ? prev
        : { left: next.left, top: next.top, origin: next.origin },
    );
  }, [x, y]);

  // Focus management: move focus into the menu on open, trap it, and wire
  // Esc / Arrow / Home / End. The listener lives on the container so it catches
  // bubbling key events from the focused menuitem; the container is itself
  // focusable (tabIndex -1) so Esc still works when every item is disabled.
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const itemsOf = () =>
      Array.from(el.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
    (itemsOf()[0] ?? el).focus();

    const onKeyDown = (e: KeyboardEvent) => {
      const items = itemsOf();
      const len = items.length;
      const idx = items.indexOf(document.activeElement as HTMLElement);
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        case 'ArrowDown':
          if (!len) break;
          e.preventDefault();
          items[(idx + 1 + len) % len]?.focus();
          break;
        case 'ArrowUp':
          if (!len) break;
          e.preventDefault();
          items[(idx - 1 + len) % len]?.focus();
          break;
        case 'Home':
          if (!len) break;
          e.preventDefault();
          items[0]?.focus();
          break;
        case 'End':
          if (!len) break;
          e.preventDefault();
          items[len - 1]?.focus();
          break;
        case 'Tab':
          // Trap focus within the menu so the popover stays self-contained.
          if (!len) break;
          e.preventDefault();
          items[e.shiftKey ? (idx - 1 + len) % len : (idx + 1) % len]?.focus();
          break;
      }
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <>
      <div
        className="fixed inset-0 z-50"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label="Tab actions"
        tabIndex={-1}
        className="browser-popover browser-popover-anim fixed z-50 min-w-[220px] py-1 text-[12px] focus:outline-none"
        style={{ left: pos.left, top: pos.top, ['--browser-popover-origin' as string]: pos.origin }}
      >
        {handed ? (
          <button
            role="menuitem"
            onClick={onReturn}
            className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-fg-primary hover:bg-[var(--color-tab-hover-bg)] focus:bg-[var(--color-tab-hover-bg)] focus:outline-none"
          >
            <Icons.Undo2 className="w-3.5 h-3.5 shrink-0" />
            Return tab to me
          </button>
        ) : (
          <button
            role="menuitem"
            onClick={onHandoff}
            disabled={!canHand}
            className={`w-full text-left px-3 py-1.5 flex items-center gap-2 focus:outline-none ${
              canHand
                ? 'text-fg-primary hover:bg-[var(--color-tab-hover-bg)] focus:bg-[var(--color-tab-hover-bg)]'
                : 'text-fg-muted cursor-not-allowed'
            }`}
            title={
              canHand
                ? 'Let the agent drive this signed-in tab'
                : 'Only available on your tabs whose site is an "allow signed in" agent rule'
            }
          >
            <Icons.Bot className="w-3.5 h-3.5 shrink-0" />
            Hand this tab to the agent
          </button>
        )}
      </div>
    </>
  );
}

export default function BrowserTabStrip() {
  const tabs = useBrowserStore((s) => s.tabs);
  const selectedWorkspaceId = useBrowserStore((s) => s.selectedWorkspaceId);
  const snapshot = useBrowserStore((s) => s.snapshot);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const attentionTabIds = useBrowserStore((s) => s.attentionTabIds);
  const selectTab = useBrowserStore((s) => s.selectTab);
  const closeTab = useBrowserStore((s) => s.closeTab);
  const createTab = useBrowserStore((s) => s.createTab);
  const reorderTab = useBrowserStore((s) => s.reorderTab);
  const setTabPinned = useBrowserStore((s) => s.setTabPinned);
  const reopenClosedTab = useBrowserStore((s) => s.reopenClosedTab);

  // Tab groups (UI-only state).
  const groupCollapsed = useBrowserStore((s) => s.groupCollapsed);
  const openGroupId = useBrowserStore((s) => s.openGroupId);
  const toggleGroupCollapsed = useBrowserStore((s) => s.toggleGroupCollapsed);
  const openGroupDropdown = useBrowserStore((s) => s.openGroupDropdown);

  // ── Mechanism-B hand-off (plans/website-allowlist-design.md §15) ───────────
  const agentRules = useBrowserStore((s) => s.accessRules);
  const handedTabIds = useBrowserStore((s) => s.handedTabIds);
  const tabHandToAgent = useBrowserStore((s) => s.tabHandToAgent);
  const tabReturnToHuman = useBrowserStore((s) => s.tabReturnToHuman);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Slice 16 motion: a tab being closed animates (width+opacity collapse) before
  // the store actually removes it. We hold the id, paint `.browser-tab-closing`,
  // then call closeTab after the animation. Reduced-motion users skip the delay.
  const [closingId, setClosingId] = useState<string | null>(null);
  const closeTimer = useRef<number | null>(null);
  const prefersReducedMotion = () =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const requestClose = (tabId: string) => {
    if (prefersReducedMotion()) {
      closeTab(tabId);
      return;
    }
    setClosingId(tabId);
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      closeTab(tabId);
      setClosingId(null);
      closeTimer.current = null;
    }, 130);
  };
  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );
  // Tab right-click context menu (renderer chrome) + the hand-off confirm dialog.
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [confirmHandoff, setConfirmHandoff] = useState<{ tabId: string; origin: string } | null>(null);
  // Anchor for the open group dropdown (which group is openGroupId; this is just
  // where to render its popover).
  const [dropdownAnchor, setDropdownAnchor] = useState<{ x: number; y: number } | null>(null);
  // Hover card (replaces the native title=URL tooltip).
  const [hover, setHover] = useState<HoverState | null>(null);
  const hoverTimer = useRef<number | null>(null);

  // The WebContentsView paints over renderer DOM, so suspend the pane while the
  // menu or confirm dialog is up (they can overflow into the host region). The
  // group dropdown suspends itself via useBrowserSuspension.
  const overlayOpen = menu !== null || confirmHandoff !== null;
  useEffect(() => {
    if (!overlayOpen) return;
    suspendBrowserPane();
    return () => resumeBrowserPane();
  }, [overlayOpen]);

  // Slice 12: a persistent toolbar "Agent driving" chip for the ACTIVE handed
  // tab — visible without hovering the tab itself (the per-tab badge can scroll
  // out of view in a crowded strip), with a one-click Return affordance.
  const activeHandedTab =
    activeTabId && handedTabIds[activeTabId]
      ? tabs.find((t) => t.tabId === activeTabId) ?? null
      : null;

  const menuTab = menu ? tabs.find((t) => t.tabId === menu.tabId) ?? null : null;
  const canHand =
    !!menuTab &&
    menuTab.partition === 'user' &&
    !!menuTab.url &&
    !!agentSignedInRuleForUrl(menuTab.url, agentRules);

  const originOf = (url: string): string => {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  };

  const beginHandoff = () => {
    if (!menuTab || !canHand) return;
    setConfirmHandoff({ tabId: menuTab.tabId, origin: originOf(menuTab.url) });
    setMenu(null);
  };

  // Render order: pinned cluster left, then by main's order. Fallback to the
  // raw tabs order until the first snapshot lands.
  const ordered = useMemo<OrderedTab[]>(() => {
    if (snapshot.length === 0) {
      return tabs
        .filter((tab) => (tab.workspaceId ?? null) === selectedWorkspaceId)
        .map((tab) => ({ tab, pinned: false, order: -1 }));
    }
    const byId = new Map(tabs.map((t) => [t.tabId, t]));
    return snapshot
      .slice()
      .sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : a.order - b.order))
      .map((e) => {
        const tab = byId.get(e.tabId);
        return tab ? { tab, pinned: e.pinned, order: e.order } : null;
      })
      .filter((x): x is OrderedTab => x !== null);
  }, [snapshot, tabs, selectedWorkspaceId]);

  const grouped = useMemo(
    () => selectTabGroups({ ordered, activeTabId, groupCollapsed, attentionTabIds }),
    [ordered, activeTabId, groupCollapsed, attentionTabIds],
  );

  // If the open dropdown's group no longer exists (all members closed, or it
  // shrank to a loose tab), drop the popover so nothing dangles.
  const groupIds = useMemo(
    () => new Set(grouped.items.filter((i) => i.kind === 'group').map((i) => (i as { group: { id: string } }).group.id)),
    [grouped],
  );
  useEffect(() => {
    if (openGroupId && !groupIds.has(openGroupId)) openGroupDropdown(null);
  }, [openGroupId, groupIds, openGroupDropdown]);

  const draggable = snapshot.length > 0;

  const onDrop = (target: OrderedTab) => {
    const sourceId = draggingId;
    setDraggingId(null);
    if (!sourceId || sourceId === target.tab.tabId) return;
    const source = ordered.find((o) => o.tab.tabId === sourceId);
    if (!source || source.pinned !== target.pinned) return;
    reorderTab(sourceId, target.order);
  };

  // ── Hover card plumbing (400ms intent; rect captured synchronously) ─────────
  const cancelHover = () => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };
  const startHover = (e: React.MouseEvent, content: Omit<TabHoverCardProps, 'x' | 'y'>) => {
    if (overlayOpen || openGroupId !== null || draggingId !== null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    cancelHover();
    hoverTimer.current = window.setTimeout(() => {
      setHover({ ...content, x: rect.left, y: rect.bottom });
    }, 400);
  };
  const endHover = () => {
    cancelHover();
    setHover(null);
  };
  useEffect(() => cancelHover, []);
  // Any overlay opening must dismiss a lingering card.
  useEffect(() => {
    if (overlayOpen || openGroupId !== null || draggingId !== null) endHover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayOpen, openGroupId, draggingId]);

  const tabCard = (tab: OrderedTab['tab']): Omit<TabHoverCardProps, 'x' | 'y'> => {
    const handed = Boolean(handedTabIds[tab.tabId]);
    // Slice-2: surface the opening agent's identity as the tab's tooltip line
    // ("Opened by <agentTitle>"). Applies to a forHuman open too (partition
    // 'user' but agent-attributed), so it is checked before the partition fallback.
    const openedBy = tab.openedByAgentTitle;
    const status = tab.loading
      ? { icon: <Icons.Loader2 className="w-3 h-3 animate-spin" />, text: 'Loading…' }
      : handed
        ? { icon: <Icons.Bot className="w-3 h-3" />, text: 'Agent driving this tab', className: 'text-accent-orange' }
        : openedBy
          ? { icon: <Icons.Bot className="w-3 h-3" />, text: `Opened by ${openedBy}`, className: 'text-accent-orange' }
          : tab.partition === 'agent'
            ? { icon: <Icons.Bot className="w-3 h-3" />, text: 'Agent tab', className: 'text-accent-orange' }
            : null;
    return {
      icon: <TabIcon tab={tab} />,
      title: tabLabel(tab),
      subtitle: tab.url ? prettyHost(tab.url) : null,
      status,
    };
  };

  // ── Single tab pill (loose tab, pinned tab, or group member) ────────────────
  const renderTab = (entry: OrderedTab) => {
    const { tab, pinned } = entry;
    const active = tab.tabId === activeTabId;
    const isAgent = tab.partition === 'agent';
    const attention = Boolean(attentionTabIds[tab.tabId]);
    const handed = Boolean(handedTabIds[tab.tabId]);
    // Slice 10/11: a frozen tab has NO live view yet — its favicon/title come
    // from a persisted snapshot, so it renders dimmed. A discarded tab (idle/cap
    // memory sweep) gets the same dimming PLUS a MoonStar "suspended" glyph.
    // Clicking either activates the tab → main lazily hydrates/reloads it.
    const frozen = Boolean(tab.frozen);
    const discarded = Boolean(tab.discarded);
    const closing = closingId === tab.tabId;
    // Full-title tooltip for a11y/quick-ID (the rich TabHoverCard still shows on
    // hover-intent; this native title is the accessible-name fallback).
    const fullTitle = tab.url ? `${tabLabel(tab)} — ${tab.url}` : tabLabel(tab);
    return (
      <div
        key={tab.tabId}
        role="tab"
        aria-selected={active}
        title={fullTitle}
        draggable={draggable}
        onDragStart={() => setDraggingId(tab.tabId)}
        onDragEnd={() => setDraggingId(null)}
        onDragOver={(e) => {
          if (draggable) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          onDrop(entry);
        }}
        onClick={() => selectTab(tab.tabId)}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            requestClose(tab.tabId);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ tabId: tab.tabId, x: e.clientX, y: e.clientY });
        }}
        onMouseEnter={(e) => startHover(e, tabCard(tab))}
        onMouseLeave={endHover}
        data-partition={tab.partition}
        className={`group browser-tab text-[12px] cursor-pointer ${pinned ? 'browser-tab-pinned' : ''} ${
          active ? 'browser-tab-active' : ''
        } ${attention ? 'browser-tab-attention' : ''} ${
          closing ? 'browser-tab-closing' : !pinned ? 'browser-tab-opening' : ''
        } ${
          draggingId === tab.tabId ? 'opacity-50' : (frozen || discarded) ? 'opacity-60' : ''
        }`}
        data-frozen={frozen || undefined}
        data-discarded={discarded || undefined}
      >
        <TabIcon tab={tab} />

        {/* Discarded tabs (idle/cap memory sweep) carry a MoonStar suspended
            glyph; restored-but-not-yet-discarded frozen tabs just dim. */}
        {discarded && (
          <span
            className="shrink-0 inline-flex items-center text-fg-muted"
            title="Suspended to save memory"
            aria-label="Suspended to save memory"
          >
            <Icons.MoonStar className="w-3 h-3" />
          </span>
        )}

        {/* Pinned tabs render compact: favicon only, no title/close. */}
        {!pinned && <span className="truncate min-w-0">{tabLabel(tab)}</span>}

        {/* "Agent driving" badge — a handed user tab the agent is driving. */}
        {handed && (
          <span
            className="shrink-0 inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-accent-orange/15 text-accent-orange"
            title="The agent is driving this signed-in tab. Right-click → Return tab to me to revoke."
          >
            <Icons.Bot className="w-2.5 h-2.5" />
            Agent driving
          </span>
        )}

        {/* Pin toggle — hover affordance, kept compact for pinned tabs. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setTabPinned(tab.tabId, !pinned);
          }}
          className={`shrink-0 p-0.5 hover:text-accent-blue ${
            pinned ? 'text-accent-blue opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
          title={pinned ? 'Unpin tab' : 'Pin tab'}
        >
          {pinned ? <Icons.PinOff className="w-3 h-3" /> : <Icons.Pin className="w-3 h-3" />}
        </button>

        {!pinned && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              requestClose(tab.tabId);
            }}
            className="shrink-0 p-0.5 opacity-0 group-hover:opacity-100 hover:text-accent-red"
            title="Close tab"
          >
            <Icons.X className="w-3 h-3" />
          </button>
        )}
      </div>
    );
  };

  return (
    <>
      <div
        role="tablist"
        aria-label="Browser tabs"
        className="flex items-center gap-0.5 px-2 pt-1.5 bg-browser-chrome border-b border-browser-divider overflow-x-auto scrollbar-thin shrink-0"
      >
        {/* Pinned cluster (always plain, ungrouped, leftmost). */}
        {grouped.pinned.map(renderTab)}

        {/* Groups + loose tabs. */}
        {grouped.items.map((item) => {
          if (item.kind === 'tab') return renderTab(item.tab);
          const { group } = item;
          if (group.collapsed) {
            return (
              <div
                key={`group-${group.id}`}
                className="shrink-0"
                onMouseEnter={(e) =>
                  startHover(e, {
                    icon:
                      group.partition === 'agent' ? (
                        <Icons.Bot className="w-4 h-4 text-accent-orange" />
                      ) : (
                        <Icons.User className="w-4 h-4 text-accent-blue" />
                      ),
                    title: `${group.label} · ${group.members.length} tabs`,
                    subtitle: null,
                    members: group.members.slice(0, 3).map((m) => tabLabel(m.tab)),
                    moreCount: Math.max(0, group.members.length - 3),
                  })
                }
                onMouseLeave={endHover}
              >
                <TabGroupChip
                  group={group}
                  dropdownOpen={openGroupId === group.id}
                  onToggleInline={() => toggleGroupCollapsed(group.id)}
                  onToggleDropdown={(rect) => {
                    endHover();
                    if (openGroupId === group.id) {
                      openGroupDropdown(null);
                      return;
                    }
                    if (rect) setDropdownAnchor({ x: rect.left, y: rect.bottom });
                    openGroupDropdown(group.id);
                  }}
                />
              </div>
            );
          }
          // Expanded inline run: a tinted bracket with a leading collapse handle.
          const tint = group.partition === 'agent' ? 'bg-accent-orange/5' : 'bg-accent-blue/5';
          const accent = group.partition === 'agent' ? 'text-accent-orange' : 'text-accent-blue';
          return (
            <div
              key={`group-${group.id}`}
              className={`flex items-center gap-0.5 pl-1 rounded-t-lg shrink-0 ${tint}`}
            >
              <button
                onClick={() => toggleGroupCollapsed(group.id)}
                className={`flex items-center gap-1 px-1.5 h-8 rounded-t-lg text-[11px] font-medium hover:bg-[var(--color-tab-hover-bg)] ${accent}`}
                title={`Collapse ${group.label}`}
              >
                {group.partition === 'agent' ? (
                  <Icons.Bot className="w-3.5 h-3.5" />
                ) : (
                  <Icons.User className="w-3.5 h-3.5" />
                )}
                <Icons.ChevronDown className="w-3 h-3" />
              </button>
              {group.members.map(renderTab)}
            </div>
          );
        })}

        <button
          onClick={() => void createTab('user')}
          className="ui-btn ui-btn-ghost p-1.5 ml-1 shrink-0 self-center"
          title="New tab (your partition — persist:user)"
        >
          <Icons.Plus className="w-4 h-4" />
        </button>
        <button
          onClick={() => void reopenClosedTab()}
          className="ui-btn ui-btn-ghost p-1.5 shrink-0 self-center"
          title="Reopen closed tab (Ctrl+Shift+T)"
        >
          <Icons.RotateCcw className="w-4 h-4" />
        </button>

        {/* Persistent "Agent driving" chip for the active handed tab. */}
        {activeHandedTab && (
          <div
            className="ml-auto mr-1 shrink-0 self-center inline-flex items-center gap-1.5 pl-2 pr-1 py-0.5 rounded-full bg-accent-orange/15 text-accent-orange"
            title="The agent is driving this signed-in tab."
          >
            <Icons.Bot className="w-3 h-3 shrink-0" />
            <span className="text-[10px] font-bold uppercase tracking-wide">Agent driving</span>
            <button
              onClick={() => void tabReturnToHuman(activeHandedTab.tabId)}
              className="ui-btn ui-btn-ghost px-1.5 py-0.5 text-[10px] font-semibold rounded-full hover:text-accent-red"
              title="Stop the agent driving this tab and take it back"
            >
              <Icons.Undo2 className="w-3 h-3" />
              Return
            </button>
          </div>
        )}
      </div>

      {/* ── Rich hover card (human-readable; replaces title=URL) ─────────────── */}
      {hover && <TabHoverCard {...hover} />}

      {/* ── Group dropdown list (suspends the pane via its own hook) ─────────── */}
      {openGroupId &&
        dropdownAnchor &&
        (() => {
          const item = grouped.items.find(
            (i) => i.kind === 'group' && i.group.id === openGroupId,
          );
          if (!item || item.kind !== 'group') return null;
          return (
            <TabGroupDropdown
              group={item.group}
              x={dropdownAnchor.x}
              y={dropdownAnchor.y}
              onClose={() => openGroupDropdown(null)}
            />
          );
        })()}

      {/* ── Tab right-click context menu (hand-off / return) ─────────────────── */}
      {menu && menuTab && (
        <TabContextMenu
          x={menu.x}
          y={menu.y}
          handed={Boolean(handedTabIds[menu.tabId])}
          canHand={canHand}
          onReturn={() => {
            void tabReturnToHuman(menu.tabId);
            setMenu(null);
          }}
          onHandoff={beginHandoff}
          onClose={() => setMenu(null)}
        />
      )}

      {/* ── Hand-off confirm dialog (names the origin) ───────────────────────── */}
      {confirmHandoff && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setConfirmHandoff(null)}>
          <div
            className="w-[420px] max-w-[90vw] rounded-lg border border-[var(--color-browser-divider)] bg-[var(--color-surface-0)] shadow-xl p-4 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 text-fg-primary">
              <Icons.Bot className="w-5 h-5 text-accent-orange" />
              <span className="text-[14px] font-semibold">Hand this tab to the agent?</span>
            </div>
            <p className="text-[12px] text-fg-secondary">
              The agent will act inside your real signed-in session at{' '}
              <span className="font-mono text-fg-primary">{confirmHandoff.origin}</span> until you
              return the tab or close it. Anything the agent reads on this page can drive that
              session.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setConfirmHandoff(null)}
                className="ui-btn ui-btn-ghost px-3 py-1.5 text-[12px]"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  void tabHandToAgent(confirmHandoff.tabId);
                  setConfirmHandoff(null);
                }}
                className="ui-btn px-3 py-1.5 text-[12px] font-semibold bg-accent-orange text-white border border-accent-orange hover:bg-accent-orange/90"
              >
                <Icons.Bot className="w-4 h-4" />
                Hand to agent
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
