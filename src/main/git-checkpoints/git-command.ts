// git-command.ts — bounded git exec + binary blob streaming (Git-Native WP-G1.1).
// MAIN-PROCESS ONLY.
//
// The single low-level seam every Lares checkpoint/recovery op shells through.
// Three entry points:
//
//   • runGit(cwd, args, opts)          — bounded, buffered exec of a text-ish git
//                                        command (rev-parse, ls-files, update-index,
//                                        commit-tree, …). Buffers stdout/stderr under
//                                        a byte cap; classifies every failure.
//   • runGitBytes(cwd, args, opts)     — the same bounded exec semantics while
//                                        preserving stdout as authoritative bytes.
//   • runGitBlobToFile(cwd, oid, dst)  — restore's binary path: validates a blob's
//                                        type+size, then STREAMS `cat-file blob` into
//                                        a temp file, never decoding it as text.
//
// Design contract (mirrors the invariants in git-runtime.ts / plan §0):
//   – execFile with an ABSOLUTE git exe + an argument ARRAY. No cmd.exe, no shell,
//     so a leading-dash / spaced / Unicode filename can never be re-split. All
//     pathspecs are the caller's responsibility to place after `--`.
//   – env is always built through git-runtime.buildGitEnv (routing vars stripped,
//     locks/prompt pinned, identity only in commit mode). Our own per-op
//     GIT_INDEX_FILE is injected AFTER sanitizing, never inherited.
//   – Every invocation is bounded: a per-op timeout derived from the SMALLER of an
//     explicit `timeoutMs` and the time left until an absolute `deadlineAt`, with a
//     hard kill on expiry. A hung git degrades one op, never the app.
//   – Failures are classified into a typed GitCommandError so the queue (WP-G1.2)
//     can retry `lock` with backoff and callers can distinguish deadline vs timeout.
//
// The git exe is injectable (`opts.gitExe`) so unit tests pin a real git in a temp
// repo without a discovery round-trip. In production, callers pass the exe from a
// cached `resolveInternalGit()` — resolving per-op would re-run discovery.

import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

import type { GitEnvMode } from '../git/git-runtime';
import { buildGitEnv, resolveInternalGit } from '../git/git-runtime';

/** How much of stderr we keep on a failure — enough to diagnose, bounded so a
 *  pathological error stream never balloons an Error object. */
const STDERR_TAIL_CHARS = 4096;

export type GitErrorKind = 'timeout' | 'lock' | 'nonzero' | 'spawn' | 'deadline';

/** Typed classification of a failed git invocation.
 *   • timeout  — killed because the explicit `timeoutMs` elapsed.
 *   • deadline — killed because the absolute `deadlineAt` elapsed (or it had
 *                already passed before we spawned).
 *   • lock     — process exited non-zero and stderr names a `*.lock` contention
 *                (index.lock / ref lock). Retryable with backoff by the queue.
 *   • nonzero  — process exited non-zero for any other reason (and the caller did
 *                not opt into `allowNonzero`).
 *   • spawn    — the process never ran (missing exe, EACCES, …).
 *  `code` is git's numeric exit code when the process ran, else null. */
export class GitCommandError extends Error {
  readonly kind: GitErrorKind;
  readonly code: number | null;
  readonly stderrTail: string;

  constructor(kind: GitErrorKind, message: string, code: number | null, stderrTail: string) {
    super(message);
    this.name = 'GitCommandError';
    this.kind = kind;
    this.code = code;
    this.stderrTail = stderrTail;
  }
}

/** Why `runGitBlobToFile` rejected before/instead of streaming.
 *   • not-a-blob — the OID resolves to a tree/commit/tag, not a blob.
 *   • over-cap   — the blob's declared size exceeds `maxBytes` (rejected BEFORE any
 *                  streaming — never buffered).
 *   • stream-cap — the stream exceeded `maxBytes` mid-flight (declared size lied);
 *                  defensive backstop. */
export class GitBlobError extends Error {
  readonly reason: 'not-a-blob' | 'over-cap' | 'stream-cap';
  readonly detail: string;

  constructor(reason: GitBlobError['reason'], message: string, detail = '') {
    super(message);
    this.name = 'GitBlobError';
    this.reason = reason;
    this.detail = detail;
  }
}

export interface RunGitOptions {
  /** Explicit per-op timeout in ms. Combined with `deadlineAt` — the smaller wins. */
  timeoutMs?: number;
  /** Absolute wall-clock deadline (epoch ms). Propagated across a compound op so a
   *  late sub-op inherits only the time left, not a fresh full budget. */
  deadlineAt?: number;
  /** Byte cap on buffered stdout+stderr (via execFile `maxBuffer`). Required — an
   *  unbounded git output must never be bufferable. */
  maxBytes: number;
  /** Per-op `GIT_INDEX_FILE` (a Lares-owned temp index, outside `.git/`). Injected
   *  after env sanitization; never inherited from the parent. */
  indexFile?: string;
  /** Env mode for buildGitEnv — 'commit' sets the Lares identity. Default 'read'. */
  mode?: GitEnvMode;
  /** NUL-delimited stdin for plumbing that reads it (update-index --index-info,
   *  check-attr --stdin, hash-object --stdin). Written then closed immediately. */
  stdin?: string | Buffer;
  /** When true, a non-zero exit RESOLVES with the result instead of rejecting.
   *  timeout/deadline/spawn always reject; a `lock` exit always rejects (the queue
   *  needs the typed contention signal) regardless of this flag. */
  allowNonzero?: boolean;
  /** Absolute git exe. Injectable seam for tests; production callers pass the exe
   *  from a cached `resolveInternalGit()`. Defaults to a fresh resolution. */
  gitExe?: string;
  /** Base env to sanitize (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunBytesResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** stderr shapes that mean "someone else holds a git lock" — retryable. */
function looksLikeLock(stderr: string): boolean {
  if (/index\.lock/i.test(stderr)) return true;
  if (/unable to create '[^']*\.lock'/i.test(stderr)) return true;
  if (/cannot lock ref|could not lock|unable to lock/i.test(stderr)) return true;
  if (/\.lock/i.test(stderr) && /file exists/i.test(stderr)) return true;
  return false;
}

function tail(s: string): string {
  return s.length > STDERR_TAIL_CHARS ? s.slice(-STDERR_TAIL_CHARS) : s;
}

/** Resolve the absolute git exe: the injected one, else a fresh internal
 *  resolution. Rejects as a `spawn` error when no compatible git exists. */
async function resolveExe(gitExe: string | undefined): Promise<string> {
  if (gitExe) return gitExe;
  const internal = await resolveInternalGit();
  if (!internal) {
    throw new GitCommandError('spawn', 'No git meeting the version floor is available.', null, '');
  }
  return internal.execPath;
}

/** Build the sanitized env for an op, then inject our own GIT_INDEX_FILE. */
function buildOpEnv(opts: RunGitOptions): NodeJS.ProcessEnv {
  const env = buildGitEnv(opts.env ?? process.env, { mode: opts.mode ?? 'read' });
  if (opts.indexFile) env.GIT_INDEX_FILE = opts.indexFile;
  return env;
}

/** Pick the effective timeout (ms) and the kill-classification for whichever bound
 *  is tighter. Returns null when the op is unbounded. Throws `deadline` when the
 *  absolute deadline has already passed. */
function effectiveTimeout(opts: RunGitOptions): { ms: number; kind: 'timeout' | 'deadline' } | null {
  const now = Date.now();
  if (opts.deadlineAt !== undefined && opts.deadlineAt <= now) {
    throw new GitCommandError('deadline', 'Deadline already elapsed before spawn.', null, '');
  }
  const bounds: { ms: number; kind: 'timeout' | 'deadline' }[] = [];
  if (opts.timeoutMs !== undefined) bounds.push({ ms: opts.timeoutMs, kind: 'timeout' });
  if (opts.deadlineAt !== undefined) bounds.push({ ms: opts.deadlineAt - now, kind: 'deadline' });
  if (bounds.length === 0) return null;
  return bounds.reduce((a, b) => (b.ms < a.ms ? b : a));
}

/**
 * Shared bounded exec implementation. `projectStdout` is the sole distinction
 * between the text and binary public seams.
 */
function runGitBuffered<T>(
  cwd: string,
  args: string[],
  opts: RunGitOptions,
  projectStdout: (stdout: Buffer) => T,
): Promise<{ code: number; stdout: T; stderr: string }> {
  return new Promise<{ code: number; stdout: T; stderr: string }>((resolve, reject) => {
    let limit: { ms: number; kind: 'timeout' | 'deadline' } | null;
    try {
      limit = effectiveTimeout(opts);
    } catch (e) {
      reject(e);
      return;
    }

    void resolveExe(opts.gitExe).then(
      (exe) => {
        let env: NodeJS.ProcessEnv;
        try {
          env = buildOpEnv(opts);
        } catch (e) {
          reject(e instanceof GitCommandError ? e : new GitCommandError('spawn', String(e), null, ''));
          return;
        }

        let killedBy: 'timeout' | 'deadline' | null = null;
        const child = execFile(
          exe,
          args,
          {
            cwd,
            env,
            encoding: 'buffer',
            windowsHide: true,
            maxBuffer: Math.max(1, opts.maxBytes),
            // We manage our own timer so we can classify timeout vs deadline.
            timeout: 0,
          },
          (err, stdoutBuf, stderrBuf) => {
            if (timer) clearTimeout(timer);
            const rawStdout = Buffer.isBuffer(stdoutBuf) ? stdoutBuf : Buffer.from(String(stdoutBuf ?? ''));
            const stdout = projectStdout(rawStdout);
            const stderr = Buffer.isBuffer(stderrBuf) ? stderrBuf.toString('utf8') : String(stderrBuf ?? '');

            if (killedBy) {
              reject(new GitCommandError(killedBy, `git ${args[0] ?? ''} exceeded its ${killedBy}.`, null, tail(stderr)));
              return;
            }

            if (err) {
              const e = err as NodeJS.ErrnoException & { code?: number | string };
              // Numeric code → the process ran and exited non-zero. String code →
              // it never ran (ENOENT/EACCES) or hit an execFile guard (maxBuffer).
              if (typeof e.code === 'number') {
                const code = e.code;
                if (looksLikeLock(stderr)) {
                  reject(new GitCommandError('lock', `git ${args[0] ?? ''} hit a lock.`, code, tail(stderr)));
                  return;
                }
                if (opts.allowNonzero) {
                  resolve({ code, stdout, stderr });
                  return;
                }
                reject(new GitCommandError('nonzero', `git ${args[0] ?? ''} exited ${code}.`, code, tail(stderr)));
                return;
              }
              // maxBuffer overflow is reported with a string code but IS a
              // completed-then-killed process; surface it as a bounded failure.
              if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
                reject(new GitCommandError('nonzero', `git ${args[0] ?? ''} output exceeded maxBytes.`, null, tail(stderr)));
                return;
              }
              reject(new GitCommandError('spawn', `git failed to run: ${e.code ?? e.message}`, null, tail(stderr)));
              return;
            }

            resolve({ code: 0, stdout, stderr });
          },
        );

        const timer = limit
          ? setTimeout(() => {
              killedBy = limit!.kind;
              child.kill('SIGKILL');
            }, Math.max(0, limit.ms))
          : null;
        if (timer && typeof timer.unref === 'function') timer.unref();

        if (opts.stdin !== undefined && child.stdin) {
          child.stdin.on('error', () => {
            /* child may exit before consuming stdin — EPIPE is not fatal here. */
          });
          child.stdin.end(opts.stdin);
        }

        child.on('error', () => {
          /* surfaced through the execFile callback's `err`; swallow the duplicate. */
        });
      },
      (e) => reject(e instanceof GitCommandError ? e : new GitCommandError('spawn', String(e), null, '')),
    );
  });
}

/**
 * Bounded, buffered exec of a git command. Resolves `{ code, stdout, stderr }` on
 * success (and, when `allowNonzero`, on a non-zero exit); otherwise rejects with a
 * classified `GitCommandError`. Never spawns a shell — args are passed verbatim.
 */
export function runGit(cwd: string, args: string[], opts: RunGitOptions): Promise<GitRunResult> {
  return runGitBuffered(cwd, args, opts, (stdout) => stdout.toString('utf8'));
}

/**
 * Binary counterpart to `runGit`. It has identical bounds, environment handling,
 * timeout/deadline behavior, and failure classification, but returns stdout
 * without decoding or otherwise changing Git's authoritative bytes.
 */
export function runGitBytes(cwd: string, args: string[], opts: RunGitOptions): Promise<GitRunBytesResult> {
  return runGitBuffered(cwd, args, opts, (stdout) => stdout);
}

export interface RunGitBlobToFileOptions {
  /** Reject a blob whose declared size exceeds this, BEFORE streaming. Also a
   *  mid-stream backstop. */
  maxBytes: number;
  /** Absolute wall-clock deadline (epoch ms) shared with the validation probes. */
  deadlineAt?: number;
  /** Injectable git exe (see RunGitOptions.gitExe). */
  gitExe?: string;
  /** Base env to sanitize (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Restore's binary path. Validates that `blobOid` is a blob no larger than
 * `maxBytes` (via `cat-file -t` + `-s`), then STREAMS `cat-file blob <oid>` stdout
 * straight into `destTmpPath` — never buffering or decoding the bytes as text —
 * then fsyncs and closes. Returns the byte count only; the caller supplies the file
 * mode from its `ls-tree` entry (a git mode never comes from cat-file).
 *
 * Rejects with `GitBlobError` for a non-blob OID or an over-cap blob (before any
 * streaming), and with `GitCommandError` for spawn/deadline failures.
 */
export async function runGitBlobToFile(
  cwd: string,
  blobOid: string,
  destTmpPath: string,
  opts: RunGitBlobToFileOptions,
): Promise<{ bytesWritten: number }> {
  const exe = await resolveExe(opts.gitExe);

  // 1. Validate type — must be a blob. cat-file exits non-zero for a missing OID.
  const typeRes = await runGit(cwd, ['cat-file', '-t', blobOid], {
    maxBytes: 4096,
    deadlineAt: opts.deadlineAt,
    gitExe: exe,
    env: opts.env,
    allowNonzero: true,
  });
  const type = typeRes.stdout.trim();
  if (typeRes.code !== 0 || type !== 'blob') {
    throw new GitBlobError(
      'not-a-blob',
      `Object ${blobOid} is not a blob (type=${type || 'unknown'}).`,
      typeRes.stderr.trim(),
    );
  }

  // 2. Validate size — reject over-cap BEFORE opening any stream (no buffering).
  const sizeRes = await runGit(cwd, ['cat-file', '-s', blobOid], {
    maxBytes: 4096,
    deadlineAt: opts.deadlineAt,
    gitExe: exe,
    env: opts.env,
  });
  const declaredSize = Number.parseInt(sizeRes.stdout.trim(), 10);
  if (!Number.isFinite(declaredSize) || declaredSize < 0) {
    throw new GitBlobError('not-a-blob', `Object ${blobOid} has an unreadable size.`, sizeRes.stdout.trim());
  }
  if (declaredSize > opts.maxBytes) {
    throw new GitBlobError(
      'over-cap',
      `Blob ${blobOid} is ${declaredSize} bytes, over the ${opts.maxBytes}-byte cap.`,
      String(declaredSize),
    );
  }

  // 3. Stream `cat-file blob <oid>` → destTmpPath, byte-capped + deadline-bounded.
  const env = buildGitEnv(opts.env ?? process.env, { mode: 'read' });
  const now = Date.now();
  if (opts.deadlineAt !== undefined && opts.deadlineAt <= now) {
    throw new GitCommandError('deadline', 'Deadline already elapsed before blob stream.', null, '');
  }
  const remainingMs = opts.deadlineAt !== undefined ? opts.deadlineAt - now : null;

  const child = spawn(exe, ['cat-file', 'blob', blobOid], {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let written = 0;
  let stderrTail = '';
  let killedByDeadline = false;
  let capError: GitBlobError | null = null;

  const timer =
    remainingMs !== null
      ? setTimeout(() => {
          killedByDeadline = true;
          child.kill('SIGKILL');
        }, Math.max(0, remainingMs))
      : null;
  if (timer && typeof timer.unref === 'function') timer.unref();

  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrTail.length < STDERR_TAIL_CHARS) stderrTail += chunk.toString('utf8');
  });

  // Count + cap in a Transform so `pipeline` owns backpressure end-to-end (no
  // manual pause/resume race). On overflow the Transform errors → pipeline
  // rejects → the child is torn down below.
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > opts.maxBytes) {
        capError = new GitBlobError('stream-cap', `Blob stream for ${blobOid} exceeded the ${opts.maxBytes}-byte cap.`);
        cb(capError);
        return;
      }
      cb(null, chunk);
    },
  });

  // Own the fd ourselves (autoClose:false) so we can fsync BEFORE close. A
  // FileHandle-backed stream would ref-count the handle and deadlock its close();
  // a raw fd from a path stream avoids that. Never decoded as text — raw Buffers
  // flow stdout → counter → file.
  const ws = fs.createWriteStream(destTmpPath, { flags: 'w', autoClose: false });
  let fd = -1;
  ws.on('open', (f) => { fd = f; });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) => {
    child.on('close', (code, signal) => res({ code, signal }));
  });

  let ok = false;
  try {
    try {
      await pipeline(child.stdout, counter, ws);
    } catch (err) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      if (killedByDeadline) {
        throw new GitCommandError('deadline', `git cat-file blob for ${blobOid} exceeded its deadline.`, null, tail(stderrTail));
      }
      if (capError) throw capError;
      throw err instanceof Error ? err : new Error(String(err));
    }

    const { code, signal } = await exited;
    if (killedByDeadline) {
      throw new GitCommandError('deadline', `git cat-file blob for ${blobOid} exceeded its deadline.`, null, tail(stderrTail));
    }
    if (code !== 0) {
      throw new GitCommandError(
        'nonzero',
        `git cat-file blob for ${blobOid} exited ${code ?? `signal ${signal}`}.`,
        typeof code === 'number' ? code : null,
        tail(stderrTail),
      );
    }

    if (fd >= 0) await new Promise<void>((res, rej) => fs.fsync(fd, (e) => (e ? rej(e) : res())));
    ok = true;
    return { bytesWritten: written };
  } finally {
    if (timer) clearTimeout(timer);
    if (fd >= 0) await new Promise<void>((res) => fs.close(fd, () => res()));
    if (!ok) await fs.promises.unlink(destTmpPath).catch(() => { /* best-effort */ });
  }
}
