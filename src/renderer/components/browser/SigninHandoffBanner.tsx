import React, { useEffect } from 'react';
import * as Icons from 'lucide-react';
import { useBrowserStore } from '../../stores/browser-store';

// ── Mechanism-A sign-in hand-off banner (plans/website-allowlist-design.md §15)
//
// Shown in the browser CHROME (above the host, never occluded by the
// WebContentsView) while a visible, quarantined persist:agent login tab is open
// — the human types their credentials into that tab (the agent is quarantined
// from it), then clicks "Hand to agent" here to clear the quarantine.
//
// The banner MUST state all four §15 consent points:
//   (a) the agent will drive this session afterward,
//   (b) ALL workspace agents share it,
//   (c) it persists across restarts until you sign out / clear,
//   (d) don't enter credentials you wouldn't share with this workspace.
//
// Slice 12 adds: a quarantine badge on the login tab ("🔒 Human only — agent
// can't read this"), a clearly-labelled "Cancel hand-off" affordance, and a
// transient success state after the hand-off completes.
//
// The hostname renders as plain escaped text (a text child) — never as markup
// or a link.

const SUCCESS_MS = 5_000;

// Transient confirmation shown for a few seconds once the human hands the
// signed-in tab to the agent. Self-dismisses; also dismissable by hand.
function HandoffSuccess({ hostname }: { hostname: string }) {
  const dismiss = useBrowserStore((s) => s.dismissSigninHandoffDone);

  useEffect(() => {
    const t = window.setTimeout(() => dismiss(), SUCCESS_MS);
    return () => clearTimeout(t);
  }, [dismiss]);

  return (
    <div
      role="status"
      className="border-b border-accent-green/40 bg-accent-green/10 px-3 py-2 text-[12px] text-fg-primary shrink-0 flex items-center gap-2"
    >
      <Icons.CheckCircle2 className="w-4 h-4 text-accent-green shrink-0" />
      <span className="flex-1">
        The agent can now use your signed-in session for{' '}
        <span className="font-mono">{hostname}</span>.
      </span>
      <button onClick={() => dismiss()} className="ui-btn ui-btn-ghost p-1 shrink-0" title="Dismiss">
        <Icons.X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ── Signed-in tabs (WI-5): JIT sign-in reminder banner ───────────────────────
//
// Surfaced when an AGENT navigated to an `allow_signed_in` origin with no live
// session and main pushed browser:signin-pending-opened (a quarantined login tab
// was opened). Unlike the Mechanism-B consent banner above, this is an
// in-context REMINDER, not a second consent gate — the human already consented
// once at toggle-on. It names the origin + the waiting agent, and offers:
//   • "Done signing in" → access-handoff-ready (clears quarantine, the agent
//     proceeds on the shared session),
//   • "Cancel" → signin-pending-cancel (the agent degrades to a block-stub; the
//     rule's durable consent is preserved).
// It clears on browser:signin-resolved (also covers timeout / unattended).
function JitSigninBanner({ origin }: { origin: string }) {
  const complete = useBrowserStore((s) => s.completeSigninPending);
  const cancel = useBrowserStore((s) => s.cancelSigninPending);

  return (
    <div className="border-b border-accent-blue/40 bg-accent-blue/10 px-3 py-2.5 text-[12px] text-fg-primary shrink-0 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icons.UserCheck className="w-4 h-4 text-accent-blue shrink-0" />
        <span className="font-semibold">
          An agent is waiting to use <span className="font-mono">{origin}</span> — sign in to
          continue
        </span>
      </div>
      <div className="text-[11px] text-fg-muted pl-6">
        A login tab is open for this site. Sign in there, then click “Done signing in” to let the
        waiting agent continue on your session.
      </div>
      <div className="flex items-center gap-2 pl-6">
        <button
          onClick={() => void complete()}
          className="ui-btn px-3 py-1 text-[11px] font-semibold bg-accent-blue text-white border border-accent-blue hover:bg-accent-blue/90"
        >
          <Icons.Check className="w-3.5 h-3.5" />
          Done signing in
        </button>
        <button
          onClick={() => void cancel()}
          className="ui-btn ui-btn-ghost px-3 py-1 text-[11px]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function SigninHandoffBanner() {
  const handoff = useBrowserStore((s) => s.signinHandoff);
  const error = useBrowserStore((s) => s.signinHandoffError);
  const done = useBrowserStore((s) => s.signinHandoffDone);
  const complete = useBrowserStore((s) => s.completeSigninHandoff);
  const cancel = useBrowserStore((s) => s.cancelSigninHandoff);
  const signinPending = useBrowserStore((s) => s.signinPending);

  // The JIT reminder banner is independent of the Mechanism-B consent flow; it
  // can coexist with the success flash, so render it alongside.
  const jit = signinPending ? <JitSigninBanner origin={signinPending.origin} /> : null;

  // The success flash only shows once the consent banner is gone.
  if (!handoff) {
    return (
      <>
        {jit}
        {done ? <HandoffSuccess hostname={done.hostname} /> : null}
      </>
    );
  }

  return (
    <>
      {jit}
      <div className="border-b border-accent-orange/40 bg-accent-orange/10 px-3 py-2.5 text-[12px] text-fg-primary shrink-0 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icons.KeyRound className="w-4 h-4 text-accent-orange shrink-0" />
        <span className="font-semibold">
          Sign in to <span className="font-mono">{handoff.hostname}</span> for the agent
        </span>
        {/* Quarantine badge — the visible login tab is fully agent-isolated while
            the human types credentials (ALL agent tools denied against it). */}
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-accent-orange/15 text-accent-orange"
          title="The agent is blocked from reading or acting on this login tab until you hand it over."
        >
          <Icons.Lock className="w-3 h-3" />
          Human only — agent can't read this
        </span>
      </div>
      <ul className="list-disc pl-8 space-y-0.5 text-[11px] text-fg-secondary">
        <li>After you hand it over, the agent will drive this signed-in session.</li>
        <li>This session is shared by every agent in this workspace.</li>
        <li>It persists across restarts until you sign out or clear the session.</li>
        <li>Don't enter credentials you wouldn't share with this workspace.</li>
      </ul>
      <div className="text-[11px] text-fg-muted pl-8">
        Type your credentials in the login tab above (the agent can't see it), then hand it over.
      </div>
      {error && (
        <div className="flex items-center gap-1.5 pl-8 text-[11px] text-accent-red">
          <Icons.AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      <div className="flex items-center gap-2 pl-8">
        <button
          onClick={() => void complete()}
          className="ui-btn px-3 py-1 text-[11px] font-semibold bg-accent-orange text-white border border-accent-orange hover:bg-accent-orange/90"
        >
          <Icons.LogIn className="w-3.5 h-3.5" />
          Hand to agent
        </button>
        <button onClick={() => cancel()} className="ui-btn ui-btn-ghost px-3 py-1 text-[11px]">
          Cancel hand-off
        </button>
      </div>
      </div>
    </>
  );
}
