// file-coverage unit tests (hardening-classifier-agent-surface §2 / §7).
// Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/context-optimizer/file-coverage.test.js
//
// Coverage: bucket precedence (§2.2), config-referenced exact+open-epoch gating,
// ignore retroactivity, and the skill-bypass detector's seven guards (§2.4 G1..G7)
// incl. the read-comments rediscovery fixture (24 exec / 5 skill → one proposal).

import assert from 'node:assert/strict';
import type { AgentRoleLane } from '../../shared/types';
import type { MutabilityClass } from '../shared/path-mutability';
import type { PredictedAction } from './guidance-action-model';
import {
  classifyFileCoverage,
  classifyPathBucket,
  classifyPathRole,
  canonicalHeatScore,
  isOperationalNoiseRole,
  detectSkillBypass,
  scriptGlobsFor,
  normPath,
  globMatch,
  type SkillScriptOwnership,
  type SkillOwnedIndex,
  type FileCoverageIgnore,
  type FileTouch,
  type ClassifyDeps,
  type PathRoleDeps,
  type BypassExecEvent,
  type SkillInvocationWindow,
  type SkillLaneExposure,
} from './file-coverage';

// ── fixture builders ─────────────────────────────────────────────────────────

const SUP: AgentRoleLane = 'supervisor';
const WORKER: AgentRoleLane = 'worker';
const RESEARCHER: AgentRoleLane = 'researcher';

function skill(over: Partial<SkillScriptOwnership> = {}): SkillScriptOwnership {
  return {
    skillName: 'read-comments',
    skillRoot: '/w/.claude/skills/read-comments',
    lanes: [WORKER],
    mutable: 'user-owned' as MutabilityClass,
    scriptGlobs: ['/w/.claude/skills/read-comments/read.py'],
    ...over,
  };
}

function pathTouchAction(over: Partial<PredictedAction> = {}): PredictedAction {
  return {
    id: 'pt1',
    source: { absPath: '/w/.dashboard/supervisor/CLAUDE.md', line: 5 },
    sourceKind: 'capability' as PredictedAction['sourceKind'],
    lanes: [SUP],
    kind: 'path-touch',
    params: { pathGlob: '/w/config/*.yaml' },
    derivability: 'exact',
    residentTokens: 40,
    sourceSectionKey: 'sec',
    sourceEpochId: 'e-open',
    requiresDerivationGate: true,
    ...over,
  };
}

const DEFAULT_DEPS: ClassifyDeps = {
  classifyPathMutability: () => 'user-owned',
  isOpenEpoch: (id) => id !== '' && id !== 'e-closed',
};

function touch(over: Partial<FileTouch> = {}): FileTouch {
  return { path: '/w/src/foo.ts', reads: 1, writes: 0, executes: 0, distinctStreams: 1, ...over };
}

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error('       ', err instanceof Error ? err.message : err);
    failed++;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

check('glob: ** spans slashes; * does not', () => {
  assert.equal(globMatch('**/node_modules/**', '/w/a/node_modules/b/c.js'), true);
  assert.equal(globMatch('/w/config/*.yaml', '/w/config/app.yaml'), true);
  assert.equal(globMatch('/w/config/*.yaml', '/w/config/nested/app.yaml'), false);
});
check('glob: {a,b} alternation', () => {
  assert.equal(globMatch('**/{package-lock,pnpm-lock,yarn}.lock', '/w/package-lock.lock'), true);
});
check('normPath: lowercase + backslashes → forward, trailing slash stripped', () => {
  assert.equal(normPath('C:\\W\\Src\\Foo.TS\\'), 'c:/w/src/foo.ts');
});

// ── scriptGlobsFor (§2.1) ──────────────────────────────────────────────────

check('scriptGlobsFor: script exts only, excludes SKILL.md/docs/tests, adds referenced exe', () => {
  const globs = scriptGlobsFor({
    skillRoot: '/w/.claude/skills/rc',
    filesUnderRoot: [
      '/w/.claude/skills/rc/SKILL.md',
      '/w/.claude/skills/rc/read.py',
      '/w/.claude/skills/rc/README.md',
      '/w/.claude/skills/rc/logo.png',
      '/w/.claude/skills/rc/tests/read.test.py',
    ],
    skillMdReferencedExecutables: ['bin/run.sh'],
  });
  assert.deepEqual(globs, ['/w/.claude/skills/rc/bin/run.sh', '/w/.claude/skills/rc/read.py']);
});

// ── Acceptance §7.1: skill-owned wins over a path-touch glob; doc → resource ──

check('§7.1 bucket precedence: script → skill-owned even if it matches a path-touch glob', () => {
  const s = skill({ skillRoot: '/w/.claude/skills/read-comments' });
  const action = pathTouchAction({ params: { pathGlob: '/w/.claude/skills/**/*.py' }, lanes: [WORKER] });
  const v = classifyPathBucket(
    '/w/.claude/skills/read-comments/read.py', WORKER, [action], [s], [], DEFAULT_DEPS);
  assert.equal(v.bucket, 'skill-owned');
  assert.equal(v.matchConfidence, 'exact');
});
check('§7.1 a doc under the same skill root → skill-owned-resource (heat only)', () => {
  const s = skill();
  const v = classifyPathBucket(
    '/w/.claude/skills/read-comments/README.md', WORKER, [], [s], [], DEFAULT_DEPS);
  assert.equal(v.bucket, 'skill-owned-resource');
});

// ── Acceptance §7.2: scaffold-vendor wins over skill-owned for vendored root ──

check('§7.2 vendored (generated-vendor) skill root → scaffold-vendor, not skill-owned', () => {
  const s = skill({ mutable: 'generated-vendor' });
  const v = classifyPathBucket(
    '/w/.claude/skills/read-comments/read.py', WORKER, [], [s], [], DEFAULT_DEPS);
  assert.equal(v.bucket, 'scaffold-vendor');
});
check('§7.2 classifyPathMutability generated-vendor → scaffold-vendor', () => {
  const deps: ClassifyDeps = { ...DEFAULT_DEPS, classifyPathMutability: () => 'generated-vendor' };
  const v = classifyPathBucket('/w/node/x.js', WORKER, [], [], [], deps);
  assert.equal(v.bucket, 'scaffold-vendor');
});

// ── Acceptance §7.3: ignores → ignored, absent from rollup, raw events remain ──

check('§7.3 node_modules / *-lock.json / *.bak.* → ignored, dropped from fileHeat', () => {
  const ignores: FileCoverageIgnore[] = [
    { pattern: '**/node_modules/**', patternKind: 'glob', scope: 'global' },
    { pattern: '**/*-lock.json', patternKind: 'glob', scope: 'global' },
    { pattern: '**/*.bak.*', patternKind: 'glob', scope: 'global' },
  ];
  const touches: FileTouch[] = [
    touch({ path: '/w/node_modules/x/index.js', reads: 9 }),
    touch({ path: '/w/package-lock.json', reads: 3 }),
    touch({ path: '/w/foo.bak.123', reads: 2 }),
    touch({ path: '/w/src/live.ts', reads: 5 }),
  ];
  const r = classifyFileCoverage(WORKER, touches, [], [], ignores, DEFAULT_DEPS);
  assert.equal(r.bucketCounts.ignored, 3);
  assert.equal(r.fileHeat.length, 1);
  assert.equal(r.fileHeat[0].pathDisplay, '/w/src/live.ts');
});

// ── Acceptance §7.4: config-referenced only for exact + open-epoch ─────────────

check('§7.4 config-referenced only for derivability=exact + open epoch', () => {
  const exact = pathTouchAction({ derivability: 'exact', sourceEpochId: 'e-open', lanes: [SUP] });
  const v = classifyPathBucket('/w/config/app.yaml', SUP, [exact], [], [], DEFAULT_DEPS);
  assert.equal(v.bucket, 'config-referenced');
});
check('§7.4 heuristic path-touch does NOT cover → uncovered', () => {
  const heur = pathTouchAction({ derivability: 'heuristic', lanes: [SUP] });
  const v = classifyPathBucket('/w/config/app.yaml', SUP, [heur], [], [], DEFAULT_DEPS);
  assert.equal(v.bucket, 'uncovered');
});
check('§7.4 closed epoch does NOT cover → uncovered', () => {
  const closed = pathTouchAction({ sourceEpochId: 'e-closed', lanes: [SUP] });
  const v = classifyPathBucket('/w/config/app.yaml', SUP, [closed], [], [], DEFAULT_DEPS);
  assert.equal(v.bucket, 'uncovered');
});
check('§7.4 wrong-lane path-touch does NOT cover', () => {
  const other = pathTouchAction({ lanes: [RESEARCHER] });
  const v = classifyPathBucket('/w/config/app.yaml', SUP, [other], [], [], DEFAULT_DEPS);
  assert.equal(v.bucket, 'uncovered');
});

// ── Acceptance §7.5: basename-only match to GENERIC_SCRIPT_NAMES → not skill-owned

check('§7.5 basename-only run.py (generic) → NOT skill-owned (uncovered)', () => {
  const s = skill({ skillRoot: '/w/.claude/skills/rc', scriptGlobs: ['/w/.claude/skills/rc/run.py'] });
  // A run.py executed elsewhere, basename collides with generic stoplist stem 'run'.
  const v = classifyPathBucket('/elsewhere/run.py', WORKER, [], [s], [], DEFAULT_DEPS);
  assert.equal(v.bucket, 'uncovered');
});
check('§7.5 basename-only non-generic (>=4 chars) → skill-owned basename confidence', () => {
  const s = skill({ scriptGlobs: ['/w/.claude/skills/read-comments/reader.py'] });
  const v = classifyPathBucket('/elsewhere/reader.py', WORKER, [], [s], [], DEFAULT_DEPS);
  assert.equal(v.bucket, 'skill-owned');
  assert.equal(v.matchConfidence, 'basename');
});

// ── Acceptance §7.6: ignore retroactivity + soft-delete re-exposes ─────────────

check('§7.6 adding a pattern suppresses; disabledAtMs re-exposes (same touches)', () => {
  const touches: FileTouch[] = [touch({ path: '/w/scratch/tmp.ts', reads: 4 })];
  const active: FileCoverageIgnore[] = [
    { pattern: '/w/scratch/**', patternKind: 'glob', scope: 'global' },
  ];
  const disabled: FileCoverageIgnore[] = [{ ...active[0], disabledAtMs: 1234 }];
  assert.equal(classifyFileCoverage(WORKER, touches, [], [], active, DEFAULT_DEPS).fileHeat.length, 0);
  assert.equal(classifyFileCoverage(WORKER, touches, [], [], disabled, DEFAULT_DEPS).fileHeat.length, 1);
});
check('§7.6 lane-scoped ignore only applies to its lane', () => {
  const touches: FileTouch[] = [touch({ path: '/w/x.ts' })];
  const ign: FileCoverageIgnore[] = [
    { pattern: '/w/x.ts', patternKind: 'exact-path', scope: 'lane', lane: RESEARCHER },
  ];
  assert.equal(classifyFileCoverage(WORKER, touches, [], [], ign, DEFAULT_DEPS).fileHeat.length, 1);
  assert.equal(classifyFileCoverage(RESEARCHER, touches, [], [], ign, DEFAULT_DEPS).fileHeat.length, 0);
});

// ── Bypass detector fixtures ──────────────────────────────────────────────────

const SCRIPT = '/w/.claude/skills/read-comments/read.py';

function execEv(streamId: string, tsMs: number, over: Partial<BypassExecEvent> = {}): BypassExecEvent {
  return {
    streamId,
    tsMs,
    path: SCRIPT,
    lane: WORKER,
    subAgentName: null,
    accessMode: 'executed',
    argPathConfidence: 'exact',
    ...over,
  };
}

function bypassDeps(over: Partial<{ execEvents: BypassExecEvent[]; windows: SkillInvocationWindow[]; exposures: SkillLaneExposure[] }> = {}) {
  return {
    execEvents: [],
    windows: [],
    exposures: [{ skillName: 'read-comments', lane: WORKER, exposureTurns: 200 } as SkillLaneExposure],
    ...over,
  };
}

// ── Acceptance §7.7: read-comments rediscovery — 24 exec / 5 skill → 1 proposal ─

check('§7.7 read-comments: 24 exec streams / 5 skill streams → one tune-skill-trigger', () => {
  const idx: SkillOwnedIndex = [skill()];
  const execEvents = Array.from({ length: 24 }, (_, i) => execEv(`ex${i}`, 1000 + i));
  const windows: SkillInvocationWindow[] = Array.from({ length: 5 }, (_, i) => ({
    streamId: `sk${i}`, skillName: 'read-comments', lane: WORKER, startTsMs: 5000, endTsMs: 6000,
  }));
  const r = detectSkillBypass(WORKER, idx, bypassDeps({ execEvents, windows }));
  assert.equal(r.proposals.length, 1);
  const p = r.proposals[0];
  assert.equal(p.kind, 'tune-skill-trigger');
  assert.equal(p.execStreams, 24);
  assert.equal(p.skillStreams, 5);
  assert.equal(p.requiresDerivationGate, false);
  assert.equal(p.citedStreams.length, 24);
  assert.equal(p.matchConfidence, 'exact');
});

// ── Acceptance §7.8: no false positive on read/debug (G1) ──────────────────────

check('§7.8 30 read touches, 0 executed → no proposal (G1)', () => {
  const idx: SkillOwnedIndex = [skill()];
  const execEvents = Array.from({ length: 30 }, (_, i) => execEv(`r${i}`, 1000 + i, { accessMode: 'read' }));
  const r = detectSkillBypass(WORKER, idx, bypassDeps({ execEvents }));
  assert.equal(r.proposals.length, 0);
});

// ── Acceptance §7.9: within-window execution excluded (G2) ─────────────────────

check('§7.9 execs inside a legit skill window are not bypasses (G2)', () => {
  const idx: SkillOwnedIndex = [skill()];
  // 10 execs, all inside the same stream's window → excluded.
  const execEvents = Array.from({ length: 10 }, (_, i) => execEv(`s${i}`, 5100 + i));
  const windows: SkillInvocationWindow[] = Array.from({ length: 10 }, (_, i) => ({
    streamId: `s${i}`, skillName: 'read-comments', lane: WORKER, startTsMs: 5000, endTsMs: 6000,
  }));
  const r = detectSkillBypass(WORKER, idx, bypassDeps({ execEvents, windows }));
  assert.equal(r.proposals.length, 0);
});

// ── Acceptance §7.10: lane scoping (G3) ────────────────────────────────────────

check('§7.10 worker-skill executed only in researcher streams → no worker bypass (G3)', () => {
  const idx: SkillOwnedIndex = [skill({ lanes: [WORKER] })];
  const execEvents = Array.from({ length: 10 }, (_, i) => execEv(`r${i}`, 1000 + i, { lane: RESEARCHER }));
  const r = detectSkillBypass(WORKER, idx, bypassDeps({ execEvents }));
  assert.equal(r.proposals.length, 0);
  assert.equal(r.watchItems.length, 0);
});

// ── Acceptance §7.11: subagent exclusion (G4) ──────────────────────────────────

check('§7.11 exec only in subagent streams → no proposal; count surfaced (G4)', () => {
  const idx: SkillOwnedIndex = [skill()];
  const execEvents = Array.from({ length: 10 }, (_, i) => execEv(`sa${i}`, 1000 + i, { subAgentName: 'child' }));
  const r = detectSkillBypass(WORKER, idx, bypassDeps({ execEvents }));
  assert.equal(r.proposals.length, 0);
  assert.equal(r.watchItems.length, 1);
  assert.equal(r.watchItems[0].disclosedSubagentExecs, 10);
  assert.equal(r.watchItems[0].execCount, 0);
});

// ── Acceptance §7.12: vendored skill trigger → heat only (G5) ──────────────────

check('§7.12 vendored (generated-vendor) skill → watch item, no proposal (G5)', () => {
  const idx: SkillOwnedIndex = [skill({ mutable: 'generated-vendor' })];
  const execEvents = Array.from({ length: 24 }, (_, i) => execEv(`ex${i}`, 1000 + i));
  const r = detectSkillBypass(WORKER, idx, bypassDeps({ execEvents }));
  assert.equal(r.proposals.length, 0);
  assert.equal(r.watchItems.length, 1);
  assert.equal(r.watchItems[0].reason, 'vendored-trigger');
});

// ── Acceptance §7.13: thresholds (G7) ──────────────────────────────────────────

check('§7.13 4 exec streams → below-support watch item, no proposal (G7)', () => {
  const idx: SkillOwnedIndex = [skill()];
  const execEvents = Array.from({ length: 4 }, (_, i) => execEv(`ex${i}`, 1000 + i));
  const r = detectSkillBypass(WORKER, idx, bypassDeps({ execEvents }));
  assert.equal(r.proposals.length, 0);
  assert.equal(r.watchItems.length, 1);
  assert.equal(r.watchItems[0].reason, 'below-support');
});
check('§7.13 zero-skill-call case needs >=8 exec streams (7 → watch, 8 → proposal)', () => {
  const idx: SkillOwnedIndex = [skill()];
  const seven = Array.from({ length: 7 }, (_, i) => execEv(`a${i}`, 1000 + i));
  const eight = Array.from({ length: 8 }, (_, i) => execEv(`b${i}`, 1000 + i));
  assert.equal(detectSkillBypass(WORKER, idx, bypassDeps({ execEvents: seven })).proposals.length, 0);
  assert.equal(detectSkillBypass(WORKER, idx, bypassDeps({ execEvents: eight })).proposals.length, 1);
});
check('§7.13 insufficient exposure → watch item, no proposal', () => {
  const idx: SkillOwnedIndex = [skill()];
  const execEvents = Array.from({ length: 10 }, (_, i) => execEv(`ex${i}`, 1000 + i));
  const deps = bypassDeps({ execEvents, exposures: [{ skillName: 'read-comments', lane: WORKER, exposureTurns: 5 }] });
  const r = detectSkillBypass(WORKER, idx, deps);
  assert.equal(r.proposals.length, 0);
  assert.equal(r.watchItems[0].reason, 'insufficient-exposure');
});

// ── Determinism guard ─────────────────────────────────────────────────────────

check('bypass output is order-independent (shuffled exec rows → identical proposal)', () => {
  const idx: SkillOwnedIndex = [skill()];
  const base = Array.from({ length: 24 }, (_, i) => execEv(`ex${i}`, 1000 + i));
  const a = detectSkillBypass(WORKER, idx, bypassDeps({ execEvents: base }));
  const b = detectSkillBypass(WORKER, idx, bypassDeps({ execEvents: [...base].reverse() }));
  assert.deepEqual(a.proposals, b.proposals);
});

// ── WP-4A (Phase 4): path-role classification (spec 260-271) ──────────────────

const roleDeps = (over: Partial<PathRoleDeps> = {}): PathRoleDeps => ({
  classifyPathMutability: () => 'user-owned',
  ...over,
});

check('WP-4A classifyPathRole: build-generated (dist/ tree + .map)', () => {
  assert.equal(classifyPathRole('/w/dist/main/index.js', roleDeps()).role, 'build-generated');
  assert.equal(classifyPathRole('/w/src/foo.js.map', roleDeps()).role, 'build-generated');
});
check('WP-4A classifyPathRole: dependency-or-vendor (node_modules + lockfile + generated-vendor)', () => {
  assert.equal(classifyPathRole('/w/node_modules/x/i.js', roleDeps()).role, 'dependency-or-vendor');
  assert.equal(classifyPathRole('/w/package-lock.json', roleDeps()).role, 'dependency-or-vendor');
  assert.equal(
    classifyPathRole('/w/plugin/x.js', roleDeps({ classifyPathMutability: () => 'generated-vendor' })).role,
    'dependency-or-vendor');
});
check('WP-4A classifyPathRole: skill-owned (under lane skill root + .claude skills tree)', () => {
  const idx: SkillOwnedIndex = [skill({ skillRoot: '/w/.claude/skills/read-comments', lanes: [WORKER] })];
  assert.equal(
    classifyPathRole('/w/.claude/skills/read-comments/read.py', roleDeps({ skillIndex: idx, lane: WORKER })).role,
    'skill-owned');
  assert.equal(classifyPathRole('/w/.dashboard/workers/claude/skills/foo/x.py', roleDeps()).role, 'skill-owned');
});
check('WP-4A classifyPathRole: test-or-fixture (__tests__ tree + *.test.* basename)', () => {
  assert.equal(classifyPathRole('/w/src/__tests__/a.ts', roleDeps()).role, 'test-or-fixture');
  assert.equal(classifyPathRole('/w/src/foo.test.ts', roleDeps()).role, 'test-or-fixture');
});
check('WP-4A classifyPathRole: guidance-or-config (CLAUDE.md + *.md + config exts + dotfile)', () => {
  assert.equal(classifyPathRole('/w/CLAUDE.md', roleDeps()).role, 'guidance-or-config');
  assert.equal(classifyPathRole('/w/docs/workflow.md', roleDeps()).role, 'guidance-or-config');
  assert.equal(classifyPathRole('/w/tsconfig.json', roleDeps()).role, 'guidance-or-config');
  assert.equal(classifyPathRole('/w/.gitignore', roleDeps()).role, 'guidance-or-config');
});
check('WP-4A classifyPathRole: product-source (recognized source ext)', () => {
  assert.equal(classifyPathRole('/w/src/foo.ts', roleDeps()).role, 'product-source');
  assert.equal(classifyPathRole('/w/api/server.py', roleDeps()).role, 'product-source');
});
check('WP-4A classifyPathRole: external only fires when workspaceRoot is known', () => {
  assert.equal(classifyPathRole('/other/proj/x.ts', roleDeps({ workspaceRoot: '/w' })).role, 'external');
  // no workspaceRoot ⇒ external never fires; a .ts falls through to product-source (honest).
  assert.equal(classifyPathRole('/other/proj/x.ts', roleDeps()).role, 'product-source');
});
check('WP-4A classifyPathRole: unknown residual carries an explainable reason', () => {
  const v = classifyPathRole('/w/data/blob.xyz', roleDeps());
  assert.equal(v.role, 'unknown');
  assert.ok(v.reason.length > 0);
});

// ── WP-4A: ONE canonical heat score (spec 273) ────────────────────────────────

check('WP-4A canonicalHeatScore: executes*3 + writes*2 + reads', () => {
  assert.equal(canonicalHeatScore({ reads: 1, writes: 0, executes: 0, distinctStreams: 1 }), 1);
  assert.equal(canonicalHeatScore({ reads: 0, writes: 1, executes: 0, distinctStreams: 1 }), 2);
  assert.equal(canonicalHeatScore({ reads: 0, writes: 0, executes: 1, distinctStreams: 1 }), 3);
  assert.equal(canonicalHeatScore({ reads: 5, writes: 2, executes: 1, distinctStreams: 3 }), 12);
});

check('WP-4A isOperationalNoiseRole: build/vendor/test are noise; others are not', () => {
  assert.equal(isOperationalNoiseRole('build-generated'), true);
  assert.equal(isOperationalNoiseRole('dependency-or-vendor'), true);
  assert.equal(isOperationalNoiseRole('test-or-fixture'), true);
  assert.equal(isOperationalNoiseRole('product-source'), false);
  assert.equal(isOperationalNoiseRole('guidance-or-config'), false);
  assert.equal(isOperationalNoiseRole('skill-owned'), false);
});

// ── WP-4A: classifyFileCoverage stamps role/score/noise/guidance-gap (spec 271-273)

check('WP-4A classifyFileCoverage: stamps role/score, flags operationalNoise + guidance-gap', () => {
  const touches: FileTouch[] = [
    touch({ path: '/w/docs/workflow.md', reads: 3, distinctStreams: 2 }), // uncovered guidance, meets bar
    touch({ path: '/w/dist/bundle.js', reads: 9, distinctStreams: 4 }),   // build-generated noise
    touch({ path: '/w/src/foo.ts', reads: 5, distinctStreams: 1 }),        // product-source, not a gap
  ];
  const r = classifyFileCoverage(WORKER, touches, [], [], [], DEFAULT_DEPS);
  const byPath = (p: string) => r.fileHeat.find((h) => h.pathDisplay === p)!;
  assert.equal(byPath('/w/docs/workflow.md').role, 'guidance-or-config');
  assert.equal(byPath('/w/docs/workflow.md').guidanceGapCandidate, true);
  assert.equal(byPath('/w/docs/workflow.md').operationalNoise, false);
  assert.equal(byPath('/w/dist/bundle.js').role, 'build-generated');
  assert.equal(byPath('/w/dist/bundle.js').operationalNoise, true);
  assert.equal(byPath('/w/dist/bundle.js').guidanceGapCandidate, false);
  assert.equal(byPath('/w/src/foo.ts').role, 'product-source');
  assert.equal(byPath('/w/src/foo.ts').guidanceGapCandidate, false);
  assert.equal(byPath('/w/src/foo.ts').score, 5);                         // canonical score published
  assert.equal(r.operationalNoiseCount, 1);
  assert.equal(r.guidanceGapCandidateCount, 1);
});

check('WP-4A guidance-gap bar: below REPEAT_MIN_STREAMS or REPEAT_MIN does NOT qualify', () => {
  const oneStream: FileTouch[] = [touch({ path: '/w/docs/g.md', reads: 5, distinctStreams: 1 })];
  const fewTouches: FileTouch[] = [touch({ path: '/w/docs/h.md', reads: 2, distinctStreams: 3 })];
  assert.equal(classifyFileCoverage(WORKER, oneStream, [], [], [], DEFAULT_DEPS).guidanceGapCandidateCount, 0);
  assert.equal(classifyFileCoverage(WORKER, fewTouches, [], [], [], DEFAULT_DEPS).guidanceGapCandidateCount, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
