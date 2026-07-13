// Spike harness (run under ELECTRON_RUN_AS_NODE=1 electron). Validates:
//   Spike 2: a child assigned before it forks pulls its descendants into the job.
//   Spike 3: a named job is reopenable via OpenJobObject after the creating
//            process is force-killed, while a member still runs.
//   Spike 4: listJobPids / terminateJob work from the NEW process on that job.
// Spikes 1, 5, 6 are validated out-of-band (build/ABI, Get-Counter, WSL) — see
// run-spike.sh.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const native = require('../index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (name) => path.join(os.tmpdir(), `lares-spike-${process.pid}-${name}`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ` :: ${detail}` : ''}`);
  if (!ok) failures++;
}

async function spike2() {
  console.log('\n=== Spike 2: assign-before-fork race (breakaway denied) ===');
  const name = `Local\\Lares.spike.assign.${process.pid}`;
  const gcFile = tmp('gc');
  try { fs.unlinkSync(gcFile); } catch {}
  const job = native.createNamedJob(name);

  const forkDelayMs = 300;
  const t0 = process.hrtime.bigint();
  const child = cp.spawn('node', [path.join(__dirname, 'forker.js'), String(forkDelayMs), gcFile], { stdio: 'ignore' });
  await new Promise((res) => child.on('spawn', res));
  native.assignPid(job, child.pid);
  const assignLatencyMs = Number(process.hrtime.bigint() - t0) / 1e6;

  check('assign latency < fork delay (assignment lands before the CLI forks)',
    assignLatencyMs < forkDelayMs, `assignLatency=${assignLatencyMs.toFixed(1)}ms, forkDelay=${forkDelayMs}ms`);

  // Wait past the fork so the grandchild exists, then confirm it was captured.
  await sleep(forkDelayMs + 600);
  const gcPid = parseInt(fs.readFileSync(gcFile, 'utf8'), 10);
  const pids = native.listJobPids(job);
  check('child (assigned) is in the job', pids.includes(child.pid), `childPid=${child.pid} pids=[${pids}]`);
  check('grandchild forked AFTER assign was auto-captured (breakaway denied)',
    pids.includes(gcPid), `gcPid=${gcPid} pids=[${pids}]`);

  native.terminateJob(job);
  await sleep(300);
  check('terminateJob killed the whole tree', !alive(child.pid) && !alive(gcPid),
    `childAlive=${alive(child.pid)} gcAlive=${alive(gcPid)}`);
  try { fs.unlinkSync(gcFile); } catch {}
}

async function spike34() {
  console.log('\n=== Spike 3+4: reopen after force-killing the creator; list+terminate from new process ===');
  const name = `Local\\Lares.spike.reopen.${process.pid}`;
  const memberFile = tmp('member');
  try { fs.unlinkSync(memberFile); } catch {}

  // The creator must run under the Electron ABI (it loads the addon).
  const creator = cp.spawn(process.execPath, [path.join(__dirname, 'job-creator.js'), name, memberFile], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  // Wait for READY.
  await new Promise((res) => {
    creator.stdout.on('data', (d) => { if (d.toString().includes('READY')) res(); });
  });
  const memberPid = parseInt(fs.readFileSync(memberFile, 'utf8'), 10);
  check('member is running before we kill the creator', alive(memberPid), `memberPid=${memberPid}`);

  // Force-kill ONLY the creator (no /T) so the member survives — models a forced
  // death of the Lares main process while a hosted CLI keeps running.
  cp.execSync(`taskkill /F /PID ${creator.pid}`, { stdio: 'ignore' });
  await sleep(500);
  check('creator process is gone', !alive(creator.pid), `creatorPid=${creator.pid}`);
  check('member still running after creator death', alive(memberPid), `memberPid=${memberPid}`);

  // Spike 3: reopen by name from THIS (new) process.
  const reopened = native.openNamedJob(name);
  check('openNamedJob reopened the job after creator death', reopened != null);

  if (reopened != null) {
    // Spike 4: list + terminate from the new process.
    const pids = native.listJobPids(reopened);
    check('listJobPids from new process sees the surviving member', pids.includes(memberPid),
      `memberPid=${memberPid} pids=[${pids}]`);
    native.terminateJob(reopened);
    await sleep(400);
    check('terminateJob from new process killed the member', !alive(memberPid), `memberPid=${memberPid}`);

    // After the last member dies, the named job should no longer be openable.
    const gone = native.openNamedJob(name);
    check('named job no longer openable once all members exit', gone == null);
  }
  try { fs.unlinkSync(memberFile); } catch {}
}

(async () => {
  console.log(`electron=${process.versions.electron || 'n/a'} abi=${process.versions.modules} supported=${native.supported}`);
  await spike2();
  await spike34();
  console.log(`\n${failures === 0 ? 'ALL SPIKE CHECKS PASSED' : `${failures} SPIKE CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('spike harness error:', e); process.exit(1); });
