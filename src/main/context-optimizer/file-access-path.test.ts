// file-access-path.test.ts — WP-1B canonical path identity + verb→mode lexicon.
// node:assert on dist. Run: node dist/main/main/context-optimizer/file-access-path.test.js
//
// These are the regression fixtures the brief calls out (relative-vs-absolute,
// Windows/WSL normalization, case, `..`, duplicate basenames, glob/variable
// non-resolution, read-vs-write verbs) at the PURE layer. The DB-backed matching +
// real-Memory corpus acceptance live in file-access-matching.test.ts.

import assert from 'node:assert';
import { normalizeExecPath } from '../skill-analytics/command-path-extractor';
import {
  canonicalizeAccessPath,
  inferAccessModes,
  workspaceRelativeOf,
  hasUnresolvableMeta,
} from './file-access-path';

let passed = 0;
function check(name: string, fn: () => void): void { fn(); passed++; console.log(`  ok - ${name}`); }

const SUP = 'C:/projA/.dashboard/supervisor';

// ── relative vs absolute ──────────────────────────────────────────────────────
check('relative `./memory/MEMORY.md` resolves against the agent cwd', () => {
  const r = canonicalizeAccessPath('./memory/MEMORY.md', SUP);
  assert.strictEqual(r.canonicalAbs, 'C:\\projA\\.dashboard\\supervisor\\memory\\MEMORY.md');
});

check('bare-relative `memory/MEMORY.md` resolves too', () => {
  const r = canonicalizeAccessPath('memory/MEMORY.md', SUP);
  assert.strictEqual(r.canonicalAbs, 'C:\\projA\\.dashboard\\supervisor\\memory\\MEMORY.md');
});

check('absolute reference resolves with NO cwd', () => {
  const r = canonicalizeAccessPath('C:/projA/src/index.ts', null);
  assert.strictEqual(r.canonicalAbs, 'C:\\projA\\src\\index.ts');
});

check('relative reference with no cwd stays UNRESOLVED (candidate-only)', () => {
  const r = canonicalizeAccessPath('./memory/MEMORY.md', null);
  assert.strictEqual(r.canonicalAbs, undefined);
});

// ── the cross-side agreement invariant (compiler resolve === ingestion resolve) ──
check('compiler-side resolve of `./memory/MEMORY.md` === ingestion-side resolve of the absolute read', () => {
  const compiled = canonicalizeAccessPath('./memory/MEMORY.md', SUP).canonicalAbs;
  const ingested = normalizeExecPath('C:/projA/.dashboard/supervisor/memory/MEMORY.md', SUP).normalizedPath;
  assert.ok(compiled && ingested);
  assert.strictEqual(compiled!.toLowerCase(), ingested!.toLowerCase());
});

// ── Windows / WSL normalization ───────────────────────────────────────────────
check('WSL /mnt/c mount folds to the Windows drive form', () => {
  assert.strictEqual(canonicalizeAccessPath('/mnt/c/projA/x.ts', null).canonicalAbs, 'C:\\projA\\x.ts');
});
check('WSL UNC \\\\wsl$\\<distro>\\mnt\\c folds identically', () => {
  assert.strictEqual(canonicalizeAccessPath('\\\\wsl$\\Ubuntu\\mnt\\c\\projA\\x.ts', null).canonicalAbs, 'C:\\projA\\x.ts');
});
check('a /mnt/c reference and a C:\\ reference collapse to ONE key', () => {
  const a = canonicalizeAccessPath('/mnt/c/projA/x.ts', null).canonicalAbs!;
  const b = canonicalizeAccessPath('C:\\projA\\x.ts', null).canonicalAbs!;
  assert.strictEqual(a.toLowerCase(), b.toLowerCase());
});

// ── case-insensitivity ────────────────────────────────────────────────────────
check('case differences fold under LOWER() (drive + segments)', () => {
  const a = canonicalizeAccessPath('C:/ProjA/SRC/Index.TS', null).canonicalAbs!;
  const b = canonicalizeAccessPath('c:/proja/src/index.ts', null).canonicalAbs!;
  assert.strictEqual(a.toLowerCase(), b.toLowerCase());
});

// ── `..` segments ─────────────────────────────────────────────────────────────
check('`..` segments are collapsed during resolution', () => {
  assert.strictEqual(canonicalizeAccessPath('a/b/../c.ts', 'C:/w').canonicalAbs, 'C:\\w\\a\\c.ts');
});

// ── duplicate basenames in different workspaces stay DISTINCT ──────────────────
check('same basename under different roots → distinct canonical identities', () => {
  const a = canonicalizeAccessPath('MEMORY.md', 'C:/projA/.dashboard/supervisor/memory').canonicalAbs!;
  const b = canonicalizeAccessPath('MEMORY.md', 'C:/projB/.dashboard/supervisor/memory').canonicalAbs!;
  assert.notStrictEqual(a.toLowerCase(), b.toLowerCase());
});

// ── glob / variable tokens never resolve (never suffix-matchable) ─────────────
check('glob token → unresolved (candidate-only)', () => {
  assert.strictEqual(canonicalizeAccessPath('src/**/*.ts', 'C:/w').canonicalAbs, undefined);
  assert.ok(hasUnresolvableMeta('src/**/*.ts'));
});
check('variable/subshell token → unresolved', () => {
  assert.strictEqual(canonicalizeAccessPath('$HOME/x.ts', 'C:/w').canonicalAbs, undefined);
  assert.strictEqual(canonicalizeAccessPath('%APPDATA%/x.ts', 'C:/w').canonicalAbs, undefined);
});
check('leading @ import marker is stripped before resolving', () => {
  assert.strictEqual(canonicalizeAccessPath('@docs/spike.md', 'C:/w').canonicalAbs, 'C:\\w\\docs\\spike.md');
});

// ── workspace-relative identity ───────────────────────────────────────────────
check('workspaceRelativeOf yields a root-anchored fwd-slash form', () => {
  const canon = canonicalizeAccessPath('./memory/MEMORY.md', SUP, 'C:/projA').workspaceRelative;
  assert.strictEqual(canon, '.dashboard/supervisor/memory/MEMORY.md');
});
check('workspaceRelativeOf is undefined when the path is OUTSIDE the root', () => {
  assert.strictEqual(workspaceRelativeOf('C:\\projB\\x.ts', 'C:/projA'), undefined);
});
check('workspaceRelativeOf is undefined when no root is known', () => {
  assert.strictEqual(canonicalizeAccessPath('./x.ts', SUP).workspaceRelative, undefined);
});

// ── verb → access-mode lexicon (read vs write; downgrade on ambiguity) ────────
check('read verbs → [read]', () => {
  for (const t of ['read the file', 'Check `x` at session start', 'open and inspect it', 'review the doc', 'consult the index']) {
    assert.deepStrictEqual(inferAccessModes(t), ['read'], t);
  }
});
check('write verbs → [write]', () => {
  for (const t of ['save it there', 'update the config', 'write the migration', 'append to the log', 'overwrite the file']) {
    assert.deepStrictEqual(inferAccessModes(t), ['write'], t);
  }
});
check('BOTH senses → [] (ambiguous → any touch, candidate-only)', () => {
  assert.deepStrictEqual(inferAccessModes('Check ./memory/MEMORY.md at session start. Save observations there.'), []);
});
check('NEITHER sense → [] (no verb → ambiguous)', () => {
  assert.deepStrictEqual(inferAccessModes('the `.claude/settings.json` file'), []);
});

console.log(`\nfile-access-path.test.ts: ${passed} passed`);
