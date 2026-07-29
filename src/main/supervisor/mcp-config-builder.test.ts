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
import { builtinModules } from 'node:module';
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

test('toolsetsForLane: supervisor gets orchestration/comms/observability-core/plans + browser-present (NO teams/full browser/notebooks/analytics)', () => {
  // QW1 (context-optimizer §3): `teams` dropped from the supervisor grant.
  // Planning-surface demo (2026-07-06): `plans` added to the supervisor lane.
  // WP-F (P5) split observability into core + analytics and gave the supervisor
  // both; the analytics half has since been RETIRED (all 13 tools deleted,
  // replaced by the on-demand snapshot exporter + the `context-analytics` skill),
  // so it is gone from this grant.
  // WP-G2.3 appended `checkpoints` (supervisor-lane-only recovery toolset).
  // WP-D (Memory & Lessons v2) appended `memory` (recall_memory; both lanes).
  // WP-F2 (Memory & Lessons v2) appended `migration` (supervisor-lane-only).
  assert.equal(toolsetsForLane('supervisor'), 'orchestration,comms,observability-core,plans,browser-present,checkpoints,memory,migration');
});

test('toolsetsForLane: the full `plans` grant is supervisor-ONLY (not worker/researcher/legacy)', () => {
  // GT-A WP-A4 (I-1): the supervisor keeps the full `plans` toolset (create + read).
  // Workers get the read-only `plans-read` subset — a DISTINCT grant, not `plans`.
  assert.ok(toolsetsForLane('supervisor').split(',').includes('plans'));
  for (const lane of ['worker', 'researcher', 'legacy'] as const) {
    assert.ok(!toolsetsForLane(lane).split(',').includes('plans'), `${lane} must NOT include the full plans grant`);
  }
});

test('toolsetsForLane: worker gets the read-only plans-read subset, NOT the full plans grant', () => {
  // GT-A WP-A4 (I-1): plans-read added so a plan-bound worker can orient/read/
  // observe under --strict-mcp-config; create_plan + write stay supervisor-native.
  const grant = toolsetsForLane('worker').split(',');
  assert.ok(grant.includes('plans-read'), 'worker must include plans-read');
  assert.ok(!grant.includes('plans'), 'worker must NOT include the full plans grant');
});

test('toolsetsForLane: plans-read is granted to the worker lane ONLY (not supervisor/researcher/legacy)', () => {
  assert.ok(toolsetsForLane('worker').split(',').includes('plans-read'));
  for (const lane of ['supervisor', 'researcher', 'legacy'] as const) {
    assert.ok(!toolsetsForLane(lane).split(',').includes('plans-read'), `${lane} must NOT include plans-read`);
  }
});

test('toolsetsForLane: worker gets comms,observability-core,browser-present + plans-read (no notebooks/orchestration/full browser/analytics)', () => {
  // QW1 (context-optimizer §3): `notebooks` dropped from the worker grant.
  // GT-A WP-A4: `plans-read` appended.
  // WP-F (P5): `observability` → `observability-core`; the analytics half is dropped.
  // WP-D (Memory & Lessons v2): `memory` appended (recall_memory; both lanes).
  assert.equal(toolsetsForLane('worker'), 'comms,observability-core,browser-present,plans-read,memory');
});

test('observability-core is supervisor+worker; the retired observability-analytics is granted to NO lane', () => {
  const sup = toolsetsForLane('supervisor').split(',');
  const worker = toolsetsForLane('worker').split(',');
  assert.ok(sup.includes('observability-core'), 'supervisor must include observability-core');
  assert.ok(worker.includes('observability-core'), 'worker must include observability-core');
  // The analytics toolset was retired outright — no lane may name it, not even
  // the supervisor that used to hold it exclusively. Granting a name the proxy no
  // longer registers would fail OPEN (the entry is logged and ignored), so this
  // has to be asserted at the grant layer rather than left to the proxy.
  for (const lane of ['supervisor', 'worker', 'researcher', 'legacy'] as const) {
    assert.ok(!toolsetsForLane(lane).split(',').includes('observability-analytics'),
      `${lane} must NOT grant the retired observability-analytics toolset`);
    // The bare (pre-split) `observability` union grant is granted to no lane either.
    assert.ok(!toolsetsForLane(lane).split(',').includes('observability'),
      `${lane} must not grant the bare pre-split observability union`);
  }
});

test('toolsetsForLane: the `memory` toolset (recall_memory) is granted to BOTH the supervisor and worker lanes (WP-D)', () => {
  // Memory & Lessons v2 WP-D: both lanes recall closed-capsule detail on demand.
  for (const lane of ['supervisor', 'worker'] as const) {
    assert.ok(toolsetsForLane(lane).split(',').includes('memory'), `${lane} must include the memory toolset`);
  }
  // Not leaked to the researcher / legacy lanes (they get no memory recall).
  for (const lane of ['researcher', 'legacy'] as const) {
    assert.ok(!toolsetsForLane(lane).split(',').includes('memory'), `${lane} must NOT include the memory toolset`);
  }
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

// ── WP-G2.3: the `checkpoints` recovery toolset is supervisor-lane ONLY ──────
// Shape §8.3: checkpoint recovery tools are supervisor-tier + human, NEVER
// workers/researchers. Toolset-hiding is defense-in-depth; the real boundary is
// the minted capability token the /api/checkpoints* routes require (WP-G2.0/2.1)
// — the server-side rejection of a non-supervisor caller is proven in
// api-server-checkpoints.test.ts ("a minted worker credential … is refused
// (supervisor-tier)"). Here we own the config/grant side.

test('toolsetsForLane: the supervisor grant contains the `checkpoints` toolset (WP-G2.3)', () => {
  assert.ok(toolsetsForLane('supervisor').split(',').includes('checkpoints'),
    'supervisor must be granted the checkpoints recovery toolset');
});

test('toolsetsForLane: `checkpoints` is granted to the supervisor lane ONLY (never worker/researcher/legacy)', () => {
  // Shape §8.3: recovery tools NEVER reach workers. This asserts the grant layer
  // hides the toolset from every non-supervisor lane (belt-and-suspenders behind
  // the capability-token authorization the routes enforce).
  assert.ok(toolsetsForLane('supervisor').split(',').includes('checkpoints'));
  for (const lane of ['worker', 'researcher', 'legacy'] as const) {
    assert.ok(!toolsetsForLane(lane).split(',').includes('checkpoints'),
      `${lane} must NOT be granted the checkpoints toolset (shape §8.3: never workers)`);
  }
});

// ── WP-F2: the `migration` toolset is supervisor-lane ONLY ──────────────────
// Memory & Lessons v2 WP-F2: the guarded batch/bundle memory-migration
// operations (publish_lessons_batch / replace_memory_bundle /
// restore_memory_bundle) are supervisor-tier + human sign-off (a recorded
// migration approval gates every bundle op). They must NEVER reach the worker
// lane — that is the acceptance criterion "the migration toolset is absent from
// the worker grant."

test('toolsetsForLane: the `migration` toolset is granted to the supervisor lane ONLY (never worker/researcher/legacy) (WP-F2)', () => {
  assert.ok(toolsetsForLane('supervisor').split(',').includes('migration'),
    'supervisor must be granted the migration toolset');
  for (const lane of ['worker', 'researcher', 'legacy'] as const) {
    assert.ok(!toolsetsForLane(lane).split(',').includes('migration'),
      `${lane} must NOT be granted the migration toolset (WP-F2: supervisor-only)`);
  }
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
  // Plan §5.4 / F4: a Windows-typed sidecar runs on the Node runtime bundled
  // inside Electron, never a system `node` (a clean machine has none).
  assert.equal(srv.command, process.execPath);
  assert.notEqual(srv.command, 'node');
  assert.equal(srv.env.ELECTRON_RUN_AS_NODE, '1');
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
  // Plan §5.4: the WSL branch deliberately KEEPS the literal `node` — the
  // Windows Lares.exe cannot execute inside the distro. Node-in-WSL stays a
  // WSL-workspace-only prerequisite.
  assert.equal(srv.command, 'node');
  assert.equal(srv.env.ELECTRON_RUN_AS_NODE, undefined,
    'an Electron marker inside WSL would be meaningless and inherited by the agent');
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

// ── identityEnv pass-through (GT-A WP-A4 / D-2) ──────────────────────

test('buildDashboardMcpConfigArg: merges identityEnv into the windows env dict', () => {
  const parsed = JSON.parse(buildDashboardMcpConfigArg({
    toolsets: 'comms,observability,browser-present,plans-read',
    pathType: 'windows',
    scriptPath: WIN_SCRIPT,
    apiPort: 24681,
    apiToken: FAKE_TOKEN,
    identityEnv: {
      AGENT_DASHBOARD_SELF_ID: 'agent-w',
      AGENT_DASHBOARD_WORKSPACE_ID: 'ws-1',
      AGENT_DASHBOARD_PLAN_ID: 'plan-77',
      AGENT_DASHBOARD_PLAN_SECTION: 'sec_abc',
    },
  }));
  const env = parsed.mcpServers['agent-dashboard'].env;
  assert.equal(env.AGENT_DASHBOARD_SELF_ID, 'agent-w');
  assert.equal(env.AGENT_DASHBOARD_WORKSPACE_ID, 'ws-1');
  assert.equal(env.AGENT_DASHBOARD_PLAN_ID, 'plan-77');
  assert.equal(env.AGENT_DASHBOARD_PLAN_SECTION, 'sec_abc');
  // fixed API keys still present + correct.
  assert.equal(env.AGENT_DASHBOARD_API_TOKEN, FAKE_TOKEN);
  assert.equal(env.AGENT_DASHBOARD_API_PORT, '24681');
  assert.equal(env.DASHBOARD_MCP_TOOLSETS, 'comms,observability,browser-present,plans-read');
});

test('buildDashboardMcpConfigArg: merges identityEnv (incl. supervisor id) into the WSL env dict', () => {
  const parsed = JSON.parse(buildDashboardMcpConfigArg({
    toolsets: 'orchestration,comms,observability,plans,browser-present',
    pathType: 'wsl',
    scriptPath: WIN_SCRIPT,
    apiPort: 24681,
    apiToken: FAKE_TOKEN,
    wslHostIp: '172.22.208.1',
    identityEnv: {
      AGENT_DASHBOARD_SELF_ID: 'sup-1',
      AGENT_DASHBOARD_WORKSPACE_ID: 'ws-1',
      AGENT_DASHBOARD_SUPERVISOR_ID: 'sup-1',
    },
  }));
  const env = parsed.mcpServers['agent-dashboard'].env;
  assert.equal(env.AGENT_DASHBOARD_SUPERVISOR_ID, 'sup-1');
  assert.equal(env.AGENT_DASHBOARD_SELF_ID, 'sup-1');
  assert.equal(env.AGENT_DASHBOARD_WORKSPACE_ID, 'ws-1');
  assert.equal(env.AGENT_DASHBOARD_API_HOST, '172.22.208.1');
  assert.equal(env.AGENT_DASHBOARD_API_TOKEN, FAKE_TOKEN);
});

test('buildDashboardMcpConfigArg: a hostile identityEnv CANNOT override token/host/port/toolsets', () => {
  // identityEnv is spread FIRST, so the fixed API keys always win — proven on
  // both branches (windows has no HOST key, WSL does).
  const hostile = {
    AGENT_DASHBOARD_API_TOKEN: 'ATTACKER-TOKEN',
    AGENT_DASHBOARD_API_PORT: '9',
    AGENT_DASHBOARD_API_HOST: 'evil.example',
    DASHBOARD_MCP_TOOLSETS: 'orchestration',
    AGENT_DASHBOARD_SELF_ID: 'agent-w',
  };
  const win = JSON.parse(buildDashboardMcpConfigArg({
    toolsets: 'plans-read', pathType: 'windows', scriptPath: WIN_SCRIPT,
    apiPort: 24681, apiToken: FAKE_TOKEN, identityEnv: hostile,
  })).mcpServers['agent-dashboard'].env;
  assert.equal(win.AGENT_DASHBOARD_API_TOKEN, FAKE_TOKEN, 'token must not be clobbered');
  assert.equal(win.AGENT_DASHBOARD_API_PORT, '24681', 'port must not be clobbered');
  assert.equal(win.DASHBOARD_MCP_TOOLSETS, 'plans-read', 'toolsets must not be clobbered');
  assert.equal(win.AGENT_DASHBOARD_SELF_ID, 'agent-w', 'non-conflicting identity still lands');

  const wsl = JSON.parse(buildDashboardMcpConfigArg({
    toolsets: 'plans-read', pathType: 'wsl', scriptPath: WIN_SCRIPT,
    apiPort: 24681, apiToken: FAKE_TOKEN, wslHostIp: '172.22.208.1', identityEnv: hostile,
  })).mcpServers['agent-dashboard'].env;
  assert.equal(wsl.AGENT_DASHBOARD_API_TOKEN, FAKE_TOKEN, 'token must not be clobbered (wsl)');
  assert.equal(wsl.AGENT_DASHBOARD_API_PORT, '24681', 'port must not be clobbered (wsl)');
  assert.equal(wsl.AGENT_DASHBOARD_API_HOST, '172.22.208.1', 'host must not be clobbered (wsl)');
  assert.equal(wsl.DASHBOARD_MCP_TOOLSETS, 'plans-read', 'toolsets must not be clobbered (wsl)');
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

test('buildDashboardMcpConfigArg windows: a hostile identityEnv cannot clobber the runtime flag', () => {
  const parsed = JSON.parse(buildDashboardMcpConfigArg({
    toolsets: 'browser', pathType: 'windows', scriptPath: WIN_SCRIPT, apiPort: 1, apiToken: FAKE_TOKEN,
    identityEnv: { ELECTRON_RUN_AS_NODE: '0', AGENT_DASHBOARD_API_TOKEN: 'stolen' },
  }));
  const srv = parsed.mcpServers['agent-dashboard'];
  assert.equal(srv.env.ELECTRON_RUN_AS_NODE, '1',
    'identityEnv is spread FIRST — the fixed keys must win');
  assert.equal(srv.env.AGENT_DASHBOARD_API_TOKEN, FAKE_TOKEN);
});

// ── §5.4a external-helper dependency closure ─────────────────────────
//
// The MCP sidecar scripts stay in `resources/scripts/` (an agent CLI launches
// them by absolute path, and the WSL ones must be real files a Linux `node` can
// read — they cannot move into the asar). From there NO node_modules is on the
// resolution path, so they may only require Node builtins. Measured 2026-07-20:
// they require exactly http/fs/readline plus siblings, so no dependency closure
// needs to be shipped. This test is what keeps that true.

test('closure gate: resources/scripts MCP sidecars require only builtins and siblings', () => {
  const scriptsDir = path.join(process.cwd(), 'scripts');
  const entries = fs.readdirSync(scriptsDir)
    .filter((f) => /^mcp-.*\.js$/.test(f) && !f.endsWith('.test.js'));
  assert.ok(entries.length >= 4, `expected the mcp-*.js sidecars in ${scriptsDir}; found ${entries.length}`);

  const builtins = new Set(builtinModules);
  const offenders: string[] = [];
  for (const file of entries) {
    const src = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
    for (const m of src.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
      const spec = m[2];
      if (spec.startsWith('.')) {
        // A sibling is fine; reaching into ../dist would land outside
        // resources/scripts when packaged and must never appear here.
        if (spec.includes('..')) offenders.push(`${file}: require('${spec}') escapes resources/scripts`);
        continue;
      }
      if (!builtins.has(spec.replace(/^node:/, ''))) {
        offenders.push(`${file}: require('${spec}') is a third-party dep with no node_modules on its path`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    'plan §5.4a: adding a third-party require to an MCP sidecar means shipping its ' +
    'transitive prod closure into resources/scripts/node_modules — do that deliberately, ' +
    'then update this gate.\n' + offenders.join('\n'));
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
  // WP0.5 (cross-workspace-collaboration): the WSL command now embeds the
  // per-agent capabilityToken (not getApiToken()), so the console log routes
  // through redactSecrets, which scrubs BOTH that token and the global bearer.
  assert.ok(/this\.redactSecrets\(command, capabilityToken\)/.test(idx),
    'the [WSL] Command console log must redact the token via redactSecrets');
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
