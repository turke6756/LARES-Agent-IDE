import React, { useEffect, useMemo, useState } from 'react';
import * as Icons from 'lucide-react';
import {
  useBrowserStore,
  selectVisibleAuditEvents,
  auditHost,
  type BrowserAuditEntry,
} from '../../stores/browser-store';
import { denialCopyForOutcome } from '../../../main/browser/browser-policy';
import { useBrowserSuspension } from './useBrowserSuspension';

// ── Activity / Audit drawer (Slice-3) ────────────────────────────────────────
// Right-side slide-over surfacing the M16 action-audit feed for the workspace
// the human is viewing (selectVisibleAuditEvents — per-workspace isolation). It
// overlaps the WebContentsView, so it suspends the pane for its lifetime via
// useBrowserSuspension (cross-cutting rule #3).
//
// Rows are newest-first: time-ago · verb · partition badge · host · outcome chip
// (green ok / red denied:<DENIAL_COPY title> / amber error). Filter chips scope
// the list to All / Denied / This host. Denied rows render the remediation CTA
// from DENIAL_COPY.action (open the access overlay, or flip the Agent Actions
// gate). The feed NEVER carries page content — only audited shell metadata.

type Filter = 'all' | 'denied' | 'host';

/** Compact relative "x ago" from an ISO-8601 timestamp. */
function timeAgo(ts: string): string {
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Outcome → chip styling + label. Green ok / red denied:<title> / amber error. */
function outcomeChip(outcome: string): { label: string; className: string } {
  const denial = denialCopyForOutcome(outcome);
  if (denial) {
    return {
      label: `denied: ${denial.copy.title}`,
      className: 'text-accent-red bg-accent-red/10',
    };
  }
  if (outcome.startsWith('error:')) {
    return { label: 'error', className: 'text-accent-orange bg-accent-orange/10' };
  }
  if (outcome === 'ok:authenticated') {
    return { label: 'authenticated', className: 'text-accent-green bg-accent-green/10' };
  }
  return { label: 'ok', className: 'text-accent-green bg-accent-green/10' };
}

function Row({ entry }: { entry: BrowserAuditEntry }) {
  const openAccessView = useBrowserStore((s) => s.openAccessView);
  const setActionsEnabled = useBrowserStore((s) => s.setActionsEnabled);
  const closeAuditDrawer = useBrowserStore((s) => s.closeAuditDrawer);

  const host = auditHost(entry.url);
  const chip = outcomeChip(entry.outcome);
  const denial = denialCopyForOutcome(entry.outcome);
  const isAgent = entry.partition === 'persist:agent';

  const remediate = () => {
    if (!denial) return;
    if (denial.copy.action === 'open-access-settings') {
      closeAuditDrawer();
      openAccessView();
    } else if (denial.copy.action === 'enable-actions') {
      void setActionsEnabled(true);
      closeAuditDrawer();
    }
  };

  const ctaLabel =
    denial?.copy.action === 'open-access-settings'
      ? 'Open website access'
      : denial?.copy.action === 'enable-actions'
        ? 'Enable agent actions'
        : null;

  return (
    <div className="flex flex-col gap-1 px-3 py-2 border-b border-[var(--color-browser-divider)]">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[10px] text-fg-muted shrink-0 tabular-nums w-14" title={entry.ts}>
          {timeAgo(entry.ts)}
        </span>
        <span className="text-[11px] font-semibold text-fg-primary shrink-0">{entry.verb}</span>
        <span
          className={`text-[9px] px-1 py-0.5 font-semibold uppercase shrink-0 rounded-sm ${
            isAgent ? 'text-accent-orange bg-accent-orange/10' : 'text-accent-blue bg-accent-blue/10'
          }`}
          title={isAgent ? 'Agent partition' : 'Your partition'}
        >
          {isAgent ? 'agent' : 'user'}
        </span>
        <span className="text-[11px] text-fg-secondary truncate flex-1 min-w-0" title={entry.url}>
          {host || entry.url || '—'}
        </span>
      </div>
      <div className="flex items-center gap-2 pl-16">
        <span className={`text-[10px] px-1.5 py-0.5 rounded-sm font-medium ${chip.className}`}>
          {chip.label}
        </span>
        {entry.agentTitle && (
          <span className="text-[10px] text-fg-muted truncate" title={`Opened by ${entry.agentTitle}`}>
            · {entry.agentTitle}
          </span>
        )}
        {ctaLabel && (
          <button
            onClick={remediate}
            className="ui-btn ui-btn-outline px-2 py-0.5 text-[10px] ml-auto shrink-0"
          >
            {ctaLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function ActivityDrawerInner() {
  useBrowserSuspension();

  const closeAuditDrawer = useBrowserStore((s) => s.closeAuditDrawer);
  const auditEvents = useBrowserStore((s) => s.auditEvents);
  const selectedWorkspaceId = useBrowserStore((s) => s.selectedWorkspaceId);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const tabs = useBrowserStore((s) => s.tabs);

  const [filter, setFilter] = useState<Filter>('all');

  // Per-workspace isolation: only this workspace's audit rows, newest-first.
  const visible = useMemo(
    () => selectVisibleAuditEvents({ auditEvents, selectedWorkspaceId }),
    [auditEvents, selectedWorkspaceId],
  );

  // "This host" reference = the active tab's host (empty when no tab / NTP).
  const activeHost = useMemo(() => {
    const tab = tabs.find((t) => t.tabId === activeTabId);
    return tab ? auditHost(tab.url) : '';
  }, [tabs, activeTabId]);

  const rows = useMemo(() => {
    const list = visible.filter((e) => {
      if (filter === 'denied') return denialCopyForOutcome(e.outcome) !== null;
      if (filter === 'host') return activeHost !== '' && auditHost(e.url) === activeHost;
      return true;
    });
    // Newest-first (the buffer is oldest→newest).
    return [...list].reverse();
  }, [visible, filter, activeHost]);

  // Close on Esc (mirror of HistoryView).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAuditDrawer();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeAuditDrawer]);

  const chip = (id: Filter, label: string) => (
    <button
      onClick={() => setFilter(id)}
      className={`px-2 py-0.5 text-[11px] rounded-full border transition-colors ${
        filter === id
          ? 'bg-accent-blue/15 border-accent-blue/50 text-accent-blue'
          : 'border-[var(--color-browser-divider)] text-fg-secondary hover:bg-[var(--color-tab-hover-bg)]'
      }`}
    >
      {label}
    </button>
  );

  return (
    <>
      {/* Backdrop — clicking it closes the drawer. The pane is already suspended,
          so the backdrop paints over the (now-hidden) host region. */}
      <div className="absolute inset-0 z-40 bg-black/20" onClick={closeAuditDrawer} />
      <div
        className="absolute inset-y-0 right-0 z-50 w-[420px] max-w-full flex flex-col bg-[var(--color-surface-0)] text-fg-primary border-l border-[var(--color-browser-divider)] shadow-xl"
        role="dialog"
        aria-label="Browser activity"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-browser-divider)] shrink-0">
          <Icons.ScrollText className="w-5 h-5" />
          <span className="text-[14px] font-semibold flex-1">Activity</span>
          <button onClick={closeAuditDrawer} className="ui-btn ui-btn-ghost p-1.5" title="Close activity">
            <Icons.X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-browser-divider)] shrink-0">
          {chip('all', 'All')}
          {chip('denied', 'Denied')}
          {chip('host', activeHost ? `This host (${activeHost})` : 'This host')}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-fg-muted gap-2">
              <Icons.ScrollText className="w-8 h-8 opacity-40" />
              <span className="text-[12px]">
                {filter === 'denied'
                  ? 'No denied actions.'
                  : filter === 'host'
                    ? 'No activity for this host.'
                    : 'No browser activity yet.'}
              </span>
            </div>
          ) : (
            rows.map((e, i) => <Row key={`${e.ts}-${e.verb}-${i}`} entry={e} />)
          )}
        </div>
      </div>
    </>
  );
}

export default function ActivityDrawer() {
  const auditDrawerOpen = useBrowserStore((s) => s.auditDrawerOpen);
  if (!auditDrawerOpen) return null;
  return <ActivityDrawerInner />;
}
