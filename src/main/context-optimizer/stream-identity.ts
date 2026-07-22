// stream-identity.ts — WP9 (G9): THE pinned stream→agent identity join, extracted
// into a shared helper.
//
// The authoritative join is `behavior_events.session_id → agent_sessions
// .dashboard_agent_id → agents` — the exact shape optimizer-pipeline.ts's
// FILE_TOUCH_JOINS has always used (extracted from there; the pipeline now
// delegates here so the two sites can never drift). It is deliberately NOT routed
// through Context/Outputs `file_activities` (a different store), and identity is
// NEVER inferred from cwd or the Claude project slug: many concurrent agents map
// to one cwd/slug by design (many-agents-per-cwd invariant — CLAUDE.md), so a
// cwd-derived key is not a per-agent signal. Streams that do not resolve through
// this join stay UNRESOLVED and are surfaced in an explicit unattributed bucket —
// never dropped, never guessed.

import type { QueryDb } from './behavior-store';

/**
 * The pinned identity join fragment. LEFT joins so an unresolved row keeps its
 * COUNT (unattributed stays first-class). `agent_sessions` can carry several rows
 * per session_id; MIN(dashboard_agent_id) makes the pick deterministic.
 *
 * `evAlias` must be the alias of a `behavior_events`-shaped relation exposing
 * `session_id`. The caller composes this after its own FROM/JOIN clauses.
 */
export function streamAgentIdentityJoin(evAlias = 'ev', asxAlias = 'asx', agAlias = 'ag'): string {
  return `
  LEFT JOIN (
    SELECT session_id, MIN(dashboard_agent_id) AS dashboard_agent_id
    FROM agent_sessions GROUP BY session_id
  ) ${asxAlias} ON ${asxAlias}.session_id = ${evAlias}.session_id
  LEFT JOIN agents ${agAlias} ON ${agAlias}.id = ${asxAlias}.dashboard_agent_id
`;
}

/** Per-stream resolution outcome: streams that resolved to a dashboard agent id
 *  via the pinned join, and the honest remainder. */
export interface StreamAgentResolution {
  /** stream_id → dashboard agent id (deterministic MIN across the stream's
   *  resolvable sessions). */
  attributed: Map<string, string>;
  /** Streams with ≥1 behavior event but NO session→agent resolution. */
  unattributedStreamIds: string[];
}

/**
 * Resolve every stream that has behavior events to a dashboard agent id via the
 * pinned join — or into the unattributed bucket. The ONLY identity path; no
 * cwd/slug fallback exists here by construction.
 */
export function resolveStreamAgents(db: QueryDb): StreamAgentResolution {
  const rows = db.prepare(
    `SELECT ev.stream_id AS s, MIN(ag.id) AS agent_id
       FROM behavior_events ev
       ${streamAgentIdentityJoin('ev')}
      GROUP BY ev.stream_id
      ORDER BY ev.stream_id`,
  ).all();
  const attributed = new Map<string, string>();
  const unattributedStreamIds: string[] = [];
  for (const r of rows) {
    const streamId = String(r.s ?? '');
    if (!streamId) continue;
    if (r.agent_id == null) unattributedStreamIds.push(streamId);
    else attributed.set(streamId, String(r.agent_id));
  }
  return { attributed, unattributedStreamIds };
}
