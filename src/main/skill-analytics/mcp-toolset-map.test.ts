// mcp-toolset-map unit tests (design §4.3). Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/skill-analytics/mcp-toolset-map.test.js
import assert from 'node:assert/strict';
import { buildMcpToolsetReverseMap, DASHBOARD_TOOLSETS, type ToolsetDefsLike } from './mcp-toolset-map';

// Fake provider mirroring real toolset → tool-name shape (bare names).
const fakeDefs: ToolsetDefsLike = {
  defsFor(toolset) {
    switch (toolset) {
      case 'observability':
        return [{ name: 'list_agents' }, { name: 'read_agent_log' }];
      case 'notebooks':
        return [{ name: 'execute_cell' }];
      case 'browser':
        return [{ name: 'browser_open_url' }];
      case 'unknown-toolset':
        return null; // provider miss
      default:
        return null;
    }
  },
};

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

test('resolves a known dashboard tool to its toolset', () => {
  const m = buildMcpToolsetReverseMap(fakeDefs, { toolsets: ['observability', 'notebooks', 'browser'] });
  assert.equal(m.resolve('mcp__agent-dashboard__list_agents'), 'observability');
  assert.equal(m.resolve('mcp__agent-dashboard__read_agent_log'), 'observability');
  assert.equal(m.resolve('mcp__agent-dashboard__execute_cell'), 'notebooks');
  assert.equal(m.resolve('mcp__agent-dashboard__browser_open_url'), 'browser');
  assert.equal(m.size, 4);
});

test('unresolved mcp__ name → null', () => {
  const m = buildMcpToolsetReverseMap(fakeDefs, { toolsets: ['observability'] });
  assert.equal(m.resolve('mcp__agent-dashboard__nonexistent_tool'), null);
  assert.equal(m.resolve('mcp__some-other-server__foo'), null);
});

test('non-mcp tool name → null (never a false toolset)', () => {
  const m = buildMcpToolsetReverseMap(fakeDefs, { toolsets: ['observability'] });
  assert.equal(m.resolve('Bash'), null);
  assert.equal(m.resolve('Skill'), null);
  assert.equal(m.resolve(''), null);
});

test('custom server name is honored', () => {
  const m = buildMcpToolsetReverseMap(fakeDefs, { toolsets: ['notebooks'], serverName: 'custom-srv' });
  assert.equal(m.resolve('mcp__custom-srv__execute_cell'), 'notebooks');
  assert.equal(m.resolve('mcp__agent-dashboard__execute_cell'), null);
});

test('missing toolset defs are skipped, not fatal', () => {
  const m = buildMcpToolsetReverseMap(fakeDefs, { toolsets: ['unknown-toolset', 'observability'] });
  assert.equal(m.size, 2);
  assert.equal(m.resolve('mcp__agent-dashboard__list_agents'), 'observability');
});

test('first toolset to claim a duplicated name wins (deterministic order)', () => {
  const dupDefs: ToolsetDefsLike = {
    defsFor(t) {
      return t === 'a' ? [{ name: 'shared' }] : t === 'b' ? [{ name: 'shared' }] : null;
    },
  };
  const m = buildMcpToolsetReverseMap(dupDefs, { toolsets: ['a', 'b'] });
  assert.equal(m.resolve('mcp__agent-dashboard__shared'), 'a');
});

// L1.1 registry-drift regression: `plans` is now a canonical toolset, and a
// provider that supplies plans defs maps every plans tool to the `plans` toolset
// (previously omitted → plans calls resolved to a NULL toolset).
test('DASHBOARD_TOOLSETS includes plans (L1.1 drift fix)', () => {
  assert.ok(DASHBOARD_TOOLSETS.includes('plans'), 'plans must be a canonical toolset');
});

test('DASHBOARD_TOOLSETS lists plans-read BEFORE plans (GT-A WP-A4.5 first-wins)', () => {
  const readIdx = DASHBOARD_TOOLSETS.indexOf('plans-read');
  const plansIdx = DASHBOARD_TOOLSETS.indexOf('plans');
  assert.ok(readIdx >= 0, 'plans-read must be a canonical toolset');
  assert.ok(plansIdx >= 0, 'plans must be a canonical toolset');
  assert.ok(readIdx < plansIdx, 'plans-read must precede plans so shared read names resolve to plans-read');
});

test('plans tools map to the plans toolset', () => {
  const plansDefs: ToolsetDefsLike = {
    defsFor(t) {
      return t === 'plans'
        ? [{ name: 'create_plan' }, { name: 'read_plan_section' }, { name: 'read_plan_projection' }]
        : t === 'observability-core'
          ? [{ name: 'list_agents' }]
          : null;
    },
  };
  // Default toolsets (which now include 'plans') are exercised here.
  const m = buildMcpToolsetReverseMap(plansDefs);
  assert.equal(m.resolve('mcp__agent-dashboard__create_plan'), 'plans');
  assert.equal(m.resolve('mcp__agent-dashboard__read_plan_section'), 'plans');
  assert.equal(m.resolve('mcp__agent-dashboard__read_plan_projection'), 'plans');
  // WP-F (P5): list_agents is an observability-CORE tool after the split.
  assert.equal(m.resolve('mcp__agent-dashboard__list_agents'), 'observability-core');
});

// WP-F (P5) split: DASHBOARD_TOOLSETS lists the two observability halves and NOT
// the pre-split `observability` union, so analytics tools resolve to
// `observability-analytics` (supervisor-exclusive → P2 lane inference works).
test('DASHBOARD_TOOLSETS splits observability into core + analytics (WP-F)', () => {
  assert.ok(DASHBOARD_TOOLSETS.includes('observability-core'), 'observability-core must be canonical');
  assert.ok(DASHBOARD_TOOLSETS.includes('observability-analytics'), 'observability-analytics must be canonical');
  assert.ok(!DASHBOARD_TOOLSETS.includes('observability'), 'the pre-split observability union must NOT be a canonical reverse-map toolset');
});

test('WP-F split: a core tool and an analytics tool resolve to their respective halves', () => {
  const splitDefs: ToolsetDefsLike = {
    defsFor(t) {
      return t === 'observability-core'
        ? [{ name: 'list_agents' }, { name: 'get_context_stats' }]
        : t === 'observability-analytics'
          ? [{ name: 'get_file_heat' }, { name: 'get_skill_usage' }]
          : null;
    },
  };
  const m = buildMcpToolsetReverseMap(splitDefs);
  assert.equal(m.resolve('mcp__agent-dashboard__list_agents'), 'observability-core');
  assert.equal(m.resolve('mcp__agent-dashboard__get_file_heat'), 'observability-analytics');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
