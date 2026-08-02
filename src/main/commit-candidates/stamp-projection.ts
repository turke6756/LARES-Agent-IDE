// SC-WP-2I — immutable turn-stamp projection for Save-card attribution.
//
// The turn row is the sole attribution authority. In particular, this adapter
// never consults the mutable agents.plan_id default. Legacy/missing/invalid rows
// fail closed to the WP-1W "stamp unavailable" result.

import type { TurnRecord, TurnPlanStampSource } from '../database';
import type { WitnessStampSource } from './witness-projection';

export type TurnStampRecord = Pick<
  TurnRecord,
  'id' | 'workspaceId' | 'planId' | 'planItemId' | 'planStampSource'
>;

export type TurnStampRecordReader = (turnId: string) => TurnStampRecord | null;

const RUNTIME_STAMP_SOURCES: ReadonlySet<string> = new Set<TurnPlanStampSource>([
  'explicit',
  'agent-default',
  'fork-carry',
  'revive-carry',
  'continuation-carry',
  'explicit-none',
  'unbound-manual',
]);

/** Adapt immutable turn rows to WP-1W's optional stamp seam. */
export function createTurnStampSource(
  readTurnRecord: TurnStampRecordReader,
): WitnessStampSource {
  return (workspaceId, turnId) => {
    const row = readTurnRecord(turnId);
    if (!row || row.id !== turnId || row.workspaceId !== workspaceId) return null;
    if (!row.planStampSource || !RUNTIME_STAMP_SOURCES.has(row.planStampSource)) return null;
    return {
      planId: row.planId ?? null,
      planItemId: row.planItemId ?? null,
    };
  };
}
