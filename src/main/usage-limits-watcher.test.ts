// Unit tests for the usage-limits watcher pure seams + the statusline record
// builders. plans/usage-limits-mcp-and-ui.md §5.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/usage-limits-watcher.test.js

import assert from 'node:assert/strict';
import {
  toReading,
  mergeRawRecord,
  parseRawRecord,
  normalizeResetsAt,
  type UsageLastKnown,
} from './usage-limits-watcher';
import {
  buildUsageStatusText,
  buildUsageRawRecord,
} from '../shared/usage-limits-record';
import type { UsageLimitsRawRecord } from '../shared/types';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const STALE_MS = 15 * 60 * 1000; // pass explicitly so the env override can't perturb tests
const NOW = 1_700_000_000_000;   // fixed "now" in ms

// ── toReading ────────────────────────────────────────────────────────

test('toReading: empty last-known → no_reading_yet, unavailable', () => {
  const lk: UsageLastKnown = { five_hour: null, seven_day: null };
  const r = toReading(lk, NOW, STALE_MS);
  assert.equal(r.available, false);
  assert.equal(r.reason, 'no_reading_yet');
  assert.equal(r.account_wide, true);
  assert.equal(r.five_hour, undefined);
});

test('toReading: fresh window → not stale + correct resets_in_seconds', () => {
  const resetsAtSec = Math.floor(NOW / 1000) + 3600; // 1h out, in seconds
  const lk: UsageLastKnown = {
    five_hour: { used_percentage: 42, resets_at: resetsAtSec, captured_at: NOW - 10_000 },
    seven_day: null,
  };
  const r = toReading(lk, NOW, STALE_MS);
  assert.equal(r.available, true);
  assert.equal(r.account_wide, true);
  assert.equal(r.source, 'claude_statusline');
  assert.ok(r.five_hour, 'five_hour present');
  assert.equal(r.five_hour!.used_percentage, 42);
  assert.equal(r.five_hour!.stale, false);
  assert.equal(r.five_hour!.resets_at_ms, resetsAtSec * 1000);
  assert.equal(r.five_hour!.resets_in_seconds, 3600);
  assert.equal(r.seven_day, null);
  // overall captured_at = max observed
  assert.equal(r.captured_at, NOW - 10_000);
  assert.equal(r.stale, false);
});

test('toReading: window older than staleMs → that window stale', () => {
  const lk: UsageLastKnown = {
    five_hour: { used_percentage: 10, resets_at: Math.floor(NOW / 1000) + 60, captured_at: NOW - (STALE_MS + 60_000) },
    seven_day: { used_percentage: 20, resets_at: Math.floor(NOW / 1000) + 120, captured_at: NOW - 1_000 },
  };
  const r = toReading(lk, NOW, STALE_MS);
  assert.ok(r.five_hour && r.seven_day);
  assert.equal(r.five_hour!.stale, true, 'old five_hour is stale');
  assert.equal(r.seven_day!.stale, false, 'fresh seven_day is not stale');
  // overall captured_at = max = the fresh one; overall not stale
  assert.equal(r.captured_at, NOW - 1_000);
  assert.equal(r.stale, false);
});

test('toReading: resets in the past → resets_in_seconds clamps to 0', () => {
  const lk: UsageLastKnown = {
    five_hour: { used_percentage: 99, resets_at: Math.floor(NOW / 1000) - 60, captured_at: NOW - 500 },
    seven_day: null,
  };
  const r = toReading(lk, NOW, STALE_MS);
  assert.equal(r.five_hour!.resets_in_seconds, 0);
});

// ── merge (per-window last-known) ────────────────────────────────────

test('mergeRawRecord: a five-hour-only event does NOT erase a known seven-day value', () => {
  const lk: UsageLastKnown = {
    five_hour: { used_percentage: 5, resets_at: 111, captured_at: NOW - 20_000 },
    seven_day: { used_percentage: 30, resets_at: 222, captured_at: NOW - 20_000 },
  };
  const fiveHourOnly: UsageLimitsRawRecord = {
    schema: 1, source: 'claude_statusline', captured_at: NOW,
    session_id: null, agent_id: null, claude_project_dir: null,
    five_hour: { used_percentage: 8, resets_at: 333 },
  };
  const changed = mergeRawRecord(lk, fiveHourOnly);
  assert.equal(changed, true);
  assert.equal(lk.five_hour!.used_percentage, 8, 'five_hour updated');
  assert.equal(lk.five_hour!.captured_at, NOW);
  assert.ok(lk.seven_day, 'seven_day survives a five-hour-only event');
  assert.equal(lk.seven_day!.used_percentage, 30, 'seven_day value untouched');
  assert.equal(lk.seven_day!.captured_at, NOW - 20_000, 'seven_day captured_at untouched');
});

test('mergeRawRecord: an older captured_at does NOT overwrite a newer window', () => {
  const lk: UsageLastKnown = {
    five_hour: { used_percentage: 50, resets_at: 111, captured_at: NOW },
    seven_day: null,
  };
  const stale: UsageLimitsRawRecord = {
    schema: 1, source: 'claude_statusline', captured_at: NOW - 60_000,
    session_id: null, agent_id: null, claude_project_dir: null,
    five_hour: { used_percentage: 1, resets_at: 999 },
  };
  const changed = mergeRawRecord(lk, stale);
  assert.equal(changed, false, 'older record makes no change');
  assert.equal(lk.five_hour!.used_percentage, 50, 'newer value preserved');
});

// ── normalizeResetsAt ────────────────────────────────────────────────

test('normalizeResetsAt: seconds → ms; ms passthrough', () => {
  assert.equal(normalizeResetsAt(1_700_000_000), 1_700_000_000_000, 'unix seconds scaled to ms');
  assert.equal(normalizeResetsAt(1_700_000_000_000), 1_700_000_000_000, 'ms value passes through');
  assert.equal(normalizeResetsAt(0), 0);
});

// ── parseRawRecord ───────────────────────────────────────────────────

test('parseRawRecord: malformed / empty → null', () => {
  assert.equal(parseRawRecord(''), null);
  assert.equal(parseRawRecord('not json'), null);
  assert.equal(parseRawRecord('{}'), null, 'no captured_at → null');
  assert.equal(parseRawRecord(JSON.stringify({ captured_at: 1 })), null, 'no windows → null');
});

test('parseRawRecord: keeps only observed, well-formed windows', () => {
  const rec = parseRawRecord(JSON.stringify({
    captured_at: NOW, session_id: 's', agent_id: 'a', claude_project_dir: 'd',
    five_hour: { used_percentage: 12, resets_at: 500 },
    seven_day: { used_percentage: 'bad' }, // malformed → dropped
  }));
  assert.ok(rec);
  assert.equal(rec!.captured_at, NOW);
  assert.deepEqual(rec!.five_hour, { used_percentage: 12, resets_at: 500 });
  assert.equal(rec!.seven_day, undefined, 'malformed seven_day dropped');
});

// ── statusline record builder (pure, embedded verbatim in the .mjs) ───

test('buildUsageRawRecord: no rate_limits → null (script prints line, does not write)', () => {
  assert.equal(buildUsageRawRecord({ model: { id: 'x' } }, 'a', 'd', NOW), null);
  assert.equal(buildUsageRawRecord(null, 'a', 'd', NOW), null);
});

test('buildUsageRawRecord: partial windows → only observed keys present', () => {
  const rec = buildUsageRawRecord(
    { session_id: 'sid', rate_limits: { five_hour: { used_percentage: 20, resets_at: 900 } } },
    'agent-1', '/proj', NOW,
  );
  assert.ok(rec);
  assert.equal(rec.schema, 1);
  assert.equal(rec.source, 'claude_statusline');
  assert.equal(rec.captured_at, NOW);
  assert.equal(rec.session_id, 'sid');
  assert.equal(rec.agent_id, 'agent-1');
  assert.equal(rec.claude_project_dir, '/proj');
  assert.deepEqual(rec.five_hour, { used_percentage: 20, resets_at: 900 });
  assert.ok(!('seven_day' in rec), 'absent window omitted');
});

test('buildUsageStatusText: malformed blob → still returns a non-empty line', () => {
  assert.equal(buildUsageStatusText(null), 'claude');
  assert.equal(buildUsageStatusText({}), 'claude');
});

test('buildUsageStatusText: context% present vs absent formatting', () => {
  const withCtx = buildUsageStatusText({
    model: { display_name: 'Opus' },
    workspace: { current_dir: '/home/me/proj' },
    context_window: { remaining_percentage: 73 },
    rate_limits: { five_hour: { used_percentage: 40 }, seven_day: { used_percentage: 12 } },
  });
  assert.equal(withCtx, 'Opus | proj | ctx 73% left | 5h 40% | 7d 12%');

  const noCtx = buildUsageStatusText({
    model: { display_name: 'Opus' },
    workspace: { current_dir: '/home/me/proj' },
    rate_limits: { five_hour: { used_percentage: 40 } },
  });
  assert.equal(noCtx, 'Opus | proj | 5h 40%', 'no context field → ctx segment dropped; only observed windows shown');
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
