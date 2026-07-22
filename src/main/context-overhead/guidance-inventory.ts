// guidance-inventory.ts — WP7 (G7) nested guidance inventory with a DECLARED
// scan contract.
//
// Enumerates every guidance file (CLAUDE.md / CLAUDE.local.md / AGENTS.md)
// under the workspace root and costs it, under a contract whose constants are
// EXPORTED and echoed into the scan metadata — a reader can always tell what
// the scan promised and whether it kept the promise:
//
//   - rooted at the workspace root, containment enforced (nothing outside the
//     resolved root can enter the inventory);
//   - symlinks are NOT followed — each is counted (`skippedSymlinks`), never
//     traversed, so a link cannot smuggle an off-workspace subtree in;
//   - budgets: maxDepth 8, maxDirs 5,000, maxFiles 200,000, maxBytes 2 MB/file;
//   - always-ignored directories: `.git`, `node_modules`, the workspace state
//     dirs (`.lares` / legacy `.dashboard`); plus `.gitignore` when the
//     workspace is a git work tree (`gitIgnoreApplied:false` disclosed
//     otherwise — non-git is a disclosed state, never a silent difference);
//   - read/permission failures counted per reason code;
//   - deterministic path-lexicographic ordering of the emitted entries.
//
// Completeness metadata distinguishes KNOWN omissions from UNKNOWN remainder:
//   - known omissions carry counts (`skippedSymlinks`, `skippedIgnoredDirs`,
//     `skippedGitIgnored`, `skippedOversized`, `readFailuresByReason`) — each is
//     a dirent the scan SAW and deliberately or forcedly left out;
//   - a budget-stopped traversal leaves subtrees UNVISITED: `scanComplete:false`
//     + `scanStoppedReason` + `remainderCountKnown:false`. There is NEVER an
//     "omitted count" for an unvisited subtree — a number for something the
//     scan did not see would be fabricated.
//   Note the per-file maxBytes budget is a KNOWN omission (the file was seen,
//   sized, and skipped → `skippedOversized`); only the traversal budgets
//   (depth/dirs/files) can produce the unknown-remainder state.
//
// Every entry reuses WP2's `GuidanceSource` model (fileKind, audienceProviders,
// per-directory chain applicability semantics) and carries
// `liveness:'not-analyzed'` — a nested file gains liveness ONLY if/when a
// captured session-cwd/task scope proves applicability, which is OUT OF SCOPE
// here. No entry ever leaves this module with any other liveness value.
//
// The scan core is pure over injected IO (`GuidanceScanFs`, `GitIgnoreProbe`,
// `PathOps`, a token estimator) so it unit-tests under the system-Node runner;
// the two production adapters at the bottom (`makeNodeGuidanceScanFs`,
// `loadGitIgnore`) are the impure tail the exporter wires in.

import * as nodeFs from 'fs';
import { execFileSync } from 'child_process';
import type { GuidanceSource } from '../../shared/types';
import type { PathOps } from './paths';
import {
  AGENTS_MD_DOCUMENTED_PROVIDERS,
  classifyAgentsMdApplicability,
} from './guidance-sources';

// ── the declared scan contract ────────────────────────────────────────────────

export type GuidanceScanStopReason = 'max-depth' | 'max-dirs' | 'max-files';

export interface GuidanceScanContractV1 {
  /** Directory levels below the workspace root a traversal may descend. */
  maxDepth: number;
  /** Directories the traversal may list (the root counts as the first). */
  maxDirs: number;
  /** File dirents the traversal may consider before halting. */
  maxFiles: number;
  /** Per-file size cap; an oversized guidance file is a KNOWN omission. */
  maxFileBytes: number;
  /** Structural fact of this scanner, echoed so readers need no source dive. */
  followSymlinks: false;
  /** Directory names never descended (case-insensitive). The two workspace
   *  state-dir spellings are both listed — pre-migration workspaces still use
   *  `.dashboard` (workspace-state-dir.ts). */
  ignoredDirNames: readonly string[];
  ordering: 'path-lexicographic';
}

/** THE contract (plan WP7). Exported and echoed verbatim into the scan
 *  metadata; tests may pass overrides to exercise each budget cheaply, and the
 *  metadata then echoes the overridden contract actually applied. */
export const GUIDANCE_SCAN_CONTRACT: GuidanceScanContractV1 = {
  maxDepth: 8,
  maxDirs: 5_000,
  maxFiles: 200_000,
  maxFileBytes: 2 * 1024 * 1024,
  followSymlinks: false,
  ignoredDirNames: ['.git', 'node_modules', '.lares', '.dashboard'],
  ordering: 'path-lexicographic',
};

// ── injected IO seams ─────────────────────────────────────────────────────────

export type GuidanceDirentKind = 'file' | 'dir' | 'symlink' | 'other';

export interface GuidanceDirent {
  name: string;
  /** `symlink` for ANY symbolic link (file- or dir-targeted) — never followed. */
  kind: GuidanceDirentKind;
}

export interface GuidanceScanFs {
  /** May throw an Error carrying a `code` (EACCES/EPERM/ENOENT/…). */
  listDir(absPath: string): GuidanceDirent[];
  fileSize(absPath: string): number;
  readFile(absPath: string): string;
}

export interface GitIgnoreProbe {
  /** True when the workspace is a git work tree whose ignore rules were loaded.
   *  False ⇒ `gitIgnoreApplied:false` is disclosed and nothing is git-ignored. */
  applied: boolean;
  /** `relPath` is workspace-root-relative with forward slashes, no leading `/`. */
  isIgnored(relPath: string, isDir: boolean): boolean;
}

export interface GuidanceInventoryDeps {
  fs: GuidanceScanFs;
  pathOps: PathOps;
  estimator: { estimate(text: string): { tokens: number } };
  gitIgnore: GitIgnoreProbe;
  /** Launch cwds of CAPTURED streams — the ONLY signal that puts a file on a
   *  chain (WP2 semantics). Never inferred for below-cwd files. */
  capturedLaunchCwds: readonly string[];
}

// ── result shapes ─────────────────────────────────────────────────────────────

/** One inventoried guidance file. Reuses WP2's `GuidanceSource` verbatim —
 *  applicability follows the per-directory chain semantics, and `liveness` is
 *  the literal `'not-analyzed'` for EVERY entry (see module header). */
export interface GuidanceInventoryEntryV1 extends GuidanceSource {
  tokens: number;
  headings: string[];
  liveness: 'not-analyzed';
}

export interface GuidanceScanMetaV1 {
  /** The contract ACTUALLY applied (the exported constant unless overridden). */
  contract: GuidanceScanContractV1;
  gitIgnoreApplied: boolean;
  /** False iff a traversal budget left subtrees unvisited. */
  scanComplete: boolean;
  /** First budget that caused unvisited remainder; null when complete. */
  scanStoppedReason: GuidanceScanStopReason | null;
  /** True ONLY when the scan completed (remainder provably zero). A stopped
   *  scan can never know how much it missed — no omitted count is fabricated. */
  remainderCountKnown: boolean;
  dirsVisited: number;
  filesSeen: number;
  // Known omissions — dirents the scan SAW and left out, each with a count.
  skippedSymlinks: number;
  /** Contract-ignored directories (.git / node_modules / state dirs). Counts
   *  skipped DIRECTORY dirents — guidance files inside them were never seen. */
  skippedIgnoredDirs: number;
  /** Git-ignored directories + git-ignored guidance-named files. */
  skippedGitIgnored: number;
  /** Guidance files over `maxFileBytes` — seen, sized, skipped. */
  skippedOversized: number;
  /** listDir/stat/read failures bucketed by error `code` ('UNKNOWN' when the
   *  error carried none). A failed listDir also leaves that subtree unseen —
   *  the count is the disclosure. */
  readFailuresByReason: Record<string, number>;
}

export interface GuidanceInventoryV1 {
  /** Path-lexicographic order (the contract's `ordering`). */
  entries: GuidanceInventoryEntryV1[];
  scan: GuidanceScanMetaV1;
}

// ── guidance file-name → fileKind ─────────────────────────────────────────────

const GUIDANCE_FILE_KINDS = new Map<string, GuidanceSource['fileKind']>([
  ['claude.md', 'claude-md'],
  ['claude.local.md', 'claude-local-md'],
  ['agents.md', 'agents-md'],
]);

// ── markdown headings ─────────────────────────────────────────────────────────

/** ATX headings (`#`…`######`), skipping fenced code blocks so a `# comment`
 *  inside a ``` fence is not a heading. */
export function extractHeadings(content: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const m = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (m) out.push(m[2]);
  }
  return out;
}

// ── the scan core (pure over injected IO) ─────────────────────────────────────

function failureCode(err: unknown): string {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' && c.length > 0 ? c : 'UNKNOWN';
}

/** Is `dir` on the root→cwd chain of ≥1 captured launch cwd (ancestor-or-equal
 *  of the cwd, both within the root)? WP2's per-directory chain test, applied
 *  to the CLAUDE-family walk-up analog. */
function onCapturedChain(
  dir: string,
  root: string,
  capturedLaunchCwds: readonly string[],
  ops: PathOps,
): boolean {
  for (const cwd of capturedLaunchCwds) {
    const resolved = ops.resolve(cwd);
    if (!ops.isWithin(resolved, root)) continue;
    if (ops.isWithin(resolved, dir)) return true;
  }
  return false;
}

export function scanGuidanceInventory(
  workspaceRoot: string,
  deps: GuidanceInventoryDeps,
  contract: GuidanceScanContractV1 = GUIDANCE_SCAN_CONTRACT,
): GuidanceInventoryV1 {
  const ops = deps.pathOps;
  const root = ops.resolve(workspaceRoot);
  const rootPrefix = root.endsWith('/') ? root : `${root}/`;
  const ignoredDirNames = new Set(contract.ignoredDirNames.map((n) => n.toLowerCase()));

  const entries: GuidanceInventoryEntryV1[] = [];
  let dirsVisited = 0;
  let filesSeen = 0;
  let skippedSymlinks = 0;
  let skippedIgnoredDirs = 0;
  let skippedGitIgnored = 0;
  let skippedOversized = 0;
  const readFailuresByReason: Record<string, number> = {};
  /** First budget that caused unvisited remainder (never overwritten). */
  let stoppedReason: GuidanceScanStopReason | null = null;
  /** dirs/files exhaustion halts the whole traversal; depth only prunes. */
  let halted = false;

  const note = (reason: GuidanceScanStopReason): void => {
    if (stoppedReason === null) stoppedReason = reason;
  };
  const countFailure = (err: unknown): void => {
    const code = failureCode(err);
    readFailuresByReason[code] = (readFailuresByReason[code] ?? 0) + 1;
  };

  const visit = (dir: string, depth: number): void => {
    if (halted) return;
    if (dirsVisited >= contract.maxDirs) { note('max-dirs'); halted = true; return; }
    dirsVisited += 1;

    let list: GuidanceDirent[];
    try {
      list = deps.fs.listDir(dir);
    } catch (err) {
      countFailure(err);
      return;
    }
    // Deterministic order regardless of what the filesystem returned — this is
    // what makes budget cut-offs reproducible, not just the output sort.
    const sorted = [...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const d of sorted) {
      if (halted) return;
      const path = ops.join(dir, d.name);
      // Containment enforced: join() of a plain name cannot escape, but a
      // hostile dirent name with separators could — refuse anything that
      // resolves outside the root or collapses onto the parent.
      if (!ops.isWithin(path, root) || path === dir) continue;
      if (d.kind === 'symlink') { skippedSymlinks += 1; continue; }
      const rel = path.startsWith(rootPrefix) ? path.slice(rootPrefix.length) : path;

      if (d.kind === 'dir') {
        if (ignoredDirNames.has(d.name.toLowerCase())) { skippedIgnoredDirs += 1; continue; }
        if (deps.gitIgnore.applied && deps.gitIgnore.isIgnored(rel, true)) { skippedGitIgnored += 1; continue; }
        if (depth + 1 > contract.maxDepth) { note('max-depth'); continue; }
        visit(path, depth + 1);
        continue;
      }
      if (d.kind !== 'file') continue;

      if (filesSeen >= contract.maxFiles) { note('max-files'); halted = true; return; }
      filesSeen += 1;

      const fileKind = GUIDANCE_FILE_KINDS.get(d.name.toLowerCase());
      if (!fileKind) continue;
      if (deps.gitIgnore.applied && deps.gitIgnore.isIgnored(rel, false)) { skippedGitIgnored += 1; continue; }

      let size: number;
      try { size = deps.fs.fileSize(path); } catch (err) { countFailure(err); continue; }
      if (size > contract.maxFileBytes) { skippedOversized += 1; continue; }

      let content: string;
      try { content = deps.fs.readFile(path); } catch (err) { countFailure(err); continue; }

      entries.push(buildEntry(path, fileKind, content, root, deps));
    }
  };

  visit(root, 0);

  // Path-lexicographic output ordering (the contract's `ordering`).
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  linkChainParents(entries, ops);

  const scanComplete = stoppedReason === null;
  return {
    entries,
    scan: {
      contract,
      gitIgnoreApplied: deps.gitIgnore.applied,
      scanComplete,
      scanStoppedReason: stoppedReason,
      // Complete ⇒ the remainder is provably zero. Stopped ⇒ the remainder is
      // UNKNOWN — never a count.
      remainderCountKnown: scanComplete,
      dirsVisited,
      filesSeen,
      skippedSymlinks,
      skippedIgnoredDirs,
      skippedGitIgnored,
      skippedOversized,
      readFailuresByReason,
    },
  };
}

function buildEntry(
  path: string,
  fileKind: GuidanceSource['fileKind'],
  content: string,
  root: string,
  deps: GuidanceInventoryDeps,
): GuidanceInventoryEntryV1 {
  const ops = deps.pathOps;
  const dir = ops.dirname(path);

  let source: GuidanceSource;
  if (fileKind === 'agents-md') {
    // WP2's classifier IS the applicability rule: `directory-chain` iff the
    // file's dir lies on the root→cwd chain of ≥1 captured stream; everything
    // else (below-cwd, off-chain) is `inventory-only`.
    const model = classifyAgentsMdApplicability(path, root, [...deps.capturedLaunchCwds], ops);
    const documented = AGENTS_MD_DOCUMENTED_PROVIDERS.filter(Boolean);
    source = {
      path,
      fileKind,
      audienceProviders: documented.length > 0 ? [...documented] : 'unknown',
      applicability: { model },
      loadingSemanticsConfidence: documented.length > 0 ? 'documented' : 'unknown',
    };
  } else {
    // CLAUDE-family: the walk-up loads every CLAUDE.md/CLAUDE.local.md on the
    // chain from a captured launch cwd UP to the root — the same
    // ancestor-or-equal test, tagged with the walk-up model (WP2 semantics
    // unchanged). Off-chain / below-cwd files are inventory-only until a
    // captured scope proves applicability.
    const onChain = onCapturedChain(dir, root, deps.capturedLaunchCwds, ops);
    source = {
      path,
      fileKind,
      audienceProviders: ['claude'],
      applicability: { model: onChain ? 'walk-up-chain' : 'inventory-only' },
      loadingSemanticsConfidence: 'documented',
    };
  }

  return {
    ...source,
    tokens: deps.estimator.estimate(content).tokens,
    headings: extractHeadings(content),
    // OUT OF SCOPE for WP7 by design: liveness would require a session-cwd/task
    // scope to prove applicability. Every inventoried file stays 'not-analyzed'.
    liveness: 'not-analyzed',
  };
}

/** Link each chain-applicable entry to the nearest same-kind entry strictly
 *  above it (WP2's `chainParent` semantics, derived from the inventory itself).
 *  Inventory-only entries never get a parent — they are on no chain. On an
 *  incomplete scan a missing ancestor simply yields no link; `scanComplete`
 *  already discloses the gap. */
function linkChainParents(entries: GuidanceInventoryEntryV1[], ops: PathOps): void {
  const byDirAndKind = new Map<string, GuidanceInventoryEntryV1>();
  for (const e of entries) {
    if (e.applicability.model === 'inventory-only') continue;
    byDirAndKind.set(`${e.fileKind} ${ops.dirname(e.path)}`, e);
  }
  for (const e of entries) {
    if (e.applicability.model === 'inventory-only') continue;
    let dir = ops.dirname(e.path);
    for (;;) {
      const parentDir = ops.dirname(dir);
      if (parentDir === dir) break;
      dir = parentDir;
      const candidate = byDirAndKind.get(`${e.fileKind} ${dir}`);
      if (candidate) { e.applicability.chainParent = candidate.path; break; }
    }
  }
}

// ── production adapters (the impure tail) ─────────────────────────────────────

/** Node-fs adapter. Paths arrive in the canonical forward-slash form produced
 *  by `PathOps.resolve`, which node's fs accepts on every host platform. Note:
 *  a WSL workspace's POSIX root is not readable through host-node fs — every
 *  listDir fails and the failure lands in `readFailuresByReason`, disclosed
 *  rather than silently empty. */
export function makeNodeGuidanceScanFs(): GuidanceScanFs {
  return {
    listDir(absPath) {
      return nodeFs.readdirSync(absPath, { withFileTypes: true }).map((d) => ({
        name: d.name,
        kind: d.isSymbolicLink() ? 'symlink' as const
          : d.isDirectory() ? 'dir' as const
            : d.isFile() ? 'file' as const
              : 'other' as const,
      }));
    },
    fileSize(absPath) {
      // lstat, deliberately: a symlinked file already never reaches here, and
      // stat-following would size a target instead of the seen dirent.
      return nodeFs.lstatSync(absPath).size;
    },
    readFile(absPath) {
      return nodeFs.readFileSync(absPath, 'utf8');
    },
  };
}

/**
 * Load the workspace's effective git-ignore set with ONE `git ls-files
 * --others --ignored --exclude-standard --directory` call (`-z` for exact
 * names). Any failure — no git binary, not a work tree, WSL root unreachable —
 * yields `applied:false`, which the scan metadata discloses as
 * `gitIgnoreApplied:false`; the non-git behavior is a disclosed state, never a
 * silent difference.
 */
export function loadGitIgnore(workspaceRoot: string): GitIgnoreProbe {
  let out: string;
  try {
    out = execFileSync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return { applied: false, isIgnored: () => false };
  }
  const ignoredDirs: string[] = [];
  const ignoredFiles = new Set<string>();
  for (const raw of out.split('\0')) {
    if (!raw) continue;
    const rel = raw.replace(/\\/g, '/');
    if (rel.endsWith('/')) ignoredDirs.push(rel);
    else ignoredFiles.add(rel);
  }
  return {
    applied: true,
    isIgnored(relPath, isDir) {
      if (!isDir && ignoredFiles.has(relPath)) return true;
      const asDir = isDir ? `${relPath}/` : relPath;
      for (const d of ignoredDirs) {
        if (asDir === d || asDir.startsWith(d)) return true;
      }
      return false;
    },
  };
}
