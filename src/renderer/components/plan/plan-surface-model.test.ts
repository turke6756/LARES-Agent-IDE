import { describe, it, expect } from 'vitest';
import {
  groupEventsBySection,
  toTrustedRow,
  toClaimedPayload,
  selectBannerState,
  confidenceLabel,
  observedViaLabel,
  mismatchLabel,
  isWrite,
  classifyEvent,
  toClaimHeadline,
  buildRunStory,
  repoDigestLabel,
  hasRepoDetail,
  sectionHasRepoActivity,
  repoFileItemLine,
  repoDetailOverflow,
  ARCHIVED_GROUP_ANCHOR,
  ARCHIVED_GROUP_HEADING,
  type PlanSectionView,
  type PlanEventView,
  type RepoActivityDigest,
  type RepoActivityDetail,
} from './plan-surface-model';

const section = (over: Partial<PlanSectionView> = {}): PlanSectionView => ({
  anchor: 'sec_a1',
  heading: 'Goal',
  zone: 'goal',
  archived: false,
  eventCount: 0,
  lastEventAt: null,
  ...over,
});

// Default factory is a WRITE turn to sec_a1 (change_count 1, effect set [sec_a1]).
// Presence turns override `writtenSectionAnchors: []` + `changeCount: 0`.
const event = (over: Partial<PlanEventView> = {}): PlanEventView => ({
  id: 'e1',
  agentId: 'agent-1',
  agentTitle: 'Worker 1',
  createdAt: '2026-07-05T00:00:00.000Z',
  observedSectionAnchor: 'sec_a1',
  dispatchedSectionAnchor: 'sec_a1',
  observedVia: 'edit-target',
  attributionConfidence: 'high',
  sectionMismatch: false,
  mismatchReason: null,
  changeCount: 1,
  writtenSectionAnchors: ['sec_a1'],
  ...over,
});

// A presence/no-op deliberation turn: no effect set, zero change cardinality.
const presence = (over: Partial<PlanEventView> = {}): PlanEventView =>
  event({ changeCount: 0, writtenSectionAnchors: [], ...over });

describe('groupEventsBySection (A3.2 fan-out + F-E orphan grouping)', () => {
  it('buckets write events under their written section', () => {
    const groups = groupEventsBySection(
      [section({ anchor: 'sec_a1' }), section({ anchor: 'sec_b2', heading: 'Risks' })],
      [
        event({ writtenSectionAnchors: ['sec_a1'] }),
        event({ id: 'e2', writtenSectionAnchors: ['sec_b2'] }),
      ],
    );
    expect(groups.map((g) => g.anchor)).toEqual(['sec_a1', 'sec_b2']);
    expect(groups[0].eventCount).toBe(1);
    expect(groups[1].eventCount).toBe(1);
  });

  it('A3.2/I-2: a multi-write turn fans into EVERY written live section (deduped)', () => {
    const groups = groupEventsBySection(
      [section({ anchor: 'sec_a1' }), section({ anchor: 'sec_b2' }), section({ anchor: 'sec_c3' })],
      [event({ id: 'multi', writtenSectionAnchors: ['sec_a1', 'sec_b2', 'sec_c3', 'sec_a1'] })],
    );
    const byAnchor = new Map(groups.map((g) => [g.anchor, g]));
    expect(byAnchor.get('sec_a1')!.events.map((e) => e.id)).toEqual(['multi']);
    expect(byAnchor.get('sec_b2')!.events.map((e) => e.id)).toEqual(['multi']);
    expect(byAnchor.get('sec_c3')!.events.map((e) => e.id)).toEqual(['multi']);
    // Deduped per group — the repeated sec_a1 in the written set appears once.
    expect(byAnchor.get('sec_a1')!.writeCount).toBe(1);
  });

  it('A3.2/D-6: a presence turn buckets dispatched-first and does not inflate write rows', () => {
    const groups = groupEventsBySection(
      [section({ anchor: 'sec_disp' }), section({ anchor: 'sec_obs' })],
      [presence({ id: 'p1', dispatchedSectionAnchor: 'sec_disp', observedSectionAnchor: 'sec_obs' })],
    );
    const byAnchor = new Map(groups.map((g) => [g.anchor, g]));
    // Keyed on dispatched, not observed.
    expect(byAnchor.get('sec_disp')!.events.map((e) => e.id)).toEqual(['p1']);
    expect(byAnchor.get('sec_obs')!.events).toEqual([]);
    // Presence never counts as a write.
    expect(byAnchor.get('sec_disp')!.writeCount).toBe(0);
    expect(byAnchor.get('sec_disp')!.presenceCount).toBe(1);
  });

  it('D-6: presence turn falls back to observed anchor when dispatched is null', () => {
    const groups = groupEventsBySection(
      [section({ anchor: 'sec_obs' })],
      [presence({ id: 'p1', dispatchedSectionAnchor: null, observedSectionAnchor: 'sec_obs' })],
    );
    expect(groups[0].presenceEvents.map((e) => e.id)).toEqual(['p1']);
  });

  it('splits a group into writeEvents + presenceEvents with correct counts', () => {
    const groups = groupEventsBySection(
      [section({ anchor: 'sec_a1' })],
      [
        event({ id: 'w1', writtenSectionAnchors: ['sec_a1'] }),
        event({ id: 'w2', writtenSectionAnchors: ['sec_a1'] }),
        presence({ id: 'p1', dispatchedSectionAnchor: 'sec_a1' }),
        presence({ id: 'p2', dispatchedSectionAnchor: 'sec_a1' }),
        presence({ id: 'p3', dispatchedSectionAnchor: 'sec_a1' }),
      ],
    );
    const g = groups[0];
    expect(g.writeCount).toBe(2);
    expect(g.presenceCount).toBe(3);
    expect(g.eventCount).toBe(5);
    expect(g.writeEvents.map((e) => e.id)).toEqual(['w1', 'w2']);
    expect(g.presenceEvents.map((e) => e.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('keeps empty live sections visible with a zero count', () => {
    const groups = groupEventsBySection([section({ anchor: 'sec_a1' })], []);
    expect(groups).toHaveLength(1);
    expect(groups[0].eventCount).toBe(0);
    expect(groups[0].writeCount).toBe(0);
    expect(groups[0].presenceCount).toBe(0);
    expect(groups[0].lastEventAt).toBeNull();
  });

  it('NEVER drops orphan writes — an absent written anchor lands in the Archived section', () => {
    const groups = groupEventsBySection(
      [section({ anchor: 'sec_a1' })],
      [event({ id: 'orphan', writtenSectionAnchors: ['sec_gone'] })],
    );
    const archived = groups.find((g) => g.anchor === ARCHIVED_GROUP_ANCHOR);
    expect(archived).toBeDefined();
    expect(archived!.heading).toBe(ARCHIVED_GROUP_HEADING);
    expect(archived!.archived).toBe(true);
    expect(archived!.events.map((e) => e.id)).toEqual(['orphan']);
  });

  it('orphans a presence turn whose dispatched + observed anchors are both gone', () => {
    const groups = groupEventsBySection(
      [section({ anchor: 'sec_a1' })],
      [presence({ id: 'p', dispatchedSectionAnchor: 'sec_gone', observedSectionAnchor: 'sec_alsogone' })],
    );
    // The live section stays visible (empty); the orphan presence lands in Archived.
    const archived = groups.find((g) => g.anchor === ARCHIVED_GROUP_ANCHOR);
    expect(archived).toBeDefined();
    expect(archived!.events.map((e) => e.id)).toEqual(['p']);
    expect(groups.find((g) => g.anchor === 'sec_a1')!.events).toEqual([]);
  });

  it('folds writes on an archived live section into the Archived group', () => {
    const groups = groupEventsBySection(
      [section({ anchor: 'sec_a1', archived: true })],
      [event({ writtenSectionAnchors: ['sec_a1'] })],
    );
    // The archived live section is NOT its own live group; its write orphans.
    expect(groups.map((g) => g.anchor)).toEqual([ARCHIVED_GROUP_ANCHOR]);
  });

  it('omits the Archived group entirely when there are no orphans', () => {
    const groups = groupEventsBySection([section({ anchor: 'sec_a1' })], [event()]);
    expect(groups.some((g) => g.anchor === ARCHIVED_GROUP_ANCHOR)).toBe(false);
  });

  it('computes lastEventAt as the max createdAt in the group', () => {
    const groups = groupEventsBySection(
      [section({ anchor: 'sec_a1' })],
      [
        event({ id: 'e1', createdAt: '2026-07-05T01:00:00.000Z' }),
        event({ id: 'e2', createdAt: '2026-07-05T03:00:00.000Z' }),
        event({ id: 'e3', createdAt: '2026-07-05T02:00:00.000Z' }),
      ],
    );
    expect(groups[0].lastEventAt).toBe('2026-07-05T03:00:00.000Z');
  });
});

describe('classifyEvent + isWrite (A3.3 / GT-C §3.2)', () => {
  it('classifyEvent is "write" iff the effect set is non-empty', () => {
    expect(classifyEvent(event({ writtenSectionAnchors: ['sec_a1'] }))).toBe('write');
    expect(classifyEvent(presence())).toBe('presence');
    expect(classifyEvent(event({ writtenSectionAnchors: [] }))).toBe('presence');
  });

  it('isWrite keys on raw change cardinality', () => {
    expect(isWrite(event({ changeCount: 3 }))).toBe(true);
    expect(isWrite(presence())).toBe(false);
    expect(isWrite(event({ changeCount: 0, writtenSectionAnchors: [] }))).toBe(false);
  });
});

describe('toClaimHeadline (GT-C §3.2, string-coerced, diagnostics-only)', () => {
  it('extracts status/result/next from the claimed payload', () => {
    const h = toClaimHeadline(event({ claimedPayload: { status: 'integrated', result: 'landed X', next: 'do Y' } }));
    expect(h).toEqual({ status: 'integrated', result: 'landed X', next: 'do Y' });
  });

  it('string-coerces non-string values', () => {
    const h = toClaimHeadline(event({ claimedPayload: { status: 1, result: true, next: null } }));
    expect(h.status).toBe('1');
    expect(h.result).toBe('true');
    expect(h.next).toBeNull();
  });

  it('returns all-null when there is no payload', () => {
    expect(toClaimHeadline(event({ claimedPayload: null }))).toEqual({ status: null, result: null, next: null });
    expect(toClaimHeadline(event({ claimedPayload: undefined }))).toEqual({ status: null, result: null, next: null });
  });
});

describe('buildRunStory (GT-C §3.2 chronological flattening)', () => {
  it('sorts ascending by createdAt', () => {
    const story = buildRunStory([
      event({ id: 'c', createdAt: '2026-07-05T03:00:00.000Z' }),
      event({ id: 'a', createdAt: '2026-07-05T01:00:00.000Z' }),
      event({ id: 'b', createdAt: '2026-07-05T02:00:00.000Z' }),
    ]);
    expect(story.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('is a stable sort for equal timestamps and does not mutate the input', () => {
    const input = [
      event({ id: 'x', createdAt: '2026-07-05T01:00:00.000Z' }),
      event({ id: 'y', createdAt: '2026-07-05T01:00:00.000Z' }),
    ];
    const story = buildRunStory(input);
    expect(story.map((e) => e.id)).toEqual(['x', 'y']);
    expect(input.map((e) => e.id)).toEqual(['x', 'y']); // input untouched
  });
});

describe('toTrustedRow (tier-2 trusted grammar)', () => {
  it('maps resolver facts into a labelled trusted row', () => {
    const row = toTrustedRow(event({ observedVia: 'fs-diff', attributionConfidence: 'medium' }));
    expect(row.observedViaLabel).toBe('Observed via file diff');
    expect(row.confidence).toBe('medium');
    expect(row.confidenceLabel).toBe('Medium confidence');
    expect(row.agentTitle).toBe('Worker 1');
    expect(row.mismatchLabel).toBeNull();
  });

  it('surfaces a mismatch flag when sectionMismatch is set', () => {
    const row = toTrustedRow(event({ sectionMismatch: true, mismatchReason: 'intent-effect-divergence' }));
    expect(row.mismatchLabel).toBe('Read one section, changed another');
  });

  it('falls back to a generic mismatch label when reason is null', () => {
    const row = toTrustedRow(event({ sectionMismatch: true, mismatchReason: null }));
    expect(row.mismatchLabel).toBe('Section mismatch');
  });

  it('falls back to agentId when no title is present', () => {
    expect(toTrustedRow(event({ agentTitle: null })).agentTitle).toBe('agent-1');
  });
});

describe('toClaimedPayload (kept separate, never merged into trusted)', () => {
  it('reports absence plainly when the agent made no claim', () => {
    const c = toClaimedPayload(event({ claimedSectionAnchor: null, claimedPayload: null }));
    expect(c.present).toBe(false);
    expect(c.entries).toEqual([]);
  });

  it('flattens a claimed payload into display entries without interpreting it', () => {
    const c = toClaimedPayload(
      event({ claimedSectionAnchor: 'sec_a1', claimedPayload: { note: 'done', count: 3 } }),
    );
    expect(c.present).toBe(true);
    expect(c.entries).toContainEqual({ key: 'note', value: 'done' });
    expect(c.entries).toContainEqual({ key: 'count', value: '3' });
  });

  it('flags a claimed-vs-observed divergence (diagnostics)', () => {
    const c = toClaimedPayload(
      event({ observedSectionAnchor: 'sec_a1', claimedSectionAnchor: 'sec_b2' }),
    );
    expect(c.divergesFromObserved).toBe(true);
  });

  it('does not flag divergence when claimed matches observed', () => {
    const c = toClaimedPayload(
      event({ observedSectionAnchor: 'sec_a1', claimedSectionAnchor: 'sec_a1' }),
    );
    expect(c.divergesFromObserved).toBe(false);
  });
});

describe('selectBannerState (F-E degradation)', () => {
  it('is silent on a clean projection', () => {
    const b = selectBannerState({ parseError: null, warnings: [] });
    expect(b.kind).toBe('none');
    expect(b.message).toBeNull();
  });

  it('renders a last-good banner when degraded from memory', () => {
    const b = selectBannerState({ parseError: 'boom', warnings: [], degradedFrom: 'memory' });
    expect(b.kind).toBe('parse-error');
    expect(b.severity).toBe('error');
    expect(b.message).toMatch(/last good render/i);
  });

  it('names the snapshot source when degraded from a snapshot blob', () => {
    const b = selectBannerState({ parseError: 'boom', warnings: [], degradedFrom: 'snapshot' });
    expect(b.message).toMatch(/snapshot/i);
  });

  it('states cold-start honestly when there is no fallback', () => {
    const b = selectBannerState({ parseError: 'boom', warnings: [], degradedFrom: 'empty' });
    expect(b.message).toMatch(/no previous version/i);
  });

  it('surfaces anchor-repair warnings when the parse itself succeeded', () => {
    const b = selectBannerState({ parseError: null, warnings: ['duplicate data-anchor sec_a1'] });
    expect(b.kind).toBe('anchor-repair');
    expect(b.severity).toBe('warn');
    expect(b.warnings).toHaveLength(1);
  });

  it('a parse error dominates over repair warnings', () => {
    const b = selectBannerState({ parseError: 'boom', warnings: ['dup'], degradedFrom: 'memory' });
    expect(b.kind).toBe('parse-error');
    expect(b.warnings).toEqual(['dup']);
  });
});

describe('label helpers', () => {
  it('confidenceLabel covers every tier + null', () => {
    expect(confidenceLabel('high')).toBe('High confidence');
    expect(confidenceLabel(null)).toBe('Unattributed');
  });
  it('observedViaLabel covers dispatched-fallback + null', () => {
    expect(observedViaLabel('dispatched-fallback')).toMatch(/dispatched/i);
    expect(observedViaLabel(null)).toMatch(/no attribution/i);
  });
  it('mismatchLabel returns null when there is no reason', () => {
    expect(mismatchLabel(null)).toBeNull();
  });
});

// ── Fix-4 §6: witnessed repo-activity view-model helpers ───────────────────────

type Totals = NonNullable<RepoActivityDigest['totals']>;
const totals = (over: Partial<Totals> = {}): Totals => ({
  filesRead: 0, filesEdited: 0, filesCreated: 0, fileEvents: 0, distinctFiles: 0,
  testsRun: 0, testsPassed: 0, testsFailed: 0,
  ...over,
});

describe('repoDigestLabel (never re-synthesizes — line wins verbatim)', () => {
  it('missing digest → the honest pre-fix-4 disclosure', () => {
    expect(repoDigestLabel(null)).toBe('witnessed: not captured (pre-fix-4)');
    expect(repoDigestLabel(undefined)).toBe('witnessed: not captured (pre-fix-4)');
  });

  it('not-captured status → the pre-fix-4 disclosure', () => {
    const d: RepoActivityDigest = { status: 'not-captured', totals: null, line: null };
    expect(repoDigestLabel(d)).toBe('witnessed: not captured (pre-fix-4)');
  });

  it('captured with a line → returns digest.line VERBATIM (no re-synthesis from counts)', () => {
    // The line deliberately disagrees with what the counts would produce — the frozen
    // server-formatted line must win, proving the renderer never recomputes it.
    const d: RepoActivityDigest = {
      status: 'captured',
      totals: totals({ filesEdited: 99, filesRead: 3 }),
      line: 'witnessed: 9 repo files edited; 2 created; 14 read',
    };
    expect(repoDigestLabel(d)).toBe('witnessed: 9 repo files edited; 2 created; 14 read');
  });

  it('captured but empty (line === null) → null (nothing to show)', () => {
    const d: RepoActivityDigest = { status: 'captured', totals: totals(), line: null };
    expect(repoDigestLabel(d)).toBeNull();
  });
});

describe('hasRepoDetail (expander gate)', () => {
  it('true only for captured digest with a non-empty line', () => {
    expect(hasRepoDetail({ status: 'captured', totals: totals({ filesEdited: 1 }), line: 'witnessed: 1 repo files edited' })).toBe(true);
  });
  it('false for not-captured, captured-empty, and missing', () => {
    expect(hasRepoDetail({ status: 'not-captured', totals: null, line: null })).toBe(false);
    expect(hasRepoDetail({ status: 'captured', totals: totals(), line: null })).toBe(false);
    expect(hasRepoDetail(null)).toBe(false);
    expect(hasRepoDetail(undefined)).toBe(false);
  });
});

describe('sectionHasRepoActivity', () => {
  it('true when any repo count is positive, false when all zero', () => {
    expect(sectionHasRepoActivity({ repoFilesRead: 0, repoFilesEdited: 0, repoFilesCreated: 0 })).toBe(false);
    expect(sectionHasRepoActivity({ repoFilesRead: 5, repoFilesEdited: 0, repoFilesCreated: 0 })).toBe(true);
    expect(sectionHasRepoActivity({ repoFilesRead: 0, repoFilesEdited: 2, repoFilesCreated: 0 })).toBe(true);
    expect(sectionHasRepoActivity({ repoFilesRead: 0, repoFilesEdited: 0, repoFilesCreated: 1 })).toBe(true);
  });
});

describe('groupEventsBySection carries per-section repo counts from the projection', () => {
  it('copies repo counts onto the live group; archived group stays 0', () => {
    const groups = groupEventsBySection(
      [
        section({ anchor: 'sec_a1', repoFilesRead: 14, repoFilesEdited: 9, repoFilesCreated: 2 }),
      ],
      [
        event({ id: 'w', writtenSectionAnchors: ['sec_a1'] }),
        event({ id: 'orphan', writtenSectionAnchors: ['sec_gone'] }),
      ],
    );
    const byAnchor = new Map(groups.map((g) => [g.anchor, g]));
    const live = byAnchor.get('sec_a1')!;
    expect(live.repoFilesRead).toBe(14);
    expect(live.repoFilesEdited).toBe(9);
    expect(live.repoFilesCreated).toBe(2);
    // The synthetic Archived group has no section rollup → counts default to 0.
    const archived = byAnchor.get(ARCHIVED_GROUP_ANCHOR)!;
    expect([archived.repoFilesRead, archived.repoFilesEdited, archived.repoFilesCreated]).toEqual([0, 0, 0]);
  });

  it('defaults repo counts to 0 for a section that omits them (pre-fix-4 projection)', () => {
    const groups = groupEventsBySection([section({ anchor: 'sec_a1' })], [event()]);
    expect([groups[0].repoFilesRead, groups[0].repoFilesEdited, groups[0].repoFilesCreated]).toEqual([0, 0, 0]);
  });
});

describe('repoFileItemLine (Tier-3 path · ops · counts)', () => {
  const item = (over: Partial<RepoActivityDetail['files']['items'][number]> = {}): RepoActivityDetail['files']['items'][number] => ({
    path: 'src/main/index.ts',
    operations: ['read', 'write'],
    counts: { read: 2, write: 1, create: 0 },
    firstAt: '2026-07-09T00:00:00.000Z',
    lastAt: '2026-07-09T00:01:00.000Z',
    ...over,
  });

  it('formats path, ops, and non-zero counts', () => {
    const line = repoFileItemLine(item());
    expect(line.path).toBe('src/main/index.ts');
    expect(line.ops).toBe('read, write');
    expect(line.counts).toBe('2 read, 1 edit');
  });

  it('renders the workspace-root path (empty string) as a readable placeholder', () => {
    expect(repoFileItemLine(item({ path: '' })).path).toBe('(workspace root)');
  });

  it('includes a create count when present', () => {
    expect(repoFileItemLine(item({ operations: ['create'], counts: { read: 0, write: 0, create: 3 } })).counts).toBe('3 create');
  });
});

describe('repoDetailOverflow ("+N more (capped)")', () => {
  const detail = (distinctFiles: number, shown: number): RepoActivityDetail => ({
    planEventId: 'e1',
    files: { truncated: distinctFiles > shown, items: Array.from({ length: shown }, (_, i) => ({
      path: `f${i}.ts`, operations: ['write'], counts: { read: 0, write: 1, create: 0 },
      firstAt: '2026-07-09T00:00:00.000Z', lastAt: '2026-07-09T00:00:00.000Z',
    })) },
    totals: totals({ distinctFiles }),
    window: { sinceIso: '2026-07-09T00:00:00.000Z', untilIso: '2026-07-09T00:05:00.000Z' },
  });

  it('reports the elided count from pre-cap distinctFiles', () => {
    expect(repoDetailOverflow(detail(250, 200))).toBe(50);
  });
  it('is 0 (never negative) when nothing was elided', () => {
    expect(repoDetailOverflow(detail(3, 3))).toBe(0);
  });
});
