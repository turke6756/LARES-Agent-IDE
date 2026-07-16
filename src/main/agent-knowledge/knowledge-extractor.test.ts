// Deterministic knowledge extractor unit tests (WP4 / P3.1).
//   npm run build:main
//   node dist/main/main/agent-knowledge/knowledge-extractor.test.js

import assert from 'node:assert/strict';
import { extractAgentKnowledge } from './knowledge-extractor';
import type { KnowledgeNode, KnowledgeNodeType } from '../../shared/types';
import {
  buildFixtureAgent, FILES, WS_ROOT,
  AGENT_CLAUDE, WS_CLAUDE, IMPORTED, SKILL,
} from './__fixtures__/knowledge-fixtures';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const deps = { readFile: (p: string): string | null => (p in FILES ? FILES[p] : null) };
function run() { return extractAgentKnowledge(buildFixtureAgent(), deps, { workspaceRoot: WS_ROOT }); }

function nodesOf(nodes: KnowledgeNode[], type: KnowledgeNodeType): KnowledgeNode[] {
  return nodes.filter((n) => n.type === type);
}
function byLabel(nodes: KnowledgeNode[], label: string): KnowledgeNode | undefined {
  return nodes.find((n) => n.label === label);
}

// ── classification rules ───────────────────────────────────────────────────────

test('positive imperative bullet → capability with source line + provenance', () => {
  const { nodes } = run();
  const n = byLabel(nodes, 'Use absolute paths for Read / Edit / Glob.');
  assert.ok(n, 'capability node present');
  assert.equal(n!.type, 'capability');
  assert.equal(n!.source.absPath, AGENT_CLAUDE);
  assert.equal(n!.source.lineStart, 7, '1-based line of the bullet');
  assert.equal(n!.source.lineEnd, 7, 'single-line bullet span: lineStart === lineEnd');
  assert.equal(n!.sourceScope, 'agent');
  assert.equal(n!.sourceRole, 'agent-claude', 'agent template CLAUDE.md → agent-claude role');
});

test('negative imperative bullet → constraint', () => {
  const { nodes } = run();
  const n = byLabel(nodes, 'Never invoke AskUserQuestion or blocking dialogs.');
  assert.ok(n, 'constraint node present');
  assert.equal(n!.type, 'constraint');
  assert.equal(n!.source.lineStart, 8);
});

test('heading → capability; "How to" heading + numbered item → workflow', () => {
  const { nodes } = run();
  const cap = byLabel(nodes, 'Worker Agent');
  assert.equal(cap?.type, 'capability');
  assert.match(cap?.detail ?? '', /generic worker/, 'synopsis = verbatim first sentence');

  const howTo = byLabel(nodes, 'How to ask questions');
  assert.equal(howTo?.type, 'workflow', '"How to" heading classes as workflow');

  const numbered = byLabel(nodes, 'Draft the change first.');
  assert.equal(numbered?.type, 'workflow', 'numbered list item → workflow');
});

test('MEMORY reference → memory node', () => {
  const { nodes } = run();
  const mem = nodesOf(nodes, 'memory');
  assert.ok(mem.some((n) => /MEMORY\.md/.test(n.label)), 'a memory node cites MEMORY.md');
});

test('backticked path + @import → file-reference nodes', () => {
  const { nodes } = run();
  const refs = nodesOf(nodes, 'file-reference');
  assert.ok(refs.some((n) => n.label === 'memory/MEMORY.md'), 'inline backticked path captured');
  const imp = refs.find((n) => n.label === '@behavioral-notes.md');
  assert.ok(imp, '@import token captured as a file-reference');
  assert.equal(imp!.source.absPath, WS_CLAUDE);
  assert.equal(imp!.source.lineStart, 5, '@import line resolved in the workspace CLAUDE.md');
});

// ── skills + MCP → tool nodes ──────────────────────────────────────────────────

test('SKILL.md → single skill tool node (header/body dedup) + parsed body', () => {
  const { nodes } = run();
  const skillTools = nodesOf(nodes, 'tool').filter((n) => n.label.startsWith('skill:'));
  assert.equal(skillTools.length, 1, 'header+body share a path → exactly one skill tool node');
  assert.equal(skillTools[0].label, 'skill: deep-research');
  assert.equal(skillTools[0].source.absPath, SKILL);
  // Body content parsed exactly once despite the header/body pair.
  const fanOut = nodes.filter((n) => n.label === 'Fan out search queries.');
  assert.equal(fanOut.length, 1, 'skill body parsed exactly once');
  assert.equal(fanOut[0].type, 'workflow');
});

test('granted MCP servers → tool nodes; excluded flagged; ungranted omitted', () => {
  const { nodes } = run();
  const mcp = nodesOf(nodes, 'tool').filter((n) => n.label.startsWith('mcp:'));
  const names = mcp.map((n) => n.label).sort();
  assert.deepEqual(names, ['mcp: agent-dashboard', 'mcp: agent-teams'], 'only granted servers surface');
  const excluded = byLabel(nodes, 'mcp: agent-teams');
  assert.match(excluded?.detail ?? '', /excluded by strict mode/);
  const dash = byLabel(nodes, 'mcp: agent-dashboard');
  assert.equal(dash?.source.absPath, '/ws/.mcp.json', 'configPath is the click target');
});

// ── frame filtering + provenance + determinism ─────────────────────────────────

test('excluded (included:false) frames contribute no nodes', () => {
  const { nodes } = run();
  assert.ok(!nodes.some((n) => n.source.absPath === '/other/CLAUDE.md'), 'gated-out frame ignored');
});

test('every node carries a source pointer with a positive line span', () => {
  const { nodes } = run();
  for (const n of nodes) {
    assert.equal(typeof n.source.lineStart, 'number');
    assert.ok(n.source.lineStart >= 1, `lineStart >= 1 for ${n.label}`);
    assert.ok(n.source.lineEnd >= n.source.lineStart, `lineEnd >= lineStart for ${n.label}`);
    assert.equal(typeof n.source.absPath, 'string');
  }
});

test('sourceFiles report the parsed surfaces with node counts', () => {
  const { sourceFiles } = run();
  const paths = sourceFiles.map((f) => f.absPath);
  assert.ok(paths.includes(AGENT_CLAUDE) && paths.includes(WS_CLAUDE) && paths.includes(IMPORTED) && paths.includes(SKILL));
  // SKILL appears once even though walk-up emitted header + body rows.
  assert.equal(paths.filter((p) => p === SKILL).length, 1, 'skill path de-duped in sourceFiles');
  assert.ok(sourceFiles.every((f) => f.nodeCount >= 0));
});

test('extraction is deterministic (byte-stable across runs)', () => {
  assert.equal(JSON.stringify(run()), JSON.stringify(run()));
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
