import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import type { Plan, PromoteProposalResult, PromotionStatus } from '../../../shared/types';

// WP-P3C′ — the Promote dialog. §P3-GAP: a SUPERVISOR PICKER ONLY — there is NO
// document checklist and NO `selectedDocRelPaths` field anywhere; the plan folder
// the promotion worker scaffolds IS the document set.
//
// Lifecycle (all promotion business logic lives in WP-P3B-core/enrich behind the
// injected `promote` / `promotionStatus` seams — this component only orchestrates
// the UI transitions):
//   picking → (confirm) → promoting → result:
//     • adopted           → surface the plan (onResolved), terminal.
//     • promotion-pending → polling: bounded refetch of `promotionStatus` with
//        backoff, transitioning to the adopted plan when `state==='adopted'` +
//        a plan row surfaces; a `failed` state surfaces the reason; exhausting the
//        bounded attempts lands in `still-promoting` ("planning worker running"),
//        NEVER an infinite poll.
//   Cancel from `picking` mints NOTHING (never calls `promote`).

export interface SupervisorChoice {
  id: string;
  title: string;
}

export interface PromoteDialogProps {
  proposalId: string;
  proposalTitle: string;
  /** Candidate supervisors — already filtered by the caller to privileged,
   *  same-workspace agents. The server independently re-validates on confirm. */
  supervisors: SupervisorChoice[];
  promote: (input: { proposalId: string; supervisorId: string }) => Promise<PromoteProposalResult>;
  promotionStatus: (input: { promotionRequestId: string }) => Promise<PromotionStatus>;
  /** Called once the promotion resolves to an adopted plan. */
  onResolved: (plan: Plan) => void;
  /** Close/cancel the dialog. From the picking phase this mints nothing. */
  onClose: () => void;
  /** Bounded-poll tuning (defaults for prod; overridden in tests). */
  pollMaxAttempts?: number;
  pollBaseDelayMs?: number;
  pollMaxDelayMs?: number;
}

type Phase = 'picking' | 'promoting' | 'polling' | 'adopted' | 'still-promoting' | 'error';

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_BASE_DELAY_MS = 750;
const DEFAULT_MAX_DELAY_MS = 8000;

export default function PromoteDialog({
  proposalId,
  proposalTitle,
  supervisors,
  promote,
  promotionStatus,
  onResolved,
  onClose,
  pollMaxAttempts = DEFAULT_MAX_ATTEMPTS,
  pollBaseDelayMs = DEFAULT_BASE_DELAY_MS,
  pollMaxDelayMs = DEFAULT_MAX_DELAY_MS,
}: PromoteDialogProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>('picking');
  const [supervisorId, setSupervisorId] = useState<string>(supervisors[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);

  // Cancellation latch — set on unmount so an in-flight poll loop stops touching
  // state after the dialog closes.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const sleep = useCallback(
    (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
    [],
  );

  // Bounded, backing-off poll of `promotionStatus` — resolves to the adopted plan,
  // surfaces a failure, or gives up in `still-promoting` after the attempt budget.
  const pollUntilResolved = useCallback(
    async (promotionRequestId: string): Promise<void> => {
      for (let attempt = 0; attempt < pollMaxAttempts; attempt++) {
        if (cancelledRef.current) return;
        let status: PromotionStatus;
        try {
          status = await promotionStatus({ promotionRequestId });
        } catch (err) {
          if (cancelledRef.current) return;
          setError(err instanceof Error ? err.message : 'Could not read promotion status');
          setPhase('error');
          return;
        }
        if (cancelledRef.current) return;
        if (status.state === 'adopted' && status.plan) {
          onResolved(status.plan);
          setPhase('adopted');
          return;
        }
        if (status.state === 'failed') {
          setError(status.failureReason ?? 'Promotion failed');
          setPhase('error');
          return;
        }
        // Still pending (or adopted-without-a-row-yet) → back off and retry, unless
        // this was the last attempt.
        if (attempt < pollMaxAttempts - 1) {
          const delay = Math.min(pollBaseDelayMs * 2 ** attempt, pollMaxDelayMs);
          await sleep(delay);
        }
      }
      if (cancelledRef.current) return;
      // Budget exhausted — the planning worker is still running; never loop forever.
      setPhase('still-promoting');
    },
    [promotionStatus, onResolved, pollMaxAttempts, pollBaseDelayMs, pollMaxDelayMs, sleep],
  );

  const onConfirm = useCallback(async () => {
    if (!supervisorId) return;
    setError(null);
    setPhase('promoting');
    let result: PromoteProposalResult;
    try {
      result = await promote({ proposalId, supervisorId });
    } catch (err) {
      if (cancelledRef.current) return;
      setError(err instanceof Error ? err.message : 'Could not promote this proposal');
      setPhase('error');
      return;
    }
    if (cancelledRef.current) return;
    if (result.status === 'adopted') {
      onResolved(result.plan);
      setPhase('adopted');
      return;
    }
    // promotion-pending → resolve through the concrete status poll.
    setPhase('polling');
    await pollUntilResolved(result.promotionRequestId);
  }, [supervisorId, promote, proposalId, onResolved, pollUntilResolved]);

  const busy = phase === 'promoting' || phase === 'polling';
  const noSupervisors = supervisors.length === 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="promote-dialog"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-[420px] max-w-[92vw] rounded-lg border border-white/10 bg-surface-1 p-4 shadow-2xl">
        <div className="mb-3 flex items-center gap-2">
          <Icons.ArrowUpCircle className="h-4 w-4 text-accent-blue" />
          <span className="text-[13px] font-semibold text-gray-100">Promote proposal</span>
          <button
            onClick={onClose}
            className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-100"
            data-testid="promote-close"
            title="Close"
          >
            <Icons.X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-3 truncate text-[12px] text-gray-400" title={proposalTitle}>
          {proposalTitle}
        </p>

        {phase === 'picking' && (
          <div data-testid="promote-picking">
            {noSupervisors ? (
              <div className="rounded bg-surface-2 px-3 py-2 text-[12px] text-gray-400" data-testid="promote-no-supervisors">
                No eligible supervisor in this workspace. Launch or designate a supervisor to promote.
              </div>
            ) : (
              <label className="block">
                <span className="mb-1 block text-[11px] uppercase tracking-wide text-gray-500">
                  Responsible supervisor
                </span>
                <select
                  className="w-full rounded border border-white/10 bg-surface-0 px-2 py-1.5 text-[12px] text-gray-200"
                  value={supervisorId}
                  onChange={(e) => setSupervisorId(e.target.value)}
                  data-testid="promote-supervisor-select"
                >
                  {supervisors.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        {phase === 'promoting' && (
          <div className="flex items-center gap-2 text-[12px] text-gray-300" data-testid="promote-promoting">
            <Icons.Loader2 className="h-4 w-4 animate-spin" />
            Promoting…
          </div>
        )}

        {phase === 'polling' && (
          <div className="flex items-center gap-2 text-[12px] text-gray-300" data-testid="promote-pending">
            <Icons.Loader2 className="h-4 w-4 animate-spin" />
            Promotion in progress — waiting for the plan to be adopted…
          </div>
        )}

        {phase === 'adopted' && (
          <div className="flex items-center gap-2 text-[12px] text-accent-green" data-testid="promote-adopted">
            <Icons.CheckCircle2 className="h-4 w-4" />
            Plan adopted.
          </div>
        )}

        {phase === 'still-promoting' && (
          <div className="rounded bg-surface-2 px-3 py-2 text-[12px] text-gray-300" data-testid="promote-still-promoting">
            Still promoting — the planning worker is running. This dialog can be closed;
            the plan will appear in the gallery when it is adopted.
          </div>
        )}

        {phase === 'error' && (
          <div className="rounded bg-accent-red/15 px-3 py-2 text-[12px] text-accent-red" data-testid="promote-error">
            {error ?? 'Promotion failed.'}
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-1 text-[12px] text-gray-300 hover:bg-white/10 disabled:opacity-50"
            data-testid="promote-cancel"
          >
            {phase === 'adopted' || phase === 'still-promoting' || phase === 'error' ? 'Close' : 'Cancel'}
          </button>
          {phase === 'picking' && (
            <button
              onClick={onConfirm}
              disabled={noSupervisors || !supervisorId}
              className="rounded bg-accent-blue px-3 py-1 text-[12px] font-medium text-white hover:bg-accent-blue/90 disabled:opacity-50"
              data-testid="promote-confirm"
            >
              Promote
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
