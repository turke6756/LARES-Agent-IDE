import React from 'react';
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
// The hostname renders as plain escaped text (a text child) — never as markup
// or a link.
export default function SigninHandoffBanner() {
  const handoff = useBrowserStore((s) => s.signinHandoff);
  const error = useBrowserStore((s) => s.signinHandoffError);
  const complete = useBrowserStore((s) => s.completeSigninHandoff);
  const cancel = useBrowserStore((s) => s.cancelSigninHandoff);

  if (!handoff) return null;

  return (
    <div className="border-b border-accent-orange/40 bg-accent-orange/10 px-3 py-2.5 text-[12px] text-fg-primary shrink-0 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icons.KeyRound className="w-4 h-4 text-accent-orange shrink-0" />
        <span className="font-semibold">
          Sign in to <span className="font-mono">{handoff.hostname}</span> for the agent
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
          Cancel
        </button>
      </div>
    </div>
  );
}
