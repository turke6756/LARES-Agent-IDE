// §1.5 Git-Bash POSIX-shim gate (bundled-node-exposure plan §1.5 / §1.6).
//
// The extensionless `node` shim in ensureNodeShimDir is plausible but quoting a
// Windows exe path inside /bin/sh — and reconstructing it through an MSYS exec —
// is subtle. This test PROVES the contract: with the shim dir first on PATH,
// Git-Bash's bare `node` resolves the shim, which re-execs the (space+apostrophe)
// exe path with args and -e/-p flags preserved.
//
// It SKIPS cleanly (exit 0) when Git-Bash is absent or off-Windows — those are
// not failures. It only FAILS when Git-Bash is present and the shim misbehaves.
// Per §1.5: if this gate cannot be made green, delete the `sh` block from
// ensureNodeShimDir and scope the Windows contract to node.cmd only.
//
// Under the plain-node test runner process.execPath is a real node.exe, so the
// shim (`ELECTRON_RUN_AS_NODE=1 exec "<exe>" "$@"`) genuinely runs node here —
// node ignores the flag. That is what makes the quoting contract testable
// without the packaged Electron build.
//
// Compile + run:
//   npm run build:main
//   node dist/main/main/node-shim.git-bash.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureNodeShimDir, getNodeShimDir } from './node-shim';

function findGitBash(): string | null {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const out = execFileSync(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'),
      ['bash'],
      { encoding: 'utf-8' },
    );
    const line = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    // A WSL `bash.exe` is NOT Git-Bash; the shim contract is MSYS-only. The
    // System32 wsl launcher lives in System32 — filter it out.
    if (line && fs.existsSync(line) && !/\\System32\\bash\.exe$/i.test(line)) return line;
  } catch { /* no bash on PATH */ }
  return null;
}

function skip(reason: string): never {
  console.log(`  SKIP  node-shim git-bash gate — ${reason}`);
  console.log('\nnode-shim.git-bash: skipped (not a failure)');
  process.exit(0);
}

if (process.platform !== 'win32') skip('not Windows');
const bash = findGitBash();
if (!bash) skip('Git-Bash not found on this machine');

// Build an "install" exe path that contains BOTH a space and an apostrophe —
// the two characters most likely to break /bin/sh quoting.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-gitbash-'));
const weirdDir = path.join(root, "it's a dir");
fs.mkdirSync(weirdDir, { recursive: true });
const weirdExe = path.join(weirdDir, 'node.exe');
fs.copyFileSync(process.execPath, weirdExe);

const savedCwd = process.cwd();
let failed = 0;
// `node -p` colorizes its result and Git-Bash advertises color support even
// through a pipe, so strip ANSI SGR codes before comparing values. Built from
// charCode 27 to keep a raw ESC byte out of the source file. This is orthogonal
// to the shim's quoting/flag-preservation contract this gate proves.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
function check(name: string, actual: string, expected: string): void {
  actual = actual.replace(ANSI, '');
  if (actual === expected) {
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}

try {
  process.chdir(root);
  ensureNodeShimDir(weirdExe);
  const shimDir = getNodeShimDir();

  // The shim dir goes FIRST here so Git-Bash resolves our extensionless `node`
  // rather than any real node.exe already on PATH — that is the code path §1.5
  // is validating.
  const runBash = (script: string): string =>
    execFileSync(bash!, ['-c', script], {
      encoding: 'utf-8',
      // NODE_DISABLE_COLORS keeps `node -p` from ANSI-colorizing its result,
      // so the assertions check the VALUE, not node's TTY-coloring (orthogonal
      // to the quoting/flag-preservation contract this gate proves).
      env: { ...process.env, WINSHIM: shimDir, NODE_DISABLE_COLORS: '1', NO_COLOR: '1' },
    }).trim();

  const preamble = 'SHIMDIR="$(cygpath -u "$WINSHIM")"; export PATH="$SHIMDIR:$PATH";';

  // (a) args with a space and an apostrophe survive the sh `exec "$@"`.
  check(
    'args with spaces + apostrophe preserved through the shim',
    runBash(`${preamble} node -p "process.argv.slice(1).join('|')" "sp ace" "ap'os"`),
    'sp ace|ap\'os',
  );

  // (b) -e is preserved (not swallowed / reordered by the shim).
  check(
    '-e flag preserved',
    runBash(`${preamble} node -e "process.stdout.write(String(6*7))"`),
    '42',
  );

  // (c) -p is preserved.
  check(
    '-p flag preserved',
    runBash(`${preamble} node -p "40 + 2"`),
    '42',
  );

  // (d) the exe path (spaces + apostrophe) really resolved through the shim,
  // not a stray system node: process.execPath must be our weird copy.
  check(
    'bare node resolves the shim, which re-execs the space+apostrophe exe path',
    runBash(`${preamble} node -p "process.execPath"`),
    weirdExe,
  );
} catch (err) {
  failed++;
  console.error('  FAIL node-shim git-bash gate threw:', err instanceof Error ? err.message : err);
} finally {
  process.chdir(savedCwd);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\nnode-shim.git-bash: ${failed === 0 ? 'PASS' : 'FAIL (' + failed + ')'}`);
process.exit(failed === 0 ? 0 : 1);
