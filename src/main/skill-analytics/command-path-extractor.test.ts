// command-path-extractor unit tests (A1, hardening-wp2b-capture.md §4.5 + §7 tests 17-21).
// Pure — system-Node runner:
//   npm run build:main
//   node dist/main/main/skill-analytics/command-path-extractor.test.js

import assert from 'node:assert/strict';
import { extractExecutedPaths, normalizeExecPath, type Shell } from './command-path-extractor';

const CWD = 'C:\\proj';   // Windows cwd used across relative-resolution cases

interface Case {
  name: string;
  cmd: string;
  shell: Shell;
  cwd?: string | null;
  // expected normalized paths (order-independent); use null entries for unresolved
  expectPaths: (string | null)[];
  expectFamily?: string | null;
}

const cases: Case[] = [
  // ── §4.5 worked cases ──
  { name: 'python /mnt/c → drive fold', cmd: 'python /mnt/c/proj/read-comments.py doc.md', shell: 'bash', expectPaths: ['C:\\proj\\read-comments.py'] },
  { name: 'node --loader skips value, resolves rel', cmd: 'node --loader ts-node/esm scripts/a.ts', shell: 'bash', cwd: CWD, expectPaths: ['C:\\proj\\scripts\\a.ts'] },
  { name: 'node then pipe → one script', cmd: 'node scripts/foo.js | tee out.log', shell: 'bash', cwd: CWD, expectPaths: ['C:\\proj\\scripts\\foo.js'] },
  { name: 'two-script chain', cmd: 'python a.py && node b.js', shell: 'bash', cwd: CWD, expectPaths: ['C:\\proj\\a.py', 'C:\\proj\\b.js'] },
  { name: 'bash -lc recurse', cmd: 'bash -lc "python scripts/a.py"', shell: 'bash', cwd: CWD, expectPaths: ['C:\\proj\\scripts\\a.py'] },
  { name: 'npx unwrap', cmd: 'npx tsx scripts/a.ts', shell: 'bash', cwd: CWD, expectPaths: ['C:\\proj\\scripts\\a.ts'] },
  { name: 'npm exec unwrap', cmd: 'npm exec -- tsx scripts/a.ts', shell: 'bash', cwd: CWD, expectPaths: ['C:\\proj\\scripts\\a.ts'] },
  { name: 'pwsh -File', cmd: 'pwsh -File .\\a.ps1 -Force', shell: 'powershell', cwd: CWD, expectPaths: ['C:\\proj\\a.ps1'] },
  { name: 'PS call operator', cmd: "& '.\\build.ps1'", shell: 'powershell', cwd: CWD, expectPaths: ['C:\\proj\\build.ps1'] },
  { name: 'npm run → family only', cmd: 'npm run build', shell: 'bash', cwd: CWD, expectPaths: [], expectFamily: 'npm-run:build' },
  { name: 'python -m give up', cmd: 'python -m pytest', shell: 'bash', cwd: CWD, expectPaths: [] },
  { name: 'python -c give up', cmd: 'python -c "import os"', shell: 'bash', cwd: CWD, expectPaths: [] },
  { name: 'stdin give up', cmd: 'cat a.py | python -', shell: 'bash', cwd: CWD, expectPaths: [] },
  { name: 'variable give up → unresolved', cmd: 'bash $SCRIPT', shell: 'bash', cwd: CWD, expectPaths: [null] },

  // ── §7 test 19 — relative with/without cwd ──
  { name: 'rel with cwd → absolute', cmd: 'bash ./scripts/x.sh', shell: 'bash', cwd: CWD, expectPaths: ['C:\\proj\\scripts\\x.sh'] },
  { name: 'rel with null cwd → unresolved', cmd: 'bash ./scripts/x.sh', shell: 'bash', cwd: null, expectPaths: [null] },

  // ── §7 test 20 — genuine POSIX kept ──
  { name: 'genuine POSIX kept', cmd: 'python /home/u/x.py', shell: 'bash', expectPaths: ['/home/u/x.py'] },

  // extra: direct script path, no interpreter
  { name: 'direct ./ script', cmd: './scripts/run.sh --flag', shell: 'bash', cwd: CWD, expectPaths: ['C:\\proj\\scripts\\run.sh'] },
];

let passed = 0; let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (err) { console.error(`  FAIL ${name}`); console.error('       ', err instanceof Error ? err.message : err); failed++; }
}

for (const c of cases) {
  check(c.name, () => {
    const res = extractExecutedPaths(c.cmd, c.shell, c.cwd === undefined ? undefined : c.cwd);
    const gotNorm = res.paths.map((p) => p.normalizedPath).sort((a, b) => String(a).localeCompare(String(b)));
    const wantNorm = [...c.expectPaths].sort((a, b) => String(a).localeCompare(String(b)));
    assert.deepEqual(gotNorm, wantNorm, `paths: got ${JSON.stringify(gotNorm)} want ${JSON.stringify(wantNorm)}`);
    if (c.expectFamily !== undefined) assert.equal(res.commandFamily, c.expectFamily, `family: got ${res.commandFamily}`);
    // give-up unresolved must carry confidence 'unresolved'
    for (const p of res.paths) if (p.normalizedPath === null) assert.equal(p.confidence, 'unresolved');
  });
}

// ── §7 test 18 — three roots fold to ONE LOWER(arg_path) key ──
check('test18: /mnt/c, wsl.localhost UNC, C:\\ fold to one key', () => {
  const a = normalizeExecPath('/mnt/c/Users/x/p.py', null).normalizedPath;
  const b = normalizeExecPath('\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\x\\p.py', null).normalizedPath;
  const d = normalizeExecPath('C:\\Users\\x\\p.py', null).normalizedPath;
  assert.ok(a && b && d, `all resolve: ${a} ${b} ${d}`);
  const keys = new Set([a!.toLowerCase(), b!.toLowerCase(), d!.toLowerCase()]);
  assert.equal(keys.size, 1, `one key, got ${[...keys].join(' | ')}`);
});

// ── §7 test 21 — raw preserves casing; arg_path folded ──
check('test21: raw preserves casing, normalized folds', () => {
  const ep = normalizeExecPath('/mnt/c/Proj/ReadMe.PY'.replace('ReadMe.PY', 'Read.py'), null);
  assert.equal(ep.rawPath, '/mnt/c/Proj/Read.py');
  assert.equal(ep.normalizedPath, 'C:\\Proj\\Read.py');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
