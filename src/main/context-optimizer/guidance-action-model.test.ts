// Tests for guidance-action-model.ts (the WP5 compiler, design §5.1).
// node:assert on dist. Run: node dist/main/main/context-optimizer/guidance-action-model.test.js
import assert from 'node:assert';
import type { AgentRoleLane, KnowledgeNode } from '../../shared/types';
import {
  compileGuidanceActions,
  type CompileDeps,
  type PredictedAction,
} from './guidance-action-model';
import {
  deriveAnchors,
  parseMarkdownSections,
  type ResidentTarget,
} from './resident-inventory';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// ── fixture: one resident target with known line spans ────────────────────────
const P = 'C:/ws/.dashboard/workers/claude/CLAUDE.md';
const TEXT = [
  '# Worker Agent',                                   // 1
  '',                                                 // 2
  'Intro prose.',                                     // 3
  '',                                                 // 4
  '## How to work',                                   // 5
  '',                                                 // 6
  'Run `npm run build` then `git status`.',           // 7
  '',                                                 // 8
  '## Constraints',                                   // 9
  '',                                                 // 10
  '- Never edit `.claude/settings.json`.',            // 11
].join('\n');

const LANES: AgentRoleLane[] = ['supervisor', 'worker'];
const target: ResidentTarget = {
  targetType: 'markdown_section',
  targetKey: P,
  sourceKind: 'ignored_scaffold',
  sourcePath: P,
  sourceSymbol: null,
  lanes: LANES,
  text: TEXT,
};

// Deterministic estimator = char count, so residentTokens is checkable.
const estimateTokens = (t: string): number => t.length;

const baseDeps: CompileDeps = { residentTargets: [target], estimateTokens };

function node(partial: Partial<KnowledgeNode> & Pick<KnowledgeNode, 'type' | 'label'>): KnowledgeNode {
  return { source: { absPath: P, lineStart: 3, lineEnd: 3 }, ...partial } as KnowledgeNode;
}
const byKind = (as: PredictedAction[], k: string): PredictedAction[] => as.filter((a) => a.kind === k);

// Expected residentTokens + section key for the "How to work" section (lines 5–8).
// headingPath is the full breadcrumb (worker-agent>how-to-work), so keys are
// derived from the real parsed anchors rather than hand-guessed.
const sections = deriveAnchors(parseMarkdownSections(TEXT));
const howTo = sections.find((s) => s.headingText === 'How to work')!;
const constraints = sections.find((s) => s.headingText === 'Constraints')!;
const HOWTO_TOKENS = (`${howTo.rawHeadingLine}\n${howTo.body}`).length;
const HOWTO_KEY = `markdown_section:${P}:${howTo.rawAnchor}`;
const CONSTRAINTS_KEY = `markdown_section:${P}:${constraints.rawAnchor}`;

// ── 1. skill tool → skill-invocation ──────────────────────────────────────────
check('skill tool → skill-invocation (exact)', () => {
  const out = compileGuidanceActions([node({ type: 'tool', label: 'skill: deep-research' })], baseDeps);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'skill-invocation');
  assert.strictEqual(out[0].params.skillName, 'deep-research');
  assert.strictEqual(out[0].derivability, 'exact');
  assert.strictEqual(out[0].requiresDerivationGate, true);
});

// ── 2. mcp tool + resolver → toolset-usage + tool-invocation per member ────────
check('mcp tool w/ resolver → toolset-usage + per-tool fan-out', () => {
  const deps: CompileDeps = {
    ...baseDeps,
    mcpServerResolver: (d) => d === 'agent-dashboard'
      ? { toolset: 'observability', tools: ['mcp__agent-dashboard__list_agents', 'mcp__agent-dashboard__read_agent_chat'] }
      : null,
  };
  const out = compileGuidanceActions([node({ type: 'tool', label: 'mcp: agent-dashboard' })], deps);
  assert.strictEqual(byKind(out, 'toolset-usage').length, 1);
  assert.strictEqual(byKind(out, 'toolset-usage')[0].params.toolset, 'observability');
  const tis = byKind(out, 'tool-invocation');
  assert.strictEqual(tis.length, 2);
  assert.deepStrictEqual(tis.map((a) => a.params.toolName).sort(),
    ['mcp__agent-dashboard__list_agents', 'mcp__agent-dashboard__read_agent_chat']);
  assert.ok(out.every((a) => a.derivability === 'exact'));
});

// ── 3. mcp tool w/o resolver → single server-granularity toolset-usage ─────────
check('mcp tool w/o resolver → coarse toolset-usage keyed by server', () => {
  const out = compileGuidanceActions([node({ type: 'tool', label: 'mcp: agent-dashboard' })], baseDeps);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'toolset-usage');
  assert.strictEqual(out[0].params.server, 'agent-dashboard');
  assert.strictEqual(out[0].params.toolset, undefined);
});

// ── 4. plain tool node → tool-invocation ──────────────────────────────────────
check('plain tool node → tool-invocation', () => {
  const out = compileGuidanceActions([node({ type: 'tool', label: 'WebFetch' })], baseDeps);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'tool-invocation');
  assert.strictEqual(out[0].params.toolName, 'WebFetch');
});

// ── 5. file-reference → path-touch ────────────────────────────────────────────
check('file-reference → path-touch (exact)', () => {
  const out = compileGuidanceActions([node({ type: 'file-reference', label: '@docs/spike.md' })], baseDeps);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'path-touch');
  assert.strictEqual(out[0].params.pathGlob, 'docs/spike.md'); // leading @ stripped
  assert.strictEqual(out[0].derivability, 'exact');
});

// ── 6. workflow w/ two ordered commands → 2×command-family + workflow-sequence ─
check('workflow w/ ordered commands → command-family ×2 + workflow-sequence', () => {
  const out = compileGuidanceActions([node({
    type: 'workflow', label: 'Run `npm run build` then `git status`.', source: { absPath: P, lineStart: 7, lineEnd: 7 },
  })], baseDeps);
  const fams = byKind(out, 'command-family');
  assert.deepStrictEqual(fams.map((a) => a.params.commandFamily), ['npm-run:build', 'git']);
  assert.ok(fams.every((a) => a.derivability === 'exact'));
  const seq = byKind(out, 'workflow-sequence');
  assert.strictEqual(seq.length, 1);
  assert.strictEqual(seq[0].params.sequence, 'npm-run:build>git');
  assert.strictEqual(seq[0].derivability, 'heuristic');
});

// ── 7. capability w/ single npm command → command-family, no sequence ─────────
check('capability w/ single command → command-family only (no sequence)', () => {
  const out = compileGuidanceActions([node({
    type: 'capability', label: 'Always `npm run restart` to relaunch.', source: { absPath: P, lineStart: 7, lineEnd: 7 },
  })], baseDeps);
  assert.strictEqual(byKind(out, 'command-family').length, 1);
  assert.strictEqual(byKind(out, 'command-family')[0].params.commandFamily, 'npm-run:restart');
  assert.strictEqual(byKind(out, 'workflow-sequence').length, 0); // capability ≠ ordered workflow
});

// ── 8. constraint naming a path → path-touch (observable, not prose) ──────────
check('constraint naming a path → path-touch', () => {
  const out = compileGuidanceActions([node({
    type: 'constraint', label: 'Never edit `.claude/settings.json`.', source: { absPath: P, lineStart: 11, lineEnd: 11 },
  })], baseDeps);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'path-touch');
  assert.strictEqual(out[0].params.pathGlob, '.claude/settings.json');
});

// ── 9. pure prose → unmatchable (honesty boundary, NOT gated) ─────────────────
check('pure prose → unmatchable, requiresDerivationGate=false', () => {
  const out = compileGuidanceActions([node({ type: 'capability', label: 'Be concise and trust your supervisor.' })], baseDeps);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'unmatchable');
  assert.strictEqual(out[0].derivability, 'unmatchable');
  assert.strictEqual(out[0].requiresDerivationGate, false); // unobservable ⇒ parity gate does not govern
});

// ── 10. search intent (no command) → search-pattern ───────────────────────────
check('search-intent capability → search-pattern (heuristic)', () => {
  const out = compileGuidanceActions([node({
    type: 'capability', label: 'Grep the logs for retry markers', source: { absPath: P, lineStart: 5, lineEnd: 5 },
  })], baseDeps);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'search-pattern');
  assert.ok(/^[0-9a-f]{16}$/.test(out[0].params.queryHash));
  assert.strictEqual(out[0].derivability, 'heuristic');
});

// ── 11. "when X" branch → decision-branch ─────────────────────────────────────
check('when-branch capability → decision-branch (heuristic)', () => {
  const out = compileGuidanceActions([node({
    type: 'capability', label: 'When the build fails, revert the change.', source: { absPath: P, lineStart: 5, lineEnd: 5 },
  })], baseDeps);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'decision-branch');
  assert.strictEqual(out[0].derivability, 'heuristic');
});

// ── 11b. WP-2A: code-form tool mention in prose → tool-invocation{fromProse} ──
check('WP-2A: prose `create_team` with a resolver → tool-invocation{fromProse:1}; no resolver → none', () => {
  const proseNode = node({
    type: 'capability', label: 'Use `create_team` to spin up a team.', source: { absPath: P, lineStart: 5, lineEnd: 5 },
  });
  // No resolver wired (baseDeps) → the mention is NOT emitted (pre-WP-2A behaviour).
  const bare = compileGuidanceActions([proseNode], baseDeps);
  assert.strictEqual(byKind(bare, 'tool-invocation').length, 0, 'no resolver ⇒ no fromProse mention');

  // Resolver recognises create_team → exactly one tool-invocation carrying fromProse:'1'.
  const withResolver: CompileDeps = { ...baseDeps, toolNameResolver: (n) => (n === 'create_team' ? ['teams'] : []) };
  const out = compileGuidanceActions([proseNode], withResolver);
  const inv = byKind(out, 'tool-invocation');
  assert.strictEqual(inv.length, 1, 'resolver ⇒ one fromProse tool-invocation');
  assert.strictEqual(inv[0].params.toolName, 'create_team');
  assert.strictEqual(inv[0].params.fromProse, '1');
  assert.strictEqual(inv[0].derivability, 'heuristic');
  // A resolver that does NOT recognise the token emits nothing (the gate stays off).
  const unknownResolver: CompileDeps = { ...baseDeps, toolNameResolver: () => [] };
  assert.strictEqual(byKind(compileGuidanceActions([proseNode], unknownResolver), 'tool-invocation').length, 0);
});

// ── 12. residentTokens = smallest enclosing section; sectionKey; epoch id ──────
check('resident section pricing + sourceSectionKey + sourceEpochId', () => {
  const deps: CompileDeps = {
    ...baseDeps,
    openEpochIdFor: (k) => k === HOWTO_KEY ? `${HOWTO_KEY}@1700000000000` : null,
  };
  const out = compileGuidanceActions([node({
    type: 'workflow', label: 'Run `npm run build` then `git status`.', source: { absPath: P, lineStart: 7, lineEnd: 7 },
  })], deps);
  assert.ok(out.length >= 1);
  for (const a of out) {
    assert.strictEqual(a.residentTokens, HOWTO_TOKENS, 'section priced by enclosing span');
    assert.strictEqual(a.sourceSectionKey, HOWTO_KEY);
    assert.strictEqual(a.sourceEpochId, `${HOWTO_KEY}@1700000000000`);
    assert.deepStrictEqual(a.lanes, LANES); // lane-union reused from module-1 target
  }
});

// ── 13. unresolved epoch → empty sourceEpochId (honest, not fabricated) ───────
check('no openEpochIdFor ⇒ empty sourceEpochId, sectionKey still resolves', () => {
  const out = compileGuidanceActions([node({
    type: 'constraint', label: 'Never edit `.claude/settings.json`.', source: { absPath: P, lineStart: 11, lineEnd: 11 },
  })], baseDeps);
  assert.strictEqual(out[0].sourceEpochId, '');
  assert.strictEqual(out[0].sourceSectionKey, CONSTRAINTS_KEY);
  assert.ok(out[0].residentTokens > 0);
});

// ── 14. path-less / off-target node → zeroed section identity, empty lanes ────
check('path-less node (absPath "") → zero tokens, empty section key + lanes', () => {
  const out = compileGuidanceActions([node({
    type: 'tool', label: 'mcp: some-server', source: { absPath: '', lineStart: 1, lineEnd: 1 },
  })], baseDeps);
  assert.strictEqual(out[0].kind, 'toolset-usage');
  assert.strictEqual(out[0].residentTokens, 0);
  assert.strictEqual(out[0].sourceSectionKey, '');
  assert.strictEqual(out[0].sourceEpochId, '');
  assert.deepStrictEqual(out[0].lanes, []);
});

// ── 15. deterministic ids + stable ordering ───────────────────────────────────
check('stable ids + deterministic ordering across runs', () => {
  const nodes: KnowledgeNode[] = [
    node({ type: 'tool', label: 'skill: verify' }),
    node({ type: 'workflow', label: 'Run `npm run build` then `git status`.', source: { absPath: P, lineStart: 7, lineEnd: 7 } }),
  ];
  const a = compileGuidanceActions(nodes, baseDeps);
  const b = compileGuidanceActions(nodes, baseDeps);
  assert.deepStrictEqual(a.map((x) => x.id), b.map((x) => x.id));
  assert.ok(a.every((x) => /^[0-9a-f]{16}$/.test(x.id)));
  // ids distinguish kind+params under one anchor
  const ids = new Set(a.map((x) => x.id));
  assert.strictEqual(ids.size, a.length);
});

console.log(`\nguidance-action-model.test.ts: ${passed} passed`);
