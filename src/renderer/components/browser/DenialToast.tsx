import React, { useEffect } from 'react';
import * as Icons from 'lucide-react';
import {
  useBrowserStore,
  type AgentDrivingRevoked,
  type DenialToast as DenialToastItem,
} from '../../stores/browser-store';

// ── Denial toast (Slice-3) ───────────────────────────────────────────────────
// Transient notifications raised when the agent is BLOCKED in the browser (a
// `denied:<code>` audit event for the workspace the human is viewing). The store
// (handleAuditEvent) owns the surfacing + host+code dedupe within 10s; this
// component renders the stack, auto-dismisses each after 6s, and offers "View"
// (open the Activity drawer) + the remediation CTA from DENIAL_COPY.action.
//
// Occlusion note: a WebContentsView paints above renderer DOM within the host
// bounds, so these are pinned to the TOP-RIGHT chrome zone (above the host) and
// deliberately do NOT suspend the pane — a 6s transient must never blank the
// agent's live page. The Activity DRAWER (which overlaps the host) suspends; the
// toast does not.

const TOAST_MS = 6_000;

function ToastCard({ toast }: { toast: DenialToastItem }) {
  const dismissDenialToast = useBrowserStore((s) => s.dismissDenialToast);
  const openAuditDrawer = useBrowserStore((s) => s.openAuditDrawer);
  const openAccessView = useBrowserStore((s) => s.openAccessView);
  const setActionsEnabled = useBrowserStore((s) => s.setActionsEnabled);

  // Auto-dismiss 6s after the toast was surfaced (shownAt is set at creation).
  useEffect(() => {
    const remaining = Math.max(0, toast.shownAt + TOAST_MS - Date.now());
    const t = window.setTimeout(() => dismissDenialToast(toast.id), remaining);
    return () => clearTimeout(t);
  }, [toast.id, toast.shownAt, dismissDenialToast]);

  const onView = () => {
    openAuditDrawer();
    dismissDenialToast(toast.id);
  };

  const onRemediate = () => {
    if (toast.action === 'open-access-settings') openAccessView();
    else if (toast.action === 'enable-actions') void setActionsEnabled(true);
    dismissDenialToast(toast.id);
  };

  const ctaLabel =
    toast.action === 'open-access-settings'
      ? 'Open website access'
      : toast.action === 'enable-actions'
        ? 'Enable agent actions'
        : null;

  return (
    <div
      role="status"
      className="pointer-events-auto w-[320px] rounded-md border border-accent-red/40 bg-[var(--color-surface-0)] shadow-lg p-3 flex flex-col gap-1.5"
    >
      <div className="flex items-start gap-2">
        <Icons.ShieldAlert className="w-4 h-4 text-accent-red shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-fg-primary">{toast.title}</div>
          {toast.host && (
            <div className="text-[10px] text-fg-muted truncate" title={toast.host}>
              {toast.host}
            </div>
          )}
        </div>
        <button
          onClick={() => dismissDenialToast(toast.id)}
          className="ui-btn ui-btn-ghost p-0.5 shrink-0"
          title="Dismiss"
        >
          <Icons.X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="text-[11px] text-fg-secondary leading-snug">{toast.body}</div>
      <div className="flex items-center gap-2 mt-0.5">
        <button onClick={onView} className="ui-btn ui-btn-ghost px-2 py-0.5 text-[11px]">
          View
        </button>
        {ctaLabel && (
          <button onClick={onRemediate} className="ui-btn ui-btn-outline px-2 py-0.5 text-[11px]">
            {ctaLabel}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Slice 12: "agent driving stopped" toast ───────────────────────────────────
// Raised when a handed tab auto-navigated off its allow-signed-in origin and
// main detached the driver (§12-B). The store already dropped the chip; this is
// the human-visible notice. Same 6s auto-dismiss + top-right placement; amber
// (an expected revoke, not a denial) rather than red.
function RevokedCard({ notice }: { notice: AgentDrivingRevoked }) {
  const dismiss = useBrowserStore((s) => s.dismissDrivingRevoked);

  useEffect(() => {
    const t = window.setTimeout(() => dismiss(notice.tabId), TOAST_MS);
    return () => clearTimeout(t);
  }, [notice.tabId, dismiss]);

  return (
    <div
      role="status"
      className="pointer-events-auto w-[320px] rounded-md border border-accent-orange/40 bg-[var(--color-surface-0)] shadow-lg p-3 flex flex-col gap-1.5"
    >
      <div className="flex items-start gap-2">
        <Icons.Bot className="w-4 h-4 text-accent-orange shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-fg-primary">Agent driving stopped</div>
          {notice.hostname && (
            <div className="text-[10px] text-fg-muted truncate" title={notice.hostname}>
              {notice.hostname}
            </div>
          )}
        </div>
        <button
          onClick={() => dismiss(notice.tabId)}
          className="ui-btn ui-btn-ghost p-0.5 shrink-0"
          title="Dismiss"
        >
          <Icons.X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="text-[11px] text-fg-secondary leading-snug">
        The tab navigated off the signed-in site, so the agent was returned control of your tab.
      </div>
    </div>
  );
}

export default function DenialToast() {
  const denialToasts = useBrowserStore((s) => s.denialToasts);
  const drivingRevoked = useBrowserStore((s) => s.drivingRevoked);
  if (denialToasts.length === 0 && drivingRevoked.length === 0) return null;
  return (
    <div className="absolute top-2 right-2 z-[60] flex flex-col gap-2 pointer-events-none">
      {denialToasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
      {drivingRevoked.map((r) => (
        <RevokedCard key={`revoked-${r.tabId}`} notice={r} />
      ))}
    </div>
  );
}
