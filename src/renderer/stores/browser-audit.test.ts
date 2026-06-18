// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  useBrowserStore,
  selectVisibleAuditEvents,
  auditHost,
  type BrowserAuditEntry,
} from './browser-store';
import { DENIAL_COPY } from '../../main/browser/browser-policy';

// Slice-3 acceptance (renderer lane): the denial-toast surfacing + per-workspace
// audit-feed isolation that the Activity drawer + AddressBar badge read from.
// Pure store logic (handleAuditEvent / selectVisibleAuditEvents) — no preload.

function ev(over: Partial<BrowserAuditEntry> = {}): BrowserAuditEntry {
  return {
    ts: new Date().toISOString(),
    verb: 'openUrl',
    partition: 'persist:agent',
    url: 'https://blocked.example/path',
    outcome: 'denied:actions-disabled',
    workspaceId: 'ws-A',
    agentId: 'agent-7',
    agentTitle: 'Research bot',
    ...over,
  };
}

beforeEach(() => {
  useBrowserStore.setState({
    auditEvents: [],
    auditDrawerOpen: false,
    auditUnreadDenials: 0,
    denialToasts: [],
    selectedWorkspaceId: 'ws-A',
    activeTabId: null,
    tabs: [],
  });
});

describe('Slice-3: denial toast surfacing', () => {
  it('a denial event raises a toast with the exact DENIAL_COPY copy + action', () => {
    useBrowserStore.getState().handleAuditEvent(ev());
    const toasts = useBrowserStore.getState().denialToasts;
    expect(toasts).toHaveLength(1);
    const t = toasts[0];
    const expected = DENIAL_COPY['actions-disabled'];
    expect(t.code).toBe('actions-disabled');
    expect(t.title).toBe(expected.title);
    expect(t.body).toBe(expected.body);
    expect(t.action).toBe(expected.action); // 'enable-actions'
    expect(t.action).toBe('enable-actions');
    expect(t.host).toBe('blocked.example');
    // Every denial bumps the unread-denial badge.
    expect(useBrowserStore.getState().auditUnreadDenials).toBe(1);
  });

  it('a different denial code maps to its own copy + remediation (open-access-settings)', () => {
    useBrowserStore.getState().handleAuditEvent(
      ev({ outcome: 'denied:agent-allowlist-denied' }),
    );
    const t = useBrowserStore.getState().denialToasts[0];
    expect(t.title).toBe(DENIAL_COPY['agent-allowlist-denied'].title);
    expect(t.action).toBe('open-access-settings');
  });

  it('a non-denial (ok) event lands in the feed but never raises a toast', () => {
    useBrowserStore.getState().handleAuditEvent(ev({ outcome: 'ok' }));
    const s = useBrowserStore.getState();
    expect(s.denialToasts).toHaveLength(0);
    expect(s.auditUnreadDenials).toBe(0);
    expect(s.auditEvents).toHaveLength(1);
  });

  it('dedupes identical host+code within 10s — one toast, badge still counts each', () => {
    useBrowserStore.getState().handleAuditEvent(ev());
    useBrowserStore.getState().handleAuditEvent(ev()); // same host+code, immediately
    const s = useBrowserStore.getState();
    expect(s.denialToasts).toHaveLength(1); // deduped — no duplicate node
    expect(s.auditUnreadDenials).toBe(2); // but both counted as unread
  });

  it('a different host (same code) is NOT deduped — a second toast appears', () => {
    useBrowserStore.getState().handleAuditEvent(ev());
    useBrowserStore.getState().handleAuditEvent(ev({ url: 'https://other.example/x' }));
    expect(useBrowserStore.getState().denialToasts).toHaveLength(2);
  });

  it('dismissDenialToast removes only the targeted toast', () => {
    useBrowserStore.getState().handleAuditEvent(ev());
    useBrowserStore.getState().handleAuditEvent(ev({ url: 'https://other.example/x' }));
    const [first] = useBrowserStore.getState().denialToasts;
    useBrowserStore.getState().dismissDenialToast(first.id);
    const left = useBrowserStore.getState().denialToasts;
    expect(left).toHaveLength(1);
    expect(left[0].id).not.toBe(first.id);
  });

  it('openAuditDrawer opens the drawer and resets the unread-denial badge', () => {
    useBrowserStore.getState().handleAuditEvent(ev());
    expect(useBrowserStore.getState().auditUnreadDenials).toBe(1);
    useBrowserStore.getState().openAuditDrawer();
    const s = useBrowserStore.getState();
    expect(s.auditDrawerOpen).toBe(true);
    expect(s.auditUnreadDenials).toBe(0);
  });
});

describe('Slice-3: per-workspace audit isolation + payload', () => {
  it('a denial in ANOTHER workspace lands in the ring buffer but never interrupts', () => {
    useBrowserStore.getState().handleAuditEvent(ev({ workspaceId: 'ws-B' }));
    const s = useBrowserStore.getState();
    expect(s.denialToasts).toHaveLength(0); // not the viewed workspace → no toast
    expect(s.auditUnreadDenials).toBe(0);
    expect(s.auditEvents).toHaveLength(1); // still recorded for ws-B's drawer
  });

  it('the audit event/entry payload carries workspaceId + agentId, scoped by selectVisibleAuditEvents', () => {
    useBrowserStore.getState().handleAuditEvent(ev()); // ws-A
    useBrowserStore.getState().handleAuditEvent(ev({ workspaceId: 'ws-B', agentId: 'agent-9' }));

    const all = useBrowserStore.getState().auditEvents;
    expect(all).toHaveLength(2);

    const visible = selectVisibleAuditEvents({ auditEvents: all, selectedWorkspaceId: 'ws-A' });
    expect(visible).toHaveLength(1);
    expect(visible[0].workspaceId).toBe('ws-A');
    expect(visible[0].agentId).toBe('agent-7');
    expect(visible[0].agentTitle).toBe('Research bot');

    // Switching the viewed workspace surfaces only that workspace's row.
    const visibleB = selectVisibleAuditEvents({ auditEvents: all, selectedWorkspaceId: 'ws-B' });
    expect(visibleB).toHaveLength(1);
    expect(visibleB[0].agentId).toBe('agent-9');
  });

  it('the ring buffer is capped at 200 (oldest dropped)', () => {
    for (let i = 0; i < 250; i++) {
      useBrowserStore.getState().handleAuditEvent(ev({ outcome: 'ok', url: `https://x${i}.example/` }));
    }
    const all = useBrowserStore.getState().auditEvents;
    expect(all).toHaveLength(200);
    expect(all[0].url).toBe('https://x50.example/'); // 0..49 evicted
    expect(all[199].url).toBe('https://x249.example/');
  });
});

describe('Slice-3: auditHost helper', () => {
  it('extracts the hostname, and returns "" for empty/unparseable urls (NTP/about:blank)', () => {
    expect(auditHost('https://sub.example.com/a?b=1')).toBe('sub.example.com');
    expect(auditHost('')).toBe('');
    expect(auditHost('about:blank')).toBe('');
  });
});
