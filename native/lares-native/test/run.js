'use strict';
// Unit tests for lares-native. The addon is built for the Electron ABI, so if we
// were started under plain `node` (different ABI) we transparently relaunch under
// Electron via ELECTRON_RUN_AS_NODE — meaning `node test/run.js` "just works".
const path = require('path');
const cp = require('child_process');
const assert = require('assert/strict');

const native = require('../index.js');

if (process.platform === 'win32' && !native.supported && !process.env.LARES_TEST_RELAUNCHED) {
  let electronPath;
  try { electronPath = require('electron'); } catch (e) {
    console.error('lares-native tests need the Electron ABI; could not resolve electron:', e.message);
    process.exit(2);
  }
  const r = cp.spawnSync(electronPath, [__filename], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', LARES_TEST_RELAUNCHED: '1' },
  });
  process.exit(r.status == null ? 1 : r.status);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const spawnLived = () => cp.spawn('node', ['-e', 'setInterval(()=>{}, 1073741824)'], { stdio: 'ignore' });

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── non-Windows: the graceful no-op stub surface ────────────────────────────
if (process.platform !== 'win32') {
  test('non-Windows: platformSupported() is false', () => {
    assert.equal(native.supported, false);
    assert.equal(native.platformSupported(), false);
  });
  test('non-Windows: operations throw a clear error', () => {
    assert.throws(() => native.createNamedJob('x'), /not supported|unavailable/i);
    assert.throws(() => native.getCommitStatus(), /not supported|unavailable/i);
  });
  test('non-Windows: jobName still formats the convention', () => {
    assert.equal(native.jobName('a', 'b'), 'Local\\Lares.agent.a.b');
  });
} else {
  // ── surface ───────────────────────────────────────────────────────────────
  test('addon loaded and reports supported', () => {
    assert.equal(native.supported, true);
    assert.equal(native.platformSupported(), true);
    for (const fn of ['createNamedJob', 'openNamedJob', 'assignPid', 'listJobPids',
      'terminateJob', 'pidCreationTime', 'getCommitStatus']) {
      assert.equal(typeof native[fn], 'function', `${fn} should be a function`);
    }
  });

  test('jobName follows Local\\Lares.agent.<id>.<epoch>', () => {
    assert.equal(native.jobName('agent-7', 'ep-42'), 'Local\\Lares.agent.agent-7.ep-42');
  });

  // ── getCommitStatus (D5 sampler dependency) ─────────────────────────────────
  test('getCommitStatus returns a coherent snapshot', () => {
    const cs = native.getCommitStatus();
    for (const k of ['commitLimitBytes', 'commitAvailableBytes', 'commitChargeBytes',
      'physicalTotalBytes', 'physicalAvailableBytes', 'memoryLoadPercent']) {
      assert.equal(typeof cs[k], 'number', `${k} should be a number`);
    }
    assert.ok(cs.commitLimitBytes > 0, 'commit limit > 0');
    assert.ok(cs.commitChargeBytes > 0, 'commit charge > 0');
    assert.ok(cs.commitChargeBytes < cs.commitLimitBytes, 'charge < limit');
    // charge == limit - available (identity from the syscall)
    assert.ok(Math.abs((cs.commitLimitBytes - cs.commitAvailableBytes) - cs.commitChargeBytes) < 1,
      'charge equals limit - available');
    assert.ok(cs.physicalTotalBytes > 0, 'physical total > 0');
    assert.ok(cs.memoryLoadPercent >= 0 && cs.memoryLoadPercent <= 100, 'load 0..100');
  });

  // ── pidCreationTime (PID-reuse disambiguation) ──────────────────────────────
  test('pidCreationTime returns a FILETIME decimal string for a live pid', () => {
    const ct = native.pidCreationTime(process.pid);
    assert.equal(typeof ct, 'string');
    assert.match(ct, /^\d+$/);
    assert.ok(ct.length > 10, 'FILETIME is a large integer');
  });

  test('pidCreationTime returns null for a non-existent pid', () => {
    assert.equal(native.pidCreationTime(0xFFFFFFF0), null);
  });

  // ── job lifecycle: create → assign → list → terminate ───────────────────────
  test('assign a process, list it, terminate the job', async () => {
    const name = native.jobName('unit-lifecycle-' + process.pid, 'ep1');
    const job = native.createNamedJob(name);
    const child = spawnLived();
    await new Promise((r) => child.on('spawn', r));
    try {
      assert.equal(native.assignPid(job, child.pid), true);
      const pids = native.listJobPids(job);
      assert.ok(pids.includes(child.pid), `pids ${JSON.stringify(pids)} include ${child.pid}`);
      assert.equal(native.terminateJob(job), true);
      await sleep(400);
      assert.equal(alive(child.pid), false, 'child terminated with the job');
    } finally {
      if (alive(child.pid)) process.kill(child.pid);
    }
  });

  // ── breakaway denied: descendants forked after assign are captured ──────────
  test('descendant forked after assignment is captured (breakaway denied)', async () => {
    const name = native.jobName('unit-breakaway-' + process.pid, 'ep1');
    const job = native.createNamedJob(name);
    const os = require('os');
    const fs = require('fs');
    const gcFile = path.join(os.tmpdir(), `lares-unit-gc-${process.pid}`);
    try { fs.unlinkSync(gcFile); } catch {}
    const forker = cp.spawn('node', [path.join(__dirname, '..', 'spike', 'forker.js'), '250', gcFile], { stdio: 'ignore' });
    await new Promise((r) => forker.on('spawn', r));
    try {
      native.assignPid(job, forker.pid);      // assign BEFORE the fork at +250ms
      await sleep(900);
      const gcPid = parseInt(fs.readFileSync(gcFile, 'utf8'), 10);
      const pids = native.listJobPids(job);
      assert.ok(pids.includes(forker.pid), 'forker in job');
      assert.ok(pids.includes(gcPid), `grandchild ${gcPid} captured: ${JSON.stringify(pids)}`);
      native.terminateJob(job);
      await sleep(400);
      assert.equal(alive(gcPid), false, 'grandchild terminated with the job');
    } finally {
      if (alive(forker.pid)) process.kill(forker.pid);
      try { fs.unlinkSync(gcFile); } catch {}
    }
  });

  // ── openNamedJob: SAME-INSTANCE reopen contract (Option B) ───────────────────
  // Reframed after the spike: reopen works while a handle is held in-process; it
  // is NOT a cross-process-death durable handle (see README / plan rev-4).
  test('openNamedJob reopens a named job while a handle is held (same instance)', async () => {
    const name = native.jobName('unit-reopen-' + process.pid, 'ep1');
    const job = native.createNamedJob(name);   // keep this handle alive in-scope
    const child = spawnLived();
    await new Promise((r) => child.on('spawn', r));
    try {
      native.assignPid(job, child.pid);
      const reopened = native.openNamedJob(name);
      assert.notEqual(reopened, null, 'reopened handle is non-null');
      const pids = native.listJobPids(reopened);
      assert.ok(pids.includes(child.pid), 'reopened handle lists the member');
      native.terminateJob(reopened);
      await sleep(400);
      assert.equal(alive(child.pid), false);
      assert.ok(job, 'original handle still referenced');
    } finally {
      if (alive(child.pid)) process.kill(child.pid);
    }
  });

  test('openNamedJob returns null for a non-existent name', () => {
    assert.equal(native.openNamedJob('Local\\Lares.agent.does-not-exist.' + process.pid), null);
  });

  test('createNamedJob is idempotent for the same name', () => {
    const name = native.jobName('unit-idempotent-' + process.pid, 'ep1');
    const a = native.createNamedJob(name);
    const b = native.createNamedJob(name);   // must not throw
    assert.ok(a && b);
    // no members were assigned, so nothing to terminate; handles GC-close safely
  });
}

(async () => {
  console.log(`lares-native tests — platform=${process.platform} electron=${process.versions.electron || 'n/a'} abi=${process.versions.modules} supported=${native.supported}`);
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok   — ${name}`);
    } catch (e) {
      console.log(`  FAIL — ${name}\n         ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  if (passed !== tests.length) process.exitCode = 1;
})();
