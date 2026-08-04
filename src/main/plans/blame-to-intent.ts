// WP-P7C — conservative file -> turn -> plan contribution evidence.
//
// Git blame is used only to discover commits which currently contribute bytes to
// the file. A commit-turn ledger link is still commit-level evidence: this module
// never claims that a turn authored a particular line, and never emits clobber
// labels.

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import type {
  BlameIntentConfidence,
  BlameIntentContributor,
  BlameIntentPlanRef,
  BlameToIntentRequest,
  BlameToIntentResult,
  Plan,
  Workspace,
} from '../../shared/types';
import {
  getCommitRecord,
  getDb,
  getPlan,
  getTurnRecord,
  getWorkspace,
  listCommitTurnLinks,
  listTurnRecords,
  type CommitRecord,
  type CommitTurnLink,
  type TurnRecord,
} from '../database';
import { runGit, type GitRunResult } from '../git-checkpoints/git-command';
import { normalizeIndexKeyPath } from '../commit-candidates/repository-identity';
import { projectDurableStampedTrail, projectLiveStampedActivity } from './stamped-evidence-projection';

const FRAME = 'These plans and turns contributed to this file.' as const;
const ZERO_OID_RE = /^0+$/;
const OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export interface BlameToIntentLedger {
  getCommitRecord(repositoryKey: string, commitOid: string): CommitRecord | null;
  listCommitTurnLinks(repositoryKey: string, commitOid: string): CommitTurnLink[];
}

export interface BlameToIntentDeps {
  getWorkspace(id: string): Workspace | null;
  listTurns(workspaceId: string, file: string): TurnRecord[];
  getTurn(id: string): TurnRecord | null;
  getPlan(id: string): Plan | null;
  ledger: BlameToIntentLedger | null;
  runGit(cwd: string, args: string[]): Promise<GitRunResult>;
  canonicalizeIndex(indexPath: string): string;
}

function defaultLedger(): BlameToIntentLedger | null {
  try {
    const rows = getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('commit_records','commit_turn_links')",
    ).all() as Array<{ name: string }>;
    if (new Set(rows.map((row) => row.name)).size !== 2) return null;
    return { getCommitRecord, listCommitTurnLinks };
  } catch {
    return null;
  }
}

function canonicalizeIndex(indexPath: string): string {
  if (fs.existsSync(indexPath)) {
    try { return fs.realpathSync.native(indexPath); } catch { /* best-effort below */ }
  }
  const parent = path.dirname(indexPath);
  if (fs.existsSync(parent)) {
    try { return path.join(fs.realpathSync.native(parent), path.basename(indexPath)); } catch { /* below */ }
  }
  return indexPath;
}

function defaultDeps(): BlameToIntentDeps {
  return {
    getWorkspace,
    listTurns: (workspaceId, file) => listTurnRecords(workspaceId, { file, limit: 200 }),
    getTurn: getTurnRecord,
    getPlan,
    ledger: defaultLedger(),
    runGit: (cwd, args) => runGit(cwd, args, {
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 10_000,
      allowNonzero: true,
    }),
    canonicalizeIndex,
  };
}

/** Validate the sole v1 selector. Ranges/hunks are intentionally not accepted. */
export function normalizeBlameIntentPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0') || raw.includes('\\')) return null;
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) return null;
  const normalized = path.posix.normalize(raw);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function planRef(plan: Plan | null): BlameIntentPlanRef | null {
  return plan ? { id: plan.id, path: plan.path, slug: plan.slug } : null;
}

function confidenceRank(value: BlameIntentConfidence): number {
  return value === 'high' ? 3 : value === 'medium' ? 2 : 1;
}

function blamedCommitOids(stdout: string): string[] {
  const commits = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const first = line.split(' ', 1)[0].replace(/^\^/, '');
    if (OID_RE.test(first) && !ZERO_OID_RE.test(first)) commits.add(first.toLowerCase());
  }
  return [...commits];
}

async function repositoryKey(
  workspaceRoot: string,
  deps: BlameToIntentDeps,
): Promise<{ key: string | null; warning: string | null }> {
  const result = await deps.runGit(workspaceRoot, ['rev-parse', '--git-path', 'index']);
  const raw = result.stdout.trim();
  if (result.code !== 0 || !raw) return { key: null, warning: 'repository identity unavailable' };
  const native = process.platform === 'win32' ? raw.replace(/\//g, '\\') : raw;
  const absolute = path.isAbsolute(native) ? native : path.resolve(workspaceRoot, native);
  const canonical = normalizeIndexKeyPath(deps.canonicalizeIndex(absolute), process.platform);
  return { key: createHash('sha256').update(canonical, 'utf8').digest('hex'), warning: null };
}

function verifiedPlans(turns: readonly TurnRecord[]): Map<string, string> {
  const projected = [
    ...projectLiveStampedActivity(turns),
    ...projectDurableStampedTrail(turns, []).acceptedTurns,
  ];
  return new Map(projected
    .filter((turn) => turn.planStampStatus === 'verified' && turn.planId !== null)
    .map((turn) => [turn.turnId, turn.planId!]));
}

function conflicts(contributors: readonly BlameIntentContributor[]): BlameIntentContributor[] {
  const identities = new Set(contributors.map((entry) =>
    entry.plan ? `plan:${entry.plan.id}` : `unplanned:${entry.turnId}`));
  return identities.size > 1 ? contributors.map((entry) => ({ ...entry })) : [];
}

/** Query file-level contribution evidence. Failures degrade to witnessed turns. */
export async function queryBlameToIntent(
  request: BlameToIntentRequest,
  injected?: BlameToIntentDeps,
): Promise<BlameToIntentResult | null> {
  const file = normalizeBlameIntentPath(request?.path);
  if (!request || typeof request.workspaceId !== 'string' || !request.workspaceId || !file) return null;
  const deps = injected ?? defaultDeps();
  const workspace = deps.getWorkspace(request.workspaceId);
  if (!workspace) return null;

  const warnings: string[] = [];
  const turns = deps.listTurns(workspace.id, file);
  const planByTurn = verifiedPlans(turns);
  const contributors = new Map<string, BlameIntentContributor>();
  for (const turn of turns) {
    // Match WP-P6A's contributing activity seam: open live activity and accepted
    // durable activity only. Other terminal states do not establish contribution.
    if (turn.status !== 'open' && turn.status !== 'accepted') continue;
    const planId = planByTurn.get(turn.id) ?? null;
    contributors.set(turn.id, {
      turnId: turn.id,
      agentId: turn.agentId,
      taskLabel: turn.taskLabel,
      plan: planId ? planRef(deps.getPlan(planId)) : null,
      confidence: 'low',
      evidence: 'turn-witness',
      commitOids: [],
      commitLevelOnly: false,
    });
  }

  let ledgerStrengthening: BlameToIntentResult['ledgerStrengthening'] =
    deps.ledger ? 'no-linked-commits' : 'unavailable';
  if (!deps.ledger) warnings.push('commit ledger unavailable; showing witnessed turn evidence');

  if (deps.ledger) {
    try {
      const [identity, blame] = await Promise.all([
        repositoryKey(workspace.path, deps),
        deps.runGit(workspace.path, ['blame', '--line-porcelain', 'HEAD', '--', file]),
      ]);
      if (identity.warning) warnings.push(identity.warning);
      if (blame.code !== 0) warnings.push('git blame unavailable for this file; showing witnessed turn evidence');
      if (identity.key && blame.code === 0) {
        for (const oid of blamedCommitOids(blame.stdout)) {
          if (!deps.ledger.getCommitRecord(identity.key, oid)) continue;
          for (const link of deps.ledger.listCommitTurnLinks(identity.key, oid)) {
            const turn = deps.getTurn(link.turnId);
            const confidence: BlameIntentConfidence = link.relation === 'exact_path_match'
              ? 'high' : link.relation === 'candidate_member' ? 'medium' : 'low';
            const existing = contributors.get(link.turnId);
            const linkedPlanId = link.planId ?? planByTurn.get(link.turnId) ?? null;
            const next: BlameIntentContributor = existing ? { ...existing } : {
              turnId: link.turnId,
              agentId: turn?.agentId ?? null,
              taskLabel: turn?.taskLabel ?? null,
              plan: null,
              confidence,
              evidence: 'blamed-commit',
              commitOids: [],
              commitLevelOnly: true,
            };
            if (linkedPlanId) next.plan = planRef(deps.getPlan(linkedPlanId));
            if (confidenceRank(confidence) > confidenceRank(next.confidence)) next.confidence = confidence;
            next.evidence = link.relation === 'exact_path_match'
              ? 'blamed-commit-exact-path' : 'blamed-commit';
            next.commitLevelOnly = true;
            next.commitOids = [...new Set([...next.commitOids, oid])].sort();
            contributors.set(link.turnId, next);
            ledgerStrengthening = 'applied';
          }
        }
      }
    } catch {
      warnings.push('commit-ledger strengthening failed; showing witnessed turn evidence');
    }
  }

  const rows = [...contributors.values()];
  const confidence = rows.reduce<BlameIntentConfidence | null>((best, row) =>
    !best || confidenceRank(row.confidence) > confidenceRank(best) ? row.confidence : best, null);
  return {
    workspaceId: workspace.id,
    path: file,
    confidence,
    contributors: rows,
    conflictingContributors: conflicts(rows),
    ledgerStrengthening,
    framing: FRAME,
    warnings,
  };
}
