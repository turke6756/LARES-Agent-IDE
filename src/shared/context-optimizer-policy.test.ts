// context-optimizer-policy tests (WP-B1) — per-kind default-surface policy, positive-cost
// boundary, and the target/hash-only predicates. Pure node:assert:
//   npm run build:main
//   node dist/main/shared/context-optimizer-policy.test.js

import assert from 'node:assert/strict';
import type { ContextOptimizerProposal } from './types';
import {
  derivesFromHashDimension,
  isDefaultVisibleProposal,
  isProposalDefaultSurfaced,
  proposalHasActionableContent,
  proposalHasConcreteTarget,
  proposalIsHashOnly,
} from './context-optimizer-policy';

let passed = 0;
function ok(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok - ${name}`); }

function prop(over: Partial<ContextOptimizerProposal> & { id: string }): ContextOptimizerProposal {
  const { id, ...rest } = over;
  return {
    id, kind: 'subtract-dead-guidance', lever: 'subtract', title: `t-${id}`,
    rationale: 'r', target: { lane: 'worker', mutable: 'scaffold-managed' },
    residentTokenDelta: { estimate: 0, basis: 'remove-resident' },
    tokenTurnsWeight: 0, occurrence: 'never', evidenceState: 'unavailable', confidence: 'observed', epochConfidence: 'high',
    attribution: { lane: 'worker', streamIds: [], sharedCwdRisk: 'none' },
    exposure: { turns: 10, streams: 2, slugs: 1 },
    citations: [],
    verification: { state: 'unverified', verified: false, requiresDerivationGate: true },
    actionability: 'candidate-unverified', derivationVerified: false, suppressedFromAgentSurface: false,
    ...rest,
  };
}

// ── proposalHasConcreteTarget: the four concrete loci vs. lane-only ──────────────
ok('concrete target: mcpToolset / mcpToolName / skillName / absPath+lineStart', () => {
  assert.equal(proposalHasConcreteTarget(prop({ id: 'a', target: { mcpToolset: 'obs', mutable: 'scaffold-managed' } })), true);
  assert.equal(proposalHasConcreteTarget(prop({ id: 'b', target: { mcpToolName: 'get_x', mutable: 'scaffold-managed' } })), true);
  assert.equal(proposalHasConcreteTarget(prop({ id: 'c', target: { skillName: 'read-comments', mutable: 'scaffold-managed' } })), true);
  assert.equal(proposalHasConcreteTarget(prop({ id: 'd', target: { absPath: '/ws/CLAUDE.md', lineStart: 10, mutable: 'scaffold-managed' } })), true);
});

ok('concrete target: lane-only and absPath-without-lineStart are NOT concrete', () => {
  assert.equal(proposalHasConcreteTarget(prop({ id: 'a', target: { lane: 'worker', mutable: 'scaffold-managed' } })), false);
  assert.equal(proposalHasConcreteTarget(prop({ id: 'b', target: { absPath: '/ws/CLAUDE.md', mutable: 'scaffold-managed' } })), false);
});

// ── hash-only detection from the add-cluster id + rollup exemption ───────────────
ok('hash-only: input_shape_hash / search_signature_hash cluster ids derive-from-hash', () => {
  assert.equal(derivesFromHashDimension(prop({ id: 'add-cluster:worker:input_shape_hash:ab12', kind: 'add-improvisation-support', lever: 'add' })), true);
  assert.equal(derivesFromHashDimension(prop({ id: 'add-cluster:supervisor:search_signature_hash:ffee', kind: 'add-improvisation-support', lever: 'add' })), true);
  // command_family carries a human-readable key → NOT a hash dimension.
  assert.equal(derivesFromHashDimension(prop({ id: 'add-cluster:worker:command_family:git commit', kind: 'add-improvisation-support', lever: 'add' })), false);
  // Non-cluster ids never derive from a hash dimension.
  assert.equal(derivesFromHashDimension(prop({ id: 'subtract-dead-guidance:worker:sec' })), false);
});

ok('hash-only: a rollup row is NOT hash-only (it is the actionable summary)', () => {
  const raw = prop({ id: 'add-cluster:worker:input_shape_hash:ab12', kind: 'add-improvisation-support', lever: 'add' });
  assert.equal(proposalIsHashOnly(raw), true, 'individual hash cluster is hash-only');
  const rollup = prop({
    id: 'add-cluster-rollup:worker:input_shape_hash', kind: 'add-improvisation-support', lever: 'add',
    target: { lane: 'worker', mutable: 'scaffold-managed', rollup: { count: 7, dimension: 'input_shape_hash' } },
  });
  assert.equal(derivesFromHashDimension(rollup), true, 'rollup dimension is a hash dim');
  assert.equal(proposalIsHashOnly(rollup), false, 'but a rollup is NOT hash-only');
});

// ── proposalHasActionableContent = concrete && !hash-only ────────────────────────
ok('actionable content: concrete non-hash target true; hash-only or lane-only false', () => {
  assert.equal(proposalHasActionableContent(prop({ id: 'a', target: { absPath: '/ws/CLAUDE.md', lineStart: 3, mutable: 'scaffold-managed' } })), true);
  assert.equal(proposalHasActionableContent(prop({ id: 'add-cluster:worker:input_shape_hash:ab12', kind: 'add-improvisation-support', lever: 'add' })), false);
  assert.equal(proposalHasActionableContent(prop({ id: 'c', target: { lane: 'worker', mutable: 'scaffold-managed' } })), false);
});

// ── isDefaultVisibleProposal: subtract positive-cost boundary ────────────────────
ok('default-visible subtract: concrete target AND positive cost (weight OR resident delta)', () => {
  const concrete = { absPath: '/ws/CLAUDE.md', lineStart: 10, lane: 'supervisor' as const, mutable: 'scaffold-managed' as const };
  // positive weight
  assert.equal(isDefaultVisibleProposal(prop({ id: 'a', target: concrete, tokenTurnsWeight: 500 })), true);
  // zero weight but positive resident delta
  assert.equal(isDefaultVisibleProposal(prop({ id: 'b', target: concrete, tokenTurnsWeight: 0, residentTokenDelta: { estimate: 900, basis: 'remove-resident' } })), true);
  // zero cost on both → not default-visible
  assert.equal(isDefaultVisibleProposal(prop({ id: 'c', target: concrete, tokenTurnsWeight: 0, residentTokenDelta: { estimate: 0, basis: 'remove-resident' } })), false);
  // positive weight but no concrete target → not default-visible
  assert.equal(isDefaultVisibleProposal(prop({ id: 'd', target: { lane: 'supervisor', mutable: 'scaffold-managed' }, tokenTurnsWeight: 500 })), false);
});

// ── isDefaultVisibleProposal: tune / relocate need concrete target AND observed ──
ok('default-visible tune/relocate: concrete target AND observed behavior (occurs)', () => {
  const skillTarget = { skillName: 'read-comments', absPath: '/skills/x.py', lane: 'worker' as const, mutable: 'scaffold-managed' as const };
  assert.equal(isDefaultVisibleProposal(prop({ id: 'a', kind: 'tune-skill-trigger', lever: 'tune', target: skillTarget, occurrence: 'occurs' })), true);
  assert.equal(isDefaultVisibleProposal(prop({ id: 'b', kind: 'tune-skill-trigger', lever: 'tune', target: skillTarget, occurrence: 'never' })), false, 'unobserved tune not default-visible');
  const fileTarget = { absPath: '/ws/CLAUDE.md', lineStart: 5, lane: 'worker' as const, mutable: 'scaffold-managed' as const };
  assert.equal(isDefaultVisibleProposal(prop({ id: 'c', kind: 'relocate-to-progressive-disclosure', lever: 'relocate', target: fileTarget, occurrence: 'occurs' })), true);
  // observed but no concrete target → not default-visible
  assert.equal(isDefaultVisibleProposal(prop({ id: 'd', kind: 'tune-skill-trigger', lever: 'tune', target: { lane: 'worker', mutable: 'scaffold-managed' }, occurrence: 'occurs' })), false);
});

// ── isDefaultVisibleProposal: add needs a human label and must not be hash-only ──
ok('default-visible add: human-readable label AND not hash-only', () => {
  // command_family cluster: human key, no concrete target, but default-visible for ADD.
  assert.equal(isDefaultVisibleProposal(prop({ id: 'add-cluster:worker:command_family:git commit', kind: 'add-improvisation-support', lever: 'add', title: "Support a 'git commit' improvisation" })), true);
  // hash-only add → hidden.
  assert.equal(isDefaultVisibleProposal(prop({ id: 'add-cluster:worker:input_shape_hash:ab12', kind: 'add-improvisation-support', lever: 'add' })), false);
  // rollup add (has target.rollup) → visible.
  assert.equal(isDefaultVisibleProposal(prop({ id: 'add-cluster-rollup:worker:input_shape_hash', kind: 'add-improvisation-support', lever: 'add', title: '7 improvisation clusters, hash-only', target: { lane: 'worker', mutable: 'scaffold-managed', rollup: { count: 7, dimension: 'input_shape_hash' } } })), true);
  // empty title → not default-visible even when not hash-only.
  assert.equal(isDefaultVisibleProposal(prop({ id: 'add-missing:worker:x', kind: 'add-missing-guidance', lever: 'add', title: '   ' })), false);
});

// ── isProposalDefaultSurfaced: the shared parity predicate ───────────────────────
ok('default-surfaced: suppressed material subtract surfaces; suppressed non-material stays hidden', () => {
  const concrete = { absPath: '/ws/CLAUDE.md', lineStart: 10, lane: 'supervisor' as const, mutable: 'scaffold-managed' as const };
  const material = prop({ id: 'm', target: concrete, tokenTurnsWeight: 500, suppressedFromAgentSurface: true });
  assert.equal(isProposalDefaultSurfaced(material), true, 'material suppressed subtract is default-surfaced');
  const nonMaterial = prop({ id: 'n', target: { lane: 'supervisor', mutable: 'scaffold-managed' }, tokenTurnsWeight: 0, suppressedFromAgentSurface: true });
  assert.equal(isProposalDefaultSurfaced(nonMaterial), false, 'suppressed + non-material stays hidden');
  const notSuppressed = prop({ id: 'v', target: { lane: 'worker', mutable: 'scaffold-managed' }, suppressedFromAgentSurface: false });
  assert.equal(isProposalDefaultSurfaced(notSuppressed), true, 'never-suppressed always surfaces');
});

console.log(`\ncontext-optimizer-policy.test.ts: ${passed} assertions passed`);
