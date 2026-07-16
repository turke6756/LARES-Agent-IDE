// config-epoch-backfill.ts — WP5 module 0. The §3 one-shot cold-start backfill that
// seats every resident section's `first_seen_ms` from history BEFORE the first
// classification. Without it, day one every section opens at parse-time → the
// classifier returns `insufficient-exposure` for all → no section can reach `never`
// → WP6's SUBTRACT acceptance (rediscover QW1/QW3) structurally fails (§3, master
// lines 373-378).
//
// Two exports:
//  1. `makeGitBirthdayResolver` — the git section-hash `BirthdayResolver` that
//     overrides the module-1 `noneBirthdayResolver` default. Birthday precedence
//     (first that yields a date wins, §3.2):
//       git_section_history (high) → git_blame (medium) → scaffold_constant (medium)
//       → mtime (low) → none (low).
//     git_section_history is the ONLY method that survives a whole-file scaffold
//     rewrite (blame collapses every line to the rewrite date; a per-section
//     content-hash match across revisions recovers the real birthday, §3.2.1).
//  2. `runEpochBackfill` — the one-shot runner. Guarded by `epochs_backfilled_at`
//     in `skill_analytics_meta`; a no-op (and therefore NO git) once stamped at the
//     current parser_version (§1.5, §3.5). A parser bump re-opens it.

import * as path from 'node:path';
import {
  blameMaxCommitterMs, listRevisions, repoRootFor, showFileAtRevision, type GitRunner,
} from './git-history';
import { RESIDENT_PARSER_VERSION } from './optimizer-config';
import {
  deriveAnchors, parseMarkdownSections, writeResidentInventory,
  type BirthdayResolver, type FirstSeenConfidence, type FirstSeenSource,
  type LedgerDb, type ReconcileResult, type ResidentTarget, type SectionCandidate,
} from './resident-inventory';

// ─────────────────────────────────────────────────────────────────────────────
// The git section-hash BirthdayResolver (§3.2 tiers 1-4; falls through to 'none')
// ─────────────────────────────────────────────────────────────────────────────

/** §3.2.3 scaffold-constant history bridge. Given a resident target whose OWN path
 *  has no git history (a gitignored / generated runtime file that nonetheless
 *  mirrors a managed scaffold constant), return the constant's git coordinates plus
 *  a text extractor so section-hash history can run against the constant's lineage
 *  in `src/shared/constants.ts` ("constant-hash history"). null ⇒ tier skipped. */
export interface ScaffoldConstantBridge {
  repoDir: string;
  relPath: string;
  /** Pull the constant's markdown string out of a `constants.ts` revision's source;
   *  null when the constant is absent at that revision. */
  extractConstantText(fileText: string): string | null;
}

export interface GitBirthdayDeps {
  git: GitRunner;
  /** File mtime in ms for the §3.2.4 low-confidence tier; null when unavailable. */
  statMtimeMs(absPath: string): number | null;
  /** §3.2.3 bridge; omitted ⇒ scaffold-constant tier never fires (honest). */
  scaffoldConstant?(target: ResidentTarget): ScaffoldConstantBridge | null;
}

/** Build the one-shot git resolver. A per-instance cache memoizes the set of
 *  content-hashes present at each (repoDir, relPath, revision) so scanning the N
 *  sections of one target re-uses a single `git show` + parse per revision. */
export function makeGitBirthdayResolver(deps: GitBirthdayDeps): BirthdayResolver {
  const hashCache = new Map<string, Set<string> | null>();

  const hashesAt = (
    repoDir: string, relPath: string, hash: string,
    extract: (raw: string) => string | null,
  ): Set<string> | null => {
    const key = `${repoDir}\0${relPath}\0${hash}`;
    if (hashCache.has(key)) return hashCache.get(key) ?? null;
    const raw = showFileAtRevision(deps.git, repoDir, hash, relPath);
    const text = raw == null ? null : extract(raw);
    const set = text == null
      ? null
      : new Set(deriveAnchors(parseMarkdownSections(text)).map((s) => s.contentHash));
    hashCache.set(key, set);
    return set;
  };

  /** Earliest revision (oldest-first list) whose extracted content contains the
   *  section's content_hash, in ms; null if no revision does. */
  const earliestWithHash = (
    repoDir: string, relPath: string, contentHash: string,
    extract: (raw: string) => string | null,
  ): number | null => {
    for (const rev of listRevisions(deps.git, repoDir, relPath)) {
      const set = hashesAt(repoDir, relPath, rev.hash, extract);
      if (set && set.has(contentHash)) return rev.committedMs; // oldest-first ⇒ first hit is earliest
    }
    return null;
  };

  const identity = (raw: string): string => raw;

  return {
    resolve(target: ResidentTarget, section: SectionCandidate, nowMs: number): {
      firstSeenMs: number; source: FirstSeenSource; confidence: FirstSeenConfidence;
    } {
      const abs = target.sourcePath;
      const root = repoRootFor(deps.git, path.dirname(abs));

      // Tiers 1-2 — the resident file's OWN git history (a tracked runtime file).
      if (root) {
        const relPath = path.relative(root, abs);
        if (listRevisions(deps.git, root, relPath).length > 0) {
          // §3.2.1 section-history — survives whole-file scaffold rewrites.
          const hist = earliestWithHash(root, relPath, section.contentHash, identity);
          if (hist != null) return { firstSeenMs: hist, source: 'git_section_history', confidence: 'high' };
          // §3.2.2 blame — MAX committer time over the current section's non-blank
          // lines. Clamp the range to the file's real line count: module-1's parse
          // reports `lineEnd` one past EOF for a trailing-newline final section, and
          // `git blame -L` errors (→ null, tier silently lost) on an out-of-range end.
          const fileLines = target.text.replace(/\r\n?/g, '\n').split('\n');
          const lastLine = fileLines.length - (fileLines[fileLines.length - 1] === '' ? 1 : 0);
          const ls = Math.max(1, Math.min(section.lineStart, lastLine));
          const le = Math.max(ls, Math.min(section.lineEnd, lastLine));
          const blamed = blameMaxCommitterMs(deps.git, root, relPath, ls, le);
          if (blamed != null) return { firstSeenMs: blamed, source: 'git_blame', confidence: 'medium' };
        }
      }

      // §3.2.3 — ignored/generated file mirroring a managed constant: date it from
      // the constant's own section-hash history in constants.ts.
      const bridge = deps.scaffoldConstant?.(target);
      if (bridge) {
        const hist = earliestWithHash(
          bridge.repoDir, bridge.relPath, section.contentHash, bridge.extractConstantText,
        );
        if (hist != null) return { firstSeenMs: hist, source: 'scaffold_constant', confidence: 'medium' };
      }

      // §3.2.4 — mtime floor for locally-diverged / undated content.
      const mt = deps.statMtimeMs(abs);
      if (mt != null) return { firstSeenMs: mt, source: 'mtime', confidence: 'low' };

      // §3.2.5 — no signal: honest, reads `insufficient-exposure`, never killable.
      return { firstSeenMs: nowMs, source: 'none', confidence: 'low' };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The one-shot backfill runner (guarded by skill_analytics_meta, §1.5 / §3.5)
// ─────────────────────────────────────────────────────────────────────────────

export const EPOCHS_BACKFILLED_AT_KEY = 'epochs_backfilled_at';
export const EPOCHS_BACKFILLED_VERSION_KEY = 'epochs_backfilled_parser_version';

function getMeta(db: LedgerDb, k: string): string | null {
  const row = db.prepare('SELECT v FROM skill_analytics_meta WHERE k = @k').get({ k });
  return row ? String(row.v) : null;
}
function setMeta(db: LedgerDb, k: string, v: string): void {
  db.prepare('INSERT OR REPLACE INTO skill_analytics_meta (k, v) VALUES (@k, @v)').run({ k, v });
}

/** The §3 backfill is complete iff the marker is stamped AT the current
 *  parser_version. A parser bump (RESIDENT_PARSER_VERSION) re-opens it, matching the
 *  parity-gate invalidation contract. */
export function isEpochsBackfilled(db: LedgerDb, parserVersion = RESIDENT_PARSER_VERSION): boolean {
  if (getMeta(db, EPOCHS_BACKFILLED_AT_KEY) == null) return false;
  return Number(getMeta(db, EPOCHS_BACKFILLED_VERSION_KEY)) === parserVersion;
}

export interface EpochBackfillDeps {
  db: LedgerDb;
  resolver: BirthdayResolver;
  nowMs: number;
  parserVersion?: number;
}

export interface EpochBackfillOutcome {
  ran: boolean;
  results: { target: ResidentTarget; result: ReconcileResult }[];
}

/** Run the ONE-SHOT §3 cold-start backfill over the resident markdown targets a
 *  lane inherits, dating each brand-new section via the git resolver, then stamp the
 *  guard. No-op (returns `ran:false`, and therefore touches NO git) once already
 *  backfilled at the current parser_version (§3.5). Idempotent by construction. */
export function runEpochBackfill(
  targets: ResidentTarget[], deps: EpochBackfillDeps,
): EpochBackfillOutcome {
  const parserVersion = deps.parserVersion ?? RESIDENT_PARSER_VERSION;
  if (isEpochsBackfilled(deps.db, parserVersion)) return { ran: false, results: [] };

  const results = writeResidentInventory(deps.db, targets, {
    nowMs: deps.nowMs, birthday: deps.resolver, parserVersion,
  });

  setMeta(deps.db, EPOCHS_BACKFILLED_AT_KEY, String(deps.nowMs));
  setMeta(deps.db, EPOCHS_BACKFILLED_VERSION_KEY, String(parserVersion));
  return { ran: true, results };
}
