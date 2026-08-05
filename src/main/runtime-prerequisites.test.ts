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
import type { GitCapability } from '../shared/types';

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
  parseNodeMajor,
  decideNodeOptional,
  decideGitStatus,
  __setProbeWorkspaceGitForTest,
  forcePrerequisiteRecheck,
} = require('./runtime-prerequisites') as typeof import('./runtime-prerequisites');

/** A healthy git capability (system git, at repo root, non-protected). Override
 *  individual fields per case. */
function gitCap(overrides: Partial<GitCapability> = {}): GitCapability {
  return {
    resolution: {
      agentShell: { source: 'system', note: 'Agent shell and Lares both resolve system git.' },
      internal: {
        source: 'system',
        execPath: 'C:\\Program Files\\Git\\cmd\\git.exe',
        semver: { major: 2, minor: 45, patch: 2 },
      },
    },
    repoState: 'repo',
    commonDir: null,
    commonDirQueueKey: null,
    repoRoot: null,
    workspacePrefix: null,
    protectedRoot: false,
    reason: 'ok',
    detail: null,
    ...overrides,
  };
}

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
test('all four launchable providers are always listed independently in the agent-cli tier', async () => {
  const restore = withEmptyHome();
  reset();
  try {
    const report = await detectRuntimePrerequisites({ force: true });
    assert.deepEqual(report.providers.map((p) => p.id), ['claude', 'codex', 'grok', 'agy']);
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

// ── Grok is the fourth provider row (plan §1.4/§1.8) ───────────────────────
// The detector must produce a grok row driven by the SAME checkProvider +
// probeWindowsProvider path as the other three — no bespoke grok logic.

function writeExec(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
}

test('grok row: MISSING in an empty home (nothing installed)', async () => {
  const restore = withEmptyHome();
  reset();
  try {
    const report = await detectRuntimePrerequisites({ force: true });
    const grok = report.providers.find((p) => p.id === 'grok');
    assert.ok(grok, 'grok must always be present in the providers list');
    assert.equal(grok.tier, 'agent-cli');
    assert.equal(grok.status, 'missing');
    assert.equal(grok.label, 'Grok Build');
    assert.ok(grok.docsUrl, 'grok must carry a docs link');
    assert.ok(grok.installCommand, 'grok must carry one copyable install command');
  } finally {
    restore();
  }
});

test('grok row: AVAILABLE when a runnable grok resolves — version captured best-effort', async () => {
  const restore = withEmptyHome();
  reset();
  // An npm-global grok.cmd that cmd.exe can actually run and that echoes a
  // version line, so the --version probe succeeds.
  writeExec(
    path.join(process.env.APPDATA as string, 'npm', 'grok.cmd'),
    '@echo off\r\necho grok 0.2.112\r\n',
  );
  try {
    const report = await detectRuntimePrerequisites({ force: true });
    const grok = report.providers.find((p) => p.id === 'grok');
    assert.ok(grok);
    assert.equal(grok.status, 'available');
    assert.ok(grok.path && grok.path.endsWith('grok.cmd'), `grok path should be the resolved shim, got ${grok.path}`);
    assert.match(grok.version ?? '', /0\.2\.112/);
    assert.equal(report.anyProviderAvailable, true, 'a resolvable grok flips anyProviderAvailable');
  } finally {
    restore();
  }
});

test('grok row: a resolved binary whose --version never answers still reports AVAILABLE (version best-effort, like a timeout)', async () => {
  const restore = withEmptyHome();
  reset();
  // The documented installer path exists (so grok RESOLVES) but the file is not
  // a runnable PE, so `cmd.exe /c "<path> --version"` errors with no stdout —
  // the same terminal state as a --version timeout. Knowing WHERE the binary is
  // is what marks the provider available; the version is a nicety.
  writeExec(
    path.join(process.env.USERPROFILE as string, '.grok', 'bin', 'grok.exe'),
    'not a real executable',
  );
  try {
    const report = await detectRuntimePrerequisites({ force: true });
    const grok = report.providers.find((p) => p.id === 'grok');
    assert.ok(grok);
    assert.equal(grok.status, 'available', 'a resolved-but-unversionable grok is still available');
    assert.ok(grok.path && grok.path.endsWith(path.join('.grok', 'bin', 'grok.exe')), `expected the installer path, got ${grok.path}`);
    assert.equal(grok.version, undefined, 'an unanswered --version yields no version, never a crash');
  } finally {
    restore();
  }
});

// Antigravity rides the same resolver + --version path, with its official
// installer location rooted at LOCALAPPDATA rather than USERPROFILE.
test('agy row: MISSING in an empty home and branded as Antigravity CLI', async () => {
  const restore = withEmptyHome();
  reset();
  try {
    const report = await detectRuntimePrerequisites({ force: true });
    const agy = report.providers.find((p) => p.id === 'agy');
    assert.ok(agy, 'agy must always be present in the providers list');
    assert.equal(agy.status, 'missing');
    assert.equal(agy.label, 'Antigravity CLI');
    assert.ok(agy.docsUrl);
    assert.ok(agy.installCommand);
  } finally {
    restore();
  }
});

test('agy row: AVAILABLE from %LOCALAPPDATA%\\agy\\bin\\agy.exe with version best-effort', async () => {
  const restore = withEmptyHome();
  reset();
  writeExec(
    path.join(process.env.LOCALAPPDATA as string, 'agy', 'bin', 'agy.exe'),
    'not a real executable',
  );
  try {
    const report = await detectRuntimePrerequisites({ force: true });
    const agy = report.providers.find((p) => p.id === 'agy');
    assert.ok(agy);
    assert.equal(agy.status, 'available');
    assert.ok(agy.path?.endsWith(path.join('agy', 'bin', 'agy.exe')), `unexpected path: ${agy.path}`);
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

test('external node is optional — a missing node reports the bundled-fallback copy (plan §4)', async () => {
  const restore = withEmptyHome();
  reset();
  try {
    const report = await detectRuntimePrerequisites({ force: true });
    const node = report.optional.find((c) => c.id === 'node');
    assert.ok(node);
    assert.equal(node.tier, 'optional');
    assert.equal(node.status, 'missing');
    // Plan §4: a MISSING system node is no longer a hook-breaker — the bundled
    // runtime fallback covers managed scripts. The impact must SAY so, and must
    // not tell the user the app is broken.
    assert.match(node.impact, /bundled Node fallback/);
    assert.match(node.remediation, /only if you want your own/i);
  } finally {
    restore();
  }
});

// ── Plan §4: system-Node minimum-version branching ─────────────────────────
// The precedence-aware node decision is a pure function so all three branches
// are testable without spawning `where` / `node --version`.
test('parseNodeMajor: extracts the major, tolerates the v-prefix, null on garbage', () => {
  assert.equal(parseNodeMajor('v18.17.0'), 18);
  assert.equal(parseNodeMajor('20.11.1'), 20);
  assert.equal(parseNodeMajor('v16.20.2'), 16);
  assert.equal(parseNodeMajor(undefined), null);
  assert.equal(parseNodeMajor(''), null);
  assert.equal(parseNodeMajor('not a version'), null);
});

test('decideNodeOptional: MISSING → bundled-fallback copy, status missing', () => {
  const d = decideNodeOptional(null, undefined);
  assert.equal(d.status, 'missing');
  assert.match(d.impact, /bundled Node fallback/);
  assert.match(d.remediation, /your own `node`/);
});

test('decideNodeOptional: TOO OLD (< 18) → available but flagged, do not override', () => {
  const d = decideNodeOptional('C:\\old\\node.exe', 'v16.20.2');
  assert.equal(d.status, 'available');
  assert.match(d.impact, /too old for Lares hooks/);
  assert.match(d.impact, /v16\.20\.2/);
  assert.match(d.remediation, /Upgrade to Node 18 or newer/);
});

test('decideNodeOptional: COMPATIBLE (>= 18) → authoritative, no impact', () => {
  const d = decideNodeOptional('C:\\ok\\node.exe', 'v18.17.0');
  assert.equal(d.status, 'available');
  assert.equal(d.impact, '');
  assert.equal(d.remediation, '');
});

test('decideNodeOptional: an unparseable version is treated as compatible, never too-old', () => {
  // Version is best-effort; a resolved-but-unparseable node must not be
  // slandered as obsolete.
  const d = decideNodeOptional('C:\\ok\\node.exe', undefined);
  assert.equal(d.status, 'available');
  assert.equal(d.impact, '');
});

test('never throws, even when every probe fails', async () => {
  const restore = withEmptyHome();
  reset();
  const savedSystemRoot = process.env.SystemRoot;
  // Break cmd.exe resolution so every spawn errors.
  process.env.SystemRoot = path.join(os.tmpdir(), 'no-such-windows-root');
  try {
    const report = await detectRuntimePrerequisites({ force: true });
    assert.ok(report.providers.length === 4);
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

// ── Git-Native WP-G0.3: capability-aware git row ────────────────────────────
// The mapping is pure, so the reason × protectedRoot matrix is tested without
// spawning git. The key honesty rule (mirrors the acceptance case): a
// git-present-but-broken workspace must NOT read as "available".

test('decideGitStatus: healthy repo on a non-protected root → available, no remediation', () => {
  const d = decideGitStatus(gitCap());
  assert.equal(d.status, 'available');
  assert.equal(d.impact, '');
  assert.equal(d.remediation, '');
});

test('decideGitStatus: non-repo and unborn HEAD (reason ok) stay available — supported', () => {
  assert.equal(decideGitStatus(gitCap({ reason: 'ok', repoState: 'non-repo' })).status, 'available');
  assert.equal(decideGitStatus(gitCap({ reason: 'ok', repoState: 'unborn' })).status, 'available');
});

// The acceptance case: safe.directory on a foreign-owned workspace.
test('decideGitStatus: unsafe-directory → status NOT available + actionable remediation', () => {
  const d = decideGitStatus(gitCap({ reason: 'unsafe-directory', repoState: 'repo' }));
  assert.notEqual(d.status, 'available');
  assert.ok(d.remediation.trim().length > 0, 'must carry a non-empty remediation');
  assert.match(d.remediation, /safe\.directory/);
});

test('decideGitStatus: protectedRoot flags even a healthy repo → not available, protected-root remediation', () => {
  const d = decideGitStatus(gitCap({ reason: 'ok', protectedRoot: true }));
  assert.notEqual(d.status, 'available');
  assert.ok(d.remediation.trim().length > 0);
  assert.match(d.remediation, /protected root/i);
});

test('decideGitStatus: missing git → not available, install remediation', () => {
  const d = decideGitStatus(
    gitCap({
      reason: 'missing',
      repoState: null,
      resolution: {
        agentShell: { source: null, note: 'No git resolves on the agent shell PATH.' },
        internal: null,
      },
    }),
  );
  assert.notEqual(d.status, 'available');
  assert.match(d.remediation, /install/i);
});

test('decideGitStatus: divergent internal vs agent-shell resolution is surfaced in detail', () => {
  const d = decideGitStatus(
    gitCap({
      reason: 'ok',
      resolution: {
        agentShell: {
          source: 'system',
          note: 'Divergent: the agent shell resolves system git first, while Lares uses bundled git (X) internally.',
        },
        internal: { source: 'bundled', execPath: 'X\\git.exe', semver: { major: 2, minor: 45, patch: 0 } },
      },
    }),
  );
  // Both resolutions must be legible in the rendered detail.
  assert.ok(d.detail, 'divergence must produce a detail line');
  assert.match(d.detail as string, /Divergent/i);
  assert.match(d.detail as string, /bundled/);
  assert.match(d.detail as string, /system/);
});

test('checkGit: an injected fake probe drives the git optional row + attaches the DTO', async () => {
  const restore = withEmptyHome();
  reset();
  __setProbeWorkspaceGitForTest(async () => gitCap({ reason: 'unsafe-directory' }));
  try {
    const report = await detectRuntimePrerequisites({ force: true });
    const git = report.optional.find((c) => c.id === 'git');
    assert.ok(git, 'git must be present in the optional group');
    assert.equal(git.tier, 'optional');
    assert.notEqual(git.status, 'available');
    assert.ok(git.remediation.trim().length > 0);
    assert.ok(git.git, 'the full git DTO rides along on the check');
    assert.equal(git.git?.reason, 'unsafe-directory');
    // A degraded row must not advertise a usable path/version.
    assert.equal(git.path, undefined);
  } finally {
    __setProbeWorkspaceGitForTest(null);
    restore();
  }
});

test('checkGit: a healthy probe → available, with the internal git path + version', async () => {
  const restore = withEmptyHome();
  reset();
  __setProbeWorkspaceGitForTest(async () => gitCap());
  try {
    const report = await detectRuntimePrerequisites({ force: true });
    const git = report.optional.find((c) => c.id === 'git');
    assert.equal(git?.status, 'available');
    assert.equal(git?.path, 'C:\\Program Files\\Git\\cmd\\git.exe');
    assert.equal(git?.version, '2.45.2');
    // A missing git must never flip the launch flag (git is optional).
    assert.equal(report.anyProviderAvailable, false);
  } finally {
    __setProbeWorkspaceGitForTest(null);
    restore();
  }
});

test('forcePrerequisiteRecheck drops the TTL cache so the git row re-probes', async () => {
  const restore = withEmptyHome();
  reset();
  __setProbeWorkspaceGitForTest(async () => gitCap({ reason: 'unsafe-directory' }));
  try {
    const first = await detectRuntimePrerequisites({});
    assert.equal(first.optional.find((c) => c.id === 'git')?.git?.reason, 'unsafe-directory');
    // Swap the probe result. Within the TTL and without invalidation, the cached
    // (stale) report is served — proving the cache is real…
    __setProbeWorkspaceGitForTest(async () => gitCap());
    const cached = await detectRuntimePrerequisites({});
    assert.equal(cached.optional.find((c) => c.id === 'git')?.git?.reason, 'unsafe-directory');
    // …then the force hook drops it and the next pass recomputes.
    forcePrerequisiteRecheck();
    const fresh = await detectRuntimePrerequisites({});
    assert.equal(fresh.optional.find((c) => c.id === 'git')?.status, 'available');
  } finally {
    __setProbeWorkspaceGitForTest(null);
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
