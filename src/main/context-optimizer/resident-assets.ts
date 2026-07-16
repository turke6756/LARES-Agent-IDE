// resident-assets.ts — context-optimizer R2 WP-3 (Priority 1).
//
// Promote the two largest UNMODELED subtract opportunities into first-class,
// individually-rankable assets:
//   • an advertised skill HEADER  (resident every session so the agent can discover it)
//   • a granted MCP TOOLSET schema (already tokenized by the inventory)
//
// `buildResidentAssets` reads ONLY the static scan (walk-up skill-header sources +
// McpServerOverhead totals) — pure, no DB. `joinSkillAdvertisementUsage` joins the
// skill-advertisement assets to the lane's observed behavior spine (skill_invocations
// × stream_lane_stats), producing the honest coverage/recency signals the ranking +
// gating consume.
//
// Honesty contract (spec risks, §"Priority 1"):
//   - Scope is always the LANE advertisement, never a global "delete the skill".
//   - Skill advertisement/grant EPOCHS are not cheaply derivable, so exposure is a
//     CONSERVATIVE full-lane approximation and `exposureApproximate` is set — the
//     backing proposal is therefore surfaced UNVERIFIED (candidate) for human review.
//   - Skill invocation can be indirect/provider-specific; `usageCoveragePct` is a
//     conservative capture proxy (how often skills are observed AT ALL in the lane).
//     Low coverage BLOCKS actionable subtraction.
//   - The workspace dimension is a slug proxy (stream_lane_stats.workspace_id is
//     unpopulated — WP-2B), disclosed via `scopeMeta`; the join runs over the lane's
//     captured corpus, top-level (non-subagent) streams only (the strict exclusion tier).

import * as path from 'node:path';
import type {
  AgentContextOverhead,
  AgentRoleLane,
  ResidentAsset,
  ResidentAssetUsage,
  WorkspaceScopeMode,
} from '../../shared/types';
import type { QueryDb } from './behavior-store';

function numOf(v: unknown): number {
  return typeof v === 'number' ? v : v == null ? 0 : Number(v) || 0;
}

/** The skill name for a SKILL.md path == its owning directory basename (the same
 *  identity `buildLaneSkillIndex` / skill_invocations.skill_name use). */
function skillNameForPath(resolvedPath: string): string {
  return path.basename(path.dirname(resolvedPath.replace(/\\/g, '/')));
}

/** Build the resident-asset inventory for ONE lane's representative agent (pure).
 *  `resolveToolset(displayName)` mirrors the compiler's `mcpServerResolver` so a
 *  `mcp-toolset` asset keys by the same toolset id a `toolset-usage` action carries.
 *  Strict-excluded / zero-token servers and zero-token skill headers are OMITTED —
 *  they carry no reclaimable resident cost. */
export function buildResidentAssets(
  agent: AgentContextOverhead,
  lane: AgentRoleLane,
  resolveToolset: (displayName: string) => string | null,
): ResidentAsset[] {
  const out: ResidentAsset[] = [];

  // ── mcp-toolset assets ──
  for (const server of agent.mcpServers) {
    if (server.excludedByStrictMode) continue;
    const tokens = server.total?.tokens ?? 0;
    if (tokens <= 0) continue;
    const toolset = resolveToolset(server.displayName) ?? server.displayName;
    out.push({
      kind: 'mcp-toolset',
      toolset,
      schemaTokens: tokens,
      lane,
      members: server.tools.map((t) => t.name),
    });
  }

  // ── skill-advertisement assets (resident skill-header sources, de-duped by skill) ──
  const bySkill = new Map<string, ResidentAsset & { kind: 'skill-advertisement' }>();
  for (const s of agent.flatSources) {
    if (s.kind !== 'skill-header' || !s.resolvedPath) continue;
    const headerTokens = s.estimate?.tokens ?? 0;
    if (headerTokens <= 0) continue;
    const skillName = skillNameForPath(s.resolvedPath);
    if (!skillName) continue;
    // A skill inherited via multiple frames flattens to one advertisement; keep the
    // first (largest observed header wins on collision so sizing is not understated).
    const prior = bySkill.get(skillName);
    if (prior && prior.headerTokens >= headerTokens) continue;
    bySkill.set(skillName, {
      kind: 'skill-advertisement', skillName, headerTokens, lanes: [lane], sourcePath: s.resolvedPath,
    });
  }
  for (const a of [...bySkill.values()].sort((x, y) => (x.skillName < y.skillName ? -1 : 1))) out.push(a);

  return out;
}

export interface SkillUsageJoinOptions {
  /** The workspace scope the caller intends (disclosed, not silently trusted). Defaults
   *  to 'strict' — but see `workspaceKeyIsSlugProxy`: the spine is not workspace-
   *  partitioned, so the join runs over the lane's captured corpus regardless. */
  scopeMode?: WorkspaceScopeMode;
  /** Coverage floor (%) below which a zero-use skill-advertisement stays UNVERIFIED even
   *  before the always-on approximate-epoch gate. Conservative default. */
  coverageFloorPct?: number;
}

interface LaneSpine {
  streams: number;          // distinct top-level lane streams
  streamsWithSkills: number;// distinct top-level lane streams with ≥1 captured skill invocation
  turns: number;            // top-level turn_outcome count (exposure denominator)
  windowLo: number | null;
  windowHi: number | null;
}

function laneSpine(db: QueryDb, lane: AgentRoleLane): LaneSpine {
  const s = db.prepare(
    `SELECT COUNT(DISTINCT sls.stream_id) AS streams
       FROM stream_lane_stats sls WHERE sls.lane = ? AND sls.is_subagent = 0`,
  ).get(lane) as Record<string, unknown> | undefined;
  const w = db.prepare(
    `SELECT COUNT(*) AS turns, MIN(ev.ts_ms) AS lo, MAX(ev.ts_ms) AS hi
       FROM behavior_events ev
       JOIN stream_lane_stats sls ON sls.stream_id = ev.stream_id
      WHERE ev.kind = 'turn_outcome' AND sls.lane = ? AND sls.is_subagent = 0`,
  ).get(lane) as Record<string, unknown> | undefined;
  const sk = db.prepare(
    `SELECT COUNT(DISTINCT si.stream_id) AS s
       FROM skill_invocations si
       JOIN stream_lane_stats sls ON sls.stream_id = si.stream_id
      WHERE sls.lane = ? AND sls.is_subagent = 0`,
  ).get(lane) as Record<string, unknown> | undefined;
  return {
    streams: numOf(s?.streams),
    streamsWithSkills: numOf(sk?.s),
    turns: numOf(w?.turns),
    windowLo: w?.lo == null ? null : numOf(w.lo),
    windowHi: w?.hi == null ? null : numOf(w.hi),
  };
}

interface SkillInvAgg { uses: number; lastTs: number | null }

function skillInvocationsByName(db: QueryDb, lane: AgentRoleLane): Map<string, SkillInvAgg> {
  const rows = db.prepare(
    `SELECT si.skill_name AS skill, COUNT(*) AS uses, MAX(si.ts_ms) AS last_ts
       FROM skill_invocations si
       JOIN stream_lane_stats sls ON sls.stream_id = si.stream_id
      WHERE sls.lane = ? AND sls.is_subagent = 0
      GROUP BY si.skill_name`,
  ).all(lane) as Record<string, unknown>[];
  const m = new Map<string, SkillInvAgg>();
  for (const r of rows) m.set(String(r.skill ?? ''), { uses: numOf(r.uses), lastTs: r.last_ts == null ? null : numOf(r.last_ts) });
  return m;
}

/** Join skill-advertisement assets to the lane's observed skill invocations, yielding a
 *  `ResidentAssetUsage` per skill-advertisement asset. `mcp-toolset` assets are NOT
 *  joined here — whole-toolset deadness is already classified by the occurrence engine
 *  (the `subtract-unused-toolset` path, now schema-sized). */
export function joinSkillAdvertisementUsage(
  db: QueryDb,
  lane: AgentRoleLane,
  assets: ResidentAsset[],
  opts: SkillUsageJoinOptions = {},
): ResidentAssetUsage[] {
  const skillAssets = assets.filter((a): a is ResidentAsset & { kind: 'skill-advertisement' } => a.kind === 'skill-advertisement');
  if (skillAssets.length === 0) return [];

  const spine = laneSpine(db, lane);
  const invByName = skillInvocationsByName(db, lane);
  // Conservative capture proxy: how often skills are observed AT ALL in this lane. A lane
  // that essentially never surfaces skill usage cannot support "skill X is dead" — the
  // absence is as likely capture/provider-specific as genuine disuse.
  const coveragePct = spine.streams > 0
    ? Math.round((spine.streamsWithSkills / spine.streams) * 100)
    : 0;
  const scopeMode: WorkspaceScopeMode = opts.scopeMode ?? 'strict';

  return skillAssets.map((asset) => {
    const inv = invByName.get(asset.skillName);
    const observedUses = inv?.uses ?? 0;
    const lastUsedAt = inv?.lastTs ?? null;
    return {
      asset,
      observedUses,
      // Advertisement epochs are not derivable ⇒ conservative full-lane exposure and the
      // proposal is UNVERIFIED (candidate) by construction.
      eligibleExposureTurns: spine.turns,
      exposureApproximate: true,
      usageCoveragePct: coveragePct,
      lastUsedAt,
      zeroUseWindow: { sinceMs: lastUsedAt ?? spine.windowLo, untilMs: spine.windowHi },
      scopeMeta: {
        appliedScopeMode: scopeMode,
        // stream_lane_stats.workspace_id unpopulated (WP-2B) ⇒ workspace dimension is a
        // slug proxy; the join is lane-corpus-wide, disclosed rather than over-claimed.
        workspaceKeyIsSlugProxy: true,
        proxyIncluded: scopeMode !== 'strict',
      },
    };
  });
}
