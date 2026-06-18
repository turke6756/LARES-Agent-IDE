import type { BrowserPartition, BrowserTabState } from '../../stores/browser-store';

// ── Tab grouping (renderer-derived, no IPC change) ───────────────────────────
//
// Agents spawn many tabs; the flat strip overflows. We derive at most two
// groups from the existing `partition` field — "Agent" (orange) and "Your tabs"
// (blue) — so the agent pile-up collapses into a single chip the human can
// expand inline or as a dropdown list. This is PURE UI state: order + pin stay
// main-authoritative (the `snapshot`), and grouping layers on top of the
// already-ordered list without re-parenting anything.
//
// Rules:
//   • Pinned tabs are never grouped — they hoist to the pinned cluster at the
//     left (mirrors Chrome: pinning pulls a tab out of its group).
//   • A partition with ≤1 unpinned tab renders as a loose tab, not a chip (a
//     chip around a single tab is just noise).
//   • Within a group, members keep their snapshot order; groups emit in order
//     of each partition's first appearance among the unpinned tabs.

export interface OrderedTab {
  tab: BrowserTabState;
  pinned: boolean;
  /** Main-authoritative order index; -1 in the pre-snapshot fallback. */
  order: number;
}

export type TabGroupId = 'agent' | 'user';

export interface TabGroup {
  id: TabGroupId;
  partition: BrowserPartition;
  label: string;
  members: OrderedTab[];
  collapsed: boolean;
  /** Any member pulsing for attention — surfaced on the collapsed chip so the
   *  agent-attention signal isn't hidden by collapsing. */
  hasAttention: boolean;
  /** The active tab IF it lives in this group — the collapsed chip shows it so
   *  the human always knows what's on screen. */
  activeMember: OrderedTab | null;
}

export type StripItem =
  | { kind: 'tab'; tab: OrderedTab }
  | { kind: 'group'; group: TabGroup };

export interface GroupedStrip {
  /** Pinned tabs, rendered as compact plain tabs at the left. */
  pinned: OrderedTab[];
  /** Ordered render list of groups + loose tabs (pinned excluded). */
  items: StripItem[];
}

const GROUP_LABEL: Record<TabGroupId, string> = {
  agent: 'Agent',
  user: 'Your tabs',
};

const PARTITION_GROUP: Record<BrowserPartition, TabGroupId> = {
  agent: 'agent',
  user: 'user',
};

export interface SelectTabGroupsInput {
  ordered: OrderedTab[];
  activeTabId: string | null;
  groupCollapsed: Record<TabGroupId, boolean>;
  attentionTabIds: Record<string, true>;
}

export function selectTabGroups(input: SelectTabGroupsInput): GroupedStrip {
  const { ordered, activeTabId, groupCollapsed, attentionTabIds } = input;

  const pinned = ordered.filter((o) => o.pinned);
  const unpinned = ordered.filter((o) => !o.pinned);

  // Bucket unpinned tabs by partition, preserving order, and remember the
  // first-appearance index so groups emit left-to-right by where they start.
  const buckets = new Map<TabGroupId, OrderedTab[]>();
  const firstSeen = new Map<TabGroupId, number>();
  unpinned.forEach((o, i) => {
    const id = PARTITION_GROUP[o.tab.partition];
    if (!buckets.has(id)) {
      buckets.set(id, []);
      firstSeen.set(id, i);
    }
    buckets.get(id)!.push(o);
  });

  const orderedIds = [...buckets.keys()].sort(
    (a, b) => (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0),
  );

  const items: StripItem[] = [];
  for (const id of orderedIds) {
    const members = buckets.get(id)!;
    // ≤1 member → loose tab(s), no chip.
    if (members.length <= 1) {
      members.forEach((tab) => items.push({ kind: 'tab', tab }));
      continue;
    }
    const activeMember =
      members.find((m) => m.tab.tabId === activeTabId) ?? null;
    const hasAttention = members.some((m) => Boolean(attentionTabIds[m.tab.tabId]));
    items.push({
      kind: 'group',
      group: {
        id,
        partition: members[0].tab.partition,
        label: GROUP_LABEL[id],
        members,
        collapsed: Boolean(groupCollapsed[id]),
        hasAttention,
        activeMember,
      },
    });
  }

  return { pinned, items };
}

// ── Human-readable labels (NOT raw URLs) ─────────────────────────────────────

/** A page's display title: its <title>, falling back to a prettified host. */
export function tabLabel(tab: BrowserTabState): string {
  if (tab.title) return tab.title;
  if (tab.url) return prettyHost(tab.url) ?? tab.url;
  return 'New Tab';
}

/** Domain only, de-emphasized for the hover-card subtitle — scheme, `www.`,
 *  and path stripped. Returns null when the input has no parseable host. */
export function prettyHost(url: string): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).host;
    return host ? host.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}
