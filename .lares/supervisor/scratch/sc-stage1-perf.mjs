import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const { CommitCandidateService } = require(
  path.join(repoRoot, 'dist', 'main', 'main', 'commit-candidates', 'candidate-service.js'),
);
const { runGit, runGitBytes } = require(
  path.join(repoRoot, 'dist', 'main', 'main', 'git-checkpoints', 'git-command.js'),
);
const { resolveInternalGit } = require(
  path.join(repoRoot, 'dist', 'main', 'main', 'git', 'git-runtime.js'),
);

const WARMUPS = 3;
const ITERATIONS = 30;
const ENTRY_COUNTS = [667, 667, 666];
const TURN_COUNTS = [167, 167, 166];
const prefixes = ['workspace-a', 'workspace-b', 'workspace-c'];

function percentile(sorted, fraction) {
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return {
    min: sorted[0],
    median: (sorted[middle - 1] + sorted[middle]) / 2,
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1),
  };
}

function captureTurn(id) {
  return {
    id,
    status: 'accepted',
    beforeOid: null,
    afterOid: null,
    beforeRef: null,
    afterRef: null,
    beforeReady: false,
    afterReady: false,
    beforeQuality: 'guaranteed',
    afterQuality: 'hook',
    beforePrunedAt: null,
    afterPrunedAt: null,
    failureReason: null,
  };
}

function commandName(args) {
  return args[0] === '--no-optional-locks' ? args[1] : args[0];
}

const internal = await resolveInternalGit();
if (!internal) throw new Error('No compatible Git executable was resolved');
const gitExe = internal.execPath;
const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-sc-stage1-perf-'));

try {
  execFileSync(gitExe, ['init', '-q'], { cwd: tempRepo });

  const witnessRows = {};
  const captureRows = {};
  const workspaces = [];

  for (let workspaceIndex = 0; workspaceIndex < prefixes.length; workspaceIndex++) {
    const prefix = prefixes[workspaceIndex];
    const workspaceDir = path.join(tempRepo, prefix);
    fs.mkdirSync(workspaceDir, { recursive: true });

    const relativePaths = [];
    for (let index = 0; index < ENTRY_COUNTS[workspaceIndex]; index++) {
      const relativePath = `file-${String(index).padStart(4, '0')}.txt`;
      relativePaths.push(relativePath);
      fs.writeFileSync(path.join(workspaceDir, relativePath), `${workspaceIndex}:${index}\n`);
    }

    const witnesses = [];
    const captures = [];
    for (let turnIndex = 0; turnIndex < TURN_COUNTS[workspaceIndex]; turnIndex++) {
      const turnId = `turn-${workspaceIndex}-${String(turnIndex).padStart(3, '0')}`;
      const start = turnIndex * 4;
      const touched = relativePaths
        .slice(start, start + 4)
        .map((touchedPath) => ({ path: touchedPath, op: 'write' }));
      witnesses.push({
        turnId,
        agentId: 'fixture-agent',
        ownerAgentId: null,
        ownerBrickGeneration: null,
        touched,
      });
      captures.push(captureTurn(turnId));
    }
    witnessRows[`ws-${workspaceIndex}`] = witnesses;
    captureRows[`ws-${workspaceIndex}`] = captures;

    workspaces.push({
      workspaceId: `ws-${workspaceIndex}`,
      workspaceDir,
      capability: {
        commonDirQueueKey: 'shared-fixture-object-db',
        workspacePrefix: prefix,
        repoRoot: tempRepo,
      },
      gitExe,
    });
  }

  let activeMetrics = null;
  async function measuredGit(cwd, args, options) {
    const started = performance.now();
    try {
      return await runGit(cwd, args, { ...options, gitExe });
    } finally {
      if (activeMetrics) {
        const name = commandName(args);
        const stat = activeMetrics.commands[name] ??= { calls: 0, summedMs: 0 };
        stat.calls++;
        stat.summedMs += performance.now() - started;
      }
    }
  }
  async function measuredGitBytes(cwd, args, options) {
    const started = performance.now();
    try {
      return await runGitBytes(cwd, args, { ...options, gitExe });
    } finally {
      if (activeMetrics) {
        const name = commandName(args);
        const stat = activeMetrics.commands[name] ??= { calls: 0, summedMs: 0 };
        stat.calls++;
        stat.summedMs += performance.now() - started;
      }
    }
  }

  const service = new CommitCandidateService({
    runGit: measuredGit,
    runGitBytes: measuredGitBytes,
    readTurnWitnesses: (workspaceId) => witnessRows[workspaceId] ?? [],
    readCaptureTurns: (workspaceId) => captureRows[workspaceId] ?? [],
  });
  const request = { targetWorkspaceId: 'ws-0', workspaces };

  async function readOnce(recordMetrics) {
    activeMetrics = recordMetrics ? { commands: {} } : null;
    const started = performance.now();
    const bundles = await service.listWorkBundles(request);
    const elapsedMs = performance.now() - started;
    const metrics = activeMetrics;
    activeMetrics = null;
    return { elapsedMs, bundles, metrics };
  }

  for (let index = 0; index < WARMUPS; index++) {
    const result = await readOnce(false);
    if (result.bundles.length === 0) throw new Error('Warmup returned no bundles');
  }

  const samples = [];
  const commandTotals = {};
  let observedEntries = 0;
  let observedBundles = 0;
  for (let index = 0; index < ITERATIONS; index++) {
    const result = await readOnce(true);
    samples.push(result.elapsedMs);
    observedBundles = result.bundles.length;
    observedEntries = result.bundles.reduce(
      (total, bundle) => total + bundle.members.length,
      0,
    );
    for (const [name, stat] of Object.entries(result.metrics.commands)) {
      const aggregate = commandTotals[name] ??= { calls: 0, summedMs: 0 };
      aggregate.calls += stat.calls;
      aggregate.summedMs += stat.summedMs;
    }
    process.stdout.write(
      `iteration ${String(index + 1).padStart(2, '0')}/${ITERATIONS}: `
      + `${result.elapsedMs.toFixed(2)} ms\n`,
    );
  }

  const commandAverages = Object.fromEntries(
    Object.entries(commandTotals).map(([name, stat]) => [
      name,
      {
        callsPerIteration: stat.calls / ITERATIONS,
        summedMsPerIteration: stat.summedMs / ITERATIONS,
      },
    ]),
  );

  console.log('\nSC_STAGE1_PERF_RESULT');
  console.log(JSON.stringify({
    platform: `${os.version()} (${os.release()})`,
    node: process.version,
    gitExe,
    fixture: {
      entries: ENTRY_COUNTS.reduce((sum, count) => sum + count, 0),
      entriesByWorkspace: ENTRY_COUNTS,
      witnessedTurns: TURN_COUNTS.reduce((sum, count) => sum + count, 0),
      turnsByWorkspace: TURN_COUNTS,
      observedEntries,
      observedBundles,
      git: 'real temp repository; real rev-parse/status/hash-object subprocesses',
      database: 'injected in-memory witness and capture-turn readers',
    },
    warmups: WARMUPS,
    iterations: ITERATIONS,
    milliseconds: summary(samples),
    commandAverages,
    samples,
  }, null, 2));
} finally {
  fs.rmSync(tempRepo, { recursive: true, force: true });
}
