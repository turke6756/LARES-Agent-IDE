// Unit tests — per-agent budget + owned-process cap (full-D5, Wave 4). Run:
//   npm run build:main
//   node dist/main/main/watchdog/budget.test.js

import assert from 'node:assert/strict';
import {
  checkAgentBudget,
  checkOwnedProcessCap,
  DEFAULT_AGENT_BUDGET_BYTES,
  DEFAULT_MAX_OWNED_PROCESSES,
  type BudgetConfig,
} from './budget';
import type { AgentMemoryUsage, AppOwnedTotals } from './attribution';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const GiB = 1024 * 1024 * 1024;

function usage(over: Partial<AgentMemoryUsage>): AgentMemoryUsage {
  return { agentId: 'a', transport: 'conpty', cliTreeBytes: 0, cliCommitBytes: 0, commitComplete: true, pidCount: 1, source: 'job', ...over };
}
function totals(over: Partial<AppOwnedTotals>): AppOwnedTotals {
  return {
    electronProcessCount: 0, electronBytes: 0, ownedCliProcessCount: 0, ownedCliBytes: 0,
    totalOwnedProcessCount: 0, totalOwnedBytes: 0, ...over,
  };
}
const cfg: BudgetConfig = { perAgentBudgetBytes: 4 * GiB, maxOwnedProcesses: 100 };

// ── per-agent budget ──────────────────────────────────────────────────────────

test('under budget → allowed', () => {
  assert.equal(checkAgentBudget(usage({ cliTreeBytes: 1 * GiB }), cfg).allowed, true);
});

test('at/over budget → refused with memory-budget code', () => {
  const d = checkAgentBudget(usage({ cliTreeBytes: 4 * GiB }), cfg);
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'memory-budget');
  assert.match(d.reason!, /budget/);
});

test('fail-open: null usage allowed', () => {
  assert.equal(checkAgentBudget(null, cfg).allowed, true);
  assert.equal(checkAgentBudget(undefined, cfg).allowed, true);
});

test('fail-open: unmeasured tree (source none / 0 pids) allowed even if bytes look high', () => {
  assert.equal(checkAgentBudget(usage({ source: 'none', cliTreeBytes: 99 * GiB, pidCount: 0 }), cfg).allowed, true);
  assert.equal(checkAgentBudget(usage({ pidCount: 0, cliTreeBytes: 99 * GiB }), cfg).allowed, true);
});

test('default budget is generous (6 GiB)', () => {
  assert.equal(DEFAULT_AGENT_BUDGET_BYTES, 6 * GiB);
  // 3 GiB is fine against the default.
  assert.equal(checkAgentBudget(usage({ cliTreeBytes: 3 * GiB })).allowed, true);
});

// ── whole-app owned-process cap ─────────────────────────────────────────────────

test('under cap → allowed', () => {
  assert.equal(checkOwnedProcessCap(totals({ totalOwnedProcessCount: 99 }), cfg).allowed, true);
});

test('at/over cap → refused with memory-capacity code', () => {
  const d = checkOwnedProcessCap(totals({ totalOwnedProcessCount: 100, electronProcessCount: 60, ownedCliProcessCount: 40 }), cfg);
  assert.equal(d.allowed, false);
  assert.equal(d.code, 'memory-capacity');
  assert.match(d.reason!, /cap 100/);
});

test('fail-open: null totals allowed', () => {
  assert.equal(checkOwnedProcessCap(null, cfg).allowed, true);
});

test('default cap constant is exported and positive', () => {
  assert.ok(DEFAULT_MAX_OWNED_PROCESSES > 350);
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
