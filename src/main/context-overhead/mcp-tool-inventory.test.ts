// Context-Overhead Analyzer — MCP inventory unit tests (plan §6, R6).
//   npm run build:main
//   node dist/main/main/context-overhead/mcp-tool-inventory.test.js

import assert from 'node:assert/strict';
import { buildMcpInventory, type GlobalMcpProvider, type ToolsetDefsProvider } from './mcp-tool-inventory';
import { TokenEstimator } from './token-estimator';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// Deterministic estimator: tokens === text.length.
const estimator = () => new TokenEstimator({ encoder: (t) => t.length });

const defs: ToolsetDefsProvider = {
  defsFor(toolset) {
    return [
      {
        name: `${toolset}_tool`,
        description: 'a tool description',
        inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
      },
    ];
  },
  scriptPathFor(toolset) {
    return `C:/repo/scripts/mcp-tools-${toolset}.js`;
  },
};

const globals: GlobalMcpProvider = {
  list: () => [{ name: 'Gmail', configPath: 'C:/Users/me/.claude.json' }],
};

test('worker lane: dashboard toolsets sized non-zero; globals excluded by strict mode (total 0)', () => {
  const inv = buildMcpInventory(estimator(), defs, globals);
  const servers = inv.forLane('worker');

  const dashboard = servers.filter((s) => s.source === 'dashboard-injected');
  assert.ok(dashboard.length > 0, 'worker gets dashboard toolsets');
  for (const s of dashboard) {
    assert.ok(s.total.tokens > 0, `${s.displayName} sized non-zero`);
    assert.equal(s.schemaSourced, true);
    assert.equal(s.excludedByStrictMode, false);
  }

  const gmail = servers.find((s) => s.displayName === 'Gmail')!;
  assert.equal(gmail.excludedByStrictMode, true, 'global excluded from strict worker lane');
  assert.equal(gmail.total.tokens, 0, 'strict-excluded global counted 0');
  assert.equal(gmail.grantedToAgent, false);
});

test('dashboard tool sizing splits description vs inputSchema; schemaSource is dashboard-module', () => {
  const inv = buildMcpInventory(estimator(), defs, globals);
  const server = inv.forLane('worker').find((s) => s.source === 'dashboard-injected')!;
  const tool = server.tools[0];
  assert.ok(tool.descriptionTokens > 0, 'description sized');
  assert.ok(tool.inputSchemaTokens > 0, 'input schema sized');
  assert.equal(tool.schemaSource, 'dashboard-module');
  // The serialized total covers more than either part alone.
  assert.ok(tool.estimate.tokens >= tool.descriptionTokens);
  assert.ok(tool.estimate.tokens >= tool.inputSchemaTokens);
});

test('supervisor lane: globals named-only (schemaSourced false, no fabricated count)', () => {
  const inv = buildMcpInventory(estimator(), defs, globals);
  const servers = inv.forLane('supervisor');
  const gmail = servers.find((s) => s.displayName === 'Gmail')!;
  assert.equal(gmail.excludedByStrictMode, false, 'supervisor keeps its globals');
  assert.equal(gmail.grantedToAgent, true);
  assert.equal(gmail.schemaSourced, false, 'schema not sourced — named only');
  assert.equal(gmail.total.tokens, 0, 'never fabricate a count');
  assert.ok(gmail.warnings.length > 0);
});

test('unknown dashboard toolset → schemaSourced false + warning, not a crash', () => {
  const emptyDefs: ToolsetDefsProvider = { defsFor: () => null, scriptPathFor: () => null };
  const inv = buildMcpInventory(estimator(), emptyDefs, globals);
  const servers = inv.forLane('worker').filter((s) => s.source === 'dashboard-injected');
  for (const s of servers) {
    assert.equal(s.schemaSourced, false);
    assert.ok(s.warnings.length > 0);
  }
});

test('R6 consistency: clickability derives from configPath != null (no openable field drift)', () => {
  const inv = buildMcpInventory(estimator(), defs, globals);
  for (const lane of ['worker', 'supervisor'] as const) {
    for (const s of inv.forLane(lane)) {
      assert.ok(!('openable' in s), 'McpServerOverhead must NOT carry an openable field');
      if (s.source === 'dashboard-injected') {
        assert.notEqual(s.configPath, null, 'dashboard server has a script click target');
      }
      // The renderer derives clickability as configPath != null — assert the
      // field is the single source of truth (string or null, never undefined).
      assert.ok(typeof s.configPath === 'string' || s.configPath === null);
    }
  }
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
