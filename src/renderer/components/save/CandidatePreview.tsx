import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SaveCardPreviewRequest, SaveCardPreviewResponse } from '../../../shared/types';
import type {
  CandidateMember,
  CommitEligibility,
  PackageVerificationState,
  ReviewChallengeAtom,
  CrossIntentChallengeAtom,
  CrossIntentResolution,
} from '../../../shared/commit-candidates';
import { renderSaveRefusal } from './save-refusal-copy';

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
  onCommit?: (
    response: SaveCardPreviewResponse,
    messageBody: string,
    acknowledgedUnattributedEntryIds: string[],
    draft: CandidatePreviewDraft,
  ) => void | Promise<void>;
  /** SaveCard's decisive gesture lives outside this optional detail pane. Plan
   * keeps the original in-pane action by default. */
  showCommitAction?: boolean;
  onDraftChange?: (draft: CandidatePreviewDraft) => void;
  /** An authoritative submit-time response installed without another fetch. */
  authoritativeResponse?: SaveCardPreviewResponse | null;
  /** Lets the package checkbox mirror preview/verification work in place. */
  onBusyChange?: (busy: boolean) => void;
  /** Main-owned persistence seam. A restore choice is a request to supervisor
   * authority; CandidatePreview never mutates repository bytes itself. */
  onCrossIntentResolution?: (
    atom: CrossIntentChallengeAtom,
    resolution: CrossIntentResolution,
  ) => void | Promise<void>;
}

export interface CandidatePreviewDraft {
  response: SaveCardPreviewResponse;
  /** Main-issued review identity. The renderer echoes it; it never computes or
   * compares semantic equivalence. */
  reviewedManifestDigest: string | null;
  durableFinalizationIntent: NonNullable<SaveCardPreviewResponse['durableFinalizationIntent']>;
  /** Exact challenge evidence acknowledged by the human. Both atom id and digest
   * are retained, so a changed atom resets without disturbing unchanged atoms. */
  acknowledgedChallengeAtoms: ReviewChallengeAtom[];
  crossIntentResolutions?: Array<{
    atomId: string;
    evidenceDigest: string;
    resolution: CrossIntentResolution;
  }>;
  previewedCandidateId: string | null;
  componentTopologyDigest: string;
  checkedUnattributedEntryIds: string[];
  overlapAcknowledged: boolean;
  messageBody: string;
  userTrailers: string;
  canSave: boolean;
  reservedTrailer: string | null;
  /** SC-WP-W6 — the unattributed entry ids the human has checked. The submit leg
   *  forwards these to the mint gate as the explicit acknowledgement; the server
   *  never acks unattributed atoms on the human's behalf. */
  acknowledgedUnattributedEntryIds: string[];
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
  'intent-revision-stale': 'This save intent changed since review — preview it again.',
  'resolution-required': 'Resolve every cross-intent lost-update risk before saving.',
  'resolution-stale': 'A cross-intent resolution is stale — review the current evidence.',
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

function challengeAtoms(response: SaveCardPreviewResponse): ReviewChallengeAtom[] {
  return response.reviewedManifest?.challengeAtoms ?? [];
}

function atomKey(atom: Pick<ReviewChallengeAtom, 'atomId' | 'digest'>): string {
  return `${atom.atomId}\0${atom.digest}`;
}

function retainAcknowledgedAtoms(
  acknowledged: readonly ReviewChallengeAtom[],
  response: SaveCardPreviewResponse,
): ReviewChallengeAtom[] {
  const retained = new Set(acknowledged.map(atomKey));
  return challengeAtoms(response).filter((atom) => retained.has(atomKey(atom)));
}

function isAcknowledged(
  acknowledged: readonly ReviewChallengeAtom[],
  atom: ReviewChallengeAtom | undefined,
): boolean {
  return Boolean(atom && acknowledged.some((item) => atomKey(item) === atomKey(atom)));
}

function unattributedAtomForEntry(
  response: SaveCardPreviewResponse,
  entryId: string,
): ReviewChallengeAtom | undefined {
  const pathBytesBase64 = response.candidate.members.find((member) => member.entryId === entryId)
    ?.path.pathBytesBase64;
  return challengeAtoms(response).find((atom) =>
    atom.kind === 'unattributed' && atom.pathBytesBase64 === pathBytesBase64);
}

function crossIntentAtoms(response: SaveCardPreviewResponse): CrossIntentChallengeAtom[] {
  return challengeAtoms(response).filter(
    (atom): atom is CrossIntentChallengeAtom => atom.kind === 'cross-intent',
  );
}

function crossIntentKey(atom: CrossIntentChallengeAtom): string {
  return `${atom.atomId}\0${atom.evidenceDigest}`;
}

function retainCrossResolutions(
  current: Record<string, CrossIntentResolution>,
  response: SaveCardPreviewResponse,
): Record<string, CrossIntentResolution> {
  return Object.fromEntries(crossIntentAtoms(response).flatMap((atom) => {
    const resolution = atom.resolution ?? current[crossIntentKey(atom)];
    return resolution ? [[crossIntentKey(atom), resolution]] : [];
  }));
}

export default function CandidatePreview({
  workspaceId,
  selection,
  title,
  onClose,
  onCommit,
  showCommitAction = true,
  onDraftChange,
  authoritativeResponse,
  onBusyChange,
  onCrossIntentResolution,
}: CandidatePreviewProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [messageBody, setMessageBody] = useState('');
  const [userTrailers, setUserTrailers] = useState('');
  const [acknowledgedAtoms, setAcknowledgedAtoms] = useState<ReviewChallengeAtom[]>([]);
  const [crossResolutions, setCrossResolutions] = useState<Record<string, CrossIntentResolution>>({});
  const [commitBusy, setCommitBusy] = useState(false);
  const commitInFlightRef = useRef(false);

  useEffect(() => {
    onBusyChange?.(state.status === 'loading');
    return () => onBusyChange?.(false);
  }, [state.status, onBusyChange]);

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
        setAcknowledgedAtoms((current) => retainAcknowledgedAtoms(current, response));
        setCrossResolutions((current) => retainCrossResolutions(current, response));
      } catch (err) {
        if (isCurrent()) setState({ status: 'error', message: `Preview verification stage failed unexpectedly: ${errorMessage(err)}` });
      }
    },
    [request],
  );

  useEffect(() => {
    if (authoritativeResponse) return;
    let active = true;
    void load(() => active);
    return () => {
      active = false;
    };
  }, [load, authoritativeResponse]);

  useEffect(() => {
    if (!authoritativeResponse) return;
    setState({ status: 'ready', response: authoritativeResponse });
    setAcknowledgedAtoms((current) => retainAcknowledgedAtoms(current, authoritativeResponse));
    setCrossResolutions((current) => retainCrossResolutions(current, authoritativeResponse));
  }, [authoritativeResponse]);

  useEffect(() => {
    if (state.status !== 'ready' || !onDraftChange) return;
    const response = state.response;
    const eligible = response.candidate.eligibility.eligible === true;
    const reservedTrailer = firstReservedTrailerLine(userTrailers);
    const currentAtoms = challengeAtoms(response);
    const currentOverlapAtoms = currentAtoms.filter((atom) => atom.kind === 'overlap');
    const overlapSatisfied = !response.requiresOverlapAck
      || (currentOverlapAtoms.length > 0
        && currentOverlapAtoms.every((atom) => isAcknowledged(acknowledgedAtoms, atom)));
    const currentCrossAtoms = crossIntentAtoms(response);
    const selectedCrossResolutions = currentCrossAtoms.flatMap((atom) => {
      const resolution = atom.resolution ?? crossResolutions[crossIntentKey(atom)];
      return resolution ? [{ atomId: atom.atomId, evidenceDigest: atom.evidenceDigest, resolution }] : [];
    });
    const crossIntentSatisfied = selectedCrossResolutions.length === currentCrossAtoms.length
      && selectedCrossResolutions.every((item) => item.resolution !== 'restore-lost-work');
    const unattributedSatisfied = currentAtoms
      .filter((atom) => atom.kind === 'unattributed')
      .every((atom) => isAcknowledged(acknowledgedAtoms, atom))
      && response.unacknowledgedUnattributedEntryIds.every((id) =>
        isAcknowledged(acknowledgedAtoms, unattributedAtomForEntry(response, id)));
    const checkedUnattributedEntryIds = response.unacknowledgedUnattributedEntryIds.filter((id) =>
      isAcknowledged(acknowledgedAtoms, unattributedAtomForEntry(response, id)),
    );
    onDraftChange({
      response,
      reviewedManifestDigest: response.reviewedManifest?.reviewedManifestDigest ?? null,
      durableFinalizationIntent: response.durableFinalizationIntent ?? [],
      acknowledgedChallengeAtoms: acknowledgedAtoms,
      crossIntentResolutions: selectedCrossResolutions,
      previewedCandidateId: response.isCandidate && 'candidateId' in response.candidate
        ? response.candidate.candidateId
        : null,
      componentTopologyDigest: response.componentTopologyDigest,
      checkedUnattributedEntryIds,
      overlapAcknowledged: overlapSatisfied,
      messageBody,
      userTrailers,
      canSave: response.isCandidate && eligible && overlapSatisfied && unattributedSatisfied
        && crossIntentSatisfied
        && Boolean(response.reviewedManifest?.reviewedManifestDigest)
        && Boolean(response.durableFinalizationIntent?.length) && !reservedTrailer,
      reservedTrailer,
      acknowledgedUnattributedEntryIds: checkedUnattributedEntryIds,
    });
  }, [state, onDraftChange, messageBody, userTrailers, acknowledgedAtoms, crossResolutions]);

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
  const blockingDriftPaths = [...new Set([
    ...response.selectionDrift.missing,
    ...response.selectionDrift.byteMoved,
    ...response.selectionDrift.reAttributed,
  ])];
  const blockingDriftNames = blockingDriftPaths.map((path) =>
    response.selectionDriftDisplayPaths[path] ?? path);
  const eligible = candidate.eligibility.eligible === true;
  const reservedTrailer = firstReservedTrailerLine(userTrailers);
  const currentAtoms = challengeAtoms(response);
  const overlapAtoms = currentAtoms.filter((atom) => atom.kind === 'overlap');
  const overlapSatisfied = !response.requiresOverlapAck
    || (overlapAtoms.length > 0 && overlapAtoms.every((atom) => isAcknowledged(acknowledgedAtoms, atom)));
  const currentCrossAtoms = crossIntentAtoms(response);
  const selectedCrossResolutions = currentCrossAtoms.flatMap((atom) => {
    const resolution = atom.resolution ?? crossResolutions[crossIntentKey(atom)];
    return resolution ? [{ atomId: atom.atomId, evidenceDigest: atom.evidenceDigest, resolution }] : [];
  });
  const crossIntentSatisfied = selectedCrossResolutions.length === currentCrossAtoms.length
    && selectedCrossResolutions.every((item) => item.resolution !== 'restore-lost-work');
  const unattributedSatisfied = currentAtoms
    .filter((atom) => atom.kind === 'unattributed')
    .every((atom) => isAcknowledged(acknowledgedAtoms, atom))
    && response.unacknowledgedUnattributedEntryIds.every((id) =>
      isAcknowledged(acknowledgedAtoms, unattributedAtomForEntry(response, id)));
  const acksSatisfied = overlapSatisfied && unattributedSatisfied && crossIntentSatisfied;
  // One-click save is allowed ONLY for a finalization-backed candidate that the
  // server declared eligible, with every acknowledgement satisfied and no reserved
  // user trailer. Mismatch / degraded / unfinalized work is previewable, never
  // one-click.
  const canSave = response.isCandidate && eligible && acksSatisfied
    && Boolean(response.reviewedManifest?.reviewedManifestDigest)
    && Boolean(response.durableFinalizationIntent?.length) && !reservedTrailer;

  const setAtomsAcknowledged = (atoms: readonly ReviewChallengeAtom[], checked: boolean) => {
    const keys = new Set(atoms.map(atomKey));
    setAcknowledgedAtoms((previous) => {
      const retained = previous.filter((atom) => !keys.has(atomKey(atom)));
      return checked ? [...retained, ...atoms] : retained;
    });
  };

  const toggleUnattributed = (entryId: string) => {
    const atom = unattributedAtomForEntry(response, entryId);
    if (!atom) return;
    setAtomsAcknowledged([atom], !isAcknowledged(acknowledgedAtoms, atom));
  };

  const resolveCrossIntent = async (
    atom: CrossIntentChallengeAtom,
    resolution: CrossIntentResolution,
  ) => {
    await onCrossIntentResolution?.(atom, resolution);
    setCrossResolutions((current) => ({ ...current, [crossIntentKey(atom)]: resolution }));
  };

  const unattributedRows = response.unacknowledgedUnattributedEntryIds.map((entryId) => ({
    entryId,
    atom: unattributedAtomForEntry(response, entryId),
    displayPath: candidate.members.find((member) => member.entryId === entryId)?.path.displayPath ?? '[unknown path]',
  }));
  const unattributedAtoms = unattributedRows
    .map(({ atom }) => atom)
    .filter((atom): atom is ReviewChallengeAtom => atom !== undefined);
  const allUnattributedAcknowledged = unattributedRows.length > 0
    && unattributedRows.every(({ atom }) => isAcknowledged(acknowledgedAtoms, atom));

  return (
    <div className="sc-preview" data-testid="candidate-preview" data-eligible={String(eligible)}>
      {title && <h3 className="sc-preview-title">{title}</h3>}

      {/* Verdict banner — honest state, never a safety claim. */}
      <div
        className={`sc-preview-verdict${eligible ? ' sc-preview-ok' : ' sc-preview-bad'}`}
        data-testid="candidate-preview-verdict"
        data-eligible={String(eligible)}
      >
        {blockingDriftNames.length > 0 ? (
          <span>
            {blockingDriftNames.length} of {response.pinnedSelection.frozenMemberCount} pinned files changed
            {' — '}re-pin to save current bytes: {blockingDriftNames.join(', ')}.
          </span>
        ) : candidate.eligibility.eligible ? (
          <span>Disk matches this package byte-for-byte. Saving commits exactly the reviewed work.</span>
        ) : (
          <span>{REASON_LABEL[candidate.eligibility.reason]}</span>
        )}
      </div>

      {response.selectionDrift.added.length > 0 && blockingDriftNames.length === 0 && (
        <div className="sc-save-note" data-testid="candidate-preview-added-drift">
          {response.selectionDrift.added.length} unpinned file
          {response.selectionDrift.added.length === 1 ? ' was' : 's were'} added; this save still contains only the{' '}
          {response.pinnedSelection.frozenMemberCount} pinned files.
        </div>
      )}

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
      {currentCrossAtoms.map((atom) => {
        const selected = atom.resolution ?? crossResolutions[crossIntentKey(atom)] ?? null;
        return (
          <fieldset
            key={crossIntentKey(atom)}
            className="sc-preview-cross-intent"
            data-testid="candidate-preview-cross-intent-picker"
            data-path-bytes={atom.pathBytesBase64}
          >
            <legend>Two tasks diverged on {atom.displayPath}</legend>
            <div className="sc-save-note">
              Choose how to preserve the intent history. This decision resets if file or witness evidence changes.
            </div>
            {([
              ['commit-together', 'Commit together'],
              ['superseded-intentionally', 'Superseded intentionally'],
              ['restore-lost-work', 'Work was lost — restore'],
            ] as const).map(([resolution, label]) => (
              <label key={resolution} className="sc-preview-ack">
                <input
                  type="radio"
                  name={`cross-intent-${atom.atomId}`}
                  value={resolution}
                  checked={selected === resolution}
                  onChange={() => { void resolveCrossIntent(atom, resolution); }}
                />
                <span>{label}</span>
              </label>
            ))}
            {selected === 'restore-lost-work' && (
              <div className="sc-save-note" data-testid="candidate-preview-restore-authority-note">
                Restore is sent to supervisor checkpoint authority. This stale preview cannot be saved.
              </div>
            )}
          </fieldset>
        );
      })}
      {response.requiresOverlapAck && (
        <label className="sc-preview-ack" data-testid="candidate-preview-overlap-ack">
          <input
            type="checkbox"
            checked={overlapSatisfied}
            onChange={(e) => setAtomsAcknowledged(overlapAtoms, e.target.checked)}
          />
          <span>This package fuses work from multiple agents or plans — I acknowledge the overlap.</span>
        </label>
      )}
      {unattributedRows.length > 1 && (
        <label className="sc-preview-ack" data-testid="candidate-preview-unattributed-ack-all">
          <input
            type="checkbox"
            checked={allUnattributedAcknowledged}
            disabled={unattributedAtoms.length !== unattributedRows.length}
            onChange={(event) => setAtomsAcknowledged(unattributedAtoms, event.target.checked)}
          />
          <span>Acknowledge all {unattributedRows.length} unattributed changes.</span>
        </label>
      )}
      {unattributedRows.map(({ entryId, atom, displayPath }) => {
        return (
        <label
          key={entryId}
          className="sc-preview-ack"
          data-testid="candidate-preview-unattributed-ack"
          data-entry-id={entryId}
        >
          <input
            type="checkbox"
            checked={isAcknowledged(acknowledgedAtoms, atom)}
            disabled={!atom}
            onChange={() => toggleUnattributed(entryId)}
          />
          <span>Include unattributed change {displayPath} — I acknowledge no agent was seen touching it.</span>
        </label>
        );
      })}

      {/* Editable commit-message body. */}
      <label className="sc-preview-msg-label" htmlFor="candidate-preview-message">
        Commit message (optional override)
      </label>
      <div className="sc-save-note" data-testid="candidate-preview-message-help">
        Generated from package details. You can edit it, but typing a message is not required to save.
      </div>
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
        {showCommitAction && <button
          type="button"
          className="ui-btn ui-btn-primary px-3 py-1 text-[12.5px]"
          data-testid="candidate-preview-save"
          disabled={!canSave || commitBusy}
          aria-busy={commitBusy}
          onClick={async () => {
            if (!canSave || !onCommit || commitInFlightRef.current) return;
            const checkedUnattributedEntryIds = response.unacknowledgedUnattributedEntryIds.filter((id) =>
              isAcknowledged(acknowledgedAtoms, unattributedAtomForEntry(response, id)),
            );
            commitInFlightRef.current = true;
            setCommitBusy(true);
            try {
              await onCommit(
                response,
                messageBody,
                checkedUnattributedEntryIds,
                {
                  response,
                  reviewedManifestDigest: response.reviewedManifest?.reviewedManifestDigest ?? null,
                  durableFinalizationIntent: response.durableFinalizationIntent ?? [],
                  acknowledgedChallengeAtoms: acknowledgedAtoms,
                  crossIntentResolutions: selectedCrossResolutions,
                  previewedCandidateId: response.isCandidate && 'candidateId' in response.candidate
                    ? response.candidate.candidateId
                    : null,
                  componentTopologyDigest: response.componentTopologyDigest,
                  checkedUnattributedEntryIds,
                  overlapAcknowledged: overlapSatisfied,
                  messageBody,
                  userTrailers,
                  canSave,
                  reservedTrailer,
                  acknowledgedUnattributedEntryIds: checkedUnattributedEntryIds,
                },
              );
            } finally {
              commitInFlightRef.current = false;
              setCommitBusy(false);
            }
          }}
        >
          {commitBusy
            ? 'Saving…'
            : response.isCandidate
              ? `Save — commit ${candidate.members.length} file${candidate.members.length === 1 ? '' : 's'}`
              : 'Save'}
        </button>}
        {showCommitAction && !canSave && !reservedTrailer && (
          <span className="sc-why" data-testid="candidate-preview-why">
            {!response.isCandidate || !eligible
              ? (response.refusal
                  ? renderSaveRefusal(response.refusal)
                  : 'Unknown preview-verification refusal.')
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
