// Pre/post-launch rollout discovery for CLIs that mint their own session IDs.
//
// Codex has no supported machine-readable "current session id" API. The stable
// source is the rollout file under ~/.codex/sessions/YYYY/MM/DD/. Discovery is
// therefore filesystem based, but scoped to the launched agent's home root and
// validated against session_meta before persisting anything.

import {
  type CodexRolloutFile,
  type CodexSessionHome,
  listCodexRolloutFiles,
  readCodexSessionMeta,
} from './log-readers/codex-rollout-reader';

export interface RecoverCodexSessionOptions {
  workingDirectory: string;
  home: CodexSessionHome;
  daysBack?: number | 'all';
  listFiles?: (home: CodexSessionHome) => CodexRolloutFile[];
}

export interface CodexSessionSnapshot {
  home: CodexSessionHome;
  paths: Set<string>;
}

export interface DiscoveryResult {
  sessionId: string;
  filename: string;
  path: string;
  cwd: string;
  cliVersion: string | null;
}

export interface DiscoverCodexSessionOptions {
  workingDirectory: string;
  launchedAfterMs: number;
  timeoutMs?: number;
  listFiles?: (home: CodexSessionHome) => CodexRolloutFile[];
}

/** Snapshot rollout paths currently on disk for one Codex home root. */
export async function snapshotCodexSessions(home: CodexSessionHome): Promise<CodexSessionSnapshot> {
  return {
    home,
    paths: new Set(listCodexRolloutFiles({ home }).map((file) => file.path)),
  };
}

/**
 * Poll until a new, validated Codex rollout appears, or timeout elapses.
 *
 * Validation rejects unrelated concurrent sessions by requiring:
 * - file path was absent from the pre-launch snapshot
 * - file mtime is after launch start
 * - filename UUID matches session_meta.payload.id
 * - session_meta.payload.cwd matches the launched agent working directory
 */
export async function discoverNewCodexSession(
  before: CodexSessionSnapshot,
  options: DiscoverCodexSessionOptions
): Promise<DiscoveryResult | null> {
  const pollIntervalMs = 500;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  const targetCwd = normalizeCwd(options.workingDirectory);

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const current = options.listFiles
      ? options.listFiles(before.home)
      : listCodexRolloutFiles({ home: before.home });
    const candidates = current
      .filter((file) => !before.paths.has(file.path))
      .filter((file) => file.mtimeMs >= options.launchedAfterMs)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const file of candidates) {
      const valid = validateCandidate(file, targetCwd);
      if (valid) return valid;
    }
  }
  return null;
}

/**
 * BUG-08 decision helper: should the launch path take a pre-launch rollout
 * snapshot and run `discoverNewCodexSession` to bind the new agent to the
 * codex-minted session id?
 *
 * - Non-codex providers never need it (claude/gemini handle their own ids).
 * - When `resume` is true, the launch is using an explicit `codex resume <sid>`
 *   subcommand; discovery would be redundant.
 * - When `freshSession` is true (BUG-08), the caller has explicitly asked for
 *   a clean start. Skipping discovery lets codex mint its own brand-new
 *   session on disk without the dashboard auto-binding the new agent record
 *   to any rollout in this cwd. Default behavior (no flag) is unchanged.
 *
 * Pure helper so it can be unit-tested without touching the DB or filesystem.
 */
export function shouldDiscoverCodexSession(opts: {
  provider: string;
  resume: boolean;
  freshSession?: boolean;
}): boolean {
  if (opts.provider !== 'codex') return false;
  if (opts.resume) return false;
  if (opts.freshSession) return false;
  return true;
}

/**
 * Lazy-recovery decision helper. Returns the existing sid if present;
 * otherwise invokes the recovery callback and returns its result. Used at
 * every site that needs a Codex `resumeSessionId` so that BUG-04 (10 s
 * `discoverNewCodexSession` poll missed the flush) becomes self-healing —
 * the first operation that actually reads the sid triggers the rollout-dir
 * scan instead of failing.
 *
 * Pure / synchronous so it can be unit-tested without touching the DB or
 * filesystem; the recovery callback wraps the I/O.
 */
export function ensureCodexResumeSessionId(opts: {
  current: string | null | undefined;
  recover: () => string | null;
}): string | null {
  if (opts.current) return opts.current;
  return opts.recover();
}

/**
 * Retroactively find a Codex session id by matching `session_meta.cwd`.
 *
 * Used when an agent's `resumeSessionId` was never persisted (e.g. the app was
 * killed mid-launch, before `discoverNewCodexSession` could write to the DB) but
 * the rollout file is still on disk. Returns the newest matching rollout's
 * validated session id, or null.
 *
 * Caveat: when two agents share the same workingDirectory this picks the most
 * recent one. The chat-log reader has the same caveat in `findByCwd` — they
 * agree on which rollout "belongs" to the agent.
 */
export function findCodexSessionIdByCwd(
  options: RecoverCodexSessionOptions
): DiscoveryResult | null {
  const targetCwd = normalizeCwd(options.workingDirectory);
  const files = options.listFiles
    ? options.listFiles(options.home)
    : listCodexRolloutFiles({ home: options.home, daysBack: options.daysBack ?? 'all' });

  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of sorted) {
    const valid = validateCandidate(file, targetCwd);
    if (valid) return valid;
  }
  return null;
}

function validateCandidate(file: CodexRolloutFile, targetCwd: string): DiscoveryResult | null {
  const meta = readCodexSessionMeta(file.path);
  if (!meta.id || meta.id !== file.sessionId) return null;
  if (!meta.cwd || normalizeCwd(meta.cwd) !== targetCwd) return null;
  return {
    sessionId: file.sessionId,
    filename: file.filename,
    path: file.path,
    cwd: meta.cwd,
    cliVersion: meta.cliVersion,
  };
}

function normalizeCwd(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
