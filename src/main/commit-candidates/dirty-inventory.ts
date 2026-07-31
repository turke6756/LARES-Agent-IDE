// SC-WP-1B — DirtyInventory producer (bundle contract v1 §2). MAIN-PROCESS ONLY.
//
// Turns the raw, scoped worktree dirt of ONE repository into a list of
// `DirtyEntry` records + the `RepositoryIdentity` they belong to. This is the
// "raw half" of the inventory: it does NOT compute witness attribution, topology,
// `unattributedEntryIds`, or `topologyDigest` (all WP-1D), and it does NOT compute
// `expectedCommitBlobOid` (needs a temp index; a later WP). It returns an honest
// PARTIAL — `{ repository, entries }` — never a faked `DirtyInventory`.
//
// Source of truth (normative §2):
//   git --no-optional-locks status --porcelain=v2 -z --untracked-files=all
// run via `runGitBytes` (NEVER the string-decoding `runGit`) so authoritative Git
// path bytes survive. Records are split on NUL BYTES; `pathBytesBase64` is the
// authoritative transport form; `displayPath`/`utf8Clean` are derived AFTER and
// are DISPLAY-ONLY (control chars escaped; a lossy UTF-8 decode ⇒ utf8Clean:false).
//
// Scope (normative): `enumerationPathspec(workspacePrefix)` + `--exclude-standard`
// semantics ONLY (status without `--ignored` already excludes ignored files).
// We deliberately do NOT call `enumerateScope()` — it string-decodes paths, applies
// capture path/byte caps, and lstats, and can report `oversized` for an inventory
// the card must still render. This producer matches raw scoped `git status` even
// when checkpoint capture would report `oversized`.
//
// Everything that shells out routes through injected seams (`runGitBytes` for the
// authoritative status bytes; a text `runGit` for the ascii-only `hash-object`
// probe), so unit tests drive it with either a real git in a throwaway temp repo
// or crafted byte fixtures (the only way to exercise non-UTF-8 paths on Windows).

import { createHash } from 'crypto';

import { enumerationPathspec } from '../git-checkpoints/checkpoint-gating';
import type { GitRunBytesResult, GitRunResult, RunGitOptions } from '../git-checkpoints/git-command';
import type { DirtyEntry, EncodedGitPath, RepositoryIdentity } from '../../shared/commit-candidates';

/** Injectable binary git seam — structurally `git-command.runGitBytes`. */
export type RunGitBytesLike = (cwd: string, args: string[], opts: RunGitOptions) => Promise<GitRunBytesResult>;
/** Injectable text git seam — structurally `git-command.runGit` (ascii output only). */
export type RunGitTextLike = (cwd: string, args: string[], opts: RunGitOptions) => Promise<GitRunResult>;

export interface ProduceDirtyInventoryOptions {
  /** Repo-root cwd for git; status paths come back repo-root-relative. */
  repoRoot: string;
  /** Top-anchored POSIX workspace prefix ('' ⇒ whole repo, no pathspec). */
  workspacePrefix: string;
  /** The already-derived identity (WP-1A); embedded verbatim + supplies `repositoryKey`. */
  repository: RepositoryIdentity;
  runGitBytes: RunGitBytesLike;
  runGit: RunGitTextLike;
  gitExe?: string;
  deadlineAt?: number;
  /** Byte cap for buffered status output. */
  maxBytes?: number;
}

/** The producer's honest partial of `DirtyInventory`. `unattributedEntryIds` and
 *  `topologyDigest` are deliberately ABSENT — the WP-1D assembler owns them; we
 *  never fabricate them. */
export interface DirtyInventoryDraft {
  repository: RepositoryIdentity;
  entries: DirtyEntry[];
}

const DEFAULT_MAX_BYTES = 64 << 20;
const STATUS_TIMEOUT_MS = 30_000;

// ── Path encoding (§2: bytes authoritative; display derived after) ─────────────

// Control chars (C0 + DEL) that must be escaped for DISPLAY. Kept as a codepoint
// test so the source carries no literal control bytes.
function isControlChar(code: number): boolean {
  return code <= 0x1f || code === 0x7f;
}

/** C-style escape of control chars for DISPLAY ONLY — never fed back to git. */
function escapeForDisplay(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (!isControlChar(code)) {
      out += ch;
      continue;
    }
    if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += `\\x${code.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/** Encode raw Git path bytes into an `EncodedGitPath`. `pathBytesBase64` is
 *  authoritative; `utf8Clean` is a lossless round-trip test; `displayPath` is a
 *  best-effort, control-char-escaped rendering. */
export function encodeGitPath(pathBytes: Buffer): EncodedGitPath {
  const decoded = pathBytes.toString('utf8');
  const utf8Clean = Buffer.compare(Buffer.from(decoded, 'utf8'), pathBytes) === 0;
  return {
    pathBytesBase64: pathBytes.toString('base64'),
    displayPath: escapeForDisplay(decoded),
    utf8Clean,
  };
}

// ── porcelain=v2 -z parsing (byte-exact) ───────────────────────────────────────

/** Split a Buffer on NUL bytes, preserving each segment's exact bytes. Empty
 *  trailing segments are dropped; interior empties (never produced by porcelain)
 *  are kept and skipped by the caller. */
function splitNulBytes(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      out.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.subarray(start));
  return out;
}

/**
 * Split a porcelain-v2 record token into its ASCII header fields and the raw path
 * bytes. `fieldCount` = number of space-separated header fields BEFORE the path
 * (8 for type-1, 9 for type-2, 10 for type-u, 1 for type-`?`). The header is pure
 * ASCII (status chars, octal modes, hex OIDs, `N...`/`S...` sub); only the path can
 * carry arbitrary bytes, so it is sliced out as a Buffer and never decoded here.
 */
function splitHeaderAndPath(token: Buffer, fieldCount: number): { fields: string[]; pathBytes: Buffer } {
  let spaces = 0;
  let idx = 0;
  for (; idx < token.length; idx++) {
    if (token[idx] === 0x20) {
      spaces++;
      if (spaces === fieldCount) {
        idx++;
        break;
      }
    }
  }
  const fields = token.subarray(0, Math.max(0, idx - 1)).toString('latin1').split(' ');
  const pathBytes = token.subarray(idx);
  return { fields, pathBytes };
}

/** '000000' is git's "no entry at this level" sentinel — surfaced as null so the
 *  stored modes match the §2 enumerated set (`100644|100755|120000|160000|null`). */
function normalizeMode(raw: string | undefined): string | null {
  return raw && raw !== '000000' ? raw : null;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** GIT-LEVEL eligibility ONLY (no package/byte verdicts here): unmerged, gitlink
 *  (`160000`) / submodule (`S...`), and non-UTF-8 paths are visible but never
 *  eligible. Symlinks (`120000`) ARE supported. */
function computeEligibility(
  entryKind: DirtyEntry['entryKind'],
  rawModes: (string | null)[],
  submoduleState: string | null,
  utf8Clean: boolean,
): DirtyEntry['gitLevelEligibility'] {
  if (!utf8Clean) return 'unsupported-git-state';
  if (entryKind === 'unmerged') return 'unsupported-git-state';
  if (rawModes.some((m) => m === '160000')) return 'unsupported-git-state';
  if (submoduleState && submoduleState.startsWith('S')) return 'unsupported-git-state';
  return 'supported';
}

/** Intermediate parse result before the (async) raw-hash pass. */
interface ParsedEntry {
  entry: DirtyEntry;
  /** repo-relative POSIX path string for hash-object — set only when hashable
   *  (present + utf8Clean); null ⇒ leave rawWorktreeBlobOid null. */
  hashPath: string | null;
}

function buildEntry(args: {
  repositoryKey: string;
  entryKind: DirtyEntry['entryKind'];
  indexStatus: string;
  worktreeStatus: string;
  headModeRaw: string | undefined;
  indexModeRaw: string | undefined;
  worktreeModeRaw: string | undefined;
  submoduleState: string | null;
  renameOrCopyScore: string | null;
  pathBytes: Buffer;
  originalPathBytes: Buffer | null;
}): ParsedEntry {
  const path = encodeGitPath(args.pathBytes);
  const originalPath = args.originalPathBytes ? encodeGitPath(args.originalPathBytes) : null;

  // Deletion is decided from the RAW worktree mode ('000000') BEFORE normalization,
  // so 'absent' stays distinct from an unavailable hash (§2).
  const expectedWorktreeState: DirtyEntry['expectedWorktreeState'] =
    args.worktreeModeRaw === '000000' ? 'absent' : 'present';

  const headMode = normalizeMode(args.headModeRaw);
  const indexMode = normalizeMode(args.indexModeRaw);
  const worktreeMode = normalizeMode(args.worktreeModeRaw);

  const gitLevelEligibility = computeEligibility(
    args.entryKind,
    [args.headModeRaw ?? null, args.indexModeRaw ?? null, args.worktreeModeRaw ?? null],
    args.submoduleState,
    path.utf8Clean,
  );

  // Every old/new path a rename/delete/copy commit needs (§2): the path always,
  // plus the rename/copy source when present.
  const commitPathspecs: EncodedGitPath[] = [path];
  if (originalPath) commitPathspecs.push(originalPath);

  const entry: DirtyEntry = {
    entryId: sha256Hex(args.repositoryKey + path.pathBytesBase64),
    path,
    originalPath,
    entryKind: args.entryKind,
    indexStatus: args.indexStatus,
    worktreeStatus: args.worktreeStatus,
    headMode,
    indexMode,
    worktreeMode,
    submoduleState: args.submoduleState,
    renameOrCopyScore: args.renameOrCopyScore,
    expectedWorktreeState,
    rawWorktreeBlobOid: null, // filled by the raw-hash pass below
    gitLevelEligibility,
    commitPathspecs,
  };

  // Hashable iff the worktree file is present AND the path decodes cleanly (a
  // non-UTF-8 path cannot be passed safely through a Node string argv; such entries
  // are unsupported anyway and keep rawWorktreeBlobOid null = "unhashable"). Uses
  // the RAW decoded string (NOT the control-char-escaped displayPath) so the bytes
  // handed to git match the worktree file exactly.
  const hashPath = expectedWorktreeState === 'present' && path.utf8Clean
    ? args.pathBytes.toString('utf8')
    : null;

  return { entry, hashPath };
}

/** Parse the full NUL-byte status stream into entries (sync; no hashing yet). */
function parseStatus(stdout: Buffer, repositoryKey: string): ParsedEntry[] {
  const tokens = splitNulBytes(stdout);
  const parsed: ParsedEntry[] = [];

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.length === 0) { i++; continue; }
    const kind = tok[0];

    if (kind === 0x31) {
      // '1' ordinary: 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const { fields, pathBytes } = splitHeaderAndPath(tok, 8);
      const xy = fields[1] ?? '..';
      parsed.push(buildEntry({
        repositoryKey,
        entryKind: 'ordinary',
        indexStatus: xy[0] ?? '.',
        worktreeStatus: xy[1] ?? '.',
        submoduleState: fields[2] ?? null,
        headModeRaw: fields[3],
        indexModeRaw: fields[4],
        worktreeModeRaw: fields[5],
        renameOrCopyScore: null,
        pathBytes,
        originalPathBytes: null,
      }));
      i += 1;
    } else if (kind === 0x32) {
      // '2' rename/copy: 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<origPath>
      const { fields, pathBytes } = splitHeaderAndPath(tok, 9);
      const originalPathBytes = tokens[i + 1] ?? Buffer.alloc(0);
      const xy = fields[1] ?? '..';
      const xscore = fields[8] ?? '';
      parsed.push(buildEntry({
        repositoryKey,
        entryKind: 'rename-or-copy',
        indexStatus: xy[0] ?? '.',
        worktreeStatus: xy[1] ?? '.',
        submoduleState: fields[2] ?? null,
        headModeRaw: fields[3],
        indexModeRaw: fields[4],
        worktreeModeRaw: fields[5],
        renameOrCopyScore: xscore.slice(1) || null,
        pathBytes,
        originalPathBytes,
      }));
      i += 2; // consume the origPath token
    } else if (kind === 0x75) {
      // 'u' unmerged: u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const { fields, pathBytes } = splitHeaderAndPath(tok, 10);
      const xy = fields[1] ?? '..';
      parsed.push(buildEntry({
        repositoryKey,
        entryKind: 'unmerged',
        indexStatus: xy[0] ?? '.',
        worktreeStatus: xy[1] ?? '.',
        submoduleState: fields[2] ?? null,
        // Three merge stages (base/ours/theirs) don't map onto head/index; only the
        // worktree mode is meaningful. Unmerged is unsupported-git-state regardless.
        headModeRaw: undefined,
        indexModeRaw: undefined,
        worktreeModeRaw: fields[6],
        renameOrCopyScore: null,
        pathBytes,
        originalPathBytes: null,
      }));
      i += 1;
    } else if (kind === 0x3f) {
      // '?' untracked: ? <path>   (no modes/sub reported by git)
      const { pathBytes } = splitHeaderAndPath(tok, 1);
      parsed.push(buildEntry({
        repositoryKey,
        entryKind: 'untracked',
        indexStatus: '?',
        worktreeStatus: '?',
        submoduleState: null,
        headModeRaw: undefined,
        indexModeRaw: undefined,
        worktreeModeRaw: undefined,
        renameOrCopyScore: null,
        pathBytes,
        originalPathBytes: null,
      }));
      i += 1;
    } else {
      // '!' ignored (never emitted without --ignored) or an unknown line → skip
      // defensively so junk never chokes the producer.
      i += 1;
    }
  }

  return parsed;
}

/**
 * Produce the raw-half `DirtyInventory` for one repository, scoped to one
 * workspace prefix. Returns `{ repository, entries }` — the WP-1D assembler adds
 * `unattributedEntryIds` + `topologyDigest`.
 */
export async function produceDirtyInventory(opts: ProduceDirtyInventoryOptions): Promise<DirtyInventoryDraft> {
  const { repoRoot, workspacePrefix, repository, runGitBytes, runGit, gitExe, deadlineAt } = opts;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  // §2 source command. `--no-optional-locks` avoids touching index.lock on a
  // read; NOT passing `--ignored` gives `--exclude-standard` semantics (ignored
  // files never appear). Scope via the workspace pathspec ONLY.
  const args = ['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--untracked-files=all'];
  const pathspec = enumerationPathspec(workspacePrefix);
  if (pathspec !== null) args.push('--', pathspec);

  const status = await runGitBytes(repoRoot, args, {
    maxBytes,
    gitExe,
    deadlineAt,
    timeoutMs: STATUS_TIMEOUT_MS,
  });

  const parsed = parseStatus(status.stdout, repository.repositoryKey);

  // Raw-hash pass: `hash-object --no-filters` gives the CHECKPOINT raw semantics
  // (bypasses clean filters). ascii output ⇒ the text seam is fine. A failing
  // hash (e.g. a symlink/dir that can't be hashed) leaves rawWorktreeBlobOid null
  // = "unhashable", never a throw.
  for (const p of parsed) {
    if (p.hashPath === null) continue;
    try {
      const res = await runGit(repoRoot, ['hash-object', '--no-filters', '--', p.hashPath], {
        maxBytes: 4096,
        gitExe,
        deadlineAt,
        timeoutMs: STATUS_TIMEOUT_MS,
        allowNonzero: true,
      });
      const oid = res.stdout.trim();
      if (res.code === 0 && /^[0-9a-f]{40,64}$/.test(oid)) {
        p.entry.rawWorktreeBlobOid = oid;
      }
    } catch {
      /* unhashable → leave null */
    }
  }

  // Deterministic order by authoritative bytes (identity is per-entry regardless).
  const entries = parsed.map((p) => p.entry).sort((a, b) =>
    a.path.pathBytesBase64 < b.path.pathBytesBase64 ? -1 : a.path.pathBytesBase64 > b.path.pathBytesBase64 ? 1 : 0,
  );

  return { repository, entries };
}
