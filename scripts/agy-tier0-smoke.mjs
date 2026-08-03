#!/usr/bin/env node
// agy-tier0-smoke.mjs - Phase 5 Tier-0, non-interactive Antigravity lane smoke.
//
// Run standalone after building both products:
//   npm run build:main
//   npm run build:renderer
//   node scripts/agy-tier0-smoke.mjs
//
// The script never launches an interactive or paid agy turn. It may execute the
// resolved binary with `--version`, then exercises compiled product helpers and
// disposable USERPROFILE/AppData fixtures only.

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '..');
const distSupervisor = path.join(repoRoot, 'dist', 'main', 'main', 'supervisor');
const requiredDist = [
  'index.js', 'provider-resolver.js', 'launch-command.js', 'send-input-encoders.js',
  'key-bytes.js', 'agy-hooks.js', 'agy-settings.js',
].map((name) => path.join(distSupervisor, name));
if (requiredDist.some((file) => !fs.existsSync(file))) {
  console.error('agy-tier0-smoke: compiled main files missing; run `npm run build:main` first');
  process.exit(1);
}

const results = [];
function record(status, name, detail = '') {
  results.push({ status, name, detail });
  const tag = status === 'PASS' ? '  ok  ' : ' FAIL ';
  console.log(`${tag} ${name}${detail ? ` - ${detail}` : ''}`);
}
const pass = (name, detail) => record('PASS', name, detail);
const fail = (name, detail) => record('FAIL', name, detail);
function check(name, fn) {
  try {
    const detail = fn();
    pass(name, typeof detail === 'string' ? detail : '');
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tier0-'));
const workDir = path.join(scratch, 'workspace');
const agentCwd = path.join(workDir, '.lares', 'workers', 'agy');
const fakeHome = path.join(scratch, 'home');
const fakeAppData = path.join(scratch, 'appdata');
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(fakeHome, { recursive: true });

const prior = {
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
  APPDATA: process.env.APPDATA,
};
process.env.USERPROFILE = fakeHome;
process.env.HOME = fakeHome;
process.env.APPDATA = fakeAppData;

const hooksPath = path.join(fakeHome, '.gemini', 'config', 'hooks.json');
const settingsPath = path.join(fakeHome, '.gemini', 'antigravity-cli', 'settings.json');
fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(hooksPath, JSON.stringify({
  'human-foreign-hook': {
    PreInvocation: [{ matcher: 'foreign', hooks: [{ type: 'command', command: 'echo foreign' }] }],
  },
}, null, 2) + '\n');
fs.writeFileSync(settingsPath, JSON.stringify({
  foreignTopLevel: { keep: true },
  trustedWorkspaces: ['C:\\Unrelated\\Workspace'],
  permissions: {
    allow: ['command(echo safe)'],
    ask: ['command(custom tool)'],
    deny: ['command(foreign deny)'],
  },
}, null, 2) + '\n');

try {
  const { AgentSupervisor } = require(path.join(distSupervisor, 'index.js'));
  const { findWindowsProviderBinary } = require(path.join(distSupervisor, 'provider-resolver.js'));
  const { resolveLaunchCommand } = require(path.join(distSupervisor, 'launch-command.js'));
  const { encodeAgyWindowsBody, getWindowsSubmitSequence } = require(path.join(distSupervisor, 'send-input-encoders.js'));
  const { mapKeyToBytes } = require(path.join(distSupervisor, 'key-bytes.js'));
  const { AGY_STATUS_HOOK_ENTRY, AGY_STATUS_HOOK_NAME } = require(path.join(distSupervisor, 'agy-hooks.js'));
  const { AGY_GIT_DISCARD_DENY_RULES } = require(path.join(distSupervisor, 'agy-settings.js'));
  const db = require(path.join(repoRoot, 'dist', 'main', 'main', 'database.js'));
  db.addEvent = () => {};
  db.getAgent = () => null;

  const supervisor = new AgentSupervisor();
  supervisor.ensureWorkerScaffold(workDir, 'agy', 'windows');
  supervisor.ensureProviderDirTrust(workDir, agentCwd, 'agy', 'windows');

  check('scaffold seeds AGENTS.md and shared scripts, with no project hook carrier', () => {
    for (const file of [
      path.join(agentCwd, 'AGENTS.md'),
      path.join(workDir, '.lares', 'scripts', 'dashboard-status.mjs'),
      path.join(workDir, '.lares', 'scripts', 'guard-git-discard.mjs'),
    ]) assert(fs.existsSync(file), `missing ${file}`);
    assert(!fs.existsSync(path.join(agentCwd, '.agents', 'hooks.json')), 'inert project .agents/hooks.json was written');
  });

  check('global named/nested hooks merge preserves foreign entries and installs PreInvocation only', () => {
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    assert(hooks['human-foreign-hook']?.PreInvocation?.length === 1, 'foreign global hook was not preserved');
    assert(JSON.stringify(hooks[AGY_STATUS_HOOK_NAME]) === JSON.stringify(AGY_STATUS_HOOK_ENTRY),
      'managed agy hook differs from compiled named/nested entry');
    const active = Object.entries(hooks[AGY_STATUS_HOOK_NAME])
      .filter(([, value]) => Array.isArray(value) && value.length).map(([event]) => event);
    assert(JSON.stringify(active) === JSON.stringify(['PreInvocation']), `unexpected active events: ${active.join(',')}`);
  });

  check('trust and permissions merge preserve user settings on disposable fixtures', () => {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert(settings.foreignTopLevel?.keep === true, 'foreign top-level setting changed');
    assert(settings.trustedWorkspaces.includes('C:\\Unrelated\\Workspace'), 'foreign trust entry lost');
    assert(settings.trustedWorkspaces.includes(agentCwd), `exact agy cwd trust missing: ${agentCwd}`);
    assert(JSON.stringify(settings.permissions.allow) === JSON.stringify(['command(echo safe)']), 'allow list changed');
    assert(JSON.stringify(settings.permissions.ask) === JSON.stringify(['command(custom tool)']), 'ask list changed');
    assert(settings.permissions.deny.includes('command(foreign deny)'), 'foreign deny entry lost');
    for (const rule of AGY_GIT_DISCARD_DENY_RULES) {
      assert(settings.permissions.deny.includes(rule), `managed deny missing: ${rule}`);
    }
  });

  check('scaffold, global hook, trust, and permissions preparation is idempotent', () => {
    const agentsPath = path.join(agentCwd, 'AGENTS.md');
    fs.writeFileSync(agentsPath, 'human-owned identity survives\n');
    const before = {
      agents: fs.readFileSync(agentsPath, 'utf-8'),
      hooks: fs.readFileSync(hooksPath, 'utf-8'),
      settings: fs.readFileSync(settingsPath, 'utf-8'),
    };
    const second = new AgentSupervisor();
    second.ensureWorkerScaffold(workDir, 'agy', 'windows');
    second.ensureProviderDirTrust(workDir, agentCwd, 'agy', 'windows');
    assert(fs.readFileSync(agentsPath, 'utf-8') === before.agents, 'seed-once AGENTS.md was overwritten');
    assert(fs.readFileSync(hooksPath, 'utf-8') === before.hooks, 'global hooks changed on no-op rerun');
    assert(fs.readFileSync(settingsPath, 'utf-8') === before.settings, 'settings changed on no-op rerun');
  });

  check('launch-command construction selects agy and rejects a Claude binary mismatch', () => {
    const normal = resolveLaunchCommand({
      provider: 'agy', pathType: 'windows', workspaceDefaultCommand: 'claude --dangerously-skip-permissions',
    });
    const mismatch = resolveLaunchCommand({
      provider: 'agy', pathType: 'windows', inputCommand: 'claude --dangerously-skip-permissions',
      workspaceDefaultCommand: 'custom-wrapper',
    });
    assert(normal.command === 'agy' && normal.providerOverride === null, `unexpected normal command: ${JSON.stringify(normal)}`);
    assert(mismatch.command === 'agy' && mismatch.providerOverride?.to === 'agy', `mismatch not corrected: ${JSON.stringify(mismatch)}`);
  });

  check('encoder bytes are LF body newlines plus one final CR', () => {
    const body = encodeAgyWindowsBody('alpha\r\nbeta\rgamma');
    const submit = getWindowsSubmitSequence('agy');
    assert(body === 'alpha\nbeta\ngamma', `body bytes wrong: ${JSON.stringify(body)}`);
    assert(Buffer.from(submit)[0] === 0x0d && Buffer.byteLength(submit) === 1, 'submit is not exactly CR');
    assert(mapKeyToBytes('shift-enter', 'agy', 'windows') === '\n', 'named newline key is not LF');
    assert(mapKeyToBytes('enter', 'agy', 'windows') === '\r', 'named Enter key is not CR');
    return `hex=${Buffer.from(body + submit).toString('hex')}`;
  });

  check('launch dialog advertises Antigravity with command metadata and first-run notice', () => {
    const dialogPath = path.join(repoRoot, 'src', 'renderer', 'components', 'agent', 'AgentLaunchDialog.tsx');
    const constantsPath = path.join(repoRoot, 'src', 'shared', 'constants.ts');
    const dialog = fs.readFileSync(dialogPath, 'utf-8');
    const constants = fs.readFileSync(constantsPath, 'utf-8');
    assert(/PROVIDERS[^\n]*'agy'/.test(dialog), 'agy is absent from the launch dialog provider list');
    assert(/provider === 'agy'/.test(dialog) && /PROVIDER_INSTALL_HINTS\.agy\.installNote/.test(dialog),
      'agy first-run notice is absent from the launch dialog');
    assert(/agy:\s*\{\s*windows:\s*'agy'/.test(constants), 'agy launch command metadata is absent');
    assert(/Antigravity/.test(constants) && /Google/.test(constants), 'Antigravity label/Google sign-in guidance absent');
  });

  const binary = await findWindowsProviderBinary('agy');
  check('binary resolution prefers %LOCALAPPDATA%\\agy\\bin\\agy.exe', () => {
    assert(binary, 'agy binary was not resolved');
    const expected = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
    assert(path.resolve(binary).toLowerCase() === path.resolve(expected).toLowerCase(),
      `resolved ${binary}; expected ${expected}`);
    const version = spawnSync(binary, ['--version'], {
      cwd: agentCwd, encoding: 'utf-8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: '1' },
    });
    assert(version.status === 0, `agy --version failed: ${(version.stderr || '').trim()}`);
    const output = `${version.stdout || ''}`.trim().split(/\r?\n/)[0];
    assert(/\d+\.\d+\.\d+/.test(output), `unexpected version output: ${output}`);
    return `${binary} (${output})`;
  });
} catch (err) {
  fail('smoke harness', err instanceof Error ? err.stack || err.message : String(err));
} finally {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
}

const passed = results.filter((result) => result.status === 'PASS').length;
const failed = results.filter((result) => result.status === 'FAIL').length;
console.log(`\nagy-tier0-smoke: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
