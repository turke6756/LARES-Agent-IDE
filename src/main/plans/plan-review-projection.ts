// WP-P7A-proj — primary, conservative plan-review projection.
// Composes the pinned baseline, P6 evidence, and the unchanged SC object. It
// never assembles candidates, splits components, or infers completion.

import type { PlanExecutionRun } from '../database';
import type { RunGitLike } from '../git-checkpoints/checkpoint-service';
import { runGit as realRunGit } from '../git-checkpoints/git-command';
import type { CommitCandidate, SelectionPreview } from '../../shared/commit-candidates';
import type {
  PlanReviewBaselineDiff,
  PlanReviewCaptureGapAnnotation,
  PlanReviewMixedAuthorshipAnnotation,
  PlanReviewProjection,
  SaveCardBundle,
} from '../../shared/types';
import type { MissionBoardPlanEvidence } from './mission-board-evidence';

const DIFF_MAX_BYTES = 64 << 20;
const DIFF_TIMEOUT_MS = 30_000;

export interface PlanReviewProjectionInput {
  workspaceId: string;
  planId: string;
  repoRoot: string;
  workspacePrefix: string;
  executionRun: PlanExecutionRun;
  evidence: MissionBoardPlanEvidence;
  /** Exact SC-WP-3G result: embedded without cloning or re-shaping. */
  scObject: CommitCandidate | SelectionPreview;
  /** Raw SC bundles are annotation + D-1 audit inputs, never reassembled here. */
  scBundles: readonly SaveCardBundle[];
}

export interface PlanReviewProjectionDeps {
  runGit?: RunGitLike;
  gitExe?: string;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function witnessedPaths(evidence: MissionBoardPlanEvidence): string[] {
  const paths: string[] = [];
  for (const pkg of evidence.packages) {
    for (const turn of [...pkg.liveActivity, ...pkg.durableTurns]) {
      for (const touch of turn.touched) paths.push(touch.path);
    }
  }
  for (const turn of [...evidence.unassignedLiveActivity, ...evidence.unassignedDurableTurns]) {
    for (const touch of turn.touched) paths.push(touch.path);
  }
  return uniqueSorted(paths);
}

function repositoryPath(workspacePrefix: string, path: string): string {
  const relative = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const prefix = workspacePrefix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  const segments = relative.split('/');
  if (!relative || relative.startsWith('/') || /^[A-Za-z]:\//.test(relative)
      || segments.some((segment) => segment === '..' || segment === '')) {
    throw new Error(`unsafe witnessed path '${path}'`);
  }
  return prefix ? `${prefix}/${relative}` : relative;
}

function untrackedRepositoryPaths(
  bundles: readonly SaveCardBundle[],
  included: ReadonlySet<string>,
): string[] {
  return uniqueSorted(bundles.flatMap((bundle) => bundle.members.flatMap(({ entry }) => {
    if (entry.entryKind !== 'untracked') return [];
    const path = entry.path.displayPath.replace(/\\/g, '/');
    return included.has(path) ? [path] : [];
  })));
}

/** Pinned-baseline → current-worktree patch, restricted to plan-witnessed paths.
 * Normal diff omits untracked files, so witnessed SC-untracked members are added
 * with read-only `diff --no-index`. No identity is derived from this patch. */
export async function readPlanReviewBaselineDiff(
  input: Pick<PlanReviewProjectionInput,
    'repoRoot' | 'workspacePrefix' | 'executionRun' | 'evidence' | 'scBundles'>,
  deps: PlanReviewProjectionDeps = {},
): Promise<PlanReviewBaselineDiff> {
  const runGit = deps.runGit ?? realRunGit;
  const paths = witnessedPaths(input.evidence);
  const repositoryPaths = uniqueSorted(paths.map((path) => repositoryPath(input.workspacePrefix, path)));
  const baseline = input.executionRun.baselineKind === 'head'
    ? (() => {
        if (!input.executionRun.baselineRef || !input.executionRun.baselineHeadOid) {
          throw new Error(`head baseline run ${input.executionRun.id} is missing its durable ref/OID`);
        }
        return {
          kind: 'head' as const,
          ref: input.executionRun.baselineRef,
          headOid: input.executionRun.baselineHeadOid,
        };
      })()
    : { kind: 'unborn' as const };

  if (repositoryPaths.length === 0) {
    return { executionRunId: input.executionRun.id, baseline, witnessedPaths: paths, repositoryPaths, patch: '' };
  }

  let baselineTreeish: string;
  if (baseline.kind === 'head') {
    baselineTreeish = baseline.ref;
  } else {
    const emptyTree = await runGit(input.repoRoot, ['hash-object', '-t', 'tree', '--stdin'], {
      gitExe: deps.gitExe, stdin: '', maxBytes: 4096, timeoutMs: DIFF_TIMEOUT_MS,
    });
    baselineTreeish = emptyTree.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(baselineTreeish)) {
      throw new Error('could not derive the empty-tree OID for an unborn baseline');
    }
  }

  const tracked = await runGit(input.repoRoot, [
    '--no-pager', 'diff', '--no-ext-diff', '--no-textconv', '--binary', baselineTreeish,
    '--', ...repositoryPaths.map((path) => `:(top,literal)${path}`),
  ], { gitExe: deps.gitExe, maxBytes: DIFF_MAX_BYTES, timeoutMs: DIFF_TIMEOUT_MS });

  const patchParts = tracked.stdout ? [tracked.stdout] : [];
  for (const path of untrackedRepositoryPaths(input.scBundles, new Set(repositoryPaths))) {
    const diff = await runGit(input.repoRoot, [
      '--no-pager', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--binary',
      '--', '/dev/null', path,
    ], {
      gitExe: deps.gitExe, allowNonzero: true, maxBytes: DIFF_MAX_BYTES, timeoutMs: DIFF_TIMEOUT_MS,
    });
    if (diff.code > 1) throw new Error(`git diff --no-index failed for '${path}': ${diff.stderr}`);
    if (diff.stdout) patchParts.push(diff.stdout);
  }

  return {
    executionRunId: input.executionRun.id,
    baseline,
    witnessedPaths: paths,
    repositoryPaths,
    patch: patchParts.join(patchParts.length > 1 ? '\n' : ''),
  };
}

function selectedComponentBundles(
  scObject: CommitCandidate | SelectionPreview,
  bundles: readonly SaveCardBundle[],
): SaveCardBundle[] {
  const byId = new Map(bundles.flatMap((bundle) =>
    bundle.component ? [[bundle.component.componentId, bundle] as const] : []));
  const selected = scObject.componentIds.map((componentId) => {
    const bundle = byId.get(componentId);
    if (!bundle) throw new Error(`SC component '${componentId}' is unavailable for plan review`);
    return bundle;
  });
  const memberIds = new Set(scObject.members.map((member) => member.entryId));
  for (const bundle of selected) {
    const missing = bundle.component!.dirtyEntryIds.filter((entryId) => !memberIds.has(entryId));
    if (missing.length > 0) {
      throw new Error(`plan review cannot split SC component '${bundle.component!.componentId}' (missing ${missing.join(', ')})`);
    }
  }
  return selected;
}

function mixedAuthorshipAnnotations(
  planId: string,
  bundles: readonly SaveCardBundle[],
): PlanReviewMixedAuthorshipAnnotation[] {
  return bundles.flatMap((bundle) => {
    const component = bundle.component!;
    const planIds = [...new Set(component.associations.map((a) => a.planId))];
    const otherPlanIds = planIds.filter((id) => id !== planId);
    const reasons: PlanReviewMixedAuthorshipAnnotation['reasons'] = [];
    if (planIds.filter((id) => id !== null).length > 1) reasons.push('multiple-plans');
    if (planIds.includes(null)) reasons.push('unattributed-contributor');
    if (component.overlap.contributingAgentCount > 1) reasons.push('multiple-agents');
    if (reasons.length === 0) return [];
    return [{
      componentId: component.componentId,
      planIds,
      otherPlanIds,
      contributingTurnIds: uniqueSorted(component.associations.flatMap((a) => a.contributingTurnIds)),
      reasons,
      currentBytesMayContainMixedAuthorship: true,
    }];
  });
}

function captureGapAnnotations(
  evidence: MissionBoardPlanEvidence,
  bundles: readonly SaveCardBundle[],
): PlanReviewCaptureGapAnnotation[] {
  const componentGaps = bundles.flatMap((bundle): PlanReviewCaptureGapAnnotation[] => {
    const health = bundle.captureHealth;
    const incompleteTurnIds = health.turns.filter((turn) =>
      turn.beforeEdge !== 'verified-live' || turn.afterEdge !== 'verified-live'
      || turn.failureClass !== 'none').map((turn) => turn.turnId);
    const reasons: PlanReviewCaptureGapAnnotation['reasons'] = [];
    if (health.captureOutage) reasons.push('capture-outage');
    if (incompleteTurnIds.length > 0 || health.pathsWithoutFinalizationEdge.length > 0) {
      reasons.push('incomplete-edge');
    }
    if (reasons.length === 0) return [];
    return [{
      source: 'component-capture', componentId: bundle.component!.componentId,
      turnIds: uniqueSorted(incompleteTurnIds),
      pathsWithoutFinalizationEdge: uniqueSorted(health.pathsWithoutFinalizationEdge), reasons,
    }];
  });
  const stampGaps = evidence.stampAnnotations.map((annotation): PlanReviewCaptureGapAnnotation => ({
    source: 'plan-stamp', componentId: null, turnIds: [annotation.turnId],
    pathsWithoutFinalizationEdge: [],
    reasons: [annotation.planStampStatus === 'unstamped' ? 'unstamped-turn' : 'unverified-turn'],
  }));
  return [...componentGaps, ...stampGaps];
}

/** Build the review DTO while preserving the SC object verbatim. */
export async function projectPlanReview(
  input: PlanReviewProjectionInput,
  deps: PlanReviewProjectionDeps = {},
): Promise<PlanReviewProjection> {
  if (input.executionRun.planId !== input.planId) {
    throw new Error(`execution run ${input.executionRun.id} does not belong to plan ${input.planId}`);
  }
  if (input.evidence.workspaceId !== input.workspaceId || input.evidence.planId !== input.planId) {
    throw new Error('mission-board evidence does not match the requested workspace/plan');
  }
  const selectedBundles = selectedComponentBundles(input.scObject, input.scBundles);
  return {
    workspaceId: input.workspaceId,
    planId: input.planId,
    baselineDiff: await readPlanReviewBaselineDiff(input, deps),
    scObject: input.scObject,
    annotations: {
      mixedAuthorship: mixedAuthorshipAnnotations(input.planId, selectedBundles),
      captureGaps: captureGapAnnotations(input.evidence, selectedBundles),
    },
    evidenceSemantics: 'activity-only-never-completion',
  };
}
