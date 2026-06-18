import React, { useEffect } from 'react';
import { useBrowserStore } from '../../stores/browser-store';
import * as Icons from 'lucide-react';

// M12 coarse act-tier gate, flipped from the browser chrome instead of
// relaunching with AGENT_BROWSER_ACTIONS=1. Dashboard-GLOBAL (not per-agent):
// when ON, any agent's act-tier verbs (openUrl/click/type/…) may drive THIS
// dashboard's agent-partition browser; read-only tools work either way. The
// flag is a runtime, non-persisted mirror of the main-process gate — it resets
// to its launch default (env-seeded, default OFF) on every restart. Rendering
// this in trusted shell chrome (not page/model output) is by design.
export default function AgentActionsToggle() {
  const enabled = useBrowserStore((s) => s.actionsEnabled);
  const loadActionsEnabled = useBrowserStore((s) => s.loadActionsEnabled);
  const setActionsEnabled = useBrowserStore((s) => s.setActionsEnabled);

  useEffect(() => {
    void loadActionsEnabled();
  }, [loadActionsEnabled]);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="Agent browser actions"
      onClick={() => void setActionsEnabled(!enabled)}
      className="ui-btn ui-btn-ghost flex items-center gap-1.5 px-1.5 py-1 shrink-0"
      title={
        'Agent actions (dashboard-global, coarse M12 gate). When ON, agents can ' +
        "drive THIS dashboard's browser — open URLs, click, type — on the agent " +
        'partition. When OFF, those act-tools are blocked; read-only tools ' +
        '(read page, screenshot) work regardless. Not per-agent. Resets to its ' +
        'launch default each restart.'
      }
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
  );
}
