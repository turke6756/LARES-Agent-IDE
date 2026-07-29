// launch-injection.ts — the provider-neutral supervisor memory-index projection
// for the launch flow (WP-C). This is the ONE place the launch path turns a
// workspace's MEMORY.md into the bytes injected into a supervisor's context,
// and the ONE place the launch flow drives the durable side-effects that ride
// alongside it (last-known-good source, runtime-error state, review-queue
// reconciliation). Delivery differs by provider — Claude splices the returned
// text into its --append-system-prompt-file block; Codex stages it on the
// pending-message rail — but both consume THIS function's identical bytes.
//
// It composes the landed modules and never re-implements them:
//   • io.ts (WP-A2)              — readValidateProject (full pure + I/O validation
//                                  over the live MEMORY.md) and validateIO (the
//                                  I/O-only HARD classes, re-run over a fallback
//                                  SOURCE string that is not on disk).
//   • memory-index-core.ts (WP-A1) — the pure parse/validate/project pipeline.
//   • review-store.ts (WP-B)     — getIndexState/putIndexState/putRuntimeError,
//                                  upsertFindings, and reconcileMemoryEvidence.
//
// Severity flow (plans/memory-lessons-v2-implementation.md §WP-C step 2-3):
//   RUNTIME (read/parse threw)  → putRuntimeError + console.error; inject NOTHING;
//                                 no reconcile. Launch proceeds (fail-open).
//   current parse VALID         → putIndexState (clears last_runtime_error);
//                                 upsert advisory findings; reconcile against the
//                                 current valid source; inject its projected text.
//   current parse HARD-invalid  → persist the hard-invalid finding; load the
//                                 last-known-good SOURCE and RE-RUN full I/O
//                                 validation on it (a formerly valid detail:
//                                 pointer may now be missing/escaping). If the
//                                 fallback is still valid → re-project it with
//                                 TODAY's date and prefix a loud banner, and
//                                 reconcile against that revalidated fallback. If
//                                 the fallback is now itself invalid, or there is
//                                 no prior good source → inject a banner ONLY (no
//                                 index) and DO NOT reconcile (never clear/mutate
//                                 findings from an invalid parse).
//
// This module performs NO filesystem writes: readValidateProject only reads
// MEMORY.md, so the live file's bytes and mtime are untouched across a launch.

import crypto from 'crypto';
import {
  parseIndex,
  validateParsed,
  projectParsed,
  STALE_ACTIVE_DAYS,
  type Finding,
  type ParsedIndex,
} from '../../shared/memory-index-core';
import { readValidateProject, validateIO, type ReadValidateProjectResult } from './io';
import {
  getIndexState,
  putIndexState,
  putRuntimeError,
  upsertFindings,
  reconcileMemoryEvidence,
  type FindingInput,
} from './review-store';

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// ── Banners (provider-neutral; the same bytes reach Claude and Codex) ─────────
/** Prefixed ahead of a re-validated last-good fallback that is being injected
 *  because the LIVE MEMORY.md is HARD-invalid. */
export function fallbackBanner(validatedAt: string | null): string {
  return (
    `<!-- ⚠ MEMORY INDEX WARNING: the live MEMORY.md is INVALID and was NOT injected. ` +
    `Showing the last validated snapshot${validatedAt ? ` (validated ${validatedAt})` : ''}, ` +
    `re-checked against the current detail files and re-projected for today. ` +
    `Fix the live index — run \`node .lares/scripts/memory-index.mjs validate\`. -->`
  );
}

/** Injected (alone, no index) when the live MEMORY.md is HARD-invalid AND there
 *  is no valid fallback (no prior good source, or the fallback is now itself
 *  I/O-invalid). Never inject unvalidated fallback bytes. */
export const BANNER_ONLY =
  `<!-- ⚠ MEMORY INDEX WARNING: the workspace MEMORY.md is INVALID and no valid ` +
  `fallback snapshot exists, so NO memory index was injected this launch. ` +
  `Fix the live index — run \`node .lares/scripts/memory-index.mjs validate\`. -->`;

// ── Findings mapping (valid source only) ──────────────────────────────────────
/** Per-entry content hash so a materially-changed entry yields a new finding_id
 *  and recurs (WP-B), and index-level findings share the whole-index hash. */
function entryHash(parsed: ParsedIndex, id: string): string {
  const e = parsed.entries.find((x) => x.id === id);
  return e ? sha256Hex(parsed.normalized.slice(e.blockStart, e.blockEnd)) : sha256Hex(id);
}

/**
 * The advisory review-queue findings the launch path upserts from a VALID
 * source: the pure advisory classes (cap-pressure) plus the projection's
 * lifecycle signals — stale-active and condition-review — which the core reports
 * as id lists rather than Finding objects. reconcileMemoryEvidence separately
 * produces never-recalled / never-fired|evidence-unavailable / cap-pressure.
 */
function advisoryFindings(r: ReadValidateProjectResult): FindingInput[] {
  const whole = sha256Hex(r.parsed.raw);
  const out: FindingInput[] = [];
  for (const f of r.advisory) {
    out.push({ kind: f.cls, entryId: f.id, sourceHash: f.id ? entryHash(r.parsed, f.id) : whole, reason: f.message });
  }
  for (const id of r.projection.staleActive) {
    out.push({
      kind: 'stale-active',
      entryId: id,
      sourceHash: entryHash(r.parsed, id),
      reason: `active entry ${id} is older than ${STALE_ACTIVE_DAYS} days — confirm it is still current`,
    });
  }
  for (const id of r.projection.conditionReview) {
    const e = r.parsed.entries.find((x) => x.id === id);
    out.push({
      kind: 'condition-review',
      entryId: id,
      sourceHash: entryHash(r.parsed, id),
      reason: `active entry ${id} carries an expires-when condition — review whether it has fired`,
      exitCondition: e?.expiresWhen ?? null,
    });
  }
  return out;
}

/** One whole-index HARD-invalid review finding (entry_id NULL + whole-index
 *  source hash, per WP-B), summarizing the failing classes for the reviewer. */
function hardInvalidFinding(parsed: ParsedIndex, hard: Finding[]): FindingInput {
  const classes = [...new Set(hard.map((f) => f.cls))].join(', ');
  return {
    kind: 'hard-invalid',
    entryId: null,
    sourceHash: sha256Hex(parsed.raw),
    reason: `MEMORY.md failed validation and was not injected (${classes})`,
  };
}

// ── Full-validation over a SOURCE string (fallback path) ──────────────────────
// io.ts.readValidateProject reads MEMORY.md from disk; the fallback is a SOURCE
// held in memory_index_state (not on disk), so it is validated by composing the
// SAME landed pieces — pure validateParsed + WP-A2 validateIO (re-checking the
// live detail files) + projectParsed — never a re-implementation.
function validateProjectText(text: string, workspaceRoot: string, nowISO: string): ReadValidateProjectResult {
  const parsed = parseIndex(text);
  const pure = validateParsed(parsed);
  const io = validateIO(parsed, workspaceRoot);
  const projection = projectParsed(parsed, { nowISO });
  const combinedHard = [...pure.hard, ...io.hard];
  const advisory = [...pure.advisory, ...io.advisory];
  return {
    parsed,
    hard: combinedHard,
    advisory,
    projection,
    injectText: combinedHard.length === 0 ? projection.injectText : '',
  };
}

// ── Result ────────────────────────────────────────────────────────────────────
export type MemoryInjectionOutcome =
  | 'valid' // current parse valid — its projected text injected
  | 'valid-empty' // current parse valid but the projection is empty (index dropped to nothing)
  | 'fallback' // current parse HARD-invalid — re-validated last-good fallback injected behind a banner
  | 'banner-only' // current parse HARD-invalid — no valid fallback; banner injected, no index
  | 'runtime'; // read/parse threw — nothing injected, fail-open

export interface SupervisorMemoryInjection {
  /** The exact bytes to deliver (may be '' on the runtime path). */
  injectText: string;
  outcome: MemoryInjectionOutcome;
}

/**
 * The provider-neutral launch projection + durable side-effects for ONE
 * supervisor launch. Reads MEMORY.md for `workspaceRoot`, validates + projects,
 * persists index-state / runtime-error / review findings per the severity flow,
 * and returns the bytes to inject. Never throws — a read/parse failure is mapped
 * to the RUNTIME outcome (nothing injected) so a launch never blocks on memory.
 */
export function computeSupervisorMemoryInjection(
  ws: string,
  workspaceRoot: string,
  nowISO: string,
): SupervisorMemoryInjection {
  // Step 1 — read + validate + project the LIVE index in-process. Only a
  // read/parse throw reaches here; map it to RUNTIME and fail open.
  let current: ReadValidateProjectResult;
  try {
    current = readValidateProject(workspaceRoot, nowISO);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      putRuntimeError(ws, msg, nowISO);
    } catch (persistErr) {
      console.error(`[memory-index] failed to persist runtime error for ${ws}:`, persistErr);
    }
    console.error(`[memory-index] RUNTIME read/parse failure for ${ws} — injecting nothing (fail-open):`, err);
    return { injectText: '', outcome: 'runtime' };
  }

  // Step 2a — current parse VALID: persist the last-known-good source (clears any
  // prior runtime error), upsert advisory findings, reconcile against it, inject.
  if (current.hard.length === 0) {
    putIndexState(ws, {
      sourceText: current.parsed.raw,
      sourceHash: sha256Hex(current.parsed.raw),
      parsedJson: JSON.stringify(current.parsed),
      validatedAt: nowISO,
    });
    const advIds = upsertFindings(ws, advisoryFindings(current), nowISO);
    // Reconcile ONLY against a valid source; keep the advisory ids so the
    // reconciliation sweep does not clear them (WP-B keepExternalIds).
    reconcileMemoryEvidence(ws, current.parsed, nowISO, { keepExternalIds: advIds });
    return {
      injectText: current.injectText,
      outcome: current.injectText ? 'valid' : 'valid-empty',
    };
  }

  // Step 2b — current parse HARD-invalid. Persist the hard-invalid finding; try
  // the last-known-good SOURCE, re-running FULL I/O validation over it.
  const hardFinding = hardInvalidFinding(current.parsed, current.hard);
  const prior = getIndexState(ws);
  if (prior?.sourceText) {
    const fb = validateProjectText(prior.sourceText, workspaceRoot, nowISO);
    if (fb.hard.length === 0) {
      // Fallback still valid → re-project TODAY + banner, reconcile against it.
      const keepIds = upsertFindings(ws, [hardFinding, ...advisoryFindings(fb)], nowISO);
      reconcileMemoryEvidence(ws, fb.parsed, nowISO, { keepExternalIds: keepIds });
      return {
        injectText: `${fallbackBanner(prior.validatedAt)}\n\n${fb.injectText}`,
        outcome: 'fallback',
      };
    }
  }

  // No prior good source, or the fallback is now itself I/O-invalid → banner
  // only, never unvalidated bytes. Upsert the hard-invalid finding but DO NOT
  // reconcile (no valid source ⇒ never clear/mutate findings from an invalid
  // parse). upsertFindings does not clear, so this preserves history.
  upsertFindings(ws, [hardFinding], nowISO);
  return { injectText: BANNER_ONLY, outcome: 'banner-only' };
}

// ── Codex pending-rail composition ────────────────────────────────────────────
/**
 * Compose the memory index ahead of any base pending message (the Codex
 * single-slot rail; index-only when there is no base). Identical index bytes to
 * the Claude sysprompt splice; only this wrapper differs.
 */
export function composeMemoryPending(injectText: string, baseText: string): string {
  if (!injectText) return baseText;
  if (!baseText) return injectText;
  return `${injectText}\n\n${baseText}`;
}
