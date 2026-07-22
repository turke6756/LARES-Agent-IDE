// optimizer-production.ts — WP6 acceptance leg, task A. The PRODUCTION dependency
// composer for the optimizer pipeline: it binds the pure WP0–WP6 seams to the real
// filesystem + git + the scaffold-constant registry, producing the injectable deps
// `runOptimizerPipeline` / `runOptimizerAnalyze` need.
//
// This leg lands the composition that is fully determined by already-shipped code —
// the git-backed `BirthdayResolver` (task A). The per-lane `RawLaneInputs[]` assembly
// (task B) and its IPC wiring (task C) compose ON TOP of this using the seam readers
// in optimizer-pipeline.ts (queryFileTouches / queryBypassExecEvents / aggregateFileTouches
// / toBypassExecEvents / querySkillInvocationWindows / querySkillLaneExposures) plus the
// module detectors; see the continuation contract in the WP6 handoff.

import * as fs from 'node:fs';
import { makeGitBirthdayResolver } from './config-epoch-backfill';
import { execFileGitRunner, type GitRunner } from './git-history';
import { makeProductionScaffoldConstantResolver } from './optimizer-scaffold-registry';
import type { BirthdayResolver } from './resident-inventory';

/**
 * The production §3 cold-start `BirthdayResolver` (task A). Dates each brand-new
 * resident section by walking git history:
 *   • the resident file's OWN git history (tracked runtime files), else
 *   • the mirrored scaffold constant's lineage in `<repoDir>/src/shared/constants.ts`
 *     (gitignored `.lares/…` copies — via `makeProductionScaffoldConstantResolver`),
 *   • falling through to the file mtime, then 'none'.
 *
 * `repoDir` is the APP's own repository root (where `src/shared/constants.ts` lives),
 * NOT the analyzed workspace — the constant lineage is in the app source tree.
 */
export function makeProductionBirthdayResolver(
  repoDir: string,
  git: GitRunner = execFileGitRunner,
): BirthdayResolver {
  return makeGitBirthdayResolver({
    git,
    statMtimeMs: (p) => {
      try {
        const ms = fs.statSync(p).mtimeMs;
        return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    },
    scaffoldConstant: makeProductionScaffoldConstantResolver(repoDir),
  });
}

/** The production deps bundle the pipeline composes over. Task A ships the birthday
 *  resolver; task B extends this with the per-lane `RawLaneInputs[]` builder. */
export interface ProductionOptimizerDeps {
  birthdayResolver: BirthdayResolver;
}

/**
 * Compose the production optimizer deps (task A). `repoDir` is the app repo root that
 * contains `src/shared/constants.ts`; `gitRunner` defaults to the real `git` binary
 * and degrades to `null` on any failure (git-history.ts), so a non-repo / git-less
 * host still yields an honest mtime/none-dated resolver rather than throwing.
 */
export function makeProductionOptimizerDeps(
  repoDir: string,
  gitRunner: GitRunner = execFileGitRunner,
): ProductionOptimizerDeps {
  return { birthdayResolver: makeProductionBirthdayResolver(repoDir, gitRunner) };
}
