// optimizer-live-analyze.ts — WP7 shared composition helper (read-only).
//
// The live optimizer analyze composition, extracted so the WP7 GET routes
// (api-server.ts) do NOT re-derive it. Mirrors the production wiring in
// ipc-handlers.ts (`context-optimizer:analyze`, ~lines 489–519): resolve the
// workspace, assemble one RawLaneInputs per persona lane, date brand-new sections
// via the git-backed birthday resolver, and run the pure engine. With no resolvable
// workspace it returns the engine's honest EMPTY result — never a crash, never a
// fabricated proposal.
//
// READ-ONLY: this NEVER writes a DB row, marks-applied, or signs a derivation. It is
// pure composition over already-existing read surfaces (the ipc-handlers copy stays
// the single production write-adjacent path; a future cleanup can dedupe onto this).

import type { ContextOptimizerQuery, ContextOptimizerResult } from '../../shared/types';
import { runOptimizerAnalyze } from './optimizer-surface';
import { buildAssembleContext, assembleAllLaneInputs } from './optimizer-assemble';
import { makeProductionBirthdayResolver } from './optimizer-production';
import type { PipelineDb } from './optimizer-pipeline';

export interface LiveOptimizerAnalyzeDeps {
  /** The workspace whose scaffold + DB spine to analyze. Absent ⇒ honest EMPTY. */
  workspaceId?: string;
  db: PipelineDb;
  /** App repo root — the git-backed birthday resolver dates sections against it.
   *  api-server resolves this the same way ipc-handlers does (repo root, not cwd). */
  repoDir: string;
  generatedAtIso: string;
  nowMs: number;
  query?: ContextOptimizerQuery;
}

/**
 * Run the live optimizer engine over a workspace, or the honest EMPTY result when no
 * workspace resolves. Read-only. Backfill→classify ordering is enforced inside
 * runOptimizerPipeline (via runOptimizerAnalyze), unchanged.
 */
export function runLiveOptimizerAnalyze(deps: LiveOptimizerAnalyzeDeps): ContextOptimizerResult {
  const base = { generatedAtIso: deps.generatedAtIso, nowMs: deps.nowMs, query: deps.query };
  if (!deps.workspaceId) {
    return runOptimizerAnalyze(base);
  }
  // WP-4A — thread the caller's workspace scope into the file-heat corpus query. The
  // scanned workspaceId is the REAL scope id; slug/scopeMode come from the query (default
  // 'strict'). This is what makes per-workspace analyze scope BEHAVIOR, not just guidance.
  const ctx = buildAssembleContext({
    workspaceId: deps.workspaceId,
    db: deps.db,
    scope: {
      workspaceId: deps.workspaceId,
      slug: deps.query?.slug,
      scopeMode: deps.query?.scopeMode ?? 'strict',
    },
  });
  return runOptimizerAnalyze({
    ...base,
    lanes: assembleAllLaneInputs(ctx),
    db: deps.db,
    backfillTargets: ctx.residentTargets,
    birthdayResolver: makeProductionBirthdayResolver(deps.repoDir),
  });
}
