import { describe, it, expect } from 'vitest';
import {
  selectTabGroups,
  prettyHost,
  tabLabel,
  type OrderedTab,
} from './tab-groups';
import type { BrowserPartition, BrowserTabState } from '../../stores/browser-store';

function tab(
  tabId: string,
  partition: BrowserPartition,
  extra: Partial<BrowserTabState> = {},
): BrowserTabState {
  return {
    tabId,
    url: `https://${tabId}.example.com/path`,
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    partition,
    ...extra,
  };
}

function ord(t: BrowserTabState, order: number, pinned = false): OrderedTab {
  return { tab: t, order, pinned };
}

const DEFAULTS = {
  activeTabId: null,
  groupCollapsed: { agent: true, user: false } as Record<'agent' | 'user', boolean>,
  attentionTabIds: {} as Record<string, true>,
};

describe('selectTabGroups', () => {
  it('groups multiple agent tabs into one collapsed group', () => {
    const ordered = [
      ord(tab('a1', 'agent'), 0),
      ord(tab('a2', 'agent'), 1),
      ord(tab('a3', 'agent'), 2),
    ];
    const { pinned, items } = selectTabGroups({ ...DEFAULTS, ordered });
    expect(pinned).toHaveLength(0);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('group');
    if (items[0].kind === 'group') {
      expect(items[0].group.id).toBe('agent');
      expect(items[0].group.members).toHaveLength(3);
      expect(items[0].group.collapsed).toBe(true);
    }
  });

  it('renders a single-member partition as a loose tab, not a chip', () => {
    const ordered = [ord(tab('u1', 'user'), 0)];
    const { items } = selectTabGroups({ ...DEFAULTS, ordered });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('tab');
  });

  it('hoists pinned tabs out of groups into the pinned cluster', () => {
    const ordered = [
      ord(tab('a1', 'agent'), 0, true),
      ord(tab('a2', 'agent'), 1),
      ord(tab('a3', 'agent'), 2),
    ];
    const { pinned, items } = selectTabGroups({ ...DEFAULTS, ordered });
    expect(pinned.map((p) => p.tab.tabId)).toEqual(['a1']);
    // Only two unpinned agent tabs remain → still a group.
    expect(items).toHaveLength(1);
    if (items[0].kind === 'group') {
      expect(items[0].group.members.map((m) => m.tab.tabId)).toEqual(['a2', 'a3']);
    }
  });

  it('emits two groups ordered by first appearance, preserving member order', () => {
    const ordered = [
      ord(tab('u1', 'user'), 0),
      ord(tab('u2', 'user'), 1),
      ord(tab('a1', 'agent'), 2),
      ord(tab('a2', 'agent'), 3),
    ];
    const { items } = selectTabGroups({ ...DEFAULTS, ordered });
    expect(items.map((i) => (i.kind === 'group' ? i.group.id : 'tab'))).toEqual([
      'user',
      'agent',
    ]);
  });

  it('clusters all agent tabs even when interleaved with user tabs', () => {
    const ordered = [
      ord(tab('a1', 'agent'), 0),
      ord(tab('u1', 'user'), 1),
      ord(tab('a2', 'agent'), 2),
      ord(tab('u2', 'user'), 3),
    ];
    const { items } = selectTabGroups({ ...DEFAULTS, ordered });
    const agent = items.find((i) => i.kind === 'group' && i.group.id === 'agent');
    expect(agent && agent.kind === 'group' && agent.group.members.map((m) => m.tab.tabId)).toEqual(
      ['a1', 'a2'],
    );
  });

  it('surfaces the active member when it lives in a collapsed group', () => {
    const ordered = [ord(tab('a1', 'agent'), 0), ord(tab('a2', 'agent'), 1)];
    const { items } = selectTabGroups({ ...DEFAULTS, ordered, activeTabId: 'a2' });
    if (items[0].kind === 'group') {
      expect(items[0].group.activeMember?.tab.tabId).toBe('a2');
    }
  });

  it('flags attention when any member is pulsing', () => {
    const ordered = [ord(tab('a1', 'agent'), 0), ord(tab('a2', 'agent'), 1)];
    const { items } = selectTabGroups({
      ...DEFAULTS,
      ordered,
      attentionTabIds: { a2: true },
    });
    if (items[0].kind === 'group') {
      expect(items[0].group.hasAttention).toBe(true);
    }
  });

  it('reflects expanded state from groupCollapsed', () => {
    const ordered = [ord(tab('a1', 'agent'), 0), ord(tab('a2', 'agent'), 1)];
    const { items } = selectTabGroups({
      ...DEFAULTS,
      ordered,
      groupCollapsed: { agent: false, user: false },
    });
    if (items[0].kind === 'group') {
      expect(items[0].group.collapsed).toBe(false);
    }
  });
});

describe('prettyHost', () => {
  it('strips scheme, www., and path', () => {
    expect(prettyHost('https://www.github.com/foo/bar')).toBe('github.com');
  });
  it('returns null for unparseable input', () => {
    expect(prettyHost('not a url')).toBeNull();
    expect(prettyHost('')).toBeNull();
  });
});

describe('tabLabel', () => {
  it('prefers the page title', () => {
    expect(tabLabel({ ...tab('x', 'user'), title: 'My Page' })).toBe('My Page');
  });
  it('falls back to the pretty host', () => {
    expect(tabLabel({ ...tab('x', 'user'), title: '', url: 'https://www.foo.com/a' })).toBe(
      'foo.com',
    );
  });
  it('uses "New Tab" when there is no title or url', () => {
    expect(tabLabel({ ...tab('x', 'user'), title: '', url: '' })).toBe('New Tab');
  });
});
