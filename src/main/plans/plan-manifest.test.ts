// WP-P3-manifest tests — the `plan.json` sidecar lockfile + in-lock CAS.
//
// Timing-sensitive lock behaviour is driven with INJECTED tuning (ms-scale), never the
// real 2s/15s defaults, so the suite is fast and deterministic on NTFS. Cross-process
// contention is exercised with a REAL competing child `node` process that requires the
// compiled module and holds the sidecar lock while mutating plan.json — not two
// in-process callers.
//
//   npm run build:main
//   node dist/main/main/plans/plan-manifest.test.js

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  casAppendResponsibilityEvent,
  casMutate,
  acquirePlanLock,
  releasePlanLock,
  resolvePlanFolder,
  PlanManifestError,
  PLAN_LOCK_HEARTBEAT_MS,
  PLAN_LOCK_STALE_MS,
  calculateArcFreshness,
  calculatePlanArcFreshness,
  normalizeArcCutoff,
  type LockTuning,
  type ResponsibilityEvent,
  type PlanManifest,
} from './plan-manifest';

interface TestCase { name: string; run(): Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void>): void { tests.push({ name, run: fn }); }

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Fast tuning for lock tests: everything ms-scale so nothing waits seconds.
const FAST: Partial<LockTuning> = {
  heartbeatMs: 15,
  staleMs: 80,
  acquireTimeoutMs: 4000,
  retryBaseMs: 5,
  retryMaxMs: 20,
  maxRetries: 5,
};

let tmpRoots: string[] = [];

async function makeHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-manifest-'));
  tmpRoots.push(dir);
  const home = path.join(dir, 'plans');
  await fs.mkdir(home, { recursive: true });
  return home;
}

async function scaffoldFolder(home: string, rel: string, artifactHex = 'deadbeef'): Promise<string> {
  const folder = path.join(home, rel);
  await fs.mkdir(folder, { recursive: true });
  const now = Date.now();
  const manifest: PlanManifest = {
    schema_version: 1,
    plan_artifact_id: `plan_${artifactHex}`,
    plan_sku: rel,
    source_proposal: { artifact_id: `prop_${artifactHex}`, rel_path: `.lares/proposals/${rel}.md` },
    responsibility_events: [],
    created_at: now,
    updated_at: now,
  };
  await fs.writeFile(path.join(folder, 'plan.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return folder;
}

async function readManifest(folder: string): Promise<PlanManifest> {
  return JSON.parse(await fs.readFile(path.join(folder, 'plan.json'), 'utf8')) as PlanManifest;
}

function ev(id: string, agent = 'agent-x'): ResponsibilityEvent {
  return { event_id: id, event: 'assigned', agent_id: agent, at: Date.now(), source: 'promotion-service' };
}

async function expectError(fn: () => Promise<unknown>, code: string): Promise<PlanManifestError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof PlanManifestError, `expected PlanManifestError, got ${err}`);
    assert.equal(err.code, code, `expected code '${code}', got '${err.code}'`);
    return err;
  }
  throw new Error(`expected a PlanManifestError('${code}') but the call resolved`);
}

// Path to the compiled sibling module, for the competing child process.
const COMPILED_MODULE = path.join(__dirname, 'plan-manifest.js');

// A tiny child that requires the compiled module and appends an event via casMutate,
// holding the sidecar lock for `holdMs` while it does. Real cross-process contention.
const CHILD_SRC = `
const modPath = process.argv[2];
const [ , , , home, rel, eventId, agentId, holdMs, tuningJson ] = process.argv;
const mod = require(modPath);
const tuning = JSON.parse(tuningJson);
(async () => {
  try {
    await mod.casMutate(home, rel, async (m) => {
      const events = Array.isArray(m.responsibility_events) ? m.responsibility_events : [];
      if (events.some((e) => e && e.event_id === eventId)) return null;
      await new Promise((r) => setTimeout(r, Number(holdMs))); // hold the lock, force contention
      return { ...m, responsibility_events: [...events, {
        event_id: eventId, event: 'assigned', agent_id: agentId, at: Date.now(), source: 'promotion-service',
      }] };
    }, tuning);
    process.exit(0);
  } catch (err) {
    console.error('CHILD_ERR', err && err.message);
    process.exit(1);
  }
})();
`;

let childScriptPath = '';
async function childScript(): Promise<string> {
  if (childScriptPath) return childScriptPath;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-manifest-child-'));
  tmpRoots.push(dir);
  childScriptPath = path.join(dir, 'contend-child.cjs');
  await fs.writeFile(childScriptPath, CHILD_SRC);
  return childScriptPath;
}

function spawnContender(
  home: string, rel: string, eventId: string, agentId: string, holdMs: number, tuning: Partial<LockTuning>, script: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [script, COMPILED_MODULE, home, rel, eventId, agentId, String(holdMs), JSON.stringify(tuning)],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Constants sanity ────────────────────────────────────────────────────────

test('exported defaults match the settled protocol (2s heartbeat / 15s stale)', async () => {
  assert.equal(PLAN_LOCK_HEARTBEAT_MS, 2000);
  assert.equal(PLAN_LOCK_STALE_MS, 15000);
});

// ── ARC freshness ──────────────────────────────────────────────────────────

test('ARC cutoff unit regression — legacy seconds normalize before comparing source milliseconds', async () => {
  const home = await makeHome();
  const folder = await scaffoldFolder(home, '2026-08-03-arc-seconds');
  const cutoffSeconds = 1_786_034_858.657;
  await fs.writeFile(
    path.join(folder, 'ARC.md'),
    `# ARC\n<!--ARC-META ${JSON.stringify({ source_cutoffs: { folder_mtime_ms: cutoffSeconds } })} -->\nold completion prose\n`,
  );
  const source = path.join(folder, 'plan.md');
  await fs.writeFile(source, '# newer source\n');
  await fs.utimes(source, (cutoffSeconds + 10) / 1000, cutoffSeconds + 10);

  const normalized = normalizeArcCutoff(cutoffSeconds);
  assert.equal(normalized?.cutoffUnit, 'seconds');
  assert.equal(normalized?.cutoffMs, cutoffSeconds * 1000);

  const freshness = calculateArcFreshness(folder);
  assert.equal(freshness.cutoffUnit, 'seconds');
  assert.equal(freshness.cutoffMs, cutoffSeconds * 1000);
  assert.equal(freshness.stale, true, 'seconds must be normalized before the source-mtime comparison');
  assert.ok(freshness.sourceMtimeMs > freshness.cutoffMs!);
});

test('ARC freshness scan is read-only, stable, and marks fresh versus stale folders', async () => {
  const home = await makeHome();
  const fresh = await scaffoldFolder(home, 'b-fresh');
  const stale = await scaffoldFolder(home, 'a-stale');
  const writeArc = async (folder: string, cutoff: number): Promise<void> => {
    await fs.writeFile(
      path.join(folder, 'ARC.md'),
      `# ARC\n<!--ARC-META ${JSON.stringify({ source_cutoffs: { folder_mtime_ms: cutoff } })} -->\n`,
    );
  };
  const freshSourceMtime = (await fs.stat(path.join(fresh, 'plan.json'))).mtimeMs;
  const staleSourceMtime = (await fs.stat(path.join(stale, 'plan.json'))).mtimeMs;
  await writeArc(fresh, freshSourceMtime + 1000);
  await writeArc(stale, staleSourceMtime - 1000);
  const before = await Promise.all(
    [fresh, stale].map((folder) => fs.readFile(path.join(folder, 'ARC.md'), 'utf8')),
  );

  const scan = calculatePlanArcFreshness(home);
  assert.deepEqual(scan.map((row) => row.folder), ['a-stale', 'b-fresh']);
  assert.equal(scan[0].freshness.stale, true);
  assert.equal(scan[1].freshness.stale, false);
  const after = await Promise.all(
    [fresh, stale].map((folder) => fs.readFile(path.join(folder, 'ARC.md'), 'utf8')),
  );
  assert.deepEqual(after, before, 'freshness calculation must not rewrite ARC content');
});

test('ARC freshness fails closed when metadata cannot establish currency', async () => {
  const home = await makeHome();
  const folder = await scaffoldFolder(home, 'arc-no-meta');
  await fs.writeFile(path.join(folder, 'ARC.md'), '# ARC without metadata\ncompletion prose\n');
  assert.deepEqual(
    calculateArcFreshness(folder),
    {
      stale: true,
      sourceMtimeMs: (await fs.stat(path.join(folder, 'plan.json'))).mtimeMs,
      storedCutoff: null,
      cutoffMs: null,
      cutoffUnit: null,
      error: 'arc-meta-missing',
    },
  );
});

// ── Basic CAS append ──────────────────────────────────────────────────────────

test('casAppendResponsibilityEvent writes the event and preserves file shape', async () => {
  const home = await makeHome();
  const folder = await scaffoldFolder(home, '2026-08-03-alpha');
  const res = await casAppendResponsibilityEvent(home, '2026-08-03-alpha', ev('rev_a1'), FAST);
  assert.equal(res.changed, true);
  const m = await readManifest(folder);
  assert.equal(m.responsibility_events?.length, 1);
  assert.equal(m.responsibility_events?.[0].event_id, 'rev_a1');
  assert.equal(m.plan_artifact_id, 'plan_deadbeef', 'other manifest fields untouched');
  // lock file removed on release
  await assert.rejects(fs.stat(path.join(folder, 'plan.json.lock')));
});

test('idempotent append by event_id — re-append is a no-op, never a duplicate', async () => {
  const home = await makeHome();
  const folder = await scaffoldFolder(home, '2026-08-03-idem');
  const r1 = await casAppendResponsibilityEvent(home, '2026-08-03-idem', ev('rev_dup'), FAST);
  assert.equal(r1.changed, true);
  const r2 = await casAppendResponsibilityEvent(home, '2026-08-03-idem', ev('rev_dup'), FAST);
  assert.equal(r2.changed, false, 'second append is a no-op');
  const m = await readManifest(folder);
  assert.equal(m.responsibility_events?.length, 1, 'exactly one copy');
});

test('casMutate no-op transform (returns null) writes nothing', async () => {
  const home = await makeHome();
  const folder = await scaffoldFolder(home, '2026-08-03-noop');
  const before = await fs.readFile(path.join(folder, 'plan.json'), 'utf8');
  const res = await casMutate(home, '2026-08-03-noop', () => null, FAST);
  assert.equal(res.changed, false);
  const after = await fs.readFile(path.join(folder, 'plan.json'), 'utf8');
  assert.equal(after, before, 'file byte-identical after a no-op');
});

// ── Containment / symlink rejection ────────────────────────────────────────────

test('containment — a `..` traversal is rejected before any fs write', async () => {
  const home = await makeHome();
  await scaffoldFolder(home, 'inside');
  await expectError(() => casAppendResponsibilityEvent(home, '../escape', ev('x'), FAST), 'containment');
  await expectError(() => resolvePlanFolder(home, '../..'), 'containment');
});

test('containment — an absolute folder path is rejected', async () => {
  const home = await makeHome();
  await expectError(() => resolvePlanFolder(home, path.resolve(home, 'x')), 'containment');
});

test('containment — a junction/symlink escaping the plans-home root is rejected (realpath)', async () => {
  const home = await makeHome();
  // A real target OUTSIDE the plans-home root, containing a plan.json.
  const outsideParent = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-manifest-out-'));
  tmpRoots.push(outsideParent);
  const outside = path.join(outsideParent, 'evil');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'plan.json'), '{"schema_version":1}');
  // A link INSIDE the plans-home root pointing at it. Junction works unelevated on NTFS.
  const linkInside = path.join(home, 'sneaky');
  let linked = true;
  try {
    await fs.symlink(outside, linkInside, 'junction');
  } catch {
    try { await fs.symlink(outside, linkInside, 'dir'); } catch { linked = false; }
  }
  if (!linked) {
    console.warn('  (skipped: this host cannot create a junction/symlink without elevation)');
    return;
  }
  await expectError(() => resolvePlanFolder(home, 'sneaky'), 'containment');
  await expectError(() => casAppendResponsibilityEvent(home, 'sneaky', ev('x'), FAST), 'containment');
});

// ── Malformed / absent ─────────────────────────────────────────────────────────

test('absent plan.json → clean not-found error (not an uncaught throw)', async () => {
  const home = await makeHome();
  await fs.mkdir(path.join(home, 'empty-folder'), { recursive: true });
  await expectError(() => casAppendResponsibilityEvent(home, 'empty-folder', ev('x'), FAST), 'not-found');
});

test('absent plan FOLDER → clean not-found error', async () => {
  const home = await makeHome();
  await expectError(() => casAppendResponsibilityEvent(home, 'never-scaffolded', ev('x'), FAST), 'not-found');
});

test('malformed plan.json → clean malformed error', async () => {
  const home = await makeHome();
  const folder = path.join(home, 'broken');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'plan.json'), '{ this is not json');
  await expectError(() => casAppendResponsibilityEvent(home, 'broken', ev('x'), FAST), 'malformed');
});

test('plan.json that is a JSON array (not an object) → malformed', async () => {
  const home = await makeHome();
  const folder = path.join(home, 'arr');
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'plan.json'), '[]');
  await expectError(() => casAppendResponsibilityEvent(home, 'arr', ev('x'), FAST), 'malformed');
});

// ── Lock: heartbeat keeps it live; contender backs off then times out cleanly ──

test('a second acquirer blocks/backs off while a heartbeat is live, then times out cleanly', async () => {
  const home = await makeHome();
  const folder = await scaffoldFolder(home, 'held');
  const lockPath = path.join(folder, 'plan.json.lock');
  // staleMs (300) is many heartbeats (20ms) — a live holder can never look stale under
  // event-loop jitter, so the contender is forced to time out rather than reclaim.
  const liveTuning = { ...FAST, heartbeatMs: 20, staleMs: 300 };
  const handle = await acquirePlanLock(lockPath, { owner_kind: 'service', owner_id: 'A' }, liveTuning);
  try {
    await delay(150); // several heartbeats keep A fresh
    const err = await expectError(
      () => acquirePlanLock(lockPath, { owner_kind: 'service', owner_id: 'B' }, { ...liveTuning, acquireTimeoutMs: 150 }),
      'lock-timeout',
    );
    assert.match(err.message, /live owner/);
  } finally {
    const rel = await releasePlanLock(handle);
    assert.equal(rel.released, true);
  }
  // After release the lock is free — a fresh acquire succeeds immediately.
  const h2 = await acquirePlanLock(lockPath, { owner_kind: 'service', owner_id: 'C' }, FAST);
  await releasePlanLock(h2);
});

// ── Lock: dead holder reclaimed; racing contenders → one winner, mutual exclusion ──

test('a dead holder is reclaimed; racing contenders never hold simultaneously', async () => {
  const home = await makeHome();
  const folder = await scaffoldFolder(home, 'dead');
  const lockPath = path.join(folder, 'plan.json.lock');
  // Seed a DEEP-stale lock (heartbeat ~1000s in the past), so it is unambiguously past
  // any stale window. The live contenders below use staleMs=1000 with a 25ms heartbeat,
  // so a healthy holder can never look stale under event-loop jitter — only the seeded
  // dead lock is reclaimable, and reclaim must serialize the racers (never two holders).
  const stale = {
    owner_kind: 'service', owner_id: 'ghost', pid: 999999,
    nonce: crypto.randomBytes(8).toString('hex'),
    acquired_at: Date.now() - 1_000_000, heartbeat_at: Date.now() - 1_000_000,
  };
  await fs.writeFile(lockPath, JSON.stringify(stale));

  let held = 0;
  let maxHeld = 0;
  const raceTuning = { ...FAST, heartbeatMs: 25, staleMs: 1000, acquireTimeoutMs: 8000 };
  const contender = async (id: string) => {
    const h = await acquirePlanLock(lockPath, { owner_kind: 'service', owner_id: id }, raceTuning);
    held++;
    maxHeld = Math.max(maxHeld, held);
    await delay(10);
    held--;
    await releasePlanLock(h);
  };
  // Five racers contend the single stale lock at once.
  await Promise.all([contender('a'), contender('b'), contender('c'), contender('d'), contender('e')]);
  assert.equal(maxHeld, 1, 'mutual exclusion: never two holders at once');
  // Final lock removed (last releaser cleaned up).
  await assert.rejects(fs.stat(lockPath));
});

// ── Lock: release verifies nonce ───────────────────────────────────────────────

test('release verifies nonce — will not delete a lock reclaimed out from under it', async () => {
  const home = await makeHome();
  const folder = await scaffoldFolder(home, 'nonce');
  const lockPath = path.join(folder, 'plan.json.lock');
  const handle = await acquirePlanLock(lockPath, { owner_kind: 'service', owner_id: 'A' }, FAST);
  handle.stopHeartbeat(); // freeze so we can simulate a reclaim without renewal racing us
  // Simulate another owner having reclaimed: overwrite the lock with a different nonce.
  const other = { owner_kind: 'skill', owner_id: 'B', pid: 1, nonce: 'different-nonce', acquired_at: Date.now(), heartbeat_at: Date.now() };
  await fs.writeFile(lockPath, JSON.stringify(other));
  const rel = await releasePlanLock(handle);
  assert.equal(rel.released, false);
  assert.equal(rel.reason, 'nonce-mismatch');
  // The other owner's lock is intact — we deleted nothing.
  const still = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  assert.equal(still.nonce, 'different-nonce');
  await fs.rm(lockPath, { force: true });
});

// ── CAS: retry-exhausted clean error under relentless churn ─────────────────────

test('retry-exhausted → clean cas-exhausted error when a rogue writer churns every read', async () => {
  const home = await makeHome();
  const folder = await scaffoldFolder(home, 'churn');
  const planJson = path.join(folder, 'plan.json');
  let n = 0;
  // onAfterRead mutates the file on EVERY attempt, so the guard re-read always differs.
  await expectError(
    () =>
      casAppendResponsibilityEvent(home, 'churn', ev('rev_never'), {
        ...FAST,
        maxRetries: 3,
        onAfterRead: async () => {
          n++;
          const m = JSON.parse(await fs.readFile(planJson, 'utf8'));
          m.updated_at = Date.now() + n; // guaranteed byte change → hash drift
          await fs.writeFile(planJson, `${JSON.stringify(m, null, 2)}\n`);
        },
      }),
    'cas-exhausted',
  );
  assert.ok(n >= 4, `all attempts consumed (got ${n})`);
});

// ── CROSS-PROCESS: a real competing child preserves concurrent edits (no lost update) ──

test('concurrent cross-process edits are ALL preserved (real child processes contend the lock)', async () => {
  const home = await makeHome();
  const folder = await scaffoldFolder(home, 'xproc');
  const script = await childScript();
  const xTuning = { ...FAST, acquireTimeoutMs: 8000, heartbeatMs: 1000, staleMs: 15000 };

  // Four external processes each append a distinct event, each holding the lock ~40ms;
  // the parent appends its own event concurrently. Without the sidecar lock, some
  // appends would clobber others (lost update). With it, ALL five survive.
  const childIds = ['c1', 'c2', 'c3', 'c4'];
  const children = childIds.map((id) => spawnContender(home, 'xproc', `rev_${id}`, id, 40, xTuning, script));
  const parent = casAppendResponsibilityEvent(home, 'xproc', ev('rev_parent', 'parent'), xTuning);

  const codes = await Promise.all(children);
  await parent;
  assert.deepEqual(codes, [0, 0, 0, 0], 'every child process exited cleanly');

  const m = await readManifest(folder);
  const ids = new Set((m.responsibility_events ?? []).map((e) => e.event_id));
  for (const id of childIds) assert.ok(ids.has(`rev_${id}`), `child event rev_${id} preserved`);
  assert.ok(ids.has('rev_parent'), 'parent event preserved');
  assert.equal(m.responsibility_events?.length, 5, 'exactly five events — no lost update, no duplicate');
});

test('cross-process idempotency — two processes appending the SAME event_id yield one copy', async () => {
  const home = await makeHome();
  const folder = await scaffoldFolder(home, 'xidem');
  const script = await childScript();
  const xTuning = { ...FAST, acquireTimeoutMs: 8000, heartbeatMs: 1000, staleMs: 15000 };
  const c = spawnContender(home, 'xidem', 'rev_same', 'child', 30, xTuning, script);
  const p = casAppendResponsibilityEvent(home, 'xidem', ev('rev_same', 'parent'), xTuning);
  const [code] = await Promise.all([c, p]);
  assert.equal(code, 0);
  const m = await readManifest(folder);
  const same = (m.responsibility_events ?? []).filter((e) => e.event_id === 'rev_same');
  assert.equal(same.length, 1, 'exactly one copy despite two writers racing the same id');
});

// ── Runner ──────────────────────────────────────────────────────────────────

(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      passed++;
    } catch (err) {
      failed++;
      console.error(`✗ ${t.name}\n  ${(err as Error).stack || (err as Error).message}`);
    }
  }
  // Best-effort temp cleanup.
  for (const d of tmpRoots) {
    try { await fs.rm(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\nplan-manifest: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
