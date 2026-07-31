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
  verifyLiveEdge,
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

export type CheckpointTreeEntry =
  | {
      pathBytesBase64: string;
      expectedState: 'present';
      rawBlobOid: string;
      mode: string;
    }
  | {
      pathBytesBase64: string;
      expectedState: 'absent';
      rawBlobOid: null;
      mode: null;
    };

export interface ReadCheckpointTreeEntryOptions {
  repoRoot: string;
  checkpointOid: string;
  path: EncodedGitPath;
  runGitBytes: RunProtectionGitBytes;
  gitExe?: string;
}

export type CheckpointTreeReader = (
  options: ReadCheckpointTreeEntryOptions,
) => Promise<CheckpointTreeEntry>;

export interface EvaluateCheckpointProtectionOptions {
  repoRoot: string;
  members: readonly ProtectionMember[];
  checkpointEdges: readonly ProtectionCheckpointEdge[];
  runGit: LiveEdgeRunGit;
  runGitBytes: RunProtectionGitBytes;
  readCheckpointTreeEntry?: CheckpointTreeReader;
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

/**
 * Read one exact path from an immutable checkpoint commit.
 *
 * A successful, empty `ls-tree` result is an authoritative absent entry. Git
 * failure or malformed output throws, so a broken lookup can never be mistaken
 * for proof that a deletion was captured.
 */
export async function readCheckpointTreeEntry(
  options: ReadCheckpointTreeEntryOptions,
): Promise<CheckpointTreeEntry> {
  const pathBytes = Buffer.from(options.path.pathBytesBase64, 'base64');
  if (
    !options.path.utf8Clean
    || Buffer.compare(Buffer.from(pathBytes.toString('utf8'), 'utf8'), pathBytes) !== 0
  ) {
    throw new Error('checkpoint tree lookup requires a lossless UTF-8 Git path');
  }

  const pathText = pathBytes.toString('utf8');
  const result = await options.runGitBytes(
    options.repoRoot,
    [
      'ls-tree',
      '-z',
      '--full-tree',
      options.checkpointOid,
      '--',
      `:(top,literal)${pathText}`,
    ],
    {
      gitExe: options.gitExe,
      allowNonzero: true,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBytes: LS_TREE_MAX_BYTES,
    },
  );
  if (result.code !== 0) {
    throw new Error('checkpoint tree lookup failed');
  }
  if (result.stdout.length === 0) {
    return {
      pathBytesBase64: options.path.pathBytesBase64,
      expectedState: 'absent',
      rawBlobOid: null,
      mode: null,
    };
  }

  const nul = result.stdout.indexOf(0);
  if (nul < 0 || nul !== result.stdout.length - 1) {
    throw new Error('malformed checkpoint ls-tree output');
  }
  const record = result.stdout.subarray(0, nul);
  const tab = record.indexOf(0x09);
  if (tab < 0) throw new Error('malformed checkpoint ls-tree record');

  const header = record.subarray(0, tab).toString('ascii').split(' ');
  const recordedPath = record.subarray(tab + 1);
  if (
    header.length !== 3
    || !/^[0-7]{6}$/.test(header[0])
    || !/^[0-9a-f]{40,64}$/.test(header[2])
    || Buffer.compare(recordedPath, pathBytes) !== 0
  ) {
    throw new Error('checkpoint tree entry did not match the requested path');
  }

  return {
    pathBytesBase64: recordedPath.toString('base64'),
    expectedState: 'present',
    rawBlobOid: header[2],
    mode: header[0],
  };
}

function exactTupleMatches(
  member: ProtectionMember,
  checkpoint: CheckpointTreeEntry,
): boolean {
  return checkpoint.pathBytesBase64 === member.path.pathBytesBase64
    && checkpoint.expectedState === member.expectedWorktreeState
    && checkpoint.rawBlobOid === member.rawWorktreeBlobOid
    && checkpoint.mode === member.worktreeMode;
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

/**
 * Evaluate Stage-1 protection. Every usable edge is live-verified once, then
 * its immutable commit tree is inspected per member. Read failures degrade to
 * unprotected; they never become deletion evidence.
 */
export async function evaluateCheckpointProtection(
  options: EvaluateCheckpointProtectionOptions,
): Promise<CheckpointProtectionResult> {
  if (options.members.length === 0) {
    throw new Error('cannot evaluate protection for an empty bundle');
  }

  const liveEdges = (
    await Promise.all(options.checkpointEdges.map(async (edge) => ({
      edge,
      live: await verifyLiveEdge({
        repoRoot: options.repoRoot,
        ref: edge.ref,
        oid: edge.oid,
        runGit: options.runGit,
        gitExe: options.gitExe,
      }),
    })))
  ).filter(
    (item): item is { edge: ProtectionCheckpointEdge & { oid: string }; live: true } =>
      item.live && item.edge.oid !== null,
  );

  const reader = options.readCheckpointTreeEntry ?? readCheckpointTreeEntry;
  const members = await Promise.all(options.members.map(async (member): Promise<MemberProtectionResult> => {
    for (const { edge } of liveEdges) {
      try {
        const checkpoint = await reader({
          repoRoot: options.repoRoot,
          checkpointOid: edge.oid,
          path: member.path,
          runGitBytes: options.runGitBytes,
          gitExe: options.gitExe,
        });
        if (exactTupleMatches(member, checkpoint)) {
          return { entryId: member.entryId, protection: 'checkpoint-protected' };
        }
      } catch {
        // Missing/corrupt/unreadable tree data is not protection proof.
      }
    }
    return { entryId: member.entryId, protection: 'unprotected' };
  }));

  return {
    members,
    weakest: weakestProtectionRung(members.map((member) => member.protection)),
  };
}
