// Git-Native WP-G1.7 — dispatch-context builder tests.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/dispatch-context.test.js
//
// PURE LOGIC. Proves the WP-G1.7 dispatch-context contract:
//   - dispatch fields (taskLabel, sessionId, ownerAgentId) land on the TurnContext;
//   - ownerBrickGeneration is ALWAYS derived server-side from the owner agent's
//     current generation — a caller-supplied value (coerced onto the dispatch body)
//     is ignored;
//   - a human-terminal send is owner-less (ownerAgentId forced NULL);
//   - an unknown agent or a non-repo workspace yields null (no checkpoint).

import assert from 'node:assert/strict';

import type { GitCapability } from '../../shared/types';
import { buildDispatchTurnContext, type DispatchDeps, type DispatchAgentInfo } from './dispatch-context';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

function capOk(): GitCapability {
  return {
    resolution: { agentShell: { source: null, note: '' }, internal: null },
    repoState: 'repo', commonDir: '/repo/.git', commonDirQueueKey: '/repo',
    repoRoot: '/repo', workspacePrefix: '', protectedRoot: false, reason: 'ok', detail: null,
  };
}

function makeDeps(agents: Record<string, DispatchAgentInfo>, cap: GitCapability | null = capOk()): DispatchDeps {
  return {
    getAgent: (id) => agents[id] ?? null,
    resolveCapability: async () => cap,
  };
}

test('dispatch fields land; ownerBrickGeneration is server-derived (caller value ignored)', async () => {
  const deps = makeDeps({
    worker: { workspaceId: 'ws1', title: 'Worker', resumeSessionId: 'sess-live' },
    sup: { workspaceId: 'ws1', continuationGeneration: 4 },
  });
  // A malicious/confused caller coerces ownerBrickGeneration onto the body — it has
  // no typed slot and must be IGNORED in favor of the owner's real generation (4).
  const dispatch = { origin: 'orchestration', ownerAgentId: 'sup', taskLabel: 'do X', ownerBrickGeneration: 999 } as never;
  const ctx = await buildDispatchTurnContext(deps, 'worker', dispatch);
  assert.ok(ctx);
  assert.equal(ctx!.workspaceId, 'ws1');
  assert.equal(ctx!.agentId, 'worker');
  assert.equal(ctx!.ownerAgentId, 'sup');
  assert.equal(ctx!.ownerBrickGeneration, 4, 'server-derived from the owner, NOT the caller-supplied 999');
  assert.equal(ctx!.taskLabel, 'do X');
  assert.equal(ctx!.sessionId, 'sess-live', 'defaults to the agent live session when dispatch omits it');
  assert.equal(ctx!.agentTitle, 'Worker');
  assert.equal(ctx!.quality, 'guaranteed');
});

test('explicit dispatch.sessionId overrides the agent live session', async () => {
  const deps = makeDeps({ worker: { workspaceId: 'ws1', resumeSessionId: 'sess-live' } });
  const ctx = await buildDispatchTurnContext(deps, 'worker', { origin: 'api', sessionId: 'sess-explicit' });
  assert.equal(ctx!.sessionId, 'sess-explicit');
});

test('human-terminal send is owner-less (ownerAgentId forced NULL even if supplied)', async () => {
  const deps = makeDeps({
    worker: { workspaceId: 'ws1' },
    sup: { workspaceId: 'ws1', continuationGeneration: 7 },
  });
  const ctx = await buildDispatchTurnContext(deps, 'worker', { origin: 'human-terminal', ownerAgentId: 'sup' });
  assert.ok(ctx);
  assert.equal(ctx!.ownerAgentId, null, 'human terminals never carry an owner');
  assert.equal(ctx!.ownerBrickGeneration, null);
});

test('orchestration send with an unknown owner → owner id kept, generation null', async () => {
  const deps = makeDeps({ worker: { workspaceId: 'ws1' } });
  const ctx = await buildDispatchTurnContext(deps, 'worker', { origin: 'orchestration', ownerAgentId: 'ghost' });
  assert.equal(ctx!.ownerAgentId, 'ghost');
  assert.equal(ctx!.ownerBrickGeneration, null, 'no generation derivable for an unknown owner');
});

test('unknown agent → null', async () => {
  const deps = makeDeps({});
  assert.equal(await buildDispatchTurnContext(deps, 'nobody', { origin: 'api' }), null);
});

test('non-repo / unusable capability → null (no checkpoint, delivery unaffected)', async () => {
  const deps = makeDeps({ worker: { workspaceId: 'ws1' } }, null);
  assert.equal(await buildDispatchTurnContext(deps, 'worker', { origin: 'api' }), null);
  // A capability with no repoRoot is equally unusable.
  const noRoot = { ...capOk(), repoRoot: null } as GitCapability;
  const deps2 = makeDeps({ worker: { workspaceId: 'ws1' } }, noRoot);
  assert.equal(await buildDispatchTurnContext(deps2, 'worker', { origin: 'api' }), null);
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
