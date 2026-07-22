// section-identity-join.test.ts — WP5 (G5) milestone-gate-3 tests.
//
//  1. Helper equivalence: the config-weight section anchor === the optimizer
//     anchor on a SHARED fixture (same `${targetType}:${targetKey}:${rawAnchor}`
//     via shared/section-identity.ts — a key-equality join, no reconstruction).
//  2. Identity regression (a): unchanged sections keep IDENTICAL keys across
//     line movement caused by edits elsewhere in the file.
//  3. Identity regression (b): unchanged sections keep IDENTICAL keys across
//     unrelated section edits.
//
// node:assert on dist. Run: node dist/main/main/context-overhead/section-identity-join.test.js
import assert from 'node:assert';
import type { KnowledgeNode, McpServerOverhead, OverheadSource } from '../../shared/types';
import { normalizeSectionPathKey, sectionKeyFor } from '../../shared/section-identity';
import { classifyAgentConfig, deriveSectionKeysByStartLine } from './config-weight';
import type { FileReader } from './context-overhead-analyzer';
import type { PathOps } from './paths';
import type { TokenEstimator } from './token-estimator';
import { compileGuidanceActions } from '../context-optimizer/guidance-action-model';
import { deriveAnchors, parseMarkdownSections, type ResidentTarget } from '../context-optimizer/resident-inventory';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// ── shared fixture ────────────────────────────────────────────────────────────
const P = 'C:/ws/CLAUDE.md';
const TEXT = [
  '# Guide',                       // 1
  '',                              // 2
  'Intro prose.',                  // 3
  '',                              // 4
  '## Alpha',                      // 5
  '',                              // 6
  'Run `npm run build` here.',     // 7
  '',                              // 8
  '## Beta',                       // 9
  '',                              // 10
  'See `docs/x.md` for details.',  // 11
  '',                              // 12
  '## Notes',                      // 13 (duplicate heading path → :0)
  'a',                             // 14
  '## Notes',                      // 15 (duplicate heading path → :1)
  'b',                             // 16
].join('\n');

function makeReader(content: string): FileReader {
  return {
    read: (p) => (p === P ? { content, bytes: Buffer.byteLength(content) } : null),
    exists: () => true,
    listFiles: () => [],
  };
}
const estimator = {
  estimate: (t: string) => ({
    tokens: t.length, bytes: t.length, chars: t.length,
    method: 'chars-heuristic' as const, approximate: true,
  }),
} as unknown as TokenEstimator;
const pathOps = {
  resolve: (p: string) => p,
  dirname: (p: string) => p.split('/').slice(0, -1).join('/'),
  join: (b: string, r: string) => `${b}/${r}`,
  isAbsolute: (p: string) => /^[A-Za-z]:/.test(p) || p.startsWith('/'),
} as unknown as PathOps;
const source = {
  id: `${P}#agent-claude`, kind: 'agent-claude', label: 'CLAUDE.md', resolvedPath: P,
  dedupeKey: P, sourceScope: 'agent', openable: true, exists: true, inherited: false,
  estimate: estimator.estimate(TEXT), origin: 'walk-up', mutable: 'user-owned', warnings: [],
} as unknown as OverheadSource;
const mcp: McpServerOverhead[] = [];

function classify(content: string) {
  return classifyAgentConfig(
    [{ ...source, estimate: estimator.estimate(content) } as OverheadSource],
    mcp, makeReader(content), estimator, pathOps, 'C:/ws',
  );
}

function keysByHeading(content: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const s of classify(content).sections) {
    // duplicate headings: last-write is fine for non-duplicate assertions;
    // duplicates are asserted through the full key list separately.
    out.set(`${s.heading}@${s.startLine}`, s.sectionKey);
  }
  return out;
}

// ── 1. helper equivalence: config-weight anchor === optimizer anchor ──────────
check('config-weight sectionKey === optimizer sectionKey on the shared fixture', () => {
  const target = { targetType: 'markdown_section', targetKey: normalizeSectionPathKey(P) };
  const candidates = deriveAnchors(parseMarkdownSections(TEXT));
  const optimizerKeys = new Map(candidates.map((c) => [c.lineStart, sectionKeyFor(target, c.rawAnchor)]));

  const rollup = classify(TEXT);
  assert.ok(rollup.sections.length >= 5, 'fixture produced sections');
  for (const s of rollup.sections) {
    assert.strictEqual(s.sectionKey, optimizerKeys.get(s.startLine),
      `section '${s.heading}' (line ${s.startLine}) derives the optimizer's own key`);
    assert.ok(s.sectionKey, `section '${s.heading}' carries a key`);
  }
  // Duplicate heading paths get the SAME :n suffixes both sides.
  const noteKeys = rollup.sections.filter((s) => s.heading === 'Notes').map((s) => s.sectionKey);
  assert.strictEqual(new Set(noteKeys).size, 2, 'duplicate headings stay distinct');
  assert.ok(noteKeys.every((k) => /^markdown_section:C:\/ws\/CLAUDE\.md:h:guide>notes:[01]$/.test(k!)),
    `suffixed duplicate anchors match the §2.2 tier value: ${noteKeys.join(', ')}`);
});

// ── 2. the compiled verdict key joins the config-weight key (no reconstruction) ─
check('compileGuidanceActions sourceSectionKey === config-weight sectionKey', () => {
  const target: ResidentTarget = {
    targetType: 'markdown_section', targetKey: normalizeSectionPathKey(P),
    sourceKind: 'user_file', sourcePath: P, sourceSymbol: null, lanes: ['worker'], text: TEXT,
  };
  const node = {
    type: 'workflow', label: 'Run `npm run build` here.',
    source: { absPath: P, lineStart: 7, lineEnd: 7 }, sourceRole: 'agent-own',
  } as unknown as KnowledgeNode;
  const [action] = compileGuidanceActions([node], {
    residentTargets: [target], estimateTokens: (t) => t.length,
  });
  const alpha = classify(TEXT).sections.find((s) => s.heading === 'Alpha')!;
  assert.ok(action.sourceSectionKey, 'action resolved a section key');
  assert.strictEqual(action.sourceSectionKey, alpha.sectionKey,
    'verdict-side key and config-weight-side key are the SAME string');
});

// ── 3. regression (a): line movement from edits elsewhere ─────────────────────
check('unchanged sections keep identical keys across line movement', () => {
  const before = deriveSectionKeysByStartLine(P, TEXT);
  // Insert five lines into Alpha's body — every later section MOVES.
  const moved = TEXT.replace('Run `npm run build` here.',
    ['Run `npm run build` here.', '', 'x1', 'x2', 'x3', 'x4', 'x5'].join('\n'));
  const after = deriveSectionKeysByStartLine(P, moved);

  const beforeByKey = new Set(before.values());
  const afterByKey = new Set(after.values());
  assert.deepStrictEqual([...afterByKey].sort(), [...beforeByKey].sort(),
    'the key SET is identical — no key changed despite every startLine after Alpha shifting');

  // And through the classifier: Beta/Notes moved lines but kept keys.
  const b = keysByHeading(TEXT);
  const a = keysByHeading(moved);
  assert.strictEqual(a.get('Beta@15'), b.get('Beta@9'), 'Beta key survives a +6 line shift');
  assert.strictEqual(a.get('Notes@19'), b.get('Notes@13'), 'Notes:0 key survives the shift');
  assert.strictEqual(a.get('Notes@21'), b.get('Notes@15'), 'Notes:1 key survives the shift');
});

// ── 4. regression (b): unrelated section edits ────────────────────────────────
check('unchanged sections keep identical keys across unrelated section edits', () => {
  const before = keysByHeading(TEXT);
  const edited = TEXT.replace('See `docs/x.md` for details.', 'Totally rewritten Beta body, `git log`.');
  const after = keysByHeading(edited);
  assert.strictEqual(after.get('Alpha@5'), before.get('Alpha@5'), 'Alpha key unchanged');
  assert.strictEqual(after.get('Notes@13'), before.get('Notes@13'), 'Notes:0 key unchanged');
  assert.strictEqual(after.get('Notes@15'), before.get('Notes@15'), 'Notes:1 key unchanged');
  // The edited section keeps its own (heading-anchored) key too.
  assert.strictEqual(after.get('Beta@9'), before.get('Beta@9'), 'Beta keeps its lineage key');
});

console.log(`section-identity-join: ${passed} checks passed`);
