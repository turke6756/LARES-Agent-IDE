// Unit tests — detached-process registry (incident-2026-07-11 §5 Wave 5). Run:
//   npm run build:main
//   node dist/main/main/detached-process-registry.test.js
//
// Everything is injected (dir listing, file read, PID probe), so no real
// processes or filesystem are touched.

import assert from 'node:assert/strict';
import * as path from 'path';
import {
  listDetachedProcesses,
  parseDetachedRecord,
  commandMatches,
  classifyLiveness,
  type DetachedRegistryDeps,
  type DetachedProbeResult,
} from './detached-process-registry';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

const DIR = path.join('C:', 'ws', '.dashboard', 'detached');

/** Build injected deps from an in-memory file map + PID probe map. */
function deps(over: {
  files?: Record<string, string>;
  probe?: Map<number, DetachedProbeResult>;
  listThrows?: boolean;
  probeThrows?: boolean;
}): DetachedRegistryDeps {
  const files = over.files ?? {};
  return {
    listFiles: async (_dir) => {
      if (over.listThrows) throw new Error('ENOENT');
      return Object.keys(files);
    },
    readFile: async (file) => {
      const name = path.basename(file);
      if (!(name in files)) throw new Error('read failed');
      return files[name];
    },
    probe: async (_pids) => {
      if (over.probeThrows) throw new Error('probe failed');
      return over.probe ?? new Map();
    },
  };
}

function descriptor(over: Record<string, unknown>): string {
  return JSON.stringify({
    pid: 1234,
    command: 'node worker.js --job build',
    agentId: 'agent-7',
    startTime: 1_700_000_000_000,
    phase: 'building',
    stateFile: '/ws/.dashboard/detached/state.json',
    logFile: '/ws/.dashboard/detached/log.txt',
    stopFile: '/ws/.dashboard/detached/STOP',
    running: true,
    ...over,
  });
}

// ── parse ─────────────────────────────────────────────────────────────────

test('parse: full descriptor maps every field', () => {
  const rec = parseDetachedRecord('f.json', descriptor({}));
  assert.equal(rec.error, null);
  assert.equal(rec.pid, 1234);
  assert.equal(rec.command, 'node worker.js --job build');
  assert.equal(rec.agentId, 'agent-7');
  assert.equal(rec.startTime, 1_700_000_000_000);
  assert.equal(rec.phase, 'building');
  assert.equal(rec.runningFlag, true);
  assert.equal(rec.stopFile, '/ws/.dashboard/detached/STOP');
});

test('parse: alternate key spellings + ISO start time', () => {
  const rec = parseDetachedRecord('f.json', JSON.stringify({
    pid: '55', commandLine: 'python job.py', AGENT_ID: 'a1',
    startedAt: '2024-01-02T03:04:05Z', running: false,
  }));
  assert.equal(rec.pid, 55);
  assert.equal(rec.command, 'python job.py');
  assert.equal(rec.agentId, 'a1');
  assert.equal(rec.startTime, Date.parse('2024-01-02T03:04:05Z'));
  assert.equal(rec.runningFlag, false);
});

test('parse: malformed JSON → error row, no throw', () => {
  const rec = parseDetachedRecord('f.json', '{ not json ');
  assert.ok(rec.error && rec.error.includes('malformed'));
  assert.equal(rec.pid, null);
  assert.equal(rec.runningFlag, false);
});

test('parse: non-object JSON → error row', () => {
  const rec = parseDetachedRecord('f.json', '[1,2,3]');
  assert.ok(rec.error && rec.error.includes('not a JSON object'));
});

test('parse: missing/invalid pid → null', () => {
  assert.equal(parseDetachedRecord('f', JSON.stringify({ pid: 0, running: true })).pid, null);
  assert.equal(parseDetachedRecord('f', JSON.stringify({ pid: -3, running: true })).pid, null);
  assert.equal(parseDetachedRecord('f', JSON.stringify({ running: true })).pid, null);
});

// ── commandMatches ──────────────────────────────────────────────────────────

test('commandMatches: identical / substring / exe basename', () => {
  assert.equal(commandMatches('node worker.js', 'node worker.js'), true);
  assert.equal(commandMatches('worker.js', 'C:\\bin\\node.exe worker.js --x'), true);
  assert.equal(commandMatches('node worker.js', 'C:\\Program Files\\nodejs\\node.exe app.js'), false);
});

test('commandMatches: missing sides never flag reuse', () => {
  assert.equal(commandMatches(null, 'anything'), true);
  assert.equal(commandMatches('recorded', null), true);
});

// ── classifyLiveness ────────────────────────────────────────────────────────

test('classify: flag false → ended (no probe needed)', () => {
  const rec = parseDetachedRecord('f', descriptor({ running: false }));
  assert.equal(classifyLiveness(rec, new Map()).liveness, 'ended');
});

test('classify: running + alive + matching cmd → running', () => {
  const rec = parseDetachedRecord('f', descriptor({}));
  const probes = new Map([[1234, { alive: true, commandLine: 'node worker.js --job build' }]]);
  assert.equal(classifyLiveness(rec, probes).liveness, 'running');
});

test('classify: running flag but PID dead → dead (hard-kill caveat)', () => {
  const rec = parseDetachedRecord('f', descriptor({}));
  const probes = new Map([[1234, { alive: false, commandLine: null }]]);
  assert.equal(classifyLiveness(rec, probes).liveness, 'dead');
});

test('classify: alive but command mismatch → reused (PID recycled)', () => {
  const rec = parseDetachedRecord('f', descriptor({}));
  const probes = new Map([[1234, { alive: true, commandLine: 'C:\\Windows\\explorer.exe' }]]);
  const out = classifyLiveness(rec, probes);
  assert.equal(out.liveness, 'reused');
  assert.equal(out.actualCommand, 'C:\\Windows\\explorer.exe');
});

test('classify: alive, cmd unknown → running (no false reuse)', () => {
  const rec = parseDetachedRecord('f', descriptor({}));
  const probes = new Map([[1234, { alive: true, commandLine: null }]]);
  assert.equal(classifyLiveness(rec, probes).liveness, 'running');
});

test('classify: no probe entry → unknown', () => {
  const rec = parseDetachedRecord('f', descriptor({}));
  assert.equal(classifyLiveness(rec, new Map()).liveness, 'unknown');
});

test('classify: error record → unknown', () => {
  const rec = parseDetachedRecord('f', 'garbage');
  assert.equal(classifyLiveness(rec, new Map()).liveness, 'unknown');
});

// ── listDetachedProcesses ────────────────────────────────────────────────────

test('list: missing directory → empty list', async () => {
  const out = await listDetachedProcesses(DIR, deps({ listThrows: true }));
  assert.deepEqual(out, []);
});

test('list: no descriptors → empty list', async () => {
  const out = await listDetachedProcesses(DIR, deps({ files: {} }));
  assert.deepEqual(out, []);
});

test('list: ignores non-json files', async () => {
  const out = await listDetachedProcesses(DIR, deps({
    files: { 'a.json': descriptor({ running: false }), 'readme.txt': 'x', 'b.log': 'y' },
  }));
  assert.equal(out.length, 1);
});

test('list: probes only claimed-running pids, stable sort by filename', async () => {
  let probedPids: number[] = [];
  const d = deps({
    files: {
      'z.json': descriptor({ pid: 10, running: true }),
      'a.json': descriptor({ pid: 20, running: false }),
    },
    probe: new Map([[10, { alive: true, commandLine: 'node worker.js --job build' }]]),
  });
  const origProbe = d.probe;
  d.probe = async (pids) => { probedPids = pids; return origProbe(pids); };
  const out = await listDetachedProcesses(DIR, d);
  // sorted: a.json before z.json
  assert.equal(path.basename(out[0].file), 'a.json');
  assert.equal(path.basename(out[1].file), 'z.json');
  // only the running one (pid 10) is probed
  assert.deepEqual(probedPids, [10]);
  assert.equal(out[0].liveness, 'ended');
  assert.equal(out[1].liveness, 'running');
});

test('list: probe failure → claimed-running rows fall to unknown', async () => {
  const out = await listDetachedProcesses(DIR, deps({
    files: { 'a.json': descriptor({ pid: 10, running: true }) },
    probeThrows: true,
  }));
  assert.equal(out[0].liveness, 'unknown');
});

test('list: unreadable descriptor surfaces as an error row', async () => {
  // File listed but readFile throws (name not in the files map read path).
  const d: DetachedRegistryDeps = {
    listFiles: async () => ['broken.json'],
    readFile: async () => { throw new Error('EACCES'); },
    probe: async () => new Map(),
  };
  const out = await listDetachedProcesses(DIR, d);
  assert.equal(out.length, 1);
  assert.ok(out[0].error && out[0].error.includes('read failed'));
  assert.equal(out[0].liveness, 'unknown');
});

test('list: dedups a repeated running pid across descriptors', async () => {
  let probedPids: number[] = [];
  const d = deps({
    files: {
      'a.json': descriptor({ pid: 42, running: true }),
      'b.json': descriptor({ pid: 42, running: true }),
    },
    probe: new Map([[42, { alive: false, commandLine: null }]]),
  });
  const origProbe = d.probe;
  d.probe = async (pids) => { probedPids = pids; return origProbe(pids); };
  const out = await listDetachedProcesses(DIR, d);
  assert.deepEqual(probedPids, [42]);
  assert.equal(out[0].liveness, 'dead');
  assert.equal(out[1].liveness, 'dead');
});

// ── runner ──────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
    } catch (e) {
      failed += 1;
      console.error(`FAIL  ${t.name}`);
      console.error(e);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
})();
