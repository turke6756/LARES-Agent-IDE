// SC-WP-2J — read the current commit representation without touching the real
// index. MAIN-PROCESS ONLY.
//
// The temporary index models `git commit --only`: seed it from the pinned HEAD,
// apply only the selected worktree paths, then inspect the resulting stage-0
// entry. Authoritative path bytes are transported only through NUL-delimited
// files/stdin; they never pass through a Node string argv.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DirtyEntry, EncodedGitPath } from '../../shared/commit-candidates';
import { CheckpointQueue, type SkippedDeadline } from '../git-checkpoints/checkpoint-queue';
import {
  runGit as realRunGit,
  runGitBytes as realRunGitBytes,
  type GitRunBytesResult,
  type GitRunResult,
  type RunGitOptions,
} from '../git-checkpoints/git-command';

const DEFAULT_MAX_BYTES = 64 << 20;
const DEFAULT_TIMEOUT_MS = 30_000;

export type CommitRepresentationEntry = Pick<
  DirtyEntry,
  'path' | 'commitPathspecs' | 'expectedWorktreeState' | 'rawWorktreeBlobOid'
>;

export interface CommitRepresentation {
  expectedState: 'present' | 'absent';
  rawBlobOid: string | null;
  commitBlobOid: string | null;
  commitMode: string | null;
}

export type CommitRepresentationRunGit = (
  cwd: string,
  args: string[],
  options: RunGitOptions,
) => Promise<GitRunResult>;

export type CommitRepresentationRunGitBytes = (
  cwd: string,
  args: string[],
  options: RunGitOptions,
) => Promise<GitRunBytesResult>;

export interface ReadCurrentCommitRepresentationOptions {
  repoRoot: string;
  /** Commit whose tree models the base of `git commit --only`; null means unborn. */
  pinnedHeadOid: string | null;
  entry: CommitRepresentationEntry;
  gitExe?: string;
  deadlineAt?: number;
  maxBytes?: number;
  tmpDir?: string;
  runGit?: CommitRepresentationRunGit;
  runGitBytes?: CommitRepresentationRunGitBytes;
  /** Production callers provide the shared object-db queue and its opaque key. */
  queue?: CheckpointQueue;
  commonDirQueueKey?: string;
}

interface StageEntry {
  mode: string;
  oid: string;
  stage: string;
  pathBytesBase64: string;
}

const MEMBER_READ_CONCURRENCY = 8;

interface PendingRepresentationRead {
  options: ReadCurrentCommitRepresentationOptions;
  resolve(value: CommitRepresentation): void;
  reject(reason: unknown): void;
}

let pendingReads: PendingRepresentationRead[] = [];
let flushScheduled = false;

/** Parse the complete binary `ls-files --stage -z` stream without decoding paths. */
export function parseStageEntries(stdout: Buffer): StageEntry[] {
  const entries: StageEntry[] = [];
  let start = 0;
  for (let i = 0; i <= stdout.length; i++) {
    if (i !== stdout.length && stdout[i] !== 0) continue;
    if (i === start) {
      start = i + 1;
      continue;
    }
    const record = stdout.subarray(start, i);
    start = i + 1;
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error('Malformed git ls-files --stage record: missing TAB.');
    const metadata = record.subarray(0, tab).toString('ascii').split(' ');
    if (metadata.length !== 3 || !/^\d{6}$/.test(metadata[0]) || !/^[0-9a-f]{40,64}$/.test(metadata[1])) {
      throw new Error('Malformed git ls-files --stage record metadata.');
    }
    entries.push({
      mode: metadata[0],
      oid: metadata[1],
      stage: metadata[2],
      pathBytesBase64: record.subarray(tab + 1).toString('base64'),
    });
  }
  return entries;
}

function pathBytes(encoded: EncodedGitPath): Buffer {
  const bytes = Buffer.from(encoded.pathBytesBase64, 'base64');
  if (
    bytes.length === 0
    || bytes.includes(0)
    || bytes.toString('base64') !== encoded.pathBytesBase64
  ) {
    throw new Error('Git path bytes must be canonical base64, non-empty, and contain no NUL.');
  }
  return bytes;
}

function nulDelimited(paths: EncodedGitPath[]): Buffer {
  return Buffer.concat(paths.flatMap((encoded) => [pathBytes(encoded), Buffer.from([0])]));
}

function skipped(value: unknown): value is SkippedDeadline {
  return typeof value === 'object' && value !== null && (value as SkippedDeadline).skipped === 'deadline';
}

async function readRepresentations(
  options: Omit<ReadCurrentCommitRepresentationOptions, 'entry'>,
  entries: readonly CommitRepresentationEntry[],
  runGit: CommitRepresentationRunGit,
  runGitBytes: CommitRepresentationRunGitBytes,
): Promise<CommitRepresentation[]> {
  for (const entry of entries) {
    if (entry.commitPathspecs.length === 0) {
      throw new Error('At least one authoritative commit pathspec is required.');
    }
    if (!entry.commitPathspecs.some(
      (candidate) => candidate.pathBytesBase64 === entry.path.pathBytesBase64,
    )) {
      throw new Error('The represented path must be included in commitPathspecs.');
    }
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const tempRoot = await fs.promises.mkdtemp(path.join(options.tmpDir ?? os.tmpdir(), 'lares-commit-repr-'));
  const nonce = randomUUID();
  const indexFile = path.join(tempRoot, `${nonce}.index`);
  const pathspecFile = path.join(tempRoot, `${nonce}.paths`);
  const gitOptions: RunGitOptions = {
    indexFile,
    gitExe: options.gitExe,
    deadlineAt: options.deadlineAt,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBytes,
  };

  try {
    await runGit(
      options.repoRoot,
      options.pinnedHeadOid === null
        ? ['read-tree', '--empty']
        : ['read-tree', options.pinnedHeadOid],
      gitOptions,
    );

    const uniquePathspecs = new Map<string, EncodedGitPath>();
    for (const entry of entries) {
      for (const pathspec of entry.commitPathspecs) {
        uniquePathspecs.set(pathspec.pathBytesBase64, pathspec);
      }
    }
    await fs.promises.writeFile(pathspecFile, nulDelimited([...uniquePathspecs.values()]));
    await runGit(options.repoRoot, [
      'add',
      `--pathspec-from-file=${pathspecFile}`,
      '--pathspec-file-nul',
    ], gitOptions);

    const staged = await runGitBytes(options.repoRoot, ['ls-files', '--stage', '-z'], gitOptions);
    const stagedByPath = new Map<string, StageEntry[]>();
    for (const candidate of parseStageEntries(staged.stdout)) {
      const matches = stagedByPath.get(candidate.pathBytesBase64) ?? [];
      matches.push(candidate);
      stagedByPath.set(candidate.pathBytesBase64, matches);
    }
    return entries.map((entry) => {
      const matches = stagedByPath.get(entry.path.pathBytesBase64) ?? [];
      if (entry.expectedWorktreeState === 'absent') {
        if (matches.length !== 0) throw new Error('Temporary index still contains an expected-absent path.');
        return {
          expectedState: 'absent',
          rawBlobOid: entry.rawWorktreeBlobOid,
          commitBlobOid: null,
          commitMode: null,
        };
      }
      if (matches.length !== 1 || matches[0].stage !== '0') {
        throw new Error('Temporary index did not produce exactly one stage-0 entry for the selected path.');
      }
      return {
        expectedState: 'present',
        rawBlobOid: entry.rawWorktreeBlobOid,
        commitBlobOid: matches[0].oid,
        commitMode: matches[0].mode,
      };
    });
  } finally {
    // Git normally removes its lock, but clean it defensively after killed/failed
    // commands as well. The isolated directory guarantees no foreign file is hit.
    await Promise.all([
      fs.promises.unlink(pathspecFile).catch(() => undefined),
      fs.promises.unlink(indexFile).catch(() => undefined),
      fs.promises.unlink(`${indexFile}.lock`).catch(() => undefined),
    ]);
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  }
}

function compatible(
  left: ReadCurrentCommitRepresentationOptions,
  right: ReadCurrentCommitRepresentationOptions,
): boolean {
  return left.repoRoot === right.repoRoot
    && left.pinnedHeadOid === right.pinnedHeadOid
    && left.gitExe === right.gitExe
    && left.deadlineAt === right.deadlineAt
    && left.maxBytes === right.maxBytes
    && left.tmpDir === right.tmpDir
    && (left.runGit ?? realRunGit) === (right.runGit ?? realRunGit)
    && (left.runGitBytes ?? realRunGitBytes) === (right.runGitBytes ?? realRunGitBytes)
    && left.queue === right.queue
    && left.commonDirQueueKey === right.commonDirQueueKey;
}

async function executeBatch(batch: PendingRepresentationRead[]): Promise<void> {
  const first = batch[0].options;
  const runGit = first.runGit ?? realRunGit;
  const runGitBytes = first.runGitBytes ?? realRunGitBytes;
  const maxBytes = first.maxBytes ?? DEFAULT_MAX_BYTES;
  const operation = async (): Promise<CommitRepresentation[]> => {
    const snapshotOptions: RunGitOptions = {
      gitExe: first.gitExe,
      deadlineAt: first.deadlineAt,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxBytes,
    };
    const before = (await runGitBytes(first.repoRoot, ['ls-files', '--stage', '-z'], snapshotOptions)).stdout;
    try {
      return await readRepresentations(first, batch.map((pending) => pending.options.entry), runGit, runGitBytes);
    } finally {
      const after = (await runGitBytes(first.repoRoot, ['ls-files', '--stage', '-z'], snapshotOptions)).stdout;
      if (!before.equals(after)) {
        throw new Error('Real Git index changed during read-only commit-representation computation.');
      }
    }
  };

  try {
    let representations: CommitRepresentation[];
    if (!first.queue || !first.commonDirQueueKey) {
      representations = await operation();
    } else {
      const settled = await first.queue.withPriority(
        first.commonDirQueueKey,
        {
          priority: 'MAINTENANCE',
          deadlineAt: first.deadlineAt ?? Date.now() + DEFAULT_TIMEOUT_MS,
        },
        operation,
      );
      if (skipped(settled)) throw new Error('Commit-representation read expired in the object-db queue.');
      representations = settled;
    }
    batch.forEach((pending, index) => pending.resolve(representations[index]));
  } catch (error) {
    batch.forEach((pending) => pending.reject(error));
  }
}

async function flushPendingReads(): Promise<void> {
  flushScheduled = false;
  const reads = pendingReads;
  pendingReads = [];
  const groups: PendingRepresentationRead[][] = [];
  for (const pending of reads) {
    const group = groups.find((candidate) => compatible(candidate[0].options, pending.options));
    if (group) group.push(pending);
    else groups.push([pending]);
  }
  for (let offset = 0; offset < groups.length; offset += MEMBER_READ_CONCURRENCY) {
    await Promise.all(groups.slice(offset, offset + MEMBER_READ_CONCURRENCY).map(executeBatch));
  }
}

/**
 * Compute the selected path's raw + clean-filtered commit representation while
 * preserving the real index. A complete raw real-index snapshot check brackets
 * the whole temp-index operation and is enforced even when the operation throws.
 */
export async function readCurrentCommitRepresentation(
  options: ReadCurrentCommitRepresentationOptions,
): Promise<CommitRepresentation> {
  if ((options.queue === undefined) !== (options.commonDirQueueKey === undefined)) {
    throw new Error('queue and commonDirQueueKey must be provided together.');
  }
  return new Promise<CommitRepresentation>((resolve, reject) => {
    pendingReads.push({ options, resolve, reject });
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(() => { void flushPendingReads(); });
    }
  });
}
