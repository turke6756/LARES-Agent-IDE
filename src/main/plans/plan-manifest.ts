// WP-P3-manifest — the `plan.json` no-clobber seam (§P3-MANIFEST-LOCK).
//
// A plan folder's `plan.json` (§R0) is mutated by TWO independent processes: the
// promotion SERVICE (this file, in the app main process) and the planning SKILL's
// shipped helper script (a separate child process the planning worker runs). An
// optimistic content-hash CAS alone cannot close the cross-process window between
// "read + hash" and "atomic rename" — a second process can slip its own rename in
// between. The settled protocol (§P3-MANIFEST-LOCK) closes that window with a
// SIDECAR LOCKFILE, and keeps the CAS as the in-lock consistency check:
//
//   1. Acquire  — atomic exclusive create (`open(…, 'wx')`) of `<folder>/plan.json.lock`
//                 carrying owner identity + a random nonce. Bounded retry with backoff
//                 on contention; exhaustion is a CLEAN error (throwable, never an
//                 uncaught async throw).
//   2. Heartbeat — the holder atomically rewrites `heartbeat_at` (temp-write + rename)
//                 every PLAN_LOCK_HEARTBEAT_MS while the mutation is in flight. A live
//                 owner renews indefinitely; there is no hard TTL on a healthy holder.
//   3. Stale reclaim — a contender may reclaim ONLY when
//                 `now − heartbeat_at > PLAN_LOCK_STALE_MS`. Reclaim is rename-based and
//                 race-safe: rename the stale lock to a tombstone (`plan.json.lock.stale-<nonce>`),
//                 then re-enter acquire — exactly one racer wins the rename; losers
//                 re-enter cleanly. Tombstones are best-effort deleted.
//   4. Release  — the holder verifies its OWN nonce, then deletes the lock. If the lock
//                 was reclaimed out from under it (nonce mismatch) it deletes nothing.
//   5. In-lock mutation — an in-process async mutex (keyed by the resolved folder path)
//                 plus the expected-hash CAS: read → parse → transform → re-read guard →
//                 temp-write → fsync → atomic rename. The guard re-read preserves a
//                 concurrent (mis-behaving, non-locking) writer's `responsibility_events`.
//                 Never truncate/clobber; never a shell redirect.
//
// Containment: the API takes the plans-home ROOT (`<workspaceStateDir()>/plans`) plus a
// RELATIVE folder path; it resolves both, requires the resolved folder to stay beneath
// the root, and rejects symlink/junction escapes (realpath-verified). An absent path is
// a clean error, not an uncaught throw.
//
// Non-goals (this file): no scaffold, no DB, no dispatch, no IPC. The skill-side helper
// implements the SAME protocol per its own (P0A/P0C) brief; it is not authored here.
//
//   npm run build:main
//   node dist/main/main/plans/plan-manifest.test.js

import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

// ── Tunable constants (§P3-MANIFEST-LOCK). Exported so tests drive timing-sensitive
//    behaviour with injected values, never real multi-second waits. Each API also
//    accepts a per-call `tuning` override so a test never mutates shared module state.
export const PLAN_LOCK_HEARTBEAT_MS = 2000;
export const PLAN_LOCK_STALE_MS = 15000;
/** Wall-clock budget for a single acquire before a clean lock-timeout error. */
export const PLAN_LOCK_ACQUIRE_TIMEOUT_MS = 10000;
/** Base for the (jittered, capped) exponential backoff between acquire attempts. */
export const PLAN_LOCK_RETRY_BASE_MS = 25;
/** Upper bound on a single backoff sleep. */
export const PLAN_LOCK_RETRY_MAX_MS = 250;
/** Default number of in-lock CAS re-read retries when the guard read finds drift. */
export const PLAN_CAS_MAX_RETRIES = 5;

export interface LockTuning {
  heartbeatMs: number;
  staleMs: number;
  acquireTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxRetries: number;
}

function resolveTuning(opts?: Partial<LockTuning>): LockTuning {
  return {
    heartbeatMs: opts?.heartbeatMs ?? PLAN_LOCK_HEARTBEAT_MS,
    staleMs: opts?.staleMs ?? PLAN_LOCK_STALE_MS,
    acquireTimeoutMs: opts?.acquireTimeoutMs ?? PLAN_LOCK_ACQUIRE_TIMEOUT_MS,
    retryBaseMs: opts?.retryBaseMs ?? PLAN_LOCK_RETRY_BASE_MS,
    retryMaxMs: opts?.retryMaxMs ?? PLAN_LOCK_RETRY_MAX_MS,
    maxRetries: opts?.maxRetries ?? PLAN_CAS_MAX_RETRIES,
  };
}

// ── Clean, catchable error surface. Every failure this module raises is a
//    PlanManifestError with a stable `code`; nothing escapes as an uncaught async throw.
export type PlanManifestErrorCode =
  | 'containment' // resolved folder escapes the plans-home root (path or symlink)
  | 'not-found' // the plan folder / plan.json is absent
  | 'malformed' // plan.json is not valid JSON / not an object
  | 'lock-timeout' // acquire exhausted its bounded retry while a live holder kept the lock
  | 'cas-exhausted' // the in-lock CAS kept losing the guard re-read (a rogue writer churned the file)
  | 'invalid-arg'; // caller-supplied argument is unusable (e.g. absolute rel path, bad event)

export class PlanManifestError extends Error {
  readonly code: PlanManifestErrorCode;
  constructor(code: PlanManifestErrorCode, message: string) {
    super(message);
    this.name = 'PlanManifestError';
    this.code = code;
  }
}

// ── §R0 manifest shapes (only the fields this seam reads/writes).
export interface ResponsibilityEvent {
  event_id: string;
  event: 'assigned' | string;
  agent_id: string;
  display?: string;
  at: number;
  source: 'manual-skill' | 'promotion-service' | string;
}

export interface PlanManifest {
  schema_version?: number;
  plan_artifact_id?: string;
  plan_sku?: string;
  source_proposal?: { artifact_id?: string; rel_path?: string };
  responsibility_events?: ResponsibilityEvent[];
  created_at?: number;
  updated_at?: number;
  [k: string]: unknown;
}

export interface CasResult<T = PlanManifest> {
  /** True when a new plan.json was written; false when the transform was a no-op. */
  changed: boolean;
  /** The manifest as it now stands on disk (post-write, or the read value on a no-op). */
  manifest: T;
  /** sha256 of the exact bytes now on disk. */
  hash: string;
}

export interface CasMutateOpts extends Partial<LockTuning> {
  /** Owner identity written into the lockfile. */
  ownerKind?: 'service' | 'skill';
  ownerId?: string;
  /**
   * Advisory expected content-hash of the manifest the caller last read. Recorded on
   * the result via `expectedHashMatched`; NEVER a hard gate — an idempotent/mergeable
   * transform is always applied against the FRESH on-disk manifest so a concurrent
   * writer's events are preserved (no-clobber), rather than failing the append.
   */
  expectedHash?: string;
  /**
   * Test-only seam: invoked with the plan.json path after each in-lock read, before the
   * transform. Lets a test simulate a rogue concurrent writer to exercise the guard
   * re-read / cas-exhausted path. Not used by production callers.
   */
  onAfterRead?: (planJsonPath: string) => void | Promise<void>;
}

// The transform receives a deep copy of the current manifest and returns the next
// manifest, or null/undefined to signal a no-op (idempotent short-circuit).
export type ManifestTransform = (
  current: PlanManifest,
) => PlanManifest | null | undefined | Promise<PlanManifest | null | undefined>;

// ─────────────────────────────────────────────────────────────────────────────
// Containment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve `<plansHomeRoot>/<planFolderRelPath>` to an absolute, real path, requiring
 * it to stay beneath the plans-home root both lexically AND after realpath resolution
 * (so a symlink/junction cannot escape). Throws PlanManifestError('containment') on
 * escape and ('not-found') when the folder is absent — never an uncaught throw.
 */
export async function resolvePlanFolder(
  plansHomeRoot: string,
  planFolderRelPath: string,
): Promise<string> {
  if (typeof planFolderRelPath !== 'string' || planFolderRelPath.length === 0) {
    throw new PlanManifestError('invalid-arg', 'planFolderRelPath must be a non-empty string');
  }
  if (path.isAbsolute(planFolderRelPath)) {
    throw new PlanManifestError(
      'containment',
      `planFolderRelPath must be relative, got absolute: ${planFolderRelPath}`,
    );
  }
  const home = path.resolve(plansHomeRoot);
  const target = path.resolve(home, planFolderRelPath);

  // Lexical containment first — rejects `..` traversal before any fs touch.
  const lexRel = path.relative(home, target);
  if (lexRel === '' || lexRel.startsWith('..') || path.isAbsolute(lexRel)) {
    throw new PlanManifestError(
      'containment',
      `resolved folder escapes plans-home root: ${planFolderRelPath}`,
    );
  }

  // Realpath the root (must exist) and the target, then re-check containment on the
  // real paths so a symlink/junction inside the tree cannot point outside it.
  let realHome: string;
  try {
    realHome = await fs.realpath(home);
  } catch (err) {
    throw wrapFsError(err, 'not-found', `plans-home root is not accessible: ${home}`);
  }
  let realTarget: string;
  try {
    realTarget = await fs.realpath(target);
  } catch (err) {
    throw wrapFsError(err, 'not-found', `plan folder is not accessible: ${planFolderRelPath}`);
  }
  const realRel = path.relative(realHome, realTarget);
  if (realRel === '' || realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new PlanManifestError(
      'containment',
      `plan folder resolves outside plans-home root (symlink/junction escape): ${planFolderRelPath}`,
    );
  }
  return realTarget;
}

function wrapFsError(err: unknown, absentCode: PlanManifestErrorCode, msg: string): PlanManifestError {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new PlanManifestError(absentCode, msg);
  // Any other fs error is surfaced cleanly too — the containment/mutate APIs never
  // leak a raw uncaught rejection.
  return new PlanManifestError(absentCode, `${msg} (${code ?? (err as Error)?.message ?? 'unknown'})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidecar lockfile
// ─────────────────────────────────────────────────────────────────────────────

export interface LockRecord {
  owner_kind: 'service' | 'skill' | string;
  owner_id: string;
  pid: number;
  nonce: string;
  acquired_at: number;
  heartbeat_at: number;
}

export interface LockHandle {
  lockPath: string;
  nonce: string;
  record: LockRecord;
  /** Stop the heartbeat renewal. Idempotent. */
  stopHeartbeat(): void;
}

function sleep(ms: number): Promise<void> {
  // REF'd deliberately: a caller is awaiting the acquire this backoff belongs to, so the
  // process must stay alive until the (bounded) acquire resolves — an unref'd backoff
  // would let the event loop drain and the app exit mid-acquisition.
  return new Promise((res) => {
    setTimeout(res, ms);
  });
}

function backoffDelay(attempt: number, tuning: LockTuning): number {
  const exp = Math.min(tuning.retryBaseMs * 2 ** attempt, tuning.retryMaxMs);
  // Full jitter so a swarm of racing contenders de-synchronises.
  return Math.floor(Math.random() * exp);
}

function newNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Run an atomic fs op (rename/rm) that can hit a transient Windows sharing violation when
 * another handle briefly touches the target, retrying a few times with a tiny wait before
 * giving up. Used on the load-bearing plan.json rename and the lock removal.
 */
async function withFsRetry<T>(op: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || !isContentionError(code)) throw err;
      lastErr = err;
      await sleep(2 + i * 3);
    }
  }
  throw lastErr;
}

/**
 * True for filesystem errors that, on a contended lock file, mean "try again" rather than
 * "give up". Critically on Windows/NTFS a concurrent create/rename/delete of the SAME path
 * surfaces as a sharing violation (EPERM/EACCES/EBUSY) — not EEXIST — so those must be
 * retried as contention, never treated as a fatal acquire failure.
 */
function isContentionError(code: string | undefined): boolean {
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/**
 * Acquire the sidecar lock for `lockPath`. Bounded retry with jittered backoff; a live
 * holder (fresh heartbeat) forces a clean lock-timeout on exhaustion, a dead holder is
 * reclaimed race-safely. The returned handle heartbeats until released.
 */
export async function acquirePlanLock(
  lockPath: string,
  owner: { owner_kind: 'service' | 'skill'; owner_id: string },
  opts?: Partial<LockTuning>,
): Promise<LockHandle> {
  const tuning = resolveTuning(opts);
  const nonce = newNonce();
  const deadline = Date.now() + tuning.acquireTimeoutMs;
  let attempt = 0;

  for (;;) {
    const now = Date.now();
    const record: LockRecord = {
      owner_kind: owner.owner_kind,
      owner_id: owner.owner_id,
      pid: process.pid,
      nonce,
      acquired_at: now,
      heartbeat_at: now,
    };
    try {
      // Atomic exclusive create — the acquire primitive. Fails EEXIST when held.
      const fh = await fs.open(lockPath, 'wx');
      try {
        await fh.writeFile(JSON.stringify(record));
        await fh.sync();
      } finally {
        await fh.close();
      }
      return startHeartbeat(lockPath, record, tuning);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!isContentionError(code)) {
        // A genuinely unexpected fs error (e.g. parent dir missing) — surface it cleanly.
        throw new PlanManifestError('lock-timeout', `lock acquire failed for ${lockPath}: ${code ?? (err as Error)?.message}`);
      }
      // Contended (EEXIST, or a Windows sharing violation on a concurrent create/rename).
      // Only EEXIST means the file definitively exists → eligible for stale reclaim; the
      // sharing-violation codes are transient, so just back off and retry.
      if (code === 'EEXIST') {
        const reclaimed = await tryReclaimStaleLock(lockPath, tuning);
        if (reclaimed) continue; // reclaimed a dead holder → retry create at once
      }
      if (Date.now() >= deadline) {
        throw new PlanManifestError(
          'lock-timeout',
          `lock acquire timed out after ${tuning.acquireTimeoutMs}ms (held by a live owner): ${lockPath}`,
        );
      }
      await sleep(backoffDelay(attempt++, tuning));
    }
  }
}

/**
 * Attempt to reclaim a stale lock. Returns true iff THIS caller won the reclaim (and the
 * lock path is now free for a fresh 'wx' create). Race-safe.
 *
 * A BARE rename-to-tombstone race is NOT sufficient: a contender that read the victim as
 * stale can wake after the victim was already reclaimed and a FRESH live lock installed in
 * its place — its rename would then steal that fresh lock, transiently emptying lockPath
 * and breaking mutual exclusion (a stolen holder's heartbeat would even clobber the new
 * holder back). So reclaimers of a given victim are SERIALIZED by an exclusive per-victim
 * claim marker (`plan.json.lock.reclaim-<victim-nonce>`): exactly one contender performs
 * the confirm → tombstone → remove sequence. While the stale victim is still present, no
 * 'wx' create can install a fresh lock and no other reclaimer can act, so the sequence can
 * never grab a fresh lock. The confirmed-stale victim is then rename-tombstoned
 * (`plan.json.lock.stale-<victim-nonce>`) and dropped — the settled §P3-MANIFEST-LOCK
 * rename-based reclaim, made race-safe by the serializing claim. Losers of the claim
 * re-enter acquire cleanly.
 *
 * Crash note: a reclaimer hard-killed inside its ~sub-ms critical section can orphan a
 * claim marker for one victim nonce; that single dead lock then resists reclaim until the
 * marker is cleared. This is outside the stated acceptance (racing LIVE contenders) and is
 * greppable/clearable; broader crash recovery is WP-P3-reconcile's remit.
 */
async function tryReclaimStaleLock(lockPath: string, tuning: LockTuning): Promise<boolean> {
  let record: LockRecord | null = null;
  try {
    record = JSON.parse(await fs.readFile(lockPath, 'utf8')) as LockRecord;
  } catch {
    // Unreadable or mid-write (a heartbeat rename in flight) — do NOT reclaim; back off.
    return false;
  }
  if (!record || typeof record.heartbeat_at !== 'number' || typeof record.nonce !== 'string') {
    // Malformed lock body: refuse to guess liveness; let the caller back off. (A truly
    // orphaned malformed lock is cleared by an operator, not silently stolen.)
    return false;
  }
  if (Date.now() - record.heartbeat_at <= tuning.staleMs) {
    return false; // still live — a healthy heartbeat within the stale window
  }

  // Exclusive per-victim reclaim claim — the serializer. Losers back off.
  const claim = `${lockPath}.reclaim-${record.nonce}`;
  try {
    const fh = await fs.open(claim, 'wx');
    await fh.close();
  } catch {
    return false; // another contender owns this victim's reclaim (or transient) → back off
  }
  try {
    // Re-confirm the victim is unchanged right before acting. Under the claim, nothing else
    // can have replaced it, so this simply rejects the case where it was ALREADY reclaimed.
    let cur: LockRecord | null = null;
    try {
      cur = JSON.parse(await fs.readFile(lockPath, 'utf8')) as LockRecord;
    } catch {
      cur = null;
    }
    if (
      !cur ||
      cur.nonce !== record.nonce ||
      typeof cur.heartbeat_at !== 'number' ||
      Date.now() - cur.heartbeat_at <= tuning.staleMs
    ) {
      return false; // already reclaimed/replaced by someone else → nothing to do
    }
    // Rename the confirmed-stale victim to a tombstone, then drop it. Claim-serialized, so
    // this cannot race another reclaimer or a fresh 'wx' install.
    const tombstone = `${lockPath}.stale-${record.nonce}`;
    try {
      await fs.rename(lockPath, tombstone);
    } catch {
      return false;
    }
    fs.rm(tombstone, { force: true }).catch(() => {});
    return true; // caller re-enters acquire and 'wx'-creates a fresh lock
  } finally {
    fs.rm(claim, { force: true }).catch(() => {});
  }
}

function startHeartbeat(lockPath: string, record: LockRecord, tuning: LockTuning): LockHandle {
  let stopped = false;
  let writing = false;
  const timer = setInterval(() => {
    if (stopped || writing) return;
    writing = true;
    void renewHeartbeat(lockPath, record)
      .then((stillOurs) => {
        // Ownership-verified: if the lock on disk is no longer ours (we stalled past the
        // stale window and were reclaimed), STOP renewing — a renew would rename our
        // buffer over the new holder and clobber it.
        if (!stillOurs) {
          stopped = true;
          clearInterval(timer);
        }
      })
      .catch(() => {
        /* a transient heartbeat write failure is non-fatal; the next tick retries. If
           the holder truly dies, the interval stops and staleness eventually trips. */
      })
      .finally(() => {
        writing = false;
      });
  }, tuning.heartbeatMs);
  // The heartbeat must never keep the process alive on its own.
  (timer as { unref?: () => void })?.unref?.();

  return {
    lockPath,
    nonce: record.nonce,
    record,
    stopHeartbeat() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Atomically rewrite `heartbeat_at` via temp-write + rename (never a truncating write).
 * Returns false when the lock is no longer ours (reclaimed) — the caller must then stop
 * heartbeating so it does not clobber the new holder.
 */
async function renewHeartbeat(lockPath: string, record: LockRecord): Promise<boolean> {
  // Ownership check: only renew if the current on-disk lock still carries our nonce.
  try {
    const cur = JSON.parse(await fs.readFile(lockPath, 'utf8')) as LockRecord;
    if (!cur || cur.nonce !== record.nonce) return false;
  } catch {
    // Lock vanished/unreadable — treat as lost; stop renewing.
    return false;
  }
  record.heartbeat_at = Date.now();
  const tmp = `${lockPath}.hb-${record.nonce}`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(record));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, lockPath); // atomic replace
  return true;
}

/**
 * Release a held lock: stop the heartbeat, verify OUR nonce is still the one on disk,
 * then delete. If the lock was reclaimed out from under us (nonce mismatch) we delete
 * nothing — the current holder owns it. Returns whether this call removed the lock.
 */
export async function releasePlanLock(handle: LockHandle): Promise<{ released: boolean; reason?: string }> {
  handle.stopHeartbeat();
  let onDisk: LockRecord | null = null;
  try {
    onDisk = JSON.parse(await fs.readFile(handle.lockPath, 'utf8')) as LockRecord;
  } catch {
    // Already gone (or unreadable) — nothing to release.
    return { released: false, reason: 'absent' };
  }
  if (!onDisk || onDisk.nonce !== handle.nonce) {
    return { released: false, reason: 'nonce-mismatch' };
  }
  await withFsRetry(() => fs.rm(handle.lockPath, { force: true }));
  return { released: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// In-process folder mutex (serialises same-process CAS callers on one folder so they
// never self-contend on the sidecar lock).
// ─────────────────────────────────────────────────────────────────────────────

const folderChains = new Map<string, Promise<unknown>>();

async function withFolderMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = folderChains.get(key) ?? Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((res) => {
    releaseGate = res;
  });
  // The next waiter cannot run until this gate settles.
  const mine = prev.then(() => gate);
  folderChains.set(key, mine);
  await prev.catch(() => {}); // wait our turn; a prior failure never poisons the queue
  try {
    return await fn();
  } finally {
    releaseGate();
    if (folderChains.get(key) === mine) folderChains.delete(key);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CAS mutation (in-lock)
// ─────────────────────────────────────────────────────────────────────────────

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Lock-wrapped compare-and-swap mutation of `<folder>/plan.json`. Acquires the sidecar
 * lock, then (under an in-process folder mutex) reads → transforms → guard-re-reads →
 * temp-writes → fsyncs → atomically renames. The guard re-read preserves a concurrent
 * (non-locking) writer's edits: on drift it re-reads fresh and re-applies the transform.
 * A no-op transform (returns null/undefined) writes nothing. Every failure is a clean
 * PlanManifestError.
 */
export async function casMutate(
  plansHomeRoot: string,
  planFolderRelPath: string,
  transform: ManifestTransform,
  opts: CasMutateOpts = {},
): Promise<CasResult> {
  const tuning = resolveTuning(opts);
  const folder = await resolvePlanFolder(plansHomeRoot, planFolderRelPath);
  const planJsonPath = path.join(folder, 'plan.json');
  const lockPath = path.join(folder, 'plan.json.lock');
  const owner = {
    owner_kind: (opts.ownerKind ?? 'service') as 'service' | 'skill',
    owner_id: opts.ownerId ?? `service:pid-${process.pid}`,
  };

  return withFolderMutex(folder, async () => {
    const handle = await acquirePlanLock(lockPath, owner, tuning);
    try {
      return await casWriteLoop(planJsonPath, transform, tuning, handle.nonce, opts);
    } finally {
      await releasePlanLock(handle);
    }
  });
}

async function casWriteLoop(
  planJsonPath: string,
  transform: ManifestTransform,
  tuning: LockTuning,
  nonce: string,
  opts: CasMutateOpts,
): Promise<CasResult> {
  for (let attempt = 0; attempt <= tuning.maxRetries; attempt++) {
    const raw = await readManifestRaw(planJsonPath);
    const manifest = parseManifest(raw, planJsonPath);
    const baseHash = sha256(raw);

    // Test-only rogue-writer seam.
    if (opts.onAfterRead) await opts.onAfterRead(planJsonPath);

    const next = await transform(structuredClone(manifest));
    if (next === null || next === undefined) {
      // Idempotent no-op: nothing to write.
      return { changed: false, manifest, hash: baseHash };
    }
    next.updated_at = Date.now();
    const serialized = `${JSON.stringify(next, null, 2)}\n`;

    // Guard re-read: if the bytes moved under us (a rogue non-locking writer), re-apply
    // against the fresh manifest so their edits survive.
    const guard = await readManifestRaw(planJsonPath);
    if (sha256(guard) !== baseHash) continue;

    await atomicWrite(planJsonPath, serialized, nonce, attempt);
    return { changed: true, manifest: next, hash: sha256(serialized) };
  }
  throw new PlanManifestError(
    'cas-exhausted',
    `plan.json CAS exhausted ${tuning.maxRetries} retries under concurrent churn: ${planJsonPath}`,
  );
}

async function readManifestRaw(planJsonPath: string): Promise<string> {
  try {
    return await fs.readFile(planJsonPath, 'utf8');
  } catch (err) {
    throw wrapFsError(err, 'not-found', `plan.json not found: ${planJsonPath}`);
  }
}

function parseManifest(raw: string, planJsonPath: string): PlanManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PlanManifestError('malformed', `plan.json is not valid JSON: ${planJsonPath}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PlanManifestError('malformed', `plan.json is not a JSON object: ${planJsonPath}`);
  }
  return parsed as PlanManifest;
}

/** temp-write → fsync → atomic rename. Never truncates the live plan.json in place. */
async function atomicWrite(planJsonPath: string, contents: string, nonce: string, attempt: number): Promise<void> {
  const tmp = `${planJsonPath}.tmp-${nonce}-${attempt}`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(contents);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await withFsRetry(() => fs.rename(tmp, planJsonPath));
}

// ─────────────────────────────────────────────────────────────────────────────
// Responsibility-event append (idempotent by event_id)
// ─────────────────────────────────────────────────────────────────────────────

export interface AppendResponsibilityOpts extends Partial<LockTuning> {
  ownerKind?: 'service' | 'skill';
  ownerId?: string;
  expectedHash?: string;
  onAfterRead?: (planJsonPath: string) => void | Promise<void>;
}

/**
 * Append a responsibility event to `plan.json`, lock-wrapped and idempotent by
 * `event_id`: re-appending the same `event_id` is a no-op (never a duplicate). Preserves
 * every event already present (including any a concurrent writer added). Returns whether
 * the append actually wrote (false when the event was already present).
 */
export async function casAppendResponsibilityEvent(
  plansHomeRoot: string,
  planFolderRelPath: string,
  event: ResponsibilityEvent,
  opts: AppendResponsibilityOpts = {},
): Promise<CasResult> {
  if (!event || typeof event.event_id !== 'string' || event.event_id.length === 0) {
    throw new PlanManifestError('invalid-arg', 'responsibility event requires a non-empty event_id');
  }
  const transform: ManifestTransform = (current) => {
    const events = Array.isArray(current.responsibility_events)
      ? current.responsibility_events
      : [];
    if (events.some((e) => e && e.event_id === event.event_id)) {
      return null; // idempotent: already recorded → no-op
    }
    return { ...current, responsibility_events: [...events, event] };
  };
  return casMutate(plansHomeRoot, planFolderRelPath, transform, opts);
}
