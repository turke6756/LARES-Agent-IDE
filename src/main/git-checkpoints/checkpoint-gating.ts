// checkpoint-gating.ts — capability gate + full-scope enumeration preflight for
// the Lares checkpoint engine (Git-Native WP-G1.3a). MAIN-PROCESS ONLY.
//
// STRUCTURAL NOTE (accepted deviation): the plan text says "gating helpers in
// checkpoint-service.ts", but that file does not exist yet — it is created by
// WP-G1.3b. Rather than pre-create a half-formed service, the gate + preflight
// live in this dedicated module; G1.3b imports them. No behavior changes.
//
// What lives here:
//   1. `gateCheckpoint(cap)`  — the go/no-go decision from a probed GitCapability.
//   2. `enumerationPathspec(prefix)` — root (no pathspec) vs sub-prefix magic.
//   3. `enumerateScope(...)`  — the full-scope before-snapshot preflight
//        (ls-files → lstat partition → entry-type classification → count/byte
//        caps → filter diagnostic). Its result feeds G1.3b with NO second scan.
//   4. `classifyIgnored(...)` — the restore-side `check-ignore` exit-code
//        trichotomy (invariant #26).
//
// Every git touch goes through an INJECTABLE runGit seam so the logic is unit-
// testable with fakes; the real seam is git-command.runGit. Dirty state is the
// INPUT to checkpointing, never a rejection (shape §0 / GS).

import * as fs from 'fs';
import * as path from 'path';

import { MAX_CHECKPOINT_BYTES, MAX_CHECKPOINT_PATHS } from '../../shared/constants';
import type { GitCapability, GitCapabilityReason } from '../../shared/types';
import type { GitRunResult, RunGitOptions } from './git-command';

/** The injectable git seam — structurally `git-command.runGit`. */
export type RunGitLike = (cwd: string, args: string[], opts: RunGitOptions) => Promise<GitRunResult>;

// ── 1. Capability gate ────────────────────────────────────────────────────────

/** Reason surfaced to `checkpoint_skipped`. `protected-root` is synthetic (the
 *  probe carries protectedRoot as a boolean flag, never as a reason value); the
 *  rest mirror the underlying repo state / capability reason. */
export type CheckpointSkipReason =
  | 'protected-root'
  | GitCapabilityReason
  | 'non-repo'
  | 'nested'
  | 'spans-boundary'
  | 'unsupported-wsl'
  | 'incomplete-capability';

export interface CheckpointGateOk {
  ok: true;
  repoState: 'repo' | 'unborn';
  repoRoot: string;
  /** '' when workspace === repoRoot; POSIX, top-anchored. */
  workspacePrefix: string;
}
export interface CheckpointGateSkip {
  ok: false;
  skipped: CheckpointSkipReason;
  detail: string | null;
}
export type CheckpointGateResult = CheckpointGateOk | CheckpointGateSkip;

/**
 * The go/no-go decision. Proceed ONLY when `reason==='ok'` AND
 * (`repoState==='repo'` || `'unborn'`) AND `protectedRoot===false`. Everything
 * else is a `checkpoint_skipped` with a reason. **Dirty state is never a
 * rejection** — dirtiness is precisely what we checkpoint.
 *
 * Protected-root is gated on the BOOLEAN (single source), never on a reason
 * value, and takes precedence in reporting so the user sees the actionable cause.
 */
export function gateCheckpoint(cap: GitCapability): CheckpointGateResult {
  if (cap.protectedRoot) {
    return { ok: false, skipped: 'protected-root', detail: cap.detail };
  }
  if (cap.reason !== 'ok') {
    return { ok: false, skipped: cap.reason, detail: cap.detail };
  }
  if (cap.repoState !== 'repo' && cap.repoState !== 'unborn') {
    // reason==='ok' but the layout is unsupported for checkpointing.
    const skipped = (cap.repoState ?? 'incomplete-capability') as CheckpointSkipReason;
    return { ok: false, skipped, detail: cap.detail };
  }
  // reason ok + eligible repo state + not protected. We still need concrete
  // paths to enumerate; a null repoRoot/prefix here is an internal inconsistency.
  if (cap.repoRoot === null || cap.workspacePrefix === null) {
    return { ok: false, skipped: 'incomplete-capability', detail: cap.detail };
  }
  return {
    ok: true,
    repoState: cap.repoState,
    repoRoot: cap.repoRoot,
    workspacePrefix: cap.workspacePrefix,
  };
}

// ── 2. Enumeration pathspec ───────────────────────────────────────────────────

/**
 * The ls-files pathspec for the workspace scope:
 *   • root workspace (`workspacePrefix===''`) → **null** (no pathspec, whole repo);
 *   • sub-prefix → `":(top,literal)<prefix>"`.
 * ASSERTS it never emits a bare, empty `:(top,literal)` (invariant #6 shape).
 */
export function enumerationPathspec(workspacePrefix: string): string | null {
  if (workspacePrefix === '') return null;
  const spec = `:(top,literal)${workspacePrefix}`;
  // Defensive: a non-empty prefix must yield a non-empty literal body. An empty
  // ":(top,literal)" would match the whole tree — never emit it.
  if (spec === ':(top,literal)') {
    throw new Error('enumerationPathspec: refusing to emit an empty :(top,literal) magic pathspec');
  }
  return spec;
}

// ── 3. Full-scope enumeration preflight ───────────────────────────────────────

/** Structural lstat facts the classifier needs — injectable so tests can model
 *  a FIFO/device/submodule without creating one (impossible on Windows). */
export interface LstatInfo {
  isFile: boolean;
  isSymbolicLink: boolean;
  isDirectory: boolean;
  isFIFO: boolean;
  isSocket: boolean;
  isCharacterDevice: boolean;
  isBlockDevice: boolean;
  mode: number;
  size: number;
}

/** lstat a workspace-relative path; null on ENOENT (a tracked-but-absent path). */
export type LstatFn = (relPath: string) => LstatInfo | null;

export type CaptureType = 'regular' | 'symlink';

export interface CapturableEntry {
  /** repo-relative POSIX path, exactly as git emitted it. */
  path: string;
  type: CaptureType;
  /** raw lstat mode — G1.3b derives the git filemode (100644/100755/120000). */
  mode: number;
  size: number;
}

export interface EnumerationResult {
  kind: 'ok';
  /** Present regular files + symlinks — the raw-hash capture set for G1.3b. */
  capturable: CapturableEntry[];
  /** Tracked-but-absent paths → staged as deletions by G1.3b. */
  deletions: string[];
  /** Submodule/gitlink dirs in scope — G1.3b rejects these visibly, never
   *  captures them (mode 160000). Recorded here; not part of the capture set. */
  gitlinks: string[];
  /** FIFO/socket/char/block-device/door entries — EXCLUDED from capture and
   *  recorded as `unsupported-entry-type`. Never passed to hash-object (which
   *  could hang on a FIFO/device); at restore they are rejected as
   *  `not-covered-by-before-checkpoint`, never assumed absent. */
  unsupported: string[];
  /** Paths carrying a filter driver (from `check-attr filter`). Capture still
   *  proceeds byte-exact via `hash-object --no-filters` (G1.3b) — NEVER a skip. */
  filteredPaths: string[];
  /** Set when any filtered path was seen (mirrors `before_raw_filter_bypassed=1`). */
  beforeRawFilterBypassed: boolean;
  /** Observed scope: capturable + deletions count; capturable byte sum. */
  observed: { paths: number; bytes: number };
}

export interface EnumerationSkip {
  kind: 'skipped';
  reason: 'oversized';
  observed: { paths: number; bytes: number };
  thresholds: { maxPaths: number; maxBytes: number };
}

export type EnumerationOutcome = EnumerationResult | EnumerationSkip;

export interface EnumerateScopeOptions {
  repoRoot: string;
  workspacePrefix: string;
  runGit: RunGitLike;
  gitExe?: string;
  /** Defaults to a real fs.lstatSync-backed reader rooted at repoRoot. */
  lstat?: LstatFn;
  maxPaths?: number;
  maxBytes?: number;
  /** Byte cap for buffered git output (ls-files / check-attr). */
  gitOutputMaxBytes?: number;
}

/** Default lstat: real fs, workspace-relative → absolute, ENOENT → null. Never
 *  follows the final symlink (lstat), so out-of-workspace symlink TARGETS are
 *  not traversed. */
function defaultLstat(repoRoot: string): LstatFn {
  return (relPath: string): LstatInfo | null => {
    try {
      const st = fs.lstatSync(path.resolve(repoRoot, relPath));
      return {
        isFile: st.isFile(),
        isSymbolicLink: st.isSymbolicLink(),
        isDirectory: st.isDirectory(),
        isFIFO: st.isFIFO(),
        isSocket: st.isSocket(),
        isCharacterDevice: st.isCharacterDevice(),
        isBlockDevice: st.isBlockDevice(),
        mode: st.mode,
        size: st.size,
      };
    } catch {
      return null; // ENOENT (tracked-but-absent) or unreadable → treat as absent
    }
  };
}

function splitNul(s: string): string[] {
  return s.split('\0').filter((x) => x.length > 0);
}

/**
 * Full-scope before-snapshot enumeration (spec steps 1–5). Returns either the
 * complete scope (for G1.3b to consume without a second scan) or an `oversized`
 * skip carrying observed values + thresholds.
 */
export async function enumerateScope(opts: EnumerateScopeOptions): Promise<EnumerationOutcome> {
  const {
    repoRoot,
    workspacePrefix,
    runGit,
    gitExe,
    maxPaths = MAX_CHECKPOINT_PATHS,
    maxBytes = MAX_CHECKPOINT_BYTES,
    gitOutputMaxBytes = 64 << 20,
  } = opts;
  const lstat = opts.lstat ?? defaultLstat(repoRoot);

  // 1. Candidate scope: tracked (--cached) + non-ignored untracked (--others),
  //    filter-free plumbing enumeration, NUL-delimited.
  const pathspec = enumerationPathspec(workspacePrefix);
  const lsArgs = ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  if (pathspec !== null) lsArgs.push('--', pathspec);
  const lsRes = await runGit(repoRoot, lsArgs, {
    maxBytes: gitOutputMaxBytes,
    gitExe,
    timeoutMs: 30_000,
  });
  // Dedup — a path never appears in both --cached and --others, but be defensive.
  const candidates = Array.from(new Set(splitNul(lsRes.stdout)));

  // 2–3. lstat partition + entry-type classification.
  const capturable: CapturableEntry[] = [];
  const deletions: string[] = [];
  const gitlinks: string[] = [];
  const unsupported: string[] = [];

  for (const rel of candidates) {
    const st = lstat(rel);
    if (st === null) {
      // Tracked-but-absent (deletion). An --others path that vanished simply
      // drops out — but --others only lists existing files, so absent ⇒ tracked.
      deletions.push(rel);
      continue;
    }
    if (st.isSymbolicLink) {
      // Symlink → spike-gated capture (WP-G1.6). Captured byte-exact as 120000.
      capturable.push({ path: rel, type: 'symlink', mode: st.mode, size: st.size });
    } else if (st.isDirectory) {
      // A ls-files entry that lstat reports as a directory is a gitlink/submodule
      // working tree → visible reject (never mode 100644, never captured).
      gitlinks.push(rel);
    } else if (st.isFile) {
      capturable.push({ path: rel, type: 'regular', mode: st.mode, size: st.size });
    } else {
      // FIFO / socket / char-or-block device / door → excluded, recorded. NEVER
      // handed to hash-object (which could hang on a FIFO/device).
      unsupported.push(rel);
    }
  }

  // 4. Count + byte caps over the FULL scope. Present capturable + deletions is
  //    the path count (rename pairs would be counted once; enumeration lists a
  //    path once). Bytes = sum of present capturable sizes (deletions are 0).
  const observedPaths = capturable.length + deletions.length;
  const observedBytes = capturable.reduce((sum, e) => sum + e.size, 0);
  if (observedPaths > maxPaths || observedBytes > maxBytes) {
    return {
      kind: 'skipped',
      reason: 'oversized',
      observed: { paths: observedPaths, bytes: observedBytes },
      thresholds: { maxPaths, maxBytes },
    };
  }

  // 5. Filter diagnostic (NUL-safe): feed the capturable path set to
  //    `check-attr -z --stdin filter`; parse NUL triples <path>\0<attr>\0<info>\0;
  //    a driver-bearing info (not 'unspecified'/'unset') flags the path. Capture
  //    still proceeds byte-exact via --no-filters — NEVER a skip.
  let filteredPaths: string[] = [];
  if (capturable.length > 0) {
    filteredPaths = await diagnoseFilters(repoRoot, capturable.map((e) => e.path), runGit, gitExe, gitOutputMaxBytes);
  }

  return {
    kind: 'ok',
    capturable,
    deletions,
    gitlinks,
    unsupported,
    filteredPaths,
    beforeRawFilterBypassed: filteredPaths.length > 0,
    observed: { paths: observedPaths, bytes: observedBytes },
  };
}

/** Parse `check-attr -z --stdin filter` output into the driver-bearing subset. */
async function diagnoseFilters(
  repoRoot: string,
  paths: string[],
  runGit: RunGitLike,
  gitExe: string | undefined,
  maxBytesGit: number,
): Promise<string[]> {
  const stdin = paths.map((p) => `${p}\0`).join('');
  const res = await runGit(repoRoot, ['check-attr', '-z', '--stdin', 'filter'], {
    maxBytes: maxBytesGit,
    gitExe,
    stdin,
    allowNonzero: true,
    timeoutMs: 30_000,
  });
  // Output is a flat NUL stream of triples: path, attr, info, path, attr, info…
  const toks = res.stdout.split('\0');
  const flagged: string[] = [];
  for (let i = 0; i + 2 < toks.length; i += 3) {
    const p = toks[i];
    const info = toks[i + 2];
    if (p.length === 0) continue;
    // 'unspecified' = no filter attr; 'unset' = explicitly disabled; a real
    // driver name (or 'set') means a filter would apply.
    if (info !== 'unspecified' && info !== 'unset') flagged.push(p);
  }
  return flagged;
}

// ── 4. check-ignore exit-code trichotomy (restore side) ───────────────────────

export type CheckIgnoreOutcome =
  | { kind: 'none-ignored' }                              // exit 1 — success, proceed
  | { kind: 'some-ignored'; ignored: string[] }           // exit 0 — reject those
  | { kind: 'error'; code: number; stderr: string };      // exit >1 — operational error

/**
 * Classify paths with `git check-ignore` (invariant #26). Exit-code contract:
 *   0 → some ignored (parse NUL output; caller rejects those as
 *       `not-covered-by-before-checkpoint`);
 *   1 → none ignored (SUCCESS — proceed);
 *   >1 → operational error (fail visibly).
 * Uses `allowNonzero` so exit 1 (the common "none ignored" case) does not throw.
 */
export async function classifyIgnored(opts: {
  repoRoot: string;
  paths: string[];
  runGit: RunGitLike;
  gitExe?: string;
  maxBytesGit?: number;
}): Promise<CheckIgnoreOutcome> {
  const { repoRoot, paths, runGit, gitExe, maxBytesGit = 64 << 20 } = opts;
  if (paths.length === 0) return { kind: 'none-ignored' };

  const stdin = paths.map((p) => `${p}\0`).join('');
  const res = await runGit(repoRoot, ['check-ignore', '-z', '--stdin'], {
    maxBytes: maxBytesGit,
    gitExe,
    stdin,
    allowNonzero: true,
    timeoutMs: 30_000,
  });

  if (res.code === 0) {
    return { kind: 'some-ignored', ignored: splitNul(res.stdout) };
  }
  if (res.code === 1) {
    return { kind: 'none-ignored' };
  }
  return { kind: 'error', code: res.code, stderr: res.stderr };
}
