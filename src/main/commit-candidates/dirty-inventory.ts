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
// authoritative status bytes + batched raw-path hashing; text `runGit` for the
// ascii-only per-entry hash fallback), so unit tests drive it with either a real
// git in a throwaway temp repo or crafted byte fixtures (the only way to exercise
// non-UTF-8 paths on Windows).

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

/**
 * Encode one raw path for `hash-object --stdin-paths`.
 *
 * Git reads one line at a time and C-unquotes any line beginning with `"`.
 * Ordinary paths can therefore pass through byte-for-byte, but paths containing
 * a line terminator or beginning with `"` must use Git's C-style quoted form.
 * Quoted non-printable/high bytes use three-digit octal so arbitrary path bytes
 * (including non-UTF-8) survive `unquote_c_style` exactly.
 */
export function encodeHashObjectStdinPathLine(pathBytes: Buffer): Buffer {
  const mustQuote =
    pathBytes.includes(0x0a) ||
    pathBytes.includes(0x0d) ||
    pathBytes[0] === 0x22;

  if (!mustQuote) return Buffer.concat([pathBytes, Buffer.from([0x0a])]);

  const encoded: number[] = [0x22];
  for (const byte of pathBytes) {
    if (byte === 0x5c || byte === 0x22) {
      encoded.push(0x5c, byte);
    } else if (byte < 0x20 || byte >= 0x7f) {
      const octal = byte.toString(8).padStart(3, '0');
      encoded.push(0x5c, octal.charCodeAt(0), octal.charCodeAt(1), octal.charCodeAt(2));
    } else {
      encoded.push(byte);
    }
  }
  encoded.push(0x22, 0x0a);
  return Buffer.from(encoded);
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
  /** Authoritative repo-relative path bytes for hash-object. Absent worktree
   *  entries alone are omitted; non-UTF-8 paths remain hashable. */
  hashPathBytes: Buffer | null;
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

  // `--stdin-paths` accepts authoritative bytes, so every present path is
  // hashable regardless of whether it round-trips through UTF-8.
  const hashPathBytes = expectedWorktreeState === 'present' ? args.pathBytes : null;

  return { entry, hashPathBytes };
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

  const hashable = parsed.filter((p) => p.hashPathBytes !== null);
  const hashArgs = ['hash-object', '--no-filters', '--stdin-paths'];
  const hashMaxBytes = Math.max(4096, hashable.length * 66);
  const parseOids = (stdout: Buffer | string, expected: number): string[] | null => {
    const lines = (Buffer.isBuffer(stdout) ? stdout.toString('ascii') : stdout).split('\n');
    if (lines.at(-1) === '') lines.pop();
    const oids = lines.map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
    return oids.length === expected && oids.every((oid) => /^[0-9a-f]{40,64}$/.test(oid))
      ? oids
      : null;
  };

  // Raw-hash pass: one common-case process hashes every present path in input
  // order. Git aborts `--stdin-paths` on the first unhashable member, so any
  // nonzero/malformed batch result is discarded and retried one entry per process.
  // That slower fallback preserves the exact per-entry contract: absent entries
  // were never sent, while only the individual unhashable entries remain null.
  let batchOids: string[] | null = null;
  if (hashable.length > 0) {
    try {
      const res = await runGitBytes(repoRoot, hashArgs, {
        maxBytes: hashMaxBytes,
        gitExe,
        deadlineAt,
        timeoutMs: STATUS_TIMEOUT_MS,
        allowNonzero: true,
        stdin: Buffer.concat(hashable.map((p) => encodeHashObjectStdinPathLine(p.hashPathBytes!))),
      });
      if (res.code === 0) batchOids = parseOids(res.stdout, hashable.length);
    } catch {
      /* retry individually below */
    }
  }

  if (batchOids) {
    hashable.forEach((p, index) => {
      p.entry.rawWorktreeBlobOid = batchOids![index];
    });
  } else {
    for (const p of hashable) {
      try {
        const res = await runGit(repoRoot, hashArgs, {
          maxBytes: 4096,
          gitExe,
          deadlineAt,
          timeoutMs: STATUS_TIMEOUT_MS,
          allowNonzero: true,
          stdin: encodeHashObjectStdinPathLine(p.hashPathBytes!),
        });
        const oid = res.code === 0 ? parseOids(res.stdout, 1)?.[0] : undefined;
        if (oid) p.entry.rawWorktreeBlobOid = oid;
      } catch {
        /* unhashable → leave null */
      }
    }
  }

  // Deterministic order by authoritative bytes (identity is per-entry regardless).
  const entries = parsed.map((p) => p.entry).sort((a, b) =>
    a.path.pathBytesBase64 < b.path.pathBytesBase64 ? -1 : a.path.pathBytesBase64 > b.path.pathBytesBase64 ? 1 : 0,
  );

  return { repository, entries };
}
