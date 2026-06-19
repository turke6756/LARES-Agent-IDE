import React, { useEffect, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { useBrowserStore } from '../../stores/browser-store';
import { suspendBrowserPane, resumeBrowserPane } from './useBrowserSuspension';

// Slice 12: armed-state agent-actions control. The coarse on/off M12 toggle is
// replaced by a compact popover with time-boxed arming ("Enable for 15 min" /
// "Enable until restart" / "Disable now"). Dashboard-GLOBAL (not per-agent):
// when armed, any agent's act-tier verbs (openUrl/click/type/…) may drive THIS
// dashboard's agent-partition browser; read-only tools work either way. The
// state is a runtime, non-persisted mirror of the main-process gate — it resets
// to its launch default (env-seeded "armed until restart" when
// AGENT_BROWSER_ACTIONS=1, otherwise disabled) on every restart. Arming with a
// duration auto-flips back to disabled on expiry (the main process pushes the
// flip). Rendering this in trusted shell chrome (not page/model output) is by
// design.

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

/** Short human countdown for a finite armed window, e.g. "14m left" / "45s left". */
function formatRemaining(armedUntil: number, now: number): string {
  const ms = Math.max(0, armedUntil - now);
  const mins = Math.floor(ms / 60000);
  if (mins >= 1) return `${mins}m left`;
  return `${Math.max(0, Math.ceil(ms / 1000))}s left`;
}

export default function AgentActionsToggle() {
  const actionsState = useBrowserStore((s) => s.actionsState);
  const enabled = useBrowserStore((s) => s.actionsEnabled);
  const setAgentActionsState = useBrowserStore((s) => s.setAgentActionsState);
  const loadActionsState = useBrowserStore((s) => s.loadActionsState);
  // Popover context counts.
  const accessRules = useBrowserStore((s) => s.accessRules);
  const accessRequests = useBrowserStore((s) => s.accessRequests);
  const tabs = useBrowserStore((s) => s.tabs);

  const [open, setOpen] = useState(false);
  // When enabling would race pending sign-in handoffs, we stash the pending
  // command and surface an inline confirm step instead of applying immediately.
  const [confirmCmd, setConfirmCmd] = useState<
    null | { mode: 'armed'; durationMs: number | null }
  >(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadActionsState();
  }, [loadActionsState]);

  const allowedOriginCount = accessRules.filter((r) => r.enabled).length;
  const pendingRequestCount = accessRequests.filter((r) => r.status === 'pending').length;
  const pendingSigninCount = tabs.filter((t) => t.signinPending).length;

  const armed = actionsState.mode === 'armed';
  const finite = armed && actionsState.armedUntil !== null;

  // Tick once a second while a finite armed window is open, so the countdown
  // stays live. Cheap and bounded to the open popover.
  useEffect(() => {
    if (!open || !finite) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [open, finite]);

  // Dismiss on outside click.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirmCmd(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Cross-cutting rule #3: the popover can overlap the native WebContentsView
  // (it renders below the toolbar), and a native view paints ABOVE renderer DOM
  // — so suspend the pane while open (ref-counted; composes with other overlays).
  useEffect(() => {
    if (!open) return;
    suspendBrowserPane();
    return () => resumeBrowserPane();
  }, [open]);

  const apply = (cmd: { mode: 'armed'; durationMs: number | null } | { mode: 'disabled' }) => {
    void setAgentActionsState(cmd);
    setOpen(false);
    setConfirmCmd(null);
  };

  // Enabling confirms first when sign-in handoffs are mid-flight (the agent
  // would gain act-tier capability while a credential handoff is in progress).
  const requestEnable = (durationMs: number | null) => {
    if (pendingSigninCount > 0) {
      setConfirmCmd({ mode: 'armed', durationMs });
    } else {
      apply({ mode: 'armed', durationMs });
    }
  };

  const statusLabel = armed
    ? finite
      ? `Armed · ${formatRemaining(actionsState.armedUntil!, nowTick)}`
      : 'Armed until restart'
    : 'Disabled';

  return (
    <div className="relative shrink-0" ref={popoverRef}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Agent browser actions"
        onClick={() => setOpen((v) => !v)}
        className="ui-btn ui-btn-ghost flex items-center gap-1.5 px-1.5 py-1 shrink-0"
        title={`Agent actions — ${statusLabel}. Click to arm or disable.`}
      >
        <Icons.Bot className={`w-4 h-4 ${enabled ? 'text-accent-orange' : 'text-fg-muted'}`} />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-fg-secondary hidden md:inline">
          Agent actions
        </span>
        <span
          className={`relative inline-flex h-3.5 w-6 items-center rounded-full transition-colors ${
            enabled ? 'bg-accent-orange' : 'bg-tab-border'
          }`}
        >
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-3' : 'translate-x-0.5'
            }`}
          />
        </span>
      </button>

      {open && (
        <div
          className="absolute z-50 top-full mt-1 right-0 w-72 rounded-md p-3 flex flex-col gap-2 bg-[var(--color-browser-chrome-2)] border border-[var(--color-browser-divider)] shadow-lg"
          role="dialog"
          aria-label="Agent actions control"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-fg-primary">Agent actions</span>
            <span
              className={`text-[10px] font-semibold uppercase tracking-wide ${
                armed ? 'text-accent-orange' : 'text-fg-muted'
              }`}
            >
              {statusLabel}
            </span>
          </div>

          <p className="text-[10px] leading-snug text-fg-muted">
            When armed, agents can drive this dashboard&apos;s browser (open URLs, click,
            type) on the agent partition. Read-only tools work regardless.
          </p>

          <div className="flex items-center gap-3 text-[10px] text-fg-secondary">
            <span title="Origins the agent is allowed to visit/drive">
              <span className="font-semibold text-fg-primary">{allowedOriginCount}</span> allowed
            </span>
            <span title="Pending site-access requests awaiting approval">
              <span className="font-semibold text-fg-primary">{pendingRequestCount}</span> pending
            </span>
            {pendingSigninCount > 0 && (
              <span className="text-amber-500" title="Sign-in handoffs in progress">
                <span className="font-semibold">{pendingSigninCount}</span> sign-in
              </span>
            )}
          </div>

          {confirmCmd ? (
            <div className="flex flex-col gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2">
              <span className="text-[10px] leading-snug text-amber-600">
                {pendingSigninCount} sign-in handoff{pendingSigninCount === 1 ? '' : 's'} in
                progress. Arming now lets agents act while a credential handoff is open.
                Continue?
              </span>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setConfirmCmd(null)}
                  className="ui-btn ui-btn-ghost px-2 py-1 text-[11px]"
                >
                  Cancel
                </button>
                <button
                  onClick={() => apply(confirmCmd)}
                  className="ui-btn ui-btn-outline px-3 py-1 text-[11px] text-accent-orange"
                >
                  Arm anyway
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 pt-1">
              <button
                onClick={() => requestEnable(FIFTEEN_MIN_MS)}
                className="ui-btn ui-btn-outline px-2 py-1 text-[11px] text-left"
              >
                Enable for 15 min
              </button>
              <button
                onClick={() => requestEnable(null)}
                className="ui-btn ui-btn-outline px-2 py-1 text-[11px] text-left"
              >
                Enable until restart
              </button>
              <button
                onClick={() => apply({ mode: 'disabled' })}
                disabled={!armed}
                className="ui-btn ui-btn-ghost px-2 py-1 text-[11px] text-left text-accent-red disabled:opacity-40"
              >
                Disable now
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
