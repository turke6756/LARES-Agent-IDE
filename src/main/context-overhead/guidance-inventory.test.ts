// WP7 (G7) — guidance-inventory unit tests: the declared scan contract.
// Fixture tree covers nesting, symlink skip, EACH budget exhaustion (correct
// stopped-reason + remainderCountKnown:false), non-git behavior, ordering
// determinism — and the honesty acceptance: an incomplete scan says so and
// never fabricates a remainder count; no nested file silently gains liveness.
//   npm run build:main
//   node dist/main/main/context-overhead/guidance-inventory.test.js

import assert from 'node:assert/strict';
import {
  GUIDANCE_SCAN_CONTRACT,
  extractHeadings,
  scanGuidanceInventory,
  type GuidanceDirent,
  type GuidanceInventoryDeps,
  type GuidanceScanContractV1,
  type GuidanceScanFs,
} from './guidance-inventory';
import { AGENTS_MD_DOCUMENTED_PROVIDERS } from './guidance-sources';
import { makePathOps } from './paths';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const ops = makePathOps('wsl');
const ROOT = '/ws';

// ── in-memory fixture fs ──────────────────────────────────────────────────────

interface Fixture {
  /** dir → dirents (files listed here must appear in `files` unless failing). */
  dirs: Record<string, GuidanceDirent[]>;
  files: Record<string, string>;
  /** paths whose listDir/readFile throw with this code. */
  failListDir?: Record<string, string>;
  failRead?: Record<string, string>;
  /** reverse the raw listing order (determinism test). */
  reverseListings?: boolean;
}

function coded(code: string): Error {
  const e = new Error(code) as Error & { code: string };
  e.code = code;
  return e;
}

function makeFs(fx: Fixture): GuidanceScanFs {
  return {
    listDir(p) {
      const fail = fx.failListDir?.[p];
      if (fail) throw coded(fail);
      const list = fx.dirs[p];
      if (!list) throw coded('ENOENT');
      return fx.reverseListings ? [...list].reverse() : [...list];
    },
    fileSize(p) {
      const c = fx.files[p];
      if (c === undefined) throw coded('ENOENT');
      return Buffer.byteLength(c, 'utf8');
    },
    readFile(p) {
      const fail = fx.failRead?.[p];
      if (fail) throw coded(fail);
      const c = fx.files[p];
      if (c === undefined) throw coded('ENOENT');
      return c;
    },
  };
}

function makeDeps(fx: Fixture, overrides: Partial<GuidanceInventoryDeps> = {}): GuidanceInventoryDeps {
  return {
    fs: makeFs(fx),
    pathOps: ops,
    estimator: { estimate: (t) => ({ tokens: t.length }) },
    gitIgnore: { applied: false, isIgnored: () => false },
    capturedLaunchCwds: [],
    ...overrides,
  };
}

const f = (name: string): GuidanceDirent => ({ name, kind: 'file' });
const d = (name: string): GuidanceDirent => ({ name, kind: 'dir' });
const sym = (name: string): GuidanceDirent => ({ name, kind: 'symlink' });

/** The main nesting fixture: guidance at root, on-chain, below-cwd, off-chain. */
function nestingFixture(): Fixture {
  return {
    dirs: {
      '/ws': [f('CLAUDE.md'), f('AGENTS.md'), f('readme.md'), d('packages'), d('other'), d('node_modules')],
      '/ws/packages': [f('AGENTS.md'), d('app')],
      '/ws/packages/app': [f('CLAUDE.md'), d('deep')],
      '/ws/packages/app/deep': [f('AGENTS.md'), f('CLAUDE.local.md')],
      '/ws/other': [f('AGENTS.md')],
      '/ws/node_modules': [f('CLAUDE.md')],
    },
    files: {
      '/ws/CLAUDE.md': '# Root\n\n## Build\n\nstuff',
      '/ws/AGENTS.md': '# Agents root',
      '/ws/readme.md': 'not guidance',
      '/ws/packages/AGENTS.md': '# Mid',
      '/ws/packages/app/CLAUDE.md': '# App',
      '/ws/packages/app/deep/AGENTS.md': '# Below cwd',
      '/ws/packages/app/deep/CLAUDE.local.md': 'local',
      '/ws/other/AGENTS.md': '# Off chain',
      '/ws/node_modules/CLAUDE.md': '# vendored — must never be seen',
    },
  };
}

// ── the contract constants are the plan's, verbatim ──────────────────────────

test('contract: the exported constants match the declared WP7 contract', () => {
  assert.equal(GUIDANCE_SCAN_CONTRACT.maxDepth, 8);
  assert.equal(GUIDANCE_SCAN_CONTRACT.maxDirs, 5_000);
  assert.equal(GUIDANCE_SCAN_CONTRACT.maxFiles, 200_000);
  assert.equal(GUIDANCE_SCAN_CONTRACT.maxFileBytes, 2 * 1024 * 1024);
  assert.equal(GUIDANCE_SCAN_CONTRACT.followSymlinks, false);
  assert.deepEqual([...GUIDANCE_SCAN_CONTRACT.ignoredDirNames],
    ['.git', 'node_modules', '.lares', '.dashboard']);
  assert.equal(GUIDANCE_SCAN_CONTRACT.ordering, 'path-lexicographic');
});

// ── nesting + applicability + liveness ───────────────────────────────────────

test('nesting: every guidance file listed, path-lexicographic, contract echoed', () => {
  const inv = scanGuidanceInventory(ROOT, makeDeps(nestingFixture(), {
    capturedLaunchCwds: ['/ws/packages/app'],
  }));
  assert.deepEqual(inv.entries.map((e) => e.path), [
    '/ws/AGENTS.md',
    '/ws/CLAUDE.md',
    '/ws/other/AGENTS.md',
    '/ws/packages/AGENTS.md',
    '/ws/packages/app/CLAUDE.md',
    '/ws/packages/app/deep/AGENTS.md',
    '/ws/packages/app/deep/CLAUDE.local.md',
  ]);
  assert.equal(inv.scan.scanComplete, true);
  assert.equal(inv.scan.scanStoppedReason, null);
  assert.equal(inv.scan.remainderCountKnown, true);
  assert.deepEqual(inv.scan.contract, GUIDANCE_SCAN_CONTRACT, 'metadata echoes the contract applied');
  // node_modules pruned (its CLAUDE.md never seen), counted as a known omission.
  assert.equal(inv.scan.skippedIgnoredDirs, 1);
  // readme.md was seen but is not guidance; the node_modules CLAUDE.md was not.
  assert.ok(inv.entries.every((e) => e.path !== '/ws/node_modules/CLAUDE.md'));
});

test('applicability: WP2 per-directory chain semantics; below-cwd/off-chain stay inventory-only', () => {
  const inv = scanGuidanceInventory(ROOT, makeDeps(nestingFixture(), {
    capturedLaunchCwds: ['/ws/packages/app'],
  }));
  const by = (p: string) => inv.entries.find((e) => e.path === p)!;
  // AGENTS.md on the root→cwd chain → directory-chain, with chainParent links.
  assert.equal(by('/ws/AGENTS.md').applicability.model, 'directory-chain');
  assert.equal(by('/ws/AGENTS.md').applicability.chainParent, undefined);
  assert.equal(by('/ws/packages/AGENTS.md').applicability.model, 'directory-chain');
  assert.equal(by('/ws/packages/AGENTS.md').applicability.chainParent, '/ws/AGENTS.md');
  // Below-cwd and off-chain AGENTS.md → inventory-only, never chain-linked.
  assert.equal(by('/ws/packages/app/deep/AGENTS.md').applicability.model, 'inventory-only');
  assert.equal(by('/ws/packages/app/deep/AGENTS.md').applicability.chainParent, undefined);
  assert.equal(by('/ws/other/AGENTS.md').applicability.model, 'inventory-only');
  // CLAUDE-family on the walk-up chain of the captured cwd → walk-up-chain.
  assert.equal(by('/ws/CLAUDE.md').applicability.model, 'walk-up-chain');
  assert.equal(by('/ws/packages/app/CLAUDE.md').applicability.model, 'walk-up-chain');
  // Below-cwd CLAUDE.local.md is NOT on any captured chain.
  assert.equal(by('/ws/packages/app/deep/CLAUDE.local.md').applicability.model, 'inventory-only');
  // Audiences reuse WP2's model.
  assert.deepEqual(by('/ws/CLAUDE.md').audienceProviders, ['claude']);
  assert.deepEqual(by('/ws/AGENTS.md').audienceProviders, [...AGENTS_MD_DOCUMENTED_PROVIDERS]);
});

test('liveness: EVERY entry is not-analyzed — chain applicability never lifts it here', () => {
  const inv = scanGuidanceInventory(ROOT, makeDeps(nestingFixture(), {
    capturedLaunchCwds: ['/ws/packages/app'],
  }));
  assert.ok(inv.entries.length > 0);
  for (const e of inv.entries) assert.equal(e.liveness, 'not-analyzed');
});

test('entries: tokens and headings populated', () => {
  const inv = scanGuidanceInventory(ROOT, makeDeps(nestingFixture()));
  const root = inv.entries.find((e) => e.path === '/ws/CLAUDE.md')!;
  assert.equal(root.tokens, '# Root\n\n## Build\n\nstuff'.length);
  assert.deepEqual(root.headings, ['Root', 'Build']);
});

test('headings: fenced code blocks are not headings', () => {
  assert.deepEqual(
    extractHeadings('# A\n```\n# not a heading\n```\n## B\n~~~\n# also not\n~~~\n'),
    ['A', 'B']);
});

// ── symlinks ─────────────────────────────────────────────────────────────────

test('symlinks: never followed, counted; scan stays complete', () => {
  const fx: Fixture = {
    dirs: {
      '/ws': [f('CLAUDE.md'), sym('linkdir'), sym('CLAUDE.link.md')],
      // linkdir's target is deliberately listable — a followed link would find it.
      '/ws/linkdir': [f('AGENTS.md')],
    },
    files: { '/ws/CLAUDE.md': 'x', '/ws/linkdir/AGENTS.md': 'never seen' },
  };
  const inv = scanGuidanceInventory(ROOT, makeDeps(fx));
  assert.equal(inv.scan.skippedSymlinks, 2);
  assert.deepEqual(inv.entries.map((e) => e.path), ['/ws/CLAUDE.md']);
  assert.equal(inv.scan.scanComplete, true);
  assert.equal(inv.scan.remainderCountKnown, true);
});

// ── each budget exhaustion ───────────────────────────────────────────────────

function contractWith(over: Partial<GuidanceScanContractV1>): GuidanceScanContractV1 {
  return { ...GUIDANCE_SCAN_CONTRACT, ...over };
}

test('maxDepth: too-deep subtrees are unvisited → stopped-reason, remainder UNKNOWN', () => {
  const fx: Fixture = {
    dirs: {
      '/ws': [f('CLAUDE.md'), d('a')],
      '/ws/a': [f('AGENTS.md'), d('b')],
      '/ws/a/b': [d('c')],
      '/ws/a/b/c': [f('CLAUDE.md')],
    },
    files: { '/ws/CLAUDE.md': 'x', '/ws/a/AGENTS.md': 'y', '/ws/a/b/c/CLAUDE.md': 'unvisited' },
  };
  const inv = scanGuidanceInventory(ROOT, makeDeps(fx), contractWith({ maxDepth: 2 }));
  // Depth 1 (/ws/a) and 2 (/ws/a/b) visited; depth 3 pruned.
  assert.deepEqual(inv.entries.map((e) => e.path), ['/ws/CLAUDE.md', '/ws/a/AGENTS.md']);
  assert.equal(inv.scan.scanComplete, false);
  assert.equal(inv.scan.scanStoppedReason, 'max-depth');
  assert.equal(inv.scan.remainderCountKnown, false);
  // Honesty acceptance: NO fabricated count for the unvisited subtree.
  assert.ok(!('omittedCount' in inv.scan));
  assert.ok(!('remainderCount' in inv.scan));
  assert.equal(inv.scan.contract.maxDepth, 2, 'metadata echoes the contract actually applied');
});

test('maxDirs: traversal halts → stopped-reason, remainder UNKNOWN', () => {
  const fx: Fixture = {
    dirs: {
      '/ws': [d('a'), d('b'), d('z')],
      '/ws/a': [f('CLAUDE.md')],
      '/ws/b': [f('AGENTS.md')],
      '/ws/z': [f('CLAUDE.md')],
    },
    files: { '/ws/a/CLAUDE.md': 'x', '/ws/b/AGENTS.md': 'y', '/ws/z/CLAUDE.md': 'unvisited' },
  };
  // Budget of 3: root, /ws/a, /ws/b — /ws/z would be the 4th.
  const inv = scanGuidanceInventory(ROOT, makeDeps(fx), contractWith({ maxDirs: 3 }));
  assert.deepEqual(inv.entries.map((e) => e.path), ['/ws/a/CLAUDE.md', '/ws/b/AGENTS.md']);
  assert.equal(inv.scan.dirsVisited, 3);
  assert.equal(inv.scan.scanComplete, false);
  assert.equal(inv.scan.scanStoppedReason, 'max-dirs');
  assert.equal(inv.scan.remainderCountKnown, false);
});

test('maxFiles: traversal halts → stopped-reason, remainder UNKNOWN', () => {
  const fx: Fixture = {
    dirs: { '/ws': [f('AGENTS.md'), f('CLAUDE.md'), f('a.txt'), f('zz.md')] },
    files: { '/ws/AGENTS.md': 'x', '/ws/CLAUDE.md': 'y', '/ws/a.txt': 'z', '/ws/zz.md': 'w' },
  };
  const inv = scanGuidanceInventory(ROOT, makeDeps(fx), contractWith({ maxFiles: 3 }));
  // Lexicographic: AGENTS.md, CLAUDE.md, a.txt seen; zz.md over budget.
  assert.deepEqual(inv.entries.map((e) => e.path), ['/ws/AGENTS.md', '/ws/CLAUDE.md']);
  assert.equal(inv.scan.filesSeen, 3);
  assert.equal(inv.scan.scanComplete, false);
  assert.equal(inv.scan.scanStoppedReason, 'max-files');
  assert.equal(inv.scan.remainderCountKnown, false);
});

test('maxBytes: an oversized file is a KNOWN omission — counted, scan stays complete', () => {
  const fx: Fixture = {
    dirs: { '/ws': [f('AGENTS.md'), f('CLAUDE.md')] },
    files: { '/ws/AGENTS.md': 'tiny', '/ws/CLAUDE.md': 'this one is far too large' },
  };
  const inv = scanGuidanceInventory(ROOT, makeDeps(fx), contractWith({ maxFileBytes: 10 }));
  assert.deepEqual(inv.entries.map((e) => e.path), ['/ws/AGENTS.md']);
  assert.equal(inv.scan.skippedOversized, 1);
  // Per-file budget ≠ traversal budget: the file WAS seen, so the scan is
  // complete and the remainder is known (zero).
  assert.equal(inv.scan.scanComplete, true);
  assert.equal(inv.scan.scanStoppedReason, null);
  assert.equal(inv.scan.remainderCountKnown, true);
});

// ── git / non-git ────────────────────────────────────────────────────────────

test('non-git workspace: gitIgnoreApplied disclosed false, nothing git-skipped', () => {
  const inv = scanGuidanceInventory(ROOT, makeDeps(nestingFixture()));
  assert.equal(inv.scan.gitIgnoreApplied, false);
  assert.equal(inv.scan.skippedGitIgnored, 0);
});

test('git workspace: ignored dirs pruned + ignored guidance files skipped, both counted', () => {
  const fx = nestingFixture();
  const inv = scanGuidanceInventory(ROOT, makeDeps(fx, {
    gitIgnore: {
      applied: true,
      isIgnored: (rel, isDir) => (isDir && rel === 'other') || rel === 'packages/AGENTS.md',
    },
  }));
  assert.equal(inv.scan.gitIgnoreApplied, true);
  assert.equal(inv.scan.skippedGitIgnored, 2);
  assert.ok(!inv.entries.some((e) => e.path.startsWith('/ws/other/')));
  assert.ok(!inv.entries.some((e) => e.path === '/ws/packages/AGENTS.md'));
  assert.equal(inv.scan.scanComplete, true, 'git-ignored omissions are KNOWN, not a stop');
});

// ── read/permission failures ─────────────────────────────────────────────────

test('read failures: counted per reason code; traversal continues', () => {
  const fx = nestingFixture();
  fx.failListDir = { '/ws/other': 'EACCES' };
  fx.failRead = { '/ws/packages/AGENTS.md': 'EPERM' };
  const inv = scanGuidanceInventory(ROOT, makeDeps(fx));
  assert.deepEqual(inv.scan.readFailuresByReason, { EACCES: 1, EPERM: 1 });
  assert.ok(!inv.entries.some((e) => e.path === '/ws/packages/AGENTS.md'));
  assert.ok(inv.entries.some((e) => e.path === '/ws/packages/app/CLAUDE.md'),
    'a failed sibling read never aborts the rest of the scan');
});

// ── ordering determinism ─────────────────────────────────────────────────────

test('determinism: reversed raw directory listings produce the identical inventory', () => {
  const a = scanGuidanceInventory(ROOT, makeDeps(nestingFixture(), {
    capturedLaunchCwds: ['/ws/packages/app'],
  }));
  const b = scanGuidanceInventory(ROOT, makeDeps({ ...nestingFixture(), reverseListings: true }, {
    capturedLaunchCwds: ['/ws/packages/app'],
  }));
  assert.deepEqual(a.entries, b.entries);
  assert.deepEqual(a.scan, b.scan);
});

test('determinism: budget cut-off is reproducible under reversed listings', () => {
  const fx: Fixture = {
    dirs: { '/ws': [f('AGENTS.md'), f('CLAUDE.md'), f('zz.md')] },
    files: { '/ws/AGENTS.md': 'x', '/ws/CLAUDE.md': 'y', '/ws/zz.md': 'z' },
  };
  const c = contractWith({ maxFiles: 2 });
  const a = scanGuidanceInventory(ROOT, makeDeps(fx), c);
  const b = scanGuidanceInventory(ROOT, makeDeps({ ...fx, reverseListings: true }), c);
  assert.deepEqual(a.entries, b.entries);
  assert.deepEqual(a.scan, b.scan);
  assert.deepEqual(a.entries.map((e) => e.path), ['/ws/AGENTS.md', '/ws/CLAUDE.md']);
});

// ── containment ──────────────────────────────────────────────────────────────

test('containment: a hostile dirent name cannot escape the root', () => {
  const fx: Fixture = {
    dirs: { '/ws': [f('CLAUDE.md'), f('../outside/CLAUDE.md'), d('..')] },
    files: { '/ws/CLAUDE.md': 'x', '/outside/CLAUDE.md': 'evil' },
  };
  const inv = scanGuidanceInventory(ROOT, makeDeps(fx));
  assert.deepEqual(inv.entries.map((e) => e.path), ['/ws/CLAUDE.md']);
});

// ── runner ───────────────────────────────────────────────────────────────────

let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ok - ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL - ${t.name}`);
    console.error(err);
  }
}
if (failed > 0) {
  console.error(`\n${failed}/${tests.length} guidance-inventory tests failed`);
  process.exit(1);
}
console.log(`\nguidance-inventory: ${tests.length} tests passed`);
