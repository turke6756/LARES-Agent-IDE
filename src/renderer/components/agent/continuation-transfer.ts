import type { AgentStatus } from '../../../shared/types';

// Derivation of "which agents are mid context-brick continuation transfer" from
// the statusChanged stream. A supervisor/worker whose session is being handed to
// a successor emits `status: 'restarting', source: 'continuation'` at transfer
// START; the transfer ENDS on that same agent's next status change (successor
// flips to launching/working, or 'crashed' on a failed swap). Kept as pure
// functions so the reducer is unit-testable independent of the store/React.

/** The minimal slice of a statusChanged signal the transfer tracker reads.
 *  `source` distinguishes a continuation restart from an ordinary auto-restart —
 *  both surface as status 'restarting'. */
export interface TransferStatusSignal {
  agentId: string;
  status: AgentStatus;
  source?: string;
}

/** True only for the START of a context-brick continuation transfer. Ordinary
 *  restarts (`source: 'restart'`) and every other status are NOT a start, so
 *  they never light the gold border. */
export function isContinuationTransferStart(sig: TransferStatusSignal): boolean {
  return sig.status === 'restarting' && sig.source === 'continuation';
}

/** Fold one statusChanged signal into the set of agent ids showing the gold
 *  transfer border. A continuation 'restarting' adds the agent; any other status
 *  change for a tracked agent (successor → launching/working, or 'crashed' on a
 *  failed swap) removes it. Returns the SAME Set reference when nothing changed
 *  so callers can skip redundant state writes. */
export function nextTransferSet(
  current: ReadonlySet<string>,
  sig: TransferStatusSignal,
): Set<string> {
  const has = current.has(sig.agentId);
  if (isContinuationTransferStart(sig)) {
    if (has) return current as Set<string>;
    const next = new Set(current);
    next.add(sig.agentId);
    return next;
  }
  // Any non-continuation status change for a tracked agent ends its transfer.
  if (!has) return current as Set<string>;
  const next = new Set(current);
  next.delete(sig.agentId);
  return next;
}

/** Missed-event safety: reconcile the transfer set against an authoritative
 *  agent list (a full refresh). Any tracked agent that is absent from the list,
 *  or is present but no longer 'restarting', has its flag cleared — so a dropped
 *  transfer-end event can't strand the gold border forever. Returns the SAME Set
 *  reference when nothing changed. */
export function reconcileTransferSet(
  current: ReadonlySet<string>,
  agents: ReadonlyArray<{ id: string; status: AgentStatus }>,
): Set<string> {
  if (current.size === 0) return current as Set<string>;
  const statusById = new Map(agents.map((a) => [a.id, a.status]));
  let next: Set<string> | null = null;
  for (const id of current) {
    // Still legitimately transferring only while status is 'restarting'.
    if (statusById.get(id) !== 'restarting') {
      if (!next) next = new Set(current);
      next.delete(id);
    }
  }
  return next ?? (current as Set<string>);
}
