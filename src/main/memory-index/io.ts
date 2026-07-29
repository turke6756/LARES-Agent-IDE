// Memory-index v2 — the I/O validation layer (WP-A2).
//
// This is the ONLY memory-index module allowed `fs`/`realpath`. It composes with
// the pure core (src/shared/memory-index-core.ts) — it never re-implements any
// pure class. It adds the three HARD findings the pure core cannot produce
// because they require the filesystem:
//   • detail-missing  — a declared `detail:` pointer whose file is absent.
//   • detail-escape   — a `detail:` pointer whose realpath resolves OUTSIDE the
//                       exact MEMORY_DETAILS_DIR (a symlink/junction escape, a
//                       `..` traversal, or a location merely under memory/ but
//                       outside details/).
//   • orphan-details  — a detail file present on disk with NO index entry.
//
// Layout (single source of truth — MEMORY_DETAILS_DIR):
//   <workspaceRoot>/.lares/supervisor/memory/MEMORY.md      ← the index
//   <workspaceRoot>/.lares/supervisor/memory/details/<id>.md ← detail files
// `detail:` pointers are authored relative to the supervisor cwd
// (`.lares/supervisor/`), e.g. `memory/details/mb-2026-07-28-x.md`, so they are
// resolved against that directory and then realpath-contained beneath the exact
// details dir.
//
// This same source is imported in-process by main (compiled to CommonJS in
// dist/main) AND esbuild-bundled — via scripts/memory-index-cli-entry.ts — into
// the scaffolded .lares/scripts/memory-index.mjs. To keep that bundle free of
// heavy transitive deps, the containment check is a small local helper rather
// than an import of src/main/security/path-confinement (which drags in
// path-utils). That mirrors the deliberate pure/io split of the core.

import * as fs from 'fs';
import * as path from 'path';
import {
  parseIndex,
  validateParsed,
  projectParsed,
  MEMORY_DETAILS_DIR,
  type Finding,
  type ParsedIndex,
  type ValidateResult,
  type ProjectionResult,
} from '../../shared/memory-index-core';

function hard(cls: string, id: string | null, message: string): Finding {
  return { cls, severity: 'hard', id, message };
}

/** True iff absolute `target` lies STRICTLY beneath absolute `dir` (not `dir`
 *  itself). Both inputs are expected to be already realpath-resolved so symlink
 *  escapes are caught before this lexical check runs. */
function isInsideDir(target: string, dir: string): boolean {
  const rel = path.relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The supervisor cwd and details dir for a workspace root. Derived from the
 *  ratified MEMORY_DETAILS_DIR constant so there is one source of the layout. */
function memoryDirs(workspaceRoot: string): { supervisorDir: string; detailsDir: string; memoryMd: string } {
  const detailsDir = path.join(workspaceRoot, ...MEMORY_DETAILS_DIR.split('/').filter(Boolean));
  // detailsDir = <root>/.lares/supervisor/memory/details ; go up two for the
  // supervisor cwd (the base `detail:` pointers are authored relative to).
  const supervisorDir = path.resolve(detailsDir, '..', '..');
  const memoryMd = path.join(supervisorDir, 'memory', 'MEMORY.md');
  return { supervisorDir, detailsDir, memoryMd };
}

/** Realpath `p`, or null if it does not exist / cannot be resolved. */
function tryRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * The filesystem-dependent HARD findings, layered on top of the pure classes.
 * Never throws on content: a missing details dir simply yields no orphans and
 * turns every declared pointer into `detail-missing` / `detail-escape`.
 */
export function validateIO(parsed: ParsedIndex, workspaceRoot: string): ValidateResult {
  const hardFindings: Finding[] = [];
  const { supervisorDir, detailsDir } = memoryDirs(workspaceRoot);
  const canonicalDetailsDir = tryRealpath(detailsDir);

  // Realpaths of the detail files that a VALID (existing + contained) pointer
  // resolves to — used to decide which on-disk files are orphans.
  const referenced = new Set<string>();

  for (const e of parsed.entries) {
    const pointer = e.detail;
    if (!pointer) continue; // no declared detail file → nothing to resolve
    const candidate = path.resolve(supervisorDir, pointer);
    const real = tryRealpath(candidate);
    if (real === null) {
      hardFindings.push(hard('detail-missing', e.id, `detail file for ${e.id} does not exist: ${pointer}`));
      continue;
    }
    // Exists → must land strictly beneath the exact details dir. If the details
    // dir itself is absent, nothing can be contained ⇒ every resolvable pointer
    // escapes.
    if (canonicalDetailsDir === null || !isInsideDir(real, canonicalDetailsDir)) {
      hardFindings.push(
        hard('detail-escape', e.id, `detail pointer for ${e.id} resolves outside ${MEMORY_DETAILS_DIR}: ${pointer}`),
      );
      continue;
    }
    referenced.add(real);
  }

  // orphan-details: files physically in the details dir that no entry references.
  if (canonicalDetailsDir !== null) {
    let dirents: fs.Dirent[] = [];
    try {
      dirents = fs.readdirSync(detailsDir, { withFileTypes: true });
    } catch {
      dirents = [];
    }
    for (const d of dirents) {
      if (!d.isFile() && !d.isSymbolicLink()) continue; // only files can be orphan detail bodies
      const real = tryRealpath(path.join(detailsDir, d.name));
      if (real === null) continue; // a broken symlink is not a valid detail body
      if (!referenced.has(real)) {
        hardFindings.push(hard('orphan-details', null, `orphan detail file with no index entry: ${d.name}`));
      }
    }
  }

  return { hard: hardFindings, advisory: [] };
}

// ── Full-validation entry point ───────────────────────────────────────────────
export interface ReadValidateProjectResult {
  parsed: ParsedIndex;
  /** pure HARD findings + I/O HARD findings, combined. */
  hard: Finding[];
  /** pure advisory findings (+ I/O advisory, of which there are none today). */
  advisory: Finding[];
  projection: ProjectionResult;
  /**
   * The safe-to-inject bytes: the projection's injectText, but forced to '' when
   * ANY HARD finding (pure OR I/O) is present. The pure projection only knows the
   * pure HARD classes, so a valid-looking index with a dangling `detail:` pointer
   * would otherwise still carry injectText — this gate closes that gap.
   */
  injectText: string;
}

/**
 * The single full-validation path used by launch (WP-C), recall (WP-D), and
 * migration (WP-F2): read MEMORY.md, then pure `validateParsed` + `validateIO` +
 * `projectParsed`. Reads are the only failure that throws — the caller maps a
 * thrown read/parse to the RUNTIME (exit 2) condition and fails open.
 */
export function readValidateProject(workspaceRoot: string, nowISO: string): ReadValidateProjectResult {
  const { memoryMd } = memoryDirs(workspaceRoot);
  const text = fs.readFileSync(memoryMd, 'utf8'); // throws → caller maps to RUNTIME
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

/**
 * Derive the workspace root from a path to a canonical MEMORY.md, or null if the
 * path is not `<root>/.lares/supervisor/memory/<file>`. The CLI uses this to run
 * I/O validation only when the index sits in the real memory layout; a stray
 * fixture elsewhere gets pure-only validation (the pre-WP-A2 behavior), so it can
 * never spuriously fail on absent detail files it was never meant to have.
 */
export function deriveWorkspaceRootFromIndexPath(indexPath: string): string | null {
  const dir = path.dirname(path.resolve(indexPath));
  const suffix = path.join('.lares', 'supervisor', 'memory');
  const tail = path.sep + suffix;
  // fs is case-insensitive on Windows; compare case-folded, return original case.
  if (dir.toLowerCase().endsWith(tail.toLowerCase())) {
    return dir.slice(0, dir.length - tail.length);
  }
  return null;
}
