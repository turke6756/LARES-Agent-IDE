#!/usr/bin/env node
// plan-manifest.mjs — the proposal-to-plan skill's ONLY write path for plan.json,
// plus the atomic complete-folder scaffold and a read-only inspect dump.
//
//   scaffold  build the COMPLETE §R0 folder (plan.json + plan.md + ARC.md + seeded
//             subdirs) in a request-ID-qualified temp sibling, then ATOMICALLY rename
//             it onto the deterministic target. EEXIST → defer to orient:
//               matching source_proposal.artifact_id → resume (exit 0, action=resume)
//               mismatching                          → collision, BLOCK (exit 3)
//   manifest  ALL plan.json creation/mutation under §P3-MANIFEST-LOCK — owner+nonce
//             `wx` acquire, 2s heartbeat, 15s stale reclaim, CAS inside the lock.
//             Lock exhaustion → clean blocking error (exit 4); NEVER a direct edit.
//   inspect   read-only dump of plan.json + folder listing. NO rung parser.
//
// Pure Node (no deps). Rung derivation is deliberately absent — that is the P1
// reader / P2L ledger's canonical work (recommendation §"plan-manifest.mjs scope").

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SCHEMA_VERSION = 1;
const HEARTBEAT_MS = 2000;      // §P3-MANIFEST-LOCK: refresh cadence
const STALE_MS = 15000;         // §P3-MANIFEST-LOCK: reclaim threshold
const DEFAULT_MAX_WAIT_MS = 20000;
const DEFAULT_POLL_MS = 250;
const CAS_RETRIES = 8;

// ---------- tiny helpers ----------
const hex = (n) => crypto.randomBytes(n).toString('hex');
const nowMs = () => Date.now();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}
function die(code, msg, extra) {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  if (extra) process.stderr.write(extra.endsWith('\n') ? extra : extra + '\n');
  process.exit(code);
}
function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { a[k] = true; }
      else { a[k] = next; i++; }
    } else a._.push(t);
  }
  return a;
}

// ---------- minimal YAML frontmatter reader (proposal artifact_id/title) ----------
function readFrontmatter(mdPath) {
  const raw = fs.readFileSync(mdPath, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fm = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { fm, raw };
}

// deterministic identity: plan_<proposal-artifact-hex>
function deriveIdentity(fm, args) {
  const propArtifact = args['proposal-artifact-id'] || fm.artifact_id;
  if (!propArtifact) die(2, 'scaffold: proposal has no artifact_id (frontmatter) and --proposal-artifact-id not given');
  const propHex = String(propArtifact).replace(/^prop_/, '');
  const planArtifactId = 'plan_' + propHex;
  const artifactShort = propHex.slice(0, 8);
  const date = args.date || fm.authored_at?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const slug = args.slug || slugify(fm.title || 'plan');
  const planSku = `${date}-${slug}-${artifactShort}`;
  return { propArtifact, planArtifactId, artifactShort, date, slug, planSku };
}
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'plan';
}

// ---------- the lock (§P3-MANIFEST-LOCK) ----------
// This is the SKILL-side mirror of src/main/plans/plan-manifest.ts. It MUST stay
// behaviorally interoperable with that service implementation: same lock path
// (`<dir>/plan.json.lock`), same lock-record schema (owner_kind/owner_id/pid/nonce/
// acquired_at/heartbeat_at — `heartbeat_at`, NOT a short `hb`, so a service holder's
// freshness is read correctly cross-process), same 2s heartbeat / 15s stale window,
// and — critically — the SAME claim-marker + tombstone naming, so a skill contender
// and a service contender racing to reclaim ONE stale lock serialize against each
// other instead of both acting.
class LockExhaustion extends Error {}

// On Windows/NTFS a concurrent create/rename/delete of the SAME path surfaces as a
// sharing violation (EPERM/EACCES/EBUSY) — NOT EEXIST — so those are contention to
// retry, never a fatal acquire failure. (Mirrors plan-manifest.ts isContentionError.)
function isContentionError(code) {
  return code === 'EEXIST' || code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

// Run an atomic fs op (rename/unlink) that can hit a transient Windows sharing
// violation, retrying a few times with a tiny wait before giving up. ENOENT is
// terminal (nothing there). Mirrors plan-manifest.ts withFsRetry.
function withFsRetrySync(op, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return op(); }
    catch (e) {
      if (e.code === 'ENOENT' || !isContentionError(e.code)) throw e;
      lastErr = e;
      sleepSync(2 + i * 3);
    }
  }
  throw lastErr;
}

function acquireLock(lockPath, opts) {
  const maxWaitMs = Number(opts['max-wait-ms'] ?? opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const pollMs = Number(opts['poll-ms'] ?? opts.pollMs ?? DEFAULT_POLL_MS);
  const ownerKind = opts.ownerKind || opts['owner-kind'] || 'skill';
  const ownerId = opts.ownerId || opts['owner-id'] || ('skill:pid-' + process.pid);
  const nonce = hex(16);
  const deadline = nowMs() + maxWaitMs;
  for (;;) {
    const now = nowMs();
    const record = { owner_kind: ownerKind, owner_id: ownerId, pid: process.pid, nonce, acquired_at: now, heartbeat_at: now };
    try {
      const fd = fs.openSync(lockPath, 'wx');           // atomic exclusive create — the acquire primitive
      try { fs.writeSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      return { ownerKind, ownerId, nonce, lockPath, record };
    } catch (e) {
      if (!isContentionError(e.code)) throw e;          // genuinely unexpected fs error → surface it
      // Only EEXIST means the file definitively exists → eligible for stale reclaim; the
      // Windows sharing-violation codes are transient, so just back off and retry.
      if (e.code === 'EEXIST' && tryReclaimStaleLock(lockPath)) continue; // reclaimed a dead holder → retry create
      if (nowMs() > deadline) {
        let age = 'unknown';
        try { const h = JSON.parse(fs.readFileSync(lockPath, 'utf8')); if (typeof h.heartbeat_at === 'number') age = String(nowMs() - h.heartbeat_at); } catch { /* torn */ }
        throw new LockExhaustion(
          `plan.json lock is held by a live owner (heartbeat ${age}ms old, < ${STALE_MS}ms stale window). ` +
          `Recovery: retry after the ${STALE_MS}ms stale-reclaim window, or surface to the responsible ` +
          `supervisor. NO direct plan.json edit is performed.`);
      }
      sleepSync(1 + Math.floor(Math.random() * pollMs)); // jittered backoff de-syncs a racing swarm
    }
  }
}

// Attempt to reclaim a stale lock. Returns true iff THIS caller won the reclaim (lock
// path now free for a fresh 'wx' create). Race-safe and cross-implementation-safe.
//
// A BARE read-staleness→unlink race is NOT sufficient: a contender that read the victim
// as stale can wake after the victim was already reclaimed and a FRESH live lock installed
// in its place — its unlink/rename would then steal that fresh lock, transiently emptying
// lockPath and breaking mutual exclusion. So reclaimers of a given victim are SERIALIZED by
// an exclusive per-victim claim marker (`plan.json.lock.reclaim-<victim-nonce>`): exactly
// one contender performs the confirm → tombstone → remove sequence. While the stale victim
// is still present no 'wx' create can install a fresh lock and no other reclaimer can act,
// so the sequence can never grab a fresh lock. Because the claim marker and tombstone use
// the SAME paths as plan-manifest.ts, a skill contender and a service contender racing the
// same victim serialize on the marker across processes. Losers of the claim back off.
function tryReclaimStaleLock(lockPath) {
  let record = null;
  try { record = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
  catch { return false; }                                // unreadable / mid-write heartbeat rename → back off
  if (!record || typeof record.heartbeat_at !== 'number' || typeof record.nonce !== 'string') return false;
  if (nowMs() - record.heartbeat_at <= STALE_MS) return false; // still live — fresh heartbeat

  // Exclusive per-victim reclaim claim — the serializer. Losers back off.
  const claim = lockPath + '.reclaim-' + record.nonce;
  try { fs.closeSync(fs.openSync(claim, 'wx')); }
  catch { return false; }                                // another contender owns this victim's reclaim (or transient)
  try {
    // Re-confirm the victim is unchanged right before acting. Under the claim nothing else
    // can have replaced it, so this only rejects the already-reclaimed case.
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { cur = null; }
    if (!cur || cur.nonce !== record.nonce || typeof cur.heartbeat_at !== 'number' || nowMs() - cur.heartbeat_at <= STALE_MS) {
      return false;                                      // already reclaimed/replaced → nothing to do
    }
    const tombstone = lockPath + '.stale-' + record.nonce;
    try { fs.renameSync(lockPath, tombstone); } catch { return false; }
    try { fs.rmSync(tombstone, { force: true }); } catch { /* best-effort */ }
    return true;                                         // caller re-enters acquire and 'wx'-creates a fresh lock
  } finally {
    try { fs.rmSync(claim, { force: true }); } catch { /* best-effort */ }
  }
}

// Atomically rewrite heartbeat_at (temp-write + rename, never a truncating write) only
// while the on-disk lock still carries OUR nonce. Returns false when the lock is no longer
// ours (reclaimed) so the caller stops heartbeating and never clobbers the new holder.
function heartbeat(lock) {
  try {
    const cur = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
    if (!cur || cur.nonce !== lock.nonce) return false;  // reclaimed out from under us → stop
  } catch { return false; }                              // vanished/unreadable → stop
  lock.record.heartbeat_at = nowMs();
  const tmp = lock.lockPath + '.hb-' + lock.nonce;
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify(lock.record)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, lock.lockPath);                   // atomic replace
  } catch { /* transient write failure is non-fatal; next tick retries */ }
  return true;
}

// Release: verify OUR nonce is still on disk, then delete. If reclaimed out from under us
// (nonce mismatch) delete nothing — the current holder owns it.
function releaseLock(lock) {
  try {
    const cur = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8'));
    if (!cur || cur.nonce !== lock.nonce) return;        // reclaimed → delete nothing
  } catch { return; }                                    // already gone / unreadable
  try { withFsRetrySync(() => fs.unlinkSync(lock.lockPath)); } catch { /* already gone */ }
}

// Atomic read-modify-write / CAS on plan.json under the lock.
// mutate(obj) returns the mutated object; the write lands only if the on-disk
// hash is unchanged since the read (preserving concurrent responsibility_events).
function withManifestCAS(dir, mutate, opts = {}) {
  const manifestPath = path.join(dir, 'plan.json');
  const lockPath = manifestPath + '.lock';
  const lock = acquireLock(lockPath, opts);
  let hbTimer;
  hbTimer = setInterval(() => { if (heartbeat(lock) === false) clearInterval(hbTimer); }, HEARTBEAT_MS);
  try {
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
      const exists = fs.existsSync(manifestPath);
      const before = exists ? fs.readFileSync(manifestPath, 'utf8') : null;
      const beforeHash = before === null ? null : sha256(before);
      const obj = before === null ? null : JSON.parse(before);

      // test-only: simulate a concurrent writer between read and write, ONCE,
      // to prove the CAS loop re-reads and preserves the intervening append.
      if ((opts['inject-concurrent-append-once'] || opts.injectConcurrentAppendOnce) && attempt === 0 && obj) {
        const inj = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        inj.responsibility_events.push({
          event_id: 'rev_' + hex(6), event: 'assigned', agent_id: 'concurrent-writer',
          display: 'concurrent-writer', at: nowMs(), source: 'promotion-service',
        });
        inj.updated_at = nowMs();
        fs.writeFileSync(manifestPath, JSON.stringify(inj, null, 2) + '\n');
      }

      const next = mutate(obj);
      const serialized = JSON.stringify(next, null, 2) + '\n';

      // CAS check: has the file changed since we read it?
      const cur = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : null;
      const curHash = cur === null ? null : sha256(cur);
      if (curHash !== beforeHash) continue;             // lost the race → re-read + retry

      const tmp = manifestPath + '.wtmp-' + hex(4);
      const fd = fs.openSync(tmp, 'wx');
      fs.writeSync(fd, serialized); fs.fsyncSync(fd); fs.closeSync(fd);
      withFsRetrySync(() => fs.renameSync(tmp, manifestPath)); // tolerate transient Windows sharing violation
      return next;
    }
    throw new Error(`plan.json CAS did not converge after ${CAS_RETRIES} retries (persistent contention).`);
  } finally {
    clearInterval(hbTimer);
    releaseLock(lock);
  }
}

// ---------- scaffold ----------
function buildArcSkeleton({ title, planSku, planArtifactId, verdictLine }) {
  const meta = { last_refreshed_at: nowMs(), source_cutoffs: { folder_mtime_ms: nowMs(), ledger_updated_at: null } };
  return `# ARC — ${title}   (plan_sku: ${planSku} · plan_artifact_id: ${planArtifactId})
<!--ARC-META ${JSON.stringify(meta)} -->
## Decisions
- ${new Date().toISOString().slice(0, 10)} — ${verdictLine}
## Work packages
## Deliberations
## Who did what
`;
}

function cmdScaffold(args) {
  const proposalPath = args.proposal;
  const plansHome = args['plans-home'];
  if (!proposalPath || !plansHome) die(2, 'scaffold: --proposal <flat-proposal.md> and --plans-home <state-dir/plans> required');
  const { fm, raw } = readFrontmatter(proposalPath);
  const id = deriveIdentity(fm, args);
  const target = path.join(plansHome, id.planSku);
  const requestId = args['request-id'] || hex(6);
  const agentId = args['agent-id'] || 'manual-skill-agent';
  const display = args.display || agentId;
  const title = fm.title || id.slug;

  // ----- EEXIST → defer to orient (both branches) -----
  if (fs.existsSync(target)) {
    let occupant = null;
    try { occupant = JSON.parse(fs.readFileSync(path.join(target, 'plan.json'), 'utf8')); } catch { /* malformed occupant */ }
    const occArtifact = occupant?.source_proposal?.artifact_id;
    if (occArtifact && occArtifact === id.propArtifact) {
      out({ action: 'resume', reason: 'EEXIST with matching source_proposal.artifact_id', target, plan_artifact_id: id.planArtifactId });
      return;
    }
    die(3, `scaffold: EEXIST COLLISION — target ${target} is occupied by an unrelated plan ` +
           `(source_proposal.artifact_id=${occArtifact ?? 'unknown/malformed'}, expected ${id.propArtifact}). ` +
           `Blocking; occupant left untouched. Run orient against it.`);
  }

  // ----- build the COMPLETE folder in a request-ID-qualified temp sibling -----
  const tmp = path.join(plansHome, `${id.planSku}.tmp-${requestId}`);
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true }); // resume only our own temp
  fs.mkdirSync(tmp, { recursive: true });
  for (const sub of ['deliberations', 'research', 'supplements']) {
    fs.mkdirSync(path.join(tmp, sub));
    fs.writeFileSync(path.join(tmp, sub, '.gitkeep'), '');
  }
  // plan.md = verbatim copy of the already-marked proposal (carries PLAN-INTENT sentinels)
  fs.writeFileSync(path.join(tmp, 'plan.md'), raw);
  // ARC.md skeleton
  const verdictLine = args['verdict-line'] || 'Hardening scope verdict migrated from the proposal (see ## Hardening scope).';
  fs.writeFileSync(path.join(tmp, 'ARC.md'), buildArcSkeleton({ title, planSku: id.planSku, planArtifactId: id.planArtifactId, verdictLine }));
  // plan.json via the manifest create path (lock on the private temp manifest)
  withManifestCAS(tmp, () => ({
    schema_version: SCHEMA_VERSION,
    plan_artifact_id: id.planArtifactId,
    plan_sku: id.planSku,
    source_proposal: { artifact_id: id.propArtifact, rel_path: toRelProposal(proposalPath) },
    responsibility_events: [{
      event_id: 'rev_' + hex(8), event: 'assigned', agent_id: agentId, display,
      at: nowMs(), source: 'manual-skill',
    }],
    created_at: nowMs(), updated_at: nowMs(),
  }), args);

  // fsync the temp dir, then ATOMIC rename the COMPLETE folder onto the target
  fsyncDir(tmp);
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    // lost a rename race → re-check EEXIST semantics
    if (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'ENOTEMPTY') {
      fs.rmSync(tmp, { recursive: true, force: true });
      die(3, `scaffold: target ${target} appeared during scaffold (rename race). Re-run scaffold; orient decides resume vs. collision.`);
    }
    throw e;
  }
  out({ action: 'scaffolded', target, plan_artifact_id: id.planArtifactId, plan_sku: id.planSku });
}

function toRelProposal(p) {
  const norm = p.replace(/\\/g, '/');
  const i = norm.indexOf('.lares/proposals/');
  return i >= 0 ? norm.slice(i) : path.basename(norm);
}
function fsyncDir(dir) {
  try { const fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); fs.closeSync(fd); }
  catch { /* directory fsync unsupported on some platforms (e.g. Windows) — non-fatal */ }
}

// ---------- manifest (append responsibility / generic CAS) ----------
function cmdManifest(args) {
  const dir = args.dir;
  if (!dir) die(2, 'manifest: --dir <plan-folder> required');
  const manifestPath = path.join(dir, 'plan.json');

  if (args['append-responsibility']) {
    if (!fs.existsSync(manifestPath)) die(2, `manifest: no plan.json at ${manifestPath}`);
    const agentId = args['agent-id'] || die(2, 'manifest --append-responsibility: --agent-id required');
    const display = args.display || agentId;
    const source = args.source || 'manual-skill';
    const eventId = 'rev_' + hex(8);
    try {
      const next = withManifestCAS(dir, (obj) => {
        if (!obj) throw new Error('plan.json is empty/unreadable');
        obj.responsibility_events.push({ event_id: eventId, event: 'assigned', agent_id: agentId, display, at: nowMs(), source });
        obj.updated_at = nowMs();
        return obj;
      }, args);
      out({ action: 'appended', event_id: eventId, responsibility_events: next.responsibility_events.length });
    } catch (e) {
      if (e instanceof LockExhaustion) die(4, 'manifest: LOCK EXHAUSTION — mutation BLOCKED, no direct edit performed.', e.message);
      throw e;
    }
    return;
  }
  die(2, 'manifest: specify --append-responsibility (the only supported mutation in P0).');
}

// ---------- inspect (read-only; NO rung parser) ----------
function cmdInspect(args) {
  const dir = args.dir;
  if (!dir) die(2, 'inspect: --dir <plan-folder> required');
  const manifestPath = path.join(dir, 'plan.json');
  let manifest = null, manifestError = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { manifestError = e.message; }
  const listing = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({
        name: d.name, type: d.isDirectory() ? 'dir' : 'file',
        children: d.isDirectory() ? fs.readdirSync(path.join(dir, d.name)) : undefined,
      }))
    : null;
  const responsible = manifest?.responsibility_events?.length
    ? manifest.responsibility_events[manifest.responsibility_events.length - 1]
    : null;
  out({
    action: 'inspect', dir, manifest, manifest_error: manifestError,
    current_responsible: responsible,     // last `assigned` event = current responsible supervisor
    listing,
    note: 'read-only dump; rung derivation is NOT performed here (P1 reader / P2L ledger owns it).',
  });
}

// ---------- dispatch ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const args = parseArgs(argv.slice(1));
switch (cmd) {
  case 'scaffold': cmdScaffold(args); break;
  case 'manifest': cmdManifest(args); break;
  case 'inspect': cmdInspect(args); break;
  default:
    die(2, `usage: plan-manifest.mjs <scaffold|manifest|inspect> [flags]
  scaffold --proposal <p.md> --plans-home <dir> [--request-id x] [--agent-id x] [--display x] [--slug x] [--date YYYY-MM-DD] [--verdict-line "..."]
  manifest --dir <plan-folder> --append-responsibility --agent-id <id> [--display x] [--source manual-skill|promotion-service]
  inspect  --dir <plan-folder>
lock tuning (manifest/scaffold): --max-wait-ms N --poll-ms N   |   exit codes: 2 usage · 3 collision · 4 lock-exhaustion`);
}
