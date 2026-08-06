import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../../shared/types';
import { derivePlanIdentityFromMarkdown } from '../../shared/plan-identity';
import {
  applyPlanSourceProposalProjection,
  getProposalByWorkspaceArtifactId,
  getProposalByWorkspacePath,
  recordPlanSourceProposalProjectionStatus,
  type PlanSourceProposalProjectionState,
} from '../database';
import { workspaceStateDir, workspaceStateDirName } from '../workspace-state-dir';
import { parseStrictJson } from './strict-json';

const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_PROPOSAL_BYTES = 2_000_000;

export interface SourceProposalProjectionDiagnostic {
  code: string;
  detail: string;
}

export interface SourceProposalProjectionResult extends PlanSourceProposalProjectionState {
  diagnostics: SourceProposalProjectionDiagnostic[];
}

export interface ReconcilePlanSourceProposalInput {
  workspace: Workspace;
  planId: string;
  folderAbs: string;
  expectedPlanArtifactId: string;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asResult(state: PlanSourceProposalProjectionState): SourceProposalProjectionResult {
  let diagnostics: SourceProposalProjectionDiagnostic[] = [];
  try {
    const parsed = JSON.parse(state.diagnosticsJson);
    if (Array.isArray(parsed)) diagnostics = parsed;
  } catch { /* database CHECK/default keeps production rows valid; tolerate legacy dirt */ }
  return { ...state, diagnostics };
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

function fail(input: ReconcilePlanSourceProposalInput, observedManifestMtime: number | null,
  status: 'absent' | 'invalid' | 'conflict', code: string, detail: string,
  sourceArtifactId: string | null = null, sourceRelPath: string | null = null,
): SourceProposalProjectionResult {
  return asResult(recordPlanSourceProposalProjectionStatus({
    planId: input.planId,
    workspaceId: input.workspace.id,
    status,
    sourceArtifactId,
    sourceRelPath,
    diagnosticCode: code,
    diagnosticsJson: JSON.stringify([{ code, detail }]),
    observedManifestMtime,
    reconciledAt: (input.now ?? (() => Date.now()))(),
  }));
}

/** Reconcile only the source-proposal projection. All filesystem validation is
 * completed before the independently-atomic SQLite apply begins. */
export function reconcilePlanSourceProposal(
  input: ReconcilePlanSourceProposalInput,
): SourceProposalProjectionResult {
  const manifestAbs = path.join(input.folderAbs, 'plan.json');
  let manifestStat: fs.Stats;
  let manifest: Record<string, unknown>;
  try {
    manifestStat = fs.lstatSync(manifestAbs);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) {
      return fail(input, null, 'invalid', 'manifest-unsafe', 'plan.json must be a bounded regular file');
    }
    const parsed = parseStrictJson(fs.readFileSync(manifestAbs, 'utf8'));
    if (!isRecord(parsed)) throw new Error('plan.json must contain an object');
    manifest = parsed;
  } catch (err) {
    return fail(input, null, 'invalid', 'manifest-invalid', err instanceof Error ? err.message : String(err));
  }
  const observedManifestMtime = Math.trunc(manifestStat.mtimeMs);
  if (manifest.plan_artifact_id !== input.expectedPlanArtifactId) {
    return fail(input, observedManifestMtime, 'conflict', 'plan-identity-mismatch',
      'plan.json identity does not match the adopted plan row');
  }
  if (!Number.isSafeInteger(manifest.created_at) || (manifest.created_at as number) <= 0) {
    return fail(input, observedManifestMtime, 'invalid', 'created-at-invalid',
      'plan.json.created_at must be a positive stable epoch-millisecond integer');
  }
  if (!isRecord(manifest.source_proposal)) {
    return fail(input, observedManifestMtime, 'absent', 'source-proposal-absent',
      'plan.json has no source_proposal object');
  }
  const sourceArtifactId = manifest.source_proposal.artifact_id;
  const sourceRelPath = manifest.source_proposal.rel_path;
  if (typeof sourceArtifactId !== 'string' || sourceArtifactId.trim() === ''
      || typeof sourceRelPath !== 'string' || sourceRelPath.trim() === '') {
    return fail(input, observedManifestMtime, 'invalid', 'source-proposal-invalid',
      'source_proposal must contain non-empty artifact_id and rel_path');
  }

  // Proposal registration is intentionally flat. Accept exactly the active
  // state root's proposals/<file>.md shape and reject aliases/traversal.
  const stateName = workspaceStateDirName(input.workspace.path, input.workspace.pathType);
  const parts = sourceRelPath.split('/');
  const canonicalShape = !sourceRelPath.includes('\\') && parts.length === 3
    && parts[0] === stateName && parts[1] === 'proposals'
    && parts[2] !== '' && parts[2] !== '.' && parts[2] !== '..'
    && parts[2].toLowerCase().endsWith('.md')
    && path.posix.normalize(sourceRelPath) === sourceRelPath;
  if (!canonicalShape) {
    return fail(input, observedManifestMtime, 'invalid', 'source-path-unsafe',
      'source proposal path must be the canonical active-state-root proposals/<file>.md path',
      sourceArtifactId, sourceRelPath);
  }
  const proposalsRoot = path.join(workspaceStateDir(input.workspace.path, input.workspace.pathType), 'proposals');
  const proposalAbs = path.join(proposalsRoot, parts[2]);
  let proposalBody: string;
  try {
    const rootReal = fs.realpathSync.native(proposalsRoot);
    const proposalStat = fs.lstatSync(proposalAbs);
    if (!proposalStat.isFile() || proposalStat.isSymbolicLink() || proposalStat.size > MAX_PROPOSAL_BYTES) {
      throw new Error('source proposal must be a bounded regular file, not a symlink');
    }
    const proposalReal = fs.realpathSync.native(proposalAbs);
    if (!samePath(path.dirname(proposalReal), rootReal)) throw new Error('source proposal escapes the canonical proposals root');
    proposalBody = fs.readFileSync(proposalAbs, 'utf8');
  } catch (err) {
    return fail(input, observedManifestMtime, 'invalid', 'source-file-unavailable',
      err instanceof Error ? err.message : String(err), sourceArtifactId, sourceRelPath);
  }
  try {
    const identity = derivePlanIdentityFromMarkdown(proposalBody);
    if (identity.proposalArtifactId !== sourceArtifactId
        || identity.planArtifactId !== input.expectedPlanArtifactId) {
      return fail(input, observedManifestMtime, 'conflict', 'source-file-identity-mismatch',
        'source proposal frontmatter does not match plan.json identity', sourceArtifactId, sourceRelPath);
    }
  } catch (err) {
    return fail(input, observedManifestMtime, 'invalid', 'source-frontmatter-invalid',
      err instanceof Error ? err.message : String(err), sourceArtifactId, sourceRelPath);
  }

  const byArtifact = getProposalByWorkspaceArtifactId(input.workspace.id, sourceArtifactId);
  const byPath = getProposalByWorkspacePath(input.workspace.id, sourceRelPath);
  if (!byArtifact && !byPath) {
    return fail(input, observedManifestMtime, 'absent', 'source-proposal-unregistered',
      'the source proposal has not yet converged into the proposal registry', sourceArtifactId, sourceRelPath);
  }
  if (!byArtifact || !byPath || byArtifact.id !== byPath.id || byArtifact.deletedAt != null) {
    return fail(input, observedManifestMtime, 'conflict', 'source-proposal-registry-mismatch',
      'no single live same-workspace proposal row matches both artifact and canonical path',
      sourceArtifactId, sourceRelPath);
  }

  try {
    return asResult(applyPlanSourceProposalProjection({
      planId: input.planId,
      planArtifactId: input.expectedPlanArtifactId,
      workspaceId: input.workspace.id,
      sourceProposalId: byArtifact.id,
      sourceArtifactId,
      sourceRelPath,
      promotedAt: manifest.created_at as number,
      observedManifestMtime,
      reconciledAt: (input.now ?? (() => Date.now()))(),
    }));
  } catch (err) {
    return fail(input, observedManifestMtime, 'conflict', 'source-apply-failed',
      err instanceof Error ? err.message : String(err), sourceArtifactId, sourceRelPath);
  }
}
