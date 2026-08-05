import React from 'react';
import * as Icons from 'lucide-react';
import { useDashboardStore } from '../../stores/dashboard-store';
import PrerequisiteRow from './PrerequisiteRow';
import GitInitConsent from './GitInitConsent';

/** First-run prerequisite report (packaging plan §6.3).
 *
 *  This dialog exists because of one concrete failure: someone installed Lares,
 *  had no agent CLI, and got an app where "Launch Agent" did nothing legible.
 *  Everything about the copy here is aimed at that person.
 *
 *  Three rules the copy must keep:
 *  1. Launchable providers are listed independently and the lead says "at
 *     least one". Nothing may imply every CLI is needed.
 *  2. Git, Python and an external Node sit under "Optional" with an explicit
 *     "none of these stop Lares from working" note. A missing Git must never
 *     read as "the app is incomplete".
 *  3. Nothing here blocks opening Lares. The only buttons out are Recheck and
 *     Continue — there is no state in which this dialog traps the user. */
export default function RuntimePrerequisitesDialog() {
  const open = useDashboardStore((s) => s.prerequisitesDialogOpen);
  const report = useDashboardStore((s) => s.prerequisites);
  const checking = useDashboardStore((s) => s.prerequisitesChecking);
  const close = useDashboardStore((s) => s.closePrerequisitesDialog);
  const loadPrerequisites = useDashboardStore((s) => s.loadPrerequisites);
  const checkHealth = useDashboardStore((s) => s.checkHealth);

  if (!open) return null;

  const openDocs = (url: string) => { void window.api.system.openExternal(url); };
  const recheck = () => {
    // force:true — the point of Recheck is that the user just installed
    // something, so the cached answer is exactly the wrong one to serve.
    void loadPrerequisites(true).then(() => checkHealth());
  };

  const ok = report?.anyProviderAvailable ?? false;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 app-no-drag p-6">
      <div className="ui-card w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="p-5 pb-3 shrink-0">
          <h2 className="text-[15px] font-semibold text-gray-100 flex items-center gap-2">
            {ok ? (
              <Icons.CheckCircle2 className="w-4 h-4 text-accent-green" />
            ) : (
              <Icons.Info className="w-4 h-4 text-accent-blue" />
            )}
            {ok ? 'Lares is ready' : 'Lares is installed'}
          </h2>
          <p className="text-[13px] text-gray-400 mt-1.5">
            {ok
              ? 'At least one agent CLI is installed, so you can launch agents. The full report is below.'
              : 'To launch agents, install at least one supported agent CLI. Lares runs these tools on your behalf — they are separate programs and cannot be bundled with the app.'}
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5">
          {!report ? (
            <p className="text-[13px] text-gray-500 py-6 text-center">Checking…</p>
          ) : (
            <>
              <section className="mb-4">
                <h3 className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                  Agent CLIs — you need at least one
                </h3>
                {report.providers.map((c) => (
                  <PrerequisiteRow key={c.id} check={c} onOpenDocs={openDocs} />
                ))}
              </section>

              <section className="mb-4">
                <h3 className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                  Optional — feature-dependent
                </h3>
                <p className="text-[12px] text-gray-500 mb-1">
                  None of these are required. Lares opens ordinary folders as workspaces without
                  them, and it ships the JavaScript runtime its own helpers need — but an agent
                  CLI, a hook, a notebook or a workspace script may want one.
                </p>
                {report.optional.map((c) => (
                  <PrerequisiteRow key={c.id} check={c} onOpenDocs={openDocs} />
                ))}
                {/* WP-G3.4 — human-only consent action to enable Git checkpoints on
                    a non-repo workspace. Renders only when git is usable + a
                    workspace is selected; the main process refuses honestly when the
                    workspace is already a repository. */}
                <GitInitConsent />
              </section>

              <section className="mb-4">
                <h3 className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                  WSL — only for WSL-backed workspaces
                </h3>
                <p className="text-[12px] text-gray-500 mb-1">
                  Windows-native workspaces work without WSL. WSL plus tmux is what enables
                  persistent WSL-backed terminals that survive closing the pane.
                  {!report.wslChecked && ' Not checked, because you have no WSL workspace.'}
                </p>
                {report.wsl.map((c) => (
                  <PrerequisiteRow key={c.id} check={c} onOpenDocs={openDocs} />
                ))}
              </section>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-5 pt-3 shrink-0 flex items-center gap-2 border-t border-white/5">
          <button onClick={recheck} disabled={checking} className="ui-btn px-3 py-1.5 text-[13px] disabled:opacity-50">
            <Icons.RefreshCw className={`w-3.5 h-3.5 inline mr-1.5 ${checking ? 'animate-spin' : ''}`} />
            Recheck
          </button>
          <div className="flex-1" />
          {report && (
            <span className="text-[11px] text-gray-600">Lares {report.appVersion}</span>
          )}
          <button onClick={close} className="ui-btn ui-btn-primary px-3 py-1.5 text-[13px]">
            {ok ? 'Close' : 'Continue without agents'}
          </button>
        </div>
      </div>
    </div>
  );
}
