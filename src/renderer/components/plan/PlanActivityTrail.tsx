import React, { useState } from 'react';
import {
  sectionDomId,
  buildRunStory,
  toClaimHeadline,
  observedViaLabel,
  sectionHasRepoActivity,
  type SectionGroup,
  type PlanEventView,
} from './plan-surface-model';
import TrustedEventRow, { type FetchEventDetail } from './TrustedEventRow';
import ClaimedPayload from './ClaimedPayload';

/** The section activity trail. Two view modes (GT-C §3.3–§3.4), owned by
 *  `PlanSurfaceView`:
 *
 *  - `section` (default): one fully-expanded group per section. Within a group,
 *    WRITE turns render first — each **claim-first** (the agent's self-reported
 *    result is the headline; the trusted attribution row sits beneath as demoted
 *    but never-removed metadata). Presence/deliberation turns (no changes) never
 *    interleave with writes — they collapse into a single muted toggle line
 *    (fixes I-3). Orphan events surface under a named "Archived section" group.
 *  - `story`: the whole run as one flat, oldest-first list — no section grouping,
 *    writes prominent, presence muted.
 *
 *  Each section carries a stable DOM id (`sectionDomId`) so the nav can scroll-to
 *  it; the nav is hidden by the parent in story mode (no dangling scroll targets). */
function PlanActivityTrail({
  groups,
  events,
  viewMode,
  highlightAnchor,
  onFetchEventDetail,
}: {
  groups: SectionGroup[];
  events: PlanEventView[];
  viewMode: 'section' | 'story';
  highlightAnchor?: string | null;
  onFetchEventDetail?: FetchEventDetail;
}): React.ReactElement {
  if (viewMode === 'story') {
    const story = buildRunStory(events);
    return (
      <div className="plan-trail plan-trail--story" data-testid="plan-trail">
        {story.length === 0 ? (
          <div className="plan-section-group__empty">No recorded activity yet.</div>
        ) : (
          story.map((ev) => <EventRow key={ev.id} event={ev} onFetchEventDetail={onFetchEventDetail} />)
        )}
      </div>
    );
  }

  return (
    <div className="plan-trail" data-testid="plan-trail">
      {groups.map((g) => (
        <SectionGroupRow
          key={g.anchor}
          group={g}
          flash={highlightAnchor === g.anchor}
          onFetchEventDetail={onFetchEventDetail}
        />
      ))}
    </div>
  );
}

function SectionGroupRow({
  group,
  flash,
  onFetchEventDetail,
}: {
  group: SectionGroup;
  flash: boolean;
  onFetchEventDetail?: FetchEventDetail;
}): React.ReactElement {
  const cls =
    `plan-section-group${group.archived ? ' plan-section-group--archived' : ''}` +
    `${flash ? ' plan-section-group--flash' : ''}`;
  return (
    <section className={cls} id={sectionDomId(group.anchor)} data-nav-target={group.anchor}>
      <header className="plan-section-group__chip">
        <span className="plan-section-group__heading">{group.heading}</span>
        {group.zone && <span className="plan-section-group__zone">{group.zone}</span>}
        {/* GT-C §3.4 — writes prominent, presence muted (replaces the ambiguous "N events"). */}
        <span className="plan-section-group__count">
          {group.writeCount > 0 ? (
            <span className="plan-section-group__writes">
              {group.writeCount} {group.writeCount === 1 ? 'write' : 'writes'}
            </span>
          ) : (
            <span className="plan-section-group__writes plan-section-group__writes--none">no writes</span>
          )}
          {group.presenceCount > 0 && (
            <span className="plan-section-group__notes"> · {group.presenceCount} notes</span>
          )}
        </span>
        {group.lastEventAt && (
          <span className="plan-section-group__last">{formatLast(group.lastEventAt)}</span>
        )}
      </header>
      {/* Fix-4 §6 — witnessed per-section repo counts; hidden entirely when zero. */}
      <RepoCountsChip group={group} />
      <div className="plan-section-group__body">
        {group.events.length === 0 ? (
          <div className="plan-section-group__empty">No recorded activity yet.</div>
        ) : (
          <>
            {group.writeEvents.map((ev) => (
              <EventRow key={ev.id} event={ev} onFetchEventDetail={onFetchEventDetail} />
            ))}
            <PresenceCollapse events={group.presenceEvents} onFetchEventDetail={onFetchEventDetail} />
          </>
        )}
      </div>
    </section>
  );
}

/** Fix-4 §6 — the section chip's witnessed repo counts (edited / created / read),
 *  from the server-computed per-section rollup. Zero → renders nothing so a
 *  no-repo-activity section stays uncluttered. */
function RepoCountsChip({ group }: { group: SectionGroup }): React.ReactElement | null {
  if (!sectionHasRepoActivity(group)) return null;
  const parts: Array<{ key: string; label: string }> = [];
  if (group.repoFilesEdited > 0) parts.push({ key: 'edited', label: `${group.repoFilesEdited} edited` });
  if (group.repoFilesCreated > 0) parts.push({ key: 'created', label: `${group.repoFilesCreated} created` });
  if (group.repoFilesRead > 0) parts.push({ key: 'read', label: `${group.repoFilesRead} read` });
  return (
    <div className="plan-section-group__repo" data-testid="section-repo-counts">
      <span className="plan-section-group__repo-label">witnessed</span>
      {parts.map((p) => (
        <span key={p.key} className={`plan-section-group__repo-chip plan-section-group__repo-chip--${p.key}`}>
          {p.label}
        </span>
      ))}
    </div>
  );
}

/** A single claim-first activity row. Headline = the agent's self-reported result
 *  when present (GT-C §3.4 claim-first), else the trusted `observed_via` label. The
 *  `TrustedEventRow` beneath is the verified record, demoted to secondary metadata
 *  but never removed (trusted ≠ claimed stays visible — security-load-bearing). */
function EventRow({
  event,
  onFetchEventDetail,
}: {
  event: PlanEventView;
  onFetchEventDetail?: FetchEventDetail;
}): React.ReactElement {
  const claim = toClaimHeadline(event);
  const headline = claim.result ?? observedViaLabel(event.observedVia);
  const write = event.changeCount > 0;
  return (
    <div className={`plan-event${write ? ' plan-event--write' : ' plan-event--presence'}`} data-testid="plan-event">
      <div className="plan-event__headline" data-testid="plan-event-headline">
        {claim.status && <span className="plan-event__status">{claim.status}</span>}
        <span className="plan-event__result">{headline}</span>
      </div>
      <TrustedEventRow event={event} onFetchEventDetail={onFetchEventDetail} />
      <ClaimedPayload event={event} />
    </div>
  );
}

/** GT-C §3.4 / GT-A A3.3 — presence turns collapse into ONE muted line, never
 *  interleaved with writes. Collapsed by default; a click reveals the individual
 *  no-op rows. Renders nothing when there are no presence turns. */
function PresenceCollapse({
  events,
  onFetchEventDetail,
}: {
  events: PlanEventView[];
  onFetchEventDetail?: FetchEventDetail;
}): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  if (events.length === 0) return null;
  return (
    <div className="plan-presence" data-testid="plan-presence">
      <button
        type="button"
        className="plan-presence__toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="plan-presence-toggle"
      >
        {events.length} deliberation {events.length === 1 ? 'turn' : 'turns'} — no changes
        <span className="plan-presence__chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="plan-presence__body" data-testid="plan-presence-body">
          {events.map((ev) => (
            <EventRow key={ev.id} event={ev} onFetchEventDetail={onFetchEventDetail} />
          ))}
        </div>
      )}
    </div>
  );
}

function formatLast(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `last ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export default PlanActivityTrail;
