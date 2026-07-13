// Spike helper (plain node): model a CLI that forks a descendant AFTER a delay.
// Used by spike 2 to prove a child assigned to the job before it forks pulls its
// later descendants into the job too (breakaway denied). Argv: <delayMs> <gcPidFile>.
const cp = require('child_process');
const fs = require('fs');
const delayMs = parseInt(process.argv[2] || '300', 10);
const gcPidFile = process.argv[3];

setTimeout(() => {
  const gc = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1073741824)'], { stdio: 'ignore' });
  if (gcPidFile) fs.writeFileSync(gcPidFile, String(gc.pid));
}, delayMs);

// Keep the forker itself alive so it stays a job member.
setInterval(() => {}, 1073741824);
