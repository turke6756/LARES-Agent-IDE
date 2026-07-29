// Main-process V8 heap telemetry unit tests (crash diagnosability Layer 3).
//   npm run build:main
//   node dist/main/main/watchdog/heap-telemetry.test.js
//
// All deps are faked (heap reader, clock, in-memory "file"), so these exercise
// the JSONL line shape, the ~5 MiB rotation, and the once-per-crossing 75/90%
// warnings with no fs, no timers, and no v8.

import assert from 'node:assert/strict';
import { HeapTelemetry, type HeapSample, type HeapTelemetryDeps } from './heap-telemetry';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

/** A heap reading whose heapUsed is `pct`% of a fixed 4 GiB limit. */
function heapAtPercent(pct: number): HeapSample {
  const limit = 4 * 1024 ** 3;
  return {
    heapUsed: Math.round((pct / 100) * limit),
    heapTotal: Math.round((pct / 100) * limit) + 10 * 1024 ** 2,
    heapSizeLimit: limit,
    external: 5 * 1024 ** 2,
    malloced: 1 * 1024 ** 2,
  };
}

interface Harness {
  telemetry: HeapTelemetry;
  setPercent(pct: number): void;
  setTime(ms: number): void;
  /** Appended lines currently in the live "file" (post-rotation). */
  lines: string[];
  /** Lines that were rotated out to `.1`. */
  rotated: string[];
  logs: string[];
  rotations: number;
}

function makeHarness(config?: Partial<HeapTelemetryDeps>): Harness {
  let pct = 10;
  let t = Date.parse('2026-07-25T00:00:00.000Z');
  let live: string[] = [];
  let rotated: string[] = [];
  const logs: string[] = [];
  let rotations = 0;

  const deps: HeapTelemetryDeps = {
    readHeap: () => heapAtPercent(pct),
    now: () => t,
    append: (line) => { live.push(line); },
    size: () => live.reduce((n, l) => n + Buffer.byteLength(l), 0),
    rotate: () => { rotated = live; live = []; rotations++; },
    log: (m) => logs.push(m),
    ...config,
  };
  const telemetry = new HeapTelemetry(deps);
  return {
    telemetry,
    setPercent: (p) => { pct = p; },
    setTime: (ms) => { t = ms; },
    get lines() { return live; },
    get rotated() { return rotated; },
    logs,
    get rotations() { return rotations; },
  };
}

// ── JSONL line shape ──────────────────────────────────────────────────────────

test('each sample appends one JSONL line with an ISO timestamp and heap fields', () => {
  const h = makeHarness();
  h.setTime(Date.parse('2026-07-25T11:15:00.000Z'));
  h.setPercent(20);
  h.telemetry.sample();
  assert.equal(h.lines.length, 1, 'one line per sample');
  assert.ok(h.lines[0].endsWith('\n'), 'line is newline-terminated');
  const rec = JSON.parse(h.lines[0]);
  assert.equal(rec.t, '2026-07-25T11:15:00.000Z', 'ISO timestamp from the injected clock');
  const limit = 4 * 1024 ** 3;
  assert.equal(rec.heapLimit, limit);
  assert.equal(rec.heapUsed, Math.round(0.2 * limit));
  assert.equal(typeof rec.heapTotal, 'number');
  assert.equal(rec.external, 5 * 1024 ** 2);
  assert.equal(rec.malloced, 1 * 1024 ** 2);
});

// ── once-per-crossing warnings ────────────────────────────────────────────────

test('warns once when crossing 75%, again at 90%, not every tick', () => {
  const h = makeHarness();
  const warnLines = () => h.logs.filter((l) => l.includes('WARN'));
  const critLines = () => h.logs.filter((l) => l.includes('CRITICAL'));

  h.setPercent(50); h.telemetry.sample();
  assert.equal(h.logs.length, 0, 'no warning below 75%');

  h.setPercent(78); h.telemetry.sample();
  assert.equal(warnLines().length, 1, 'crossing 75% warns once');
  h.setPercent(80); h.telemetry.sample();
  h.setPercent(85); h.telemetry.sample();
  assert.equal(warnLines().length, 1, 'staying in the warn band does not re-warn every tick');

  h.setPercent(92); h.telemetry.sample();
  assert.equal(critLines().length, 1, 'crossing 90% warns once at critical');
  h.setPercent(95); h.telemetry.sample();
  assert.equal(critLines().length, 1, 'staying critical does not re-warn');
});

test('recovering below the band re-arms the warning for the next crossing', () => {
  const h = makeHarness();
  h.setPercent(80); h.telemetry.sample();
  assert.equal(h.logs.filter((l) => l.includes('WARN')).length, 1);
  h.setPercent(40); h.telemetry.sample(); // recover to normal
  h.setPercent(80); h.telemetry.sample(); // cross again
  assert.equal(h.logs.filter((l) => l.includes('WARN')).length, 2, 're-cross re-warns');
});

test('a direct jump from normal to critical fires the critical warning', () => {
  const h = makeHarness();
  h.setPercent(30); h.telemetry.sample();
  h.setPercent(95); h.telemetry.sample();
  assert.equal(h.logs.filter((l) => l.includes('CRITICAL')).length, 1, 'jump straight to critical warns');
});

// ── rotation at the size cap ──────────────────────────────────────────────────

test('rotates when the file reaches maxBytes, moving old lines to .1 and starting fresh', () => {
  // Tiny cap so a couple of lines trip it.
  const h = makeHarness({ maxBytes: 300 });
  h.setPercent(10);
  // Each line is well under 300 B; append until we exceed the cap.
  h.telemetry.sample();
  h.telemetry.sample();
  const beforeRotate = h.rotations;
  // Keep sampling until a rotation happens.
  for (let i = 0; i < 20 && h.rotations === beforeRotate; i++) h.telemetry.sample();
  assert.ok(h.rotations >= 1, 'the cap eventually triggers a rotation');
  assert.ok(h.rotated.length >= 1, 'previous lines were moved aside to the rotated file');
  // After a rotation the live file holds only the post-rotation samples.
  assert.ok(h.lines.length >= 1, 'sampling continues into a fresh live file');
  assert.ok(
    h.lines.reduce((n, l) => n + Buffer.byteLength(l), 0) <= 300 + 200,
    'the live file is bounded near the cap, not unbounded'
  );
});

// ── robustness: telemetry must never throw into the app ───────────────────────

test('an append failure does not throw out of sample()', () => {
  const h = makeHarness({ append: () => { throw new Error('disk full'); } });
  h.setPercent(20);
  assert.doesNotThrow(() => h.telemetry.sample(), 'append failure is swallowed');
});

test('a rotate failure still lets the sample append', () => {
  let appended = 0;
  const h = makeHarness({
    maxBytes: 1, // force a rotation attempt every tick
    rotate: () => { throw new Error('rename failed'); },
    append: () => { appended++; },
    size: () => 1000,
  });
  h.setPercent(20);
  assert.doesNotThrow(() => h.telemetry.sample());
  assert.equal(appended, 1, 'the sample still appended despite the rotate failure');
});

test('heapSizeLimit of 0 does not divide-by-zero and never warns', () => {
  const h = makeHarness({
    readHeap: () => ({ heapUsed: 1000, heapTotal: 1000, heapSizeLimit: 0, external: 0, malloced: 0 }),
  });
  assert.doesNotThrow(() => h.telemetry.sample());
  assert.equal(h.logs.length, 0, 'no warning when the limit is unknown');
});

// ── per-part line kinds ───────────────────────────────────────────────────────

function kindsOf(lines: string[]): string[] {
  return lines.map((l) => JSON.parse(l).kind);
}

test('the heap line now carries kind:"heap" and no providers means heap-only', () => {
  const h = makeHarness();
  h.telemetry.sample();
  assert.deepEqual(kindsOf(h.lines), ['heap'], 'exactly one heap line with no providers wired');
  assert.equal(JSON.parse(h.lines[0]).kind, 'heap');
});

test('a wired process provider appends a processes line each tick', () => {
  const h = makeHarness({
    readProcesses: () => [
      { type: 'Browser', pid: 1, rss: 100 },
      { type: 'Tab', pid: 2, rss: 50 },
    ],
  });
  h.telemetry.sample();
  assert.deepEqual(kindsOf(h.lines), ['heap', 'processes']);
  const rec = JSON.parse(h.lines[1]);
  assert.equal(rec.procs.length, 2);
  assert.equal(rec.procs[0].type, 'Browser');
  assert.equal(rec.procs[0].rss, 100);
});

test('wired gauges append a subsystems line; array-returning gauges are flattened', () => {
  const h = makeHarness({
    gauges: [
      { name: 'chat-ring', read: () => ({ name: 'chat-ring', count: 12, bytes: 2048 }) },
      { name: 'runners', read: () => [
        { name: 'live-runners', count: 3 },
        { name: 'terminal-rings', count: 900, bytes: 4096 },
      ] },
    ],
  });
  h.telemetry.sample();
  assert.deepEqual(kindsOf(h.lines), ['heap', 'subsystems']);
  const rec = JSON.parse(h.lines[1]);
  assert.equal(rec.gauges.length, 3, 'array reading flattened into the batch');
  assert.equal(rec.gauges[0].bytes, 2048);
  assert.equal(rec.gauges[1].name, 'live-runners');
  assert.equal(rec.gauges[1].bytes, undefined, 'a count-only gauge omits bytes');
});

test('a throwing gauge is isolated: the rest of the batch still emits, and it warns once', () => {
  let goodReads = 0;
  const h = makeHarness({
    gauges: [
      { name: 'bad', read: () => { throw new Error('kaboom'); } },
      { name: 'good', read: () => { goodReads++; return { name: 'good', count: 1 }; } },
    ],
  });
  h.telemetry.sample();
  h.telemetry.sample();
  const subLines = h.lines.filter((l) => JSON.parse(l).kind === 'subsystems');
  assert.equal(subLines.length, 2, 'a bad gauge never blanks the subsystems line');
  assert.equal(JSON.parse(subLines[0]).gauges[0].name, 'good', 'only the good reading survives');
  assert.equal(goodReads, 2, 'the good gauge still ran both ticks');
  const failLogs = h.logs.filter((l) => l.includes('"bad"'));
  assert.equal(failLogs.length, 1, 'a persistently-failing gauge warns once, not every tick');
});

test('a throwing process provider skips only its line and warns once', () => {
  const h = makeHarness({ readProcesses: () => { throw new Error('metrics down'); } });
  h.telemetry.sample();
  h.telemetry.sample();
  assert.deepEqual(kindsOf(h.lines), ['heap', 'heap'], 'heap lines still land; no process line');
  assert.equal(
    h.logs.filter((l) => l.includes('process-metrics provider failed')).length,
    1,
    'process provider failure logged once',
  );
});

test('sampleAgents emits an agents line; a throwing provider skips + warns once', () => {
  const ok = makeHarness({
    readAgents: () => [{ agentId: 'a1', rss: 1000, pidCount: 2, source: 'job' }],
  });
  ok.telemetry.sampleAgents();
  assert.deepEqual(kindsOf(ok.lines), ['agents']);
  const rec = JSON.parse(ok.lines[0]);
  assert.equal(rec.perAgent[0].agentId, 'a1');
  assert.equal(rec.perAgent[0].rss, 1000);

  const bad = makeHarness({ readAgents: () => { throw new Error('cache cold'); } });
  bad.telemetry.sampleAgents();
  bad.telemetry.sampleAgents();
  assert.equal(bad.lines.length, 0, 'no agents line on failure');
  assert.equal(
    bad.logs.filter((l) => l.includes('per-agent memory provider failed')).length,
    1,
    'agent provider failure logged once',
  );
});

test('rotation stays correct with mixed line kinds and keeps the live file bounded', () => {
  // Small cap + all providers wired so every tick writes heap+processes+subsystems.
  const h = makeHarness({
    maxBytes: 400,
    readProcesses: () => [{ type: 'Browser', pid: 1, rss: 100 }],
    gauges: [{ name: 'g', read: () => ({ name: 'g', count: 1, bytes: 10 }) }],
  });
  for (let i = 0; i < 30; i++) h.telemetry.sample();
  assert.ok(h.rotations >= 1, 'the cap trips a rotation even with multi-kind lines');
  // Every rotated + live line is still valid JSON of a known kind.
  const all = [...h.rotated, ...h.lines];
  for (const l of all) {
    const k = JSON.parse(l).kind;
    assert.ok(['heap', 'processes', 'subsystems'].includes(k), `known kind, got ${k}`);
  }
  const liveBytes = h.lines.reduce((n, l) => n + Buffer.byteLength(l), 0);
  assert.ok(liveBytes <= 400 + 300, 'live file bounded near the cap, not unbounded');
});

// ── WP-8: log-retention-sweep line through the SINGLE writer ───────────────────

const SWEEP_EVENT = {
  beforeBytes: 5000,
  afterBytes: 3000,
  removedFiles: 4,
  reclaimedBytes: 2000,
  reclaimedAgents: 2,
  targetBytes: 2 * 1024 ** 3,
  outcome: 'swept-to-target' as const,
  durationMs: 1234,
  scanErrors: 0,
};

test('emitLogRetentionSweep appends one log-retention-sweep line with all actual fields', () => {
  const h = makeHarness();
  h.setTime(Date.parse('2026-07-27T09:00:00.000Z'));
  h.telemetry.emitLogRetentionSweep(SWEEP_EVENT);
  assert.equal(h.lines.length, 1, 'exactly one line');
  const rec = JSON.parse(h.lines[0]);
  assert.equal(rec.kind, 'log-retention-sweep');
  assert.equal(rec.t, '2026-07-27T09:00:00.000Z', 'ISO timestamp from the injected clock');
  assert.equal(rec.beforeBytes, 5000);
  assert.equal(rec.afterBytes, 3000);
  assert.equal(rec.removedFiles, 4);
  assert.equal(rec.reclaimedBytes, 2000);
  assert.equal(rec.reclaimedAgents, 2);
  assert.equal(rec.reclaimedBytes, rec.beforeBytes - rec.afterBytes, 'before/after are consistent actuals');
  assert.equal(rec.outcome, 'swept-to-target');
  assert.equal(rec.durationMs, 1234);
  assert.equal(rec.scanErrors, 0);
});

test('emitLogRetentionSweep goes through the SINGLE writer — same append + rotation, no second rotator', () => {
  // Mutation guard: a second appender/rotator would bypass the injected
  // `append`/`rotate`/`size` deps. Fill near the cap with heap lines, then emit
  // a sweep line: it must (a) land in the SAME live buffer and (b) rotate via
  // the SAME injected rotate — never its own file/rotator.
  const h = makeHarness({ maxBytes: 300 });
  h.setPercent(10);
  h.telemetry.sample(); // one heap line, still under the cap
  const rotationsBefore = h.rotations;
  // Pad the live file right up against the cap so the next write must rotate.
  while (h.lines.reduce((n, l) => n + Buffer.byteLength(l), 0) < 300) h.telemetry.sample();
  const preSweepRotations = h.rotations;
  h.telemetry.emitLogRetentionSweep(SWEEP_EVENT);
  // The sweep line rotated the shared file (one more rotation via the injected
  // rotate) and then appended into the fresh live buffer.
  assert.ok(h.rotations > preSweepRotations, 'the sweep write rotated the SHARED file, not a private one');
  assert.ok(h.rotations >= rotationsBefore + 1);
  const sweepLines = [...h.rotated, ...h.lines].filter((l) => JSON.parse(l).kind === 'log-retention-sweep');
  assert.equal(sweepLines.length, 1, 'the sweep line lives in the same rotated/live stream as every other kind');
});

test('an append failure does not throw out of emitLogRetentionSweep', () => {
  const h = makeHarness({ append: () => { throw new Error('disk full'); } });
  assert.doesNotThrow(() => h.telemetry.emitLogRetentionSweep(SWEEP_EVENT));
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
