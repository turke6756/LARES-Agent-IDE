// Unit tests for the runtime-prerequisite detector (packaging plan §6.1/§6.2).
//
// Two things are being protected here, and neither is "does `where` work":
//
//   1. The WSL popup regression guard (commit 8eaa103). On a Windows-only
//      machine, invoking `wsl.exe` can raise Windows' "install WSL" dialog. The
//      detector must not touch WSL at all unless the user has a WSL workspace,
//      and it must report `not-checked` rather than `missing` when it didn't
//      look. This is asserted by counting wsl-bridge calls, not by trusting the
//      code to be careful.
//
//   2. The honesty rules the first-run UI depends on: Git is never in the
//      agent-CLI tier, all three providers are always listed independently,
//      and the legacy HealthCheck is a faithful projection of the same report.
//
// Compile + run:
//   npm run build:main
//   node dist/main/main/runtime-prerequisites.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// ── wsl-bridge instrumentation ─────────────────────────────────────────────
// The detector imports wsl-bridge at module load, so the counter has to be
// installed into the require cache BEFORE requiring the detector. Patching the
// resolved module's exports keeps the real module identity intact.
const wslCalls = { passive: 0, exec: 0 };
let wslStatusToReturn: { state: string; distros: unknown[]; defaultDistro?: string } = {
  state: 'unavailable',
  distros: [],
};

const wslBridgePath = require.resolve('./wsl-bridge');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wslBridge = require(wslBridgePath) as Record<string, unknown>;
wslBridge.getPassiveWslStatus = async () => {
  wslCalls.passive++;
  return wslStatusToReturn;
};
wslBridge.wslExec = async () => {
  wslCalls.exec++;
  return { stdout: '', stderr: '', exitCode: 1 };
};
void Module; // imported for the require-cache contract above

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  detectRuntimePrerequisites,
  toHealthCheck,
  __resetPrerequisiteCache,
} = require('./runtime-prerequisites') as typeof import('./runtime-prerequisites');

/** Point the resolver at an empty scratch home so no real CLI on the dev box
 *  makes these assertions depend on what happens to be installed. */
function withEmptyHome(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-prereq-det-'));
  const saved = {
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PATH: process.env.PATH,
  };
  process.env.USERPROFILE = root;
  process.env.APPDATA = path.join(root, 'Roaming');
  process.env.LOCALAPPDATA = path.join(root, 'Local');
  process.env.PATH = '';
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  };
}

function reset(): void {
  __resetPrerequisiteCache();
  wslCalls.passive = 0;
  wslCalls.exec = 0;
}

// ── The 8eaa103 regression guard ───────────────────────────────────────────
test('no WSL workspace → wsl.exe is never invoked at all', async () => {
  const restore = withEmptyHome();
  reset();
  try {
    const report = await detectRuntimePrerequisites({ hasWslWorkspace: false, force: true });
    assert.equal(wslCalls.passive, 0, 'getPassiveWslStatus must not be called without a WSL workspace');
    assert.equal(wslCalls.exec, 0, 'wslExec must not be called without a WSL workspace');
    assert.equal(report.wslChecked, false);
    // "not-checked" is NOT "missing". Reporting missing here would tell the
    // user to install something we never looked for.
    for (const c of report.wsl) {
      assert.equal(c.status, 'not-checked', `${c.id} should be not-checked, got ${c.status}`);
    }
  } finally {
    restore();
  }
});

test('WSL present but stopped → status stopped, and nothing reaches into the distro', async () => {
  const restore = withEmptyHome();
  reset();
  wslStatusToReturn = { state: 'stopped', distros: [] };
  try {
    const report = await detectRuntimePrerequisites({ hasWslWorkspace: true, force: true });
    assert.equal(wslCalls.passive, 1, 'the passive probe should run exactly once');
    // Reaching into a stopped distro is what starts it (and what can raise the
    // install prompt). The deep checks must stay unprobed.
    assert.equal(wslCalls.exec, 0, 'must not exec inside a stopped distro');
    const wsl = report.wsl.find((c) => c.id === 'wsl');
    assert.equal(wsl?.status, 'stopped');
    assert.equal(report.wsl.find((c) => c.id === 'tmux')?.status, 'not-checked');
  } finally {
    wslStatusToReturn = { state: 'unavailable', distros: [] };
    restore();
  }
});

test('no WSL distro installed → wsl reports missing, deep checks stay unprobed', async () => {
  const restore = withEmptyHome();
  reset();
  wslStatusToReturn = { state: 'no-distro', distros: [] };
  try {
    const report = await detectRuntimePrerequisites({ hasWslWorkspace: true, force: true });
    assert.equal(wslCalls.exec, 0);
    assert.equal(report.wsl.find((c) => c.id === 'wsl')?.status, 'missing');
    // …and it must not be presented as something that breaks the app.
    assert.equal(report.wsl.find((c) => c.id === 'wsl')?.tier, 'wsl-feature');
  } finally {
    wslStatusToReturn = { state: 'unavailable', distros: [] };
    restore();
  }
});

test('WSL running → the in-distro checks do run', async () => {
  const restore = withEmptyHome();
  reset();
  wslStatusToReturn = { state: 'running', distros: [], defaultDistro: 'Ubuntu' };
  try {
    const report = await detectRuntimePrerequisites({ hasWslWorkspace: true, force: true });
    assert.equal(report.wsl.find((c) => c.id === 'wsl')?.status, 'available');
    assert.ok(wslCalls.exec >= 3, `expected node/tmux/claude probes, saw ${wslCalls.exec}`);
    // The stub returns exitCode 1, i.e. "not installed inside the distro".
    assert.equal(report.wsl.find((c) => c.id === 'tmux')?.status, 'missing');
  } finally {
    wslStatusToReturn = { state: 'unavailable', distros: [] };
    restore();
  }
});

// ── Honesty rules the UI depends on ────────────────────────────────────────
test('all three providers are always listed, independently, in the agent-cli tier', async () => {
  const restore = withEmptyHome();
  reset();
  try {
    const report = await detectRuntimePrerequisites({ force: true });
    assert.deepEqual(report.providers.map((p) => p.id), ['claude', 'codex', 'gemini']);
    for (const p of report.providers) {
      assert.equal(p.tier, 'agent-cli');
      assert.equal(p.status, 'missing', `${p.id} should be missing in an empty home`);
      assert.ok(p.docsUrl, `${p.id} must carry a docs link (the primary affordance)`);
      assert.ok(p.installCommand, `${p.id} must carry one copyable command`);
      assert.ok(p.verifiedOn, `${p.id} install command must carry its verified-on date`);
    }
    assert.equal(report.anyProviderAvailable, false);
  } finally {
    restore();
  }
});

// Plan §6.1 is explicit: "Git is explicitly not core… A missing Git must not
// make first-run say the app is incomplete." That is enforced structurally —
// git can never appear in the providers list nor in the agent-cli tier.
test('git is optional, never an agent-cli requirement', async () => {
  const restore = withEmptyHome();
  reset();
  try {
    const report = await detectRuntimePrerequisites({ force: true });
    assert.equal(report.providers.find((p) => p.id === 'git'), undefined);
    const git = report.optional.find((c) => c.id === 'git');
    assert.ok(git, 'git should be reported, in the optional group');
    assert.equal(git.tier, 'optional');
    // A missing git must not flip the "can this user launch agents" flag.
    const gitless = { ...report, optional: report.optional };
    assert.equal(gitless.anyProviderAvailable, false);
    for (const c of report.optional) assert.equal(c.tier, 'optional');
  } finally {
    restore();
  }
});

test('external node is optional — Lares ships its own runtime', async () => {
  const restore = withEmptyHome();
  reset();
  try {
    const report = await detectRuntimePrerequisites({ force: true });
    const node = report.optional.find((c) => c.id === 'node');
    assert.ok(node);
    assert.equal(node.tier, 'optional');
    assert.match(node.impact, /Lares itself does not need this/);
  } finally {
    restore();
  }
});

test('never throws, even when every probe fails', async () => {
  const restore = withEmptyHome();
  reset();
  const savedSystemRoot = process.env.SystemRoot;
  // Break cmd.exe resolution so every spawn errors.
  process.env.SystemRoot = path.join(os.tmpdir(), 'no-such-windows-root');
  try {
    const report = await detectRuntimePrerequisites({ force: true });
    assert.ok(report.providers.length === 3);
    assert.equal(report.anyProviderAvailable, false);
  } finally {
    if (savedSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = savedSystemRoot;
    restore();
  }
});

// ── The projection (F15: extend, don't fork) ───────────────────────────────
test('HealthCheck is a faithful projection of the same report', async () => {
  const restore = withEmptyHome();
  reset();
  wslStatusToReturn = { state: 'running', distros: [], defaultDistro: 'Ubuntu' };
  try {
    const report = await detectRuntimePrerequisites({ hasWslWorkspace: true, force: true });
    const health = toHealthCheck(report);
    assert.equal(health.wslAvailable, report.wslStatus.state === 'running');
    assert.equal(
      health.claudeWindowsAvailable,
      report.providers.find((p) => p.id === 'claude')?.status === 'available',
    );
    assert.equal(
      health.tmuxAvailable,
      report.wsl.find((c) => c.id === 'tmux')?.status === 'available',
    );
    // The full report rides along, so the sidebar ticker and the first-run
    // dialog are literally rendering one detection pass.
    assert.equal(health.prerequisites, report);
  } finally {
    wslStatusToReturn = { state: 'unavailable', distros: [] };
    restore();
  }
});

test('the TTL cache is bypassed by force, and never serves a WSL-less report to a WSL caller', async () => {
  const restore = withEmptyHome();
  reset();
  wslStatusToReturn = { state: 'running', distros: [] };
  try {
    await detectRuntimePrerequisites({ hasWslWorkspace: false, force: true });
    assert.equal(wslCalls.passive, 0);
    // A later caller that DOES have a WSL workspace must not be handed the
    // cached, unprobed answer — that would permanently report WSL unknown.
    const second = await detectRuntimePrerequisites({ hasWslWorkspace: true });
    assert.equal(second.wslChecked, true);
    assert.ok(wslCalls.passive >= 1);
  } finally {
    wslStatusToReturn = { state: 'unavailable', distros: [] };
    restore();
  }
});

async function main(): Promise<void> {
  let failures = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failures++;
      console.error(`  FAIL  ${t.name}`);
      console.error(err instanceof Error ? err.stack : err);
    }
  }
  console.log(`\nruntime-prerequisites: ${tests.length - failures}/${tests.length} passed`);
  if (failures) process.exit(1);
}

void main();
