import fs from 'node:fs';
import path from 'node:path';
import type {
  DeleteProposalRequest,
  DeleteProposalResult,
  PlanningReaderListResult,
  Workspace,
} from '../../shared/types';
import {
  getProposalByWorkspacePath,
  getWorkspace,
  type ProposalRecord,
} from '../database';
import { workspaceStateDir, workspaceStateDirName } from '../workspace-state-dir';
import { listPlanningEntries } from './planning-reader';

interface PlanSourceReference {
  artifactId: string | null;
  relPath: string | null;
}

type PlanSourceScanResult =
  | { ok: true; references: PlanSourceReference[] }
  | { ok: false };

export interface ProposalDeleteDeps {
  getWorkspace: (workspaceId: string) => Workspace | null;
  listPlanningEntries: (
    workspaceRoot: string,
    pathType: Workspace['pathType'],
  ) => PlanningReaderListResult;
  getProposalByWorkspacePath: (workspaceId: string, relPath: string) => ProposalRecord | null;
  scanPlanSources: (workspace: Workspace) => PlanSourceScanResult;
  unlink: (absPath: string) => void;
}

function normalizedPath(value: string): string {
  const normalized = value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\.dashboard(?=\/proposals\/)/i, '.lares')
    .replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isContained(parent: string, child: string): boolean {
  const normalize = (value: string): string => {
    let normalized = path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '');
    if (process.platform === 'win32') normalized = normalized.toLowerCase();
    return normalized;
  };
  const boundary = normalize(parent);
  const candidate = normalize(child);
  return candidate === boundary || candidate.startsWith(`${boundary}/`);
}

function isReparsePoint(stat: fs.Stats): boolean {
  return stat.isSymbolicLink();
}

function scanPlanSources(workspace: Workspace): PlanSourceScanResult {
  const plansHome = path.join(workspaceStateDir(workspace.path, workspace.pathType), 'plans');
  let entries: fs.Dirent[];
  try {
    const homeStat = fs.lstatSync(plansHome);
    if (isReparsePoint(homeStat) || !homeStat.isDirectory()) return { ok: false };
    entries = fs.readdirSync(plansHome, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, references: [] };
    return { ok: false };
  }

  const references: PlanSourceReference[] = [];
  let realHome: string;
  try {
    realHome = fs.realpathSync.native(plansHome);
  } catch {
    return { ok: false };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      if (entry.isSymbolicLink()) return { ok: false };
      continue;
    }
    const folderAbs = path.join(plansHome, entry.name);
    const manifestAbs = path.join(folderAbs, 'plan.json');
    try {
      const folderStat = fs.lstatSync(folderAbs);
      if (isReparsePoint(folderStat) || !folderStat.isDirectory()) return { ok: false };
      const realFolder = fs.realpathSync.native(folderAbs);
      if (!isContained(realHome, realFolder)) return { ok: false };

      let manifestStat: fs.Stats;
      try {
        manifestStat = fs.lstatSync(manifestAbs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return { ok: false };
      }
      if (isReparsePoint(manifestStat) || !manifestStat.isFile() || manifestStat.size > 256_000) {
        return { ok: false };
      }
      const parsed = JSON.parse(fs.readFileSync(manifestAbs, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object') continue;
      const source = (parsed as Record<string, unknown>).source_proposal;
      if (!source || typeof source !== 'object') continue;
      const sourceRecord = source as Record<string, unknown>;
      references.push({
        artifactId: typeof sourceRecord.artifact_id === 'string' ? sourceRecord.artifact_id : null,
        relPath: typeof sourceRecord.rel_path === 'string' ? sourceRecord.rel_path : null,
      });
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, references };
}

function defaultDeps(): ProposalDeleteDeps {
  return {
    getWorkspace,
    listPlanningEntries: (root, pathType) => listPlanningEntries(root, { pathType }),
    getProposalByWorkspacePath,
    scanPlanSources,
    unlink: (absPath) => fs.unlinkSync(absPath),
  };
}

type FileIdentity = Pick<fs.Stats, 'dev' | 'ino' | 'size' | 'mtimeMs'>;

function validateDeleteTarget(
  workspace: Workspace,
  fileName: string,
): { ok: true; absPath: string; identity: FileIdentity } | { ok: false; reason: 'not-found' | 'unsafe-path' } {
  if (!/^[^\\/]+\.md$/i.test(fileName)) return { ok: false, reason: 'unsafe-path' };
  const stateDir = workspaceStateDir(workspace.path, workspace.pathType);
  const proposalsDir = path.join(stateDir, 'proposals');
  const absPath = path.resolve(proposalsDir, fileName);
  if (path.dirname(absPath) !== path.resolve(proposalsDir) || !isContained(proposalsDir, absPath)) {
    return { ok: false, reason: 'unsafe-path' };
  }

  try {
    const stateStat = fs.lstatSync(stateDir);
    const proposalsStat = fs.lstatSync(proposalsDir);
    const targetStat = fs.lstatSync(absPath);
    if (
      isReparsePoint(stateStat) || !stateStat.isDirectory()
      || isReparsePoint(proposalsStat) || !proposalsStat.isDirectory()
      || isReparsePoint(targetStat) || !targetStat.isFile()
    ) return { ok: false, reason: 'unsafe-path' };
    const realState = fs.realpathSync.native(stateDir);
    const realProposals = fs.realpathSync.native(proposalsDir);
    const realTarget = fs.realpathSync.native(absPath);
    if (!isContained(realState, realProposals) || !isContained(realProposals, realTarget)) {
      return { ok: false, reason: 'unsafe-path' };
    }
    return {
      ok: true,
      absPath,
      identity: {
        dev: targetStat.dev,
        ino: targetStat.ino,
        size: targetStat.size,
        mtimeMs: targetStat.mtimeMs,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'unsafe-path',
    };
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

/** Hard-delete one freshly rebound, unpromoted proposal file and nothing else. */
export function deleteProposal(
  request: DeleteProposalRequest,
  overrides: Partial<ProposalDeleteDeps> = {},
): DeleteProposalResult {
  const deps = { ...defaultDeps(), ...overrides };
  const workspace = deps.getWorkspace(request.workspaceId);
  if (!workspace) return { ok: false, reason: 'workspace-not-found' };

  const listing = deps.listPlanningEntries(workspace.path, workspace.pathType);
  const document = listing.entries
    .filter((entry) => entry.kind === 'proposal')
    .flatMap((entry) => entry.documents)
    .find((candidate) => candidate.docId === request.proposalDocumentId && candidate.category === 'proposal');
  if (!document) return { ok: false, reason: 'not-found' };
  if (!/^[^\\/]+\.md$/i.test(document.name)) return { ok: false, reason: 'unsafe-path' };

  const stateName = workspaceStateDirName(workspace.path, workspace.pathType);
  const proposalRelPath = `${stateName}/proposals/${document.name}`;
  const proposal = deps.getProposalByWorkspacePath(workspace.id, proposalRelPath);
  if (!proposal || proposal.deletedAt !== null) return { ok: false, reason: 'not-found' };

  const firstValidation = validateDeleteTarget(workspace, document.name);
  if (!firstValidation.ok) return firstValidation;
  if (proposal.state === 'promoted' || proposal.promotedToPlanId !== null) {
    return { ok: false, reason: 'promoted' };
  }

  const sources = deps.scanPlanSources(workspace);
  if (!sources.ok) return { ok: false, reason: 'io-error' };
  const normalizedRelPath = normalizedPath(proposalRelPath);
  if (sources.references.some((reference) =>
    (proposal.artifactId !== null && reference.artifactId === proposal.artifactId)
    || (reference.relPath !== null && normalizedPath(reference.relPath) === normalizedRelPath))) {
    return { ok: false, reason: 'plan-source-reference' };
  }

  // Destructive boundary: repeat every filesystem guard after the slower plan
  // scan, then require the same file identity observed above before unlinking.
  const finalValidation = validateDeleteTarget(workspace, document.name);
  if (!finalValidation.ok) return finalValidation;
  if (!sameIdentity(firstValidation.identity, finalValidation.identity)) {
    return { ok: false, reason: 'unsafe-path' };
  }
  const finalProposal = deps.getProposalByWorkspacePath(workspace.id, proposalRelPath);
  if (!finalProposal || finalProposal.deletedAt !== null) return { ok: false, reason: 'not-found' };
  if (finalProposal.id !== proposal.id || finalProposal.artifactId !== proposal.artifactId) {
    return { ok: false, reason: 'unsafe-path' };
  }
  if (finalProposal.state === 'promoted' || finalProposal.promotedToPlanId !== null) {
    return { ok: false, reason: 'promoted' };
  }
  try {
    deps.unlink(finalValidation.absPath);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'io-error',
    };
  }
}
