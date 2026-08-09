import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  insertPlanWpReachabilityEvidenceBatch,
  listPlanWpReachabilityObligations,
  type PlanWpReachabilityEvidence,
  type PlanWpReachabilityObligation,
  type PlanWpReachabilityVerdict,
} from '../database';
import {
  parsePlanWorkPackageDocument,
  PLAN_WORK_PACKAGE_MAX_BYTES,
  type ParsedPlanWorkPackageInput,
  type PlanWorkPackageEntrySeamLink,
  type PlanWorkPackageProductionConstruct,
} from './plan-work-package-ingest';
import {
  REACHABILITY_TARGET_REGISTRY,
  type ReachabilityTargetRegistry,
  type ReachabilityVerificationTarget,
} from './reachability-targets';

const GIT_OID = /^[0-9a-f]{40}$/i;
const OUTPUT_LIMIT = 2_000_000;
const RUN_TIMEOUT_MS = 5 * 60_000;

export interface ReachabilityProofRequest {
  repositoryRoot: string;
  planFolder: string;
  packageId: string;
  /** Exact commit used as the immutable base of the candidate specimen. */
  baseOid: string;
  /**
   * Required caller-reviewed disclosure. Use [] only after reviewing the dirty
   * declared-path status as package-owned; list inseparable foreign edits here.
   */
  foreignEditPaths: string[];
}

export interface ReachabilityCommandResult {
  command: string;
  args: string[];
  exitCode: number | null;
  phase: 'compile' | 'test' | 'git';
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ReachabilityObligationResult {
  obligationId: string;
  kind: 'entry-link' | 'construct';
  ordinal: number;
  target: string;
  verdict: PlanWpReachabilityVerdict;
  classification: string;
  mutationBlobOid: string | null;
  baseline: ReachabilityCommandResult | null;
  mutated: ReachabilityCommandResult | null;
}

export interface ReachabilityProofResult {
  packageId: string;
  packageContentHash: string;
  verdict: PlanWpReachabilityVerdict;
  registryVersion: string;
  specimen: {
    baseOid: string;
    treeOid: string;
    commitOid: string;
    includedPaths: string[];
    dirtyDeclaredPathStatus: string[];
    packageExact: boolean;
    admittedForeignPaths: string[];
  };
  obligations: ReachabilityObligationResult[];
  evidenceRecorded: boolean;
}

interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

type RunProcess = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => Promise<ReachabilityCommandResult>;

export interface ReachabilityProverDependencies {
  registry?: ReachabilityTargetRegistry;
  runProcess?: RunProcess;
  listObligations?: (packageId: string, contentHash: string) => PlanWpReachabilityObligation[];
  persistEvidence?: (rows: readonly PlanWpReachabilityEvidence[]) => void;
  now?: () => number;
}

type DeclaredObligation = {
  kind: 'entry-link' | 'construct';
  ordinal: number;
  path: string;
  symbol: string;
  enteringTest: string;
  mutation: string;
  target: string;
  expectFailure: string;
};

function appendBounded(current: string, chunk: Buffer): string {
  if (current.length >= OUTPUT_LIMIT) return current;
  return current + chunk.toString('utf8', 0, Math.max(0, OUTPUT_LIMIT - current.length));
}

const defaultRunProcess: RunProcess = (command, args, options) => new Promise((resolve) => {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.on('data', (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on('data', (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
  child.on('error', (err) => { stderr = appendBounded(stderr, Buffer.from(String(err))); });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs ?? RUN_TIMEOUT_MS);
  child.on('close', (exitCode) => {
    clearTimeout(timer);
    resolve({ command, args: [...args], exitCode, phase: 'git', stdout, stderr, timedOut });
  });
  if (options.input !== undefined) child.stdin.end(options.input);
  else child.stdin.end();
});

function normalizePlanPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`unsafe repository-relative path: ${value}`);
  }
  return normalized;
}

function isContained(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

async function runGit(
  run: RunProcess,
  repositoryRoot: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
  input?: string,
): Promise<ReachabilityCommandResult> {
  return run('git', ['-C', repositoryRoot, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    input,
  });
}

function requireSuccess(result: ReachabilityCommandResult, action: string): string {
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`${action} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function readProjection(planFolder: string): ReturnType<typeof parsePlanWorkPackageDocument> {
  const manifestPath = path.join(planFolder, 'plan.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { plan_artifact_id?: unknown };
  if (typeof manifest.plan_artifact_id !== 'string' || !manifest.plan_artifact_id) {
    throw new Error('plan.json has no plan_artifact_id');
  }
  const supplements = path.join(planFolder, 'supplements');
  const candidates = fs.readdirSync(supplements, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => ({
      name: entry.name,
      body: fs.readFileSync(path.join(supplements, entry.name), 'utf8'),
    }))
    .filter((entry) => /<!--PLAN-WORK-PACKAGES:v[12]\b/.test(entry.body));
  if (candidates.length !== 1) throw new Error('exactly one work-package supplement is required');
  if (Buffer.byteLength(candidates[0].body, 'utf8') > PLAN_WORK_PACKAGE_MAX_BYTES) {
    throw new Error('work-package supplement exceeds the parser byte limit');
  }
  return parsePlanWorkPackageDocument(
    candidates[0].body,
    manifest.plan_artifact_id,
    `supplements/${candidates[0].name}`,
  );
}

function declaredObligations(pkg: ParsedPlanWorkPackageInput): DeclaredObligation[] {
  if (pkg.reachability?.kind !== 'behavior') return [];
  const entry = (item: PlanWorkPackageEntrySeamLink, ordinal: number): DeclaredObligation => ({
    kind: 'entry-link', ordinal, path: item.path, symbol: item.symbol,
    enteringTest: item.entering_test, mutation: item.mutation,
    target: item.verification.target, expectFailure: item.verification.expect_failure,
  });
  const construct = (item: PlanWorkPackageProductionConstruct, ordinal: number): DeclaredObligation => ({
    kind: 'construct', ordinal, path: item.producer_path, symbol: item.producer_symbol,
    enteringTest: item.entering_test, mutation: item.mutation,
    target: item.verification.target, expectFailure: item.verification.expect_failure,
  });
  return [
    ...pkg.reachability.entry_seam_links.map(entry),
    ...pkg.reachability.production_constructs.map(construct),
  ];
}

function changedPathsFromPatch(patchBody: string): string[] {
  const paths = new Set<string>();
  for (const line of patchBody.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+)$/.exec(line);
    if (!match || match[1] === '/dev/null') continue;
    paths.add(normalizePlanPath(match[1].replace(/^"|"$/g, '')));
  }
  return [...paths];
}

function validatePatch(
  patchBody: string,
  obligation: DeclaredObligation,
  target: ReachabilityVerificationTarget,
): string | null {
  const changedPaths = changedPathsFromPatch(patchBody);
  const protectedPaths = new Set(target.protected_test_paths.map(normalizePlanPath));
  if (changedPaths.some((changed) => protectedPaths.has(changed))) return 'protected-test-path-touched';
  if (changedPaths.length !== 1 || changedPaths[0] !== normalizePlanPath(obligation.path)) {
    return 'mutation-path-mismatch';
  }
  const changedLines = patchBody.replace(/\r\n/g, '\n').split('\n')
    .filter((line) => (/^[+-]/.test(line) && !/^\+\+\+|^---/.test(line)));
  if (!changedLines.some((line) => line.includes(obligation.symbol))) return 'mutation-symbol-miss';
  return null;
}

function assertionCarriesMarker(result: ReachabilityCommandResult, marker: string): boolean {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assertion = new RegExp(`AssertionError[^\\r\\n]{0,500}${escaped}|${escaped}[^\\r\\n]{0,500}AssertionError`);
  return assertion.test(`${result.stdout}\n${result.stderr}`);
}

function compiledNodeTestPath(sourcePath: string): string {
  if (!sourcePath.startsWith('src/') || !sourcePath.endsWith('.ts')) return sourcePath;
  return `dist/main/${sourcePath.slice('src/'.length, -3)}.js`;
}

async function runTarget(
  run: RunProcess,
  repositoryRoot: string,
  scratch: string,
  target: ReachabilityVerificationTarget,
): Promise<ReachabilityCommandResult> {
  const dependencyRoot = path.join(repositoryRoot, 'node_modules');
  const env = { ...process.env, NODE_PATH: dependencyRoot };
  if (target.runner === 'node-test') {
    if (target.file.endsWith('.ts')) {
      const compiler = path.join(dependencyRoot, 'typescript', 'bin', 'tsc');
      const compiled = await run(process.execPath, [compiler, '-p', 'tsconfig.main.json'], {
        cwd: scratch, env,
      });
      if (compiled.exitCode !== 0 || compiled.timedOut) return { ...compiled, phase: 'compile' };
    }
    const tested = await run(process.execPath, [
      '--test', `--test-name-pattern=${target.test_name}`, compiledNodeTestPath(target.file),
    ], { cwd: scratch, env });
    return { ...tested, phase: 'test' };
  }
  const vitest = path.join(dependencyRoot, 'vitest', 'vitest.mjs');
  const tested = await run(process.execPath, [vitest, 'run', '--config', 'vitest.config.ts',
    target.file, '-t', target.test_name], { cwd: scratch, env });
  return { ...tested, phase: 'test' };
}

function overallVerdict(results: readonly ReachabilityObligationResult[]): PlanWpReachabilityVerdict {
  if (results.some((result) => result.verdict === 'indeterminate')) return 'indeterminate';
  return results.every((result) => result.verdict === 'pass') ? 'pass' : 'fail';
}

function commandJson(result: ReachabilityCommandResult | null): string {
  return JSON.stringify(result ?? { notRun: true });
}

/**
 * Prove each declared reachability obligation against an immutable candidate
 * specimen. The shared worktree and its index are never mutated.
 */
export async function proveReachability(
  request: ReachabilityProofRequest,
  dependencies: ReachabilityProverDependencies = {},
): Promise<ReachabilityProofResult> {
  const run = dependencies.runProcess ?? defaultRunProcess;
  const registry = dependencies.registry ?? REACHABILITY_TARGET_REGISTRY;
  const listObligations = dependencies.listObligations ?? listPlanWpReachabilityObligations;
  const persistEvidence = dependencies.persistEvidence ?? insertPlanWpReachabilityEvidenceBatch;
  const now = dependencies.now ?? Date.now;

  const repositoryRoot = fs.realpathSync(request.repositoryRoot);
  const planFolder = fs.realpathSync(request.planFolder);
  if (!isContained(repositoryRoot, planFolder)) throw new Error('planFolder must be inside repositoryRoot');
  if (!GIT_OID.test(request.baseOid)) throw new Error('baseOid must be a full 40-hex commit OID');

  const parsed = readProjection(planFolder);
  if (!parsed.ok) throw new Error(`work-package parse failed: ${JSON.stringify(parsed.diagnostics)}`);
  if (parsed.projection.schemaVersion !== 2) throw new Error('reachability proof requires PLAN-WORK-PACKAGES:v2');
  const foldedId = request.packageId.toLowerCase();
  const pkg = parsed.projection.packages.find((candidate) =>
    candidate.id.toLowerCase() === foldedId || candidate.sourceLocalId.toLowerCase() === foldedId);
  if (!pkg) throw new Error(`package not found: ${request.packageId}`);
  const declared = declaredObligations(pkg);
  if (declared.length === 0) throw new Error(`package ${pkg.sourceLocalId} has no behavior obligations`);

  const includedPaths = [...new Set(pkg.paths.map((entry) => normalizePlanPath(entry.path)))].sort();
  const includedSet = new Set(includedPaths);
  if (!Array.isArray(request.foreignEditPaths)) {
    throw new Error('foreignEditPaths disclosure is required (use [] only after review)');
  }
  const admittedForeignPaths = [...new Set(request.foreignEditPaths.map(normalizePlanPath))].sort();
  if (admittedForeignPaths.some((entry) => !includedSet.has(entry))) {
    throw new Error('foreignEditPaths must be a subset of the package declared paths');
  }

  const pinned = requireSuccess(await runGit(run, repositoryRoot,
    ['rev-parse', '--verify', `${request.baseOid}^{commit}`]), 'pin base commit');
  if (pinned.toLowerCase() !== request.baseOid.toLowerCase()) {
    throw new Error('baseOid did not resolve to itself as a commit');
  }
  const dirtyStatusResult = await runGit(run, repositoryRoot,
    ['status', '--porcelain=v1', '--untracked-files=all', '--', ...includedPaths]);
  const dirtyDeclaredPathStatus = requireSuccess(dirtyStatusResult, 'inspect declared paths')
    .split(/\r?\n/).filter(Boolean);

  const tempIndexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-reachability-index-'));
  const tempIndex = path.join(tempIndexDir, 'index');
  const indexEnv = { GIT_INDEX_FILE: tempIndex };
  let specimenTreeOid = '';
  let specimenCommitOid = '';
  try {
    requireSuccess(await runGit(run, repositoryRoot, ['read-tree', request.baseOid], indexEnv), 'read base tree');
    requireSuccess(await runGit(run, repositoryRoot, ['add', '-A', '--', ...includedPaths], indexEnv), 'stage declared paths');
    specimenTreeOid = requireSuccess(await runGit(run, repositoryRoot, ['write-tree'], indexEnv), 'write specimen tree');
    specimenCommitOid = requireSuccess(await runGit(run, repositoryRoot,
      ['commit-tree', specimenTreeOid, '-p', request.baseOid], {
        GIT_AUTHOR_NAME: 'Lares Reachability Prover',
        GIT_AUTHOR_EMAIL: 'reachability@lares.local',
        GIT_COMMITTER_NAME: 'Lares Reachability Prover',
        GIT_COMMITTER_EMAIL: 'reachability@lares.local',
      }, 'Lares reachability specimen\n'), 'commit specimen tree');
  } finally {
    fs.rmSync(tempIndexDir, { recursive: true, force: true });
  }

  const persisted = listObligations(pkg.id, pkg.contentHash);
  const results: ReachabilityObligationResult[] = [];
  const evidence: PlanWpReachabilityEvidence[] = [];
  for (const obligation of declared) {
    const stored = persisted.find((row) => row.obligationKind === obligation.kind
      && row.ordinal === obligation.ordinal);
    if (!stored) throw new Error(`persisted obligation missing for ${obligation.kind}:${obligation.ordinal}`);
    const target = registry.targets[obligation.target];
    let mutationBlobOid: string | null = null;
    let baseline: ReachabilityCommandResult | null = null;
    let mutated: ReachabilityCommandResult | null = null;
    let verdict: PlanWpReachabilityVerdict = 'indeterminate';
    let classification = 'unregistered-target';
    const scratchParent = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-reachability-worktree-'));
    const scratch = path.join(scratchParent, 'specimen');
    let addedWorktree = false;
    try {
      requireSuccess(await runGit(run, repositoryRoot,
        ['worktree', 'add', '--detach', scratch, specimenCommitOid]), 'add detached specimen worktree');
      addedWorktree = true;
      if (!target) continue;
      if (normalizePlanPath(target.file) !== normalizePlanPath(obligation.enteringTest)) {
        classification = 'target-entering-test-mismatch';
        continue;
      }
      const patchPath = path.join(scratch, ...normalizePlanPath(obligation.mutation).split('/'));
      if (!fs.existsSync(patchPath) || !fs.statSync(patchPath).isFile()) {
        classification = 'mutation-missing';
        continue;
      }
      mutationBlobOid = requireSuccess(await runGit(run, scratch,
        ['hash-object', '--', obligation.mutation]), 'hash mutation blob');
      const patchBody = fs.readFileSync(patchPath, 'utf8');
      baseline = await runTarget(run, repositoryRoot, scratch, target);
      if (baseline.exitCode !== 0 || baseline.timedOut) {
        classification = baseline.phase === 'compile' ? 'baseline-compile-failure' : 'baseline-must-pass';
        continue;
      }
      const protectedPaths = target.protected_test_paths.map(normalizePlanPath);
      if (!protectedPaths.includes(normalizePlanPath(obligation.enteringTest))) {
        classification = 'target-protection-incomplete';
        continue;
      }
      const patchProblem = validatePatch(patchBody, obligation, target);
      if (patchProblem) {
        classification = patchProblem;
        continue;
      }
      const check = await runGit(run, scratch, ['apply', '--check', '--', obligation.mutation]);
      if (check.exitCode !== 0 || check.timedOut) {
        classification = 'stale-context-patch';
        continue;
      }
      const apply = await runGit(run, scratch, ['apply', '--', obligation.mutation]);
      if (apply.exitCode !== 0 || apply.timedOut) {
        classification = 'mutation-apply-failure';
        continue;
      }
      mutated = await runTarget(run, repositoryRoot, scratch, target);
      if (mutated.exitCode === 0 && !mutated.timedOut) {
        verdict = 'fail';
        classification = 'still-passes-after-revert';
      } else if (mutated.phase === 'test' && !mutated.timedOut
          && assertionCarriesMarker(mutated, obligation.expectFailure)) {
        verdict = 'pass';
        classification = 'expected-assertion-refuted';
      } else {
        classification = mutated.phase === 'compile'
          ? 'compile-failure-under-mutation'
          : 'compile-collection-fixture-failure-under-mutation';
      }
    } finally {
      if (addedWorktree) {
        await runGit(run, repositoryRoot, ['worktree', 'remove', '--force', scratch]);
      }
      fs.rmSync(scratchParent, { recursive: true, force: true });
      const result: ReachabilityObligationResult = {
        obligationId: stored.id, kind: obligation.kind, ordinal: obligation.ordinal,
        target: obligation.target, verdict, classification, mutationBlobOid, baseline, mutated,
      };
      results.push(result);
      if (mutationBlobOid && GIT_OID.test(mutationBlobOid)) {
        evidence.push({
          id: `reachability-evidence:${randomUUID()}`,
          obligationId: stored.id,
          packageContentHash: pkg.contentHash,
          specimenBaseOid: request.baseOid.toLowerCase(),
          specimenTreeOid: specimenTreeOid.toLowerCase(),
          mutationBlobOid: mutationBlobOid.toLowerCase(),
          baselineResult: commandJson(baseline),
          mutatedResult: commandJson(mutated),
          failureClassification: classification,
          verdict,
          verificationTargetVersion: registry.version,
          verifiedAt: now(),
        });
      }
    }
  }
  if (evidence.length > 0) persistEvidence(evidence);
  return {
    packageId: pkg.id,
    packageContentHash: pkg.contentHash,
    verdict: overallVerdict(results),
    registryVersion: registry.version,
    specimen: {
      baseOid: request.baseOid.toLowerCase(), treeOid: specimenTreeOid.toLowerCase(),
      commitOid: specimenCommitOid.toLowerCase(), includedPaths,
      dirtyDeclaredPathStatus, packageExact: admittedForeignPaths.length === 0,
      admittedForeignPaths,
    },
    obligations: results,
    evidenceRecorded: evidence.length > 0,
  };
}
