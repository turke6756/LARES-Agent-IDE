// optimizer-scaffold-registry.ts — WP6 acceptance leg. The PRODUCTION
// `ScaffoldConstantEntry[]` registry that closes seam #2 (config-epoch-backfill's
// §3.2.3 scaffold-constant history bridge).
//
// The A2 cold-start backfill dates each resident section by walking git history.
// A `.dashboard/…` scaffold file is gitignored/generated — it has NO git history of
// its OWN — but it MIRRORS a managed constant in `src/shared/constants.ts`
// (SUPERVISOR_AGENT_MD, WORKER_CLAUDE_MD, the skill-body constants, …). This registry
// maps each such resident target back to the constant whose lineage in `constants.ts`
// the backfill should walk, so a section that was ALREADY trimmed on disk can still be
// dated from the constant's git-historical revisions (master §3, hardening-epochs A2).
//
// One `ScaffoldConstantEntry` per managed constant:
//   • `constantSymbol` — the exported symbol in constants.ts (`extractConstantTemplate`
//     pulls the template-literal body out of each revision).
//   • `matches(target)` — TRUE when the resident target is the mirror of this constant.
//     Keyed on `sourceSymbol` when a ScaffoldMatcher resolved one (pooled identity),
//     ELSE on the resident path tail (the robust default — collectMarkdownTargets ships
//     `sourceSymbol: null` until the pooling oracle is wired).
//
// Pure + dependency-light (no DB, no git, no constants import): a data table + string
// predicates, so it is unit-testable against synthetic ResidentTargets and — via
// `makeScaffoldConstantResolver` — against the real constants.ts checked into the repo.

import {
  makeScaffoldConstantResolver,
  type ScaffoldConstantEntry,
  type ScaffoldConstantResolverDeps,
} from './optimizer-pipeline';
import type { ScaffoldConstantBridge } from './config-epoch-backfill';
import type { ResidentTarget } from './resident-inventory';

/** Normalize a resident path for tail matching: backslashes → forward slashes,
 *  lower-cased (scaffold path tails are ASCII + case-stable, and the DB spine already
 *  LOWERs arg paths — matching that convention avoids a Windows-vs-WSL case split). */
function normTail(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

/** One managed-constant → resident-mirror mapping. `pathTails` are resident-path
 *  suffixes (each already normalized) that identify this constant's scaffold copies.
 *  A skill body has one tail that matches its per-lane copies (supervisor / worker /
 *  researcher) at once; a persona CLAUDE.md has a single lane-specific tail. */
interface ScaffoldRegistryRow {
  constantSymbol: string;
  pathTails: string[];
}

// The managed scaffold constants whose sections the backfill must be able to date
// from git. Kept in sync with the SUPERVISOR_FILES / WORKER_FILES / RESEARCHER_FILES
// scaffold maps in src/main/supervisor/index.ts (the authoritative path↔constant
// registry). Persona CLAUDE.md constants + the shared skill bodies are the ones that
// carry datable markdown sections; settings.json / .sh / .mjs scaffolds are not
// markdown targets and never reach this bridge.
const REGISTRY_ROWS: ScaffoldRegistryRow[] = [
  // Persona CLAUDE.md (one per native lane). Both state-dir spellings: `.lares`
  // is live; `.dashboard` appears in pre-rename resident targets.
  { constantSymbol: 'SUPERVISOR_AGENT_MD', pathTails: ['/.lares/supervisor/claude.md', '/.dashboard/supervisor/claude.md'] },
  { constantSymbol: 'WORKER_CLAUDE_MD', pathTails: ['/.lares/workers/claude/claude.md', '/.dashboard/workers/claude/claude.md'] },
  { constantSymbol: 'RESEARCHER_AGENT_MD', pathTails: ['/.lares/researcher/claude.md', '/.dashboard/researcher/claude.md'] },
  // Skill bodies — one tail matches every lane's copy of that skill's SKILL.md.
  { constantSymbol: 'SUPERVISOR_RUN_ORCHESTRATION_SKILL', pathTails: ['/skills/run-orchestration/skill.md'] },
  { constantSymbol: 'SUPERVISOR_ORCHESTRATION_SPIKE_SKILL', pathTails: ['/skills/orchestration-spike/skill.md'] },
  { constantSymbol: 'PERSONA_CREATE_PERSONA_SKILL', pathTails: ['/skills/create-persona/skill.md'] },
  { constantSymbol: 'PERSONA_READ_COMMENTS_SKILL', pathTails: ['/skills/read-comments/skill.md'] },
];

/** Build a `matches(target)` predicate for one registry row. `sourceSymbol` (when the
 *  ScaffoldMatcher resolved a pooled identity) wins; otherwise the resident path tail. */
function matcherFor(row: ScaffoldRegistryRow): (target: ResidentTarget) => boolean {
  return (target: ResidentTarget): boolean => {
    if (target.sourceSymbol && target.sourceSymbol === row.constantSymbol) return true;
    const tail = normTail(target.sourcePath);
    return row.pathTails.some((t) => tail.endsWith(t));
  };
}

/** The production `ScaffoldConstantEntry[]` registry (seam #2). One entry per managed
 *  markdown-bearing scaffold constant, in a stable order. */
export const PRODUCTION_SCAFFOLD_ENTRIES: ScaffoldConstantEntry[] = REGISTRY_ROWS.map((row) => ({
  constantSymbol: row.constantSymbol,
  matches: matcherFor(row),
}));

/** Convenience: the production `scaffoldConstant` resolver for `GitBirthdayDeps`,
 *  bound to the repo's `src/shared/constants.ts`. `repoDir` is the repository root that
 *  contains `src/shared/constants.ts` (NOT the workspace — the constant lineage lives in
 *  the app's own source tree). */
export function makeProductionScaffoldConstantResolver(
  repoDir: string,
  over: Partial<Omit<ScaffoldConstantResolverDeps, 'repoDir' | 'entries'>> = {},
): (target: ResidentTarget) => ScaffoldConstantBridge | null {
  return makeScaffoldConstantResolver({
    repoDir,
    entries: PRODUCTION_SCAFFOLD_ENTRIES,
    ...over,
  });
}
