// optimizer-scaffold-registry unit tests (WP6 acceptance leg — seam #2 data half).
// Pure — system-Node runner, no DB, no git spawn:
//   npm run build:main
//   node dist/main/main/context-optimizer/optimizer-scaffold-registry.test.js
//
// Coverage: every production entry matches its resident scaffold copy (by path tail
// across Windows / POSIX / WSL path forms AND by pooled sourceSymbol); a skill body's
// entry matches ALL three lanes' copies; a non-scaffold target matches NOTHING; and the
// bridge extracts the CORRECT, symbol-specific constant body out of the REAL
// src/shared/constants.ts checked into this repo (proving §3.2.3 end-to-end).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PRODUCTION_SCAFFOLD_ENTRIES,
  makeProductionScaffoldConstantResolver,
} from './optimizer-scaffold-registry';
import type { ResidentTarget } from './resident-inventory';

function target(over: Partial<ResidentTarget> & { sourcePath: string }): ResidentTarget {
  return {
    targetType: 'markdown_section',
    targetKey: over.sourcePath,
    sourceKind: 'user_file',
    sourceSymbol: null,
    lanes: ['supervisor'],
    text: '# heading\nbody\n',
    ...over,
  };
}

/** Walk up from this compiled test file until src/shared/constants.ts is found. */
function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'src', 'shared', 'constants.ts'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('could not locate repo root (src/shared/constants.ts) from ' + __dirname);
}

type Test = { name: string; fn: () => void };
const tests: Test[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

// The expected resident copies for each managed constant (one representative path per
// constant; skill bodies list all three lane copies to prove the single tail matches).
const EXPECTED: Record<string, string[]> = {
  SUPERVISOR_AGENT_MD: ['C:\\Users\\x\\proj\\.dashboard\\supervisor\\CLAUDE.md'],
  WORKER_CLAUDE_MD: ['/home/x/proj/.dashboard/workers/claude/CLAUDE.md'],
  RESEARCHER_AGENT_MD: ['\\\\wsl.localhost\\Ubuntu\\home\\x\\proj\\.dashboard\\researcher\\CLAUDE.md'],
  SUPERVISOR_RUN_ORCHESTRATION_SKILL: ['/p/.dashboard/supervisor/.claude/skills/run-orchestration/SKILL.md'],
  SUPERVISOR_ORCHESTRATION_SPIKE_SKILL: ['/p/.dashboard/supervisor/.claude/skills/orchestration-spike/SKILL.md'],
  PERSONA_CREATE_PERSONA_SKILL: [
    '/p/.dashboard/supervisor/.claude/skills/create-persona/SKILL.md',
    '/p/.dashboard/workers/claude/.claude/skills/create-persona/SKILL.md',
    '/p/.dashboard/researcher/.claude/skills/create-persona/SKILL.md',
  ],
  PERSONA_READ_COMMENTS_SKILL: [
    '/p/.dashboard/supervisor/.claude/skills/read-comments/SKILL.md',
    '/p/.dashboard/workers/claude/.claude/skills/read-comments/SKILL.md',
    '/p/.dashboard/researcher/.claude/skills/read-comments/SKILL.md',
  ],
};

const entryFor = (sym: string) =>
  PRODUCTION_SCAFFOLD_ENTRIES.find((e) => e.constantSymbol === sym) ??
  assert.fail(`no registry entry for ${sym}`);

test('every managed constant in EXPECTED has exactly one registry entry (and vice versa)', () => {
  const registrySymbols = PRODUCTION_SCAFFOLD_ENTRIES.map((e) => e.constantSymbol).sort();
  const expectedSymbols = Object.keys(EXPECTED).sort();
  assert.deepEqual(registrySymbols, expectedSymbols);
});

test('each entry matches its resident copy by path tail (Windows / POSIX / WSL forms)', () => {
  for (const [sym, paths] of Object.entries(EXPECTED)) {
    const entry = entryFor(sym);
    for (const p of paths) {
      assert.ok(entry.matches(target({ sourcePath: p })), `${sym} should match ${p}`);
    }
  }
});

test('skill-body entries match ALL three lane copies with one tail', () => {
  for (const sym of ['PERSONA_CREATE_PERSONA_SKILL', 'PERSONA_READ_COMMENTS_SKILL']) {
    const entry = entryFor(sym);
    assert.equal(EXPECTED[sym].length, 3);
    for (const p of EXPECTED[sym]) assert.ok(entry.matches(target({ sourcePath: p })));
  }
});

test('an entry also matches by pooled sourceSymbol regardless of path', () => {
  const entry = entryFor('SUPERVISOR_AGENT_MD');
  assert.ok(entry.matches(target({ sourcePath: '/wherever/pooled.md', sourceSymbol: 'SUPERVISOR_AGENT_MD' })));
  // Wrong symbol on an unrelated path ⇒ no match.
  assert.ok(!entry.matches(target({ sourcePath: '/wherever/pooled.md', sourceSymbol: 'WORKER_CLAUDE_MD' })));
});

test('non-scaffold targets match NOTHING (no false-positive dating)', () => {
  const strangers = [
    '/home/x/myproject/CLAUDE.md',                       // a USER project root CLAUDE.md
    '/home/x/proj/docs/README.md',
    '/home/x/proj/.dashboard/research/README.md',        // research store, not a persona
    '/home/x/proj/.dashboard/supervisor/memory/MEMORY.md', // seed-once, not managed here
    '/home/x/proj/.claude/skills/other/SKILL.md',        // a non-registered skill
  ];
  for (const p of strangers) {
    const t = target({ sourcePath: p });
    assert.ok(
      PRODUCTION_SCAFFOLD_ENTRIES.every((e) => !e.matches(t)),
      `${p} should match no scaffold entry`,
    );
  }
});

test('read-comments SKILL.md does NOT collide with create-persona SKILL.md', () => {
  const readComments = entryFor('PERSONA_READ_COMMENTS_SKILL');
  const createPersona = entryFor('PERSONA_CREATE_PERSONA_SKILL');
  const rcPath = '/p/.dashboard/supervisor/.claude/skills/read-comments/SKILL.md';
  const cpPath = '/p/.dashboard/supervisor/.claude/skills/create-persona/SKILL.md';
  assert.ok(readComments.matches(target({ sourcePath: rcPath })));
  assert.ok(!readComments.matches(target({ sourcePath: cpPath })));
  assert.ok(createPersona.matches(target({ sourcePath: cpPath })));
  assert.ok(!createPersona.matches(target({ sourcePath: rcPath })));
});

// ── end-to-end against the REAL constants.ts (proves the bridge extracts the right
//    symbol body — §3.2.3 constant-hash history seam) ─────────────────────────────
test('bridge extracts the correct, symbol-specific body from the real constants.ts', () => {
  const repoRoot = findRepoRoot();
  const constantsSource = fs.readFileSync(
    path.join(repoRoot, 'src', 'shared', 'constants.ts'),
    'utf8',
  );
  const resolver = makeProductionScaffoldConstantResolver(repoRoot);

  const supBridge = resolver(target({ sourcePath: EXPECTED.SUPERVISOR_AGENT_MD[0] }));
  assert.ok(supBridge, 'supervisor CLAUDE.md should resolve a scaffold bridge');
  const supText = supBridge!.extractConstantText(constantsSource);
  assert.ok(supText && supText.length > 100, 'SUPERVISOR_AGENT_MD body should be non-trivial');

  const rcBridge = resolver(target({ sourcePath: EXPECTED.PERSONA_READ_COMMENTS_SKILL[0] }));
  assert.ok(rcBridge, 'read-comments SKILL.md should resolve a scaffold bridge');
  const rcText = rcBridge!.extractConstantText(constantsSource);
  assert.ok(rcText && rcText.length > 50, 'PERSONA_READ_COMMENTS_SKILL body should be non-trivial');

  // Symbol-specific: two different constants extract DIFFERENT bodies.
  assert.notEqual(supText, rcText);

  // The bridge points at src/shared/constants.ts and the app's own repo root.
  assert.equal(supBridge!.relPath.replace(/\\/g, '/'), 'src/shared/constants.ts');
  assert.equal(supBridge!.repoDir, repoRoot);
});

test('resolver returns null for a non-scaffold target (no bridge, no false dating)', () => {
  const resolver = makeProductionScaffoldConstantResolver(findRepoRoot());
  assert.equal(resolver(target({ sourcePath: '/home/x/myproject/CLAUDE.md' })), null);
});

// ── runner ──────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
for (const t of tests) {
  try { t.fn(); passed++; console.log(`  ✓ ${t.name}`); }
  catch (e) { failed++; console.error(`  ✗ ${t.name}\n    ${e instanceof Error ? e.message : e}`); }
}
console.log(`\noptimizer-scaffold-registry: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
