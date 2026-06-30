// Context-Overhead Analyzer — orchestrator unit tests (plan §6).
//   npm run build:main
//   node dist/main/main/context-overhead/context-overhead-analyzer.test.js

import assert from 'node:assert/strict';
import { analyzeOverhead, type FileReader, type OverheadServiceDeps } from './context-overhead-analyzer';
import { TokenEstimator } from './token-estimator';
import type { McpInventory } from './mcp-tool-inventory';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const WS = 'C:/ws';
const WORKER_DIR = 'C:/ws/.dashboard/workers/claude';
const SUBDIR_DOC = 'C:/ws/.dashboard/workers/claude/sub/CLAUDE.md';

const noMcp: McpInventory = { forLane: () => [] };

function makeDeps(
  files: Record<string, string>,
  dirs: Set<string>,
  readLog: string[],
  overrides: Partial<OverheadServiceDeps> = {},
): OverheadServiceDeps {
  const reader: FileReader = {
    read(p) { readLog.push(p); const c = files[p]; return c !== undefined ? { content: c, bytes: c.length } : null; },
    exists(p) { return files[p] !== undefined || dirs.has(p); },
    listFiles() { return []; },
  };
  return {
    reader,
    estimator: new TokenEstimator(),
    mcpInventory: noMcp,
    personas: [],
    env: {},
    userHome: 'C:/Users/me',
    managedPolicyPath: 'C:/Program Files/ClaudeCode/CLAUDE.md',
    ...overrides,
  };
}

function baseFiles(): Record<string, string> {
  return {
    'C:/ws/.dashboard/workers/claude/CLAUDE.md': 'worker root doc',
    'C:/ws/CLAUDE.md': 'workspace doc',
    'C:/Users/me/.claude/CLAUDE.md': 'user doc',
    'C:/Program Files/ClaudeCode/CLAUDE.md': 'managed doc',
    [SUBDIR_DOC]: 'SUBDIR — MUST NOT BE READ',
  };
}

test('discovers the worker lane; ancestor/user/managed frames scoped + distanced correctly', () => {
  const readLog: string[] = [];
  const deps = makeDeps(baseFiles(), new Set([WORKER_DIR]), readLog);
  const model = analyzeOverhead('w1', WS, 'windows', deps);

  assert.equal(model.agents.length, 1, 'only the existing worker lane is discovered');
  const agent = model.agents[0];
  assert.equal(agent.lane, 'worker');
  assert.equal(agent.kind, 'builtin-worker');

  const byDist = new Map(agent.inheritanceChain.map((f) => [f.distanceFromAgentCwd, f]));

  const agentFrame = byDist.get(0)!;
  assert.equal(agentFrame.scope, 'agent');
  assert.equal(agentFrame.sources[0].kind, 'agent-claude');

  const wsFrame = [...byDist.values()].find((f) => f.scope === 'workspace-ancestor')!;
  assert.ok(wsFrame, 'workspace-ancestor frame present');
  assert.ok(wsFrame.distanceFromAgentCwd > 0);
  assert.equal(wsFrame.sources[0].kind, 'inherited-claude');

  const userFrame = byDist.get(-1)!;
  assert.equal(userFrame.scope, 'user');
  assert.equal(userFrame.sources[0].kind, 'user-claude');

  const managedFrame = byDist.get(-2)!;
  assert.equal(managedFrame.scope, 'managed');
  assert.equal(managedFrame.sources[0].kind, 'managed-policy');
});

test('subdirectory CLAUDE.md below the agent cwd is NEVER read (walk-up only ascends)', () => {
  const readLog: string[] = [];
  const deps = makeDeps(baseFiles(), new Set([WORKER_DIR]), readLog);
  analyzeOverhead('w1', WS, 'windows', deps);
  assert.ok(!readLog.includes(SUBDIR_DOC), 'subdir doc must not be read');
});

test('an additional-dir overlapping an ancestor is never double-counted (deduped)', () => {
  const readLog: string[] = [];
  const deps = makeDeps(baseFiles(), new Set([WORKER_DIR]), readLog, {
    additionalDirs: ['C:/ws'], // already an ancestor of the worker cwd
    env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' },
  });
  const model = analyzeOverhead('w1', WS, 'windows', deps);
  const agent = model.agents[0];
  const addFrames = agent.inheritanceChain.filter((f) => f.scope === 'additional-dir');
  assert.equal(addFrames.length, 0, 'overlapping additional-dir contributes no extra frame');
});

test('--add-dir non-ancestor: counted only when the env var is set', () => {
  const files = { ...baseFiles(), 'C:/other/CLAUDE.md': 'other-dir doc' };

  // env OFF → visible but uncounted frame
  let readLog: string[] = [];
  let deps = makeDeps(files, new Set([WORKER_DIR]), readLog, { additionalDirs: ['C:/other'] });
  let model = analyzeOverhead('w1', WS, 'windows', deps);
  let addFrame = model.agents[0].inheritanceChain.find((f) => f.scope === 'additional-dir');
  assert.ok(addFrame, 'additional-dir frame is shown');
  assert.equal(addFrame!.included, false, 'not counted when env var unset');

  // env ON → counted frame
  readLog = [];
  deps = makeDeps(files, new Set([WORKER_DIR]), readLog, {
    additionalDirs: ['C:/other'],
    env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' },
  });
  model = analyzeOverhead('w1', WS, 'windows', deps);
  addFrame = model.agents[0].inheritanceChain.find((f) => f.scope === 'additional-dir');
  assert.ok(addFrame, 'additional-dir frame present');
  assert.equal(addFrame!.included, true, 'counted when env var set');
});

test('missing built-in lane dirs are skipped with a global warning', () => {
  const readLog: string[] = [];
  const deps = makeDeps(baseFiles(), new Set([WORKER_DIR]), readLog);
  const model = analyzeOverhead('w1', WS, 'windows', deps);
  assert.ok(model.globalWarnings.some((w) => w.includes('.dashboard/supervisor')));
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
