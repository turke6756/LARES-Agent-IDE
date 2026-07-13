// Spike helper (Electron-ABI, run via ELECTRON_RUN_AS_NODE): a stand-in for the
// Lares main process that creates a named job, assigns a long-lived member, then
// is force-killed by the harness (spike 3/4) while the member keeps running.
// Argv: <jobName> <memberPidFile>.
const cp = require('child_process');
const fs = require('fs');
const native = require('../index.js');

const jobName = process.argv[2];
const memberPidFile = process.argv[3];

// Hold the handle in a live variable so it is not GC-closed; even if it were,
// the named job persists while the member runs.
const job = native.createNamedJob(jobName);

// A long-lived member, spawned with plain node so it doesn't depend on the addon.
const member = cp.spawn('node', ['-e', 'setInterval(()=>{}, 1073741824)'], { stdio: 'ignore' });
member.on('spawn', () => {
  native.assignPid(job, member.pid);
  fs.writeFileSync(memberPidFile, String(member.pid));
  process.stdout.write('READY\n');
});

// Stay alive until the harness force-kills us.
setInterval(() => { void job; }, 1073741824);
