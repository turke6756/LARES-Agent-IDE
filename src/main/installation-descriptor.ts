// installation-descriptor.ts — the workspace's pointer back to the Lares
// installation that manages it (WP1/G1,
// plans/context-analytics-implementation-plan.md).
//
// Two artifacts, both under the workspace state dir:
//   .lares/installation.json          — the descriptor (this module owns it)
//   .lares/scripts/analytics-snapshot.mjs — the cross-platform launcher shim
//                                       (content in shared/constants.ts, written
//                                       through the standard scaffold machinery)
//
// Written at workspace registration (ipc-handlers workspace:create) AND
// refreshed from the unconditional per-launch workspace-script refresh path
// (AgentSupervisor.ensureWorkspaceScripts). Heal condition: rewrite whenever
// any of { mode, invocation.command, invocation.argsPrefix, installRoot,
// appVersion, wsl.commandWslPath, descriptorVersion } differs from the current
// installation — full-payload comparison, `writtenAt` excluded. This is the
// whole relocation story; zero background machinery.

import * as path from 'path';
import type { InstallationDescriptor } from '../shared/types';
import { LARES_DIR_NAME, ANALYTICS_SNAPSHOT_SHIM_MJS } from '../shared/constants';
import {
  readScaffoldText, atomicWriteScaffoldText, writeScaffoldMap, type ScaffoldFile,
} from './scaffold-writer';
import { windowsToWslPath } from './path-utils';

export const INSTALLATION_DESCRIPTOR_REL = `${LARES_DIR_NAME}/installation.json`;
export const INSTALLATION_DESCRIPTOR_VERSION = 1;

/** The launcher shim as a standard versioned scaffold map — written on
 *  registration and self-healed on every lane launch alongside the other
 *  workspace scripts. The shim reads the descriptor at RUNTIME, so descriptor
 *  healing needs no shim rewrite (though this refresh path rewrites both
 *  anyway whenever the bundled shim version bumps). */
export const ANALYTICS_SHIM_FILES: Record<string, ScaffoldFile> = {
  [`${LARES_DIR_NAME}/scripts/analytics-snapshot.mjs`]: {
    content: ANALYTICS_SNAPSHOT_SHIM_MJS,
    version: 1,
    executable: true,
  },
};

/** Everything the descriptor is computed from, injected so the computation and
 *  the heal comparison are testable under plain node (no Electron). */
export interface InstallationIdentity {
  isPackaged: boolean;
  /** The running binary — dev: node_modules/electron/dist/electron(.exe);
   *  packaged: the installed app exe. */
  execPath: string;
  appVersion: string;
  installRoot: string;
  /** Absolute path of the compiled snapshot CLI (source-mode argsPrefix). */
  snapshotCliJsPath: string;
  platform: NodeJS.Platform;
}

/** Read the identity off the live Electron app. Throws outside an Electron
 *  runtime — callers on the app path use ensureInstallationLauncher, which
 *  warn-and-skips. */
export function currentInstallationIdentity(): InstallationIdentity {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron');
  return {
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appVersion: app.getVersion(),
    installRoot: app.getAppPath(),
    // __dirname is dist/main/main at runtime; the CLI compiles beside us.
    snapshotCliJsPath: path.join(__dirname, 'analytics-export', 'analytics-snapshot-cli.js'),
    platform: process.platform,
  };
}

/** Pure descriptor computation. Source mode: command = the installation's
 *  Electron binary, argsPrefix = [abs dist CLI path]. Packaged: command = the
 *  app binary, argsPrefix = ['--analytics-snapshot'] (the argv branch in
 *  index.ts). `writtenAt` is stamped at write time, never compared. */
export function computeInstallationDescriptor(id: InstallationIdentity): InstallationDescriptor {
  const invocation = id.isPackaged
    ? { command: id.execPath, argsPrefix: ['--analytics-snapshot'] }
    : { command: id.execPath, argsPrefix: [id.snapshotCliJsPath] };
  const descriptor: InstallationDescriptor = {
    descriptorVersion: INSTALLATION_DESCRIPTOR_VERSION,
    mode: id.isPackaged ? 'packaged' : 'source',
    invocation,
    installRoot: id.installRoot,
    appVersion: id.appVersion,
    writtenAt: '',
  };
  if (id.platform === 'win32') {
    // WSL executes Windows binaries via their /mnt/<drive>/ form; the args
    // stay Windows-shaped because the Windows-side exe resolves them.
    descriptor.wsl = { commandWslPath: windowsToWslPath(invocation.command) };
  }
  return descriptor;
}

/** Full-payload heal comparison over { mode, invocation.command,
 *  invocation.argsPrefix, installRoot, appVersion, wsl.commandWslPath,
 *  descriptorVersion }. Anything unparseable / wrong-shaped differs. */
export function descriptorPayloadDiffers(existing: unknown, current: InstallationDescriptor): boolean {
  if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) return true;
  const e = existing as Partial<InstallationDescriptor>;
  if (e.descriptorVersion !== current.descriptorVersion) return true;
  if (e.mode !== current.mode) return true;
  if (e.installRoot !== current.installRoot) return true;
  if (e.appVersion !== current.appVersion) return true;
  const inv = e.invocation;
  if (!inv || typeof inv !== 'object') return true;
  if (inv.command !== current.invocation.command) return true;
  if (!Array.isArray(inv.argsPrefix)
    || inv.argsPrefix.length !== current.invocation.argsPrefix.length
    || inv.argsPrefix.some((a, i) => a !== current.invocation.argsPrefix[i])) return true;
  if ((e.wsl?.commandWslPath ?? null) !== (current.wsl?.commandWslPath ?? null)) return true;
  return false;
}

/** Write `.lares/installation.json` iff the on-disk payload differs from
 *  `current` (or is missing/corrupt). Returns whether a write happened. */
export function ensureInstallationDescriptor(
  workDir: string,
  pathType: string,
  current: InstallationDescriptor,
): boolean {
  const raw = readScaffoldText(workDir, INSTALLATION_DESCRIPTOR_REL, pathType);
  if (raw !== null) {
    let existing: unknown = null;
    try { existing = JSON.parse(raw); } catch { existing = null; }
    if (existing !== null && !descriptorPayloadDiffers(existing, current)) return false;
  }
  const payload: InstallationDescriptor = { ...current, writtenAt: new Date().toISOString() };
  atomicWriteScaffoldText(
    workDir, INSTALLATION_DESCRIPTOR_REL, JSON.stringify(payload, null, 2) + '\n', false, pathType,
  );
  return true;
}

/** The one call both app paths use: write/heal the shim (versioned scaffold
 *  machinery) AND the descriptor (full-payload comparison). Never throws — a
 *  workspace registration or lane launch must not fail on launcher upkeep.
 *  `current` is injectable for tests; the default reads the live Electron app. */
export function ensureInstallationLauncher(
  workDir: string,
  pathType: string,
  current?: InstallationDescriptor,
  opts?: { logPrefix?: string },
): { shimWrites: number; descriptorWritten: boolean } {
  const logPrefix = opts?.logPrefix ?? '[installation]';
  let shimWrites = 0;
  let descriptorWritten = false;
  try {
    shimWrites = writeScaffoldMap(workDir, ANALYTICS_SHIM_FILES, pathType, { logPrefix });
  } catch (err) {
    console.warn(`${logPrefix} analytics-snapshot shim write failed in ${workDir}:`, err);
  }
  try {
    const cur = current ?? computeInstallationDescriptor(currentInstallationIdentity());
    descriptorWritten = ensureInstallationDescriptor(workDir, pathType, cur);
    if (descriptorWritten) {
      console.log(`${logPrefix} wrote ${INSTALLATION_DESCRIPTOR_REL} in ${workDir}`);
    }
  } catch (err) {
    console.warn(`${logPrefix} installation descriptor write failed in ${workDir}:`, err);
  }
  return { shimWrites, descriptorWritten };
}
