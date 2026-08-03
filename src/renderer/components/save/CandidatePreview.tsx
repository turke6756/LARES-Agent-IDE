import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { SaveCardPreviewRequest, SaveCardPreviewResponse } from '../../../shared/types';
import type {
  CandidateMember,
  CommitEligibility,
  PackageVerificationState,
} from '../../../shared/commit-candidates';

// SC-WP-3H — Save-lens candidate preview pane.
//
// Renders the WP-3G `CommitCandidate` / `SelectionPreview` the main process
// assembled for one explicit selection: per-member verification verdicts, the
// overlap / unattributed acknowledgement checkboxes, an EDITABLE commit-message
// body, and the server-derived READ-ONLY `Lares-*` trailer previews. A user may
// add their own trailers in a SEPARATE namespace that can never override a
// `Lares-*` line. There is NO one-click save path for mismatch / degraded /
// unfinalized work — the primary Save button is gated on server eligibility AND
// the acknowledgements. This pane is read-only against the repository; no writer
// exists yet (the CommitCoordinator is a later stage).

export interface CandidatePreviewSelection {
  selectedComponentIds: string[];
  selectedUnattributedEntryIds: string[];
  finalizationIds: string[];
}

export interface CandidatePreviewProps {
  workspaceId: string;
  selection: CandidatePreviewSelection;
  title?: string;
  onClose?: () => void;
  /** Optional one-click commit hook. Invoked ONLY when the candidate is fully
   *  eligible and every acknowledgement is satisfied. Absent ⇒ the enabled Save
   *  button is inert (no CommitCoordinator is wired in this stage). */
  onCommit?: (response: SaveCardPreviewResponse, messageBody: string) => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; response: SaveCardPreviewResponse };

const VERDICT_LABEL: Record<PackageVerificationState, string> = {
  'verified-match': 'Verified',
  'verified-mismatch': 'Held — changed since done',
  'package-not-finalized': 'Not finalized',
  'final-checkpoint-unavailable': 'Checkpoint unavailable',
  'unsupported-entry': 'Unsupported',
};

// Human, honest one-liners for why a candidate cannot be one-click saved. Never
// claims safety — it names the exact blocking state from the server verdict.
const REASON_LABEL: Record<Extract<CommitEligibility, { eligible: false }>['reason'], string> = {
  'byte-mismatch': 'Disk no longer matches the reviewed snapshot — look before saving.',
  'package-not-finalized': 'This work is not finalized yet — preview only, nothing to commit.',
  'checkpoint-unavailable': 'A final checkpoint for this package is unavailable.',
  'finalization-conflict': 'Two finalizations disagree on this work — cannot save.',
  'component-subset-not-allowed': 'A whole work component must be saved together — not a subset.',
  'extraneous-finalization': 'A requested finalization covers none of this selection.',
  'unattributed-not-acknowledged': 'Acknowledge the unattributed changes to continue.',
  'overlap-not-acknowledged': 'Acknowledge the overlapping work to continue.',
  'compose-in-flight': 'Another save is in flight for this repository — try again shortly.',
  'unsupported-git-state': 'This selection includes git state Lares cannot safely commit.',
};

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'The Save preview could not be assembled.';
}

// A user trailer line that begins with `Lares-` would collide with the
// server-authoritative namespace; the renderer refuses it outright (it can never
// override a server `Lares-*` trailer — contract §4.2 / WP-3H).
function firstReservedTrailerLine(userTrailers: string): string | null {
  for (const raw of userTrailers.split('\n')) {
    const line = raw.trim();
    if (line && /^lares-/i.test(line)) return line;
  }
  return null;
}

export default function CandidatePreview({
  workspaceId,
  selection,
  title,
  onClose,
  onCommit,
}: CandidatePreviewProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [messageBody, setMessageBody] = useState('');
  const [userTrailers, setUserTrailers] = useState('');
  const [overlapAck, setOverlapAck] = useState(false);
  const [unattributedAcks, setUnattributedAcks] = useState<Set<string>>(new Set());

  const request: SaveCardPreviewRequest = useMemo(
    () => ({
      workspaceId,
      selectedComponentIds: selection.selectedComponentIds,
      selectedUnattributedEntryIds: selection.selectedUnattributedEntryIds,
      finalizationIds: selection.finalizationIds,
    }),
    [
      workspaceId,
      selection.selectedComponentIds,
      selection.selectedUnattributedEntryIds,
      selection.finalizationIds,
    ],
  );

  const load = useCallback(
    async (isCurrent: () => boolean) => {
      setState({ status: 'loading' });
      try {
        const response = await window.api.saveCard.preview(request);
        if (!isCurrent()) return;
        setState({ status: 'ready', response });
        setMessageBody(response.defaultMessageBody);
        setOverlapAck(false);
        setUnattributedAcks(new Set());
      } catch (err) {
        if (isCurrent()) setState({ status: 'error', message: errorMessage(err) });
      }
    },
    [request],
  );

  useEffect(() => {
    let active = true;
    void load(() => active);
    return () => {
      active = false;
    };
  }, [load]);

  if (state.status === 'loading') {
    return (
      <div className="sc-preview" data-testid="candidate-preview">
        <div data-testid="candidate-preview-loading">Assembling save preview…</div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="sc-preview" data-testid="candidate-preview">
        <div className="sc-state-error" data-testid="candidate-preview-error">
          <div className="sc-state-title">Save preview unavailable</div>
          <div className="sc-state-body">{state.message}</div>
        </div>
        {onClose && (
          <button type="button" className="ui-btn ui-btn-outline px-3 py-1 text-[12.5px]" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    );
  }

  const { response } = state;
  const { candidate } = response;
  const eligible = candidate.eligibility.eligible === true;
  const reservedTrailer = firstReservedTrailerLine(userTrailers);
  const overlapSatisfied = !response.requiresOverlapAck || overlapAck;
  const unattributedSatisfied = response.unacknowledgedUnattributedEntryIds.every((id) =>
    unattributedAcks.has(id),
  );
  const acksSatisfied = overlapSatisfied && unattributedSatisfied;
  // One-click save is allowed ONLY for a finalization-backed candidate that the
  // server declared eligible, with every acknowledgement satisfied and no reserved
  // user trailer. Mismatch / degraded / unfinalized work is previewable, never
  // one-click.
  const canSave = response.isCandidate && eligible && acksSatisfied && !reservedTrailer;

  const toggleUnattributed = (entryId: string) => {
    setUnattributedAcks((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  return (
    <div className="sc-preview" data-testid="candidate-preview" data-eligible={String(eligible)}>
      {title && <h3 className="sc-preview-title">{title}</h3>}

      {/* Verdict banner — honest state, never a safety claim. */}
      <div
        className={`sc-preview-verdict${eligible ? ' sc-preview-ok' : ' sc-preview-bad'}`}
        data-testid="candidate-preview-verdict"
        data-eligible={String(eligible)}
      >
        {eligible ? (
          <span>Disk matches this package byte-for-byte. Saving commits exactly the reviewed work.</span>
        ) : (
          <span>{REASON_LABEL[candidate.eligibility.reason]}</span>
        )}
      </div>

      {/* Per-member verification verdicts. */}
      <ul className="sc-preview-members" data-testid="candidate-preview-members">
        {candidate.members.map((member: CandidateMember) => (
          <li
            key={member.entryId}
            className="sc-preview-member"
            data-testid="candidate-member"
            data-verdict={member.packageVerification}
          >
            <span className="sc-preview-verdict-badge">{VERDICT_LABEL[member.packageVerification]}</span>
            <span className="sc-preview-path">{member.path.displayPath}</span>
          </li>
        ))}
      </ul>

      {/* Acknowledgements — must be satisfied before a one-click save. */}
      {response.requiresOverlapAck && (
        <label className="sc-preview-ack" data-testid="candidate-preview-overlap-ack">
          <input
            type="checkbox"
            checked={overlapAck}
            onChange={(e) => setOverlapAck(e.target.checked)}
          />
          <span>This package fuses work from multiple agents or plans — I acknowledge the overlap.</span>
        </label>
      )}
      {response.unacknowledgedUnattributedEntryIds.map((entryId) => (
        <label
          key={entryId}
          className="sc-preview-ack"
          data-testid="candidate-preview-unattributed-ack"
          data-entry-id={entryId}
        >
          <input
            type="checkbox"
            checked={unattributedAcks.has(entryId)}
            onChange={() => toggleUnattributed(entryId)}
          />
          <span>Include unattributed change {entryId} — I acknowledge no agent was seen touching it.</span>
        </label>
      ))}

      {/* Editable commit-message body. */}
      <label className="sc-preview-msg-label" htmlFor="candidate-preview-message">
        Commit message
      </label>
      <textarea
        id="candidate-preview-message"
        className="sc-preview-msg"
        data-testid="candidate-preview-message"
        value={messageBody}
        onChange={(e) => setMessageBody(e.target.value)}
        rows={3}
      />

      {/* READ-ONLY server-derived Lares-* trailers. */}
      <div className="sc-preview-trailers" data-testid="candidate-preview-trailers">
        <div className="sc-preview-trailers-head">Trailers (added automatically — read-only)</div>
        {response.laresTrailers.length === 0 ? (
          <div className="sc-preview-trailer" data-testid="candidate-preview-trailer">
            No Lares trailers for this selection.
          </div>
        ) : (
          response.laresTrailers.map((trailer) => (
            <div key={trailer} className="sc-preview-trailer" data-testid="candidate-preview-trailer">
              {trailer}
            </div>
          ))
        )}
      </div>

      {/* User trailers — a SEPARATE namespace that can never override Lares-*. */}
      <label className="sc-preview-msg-label" htmlFor="candidate-preview-user-trailers">
        Your trailers (optional)
      </label>
      <textarea
        id="candidate-preview-user-trailers"
        className="sc-preview-user-trailers"
        data-testid="candidate-preview-user-trailers"
        value={userTrailers}
        onChange={(e) => setUserTrailers(e.target.value)}
        rows={2}
        placeholder="e.g. Co-authored-by: …"
      />
      {reservedTrailer && (
        <div className="sc-preview-trailer-error" data-testid="candidate-preview-user-trailers-error">
          "{reservedTrailer}" uses the reserved Lares- namespace and will be ignored — it can never
          override an automatic trailer.
        </div>
      )}

      <div className="sc-actions">
        <button
          type="button"
          className="ui-btn ui-btn-primary px-3 py-1 text-[12.5px]"
          data-testid="candidate-preview-save"
          disabled={!canSave}
          onClick={() => {
            if (canSave) onCommit?.(response, messageBody);
          }}
        >
          {response.isCandidate ? `Save — commit ${candidate.members.length} file${candidate.members.length === 1 ? '' : 's'}` : 'Save'}
        </button>
        {!canSave && !reservedTrailer && (
          <span className="sc-why" data-testid="candidate-preview-why">
            {!response.isCandidate || !eligible
              ? (candidate.eligibility.eligible === false
                  ? REASON_LABEL[candidate.eligibility.reason]
                  : 'Preview only — not finalized.')
              : 'Acknowledge the highlighted items to save.'}
          </span>
        )}
        {onClose && (
          <button
            type="button"
            className="ui-btn ui-btn-outline px-3 py-1 text-[12.5px]"
            data-testid="candidate-preview-close"
            onClick={onClose}
          >
            Close
          </button>
        )}
      </div>
    </div>
  );
}
