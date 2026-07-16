// optimizer-surface.ts — WP6 HUMAN-SURFACE impure wiring (IPC-only, human-gated).
//
// Three thin, additive entry points behind the `context-optimizer:*` IPC channels.
// NONE of them auto-writes a config file (master WP6 hard rule):
//
//   • runOptimizerAnalyze  — read-only. Runs the pure engine over whatever RawLaneInputs
//     the caller supplies. Production supplies NONE yet (the per-lane query surfaces are
//     the acceptance leg's, optimizer-pipeline.ts §"still INJECTS"), so the default is an
//     HONEST EMPTY result — never a crash, never a fabricated proposal. When the
//     acceptance leg wires `lanes`, this composes the real pipeline unchanged.
//
//   • markOptimizerActionApplied — writes ONE intent row into `optimizer_actions` via
//     outcome-tracker.buildOptimizerActionTarget (the snapshotted, re-runnable watch
//     predicate). Records human intent + the §4.6 `unverified_at_apply` stamp; it does
//     NOT edit any CLAUDE.md / constants / scaffold file.
//
//   • signOptimizerDerivation — the G2 sign-off (classifier addendum §5.4): inserts a
//     `verified` row into `optimizer_derivation_verifications` when the human clicks.
//     UI/IPC-only; no MCP path, no auto-sign. The caller supplies every fingerprint /
//     artifact field (the acceptance leg builds the parity artifact); this NEVER
//     re-derives them.

import type {
  ContextOptimizerQuery,
  ContextOptimizerResult,
  MarkOptimizerActionAppliedRequest,
  SignOptimizerDerivationRequest,
} from '../../shared/types';
import { generateContextOptimizerProposals } from './context-optimizer';
import {
  runOptimizerPipeline,
  type PipelineDb,
  type RawLaneInputs,
} from './optimizer-pipeline';
import { buildOptimizerActionTarget } from './outcome-tracker';
import type { BirthdayResolver, ResidentTarget } from './resident-inventory';

// ── analyze (read-only) ───────────────────────────────────────────────────────

export interface OptimizerAnalyzeDeps {
  generatedAtIso: string;
  nowMs: number;
  /** Per-lane raw module inputs. Absent/empty ⇒ the honest EMPTY result. The
   *  acceptance leg assembles these from the corpus and passes them through. */
  lanes?: RawLaneInputs[];
  db?: PipelineDb;
  backfillTargets?: ResidentTarget[];
  birthdayResolver?: BirthdayResolver;
  query?: ContextOptimizerQuery;
}

/**
 * Run the optimizer engine. With no lanes wired yet this returns the engine's own
 * empty-lane result (empty proposals + fileHeat, zeroed modelStats, populated
 * `meta.tierGroups`) — the panel renders that as the honest "empty / corpus run
 * pending" state, NOT a blank surface. With lanes + db + resolver it delegates to
 * the production pipeline (seam ordering intact).
 */
export function runOptimizerAnalyze(deps: OptimizerAnalyzeDeps): ContextOptimizerResult {
  const lanes = deps.lanes ?? [];
  if (lanes.length === 0 || !deps.db || !deps.birthdayResolver) {
    return generateContextOptimizerProposals({
      generatedAtIso: deps.generatedAtIso,
      lanes: [],
      query: deps.query,
    });
  }
  const { result } = runOptimizerPipeline({
    db: deps.db,
    generatedAtIso: deps.generatedAtIso,
    nowMs: deps.nowMs,
    backfillTargets: deps.backfillTargets ?? [],
    birthdayResolver: deps.birthdayResolver,
    lanes,
    query: deps.query,
  });
  return result;
}

// ── writers ───────────────────────────────────────────────────────────────────

/** The minimal write surface both the real better-sqlite3 handle and the sql.js
 *  test stand-in satisfy structurally. */
export interface OptimizerWriterDb {
  prepare(sql: string): { run(...args: unknown[]): unknown };
}

/**
 * "Mark applied" — insert one INTENT row into `optimizer_actions`. Uses
 * buildOptimizerActionTarget for the immutable, re-runnable `target_json` +
 * `target_predicate_hash`. The `unverified_at_apply` stamp (§4.6) is recorded in the
 * row note. NEVER edits a config file.
 */
export function markOptimizerActionApplied(
  db: OptimizerWriterDb,
  req: MarkOptimizerActionAppliedRequest,
  nowMs: number,
): { actionId: string; targetPredicateHash: string } {
  const { target, targetPredicateHash } = buildOptimizerActionTarget({
    proposal: { kind: req.kind, target: req.target },
    lane: req.lane,
    watchLanes: req.watchLanes,
    includeSubagents: req.includeSubagents,
    proposedEdit: req.proposedEdit,
    epochRefs: req.epochRefs ?? [],
    // The panel does not hold the snapshotted matchers; an empty set is the honest
    // intent record. The acceptance leg enriches these before reconciliation.
    predictedActions: [],
  });

  const actionId = `oa_${targetPredicateHash.slice(0, 16)}_${nowMs}`;
  const note = req.unverifiedAtApply
    ? `[unverified_at_apply] ${req.note ?? ''}`.trim()
    : (req.note ?? null);

  db.prepare(
    `INSERT INTO optimizer_actions
       (id, proposal_id, kind, lane, target_json, target_predicate_hash, status,
        applied_at_ms, detected_at_ms, after_start_ms, reverted_at_ms, note,
        created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 'marked_applied', ?, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(
    actionId,
    req.proposalId,
    req.kind,
    req.lane,
    JSON.stringify(target),
    targetPredicateHash,
    nowMs,
    note,
    nowMs,
    nowMs,
  );

  return { actionId, targetPredicateHash };
}

/**
 * G2 sign-off — insert/replace a `verified` derivation row. Human-gated: only called
 * from the IPC handler behind an explicit confirm. Sets `status='verified'` and stamps
 * `signed_off_at_ms`. No re-derivation of fingerprints (all supplied by the caller).
 */
export function signOptimizerDerivation(
  db: OptimizerWriterDb,
  req: SignOptimizerDerivationRequest,
  nowMs: number,
): { gateName: string } {
  db.prepare(
    `INSERT OR REPLACE INTO optimizer_derivation_verifications
       (gate_name, lane, status, parser_version, compiler_version,
        corpus_fingerprint, config_fingerprint, toolset_inventory_fingerprint,
        empirical_report_fingerprint, signed_histogram_json, signed_split_json,
        artifact_path, artifact_sha256, signed_off_by, signed_off_at_ms, notes)
     VALUES (?, ?, 'verified', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    req.gateName,
    req.lane,
    req.parserVersion,
    req.compilerVersion,
    req.corpusFingerprint,
    req.configFingerprint,
    req.toolsetInventoryFingerprint,
    req.empiricalReportFingerprint,
    req.signedHistogramJson,
    req.signedSplitJson,
    req.artifactPath,
    req.artifactSha256,
    req.signedOffBy ?? null,
    nowMs,
    req.notes ?? null,
  );
  return { gateName: req.gateName };
}
