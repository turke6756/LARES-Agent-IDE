import { spawn, type ChildProcess, type StdioOptions } from 'child_process';

/**
 * Spawning bundled JS helpers without a system Node.js (plan §5.2, ground truth F3).
 *
 * The packaged app carries a complete Node runtime *inside* Electron, but the
 * code used to `spawn('node', …)` — so on a machine with no Node installed
 * terminals never opened and every dashboard MCP tool died. Electron exposes its
 * embedded Node through `ELECTRON_RUN_AS_NODE=1`: launched with that variable
 * set, `Lares.exe` behaves as a plain `node` binary. That also gives us the same
 * ABI as the natives we ship and asar-aware module resolution for free.
 *
 * Under the plain-Node test runner `process.execPath` is already the node
 * binary, so the same code path works there with the flag left off.
 */

/** True when this process is Electron (main process or `ELECTRON_RUN_AS_NODE`). */
export function isElectronRuntime(): boolean {
  return Boolean(process.versions.electron);
}

export interface BundledNodeSpawnOptions {
  /** Base environment for the child. Defaults to `process.env`.
   *  Callers that sanitize (e.g. `sanitizeClaudeChildEnv`) must sanitize FIRST
   *  and pass the result here — this helper adds `ELECTRON_RUN_AS_NODE` after,
   *  so a sanitizer can never strip the very flag that makes the child run. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdio?: StdioOptions;
  /** Test seam: override runtime detection. Defaults to `isElectronRuntime()`. */
  electron?: boolean;
}

export interface BundledNodeSpawnPlan {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Whether the child is Electron-as-Node rather than a real node binary. */
  electronAsNode: boolean;
}

/**
 * Pure, testable half of {@link spawnBundledNode}: decide the command, argv and
 * environment without touching the process table.
 *
 * The script path is passed as a separate argv element and `shell` is never
 * used, so paths containing spaces (`C:\Program Files\…`) need no quoting.
 */
export function buildBundledNodeSpawn(
  scriptPath: string,
  args: string[] = [],
  opts: BundledNodeSpawnOptions = {},
): BundledNodeSpawnPlan {
  const electronAsNode = opts.electron ?? isElectronRuntime();
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };

  if (electronAsNode) {
    // Run our own executable as a bare Node runtime. No system Node required.
    env.ELECTRON_RUN_AS_NODE = '1';
  } else {
    // Plain-node runner: the marker would be meaningless noise inherited by
    // every descendant, and a provider CLI that re-execs node while inheriting
    // it misbehaves.
    delete env.ELECTRON_RUN_AS_NODE;
  }

  return {
    command: process.execPath,
    args: [scriptPath, ...args],
    env,
    electronAsNode,
  };
}

/**
 * Spawn a bundled JS helper on the runtime we ship, never on a system `node`.
 */
export function spawnBundledNode(
  scriptPath: string,
  args: string[] = [],
  opts: BundledNodeSpawnOptions = {},
): ChildProcess {
  const plan = buildBundledNodeSpawn(scriptPath, args, opts);
  return spawn(plan.command, plan.args, {
    stdio: opts.stdio ?? ['pipe', 'pipe', 'pipe'],
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    env: plan.env,
  });
}
