// behavior-sequences.ts — WP9 (G9): sequence/co-touch mining + command-family
// association over per-stream `behavior_events`, with pinned agent identity.
//
// Semantics (plan "implement exactly"):
//   • event ordering: (ts_ms, byte_offset, block_index, event_ordinal, id);
//   • session boundary = the STREAM; entry boundary = `entry_uuid` (there is no
//     turn id on behavior_events — dedup collapses CONSECUTIVE same-op same-path
//     file touches within one entry_uuid to one);
//   • ops classified read/write/execute by REUSING the file-coverage op mapping
//     (`classifyAccessOp` below is that mapping, extracted from
//     optimizer-pipeline.ts aggregateFileTouches, which now delegates here);
//   • co-touch = same stream, window of ±CO_TOUCH_WINDOW behavior events OF ANY
//     KIND (stated in the exported metadata), min support MIN_SUPPORT streams;
//   • predecessor distance ≤ PREDECESSOR_MAX_DISTANCE events;
//   • top-k TOP_K per list, tie-break (support desc, path lex asc);
//   • truncation disclosed per list in the WP6 TableTruncationMetaV1 SHAPE
//     (mirrored structurally — this layer does not import analytics-export);
//   • identity ONLY via the pinned stream-identity join; unresolved streams land
//     in an explicit `unattributedStreams` bucket, NEVER inferred from cwd/slug.
//
// `associatedCommandFamilies` is the ONE join that may lift WP3's file-targeting
// bar for command-family evidence (milestone gate 5): per (file, command_family)
// within the same-stream declared window, min stream support, each entry stamped
// with THIS analysis `generationId` — the lift is generationId-gated and
// therefore prospective only (an older draft's generation can never match).
//
// Pure over an injected QueryDb (real handle in production, sql.js in tests).

import type { QueryDb } from './behavior-store';
import { resolveStreamAgents } from './stream-identity';

// ── declared parameters (exported so metadata/tests/consumers share them) ─────
export const FILE_SEQUENCES_CO_TOUCH_WINDOW_EVENTS = 10;
export const FILE_SEQUENCES_MIN_SUPPORT_STREAMS = 3;
export const FILE_SEQUENCES_PREDECESSOR_MAX_DISTANCE_EVENTS = 5;
export const FILE_SEQUENCES_TOP_K = 10;

// ── op classification (the file-coverage mapping, extracted) ──────────────────
export type FileSequenceOp = 'read' | 'write' | 'execute';

/** THE file-coverage op mapping (extracted from optimizer-pipeline.ts
 *  aggregateFileTouches, which delegates here): `executed` → execute, `write` →
 *  write, anything else — read and any unknown access — counts as a read. */
export function classifyAccessOp(accessMode: string | null | undefined): FileSequenceOp {
  if (accessMode === 'executed') return 'execute';
  if (accessMode === 'write') return 'write';
  return 'read';
}

// ── output shapes ─────────────────────────────────────────────────────────────

/** WP6 TableTruncationMetaV1 SHAPE, mirrored field-for-field (this layer stays
 *  independent of analytics-export; the export test asserts the shapes agree). */
export interface SequenceTruncationMetaV1 {
  populationAvailable: number | null;
  rowsEmitted: number;
  truncated: boolean | null;
  limit: number;
  paginationOrder: 'truncate-then-paginate';
}

export interface CoTouchPairV1 {
  /** Normalized (LOWER, as stored) touch paths; pathA < pathB lexicographically. */
  pathA: string;
  pathB: string;
  streamsSupporting: number;
  occurrences: number;
}

export interface PredecessorEdgeV1 {
  /** The successor file (the one being predicted). */
  path: string;
  /** A file touched within ≤ predecessorMaxDistanceEvents BEFORE a touch of `path`. */
  predecessorPath: string;
  streamsSupporting: number;
  occurrences: number;
}

export interface AssociatedCommandFamilyV1 {
  path: string;
  commandFamily: string;
  streamsSupporting: number;
  occurrences: number;
  /** The analysis generation this join was computed in — the WP3 lift is gated
   *  on EQUALITY with the draft's generation (prospective only). */
  generationId: string;
}

export interface FileSequencesMetadataV1 {
  /** ± window measured in behavior events OF ANY KIND, not only file touches. */
  coTouchWindowEvents: number;
  coTouchWindowEventKinds: 'any-behavior-event';
  minSupportStreams: number;
  predecessorMaxDistanceEvents: number;
  topK: number;
  /** Entry boundary column — there is no turn id on behavior_events. */
  entryBoundary: 'entry_uuid';
  /** The exact ordering tuple applied within a stream. */
  eventOrdering: ['ts_ms', 'byte_offset', 'block_index', 'event_ordinal', 'id'];
  opClassification: 'file-coverage-access-mode-mapping';
  /** Streams are the session boundary; all streams with behavior events enter. */
  sessionBoundary: 'stream';
}

export interface FileSequencesAttributionV1 {
  /** Streams resolved via the pinned session→agent join. */
  attributedStreams: number;
  /** Streams with behavior events but NO resolvable agent — the honest bucket;
   *  identity is never inferred from cwd/slug (many-agents-per-cwd invariant). */
  unattributedStreams: number;
  byAgent: Array<{ dashboardAgentId: string; streams: number }>;
}

export interface FileSequencesV1 {
  generationId: string;
  metadata: FileSequencesMetadataV1;
  coTouch: CoTouchPairV1[];
  predecessors: PredecessorEdgeV1[];
  associatedCommandFamilies: AssociatedCommandFamilyV1[];
  attribution: FileSequencesAttributionV1;
  truncation: {
    coTouch: SequenceTruncationMetaV1;
    predecessors: SequenceTruncationMetaV1;
    associatedCommandFamilies: SequenceTruncationMetaV1;
  };
}

// ── internals ─────────────────────────────────────────────────────────────────

export interface RawEvent {
  streamId: string;
  entryUuid: string | null;
  kind: string;
  commandFamily: string | null;
  path: string | null;        // LOWER(arg_path)
  op: FileSequenceOp;
}

/** All behavior events, grouped per stream in the EXACT declared ordering tuple.
 *  SQL does the ordering so the tiebreak columns behave identically to every
 *  other reader of this table. */
function loadOrderedEvents(db: QueryDb): Map<string, RawEvent[]> {
  const rows = db.prepare(
    `SELECT ev.stream_id AS s, ev.entry_uuid AS eu, ev.kind AS k,
            ev.command_family AS cf, LOWER(ev.arg_path) AS p, ev.access_mode AS am
       FROM behavior_events ev
      ORDER BY ev.stream_id, ev.ts_ms, ev.byte_offset, ev.block_index, ev.event_ordinal, ev.id`,
  ).all();
  const byStream = new Map<string, RawEvent[]>();
  for (const r of rows) {
    const streamId = String(r.s ?? '');
    if (!streamId) continue;
    let list = byStream.get(streamId);
    if (!list) { list = []; byStream.set(streamId, list); }
    list.push({
      streamId,
      entryUuid: r.eu == null ? null : String(r.eu),
      kind: String(r.k ?? ''),
      commandFamily: r.cf == null ? null : String(r.cf),
      path: r.p == null ? null : String(r.p),
      op: classifyAccessOp(r.am == null ? null : String(r.am)),
    });
  }
  return byStream;
}

/** Entry-boundary dedup: an event is dropped iff it is a file touch and the
 *  IMMEDIATELY PRECEDING kept event is a file touch of the same path with the
 *  same op inside the same entry_uuid (a null entry_uuid never matches — no
 *  boundary means no collapse). Indices for the ±window are assigned over the
 *  KEPT events of every kind. */
export function dedupConsecutiveTouches(events: RawEvent[]): RawEvent[] {
  const kept: RawEvent[] = [];
  for (const ev of events) {
    const prev = kept[kept.length - 1];
    const isTouch = ev.kind === 'file_touch' && ev.path != null;
    if (
      isTouch && prev !== undefined
      && prev.kind === 'file_touch' && prev.path === ev.path && prev.op === ev.op
      && ev.entryUuid != null && prev.entryUuid === ev.entryUuid
    ) {
      continue; // consecutive same-op same-path within one entry_uuid → collapse
    }
    kept.push(ev);
  }
  return kept;
}

interface PairAcc { occurrences: number; streams: Set<string> }
function bump(map: Map<string, PairAcc>, key: string, streamId: string): void {
  let acc = map.get(key);
  if (!acc) { acc = { occurrences: 0, streams: new Set() }; map.set(key, acc); }
  acc.occurrences += 1;
  acc.streams.add(streamId);
}

/** support desc, then the row's lexical key parts asc — the declared tie-break. */
function bySupportThenLex(aSupport: number, aKey: string[], bSupport: number, bKey: string[]): number {
  if (aSupport !== bSupport) return bSupport - aSupport;
  for (let i = 0; i < Math.min(aKey.length, bKey.length); i++) {
    if (aKey[i] !== bKey[i]) return aKey[i] < bKey[i] ? -1 : 1;
  }
  return 0;
}

function truncMeta(population: number, emitted: number): SequenceTruncationMetaV1 {
  return {
    populationAvailable: population,
    rowsEmitted: emitted,
    truncated: population > emitted,
    limit: FILE_SEQUENCES_TOP_K,
    paginationOrder: 'truncate-then-paginate',
  };
}

// ── build ─────────────────────────────────────────────────────────────────────

export function buildFileSequences(db: QueryDb, opts: { generationId: string }): FileSequencesV1 {
  const byStream = loadOrderedEvents(db);

  const coTouchAcc = new Map<string, PairAcc>();
  const predecessorAcc = new Map<string, PairAcc>();
  const familyAcc = new Map<string, PairAcc>();

  // NUL never appears in a normalized path or a command-family token — a space can.
  const SEP = '\u0000';

  for (const [streamId, rawEvents] of byStream) {
    const events = dedupConsecutiveTouches(rawEvents);
    // Kept-event indices over ALL kinds — the declared distance unit.
    const touches: Array<{ idx: number; path: string }> = [];
    const familyEvents: Array<{ idx: number; family: string }> = [];
    events.forEach((ev, idx) => {
      if (ev.kind === 'file_touch' && ev.path != null) touches.push({ idx, path: ev.path });
      if (ev.commandFamily != null) familyEvents.push({ idx, family: ev.commandFamily });
    });

    // Co-touch: unordered distinct-path pair with |idx diff| ≤ window.
    for (let a = 0; a < touches.length; a++) {
      for (let b = a + 1; b < touches.length; b++) {
        const dist = touches[b].idx - touches[a].idx;
        if (dist > FILE_SEQUENCES_CO_TOUCH_WINDOW_EVENTS) break; // ordered → no later b qualifies
        if (touches[a].path === touches[b].path) continue;
        const [pA, pB] = touches[a].path < touches[b].path
          ? [touches[a].path, touches[b].path]
          : [touches[b].path, touches[a].path];
        bump(coTouchAcc, pA + SEP + pB, streamId);
      }
    }

    // Predecessors: for each touch, each DISTINCT other path touched within
    // ≤ maxDistance events strictly before it counts once per successor touch.
    for (let b = 0; b < touches.length; b++) {
      const seen = new Set<string>();
      for (let a = b - 1; a >= 0; a--) {
        const dist = touches[b].idx - touches[a].idx;
        if (dist > FILE_SEQUENCES_PREDECESSOR_MAX_DISTANCE_EVENTS) break;
        const pred = touches[a].path;
        if (pred === touches[b].path || seen.has(pred)) continue;
        seen.add(pred);
        bump(predecessorAcc, touches[b].path + SEP + pred, streamId);
      }
    }

    // Command-family association: family event within the same-stream declared
    // (co-touch) window of a file touch → one occurrence per qualifying pair.
    for (const t of touches) {
      for (const f of familyEvents) {
        if (Math.abs(f.idx - t.idx) > FILE_SEQUENCES_CO_TOUCH_WINDOW_EVENTS) continue;
        bump(familyAcc, t.path + SEP + f.family, streamId);
      }
    }
  }

  // Min support, sort (support desc, path lex), top-k, truncation disclosure.
  const qualify = (map: Map<string, PairAcc>): Array<{ key: string[]; acc: PairAcc }> =>
    [...map.entries()]
      .filter(([, acc]) => acc.streams.size >= FILE_SEQUENCES_MIN_SUPPORT_STREAMS)
      .map(([k, acc]) => ({ key: k.split(SEP), acc }))
      .sort((x, y) => bySupportThenLex(x.acc.streams.size, x.key, y.acc.streams.size, y.key));

  const coQ = qualify(coTouchAcc);
  const predQ = qualify(predecessorAcc);
  const famQ = qualify(familyAcc);

  const coTouch: CoTouchPairV1[] = coQ.slice(0, FILE_SEQUENCES_TOP_K).map(({ key, acc }) => ({
    pathA: key[0], pathB: key[1], streamsSupporting: acc.streams.size, occurrences: acc.occurrences,
  }));
  const predecessors: PredecessorEdgeV1[] = predQ.slice(0, FILE_SEQUENCES_TOP_K).map(({ key, acc }) => ({
    path: key[0], predecessorPath: key[1], streamsSupporting: acc.streams.size, occurrences: acc.occurrences,
  }));
  const associatedCommandFamilies: AssociatedCommandFamilyV1[] =
    famQ.slice(0, FILE_SEQUENCES_TOP_K).map(({ key, acc }) => ({
      path: key[0], commandFamily: key[1],
      streamsSupporting: acc.streams.size, occurrences: acc.occurrences,
      generationId: opts.generationId,
    }));

  // Identity — ONLY via the pinned join; unresolved → explicit bucket.
  const resolution = resolveStreamAgents(db);
  const byAgentCounts = new Map<string, number>();
  for (const agentId of resolution.attributed.values()) {
    byAgentCounts.set(agentId, (byAgentCounts.get(agentId) ?? 0) + 1);
  }
  const byAgent = [...byAgentCounts.entries()]
    .map(([dashboardAgentId, streams]) => ({ dashboardAgentId, streams }))
    .sort((a, b) => (b.streams - a.streams)
      || (a.dashboardAgentId < b.dashboardAgentId ? -1 : a.dashboardAgentId > b.dashboardAgentId ? 1 : 0));

  return {
    generationId: opts.generationId,
    metadata: {
      coTouchWindowEvents: FILE_SEQUENCES_CO_TOUCH_WINDOW_EVENTS,
      coTouchWindowEventKinds: 'any-behavior-event',
      minSupportStreams: FILE_SEQUENCES_MIN_SUPPORT_STREAMS,
      predecessorMaxDistanceEvents: FILE_SEQUENCES_PREDECESSOR_MAX_DISTANCE_EVENTS,
      topK: FILE_SEQUENCES_TOP_K,
      entryBoundary: 'entry_uuid',
      eventOrdering: ['ts_ms', 'byte_offset', 'block_index', 'event_ordinal', 'id'],
      opClassification: 'file-coverage-access-mode-mapping',
      sessionBoundary: 'stream',
    },
    coTouch,
    predecessors,
    associatedCommandFamilies,
    attribution: {
      attributedStreams: resolution.attributed.size,
      unattributedStreams: resolution.unattributedStreamIds.length,
      byAgent,
    },
    truncation: {
      coTouch: truncMeta(coQ.length, coTouch.length),
      predecessors: truncMeta(predQ.length, predecessors.length),
      associatedCommandFamilies: truncMeta(famQ.length, associatedCommandFamilies.length),
    },
  };
}
