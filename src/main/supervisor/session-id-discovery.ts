// Pre/post-launch rollout discovery for CLIs that mint their own session IDs.
//
// Codex 0.133.0+ exposes an authoritative `~/.codex/state_5.sqlite` `threads`
// table (id, rollout_path, created_at, cwd, first_user_message) that is
// race-free across concurrent same-cwd launches: `created_at` filters out
// pre-launch sessions and `first_user_message` deterministically tiebreaks
// peers. T1-C in plans/windows-wsl-issues-review-2026-05-23.md.
//
// The SQLite path is the primary discovery channel. If the DB is missing,
// schema-incompatible, or returns no row within the poll window, we fall back
// to the original filesystem-mtime + session_meta validation logic with a
// warning log — the warning is the early-detection signal for schema drift.

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as nodeOs from 'node:os';
import {
  type CodexRolloutFile,
  type CodexSessionHome,
  listCodexRolloutFiles,
  readCodexSessionMeta,
} from './log-readers/codex-rollout-reader';

// Codex 0.133.0 defers the `threads`-row INSERT (and the rollout's
// `session_meta` first-line flush) until it processes the first user message
// of the conversation — empirically ~25-26 s after launch on this hardware.
// The previous 10 s default timed out before the row landed for every codex
// launch and sent discovery down the filesystem-fallback path, which is the
// race-prone code path BUG-26 exploited. 35 s gives margin for jitter without
// being absurd. Per-call `timeoutMs` overrides still win (tests use 400-700
// ms; recovery sites pass their own short windows).
export const DEFAULT_SQL_POLL_TIMEOUT_MS = 35_000;

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

// Minimal interface so unit tests can stub `better-sqlite3` without loading the
// native binding (the production binding is built against Electron's Node ABI
// and won't load under a plain `node` invocation). `all` is optional so
// existing single-row test stubs (which only implement `get`) keep working;
// production `better-sqlite3` Statement provides both.
export interface CodexStateDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all?(...params: unknown[]): unknown[];
  };
  close(): void;
}
export type CodexStateDbOpener = (path: string) => CodexStateDb;

export interface DiscoverCodexSessionOptions {
  workingDirectory: string;
  launchedAfterMs: number;
  /** T1-C: per-launch tiebreaker matched against `threads.first_user_message`. */
  firstUserMessagePrefix?: string;
  timeoutMs?: number;
  listFiles?: (home: CodexSessionHome) => CodexRolloutFile[];
  /** Test seam: override the on-disk path of state_5.sqlite. */
  statePath?: string;
  /** Test seam: stub the SQLite opener so tests don't need a native binding. */
  openSqliteDb?: CodexStateDbOpener;
  /** Test seam: capture the fallback-fired warning. Defaults to console.warn. */
  warn?: (msg: string) => void;
}

/** Snapshot rollout paths currently on disk for one Codex home root. */
export async function snapshotCodexSessions(home: CodexSessionHome): Promise<CodexSessionSnapshot> {
  return {
    home,
    paths: new Set(listCodexRolloutFiles({ home }).map((file) => file.path)),
  };
}

/**
 * Discover the codex session id minted for a just-launched worker.
 *
 * Primary path (T1-C): poll `~/.codex/state_5.sqlite` `threads` for the row
 * whose `cwd` matches the launched workingDirectory, whose `created_at` is at
 * or after the launch timestamp, and whose `first_user_message` begins with
 * the supplied launch-prompt prefix (when provided). The combination is
 * race-free against concurrent same-cwd launches.
 *
 * Fallback path: if the SQLite query yields no row within `timeoutMs`, or
 * SQLite is unavailable / schema-incompatible / errors, fall back to the
 * original filesystem-mtime + session_meta validation and emit a single
 * warning so future schema drift is detectable from logs.
 */
export async function discoverNewCodexSession(
  before: CodexSessionSnapshot,
  options: DiscoverCodexSessionOptions
): Promise<DiscoveryResult | null> {
  const pollIntervalMs = 500;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SQL_POLL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const targetCwd = normalizeCwd(options.workingDirectory);
  const launchedAfterSeconds = Math.floor(options.launchedAfterMs / 1000);
  const messagePrefix = options.firstUserMessagePrefix ?? '';
  const warn = options.warn ?? ((m) => console.warn(m));

  let lastSqlOutcome: SqlQueryOutcome = { kind: 'miss' };
  while (Date.now() < deadline) {
    lastSqlOutcome = queryStateSqlite({
      statePath: options.statePath,
      opener: options.openSqliteDb,
      workingDirectoryNormalized: targetCwd,
      launchedAfterSeconds,
      firstUserMessagePrefix: messagePrefix,
    });
    if (lastSqlOutcome.kind === 'hit') {
      const row = lastSqlOutcome.row;
      return {
        sessionId: row.sessionId,
        filename: nodePath.basename(row.rolloutPath),
        path: row.rolloutPath,
        cwd: row.cwd,
        cliVersion: row.cliVersion,
      };
    }
    if (lastSqlOutcome.kind === 'ambiguous') {
      // BUG-26 risk 3: two same-cwd same-prompt rows tied in the window.
      // Declining to bind ambiguously is strictly better than picking the
      // older row silently (the old LIMIT 1 behavior). Recovery can retry
      // once one rollout flushes new content that distinguishes it.
      warn(
        `[supervisor] state.sqlite discovery declined: ${lastSqlOutcome.count} ambiguous rows match cwd+prefix+window`
      );
      return null;
    }
    // For non-transient outcomes (no-db / schema-mismatch / sqlite-error), don't
    // keep retrying within this call — they won't change in the next 500ms.
    if (lastSqlOutcome.kind !== 'miss') break;
    await sleep(pollIntervalMs);
  }

  const reason: 'empty-result' | 'sqlite-error' | 'schema-mismatch' =
    lastSqlOutcome.kind === 'miss' ? 'empty-result' :
    lastSqlOutcome.kind === 'schema-mismatch' ? 'schema-mismatch' :
    'sqlite-error';
  warn(`[supervisor] state.sqlite discovery fell back to file poll (reason: ${reason})`);

  // Fallback: one scan with the original snapshot-diff + session_meta validation.
  // Keeps total latency bounded; the SQL poll already consumed the timeout.
  //
  // BUG-26 fail-loud-empty: the pre-fix logic walked candidates oldest-first
  // and returned the FIRST cwd-match (validated by `session_meta`). Under
  // concurrent same-cwd launches with no launch-prompt prefix to
  // disambiguate (the default codex-launch path — prompts arrive via POST
  // /input *after* launch and `messagePrefix === ''`), that silently picked
  // one of N peer rollouts and mis-attributed events between agents. The
  // semantic now: empty chat (unbound agent) is strictly better than
  // misbound chat. Recovery (`recoverCodexResumeSessionId` →
  // `findCodexSessionIdByCwd`, fired lazily the first time a sid is asked
  // for) owns the late-binding fix.
  //
  // Decision matrix:
  //   - 0 cwd+prefix matches → return null (nothing to bind to)
  //   - 1 unambiguous match  → bind it (single concurrent launch in the window)
  //   - 2+ ambiguous matches → return null + warn (BUG-26 — refuse to guess)
  const current = options.listFiles
    ? options.listFiles(before.home)
    : listCodexRolloutFiles({ home: before.home });
  const candidates = current
    .filter((file) => !before.paths.has(file.path))
    .filter((file) => file.mtimeMs >= options.launchedAfterMs);
  const prefixForFallback = messagePrefix.length > 0 ? messagePrefix : null;
  const matches: DiscoveryResult[] = [];
  for (const file of candidates) {
    const valid = validateCandidate(file, targetCwd, prefixForFallback);
    if (valid) matches.push(valid);
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  warn(
    `[supervisor] filesystem fallback declined: ${matches.length} cwd-matching ` +
    `candidates in launch window${prefixForFallback ? ' (prefix matches multiple)' : ' (no prefix to disambiguate)'}`
  );
  return null;
}

interface ThreadHit {
  sessionId: string;
  rolloutPath: string;
  cwd: string;
  cliVersion: string | null;
}

type SqlQueryOutcome =
  | { kind: 'hit'; row: ThreadHit }
  | { kind: 'miss' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'no-db' }
  | { kind: 'schema-mismatch' }
  | { kind: 'sqlite-error' };

let cachedDefaultOpener: CodexStateDbOpener | null | undefined;
function defaultOpener(): CodexStateDbOpener | null {
  if (cachedDefaultOpener !== undefined) return cachedDefaultOpener;
  try {
    // `better-sqlite3` is bundled for Electron; require lazily so this module
    // loads cleanly under plain `node` test runners that opt into a stub opener.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('better-sqlite3');
    const Database = mod && mod.default ? mod.default : mod;
    cachedDefaultOpener = (p: string) => new Database(p, { readonly: true, fileMustExist: true });
  } catch {
    cachedDefaultOpener = null;
  }
  return cachedDefaultOpener;
}

function defaultStatePath(): string {
  return nodePath.join(nodeOs.homedir(), '.codex', 'state_5.sqlite');
}

function queryStateSqlite(opts: {
  statePath?: string;
  opener?: CodexStateDbOpener;
  workingDirectoryNormalized: string;
  launchedAfterSeconds: number;
  firstUserMessagePrefix: string;
}): SqlQueryOutcome {
  const opener = opts.opener ?? defaultOpener();
  if (!opener) return { kind: 'no-db' };
  const dbPath = opts.statePath ?? defaultStatePath();
  let db: CodexStateDb;
  try {
    db = opener(dbPath);
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string } | null;
    const msg = e?.message ?? '';
    if (e?.code === 'SQLITE_CANTOPEN' || /unable to open|no such file|ENOENT/i.test(msg)) {
      return { kind: 'no-db' };
    }
    return { kind: 'sqlite-error' };
  }
  try {
    // REPLACE on a single backslash to forward-slash + LOWER on both sides
    // makes the LIKE match tolerant of Windows `\\?\` prefix, mixed slashes,
    // and drive-letter case variation observed in real codex DB rows.
    // BUG-26 risk 3: fetch up to 2 rows (instead of LIMIT 1) so we can detect
    // ambiguity (concurrent same-cwd+prefix launches) and decline binding
    // rather than silently picking the older row.
    // WP3: match the prompt prefix with a literal starts-with — NOT a LIKE
    // pattern. Topic text is user-influenced; `%`/`_` in a topic must not be
    // interpreted as SQL wildcards and loosen the match (which could bind a
    // lookalike concurrent session). `substr(first_user_message, 1, length(?))
    // = ?` is exact prefix equality; the prefix is bound TWICE (once for the
    // length, once for the comparison), so this query now binds FOUR params:
    // cwdLike, afterSec, prefixForLength, prefixForEquality.
    const stmt = db.prepare(
      "SELECT id, rollout_path, cwd, cli_version FROM threads " +
      "WHERE LOWER(REPLACE(cwd, '\\', '/')) LIKE '%' || ? || '%' " +
      "AND created_at >= ? AND substr(first_user_message, 1, length(?)) = ? " +
      "ORDER BY created_at ASC LIMIT 2"
    );
    const stmtAny = stmt as unknown as { all?(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
    let rows: Array<{ id?: string; rollout_path?: string; cwd?: string; cli_version?: string | null }>;
    if (typeof stmtAny.all === 'function') {
      rows = stmtAny.all(
        opts.workingDirectoryNormalized,
        opts.launchedAfterSeconds,
        opts.firstUserMessagePrefix,
        opts.firstUserMessagePrefix
      ) as Array<{ id?: string; rollout_path?: string; cwd?: string; cli_version?: string | null }>;
    } else {
      // Test-stub compat: only `get` exists. Treat as a single-row API.
      const single = stmtAny.get(
        opts.workingDirectoryNormalized,
        opts.launchedAfterSeconds,
        opts.firstUserMessagePrefix,
        opts.firstUserMessagePrefix
      ) as { id?: string; rollout_path?: string; cwd?: string; cli_version?: string | null } | undefined;
      rows = single ? [single] : [];
    }
    if (rows.length === 0) return { kind: 'miss' };
    if (rows.length > 1) return { kind: 'ambiguous', count: rows.length };
    const row = rows[0];
    if (!row || !row.id || !row.rollout_path) return { kind: 'miss' };
    return {
      kind: 'hit',
      row: {
        sessionId: row.id,
        rolloutPath: row.rollout_path,
        cwd: row.cwd ?? '',
        cliVersion: row.cli_version ?? null,
      },
    };
  } catch (err: unknown) {
    const msg = (err as { message?: string } | null)?.message ?? '';
    if (/no such (column|table)/i.test(msg)) return { kind: 'schema-mismatch' };
    return { kind: 'sqlite-error' };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/**
 * Decision helper: should the launch path take a pre-launch rollout snapshot
 * and run `discoverNewCodexSession` to bind the new agent to the codex-minted
 * session id?
 *
 * - Non-codex providers never need it (claude/gemini handle their own ids).
 * - When `resume` is true, the launch is using an explicit `codex resume <sid>`
 *   subcommand; discovery would be redundant.
 * - All other codex launches discover, INCLUDING `freshSession: true`. The
 *   pre-BUG-26 behavior skipped discovery on `freshSession=true`, but that
 *   left `resumeSessionId` null and forced both the launch path AND
 *   `CodexRolloutReader` to fall back to cwd-as-identity proxy — exactly the
 *   misattribution failure mode BUG-26 reproduced. The race-resistant SQLite
 *   path (cwd + created_at + first_user_message prefix) is correct for
 *   freshSession too: the flag's user-visible intent (clean codex context,
 *   not inheriting a prior rollout) is enforced by codex's CLI omitting
 *   `resume`, not by the dashboard's discovery skip.
 *
 * `freshSession` retained in the signature for caller API stability; it no
 * longer affects the discovery decision.
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

function validateCandidate(
  file: CodexRolloutFile,
  targetCwd: string,
  firstUserMessagePrefix: string | null = null
): DiscoveryResult | null {
  const meta = readCodexSessionMeta(file.path);
  if (!meta.id || meta.id !== file.sessionId) return null;
  if (!meta.cwd || normalizeCwd(meta.cwd) !== targetCwd) return null;
  if (firstUserMessagePrefix !== null) {
    // BUG-26 risk 1: concurrent same-cwd launches make cwd alone insufficient
    // for the filesystem fallback. Walk the rollout for the first
    // event_msg/user_message entry and require the launch prefix matches.
    const firstMsg = readFirstUserMessage(file.path);
    if (firstMsg === null || !firstMsg.startsWith(firstUserMessagePrefix)) {
      return null;
    }
  }
  return {
    sessionId: file.sessionId,
    filename: file.filename,
    path: file.path,
    cwd: meta.cwd,
    cliVersion: meta.cliVersion,
  };
}

// Read the first `event_msg/user_message` payload from a rollout, or null if
// none is present in the first 1 MB / no such line exists. Used by the
// filesystem fallback to validate a concurrent-launch tiebreaker.
function readFirstUserMessage(jsonlPath: string): string | null {
  let fd: number;
  try {
    fd = nodeFs.openSync(jsonlPath, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(1024 * 1024);
    const bytesRead = nodeFs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf-8', 0, bytesRead);
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type === 'event_msg' && entry?.payload?.type === 'user_message') {
          const msg = entry.payload.message;
          if (typeof msg === 'string') return msg;
          return '';
        }
      } catch {
        continue;
      }
    }
    return null;
  } finally {
    try { nodeFs.closeSync(fd); } catch { /* ignore */ }
  }
}

// ── Stale-rollout hardening (sibling bug in
// docs/BUG_claude-child-session-env-poisoning.md) ────────────────────────────
//
// `findCodexSessionIdByCwd` takes the newest cwd-matching rollout. When codex
// is slow to write its new rollout (interactive update prompt, startup race),
// "newest" is a PRE-EXISTING rollout from an older session and the agent
// attaches to a dead chat. The helpers below let recovery callers pre-filter
// the candidate list (via the `listFiles` seam) so only rollouts whose session
// timestamp is at/after the agent's launch — and not already owned by a
// sibling agent — are ever considered.

/** Filename timestamps are written in LOCAL time; allow this much slack for
 *  second-granularity truncation and minor clock skew vs. the launch stamp. */
const CODEX_ROLLOUT_LAUNCH_SLACK_MS = 2_000;

/**
 * Session creation timestamp of a rollout, in epoch ms, or null when neither
 * encoding is parseable.
 *
 * Primary: the session id is a UUIDv7 whose first 48 bits are ms-since-epoch
 * (unambiguous, timezone-free). Fallback: the `rollout-<ts>-<uuid>.jsonl`
 * filename timestamp, parsed as LOCAL time (codex stamps it in local time —
 * verified against live launches on 2026-06-12).
 */
export function codexRolloutSessionTimestampMs(
  filename: string,
  sessionId: string
): number | null {
  const hex = sessionId.replace(/-/g, '').toLowerCase();
  if (/^[0-9a-f]{32}$/.test(hex) && hex[12] === '7') {
    const ms = parseInt(hex.slice(0, 12), 16);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  const m = filename.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/);
  if (m) {
    const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * Pure candidate filter for stale-rollout-safe recovery:
 *  - drops rollouts whose session id is already owned by another agent
 *    (multiple codex agents share one cwd — never steal a sibling's rollout);
 *  - when `launchedAtMs` is set, drops rollouts whose session timestamp
 *    predates it (minus slack), INCLUDING rollouts whose timestamp cannot be
 *    determined — an unverifiable candidate must never be bound under a
 *    freshness requirement.
 * `launchedAtMs: null` disables the freshness floor (legacy behavior).
 */
export function selectFreshCodexRollouts(
  files: CodexRolloutFile[],
  opts: {
    launchedAtMs: number | null;
    excludeSessionIds?: ReadonlySet<string>;
    slackMs?: number;
  }
): CodexRolloutFile[] {
  const slackMs = opts.slackMs ?? CODEX_ROLLOUT_LAUNCH_SLACK_MS;
  return files.filter((file) => {
    if (opts.excludeSessionIds?.has(file.sessionId)) return false;
    if (opts.launchedAtMs == null) return true;
    const ts = codexRolloutSessionTimestampMs(file.filename, file.sessionId);
    if (ts === null) return false;
    return ts >= opts.launchedAtMs - slackMs;
  });
}

function normalizeCwd(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
