// WP-P0PRE — planning-surface demand probe (append service).
//
// A minimal, privacy-lean telemetry sink that answers ONE question for the
// planning-surface revamp: is the feature being exercised voluntarily? It
// appends one JSONL line per planning-surface event to
// `<stateDir>/usage/demand-probe.jsonl` (state dir resolved via
// `workspaceStateDir()`, so it lands under `.lares/usage/` — or the legacy
// `.dashboard/usage/` on a rename-blocked clone). `usage/` is git-ignored.
//
// DESIGN INVARIANTS (see the ratified plan + acceptance criteria):
//   • `source` is a FACTUAL origin tag derived from the call PATH
//     (`renderer-user-action` | `agent-tool` | `test-harness`) — it is set by
//     the transport layer that owns each path, NEVER asserted by the caller /
//     agent model. The IPC handler stamps `renderer-user-action`; the api-server
//     route behind the MCP tool stamps `agent-tool`; tests stamp `test-harness`.
//   • `feature_exercise` is an explicit boolean any exercising / test path sets
//     to flag "this event was produced by exercising the feature, not by a real
//     voluntary user action" — it is an EXCLUSION tag for aggregation.
//   • VOLUNTARY ELIGIBILITY IS NOT ASSERTED AT WRITE TIME. The writer never
//     stamps a "voluntary" boolean. Eligibility is COMPUTED at aggregation time
//     (`aggregateDemand`) by EXCLUDING feature_exercise events and test-harness
//     events. This keeps the sink honest: what counts as "voluntary demand" is a
//     read-time policy, not something a writer can pre-declare.
//   • Appends are ATOMIC (one line, one `appendFileSync` write) and
//     NON-DUPLICATING: a retried append carrying the same `eventId` is a no-op.
//   • A size CAP rotates the file (one `.1` backup) so the sink can never grow
//     unbounded.
//
// Non-goals (explicitly out of scope for this WP): no aggregation UI, no intent
// inference, no renderer work. `aggregateDemand` exists only so the acceptance
// test can reproduce the three head metrics; nothing renders it yet.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { PathType } from '../../shared/types';
import { workspaceStateDir } from '../workspace-state-dir';

/** IPC channel the renderer uses to record a user-action demand-probe event. */
export const DEMAND_PROBE_RECORD_CHANNEL = 'demand-probe:record';

/** HTTP route the agent-facing MCP tool (`record_planning_event`) posts to. */
export const DEMAND_PROBE_ROUTE = '/api/demand-probe';

/** Sub-directory (under the workspace state dir) + filename for the sink. */
export const DEMAND_PROBE_DIRNAME = 'usage';
export const DEMAND_PROBE_FILENAME = 'demand-probe.jsonl';

/** Rotate once the file would exceed this size (bytes). One `.1` backup kept. */
export const DEMAND_PROBE_MAX_BYTES = 5_000_000;

/** Event kinds. Head metrics:
 *   N = proposal_authored, K = promotion_requested, M = reader/savecard opens. */
export type DemandProbeKind =
  | 'proposal_authored'
  | 'promotion_requested'
  | 'reader_open'
  | 'savecard_open';

/** FACTUAL origin, set by the transport layer — never caller-asserted. */
export type DemandProbeSource =
  | 'renderer-user-action'
  | 'agent-tool'
  | 'test-harness';

/** The on-disk JSONL record shape. */
export interface DemandProbeEvent {
  eventId: string;
  ts: string; // ISO 8601
  workspace_id: string;
  kind: DemandProbeKind;
  source: DemandProbeSource;
  /** True when this event came from an exercising/test path (excluded at agg). */
  feature_exercise: boolean;
  /** Optional free-text manual classification annotation (provenance only). */
  manual_class?: string;
}

export interface RecordDemandProbeInput {
  workspaceRoot: string;
  workspaceId: string;
  kind: DemandProbeKind;
  /** FACTUAL origin — the transport layer passes this; it is not from the model. */
  source: DemandProbeSource;
  /** Defaults to false. Set true on any exercising / test path. */
  feature_exercise?: boolean;
  manual_class?: string;
  /** Idempotency key. Reuse the SAME id across retries to make the append a
   *  no-op on the second attempt. Generated when omitted. */
  eventId?: string;
  /** Injectable clock for tests; defaults to now. */
  ts?: string;
  pathType?: PathType;
  /** Override the rotation cap (bytes). Defaults to DEMAND_PROBE_MAX_BYTES.
   *  Exists so tests can drive rotation without writing megabytes. */
  maxBytes?: number;
}

export interface RecordDemandProbeResult {
  appended: boolean;
  /** True when the eventId was already present (retry no-op). */
  duplicate: boolean;
  eventId: string;
  file: string;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<DemandProbeKind>([
  'proposal_authored',
  'promotion_requested',
  'reader_open',
  'savecard_open',
]);

/** Validate a caller-supplied kind (from HTTP/IPC boundaries). */
export function isDemandProbeKind(value: unknown): value is DemandProbeKind {
  return typeof value === 'string' && KNOWN_KINDS.has(value);
}

/** Absolute path of the demand-probe sink for a workspace. */
export function demandProbeFilePath(workspaceRoot: string, pathType: PathType = 'windows'): string {
  return path.join(
    workspaceStateDir(workspaceRoot, pathType),
    DEMAND_PROBE_DIRNAME,
    DEMAND_PROBE_FILENAME,
  );
}

/** Scan the current sink for an eventId (idempotency check). Missing file → false. */
function eventIdPresent(file: string, eventId: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return false;
  }
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    // Cheap prefilter before the JSON parse.
    if (!line.includes(eventId)) continue;
    try {
      if ((JSON.parse(line) as DemandProbeEvent).eventId === eventId) return true;
    } catch {
      // Malformed line — ignore, it can't be our idempotency match.
    }
  }
  return false;
}

/** Rotate the sink to `<file>.1` (overwriting any previous backup) when adding
 *  `incomingBytes` would push it past the cap. Best-effort; never throws. */
function rotateIfNeeded(file: string, incomingBytes: number, maxBytes: number): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // no file yet
  }
  if (size + incomingBytes <= maxBytes) return;
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    // If rotation fails we simply keep appending — the cap is a best-effort
    // disk guard, not a correctness invariant.
  }
}

/**
 * Append one demand-probe event as a single JSONL line. Idempotent by
 * `eventId`: a retry with the same id is a no-op (`{ appended:false,
 * duplicate:true }`). The write itself is a single `appendFileSync` line.
 */
export function recordDemandProbe(input: RecordDemandProbeInput): RecordDemandProbeResult {
  const pathType = input.pathType ?? 'windows';
  const eventId = input.eventId ?? crypto.randomUUID();
  const file = demandProbeFilePath(input.workspaceRoot, pathType);

  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Idempotency FIRST (on the current file), before any rotation could roll the
  // matching line out of view.
  if (eventIdPresent(file, eventId)) {
    return { appended: false, duplicate: true, eventId, file };
  }

  const event: DemandProbeEvent = {
    eventId,
    ts: input.ts ?? new Date().toISOString(),
    workspace_id: input.workspaceId,
    kind: input.kind,
    source: input.source,
    feature_exercise: input.feature_exercise === true,
    ...(input.manual_class ? { manual_class: input.manual_class } : {}),
  };
  const line = JSON.stringify(event) + '\n';

  rotateIfNeeded(file, Buffer.byteLength(line, 'utf-8'), input.maxBytes ?? DEMAND_PROBE_MAX_BYTES);
  fs.appendFileSync(file, line, 'utf-8');
  return { appended: true, duplicate: false, eventId, file };
}

/** Read + parse the current sink (malformed lines skipped). Missing file → []. */
export function readDemandProbeEvents(
  workspaceRoot: string,
  pathType: PathType = 'windows',
): DemandProbeEvent[] {
  return parseDemandProbeJsonl(safeRead(demandProbeFilePath(workspaceRoot, pathType)));
}

function safeRead(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

/** Parse a JSONL blob into events, skipping blank/malformed lines. */
export function parseDemandProbeJsonl(raw: string): DemandProbeEvent[] {
  const out: DemandProbeEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as DemandProbeEvent);
    } catch {
      // skip malformed
    }
  }
  return out;
}

export interface DemandMetrics {
  /** proposal_authored (eligible). */
  N: number;
  /** reader/savecard opens (eligible). */
  M: number;
  /** promotion_requested (eligible). */
  K: number;
  /** Events surviving the voluntary-eligibility filter. */
  eligible: number;
  /** All parsed events, before exclusions. */
  total: number;
}

/**
 * Reproduce the three head metrics from a set of events.
 *
 * VOLUNTARY ELIGIBILITY IS COMPUTED HERE, NOT AT WRITE TIME. An event counts
 * toward N/M/K only when it is voluntary-eligible, i.e. it is NEITHER a
 * feature_exercise event NOR a test-harness event. Those two exclusions are the
 * documented policy; the writer stamps only the factual `source` /
 * `feature_exercise` tags this filter reads.
 */
export function aggregateDemand(events: DemandProbeEvent[]): DemandMetrics {
  const eligible = events.filter(
    (e) => e.feature_exercise !== true && e.source !== 'test-harness',
  );
  const count = (pred: (e: DemandProbeEvent) => boolean): number => eligible.filter(pred).length;
  return {
    N: count((e) => e.kind === 'proposal_authored'),
    M: count((e) => e.kind === 'reader_open' || e.kind === 'savecard_open'),
    K: count((e) => e.kind === 'promotion_requested'),
    eligible: eligible.length,
    total: events.length,
  };
}
