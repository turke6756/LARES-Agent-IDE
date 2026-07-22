// WP2 (G2) — guidance-sources unit tests: chain composition, applicability
// classification, audiences, and the per-agent costing filter.
//   npm run build:main
//   node dist/main/main/context-overhead/guidance-sources.test.js

import assert from 'node:assert/strict';
import {
  AGENTS_MD_DOCUMENTED_PROVIDERS,
  agentsMdChain,
  appliesToAgent,
  chainDirs,
  claudeGuidanceSources,
  classifyAgentsMdApplicability,
  inventoryOnlyAgentsMd,
  providerForAgent,
} from './guidance-sources';
import { makePathOps } from './paths';
import type { GuidanceSource, OverheadSource } from '../../shared/types';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const ops = makePathOps('wsl');

function probe(existing: string[]): { exists(p: string): boolean } {
  const set = new Set(existing.map((p) => ops.resolve(p)));
  return { exists: (p) => set.has(ops.resolve(p)) };
}

// ── provider derivation ───────────────────────────────────────────────────────

test('providerForAgent: worker lanes derive the provider from the workers/<provider> dir', () => {
  assert.equal(providerForAgent({ workingDir: '/ws/.lares/workers/codex', kind: 'builtin-worker' }), 'codex');
  assert.equal(providerForAgent({ workingDir: '/ws/.lares/workers/claude', kind: 'builtin-worker' }), 'claude');
  // Legacy spelling still resolves (unmigrated workspace).
  assert.equal(providerForAgent({ workingDir: '/ws/.dashboard/workers/codex', kind: 'builtin-worker' }), 'codex');
  // Supervisor / researcher / persona lanes are Claude Code lanes.
  assert.equal(providerForAgent({ workingDir: '/ws/.lares/supervisor', kind: 'builtin-supervisor' }), 'claude');
  assert.equal(providerForAgent({ workingDir: '/somewhere/else', kind: 'persona' }), 'claude');
});

// ── chain fixture: root + mid + below-cwd (the plan's chain test) ─────────────

const ROOT = '/ws';
const CWD = '/ws/packages/app';   // captured launch cwd
const ROOT_MD = '/ws/AGENTS.md';
const MID_MD = '/ws/packages/AGENTS.md';
const BELOW_MD = '/ws/packages/app/deep/AGENTS.md';   // below cwd
const OFF_MD = '/ws/other/AGENTS.md';                  // off-chain sibling

test('agentsMdChain: root-to-cwd files chain in order with chainParent links', () => {
  const reader = probe([ROOT_MD, MID_MD, BELOW_MD, OFF_MD]);
  const chain = agentsMdChain(ROOT, CWD, { reader, pathOps: ops });
  assert.deepEqual(chain.map((g) => g.path), [ROOT_MD, MID_MD],
    'only root→cwd files chain; below-cwd and off-chain files are NOT in the chain');
  assert.equal(chain[0].applicability.model, 'directory-chain');
  assert.equal(chain[0].applicability.chainParent, undefined, 'the root file has no chain parent');
  assert.equal(chain[1].applicability.chainParent, ROOT_MD, 'deeper files override their parent');
  for (const g of chain) {
    assert.equal(g.fileKind, 'agents-md');
    assert.deepEqual(g.audienceProviders, [...AGENTS_MD_DOCUMENTED_PROVIDERS]);
    assert.equal(g.loadingSemanticsConfidence, 'documented');
  }
});

test('agentsMdChain: an off-workspace cwd has no root→cwd chain', () => {
  const reader = probe([ROOT_MD]);
  assert.deepEqual(agentsMdChain(ROOT, '/elsewhere', { reader, pathOps: ops }), []);
  assert.deepEqual(chainDirs(ROOT, '/elsewhere', ops), []);
});

test('agentsMdChain: no documented providers → the EXPLICIT unknown audience', () => {
  const reader = probe([ROOT_MD]);
  const chain = agentsMdChain(ROOT, CWD, { reader, pathOps: ops }, { documentedProviders: [] });
  assert.equal(chain.length, 1);
  assert.equal(chain[0].audienceProviders, 'unknown');
  assert.equal(chain[0].loadingSemanticsConfidence, 'unknown');
});

test('classifyAgentsMdApplicability: on-chain vs below-cwd vs off-chain vs outside', () => {
  const cwds = [CWD];
  assert.equal(classifyAgentsMdApplicability(ROOT_MD, ROOT, cwds, ops), 'directory-chain');
  assert.equal(classifyAgentsMdApplicability(MID_MD, ROOT, cwds, ops), 'directory-chain');
  // Below-cwd: NEVER inferred applicable from launch cwd alone.
  assert.equal(classifyAgentsMdApplicability(BELOW_MD, ROOT, cwds, ops), 'inventory-only');
  assert.equal(classifyAgentsMdApplicability(OFF_MD, ROOT, cwds, ops), 'inventory-only');
  assert.equal(classifyAgentsMdApplicability('/outside/AGENTS.md', ROOT, cwds, ops), 'inventory-only');
  // No captured cwds at all → nothing is chain-applicable.
  assert.equal(classifyAgentsMdApplicability(ROOT_MD, ROOT, [], ops), 'inventory-only');
});

// ── per-agent costing filter ──────────────────────────────────────────────────

test('appliesToAgent: a claude agent is never charged for a codex-only AGENTS.md', () => {
  const codexOnly: GuidanceSource = {
    path: ROOT_MD, fileKind: 'agents-md', audienceProviders: ['codex'],
    applicability: { model: 'directory-chain' }, loadingSemanticsConfidence: 'documented',
  };
  assert.equal(appliesToAgent(codexOnly, 'codex'), true);
  assert.equal(appliesToAgent(codexOnly, 'claude'), false);
});

test('appliesToAgent: unknown audiences and inventory-only files are NEVER costed', () => {
  const unknownAudience: GuidanceSource = {
    path: ROOT_MD, fileKind: 'agents-md', audienceProviders: 'unknown',
    applicability: { model: 'directory-chain' }, loadingSemanticsConfidence: 'unknown',
  };
  assert.equal(appliesToAgent(unknownAudience, 'codex'), false);
  assert.equal(appliesToAgent(unknownAudience, 'claude'), false);

  const inventory = inventoryOnlyAgentsMd(BELOW_MD);
  assert.equal(inventory.applicability.model, 'inventory-only');
  assert.equal(appliesToAgent(inventory, 'codex'), false, 'inventory-only is never per-agent costed');
});

// ── Claude walk-up tagging (UNCHANGED semantics, just tagged) ─────────────────

function src(kind: OverheadSource['kind'], path: string): OverheadSource {
  return {
    id: `${path}#${kind}`, kind, label: path, resolvedPath: path, dedupeKey: path,
    sourceScope: 'agent', openable: true, exists: true, inherited: false,
    estimate: { tokens: 1, bytes: 1, chars: 1, method: 'chars-heuristic', approximate: true },
    origin: 'walk-up', mutable: 'user-owned', children: [], warnings: [],
  };
}

test('claudeGuidanceSources: CLAUDE-family rows map to walk-up-chain sources with the claude audience', () => {
  const out = claudeGuidanceSources([
    src('agent-claude', '/ws/a/CLAUDE.md'),
    src('claude-local', '/ws/a/CLAUDE.local.md'),
    src('skill-header', '/ws/a/.claude/skills/x/SKILL.md'),  // not a guidance fileKind
    src('rules', '/ws/a/.claude/rules/r.md'),                // not a guidance fileKind
  ]);
  assert.deepEqual(out.map((g) => [g.path, g.fileKind]), [
    ['/ws/a/CLAUDE.md', 'claude-md'],
    ['/ws/a/CLAUDE.local.md', 'claude-local-md'],
  ]);
  for (const g of out) {
    assert.deepEqual(g.audienceProviders, ['claude']);
    assert.equal(g.applicability.model, 'walk-up-chain');
    assert.equal(g.loadingSemanticsConfidence, 'documented');
    assert.equal(appliesToAgent(g, 'claude'), true);
    assert.equal(appliesToAgent(g, 'codex'), false, 'a codex agent is not charged for CLAUDE.md');
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
