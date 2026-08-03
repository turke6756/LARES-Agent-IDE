// WP-P3-manifest-sync interop tests — the SKILL-side helper
// (`.lares/proposals/supporting/scaffold-drafts/proposal-to-plan/scripts/plan-manifest.mjs`)
// contending against the SERVICE-side `plan-manifest.ts` for the SAME `plan.json.lock`.
//
// These prove the two implementations are cross-process interoperable AFTER the
// WP-P3-manifest-sync alignment: identical lock path, identical lock-record schema
// (`heartbeat_at`, not `hb`), and identical claim-marker + tombstone reclaim naming, so
// a skill contender and a service contender serialize correctly against each other.
//
// This file is INTENTIONALLY not registered in scripts/run-main-tests.mjs — it needs the
// compiled service module AND runs the real .mjs as a child process. Run it directly:
//   npm run build:main
//   node dist/main/main/plans/plan-manifest-interop.test.js
//
// It does NOT edit plan-manifest.test.ts (another lane owns it); the child-process /
// stale-lock-seed patterns are cribbed from there.

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  casAppendResponsibilityEvent,
  acquirePlanLock,
  releasePlanLock,
  type LockTuning,
  type ResponsibilityEvent,
  type PlanManifest,
} from './plan-manifest';

interface TestCase { name: string; run(): Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void>): void { tests.push({ name, run: fn }); }

// The service and skill share the SETTLED 2s/15s constants; the .mjs hardcodes them, so the
// service side MUST use the same real values for the two to agree on staleness. Holds are
// sub-millisecond, so nothing actually waits seconds despite the 15s stale window.
const REAL_TUNING: Partial<LockTuning> = {
  heartbeatMs: 2000,
  staleMs: 15000,
  acquireTimeoutMs: 15000,
  retryBaseMs: 5,
  retryMaxMs: 30,
  maxRetries: 8,
};

// Locate the real .mjs helper draft, relative to this compiled test (dist/main/main/plans).
// PLAN_MANIFEST_SKILL_MJS overrides the path (used when running a scratch build whose
// __dirname is not under dist/).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SKILL_MJS = process.env.PLAN_MANIFEST_SKILL_MJS || path.join(
  REPO_ROOT, '.lares', 'proposals', 'supporting', 'scaffold-drafts',
  'proposal-to-plan', 'scripts', 'plan-manifest.mjs',
);

let tmpRoots: string[] = [];

async function makeHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-manifest-interop-'));
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

function ev(id: string, agent = 'service'): ResponsibilityEvent {
  return { event_id: id, event: 'assigned', agent_id: agent, at: Date.now(), source: 'promotion-service' };
}

// Spawn the real .mjs helper as an external process, appending one responsibility event
// through the SKILL-side lock. Resolves to { code, stderr }.
function spawnSkillAppend(
  folder: string, agentId: string, maxWaitMs = 15000, pollMs = 20,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        SKILL_MJS, 'manifest', '--dir', folder, '--append-responsibility',
        '--agent-id', agentId, '--display', agentId, '--source', 'manual-skill',
        '--max-wait-ms', String(maxWaitMs), '--poll-ms', String(pollMs),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Seed a DEEP-stale lock (heartbeat ~1000s in the past) in the SERVICE record schema, so it
// is unambiguously reclaimable by either implementation.
async function seedStaleLock(folder: string): Promise<void> {
  const lockPath = path.join(folder, 'plan.json.lock');
  const stale = {
    owner_kind: 'service', owner_id: 'ghost', pid: 999999,
    nonce: crypto.randomBytes(16).toString('hex'),
    acquired_at: Date.now() - 1_000_000, heartbeat_at: Date.now() - 1_000_000,
  };
  await fs.writeFile(lockPath, JSON.stringify(stale));
}

// After a run, no lock / reclaim-claim / tombstone / heartbeat-temp / write-temp siblings
// should linger — proving both implementations cleaned up their reclaim + CAS artifacts.
async function assertNoLockArtifacts(folder: string): Promise<void> {
  const entries = await fs.readdir(folder);
  const litter = entries.filter((e) =>
    e === 'plan.json.lock' ||
    e.includes('plan.json.lock.reclaim-') ||
    e.includes('plan.json.lock.stale-') ||
    e.includes('plan.json.lock.hb-') ||
    e.includes('plan.json.wtmp-'),
  );
  assert.deepEqual(litter, [], `no lock/reclaim/tombstone/temp litter should remain, found: ${litter.join(', ')}`);
}

// ── Guard: the helper must be present ──────────────────────────────────────────

test('the skill helper .mjs exists where the interop test expects it', async () => {
  await fs.stat(SKILL_MJS); // throws (fails the test) if the draft path moved
});

// ── One-winner reclaim across implementations (no lost update) ──────────────────

test('skill + service contenders reclaim ONE seeded stale lock — every append preserved, exactly N events', async () => {
  const home = await makeHome();
  const folder = await scaffoldFolder(home, '2026-08-03-interop');
  await seedStaleLock(folder);

  // Three external SKILL processes and one in-process SERVICE contender all race the single
  // seeded stale lock. Whoever arrives first reclaims it via the claim marker; the rest
  // serialize on the fresh lock. If the two implementations disagreed on the record schema
  // or the reclaim naming, a live lock would be stolen and an append lost (count < N) or a
  // process would crash (nonzero exit).
  const skillIds = ['skill-a', 'skill-b', 'skill-c'];
  const skillRuns = skillIds.map((id) => spawnSkillAppend(folder, id));
  const serviceRun = casAppendResponsibilityEvent(home, '2026-08-03-interop', ev('rev_service', 'service'), REAL_TUNING);

  const results = await Promise.all(skillRuns);
  await serviceRun;

  for (const [i, r] of results.entries()) {
    assert.equal(r.code, 0, `skill contender ${skillIds[i]} exited cleanly (stderr: ${r.stderr.trim()})`);
  }

  const m = await readManifest(folder);
  const events = m.responsibility_events ?? [];
  assert.equal(events.length, 4, 'exactly four events — no lost update, no duplicate');
  const ids = new Set(events.map((e) => e.event_id));
  assert.ok(ids.has('rev_service'), 'service append preserved');
  // Skill events carry generated rev_ ids; assert one appended per distinct skill agent.
  const skillAgents = new Set(events.filter((e) => e.source === 'manual-skill').map((e) => e.agent_id));
  for (const id of skillIds) assert.ok(skillAgents.has(id), `skill append from ${id} preserved`);

  await assertNoLockArtifacts(folder);
});

// ── A LIVE service holder is NOT reclaimed by a skill contender ─────────────────
// This is the direct field-name interop proof: the OLD skill helper read a short `hb`
// field; against a service lock (which writes `heartbeat_at`) it would have read
// undefined → age Infinity → wrongly reclaimed a LIVE lock. The aligned helper reads
// `heartbeat_at`, sees the holder fresh, and cleanly times out (exit 4) instead.

test('a live SERVICE holder is not stolen by a skill contender — skill times out with lock-exhaustion (exit 4)', async () => {
  const home = await makeHome();
  const folder = await scaffoldFolder(home, '2026-08-03-livehold');
  const lockPath = path.join(folder, 'plan.json.lock');

  // Service acquires and HOLDS the lock (heartbeat renewing) with a fresh heartbeat_at.
  const handle = await acquirePlanLock(lockPath, { owner_kind: 'service', owner_id: 'holder' }, REAL_TUNING);
  try {
    // Skill contender with a short budget: the live lock is < 15s stale, so it must NOT
    // reclaim; it exhausts its wait and exits 4 (lock-exhaustion), never touching the lock.
    const r = await spawnSkillAppend(folder, 'skill-late', 1200, 30);
    assert.equal(r.code, 4, `skill contender must exit with lock-exhaustion, got ${r.code} (stderr: ${r.stderr.trim()})`);
    assert.match(r.stderr, /LOCK EXHAUSTION|live owner/i, 'exit-4 message reports the live holder');

    // The service lock is intact — our nonce, untouched.
    const onDisk = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { nonce: string };
    assert.equal(onDisk.nonce, handle.nonce, 'the live service lock was NOT stolen by the skill contender');
  } finally {
    const rel = await releasePlanLock(handle);
    assert.equal(rel.released, true, 'service holder released its own lock cleanly');
  }
});

// ── Runner ──────────────────────────────────────────────────────────────────

(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      passed++;
      console.log(`✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`✗ ${t.name}\n  ${(err as Error).stack || (err as Error).message}`);
    }
  }
  for (const d of tmpRoots) {
    try { await fs.rm(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`\nplan-manifest-interop: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
