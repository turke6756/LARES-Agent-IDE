// WP-A.2 (plans/groupthink/foundation-and-role-lane.md STEP 4) — unit tests for
// the per-lane dashboard MCP injection builders + the token-redaction blocker.
//
// Three layers:
//   1. Pure-builder behavior: toolsetsForLane, buildDashboardMcpConfigArg
//      (windows + WSL JSON shape), redactMcpToken (literal / key / env-prefix /
//      base64-envelope forms).
//   2. End-to-end redaction proof (BLOCKER, D-4/F10): drive WslRunner's
//      launches.log writer with a token-bearing command + base64 tmux envelope
//      and assert the persisted record never contains the token (literally OR
//      base64-recoverably) — proving no token reaches launches.log.
//   3. Source-scan grep gate: the retired root-`.mcp.json` write sinks are gone
//      and the WSL command serializations are wrapped in redactMcpToken.
//
// Pure (no Electron, no DB, no spawn) so it runs under the system-Node runner:
//   npm run build:main
//   node dist/main/main/supervisor/mcp-config-builder.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  toolsetsForLane,
  buildDashboardMcpConfigArg,
  laneUsesStrictMcp,
  redactMcpToken,
  shouldDirectSpawn,
  RESEARCHER_ALLOWED_TOOLS,
  RESEARCHER_DISALLOWED_TOOLS,
} from './mcp-config-builder';
import { WslRunner, buildLaunchRecord, appendLaunchRecord } from './wsl-runner';
import type { WslLaunchDiagnostics } from './wsl-runner';
import { buildTmuxNewSessionCommand } from '../wsl-bridge';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

const FAKE_TOKEN = 'TESTtok_ZmFrZS10b2tlbi12YWx1ZQ123456789abcdef';
const WIN_SCRIPT = 'C:\\Users\\me\\Projects\\AgentDashboard\\scripts\\mcp-dashboard.js';

// ── toolsetsForLane ──────────────────────────────────────────────────

test('toolsetsForLane: supervisor gets orchestration/teams/comms/observability + browser-present (NO full browser/notebooks)', () => {
  assert.equal(toolsetsForLane('supervisor'), 'orchestration,teams,comms,observability,browser-present');
});

test('toolsetsForLane: worker gets notebooks,comms,observability + browser-present (no orchestration/full browser)', () => {
  assert.equal(toolsetsForLane('worker'), 'notebooks,comms,observability,browser-present');
});

test('toolsetsForLane: supervisor + worker get the open-only browser-present grant, never the full browser', () => {
  for (const lane of ['supervisor', 'worker'] as const) {
    const grant = toolsetsForLane(lane);
    assert.ok(grant.split(',').includes('browser-present'), `${lane} must include browser-present`);
    assert.ok(!grant.split(',').includes('browser'), `${lane} must NOT include the full browser toolset`);
  }
});

test('toolsetsForLane: researcher gets the full browser, NOT the open-only browser-present', () => {
  assert.equal(toolsetsForLane('researcher'), 'browser');
});

test('toolsetsForLane: legacy gets the empty grant (no dashboard MCP)', () => {
  assert.equal(toolsetsForLane('legacy'), '');
});

// ── laneUsesStrictMcp ────────────────────────────────────────────────

test('laneUsesStrictMcp: worker is strict (containment lane)', () => {
  assert.equal(laneUsesStrictMcp('worker'), true);
});

test('laneUsesStrictMcp: researcher is strict (containment lane)', () => {
  assert.equal(laneUsesStrictMcp('researcher'), true);
});

test('laneUsesStrictMcp: supervisor is NOT strict (keeps global Gmail/Calendar/Drive/chrome MCPs)', () => {
  assert.equal(laneUsesStrictMcp('supervisor'), false);
});

test('laneUsesStrictMcp: legacy is NOT strict (keeps global MCPs; team config stays inline)', () => {
  assert.equal(laneUsesStrictMcp('legacy'), false);
});

// ── Researcher native-tool boundary (WP-B STEP 5 / Gate-0 default) ───

test('RESEARCHER_ALLOWED_TOOLS: research/browse set, NO Bash/Edit/NotebookEdit', () => {
  assert.ok(RESEARCHER_ALLOWED_TOOLS.includes('WebSearch'));
  assert.ok(RESEARCHER_ALLOWED_TOOLS.includes('WebFetch'));
  assert.ok(RESEARCHER_ALLOWED_TOOLS.includes('Read'));
  assert.ok(RESEARCHER_ALLOWED_TOOLS.includes('Grep'));
  assert.ok(RESEARCHER_ALLOWED_TOOLS.includes('Glob'));
  assert.ok(RESEARCHER_ALLOWED_TOOLS.includes('Task'));
  assert.ok(RESEARCHER_ALLOWED_TOOLS.includes('Skill'));
  assert.ok(RESEARCHER_ALLOWED_TOOLS.includes('Write'));
  assert.ok(RESEARCHER_ALLOWED_TOOLS.includes('mcp__agent-dashboard__browser_*'));
  // claude-in-chrome is the researcher's de-emphasized fallback browser —
  // granted to the researcher lane ONLY (no other lane lists it).
  assert.ok(RESEARCHER_ALLOWED_TOOLS.includes('mcp__claude-in-chrome__*'),
    'claude-in-chrome must be in the researcher --tools allowlist (fallback browser)');
  // The dangerous built-ins must NOT be in the offered set.
  for (const banned of ['Bash', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.ok(!RESEARCHER_ALLOWED_TOOLS.includes(banned), `--tools must not offer ${banned}`);
  }
});

test('RESEARCHER_DISALLOWED_TOOLS: lists the dangerous built-ins (belt-and-suspenders)', () => {
  assert.deepEqual([...RESEARCHER_DISALLOWED_TOOLS].sort(),
    ['Bash', 'Edit', 'MultiEdit', 'NotebookEdit'].sort());
});

test('researcher --tools value is a clean comma list (no spaces — single arg)', () => {
  const v = RESEARCHER_ALLOWED_TOOLS.join(',');
  assert.ok(!/\s/.test(v), 'comma-joined --tools value must contain no whitespace');
  assert.ok(v.includes('mcp__agent-dashboard__browser_*'));
});

// ── shouldDirectSpawn (Windows launch gate) ──────────────────────────
// Regression for the unsupervised-worker bug: a plain claude worker gets an
// inline --mcp-config JSON that the cmd.exe wrap corrupts into a bogus file
// path ("MCP config file not found"). The worker lane MUST direct-spawn.

test('shouldDirectSpawn: a plain claude WORKER lane direct-spawns (regression — was the omitted lane)', () => {
  assert.equal(shouldDirectSpawn({
    lane: 'worker', provider: 'claude', hasPromptArg: false,
  }), true, 'unsupervised claude worker must bypass the cmd.exe wrap');
});

test('shouldDirectSpawn: supervisor / researcher claude lanes still direct-spawn', () => {
  for (const lane of ['supervisor', 'researcher'] as const) {
    assert.equal(shouldDirectSpawn({ lane, provider: 'claude', hasPromptArg: false }), true,
      `${lane} lane must still direct-spawn`);
  }
});

// REGRESSION (privilege-lane crash-loop): a persona with isSupervisor:false +
// privilegeLane:'supervisor' resolves to the SUPERVISOR lane via roleLaneOf, so
// it is injected with an inline --mcp-config <JSON>. The gate must therefore
// direct-spawn it — keying off the lane (not the four booleans, which are all
// false for such a persona) is what closes the gap: the cmd.exe wrap would
// otherwise double every `"` in the JSON → "MCP config file not found" → the
// 5×-restart crash-loop. (roleLaneOf(privilegeLane:'supervisor') === 'supervisor'
// is asserted in role-lane.test.ts; here we prove the supervisor lane spawns.)
test('shouldDirectSpawn: a privilegeLane supervisor persona (lane=supervisor) direct-spawns', () => {
  assert.equal(shouldDirectSpawn({ lane: 'supervisor', provider: 'claude', hasPromptArg: false }), true,
    'a privilege-lane supervisor persona is injected with inline --mcp-config and MUST direct-spawn');
});

test('shouldDirectSpawn: a plain LEGACY claude agent (legacy lane, no prompt) does NOT direct-spawn', () => {
  assert.equal(shouldDirectSpawn({ lane: 'legacy', provider: 'claude', hasPromptArg: false }), false,
    'legacy claude with no prompt keeps the cmd.exe path');
});

test('shouldDirectSpawn: overrideArgs suppresses persistent-lane spawn (matches !overrideArgs)', () => {
  assert.equal(shouldDirectSpawn({
    lane: 'worker', provider: 'claude', hasPromptArg: false, overrideArgs: true,
  }), false, 'explicit override args suppress the persistent-lane direct-spawn');
});

test('shouldDirectSpawn: a multiline prompt arg forces direct-spawn even for a legacy agent', () => {
  assert.equal(shouldDirectSpawn({ lane: 'legacy', provider: 'claude', hasPromptArg: true }), true,
    'a positional prompt would be shredded by cmd.exe — must direct-spawn');
});

test('shouldDirectSpawn: a non-claude worker (e.g. codex) does NOT direct-spawn on the lane alone', () => {
  assert.equal(shouldDirectSpawn({ lane: 'worker', provider: 'codex', hasPromptArg: false }), false,
    'only claude agents take the persistent-lane direct-spawn path');
});

// ── buildDashboardMcpConfigArg (windows) ─────────────────────────────

test('buildDashboardMcpConfigArg windows: correct env/command/args, token present, no HOST', () => {
  const json = buildDashboardMcpConfigArg({
    toolsets: 'browser',
    pathType: 'windows',
    scriptPath: WIN_SCRIPT,
    apiPort: 24681,
    apiToken: FAKE_TOKEN,
  });
  const parsed = JSON.parse(json);
  const srv = parsed.mcpServers['agent-dashboard'];
  assert.ok(srv, 'server key must be agent-dashboard');
  assert.equal(srv.command, 'node');
  assert.equal(srv.args.length, 1);
  assert.ok(srv.args[0].endsWith('mcp-dashboard.js'), `args[0] should point at mcp-dashboard.js; got ${srv.args[0]}`);
  assert.ok(!srv.args[0].includes('\\'), 'windows args path must be forward-slash normalized');
  assert.equal(srv.env.DASHBOARD_MCP_TOOLSETS, 'browser');
  assert.equal(srv.env.AGENT_DASHBOARD_API_PORT, '24681');
  assert.equal(srv.env.AGENT_DASHBOARD_API_TOKEN, FAKE_TOKEN);
  assert.equal(srv.env.AGENT_DASHBOARD_API_HOST, undefined, 'windows config must NOT set a gateway host');
});

// ── buildDashboardMcpConfigArg (wsl) ─────────────────────────────────

test('buildDashboardMcpConfigArg wsl: /mnt rewrite + AGENT_DASHBOARD_API_HOST gateway', () => {
  const json = buildDashboardMcpConfigArg({
    toolsets: 'notebooks,comms,observability',
    pathType: 'wsl',
    scriptPath: WIN_SCRIPT,
    apiPort: 24681,
    apiToken: FAKE_TOKEN,
    wslHostIp: '172.22.208.1',
  });
  const parsed = JSON.parse(json);
  const srv = parsed.mcpServers['agent-dashboard'];
  assert.equal(srv.args[0], '/mnt/c/Users/me/Projects/AgentDashboard/scripts/mcp-dashboard.js',
    `WSL args must be /mnt/<drive> form; got ${srv.args[0]}`);
  assert.equal(srv.env.DASHBOARD_MCP_TOOLSETS, 'notebooks,comms,observability');
  assert.equal(srv.env.AGENT_DASHBOARD_API_HOST, '172.22.208.1');
  assert.equal(srv.env.AGENT_DASHBOARD_API_TOKEN, FAKE_TOKEN);
});

test('buildDashboardMcpConfigArg wsl: defaults host to 127.0.0.1 when gateway omitted', () => {
  const parsed = JSON.parse(buildDashboardMcpConfigArg({
    toolsets: 'browser', pathType: 'wsl', scriptPath: WIN_SCRIPT, apiPort: 1, apiToken: FAKE_TOKEN,
  }));
  assert.equal(parsed.mcpServers['agent-dashboard'].env.AGENT_DASHBOARD_API_HOST, '127.0.0.1');
});

test('buildDashboardMcpConfigArg: compact JSON has no whitespace after "env" (WSL wrap safety)', () => {
  // The WSL launch single-quotes this JSON inside a `cd && ...` wrap; a space
  // after a bare `env` token would trip the agent-supervisor `env\s` guard.
  const json = buildDashboardMcpConfigArg({
    toolsets: 'browser', pathType: 'windows', scriptPath: WIN_SCRIPT, apiPort: 1, apiToken: FAKE_TOKEN,
  });
  assert.ok(!/env\s/.test(json), `compact config JSON must not contain "env" followed by whitespace; got ${json}`);
});

// ── redactMcpToken ───────────────────────────────────────────────────

test('redactMcpToken: removes the literal token value', () => {
  const cmd = `claude --mcp-config '{"env":{"AGENT_DASHBOARD_API_TOKEN":"${FAKE_TOKEN}"}}'`;
  const out = redactMcpToken(cmd, FAKE_TOKEN);
  assert.ok(!out.includes(FAKE_TOKEN), 'literal token must be gone');
  assert.ok(out.includes('***REDACTED***'), 'placeholder must be present');
});

test('redactMcpToken: scrubs the JSON key form even with a different/rotated value', () => {
  const cmd = '{"AGENT_DASHBOARD_API_TOKEN":"some-other-value-not-the-secret"}';
  const out = redactMcpToken(cmd, FAKE_TOKEN);
  assert.ok(!out.includes('some-other-value-not-the-secret'), 'key-form value must be scrubbed regardless of secret arg');
});

test('redactMcpToken: scrubs the shell env-prefix form', () => {
  const out = redactMcpToken('AGENT_DASHBOARD_API_TOKEN=abc123 node x.js', FAKE_TOKEN);
  assert.ok(!out.includes('abc123'), 'env-prefix value must be scrubbed');
  assert.ok(out.includes('AGENT_DASHBOARD_API_TOKEN=***REDACTED***'));
});

test('redactMcpToken: strips the base64 tmux envelope so the token is not recoverable', () => {
  const inner = `claude --mcp-config '{"AGENT_DASHBOARD_API_TOKEN":"${FAKE_TOKEN}"}'`;
  const b64 = Buffer.from(inner, 'utf8').toString('base64');
  const tmuxCmd = `setsid tmux set-option -g history-limit 50000 \\; new-session -d -s 'x' -c '/h' -- bash -lic "$(echo ${b64} | base64 -d)"`;
  const out = redactMcpToken(tmuxCmd, FAKE_TOKEN);
  assert.ok(!out.includes(b64), 'base64 payload (which decodes to the token) must be stripped');
  assert.ok(!out.includes(FAKE_TOKEN), 'literal token must be absent');
  // And the stripped payload must not decode back to anything containing the token.
  const remaining = out.match(/[A-Za-z0-9+/=]{40,}/g) || [];
  for (const blob of remaining) {
    let decoded = '';
    try { decoded = Buffer.from(blob, 'base64').toString('utf8'); } catch { /* not b64 */ }
    assert.ok(!decoded.includes(FAKE_TOKEN), `a surviving base64 blob decoded back to the token: ${blob}`);
  }
});

test('redactMcpToken no-recover: a token rendered via buildTmuxNewSessionCommand leaves no decodable envelope', () => {
  // §1: the rendered command is now the quote-free outer envelope
  // `printf %s <OUTER_B64> | base64 -d | bash`, where OUTER_B64 double-decodes
  // back to the token-bearing inner command. The updated redactor must match the
  // `printf %s` form and strip the whole blob so nothing decodes back out.
  const inner = `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --mcp-config '{"mcpServers":{"agent-dashboard":{"env":{"AGENT_DASHBOARD_API_TOKEN":"${FAKE_TOKEN}"}}}}'`;
  const rendered = buildTmuxNewSessionCommand('s', '/h', inner);
  const redacted = redactMcpToken(rendered, FAKE_TOKEN);
  // (a) the literal token is absent.
  assert.ok(!redacted.includes(FAKE_TOKEN), 'literal token must be absent');
  // (b) no decodable base64 envelope remains: the placeholder
  // `***REDACTED***_BASE64` is not pure base64, so this pattern must NOT match.
  assert.ok(!/printf %s [A-Za-z0-9+/=]+ \| base64 -d/.test(redacted),
    `no decodable base64 envelope may remain in the redacted command; got: ${redacted}`);
  // And no surviving long base64 blob decodes back to the token (two layers).
  for (const blob of (redacted.match(/[A-Za-z0-9+/=]{40,}/g) || [])) {
    let once = '';
    try { once = Buffer.from(blob, 'base64').toString('utf8'); } catch { /* not b64 */ }
    let twice = '';
    try { twice = Buffer.from(once, 'base64').toString('utf8'); } catch { /* not b64 */ }
    assert.ok(!once.includes(FAKE_TOKEN) && !twice.includes(FAKE_TOKEN),
      `a surviving base64 blob decoded back to the token: ${blob}`);
  }
});

// ── BLOCKER: end-to-end — no token reaches launches.log ──────────────

test('redaction-proof: WslRunner.writeLaunchRecord never persists the token to launches.log (literal or base64)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-redact-'));
  const logPath = path.join(tmpDir, 'launches.log');
  try {
    const inner = `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false claude --mcp-config '{"mcpServers":{"agent-dashboard":{"env":{"AGENT_DASHBOARD_API_TOKEN":"${FAKE_TOKEN}"}}}}' --strict-mcp-config`;
    const b64 = Buffer.from(inner, 'utf8').toString('base64');
    const tmuxCommand = `setsid tmux set-option -g history-limit 50000 \\; new-session -d -s 's' -c '/h' -- bash -lic "$(echo ${b64} | base64 -d)"`;

    const diagnostics: WslLaunchDiagnostics = {
      launchStartedAt: '2026-06-14T00:00:00.000Z',
      launchesLogPath: logPath,
      agentId: 'a1', agentTitle: 'redact', workspaceId: 'ws', provider: 'claude',
      isSupervisor: false, isSupervised: true, resume: false, freshSession: false,
      redactSecret: FAKE_TOKEN,
    };

    // Subclass to reach the protected writeLaunchRecord with controlled private
    // state — exactly the fields launch() would have populated (with the
    // _launchCommand already redacted, matching production).
    class TestRunner extends WslRunner {
      seed(): void {
        const self = this as unknown as Record<string, unknown>;
        self._diagnostics = diagnostics;
        self._launchWorkDir = '/h';
        self._launchCommand = redactMcpToken(inner, FAKE_TOKEN); // as launch() does
        self._tmuxResult = { ok: true, exitCode: 0, stdout: '', stderr: '', tmuxCommand };
        self._attachAttempted = true;
      }
      fire(): void { (this as unknown as { writeLaunchRecord(c: number | null, s: string | null): void }).writeLaunchRecord(0, null); }
    }
    const r = new TestRunner('s');
    r.seed();
    r.fire();

    const written = fs.readFileSync(logPath, 'utf8');
    assert.ok(written.length > 0, 'a launch record should have been written');
    assert.ok(!written.includes(FAKE_TOKEN), 'launches.log must NOT contain the literal token');
    assert.ok(!written.includes(b64), 'launches.log must NOT contain the base64 envelope that decodes to the token');
    // Defense: no surviving base64 blob decodes back to the token.
    for (const blob of (written.match(/[A-Za-z0-9+/=]{40,}/g) || [])) {
      let decoded = '';
      try { decoded = Buffer.from(blob, 'base64').toString('utf8'); } catch { /* */ }
      assert.ok(!decoded.includes(FAKE_TOKEN), `launches.log base64 blob decoded to the token: ${blob}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildLaunchRecord: passthrough copies command verbatim (redaction is the caller\'s job — proven above)', () => {
  // Guards the contract that writeLaunchRecord (not buildLaunchRecord) owns
  // redaction: buildLaunchRecord faithfully serializes whatever it is handed,
  // so a redacted input yields a redacted record.
  const rec = buildLaunchRecord({
    diagnostics: {
      launchStartedAt: 'x', launchesLogPath: null, agentId: 'a', agentTitle: 't',
      workspaceId: 'w', provider: 'claude', isSupervisor: false, isSupervised: false,
      resume: false, freshSession: false,
    },
    sessionName: 's', workDir: '/h',
    command: redactMcpToken(`x --mcp-config '{"AGENT_DASHBOARD_API_TOKEN":"${FAKE_TOKEN}"}'`, FAKE_TOKEN),
    tmuxResult: null, attachAttempted: false, attachExitCode: 0, attachSignal: null,
    outputTail: '', nowIso: 'x',
  });
  assert.ok(!JSON.stringify(rec).includes(FAKE_TOKEN));
  // appendLaunchRecord is exported for the runner; just assert it's a function.
  assert.equal(typeof appendLaunchRecord, 'function');
});

// ── Source-scan grep gate ────────────────────────────────────────────

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'src', 'main', rel), 'utf8');
}

test('grep gate: index.ts no longer writes the dashboard/team token to a root .mcp.json', () => {
  const src = readSrc('supervisor/index.ts');
  assert.ok(!src.includes(`base64 -d > '${'${workDir}'}/.mcp.json'`),
    'the base64 WSL root .mcp.json write must be deleted (F9)');
  assert.ok(!src.includes('fs.writeFileSync(fullPath, configJson'),
    'the Windows root .mcp.json write must be deleted (F9)');
  assert.ok(!src.includes("existing.mcpServers[teamServerKey]"),
    'the team root .mcp.json merge must be deleted (F9)');
});

test('grep gate: WSL command serializations are wrapped in redactMcpToken (D-4/F10)', () => {
  const idx = readSrc('supervisor/index.ts');
  assert.ok(/redactMcpToken\(command, apiToken\)/.test(idx),
    'the [WSL] Command console log must redact the token');
  assert.ok(/redactSecret: apiToken/.test(idx),
    'the WSL diagnostics must carry redactSecret so the runner redacts the persisted command');

  const runner = readSrc('supervisor/wsl-runner.ts');
  assert.ok(runner.includes("import { redactMcpToken } from './mcp-config-builder'"),
    'wsl-runner must import redactMcpToken');
  assert.ok(/this\._launchCommand = safeCommand/.test(runner),
    'wsl-runner must store the REDACTED command for serialization');
  assert.ok(/redactMcpToken\(this\._tmuxResult\.tmuxCommand/.test(runner),
    'wsl-runner must redact the base64 tmux envelope before it reaches launches.log');
  // The runner must not reach for the token itself — redaction uses the passed secret.
  assert.ok(!runner.includes('getApiToken'),
    'wsl-runner must not call getApiToken (token flows in via redactSecret only)');
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
