import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { CandidateCommitPolicy } from '../../shared/commit-candidates';
import type { CoordinatorRunGit } from '../git-checkpoints/commit-coordinator';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
const MAX_OUTPUT_BYTES = 4 << 20;

export interface CandidatePolicyInput {
  repoRoot: string;
  gitExe?: string;
  runGit: CoordinatorRunGit;
}

export interface CandidateTreeValidationInput extends CandidatePolicyInput {
  treeOid: string;
  policy: CandidateCommitPolicy['validation'];
  env?: NodeJS.ProcessEnv;
  tmpDir?: string;
}

export type CandidateTreeValidationResult =
  | { ok: true }
  | { ok: false; command: string | null; diagnostic: string };

export function candidateCommitSigningArgs(
  policy: CandidateCommitPolicy['signing'],
): string[] {
  if (!policy.enabled) return [];
  return [policy.signingKey ? `-S${policy.signingKey}` : '-S'];
}

async function readLocalConfig(
  input: CandidatePolicyInput,
  key: string,
  all = false,
): Promise<string[]> {
  const result = await input.runGit(
    input.repoRoot,
    ['config', '--local', all ? '--get-all' : '--get', key],
    {
      gitExe: input.gitExe,
      allowNonzero: true,
      timeoutMs: 30_000,
      maxBytes: 1 << 20,
    },
  );
  if (result.code !== 0) return [];
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function enabled(values: readonly string[]): boolean {
  return values.length === 1 && /^(?:true|yes|on|1)$/i.test(values[0]);
}

/** Resolve only repository-local policy. Global Git preferences cannot silently
 * turn validation/signing on for every repository. */
export async function readCandidateCommitPolicy(input: CandidatePolicyInput): Promise<CandidateCommitPolicy> {
  const [validationEnabled, commands, configuredTimeout, signingEnabled, signingKey] = await Promise.all([
    readLocalConfig(input, 'lares.candidateValidation.enabled'),
    readLocalConfig(input, 'lares.candidateValidation.command', true),
    readLocalConfig(input, 'lares.candidateValidation.timeoutMs'),
    readLocalConfig(input, 'lares.commitSigning.enabled'),
    readLocalConfig(input, 'lares.commitSigning.key'),
  ]);
  const parsedTimeout = Number(configuredTimeout[0]);
  const timeoutMs = Number.isSafeInteger(parsedTimeout) && parsedTimeout > 0
    ? Math.min(parsedTimeout, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  return {
    validation: { enabled: enabled(validationEnabled), commands, timeoutMs },
    signing: { enabled: enabled(signingEnabled), signingKey: signingKey[0] ?? null },
  };
}

function runValidationCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ ok: boolean; diagnostic: string }> {
  return new Promise((resolve) => {
    exec(command, {
      cwd,
      env,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) return resolve({ ok: true, diagnostic: '' });
      const output = `${stderr || ''}\n${stdout || ''}`.trim();
      resolve({
        ok: false,
        diagnostic: (output || error.message || 'validation command failed').slice(0, 4_000),
      });
    });
  });
}

/** Materialize `treeOid` through an isolated index, then run every configured
 * command from that copy. The dirty worktree is never read by validation and the
 * reviewed Git objects/index are never rewritten. */
export async function validateCandidateTree(
  input: CandidateTreeValidationInput,
): Promise<CandidateTreeValidationResult> {
  if (!input.policy.enabled) return { ok: true };
  if (input.policy.commands.length === 0) {
    return { ok: false, command: null, diagnostic: 'candidate validation is enabled but no commands are configured' };
  }

  const tempRoot = await fs.promises.mkdtemp(path.join(input.tmpDir ?? os.tmpdir(), 'lares-validate-'));
  const checkoutRoot = path.join(tempRoot, 'tree');
  const indexFile = path.join(tempRoot, 'candidate.index');
  await fs.promises.mkdir(checkoutRoot);
  try {
    await input.runGit(input.repoRoot, ['read-tree', input.treeOid], {
      gitExe: input.gitExe,
      env: input.env,
      indexFile,
      timeoutMs: 60_000,
      maxBytes: 1 << 20,
    });
    const prefix = checkoutRoot.endsWith(path.sep) ? checkoutRoot : `${checkoutRoot}${path.sep}`;
    await input.runGit(input.repoRoot, ['checkout-index', '--all', '--force', `--prefix=${prefix}`], {
      gitExe: input.gitExe,
      env: input.env,
      indexFile,
      timeoutMs: 60_000,
      maxBytes: 1 << 20,
    });

    const commandEnv = {
      ...(input.env ?? process.env),
      LARES_CANDIDATE_TREE_OID: input.treeOid,
      LARES_CANDIDATE_TREE_ROOT: checkoutRoot,
    };
    for (const command of input.policy.commands) {
      const result = await runValidationCommand(command, checkoutRoot, commandEnv, input.policy.timeoutMs);
      if (!result.ok) return { ok: false, command, diagnostic: result.diagnostic };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      command: null,
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
