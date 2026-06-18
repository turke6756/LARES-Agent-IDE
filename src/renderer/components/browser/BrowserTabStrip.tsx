import React, { useEffect, useMemo, useRef, useState } from 'react';
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
    return (
      <div
        key={tab.tabId}
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
            closeTab(tab.tabId);
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
          draggingId === tab.tabId ? 'opacity-50' : ''
        }`}
      >
        <TabIcon tab={tab} />

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
              closeTab(tab.tabId);
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
      <div className="flex items-center gap-0.5 px-2 pt-1.5 bg-browser-chrome border-b border-browser-divider overflow-x-auto scrollbar-thin shrink-0">
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
        <>
          <div className="fixed inset-0 z-50" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className="fixed z-50 min-w-[220px] rounded-md border border-[var(--color-browser-divider)] bg-[var(--color-surface-0)] shadow-lg py-1 text-[12px]"
            style={{ left: menu.x, top: menu.y }}
          >
            {handedTabIds[menu.tabId] ? (
              <button
                onClick={() => {
                  void tabReturnToHuman(menu.tabId);
                  setMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-fg-primary hover:bg-[var(--color-tab-hover-bg)]"
              >
                <Icons.Undo2 className="w-3.5 h-3.5 shrink-0" />
                Return tab to me
              </button>
            ) : (
              <button
                onClick={beginHandoff}
                disabled={!canHand}
                className={`w-full text-left px-3 py-1.5 flex items-center gap-2 ${
                  canHand
                    ? 'text-fg-primary hover:bg-[var(--color-tab-hover-bg)]'
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
