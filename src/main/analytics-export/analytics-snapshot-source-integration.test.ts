// analytics-snapshot-source-integration.test — WP1 (G1) source-mode
// integration: temp workspace → shim → real Electron CLI → snapshot or exit 4.
//
//   npm run build:main
//   LARES_WP1_INTEGRATION=1 node dist/main/main/analytics-export/analytics-snapshot-source-integration.test.js
//
// GATED behind LARES_WP1_INTEGRATION=1 (skips green otherwise): it spawns the
// real Electron binary twice (a run-as-node DB bootstrap, then the CLI via the
// shim). It never touches the user's real dashboard.db — APPDATA is pointed at
// a temp dir for every child, and the registered workspace is a temp folder.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';

import { ANALYTICS_SNAPSHOT_SHIM_MJS } from '../../shared/constants';
import { computeInstallationDescriptor } from '../installation-descriptor';

const GATE = process.env.LARES_WP1_INTEGRATION === '1';

// Under plain node, require('electron') resolves to the binary's path string.
function electronExe(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('electron');
    return typeof p === 'string' ? p : null;
  } catch {
    return null;
  }
}

(async () => {
  if (!GATE) {
    console.log('  skip  source-mode integration (set LARES_WP1_INTEGRATION=1 to run)');
    console.log('\n0 passed, 0 failed (gated)');
    return;
  }
  const electron = electronExe();
  const cliJs = nodePath.join(__dirname, 'analytics-snapshot-cli.js');
  assert.ok(electron && fs.existsSync(electron), 'electron binary not found');
  assert.ok(fs.existsSync(cliJs), `dist CLI not found at ${cliJs} — run npm run build:main`);

  const appData = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp1-int-appdata-'));
  const ws = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp1 int ws-')); // space on purpose

  // 1. Bootstrap a fixture dashboard.db (real schema via initDatabase) with the
  //    temp workspace registered — run-as-node so better-sqlite3 keeps its
  //    Electron ABI.
  const bootstrap = nodePath.join(appData, 'bootstrap.cjs');
  fs.writeFileSync(bootstrap, `
    const db = require(${JSON.stringify(nodePath.join(__dirname, '..', 'database.js'))});
    db.initDatabase();
    db.createWorkspace({ title: 'wp1-integration', path: process.argv[2], pathType: 'windows' });
    db.closeDatabase();
  `, 'utf-8');
  const boot = spawnSync(electron!, [bootstrap, ws], {
    encoding: 'utf-8',
    timeout: 120_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', APPDATA: appData },
  });
  assert.equal(boot.status, 0, `bootstrap failed:\n${boot.stdout}\n${boot.stderr}`);

  // 2. Source-mode launcher artifacts, exactly as the app would write them.
  const scripts = nodePath.join(ws, '.lares', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  const shim = nodePath.join(scripts, 'analytics-snapshot.mjs');
  fs.writeFileSync(shim, ANALYTICS_SNAPSHOT_SHIM_MJS, 'utf-8');
  const descriptor = computeInstallationDescriptor({
    isPackaged: false,
    execPath: electron!,
    appVersion: '0.0.0-integration',
    installRoot: nodePath.resolve(__dirname, '..', '..', '..', '..'),
    snapshotCliJsPath: cliJs,
    platform: process.platform,
  });
  fs.writeFileSync(
    nodePath.join(ws, '.lares', 'installation.json'),
    JSON.stringify({ ...descriptor, writtenAt: new Date().toISOString() }, null, 2),
    'utf-8',
  );

  // 3. The skill's verbatim step-1 command, against the fixture APPDATA.
  const r = spawnSync(process.execPath, [shim, 'export', '--json', '--workspace', ws], {
    encoding: 'utf-8',
    timeout: 300_000,
    env: { ...process.env, APPDATA: appData },
  });

  // A fresh empty DB has no parse state → the honest outcomes are a snapshot
  // (0/2) or the cold-index refusal (4). Anything else is a launcher failure.
  assert.ok([0, 2, 4].includes(r.status ?? -1),
    `expected exit 0/2/4, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  if (r.status === 0 || r.status === 2) {
    const manifest = JSON.parse(r.stdout.trim().split('\n').pop() as string);
    assert.ok(typeof manifest.snapshotId === 'string' && manifest.snapshotId.length > 0, 'manifest missing snapshotId');
  } else {
    assert.ok(/cold|index/i.test(r.stderr + r.stdout), `exit 4 without a cold-index message:\n${r.stderr}`);
  }
  console.log(`  ok  source-mode integration (exit ${r.status})`);
  console.log('\n1 passed, 0 failed');
})().catch((e) => {
  console.error('  FAIL  source-mode integration\n', e);
  process.exit(1);
});
