import React from 'react';
import * as Icons from 'lucide-react';
import { useDashboardStore } from '../../stores/dashboard-store';

/** The non-modal half of the display policy (packaging plan §6.3).
 *
 *  The modal shows once per app version — re-nagging someone who chose
 *  "Continue without agents" is a worse failure than under-informing them. But
 *  "shown once" must not mean "gone forever", or the user is back to an app
 *  that silently cannot launch anything. So while NO provider is available a
 *  quiet card sits in the UI. Dismissing it hides it for this session only
 *  (the store deliberately does not persist that), and Help ▸ Check
 *  prerequisites always reopens the full report. */
export default function PrerequisitesCard() {
  const report = useDashboardStore((s) => s.prerequisites);
  const dismissed = useDashboardStore((s) => s.prerequisitesCardDismissed);
  const dialogOpen = useDashboardStore((s) => s.prerequisitesDialogOpen);
  const dismiss = useDashboardStore((s) => s.dismissPrerequisitesCard);
  const openDialog = useDashboardStore((s) => s.openPrerequisitesDialog);

  // Only while there is a real problem, and never doubled up with the modal.
  if (!report || report.anyProviderAvailable || dismissed || dialogOpen) return null;

  return (
    <div className="mx-3 mt-3 rounded-lg border border-accent-orange/30 bg-accent-orange/5 px-3 py-2.5 flex items-start gap-2.5">
      <Icons.AlertTriangle className="w-4 h-4 text-accent-orange shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-gray-200">
          No agent CLI found — Lares can’t launch agents yet.
        </p>
        <p className="text-[12px] text-gray-400 mt-0.5">
          Install Claude Code, Codex or Gemini (any one of them), then restart Lares.
        </p>
        <button
          onClick={openDialog}
          className="mt-1.5 text-[12px] text-accent-blue hover:underline"
        >
          Show me what to install
        </button>
      </div>
      <button
        onClick={dismiss}
        title="Dismiss (reopen from Help ▸ Check prerequisites)"
        aria-label="Dismiss"
        className="shrink-0 p-1 rounded text-gray-500 hover:text-gray-300 hover:bg-white/5"
      >
        <Icons.X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
