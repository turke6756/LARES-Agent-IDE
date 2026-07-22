#!/usr/bin/env node
// analytics-packaged-smoke.mjs — WP1 (G1) packaged smoke test.
//
// RELEASE-REQUIRED, NOT part of the default unit run (scripts/run-main-tests.mjs
// deliberately omits it): run it in the packaging pipeline — or manually — after
// building the NSIS/portable exe:
//
//   node scripts/analytics-packaged-smoke.mjs <packaged-exe> --workspace <fixture-workspace>
//     [--allow-cold]           pass --allow-cold through to the CLI
//     [--appdata <dir>]        APPDATA override for a fixture dashboard.db
//
// Drives the packaged binary's `--analytics-snapshot` argv branch (the compiled
// in-binary CLI — no node_modules/.bin/electron, no scripts under
// resourcesPath, asar-safe) and asserts:
//   • exit code is 0 (complete) / 2 (partial) / 4 (cold index) — anything else fails
//   • on 0/2 the --json manifest parses and carries a snapshotId
//   • on 4 the output names the cold-index refusal
//
// The fixture workspace must be registered in the dashboard.db the exe will
// read (the real one, or a fixture DB via --appdata).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function fail(msg) {
  console.error(`analytics-packaged-smoke: FAIL — ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const exe = argv[0];
if (!exe || exe.startsWith('--')) fail('usage: node scripts/analytics-packaged-smoke.mjs <packaged-exe> --workspace <path> [--allow-cold] [--appdata <dir>]');
if (!existsSync(exe)) fail(`packaged exe not found: ${exe}`);

const wsAt = argv.indexOf('--workspace');
if (wsAt === -1 || !argv[wsAt + 1]) fail('--workspace <fixture-workspace> is required');
const workspace = argv[wsAt + 1];
const allowCold = argv.includes('--allow-cold');
const appdataAt = argv.indexOf('--appdata');
const env = { ...process.env };
if (appdataAt !== -1 && argv[appdataAt + 1]) env.APPDATA = argv[appdataAt + 1];

const cliArgs = ['--analytics-snapshot', 'export', '--json', '--workspace', workspace];
if (allowCold) cliArgs.push('--allow-cold');

console.log(`analytics-packaged-smoke: ${exe} ${cliArgs.join(' ')}`);
const r = spawnSync(exe, cliArgs, { encoding: 'utf-8', timeout: 300_000, env });

if (r.error) fail(`spawn failed: ${r.error.message}`);
const stdout = r.stdout ?? '';
const stderr = r.stderr ?? '';

if (![0, 2, 4].includes(r.status)) {
  fail(`exit ${r.status} (expected 0/2/4)\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

if (r.status === 0 || r.status === 2) {
  let manifest;
  try {
    manifest = JSON.parse(stdout.trim().split('\n').pop());
  } catch (e) {
    fail(`--json manifest did not parse (${e.message})\nstdout:\n${stdout}`);
  }
  if (typeof manifest.snapshotId !== 'string' || !manifest.snapshotId) {
    fail(`manifest missing snapshotId:\n${stdout}`);
  }
  console.log(`analytics-packaged-smoke: OK — exit ${r.status}, snapshot ${manifest.snapshotId} at ${manifest.directory}`);
  if (r.status === 2) console.log('analytics-packaged-smoke: note — partial snapshot (manifest lists declines)');
} else {
  if (!/cold|index/i.test(stdout + stderr)) {
    fail(`exit 4 without a cold-index message\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  console.log('analytics-packaged-smoke: OK — exit 4 (cold index refusal, message present)');
}
