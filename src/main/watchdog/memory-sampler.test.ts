// Memory watchdog sampler + admission unit tests (incident §5 D5-lite).
//   npm run build:main
//   node dist/main/main/watchdog/memory-sampler.test.js

import assert from 'node:assert/strict';
import { MemorySampler, type MemorySamplerDeps } from './memory-sampler';
import type { CommitReading } from './types';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

/** A reading at a given commit percentage with a fixed 128 GB limit. */
function readingAtPercent(pct: number): CommitReading {
  const limit = 128 * 1024 ** 3;
  const charge = Math.round((pct / 100) * limit);
  return {
    source: 'windows-native',
    commitLimitBytes: limit,
    commitChargeBytes: charge,
    commitAvailableBytes: limit - charge,
    physicalTotalBytes: 32 * 1024 ** 3,
    physicalAvailableBytes: 4 * 1024 ** 3,
  };
}

interface Harness {
  sampler: MemorySampler;
  setPercent(pct: number | null): void;
  setCounts(c: Partial<{ agents: number; procs: number; views: number; appBytes: number }>): void;
  setTime(t: number): void;
  logs: string[];
}

function makeHarness(config?: MemorySamplerDeps['config']): Harness {
  let pct: number | null = 10;
  let t = 1_000_000;
  const counts = { agents: 0, procs: 10, views: 0, appBytes: 0 };
  const logs: string[] = [];
  const deps: MemorySamplerDeps = {
    readCommit: () => (pct === null ? null : readingAtPercent(pct)),
    getLiveAgentCount: () => counts.agents,
    getAgentViewCount: () => counts.views,
    getElectronProcessCount: () => counts.procs,
    getAppMemoryBytes: () => counts.appBytes,
    now: () => t,
    log: (m) => logs.push(m),
    config,
  };
  const sampler = new MemorySampler(deps);
  return {
    sampler,
    setPercent: (p) => { pct = p; },
    setCounts: (c) => Object.assign(counts, c),
    setTime: (nt) => { t = nt; },
    logs,
  };
}

// ── hysteresis: warn band ─────────────────────────────────────────────────────

test('Warn trips at 75% and clears only below 70% (hysteresis)', () => {
  const h = makeHarness();
  h.setPercent(74); h.sampler.sample();
  assert.equal(h.sampler.getLevel(), 'normal', '74% is below the 75% warn trip');
  h.setPercent(76); h.sampler.sample();
  assert.equal(h.sampler.getLevel(), 'warn', '76% trips Warn');
  h.setPercent(72); h.sampler.sample();
  assert.equal(h.sampler.getLevel(), 'warn', '72% holds Warn (above the 70% clear)');
  h.setPercent(69); h.sampler.sample();
  assert.equal(h.sampler.getLevel(), 'normal', '69% clears Warn');
});

// ── hysteresis: critical band + admission ─────────────────────────────────────

test('Critical trips at 88%, clears only below 80%, and refuses admission while set', () => {
  const h = makeHarness();
  h.setPercent(87); h.sampler.sample();
  assert.equal(h.sampler.getLevel(), 'warn', '87% is Warn, not yet Critical');
  assert.equal(h.sampler.canLaunchAgent().allowed, true, 'Warn still admits launches');

  h.setPercent(89); h.sampler.sample();
  assert.equal(h.sampler.getLevel(), 'critical', '89% trips Critical');
  assert.equal(h.sampler.isCriticalPressure(), true);
  const launch = h.sampler.canLaunchAgent();
  assert.equal(launch.allowed, false, 'Critical refuses new agent launch');
  assert.equal(launch.code, 'memory-critical', 'machine-readable code attached');
  assert.equal(h.sampler.canOpenAgentTab().code, 'memory-critical', 'Critical refuses new agent tab');

  h.setPercent(82); h.sampler.sample();
  assert.equal(h.sampler.getLevel(), 'critical', '82% holds Critical (above the 80% clear)');

  h.setPercent(79); h.sampler.sample();
  assert.equal(h.sampler.getLevel(), 'warn', '79% clears Critical, lands back in Warn');
  assert.equal(h.sampler.canLaunchAgent().allowed, true, 'clearing Critical re-admits launches');
});

test('D1 auto-reload is suppressed only while Critical', () => {
  const h = makeHarness();
  h.setPercent(50); h.sampler.sample();
  assert.equal(h.sampler.shouldSuppressAutoReload(), false);
  h.setPercent(90); h.sampler.sample();
  assert.equal(h.sampler.shouldSuppressAutoReload(), true, 'Critical suppresses auto-reload');
});

// ── static caps: fail-closed ──────────────────────────────────────────────────

test('static agent cap is enforced even at low pressure', () => {
  const h = makeHarness({ maxLiveAgents: 32 });
  h.setPercent(10); h.setCounts({ agents: 32 }); h.sampler.sample();
  const d = h.sampler.canLaunchAgent();
  assert.equal(d.allowed, false, 'at the 32-agent cap, launch is refused');
  assert.equal(d.code, 'memory-capacity');
  // A tab open is not bound by the agent cap.
  assert.equal(h.sampler.canOpenAgentTab().allowed, true, 'agent cap does not block tab opens');
});

test('static Electron-process cap blocks both launches and tabs', () => {
  const h = makeHarness({ maxElectronProcesses: 350 });
  h.setPercent(10); h.setCounts({ procs: 350 }); h.sampler.sample();
  assert.equal(h.sampler.canLaunchAgent().code, 'memory-capacity');
  assert.equal(h.sampler.canOpenAgentTab().code, 'memory-capacity');
});

// ── sampler failure: fail-closed caps, fail-open commit rules, unknown meter ──

test('sampler failure suspends commit rules but keeps static caps; meter unknown; logs once', () => {
  const h = makeHarness({ maxLiveAgents: 32 });
  h.setPercent(95); h.sampler.sample();
  assert.equal(h.sampler.isCriticalPressure(), true, 'baseline Critical while known');

  h.setPercent(null); // sampler fails
  const snap = h.sampler.sample();
  assert.equal(snap.commitKnown, false, 'commit is unknown');
  assert.equal(snap.commitPercent, null, 'meter shows unknown (null %)');
  assert.equal(snap.staticCapsOnly, true);
  assert.equal(h.sampler.isCriticalPressure(), false, 'commit rule fails OPEN when unknown');
  assert.equal(h.sampler.shouldSuppressAutoReload(), false, 'auto-reload permitted when unknown');
  assert.equal(h.sampler.canLaunchAgent().allowed, true, 'commit-Critical refusal suspended');

  // Static cap still bites with no telemetry.
  h.setCounts({ agents: 32 });
  assert.equal(h.sampler.canLaunchAgent().code, 'memory-capacity', 'static cap still fail-closed');

  // Failure logged exactly once across repeated failed samples.
  h.sampler.sample();
  h.sampler.sample();
  const failureLines = h.logs.filter((l) => l.includes('commit sampler unavailable'));
  assert.equal(failureLines.length, 1, 'sampler failure is logged exactly once per episode');
});

// ── fast commit growth below the band stays admitted (thresholds only) ────────

test('fast commit growth below 88% stays below Critical — only the threshold trips', () => {
  const h = makeHarness();
  const base = 2_000_000;
  // 50% → 70% over 5 minutes: steep, but still under the 88% trip.
  for (let min = 0; min <= 5; min++) {
    h.setTime(base + min * 60_000);
    h.setPercent(50 + min * 4);
    h.sampler.sample();
  }
  assert.equal(h.sampler.getLevel(), 'normal', 'sub-warn commit stays normal regardless of growth rate');
  assert.equal(h.sampler.canLaunchAgent().allowed, true, 'launches admitted below the thresholds');
});

// ── snapshot passthrough of local counts ──────────────────────────────────────

test('snapshot carries app process/agent/view counts and fires onSnapshot', () => {
  let pushed: number | null = null;
  const counts = { agents: 3, procs: 42, views: 5, appBytes: 7 * 1024 ** 3 };
  let pct: number | null = 55;
  const sampler = new MemorySampler({
    readCommit: () => (pct === null ? null : readingAtPercent(pct)),
    getLiveAgentCount: () => counts.agents,
    getAgentViewCount: () => counts.views,
    getElectronProcessCount: () => counts.procs,
    getAppMemoryBytes: () => counts.appBytes,
    now: () => 5_000_000,
    onSnapshot: (s) => { pushed = s.appProcessCount; },
  });
  const snap = sampler.sample();
  assert.equal(snap.liveAgentCount, 3);
  assert.equal(snap.appProcessCount, 42);
  assert.equal(snap.agentViewCount, 5);
  assert.equal(snap.appMemoryBytes, counts.appBytes);
  assert.equal(pushed, 42, 'onSnapshot received the snapshot');
  void pct;
});

test('a throwing count provider degrades to 0, never crashes the sample', () => {
  const sampler = new MemorySampler({
    readCommit: () => readingAtPercent(20),
    getLiveAgentCount: () => { throw new Error('boom'); },
    getAgentViewCount: () => 0,
    getElectronProcessCount: () => 10,
    getAppMemoryBytes: () => 0,
    now: () => 1,
  });
  const snap = sampler.sample();
  assert.equal(snap.liveAgentCount, 0, 'throwing provider counts as 0');
  assert.equal(snap.level, 'normal');
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
