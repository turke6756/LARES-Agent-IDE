// WP-G2.0 (plans/git-native-implementation-v2.md — Per-agent capability tokens;
// plans/capability-token-regression.md §"Lifecycle checklist") — unit tests for
// the in-process capability store: minting, rotation, revocation, resolve, and
// the claim shape per privilege lane.
//
// Pure Node (crypto + Map, no Electron) — compile via the main tsconfig and run:
//   npm run build:main
//   node dist/main/main/security/agent-capabilities.test.js

import assert from 'node:assert/strict';
import { AgentCapabilityStore, agentCapabilities } from './agent-capabilities';
import type { CapabilityClaim } from './agent-capabilities';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const claim = (over: Partial<CapabilityClaim> = {}): CapabilityClaim => ({
  agentId: 'agent-1',
  workspaceId: 'ws-1',
  privilegeLane: 'worker',
  ...over,
});

// ── Minting ─────────────────────────────────────────────────────────────────

test('mint: returns a high-entropy secret and resolves back to the claim', () => {
  const store = new AgentCapabilityStore();
  const token = store.mint(claim({ privilegeLane: 'supervisor' }));
  // base64url of 32 bytes → 43 chars, no padding, url-safe alphabet only.
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(token), `not high-entropy base64url: ${token}`);
  const resolved = store.resolve(token);
  assert.deepEqual(resolved, { agentId: 'agent-1', workspaceId: 'ws-1', privilegeLane: 'supervisor' });
});

test('mint: two agents get distinct tokens, each resolving to its own claim', () => {
  const store = new AgentCapabilityStore();
  const a = store.mint(claim({ agentId: 'a', privilegeLane: 'worker' }));
  const b = store.mint(claim({ agentId: 'b', privilegeLane: 'supervisor' }));
  assert.notEqual(a, b);
  assert.equal(store.resolve(a)?.privilegeLane, 'worker');
  assert.equal(store.resolve(b)?.privilegeLane, 'supervisor');
  assert.equal(store.size(), 2);
});

test('mint: rejects an empty agentId (claims must come from real launch state)', () => {
  const store = new AgentCapabilityStore();
  assert.throws(() => store.mint(claim({ agentId: '' })), /agentId/);
});

test('mint: claim is copied — later mutation of the input cannot reach stored state', () => {
  const store = new AgentCapabilityStore();
  const input = claim({ privilegeLane: 'worker' });
  const token = store.mint(input);
  input.privilegeLane = 'supervisor'; // attacker-style post-mint mutation
  assert.equal(store.resolve(token)?.privilegeLane, 'worker');
});

test('resolve: returns a COPY — mutating it cannot corrupt stored state', () => {
  const store = new AgentCapabilityStore();
  const token = store.mint(claim({ privilegeLane: 'worker' }));
  const first = store.resolve(token)!;
  first.privilegeLane = 'supervisor';
  assert.equal(store.resolve(token)?.privilegeLane, 'worker');
});

// ── Rotation on relaunch ──────────────────────────────────────────────────────

test('rotation: re-minting the same agent revokes the prior token', () => {
  const store = new AgentCapabilityStore();
  const old = store.mint(claim({ agentId: 'a', privilegeLane: 'worker' }));
  const fresh = store.mint(claim({ agentId: 'a', privilegeLane: 'worker' }));
  assert.notEqual(old, fresh, 'a relaunch must produce a NEW token');
  assert.equal(store.resolve(old), null, 'the old token must stop resolving');
  assert.equal(store.resolve(fresh)?.agentId, 'a');
  assert.equal(store.size(), 1, 'no stale token accumulation');
});

test('rotation: a lane change on relaunch is reflected in the new claim', () => {
  const store = new AgentCapabilityStore();
  store.mint(claim({ agentId: 'a', privilegeLane: 'worker' }));
  const fresh = store.mint(claim({ agentId: 'a', privilegeLane: 'supervisor' }));
  assert.equal(store.resolve(fresh)?.privilegeLane, 'supervisor');
});

// ── Revocation on stop/delete ─────────────────────────────────────────────────

test('revoke: after revoke the token no longer resolves', () => {
  const store = new AgentCapabilityStore();
  const token = store.mint(claim({ agentId: 'a' }));
  assert.equal(store.revokeAgent('a'), true);
  assert.equal(store.resolve(token), null);
  assert.equal(store.size(), 0);
});

test('revoke: idempotent — revoking an agent with no token returns false', () => {
  const store = new AgentCapabilityStore();
  assert.equal(store.revokeAgent('nobody'), false);
});

test('revoke: only the named agent is affected', () => {
  const store = new AgentCapabilityStore();
  const a = store.mint(claim({ agentId: 'a' }));
  const b = store.mint(claim({ agentId: 'b' }));
  store.revokeAgent('a');
  assert.equal(store.resolve(a), null);
  assert.equal(store.resolve(b)?.agentId, 'b', 'sibling token must survive');
});

// ── resolve edge cases ────────────────────────────────────────────────────────

test('resolve: empty / undefined / unknown tokens never resolve (fail closed)', () => {
  const store = new AgentCapabilityStore();
  store.mint(claim());
  assert.equal(store.resolve(''), null);
  assert.equal(store.resolve(undefined), null);
  assert.equal(store.resolve(null), null);
  assert.equal(store.resolve('not-a-real-token'), null);
});

// ── Worker-credential-is-a-valid-bearer-but-carries-a-worker-claim ────────────

test('a minted worker credential carries a WORKER claim (never supervisor)', () => {
  const store = new AgentCapabilityStore();
  const token = store.mint(claim({ agentId: 'w', privilegeLane: 'worker' }));
  const c = store.resolve(token)!;
  assert.equal(c.privilegeLane, 'worker');
  assert.notEqual(c.privilegeLane, 'supervisor');
});

// ── Singleton ────────────────────────────────────────────────────────────────

test('agentCapabilities singleton mints + resolves like a fresh store', () => {
  agentCapabilities.clear();
  const token = agentCapabilities.mint(claim({ agentId: 'singleton-agent' }));
  assert.equal(agentCapabilities.resolve(token)?.agentId, 'singleton-agent');
  agentCapabilities.clear();
  assert.equal(agentCapabilities.resolve(token), null);
});

// ── Runner ────────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  console.log(`Running ${tests.length} agent-capabilities tests...\n`);
  for (const t of tests) {
    try {
      t.run();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(err instanceof Error ? err.stack : String(err));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} agent-capabilities tests passed`);
})();
