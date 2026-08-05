// analytics-exporter.ts — the frozen analytics snapshot exporter (plan §2.6).
//
// ONE overhead scan and ONE optimizer analysis per snapshot, projected into every
// derived surface. That is the whole point: sequential re-analysis of a moving
// corpus produces an artifact that only LOOKS frozen. §2.5's `preScanned`
// parameter exists so per-agent knowledge extraction reuses the single scan
// rather than running N more.
//
// READ-ONLY, structurally:
//   - the caller opens SQLite with `readonly:true` + `PRAGMA query_only = ON`
//     (`initDatabaseReadOnly`, database.ts),
//   - the analyze runs with `backfillMode:'skip'`, suppressing the only writer on
//     that path,
//   - `getSharedParseManager().ensureIndexed()` is NEVER called (it is a chunked
//     background WRITER),
//   - plan metadata is read directly from the DB. The retired HTML activity
//     projection and its focus-bumping HTTP route are never used.
//
// Cold start is REFUSED by default (exit 4) rather than frozen: skipping the
// backfill on a cold DB would freeze a WRONG analysis in which every section reads
// `insufficient-exposure` and no SUBTRACT can reach `never`.

import * as fs from 'fs';
import * as nodePath from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';

import {
  getDb, getWorkspaces, getPlans, closeDatabase,
} from '../database';
import type { AgentRoleLane, ContextOptimizerResult, OverheadModel, Workspace } from '../../shared/types';
import { runOverheadScan } from '../context-overhead/ipc-deps';
import { resolveInternalGit } from '../git/git-runtime';
import { workspaceStateDir } from '../workspace-state-dir';
import { redactOverheadModel, computeOverheadGenerationId } from '../context-overhead/overhead-dto';
import { runLiveOptimizerAnalyze, type LiveOptimizerAnalyzeDeps } from '../context-optimizer/optimizer-live-analyze';
import type { PipelineDb } from '../context-optimizer/optimizer-pipeline';
import {
  buildProposalsPage, buildProposalDetail, buildProposalEvidence,
  buildClusterExemplars, buildFileHeatPage, buildAnalyzabilityPage,
} from '../context-optimizer/agent-dto-build';
import {
  buildSkillUsagePage, buildSkillUsageDetail, buildMcpToolUsagePage,
  buildAgentKnowledgePage, buildAgentKnowledgeDetail,
} from '../context-optimizer/agent-observability-build';
import { redactFileHeatPath, AGENT_DTO_CAPS } from '../context-optimizer/agent-dto';
import type { AgentDtoResponse, RedactionRoots } from '../context-optimizer/agent-dto';
import { OPTIMIZER_CONFIG } from '../context-optimizer/optimizer-config';
import { BehaviorStore } from '../context-optimizer/behavior-store';
import { buildFileSequences, type FileSequencesV1 } from '../context-optimizer/behavior-sequences';
import { annotateConfigWeight } from '../context-optimizer/section-liveness';
import { isEpochsBackfilled } from '../context-optimizer/config-epoch-backfill';
import { runKnowledgeExtract } from '../agent-knowledge/knowledge-extract-runner';
import { querySkillUsage, type QueryDb } from '../skill-analytics/queries';
import { queryMcpToolUsage } from '../skill-analytics/mcp-tool-usage-queries';
import { BACKFILL_COMPLETE_KEY, BACKFILL_VERSION_KEY } from '../skill-analytics/parse-manager';
import { PARSER_VERSION } from '../skill-analytics/parse-runner';
import { toolsetsForLane, laneUsesStrictMcp } from '../supervisor/mcp-config-builder';
import {
  scanGuidanceInventory, makeNodeGuidanceScanFs, loadGitIgnore,
  type GuidanceInventoryV1,
} from '../context-overhead/guidance-inventory';
import { makePathOps } from '../context-overhead/paths';
import { TokenEstimator } from '../context-overhead/token-estimator';

import {
  ANALYTICS_SCHEMA_VERSION, SNAPSHOT_MANIFEST_KIND, SURFACE_KEYS,
  canonicalJson, sha256Of, computeSnapshotId, planPrune, planTmpSweep, TMP_DIR_RE,
  ALL_RECORDED_HISTORY_START, buildSurfaceProvenance,
  type AnalyticsSnapshotV1, type AnalyticsSnapshotV2, type SnapshotSurface, type SurfaceError, type SurfaceKey,
  type SnapshotManifestV2, type DirEntry, type SnapshotProvenance, type LaneGrantEntry,
  type AgentKnowledgeEntry, type PlanEntry, type TableTruncationMetaV1,
  type SurfaceProvenanceV1,
} from './analytics-types';
import { buildCaveats, caveatIdsForSurface, type CaveatConditions } from './analytics-caveats';
import { renderSummaryMarkdown, renderSummaryTables } from './analytics-render';

export { renderSummaryMarkdown, renderSummaryTables } from './analytics-render';
export { diffAnalyticsSnapshots, renderDiffMarkdown, SnapshotDiffError } from './analytics-diff';
export type { AnalyticsSnapshotDiffV1 } from './analytics-diff';
export { planPrune } from './analytics-types';

/** The four lanes whose configured grant is recorded, in a stable order. */
const ALL_LANES: AgentRoleLane[] = ['supervisor', 'worker', 'researcher', 'legacy'];

/** Cursor-exhaustion safety stop. A DTO page is capped well under 1000 rows, so
 *  1000 iterations is a runaway guard, never a real limit. */
const MAX_PAGES = 1000;

export const COLD_START_MESSAGE =
  "analytics-snapshot: cold-start indexing is incomplete, so a read-only capture would "
  + "freeze a degraded analysis (every section would read 'insufficient-exposure' — "
  + 'optimizer-pipeline.ts:1034-1038). Open the dashboard once to let indexing finish, '
  + 'then re-run. Use --allow-cold to snapshot anyway; the result will be marked degraded.';

// ── errors ────────────────────────────────────────────────────────────────────

export class ExporterError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = 'ExporterError';
  }
}

/** Strip absolute paths out of an error message before it reaches an artifact.
 *  A per-item failure is recorded as data; it must not become a path side channel. */
export function sanitizeMessage(msg: string): string {
  return String(msg ?? '')
    .replace(/[A-Za-z]:[\\/][^\s'"]*/g, '<path>')
    .replace(/\/(?:home|Users|mnt\/[a-z])\/[^\s'"]*/g, '<path>');
}

// ── options + injectable deps ─────────────────────────────────────────────────

export interface AnalyticsSnapshotOptions {
  /** Workspace id or exact normalized path. Defaults to $AGENT_DASHBOARD_WORKSPACE_ID. */
  workspace?: string;
  keep: number;
  prune: boolean;
  allowCold: boolean;
  /** WP8 — `--window <days>`: restrict time-filterable queries to the last N days
   *  measured against the snapshot anchor (sinceMs = anchor − N·24h, untilMs =
   *  anchor). Surfaces whose queries have no time filter export their TRUE
   *  window on their provenance instead — producing a different comparabilityKey,
   *  never a silently-pretended one. */
  windowDays?: number;
  /** Tests/diagnostics only. Defaults to `<workspaceRoot>/.lares/analytics`. */
  outputRoot?: string;
  now?: () => Date;
  /** Test seam. Every field defaults to the production implementation. */
  deps?: Partial<ExporterDeps>;
}

export interface ExporterDeps {
  getDb(): unknown;
  getWorkspaces(): Workspace[];
  getPlans(filters: { workspaceId: string }): Array<{ id: string; title: string; status: string; updatedAt: string }>;
  runOverheadScan(workspaceId: string): OverheadModel;
  runLiveOptimizerAnalyze(deps: LiveOptimizerAnalyzeDeps): ContextOptimizerResult;
  runKnowledgeExtract(workspaceId: string, agentId: string, preScanned?: OverheadModel): ReturnType<typeof runKnowledgeExtract>;
  querySkillUsage: typeof querySkillUsage;
  queryMcpToolUsage: typeof queryMcpToolUsage;
  isEpochsBackfilled(db: unknown): boolean;
  skillIndexComplete(db: unknown): boolean;
  gitInfo(root: string): Promise<{ sha: string | null; branch: string | null; dirty: boolean | null }>;
  appVersion(): string;
  repoDir(): string;
  /** WP7 (G7): the nested guidance-inventory scan under the declared contract.
   *  Injectable so exporter tests run without touching a real filesystem. */
  runGuidanceInventoryScan(
    ws: Workspace, capturedLaunchCwds: string[]): GuidanceInventoryV1;
  /** Called as the LAST step of capture, before any filesystem publication. */
  closeDatabase(): void;
}

function productionDeps(): ExporterDeps {
  return {
    getDb: () => getDb(),
    getWorkspaces,
    getPlans: (f) => getPlans(f) as unknown as ReturnType<ExporterDeps['getPlans']>,
    runOverheadScan,
    runLiveOptimizerAnalyze,
    runKnowledgeExtract,
    querySkillUsage,
    queryMcpToolUsage,
    isEpochsBackfilled: (db) => isEpochsBackfilled(db as Parameters<typeof isEpochsBackfilled>[0]),
    skillIndexComplete: defaultSkillIndexComplete,
    gitInfo: defaultGitInfo,
    appVersion: defaultAppVersion,
    repoDir: () => nodePath.resolve(__dirname, '..', '..', '..'),
    runGuidanceInventoryScan: defaultGuidanceInventoryScan,
    closeDatabase,
  };
}

/** WP7 — production guidance-inventory scan: node-fs adapter + one-shot
 *  git-ignore load (non-git → `gitIgnoreApplied:false`, disclosed). The
 *  estimator mirrors the overhead scan's (cl100k when js-tiktoken loads,
 *  chars-heuristic fallback) so inventory token figures are comparable with
 *  the contextOverhead surface's. */
function defaultGuidanceInventoryScan(ws: Workspace, capturedLaunchCwds: string[]): GuidanceInventoryV1 {
  let encoder: ((t: string) => number) | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getEncoding } = require('js-tiktoken');
    const enc = getEncoding('cl100k_base');
    encoder = (t: string) => enc.encode(t).length;
  } catch { encoder = undefined; }
  return scanGuidanceInventory(ws.path, {
    fs: makeNodeGuidanceScanFs(),
    pathOps: makePathOps(ws.pathType as 'windows' | 'wsl'),
    estimator: new TokenEstimator({ encoder }),
    gitIgnore: loadGitIgnore(ws.path),
    capturedLaunchCwds,
  });
}

/**
 * The parse-manager backfill marker, read DIRECTLY out of `skill_analytics_meta`.
 * Deliberately does NOT construct a ParseManager: `ensureIndexed()` is a chunked
 * background writer, and merely holding the manager invites a caller to reach for
 * it. Mirrors `ParseManager.isBackfillComplete()` (parse-manager.ts:100-103): the
 * marker counts only when stamped AT the current parser version.
 */
export function defaultSkillIndexComplete(db: unknown): boolean {
  try {
    const q = db as { prepare(sql: string): { get(k: string): { v?: unknown } | undefined } };
    const at = q.prepare('SELECT v FROM skill_analytics_meta WHERE k = ?').get(BACKFILL_COMPLETE_KEY);
    if (!at || at.v == null) return false;
    const ver = q.prepare('SELECT v FROM skill_analytics_meta WHERE k = ?').get(BACKFILL_VERSION_KEY);
    return Number(ver?.v) === PARSER_VERSION;
  } catch {
    // Missing table on a pre-migration database reads as INCOMPLETE, never as
    // complete — the honest direction for a cold-start gate.
    return false;
  }
}

async function defaultGitInfo(root: string): Promise<{ sha: string | null; branch: string | null; dirty: boolean | null }> {
  // DEF-6: route through the same resolver the checkpoint engine uses
  // (resolveInternalGit) instead of a bare `git`, so attribution works on a box
  // with bundled MinGit but no *system* git. Falls back to a bare `git` only if
  // the resolver finds nothing — attribution is best-effort, never fatal.
  let gitExe = 'git';
  try {
    const internal = await resolveInternalGit();
    if (internal?.execPath) gitExe = internal.execPath;
  } catch { /* keep the bare-git fallback */ }
  const run = (args: string[]): string | null => {
    try {
      return execFileSync(gitExe, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { return null; }
  };
  const sha = run(['rev-parse', 'HEAD']);
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = run(['status', '--porcelain']);
  return { sha, branch, dirty: status === null ? null : status.length > 0 };
}

function defaultAppVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    if (app?.getVersion) return String(app.getVersion());
  } catch { /* not running under Electron (tests) — fall through */ }
  try {
    const pkg = JSON.parse(fs.readFileSync(nodePath.resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    return String(pkg.version ?? 'unknown');
  } catch { return 'unknown'; }
}

// ── workspace resolution (step 1) ─────────────────────────────────────────────

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function resolveWorkspace(workspaces: Workspace[], requested: string | undefined): Workspace {
  const want = requested ?? process.env.AGENT_DASHBOARD_WORKSPACE_ID ?? '';
  const list = () => workspaces.map((w) => `  ${w.id}  ${w.path}`).join('\n');
  if (!want) {
    throw new ExporterError(
      'analytics-snapshot: no workspace given and $AGENT_DASHBOARD_WORKSPACE_ID is unset. '
      + `Pass --workspace <id-or-exact-path>. Known workspaces:\n${list()}`, 1);
  }
  const byId = workspaces.filter((w) => w.id === want);
  if (byId.length === 1) return byId[0];
  const byPath = workspaces.filter((w) => normalizePath(w.path) === normalizePath(want));
  if (byPath.length === 1) return byPath[0];
  if (byId.length > 1 || byPath.length > 1) {
    throw new ExporterError(
      `analytics-snapshot: '${want}' is ambiguous. Known workspaces:\n${list()}`, 1);
  }
  throw new ExporterError(
    `analytics-snapshot: no workspace matches '${want}' by exact id or exact path. `
    + `Known workspaces:\n${list()}`, 1);
}

// ── DTO cursor exhaustion ─────────────────────────────────────────────────────

/**
 * Drain a cursor-paginated list builder. Every page's `generationId` is folded
 * into `genIds`; the caller asserts the set is a singleton. A DTO error on ANY
 * page is a capture bug, not a caveat — it aborts.
 */
function exhaust<T>(
  label: string,
  genIds: Set<string>,
  build: (cursor: string | undefined) => AgentDtoResponse<T[]>,
): T[] {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = build(cursor);
    if (!res.ok) {
      throw new ExporterError(
        `analytics-snapshot: ${label} page ${page} failed: ${res.error.code} — ${sanitizeMessage(res.error.message)}`, 1);
    }
    genIds.add(res.meta.generationId);
    out.push(...res.data);
    if (!res.page?.hasMore || !res.page.nextCursor) return out;
    cursor = res.page.nextCursor;
  }
  throw new ExporterError(`analytics-snapshot: ${label} did not exhaust within ${MAX_PAGES} pages`, 1);
}

// Drive-letter, POSIX/WSL-mount, and UNC forms. The UNC arm is load-bearing: agent
// stream ids are absolute `.jsonl` paths, and a WSL-hosted agent's is
// `\\wsl.localhost\Ubuntu\home\<user>\…`, which matches neither of the other two —
// it escaped the belt completely and reached the file verbatim.
const ABS_PATH_TOKEN =
  /[A-Za-z]:[\\/][^\s'"]*|\\\\[^\s'"\\]+\\[^\s'"]*|\/(?:home|Users|mnt\/[a-z])\/[^\s'"]*/g;

/**
 * A Claude project slug is a LOSSLESS, trivially reversible encoding of an absolute
 * working directory — `makeClaudeProjectSlug` (claude-jsonl-reader.ts:51-53) only
 * rewrites `[/\\:_.]` to `-`. So `C--Users-u-Projects-W--dashboard-supervisor` still
 * carries the drive, the username and the workspace root, and `redactFileHeatPath`
 * never sees it as a path: it survives verbatim both inside a redacted stream id
 * (`~/.claude/projects/<slug>/<uuid>.jsonl`) and as a bare `slug` / `workspaceKey`
 * value on the skill-usage surface. That made the REDACTION_IS_LOSSY promise false.
 *
 * The token matches only the encoded-absolute-root FORMS a slug can start with — a
 * drive letter (`c--`), a UNC root (`--wsl-`), or a POSIX root (`-home-`/`-mnt-`/
 * `-users-`) — each anchored by a lookbehind so an ordinary hyphenated word
 * (`back-home-again`, `re-mnt-x`) can never match.
 */
const SLUG_TOKEN =
  /(?<![A-Za-z0-9-])(?:[A-Za-z]--|--wsl-|-(?:home|mnt|users)-)[A-Za-z0-9._]+(?:-+[A-Za-z0-9._]+)*/gi;

/**
 * Stable, case-folded digest of one project slug. Stable so distinct projects stay
 * distinguishable ACROSS snapshots and in `diff`; case-folded so the raw-cased
 * `workspaceKey` (`C--Users-…`) and the lowercased in-path form (`c--users-…`) — the
 * same project — collapse to the same token and still join.
 */
export function hashProjectSlug(slug: string): string {
  return `<slug-${sha256Of(slug.toLowerCase()).slice(0, 8)}>`;
}

/**
 * Mirror of `makeClaudeProjectSlug` (claude-jsonl-reader.ts:51-53). Kept local so the
 * exporter — which runs under plain node in tests — does not pull that reader's WSL /
 * Electron discovery chain in for a one-line string rewrite.
 */
export function claudeProjectSlug(workingDirectory: string): string {
  return workingDirectory.replace(/[/\\:_.]/g, '-');
}

/** The `<slug>` segment of a `.claude/projects/<slug>/…` id, either separator, either
 *  redaction state (`~/.claude/projects/…` or a still-absolute `C:\…\.claude\projects\…`). */
const PROJECT_SLUG_IN_PATH = /[\\/]\.claude[\\/]projects[\\/]([^\\/]+)/i;

/**
 * Is this string a stream id rooted in a project OTHER than the snapshot's workspace?
 *
 * Behaviour evidence is scored over the whole Claude corpus on the machine, so a
 * strict-scope proposal's exposure denominator legitimately spans other workspaces.
 * The aggregate is wanted; the identifiers are not — an id naming an unrelated
 * project has no business in this workspace's artifact.
 */
export function isForeignStreamId(value: string, localSlugPrefix: string): boolean {
  const m = PROJECT_SLUG_IN_PATH.exec(value);
  if (!m) return false;
  const slug = m[1].toLowerCase();
  const prefix = localSlugPrefix.toLowerCase();
  if (!slug.startsWith(prefix)) return true;
  // Prefix-only is not enough: `…-AgentDashboardOld` starts with `…-AgentDashboard`.
  return slug.length !== prefix.length && slug[prefix.length] !== '-';
}

/**
 * Drop foreign-workspace stream ids from the capped SAMPLE lists.
 *
 * Only two element shapes are ever removed: a bare stream-id string, and an object
 * carrying a `streamId` (`denominator.sampledStreams[]`, `numerator.sampledEvents[]`,
 * `attribution.streamIds[]`). Nothing else is filtered — in particular a per-workspace
 * breakdown ROW is a statistic, not an identifier list, and is left alone.
 *
 * These lists are samples, capped at `EVIDENCE_SAMPLE_STREAMS_CAP` upstream
 * (context-optimizer.ts:628-632); every aggregate beside them
 * (`denominator.turns/streams/slugs`, `numerator.occurrences/streams`, `exposure.*`)
 * is computed independently of the sample, so shrinking the sample distorts no
 * statistic. The count of removals raises FOREIGN_WORKSPACE_STREAM_IDS_DROPPED so the
 * shortfall is disclosed rather than silent.
 */
export function dropForeignStreamIds<T>(
  value: T,
  localSlugPrefix: string,
  counter: { dropped: number },
): T {
  const isForeignElement = (el: unknown): boolean => {
    if (typeof el === 'string') return isForeignStreamId(el, localSlugPrefix);
    if (el && typeof el === 'object') {
      const sid = (el as { streamId?: unknown }).streamId;
      return typeof sid === 'string' && isForeignStreamId(sid, localSlugPrefix);
    }
    return false;
  };
  if (Array.isArray(value)) {
    const kept = value.filter((el) => {
      if (!isForeignElement(el)) return true;
      counter.dropped += 1;
      return false;
    });
    return kept.map((el) => dropForeignStreamIds(el, localSlugPrefix, counter)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = dropForeignStreamIds(v, localSlugPrefix, counter);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Deep path-redaction belt for surfaces built from DTOs that keep absolute paths.
 *
 * `buildProposalDetail` returns the raw `ContextOptimizerProposal`, whose
 * `target.absPath` and `citations[].absPath` are absolute (agent-dto-build.ts:448-470),
 * and the HTTP route serves them that way. That is tolerable for an ephemeral
 * response; it is NOT tolerable in a file. Fork 4 is explicit that files are the
 * most copy-pasteable artifact in the system and the wrong place to relax the
 * boundary, and §6 test 4 asserts NO emitted artifact carries a drive prefix.
 *
 * Every absolute-path token in a string leaf becomes its scope-prefixed display
 * form (`$WORKSPACE/CLAUDE.md`), so the value stays actionable while the drive,
 * the username, and the workspace root do not survive. Numbers, line spans, ids,
 * verdicts and `verified:false` pass through untouched.
 *
 * Then every Claude project SLUG becomes `<slug-xxxxxxxx>`. The shared redactor is
 * blind to slugs (they are not path-shaped), so a redacted stream id still read
 * `~/.claude/projects/c--users-<user>-projects-<root>--dashboard-supervisor/…` — a
 * lossless encoding of the very workspace root REDACTION_IS_LOSSY promises is
 * unrecoverable. Hashing here belts the FILE only; `redactFileHeatPath`
 * (agent-dto.ts:542) is untouched, so the live IPC route's output is unchanged.
 *
 * Object KEYS are redacted with the same rule as leaves. `proposalDetails` and
 * `proposalEvidence` are maps keyed by proposal id, and a proposal id embeds the
 * target's absolute path (`subtract-dead-guidance:…:markdown_section:<absPath>:h:…`).
 * Redacting only the values left those keys raw — both a leak and a join break,
 * since `proposals[].id` (a value) WAS redacted and no longer matched its own key.
 */
export function redactPathsDeep<T>(value: T, roots: RedactionRoots): T {
  if (typeof value === 'string') {
    return value
      .replace(ABS_PATH_TOKEN, (m) => redactFileHeatPath(m, roots).pathDisplay)
      .replace(SLUG_TOKEN, (m) => hashProjectSlug(m)) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => redactPathsDeep(v, roots)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[redactPathsDeep(k, roots)] = redactPathsDeep(v, roots);
    }
    return out as unknown as T;
  }
  return value;
}

/** `exhaust` for DTOs whose page payload is an object wrapping the row array
 *  (SkillUsagePage.skills, AgentKnowledgePage.nodes) rather than a bare array. */
function exhaustFrom<P, T>(
  label: string,
  genIds: Set<string>,
  build: (cursor: string | undefined) => AgentDtoResponse<P>,
  pick: (data: P) => T[],
): T[] {
  return exhaust<T>(label, genIds, (cursor) => {
    const res = build(cursor);
    if (!res.ok) return res;
    return { ...res, data: pick(res.data) };
  });
}

function surface<T>(
  status: SnapshotSurface<T>['status'],
  generationId: string,
  data: T | null,
  errors: SurfaceError[],
  caveatIds: string[],
  provenance?: SurfaceProvenanceV1,
): SnapshotSurface<T> {
  return { status, generationId, data, errors, caveatIds, ...(provenance ? { provenance } : {}) };
}

// ── capture (plan §2.6) ───────────────────────────────────────────────────────

export async function captureAnalyticsSnapshot(o: AnalyticsSnapshotOptions): Promise<AnalyticsSnapshotV2> {
  const d: ExporterDeps = { ...productionDeps(), ...(o.deps ?? {}) };
  const clock = o.now ?? (() => new Date());

  // 1. Resolve the workspace.
  const ws = resolveWorkspace(d.getWorkspaces(), o.workspace);
  const db = d.getDb();

  // 2. Stamp ONE clock. Every downstream call gets this nowMs; the completion
  //    stamp is taken once at the end (the interval is exactly what
  //    FILESYSTEM_CAPTURE_NOT_ATOMIC discloses).
  const started = clock();
  const captureStartedAtIso = started.toISOString();
  const nowMs = started.getTime();
  // WP8 — THE snapshot anchor: computed once, here, and passed to every surface
  // builder. A long-running export cannot give surfaces drifting "now"s; every
  // surface's provenance.snapshotAnchor is this exact value, and the --window
  // arithmetic below is measured against it.
  const snapshotAnchorIso = captureStartedAtIso;
  const windowSinceMs = o.windowDays !== undefined ? nowMs - o.windowDays * 86_400_000 : undefined;

  // 3. Cold-state gate.
  const epochsBackfilled = safeBool(() => d.isEpochsBackfilled(db));
  const skillIndexComplete = safeBool(() => d.skillIndexComplete(db));
  const cold = !epochsBackfilled || !skillIndexComplete;
  if (cold && !o.allowCold) throw new ExporterError(COLD_START_MESSAGE, 4);

  // 4. Lane grant matrix — from the grant FUNCTIONS, never the scan, never hard-coded.
  const laneGrantMatrix = {} as Record<AgentRoleLane, LaneGrantEntry>;
  for (const lane of ALL_LANES) {
    laneGrantMatrix[lane] = {
      toolsets: toolsetsForLane(lane).split(',').map((s) => s.trim()).filter(Boolean),
      strictMcp: laneUsesStrictMcp(lane),
    };
  }

  // 5. runOverheadScan — EXACTLY ONCE. Every later consumer reuses `model`.
  let model: OverheadModel;
  try {
    model = d.runOverheadScan(ws.id);
  } catch (err) {
    throw new ExporterError(
      `analytics-snapshot: the context-overhead scan failed, so nothing was published: `
      + sanitizeMessage((err as Error).message), 1);
  }

  const roots: RedactionRoots = {
    workspaceRoot: ws.path,
    dashboardRoot: workspaceStateDir(ws.path),
    homeDir: os.homedir(),
  };

  // The single emission belt. Foreign-workspace ids are dropped FIRST — the test is
  // `slug startsWith slugify(workspaceRoot)`, which only holds while the slug is
  // still legible — and the survivors are then path- and slug-redacted.
  const localSlugPrefix = claudeProjectSlug(ws.path);
  const foreignIds = { dropped: 0 };
  const belt = <T>(v: T): T => redactPathsDeep(dropForeignStreamIds(v, localSlugPrefix, foreignIds), roots);

  // 5b. WP7 (G7) — the nested guidance inventory, scanned ONCE under the
  // declared contract. Captured launch cwds come from the ONE overhead scan —
  // the only signal that puts a nested file on a chain (WP2 semantics). A
  // thrown scan is recorded as a surface error, never a silent absence.
  let guidanceInventory: GuidanceInventoryV1 | null = null;
  let guidanceScanError: SurfaceError | null = null;
  try {
    guidanceInventory = d.runGuidanceInventoryScan(ws, model.agents.map((a) => a.workingDir));
  } catch (err) {
    guidanceScanError = {
      code: 'GUIDANCE_INVENTORY_SCAN_FAILED',
      message: sanitizeMessage((err as Error).message),
    };
  }

  // 6. runLiveOptimizerAnalyze — EXACTLY ONCE, strict scope, non-writing.
  let result: ContextOptimizerResult;
  try {
    result = d.runLiveOptimizerAnalyze({
      workspaceId: ws.id,
      db: db as PipelineDb,
      repoDir: d.repoDir(),
      generatedAtIso: captureStartedAtIso,
      nowMs,
      query: { workspaceId: ws.id, scopeMode: 'strict', includeOperationalNoise: true },
      backfillMode: 'skip',
    });
  } catch (err) {
    throw new ExporterError(
      `analytics-snapshot: the optimizer analysis failed, so nothing was published: `
      + sanitizeMessage((err as Error).message), 1);
  }

  // 6b. WP5 (G5) — join the optimizer's occurrence verdicts onto the overhead
  // model's config-weight sections (key-equality on the shared section identity;
  // section-liveness.ts). Structural `weightClass` is untouched — this adds the
  // SEPARATE `behaviorStatus` axis + `tokensByBehavior` before redaction, so the
  // exported surface carries both axes. Honest absence: with no section-keyed
  // verdicts (result.sectionBehavior missing) the model is left untouched and
  // the 'section-behavior-status' capability is NOT declared.
  const sectionBehavior = result.sectionBehavior ?? [];
  if (sectionBehavior.length > 0) {
    for (const agent of model.agents) {
      if (agent.configWeight) {
        agent.configWeight = annotateConfigWeight(agent.configWeight, sectionBehavior).rollup;
      }
    }
    if (model.workspaceConfigWeight) {
      model.workspaceConfigWeight = annotateConfigWeight(model.workspaceConfigWeight, sectionBehavior).rollup;
    }
  }

  // 7. Project EVERY optimizer surface from that ONE result.
  const optGenIds = new Set<string>();
  const proposals = exhaust('optimizer proposals', optGenIds,
    (cursor) => buildProposalsPage(result, { cursor, includeUnverified: true }));

  const proposalDetails: Record<string, unknown> = {};
  const proposalEvidence: Record<string, unknown> = {};
  for (const p of proposals) {
    const detail = buildProposalDetail(result, p.id, { includePatch: false });
    if (detail.ok) { optGenIds.add(detail.meta.generationId); proposalDetails[p.id] = detail.data; }
    // An evidence-less proposal returns INVALID_ARGUMENT by design (legacy /
    // static-config rows carry no behavior evidence). That is an absence, not a
    // failure — record nothing and move on.
    const evidence = buildProposalEvidence(result, p.id);
    if (evidence.ok) { optGenIds.add(evidence.meta.generationId); proposalEvidence[p.id] = evidence.data; }
  }

  // Cluster exemplars ONLY for proposals that advertise a drillable cluster
  // reference — not capped at an arbitrary N (Fork 2).
  const clusterExemplars: Record<string, unknown> = {};
  const clusterStore = new BehaviorStore(db as ConstructorParameters<typeof BehaviorStore>[0]);
  const clusterProposalIds: string[] = [];
  for (const p of result.proposals) {
    if (p.target?.rollup?.hasDrillableMembers !== true) continue;
    clusterProposalIds.push(p.id);
    const collected: unknown[] = [];
    let cursor: string | undefined;
    let rollupMeta: unknown = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = buildClusterExemplars(result, clusterStore, p.id, { cursor });
      if (!res.ok) break;                 // not drillable in practice — an absence
      optGenIds.add(res.meta.generationId);
      collected.push(...res.data.exemplars);
      rollupMeta = res.data.rollup;
      if (!res.page?.hasMore || !res.page.nextCursor) break;
      cursor = res.page.nextCursor;
    }
    if (collected.length > 0 || rollupMeta) {
      clusterExemplars[p.id] = { rollup: rollupMeta, exemplars: collected };
    }
  }

  const fileHeatHot = exhaust('file heat (hot)', optGenIds,
    (cursor) => buildFileHeatPage(result, roots, { cursor, view: 'hot', includeOperationalNoise: true }));
  const fileHeatGuidanceGaps = exhaust('file heat (guidance-gaps)', optGenIds,
    (cursor) => buildFileHeatPage(result, roots, { cursor, view: 'guidance-gaps', includeOperationalNoise: true }));
  const analyzability = exhaust('analyzability', optGenIds,
    (cursor) => buildAnalyzabilityPage(result, roots, { cursor }));

  // A generationId mismatch means the surfaces are NOT projections of one
  // analysis. That is a capture bug, not something to caveat — fail (§2.6 step 7).
  if (optGenIds.size > 1) {
    throw new ExporterError(
      'analytics-snapshot: optimizer surfaces disagreed on generationId '
      + `(${[...optGenIds].map((g) => g.slice(0, 12)).join(', ')}). The snapshot would not be `
      + 'a single frozen analysis, so nothing was published.', 1);
  }
  const optimizerGenerationId = [...optGenIds][0]
    ?? sha256Of({ empty: 'optimizer', workspaceId: ws.id });

  const optimizerMeta = buildProposalsPage(result, { includeUnverified: true });

  // 7b. WP9 (G9) — the fileSequences block, computed ONCE over the same read-only
  // db and stamped with the frozen optimizer generationId (the WP3 lift is gated
  // on that id — prospective only). A thrown build is recorded as a surface
  // error, never a silent absence; identity inside the block resolves ONLY via
  // the pinned stream-identity join (unresolved → unattributedStreams).
  let fileSequences: FileSequencesV1 | null = null;
  const fileSequencesErrors: SurfaceError[] = [];
  try {
    fileSequences = buildFileSequences(
      db as Parameters<typeof buildFileSequences>[0], { generationId: optimizerGenerationId });
  } catch (err) {
    fileSequencesErrors.push({
      code: 'FILE_SEQUENCES_BUILD_FAILED',
      message: sanitizeMessage((err as Error).message),
    });
  }

  // 8. Skill usage + MCP tool usage — ONE query each, straight at the read layer.
  //    ensureIndexed() is deliberately NOT called: it writes.
  //    WP8: --window is applied uniformly against the anchor to every query that
  //    HAS a time filter (these two). The applied window is read back off each
  //    result's scopeMeta when building surface provenance — server-witnessed,
  //    never assumed from the flag.
  const windowFilter = windowSinceMs !== undefined ? { sinceMs: windowSinceMs, untilMs: nowMs } : {};
  const skillGenIds = new Set<string>();
  const skillResult = d.querySkillUsage(db as QueryDb, { workspaceId: ws.id, scopeMode: 'strict', ...windowFilter });
  const skillRows = exhaustFrom('skill usage', skillGenIds,
    (cursor) => buildSkillUsagePage(skillResult, { cursor }), (d2) => d2.skills);
  const skillDetails: Record<string, unknown> = {};
  for (const row of skillRows) {
    const det = buildSkillUsageDetail(skillResult, row.id);
    if (det.ok) skillDetails[row.id] = det.data;
  }
  const skillMeta = buildSkillUsagePage(skillResult, {});

  // The strict-workspace MCP scope — explicit here AND declared on the surface's
  // provenance (population.filters carries 'mcpScope:strict-workspace').
  const mcpResult = d.queryMcpToolUsage(db as QueryDb, { workspaceId: ws.id, scopeMode: 'strict', ...windowFilter });
  const mcpPage = buildMcpToolUsagePage(mcpResult, {});

  // WP8 — per-surface provenance, all six from the ONE anchor. The skill/mcp
  // windows come off the results' scopeMeta (what the query actually applied),
  // so a query that ignored the requested window honestly exports its TRUE window.
  const surfaceProvenances = buildSurfaceProvenances({
    anchorIso: snapshotAnchorIso,
    workspaceId: ws.id,
    skillWindow: {
      sinceMs: (skillResult.scopeMeta as { windowSinceMs?: number | null } | undefined)?.windowSinceMs ?? null,
      untilMs: (skillResult.scopeMeta as { windowUntilMs?: number | null } | undefined)?.windowUntilMs ?? null,
    },
    mcpWindow: {
      sinceMs: (mcpResult.scopeMeta as { windowSinceMs?: number | null } | undefined)?.windowSinceMs ?? null,
      untilMs: (mcpResult.scopeMeta as { windowUntilMs?: number | null } | undefined)?.windowUntilMs ?? null,
    },
  });

  // 9. Agent knowledge for EVERY agent in the overhead model, reusing the SINGLE
  //    pre-scanned model (§2.5). Without it this would be N more scans, each a
  //    different one.
  const knowledgeEntries: AgentKnowledgeEntry[] = [];
  const knowledgeErrors: SurfaceError[] = [];
  for (const agent of model.agents) {
    try {
      const graph = d.runKnowledgeExtract(ws.id, agent.id, model);
      const nodes = exhaustFrom(`agent knowledge ${agent.id}`, new Set<string>(),
        (cursor) => buildAgentKnowledgePage(graph, roots, { cursor }), (d2) => d2.nodes);
      const details: Record<string, unknown> = {};
      for (const n of nodes) {
        const det = buildAgentKnowledgeDetail(graph, roots, n.id);
        if (det.ok) details[n.id] = det.data;
      }
      const page = buildAgentKnowledgePage(graph, roots, {});
      knowledgeEntries.push({
        agentId: agent.id,
        agentName: agent.name,
        nodes,
        details,
        meta: page.ok ? page.meta : null,
      });
    } catch (err) {
      knowledgeErrors.push({
        code: 'KNOWLEDGE_EXTRACT_FAILED',
        message: sanitizeMessage((err as Error).message),
        itemId: agent.id,
      });
    }
  }

  // 10. Plans — metadata composed DIRECTLY. The legacy section/activity fields
  // stay empty/null for schema compatibility and never touch retired tables.
  const planEntries: PlanEntry[] = [];
  const planErrors: SurfaceError[] = [];
  for (const plan of d.getPlans({ workspaceId: ws.id })) {
    try {
      planEntries.push({
        plan: {
          id: plan.id,
          // `Plan` carries no title (types.ts:87-99). The slug is the display alias;
          // fall back to the workspace-RELATIVE path, which is already root-free.
          title: plan.title,
          status: plan.status,
          updatedAt: plan.updatedAt,
        },
        sections: [],
        activity: null,
      });
    } catch (err) {
      planErrors.push({
        code: 'PLAN_PROJECTION_FAILED',
        message: sanitizeMessage((err as Error).message),
        itemId: plan.id,
      });
    }
  }

  // ── the belt runs BEFORE the caveats ──
  // Every surface payload is redacted here, ahead of `buildCaveats`, because the belt
  // is what produces `foreignIds.dropped` — and that count is a caveat CONDITION.
  // Building the caveats first would have reported "nothing dropped" on every run.
  // `redactOverheadModel` redacts display paths but keeps each source's `id`
  // (`<absPath>#<anchor>`, the route's stable join key) absolute — tolerable in an
  // ephemeral HTTP response, not in a file. Belt it here rather than changing the
  // live route's DTO contract.
  const overheadData = belt(redactOverheadModel(model, roots));
  // File-heat and analyzability are already redacted by their builders (they take
  // `roots`); proposals/details/evidence/exemplars are not, so the whole block goes
  // through the belt. Idempotent on already-redacted values.
  const optimizerData = belt({
    proposals: proposals as unknown[],
    proposalDetails, proposalEvidence, clusterExemplars,
    fileHeatHot: fileHeatHot as unknown[],
    fileHeatGuidanceGaps: fileHeatGuidanceGaps as unknown[],
    analyzability: analyzability as unknown[],
    meta: optimizerMeta.ok ? optimizerMeta.meta : null,
    // WP9 — redacted by the same belt as every other optimizer payload (paths in
    // co-touch/predecessor/association rows become scope-prefixed display forms).
    fileSequences,
  });
  const skillUsageData = belt({
    rows: skillRows as unknown[], details: skillDetails, meta: skillMeta.ok ? skillMeta.meta : null,
  });
  // `byWorkspace`/`bySession` group KEYS are project slugs, so this surface needs the
  // belt too. Its rows are `McpUsageGroupRow` (key/label/count, types.ts:1998-2003) —
  // no `streamId`, so the foreign-id drop cannot reach a statistic row here.
  const mcpToolUsageData = belt({
    rollup: mcpPage.ok ? mcpPage.data : null, meta: mcpPage.ok ? mcpPage.meta : null,
  });
  const agentKnowledgeData = belt(knowledgeEntries);
  const plansData = belt(planEntries);

  // ── caveats ──
  const conditions: CaveatConditions = {
    epochsBackfilled,
    skillIndexComplete,
    estimatorMethod: String(model.estimatorMethod),
    gitShaAvailable: false,   // replaced below once git is probed
    // Proposal ids embed the target's absolute path, and these ids are echoed
    // verbatim into `caveats[].matchedIds` — which reach manifest.json and
    // SUMMARY.md. Redact at the source so all three renderings agree with the
    // (also-redacted) ids on the optimizer surface.
    clusterRollupProposalIds: redactPathsDeep(clusterProposalIds, roots),
    unverifiedProposalIds: redactPathsDeep(
      result.proposals.filter((p) => p.verification?.verified !== true).map((p) => p.id),
      roots),
    foreignStreamIdsDropped: foreignIds.dropped,
    // WP2 — any analyzed AGENTS.md lacking `complete` capture coverage keeps the
    // audience caveat observed (no enumeration seam exists yet, so all of them).
    agentsMdSourcesWithoutCompleteCoverage: countAnalyzedAgentsMdWithoutCompleteCoverage(model),
    // WP8 — the computed keys drive the ONLY cross-surface-caveat downgrade path.
    surfaceComparabilityKeys: Object.fromEntries(
      SURFACE_KEYS.map((k) => [k, surfaceProvenances[k].comparabilityKey]),
    ) as Record<SurfaceKey, string>,
  };
  const git = await d.gitInfo(ws.path);
  conditions.gitShaAvailable = git.sha !== null;
  const caveats = buildCaveats(conditions);

  const provenance: SnapshotProvenance = {
    workspace: { id: ws.id, root: '$WORKSPACE', pathType: ws.pathType as 'windows' | 'wsl' },
    workspaceGitSha: git.sha,
    workspaceGitBranch: git.branch,
    workspaceGitDirty: git.dirty,
    appVersion: d.appVersion(),
    exporterVersion: 1,
    databaseMode: 'readonly-query-only',
    backfillMode: 'skip',
    scopeMode: 'strict',
    redactionPolicy: 'agent-safe-v1',
    laneGrantMatrix,
    indexState: { epochsBackfilled, skillIndexComplete },
    generationIds: {},
    // WP6 (G6): machine-readable truncation disclosure for the two tables with a
    // declared pagination contract — never conflatable with a full drain.
    tableTruncation: computeTableTruncation({
      fileHeatRowsEmitted: fileHeatHot.length,
      fileHeatPopulation: result.meta.fileHeatPopulation,
      mcpByToolRowsEmitted: mcpPage.ok ? mcpPage.data.byTool.length : 0,
      mcpByToolPopulation: mcpResult.byTool.length,
      // WP9 — file-sequences.csv carries the block's three top-k'd lists.
      fileSequences,
    }),
    // WP8 — the one clock stamp every builder received, plus the requested
    // window (disclosed even when no query could honor it — each surface's TRUE
    // window lives on its own provenance).
    snapshotAnchor: snapshotAnchorIso,
    requestedWindowDays: o.windowDays ?? null,
  };

  // ── surface assembly ──
  const cav = (k: SurfaceKey): string[] => caveatIdsForSurface(caveats, k);
  const optimizerDegraded = !epochsBackfilled;
  const usageDegraded = !skillIndexComplete;

  const overheadGenerationId = computeOverheadGenerationId(model);
  const knowledgeGenerationId = sha256Of(knowledgeEntries.map((e) => [e.agentId, e.meta?.generationId ?? null]));
  const planGenerationId = sha256Of(planEntries.map((e) => [e.plan.id, e.sections]));

  // WP8 — cross-surface evidence in WP3 drafts requires surface provenance to
  // exist first (milestone gate 4). Now that it does, stamp each draft evidence
  // entry with the optimizer surface's comparabilityKey (every draft evidence row
  // is an optimizer-surface row by construction — recommendation-draft.ts bars
  // anything else). v2-optional field under the 'surface-provenance' capability.
  const optimizerDataStamped = stampRecommendationEvidenceComparability(
    optimizerData, surfaceProvenances.optimizer.comparabilityKey);

  const surfaces: AnalyticsSnapshotV2['surfaces'] = {
    contextOverhead: surface(
      overheadData.agents.length === 0 ? 'empty' : 'ready',
      overheadGenerationId, overheadData, [], cav('contextOverhead'), surfaceProvenances.contextOverhead),
    optimizer: surface(
      optimizerDegraded ? 'degraded' : proposals.length === 0 && fileHeatHot.length === 0 ? 'empty' : 'ready',
      optimizerGenerationId, optimizerDataStamped, fileSequencesErrors, cav('optimizer'),
      surfaceProvenances.optimizer),
    skillUsage: surface(
      usageDegraded ? 'degraded' : skillRows.length === 0 ? 'empty' : 'ready',
      [...skillGenIds][0] ?? sha256Of({ empty: 'skillUsage' }),
      skillUsageData, [], cav('skillUsage'), surfaceProvenances.skillUsage),
    mcpToolUsage: surface(
      usageDegraded ? 'degraded' : mcpPage.ok && mcpPage.data.byTool.length > 0 ? 'ready' : 'empty',
      mcpPage.ok ? mcpPage.meta.generationId : sha256Of({ empty: 'mcpToolUsage' }),
      mcpToolUsageData,
      mcpPage.ok ? [] : [{ code: mcpPage.error.code, message: sanitizeMessage(mcpPage.error.message) }],
      cav('mcpToolUsage'), surfaceProvenances.mcpToolUsage),
    agentKnowledge: surface(
      knowledgeErrors.length > 0 ? 'partial' : knowledgeEntries.length === 0 ? 'empty' : 'ready',
      knowledgeGenerationId, agentKnowledgeData, knowledgeErrors, cav('agentKnowledge'),
      surfaceProvenances.agentKnowledge),
    plans: surface(
      planErrors.length > 0 ? 'partial' : planEntries.length === 0 ? 'empty' : 'ready',
      planGenerationId, plansData, planErrors, cav('plans'), surfaceProvenances.plans),
  };

  // WP7 (G7) — the guidance-inventory surface (v2-OPTIONAL, capability
  // 'guidance-inventory'), with WP8 provenance from the SAME anchor as every
  // other surface. `partial` = the scan itself says it is incomplete
  // (budget-stopped) — the metadata carries the stopped reason and never a
  // fabricated remainder count. `gitIgnore` is a population filter: an
  // applied-vs-not-applied scan measures a different file population, so the
  // comparabilityKey differs by construction.
  const guidanceProvenance = buildSurfaceProvenance({
    workspaceScope: { workspaceId: ws.id, scopeMode: 'strict-workspace' },
    population: {
      lanes: [],
      providers: ['any-registered-agent'],
      captureSources: ['filesystem-scan'],
      filters: [
        'containment:workspace-root',
        'symlinks:not-followed',
        `gitIgnore:${guidanceInventory?.scan.gitIgnoreApplied ? 'applied' : 'not-applied'}`,
      ],
    },
    windowStart: snapshotAnchorIso, windowEnd: snapshotAnchorIso, snapshotAnchor: snapshotAnchorIso,
  });
  const guidanceGenerationId = sha256Of({ surface: 'guidanceInventory', data: guidanceInventory });
  surfaces.guidanceInventory = surface(
    guidanceScanError ? 'error'
      : !guidanceInventory ? 'empty'
        : !guidanceInventory.scan.scanComplete ? 'partial'
          : guidanceInventory.entries.length === 0 ? 'empty' : 'ready',
    guidanceGenerationId,
    guidanceInventory ? belt(guidanceInventory) : null,
    guidanceScanError ? [guidanceScanError] : [],
    caveatIdsForSurface(caveats, 'guidanceInventory'),
    guidanceProvenance);

  for (const k of SURFACE_KEYS) provenance.generationIds[k] = surfaces[k].generationId;
  provenance.generationIds.guidanceInventory = guidanceGenerationId;

  // 11. Digests.
  const snapshot: AnalyticsSnapshotV2 = {
    schemaVersion: ANALYTICS_SCHEMA_VERSION as 2,
    capabilities: snapshotCapabilities(
      model, { proposals: result.proposals, fileHeat: result.fileHeat }, surfaceProvenances,
      guidanceInventory, fileSequences),
    snapshotId: '',
    captureStartedAtIso,
    captureCompletedAtIso: clock().toISOString(),
    provenance,
    caveats,
    surfaces,
  };
  snapshot.snapshotId = computeSnapshotId(snapshot);

  // 12. Close the database BEFORE any filesystem publication.
  d.closeDatabase();

  return snapshot;
}

function safeBool(fn: () => boolean): boolean {
  try { return fn() === true; } catch { return false; }
}

/** True when ≥1 surface recorded a per-item error — the exit-2 partial condition.
 *  WP7: the optional guidanceInventory surface participates when present. */
export function snapshotHasPartialFailure(s: AnalyticsSnapshotV2): boolean {
  return SURFACE_KEYS.some((k) => s.surfaces[k].errors.length > 0)
    || (s.surfaces.guidanceInventory?.errors.length ?? 0) > 0;
}

/**
 * WP-S — the declared contract of this snapshot: one stable capability name per
 * WP whose v2-optional fields are POPULATED. Pure over the scan model so it is
 * unit-testable without a capture.
 */
export function snapshotCapabilities(
  model: OverheadModel,
  optimizer?: {
    proposals: Array<{ recommendationDraft?: unknown }>;
    fileHeat?: Array<{ role?: unknown; score?: unknown }>;
  },
  surfaceProvenances?: Partial<Record<SurfaceKey, { comparabilityKey?: string }>>,
  guidanceInventory?: { scan: { scanComplete: boolean } } | null,
  fileSequences?: { metadata?: { topK?: number } } | null,
): string[] {
  const caps: string[] = [];
  // WP2 'agents-md-sources': every agent in the scan carries a composed
  // guidanceSources list (the analyzer populates it; an old model without the
  // field would honestly withhold the capability).
  if (model.agents.every((a) => Array.isArray(a.guidanceSources))) caps.push('agents-md-sources');
  // WP3 'recommendation-drafts': declared iff ≥1 proposal in THIS snapshot actually
  // carries a recommendationDraft (populated, not merely possible). Schema stays v2.
  if ((optimizer?.proposals ?? []).some((p) => p.recommendationDraft != null)) {
    caps.push('recommendation-drafts');
  }
  // WP5 'section-behavior-status': declared iff ≥1 config-weight section in the
  // (already-annotated) model actually carries a behaviorStatus — populated, not
  // merely possible.
  const hasBehavior = (rollup?: { sections: Array<{ behaviorStatus?: unknown }> }): boolean =>
    (rollup?.sections ?? []).some((s) => s.behaviorStatus !== undefined);
  if (model.agents.some((a) => hasBehavior(a.configWeight)) || hasBehavior(model.workspaceConfigWeight)) {
    caps.push('section-behavior-status');
  }
  // WP6 'file-heat-extended': declared iff ≥1 file-heat row in THIS snapshot
  // actually carries the extended role/score semantics (populated, not merely
  // possible — an empty or pre-Phase-4 rollup honestly withholds it).
  if ((optimizer?.fileHeat ?? []).some((f) => f.role !== undefined || f.score !== undefined)) {
    caps.push('file-heat-extended');
  }
  // WP8 'surface-provenance': declared iff EVERY surface carries a provenance
  // with a computed comparabilityKey — populated, not merely possible. A partial
  // map honestly withholds the capability.
  if (SURFACE_KEYS.every((k) => {
    const key = surfaceProvenances?.[k]?.comparabilityKey;
    return typeof key === 'string' && key.length > 0;
  })) {
    caps.push('surface-provenance');
  }
  // WP7 'guidance-inventory': declared iff the scan RAN and produced its
  // contract/completeness metadata (an empty workspace with zero guidance
  // files is still a populated inventory; a failed/absent scan honestly
  // withholds the capability).
  if (guidanceInventory != null && typeof guidanceInventory.scan?.scanComplete === 'boolean') {
    caps.push('guidance-inventory');
  }
  // WP9 'file-sequences': declared iff the block was BUILT (its declared-window
  // metadata present) — a failed/absent build honestly withholds the capability.
  // An empty workspace still declares it: zero qualifying pairs is a populated,
  // honest result, not an absence of the contract.
  if (fileSequences != null && typeof fileSequences.metadata?.topK === 'number') {
    caps.push('file-sequences');
  }
  return caps;
}

// ── WP8 (G8) — per-surface provenance + comparability keys ────────────────────

/** The applied time window read back off a query RESULT's scopeMeta — what the
 *  query actually did, never what the flag requested. */
export interface AppliedQueryWindow {
  sinceMs: number | null;
  untilMs: number | null;
}

/**
 * WP8 — build all six surfaces' provenance from the ONE snapshot anchor. Pure and
 * exported so anchor-stability and key derivation are unit-testable without a
 * capture.
 *
 * Window semantics (inclusive-start / EXCLUSIVE-end ISO):
 *   - filesystem/current-state surfaces (contextOverhead, agentKnowledge, plans)
 *     are point-in-time reads: windowStart = windowEnd = anchor. They can never
 *     honor --window, so a windowed run gives them a different comparabilityKey
 *     from the windowed surfaces — by construction, not by policy.
 *   - the optimizer's behavior evidence spans everything the store recorded:
 *     ALL_RECORDED_HISTORY_START → anchor.
 *   - skillUsage / mcpToolUsage export the window their query ACTUALLY applied
 *     (scopeMeta.windowSinceMs/untilMs); no applied filter → true all-history
 *     window. A query that ignored the requested window therefore exports its
 *     TRUE window and gets a different key — never a pretended one.
 *
 * The strict-workspace MCP scope (`queryMcpToolUsage(..., scopeMode:'strict')`)
 * is explicit here: on `workspaceScope.scopeMode` and again as the mcpToolUsage
 * population filter `mcpScope:strict-workspace`.
 */
export function buildSurfaceProvenances(args: {
  anchorIso: string;
  workspaceId: string;
  skillWindow?: AppliedQueryWindow;
  mcpWindow?: AppliedQueryWindow;
}): Record<SurfaceKey, SurfaceProvenanceV1> {
  const anchor = args.anchorIso;
  const workspaceScope = { workspaceId: args.workspaceId, scopeMode: 'strict-workspace' as const };
  const iso = (ms: number): string => new Date(ms).toISOString();
  const appliedWindow = (w: AppliedQueryWindow | undefined): { windowStart: string; windowEnd: string } => ({
    windowStart: w?.sinceMs != null ? iso(w.sinceMs) : ALL_RECORDED_HISTORY_START,
    windowEnd: w?.untilMs != null ? iso(w.untilMs) : anchor,
  });

  return {
    contextOverhead: buildSurfaceProvenance({
      workspaceScope,
      population: {
        lanes: [...ALL_LANES],
        providers: ['any-registered-agent'],
        captureSources: ['filesystem-scan'],
        filters: ['workspaceAgentsOnly:true'],
      },
      windowStart: anchor, windowEnd: anchor, snapshotAnchor: anchor,
    }),
    optimizer: buildSurfaceProvenance({
      workspaceScope,
      population: {
        lanes: [...ALL_LANES],
        providers: ['claude'],
        captureSources: ['behavior-events-sqlite', 'filesystem-scan'],
        filters: ['scopeMode:strict', 'includeOperationalNoise:true', 'backfillMode:skip'],
      },
      windowStart: ALL_RECORDED_HISTORY_START, windowEnd: anchor, snapshotAnchor: anchor,
    }),
    skillUsage: buildSurfaceProvenance({
      workspaceScope,
      population: {
        lanes: [...ALL_LANES],
        providers: ['claude'],
        captureSources: ['skill-invocations-index'],
        filters: ['scopeMode:strict'],
      },
      ...appliedWindow(args.skillWindow), snapshotAnchor: anchor,
    }),
    mcpToolUsage: buildSurfaceProvenance({
      workspaceScope,
      population: {
        lanes: [...ALL_LANES],
        providers: ['claude'],
        captureSources: ['mcp-tool-events-index'],
        // The strict-workspace MCP scope, made explicit (plan: exporter's
        // queryMcpToolUsage scopeMode:'strict' call).
        filters: ['scopeMode:strict', 'mcpScope:strict-workspace'],
      },
      ...appliedWindow(args.mcpWindow), snapshotAnchor: anchor,
    }),
    agentKnowledge: buildSurfaceProvenance({
      workspaceScope,
      population: {
        lanes: [...ALL_LANES],
        providers: ['any-registered-agent'],
        captureSources: ['filesystem-scan'],
        filters: ['preScannedOverheadModel:reused'],
      },
      windowStart: anchor, windowEnd: anchor, snapshotAnchor: anchor,
    }),
    plans: buildSurfaceProvenance({
      workspaceScope,
      population: {
        lanes: [],
        providers: [],
        captureSources: ['plans-store'],
        filters: ['workspaceId:exact'],
      },
      windowStart: anchor, windowEnd: anchor, snapshotAnchor: anchor,
    }),
  };
}

/**
 * WP8 — stamp the optimizer surface's comparabilityKey onto every WP3
 * recommendation-draft evidence entry (`{ kind, rowIds, generationId }` →
 * `+ comparabilityKey`). Every draft evidence row is an optimizer-surface row by
 * construction (recommendation-draft.ts bars cross-surface evidence), so the
 * optimizer key is THE key for all of them. Pure and non-mutating; v2-optional
 * field under the 'surface-provenance' capability. This does NOT lift WP3's
 * cross-surface bar — it only makes same-surface evidence carry the key that a
 * future cross-surface join would have to match.
 */
export function stampRecommendationEvidenceComparability<T>(value: T, comparabilityKey: string): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const evidence = (val as { evidence?: unknown } | null)?.evidence;
        if (k === 'recommendationDraft' && val && typeof val === 'object' && Array.isArray(evidence)) {
          out[k] = {
            ...(val as Record<string, unknown>),
            evidence: evidence.map((e) =>
              e && typeof e === 'object' ? { ...(e as Record<string, unknown>), comparabilityKey } : e),
          };
        } else {
          out[k] = walk(val);
        }
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * WP6 (G6) — per-table truncation metadata for the two tables with a declared
 * pagination contract. Pure, so metadata correctness is unit-testable without a
 * capture. The before-WP15 `paginationOrder` values are hard facts about THIS
 * exporter's shape, not configuration:
 *   - file-heat: the engine slices to `FILE_HEAT_TOP_N` per lane BEFORE the
 *     exporter's paginated drain → `'truncate-then-paginate'`;
 *   - mcp-tool: one rollup object whose `byTool` is capped at
 *     `AGENT_DTO_CAPS.mcp_tool_usage.topTools` → `'single-object-truncated'`.
 * `populationAvailable: null` means the producing layer did not disclose the
 * population — unknown is reported as unknown, never as "not truncated".
 */
export function computeTableTruncation(args: {
  fileHeatRowsEmitted: number;
  /** `result.meta.fileHeatPopulation` — absent on an engine run that could not
   *  disclose every lane's pre-slice population. */
  fileHeatPopulation: number | undefined;
  mcpByToolRowsEmitted: number;
  mcpByToolPopulation: number;
  /** WP9 — the fileSequences block; absent/null ⇒ no file-sequences.csv entry
   *  (the table is not written without the block). */
  fileSequences?: FileSequencesV1 | null;
}): Record<string, TableTruncationMetaV1> {
  const fhPop = args.fileHeatPopulation ?? null;
  return {
    'file-heat.csv': {
      populationAvailable: fhPop,
      rowsEmitted: args.fileHeatRowsEmitted,
      truncated: fhPop === null ? null : fhPop > args.fileHeatRowsEmitted,
      limit: OPTIMIZER_CONFIG.FILE_HEAT_TOP_N,
      paginationOrder: 'truncate-then-paginate',
    },
    'mcp-tool-usage.csv': {
      populationAvailable: args.mcpByToolPopulation,
      rowsEmitted: args.mcpByToolRowsEmitted,
      truncated: args.mcpByToolPopulation > args.mcpByToolRowsEmitted,
      limit: AGENT_DTO_CAPS.mcp_tool_usage.topTools,
      paginationOrder: 'single-object-truncated',
    },
    // WP9 — one CSV row per co-touch pair / predecessor edge / association; the
    // block already discloses per-list truncation, this is the whole-table view.
    ...(args.fileSequences
      ? {
        'file-sequences.csv': {
          populationAvailable:
            (args.fileSequences.truncation.coTouch.populationAvailable ?? 0)
            + (args.fileSequences.truncation.predecessors.populationAvailable ?? 0)
            + (args.fileSequences.truncation.associatedCommandFamilies.populationAvailable ?? 0),
          rowsEmitted: args.fileSequences.coTouch.length
            + args.fileSequences.predecessors.length
            + args.fileSequences.associatedCommandFamilies.length,
          truncated: args.fileSequences.truncation.coTouch.truncated === true
            || args.fileSequences.truncation.predecessors.truncated === true
            || args.fileSequences.truncation.associatedCommandFamilies.truncated === true,
          limit: args.fileSequences.metadata.topK,
          paginationOrder: 'truncate-then-paginate',
        },
      }
      : {}),
  };
}

/** WP2 — distinct directory-chain (i.e. ANALYZED) AGENTS.md paths in the scan.
 *  Production has no window-stream enumeration seam yet, so none of these can
 *  reach `complete` capture coverage — each one keeps the
 *  AGENTS_MD_AUDIENCE_PARTIALLY_UNOBSERVED caveat observed. */
export function countAnalyzedAgentsMdWithoutCompleteCoverage(model: OverheadModel): number {
  const analyzed = new Set<string>();
  for (const a of model.agents) {
    for (const g of a.guidanceSources ?? []) {
      if (g.fileKind === 'agents-md' && g.applicability.model === 'directory-chain') analyzed.add(g.path);
    }
  }
  return analyzed.size;
}

// ── atomic publication + guarded pruning (plan Fork 3) ────────────────────────

/** `20260719T184455123Z` — lexically sortable by capture time. */
export function snapshotDirName(s: AnalyticsSnapshotV2): string {
  const t = s.captureStartedAtIso.replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
  return `${t}-${s.snapshotId.slice(0, 8)}`;
}

function writeFileSynced(file: string, content: string): string {
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return sha256Of(content);
}

export function defaultOutputRoot(workspaceRoot: string): string {
  return nodePath.join(workspaceStateDir(workspaceRoot), 'analytics');
}

/**
 * Write the snapshot into `.tmp-<pid>-<nonce>/`, fsync every file, then rename to
 * the final directory. A crashed run leaves a `.tmp-*` directory and NO published
 * snapshot; pruning runs only after a successful rename.
 */
export async function writeAnalyticsSnapshot(
  s: AnalyticsSnapshotV2,
  o: AnalyticsSnapshotOptions & { workspaceRoot?: string },
): Promise<string> {
  const root = o.outputRoot ?? defaultOutputRoot(o.workspaceRoot ?? process.cwd());
  fs.mkdirSync(root, { recursive: true });

  const nonce = randomBytes(4).toString('hex');
  const tmp = nodePath.join(root, `.tmp-${process.pid}-${nonce}`);
  const finalName = snapshotDirName(s);
  const finalDir = nodePath.join(root, finalName);

  const files: Record<string, string> = {};
  try {
    fs.mkdirSync(tmp, { recursive: true });

    files['snapshot.json'] = writeFileSynced(nodePath.join(tmp, 'snapshot.json'), canonicalJson(s));

    const surfaceIndex: SnapshotManifestV2['surfaceIndex'] = [];
    for (const k of SURFACE_KEYS) {
      const rel = `surfaces/${k}.json`;
      const sha = writeFileSynced(nodePath.join(tmp, rel), canonicalJson(s.surfaces[k]));
      files[rel] = sha;
      const data = s.surfaces[k].data as unknown;
      surfaceIndex.push({
        key: k,
        status: s.surfaces[k].status,
        generationId: s.surfaces[k].generationId,
        rows: Array.isArray(data) ? data.length : data === null ? 0 : 1,
        file: rel,
        sha256: sha,
      });
    }

    // WP7 — the optional guidanceInventory surface (v2-optional; absent on
    // older snapshots re-published through this writer).
    const gi = s.surfaces.guidanceInventory;
    if (gi) {
      const rel = 'surfaces/guidanceInventory.json';
      const sha = writeFileSynced(nodePath.join(tmp, rel), canonicalJson(gi));
      files[rel] = sha;
      surfaceIndex.push({
        key: 'guidanceInventory',
        status: gi.status,
        generationId: gi.generationId,
        rows: gi.data?.entries.length ?? 0,
        file: rel,
        sha256: sha,
      });
    }

    files['SUMMARY.md'] = writeFileSynced(nodePath.join(tmp, 'SUMMARY.md'), renderSummaryMarkdown(s));
    for (const [name, csv] of Object.entries(renderSummaryTables(s))) {
      files[`tables/${name}`] = writeFileSynced(nodePath.join(tmp, 'tables', name), csv);
    }

    const manifest: SnapshotManifestV2 = {
      kind: SNAPSHOT_MANIFEST_KIND,
      schemaVersion: 2,
      capabilities: s.capabilities ?? [],
      snapshotId: s.snapshotId,
      captureStartedAtIso: s.captureStartedAtIso,
      captureCompletedAtIso: s.captureCompletedAtIso,
      provenance: s.provenance,
      caveats: s.caveats,
      surfaceIndex,
      // WP6 (G6): per-table truncation disclosure, mirrored for manifest-only readers.
      ...(s.provenance.tableTruncation ? { tableTruncation: s.provenance.tableTruncation } : {}),
      files,
    };
    writeFileSynced(nodePath.join(tmp, 'manifest.json'), canonicalJson(manifest));

    fs.renameSync(tmp, finalDir);
  } catch (err) {
    // Leave nothing half-published. The `.tmp-*` directory is swept by a later run.
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    throw new ExporterError(
      `analytics-snapshot: publication failed, nothing was published: ${sanitizeMessage((err as Error).message)}`, 1);
  }

  if (o.prune) pruneSnapshotRoot(root, o.keep, finalName, Date.now());
  return finalDir;
}

/** Read the output root into the pure pruner's input shape. */
export function readDirEntries(root: string): DirEntry[] {
  let names: fs.Dirent[];
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return names.map((e) => {
    const full = nodePath.join(root, e.name);
    let hasValidManifest = false;
    let mtimeMs: number | undefined;
    if (e.isDirectory()) {
      try {
        const m = JSON.parse(fs.readFileSync(nodePath.join(full, 'manifest.json'), 'utf8'));
        hasValidManifest = m?.kind === SNAPSHOT_MANIFEST_KIND;
      } catch { hasValidManifest = false; }
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch { mtimeMs = undefined; }
    }
    return { name: e.name, isDirectory: e.isDirectory(), hasValidManifest, mtimeMs };
  });
}

/**
 * The exporter's ONLY destructive operation. Every deletion goes through
 * `planPrune`/`planTmpSweep`, which require a snapshot-shaped name, a valid
 * manifest, and not-just-published — so this is structurally incapable of
 * touching anything the exporter did not write. Confined to `root`.
 */
export function pruneSnapshotRoot(root: string, keep: number, justPublished: string, nowMs: number): string[] {
  const entries = readDirEntries(root);
  const doomed = [...planPrune(entries, keep, justPublished), ...planTmpSweep(entries, nowMs)];
  const removed: string[] = [];
  for (const name of doomed) {
    // Belt: never leave `root`, and never touch the just-published directory.
    if (name === justPublished || name.includes('/') || name.includes('\\') || name.includes('..')) continue;
    const full = nodePath.join(root, name);
    if (nodePath.dirname(full) !== nodePath.resolve(root) && nodePath.dirname(full) !== root) continue;
    try { fs.rmSync(full, { recursive: true, force: true }); removed.push(name); } catch { /* best effort */ }
  }
  return removed;
}

export { TMP_DIR_RE };

// ── reading a published snapshot back (for `diff`) ────────────────────────────

export function readSnapshotFrom(pathArg: string): AnalyticsSnapshotV2 | AnalyticsSnapshotV1 {
  const stat = (() => { try { return fs.statSync(pathArg); } catch { return null; } })();
  if (!stat) throw new ExporterError(`analytics-snapshot: no such snapshot path '${pathArg}'`, 1);
  const file = stat.isDirectory() ? nodePath.join(pathArg, 'snapshot.json') : pathArg;
  try {
    // May legitimately be a v1 snapshot — the diff entrypoint adapts or refuses.
    return JSON.parse(fs.readFileSync(file, 'utf8')) as AnalyticsSnapshotV2 | AnalyticsSnapshotV1;
  } catch (err) {
    throw new ExporterError(
      `analytics-snapshot: could not read snapshot.json under '${pathArg}': ${sanitizeMessage((err as Error).message)}`, 1);
  }
}
