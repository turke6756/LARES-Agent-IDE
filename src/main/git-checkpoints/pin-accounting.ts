// SC-WP-2K — logical byte accounting for dirty checkpoint retention pins.
//
// This is deliberately not an ODB disk-usage calculation. An object reachable
// from HEAD (or an active finalization boundary ref) costs no pin budget; every
// other dirty blob is charged by its uncompressed Git object size. All object
// metadata is read in one `cat-file --batch-check` process and reachability in
// one `rev-list` process. Shared OIDs are charged once across the selected set.

import {
  RETENTION_PIN_MAX_EXTENSION_MS,
  RETENTION_PIN_QUOTA_BYTES,
} from '../../shared/constants';
import type { RunGitLike } from './checkpoint-service';
import {
  selectRetentionPins,
  type EdgePinCandidate,
  type RetentionPinSelection,
} from './protection-policy';

const OID_RE = /^[0-9a-f]{40,64}$/;
const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 256 << 20;

export interface PinDirtyEntry {
  entryId: string;
  rawWorktreeBlobOid: string | null;
}

export interface PinAccountingCandidate {
  turnId: string;
  edge: 'before' | 'after';
  dirtyEntries: readonly PinDirtyEntry[];
  normalPruneEligibleAt: number;
}

export interface AccountAndSelectPinsOptions {
  repoRoot: string;
  candidates: readonly PinAccountingCandidate[];
  /** HEAD plus active finalization boundary refs. Invalid roots over-account. */
  reachableRoots: readonly string[];
  now: number;
  runGit: RunGitLike;
  gitExe?: string;
  quotaBytes?: number;
}

export interface AccountedPinSelection extends RetentionPinSelection {
  /** Unique, unreachable blob sizes learned by the one batch-check. */
  objectSizes: ReadonlyMap<string, number>;
}

/**
 * Account and quota-select dirty edge pins. Unknown/missing/non-blob OIDs are
 * charged at `quota + 1`, so uncertainty can never make an edge look cheaper.
 *
 * Costs are assigned in the exact deterministic order consumed by WP-2H. An OID
 * becomes shared/free only after an earlier edge actually fits. Thus a rejected
 * large edge cannot make a later edge under-account the same object.
 */
export async function accountAndSelectPins(
  options: AccountAndSelectPinsOptions,
): Promise<AccountedPinSelection> {
  const quotaBytes = options.quotaBytes ?? RETENTION_PIN_QUOTA_BYTES;
  const uniqueOids = sortedUnique(
    options.candidates.flatMap((candidate) =>
      candidate.dirtyEntries.flatMap((entry) =>
        entry.rawWorktreeBlobOid && OID_RE.test(entry.rawWorktreeBlobOid)
          ? [entry.rawWorktreeBlobOid]
          : [],
      ),
    ),
  );

  const [reachable, objectSizes] = await Promise.all([
    readReachableOids(options, uniqueOids),
    readBlobSizes(options, uniqueOids),
  ]);
  const ordered = [...options.candidates].sort(compareCandidates);
  const chargedOids = new Set<string>();
  let projectedUsedBytes = 0;
  const accounted: EdgePinCandidate[] = [];

  for (const candidate of ordered) {
    const dirtyEntryIds = sortedUnique(candidate.dirtyEntries.map((entry) => entry.entryId));
    const candidateOids = sortedUnique(
      candidate.dirtyEntries.flatMap((entry) =>
        entry.rawWorktreeBlobOid && OID_RE.test(entry.rawWorktreeBlobOid)
          ? [entry.rawWorktreeBlobOid]
          : [],
      ),
    ).filter((oid) => !reachable.has(oid) && !chargedOids.has(oid));

    let estimatedBytes = 0;
    for (const entry of candidate.dirtyEntries) {
      const oid = entry.rawWorktreeBlobOid;
      if (oid === null || !OID_RE.test(oid)) {
        estimatedBytes = saturatingAdd(estimatedBytes, quotaBytes + 1);
      }
    }
    for (const oid of candidateOids) {
      estimatedBytes = saturatingAdd(estimatedBytes, objectSizes.get(oid) ?? quotaBytes + 1);
    }

    const edge: EdgePinCandidate = {
      turnId: candidate.turnId,
      edge: candidate.edge,
      dirtyEntryIds,
      normalPruneEligibleAt: candidate.normalPruneEligibleAt,
      estimatedBytes,
    };
    accounted.push(edge);

    const extensionLive = options.now <= candidate.normalPruneEligibleAt + RETENTION_PIN_MAX_EXTENSION_MS;
    if (extensionLive && projectedUsedBytes + estimatedBytes <= quotaBytes) {
      projectedUsedBytes += estimatedBytes;
      for (const oid of candidateOids) chargedOids.add(oid);
    }
  }

  // Production uses the normative constant. The injectable quota exists only to
  // make accounting unit tests small; reject a divergent production-style call.
  if (quotaBytes !== RETENTION_PIN_QUOTA_BYTES) {
    return selectWithQuotaForTest(accounted, options.now, quotaBytes, objectSizes);
  }
  return { ...selectRetentionPins(accounted, options.now), objectSizes };
}

async function readReachableOids(
  options: AccountAndSelectPinsOptions,
  candidateOids: readonly string[],
): Promise<Set<string>> {
  if (candidateOids.length === 0 || options.reachableRoots.length === 0) return new Set();
  try {
    const result = await options.runGit(
      options.repoRoot,
      ['rev-list', '--objects', '--no-object-names', ...sortedUnique(options.reachableRoots)],
      {
        gitExe: options.gitExe,
        allowNonzero: true,
        timeoutMs: GIT_TIMEOUT_MS,
        maxBytes: MAX_OUTPUT_BYTES,
      },
    );
    if (result.code !== 0) return new Set();
    const wanted = new Set(candidateOids);
    return new Set(result.stdout.split(/\r?\n/).filter((oid) => wanted.has(oid)));
  } catch {
    return new Set();
  }
}

async function readBlobSizes(
  options: AccountAndSelectPinsOptions,
  oids: readonly string[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (oids.length === 0) return sizes;
  const result = await options.runGit(
    options.repoRoot,
    ['cat-file', '--batch-check'],
    {
      gitExe: options.gitExe,
      allowNonzero: true,
      timeoutMs: GIT_TIMEOUT_MS,
      maxBytes: MAX_OUTPUT_BYTES,
      stdin: `${oids.join('\n')}\n`,
    },
  );
  if (result.code !== 0) return sizes;
  const lines = result.stdout.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== oids.length) return sizes;
  lines.forEach((line, index) => {
    const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/.exec(line);
    const size = match ? Number(match[2]) : Number.NaN;
    if (match?.[1] === oids[index] && Number.isSafeInteger(size) && size >= 0) {
      sizes.set(oids[index], size);
    }
  });
  return sizes;
}

function compareCandidates(left: PinAccountingCandidate, right: PinAccountingCandidate): number {
  if (left.normalPruneEligibleAt !== right.normalPruneEligibleAt) {
    return left.normalPruneEligibleAt - right.normalPruneEligibleAt;
  }
  if (left.turnId !== right.turnId) return left.turnId < right.turnId ? -1 : 1;
  if (left.edge === right.edge) return 0;
  return left.edge === 'after' ? -1 : 1;
}

function saturatingAdd(left: number, right: number): number {
  const total = left + right;
  return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function selectWithQuotaForTest(
  candidates: EdgePinCandidate[],
  now: number,
  quotaBytes: number,
  objectSizes: ReadonlyMap<string, number>,
): AccountedPinSelection {
  const retainedEdges: EdgePinCandidate[] = [];
  const releasedEdges: EdgePinCandidate[] = [];
  let usedBytes = 0;
  for (const candidate of candidates) {
    const live = now <= candidate.normalPruneEligibleAt + RETENTION_PIN_MAX_EXTENSION_MS;
    if (live && usedBytes + candidate.estimatedBytes <= quotaBytes) {
      retainedEdges.push(candidate);
      usedBytes += candidate.estimatedBytes;
    } else releasedEdges.push(candidate);
  }
  const weakening = releasedEdges.filter((edge) => edge.dirtyEntryIds.length > 0);
  return {
    retainedEdges,
    releasedEdges,
    warning: weakening.length === 0 ? null : {
      quotaBytes,
      usedBytes,
      releasedEdges: weakening.map(({ turnId, edge }) => ({ turnId, edge })),
      willWeakenPaths: sortedUnique(weakening.flatMap((edge) => edge.dirtyEntryIds)),
    },
    objectSizes,
  };
}
