import assert from 'node:assert/strict';
import {
  LAUNCHABLE_AGENT_PROVIDERS,
  type LaunchableAgentProvider,
  type PrerequisiteCheck,
  type RuntimePrerequisiteReport,
  type UsageLimitsReading,
  type UsageWindowReading,
} from '../shared/types';
import { resolveProviderAvailability } from './provider-availability';
import {
  __resetProviderObservationsForTest,
  clearProviderObservation,
  getProviderObservations,
  noteProviderObservation,
  type ProviderRuntimeObservation,
} from './supervisor/provider-runtime-observations';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, run: () => void): void { tests.push({ name, run }); }

const NOW = 2_000_000;
const EMPTY_USAGE: UsageLimitsReading = {
  available: false,
  reason: 'no_reading_yet',
  account_wide: true,
};

function prerequisite(provider: LaunchableAgentProvider, status: 'available' | 'missing'): PrerequisiteCheck {
  return {
    id: provider,
    label: provider,
    status,
    tier: 'agent-cli',
    impact: '',
    remediation: '',
  };
}

function report(statuses: Partial<Record<LaunchableAgentProvider, 'available' | 'missing'>> = {}): RuntimePrerequisiteReport {
  const providers = LAUNCHABLE_AGENT_PROVIDERS.map(provider => prerequisite(provider, statuses[provider] ?? 'available'));
  return {
    appVersion: 'test',
    checkedAt: NOW - 10,
    providers,
    anyProviderAvailable: providers.some(row => row.status === 'available'),
    optional: [],
    wsl: [],
    wslChecked: false,
    wslStatus: { state: 'unavailable', distros: [] },
  };
}

function window(used: number, stale = false, capturedAt = NOW - 100): UsageWindowReading {
  return {
    used_percentage: used,
    resets_at: NOW + 10_000,
    resets_at_ms: NOW + 10_000,
    resets_in_seconds: 10,
    captured_at: capturedAt,
    age_seconds: (NOW - capturedAt) / 1000,
    stale,
  };
}

function usage(fiveHour: UsageWindowReading | null, sevenDay: UsageWindowReading | null): UsageLimitsReading {
  return {
    available: true,
    account_wide: true,
    source: 'claude_statusline',
    five_hour: fiveHour,
    seven_day: sevenDay,
  };
}

function resolve(
  usageLimits: UsageLimitsReading = EMPTY_USAGE,
  prerequisiteReport: RuntimePrerequisiteReport = report(),
  observations = new Map<LaunchableAgentProvider, ProviderRuntimeObservation[]>(),
) {
  return resolveProviderAvailability({ prerequisiteReport, usageLimits, observations, now: NOW });
}

test('returns all four providers in canonical order with the static installed floor', () => {
  const rows = resolve(EMPTY_USAGE, report({ grok: 'missing' }));
  assert.deepEqual(rows.map(row => row.provider), LAUNCHABLE_AGENT_PROVIDERS);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.find(row => row.provider === 'grok'), {
    provider: 'grok',
    status: 'unavailable',
    installed: false,
    reasons: ['not-detected'],
    evidence: [{
      reason: 'not-detected',
      detail: 'grok launch binary was not detected',
      observedAt: NOW - 10,
      source: 'static',
    }],
  });
  assert.equal(rows.find(row => row.provider === 'codex')?.installed, true);
  assert.equal(rows.find(row => row.provider === 'codex')?.status, 'available');
});

test('static not-detected wins and runtime observations cannot upgrade or add overlays', () => {
  const observations = new Map<LaunchableAgentProvider, ProviderRuntimeObservation[]>([
    ['agy', [{ reason: 'auth-banner', detail: 'sign in', observedAt: NOW - 1 }]],
  ]);
  const agy = resolve(EMPTY_USAGE, report({ agy: 'missing' }), observations)
    .find(row => row.provider === 'agy')!;
  assert.equal(agy.installed, false);
  assert.equal(agy.status, 'unavailable');
  assert.deepEqual(agy.reasons, ['not-detected']);
  assert.equal(agy.evidence.length, 1);
});

test('simultaneous runtime reasons use deterministic severity order', () => {
  const observations = new Map<LaunchableAgentProvider, ProviderRuntimeObservation[]>([
    ['claude', [
      { reason: 'free-usage-limit', detail: 'free limit', observedAt: NOW - 2 },
      { reason: 'auth-banner', detail: 'sign in', observedAt: NOW - 1 },
    ]],
  ]);
  const claude = resolve(usage(window(100), null), report(), observations)
    .find(row => row.provider === 'claude')!;
  assert.equal(claude.status, 'unavailable');
  assert.deepEqual(claude.reasons, ['auth-banner', 'free-usage-limit', 'quota-exhausted']);
  assert.deepEqual(claude.evidence.map(item => item.reason), claude.reasons);
});

for (const key of ['five_hour', 'seven_day'] as const) {
  for (const [percentage, status, reason] of [
    [95, 'degraded', 'quota-near-limit'],
    [99, 'degraded', 'quota-near-limit'],
    [100, 'unavailable', 'quota-exhausted'],
  ] as const) {
    test(`claude ${key} ${percentage}% boundary is ${status}`, () => {
      const reading = window(percentage);
      const limits = usage(key === 'five_hour' ? reading : null, key === 'seven_day' ? reading : null);
      const claude = resolve(limits).find(row => row.provider === 'claude')!;
      assert.equal(claude.status, status);
      assert.deepEqual(claude.reasons, [reason]);
    });
  }
}

test('max fresh Claude window drives status', () => {
  const claude = resolve(usage(window(100), window(95))).find(row => row.provider === 'claude')!;
  assert.equal(claude.status, 'unavailable');
  assert.deepEqual(claude.reasons, ['quota-exhausted']);
  assert.equal(claude.quota?.note, '5-hour 100% used');
});

test('stale 100% does not suppress fresh 95% degraded status', () => {
  const claude = resolve(usage(window(100, true), window(95, false)))
    .find(row => row.provider === 'claude')!;
  assert.equal(claude.status, 'degraded');
  assert.deepEqual(claude.reasons, ['quota-near-limit']);
  assert.equal(claude.quota?.note, '7-day 95% used');
  assert.equal(claude.quota?.stale, undefined);
});

test('stale-only Claude data is one informational quota note and never downgrades', () => {
  const claude = resolve(usage(window(100, true), window(80, true)))
    .find(row => row.provider === 'claude')!;
  assert.equal(claude.status, 'available');
  assert.deepEqual(claude.reasons, []);
  assert.equal(claude.evidence.length, 0);
  assert.equal(claude.quota?.note, '5-hour 100% used');
  assert.equal(claude.quota?.stale, true);
});

test('equal Claude percentages prefer seven_day deterministically', () => {
  const claude = resolve(usage(window(95, false, NOW - 200), window(95, false, NOW - 100)))
    .find(row => row.provider === 'claude')!;
  assert.equal(claude.quota?.note, '7-day 95% used');
  assert.equal(claude.quota?.observedAt, NOW - 100);
});

test('runtime observation projects to evidence and free-limit quota until reset expiry', () => {
  const observations = new Map<LaunchableAgentProvider, ProviderRuntimeObservation[]>([
    ['grok', [{
      reason: 'free-usage-limit', detail: 'Free usage exhausted', observedAt: NOW - 20, resetsAt: NOW + 1,
    }]],
  ]);
  const grok = resolve(EMPTY_USAGE, report(), observations).find(row => row.provider === 'grok')!;
  assert.deepEqual(grok.evidence, [{
    reason: 'free-usage-limit', detail: 'Free usage exhausted', observedAt: NOW - 20,
    source: 'runtime_observation',
  }]);
  assert.deepEqual(grok.quota, {
    source: 'runtime_observation', note: 'Free usage exhausted', observedAt: NOW - 20, resetsAt: NOW + 1,
  });

  observations.set('grok', [{
    reason: 'free-usage-limit', detail: 'expired', observedAt: NOW - 20, resetsAt: NOW,
  }]);
  assert.equal(resolve(EMPTY_USAGE, report(), observations).find(row => row.provider === 'grok')?.status, 'available');
});

test('registry retains simultaneous reasons and clearing requires a specific reason', () => {
  __resetProviderObservationsForTest();
  noteProviderObservation('agy', 'auth-banner', 'sign in', NOW - 2);
  noteProviderObservation('agy', 'free-usage-limit', 'limit', NOW - 1);
  clearProviderObservation('agy', 'auth-banner');
  assert.deepEqual(getProviderObservations(NOW).get('agy'), [
    { reason: 'free-usage-limit', detail: 'limit', observedAt: NOW - 1, resetsAt: undefined },
  ]);
  __resetProviderObservationsForTest();
});

test('registry parsed reset expiry drops only the expired entry', () => {
  __resetProviderObservationsForTest();
  noteProviderObservation('grok', 'free-usage-limit', 'expired', NOW - 2, NOW);
  noteProviderObservation('grok', 'auth-banner', 'retained', NOW - 1, NOW + 1);
  assert.deepEqual(getProviderObservations(NOW).get('grok'), [
    { reason: 'auth-banner', detail: 'retained', observedAt: NOW - 1, resetsAt: NOW + 1 },
  ]);
  __resetProviderObservationsForTest();
});

let failed = 0;
for (const testCase of tests) {
  try {
    testCase.run();
    console.log(`  PASS  ${testCase.name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL  ${testCase.name}`);
    console.error(error);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
if (failed) process.exitCode = 1;
