// SC-WP-1F — read-only, exact checkpoint-protection evaluation.
//
// Stage 1 has no commit ledger, so this module can only produce
// `checkpoint-protected` or `unprotected`. A checkpoint ref being live is merely
// the first gate: the immutable commit named by that edge must also record the
// member's exact {path, expected state, raw blob OID, mode} tuple.

import {
  PROTECTION_RUNG_ORDER,
  type DirtyEntry,
  type EncodedGitPath,
  type ProtectionRung,
} from '../../shared/commit-candidates';
import type {
  GitRunBytesResult,
  RunGitOptions,
} from '../git-checkpoints/git-command';
import {
  liveEdgeKey,
  verifyLiveEdgesBatch,
  type LiveEdgeRunGit,
} from '../git-checkpoints/live-edge';

export type ProtectionMember = Pick<
  DirtyEntry,
  'entryId' | 'path' | 'expectedWorktreeState' | 'rawWorktreeBlobOid' | 'worktreeMode'
>;

export interface ProtectionCheckpointEdge {
  ref: string | null;
  oid: string | null;
}

export type RunProtectionGitBytes = (
  cwd: string,
  args: string[],
  opts: RunGitOptions,
) => Promise<GitRunBytesResult>;

/** One present entry recorded in a checkpoint commit's tree, keyed by exact path
 *  bytes. Absent paths are represented by their ABSENCE from the returned map. */
export interface CheckpointTreePresence {
  rawBlobOid: string;
  mode: string;
}

export interface ReadCheckpointTreeOptions {
  repoRoot: string;
  checkpointOid: string;
  /** Lossless-UTF-8 member paths to look up in ONE `ls-tree` (multiple pathspecs). */
  paths: readonly EncodedGitPath[];
  runGitBytes: RunProtectionGitBytes;
  gitExe?: string;
}

/**
 * Read the present-entry tuples for a batch of paths from one immutable checkpoint
 * commit. Returns a `pathBytesBase64 → {rawBlobOid, mode}` map; a path missing
 * from the map is authoritatively absent in that tree. Returns `null` when the
 * `ls-tree` read failed or its output was malformed — a broken lookup can never be
 * mistaken for proof that a deletion was captured.
 */
export type CheckpointTreeReader = (
  options: ReadCheckpointTreeOptions,
) => Promise<Map<string, CheckpointTreePresence> | null>;

export interface EvaluateCheckpointProtectionOptions {
  repoRoot: string;
  members: readonly ProtectionMember[];
  checkpointEdges: readonly ProtectionCheckpointEdge[];
  runGit: LiveEdgeRunGit;
  runGitBytes: RunProtectionGitBytes;
  readCheckpointTree?: CheckpointTreeReader;
  gitExe?: string;
}

export interface MemberProtectionResult {
  entryId: string;
  protection: ProtectionRung;
}

export interface CheckpointProtectionResult {
  members: MemberProtectionResult[];
  weakest: ProtectionRung;
}

const GIT_TIMEOUT_MS = 10_000;
const LS_TREE_MAX_BYTES = 1 << 20;
// One `cat-file --batch-check` streams thousands of records; cap output generously
// (a few MB in practice) so a large live-checkpoint × member cross-product fits.
const CAT_FILE_MAX_BYTES = 256 << 20;
const NUL = 0x00;
const LF = 0x0a;

/** True only when a path round-trips losslessly through UTF-8, so it can be sent
 *  as a `:(top,literal)` pathspec. Non-lossless paths can never be safely batched
 *  (mirroring the old per-path reader, which rejected them) and are treated as
 *  unprotected by the evaluator. */
function isLosslessUtf8Path(path: EncodedGitPath): boolean {
  const pathBytes = Buffer.from(path.pathBytesBase64, 'base64');
  return path.utf8Clean
    && Buffer.compare(Buffer.from(pathBytes.toString('utf8'), 'utf8'), pathBytes) === 0;
}

/** A path safe to send as one line of `cat-file --batch-check -z` stdin. The `-z`
 *  input delimiter is NUL, but git still echoes the query verbatim on a "missing"
 *  line terminated by LF, so a path containing LF would desync the output; such
 *  paths fall back to the per-commit `ls-tree` scan. */
function isCatFileSafePath(path: EncodedGitPath): boolean {
  if (!isLosslessUtf8Path(path)) return false;
  return !Buffer.from(path.pathBytesBase64, 'base64').includes(LF);
}

/** Split a git `--batch-check` stdout Buffer into its LF-delimited record lines
 *  (trailing empty dropped), preserving each record's exact bytes. */
function splitBatchCheckLines(stdout: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] === LF) {
      lines.push(stdout.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < stdout.length) lines.push(stdout.subarray(start));
  return lines;
}

/**
 * Read the present-entry tuples for a batch of lossless-UTF-8 paths from one
 * immutable checkpoint commit in a SINGLE `ls-tree` (one spawn covering every
 * path via multiple `:(top,literal)` pathspecs), instead of one spawn per path.
 *
 * Returns a `pathBytesBase64 → {rawBlobOid, mode}` map of the paths present in
 * that tree; a requested path absent from the map is authoritatively absent in
 * the commit. Returns `null` on any Git failure or malformed output, so a broken
 * lookup can never be mistaken for proof that a deletion was captured.
 */
export async function readCheckpointTree(
  options: ReadCheckpointTreeOptions,
): Promise<Map<string, CheckpointTreePresence> | null> {
  const pathspecs: string[] = [];
  for (const path of options.paths) {
    if (!isLosslessUtf8Path(path)) continue;
    const pathText = Buffer.from(path.pathBytesBase64, 'base64').toString('utf8');
    pathspecs.push(`:(top,literal)${pathText}`);
  }
  if (pathspecs.length === 0) return new Map();

  const result = await options.runGitBytes(
    options.repoRoot,
    ['ls-tree', '-z', '--full-tree', options.checkpointOid, '--', ...pathspecs],
    {
      gitExe: options.gitExe,
      allowNonzero: true,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBytes: Math.max(LS_TREE_MAX_BYTES, pathspecs.length * 4096),
    },
  );
  if (result.code !== 0) return null;

  const present = new Map<string, CheckpointTreePresence>();
  const stdout = result.stdout;
  let start = 0;
  for (let i = 0; i <= stdout.length; i++) {
    if (i !== stdout.length && stdout[i] !== 0) continue;
    if (i > start) {
      const record = stdout.subarray(start, i);
      const tab = record.indexOf(0x09);
      if (tab < 0) return null;
      const header = record.subarray(0, tab).toString('ascii').split(' ');
      const recordedPath = record.subarray(tab + 1);
      if (
        header.length !== 3
        || !/^[0-7]{6}$/.test(header[0])
        || !/^[0-9a-f]{40,64}$/.test(header[2])
      ) {
        return null;
      }
      present.set(recordedPath.toString('base64'), {
        rawBlobOid: header[2],
        mode: header[0],
      });
    }
    start = i + 1;
  }
  return present;
}

/**
 * A member's exact {path, expected state, raw blob OID, mode} tuple is recorded in
 * one checkpoint tree iff either: it is present with a matching blob OID and mode,
 * or it is an absence (`absent`/null/null) and the path is absent from the tree.
 */
function memberMatchesTree(
  member: ProtectionMember,
  tree: Map<string, CheckpointTreePresence>,
): boolean {
  const recorded = tree.get(member.path.pathBytesBase64);
  if (member.expectedWorktreeState === 'present') {
    return recorded !== undefined
      && recorded.rawBlobOid === member.rawWorktreeBlobOid
      && recorded.mode === member.worktreeMode;
  }
  return recorded === undefined
    && member.rawWorktreeBlobOid === null
    && member.worktreeMode === null;
}

/**
 * Compute the minimum rung according to the normative order. A real bundle has
 * at least one member; rejecting an empty list avoids inventing a weakest rung.
 */
export function weakestProtectionRung(
  rungs: readonly ProtectionRung[],
): ProtectionRung {
  if (rungs.length === 0) {
    throw new Error('cannot compute protection for an empty bundle');
  }
  return rungs.reduce((weakest, rung) =>
    PROTECTION_RUNG_ORDER[rung] < PROTECTION_RUNG_ORDER[weakest] ? rung : weakest,
  );
}

/** One `cat-file --batch-check` record, classified. `present` carries the blob OID
 *  at that `<commit>:<path>`; `absent` means git reported the path missing. */
type MembershipLine =
  | { kind: 'present'; blobOid: string }
  | { kind: 'absent' }
  | { kind: 'other' };

function classifyBatchLine(line: Buffer): MembershipLine {
  // Success: "<objectname> <type> <size>"; miss: "<query> missing" (query echoed
  // verbatim, so parse from the RIGHT). Bytes decoded latin1 to survive path bytes.
  const text = line.toString('latin1');
  if (text.endsWith(' missing')) return { kind: 'absent' };
  const match = /^([0-9a-f]{40,64}) blob [0-9]+$/.exec(text);
  return match ? { kind: 'present', blobOid: match[1] } : { kind: 'other' };
}

/**
 * Phase 1 — resolve, in ONE `cat-file --batch-check -z`, whether each live
 * checkpoint commit records a blob at each member path (and, if so, which blob).
 * Collapses the per-(commit × member) `ls-tree` fan-out — thousands of spawns on a
 * real workspace — into a single streaming process.
 *
 * Returns, per member entryId: the set of commit OIDs whose tree holds a blob with
 * the member's exact worktree OID at its path (`blobHitOids`, still needing a mode
 * check), and whether ANY live commit records the path as absent (`sawAbsent`).
 * Returns `null` on Git failure or a record-count mismatch — never absence proof.
 */
async function probeCheckpointMembership(options: {
  repoRoot: string;
  liveOids: readonly string[];
  members: readonly ProtectionMember[];
  runGitBytes: RunProtectionGitBytes;
  gitExe?: string;
}): Promise<Map<string, { blobHitOids: string[]; sawAbsent: boolean }> | null> {
  const { repoRoot, liveOids, members } = options;
  const result = new Map<string, { blobHitOids: string[]; sawAbsent: boolean }>(
    members.map((member) => [member.entryId, { blobHitOids: [], sawAbsent: false }]),
  );
  if (liveOids.length === 0 || members.length === 0) return result;

  // Stdin: one NUL-terminated `<commit>:<pathBytes>` per (commit × member).
  const stdinParts: Buffer[] = [];
  for (const oid of liveOids) {
    const prefix = Buffer.from(`${oid}:`, 'ascii');
    for (const member of members) {
      stdinParts.push(prefix, Buffer.from(member.path.pathBytesBase64, 'base64'), Buffer.from([NUL]));
    }
  }

  const probe = await options.runGitBytes(
    repoRoot,
    ['cat-file', '--batch-check', '-z'],
    {
      gitExe: options.gitExe,
      allowNonzero: true,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBytes: CAT_FILE_MAX_BYTES,
      stdin: Buffer.concat(stdinParts),
    },
  );
  if (probe.code !== 0) return null;

  const lines = splitBatchCheckLines(probe.stdout);
  if (lines.length !== liveOids.length * members.length) return null; // desync ⇒ no proof

  for (let o = 0; o < liveOids.length; o++) {
    for (let m = 0; m < members.length; m++) {
      const member = members[m];
      const entry = result.get(member.entryId)!;
      const classified = classifyBatchLine(lines[o * members.length + m]);
      if (classified.kind === 'present' && classified.blobOid === member.rawWorktreeBlobOid) {
        entry.blobHitOids.push(liveOids[o]);
      } else if (classified.kind === 'absent') {
        entry.sawAbsent = true;
      }
    }
  }
  return result;
}

/**
 * Evaluate Stage-1 protection with request-scoped, batched Git probes. Semantics
 * are unchanged — a member is checkpoint-protected iff its exact {path, expected
 * state, raw blob OID, mode} tuple is recorded in the tree of a live-verified
 * checkpoint edge; read failures degrade to unprotected, never to deletion
 * evidence. Only the Git spawn shape changes:
 *
 *  1. Every DISTINCT edge ref is live-verified in ONE `cat-file --batch-check`
 *     (not one `rev-parse` per edge). Repeated / shared refs collapse to one probe.
 *  2. Path membership across ALL unique live commit OIDs is resolved in ONE
 *     `cat-file --batch-check -z` over the `<commit>:<path>` cross-product — an
 *     absent record protects a deletion outright; a blob-OID hit is a candidate.
 *  3. Only candidate hits need their tree entry MODE confirmed, via a small
 *     `ls-tree` pass (grouped by commit, early-exiting once every member resolves).
 *
 * On the real ~840-turn / ~1,600-edge workspace this is a handful of spawns rather
 * than the former thousands.
 */
export async function evaluateCheckpointProtection(
  options: EvaluateCheckpointProtectionOptions,
): Promise<CheckpointProtectionResult> {
  if (options.members.length === 0) {
    throw new Error('cannot evaluate protection for an empty bundle');
  }

  // (1) One batched liveness probe for the whole request.
  const liveKeys = await verifyLiveEdgesBatch({
    repoRoot: options.repoRoot,
    edges: options.checkpointEdges,
    runGit: options.runGit,
    gitExe: options.gitExe,
  });

  // Live edges → unique commit OIDs, so an OID shared by many turns' before/after
  // edges is inspected exactly once.
  const liveOids = [...new Set(
    options.checkpointEdges
      .filter(
        (edge): edge is { ref: string; oid: string } =>
          Boolean(edge.ref)
          && Boolean(edge.oid)
          && liveKeys.has(liveEdgeKey(edge.ref!, edge.oid!)),
      )
      .map((edge) => edge.oid),
  )];

  const reader = options.readCheckpointTree ?? readCheckpointTree;
  const protectedIds = new Set<string>();

  // Non-lossless-UTF-8 paths can never be represented as a literal pathspec, so
  // (mirroring the former per-path reader, which rejected them) they are never
  // batchable and remain unprotected. Paths containing LF can't ride the LF-framed
  // batch-check output either → they take the per-commit ls-tree fallback below.
  const batchable = options.members.filter((member) => isCatFileSafePath(member.path));
  const lsTreeOnly = options.members.filter(
    (member) => isLosslessUtf8Path(member.path) && !isCatFileSafePath(member.path),
  );

  if (liveOids.length > 0 && batchable.length > 0) {
    const membership = await probeCheckpointMembership({
      repoRoot: options.repoRoot,
      liveOids,
      members: batchable,
      runGitBytes: options.runGitBytes,
      gitExe: options.gitExe,
    }).catch(() => null); // a failed batch probe is not protection proof
    if (membership) {
      // Absences are fully resolved by the batch — a deletion is protected the
      // moment any live commit records its path as absent.
      const modeCandidates: ProtectionMember[] = [];
      for (const member of batchable) {
        const hit = membership.get(member.entryId)!;
        if (member.expectedWorktreeState === 'absent') {
          if (hit.sawAbsent && member.rawWorktreeBlobOid === null && member.worktreeMode === null) {
            protectedIds.add(member.entryId);
          }
        } else if (member.worktreeMode !== null && hit.blobHitOids.length > 0) {
          // A present member with no worktree mode (e.g. an untracked file, which
          // `git status` reports without a mode) can never equal a checkpoint tree
          // entry's always-present mode, so it is never protected — skip the futile
          // mode-confirm scan across its (often hundreds of) blob-hit commits.
          modeCandidates.push(member);
        }
      }

      // (3) Confirm the tree-entry MODE for blob-OID hits with a GREEDY set cover.
      // A file dirty-unchanged for many turns has its blob in hundreds of live
      // checkpoints, so its candidate-OID set is huge — but its mode is one value,
      // and a single recent checkpoint typically records ALL such members at once.
      // Each round ls-trees the ONE commit covering the most still-pending members;
      // mode mismatches drop that commit from the member's set and retry. This
      // bounds the mode-confirm pass to a handful of spawns instead of one per hit.
      const pendingOids = new Map<string, Set<string>>(
        modeCandidates.map((member) => [
          member.entryId,
          new Set(membership.get(member.entryId)!.blobHitOids),
        ]),
      );
      const byEntryId = new Map(modeCandidates.map((member) => [member.entryId, member]));
      while (pendingOids.size > 0) {
        const coverage = new Map<string, number>();
        for (const oids of pendingOids.values()) {
          for (const oid of oids) coverage.set(oid, (coverage.get(oid) ?? 0) + 1);
        }
        if (coverage.size === 0) break; // remaining candidates have no commit left to try
        let bestOid = '';
        let best = -1;
        for (const [oid, count] of coverage) {
          if (count > best) { best = count; bestOid = oid; }
        }
        const here = [...pendingOids.keys()].filter((id) => pendingOids.get(id)!.has(bestOid));
        const tree = await reader({
          repoRoot: options.repoRoot,
          checkpointOid: bestOid,
          paths: here.map((id) => byEntryId.get(id)!.path),
          runGitBytes: options.runGitBytes,
          gitExe: options.gitExe,
        }).catch(() => null);
        for (const id of here) {
          if (tree && memberMatchesTree(byEntryId.get(id)!, tree)) {
            protectedIds.add(id);
            pendingOids.delete(id); // confirmed
          } else {
            // Not proven at bestOid (mode mismatch, or a failed read): never retry
            // this commit for this member; fall through to its remaining commits.
            const remaining = pendingOids.get(id)!;
            remaining.delete(bestOid);
            if (remaining.size === 0) pendingOids.delete(id); // exhausted ⇒ unprotected
          }
        }
      }
    }
  }

  // Fallback for the rare LF-in-path members: scan the unique live commits with a
  // per-commit ls-tree, early-exiting once each resolves. Preserves exact semantics
  // for paths the batch-check line framing cannot carry.
  if (liveOids.length > 0 && lsTreeOnly.length > 0) {
    const pending = new Set(lsTreeOnly.map((member) => member.entryId));
    for (const checkpointOid of liveOids) {
      if (pending.size === 0) break;
      const tree = await reader({
        repoRoot: options.repoRoot,
        checkpointOid,
        paths: lsTreeOnly.map((member) => member.path),
        runGitBytes: options.runGitBytes,
        gitExe: options.gitExe,
      }).catch(() => null);
      if (!tree) continue;
      for (const member of lsTreeOnly) {
        if (pending.has(member.entryId) && memberMatchesTree(member, tree)) {
          protectedIds.add(member.entryId);
          pending.delete(member.entryId);
        }
      }
    }
  }

  const members: MemberProtectionResult[] = options.members.map((member) => ({
    entryId: member.entryId,
    protection: protectedIds.has(member.entryId) ? 'checkpoint-protected' : 'unprotected',
  }));

  return {
    members,
    weakest: weakestProtectionRung(members.map((member) => member.protection)),
  };
}
