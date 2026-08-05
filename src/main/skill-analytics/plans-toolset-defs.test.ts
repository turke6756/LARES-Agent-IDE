// plans-toolset-defs regression (wave2-mcp-tool-observability §1.1). Real wiring:
// the production plans-aware provider sources the plans tool defs from
// scripts/mcp-tools-plans.js and the reverse map resolves them to the `plans`
// toolset. Pure-ish (require()s the CommonJS script via getScriptPath) —
// system-Node runner:
//   npm run build:main
//   node dist/main/main/skill-analytics/plans-toolset-defs.test.js
import assert from 'node:assert/strict';
import { buildMcpToolsetReverseMap } from './mcp-toolset-map';
import { makePlansAwareDefsProvider } from './plans-toolset-defs';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${(e as Error).message}`);
  }
}

test('provider sources the real plans tool defs', () => {
  const defs = makePlansAwareDefsProvider().defsFor('plans');
  assert.ok(Array.isArray(defs) && defs.length === 4, `expected 4 plans defs, got ${defs?.length}`);
  const names = defs!.map((d) => d.name);
  assert.ok(names.includes('read_plan_projection'), 'read_plan_projection present');
});

test('provider also sources the plans-read subset (GT-A WP-A4.5)', () => {
  const defs = makePlansAwareDefsProvider().defsFor('plans-read');
  assert.ok(Array.isArray(defs) && defs.length === 2, `expected exactly 2 plans-read defs, got ${defs?.length}`);
  const names = defs!.map((d) => d.name).sort();
  assert.deepEqual(names, ['read_plan_projection', 'record_planning_event']);
});

test('reverse map: first-wins routes shared reads to plans-read and focus_plan to plans', () => {
  // DASHBOARD_TOOLSETS lists plans-read BEFORE plans, and the reverse map is
  // name-only first-wins — so the remaining shared read-tool name resolves to
  // plans-read while focus_plan (only in plans) resolves to plans.
  const resolver = buildMcpToolsetReverseMap(makePlansAwareDefsProvider());
  assert.equal(resolver.resolve('mcp__agent-dashboard__focus_plan'), 'plans', 'focus_plan → plans');
  assert.equal(resolver.resolve('mcp__agent-dashboard__read_plan_projection'), 'plans-read');
});

test('non-plans toolsets still resolve through the decorated provider', () => {
  const resolver = buildMcpToolsetReverseMap(makePlansAwareDefsProvider());
  // observability-core is a base toolset (WP-F split); delegation must be intact.
  assert.equal(resolver.resolve('mcp__agent-dashboard__list_agents'), 'observability-core');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
