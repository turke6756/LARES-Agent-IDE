// memory-ipc.ts — Memory & Lessons v2 review READ surface (WP-H1).
//
// THE load-bearing boundary of this module: it is a **renderer-only** Electron
// IPC channel. It is registered with `ipcMain.handle` (wired in index.ts beside
// the other IPC registrars) and exposed to the renderer through the preload
// contextBridge — and it appears in **no** MCP toolset and **no** api-server
// route, so no agent can reach it. `memory-review-channel-isolation.test.js`
// fails if anyone later leaks the channel into the MCP shim or an HTTP route.
//
// The handler reads WP-B's durable review queue (`memory_review_queue`) and
// WP-C's persisted `memory_index_state` (last-known-good source + runtime-error
// state), then projects the one workspace-level signal the user sees:
//   "Memory index: N entries pending review, cap at P%"
// (plans/memory-lessons-v2-proposal.md §6). Read-only: it never writes.
//
//   npm run build:main
//   node dist/main/main/memory-index/memory-ipc.test.js

import {
  CAP_PRESSURE_RATIO,
  MEMORY_INDEX_BUDGET_BYTES,
  MEMORY_INDEX_BUDGET_LINES,
} from '../../shared/memory-index-core';
import type {
  LaunchAgentInput,
  MemoryGraduationApplyDto,
  MemoryIpcOkDto,
  MemoryJanitorBriefDto,
  MemoryJanitorDispatchDto,
  MemoryReviewItemDto,
  MemoryReviewSummaryDto,
} from '../../shared/types';
import { getDb } from '../database';
import type { QueryDb } from '../skill-analytics/queries';
import {
  assessLessonEvidence as storeAssessLessonEvidence,
  getGraduation as storeGetGraduation,
  getIndexState as storeGetIndexState,
  listFindings as storeListFindings,
  listLessons as storeListLessons,
  recordMigrationApproval as storeRecordMigrationApproval,
  setGraduationStatus as storeSetGraduationStatus,
  type IndexStateRow,
  type ReviewFindingRow,
} from './review-store';
import {
  assessLessonFiring,
  generateJanitorBrief,
  type JanitorBriefDeps,
} from './janitor-brief';
import { applyGraduation } from './graduation-apply';

/** The renderer-only IPC channels this module owns. WP-H2 added the janitor
 *  siblings (`generateJanitorBrief` / `dispatchJanitor`); WP-H3 adds the
 *  human-only graduation approve/reject + migration-approval siblings. Every
 *  channel here is renderer-only — the isolation test fails if any leaks into an
 *  MCP toolset or api-server route. */
export const MEMORY_REVIEW_CHANNELS = {
  listReview: 'memory:listReview',
  generateJanitorBrief: 'memory:generateJanitorBrief',
  dispatchJanitor: 'memory:dispatchJanitor',
  graduationApprove: 'memory:graduationApprove',
  graduationReject: 'memory:graduationReject',
  migrationApprove: 'memory:migrationApprove',
} as const;

/** Injected store reads — the production wiring passes the real review-store
 *  functions; tests pass fakes so the boundary is exercised without a DB. */
export interface MemoryReviewIpcDeps {
  listFindings(ws: string, status?: string): ReviewFindingRow[];
  getIndexState(ws: string): IndexStateRow | null;
}

/** The default deps: the live review-store, reading the shared DB. */
export const liveMemoryReviewDeps: MemoryReviewIpcDeps = {
  listFindings: storeListFindings,
  getIndexState: storeGetIndexState,
};

function emptySummary(): MemoryReviewSummaryDto {
  return {
    pendingCount: 0,
    capPressure: false,
    capPercent: null,
    hardInvalid: false,
    lastRuntimeError: null,
    lastRuntimeErrorAt: null,
    items: [],
  };
}

/** Byte/line budget usage (0–100, rounded) of the persisted last-known-good
 *  source, or null when none is stored or the persisted JSON is unusable. The
 *  larger of the two ratios governs — the same figure `cap-pressure` keys off. */
function capPercentFromState(state: IndexStateRow | null): number | null {
  if (!state?.parsedJson) return null;
  try {
    const parsed = JSON.parse(state.parsedJson) as { byteLength?: unknown; lineCount?: unknown };
    const bytes = typeof parsed.byteLength === 'number' ? parsed.byteLength : NaN;
    const lines = typeof parsed.lineCount === 'number' ? parsed.lineCount : NaN;
    if (!Number.isFinite(bytes) && !Number.isFinite(lines)) return null;
    const byteRatio = Number.isFinite(bytes) ? bytes / MEMORY_INDEX_BUDGET_BYTES : 0;
    const lineRatio = Number.isFinite(lines) ? lines / MEMORY_INDEX_BUDGET_LINES : 0;
    return Math.round(Math.max(byteRatio, lineRatio) * 100);
  } catch {
    return null;
  }
}

/**
 * Project the pending review queue + persisted index state into the one
 * workspace-level DTO the renderer displays. Pure — no DB, no I/O — so it is
 * unit-testable directly and reused by the IPC handler.
 *
 * `capPressure`/`hardInvalid` are keyed off the DURABLE queue (a pending
 * `cap-pressure` / `hard-invalid` finding), not re-derived from bytes, so the
 * surface reflects exactly what WP-C persisted at the last launch. `capPercent`
 * is enrichment computed from the last-good source for the "cap at P%" copy.
 */
export function summarizeReview(
  pendingFindings: ReviewFindingRow[],
  state: IndexStateRow | null,
): MemoryReviewSummaryDto {
  const items: MemoryReviewItemDto[] = pendingFindings.map((f) => ({
    findingId: f.findingId,
    kind: f.kind,
    entryId: f.entryId,
    reason: f.reason,
    exitCondition: f.exitCondition,
    firstSeen: f.firstSeen,
    lastSeen: f.lastSeen,
  }));
  return {
    pendingCount: items.length,
    capPressure: pendingFindings.some((f) => f.kind === 'cap-pressure'),
    capPercent: capPercentFromState(state),
    hardInvalid: pendingFindings.some((f) => f.kind === 'hard-invalid'),
    lastRuntimeError: state?.lastRuntimeError ?? null,
    lastRuntimeErrorAt: state?.lastRuntimeErrorAt ?? null,
    items,
  };
}

/** Build the summary for one workspace from the injected store reads. A blank
 *  / non-string workspace id yields the empty summary rather than a throw, so a
 *  renderer with no workspace selected renders a clean (hidden) surface. */
export function buildReviewSummary(deps: MemoryReviewIpcDeps, workspaceId: unknown): MemoryReviewSummaryDto {
  if (typeof workspaceId !== 'string' || workspaceId === '') return emptySummary();
  const pending = deps.listFindings(workspaceId, 'pending');
  const state = deps.getIndexState(workspaceId);
  return summarizeReview(pending, state);
}

// ── WP-H2: janitor brief + dispatch ─────────────────────────────────────────
/** The janitor channels' injected deps: the brief-generation reads plus the
 *  launch seam. `launchAgent` is the SAME user launch path the UI drives
 *  (`supervisor.launchAgent`) — dispatch launches a real agent, it does not
 *  merely return markdown. */
export interface MemoryJanitorIpcDeps extends JanitorBriefDeps {
  launchAgent(input: LaunchAgentInput): Promise<{ id: string }>;
}

/** Title/role stamped on a dispatched janitor agent. */
export const JANITOR_AGENT_TITLE = 'Memory index janitor';
export const JANITOR_ROLE_DESCRIPTION =
  'Triage the workspace memory index from the dispatched review brief (close / graduate / archive), then re-validate.';

/** The live janitor deps: review-store reads + the coverage-guarded firing query
 *  (`assessLessonFiring` over `SkillUsageQueries`, coverage from WP-B's
 *  `assessLessonEvidence`) + the injected user launch path. */
export function liveMemoryJanitorDeps(
  launchAgent: (input: LaunchAgentInput) => Promise<{ id: string }>,
): MemoryJanitorIpcDeps {
  return {
    listPending: (ws) => storeListFindings(ws, 'pending'),
    listActiveLessons: (ws) => storeListLessons(ws, 'active'),
    assessFiring: (ws, names) =>
      assessLessonFiring(getDb() as unknown as QueryDb, ws, names, storeAssessLessonEvidence(ws)),
    launchAgent,
  };
}

/** Build the brief DTO for one workspace. A blank / non-string workspace id
 *  yields an empty, not-ok brief rather than a throw. */
export function buildJanitorBrief(janitor: JanitorBriefDeps, workspaceId: unknown): MemoryJanitorBriefDto {
  if (typeof workspaceId !== 'string' || workspaceId === '') return { ok: false, brief: '' };
  return { ok: true, brief: generateJanitorBrief(janitor, workspaceId) };
}

/** Generate the brief, then LAUNCH a janitor agent through the injected user
 *  launch path with the brief as its initial user prompt. Returns the launched
 *  agent id + the brief. A blank workspace id is rejected without a launch. */
export async function dispatchJanitor(
  janitor: MemoryJanitorIpcDeps,
  workspaceId: unknown,
): Promise<MemoryJanitorDispatchDto> {
  if (typeof workspaceId !== 'string' || workspaceId === '') return { ok: false, code: 'invalid_workspace' };
  const brief = generateJanitorBrief(janitor, workspaceId);
  const agent = await janitor.launchAgent({
    workspaceId,
    title: JANITOR_AGENT_TITLE,
    roleDescription: JANITOR_ROLE_DESCRIPTION,
    initialUserPrompt: brief,
  });
  return { ok: true, agentId: agent.id, brief };
}

// ── WP-H3: human-only graduation approve/reject + migration approval ─────────
/** The on-disk root of a workspace + its write dialect, resolved from the opaque
 *  workspace id. `null` when the id is unknown (the handler then no-ops safely). */
export interface WorkspaceLocation {
  path: string;
  pathType: string;
}

/** The graduation/migration channels' injected deps. `resolveWorkspace` maps the
 *  workspace id to its on-disk root (production: `getWorkspace(ws)`); the store
 *  writers are injected so tests exercise the boundary without a live DB. */
export interface MemoryGraduationIpcDeps {
  resolveWorkspace(ws: string): WorkspaceLocation | null;
  applyGraduation(ws: string, loc: WorkspaceLocation, proposalId: string): MemoryGraduationApplyDto;
  rejectGraduation(ws: string, proposalId: string): MemoryIpcOkDto;
  recordMigrationApproval(ws: string, snapshotId: string, tableHash: string): MemoryIpcOkDto;
}

/** The identity stamped on a human sign-off — these channels are renderer-only,
 *  so the actor is always the human at the app, never an agent. */
export const HUMAN_APPROVER = 'human';

/** The live graduation deps: real graduation apply (under the workspace lock) +
 *  the review-store writers. `resolveWorkspace` is injected by index.ts (it owns
 *  the `getWorkspace` DB read). Every method returns a structured DTO, never
 *  throws — a bad workspace id / unknown proposal is a clean `{ ok:false }`. */
export function liveMemoryGraduationDeps(
  resolveWorkspace: (ws: string) => WorkspaceLocation | null,
): MemoryGraduationIpcDeps {
  return {
    resolveWorkspace,
    applyGraduation: (ws, loc, proposalId) => applyGraduation(ws, loc.path, loc.pathType, proposalId),
    rejectGraduation: (ws, proposalId) => {
      const proposal = storeGetGraduation(proposalId);
      if (!proposal || proposal.workspaceId !== ws) {
        return { ok: false, code: 'not_found' };
      }
      storeSetGraduationStatus(proposalId, 'rejected');
      return { ok: true };
    },
    recordMigrationApproval: (ws, snapshotId, tableHash) => {
      storeRecordMigrationApproval(ws, snapshotId, tableHash, HUMAN_APPROVER, new Date().toISOString());
      return { ok: true };
    },
  };
}

/** Approve == APPLY the graduation (the only applier). A blank workspace id or an
 *  unresolvable workspace is rejected without a write. */
export function approveGraduation(
  grad: MemoryGraduationIpcDeps,
  workspaceId: unknown,
  proposalId: unknown,
): MemoryGraduationApplyDto {
  if (typeof workspaceId !== 'string' || workspaceId === '') return { ok: false, code: 'invalid_workspace', message: 'no workspace' };
  if (typeof proposalId !== 'string' || proposalId === '') return { ok: false, code: 'not_found', message: 'no proposal id' };
  const loc = grad.resolveWorkspace(workspaceId);
  if (!loc) return { ok: false, code: 'invalid_workspace', message: 'unknown workspace' };
  return grad.applyGraduation(workspaceId, loc, proposalId);
}

/** Reject a graduation proposal (DB status only; no filesystem write). */
export function rejectGraduation(
  grad: MemoryGraduationIpcDeps,
  workspaceId: unknown,
  proposalId: unknown,
): MemoryIpcOkDto {
  if (typeof workspaceId !== 'string' || workspaceId === '') return { ok: false, code: 'invalid_workspace' };
  if (typeof proposalId !== 'string' || proposalId === '') return { ok: false, code: 'not_found' };
  return grad.rejectGraduation(workspaceId, proposalId);
}

/** Record a migration approval row (WP-I2 consumes it). Human-only sign-off bound
 *  to `snapshot_id` + `table_hash`. */
export function approveMigration(
  grad: MemoryGraduationIpcDeps,
  workspaceId: unknown,
  snapshotId: unknown,
  tableHash: unknown,
): MemoryIpcOkDto {
  if (typeof workspaceId !== 'string' || workspaceId === '') return { ok: false, code: 'invalid_workspace' };
  if (typeof snapshotId !== 'string' || snapshotId === '') return { ok: false, code: 'invalid_snapshot' };
  if (typeof tableHash !== 'string' || tableHash === '') return { ok: false, code: 'invalid_table_hash' };
  return grad.recordMigrationApproval(workspaceId, snapshotId, tableHash);
}

/** Minimal `ipcMain`-shaped surface (mirrors lifecycle-ipc's `IpcLike`) so the
 *  handler can be registered against a fake in tests. */
export interface IpcLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

/**
 * Register the renderer-only review-read channel — and, when `janitorDeps` is
 * supplied, the WP-H2 janitor siblings (`generateJanitorBrief` / `dispatchJanitor`)
 * on the same registrar. `deps` defaults to the live review-store; tests pass
 * fakes. Handlers never throw on hostile input — a bad workspace id returns the
 * empty summary / an unlaunched rejection. Omitting `janitorDeps` registers only
 * the read (WP-H1's original single-channel shape).
 */
export function registerMemoryReviewIpc(
  ipc: IpcLike,
  deps: MemoryReviewIpcDeps = liveMemoryReviewDeps,
  janitorDeps?: MemoryJanitorIpcDeps,
  graduationDeps?: MemoryGraduationIpcDeps,
): void {
  ipc.handle(MEMORY_REVIEW_CHANNELS.listReview, (_e, workspaceId: unknown) =>
    buildReviewSummary(deps, workspaceId),
  );
  if (janitorDeps) {
    ipc.handle(MEMORY_REVIEW_CHANNELS.generateJanitorBrief, (_e, workspaceId: unknown) =>
      buildJanitorBrief(janitorDeps, workspaceId),
    );
    ipc.handle(MEMORY_REVIEW_CHANNELS.dispatchJanitor, (_e, workspaceId: unknown) =>
      dispatchJanitor(janitorDeps, workspaceId),
    );
  }
  if (graduationDeps) {
    // WP-H3 — human-only. Approve APPLIES the graduation (the only applier);
    // reject is a DB status flip; migrationApprove records the WP-I2 sign-off.
    ipc.handle(MEMORY_REVIEW_CHANNELS.graduationApprove, (_e, workspaceId: unknown, proposalId: unknown) =>
      approveGraduation(graduationDeps, workspaceId, proposalId),
    );
    ipc.handle(MEMORY_REVIEW_CHANNELS.graduationReject, (_e, workspaceId: unknown, proposalId: unknown) =>
      rejectGraduation(graduationDeps, workspaceId, proposalId),
    );
    ipc.handle(
      MEMORY_REVIEW_CHANNELS.migrationApprove,
      (_e, workspaceId: unknown, snapshotId: unknown, tableHash: unknown) =>
        approveMigration(graduationDeps, workspaceId, snapshotId, tableHash),
    );
  }
}
