#!/usr/bin/env node
// validate_templates.mjs — the skill's self-check harness.
//
//   --package    frontmatter + link resolution + agents/openai.yaml consistency
//   --static     symbol presence, legacy-identifier ban, standalone-probe
//                exception, policy-marker placement
//   --contract   targeted drift gate vs the authoritative server source
//   --behavioral --language <python|node|bash>   runner-owned mock + scenarios
//
// Every failure emits:  file:line — [RULE_ID] message (spec §X)
// The runner starts the mock on an ephemeral port, injects
// AGENT_DASHBOARD_API_PORT/_API_TOKEN (+ workspace/self ids), and tears it down.
// Tests use per-test OS temp dirs (fs.mkdtemp) — no repo residue.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, '..');           // package root
const A = (...p) => path.join(PKG, ...p);
const rel = (p) => path.relative(PKG, p).replace(/\\/g, '/');

const failures = [];
const fail = (file, line, ruleId, message, section) =>
  failures.push(`${rel(file)}:${line} — [${ruleId}] ${message} (spec ${section})`);
const info = (m) => process.stdout.write(`  ${m}\n`);

// ── file helpers ────────────────────────────────────────────────────────────
const read = (p) => fs.readFileSync(p, 'utf-8');
const exists = (p) => fs.existsSync(p);
function lineOf(text, idx) { return text.slice(0, idx).split('\n').length; }
function findWorkspaceRoot() {
  let d = PKG;
  for (let i = 0; i < 8; i += 1) {
    if (exists(path.join(d, 'src', 'main', 'api-server.ts'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

const CLIENT_FILES = {
  python: A('assets', 'python', 'lares_client.py'),
  node: A('assets', 'node', 'lares-client.mjs'),
};
const CORE_SYMBOLS = ['connectApi', 'launchAgent', 'waitReady', 'seedHighwater',
  'confirmedSend', 'kickoff', 'waitTurnComplete', 'waitReceiverReady', 'relay',
  'markRelayed', 'verifyArtifact', 'retire', 'reconcile', 'Highwater'];
const BASH_SUBSET = ['connect_api', 'launch_agent', 'wait_ready', 'seed_highwater',
  'confirmed_send', 'wait_turn_complete', 'verify_artifact', 'retire'];

// ════════════════════════════════════════════════════════════════════════════
// --package
// ════════════════════════════════════════════════════════════════════════════
function checkPackage() {
  info('package: frontmatter, links, agents/openai.yaml');
  const skillPath = A('SKILL.md');
  if (!exists(skillPath)) { fail(skillPath, 0, 'PKG_SKILL_MISSING', 'SKILL.md not found', '§C'); return; }
  const skill = read(skillPath);
  const fm = skill.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) { fail(skillPath, 1, 'PKG_FRONTMATTER', 'missing YAML frontmatter', '§D'); return; }
  const keys = [...fm[1].matchAll(/^([A-Za-z_]+):/gm)].map((m) => m[1]);
  const extra = keys.filter((k) => k !== 'name' && k !== 'description');
  if (!keys.includes('name')) fail(skillPath, 1, 'PKG_FM_NAME', 'frontmatter missing name', '§D');
  if (!keys.includes('description')) fail(skillPath, 1, 'PKG_FM_DESC', 'frontmatter missing description', '§D');
  for (const k of extra) fail(skillPath, 1, 'PKG_FM_EXTRA', `frontmatter has non-allowed key '${k}' (only name+description)`, '§D');
  const nameMatch = fm[1].match(/name:\s*(\S+)/);
  if (nameMatch && nameMatch[1] !== path.basename(PKG)) {
    fail(skillPath, 1, 'PKG_NAME_DIR', `name '${nameMatch[1]}' != dir '${path.basename(PKG)}'`, '§F1');
  }
  // provenance footer (commit + content-sha256), NOT in frontmatter
  if (!/content-sha256/.test(skill) || !/Derived from/.test(skill)) {
    fail(skillPath, lineOf(skill, skill.length), 'PKG_PROVENANCE', 'missing "Derived from … content-sha256" footer', '§I.3');
  }
  // internal links resolve
  for (const m of skill.matchAll(/\]\((references\/[^)]+|assets\/[^)]+)\)/g)) {
    const target = A(...m[1].split('/'));
    if (!exists(target)) fail(skillPath, lineOf(skill, m.index), 'PKG_LINK', `broken link ${m[1]}`, '§C');
  }
  // required references + assets present
  for (const f of ['api-contract.md', 'role-payloads.md', 'fixed-core-vs-policy.md', 'troubleshooting.md']) {
    if (!exists(A('references', f))) fail(A('references', f), 0, 'PKG_REF', `missing reference ${f}`, '§C');
  }
  // agents/openai.yaml consistency with SKILL.md name+description
  const yamlPath = A('agents', 'openai.yaml');
  if (!exists(yamlPath)) { fail(yamlPath, 0, 'PKG_OPENAI', 'agents/openai.yaml missing', '§C'); }
  else {
    const y = read(yamlPath);
    const yName = y.match(/name:\s*(\S+)/);
    if (yName && nameMatch && yName[1] !== nameMatch[1]) {
      fail(yamlPath, lineOf(y, y.indexOf('name')), 'PKG_OPENAI_NAME', `openai.yaml name '${yName[1]}' != SKILL name`, '§F1');
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// --static
// ════════════════════════════════════════════════════════════════════════════
function assetFiles() {
  const out = [];
  for (const dir of ['python', 'node', 'shell']) {
    const d = A('assets', dir);
    if (exists(d)) for (const f of fs.readdirSync(d)) out.push(path.join(d, f));
  }
  return out;
}

function checkStatic() {
  info('static: symbols, legacy ban, standalone exception, policy markers');
  // core symbol presence in Python & Node full clients
  for (const [lang, file] of Object.entries(CLIENT_FILES)) {
    const src = read(file);
    for (const sym of CORE_SYMBOLS) {
      const re = new RegExp(`\\b${sym}\\b`);
      if (!re.test(src)) fail(file, 0, 'STATIC_SYMBOL', `${lang} client missing core symbol ${sym}`, '§5/§E');
    }
    // fixed-core clients must carry NO policy markers
    const pm = src.match(/(#|\/\/)\s*user policy/i);
    if (pm) fail(file, lineOf(src, pm.index), 'STATIC_POLICY_IN_CORE', 'policy marker inside fixed-core client body', '§F2');
  }
  // Bash dispatcher subset (incl. stall-retention retire)
  const bash = A('assets', 'shell', 'dispatcher.sh');
  if (exists(bash)) {
    const src = read(bash);
    for (const fn of BASH_SUBSET) {
      if (!new RegExp(`${fn}\\s*\\(\\)`).test(src)) fail(bash, 0, 'STATIC_BASH_SUBSET', `dispatcher.sh missing ${fn}()`, '§E');
    }
    if (!/stall|retain|leave.?alive/i.test(src)) fail(bash, 0, 'STATIC_BASH_STALL', 'retire() lacks stall-retention (leave-alive) handling', '§E');
  } else fail(bash, 0, 'STATIC_BASH_MISSING', 'assets/shell/dispatcher.sh missing', '§E');

  // shape templates must declare their invoked-subset header
  for (const shape of [A('assets', 'python', 'dispatcher.py'), A('assets', 'python', 'scheduler.py'),
    A('assets', 'python', 'deliberation.py'), A('assets', 'python', 'pipeline.py'),
    A('assets', 'node', 'dispatcher.mjs'), A('assets', 'node', 'control-skeleton.mjs')]) {
    if (!exists(shape)) { fail(shape, 0, 'STATIC_SHAPE_MISSING', `shape template missing`, '§E'); continue; }
    const src = read(shape);
    if (!/Invoked core subset:/i.test(src)) fail(shape, 0, 'STATIC_SUBSET_HEADER', 'missing "Invoked core subset:" header', '§E');
  }

  // legacy-identifier ban across assets (except tests/fixtures/negative — not an asset)
  for (const file of assetFiles()) {
    const src = read(file);
    for (const m of src.matchAll(/\bAGENT_ID\b/g)) {
      fail(file, lineOf(src, m.index), 'STATIC_LEGACY_AGENT_ID', 'bare AGENT_ID — use AGENT_DASHBOARD_SELF_ID', '§0.2');
    }
    for (const m of src.matchAll(/\.dashboard\//g)) {
      fail(file, lineOf(src, m.index), 'STATIC_LEGACY_DASHBOARD', '.dashboard/ path — use .lares/', '§0.2');
    }
    // standalone-probe exception: 24678..24681 only on the STANDALONE_PORT_RANGE line
    for (const m of src.matchAll(/246(78|79|80|81)/g)) {
      const ln = lineOf(src, m.index);
      const lineText = src.split('\n')[ln - 1];
      if (!/STANDALONE_PORT_RANGE/.test(lineText)) {
        fail(file, ln, 'STATIC_PORT_LITERAL', 'standalone port literal outside connectApi STANDALONE_PORT_RANGE', '§F2');
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// --contract  (targeted drift gate vs authoritative source, spec §0.1/§8)
// ════════════════════════════════════════════════════════════════════════════
function checkContract() {
  info('contract: targeted drift gate vs authoritative server source');
  const root = findWorkspaceRoot();
  if (!root) { fail(A('.'), 0, 'CONTRACT_NO_SRC', 'authoritative src/ not found from package (run in-repo)', '§I'); return; }
  const S = (...p) => path.join(root, ...p);
  const manifest = [
    ['src/main/api-server.ts', /code:\s*'unknown-workspace'/, 'resolveIdentity 403 unknown-workspace', '§1.6'],
    ['src/main/api-server.ts', /code:\s*'workspace-scope-mismatch'/, 'resolveWorkspaceScope 403', '§1.6'],
    ['src/main/api-server.ts', /code:\s*'not-a-supervisor'/, 'supervisor-rail 403 not-a-supervisor', '§1.6'],
    ['src/main/api-server.ts', /statusCode:\s*409/, '/input 409 busy gate', '§2.6'],
    ['src/main/api-server.ts', /input\.ownerAgentId\s*=\s*input\.owner_agent_id/, 'owner_agent_id→ownerAgentId normalization', '§1.4'],
    ['src/main/api-server.ts', /input\.planId\s*=\s*input\.plan_id/, 'plan_id→planId normalization', '§1.3'],
    ['src/main/api-server.ts', /Unknown plan_id[\s\S]{0,200}statusCode:\s*400/, 'unknown plan_id → 400', '§1.6'],
    ['src/main/api-server.ts', /`X-Self-Id` is\s*\n?\s*\/\/\s*deliberately NOT read|deliberately NOT read here/, 'X-Self-Id not read by resolveIdentity', '§1.2'],
    ['src/main/supervisor/index.ts', /if\s*\(a\.isSupervisor\)\s*return\s*'supervisor'/, 'roleLaneOf: supervisor wins', '§1.4'],
    ['src/main/supervisor/index.ts', /if\s*\(a\.isResearcher\)\s*return\s*'researcher'/, 'roleLaneOf: researcher precedence', '§1.4'],
    ['src/main/supervisor/index.ts', /if\s*\(a\.isSupervised\s*\|\|\s*a\.isWorker\)\s*return\s*'worker'/, 'roleLaneOf: isSupervised implies worker', '§1.4'],
    ['src/main/supervisor/index.ts', /dropping owner edge/, 'owner-edge drop-never-throw', '§1.4'],
    ['src/shared/types.ts', /interface LaunchAgentInput/, 'LaunchAgentInput shape', '§8'],
  ];
  const LAUNCH_FIELDS = ['workspaceId', 'isSupervisor', 'isSupervised', 'isResearcher',
    'ownerAgentId', 'notifyOwner', 'freshSession', 'firstUserMessagePrefix', 'planId', 'planSection'];
  for (const [f, re, label, section] of manifest) {
    const p = S(...f.split('/'));
    if (!exists(p)) { fail(p, 0, 'CONTRACT_FILE', `authoritative file missing: ${f}`, section); continue; }
    if (!re.test(read(p))) fail(p, 0, 'CONTRACT_DRIFT', `contract drifted: ${label}`, section);
  }
  const typesSrc = exists(S('src/shared/types.ts')) ? read(S('src/shared/types.ts')) : '';
  const block = (typesSrc.match(/interface LaunchAgentInput\s*\{[\s\S]*?\n\}/) || [''])[0];
  for (const field of LAUNCH_FIELDS) {
    if (!new RegExp(`\\b${field}\\??:`).test(block)) {
      fail(S('src/shared/types.ts'), 0, 'CONTRACT_LAUNCH_FIELD', `LaunchAgentInput missing field the skill depends on: ${field}`, '§8');
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// --behavioral --language <lang>
// ════════════════════════════════════════════════════════════════════════════
const TOKEN = 'test-token-xyz';
const BASE_ENV = {
  AGENT_DASHBOARD_API_TOKEN: TOKEN,
  AGENT_DASHBOARD_WORKSPACE_ID: 'ws-test',
  AGENT_DASHBOARD_SELF_ID: 'self-test',
  LARES_POLL_MS: '40',
  LARES_READY_TIMEOUT_MS: '6000',
  LARES_FLUSH_GRACE_MS: '0',
  LARES_MAX_409_RETRIES: '6',
  LARES_MAX_SUBMIT_RECOVERY: '3',
  LARES_SUPERVISOR_409_RETRIES: '3',
};

function startMock(scenario) {
  const child = spawn(process.execPath, [A('scripts', 'mock_lares_server.mjs'),
    '--scenario', scenario, '--token', TOKEN, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('mock did not report a port')), 5000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/MOCK_LISTENING (\d+)/);
      if (m) { clearTimeout(t); resolve({ child, port: parseInt(m[1], 10) }); }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[mock] ${d}`));
    child.on('error', reject);
  });
}

function runProc(cmd, cmdArgs, env, cwd) {
  const r = spawnSync(cmd, cmdArgs, { env: { ...process.env, ...env }, cwd, encoding: 'utf-8', timeout: 30000 });
  return r;
}

function parseTrace(stdout) {
  const events = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^TRACE (.*)$/);
    if (m) { try { events.push(JSON.parse(m[1])); } catch { /* ignore */ } }
  }
  return events;
}

// semantic / partial-order assertions per scenario
function assertScenario(name, ev) {
  const errs = [];
  const has = (t) => ev.some((e) => e.event === t);
  const all = (t) => ev.filter((e) => e.event === t);
  const one = (t) => ev.find((e) => e.event === t);
  const check = (cond, msg) => { if (!cond) errs.push(msg); };
  switch (name) {
    case '1':
      check(has('retry_after_409'), 'expected a retry after 409');
      check(one('kickoff')?.confirmed === true, 'kickoff should be confirmed after retry');
      check(has('turn_complete'), 'expected turn_complete');
      check(one('result')?.status === 'complete', 'turn should complete');
      break;
    case '2':
      check(one('kickoff')?.confirmed === false, 'kickoff should be delivered-unconfirmed');
      check(one('kickoff')?.full_sends === 1, 'exactly one full prompt (no 2nd)');
      check(all('enter_press').length === 0, 'no Enter re-press when newer activity present');
      check(one('kickoff')?.started === true, 'newer activity ⇒ turn recognized as started');
      break;
    case '3': {
      const tcs = all('turn_complete');
      check(tcs.length === 2, `expected 2 turn_completes, got ${tcs.length}`);
      const hws = all('mark_relayed').map((e) => e.hw);
      check(hws.length === 2 && hws[0] !== hws[1], 'composite highwater must distinguish same-ts turns');
      check(hws.every((h) => h.startsWith('200|')), 'both turns share ts=200 (composite by hash)');
      break;
    }
    case '4': {
      const seed = one('seed');
      check(seed?.reseed === false, 'must NOT reseed a valid persisted highwater');
      check(seed?.hw === seed?.persisted, 'seed must preserve the persisted highwater');
      break;
    }
    case '5':
      check(has('turn_complete'), 'idle-before-message must not be treated as terminal');
      check(one('result')?.status === 'complete', 'late completion should still complete');
      break;
    case '6':
      check(one('token')?.value === 'PASS', 'newest-first token wins (PASS over stale FAIL)');
      break;
    case '7': {
      const stale = ev.find((e) => e.event === 'verify' && e.case === 'stale');
      const fresh = ev.find((e) => e.event === 'verify' && e.case === 'fresh');
      check(stale?.ok === false && stale?.reason === 'stale', 'stale artifact must fail verify');
      check(fresh?.ok === true && fresh?.reason === 'fresh', 'hash-changed artifact must verify');
      break;
    }
    case '8':
      check(one('classified')?.status === 'stalled', 'no-progress must classify as stalled');
      check(all('delete').length === 0, 'a recoverable stall must NOT delete members');
      check(has('retain'), 'stalled members must be retained');
      check((one('resume_hint')?.members || []).length >= 1, 'resume_hint must name members');
      break;
    case '9': {
      const launched = all('launch').map((e) => e.id);
      const deleted = all('delete').map((e) => e.id);
      check(deleted.length === launched.length, 'all members retired');
      check(JSON.stringify(deleted) === JSON.stringify([...launched].reverse()), 'retire in reverse launch order');
      break;
    }
    case '10':
      check(one('delivery')?.delivered === false, 'persistent 409 ⇒ not delivered');
      check(has('sentinel'), 'undelivered notice must write a sentinel');
      check(one('delivery')?.exists === true, 'sentinel file must exist on disk');
      break;
    default: errs.push(`no assertions defined for scenario ${name}`);
  }
  return errs;
}

async function runScenario(lang, scenario, driverCmd) {
  const { child, port } = await startMock(scenario);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-skill-'));
  let ok = false;
  try {
    const env = { ...BASE_ENV, AGENT_DASHBOARD_API_PORT: String(port), LARES_TMPDIR: tmp };
    const r = runProc(driverCmd.cmd, driverCmd.args(scenario), env, PKG);
    if (r.error) { fail(A('scripts', 'validate_templates.mjs'), 0, 'BEHAVIOR_SPAWN', `${lang} scenario ${scenario}: ${r.error.message}`, '§G'); return; }
    const events = parseTrace(r.stdout || '');
    const errs = assertScenario(scenario, events);
    if (r.status !== 0 && errs.length === 0) errs.push(`driver exited ${r.status}: ${(r.stderr || '').slice(-300)}`);
    if (errs.length) {
      for (const e of errs) fail(A('tests', 'scenarios', `${lang}:${scenario}`), 0, 'BEHAVIOR', e, '§G');
      process.stderr.write(`    [preserved temp] ${tmp}\n    [stderr] ${(r.stderr || '').slice(-400)}\n`);
    } else { ok = true; info(`behavioral ${lang} scenario ${scenario}: ok`); }
  } finally {
    child.kill();
    if (ok) fs.rmSync(tmp, { recursive: true, force: true }); // preserve only on failure
  }
}

function pyCompile(file) {
  const r = spawnSync('python', ['-m', 'py_compile', file], { encoding: 'utf-8' });
  if (r.status !== 0) fail(file, 0, 'BEHAVIOR_SYNTAX', `py_compile failed: ${(r.stderr || '').slice(-200)}`, '§K');
}
function nodeCheck(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8' });
  if (r.status !== 0) fail(file, 0, 'BEHAVIOR_SYNTAX', `node --check failed: ${(r.stderr || '').slice(-200)}`, '§K');
}

async function checkBehavioralPython() {
  info('behavioral: python (shared client suite 1–10 + shape syntax/smoke)');
  const python = process.env.PYTHON || 'python';
  for (const f of ['lares_client.py', 'dispatcher.py', 'scheduler.py', 'deliberation.py', 'pipeline.py']) pyCompile(A('assets', 'python', f));
  const driver = { cmd: python, args: (s) => [A('tests', 'scenarios', 'driver.py'), '--scenario', s] };
  for (const s of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']) await runScenario('python', s, driver);
  await runShapeSmoke('python', { cmd: python, args: () => [A('tests', 'scenarios', 'shape_smoke.py')] });
}

async function checkBehavioralNode() {
  info('behavioral: node (shared client suite 1–10 + control-skeleton + dispatcher smoke)');
  for (const f of ['lares-client.mjs', 'dispatcher.mjs', 'control-skeleton.mjs']) nodeCheck(A('assets', 'node', f));
  const driver = { cmd: process.execPath, args: (s) => [A('tests', 'scenarios', 'driver.mjs'), '--scenario', s] };
  for (const s of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']) await runScenario('node', s, driver);
  await runShapeSmoke('node', { cmd: process.execPath, args: () => [A('tests', 'scenarios', 'shape_smoke.mjs')] });
}

// dispatcher/control-skeleton compose smoke: one launch→kickoff→complete against --scenario happy
async function runShapeSmoke(lang, driverCmd) {
  const { child, port } = await startMock('happy');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-smoke-'));
  let ok = false;
  try {
    const env = { ...BASE_ENV, AGENT_DASHBOARD_API_PORT: String(port), LARES_TMPDIR: tmp };
    const r = runProc(driverCmd.cmd, driverCmd.args(), env, PKG);
    const events = parseTrace(r.stdout || '');
    const good = events.some((e) => e.event === 'smoke' && e.ok === true);
    if (!good || r.status !== 0) fail(A('tests', 'scenarios', `${lang}:shape-smoke`), 0, 'BEHAVIOR_SMOKE', `dispatcher/control compose smoke failed: ${(r.stderr || '').slice(-300)}`, '§G');
    else { ok = true; info(`behavioral ${lang} shape-smoke: ok`); }
  } finally {
    child.kill();
    if (ok) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function locateGitBash() {
  for (const p of ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe']) if (exists(p)) return p;
  return 'bash';
}

async function checkBehavioralBash() {
  info('behavioral: bash (shellcheck + dispatcher scenarios 1,3,5,7,8,9)');
  const bashScenarios = ['1', '3', '5', '7', '8', '9'];
  // shellcheck: prefer local binary, else WSL. Non-fatal-skip if neither present.
  const scLocal = spawnSync('shellcheck', ['--version'], { encoding: 'utf-8' });
  let ran = false;
  const target = A('assets', 'shell', 'dispatcher.sh');
  const driverSh = A('tests', 'scenarios', 'driver.sh');
  if (scLocal.status === 0) {
    ran = true;
    const r = spawnSync('shellcheck', ['-S', 'warning', target, driverSh], { encoding: 'utf-8' });
    if (r.status !== 0) fail(target, 0, 'BEHAVIOR_SHELLCHECK', `shellcheck: ${(r.stdout || r.stderr || '').slice(-400)}`, '§K');
    else info('shellcheck: ok (local)');
  } else {
    const wsl = spawnSync('wsl', ['bash', '-lc', 'command -v shellcheck'], { encoding: 'utf-8' });
    if (wsl.status === 0 && (wsl.stdout || '').trim()) {
      ran = true;
      const toWsl = (p) => spawnSync('wsl', ['wslpath', '-a', p], { encoding: 'utf-8' }).stdout.trim();
      const r = spawnSync('wsl', ['shellcheck', '-S', 'warning', toWsl(target), toWsl(driverSh)], { encoding: 'utf-8' });
      if (r.status !== 0) fail(target, 0, 'BEHAVIOR_SHELLCHECK', `shellcheck(wsl): ${(r.stdout || r.stderr || '').slice(-400)}`, '§K');
      else info('shellcheck: ok (wsl)');
    }
  }
  if (!ran) info('shellcheck: SKIPPED (no local or WSL shellcheck) — install for CI');
  // scenario runs via Git Bash (native, reaches 127.0.0.1 mock)
  const bash = locateGitBash();
  const probe = spawnSync(bash, ['-c', 'command -v curl && command -v jq && command -v sha256sum'], { encoding: 'utf-8' });
  if (probe.status !== 0) {
    fail(target, 0, 'BEHAVIOR_BASH_DEPS', `bash deps missing (need curl+jq+sha256sum): ${(probe.stdout || probe.stderr || '').slice(-200)}`, '§K');
    return;
  }
  const driver = { cmd: bash, args: (s) => [driverSh, '--scenario', s] };
  for (const s of bashScenarios) await runScenario('bash', s, driver);
}

// ════════════════════════════════════════════════════════════════════════════
async function main() {
  const args = process.argv.slice(2);
  const langIdx = args.indexOf('--language');
  const language = langIdx >= 0 ? args[langIdx + 1] : null;
  let ran = false;
  if (args.includes('--package')) { checkPackage(); ran = true; }
  if (args.includes('--static')) { checkStatic(); ran = true; }
  if (args.includes('--contract')) { checkContract(); ran = true; }
  if (args.includes('--behavioral')) {
    ran = true;
    if (language === 'python') await checkBehavioralPython();
    else if (language === 'node') await checkBehavioralNode();
    else if (language === 'bash') await checkBehavioralBash();
    else { process.stderr.write('--behavioral requires --language python|node|bash\n'); process.exit(2); }
  }
  if (!ran) { process.stderr.write('usage: validate_templates.mjs --package|--static|--contract|--behavioral --language <lang>\n'); process.exit(2); }
  if (failures.length) {
    process.stderr.write(`\nFAIL (${failures.length}):\n${failures.map((f) => '  ' + f).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('OK\n');
}
main().catch((e) => { process.stderr.write(`validator crashed: ${e.stack}\n`); process.exit(3); });
