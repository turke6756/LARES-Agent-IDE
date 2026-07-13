#!/usr/bin/env node
// Memory-watchdog stress fixture (incident-2026-07-11 §5 D5, Wave 4b).
//
// A NON-DESTRUCTIVE, offline simulation of the full-D5 attribution + admission
// math. It does NOT touch the live app, spawn agents, read real processes, or
// kill anything — it synthesizes a fleet of ownership rows + a fake per-PID memory
// snapshot, runs the SAME pure engine the app uses (computeAttribution +
// checkOwnedProcessCap + checkAgentBudget from dist/), and prints what the
// admission gates would decide as the fleet scales up. Use it to sanity-check the
// caps/budgets before shipping a tuning change, or to eyeball attribution output.
//
// Usage (build first — it reads the compiled engine from dist/):
//   npm run build:main
//   node scripts/watchdog-stress-fixture.js [--agents N] [--procs-per-agent M] [--mb-per-proc MB]
//
// Everything is a pure function call; there are no side effects.

const path = require('path');

const DIST = path.join(__dirname, '..', 'dist', 'main', 'main', 'watchdog');
let attribution;
let budget;
try {
  attribution = require(path.join(DIST, 'attribution.js'));
  budget = require(path.join(DIST, 'budget.js'));
} catch (e) {
  console.error('Could not load the compiled watchdog engine. Run `npm run build:main` first.');
  console.error(String(e && e.message ? e.message : e));
  process.exit(2);
}

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) {
    const v = Number(process.argv[i + 1]);
    return Number.isFinite(v) ? v : dflt;
  }
  return dflt;
}

const AGENTS = arg('agents', 12);
const PROCS_PER_AGENT = arg('procs-per-agent', 4);
const MB_PER_PROC = arg('mb-per-proc', 220);
const ELECTRON_PROCS = arg('electron-procs', 40);
const MiB = 1024 * 1024;

function fmt(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

// ── synthesize a fleet ──────────────────────────────────────────────────────────
// One ownership row per agent; a flat tree of PROCS_PER_AGENT pids each carrying
// MB_PER_PROC of working set. PIDs are unique across the fleet.
let nextPid = 1000;
const rows = [];
const pidBytes = new Map();
const treeByAgent = new Map();
for (let a = 0; a < AGENTS; a++) {
  const agentId = `sim-agent-${a}`;
  const pids = [];
  for (let p = 0; p < PROCS_PER_AGENT; p++) {
    const pid = nextPid++;
    pids.push(pid);
    pidBytes.set(pid, MB_PER_PROC * MiB);
  }
  treeByAgent.set(agentId, pids);
  rows.push({
    agentId, rootPid: pids[0], pidCreationTime: '1', instanceEpoch: 'sim',
    jobName: `job-${a}`, transport: 'conpty', tmuxSession: null, createdAt: 0,
  });
}

const result = attribution.computeAttribution({
  listOwnershipRows: () => rows,
  resolveTree: (row) => ({ pids: treeByAgent.get(row.agentId) || [], source: 'job' }),
  workingSetBytes: (pid) => pidBytes.get(pid) ?? null,
  commitBytes: (pid) => pidBytes.get(pid) ?? null,
  electron: () => ({ processCount: ELECTRON_PROCS, workingSetBytes: ELECTRON_PROCS * 80 * MiB }),
  now: () => 0,
});

// ── report ──────────────────────────────────────────────────────────────────────
console.log('Watchdog stress fixture — offline simulation (no live processes touched)\n');
console.log(`Fleet: ${AGENTS} agents × ${PROCS_PER_AGENT} procs × ${MB_PER_PROC} MB  +  ${ELECTRON_PROCS} electron procs\n`);

const t = result.totals;
console.log('App-owned totals:');
console.log(`  electron        : ${t.electronProcessCount} procs, ${fmt(t.electronBytes)}`);
console.log(`  owned CLI trees : ${t.ownedCliProcessCount} procs, ${fmt(t.ownedCliBytes)}`);
console.log(`  TOTAL owned     : ${t.totalOwnedProcessCount} procs, ${fmt(t.totalOwnedBytes)}\n`);

// Owned-process cap gate (new launches / tabs) with the shipped default config.
const cap = budget.checkOwnedProcessCap(t);
console.log(`Owned-process cap gate: ${cap.allowed ? 'ALLOW' : `REFUSE [${cap.code}] ${cap.reason}`}`);

// Per-agent budget gate — flag any agent over the default budget.
const over = result.perAgent
  .map((u) => ({ u, d: budget.checkAgentBudget(u) }))
  .filter((x) => !x.d.allowed);
if (over.length === 0) {
  console.log('Per-agent budget gate: all agents within budget.');
} else {
  console.log(`Per-agent budget gate: ${over.length} agent(s) OVER budget:`);
  for (const { u, d } of over) console.log(`  ${u.agentId}: ${fmt(u.cliTreeBytes)} — [${d.code}] ${d.reason}`);
}

console.log('\nPer-agent (first 5):');
for (const u of result.perAgent.slice(0, 5)) {
  console.log(`  ${u.agentId.padEnd(16)} ${String(u.pidCount).padStart(2)} procs  ${fmt(u.cliTreeBytes).padStart(9)}  (${u.source})`);
}
if (result.perAgent.length > 5) console.log(`  … +${result.perAgent.length - 5} more`);
