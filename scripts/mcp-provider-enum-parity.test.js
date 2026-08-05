// MCP provider-enum parity against the compiled canonical TypeScript constant.
//
// Run after compiling main: node scripts/mcp-provider-enum-parity.test.js

const assert = require('assert');
const { LAUNCHABLE_AGENT_PROVIDERS } = require('../dist/main/shared/types.js');
const { getOrchestrationToolDefinitions } = require('./mcp-tools-orchestration');

const tools = getOrchestrationToolDefinitions();
const launchAgent = tools.find((tool) => tool.name === 'launch_agent');
const runOrchestration = tools.find((tool) => tool.name === 'run_orchestration');

assert.ok(launchAgent, 'launch_agent tool definition must exist');
assert.ok(runOrchestration, 'run_orchestration tool definition must exist');

assert.deepStrictEqual(
  launchAgent.inputSchema.properties.provider.enum,
  LAUNCHABLE_AGENT_PROVIDERS,
  'launch_agent provider enum must exactly match canonical order',
);
assert.deepStrictEqual(
  runOrchestration.inputSchema.properties.lead_provider.enum,
  LAUNCHABLE_AGENT_PROVIDERS,
  'run_orchestration lead_provider enum must exactly match canonical order',
);
assert.deepStrictEqual(
  runOrchestration.inputSchema.properties.reviewer_provider.enum,
  LAUNCHABLE_AGENT_PROVIDERS,
  'run_orchestration reviewer_provider enum must exactly match canonical order',
);

console.log('MCP provider enums match LAUNCHABLE_AGENT_PROVIDERS in exact order');
