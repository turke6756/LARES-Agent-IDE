// installation-descriptor.test — WP1 (G1) descriptor write + heal tests.
//   npm run build:main
//   node dist/main/main/installation-descriptor.test.js
//
// Everything runs against real temp directories with pathType 'windows' (the
// scaffold IO primitives are plain fs on that path type) — no Electron: the
// tests always pass an explicit `current` descriptor, exactly like the plan's
// "structured as a pure function" intent.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';

import type { InstallationDescriptor } from '../shared/types';
import {
  computeInstallationDescriptor,
  descriptorPayloadDiffers,
  ensureInstallationDescriptor,
  ensureInstallationLauncher,
  INSTALLATION_DESCRIPTOR_REL,
  INSTALLATION_DESCRIPTOR_VERSION,
  type InstallationIdentity,
} from './installation-descriptor';
import { ANALYTICS_SNAPSHOT_SHIM_MJS } from '../shared/constants';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

function tmpWorkspace(): string {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp1-desc-'));
}

const SOURCE_IDENTITY: InstallationIdentity = {
  isPackaged: false,
  execPath: 'C:\\Repos\\Lares\\node_modules\\electron\\dist\\electron.exe',
  appVersion: '1.2.3',
  installRoot: 'C:\\Repos\\Lares',
  snapshotCliJsPath: 'C:\\Repos\\Lares\\dist\\main\\main\\analytics-export\\analytics-snapshot-cli.js',
  platform: 'win32',
};

function descriptorPath(ws: string): string {
  return nodePath.join(ws, ...INSTALLATION_DESCRIPTOR_REL.split('/'));
}
function readDescriptor(ws: string): InstallationDescriptor {
  return JSON.parse(fs.readFileSync(descriptorPath(ws), 'utf-8')) as InstallationDescriptor;
}

// ── computeInstallationDescriptor ─────────────────────────────────────────────

test('source mode: command = installation Electron binary, argsPrefix = [abs dist CLI path]', () => {
  const d = computeInstallationDescriptor(SOURCE_IDENTITY);
  assert.equal(d.mode, 'source');
  assert.equal(d.descriptorVersion, INSTALLATION_DESCRIPTOR_VERSION);
  assert.equal(d.invocation.command, SOURCE_IDENTITY.execPath);
  assert.deepEqual(d.invocation.argsPrefix, [SOURCE_IDENTITY.snapshotCliJsPath]);
  assert.equal(d.installRoot, SOURCE_IDENTITY.installRoot);
  assert.equal(d.appVersion, '1.2.3');
});

test('packaged mode: command = process.execPath, argsPrefix = [--analytics-snapshot]', () => {
  const d = computeInstallationDescriptor({
    ...SOURCE_IDENTITY,
    isPackaged: true,
    execPath: 'C:\\Program Files\\Lares\\Lares.exe',
    installRoot: 'C:\\Program Files\\Lares\\resources\\app.asar',
  });
  assert.equal(d.mode, 'packaged');
  assert.equal(d.invocation.command, 'C:\\Program Files\\Lares\\Lares.exe');
  assert.deepEqual(d.invocation.argsPrefix, ['--analytics-snapshot']);
});

test('win32 installation carries wsl.commandWslPath (/mnt form); non-win32 omits wsl', () => {
  const win = computeInstallationDescriptor(SOURCE_IDENTITY);
  assert.equal(win.wsl?.commandWslPath, '/mnt/c/Repos/Lares/node_modules/electron/dist/electron.exe');
  const linux = computeInstallationDescriptor({ ...SOURCE_IDENTITY, platform: 'linux' });
  assert.equal(linux.wsl, undefined);
});

// ── heal comparison + writes ──────────────────────────────────────────────────

test('registration write: creates .lares/installation.json with the full payload + writtenAt', () => {
  const ws = tmpWorkspace();
  const current = computeInstallationDescriptor(SOURCE_IDENTITY);
  assert.equal(ensureInstallationDescriptor(ws, 'windows', current), true);
  const onDisk = readDescriptor(ws);
  assert.equal(onDisk.mode, 'source');
  assert.deepEqual(onDisk.invocation, current.invocation);
  assert.equal(onDisk.installRoot, current.installRoot);
  assert.equal(onDisk.wsl?.commandWslPath, current.wsl?.commandWslPath);
  assert.ok(!Number.isNaN(Date.parse(onDisk.writtenAt)), `writtenAt not ISO: ${onDisk.writtenAt}`);
});

test('no-op when payload identical — bytes (incl. writtenAt) untouched', () => {
  const ws = tmpWorkspace();
  const current = computeInstallationDescriptor(SOURCE_IDENTITY);
  ensureInstallationDescriptor(ws, 'windows', current);
  const before = fs.readFileSync(descriptorPath(ws), 'utf-8');
  assert.equal(ensureInstallationDescriptor(ws, 'windows', current), false);
  assert.equal(fs.readFileSync(descriptorPath(ws), 'utf-8'), before);
});

test('heal: changed installRoot rewrites', () => {
  const ws = tmpWorkspace();
  ensureInstallationDescriptor(ws, 'windows', computeInstallationDescriptor(SOURCE_IDENTITY));
  const moved = computeInstallationDescriptor({
    ...SOURCE_IDENTITY,
    installRoot: 'D:\\Elsewhere\\Lares',
    execPath: 'D:\\Elsewhere\\Lares\\node_modules\\electron\\dist\\electron.exe',
    snapshotCliJsPath: 'D:\\Elsewhere\\Lares\\dist\\main\\main\\analytics-export\\analytics-snapshot-cli.js',
  });
  assert.equal(ensureInstallationDescriptor(ws, 'windows', moved), true);
  assert.equal(readDescriptor(ws).installRoot, 'D:\\Elsewhere\\Lares');
});

test('heal: changed argsPrefix with UNCHANGED installRoot rewrites', () => {
  const ws = tmpWorkspace();
  ensureInstallationDescriptor(ws, 'windows', computeInstallationDescriptor(SOURCE_IDENTITY));
  const cliMoved = computeInstallationDescriptor({
    ...SOURCE_IDENTITY,
    snapshotCliJsPath: 'C:\\Repos\\Lares\\dist\\main\\main\\analytics-export\\renamed-cli.js',
  });
  assert.equal(cliMoved.installRoot, SOURCE_IDENTITY.installRoot);
  assert.equal(ensureInstallationDescriptor(ws, 'windows', cliMoved), true);
  assert.deepEqual(readDescriptor(ws).invocation.argsPrefix, [
    'C:\\Repos\\Lares\\dist\\main\\main\\analytics-export\\renamed-cli.js',
  ]);
});

test('heal: changed wsl.commandWslPath rewrites', () => {
  const ws = tmpWorkspace();
  const current = computeInstallationDescriptor(SOURCE_IDENTITY);
  ensureInstallationDescriptor(ws, 'windows', current);
  const wslChanged: InstallationDescriptor = {
    ...current,
    wsl: { commandWslPath: '/mnt/d/other/electron.exe' },
  };
  assert.equal(ensureInstallationDescriptor(ws, 'windows', wslChanged), true);
  assert.equal(readDescriptor(ws).wsl?.commandWslPath, '/mnt/d/other/electron.exe');
});

test('heal: descriptorVersion / mode / appVersion changes all rewrite; corrupt JSON rewrites', () => {
  const current = computeInstallationDescriptor(SOURCE_IDENTITY);
  assert.equal(descriptorPayloadDiffers({ ...current, descriptorVersion: 99 }, current), true);
  assert.equal(descriptorPayloadDiffers({ ...current, mode: 'packaged' }, current), true);
  assert.equal(descriptorPayloadDiffers({ ...current, appVersion: '9.9.9' }, current), true);
  assert.equal(descriptorPayloadDiffers({ ...current }, current), false);
  // writtenAt is diagnostic only — never part of the comparison.
  assert.equal(descriptorPayloadDiffers({ ...current, writtenAt: '2001-01-01T00:00:00Z' }, current), false);

  const ws = tmpWorkspace();
  fs.mkdirSync(nodePath.dirname(descriptorPath(ws)), { recursive: true });
  fs.writeFileSync(descriptorPath(ws), '{ not json', 'utf-8');
  assert.equal(ensureInstallationDescriptor(ws, 'windows', current), true);
  assert.equal(readDescriptor(ws).mode, 'source');
});

// ── ensureInstallationLauncher (registration entrypoint) ─────────────────────

test('launcher ensure writes the shim AND the descriptor; second call is a full no-op', () => {
  const ws = tmpWorkspace();
  const current = computeInstallationDescriptor(SOURCE_IDENTITY);
  const first = ensureInstallationLauncher(ws, 'windows', current);
  assert.equal(first.descriptorWritten, true);
  assert.ok(first.shimWrites >= 1, 'shim not written on registration');
  const shimPath = nodePath.join(ws, '.lares', 'scripts', 'analytics-snapshot.mjs');
  assert.equal(fs.readFileSync(shimPath, 'utf-8'), ANALYTICS_SNAPSHOT_SHIM_MJS);

  const second = ensureInstallationLauncher(ws, 'windows', current);
  assert.equal(second.descriptorWritten, false);
  assert.equal(second.shimWrites, 0);
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
