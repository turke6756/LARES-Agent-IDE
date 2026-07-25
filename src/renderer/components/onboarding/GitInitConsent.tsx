import React, { useState } from 'react';
import * as Icons from 'lucide-react';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { GitInitResult } from '../../../shared/types';

/** WP-G3.4 — the human-only `git init` consent affordance.
 *
 *  A non-repo workspace has checkpoints honestly disabled: Lares never creates a
 *  `.git` behind the user's back. This is the ONE place a human can opt in — an
 *  explicit click that runs `git init` at the workspace root and turns checkpoints
 *  on. Everything here follows from that:
 *
 *  - It says PLAINLY what will happen before anything runs (creates a Git
 *    repository at the workspace root; enables checkpoints). No silent action.
 *  - It requires the click. There is no auto-run, no "enabled by default".
 *  - It reports the outcome honestly — success, an already-a-repo no-op, or a
 *    failure — from the main-process result, never an optimistic guess.
 *
 *  Visibility is gated on git being usable at all (the `git` prerequisite row is
 *  `available`) and a workspace being selected; the main process is the source of
 *  truth for whether that workspace is actually a non-repo, and refuses honestly
 *  when it is already a repository. */
export default function GitInitConsent() {
  const report = useDashboardStore((s) => s.prerequisites);
  const workspaces = useDashboardStore((s) => s.workspaces);
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const loadPrerequisites = useDashboardStore((s) => s.loadPrerequisites);
  const checkHealth = useDashboardStore((s) => s.checkHealth);

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<GitInitResult | null>(null);

  const gitCheck = report?.optional.find((c) => c.id === 'git');
  const workspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;

  // No usable git → the prerequisite row above already explains why; there is
  // nothing to consent to. No selected workspace → nothing to act on.
  if (!gitCheck || gitCheck.status !== 'available' || !workspace) return null;

  const enable = async () => {
    if (running) return;
    setRunning(true);
    try {
      const res = await window.api.checkpoints.gitInit(workspace.id);
      setResult(res);
      if (res.ok) {
        // The repo now exists: re-probe so the prerequisite/status UI reflects it.
        await loadPrerequisites(true);
        await checkHealth();
      }
    } catch (err) {
      setResult({
        ok: false,
        status: 'error',
        message: 'Enabling checkpoints failed unexpectedly. Nothing was created.',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      className="mt-2 rounded-lg border border-white/10 bg-surface-0/40 px-3 py-2.5"
      data-testid="git-init-consent"
    >
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-gray-200">
        <Icons.GitBranchPlus className="w-3.5 h-3.5 text-accent-blue" />
        Git checkpoints for “{workspace.name}”
      </div>
      <p className="mt-1 text-[12px] text-gray-400">
        Checkpoints need a Git repository at the workspace root. If this workspace isn’t a
        repository yet, enabling checkpoints runs <code className="font-mono text-[11px]">git init</code> to{' '}
        <strong className="text-gray-300">create a Git repository at the workspace root</strong> and{' '}
        <strong className="text-gray-300">turn on checkpoints</strong>. Nothing is created until you click.
      </p>

      {result && (
        <p
          className={`mt-1.5 text-[12px] ${result.ok ? 'text-accent-green' : 'text-accent-orange'}`}
          data-testid="git-init-result"
          role="status"
        >
          {result.message}
          {result.detail && (
            <span className="block mt-0.5 text-[11px] text-gray-600 font-mono break-words">
              {result.detail}
            </span>
          )}
        </p>
      )}

      {!result?.ok && (
        <button
          onClick={enable}
          disabled={running}
          className="mt-2 ui-btn ui-btn-primary px-3 py-1.5 text-[12px] disabled:opacity-50"
          data-testid="git-init-enable"
        >
          {running ? (
            <>
              <Icons.Loader2 className="w-3.5 h-3.5 inline mr-1.5 animate-spin" />
              Enabling…
            </>
          ) : (
            'Enable checkpoints (git init)'
          )}
        </button>
      )}
    </div>
  );
}
