// analytics-snapshot-shim.test — WP1 (G1) shim unit tests.
//   npm run build:main
//   node dist/main/main/analytics-export/analytics-snapshot-shim.test.js
//
// Writes the bundled shim (the exact bytes ensureInstallationLauncher ships)
// into a temp workspace layout and drives it with `node` as a real child
// process: descriptor parsing, arg passthrough, exit-code passthrough (incl.
// 2 and 4), stdout/stderr passthrough, the ENOENT heal message, and the WSL
// branch (via the shim's test-only LARES_SHIM_PLATFORM override).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';

import { ANALYTICS_SNAPSHOT_SHIM_MJS } from '../../shared/constants';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// A child the descriptor points at instead of Electron: echoes its argv to
// stdout, writes a marker to stderr, exits with `--exit-code N` when present.
const HELPER_CJS = `
const args = process.argv.slice(2);
process.stdout.write('ARGS:' + JSON.stringify(args) + '\\n');
process.stderr.write('HELPER-STDERR\\n');
const i = args.indexOf('--exit-code');
process.exit(i === -1 ? 0 : Number(args[i + 1]));
`;

interface Fixture { ws: string; shim: string; helper: string; }

/** Temp workspace with the shim at .lares/scripts/ and a descriptor whose
 *  invocation is `node helper.cjs <prefix…>` — override pieces per test. */
function fixture(descriptor: Record<string, unknown> | null | 'corrupt'): Fixture {
  // Directory name carries a space on purpose — array-args spawn must survive it.
  const ws = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp1 shim-'));
  const scripts = nodePath.join(ws, '.lares', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  const shim = nodePath.join(scripts, 'analytics-snapshot.mjs');
  fs.writeFileSync(shim, ANALYTICS_SNAPSHOT_SHIM_MJS, 'utf-8');
  const helper = nodePath.join(ws, 'helper.cjs');
  fs.writeFileSync(helper, HELPER_CJS, 'utf-8');
  if (descriptor === 'corrupt') {
    fs.writeFileSync(nodePath.join(ws, '.lares', 'installation.json'), '{ not json', 'utf-8');
  } else if (descriptor !== null) {
    fs.writeFileSync(nodePath.join(ws, '.lares', 'installation.json'), JSON.stringify(descriptor, null, 2), 'utf-8');
  }
  return { ws, shim, helper };
}

function sourceDescriptor(f: Fixture, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    descriptorVersion: 1,
    mode: 'source',
    invocation: { command: process.execPath, argsPrefix: [f.helper, 'prefix-arg'] },
    installRoot: f.ws,
    appVersion: '0.0.0-test',
    writtenAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function runShim(f: Fixture, argv: string[], env?: Record<string, string>): {
  status: number | null; stdout: string; stderr: string;
} {
  const r = spawnSync(process.execPath, [f.shim, ...argv], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ── passthrough ───────────────────────────────────────────────────────────────

test('arg passthrough: argsPrefix + argv reach the child in order; stdout/stderr pass through; exit 0', () => {
  const f = fixture(null);
  fs.writeFileSync(nodePath.join(f.ws, '.lares', 'installation.json'), JSON.stringify(sourceDescriptor(f)), 'utf-8');
  const r = runShim(f, ['export', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('ARGS:["prefix-arg","export","--json"]'), `stdout: ${r.stdout}`);
  assert.ok(r.stderr.includes('HELPER-STDERR'), 'child stderr must pass through');
});

test('exit-code passthrough: 2 (partial) and 4 (cold index) preserved verbatim', () => {
  const f = fixture(null);
  fs.writeFileSync(nodePath.join(f.ws, '.lares', 'installation.json'), JSON.stringify(sourceDescriptor(f)), 'utf-8');
  assert.equal(runShim(f, ['--exit-code', '2']).status, 2);
  assert.equal(runShim(f, ['--exit-code', '4']).status, 4);
  assert.equal(runShim(f, ['--exit-code', '7']).status, 7);
});

// ── descriptor failure modes ──────────────────────────────────────────────────

test('missing descriptor → non-zero with the heal hint', () => {
  const f = fixture(null);
  const r = runShim(f, ['export']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('reopen this workspace in Lares to heal .lares/installation.json'), r.stderr);
});

test('corrupt descriptor → non-zero with the heal hint', () => {
  const f = fixture('corrupt');
  const r = runShim(f, ['export']);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('reopen this workspace in Lares to heal .lares/installation.json'), r.stderr);
});

test('ENOENT (installation moved/uninstalled) → the exact documented message', () => {
  const f = fixture(null);
  const gone = nodePath.join(f.ws, 'no-such-dir', 'electron.exe');
  fs.writeFileSync(
    nodePath.join(f.ws, '.lares', 'installation.json'),
    JSON.stringify(sourceDescriptor(f, { invocation: { command: gone, argsPrefix: [] } })),
    'utf-8',
  );
  const r = runShim(f, ['export']);
  assert.equal(r.status, 1);
  assert.ok(
    r.stderr.includes('Lares installation moved or uninstalled — reopen this workspace in Lares to heal .lares/installation.json.'),
    r.stderr,
  );
});

// ── WSL branch ────────────────────────────────────────────────────────────────

test('WSL: wsl.commandWslPath present → it is the spawned command', () => {
  const f = fixture(null);
  // command deliberately bogus — only the wsl path is real (node itself), so a
  // green run proves the branch actually switched commands.
  fs.writeFileSync(
    nodePath.join(f.ws, '.lares', 'installation.json'),
    JSON.stringify(sourceDescriptor(f, {
      invocation: { command: 'C:\\bogus\\never-exists.exe', argsPrefix: [f.helper] },
      wsl: { commandWslPath: process.execPath },
    })),
    'utf-8',
  );
  const r = runShim(f, ['export'], { LARES_SHIM_PLATFORM: 'linux' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('ARGS:["export"]'), r.stdout);
});

test('WSL: no wsl.commandWslPath → documented limitation, non-zero exit', () => {
  const f = fixture(null);
  fs.writeFileSync(nodePath.join(f.ws, '.lares', 'installation.json'), JSON.stringify(sourceDescriptor(f)), 'utf-8');
  const withWsl = JSON.parse(fs.readFileSync(nodePath.join(f.ws, '.lares', 'installation.json'), 'utf-8'));
  delete withWsl.wsl;
  fs.writeFileSync(nodePath.join(f.ws, '.lares', 'installation.json'), JSON.stringify(withWsl), 'utf-8');
  const r = runShim(f, ['export'], { LARES_SHIM_PLATFORM: 'linux' });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('no WSL command path'), r.stderr);
  assert.ok(r.stderr.includes('Windows side of the workspace'), r.stderr);
});

// ── runner ────────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); }
    catch (e) { failed += 1; console.error(`  FAIL  ${t.name}\n`, e); }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
