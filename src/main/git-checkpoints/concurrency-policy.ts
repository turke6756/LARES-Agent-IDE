// Canonical observe/classify/act policy for intent-aware path concurrency.
// Predictions remain in contention-model.ts and are advisory only. This module
// works exclusively from per-path blobs resolved from checkpoint trees; checkpoint
// commit OIDs are never compared as a proxy for path content.

import { createHash } from 'node:crypto';

import type {
  CrossIntentChallengeAtom,
  EncodedGitPath,
  ReviewChallengeAtom,
} from '../../shared/commit-candidates';
import type { GitRunResult, RunGitOptions } from './git-command';
import { recordIntentArchitectureEvent } from './intent-architecture-telemetry';

export const CONCURRENCY_CLASSIFIER_VERSION = 1 as const;

export type ConcurrencyClassification =
  | 'same-intent-coauthor'
  | 'cross-intent-convergent'
  | 'cross-intent-carried-forward'
  | 'cross-intent-suspected-lost-update'
  | 'evidence-incomplete';

export interface PathIntentObservation {
  repositoryKey: string;
  path: EncodedGitPath;
  intentId: string | null;
  turnId: string;
  agentId: string | null;
  beforeCommitOid: string | null;
  afterCommitOid: string | null;
  beforeBlobOid: string | null;
  afterBlobOid: string | null;
  finalBlobOid: string | null;
  startedAt: number | null;
  endedAt: number | null;
  evidenceQuality: 'complete' | 'partial';
}

export interface PathIntentCheckpointEvidence {
  intentId: string | null;
  turnId: string;
  agentId: string | null;
  beforeCommitOid: string | null;
  afterCommitOid: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

export type ConcurrencyRunGit = (
  cwd: string,
  args: string[],
  opts: RunGitOptions,
) => Promise<GitRunResult>;

export interface ObservePathIntentsInput {
  repoRoot: string;
  gitExe: string;
  repositoryKey: string;
  path: EncodedGitPath;
  finalBlobOid: string | null;
  turns: readonly PathIntentCheckpointEvidence[];
  runGit: ConcurrencyRunGit;
}

/** Resolve one path's blob from one checkpoint tree. Absence/pruning is data. */
export async function resolveCheckpointPathBlob(input: {
  repoRoot: string;
  gitExe: string;
  commitOid: string | null;
  path: EncodedGitPath;
  runGit: ConcurrencyRunGit;
}): Promise<string | null> {
  if (!input.commitOid || !input.path.utf8Clean) return null;
  const result = await input.runGit(
    input.repoRoot,
    ['ls-tree', input.commitOid, '--', input.path.displayPath],
    { gitExe: input.gitExe, maxBytes: 64 << 10, timeoutMs: 10_000, allowNonzero: true },
  );
  if (result.code !== 0) return null;
  const line = result.stdout.split(/\r?\n/, 1)[0] ?? '';
  const match = /^(\d{6})\s+blob\s+([0-9a-f]+)\t/.exec(line);
  return match?.[2] ?? null;
}

/** Observe every turn using ls-tree on its before/after checkpoint tree. */
export async function observePathIntents(
  input: ObservePathIntentsInput,
): Promise<PathIntentObservation[]> {
  const observations = await Promise.all(input.turns.map(async (turn) => {
    const [beforeBlobOid, afterBlobOid] = await Promise.all([
      resolveCheckpointPathBlob({ ...input, commitOid: turn.beforeCommitOid }),
      resolveCheckpointPathBlob({ ...input, commitOid: turn.afterCommitOid }),
    ]);
    return {
      repositoryKey: input.repositoryKey,
      path: input.path,
      ...turn,
      beforeBlobOid,
      afterBlobOid,
      finalBlobOid: input.finalBlobOid,
      evidenceQuality: turn.beforeCommitOid && turn.afterCommitOid
        && beforeBlobOid && afterBlobOid && input.finalBlobOid ? 'complete' as const : 'partial' as const,
    };
  }));
  if (observations.length > 0) recordIntentArchitectureEvent('observed', observations.length);
  return observations;
}

export interface ConcurrencyCase {
  repositoryKey: string;
  path: EncodedGitPath;
  classification: ConcurrencyClassification;
  blocking: boolean;
  earlierIntentId: string | null;
  laterIntentId: string | null;
  evidenceDigest: string;
  observations: PathIntentObservation[];
  note: string | null;
}

function stableEvidence(observations: readonly PathIntentObservation[]): object {
  return {
    classifierVersion: CONCURRENCY_CLASSIFIER_VERSION,
    path: observations[0]?.path.pathBytesBase64 ?? '',
    observations: observations.map((item) => ({
      intentId: item.intentId,
      turnId: item.turnId,
      beforeBlobOid: item.beforeBlobOid,
      afterBlobOid: item.afterBlobOid,
      finalBlobOid: item.finalBlobOid,
    })),
  };
}

export function concurrencyEvidenceDigest(observations: readonly PathIntentObservation[]): string {
  return createHash('sha256').update(JSON.stringify(stableEvidence(observations))).digest('hex');
}

function orderedPair(
  left: PathIntentObservation,
  right: PathIntentObservation,
): [PathIntentObservation, PathIntentObservation] | null {
  // A checkpoint edge is stronger than wall-clock order.
  if (left.beforeBlobOid && right.afterBlobOid && left.beforeBlobOid === right.afterBlobOid) {
    return [right, left];
  }
  if (right.beforeBlobOid && left.afterBlobOid && right.beforeBlobOid === left.afterBlobOid) {
    return [left, right];
  }
  // Use time only when turns are provably non-overlapping; never order merely by
  // which started first.
  if (left.endedAt !== null && right.startedAt !== null && left.endedAt <= right.startedAt) {
    return [left, right];
  }
  if (right.endedAt !== null && left.startedAt !== null && right.endedAt <= left.startedAt) {
    return [right, left];
  }
  return null;
}

function classifyPair(
  left: PathIntentObservation,
  right: PathIntentObservation,
): { classification: ConcurrencyClassification; earlier: PathIntentObservation | null; later: PathIntentObservation | null } {
  if (left.intentId !== null && left.intentId === right.intentId) {
    return { classification: 'same-intent-coauthor', earlier: null, later: null };
  }
  if (left.intentId === null || right.intentId === null) {
    return { classification: 'evidence-incomplete', earlier: null, later: null };
  }
  if (left.afterBlobOid && left.afterBlobOid === right.afterBlobOid
      && left.finalBlobOid === left.afterBlobOid && right.finalBlobOid === right.afterBlobOid) {
    return { classification: 'cross-intent-convergent', earlier: null, later: null };
  }
  const ordered = orderedPair(left, right);
  if (!ordered) return { classification: 'evidence-incomplete', earlier: null, later: null };
  const [earlier, later] = ordered;
  if (!earlier.afterBlobOid || !later.beforeBlobOid || !later.afterBlobOid || !later.finalBlobOid) {
    return { classification: 'evidence-incomplete', earlier, later };
  }
  if (later.beforeBlobOid === earlier.afterBlobOid) {
    return { classification: 'cross-intent-carried-forward', earlier, later };
  }
  if (later.beforeBlobOid !== earlier.afterBlobOid && later.finalBlobOid !== earlier.afterBlobOid) {
    return { classification: 'cross-intent-suspected-lost-update', earlier, later };
  }
  return { classification: 'evidence-incomplete', earlier, later };
}

/** Classify exactly once per path + unordered intent pair. */
export function classifyPathConcurrency(
  observations: readonly PathIntentObservation[],
): ConcurrencyCase[] {
  const byIntent = new Map<string, PathIntentObservation[]>();
  for (const item of observations) {
    const key = item.intentId ?? `legacy:${item.turnId}`;
    const list = byIntent.get(key) ?? [];
    list.push(item);
    byIntent.set(key, list);
  }
  const groups = [...byIntent.entries()].sort(([a], [b]) => a.localeCompare(b));
  const pairs: Array<[PathIntentObservation, PathIntentObservation]> = [];
  if (groups.length === 1 && observations.length >= 2) {
    pairs.push([observations[0], observations[observations.length - 1]]);
  } else {
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        // The final turn per intent is the relevant after-image for this path.
        pairs.push([groups[i][1][groups[i][1].length - 1], groups[j][1][groups[j][1].length - 1]]);
      }
    }
  }

  const cases = pairs.map(([left, right]) => {
    const result = classifyPair(left, right);
    const ordered = result.earlier && result.later ? [result.earlier, result.later] : [left, right];
    const digest = concurrencyEvidenceDigest(ordered);
    const carried = result.classification === 'cross-intent-carried-forward';
    return {
      repositoryKey: left.repositoryKey,
      path: left.path,
      classification: result.classification,
      blocking: result.classification === 'cross-intent-suspected-lost-update',
      earlierIntentId: result.earlier?.intentId ?? left.intentId,
      laterIntentId: result.later?.intentId ?? right.intentId,
      evidenceDigest: digest,
      observations: ordered,
      note: carried ? 'The later task builds on the earlier task in this file.' : null,
    };
  });
  if (cases.length > 0) recordIntentArchitectureEvent('classified', cases.length);
  return cases;
}

export interface ConcurrencyActionProjection {
  blockingAtoms: ReviewChallengeAtom[];
  nonBlockingNotes: string[];
}

/** Project policy actions. Only suspected lost update creates a blocking atom. */
export function projectConcurrencyActions(cases: readonly ConcurrencyCase[]): ConcurrencyActionProjection {
  const blockingAtoms: CrossIntentChallengeAtom[] = [];
  const nonBlockingNotes: string[] = [];
  for (const item of cases) {
    if (item.note) nonBlockingNotes.push(item.note);
    if (!item.blocking || !item.earlierIntentId || !item.laterIntentId) continue;
    const pair = [item.earlierIntentId, item.laterIntentId].sort();
    const atomId = `cross-intent:${createHash('sha256')
      .update(`${item.repositoryKey}\0${item.path.pathBytesBase64}\0${pair.join('\0')}`)
      .digest('hex')}`;
    blockingAtoms.push({
      kind: 'cross-intent',
      atomId,
      digest: item.evidenceDigest,
      reasonVersion: CONCURRENCY_CLASSIFIER_VERSION,
      pathBytesBase64: item.path.pathBytesBase64,
      displayPath: item.path.displayPath,
      earlierIntentId: item.earlierIntentId,
      laterIntentId: item.laterIntentId,
      evidenceDigest: item.evidenceDigest,
      resolution: null,
    });
  }
  return { blockingAtoms, nonBlockingNotes: [...new Set(nonBlockingNotes)] };
}
