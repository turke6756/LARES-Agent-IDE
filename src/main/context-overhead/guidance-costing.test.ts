// WP2 (G2) — end-to-end guidance-source integration over the analyzer:
// per-agent cost inclusion/exclusion, config-weight source refs + per-fileKind
// rollups, resident-inventory exclusion, knowledge extraction admission, and the
// DTO/redaction round-trip.
//   npm run build:main
//   node dist/main/main/context-overhead/guidance-costing.test.js

import assert from 'node:assert/strict';
import { analyzeOverhead, type FileReader, type OverheadServiceDeps } from './context-overhead-analyzer';
import { TokenEstimator } from './token-estimator';
import { redactOverheadModel } from './overhead-dto';
import { fileKindBucketOf } from './config-weight';
import { collectMarkdownTargets } from '../context-optimizer/resident-inventory';
import { extractAgentKnowledge } from '../agent-knowledge/knowledge-extractor';
import type { AgentContextOverhead, OverheadModel } from '../../shared/types';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// ── fixture workspace ─────────────────────────────────────────────────────────
// /ws
//   AGENTS.md                     (root of the chain — codex audience)
//   CLAUDE.md                     (workspace claude guidance)
//   .lares/workers/AGENTS.md      (mid-chain file for both worker lanes)
//   .lares/workers/claude/CLAUDE.md
//   .lares/workers/codex/         (no own files; inherits the chain)
//   sub/AGENTS.md                 (below-cwd of nothing captured → not on any chain)

const WS = '/ws';
const FILES: Record<string, string> = {
  '/ws/AGENTS.md': '# Repo conventions\n\nRun `npm test` before committing.\n',
  '/ws/CLAUDE.md': '# Claude notes\n\nUse `npm run build` after edits.\n',
  '/ws/.lares/workers/AGENTS.md': '# Worker conventions\n\nKeep diffs small.\n',
  '/ws/.lares/workers/claude/CLAUDE.md': '# Worker claude\n\nBe terse.\n',
  '/ws/sub/AGENTS.md': '# Below\n\nOff every captured chain.\n',
};
const DIRS = new Set([
  '/ws', '/ws/.lares', '/ws/.lares/workers',
  '/ws/.lares/workers/claude', '/ws/.lares/workers/codex', '/ws/sub',
]);

function makeReader(): FileReader {
  return {
    read(p) { const c = FILES[p]; return c !== undefined ? { content: c, bytes: c.length } : null; },
    exists(p) { return FILES[p] !== undefined || DIRS.has(p); },
    listFiles() { return []; },
  };
}

function scan(): Omit<OverheadModel, 'generatedAt'> {
  const deps: OverheadServiceDeps = {
    reader: makeReader(),
    estimator: new TokenEstimator(),
    mcpInventory: { forLane: () => [] },
    personas: [],
    env: {},
    userHome: '/home/u',
    managedPolicyPath: null,
  };
  return analyzeOverhead('ws-1', WS, 'wsl', deps);
}

function agentByDir(model: Omit<OverheadModel, 'generatedAt'>, dir: string): AgentContextOverhead {
  const a = model.agents.find((x) => x.workingDir === dir);
  assert.ok(a, `agent at ${dir} present in the scan`);
  return a!;
}

const model = scan();
const codex = agentByDir(model, '/ws/.lares/workers/codex');
const claude = agentByDir(model, '/ws/.lares/workers/claude');

// ── per-agent cost inclusion/exclusion ────────────────────────────────────────

test('the codex worker is charged for BOTH chain AGENTS.md files (resident)', () => {
  assert.equal(codex.provider, 'codex');
  const agentsMd = codex.flatSources.filter((s) => s.kind === 'agents-md');
  assert.deepEqual(agentsMd.map((s) => s.resolvedPath).sort(),
    ['/ws/.lares/workers/AGENTS.md', '/ws/AGENTS.md'].sort());
  for (const s of agentsMd) {
    assert.equal(s.disclosureTier, 'resident');
    assert.ok(s.estimate.tokens > 0, 'a real file has a non-zero estimate');
    assert.ok(s.guidanceSource, 'the source carries its GuidanceSource record');
    assert.equal(s.guidanceSource!.applicability.model, 'directory-chain');
  }
  // Chain files reach residentTotal: strip them and the total must drop.
  const agentsMdTokens = agentsMd.reduce((n, s) => n + s.estimate.tokens, 0);
  assert.ok((codex.residentTotal?.tokens ?? 0) >= agentsMdTokens,
    'residentTotal includes the applicable AGENTS.md tokens');
});

test('a Claude worker is NEVER charged for a codex-only AGENTS.md', () => {
  assert.equal(claude.provider, 'claude');
  assert.deepEqual(claude.flatSources.filter((s) => s.kind === 'agents-md'), [],
    'no agents-md source enters a claude agent\'s costed sources');
  // But the chain is still LISTED in its guidanceSources (visible, not costed).
  const listed = (claude.guidanceSources ?? []).filter((g) => g.fileKind === 'agents-md');
  assert.deepEqual(listed.map((g) => g.path).sort(),
    ['/ws/.lares/workers/AGENTS.md', '/ws/AGENTS.md'].sort());
});

test('the below-cwd/off-chain AGENTS.md is on NO agent\'s chain', () => {
  for (const a of model.agents) {
    assert.ok(!(a.guidanceSources ?? []).some((g) => g.path === '/ws/sub/AGENTS.md'),
      `${a.id} must not chain /ws/sub/AGENTS.md`);
    assert.ok(!a.flatSources.some((s) => s.resolvedPath === '/ws/sub/AGENTS.md'),
      `${a.id} must not cost /ws/sub/AGENTS.md`);
  }
});

// ── config-weight: source refs + never summing across fileKind ───────────────

test('config-weight sections carry the guidance source; rollups never sum across fileKind', () => {
  const cw = codex.configWeight!;
  const agentsMdSections = cw.sections.filter((s) => fileKindBucketOf(s) === 'agents-md');
  assert.ok(agentsMdSections.length > 0, 'AGENTS.md was sectioned for the codex worker');
  for (const s of agentsMdSections) {
    assert.equal(s.guidanceSource?.fileKind, 'agents-md');
    assert.deepEqual(s.guidanceSource?.audienceProviders, ['codex']);
  }
  const agentsMdTokens = agentsMdSections.reduce((n, s) => n + s.tokens, 0);
  assert.ok(agentsMdTokens > 0);

  // tokensByClass (the headline) must EXCLUDE agents-md tokens entirely…
  const headline = Object.values(cw.tokensByClass).reduce((a, b) => a + b, 0);
  const allSections = cw.sections.reduce((n, s) => n + s.tokens, 0);
  assert.equal(headline, allSections - agentsMdTokens,
    'tokensByClass sums exactly the non-agents-md sections');

  // …and the per-fileKind map carries them in their OWN bucket.
  const byKind = cw.tokensByClassByFileKind!;
  const agentsBucket = Object.values(byKind['agents-md'] ?? {}).reduce((a, b) => a + b, 0);
  assert.equal(agentsBucket, agentsMdTokens);
});

// ── resident-inventory: AGENTS.md never a Claude-resident target ──────────────

test('collectMarkdownTargets never mints a resident target from AGENTS.md', () => {
  const targets = collectMarkdownTargets(
    { ...model, generatedAt: 'x' } as OverheadModel, makeReader());
  assert.ok(targets.length > 0, 'CLAUDE.md targets exist');
  for (const t of targets) {
    assert.ok(!/AGENTS\.md$/i.test(t.sourcePath),
      `AGENTS.md must never be a Claude-resident target (got ${t.sourcePath})`);
  }
});

// ── knowledge extraction: admits applicable AGENTS.md, nodes carry audience ───

test('extraction admits applicable AGENTS.md; nodes carry the source audience', () => {
  const { nodes, sourceFiles } = extractAgentKnowledge(codex, {
    readFile: (p) => FILES[p] ?? null,
  }, { workspaceRoot: WS });
  const agentsMdFiles = sourceFiles.filter((f) => f.kind === 'agents-md');
  assert.equal(agentsMdFiles.length, 2, 'both chain AGENTS.md files were extracted');
  const agentsMdNodes = nodes.filter((n) => n.sourceRole === 'agents-md');
  assert.ok(agentsMdNodes.length > 0, 'AGENTS.md produced knowledge nodes');
  for (const n of agentsMdNodes) assert.deepEqual(n.audienceProviders, ['codex']);
  // Claude guidance nodes are untouched — no audience stamped from CLAUDE-family
  // sources unless the analyzer tagged them; when tagged it is ['claude'].
  for (const n of nodes.filter((x) => x.sourceRole === 'workspace-claude')) {
    if (n.audienceProviders !== undefined) assert.deepEqual(n.audienceProviders, ['claude']);
  }
});

test('a claude agent\'s extraction sees NO AGENTS.md surface', () => {
  const { sourceFiles } = extractAgentKnowledge(claude, {
    readFile: (p) => FILES[p] ?? null,
  }, { workspaceRoot: WS });
  assert.deepEqual(sourceFiles.filter((f) => f.kind === 'agents-md'), []);
});

// ── DTO / redaction round-trip ────────────────────────────────────────────────

test('redaction: guidance sources survive with fields intact and NO raw paths', () => {
  const redacted = redactOverheadModel(
    { ...model, generatedAt: '2026-07-21T00:00:00.000Z' } as OverheadModel,
    { workspaceRoot: WS, dashboardRoot: '/ws/.lares', homeDir: '/home/u' });
  const rCodex = redacted.agents.find((a) => a.provider === 'codex')!;
  assert.ok(rCodex, 'codex agent present after redaction');
  const gs = rCodex.guidanceSources ?? [];
  const agentsMd = gs.filter((g) => g.fileKind === 'agents-md');
  assert.equal(agentsMd.length, 2);
  for (const g of agentsMd) {
    assert.deepEqual(g.audienceProviders, ['codex']);
    assert.equal(g.applicability.model, 'directory-chain');
    assert.ok(g.source.pathDisplay.startsWith('$'), `scoped display, got ${g.source.pathDisplay}`);
  }
  const chained = agentsMd.find((g) => g.applicability.chainParentDisplay);
  assert.ok(chained, 'the deeper chain file kept its (redacted) parent link');

  // No absolute workspace path anywhere in the serialized guidance/agent data —
  // EXCEPT each source's stable `id` join key, which redactOverheadModel keeps
  // absolute by documented contract (the exporter's belt redacts it before any
  // artifact is written; see analytics-exporter.ts "the belt runs BEFORE the
  // caveats"). Strip `id` and assert everything else is clean.
  const stripIds = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stripIds);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'id') continue;
        out[k] = stripIds(val);
      }
      return out;
    }
    return v;
  };
  const json = JSON.stringify(stripIds(redacted.agents.map((a) => ({
    guidanceSources: a.guidanceSources,
    configWeight: a.configWeight,
    flatSources: a.flatSources,
  }))));
  assert.ok(!json.includes('"/ws/'), 'no raw workspace-rooted path survives redaction (outside id join keys)');

  // Sections kept their per-fileKind rollups through redaction.
  const rw = rCodex.configWeight!;
  assert.ok(rw.tokensByClassByFileKind, 'per-fileKind rollup survives the DTO');
  const sec = rw.sections.find((s) => s.guidanceSource?.fileKind === 'agents-md');
  assert.ok(sec, 'an agents-md section survived with its guidance ref');
  assert.ok(sec!.source.pathDisplay.startsWith('$'));
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
