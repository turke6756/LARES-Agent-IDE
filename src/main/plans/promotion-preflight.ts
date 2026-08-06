import path from 'node:path';
import type {
  PlanningReaderListResult,
  PlanningReaderReadResult,
  PromotionPreflightRequest,
  PromotionPreflightResult,
  Workspace,
} from '../../shared/types';
import { derivePlanIdentityFromMarkdown } from '../../shared/plan-identity';
import {
  getPlanByWorkspaceArtifactId,
  getPromotionRequestByProposal,
  getWorkspace,
  type PromotionRequestRow,
  type StructuredPlanRow,
} from '../database';
import { workspaceStateDir, workspaceStateDirName } from '../workspace-state-dir';
import { reconcilePlanFolderProjections } from './plan-folder-reconciler';
import { listPlanningEntries, readPlanningDocument } from './planning-reader';
import { makePromotionClaimScan } from './promotion-claim-scan';

/** Result of scanning valid plan folders for a disk-truth source-proposal claim. */
export type ClaimScanResult =
  | { kind: 'none' }
  | { kind: 'claimed'; planArtifactId: string; folderRelPath: string }
  | { kind: 'duplicate'; folderRelPaths: string[]; diagnostic: string }
  | { kind: 'foreign'; folderRelPath: string; diagnostic: string };

export type ClaimScanFn = (input: {
  workspaceId: string;
  proposalArtifactId: string;
  deterministicPlanArtifactId: string;
  deterministicFolderRelPath: string;
}) => ClaimScanResult | Promise<ClaimScanResult>;

type PlanningRead = PlanningReaderReadResult | { error: string };

export interface PromotionPreflightDeps {
  getWorkspace: (workspaceId: string) => Workspace | null;
  listPlanningEntries: (workspaceRoot: string, pathType: Workspace['pathType']) => PlanningReaderListResult;
  readPlanningDocument: (docId: string, pathType: Workspace['pathType']) => PlanningRead;
  scanClaims?: ClaimScanFn;
  getLegacyRequest: (workspaceId: string, proposalArtifactId: string) => PromotionRequestRow | null;
  getPlanByArtifactId: (workspaceId: string, planArtifactId: string) => StructuredPlanRow | null;
  reconcileFolder: (workspace: Workspace, folderRelPath: string) => Promise<unknown>;
}

export class PromotionPreflightError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PromotionPreflightError';
  }
}

function requireRequest(raw: unknown): PromotionPreflightRequest {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (typeof input?.workspaceId !== 'string' || input.workspaceId === '') {
    throw new PromotionPreflightError('a non-empty workspaceId is required', 'preflight-bad-request');
  }
  if (typeof input.proposalDocumentId !== 'string' || input.proposalDocumentId === '') {
    throw new PromotionPreflightError('a non-empty proposalDocumentId is required', 'preflight-bad-request');
  }
  if (input.artifactIdCrossCheck !== undefined && typeof input.artifactIdCrossCheck !== 'string') {
    throw new PromotionPreflightError('artifactIdCrossCheck must be a string', 'preflight-bad-request');
  }
  return {
    workspaceId: input.workspaceId,
    proposalDocumentId: input.proposalDocumentId,
    ...(input.artifactIdCrossCheck === undefined
      ? {}
      : { artifactIdCrossCheck: input.artifactIdCrossCheck.trim() }),
  };
}

function defaultDeps(): PromotionPreflightDeps {
  return {
    getWorkspace,
    listPlanningEntries: (root, pathType) => listPlanningEntries(root, { pathType }),
    readPlanningDocument: (docId, pathType) => readPlanningDocument(docId, { pathType }),
    getLegacyRequest: getPromotionRequestByProposal,
    getPlanByArtifactId: getPlanByWorkspaceArtifactId,
    reconcileFolder: (workspace, folderRelPath) => reconcilePlanFolderProjections({
      workspace,
      planFolderRelPath: folderRelPath,
      changeKind: 'manual',
    }),
  };
}

function normalizeRelPath(value: string | null): string | null {
  return value?.replace(/\\/g, '/').replace(/\/+$/, '') ?? null;
}

/**
 * Resolve an opaque planning-reader handle and classify promotion without trusting
 * renderer path, filename, title, or cached metadata. The exact server-read bytes
 * supply both the returned proposal path and canonical identity.
 */
export async function runPromotionPreflight(
  raw: unknown,
  overrides: Partial<PromotionPreflightDeps> = {},
): Promise<PromotionPreflightResult> {
  const request = requireRequest(raw);
  const deps = { ...defaultDeps(), ...overrides };
  const workspace = deps.getWorkspace(request.workspaceId);
  if (!workspace) {
    throw new PromotionPreflightError('workspace not found', 'preflight-workspace-not-found');
  }

  // Re-enumeration binds the opaque handle to this exact workspace and refreshes
  // the reader registry. A foreign-category, cross-workspace, renamed, or removed
  // handle therefore cannot resolve as the requested proposal.
  const listing = deps.listPlanningEntries(workspace.path, workspace.pathType);
  const proposalDocument = listing.entries
    .filter((entry) => entry.kind === 'proposal')
    .flatMap((entry) => entry.documents)
    .find((document) => document.docId === request.proposalDocumentId && document.category === 'proposal');
  if (!proposalDocument) {
    throw new PromotionPreflightError(
      'proposal document handle is stale, foreign, or not a proposal',
      'preflight-proposal-handle-rejected',
    );
  }
  if (!/^[^\\/]+\.md$/i.test(proposalDocument.name)) {
    throw new PromotionPreflightError('proposal path is unsafe', 'preflight-proposal-path-rejected');
  }

  const read = deps.readPlanningDocument(request.proposalDocumentId, workspace.pathType);
  if ('error' in read) {
    throw new PromotionPreflightError(read.error, 'preflight-proposal-read-rejected');
  }
  if (read.truncated || read.sizeBytes !== proposalDocument.sizeBytes) {
    throw new PromotionPreflightError('proposal is oversized or changed during preflight', 'preflight-proposal-stale');
  }

  let identity;
  try {
    identity = derivePlanIdentityFromMarkdown(read.content);
  } catch (error) {
    throw new PromotionPreflightError(
      error instanceof Error ? error.message : 'proposal identity is invalid',
      'preflight-proposal-identity-rejected',
    );
  }
  if (!/^prop_[0-9a-f]{8}$/.test(identity.proposalArtifactId)) {
    throw new PromotionPreflightError(
      'proposal frontmatter must contain a portable artifact_id (prop_########)',
      'preflight-proposal-identity-rejected',
    );
  }
  if (
    request.artifactIdCrossCheck !== undefined
    && request.artifactIdCrossCheck !== identity.proposalArtifactId
  ) {
    throw new PromotionPreflightError(
      'proposal artifact_id changed; refresh the selected proposal and try again',
      'preflight-artifact-cross-check-rejected',
    );
  }

  const stateName = workspaceStateDirName(workspace.path, workspace.pathType);
  const proposalRelPath = `${stateName}/proposals/${proposalDocument.name}`;
  const deterministicFolderRelPath = `${stateName}/plans/${identity.planSku}`;
  const scanClaims = deps.scanClaims ?? makePromotionClaimScan({
    resolvePlansHomeRoot: () => path.join(workspaceStateDir(workspace.path, workspace.pathType), 'plans'),
  });
  const claim = await scanClaims({
    workspaceId: workspace.id,
    proposalArtifactId: identity.proposalArtifactId,
    deterministicPlanArtifactId: identity.planArtifactId,
    deterministicFolderRelPath,
  });

  if (claim.kind === 'duplicate') {
    return { status: 'duplicate-blocked', folderRelPaths: claim.folderRelPaths, detail: claim.diagnostic };
  }
  if (claim.kind === 'foreign') {
    return { status: 'foreign-blocked', folderRelPath: claim.folderRelPath, detail: claim.diagnostic };
  }

  const legacy = deps.getLegacyRequest(workspace.id, identity.proposalArtifactId);
  if (legacy?.state === 'pending') {
    return {
      status: 'legacy-draining',
      requestId: legacy.id,
      detail: legacy.failureReason ?? 'A legacy promotion request is still draining.',
    };
  }

  if (claim.kind === 'claimed') {
    try {
      // WP-E contract: row adoption alone is insufficient. This await proves the
      // source and responsibility projections have converged before navigation.
      await deps.reconcileFolder(workspace, claim.folderRelPath);
    } catch {
      return {
        status: 'folder-awaiting-adoption',
        proposalRelPath,
        planArtifactId: claim.planArtifactId,
        folderRelPath: claim.folderRelPath,
      };
    }
    const adopted = deps.getPlanByArtifactId(workspace.id, claim.planArtifactId);
    if (
      adopted
      && adopted.deletedAt === null
      && normalizeRelPath(adopted.folderRelPath) === normalizeRelPath(claim.folderRelPath)
    ) {
      return {
        status: 'already-adopted',
        proposalRelPath,
        planId: adopted.id,
        planArtifactId: claim.planArtifactId,
        folderRelPath: claim.folderRelPath,
      };
    }
    return {
      status: 'folder-awaiting-adoption',
      proposalRelPath,
      planArtifactId: claim.planArtifactId,
      folderRelPath: claim.folderRelPath,
    };
  }

  return {
    status: 'allowed',
    proposalRelPath,
    planArtifactId: identity.planArtifactId,
    targetFolderRelPath: deterministicFolderRelPath,
  };
}
