// Scaffold version migration tests — plans/scaffold-version-migration.md §Tests.
//
// Exercises the v2 algorithm in AgentSupervisor.writeScaffoldMap:
//   1. Fresh workspace → write + sidecar.
//   2. v1 dashboard-status.mjs + no sidecar → silent upgrade by hash match.
//   3. v1-ish but user-modified file → backup + overwrite.
//   4. Already-v2 sidecar + matching file → no-op (mtime preserved).
//   5. Corrupt sidecar → treat as empty, upgrade, replace sidecar.
//   6. Two concurrent ensureWorkerScaffold calls → parseable sidecar, complete
//      file content, at most one backup.
//
// Plus a builder check that the v1 hash constant matches the documented
// pre-DASHBOARD_HOST script content.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/scaffold-version-migration.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentSupervisor,
  DASHBOARD_STATUS_SCRIPT_V1_HASH,
  DASHBOARD_STATUS_SCRIPT_V2_HASH,
  REMEMBER_SKILL_V1_HASH,
  SCAFFOLD_SIDECAR_REL,
  SUPERVISOR_AGENT_MD_V8_HASH,
  SUPERVISOR_AGENT_MD_V9_HASH,
  SUPERVISOR_AGENT_MD_V10_HASH,
  SUPERVISOR_AGENT_MD_V11_HASH,
  SUPERVISOR_AGENT_MD_V12_HASH,
  SUPERVISOR_AGENT_MD_V13_HASH,
  SUPERVISOR_AGENT_MD_V14_HASH,
  SUPERVISOR_AGENT_MD_V15_HASH,
  SUPERVISOR_AGENT_MD_V16_HASH,
  SUPERVISOR_AGENT_MD_V17_HASH,
  SUPERVISOR_AGENT_MD_V18_HASH,
  SUPERVISOR_AGENT_MD_V19_HASH,
  SUPERVISOR_RUN_ORCHESTRATION_SKILL_V4_HASH,
  WORKER_CLAUDE_MD_V8_HASH,
  WORKER_CODEX_AGENTS_MD_V1_HASH,
  GUARD_GIT_DISCARD_MJS_V1_HASH,
  GUARD_GIT_DISCARD_MJS_V2_HASH,
  RESEARCH_WRITE_GUARD_MJS_V3_HASH,
  RESEARCH_WRITE_GUARD_MJS_V4_HASH,
  SUPERVISOR_ORCHESTRATION_SPIKE_SKILL_V1_HASH,
  SUPERVISOR_ORCHESTRATION_SPIKE_SKILL_V2_HASH,
  WORKER_CLAUDE_MD_V6_HASH,
  WORKER_CLAUDE_MD_V7_HASH,
  RESEARCHER_AGENT_MD_V5_HASH,
  WORKER_CLAUDE_MD_V5_HASH,
  RESEARCHER_AGENT_MD_V4_HASH,
  SUPERVISOR_AGENT_MD_V20_HASH,
  SUPERVISOR_AGENT_MD_V21_HASH,
  WORKER_CLAUDE_MD_V9_HASH,
  WORKER_CLAUDE_MD_V10_HASH,
  WORKER_CLAUDE_MD_V11_HASH,
  WORKER_CODEX_AGENTS_MD_V2_HASH,
  WORKER_CODEX_AGENTS_MD_V3_HASH,
  WORKER_CODEX_AGENTS_MD_V4_HASH,
  proposalToPlanEntries,
  writeProposalEntry,
  readPlanningSurfaceEntry,
  proveProductionEntryPointEntry,
  WRITE_PROPOSAL_SKILL_MD_V1_HASH,
  PROPOSAL_TO_PLAN_SKILL_MD_V1_HASH,
  PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V1_HASH,
  PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V2_HASH,
  PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V1_HASH,
  PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V2_HASH,
  PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V3_HASH,
  PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V1_HASH,
  PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V2_HASH,
  PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V3_HASH,
  PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD_V1_HASH,
  PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD_V2_HASH,
  PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD_V1_HASH,
  PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD_V1_HASH,
  PROPOSAL_TO_PLAN_SKILL_MD_V2_HASH,
  PROPOSAL_TO_PLAN_SKILL_MD_V3_HASH,
  PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V3_HASH,
  PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD_V2_HASH,
  PROPOSAL_TO_PLAN_CONTRACT_RESPONSIBILITY_MD_V1_HASH,
  PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V1_HASH,
  PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V2_HASH,
  PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V3_HASH,
  PROPOSAL_TO_PLAN_CONTRACT_MANIFEST_LOCK_MD_V1_HASH,
  normalizeManagedKey,
  sha256Hex,
} from './index';
import { writeScaffoldMap as writeScaffoldMapRaw, type ScaffoldFile } from '../scaffold-writer';
import {
  DASHBOARD_STATUS_SCRIPT_MJS,
  DASHBOARD_STATUS_SCRIPT_MJS_V4,
  DASHBOARD_STATUS_SCRIPT_MJS_V6,
  DASHBOARD_STATUS_SCRIPT_V8_HASH,
  DASHBOARD_STATUS_SCRIPT_V9_HASH,
  WORKER_AGY_HOOKS_JSON_V1_HASH,
  workerAgyHooksJsonV2,
  GUARD_GIT_DISCARD_MJS,
  RESEARCH_WRITE_GUARD_MJS,
  RESEARCH_STORE_README_MD,
  RESEARCHER_AGENT_MD,
  RESEARCHER_CLAUDE_SETTINGS_JSON,
  REMEMBER_SKILL,
  SUPERVISOR_AGENT_MD,
  SUPERVISOR_RUN_ORCHESTRATION_SKILL,
  SUPERVISOR_AGENT_MD_V19,
  SUPERVISOR_AGENT_MD_V20,
  SUPERVISOR_AGENT_MD_V21,
  WORKER_CLAUDE_MD_V9,
  WORKER_CLAUDE_MD_V10,
  WRITE_PROPOSAL_SKILL_MD,
  READ_PLANNING_SURFACE_SKILL_MD,
  PROVE_PRODUCTION_ENTRY_POINT_SKILL,
  WORKER_CODEX_AGENTS_MD_V2,
  WORKER_CODEX_AGENTS_MD_V3,
  WORKER_CODEX_AGENTS_MD_V4,
  PROPOSAL_TO_PLAN_SKILL_MD,
  PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD,
  PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V2,
  PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD,
  PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD,
  PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V3,
  PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD,
  PROPOSAL_TO_PLAN_CONTRACT_ARC_MD,
  PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD,
  PROPOSAL_TO_PLAN_CONTRACT_RESPONSIBILITY_MD,
  PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD,
  PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD_V2,
  PROPOSAL_TO_PLAN_CONTRACT_MANIFEST_LOCK_MD,
  PROPOSAL_TO_PLAN_SCRIPT_PLAN_IDENTITY_MJS,
  PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS,
  SUPERVISOR_CHECKPOINT_FORENSICS_SKILL,
  SUPERVISOR_CONTEXT_ANALYTICS_SKILL,
  WORKER_CLAUDE_MD,
  WORKER_CLAUDE_MD_V1,
  WORKER_CLAUDE_MD_V8,
  WORKER_CLAUDE_MD_V11,
  WORKER_CODEX_AGENTS_MD,
  WORKER_CODEX_AGENTS_MD_V1,
  WORKER_GROK_AGENTS_MD,
  WORKER_AGY_AGENTS_MD,
  WORKER_CODEX_CONFIG_TOML,
  WORKER_CODEX_CONFIG_TOML_V2,
  WORKER_CODEX_CONFIG_TOML_V3,
  WORKER_CODEX_CONFIG_TOML_V4,
  WORKER_CODEX_CONFIG_TOML_V5,
  WORKER_CLAUDE_SETTINGS_JSON,
  WORKER_CLAUDE_SETTINGS_JSON_V6,
  WORKER_CLAUDE_SETTINGS_JSON_V7,
} from '../../shared/constants';
import { getNodeShimDir } from '../node-shim';
import { AGY_STATUS_HOOK_ENTRY } from './agy-hooks';
import {
  GUARD_GIT_DISCARD_MJS_V1,
  GUARD_GIT_DISCARD_MJS_V2,
  RESEARCH_WRITE_GUARD_MJS_V3,
  RESEARCH_WRITE_GUARD_MJS_V4,
} from './guard-script-old-body-fixtures';
import {
  PROPOSAL_TO_PLAN_SKILL_MD_V1,
  PROPOSAL_TO_PLAN_SKILL_MD_V2,
  PROPOSAL_TO_PLAN_SKILL_MD_V3,
  PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V1,
  PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V3,
  PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V1,
  PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V2,
  PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V1,
  PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V2,
  PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD_V1,
  PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD_V2,
  PROPOSAL_TO_PLAN_CONTRACT_RESPONSIBILITY_MD_V1,
  PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD_V1,
  PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD_V1,
  PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V1,
  PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V2,
  PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V3,
  PROPOSAL_TO_PLAN_CONTRACT_MANIFEST_LOCK_MD_V1,
} from './proposal-to-plan-old-body-fixtures';
import { WRITE_PROPOSAL_SKILL_MD_V1 } from './write-proposal-old-body-fixtures';
import {
  SUPERVISOR_V11_ORCH_THROUGH_BROWSER,
  SUPERVISOR_V11_REORIENT_EXTRA,
} from './supervisor-agent-md-v11-fixture';
import {
  V13_TURN_END_BULLET,
  V12_TURN_END_BULLET,
  V13_CONTEXT_BULLET,
  V12_CONTEXT_BULLET,
  V13_TIER1_LINE,
  V12_TIER1_LINE,
  V13_MUTED_MEMBERS_PARA,
} from './supervisor-agent-md-v12-fixture';
import {
  V14_LIST_AGENTS_BULLET,
  V13_LIST_AGENTS_BULLET,
  V13_CONTEXT_STATS_BULLET,
  V14_ORCH_SKILL_POINTER,
  V13_ORCH_SKILL_POINTER,
} from './supervisor-agent-md-v13-fixture';
import {
  V15_CONTINUATION_BRICK_BULLET,
  V15_CONTINUATION_SECTION_OPEN,
  V15_CONTINUATION_SECTION_CLOSE,
} from './supervisor-agent-md-v14-fixture';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// ── Fixtures ─────────────────────────────────────────────────────────

/** Verbatim pre-DASHBOARD_HOST `dashboard-status.mjs` content shipped in
 *  every old workspace. Newlines must stay LF — the v1 hash is computed
 *  over LF bytes (the WSL workspaces use LF; the original
 *  fs.writeFileSync also wrote LF unchanged). */
const V1_DASHBOARD_STATUS_MJS = [
  `#!/usr/bin/env node`,
  `// Class IV worker hook script — see plans/class-iv-worker-hook-scaffold.md`,
  `const agentId = process.env.AGENT_ID;`,
  `const port = process.env.DASHBOARD_PORT || '24678';`,
  `if (!agentId) process.exit(0);`,
  ``,
  `const body = JSON.stringify({ state: 'idle', source: 'hook-stop', ts: Date.now() });`,
  `const url = \`http://127.0.0.1:\${port}/api/agents/\${agentId}/status\`;`,
  ``,
  `try {`,
  `  const ac = new AbortController();`,
  `  const timer = setTimeout(() => ac.abort(), 1500);`,
  `  await fetch(url, {`,
  `    method: 'POST',`,
  `    headers: { 'Content-Type': 'application/json' },`,
  `    body,`,
  `    signal: ac.signal,`,
  `  });`,
  `  clearTimeout(timer);`,
  `} catch {`,
  `  // Swallow failures — inference fallback still drives status.`,
  `}`,
  ``,
].join('\n');

/** Verbatim pre-UserPromptSubmit `dashboard-status.mjs` (v2 content with
 *  DASHBOARD_HOST + pending-status.jsonl logging but hard-coded
 *  `state: 'idle'`). Newlines stay LF for hash stability. */
const V2_DASHBOARD_STATUS_MJS = [
  `#!/usr/bin/env node`,
  `// Class IV worker hook script — see plans/class-iv-worker-hook-scaffold.md`,
  `import { fileURLToPath } from 'node:url';`,
  `import path from 'node:path';`,
  `import fs from 'node:fs';`,
  ``,
  `const agentId = process.env.AGENT_ID;`,
  `const port = process.env.DASHBOARD_PORT || '24678';`,
  `const host = process.env.DASHBOARD_HOST || '127.0.0.1';`,
  `if (!agentId) process.exit(0);`,
  ``,
  `const body = JSON.stringify({ state: 'idle', source: 'hook-stop', ts: Date.now() });`,
  `const url = \`http://\${host}:\${port}/api/agents/\${agentId}/status\`;`,
  `// Claude exports CLAUDE_HOOK_EVENT_NAME (e.g. 'Stop', 'SubagentStop'); Codex`,
  `// passes hook_event_name on stdin instead, so for Codex we tag it as 'codex'.`,
  `const hookEvent = process.env.CLAUDE_HOOK_EVENT_NAME || 'unknown';`,
  ``,
  `try {`,
  `  const ac = new AbortController();`,
  `  const timer = setTimeout(() => ac.abort(), 1500);`,
  `  await fetch(url, {`,
  `    method: 'POST',`,
  `    headers: { 'Content-Type': 'application/json' },`,
  `    body,`,
  `    signal: ac.signal,`,
  `  });`,
  `  clearTimeout(timer);`,
  `} catch (err) {`,
  `  // L-C diagnosability: append an attempt record so a single grep over`,
  `  // <workspace>/.dashboard/pending-status.jsonl shows every hook that failed`,
  `  // to reach the dashboard. Stays best-effort — if even the appendFileSync`,
  `  // fails (e.g. read-only fs) we still swallow so the user-visible hook`,
  `  // never blocks. Inference fallback continues to drive status.`,
  `  try {`,
  `    const scriptDir = path.dirname(fileURLToPath(import.meta.url));`,
  `    const logPath = path.resolve(scriptDir, '..', 'pending-status.jsonl');`,
  `    const line = JSON.stringify({`,
  `      ts: Date.now(),`,
  `      agentId,`,
  `      hookEvent,`,
  `      host,`,
  `      port,`,
  `      url,`,
  `      error: err instanceof Error ? err.message : String(err),`,
  `    }) + '\\n';`,
  `    fs.appendFileSync(logPath, line);`,
  `  } catch {`,
  `    // Last-resort swallow — inference fallback still drives status.`,
  `  }`,
  `}`,
  ``,
].join('\n');

// ── Test helpers ─────────────────────────────────────────────────────

function patchDb(): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const origAddEvent = db.addEvent;
  db.addEvent = () => {};
  return () => { db.addEvent = origAddEvent; };
}

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentdash-${prefix}-`));
}
function rmrf(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

interface SupervisorTestSurface {
  ensureWorkerScaffold(workDir: string, provider: string, pathType: string): void;
  ensureSupervisorScaffold(workDir: string, pathType: string): void;
  ensureResearchStoreScaffold(workDir: string, pathType: string): void;
  ensureResearcherScaffold(workDir: string, pathType: string): void;
  // Lane-agnostic shared-script refresh run unconditionally at launch (Option B):
  // every lane — incl. supervisor & researcher, which used to skip it — calls
  // this BEFORE its lane-specific scaffold, so a stale shared dashboard-status.mjs
  // self-heals regardless of which lane launches.
  ensureWorkspaceScripts(workDir: string, pathType: string): void;
}

function makeSupervisor(): { supervisor: SupervisorTestSurface; cleanup: () => void } {
  const restoreDb = patchDb();
  const raw = new AgentSupervisor();
  (raw as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
  const supervisor = raw as unknown as SupervisorTestSurface;
  return { supervisor, cleanup: restoreDb };
}

function scriptPath(workDir: string): string {
  return path.join(workDir, '.lares', 'scripts', 'dashboard-status.mjs');
}
function sidecarPath(workDir: string): string {
  return path.join(workDir, ...SCAFFOLD_SIDECAR_REL.split('/'));
}

function listBackups(workDir: string): string[] {
  const dir = path.join(workDir, '.lares', 'scripts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.startsWith('dashboard-status.mjs.bak.'));
}

function readSidecar(workDir: string): Record<string, number> {
  const raw = fs.readFileSync(sidecarPath(workDir), 'utf-8');
  return JSON.parse(raw);
}

// ── Tests ────────────────────────────────────────────────────────────

test('precondition: v1 fixture hashes to the constant we ship', () => {
  const hash = sha256Hex(V1_DASHBOARD_STATUS_MJS);
  assert.equal(
    hash,
    DASHBOARD_STATUS_SCRIPT_V1_HASH,
    `V1 fixture hash (${hash}) does not match shipped constant ` +
    `(${DASHBOARD_STATUS_SCRIPT_V1_HASH}). The migration cannot recognize ` +
    `existing workspaces' v1 dashboard-status.mjs without an accurate hash.`,
  );
});

test('precondition: v2 fixture hashes to the constant we ship', () => {
  const hash = sha256Hex(V2_DASHBOARD_STATUS_MJS);
  assert.equal(
    hash,
    DASHBOARD_STATUS_SCRIPT_V2_HASH,
    `V2 fixture hash (${hash}) does not match shipped constant ` +
    `(${DASHBOARD_STATUS_SCRIPT_V2_HASH}). The v2→v3 migration cannot ` +
    `silently upgrade existing v2 workspaces without an accurate hash.`,
  );
});

test('2b. v2 script + sidecar v2: silent upgrade by known v2 hash → v6', () => {
  const workDir = mktmp('scaffold-known-v2');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.dirname(scriptPath(workDir)), { recursive: true });
    fs.writeFileSync(scriptPath(workDir), V2_DASHBOARD_STATUS_MJS, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    // Workspaces previously upgraded to v2 have a sidecar entry. The v2→v3
    // migration recognizes the disk content via previousHashes[2] = v2 hash.
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'scripts/dashboard-status.mjs': 2 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const content = fs.readFileSync(scriptPath(workDir), 'utf-8');
    assert.equal(content, DASHBOARD_STATUS_SCRIPT_MJS, 'script must be upgraded to exact v6 bundled content');
    assert.equal(listBackups(workDir).length, 0, 'known v2-hash upgrade must NOT create a backup');

    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 10, `sidecar must record current version; got: ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('2d. v6 script + sidecar v6: silent upgrade by known v6 hash → v7 (P1 plan §5 E7)', () => {
  const workDir = mktmp('scaffold-known-v6');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.dirname(scriptPath(workDir)), { recursive: true });
    fs.writeFileSync(scriptPath(workDir), DASHBOARD_STATUS_SCRIPT_MJS_V6, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'scripts/dashboard-status.mjs': 6 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const content = fs.readFileSync(scriptPath(workDir), 'utf-8');
    assert.equal(content, DASHBOARD_STATUS_SCRIPT_MJS, 'v6 script must silently upgrade to exact v7 bundled content');
    assert.equal(listBackups(workDir).length, 0, 'known v6-hash upgrade must NOT create a backup');

    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 10, `sidecar must record current version; got: ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

/** Reconstruct the v8 dashboard-status.mjs body by removing the v9 idle-vs-waiting
 *  bail block from the current (v9) bundled script. The block's exact text isn't
 *  frozen as a content constant (only its parent v8 hash is), so we derive it and
 *  assert the reconstruction hashes to DASHBOARD_STATUS_SCRIPT_V8_HASH — which both
 *  validates the frozen hash literal and yields a faithful v8 on-disk fixture. */
function reconstructV9Script(): string {
  const v9 = DASHBOARD_STATUS_SCRIPT_MJS
    .replace(
      `  // hookEventName: stdin → CLAUDE_HOOK_EVENT_NAME env → explicit --event\n  // argv → state-derived. The explicit flag lets agy's PreInvocation carrier\n  // report honest provenance without a shell-specific environment assignment.\n  const rawState = process.argv[2];\n  const eventFlagIndex = process.argv.indexOf('--event');\n  const explicitEventName = eventFlagIndex >= 0 && typeof process.argv[eventFlagIndex + 1] === 'string'\n    ? process.argv[eventFlagIndex + 1]\n    : '';`,
      `  // hookEventName: stdin → CLAUDE_HOOK_EVENT_NAME env → argv-derived.\n  const rawState = process.argv[2];`,
    )
    .replace(
      '  const hookEventName = stdinEventName || process.env.CLAUDE_HOOK_EVENT_NAME || explicitEventName || argvEventName;',
      '  const hookEventName = stdinEventName || process.env.CLAUDE_HOOK_EVENT_NAME || argvEventName;',
    );
  assert.notEqual(v9, DASHBOARD_STATUS_SCRIPT_MJS, 'the v10 --event support must be present in the live script to remove');
  return v9;
}

function reconstructV8Script(): string {
  const v8 = reconstructV9Script().replace(
    /  \/\/ idle-vs-waiting fix[\s\S]*?if \(isNonBlocking\) return;\n  \}\n\n/,
    '',
  );
  assert.notEqual(v8, DASHBOARD_STATUS_SCRIPT_MJS, 'the v9 bail block must be present in the live script to remove');
  return v8;
}

test('2e0. reconstructed v9 script matches the frozen v9 hash and differs from live v10', () => {
  const v9 = reconstructV9Script();
  assert.equal(sha256Hex(v9), DASHBOARD_STATUS_SCRIPT_V9_HASH);
  assert.notEqual(sha256Hex(DASHBOARD_STATUS_SCRIPT_MJS), DASHBOARD_STATUS_SCRIPT_V9_HASH);
});

test('2e1. pristine v9 script silently upgrades to v10 via previousHashes[9]', () => {
  const workDir = mktmp('scaffold-known-v9');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.dirname(scriptPath(workDir)), { recursive: true });
    fs.writeFileSync(scriptPath(workDir), reconstructV9Script(), 'utf-8');
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'scripts/dashboard-status.mjs': 9 }, null, 2) + '\n',
      'utf-8',
    );
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');
    assert.equal(fs.readFileSync(scriptPath(workDir), 'utf-8'), DASHBOARD_STATUS_SCRIPT_MJS);
    assert.equal(listBackups(workDir).length, 0);
    assert.equal(readSidecar(workDir)['scripts/dashboard-status.mjs'], 10);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('2e2. pristine agy carrier v1 silently upgrades to Stop-enabled v3', () => {
  const workDir = mktmp('scaffold-agy-v1');
  const carrierPath = path.join(workDir, '.lares', 'workers', 'agy', '.agents', 'hooks.json');
  const oldBody = JSON.stringify({ 'lares-dashboard-status': AGY_STATUS_HOOK_ENTRY }, null, 2) + '\n';
  const priorUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = path.join(workDir, 'fake-home');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    assert.equal(sha256Hex(oldBody), WORKER_AGY_HOOKS_JSON_V1_HASH);
    fs.mkdirSync(path.dirname(carrierPath), { recursive: true });
    fs.writeFileSync(carrierPath, oldBody, 'utf-8');
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'workers/agy/.agents/hooks.json': 1 }, null, 2) + '\n',
      'utf-8',
    );
    supervisor.ensureWorkerScaffold(workDir, 'agy', 'windows');
    const upgraded = JSON.parse(fs.readFileSync(carrierPath, 'utf-8'));
    assert.equal(typeof upgraded['lares-dashboard-status'].PreInvocation[0].command, 'string');
    assert.ok(!('matcher' in upgraded['lares-dashboard-status'].PreInvocation[0]));
    assert.equal(upgraded['lares-dashboard-status'].Stop.length, 1);
    assert.equal(readSidecar(workDir)['workers/agy/.agents/hooks.json'], 3);
    const carrierDir = path.dirname(carrierPath);
    assert.equal(fs.readdirSync(carrierDir).filter((name) => name.startsWith('hooks.json.bak.')).length, 0);
  } finally {
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    cleanup();
    rmrf(workDir);
  }
});

test('2e3. pristine path-dependent agy carrier v2 silently upgrades to Stop-enabled v3', () => {
  const workDir = mktmp('scaffold-agy-v2');
  const carrierPath = path.join(workDir, '.lares', 'workers', 'agy', '.agents', 'hooks.json');
  const priorUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = path.join(workDir, 'fake-home');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const oldBody = workerAgyHooksJsonV2(workDir, path.join(getNodeShimDir(), 'node.cmd'));
    fs.mkdirSync(path.dirname(carrierPath), { recursive: true });
    fs.writeFileSync(carrierPath, oldBody, 'utf-8');
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'workers/agy/.agents/hooks.json': 2 }, null, 2) + '\n',
      'utf-8',
    );
    supervisor.ensureWorkerScaffold(workDir, 'agy', 'windows');
    const upgraded = JSON.parse(fs.readFileSync(carrierPath, 'utf-8'));
    assert.equal(upgraded['lares-dashboard-status'].PreInvocation.length, 1);
    assert.equal(upgraded['lares-dashboard-status'].Stop.length, 1);
    assert.notEqual(fs.readFileSync(carrierPath, 'utf-8'), oldBody);
    assert.equal(readSidecar(workDir)['workers/agy/.agents/hooks.json'], 3);
    assert.equal(fs.readdirSync(path.dirname(carrierPath)).filter((name) => name.startsWith('hooks.json.bak.')).length, 0);
  } finally {
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    cleanup();
    rmrf(workDir);
  }
});

test('2e. v8 script + sidecar v8: silent upgrade by frozen v8 hash → v9 (idle-vs-waiting fix)', () => {
  const workDir = mktmp('scaffold-known-v8');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const v8Script = reconstructV8Script();
    // The reconstruction MUST match the frozen v8 hash, or the v8→v9 silent
    // upgrade migration is broken.
    assert.equal(sha256Hex(v8Script), DASHBOARD_STATUS_SCRIPT_V8_HASH,
      'reconstructed v8 script must hash to DASHBOARD_STATUS_SCRIPT_V8_HASH (frozen literal)');

    fs.mkdirSync(path.dirname(scriptPath(workDir)), { recursive: true });
    fs.writeFileSync(scriptPath(workDir), v8Script, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'scripts/dashboard-status.mjs': 8 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const content = fs.readFileSync(scriptPath(workDir), 'utf-8');
    assert.equal(content, DASHBOARD_STATUS_SCRIPT_MJS, 'v8 script must silently upgrade to exact v9 bundled content');
    assert.equal(listBackups(workDir).length, 0, 'known v8-hash upgrade must NOT create a backup');

    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 10, `sidecar must record v10; got: ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('2f. locally-edited (unknown-hash) v8-ish script → backed up + overwritten with v9', () => {
  const workDir = mktmp('scaffold-edited-v8');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const edited = reconstructV8Script() + '\n// LOCAL EDIT — must be backed up, not silently clobbered\n';
    fs.mkdirSync(path.dirname(scriptPath(workDir)), { recursive: true });
    fs.writeFileSync(scriptPath(workDir), edited, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'scripts/dashboard-status.mjs': 8 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const content = fs.readFileSync(scriptPath(workDir), 'utf-8');
    assert.equal(content, DASHBOARD_STATUS_SCRIPT_MJS, 'edited script must be overwritten with v9 bundled content');

    const backups = listBackups(workDir);
    assert.equal(backups.length, 1, `expected exactly one .bak.<ts> file; got: ${backups.join(', ')}`);
    const backupContent = fs.readFileSync(
      path.join(workDir, '.lares', 'scripts', backups[0]),
      'utf-8',
    );
    assert.equal(backupContent, edited, 'backup must contain the locally-edited content verbatim');

    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 10, `sidecar must record v10; got: ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('2c. v4 script + sidecar v4: silent upgrade by known v4 hash → v6', () => {
  const workDir = mktmp('scaffold-known-v4');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.dirname(scriptPath(workDir)), { recursive: true });
    fs.writeFileSync(scriptPath(workDir), DASHBOARD_STATUS_SCRIPT_MJS_V4, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'scripts/dashboard-status.mjs': 4 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const content = fs.readFileSync(scriptPath(workDir), 'utf-8');
    assert.equal(content, DASHBOARD_STATUS_SCRIPT_MJS, 'v4 script must silently upgrade to exact v6 bundled content');
    assert.equal(listBackups(workDir).length, 0, 'known v4-hash upgrade must NOT create a backup');

    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 10, `sidecar must record current version; got: ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('1. fresh workspace: writes v6 script and sidecar with version 6', () => {
  const workDir = mktmp('scaffold-fresh');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    assert.equal(fs.existsSync(scriptPath(workDir)), false, 'precondition: no script yet');
    assert.equal(fs.existsSync(sidecarPath(workDir)), false, 'precondition: no sidecar yet');

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    assert.ok(fs.existsSync(scriptPath(workDir)), 'script must exist after scaffold');
    const content = fs.readFileSync(scriptPath(workDir), 'utf-8');
    assert.equal(content, DASHBOARD_STATUS_SCRIPT_MJS, 'script must be exact v6 bundled content');

    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 10, `sidecar must record current version for the script; got: ${JSON.stringify(sidecar)}`);
    assert.equal(listBackups(workDir).length, 0, 'no .bak files expected on fresh scaffold');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('2. v1 script + no sidecar: silent upgrade by known-hash match', () => {
  const workDir = mktmp('scaffold-known-v1');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.dirname(scriptPath(workDir)), { recursive: true });
    fs.writeFileSync(scriptPath(workDir), V1_DASHBOARD_STATUS_MJS, 'utf-8');
    assert.equal(fs.existsSync(sidecarPath(workDir)), false, 'precondition: no sidecar');

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const content = fs.readFileSync(scriptPath(workDir), 'utf-8');
    assert.equal(content, DASHBOARD_STATUS_SCRIPT_MJS, 'script must be upgraded to exact v6 bundled content');
    assert.equal(listBackups(workDir).length, 0, 'known-hash upgrade must NOT create a backup');

    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 10, `sidecar must record current version; got: ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('3. v1-ish but user-modified script + no sidecar: backup + overwrite', () => {
  const workDir = mktmp('scaffold-user-mod');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.dirname(scriptPath(workDir)), { recursive: true });
    const userEdited = V1_DASHBOARD_STATUS_MJS + '\n// USER ADDED A LINE — DO NOT CLOBBER SILENTLY\n';
    fs.writeFileSync(scriptPath(workDir), userEdited, 'utf-8');

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const content = fs.readFileSync(scriptPath(workDir), 'utf-8');
    assert.equal(content, DASHBOARD_STATUS_SCRIPT_MJS, 'active script must be upgraded to v6');

    const backups = listBackups(workDir);
    assert.equal(backups.length, 1, `expected exactly one .bak.<ts> file; got: ${backups.join(', ')}`);
    const backupContent = fs.readFileSync(
      path.join(workDir, '.lares', 'scripts', backups[0]),
      'utf-8',
    );
    assert.equal(backupContent, userEdited, 'backup must contain the user-edited content verbatim');

    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 10, `sidecar must record current version; got: ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('4. workspace already at v5: script not rewritten, no backup, sidecar still v5', async () => {
  const workDir = mktmp('scaffold-already-v5');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    // Prewrite script + sidecar exactly as a fully-migrated workspace.
    fs.mkdirSync(path.dirname(scriptPath(workDir)), { recursive: true });
    fs.writeFileSync(scriptPath(workDir), DASHBOARD_STATUS_SCRIPT_MJS, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'scripts/dashboard-status.mjs': 5 }, null, 2) + '\n',
      'utf-8',
    );

    const beforeScriptMtime = fs.statSync(scriptPath(workDir)).mtimeMs;
    // Ensure any timestamp granularity won't accidentally pass a re-write as a no-op.
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    // The plan's invariant is about the SCRIPT — it must not be rewritten when
    // the sidecar already records the current version. (The sidecar itself may
    // be re-written if other managed files were missing — e.g.
    // WORKER_FILES_CLAUDE on first scaffold — but the script is untouched.)
    const afterScriptMtime = fs.statSync(scriptPath(workDir)).mtimeMs;
    assert.equal(afterScriptMtime, beforeScriptMtime, 'script mtime must be unchanged when sidecar says current');
    assert.equal(listBackups(workDir).length, 0, 'no .bak files expected on no-op script scaffold');

    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 10, `sidecar must still record current version for the script; got: ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('5. corrupt sidecar + v1 script: warn, treat as empty, upgrade + valid sidecar', () => {
  const workDir = mktmp('scaffold-corrupt');
  const { supervisor, cleanup } = makeSupervisor();
  const origWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    fs.mkdirSync(path.dirname(scriptPath(workDir)), { recursive: true });
    fs.writeFileSync(scriptPath(workDir), V1_DASHBOARD_STATUS_MJS, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(sidecarPath(workDir), '{ this is not valid json', 'utf-8');

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const content = fs.readFileSync(scriptPath(workDir), 'utf-8');
    assert.equal(content, DASHBOARD_STATUS_SCRIPT_MJS, 'corrupt sidecar must not block upgrade');

    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 10, `sidecar must be valid JSON with current version; got: ${JSON.stringify(sidecar)}`);

    const sawWarning = warnings.some((w) => /sidecar/i.test(w) && /unparseable|not an object/i.test(w));
    assert.ok(sawWarning, `expected a sidecar warning to be logged; got: ${warnings.join('\n')}`);
  } finally {
    console.warn = origWarn;
    cleanup();
    rmrf(workDir);
  }
});

test('6. concurrent ensureWorkerScaffold: parseable sidecar, complete v2 content, ≤1 backup', async () => {
  const workDir = mktmp('scaffold-concurrent');
  const restoreDb = patchDb();
  try {
    // Prewrite a user-modified v1-ish file so EXACTLY one race winner should
    // create a .bak — the loser sees the v2 file and a sidecar entry already
    // in place and short-circuits.
    fs.mkdirSync(path.dirname(scriptPath(workDir)), { recursive: true });
    const userEdited = V1_DASHBOARD_STATUS_MJS + '\n// concurrent test user edit\n';
    fs.writeFileSync(scriptPath(workDir), userEdited, 'utf-8');

    const s1 = new AgentSupervisor();
    const s2 = new AgentSupervisor();
    (s1 as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
    (s2 as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};

    const call1 = () => (s1 as unknown as SupervisorTestSurface)
      .ensureWorkerScaffold(workDir, 'claude', 'windows');
    const call2 = () => (s2 as unknown as SupervisorTestSurface)
      .ensureWorkerScaffold(workDir, 'claude', 'windows');

    // ensureWorkerScaffold is synchronous; Promise.all on async wrappers
    // gives the runtime a chance to interleave the lock acquisitions.
    await Promise.all([
      Promise.resolve().then(call1),
      Promise.resolve().then(call2),
    ]);

    // Sidecar exists and parses cleanly.
    const sidecar = readSidecar(workDir);
    assert.equal(
      sidecar['scripts/dashboard-status.mjs'], 10,
      `sidecar should be at v10 after concurrent run; got: ${JSON.stringify(sidecar)}`,
    );

    // Final on-disk script is the FULL v5 content (not a torn write).
    const content = fs.readFileSync(scriptPath(workDir), 'utf-8');
    assert.equal(content, DASHBOARD_STATUS_SCRIPT_MJS, 'final script must be complete v6 content (no torn write)');

    // At most one backup. (One winner created it; loser sees v2 + sidecar
    // and does nothing.)
    const backups = listBackups(workDir);
    assert.ok(backups.length <= 1, `expected at most one backup; got ${backups.length}: ${backups.join(', ')}`);
  } finally {
    restoreDb();
    rmrf(workDir);
  }
});

// ── Option B: supervisor/researcher launches now refresh the shared script ──
//
// The fix hoists ensureWorkspaceScripts(workDir, pathType) ahead of the lane
// dispatch in launchAgent, so the supervisor & researcher lanes — which scaffold
// only their own kit (ensureSupervisorScaffold / ensureResearcherScaffold) and
// never wrote WORKSPACE_SCRIPT_FILES — now self-heal the shared
// .lares/scripts/dashboard-status.mjs they depend on. These exercise that
// seam directly (mirroring how the worker-lane tests above call
// ensureWorkerScaffold) across the full migration matrix.

test('B1. supervisor-launch refresh, MISSING shared script → written at v9', () => {
  const workDir = mktmp('opt-b-missing');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    // Pre-seed a supervisor kit WITHOUT the shared script (the pre-fix state of a
    // supervisor-only workspace), then confirm ensureSupervisorScaffold alone
    // does NOT create it — the gap this fix closes.
    supervisor.ensureSupervisorScaffold(workDir, 'windows');
    assert.equal(fs.existsSync(scriptPath(workDir)), false,
      'precondition: a bare supervisor scaffold must NOT write the shared script');

    // The hoisted launch step now refreshes it.
    supervisor.ensureWorkspaceScripts(workDir, 'windows');

    assert.ok(fs.existsSync(scriptPath(workDir)), 'shared script must exist after the launch-step refresh');
    assert.equal(fs.readFileSync(scriptPath(workDir), 'utf-8'), DASHBOARD_STATUS_SCRIPT_MJS,
      'shared script must be the exact v9 bundled content');
    assert.equal(readSidecar(workDir)['scripts/dashboard-status.mjs'], 10, 'sidecar must record v10');
    assert.equal(listBackups(workDir).length, 0, 'no .bak on a fresh write');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('B2. supervisor-launch refresh, STALE known-managed-hash (v6) → silent upgrade, no .bak', () => {
  const workDir = mktmp('opt-b-stale');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.dirname(scriptPath(workDir)), { recursive: true });
    fs.writeFileSync(scriptPath(workDir), DASHBOARD_STATUS_SCRIPT_MJS_V6, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'scripts/dashboard-status.mjs': 6 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkspaceScripts(workDir, 'windows');

    assert.equal(fs.readFileSync(scriptPath(workDir), 'utf-8'), DASHBOARD_STATUS_SCRIPT_MJS,
      'a v6 (pre-session_id) script must silently upgrade to v9 on a supervisor-launch refresh');
    assert.equal(listBackups(workDir).length, 0, 'known-hash upgrade must NOT create a backup');
    assert.equal(readSidecar(workDir)['scripts/dashboard-status.mjs'], 10, 'sidecar must record v10');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('B3. supervisor-launch refresh, CURRENT script (sidecar v9) → no-op, mtime preserved', async () => {
  const workDir = mktmp('opt-b-current');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.dirname(scriptPath(workDir)), { recursive: true });
    fs.writeFileSync(scriptPath(workDir), DASHBOARD_STATUS_SCRIPT_MJS, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'scripts/dashboard-status.mjs': 10 }, null, 2) + '\n',
      'utf-8',
    );

    const beforeMtime = fs.statSync(scriptPath(workDir)).mtimeMs;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    supervisor.ensureWorkspaceScripts(workDir, 'windows');

    assert.equal(fs.statSync(scriptPath(workDir)).mtimeMs, beforeMtime,
      'a current shared script must NOT be rewritten — the redundant per-lane pass is a no-op skip');
    assert.equal(listBackups(workDir).length, 0, 'no .bak on a no-op refresh');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('B4. supervisor-launch refresh, LOCALLY-EDITED unknown-hash script → .bak + overwrite', () => {
  const workDir = mktmp('opt-b-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.dirname(scriptPath(workDir)), { recursive: true });
    const edited = DASHBOARD_STATUS_SCRIPT_MJS + '\n// LOCAL EDIT — must be backed up, not silently clobbered\n';
    fs.writeFileSync(scriptPath(workDir), edited, 'utf-8');

    supervisor.ensureWorkspaceScripts(workDir, 'windows');

    assert.equal(fs.readFileSync(scriptPath(workDir), 'utf-8'), DASHBOARD_STATUS_SCRIPT_MJS,
      'edited shared script must be overwritten with v9 bundled content');
    const backups = listBackups(workDir);
    assert.equal(backups.length, 1, `expected exactly one .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(
      fs.readFileSync(path.join(workDir, '.lares', 'scripts', backups[0]), 'utf-8'),
      edited,
      'backup must hold the locally-edited content verbatim',
    );
    assert.equal(readSidecar(workDir)['scripts/dashboard-status.mjs'], 10, 'sidecar must record v10');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── WP-G research store + persona-pointer migration ──────────────────

function researchPath(workDir: string, ...rel: string[]): string {
  return path.join(workDir, '.lares', 'research', ...rel);
}
function countMatches(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
const RESEARCH_SECTION_MARKER = '<!-- section:research-store v1 -->';

test('G3. research store: fresh workspace writes README + inbox/cleared gitkeeps; idempotent', () => {
  const workDir = mktmp('research-store-fresh');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureResearchStoreScaffold(workDir, 'windows');

    const readmePath = researchPath(workDir, 'README.md');
    assert.ok(fs.existsSync(readmePath), 'README.md must exist');
    assert.ok(fs.existsSync(researchPath(workDir, 'inbox', '.gitkeep')), 'inbox/.gitkeep must exist');
    assert.ok(fs.existsSync(researchPath(workDir, 'cleared', '.gitkeep')), 'cleared/.gitkeep must exist');
    assert.equal(fs.readFileSync(readmePath, 'utf-8'), RESEARCH_STORE_README_MD, 'README must be exact bundled content');

    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['research/README.md'], 1, `sidecar must record README v1; got ${JSON.stringify(sidecar)}`);

    // Second pass is a no-op: README unchanged, no backups.
    const beforeMtime = fs.statSync(readmePath).mtimeMs;
    supervisor.ensureResearchStoreScaffold(workDir, 'windows');
    assert.equal(fs.statSync(readmePath).mtimeMs, beforeMtime, 'second pass must not rewrite README');
    const backups = fs.readdirSync(researchPath(workDir)).filter((n) => n.startsWith('README.md.bak.'));
    assert.equal(backups.length, 0, 'no backups expected on idempotent re-run');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('G3. research store: user-modified README is backed up + overwritten', () => {
  const workDir = mktmp('research-store-usermod');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const readmePath = researchPath(workDir, 'README.md');
    fs.mkdirSync(path.dirname(readmePath), { recursive: true });
    fs.writeFileSync(readmePath, '# my own README\n', 'utf-8');

    supervisor.ensureResearchStoreScaffold(workDir, 'windows');

    assert.equal(fs.readFileSync(readmePath, 'utf-8'), RESEARCH_STORE_README_MD, 'README must be upgraded to bundled content');
    const backups = fs.readdirSync(researchPath(workDir)).filter((n) => n.startsWith('README.md.bak.'));
    assert.equal(backups.length, 1, `expected one backup; got ${backups.join(', ')}`);
    assert.equal(fs.readFileSync(researchPath(workDir, backups[0]), 'utf-8'), '# my own README\n', 'backup must hold the user content');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── WP-B researcher persona scaffold ─────────────────────────────────

function researcherPath(workDir: string, ...rel: string[]): string {
  return path.join(workDir, '.lares', 'researcher', ...rel);
}

test('WP-B. researcher scaffold: fresh workspace writes persona CLAUDE.md + settings + guard + store; idempotent', () => {
  const workDir = mktmp('researcher-fresh');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureResearcherScaffold(workDir, 'windows');

    const mdPath = researcherPath(workDir, 'CLAUDE.md');
    const settingsPath = researcherPath(workDir, '.claude', 'settings.json');
    const guardPath = researcherPath(workDir, 'scripts', 'research-write-guard.mjs');
    assert.ok(fs.existsSync(mdPath), 'researcher CLAUDE.md must exist');
    assert.equal(fs.readFileSync(mdPath, 'utf-8'), RESEARCHER_AGENT_MD, 'researcher CLAUDE.md must be exact bundled content');
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), RESEARCHER_CLAUDE_SETTINGS_JSON, 'researcher settings.json must be exact bundled content');
    assert.ok(fs.existsSync(guardPath), 'research-write-guard.mjs must exist');

    // The store is also ensured (ensureResearcherScaffold → ensureResearchStoreScaffold).
    assert.ok(fs.existsSync(researchPath(workDir, 'README.md')), 'research store README must exist');
    assert.ok(fs.existsSync(researchPath(workDir, 'inbox', '.gitkeep')), 'inbox/.gitkeep must exist');

    // settings.json wires BOTH the status hooks AND the write-guard.
    const settings = fs.readFileSync(settingsPath, 'utf-8');
    assert.ok(settings.includes('"Stop"'), 'researcher settings must wire the Stop status hook');
    assert.ok(settings.includes('"SessionStart"'), 'researcher settings must wire SessionStart');
    assert.ok(settings.includes('"UserPromptSubmit"'), 'researcher settings must wire UserPromptSubmit');
    assert.ok(settings.includes('"PreToolUse"'), 'researcher settings must keep the PreToolUse write-guard');
    // Relative depth: status script is one level up (../scripts), write-guard is in-cwd (scripts/).
    assert.ok(settings.includes('/../scripts/dashboard-status.mjs'), 'status hook path must walk one level up');
    assert.ok(settings.includes('/scripts/research-write-guard.mjs'), 'write-guard path must be cwd-relative');
    // v2 (plans/usage-limits-mcp-and-ui.md §1.4) adds the statusLine usage-capture block.
    assert.ok(settings.includes('"statusLine"'), 'researcher settings must wire the statusLine block');
    assert.ok(settings.includes('dashboard-statusline.mjs'), 'statusLine must point at dashboard-statusline.mjs');

    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['researcher/CLAUDE.md'], 6, `sidecar must record researcher CLAUDE.md v6; got ${JSON.stringify(sidecar)}`);
    assert.equal(sidecar['researcher/.claude/settings.json'], 2, 'sidecar must record settings v2 (statusLine added)');

    // Idempotent second pass — no rewrites, no backups.
    const beforeMtime = fs.statSync(mdPath).mtimeMs;
    supervisor.ensureResearcherScaffold(workDir, 'windows');
    assert.equal(fs.statSync(mdPath).mtimeMs, beforeMtime, 'second pass must not rewrite researcher CLAUDE.md');
    const backups = fs.readdirSync(researcherPath(workDir)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'no backups expected on idempotent re-run');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('WP-B. researcher CLAUDE.md: user-modified persona is backed up + overwritten', () => {
  const workDir = mktmp('researcher-usermod');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = researcherPath(workDir, 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, '# my own researcher contract\n', 'utf-8');

    supervisor.ensureResearcherScaffold(workDir, 'windows');

    assert.equal(fs.readFileSync(mdPath, 'utf-8'), RESEARCHER_AGENT_MD, 'researcher CLAUDE.md must be upgraded to bundled content');
    const backups = fs.readdirSync(researcherPath(workDir)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 1, `expected one backup; got ${backups.join(', ')}`);
    assert.equal(fs.readFileSync(researcherPath(workDir, backups[0]), 'utf-8'), '# my own researcher contract\n', 'backup must hold the user content');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── Guard-script version bumps (per-provider PreToolUse deny rewrite) ─────────
//
// Both PreToolUse guard scripts had their deny EXIT CODE corrected. An earlier
// rewrite had made every deny exit 0, on the (false) belief that Claude 2.1.220
// honors an exit-0 hookSpecificOutput deny for Bash — it does not (verified: the
// command/write still runs), which left both Claude lanes silently UNENFORCING.
// The fix keeps the identical deny JSON and restores a blocking exit:
//   • guard-git-discard.mjs   — PER-PROVIDER: process.exit(codex ? 0 : 2). Claude
//     gets the blocking exit 2; Codex keeps exit 0 (it fails OPEN on any nonzero
//     exit). v2 -> v3 (WORKSPACE_SCRIPT_FILES).
//   • research-write-guard.mjs — Claude-only lane: process.exit(2). v4 -> v5
//     (RESEARCHER_FILES).
// Their scaffold `version` was bumped in lockstep so existing workspaces receive
// the new bytes instead of keeping the stale (skip-if-current) copy.
//
// The generic migration engine (silent upgrade on known-hash match, backup on an
// unknown hash) is proven exhaustively by the dashboard-status.mjs matrix above;
// these lock in (a) each entry's frozen OLD-body hashes (v1 AND v2 for the git
// guard, v3 AND v4 for the research guard) — so a genuine pristine old copy at
// either prior version is recognized and silently upgraded — and (b) the real
// on-disk upgrade through the lane's ensure* entry point. The OLD bodies live in
// the guard-script-old-body-fixtures module (production code carries only the
// frozen hash literals, per plans/scaffold-version-migration.md §Version Metadata
// Shape).

function guardScriptPath(workDir: string): string {
  return path.join(workDir, '.lares', 'scripts', 'guard-git-discard.mjs');
}
function listGuardBackups(workDir: string): string[] {
  const dir = path.join(workDir, '.lares', 'scripts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.startsWith('guard-git-discard.mjs.bak.'));
}
function researchGuardPath(workDir: string): string {
  return researcherPath(workDir, 'scripts', 'research-write-guard.mjs');
}
function listResearchGuardBackups(workDir: string): string[] {
  const dir = researcherPath(workDir, 'scripts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.startsWith('research-write-guard.mjs.bak.'));
}

test('precondition: reconstructed v1 remember body hashes to REMEMBER_SKILL_V1_HASH and differs from the live v2 body', () => {
  const v2Pointer = '- detail: memory/details/<id>.md                           # optional, for long bodies';
  const v1Pointer = '- detail: .lares/supervisor/memory/details/<id>.md         # optional, for long bodies';
  assert.ok(REMEMBER_SKILL.includes(v2Pointer), 'the live remember body must contain the validator-accepted v2 pointer');
  const v1Body = REMEMBER_SKILL.replace(v2Pointer, v1Pointer);
  assert.equal(
    sha256Hex(v1Body), REMEMBER_SKILL_V1_HASH,
    'the reconstructed v1 body must hash to the shipped previousHashes[1] literal, or pristine v1 copies cannot silently upgrade',
  );
  assert.notEqual(
    sha256Hex(REMEMBER_SKILL), REMEMBER_SKILL_V1_HASH,
    'the live v2 body must differ from the frozen v1 hash',
  );
});

test('precondition: frozen v1 git-discard-guard body hashes to GUARD_GIT_DISCARD_MJS_V1_HASH and differs from the live body', () => {
  assert.equal(
    sha256Hex(GUARD_GIT_DISCARD_MJS_V1), GUARD_GIT_DISCARD_MJS_V1_HASH,
    'the frozen v1 fixture must hash to the shipped previousHashes[1] literal, or a pristine v1 workspace cannot silently upgrade',
  );
  assert.notEqual(
    sha256Hex(GUARD_GIT_DISCARD_MJS), GUARD_GIT_DISCARD_MJS_V1_HASH,
    'the live body must differ from the v1 hash — otherwise the body was never actually rewritten and the bump is a lie',
  );
});

test('precondition: frozen v2 git-discard-guard body hashes to GUARD_GIT_DISCARD_MJS_V2_HASH and differs from the live v3 body', () => {
  assert.equal(
    sha256Hex(GUARD_GIT_DISCARD_MJS_V2), GUARD_GIT_DISCARD_MJS_V2_HASH,
    'the frozen v2 fixture must hash to the shipped previousHashes[2] literal, or a pristine v2 workspace (exit-0 deny) cannot silently upgrade to v3',
  );
  assert.notEqual(
    sha256Hex(GUARD_GIT_DISCARD_MJS), GUARD_GIT_DISCARD_MJS_V2_HASH,
    'the live (v3) body must differ from the v2 hash — otherwise the exit-0 -> per-provider exit(codex?0:2) rewrite was never applied',
  );
});

test('precondition: frozen v3 research-write-guard body hashes to RESEARCH_WRITE_GUARD_MJS_V3_HASH and differs from the live body', () => {
  assert.equal(
    sha256Hex(RESEARCH_WRITE_GUARD_MJS_V3), RESEARCH_WRITE_GUARD_MJS_V3_HASH,
    'the frozen v3 fixture must hash to the shipped previousHashes[3] literal, or a pristine v3 workspace cannot silently upgrade',
  );
  assert.notEqual(
    sha256Hex(RESEARCH_WRITE_GUARD_MJS), RESEARCH_WRITE_GUARD_MJS_V3_HASH,
    'the live body must differ from the v3 hash — otherwise the body was never actually rewritten and the bump is a lie',
  );
});

test('precondition: frozen v4 research-write-guard body hashes to RESEARCH_WRITE_GUARD_MJS_V4_HASH and differs from the live v5 body', () => {
  assert.equal(
    sha256Hex(RESEARCH_WRITE_GUARD_MJS_V4), RESEARCH_WRITE_GUARD_MJS_V4_HASH,
    'the frozen v4 fixture must hash to the shipped previousHashes[4] literal, or a pristine v4 workspace (exit-0 deny) cannot silently upgrade to v5',
  );
  assert.notEqual(
    sha256Hex(RESEARCH_WRITE_GUARD_MJS), RESEARCH_WRITE_GUARD_MJS_V4_HASH,
    'the live (v5) body must differ from the v4 hash — otherwise the exit-0 -> exit-2 rewrite was never applied',
  );
});

test('guard-git-discard.mjs v1 + sidecar v1 → silent upgrade to v3, no .bak', () => {
  const workDir = mktmp('guard-known-v1');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.dirname(guardScriptPath(workDir)), { recursive: true });
    fs.writeFileSync(guardScriptPath(workDir), GUARD_GIT_DISCARD_MJS_V1, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'scripts/guard-git-discard.mjs': 1 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkspaceScripts(workDir, 'windows');

    assert.equal(
      fs.readFileSync(guardScriptPath(workDir), 'utf-8'), GUARD_GIT_DISCARD_MJS,
      'a pristine v1 guard must silently upgrade to the exact current (v3) bundled body',
    );
    assert.equal(listGuardBackups(workDir).length, 0, 'known v1-hash upgrade must NOT create a backup');
    assert.equal(
      readSidecar(workDir)['scripts/guard-git-discard.mjs'], 3,
      `sidecar must record guard v3; got: ${JSON.stringify(readSidecar(workDir))}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('guard-git-discard.mjs v2 (exit-0 unenforcing) + sidecar v2 → silent upgrade to v3, no .bak', () => {
  const workDir = mktmp('guard-known-v2');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.dirname(guardScriptPath(workDir)), { recursive: true });
    fs.writeFileSync(guardScriptPath(workDir), GUARD_GIT_DISCARD_MJS_V2, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'scripts/guard-git-discard.mjs': 2 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkspaceScripts(workDir, 'windows');

    assert.equal(
      fs.readFileSync(guardScriptPath(workDir), 'utf-8'), GUARD_GIT_DISCARD_MJS,
      'a pristine v2 guard (the exit-0 unenforcing body) must silently upgrade to the exact v3 bundled body',
    );
    assert.equal(listGuardBackups(workDir).length, 0, 'known v2-hash upgrade must NOT create a backup');
    assert.equal(
      readSidecar(workDir)['scripts/guard-git-discard.mjs'], 3,
      `sidecar must record guard v3; got: ${JSON.stringify(readSidecar(workDir))}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('guard-git-discard.mjs locally-edited (unknown-hash) + no sidecar → .bak + overwrite with v3', () => {
  const workDir = mktmp('guard-user-mod');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.dirname(guardScriptPath(workDir)), { recursive: true });
    const edited = GUARD_GIT_DISCARD_MJS_V1 + '\n// LOCAL EDIT — must be backed up, not silently clobbered\n';
    fs.writeFileSync(guardScriptPath(workDir), edited, 'utf-8');

    supervisor.ensureWorkspaceScripts(workDir, 'windows');

    assert.equal(
      fs.readFileSync(guardScriptPath(workDir), 'utf-8'), GUARD_GIT_DISCARD_MJS,
      'an unknown-hash guard must be overwritten with the current (v3) bundled body',
    );
    const backups = listGuardBackups(workDir);
    assert.equal(backups.length, 1, `expected exactly one guard .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(
      fs.readFileSync(path.join(workDir, '.lares', 'scripts', backups[0]), 'utf-8'), edited,
      'backup must hold the locally-edited guard content verbatim',
    );
    assert.equal(readSidecar(workDir)['scripts/guard-git-discard.mjs'], 3, 'sidecar must record guard v3');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('research-write-guard.mjs v3 + sidecar v3 → silent upgrade to v5, no .bak', () => {
  const workDir = mktmp('rwguard-known-v3');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.dirname(researchGuardPath(workDir)), { recursive: true });
    fs.writeFileSync(researchGuardPath(workDir), RESEARCH_WRITE_GUARD_MJS_V3, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'researcher/scripts/research-write-guard.mjs': 3 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureResearcherScaffold(workDir, 'windows');

    assert.equal(
      fs.readFileSync(researchGuardPath(workDir), 'utf-8'), RESEARCH_WRITE_GUARD_MJS,
      'a pristine v3 research-write-guard must silently upgrade to the exact current (v5) bundled body',
    );
    assert.equal(listResearchGuardBackups(workDir).length, 0, 'known v3-hash upgrade must NOT create a backup');
    assert.equal(
      readSidecar(workDir)['researcher/scripts/research-write-guard.mjs'], 5,
      `sidecar must record research-write-guard v5; got: ${JSON.stringify(readSidecar(workDir))}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('research-write-guard.mjs v4 (exit-0 unenforcing) + sidecar v4 → silent upgrade to v5, no .bak', () => {
  const workDir = mktmp('rwguard-known-v4');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.dirname(researchGuardPath(workDir)), { recursive: true });
    fs.writeFileSync(researchGuardPath(workDir), RESEARCH_WRITE_GUARD_MJS_V4, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'researcher/scripts/research-write-guard.mjs': 4 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureResearcherScaffold(workDir, 'windows');

    assert.equal(
      fs.readFileSync(researchGuardPath(workDir), 'utf-8'), RESEARCH_WRITE_GUARD_MJS,
      'a pristine v4 research-write-guard (the exit-0 unenforcing body) must silently upgrade to the exact v5 bundled body',
    );
    assert.equal(listResearchGuardBackups(workDir).length, 0, 'known v4-hash upgrade must NOT create a backup');
    assert.equal(
      readSidecar(workDir)['researcher/scripts/research-write-guard.mjs'], 5,
      `sidecar must record research-write-guard v5; got: ${JSON.stringify(readSidecar(workDir))}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── Phase 4 (BrowserSigninSharing §D): researcher CLAUDE.md v4 → v5 ──────────
//
// v5 adds the `## Signed-in sites` section (`pending_signin` = wait/poll + retry
// the same call; `signin_unavailable` = blocked on a human re-arm; a guest view
// is an auth-verification FAILURE, never authenticated success). A pristine v4
// file must silently upgrade (no backup); the previousHashes[4] entry makes that
// silent upgrade possible.

/** The v5 researcher CLAUDE.md — the last pre-`.lares` body — reconstructed by
 *  reverting the state-dir rename (the ONLY v6 change). RN-R0 pins it to
 *  RESEARCHER_AGENT_MD_V5_HASH so any drift fails loudly. */
const RESEARCHER_AGENT_MD_V5 = RESEARCHER_AGENT_MD.split('.lares').join('.dashboard');

test('RN-R0. precondition: reconstructed v5 researcher CLAUDE.md hashes to the shipped constant', () => {
  assert.notEqual(RESEARCHER_AGENT_MD_V5, RESEARCHER_AGENT_MD, 'the v6 rename must change the body');
  assert.equal(sha256Hex(RESEARCHER_AGENT_MD_V5), RESEARCHER_AGENT_MD_V5_HASH,
    'reconstructed v5 researcher CLAUDE.md must hash to RESEARCHER_AGENT_MD_V5_HASH, or pristine v5 workspaces get .bak\'d instead of upgraded');
});

/** The v4 researcher CLAUDE.md, reconstructed by stripping the v5 `## Signed-in
 *  sites` section back out of the v5 body. The precondition test
 *  pins this to RESEARCHER_AGENT_MD_V4_HASH so any drift fails loudly. */
const RESEARCHER_AGENT_MD_V4 = RESEARCHER_AGENT_MD_V5.replace(
  /## Signed-in sites:[\s\S]*?\n\n(## Untrusted web content)/,
  '$1',
);

test('P4-0. precondition: reconstructed v4 researcher CLAUDE.md hashes to the shipped constant', () => {
  assert.notEqual(RESEARCHER_AGENT_MD_V4, RESEARCHER_AGENT_MD, 'the v5 signed-in-sites section must differ from v4');
  const hash = sha256Hex(RESEARCHER_AGENT_MD_V4);
  assert.equal(
    hash,
    RESEARCHER_AGENT_MD_V4_HASH,
    `Reconstructed v4 researcher CLAUDE.md hash (${hash}) does not match ` +
    `RESEARCHER_AGENT_MD_V4_HASH (${RESEARCHER_AGENT_MD_V4_HASH}). Old workspaces' ` +
    `pristine v4 researcher contract would be .bak'd instead of silently upgraded.`,
  );
});

test('P4-1. researcher CLAUDE.md: pristine v4 silently upgrades to v5 carrying the signed-in-sites wording once', () => {
  const workDir = mktmp('researcher-v4');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = researcherPath(workDir, 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, RESEARCHER_AGENT_MD_V4, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'researcher/CLAUDE.md': 4 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureResearcherScaffold(workDir, 'windows');

    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, RESEARCHER_AGENT_MD, 'pristine v4 researcher CLAUDE.md must silently upgrade to v5 bundled content');
    assert.equal(countMatches(content, '## Signed-in sites:'), 1, 'the signed-in-sites section appears exactly once (not double-appended)');
    assert.ok(content.includes('a guest view is NOT success') || content.includes('AUTH-VERIFICATION FAILURE'), 'upgraded contract must carry the guest≠success wording');
    const backups = fs.readdirSync(researcherPath(workDir)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v4→v5 upgrade must NOT create a backup');
    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['researcher/CLAUDE.md'], 6, `sidecar must record v5; got ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('G5. worker CLAUDE.md: pristine v1 silently upgrades to current carrying the research-store pointer', () => {
  const workDir = mktmp('worker-claudemd-v1');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'workers', 'claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, WORKER_CLAUDE_MD_V1, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'workers/claude/CLAUDE.md': 1 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, WORKER_CLAUDE_MD, 'v1 worker CLAUDE.md must silently upgrade to current bundled content');
    assert.equal(countMatches(content, RESEARCH_SECTION_MARKER), 1, 'research-store section appears exactly once (not double-appended)');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v1→current upgrade must NOT create a backup');
    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['workers/claude/CLAUDE.md'], 12, `sidecar must record current v12; got ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── GT-C Decision 2: worker CLAUDE.md v5 → v6 migration ──────────────────
//
// v6 (§2.6) rewrites the plan-event sentinel section (marker v1 → v2): the
// PLAN-EVENT sentinel becomes mandatory on EVERY plan-rail turn (not just writes)
// and the status vocabulary expands to
// integrated|reviewed|deliberating|blocked|rejected|scope-changed|transition. A
// pristine v5 file must silently upgrade; a locally-edited one must be .bak'd +
// overwritten.

const PLAN_EVENT_MARKER = '<!-- section:plan-event-sentinel v2 -->';

/** Verbatim v5 plan-event sentinel section (marker v1, "Optionally self-report").
 *  Used to reconstruct the pristine v5 worker CLAUDE.md from the current v6
 *  bundled constant; the precondition test pins the reconstruction to
 *  WORKER_CLAUDE_MD_V5_HASH so any drift fails loudly. */
const PLAN_EVENT_SECTION_V5 = `<!-- section:plan-event-sentinel v1 -->
## Planning surface: editing a plan section

If your launch bound you to a plan (you'll see \`AGENT_DASHBOARD_PLAN_ID\` /
\`AGENT_DASHBOARD_PLAN_SECTION\` in your environment), the dashboard records a
**trusted** provenance trail of what you actually touched — server-witnessed from
your tool calls, not from anything you narrate. Two habits keep that trail clean:

**1. Read the target section before you edit it.** Use the plan read tools
(\`read_plan_section\`, \`list_plan_sections\`, \`read_plan_projection\`) and, when
you're about to edit, request the section with \`mode:"raw+editWindow"\` — it
returns the byte-exact fragment to replace plus edit-discipline instructions. A
\`raw+editWindow\` read is a stronger edit-intent signal than a plain read. Then
edit natively (\`Edit\` / \`MultiEdit\`) — replace only that exact fragment and
**never** change a \`data-anchor\` value. Native edits are the only write path;
there is no plan-write MCP tool.

**2. Optionally self-report at turn-end via the sentinel.** End your final message
with a \`PLAN-EVENT\` comment block so the surface can show your own summary
alongside the trusted facts:

\`\`\`
<!--PLAN-EVENT
{ "status": "integrated", "result": "…", "next": "…", "claimed_section_anchor": "sec_a1b2c3" }
-->
\`\`\`

- \`status\` — one of \`integrated | rejected | scope-changed | transition\`.
- \`result\` / \`next\` — short free text (what landed; what's next).
- \`claimed_section_anchor\` — **optional, self-report ONLY.** It is stored for a
  claimed-vs-observed diagnostic comparison and is **never** used to attribute
  your edit; the trusted anchor is always derived server-side from your actual
  read/edit tool calls. Omit it if unsure — a wrong claim only shows as a
  mismatch, it never changes what you're credited with.

The sentinel is best-effort: if you omit it, the surface just shows "no
self-report" and your trusted trail is unaffected.
<!-- /section:plan-event-sentinel -->`;

/** The exact "Never use git to discard uncommitted work" section v8 inserts
 *  (immediately above the memory section), plus its trailing blank-line
 *  separator. Removing it from the current (v8) bundle reconstructs the v7 body.
 *  Kept byte-identical to constants.ts; GIT-W0 pins the reconstruction to
 *  WORKER_CLAUDE_MD_V7_HASH so any drift fails loudly. */
const GIT_DISCARD_SECTION_V8 = `## Never use git to discard uncommitted work

**Do not run** \`git checkout -- <file>\`, \`git restore\`, \`git clean\`, or
\`git stash\` — in this workspace or any other. No exceptions, including "I'll
stash it and pop it right back."

**Why.** Many agents share one working tree, and a single file routinely holds
hours of uncommitted work from several lanes at once — yours, another worker's,
and sometimes the human's. These commands operate on the *whole file*, not on
your edit, and they discard work that was never committed. There is no undo:
uncommitted content is not in git's object store, so nothing can recover it.
The blast radius has nothing to do with how small your own change was.

**What to do instead.** To undo a change you made, **edit the text back
literally with the \`Edit\` tool** — the same edit you used to make it, in
reverse; **not** by rewriting the file through a shell pipeline or redirect
(\`>\`, \`sed -i\`, \`tee\`), which silently converts line endings — a real
CRLF→LF incident left the content correct but every line byte-different. This
applies in particular to mutation testing (break a line, prove a test fails,
restore it): restore by re-editing the line, never by discarding the file. If
you cannot reconstruct the original text, say so at turn end and let the
supervisor resolve it; a stuck turn is cheap, destroyed work is not.

`;

/** The v7 worker CLAUDE.md — the `.lares`-renamed body BEFORE the git-discard
 *  section — reconstructed from the FROZEN v8 constant (WORKER_CLAUDE_MD_V8 — NOT
 *  the live v9 body, which since retired the behavioral.md instruction) by removing
 *  that section. GIT-W0 pins it to WORKER_CLAUDE_MD_V7_HASH so any drift fails
 *  loudly. Rooting on the frozen v8 body (not the live symbol) is the D11
 *  derivation-hazard fix: the live body drifts on every bump. */
const WORKER_CLAUDE_MD_V7 = WORKER_CLAUDE_MD_V8.split(GIT_DISCARD_SECTION_V8).join('');

test('GIT-W0. precondition: reconstructed v7 worker CLAUDE.md hashes to the shipped constant', () => {
  assert.notEqual(WORKER_CLAUDE_MD_V7, WORKER_CLAUDE_MD, 'the v8 git-discard section must change the body');
  assert.equal(sha256Hex(WORKER_CLAUDE_MD_V7), WORKER_CLAUDE_MD_V7_HASH,
    'reconstructed v7 worker CLAUDE.md must hash to WORKER_CLAUDE_MD_V7_HASH, or pristine v7 workspaces get .bak\'d instead of upgraded');
});

/** The v6 worker CLAUDE.md — the last pre-`.lares` body — reconstructed from the
 *  v7 body by reverting the state-dir rename (the ONLY v7 change). RN-W0 pins it
 *  to WORKER_CLAUDE_MD_V6_HASH so any drift fails loudly. */
const WORKER_CLAUDE_MD_V6 = WORKER_CLAUDE_MD_V7.split('.lares').join('.dashboard');

test('RN-W0. precondition: reconstructed v6 worker CLAUDE.md hashes to the shipped constant', () => {
  assert.notEqual(WORKER_CLAUDE_MD_V6, WORKER_CLAUDE_MD_V7, 'the v7 rename must change the body');
  assert.equal(sha256Hex(WORKER_CLAUDE_MD_V6), WORKER_CLAUDE_MD_V6_HASH,
    'reconstructed v6 worker CLAUDE.md must hash to WORKER_CLAUDE_MD_V6_HASH, or pristine v6 workspaces get .bak\'d instead of upgraded');
});

/** The v5 worker CLAUDE.md, reconstructed by swapping the v6 plan-event
 *  sentinel section back to its v5 form. The precondition test pins this to
 *  WORKER_CLAUDE_MD_V5_HASH. */
const WORKER_CLAUDE_MD_V5 = WORKER_CLAUDE_MD_V6.replace(
  /<!-- section:plan-event-sentinel v2 -->[\s\S]*?<!-- \/section:plan-event-sentinel -->/,
  PLAN_EVENT_SECTION_V5,
);

function workerClaudeMdPath(workDir: string): string {
  return path.join(workDir, '.lares', 'workers', 'claude', 'CLAUDE.md');
}

test('D2-0. precondition: reconstructed v5 worker CLAUDE.md hashes to the shipped constant', () => {
  assert.notEqual(WORKER_CLAUDE_MD_V5, WORKER_CLAUDE_MD, 'the v6 plan-event section must differ from v5');
  const hash = sha256Hex(WORKER_CLAUDE_MD_V5);
  assert.equal(
    hash,
    WORKER_CLAUDE_MD_V5_HASH,
    `Reconstructed v5 worker CLAUDE.md hash (${hash}) does not match ` +
    `WORKER_CLAUDE_MD_V5_HASH (${WORKER_CLAUDE_MD_V5_HASH}). Old workspaces' ` +
    `pristine v5 CLAUDE.md would be .bak'd instead of silently upgraded.`,
  );
});

test('D2-1. worker CLAUDE.md: pristine v5 silently upgrades to current (v10); the retired every-turn ceremony is dropped', () => {
  const workDir = mktmp('worker-claudemd-v5');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = workerClaudeMdPath(workDir);
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, WORKER_CLAUDE_MD_V5, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'workers/claude/CLAUDE.md': 5 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, WORKER_CLAUDE_MD, 'v5 worker CLAUDE.md must silently upgrade to the current bundled content');
    // WP-P0C (v10) retired the every-turn PLAN-EVENT ceremony; the upgraded body
    // carries the new worker planning-surface section instead.
    assert.equal(countMatches(content, PLAN_EVENT_MARKER), 0, 'the retired plan-event ceremony marker must be gone in v10');
    assert.ok(!content.includes('End EVERY plan-rail turn'), 'the mandatory-sentinel wording must be dropped in v10');
    assert.ok(content.includes('## Planning surface: proposals and plan folders'), 'upgraded CLAUDE.md must carry the new worker planning-surface section');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v5→v6 upgrade must NOT create a backup');
    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['workers/claude/CLAUDE.md'], 12, `sidecar must record current v12; got ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('GIT-W1. worker CLAUDE.md: pristine v7 silently upgrades to v8 carrying the git-discard section once', () => {
  const workDir = mktmp('worker-claudemd-v7');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = workerClaudeMdPath(workDir);
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, WORKER_CLAUDE_MD_V7, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'workers/claude/CLAUDE.md': 7 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, WORKER_CLAUDE_MD, 'v7 worker CLAUDE.md must silently upgrade to v8 bundled content');
    assert.equal(countMatches(content, '## Never use git to discard uncommitted work'), 1,
      'the git-discard section appears exactly once (not double-appended)');
    assert.ok(content.includes('edit the text back'), 'upgraded CLAUDE.md must carry the edit-back-literally remediation');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v7→v8 upgrade must NOT create a backup');
    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['workers/claude/CLAUDE.md'], 12, `sidecar must record current v12; got ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── memory-lessons v2 (WP-G): worker CLAUDE.md v8 → v9 ───────────────────────
//
// v9 RETIRES the shared `behavioral.md` read/append instruction: the section
// header becomes `## Memory & lessons` and the durable-exception paragraph is
// replaced with the injection-aware resident pointer (memory is injected at launch
// for supervisors; a worker fetches via the `recall_memory` tool or a raw read of
// `.lares/supervisor/memory/`), the cross-workspace discoverability line, and the
// `remember`-skill pointer. The live WORKER_CLAUDE_MD DERIVES from the frozen
// WORKER_CLAUDE_MD_V8; previousHashes[8] = the frozen v8 hash upgrades a pristine
// v8 workspace silently.

test('ML-W-D11. precondition: the frozen v8 worker CLAUDE.md hashes to the shipped constant', () => {
  assert.equal(sha256Hex(WORKER_CLAUDE_MD_V8), WORKER_CLAUDE_MD_V8_HASH,
    'WORKER_CLAUDE_MD_V8 must hash to WORKER_CLAUDE_MD_V8_HASH (previousHashes[8]), or pristine v8 workspaces get .bak\'d instead of upgraded');
});

test('ML-W-D11b. worker v8→v9 is a faithful derive-from-frozen transform (three D11 assertions)', () => {
  // (a) each OLD literal occurs EXACTLY ONCE in the frozen v8 source.
  assert.equal(countMatches(WORKER_CLAUDE_MD_V8, '## Memory: shared behavioral notes only'), 1,
    'the old section header must occur exactly once in the frozen v8 body');
  assert.equal(countMatches(WORKER_CLAUDE_MD_V8, 'The one durable exception is **`./behavioral.md`**'), 1,
    'the old behavioral.md paragraph must occur exactly once in the frozen v8 body');
  // (b) the frozen v9 body CONTAINS the then-new text.
  assert.ok(WORKER_CLAUDE_MD_V9.includes('## Memory & lessons'), 'v9 must carry the new section header');
  assert.ok(WORKER_CLAUDE_MD_V9.includes('injected at launch for supervisors'), 'v9 must be injection-aware');
  assert.ok(WORKER_CLAUDE_MD_V9.includes('serve **every** supervisor and worker'), 'v9 must carry the discoverability line');
  assert.ok(WORKER_CLAUDE_MD_V9.includes('recall_memory') && WORKER_CLAUDE_MD_V9.includes('`remember`'),
    'v9 must name both the recall_memory tool and the remember skill');
  assert.ok(WORKER_CLAUDE_MD_V9.includes('.lares/supervisor/memory/MEMORY.md')
    && WORKER_CLAUDE_MD_V9.includes('.lares/supervisor/memory/details/'),
    'v9 must name the raw-read fallback path (index + details)');
  // (c) the new live v9 body does NOT contain the retired behavioral.md instruction.
  assert.ok(!WORKER_CLAUDE_MD.includes('The one durable exception is'), 'v9 must drop the behavioral.md read/append instruction');
  assert.ok(!WORKER_CLAUDE_MD.includes('## Memory: shared behavioral notes only'), 'v9 must drop the old section header');
});

test('ML-W-1. worker CLAUDE.md: pristine v8 silently upgrades to v9 (no .bak)', () => {
  const workDir = mktmp('worker-claudemd-v8');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = workerClaudeMdPath(workDir);
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, WORKER_CLAUDE_MD_V8, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'workers/claude/CLAUDE.md': 8 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, WORKER_CLAUDE_MD, 'v8 worker CLAUDE.md must silently upgrade to v9 bundled content');
    assert.equal(countMatches(content, '## Memory & lessons'), 1, 'the new memory section header appears exactly once');
    assert.ok(!content.includes('The one durable exception is'), 'the upgraded body drops the behavioral.md instruction');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v8→v9 upgrade must NOT create a backup');
    assert.equal(readSidecar(workDir)['workers/claude/CLAUDE.md'], 12, 'sidecar must record current v12');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('ML-W-2. worker CLAUDE.md: locally-edited v8 (unknown hash) → .bak + overwrite with v9', () => {
  const workDir = mktmp('worker-claudemd-v8-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = workerClaudeMdPath(workDir);
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    const edited = WORKER_CLAUDE_MD_V8 + '\n## My local worker notes\n';
    fs.writeFileSync(mdPath, edited, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'workers/claude/CLAUDE.md': 8 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    assert.equal(fs.readFileSync(mdPath, 'utf-8'), WORKER_CLAUDE_MD, 'edited CLAUDE.md must be overwritten with v9 bundled content');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 1, `expected exactly one CLAUDE.md .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(readSidecar(workDir)['workers/claude/CLAUDE.md'], 12, 'sidecar must record current v12');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('D2-2. worker CLAUDE.md: locally-edited v5 (unknown hash) → .bak + overwrite with v6', () => {
  const workDir = mktmp('worker-claudemd-v5-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = workerClaudeMdPath(workDir);
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    const edited = WORKER_CLAUDE_MD_V5 + '\n## My local worker notes\n';
    fs.writeFileSync(mdPath, edited, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'workers/claude/CLAUDE.md': 5 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    assert.equal(fs.readFileSync(mdPath, 'utf-8'), WORKER_CLAUDE_MD, 'edited CLAUDE.md must be overwritten with v6 bundled content');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 1, `expected exactly one CLAUDE.md .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(
      fs.readFileSync(path.join(path.dirname(mdPath), backups[0]), 'utf-8'),
      edited,
      'backup must hold the locally-edited content verbatim',
    );
    assert.equal(readSidecar(workDir)['workers/claude/CLAUDE.md'], 12, 'sidecar must record current v12');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('G5. supervisor CLAUDE.md: fresh scaffold carries the research-store pointer once; second pass is a no-op', () => {
  const workDir = mktmp('sup-claudemd-fresh');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, SUPERVISOR_AGENT_MD, 'supervisor CLAUDE.md must be exact bundled content');
    assert.equal(countMatches(content, RESEARCH_SECTION_MARKER), 1, 'research-store section appears exactly once');
    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['supervisor/CLAUDE.md'], 22, `sidecar must record the current bundled version; got ${JSON.stringify(sidecar)}`);

    const beforeMtime = fs.statSync(mdPath).mtimeMs;
    supervisor.ensureSupervisorScaffold(workDir, 'windows');
    assert.equal(fs.statSync(mdPath).mtimeMs, beforeMtime, 'second pass must not rewrite CLAUDE.md');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'no backups expected on idempotent supervisor scaffold');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('context-analytics skill: scaffolded onto the SUPERVISOR lane only, idempotent', () => {
  const workDir = mktmp('sup-context-analytics-skill');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const skillPath = path.join(
      workDir, '.lares', 'supervisor', '.claude', 'skills', 'context-analytics', 'SKILL.md',
    );
    assert.ok(fs.existsSync(skillPath), 'the context-analytics SKILL.md must be written by the scaffold');
    const content = fs.readFileSync(skillPath, 'utf-8');
    assert.equal(content, SUPERVISOR_CONTEXT_ANALYTICS_SKILL, 'SKILL.md must be exact bundled content');
    // The frontmatter is what Claude Code indexes; a mangled template literal
    // (stray escapes, wrong leading bytes) would silently produce an unloadable
    // skill, so assert the header shape rather than only the whole-file equality.
    assert.ok(content.startsWith('---\nname: context-analytics\n'), 'frontmatter must open the file');
    assert.ok(content.includes('analytics:snapshot:fast'), 'the skill must name the exporter command');

    const sidecar = readSidecar(workDir);
    assert.equal(
      sidecar['supervisor/.claude/skills/context-analytics/SKILL.md'], 3,
      `sidecar must record the skill at v3 (installation-owned shim); got ${JSON.stringify(sidecar)}`,
    );

    // Second pass is a no-op — no rewrite, no .bak.
    const beforeMtime = fs.statSync(skillPath).mtimeMs;
    supervisor.ensureSupervisorScaffold(workDir, 'windows');
    assert.equal(fs.statSync(skillPath).mtimeMs, beforeMtime, 'second pass must not rewrite SKILL.md');
    const backups = fs.readdirSync(path.dirname(skillPath)).filter((n) => n.startsWith('SKILL.md.bak.'));
    assert.equal(backups.length, 0, 'no backups expected on an idempotent scaffold');

    // Lane scoping: the analytics consumer is the supervisor. The worker and
    // researcher kits deliberately do NOT carry this skill — every lane that
    // gets it pays its frontmatter as resident context on every session.
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');
    supervisor.ensureResearcherScaffold(workDir, 'windows');
    for (const lane of [
      path.join(workDir, '.lares', 'workers', 'claude', '.claude', 'skills', 'context-analytics'),
      path.join(workDir, '.lares', 'researcher', '.claude', 'skills', 'context-analytics'),
    ]) {
      assert.equal(fs.existsSync(lane), false, `context-analytics must NOT be scaffolded at ${lane}`);
    }
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── Usage-limits statusLine: worker settings.json v6 → v7 migration ──────
//
// plans/usage-limits-mcp-and-ui.md §1.4 — the worker .claude/settings.json gains
// a `statusLine` block (v6 → v7). A pristine v6 file must silently upgrade; a
// locally-edited one must be .bak'd + overwritten.

function workerSettingsPath(workDir: string): string {
  return path.join(workDir, '.lares', 'workers', 'claude', '.claude', 'settings.json');
}
function listSettingsBackups(workDir: string): string[] {
  const dir = path.join(workDir, '.lares', 'workers', 'claude', '.claude');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.startsWith('settings.json.bak.'));
}

test('UL-1. worker settings.json v6 (pristine) silently upgrades to v7 (statusLine added)', () => {
  const workDir = mktmp('worker-settings-v6');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const p = workerSettingsPath(workDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, WORKER_CLAUDE_SETTINGS_JSON_V6, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'workers/claude/.claude/settings.json': 6 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const content = fs.readFileSync(p, 'utf-8');
    assert.equal(content, WORKER_CLAUDE_SETTINGS_JSON, 'v6 settings must silently upgrade to exact v7 bundled content');
    assert.ok(content.includes('"statusLine"'), 'upgraded settings must carry the statusLine block');
    assert.ok(content.includes('dashboard-statusline.mjs'), 'statusLine must point at dashboard-statusline.mjs');
    assert.equal(listSettingsBackups(workDir).length, 0, 'known v6-hash upgrade must NOT create a backup');
    assert.equal(readSidecar(workDir)['workers/claude/.claude/settings.json'], 8, 'sidecar must record v8');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('UL-2. worker settings.json locally-edited (unknown hash) → .bak + overwrite with v7', () => {
  const workDir = mktmp('worker-settings-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const p = workerSettingsPath(workDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const edited = WORKER_CLAUDE_SETTINGS_JSON_V6.replace('"autoMemoryEnabled": false', '"autoMemoryEnabled": true');
    fs.writeFileSync(p, edited, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'workers/claude/.claude/settings.json': 6 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    assert.equal(fs.readFileSync(p, 'utf-8'), WORKER_CLAUDE_SETTINGS_JSON, 'edited settings must be overwritten with v7 bundled content');
    const backups = listSettingsBackups(workDir);
    assert.equal(backups.length, 1, `expected exactly one settings .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(
      fs.readFileSync(path.join(workDir, '.lares', 'workers', 'claude', '.claude', backups[0]), 'utf-8'),
      edited,
      'backup must hold the locally-edited content verbatim',
    );
    assert.equal(readSidecar(workDir)['workers/claude/.claude/settings.json'], 8, 'sidecar must record v8');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('GIT-S1. worker settings.json v7 (pristine) silently upgrades to v8 (PreToolUse git-discard guard added)', () => {
  const workDir = mktmp('worker-settings-v7');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const p = workerSettingsPath(workDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, WORKER_CLAUDE_SETTINGS_JSON_V7, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'workers/claude/.claude/settings.json': 7 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const content = fs.readFileSync(p, 'utf-8');
    assert.equal(content, WORKER_CLAUDE_SETTINGS_JSON, 'v7 settings must silently upgrade to exact v8 bundled content');
    assert.ok(content.includes('"PreToolUse"'), 'upgraded settings must carry the PreToolUse block');
    assert.ok(content.includes('guard-git-discard.mjs'), 'PreToolUse must point at guard-git-discard.mjs');
    assert.equal(listSettingsBackups(workDir).length, 0, 'known v7-hash upgrade must NOT create a backup');
    assert.equal(readSidecar(workDir)['workers/claude/.claude/settings.json'], 8, 'sidecar must record v8');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── Context-brick Inc 1 (D3/D4): supervisor CLAUDE.md v8 → v9 migration ──
//
// v9 appends the `<!-- reorientation-note-v1 -->` sentinel block (D1/D2) AND
// the `get_usage_limits` tool bullet (usage-limits workstream — landed on this
// surface without its own bump, so v9 carries both). A pristine v8 file must
// silently upgrade; a locally-edited one must be .bak'd + overwritten.

const REORIENTATION_MARKER = '<!-- reorientation-note-v1 -->';
const PLANNING_SURFACE_MARKER = '<!-- section:planning-surface v1 -->';

/** The pristine v14 supervisor CLAUDE.md, reconstructed from the current (v15)
 *  constant by undoing the two v15 continuation-request additions: the
 *  `save_continuation_brick` tool bullet and the appended
 *  `<!-- section:continuation-request v1 -->` block.
 *
 *  HEAD of the reconstruction chain: every older fixture (v13 → v12 → v11 → v9 →
 *  v8) is derived from this body, so a future bump adds ONE undo step here
 *  rather than re-deriving the chain. PV-0 pins it to
 *  SUPERVISOR_AGENT_MD_V14_HASH so any drift fails loudly. */
// ── v18 (cross-workspace-collaboration WP6) ──
// v18 extended the `launch_agent` tool bullet with the `supervisor-peer` launch
// mode and appended a `revive_agent` bullet after `fork_agent`. The reconstruction
// reverses BOTH edits — collapsing the extended launch_agent line back to the plain
// v17 one and removing the revive_agent bullet — before the older WP1 undo below.
// Neither v18 edit carries a `.lares`-rename or WP1 token, so undoing it first
// leaves every subsequent reversal untouched.

/** The v18 (WP6) extended `launch_agent` bullet, verbatim. */
const V18_LAUNCH_AGENT_LINE = "- **launch_agent** — Launch a new agent (args: workspace_id, title, role_description, prompt). Optional `mode`: `worker` (default — an owned child under you) or `supervisor-peer` (a TOP-LEVEL peer supervisor with NO owner edge, its own `.lares/supervisor` cwd and the supervisor toolset). `supervisor-peer` is the ONLY mode that may launch into another workspace (pass `workspace_id`), and cross-workspace peer launch is **supervisor-only**.";

/** The plain v17 `launch_agent` bullet the line above replaced. */
const V17_LAUNCH_AGENT_LINE = "- **launch_agent** — Launch a new agent (args: workspace_id, title, role_description, prompt)";

/** The v18 (WP6) appended `revive_agent` bullet, verbatim (with its leading
 *  newline — it sits directly after the `fork_agent` line). */
const V18_REVIVE_AGENT_BULLET = "\n- **revive_agent** — Revive a DONE or CRASHED terminal agent: relaunch its ORIGINAL session (resume) in its original workspace/cwd, top-level (no new owner edge), carrying its full prior context (args: agent_id, message?, force?). Both cross-workspace AND same-workspace revival require **supervisor privilege** (revival is a launch-class mutation) and every attempt is audited. Supported providers: **claude, codex** (gemini is not session-addressable and is rejected). An optional `message` is queued and delivered only AFTER the revived agent can orient.";

// ── v19 (checkpoint-forensics) — the NEW head of the chain ──
// v19 inserts the `<!-- section:turn-history v1 -->` block (documenting the
// checkpoint toolset) between the research-store close and the reorientation note,
// and registers the private checkpoint-forensics skill (a fresh v1 SUPERVISOR_FILES
// entry). The reconstruction strips that exact paired section back out with the
// same pinned regex the v19 file's migration relies on; because the insert touches
// neither the launch_agent/revive_agent bullets nor any `.lares`-rename token,
// stripping it FIRST leaves every subsequent reversal (v17 → v16 → …) untouched.

/** The pristine v18 supervisor CLAUDE.md, reconstructed from the FROZEN v19
 *  constant (SUPERVISOR_AGENT_MD_V19 — NOT the live v20 body, which since gained
 *  the memory-lessons-v2 memory-section rewrite) by stripping the exact paired
 *  turn-history section — the byte-inverse of the v19 insert. RN-S0d pins it to
 *  SUPERVISOR_AGENT_MD_V18_HASH so any drift fails loudly. Rooting the whole chain
 *  on the frozen v19 body (not the live symbol) is the D11 derivation-hazard fix:
 *  the live body drifts on every bump, the frozen snapshot does not. */
const SUPERVISOR_AGENT_MD_V18 = SUPERVISOR_AGENT_MD_V19.replace(
  /\n?<!-- section:turn-history v1 -->[\s\S]*?<!-- \/section:turn-history -->\n?/,
  '\n',
);

test('RN-S0d. precondition: reconstructed v18 supervisor CLAUDE.md hashes to the shipped constant', () => {
  assert.notEqual(SUPERVISOR_AGENT_MD_V18, SUPERVISOR_AGENT_MD, 'the v19 turn-history insert must change the body');
  assert.ok(!SUPERVISOR_AGENT_MD_V18.includes('section:turn-history'), 'the turn-history section must be stripped from the v18 reconstruction');
  assert.equal(sha256Hex(SUPERVISOR_AGENT_MD_V18), SUPERVISOR_AGENT_MD_V18_HASH,
    'reconstructed v18 supervisor CLAUDE.md must hash to SUPERVISOR_AGENT_MD_V18_HASH, or pristine v18 workspaces get .bak\'d instead of upgraded');
});

/** The pristine v17 supervisor CLAUDE.md, reconstructed from the v18 body (NOT the
 *  current v19 constant) by reverting the two WP6 tool-docs edits. Deriving it off
 *  SUPERVISOR_AGENT_MD_V18 keeps the whole chain valid through the new v19 head.
 *  RN-S0c pins it to SUPERVISOR_AGENT_MD_V17_HASH so any drift fails loudly. */
const SUPERVISOR_AGENT_MD_V17 = SUPERVISOR_AGENT_MD_V18
  .replace(V18_LAUNCH_AGENT_LINE, () => V17_LAUNCH_AGENT_LINE)
  .replace(V18_REVIVE_AGENT_BULLET, () => '');

test('RN-S0c. precondition: reconstructed v17 supervisor CLAUDE.md hashes to the shipped constant', () => {
  assert.notEqual(SUPERVISOR_AGENT_MD_V17, SUPERVISOR_AGENT_MD_V18, 'the v18 tool-docs edit must change the body');
  assert.equal(sha256Hex(SUPERVISOR_AGENT_MD_V17), SUPERVISOR_AGENT_MD_V17_HASH,
    'reconstructed v17 supervisor CLAUDE.md must hash to SUPERVISOR_AGENT_MD_V17_HASH, or pristine v17 workspaces get .bak\'d instead of upgraded');
});

// ── checkpoint-forensics: supervisor CLAUDE.md v18 → v19 + fresh private skill ──
//
// v19 documents the checkpoint/turn-history toolset in a resident persona section
// and ships the depth in a supervisor-private `checkpoint-forensics` skill. A
// pristine v18 file must silently upgrade (previousHashes[18] = the frozen v18
// hash); a locally-edited one must be .bak'd + overwritten. The skill is a fresh
// v1 managed entry (no previousHashes) deployed to the supervisor's private
// `.claude/skills/` tree — and an unknown pre-existing file at that path must be
// backed up before the managed body lands.

const CHECKPOINT_FORENSICS_REL = '.lares/supervisor/.claude/skills/checkpoint-forensics/SKILL.md';

function checkpointSkillPath(workDir: string): string {
  return path.join(workDir, ...CHECKPOINT_FORENSICS_REL.split('/'));
}

test('CF-0. v19 is the current bundled version, previousHashes[18] is registered, and v19 documents the turn-history section', () => {
  const managed = (AgentSupervisor as unknown as {
    SUPERVISOR_FILES: Record<string, { version: number; previousHashes?: Record<number, string> }>;
  }).SUPERVISOR_FILES['.lares/supervisor/CLAUDE.md'];
  assert.equal(managed.version, 22, 'the bundled supervisor CLAUDE.md must be current v22');
  assert.equal(
    managed.previousHashes?.[18],
    SUPERVISOR_AGENT_MD_V18_HASH,
    'previousHashes[18] must be SUPERVISOR_AGENT_MD_V18_HASH, or pristine v18 workspaces get .bak\'d instead of upgraded',
  );
  assert.equal(
    managed.previousHashes?.[19],
    SUPERVISOR_AGENT_MD_V19_HASH,
    'previousHashes[19] must be SUPERVISOR_AGENT_MD_V19_HASH, or pristine v19 workspaces get .bak\'d instead of upgraded',
  );
  // WP-P0C pinned v20; WP-GEMINI-RM freezes v21 for the v22 migration.
  assert.equal(managed.previousHashes?.[20], SUPERVISOR_AGENT_MD_V20_HASH, 'previousHashes[20] must be SUPERVISOR_AGENT_MD_V20_HASH');
  assert.equal(managed.previousHashes?.[21], SUPERVISOR_AGENT_MD_V21_HASH, 'previousHashes[21] must pin the frozen v21 body');
  assert.notEqual(
    sha256Hex(SUPERVISOR_AGENT_MD),
    SUPERVISOR_AGENT_MD_V20_HASH,
    'the live v21 body must differ from the frozen v20 hash (did the planning-artifacts section land?)',
  );
  // The persona names the six checkpoint verbs and points at the skill.
  assert.equal(countMatches(SUPERVISOR_AGENT_MD, '<!-- section:turn-history v1 -->'), 1, 'the turn-history section appears exactly once');
  for (const verb of ['list_checkpoints', 'diff_turn', 'restore_paths', 'revert_turn', 'prune_checkpoints', 'read_agent_files_touched']) {
    assert.ok(SUPERVISOR_AGENT_MD.includes(verb), `v19 persona must name ${verb}`);
  }
  assert.ok(SUPERVISOR_AGENT_MD.includes('checkpoint-forensics'), 'v19 persona must point at the checkpoint-forensics skill');
});

test('CF-1. supervisor CLAUDE.md: pristine v18 silently upgrades to v19 (no .bak); skill is written at v1', () => {
  const workDir = mktmp('sup-claudemd-v18');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, SUPERVISOR_AGENT_MD_V18, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 18 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, SUPERVISOR_AGENT_MD, 'pristine v18 supervisor CLAUDE.md must silently upgrade to the v19 bundled content');
    assert.equal(countMatches(content, '<!-- section:turn-history v1 -->'), 1, 'the turn-history section lands exactly once (not double-appended)');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v18→v19 upgrade must NOT create a backup');
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record current v22');
    // The fresh skill rides along on the same scaffold pass.
    assert.equal(fs.readFileSync(checkpointSkillPath(workDir), 'utf-8'), SUPERVISOR_CHECKPOINT_FORENSICS_SKILL, 'the checkpoint-forensics skill must be the exact bundled content');
    assert.equal(readSidecar(workDir)['supervisor/.claude/skills/checkpoint-forensics/SKILL.md'], 1, 'skill sidecar must record v1');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('CF-2. supervisor CLAUDE.md: locally-edited v18 (unknown hash) → .bak + overwrite with v19', () => {
  const workDir = mktmp('sup-claudemd-v18-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    const edited = SUPERVISOR_AGENT_MD_V18 + '\n## My local notes\n';
    fs.writeFileSync(mdPath, edited, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 18 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    assert.equal(fs.readFileSync(mdPath, 'utf-8'), SUPERVISOR_AGENT_MD, 'edited CLAUDE.md must be overwritten with the v19 bundled content');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 1, `expected exactly one CLAUDE.md .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(fs.readFileSync(path.join(path.dirname(mdPath), backups[0]), 'utf-8'), edited,
      'backup must hold the locally-edited content verbatim');
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record current v22');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── memory-lessons v2 (WP-G): supervisor CLAUDE.md v19 → v20 ─────────────────
//
// v20 rewrites the `## Memory` section to injection-aware text (the index is
// injected at launch for supervisors, not an instructed session-start read) + the
// D2 cold-resume preamble + validate-after-edit + the discoverability paragraph,
// and replaces the D10 `see behavioral.md B-11/B-12` phantom with self-contained
// triage guidance. The live SUPERVISOR_AGENT_MD DERIVES from the frozen
// SUPERVISOR_AGENT_MD_V19 via two `.split().join()` transforms; previousHashes[19]
// = the frozen v19 hash lets a pristine v19 workspace upgrade silently.

test('RN-S0e. precondition: the frozen v19 supervisor CLAUDE.md hashes to the shipped constant', () => {
  assert.equal(sha256Hex(SUPERVISOR_AGENT_MD_V19), SUPERVISOR_AGENT_MD_V19_HASH,
    'SUPERVISOR_AGENT_MD_V19 must hash to SUPERVISOR_AGENT_MD_V19_HASH (previousHashes[19]), or pristine v19 workspaces get .bak\'d instead of upgraded');
});

test('ML-S-D11. supervisor v19→v20 is a faithful derive-from-frozen transform (three D11 assertions)', () => {
  // (a) each OLD literal occurs EXACTLY ONCE in the frozen v19 source.
  assert.equal(countMatches(SUPERVISOR_AGENT_MD_V19, 'Check `./memory/MEMORY.md` at session start'), 1,
    'the old memory paragraph must occur exactly once in the frozen v19 body');
  assert.equal(countMatches(SUPERVISOR_AGENT_MD_V19, 'see behavioral.md B-11/B-12'), 1,
    'the D10 phantom must occur exactly once in the frozen v19 body');
  // (b) the new live v20 body CONTAINS the new text.
  assert.ok(SUPERVISOR_AGENT_MD.includes('injected into your context at launch'), 'v20 must be injection-aware');
  assert.ok(SUPERVISOR_AGENT_MD.includes('serve **every** supervisor and worker'), 'v20 must carry the discoverability paragraph');
  assert.ok(SUPERVISOR_AGENT_MD.includes('recall_memory') && SUPERVISOR_AGENT_MD.includes('`remember`'),
    'v20 must name both recall_memory (fetch) and remember (save)');
  assert.ok(SUPERVISOR_AGENT_MD.includes('memory-index.mjs validate'), 'v20 must carry the validate-after-edit pointer');
  assert.ok(SUPERVISOR_AGENT_MD.includes('re-orienting after a crash, reset, or continuation handoff'),
    'v20 must carry the D2 cold-resume re-orientation preamble');
  // (c) the new live v20 body does NOT contain the old text.
  assert.ok(!SUPERVISOR_AGENT_MD.includes('Check `./memory/MEMORY.md` at session start'),
    'v20 must drop the old session-start read instruction');
  assert.ok(!/behavioral\.md B-/.test(SUPERVISOR_AGENT_MD), 'v20 must carry no behavioral.md B- citation (D10)');
  // The `./memory/MEMORY.md` file path itself is retained (reframed), not deleted.
  assert.ok(SUPERVISOR_AGENT_MD.includes('`./memory/MEMORY.md`'), 'v20 must still name the memory index file path');
});

test('ML-S-1. supervisor CLAUDE.md: pristine v19 silently upgrades to v20 (no .bak)', () => {
  const workDir = mktmp('sup-claudemd-v19');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, SUPERVISOR_AGENT_MD_V19, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 19 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, SUPERVISOR_AGENT_MD, 'pristine v19 supervisor CLAUDE.md must silently upgrade to the v20 bundled content');
    assert.ok(content.includes('injected into your context at launch'), 'the upgraded body carries the injection-aware memory section');
    assert.ok(!/behavioral\.md B-/.test(content), 'the upgraded body carries no behavioral.md B- phantom');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v19→v20 upgrade must NOT create a backup');
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record current v22');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('ML-S-2. supervisor CLAUDE.md: locally-edited v19 (unknown hash) → .bak + overwrite with v20', () => {
  const workDir = mktmp('sup-claudemd-v19-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    const edited = SUPERVISOR_AGENT_MD_V19 + '\n## My local notes\n';
    fs.writeFileSync(mdPath, edited, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 19 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    assert.equal(fs.readFileSync(mdPath, 'utf-8'), SUPERVISOR_AGENT_MD, 'edited CLAUDE.md must be overwritten with the v20 bundled content');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 1, `expected exactly one CLAUDE.md .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(fs.readFileSync(path.join(path.dirname(mdPath), backups[0]), 'utf-8'), edited,
      'backup must hold the locally-edited content verbatim');
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record current v22');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('CF-3. checkpoint-forensics skill: fresh scaffold writes exact bytes at the private path with sidecar v1, supervisor-only', () => {
  const workDir = mktmp('sup-checkpoint-forensics-fresh');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const skillPath = checkpointSkillPath(workDir);
    assert.ok(fs.existsSync(skillPath), 'the checkpoint-forensics SKILL.md must be written by the scaffold');
    const content = fs.readFileSync(skillPath, 'utf-8');
    assert.equal(content, SUPERVISOR_CHECKPOINT_FORENSICS_SKILL, 'SKILL.md must be exact bundled content');
    // The frontmatter is what Claude Code indexes — assert the header shape too.
    assert.ok(content.startsWith('---\nname: checkpoint-forensics\n'), 'frontmatter must open the file');
    assert.ok(content.includes('# Checkpoint forensics'), 'the skill body must carry its H1');

    assert.equal(
      readSidecar(workDir)['supervisor/.claude/skills/checkpoint-forensics/SKILL.md'], 1,
      `skill sidecar must record v1; got ${JSON.stringify(readSidecar(workDir))}`,
    );

    // Second pass is a no-op — no rewrite, no .bak.
    const beforeMtime = fs.statSync(skillPath).mtimeMs;
    supervisor.ensureSupervisorScaffold(workDir, 'windows');
    assert.equal(fs.statSync(skillPath).mtimeMs, beforeMtime, 'second pass must not rewrite SKILL.md');
    const backups = fs.readdirSync(path.dirname(skillPath)).filter((n) => n.startsWith('SKILL.md.bak.'));
    assert.equal(backups.length, 0, 'no backups expected on an idempotent scaffold');

    // Lane scoping: checkpoint recovery is supervisor-only, so the worker and
    // researcher kits must NOT carry this skill (they would pay its frontmatter as
    // resident context for tools they cannot call).
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');
    supervisor.ensureResearcherScaffold(workDir, 'windows');
    for (const lane of [
      path.join(workDir, '.lares', 'workers', 'claude', '.claude', 'skills', 'checkpoint-forensics'),
      path.join(workDir, '.lares', 'researcher', '.claude', 'skills', 'checkpoint-forensics'),
    ]) {
      assert.equal(fs.existsSync(lane), false, `checkpoint-forensics must NOT be scaffolded at ${lane}`);
    }
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('CF-4. checkpoint-forensics skill: a pre-existing unknown SKILL.md at that path is backed up before the managed v1 body lands', () => {
  const workDir = mktmp('sup-checkpoint-forensics-collision');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const skillPath = checkpointSkillPath(workDir);
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    const unknown = '---\nname: checkpoint-forensics\n---\n# a user (or foreign) file that predates the managed skill\n';
    fs.writeFileSync(skillPath, unknown, 'utf-8');
    // No sidecar entry for the skill: the scaffolder sees an unmanaged file with an
    // unknown hash and must conserve it before overwriting.

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    assert.equal(fs.readFileSync(skillPath, 'utf-8'), SUPERVISOR_CHECKPOINT_FORENSICS_SKILL, 'the managed v1 body must overwrite the unknown file');
    const backups = fs.readdirSync(path.dirname(skillPath)).filter((n) => n.startsWith('SKILL.md.bak.'));
    assert.equal(backups.length, 1, `an unknown pre-existing file must be backed up first; got: ${backups.join(', ')}`);
    assert.equal(fs.readFileSync(path.join(path.dirname(skillPath), backups[0]), 'utf-8'), unknown, 'backup must hold the pre-existing content verbatim');
    assert.equal(readSidecar(workDir)['supervisor/.claude/skills/checkpoint-forensics/SKILL.md'], 1, 'skill sidecar must record v1 after the collision-safe write');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('WP6-0. previousHashes[17] is registered and v18 documents revive_agent + supervisor-peer', () => {
  const managed = (AgentSupervisor as unknown as {
    SUPERVISOR_FILES: Record<string, { version: number; previousHashes?: Record<number, string> }>;
  }).SUPERVISOR_FILES['.lares/supervisor/CLAUDE.md'];
  assert.equal(managed.version, 22, 'the bundled supervisor CLAUDE.md must be current v22');
  assert.equal(
    managed.previousHashes?.[17],
    SUPERVISOR_AGENT_MD_V17_HASH,
    'previousHashes[17] must be SUPERVISOR_AGENT_MD_V17_HASH, or pristine v17 workspaces get .bak\'d instead of upgraded',
  );
  // v18 documents the two WP6 capabilities.
  assert.ok(SUPERVISOR_AGENT_MD.includes('revive_agent'), 'v18 must document the revive_agent tool');
  assert.ok(SUPERVISOR_AGENT_MD.includes('supervisor-peer'), 'v18 must document the launch_agent supervisor-peer mode');
  assert.ok(/claude, codex/.test(SUPERVISOR_AGENT_MD), 'v18 revive_agent bullet must name the supported providers');
});

test('WP6-1. supervisor CLAUDE.md: pristine v17 silently upgrades to v18', () => {
  const workDir = mktmp('sup-claudemd-v17');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, SUPERVISOR_AGENT_MD_V17, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 17 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    assert.equal(fs.readFileSync(mdPath, 'utf-8'), SUPERVISOR_AGENT_MD,
      'pristine v17 supervisor CLAUDE.md must silently upgrade to the v18 bundled content');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v17→v18 upgrade must NOT create a backup');
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record current v22');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('WP6-2. supervisor CLAUDE.md: locally-edited v17 (unknown hash) → .bak + overwrite with v18', () => {
  const workDir = mktmp('sup-claudemd-v17-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    const edited = SUPERVISOR_AGENT_MD_V17 + '\n## My local notes\n';
    fs.writeFileSync(mdPath, edited, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 17 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    assert.equal(fs.readFileSync(mdPath, 'utf-8'), SUPERVISOR_AGENT_MD,
      'edited CLAUDE.md must be overwritten with the v18 bundled content');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 1, `expected exactly one CLAUDE.md .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(fs.readFileSync(path.join(path.dirname(mdPath), backups[0]), 'utf-8'), edited,
      'backup must hold the locally-edited content verbatim');
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record current v22');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── v17 (cross-workspace-collaboration WP1.3) ──
// v17 widened the `list_agents` tool bullet (foreign workspace_id is
// supervisor-only) and appended a `list_workspaces` bullet directly after it. The
// reconstruction reverses BOTH edits — collapsing the two-line block back to the
// single v16 `list_agents` line — before the older `.lares`→`.dashboard` undo.
// Because the WP1 text carries no `.lares` token, doing this undo first leaves the
// subsequent rename reversal (V16→V15) untouched.

/** The v17 `## Your Tools` block, verbatim (the widened list_agents bullet plus
 *  the appended list_workspaces bullet, on consecutive lines). */
const V17_TOOLS_BLOCK = "- **list_agents** — List agents with status, metadata (incl. `workspaceId`/`workspaceTitle`/`lastActivityAt`), and each agent's context reading inline (`context: {percentage, tokensUsed, turns, model}`) — this is the context-usage surface; there is no separate per-agent stats tool. With no `workspace_id` it lists your OWN workspace; passing another workspace's id reaches across workspaces, which is **supervisor-only** (a worker is refused)\n- **list_workspaces** — List the workspaces you can see, each with `{id, title, agentCounts}`. As a supervisor you see **every** workspace (cross-workspace discovery — pair with `list_agents {workspace_id}`); a worker sees only its own. No args";

/** The single v16 `list_agents` line the block above replaced. */
const V16_LIST_AGENTS_LINE = "- **list_agents** — List all agents with status, metadata, and each agent's context reading inline (`context: {percentage, tokensUsed, turns, model}`) — this is the context-usage surface; there is no separate per-agent stats tool";

/** The pristine v16 supervisor CLAUDE.md, reconstructed from the current (v17)
 *  constant by collapsing the WP1.3 two-bullet block back to the single v16
 *  list_agents line. RN-S0b pins it to SUPERVISOR_AGENT_MD_V16_HASH so any drift
 *  fails loudly. This is the HEAD of the reconstruction chain. */
const SUPERVISOR_AGENT_MD_V16 = SUPERVISOR_AGENT_MD_V17.replace(V17_TOOLS_BLOCK, () => V16_LIST_AGENTS_LINE);

test('RN-S0b. precondition: reconstructed v16 supervisor CLAUDE.md hashes to the shipped constant', () => {
  assert.notEqual(SUPERVISOR_AGENT_MD_V16, SUPERVISOR_AGENT_MD, 'the v17 tool-docs edit must change the body');
  assert.equal(sha256Hex(SUPERVISOR_AGENT_MD_V16), SUPERVISOR_AGENT_MD_V16_HASH,
    'reconstructed v16 supervisor CLAUDE.md must hash to SUPERVISOR_AGENT_MD_V16_HASH, or pristine v16 workspaces get .bak\'d instead of upgraded');
});

/** The v15 supervisor CLAUDE.md — the last pre-`.lares` body — reconstructed by
 *  reverting the state-dir rename (the ONLY v16 change) off the v16 body. RN-S0
 *  pins it to SUPERVISOR_AGENT_MD_V15_HASH so any drift fails loudly. */
const SUPERVISOR_AGENT_MD_V15 = SUPERVISOR_AGENT_MD_V16.split('.lares').join('.dashboard');

test('RN-S0. precondition: reconstructed v15 supervisor CLAUDE.md hashes to the shipped constant', () => {
  assert.notEqual(SUPERVISOR_AGENT_MD_V15, SUPERVISOR_AGENT_MD_V16, 'the v16 rename must change the body');
  assert.equal(sha256Hex(SUPERVISOR_AGENT_MD_V15), SUPERVISOR_AGENT_MD_V15_HASH,
    'reconstructed v15 supervisor CLAUDE.md must hash to SUPERVISOR_AGENT_MD_V15_HASH, or pristine v15 workspaces get .bak\'d instead of upgraded');
});

const SUPERVISOR_AGENT_MD_V14 = SUPERVISOR_AGENT_MD_V15
  .replace(V15_CONTINUATION_BRICK_BULLET, () => '')
  .replace(
    new RegExp(`\\n${V15_CONTINUATION_SECTION_OPEN}[\\s\\S]*?${V15_CONTINUATION_SECTION_CLOSE}\\n`),
    () => '',
  );

/** The pristine v13 supervisor CLAUDE.md, reconstructed from the v14 body by
 *  undoing the three v14 MCP context-overhead edits: the widened `list_agents`
 *  bullet, the deleted `get_context_stats` bullet, and the orchestration pointer
 *  that used to open with `list_orchestrations`. OV-0 pins it to
 *  SUPERVISOR_AGENT_MD_V13_HASH so any drift fails loudly. */
const SUPERVISOR_AGENT_MD_V13 = SUPERVISOR_AGENT_MD_V14
  .replace(V14_LIST_AGENTS_BULLET, () => V13_LIST_AGENTS_BULLET)
  // The deleted bullet sat between `send_keys_to_agent` and `get_usage_limits`,
  // not next to `list_agents` — put it back where it was.
  .replace('- **get_usage_limits**', () => V13_CONTEXT_STATS_BULLET + '- **get_usage_limits**')
  .replace(V14_ORCH_SKILL_POINTER, () => V13_ORCH_SKILL_POINTER);

/** The pristine v12 supervisor CLAUDE.md, reconstructed from the v13 body by
 *  undoing the four v13 event-noise edits: the turn-end bullet
 *  (`idle/done` → `idle`), the context tier (80%+ compact order → single 95%
 *  advisory), the Tier-1 decision line, and the appended muted-members paragraph.
 *  EV-0 pins it to SUPERVISOR_AGENT_MD_V12_HASH so any drift fails loudly. */
const SUPERVISOR_AGENT_MD_V12 = SUPERVISOR_AGENT_MD_V13
  .replace(V13_TURN_END_BULLET, () => V12_TURN_END_BULLET)
  .replace(V13_CONTEXT_BULLET, () => V12_CONTEXT_BULLET)
  .replace(V13_TIER1_LINE, () => V12_TIER1_LINE)
  .replace(V13_MUTED_MEMBERS_PARA, () => '');

/** The pristine v11 supervisor CLAUDE.md, reconstructed from the v12 body by
 *  putting back the two regions the v12 capability-parity trim removed
 *  (plans/context-overhead-review.md §2). CP-0 pins it to
 *  SUPERVISOR_AGENT_MD_V11_HASH so any drift in either fixture fails loudly.
 *
 *  It is defined HERE, ahead of the older reconstructions, because v12 was the
 *  first bump that DELETED prose: the v10 / v9 / v8 fixtures are chained off the
 *  v11 body (each undoing one later addition), and reconstructing them from the
 *  v12 constant would leave the deleted Teams/Notebooks/Browser text missing. */
const SUPERVISOR_AGENT_MD_V11 = SUPERVISOR_AGENT_MD_V12
  .replace(
    /## Multi-agent orchestration\n[\s\S]*?<!-- \/section:browser-tools -->/,
    () => SUPERVISOR_V11_ORCH_THROUGH_BROWSER,
  )
  .replace(
    /\n<!-- \/reorientation-note-v1 -->/,
    () => '\n' + SUPERVISOR_V11_REORIENT_EXTRA + '\n<!-- /reorientation-note-v1 -->',
  );

/** The v9 supervisor CLAUDE.md, reconstructed by removing the one v10 addition
 *  (the planning-surface sentinel block) from the v11 reconstruction. The
 *  precondition test below pins this reconstruction to SUPERVISOR_AGENT_MD_V9_HASH
 *  — if the append stops being clean, the hash check fails loudly. */
const SUPERVISOR_AGENT_MD_V9 = SUPERVISOR_AGENT_MD_V11
  .replace(/\n<!-- section:planning-surface v1 -->[\s\S]*?<!-- \/section:planning-surface -->\n/, '');

/** The v8 supervisor CLAUDE.md, reconstructed by further removing the two v9
 *  additions from the v9 reconstruction. The precondition test below pins this to
 *  the shipped SUPERVISOR_AGENT_MD_V8_HASH — if either addition stops being a
 *  clean append, the hash check fails loudly. */
const SUPERVISOR_AGENT_MD_V8 = SUPERVISOR_AGENT_MD_V9
  .replace(/\n<!-- reorientation-note-v1 -->[\s\S]*?<!-- \/reorientation-note-v1 -->\n/, '')
  .replace(/\n- \*\*get_usage_limits\*\*[^\n]*\n/, '\n');

test('CB-0. precondition: reconstructed v8 supervisor CLAUDE.md hashes to the shipped constant', () => {
  const hash = sha256Hex(SUPERVISOR_AGENT_MD_V8);
  assert.equal(
    hash,
    SUPERVISOR_AGENT_MD_V8_HASH,
    `Reconstructed v8 hash (${hash}) does not match SUPERVISOR_AGENT_MD_V8_HASH ` +
    `(${SUPERVISOR_AGENT_MD_V8_HASH}). Old workspaces' pristine v8 CLAUDE.md ` +
    `would be .bak'd instead of silently upgraded.`,
  );
});

test('CB-1. supervisor CLAUDE.md: pristine v8 silently upgrades to current carrying the reorientation sentinel once', () => {
  const workDir = mktmp('sup-claudemd-v8');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, SUPERVISOR_AGENT_MD_V8, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 8 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, SUPERVISOR_AGENT_MD, 'v8 supervisor CLAUDE.md must silently upgrade to current bundled content');
    assert.equal(countMatches(content, REORIENTATION_MARKER), 1, 'reorientation sentinel appears exactly once (not double-appended)');
    assert.ok(content.includes('## Re-Orientation on Revival'), 'upgraded CLAUDE.md must carry the re-orientation section');
    // v12 deduped the standalone get_my_context tool bullet; the authoritative
    // mention now lives in the re-orientation section as the first-call directive.
    assert.ok(
      content.includes('**Call `get_my_context` FIRST**'),
      'upgraded CLAUDE.md must carry the get_my_context first-call directive',
    );
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v8→current upgrade must NOT create a backup');
    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['supervisor/CLAUDE.md'], 22, `sidecar must record the current bundled version; got ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('CB-2. supervisor CLAUDE.md: locally-edited v8 (unknown hash) → .bak + overwrite with current', () => {
  const workDir = mktmp('sup-claudemd-v8-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    const edited = SUPERVISOR_AGENT_MD_V8 + '\n## My local notes\n';
    fs.writeFileSync(mdPath, edited, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 8 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    assert.equal(fs.readFileSync(mdPath, 'utf-8'), SUPERVISOR_AGENT_MD, 'edited CLAUDE.md must be overwritten with current bundled content');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 1, `expected exactly one CLAUDE.md .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(
      fs.readFileSync(path.join(path.dirname(mdPath), backups[0]), 'utf-8'),
      edited,
      'backup must hold the locally-edited content verbatim',
    );
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record the current bundled version');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── Planning-surface: supervisor CLAUDE.md v9 → v10 migration ────────────
//
// v10 appends the `<!-- section:planning-surface v1 -->` sentinel block: how a
// supervisor mints (`create_plan`), dispatches into (`launch_agent` /
// `run_orchestration` with `{plan_id, section_anchor}`), observes
// (`read_plan_projection` / `read_plan_section`), and gates a plan surface, plus
// the one-writer 409 policy. A pristine v9 file must silently upgrade; a
// locally-edited one must be .bak'd + overwritten.

test('PS-0. precondition: reconstructed v9 supervisor CLAUDE.md hashes to the shipped constant', () => {
  const hash = sha256Hex(SUPERVISOR_AGENT_MD_V9);
  assert.equal(
    hash,
    SUPERVISOR_AGENT_MD_V9_HASH,
    `Reconstructed v9 hash (${hash}) does not match SUPERVISOR_AGENT_MD_V9_HASH ` +
    `(${SUPERVISOR_AGENT_MD_V9_HASH}). Old workspaces' pristine v9 CLAUDE.md ` +
    `would be .bak'd instead of silently upgraded.`,
  );
});

test('PS-1. supervisor CLAUDE.md: pristine v9 silently upgrades to v10 carrying the planning-surface sentinel once', () => {
  const workDir = mktmp('sup-claudemd-v9');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, SUPERVISOR_AGENT_MD_V9, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 9 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, SUPERVISOR_AGENT_MD, 'v9 supervisor CLAUDE.md must silently upgrade to v10 bundled content');
    assert.equal(countMatches(content, PLANNING_SURFACE_MARKER), 1, 'planning-surface sentinel appears exactly once (not double-appended)');
    assert.ok(content.includes('## Planning surface: minting and gating a plan'), 'upgraded CLAUDE.md must carry the planning-surface section');
    assert.ok(content.includes('`create_plan`'), 'upgraded CLAUDE.md must mention create_plan');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v9→current upgrade must NOT create a backup');
    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['supervisor/CLAUDE.md'], 22, `sidecar must record the current bundled version; got ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('PS-2. supervisor CLAUDE.md: locally-edited v9 (unknown hash) → .bak + overwrite with v10', () => {
  const workDir = mktmp('sup-claudemd-v9-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    const edited = SUPERVISOR_AGENT_MD_V9 + '\n## My local notes\n';
    fs.writeFileSync(mdPath, edited, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 9 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    assert.equal(fs.readFileSync(mdPath, 'utf-8'), SUPERVISOR_AGENT_MD, 'edited CLAUDE.md must be overwritten with current bundled content');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 1, `expected exactly one CLAUDE.md .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(
      fs.readFileSync(path.join(path.dirname(mdPath), backups[0]), 'utf-8'),
      edited,
      'backup must hold the locally-edited content verbatim',
    );
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record the current bundled version');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── Execution-Trail doctrine: supervisor CLAUDE.md v10 → v11 migration ────
//
// v11 rewrites the `<!-- section:planning-surface v1 -->` block to teach that the
// Execution Trail (`sec_exectr`) is system-owned — never dispatch a writer to it or
// edit it — and to dispatch execution workers to the section they UPDATE
// (`sec_opitem` for checklist execution) with a mandated turn-end completion
// writeback (flip `&#9744;`→`&#9745;` natively + emit a PLAN-EVENT sentinel). The
// section markers are unchanged, so the v9 reconstruction (whole-block removal)
// still holds; the v10 reconstruction swaps the block back to its original wording.
// A pristine v10 file must silently upgrade; a locally-edited one must be .bak'd +
// overwritten.

/** The original (v10) `<!-- section:planning-surface v1 -->` block, verbatim.
 *  SUPERVISOR_AGENT_MD_V10 swaps the current (v11) block back to this; the
 *  precondition test pins the reconstruction to SUPERVISOR_AGENT_MD_V10_HASH so any
 *  drift in the swap fails loudly. */
const PLANNING_SURFACE_SECTION_V10 = `<!-- section:planning-surface v1 -->
## Planning surface: minting and gating a plan

A **plan surface** is a workspace HTML planning document (\`plans/*.html\`) with
anchored sections (\`sec_…\`), a **trusted server-witnessed provenance trail** (what
each dispatched agent actually read/edited, derived from its tool calls — not from
what it narrates), and a dashboard render pane. Every plan is minted from a
pre-baked **6-zone template** — Summary / Open Questions / Research / Decisions /
Execution Trail / Open Items — so you and your agents **fill sections in; you never
author the structure**.

The loop:

- **Mint** with \`create_plan\` — returns the plan id and its section anchors.
- **Dispatch** with \`launch_agent {plan_id, section_anchor}\` (single worker) or
  \`run_orchestration {plan_id, section_anchor}\` (GroupThink rail). The dispatched
  agent edits its assigned section **natively in the HTML** — there is no markdown
  deliverable and no plan-write MCP tool.
- **Observe** with \`read_plan_projection\` (per-section trusted event roll-up) and
  \`read_plan_section\` (ladder modes: \`outline\` ≈150 tokens / \`text\` / \`raw\` /
  \`raw+editWindow\`).
- **Gate** the returned work as you would any worker turn.

**One-writer policy:** dispatching a second active writer to the same plan is
**409-rejected**, naming the run that already owns it — sequence writers, don't
double-book a plan.

**Reading is cheap by design:** prefer \`outline\` mode + section-scoped reads over
whole-file reads; pull \`raw\` / \`raw+editWindow\` only when you actually need bytes.
<!-- /section:planning-surface -->`;

/** The v10 supervisor CLAUDE.md, reconstructed by swapping the current (v11)
 *  planning-surface block back to its original v10 wording. The precondition test
 *  below pins this to SUPERVISOR_AGENT_MD_V10_HASH. */
const SUPERVISOR_AGENT_MD_V10 = SUPERVISOR_AGENT_MD_V11.replace(
  /\n<!-- section:planning-surface v1 -->[\s\S]*?<!-- \/section:planning-surface -->\n/,
  '\n' + PLANNING_SURFACE_SECTION_V10 + '\n',
);

test('ET-0. precondition: reconstructed v10 supervisor CLAUDE.md hashes to the shipped constant', () => {
  assert.notEqual(SUPERVISOR_AGENT_MD_V10, SUPERVISOR_AGENT_MD_V11, 'the v11 planning-surface block must differ from v10');
  const hash = sha256Hex(SUPERVISOR_AGENT_MD_V10);
  assert.equal(
    hash,
    SUPERVISOR_AGENT_MD_V10_HASH,
    `Reconstructed v10 hash (${hash}) does not match SUPERVISOR_AGENT_MD_V10_HASH ` +
    `(${SUPERVISOR_AGENT_MD_V10_HASH}). Old workspaces' pristine v10 CLAUDE.md ` +
    `would be .bak'd instead of silently upgraded.`,
  );
});

test('ET-1. supervisor CLAUDE.md: pristine v10 silently upgrades to v11 carrying the sec_exectr doctrine once', () => {
  const workDir = mktmp('sup-claudemd-v10');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, SUPERVISOR_AGENT_MD_V10, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 10 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, SUPERVISOR_AGENT_MD, 'v10 supervisor CLAUDE.md must silently upgrade to v11 bundled content');
    assert.equal(countMatches(content, PLANNING_SURFACE_MARKER), 1, 'planning-surface sentinel appears exactly once (not double-appended)');
    assert.ok(content.includes('system-owned'), 'upgraded CLAUDE.md must carry the system-owned sec_exectr doctrine');
    assert.ok(content.includes('NEVER dispatch a writer to `sec_exectr`'), 'upgraded CLAUDE.md must forbid dispatching to sec_exectr');
    assert.ok(content.includes('`sec_opitem`'), 'upgraded CLAUDE.md must name sec_opitem as the checklist-execution target');
    assert.ok(content.includes('completion writeback'), 'upgraded CLAUDE.md must mandate the completion writeback');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v10→v11 upgrade must NOT create a backup');
    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['supervisor/CLAUDE.md'], 22, `sidecar must record the current bundled version; got ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('ET-2. supervisor CLAUDE.md: locally-edited v10 (unknown hash) → .bak + overwrite with v11', () => {
  const workDir = mktmp('sup-claudemd-v10-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    const edited = SUPERVISOR_AGENT_MD_V10 + '\n## My local notes\n';
    fs.writeFileSync(mdPath, edited, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 10 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    assert.equal(fs.readFileSync(mdPath, 'utf-8'), SUPERVISOR_AGENT_MD, 'edited CLAUDE.md must be overwritten with v11 bundled content');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 1, `expected exactly one CLAUDE.md .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(
      fs.readFileSync(path.join(path.dirname(mdPath), backups[0]), 'utf-8'),
      edited,
      'backup must hold the locally-edited content verbatim',
    );
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record the current bundled version');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── Capability-parity trim: supervisor CLAUDE.md v11 → v12 ───────────────
//
// v12 (plans/context-overhead-review.md §2, Tier 1) deletes the resident
// documentation for tools the supervisor lane is NOT granted — `## Teams`,
// `## Notebooks (live kernel)`, and the full-`browser` readback/automation prose —
// drops the obsolete `## Platform notes (Windows + PowerShell 5.1)` section,
// replaces the browser section with the one-arg `browser-present` schema, and
// compresses `## Multi-agent orchestration` to a pointer at the run-orchestration
// skill. Unlike v9/v10/v11 there is no single sentinel block to swap back, so the
// v11 fixture is FROZEN as a hash only: SUPERVISOR_AGENT_MD_V11_HASH was captured
// from the v11 constant before the edit. A pristine v11 file must silently
// upgrade; a locally-edited one must be .bak'd + overwritten (users who hand-edited
// their supervisor CLAUDE.md DO lose those edits to a .bak — intended
// managed-scaffold behavior).

/** A locally-edited v11 copy — content whose hash is NOT a known managed hash. */
const SUPERVISOR_AGENT_MD_V11_EDITED = SUPERVISOR_AGENT_MD_V11 + '\n## My local notes\n';

test('CP-0. precondition: the frozen v11 hash is registered for silent v11→v12 upgrade', () => {
  const previous = (AgentSupervisor as unknown as {
    SUPERVISOR_FILES: Record<string, { version: number; previousHashes?: Record<number, string> }>;
  }).SUPERVISOR_FILES['.lares/supervisor/CLAUDE.md'];
  assert.equal(previous.version, 22, 'supervisor CLAUDE.md must be at current version 22');
  assert.equal(
    previous.previousHashes?.[11],
    SUPERVISOR_AGENT_MD_V11_HASH,
    'previousHashes[11] must be SUPERVISOR_AGENT_MD_V11_HASH, or pristine v11 workspaces get .bak\'d instead of upgraded',
  );
  assert.notEqual(
    sha256Hex(SUPERVISOR_AGENT_MD),
    SUPERVISOR_AGENT_MD_V11_HASH,
    'the shipped constant must differ from the frozen v11 hash (did the §2 edits land?)',
  );
  const hash = sha256Hex(SUPERVISOR_AGENT_MD_V11);
  assert.equal(
    hash,
    SUPERVISOR_AGENT_MD_V11_HASH,
    `Reconstructed v11 hash (${hash}) does not match SUPERVISOR_AGENT_MD_V11_HASH ` +
    `(${SUPERVISOR_AGENT_MD_V11_HASH}). Old workspaces' pristine v11 CLAUDE.md ` +
    `would be .bak'd instead of silently upgraded.`,
  );
});

test('CP-1a. supervisor CLAUDE.md: pristine v11 silently upgrades to v12 (ungranted-tool docs gone)', () => {
  const workDir = mktmp('sup-claudemd-v11');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, SUPERVISOR_AGENT_MD_V11, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 11 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, SUPERVISOR_AGENT_MD, 'pristine v11 supervisor CLAUDE.md must silently upgrade to the current bundled content');
    assert.ok(!content.includes('## Teams'), 'the upgraded persona must not document the ungranted teams toolset');
    assert.ok(!content.includes('## Notebooks'), 'the upgraded persona must not document the ungranted notebooks toolset');
    assert.ok(!content.includes('browser_click'), 'the upgraded persona must not document researcher-only browser automation');
    assert.equal(countMatches(content, PLANNING_SURFACE_MARKER), 1, 'planning-surface sentinel survives exactly once');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v11→v12 upgrade must NOT create a backup');
    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['supervisor/CLAUDE.md'], 22, `sidecar must record the current bundled version; got ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('CP-1. supervisor CLAUDE.md: the shipped content documents no ungranted tool surface', () => {
  for (const gone of ['## Teams', '## Notebooks (live kernel)', '## Platform notes', 'create_team', 'execute_cell', 'browser_click', 'for_human_action']) {
    assert.ok(!SUPERVISOR_AGENT_MD.includes(gone), `the shipped persona must not contain '${gone}'`);
  }
  assert.ok(SUPERVISOR_AGENT_MD.includes('browser_open_url'), 'the browser-present open-only capability survives');
  assert.ok(SUPERVISOR_AGENT_MD.includes('run-orchestration skill'), 'orchestration detail stays deferred to the skill');
});

test('CP-2. supervisor CLAUDE.md: locally-edited v11 (unknown hash) → .bak + overwrite with v12', () => {
  const workDir = mktmp('sup-claudemd-v11-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, SUPERVISOR_AGENT_MD_V11_EDITED, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 11 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    assert.equal(fs.readFileSync(mdPath, 'utf-8'), SUPERVISOR_AGENT_MD, 'edited CLAUDE.md must be overwritten with the current bundled content');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 1, `expected exactly one CLAUDE.md .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(
      fs.readFileSync(path.join(path.dirname(mdPath), backups[0]), 'utf-8'),
      SUPERVISOR_AGENT_MD_V11_EDITED,
      'backup must hold the locally-edited content verbatim',
    );
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record the current bundled version');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── Supervisor event-noise reduction: supervisor CLAUDE.md v12 → v13 ─────
//
// v13 realigns the persona with the event bridge after the noise cut: `done` no
// longer produces an event at all, context_threshold collapsed from [80, 90, 95]
// to a single 95% ADVISORY tier (100% is a cost signal, not a cutoff — a
// near-complete agent should be allowed to finish), and orchestration members are
// muted so a GroupThink run no longer spams its launcher with per-turn idles.
// SUPERVISOR_AGENT_MD_V12_HASH was captured from the v12 constant before the edit;
// the reconstruction at the head of the chain must hash back to it.

/** A locally-edited v12 copy — content whose hash is NOT a known managed hash. */
const SUPERVISOR_AGENT_MD_V12_EDITED = SUPERVISOR_AGENT_MD_V12 + '\n## My local notes\n';

test('EV-0. precondition: the frozen v12 hash is registered for silent v12→v13 upgrade', () => {
  const managed = (AgentSupervisor as unknown as {
    SUPERVISOR_FILES: Record<string, { version: number; previousHashes?: Record<number, string> }>;
  }).SUPERVISOR_FILES['.lares/supervisor/CLAUDE.md'];
  assert.equal(
    managed.previousHashes?.[12],
    SUPERVISOR_AGENT_MD_V12_HASH,
    'previousHashes[12] must be SUPERVISOR_AGENT_MD_V12_HASH, or pristine v12 workspaces get .bak\'d instead of upgraded',
  );
  assert.notEqual(
    sha256Hex(SUPERVISOR_AGENT_MD),
    SUPERVISOR_AGENT_MD_V12_HASH,
    'the v13 constant must differ from the frozen v12 hash (did the event-noise edits land?)',
  );
  const hash = sha256Hex(SUPERVISOR_AGENT_MD_V12);
  assert.equal(
    hash,
    SUPERVISOR_AGENT_MD_V12_HASH,
    `Reconstructed v12 hash (${hash}) does not match SUPERVISOR_AGENT_MD_V12_HASH ` +
    `(${SUPERVISOR_AGENT_MD_V12_HASH}). Old workspaces' pristine v12 CLAUDE.md ` +
    `would be .bak'd instead of silently upgraded.`,
  );
});

test('EV-1. supervisor CLAUDE.md: the v13 content teaches the reduced event surface', () => {
  // The doc and the bridge must not drift: whatever the bridge stops delivering,
  // the persona must stop promising.
  assert.ok(!SUPERVISOR_AGENT_MD.includes('- **idle/done**'),
    'v13 must not promise a `done` event — the bridge no longer delivers one');
  assert.ok(!SUPERVISOR_AGENT_MD.includes('context threshold (80%+)'),
    'v13 must not advertise the retired 80% tier');
  assert.ok(SUPERVISOR_AGENT_MD.includes('context threshold (95%)'),
    'v13 names the single 95% notification tier');
  assert.ok(SUPERVISOR_AGENT_MD.includes('100% context is not a literal cutoff'),
    'v13 states plainly that 100% is not a hard cutoff');
  assert.ok(/let it finish/.test(SUPERVISOR_AGENT_MD),
    'v13 tells the supervisor to let near-complete work finish rather than force a handoff');
  assert.ok(SUPERVISOR_AGENT_MD.includes('Orchestration members are **muted**'),
    'v13 explains why a running orchestration produces no per-member turn events');
});

test('EV-2. supervisor CLAUDE.md: pristine v12 silently upgrades to v13', () => {
  const workDir = mktmp('sup-claudemd-v12');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, SUPERVISOR_AGENT_MD_V12, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 12 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, SUPERVISOR_AGENT_MD, 'pristine v12 supervisor CLAUDE.md must silently upgrade to the current bundled content');
    assert.equal(countMatches(content, PLANNING_SURFACE_MARKER), 1, 'planning-surface sentinel survives exactly once');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v12→v13 upgrade must NOT create a backup');
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record the current bundled version');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('EV-3. supervisor CLAUDE.md: locally-edited v12 (unknown hash) → .bak + overwrite with v13', () => {
  const workDir = mktmp('sup-claudemd-v12-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, SUPERVISOR_AGENT_MD_V12_EDITED, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 12 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    assert.equal(fs.readFileSync(mdPath, 'utf-8'), SUPERVISOR_AGENT_MD, 'edited CLAUDE.md must be overwritten with the current bundled content');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 1, `expected exactly one CLAUDE.md .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(
      fs.readFileSync(path.join(path.dirname(mdPath), backups[0]), 'utf-8'),
      SUPERVISOR_AGENT_MD_V12_EDITED,
      'backup must hold the locally-edited content verbatim',
    );
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record the current bundled version');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── MCP context-overhead cut: supervisor CLAUDE.md v13 → v14 ─────────
//
// v14 removes the persona's resident documentation for two MCP tools deleted in
// the same pass: `get_context_stats` (redundant — `list_agents` already returns
// the reading inline) and `list_orchestrations` (a one-entry catalog that never
// surfaced the serial|parallel choice). SUPERVISOR_AGENT_MD_V13_HASH was
// captured from the v13 constant before the edit; the reconstruction at the head
// of the chain must hash back to it.

/** A locally-edited v13 copy — content whose hash is NOT a known managed hash. */
const SUPERVISOR_AGENT_MD_V13_EDITED = SUPERVISOR_AGENT_MD_V13 + '\n## My local notes\n';

test('OV-0. precondition: the frozen v13 hash is registered for silent v13→v14 upgrade', () => {
  const managed = (AgentSupervisor as unknown as {
    SUPERVISOR_FILES: Record<string, { version: number; previousHashes?: Record<number, string> }>;
  }).SUPERVISOR_FILES['.lares/supervisor/CLAUDE.md'];
  assert.equal(managed.version, 22, 'the bundled supervisor CLAUDE.md must be current v22');
  assert.equal(
    managed.previousHashes?.[13],
    SUPERVISOR_AGENT_MD_V13_HASH,
    'previousHashes[13] must be SUPERVISOR_AGENT_MD_V13_HASH, or pristine v13 workspaces get .bak\'d instead of upgraded',
  );
  assert.notEqual(
    sha256Hex(SUPERVISOR_AGENT_MD),
    SUPERVISOR_AGENT_MD_V13_HASH,
    'the v14 constant must differ from the frozen v13 hash (did the tool-doc deletions land?)',
  );
  const hash = sha256Hex(SUPERVISOR_AGENT_MD_V13);
  assert.equal(
    hash,
    SUPERVISOR_AGENT_MD_V13_HASH,
    `Reconstructed v13 hash (${hash}) does not match SUPERVISOR_AGENT_MD_V13_HASH ` +
    `(${SUPERVISOR_AGENT_MD_V13_HASH}). Old workspaces' pristine v13 CLAUDE.md ` +
    `would be .bak'd instead of silently upgraded.`,
  );
});

test('OV-1. supervisor CLAUDE.md: v14 documents no deleted MCP tool, and keeps the capability', () => {
  assert.ok(!SUPERVISOR_AGENT_MD.includes('get_context_stats'),
    'v14 must not document get_context_stats — the tool was deleted');
  assert.ok(!SUPERVISOR_AGENT_MD.includes('list_orchestrations'),
    'v14 must not document list_orchestrations — the tool was deleted');
  // The capability survives the tool: list_agents carries the context reading.
  assert.ok(SUPERVISOR_AGENT_MD.includes('tokensUsed'),
    'v14 must name the inline context block list_agents returns, so the reading is still discoverable');
  assert.ok(SUPERVISOR_AGENT_MD.includes('run_orchestration'),
    'v14 keeps the orchestration entry point');
});

test('OV-2. supervisor CLAUDE.md: pristine v13 silently upgrades to v14', () => {
  const workDir = mktmp('sup-claudemd-v13');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, SUPERVISOR_AGENT_MD_V13, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 13 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, SUPERVISOR_AGENT_MD, 'pristine v13 supervisor CLAUDE.md must silently upgrade to the current bundled content');
    assert.equal(countMatches(content, PLANNING_SURFACE_MARKER), 1, 'planning-surface sentinel survives exactly once');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v13→current upgrade must NOT create a backup');
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record current v22');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('OV-3. supervisor CLAUDE.md: locally-edited v13 (unknown hash) → .bak + overwrite with v14', () => {
  const workDir = mktmp('sup-claudemd-v13-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, SUPERVISOR_AGENT_MD_V13_EDITED, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 13 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    assert.equal(fs.readFileSync(mdPath, 'utf-8'), SUPERVISOR_AGENT_MD, 'edited CLAUDE.md must be overwritten with the current bundled content');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 1, `expected exactly one CLAUDE.md .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(
      fs.readFileSync(path.join(path.dirname(mdPath), backups[0]), 'utf-8'),
      SUPERVISOR_AGENT_MD_V13_EDITED,
      'backup must hold the locally-edited content verbatim',
    );
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record current v22');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── Continuation-request awareness: supervisor CLAUDE.md v14 → v15 ───
//
// v15 teaches the persona about the handoff it is the SUBJECT of: the
// `save_continuation_brick` tool bullet and the continuation-request section.
// SUPERVISOR_AGENT_MD_V14_HASH was captured from the v14 constant before the
// edit; the reconstruction at the head of the chain must hash back to it.

/** A locally-edited v14 copy — content whose hash is NOT a known managed hash. */
const SUPERVISOR_AGENT_MD_V14_EDITED = SUPERVISOR_AGENT_MD_V14 + '\n## My local notes\n';

test('PV-0. precondition: the frozen v14 hash is registered for silent v14→v15 upgrade', () => {
  const managed = (AgentSupervisor as unknown as {
    SUPERVISOR_FILES: Record<string, { version: number; previousHashes?: Record<number, string> }>;
  }).SUPERVISOR_FILES['.lares/supervisor/CLAUDE.md'];
  assert.equal(managed.version, 22, 'the bundled supervisor CLAUDE.md must be current v22');
  assert.equal(
    managed.previousHashes?.[14],
    SUPERVISOR_AGENT_MD_V14_HASH,
    'previousHashes[14] must be SUPERVISOR_AGENT_MD_V14_HASH, or pristine v14 workspaces get .bak\'d instead of upgraded',
  );
  assert.notEqual(
    sha256Hex(SUPERVISOR_AGENT_MD),
    SUPERVISOR_AGENT_MD_V14_HASH,
    'the v15 constant must differ from the frozen v14 hash (did the continuation-request additions land?)',
  );
  const hash = sha256Hex(SUPERVISOR_AGENT_MD_V14);
  assert.equal(
    hash,
    SUPERVISOR_AGENT_MD_V14_HASH,
    `Reconstructed v14 hash (${hash}) does not match SUPERVISOR_AGENT_MD_V14_HASH ` +
    `(${SUPERVISOR_AGENT_MD_V14_HASH}). Old workspaces' pristine v14 CLAUDE.md ` +
    `would be .bak'd instead of silently upgraded.`,
  );
});

test('PV-1. supervisor CLAUDE.md: v15 documents save_continuation_brick and how to answer a continuation request', () => {
  assert.ok(SUPERVISOR_AGENT_MD.includes('save_continuation_brick'),
    'v15 must name the tool the supervisor is expected to call under a deadline');
  assert.equal(countMatches(SUPERVISOR_AGENT_MD, V15_CONTINUATION_SECTION_OPEN), 1,
    'the continuation-request sentinel block appears exactly once');
  assert.equal(countMatches(SUPERVISOR_AGENT_MD, V15_CONTINUATION_SECTION_CLOSE), 1);
  // The four load-bearing instructions: answer THAT turn, pointers over prose,
  // respect the byte cap, and don't start new work before the swap.
  assert.ok(/THAT TURN/.test(SUPERVISOR_AGENT_MD), 'the timing rule must be explicit');
  assert.ok(SUPERVISOR_AGENT_MD.includes('pointers'), 'state-and-pointers, not narration');
  assert.ok(/byte limit/.test(SUPERVISOR_AGENT_MD), 'the byte cap must be stated');
  assert.ok(/[Ss]tart no new work/.test(SUPERVISOR_AGENT_MD), 'no new work before the swap');
  // The runtime injection stays the authority on attempt specifics — the
  // scaffold must not hard-code an attempt id or a literal timeout.
  assert.ok(!/attempt att-/.test(SUPERVISOR_AGENT_MD), 'no attempt-specific detail belongs in the durable scaffold');
});

test('PV-2. supervisor CLAUDE.md: pristine v14 silently upgrades to v15', () => {
  const workDir = mktmp('sup-claudemd-v14');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, SUPERVISOR_AGENT_MD_V14, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 14 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, SUPERVISOR_AGENT_MD, 'pristine v14 supervisor CLAUDE.md must silently upgrade to the v15 bundled content');
    assert.equal(countMatches(content, PLANNING_SURFACE_MARKER), 1, 'planning-surface sentinel survives exactly once');
    assert.equal(countMatches(content, V15_CONTINUATION_SECTION_OPEN), 1, 'the new block lands exactly once');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v14→v15 upgrade must NOT create a backup');
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record current v22');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('PV-3. supervisor CLAUDE.md: locally-edited v14 (unknown hash) → .bak + overwrite with v15', () => {
  const workDir = mktmp('sup-claudemd-v14-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'supervisor', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, SUPERVISOR_AGENT_MD_V14_EDITED, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/CLAUDE.md': 14 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    assert.equal(fs.readFileSync(mdPath, 'utf-8'), SUPERVISOR_AGENT_MD, 'edited CLAUDE.md must be overwritten with the v15 bundled content');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 1, `expected exactly one CLAUDE.md .bak.<ts>; got: ${backups.join(', ')}`);
    assert.equal(
      fs.readFileSync(path.join(path.dirname(mdPath), backups[0]), 'utf-8'),
      SUPERVISOR_AGENT_MD_V14_EDITED,
      'backup must hold the locally-edited content verbatim',
    );
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 22, 'sidecar must record current v22');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── EDR P0.1: orchestration-spike skill RETIREMENT (v3 removal entry) ──
//
// The skill's detached/hidden launch recipe (`nohup … &`, `Start-Process
// -WindowStyle Hidden cmd`) is the SentinelOne false-positive class; v3 is a
// `removed: true` entry so deployed kits DELETE the file on next template touch.
// The v1/v2 bodies no longer exist in code (the constant was deleted), so the
// pristine-hash delete path is covered by scaffold-writer.test.ts R1–R4 with
// synthetic content; here we pin the shipped entry's shape and the end-to-end
// supervisor behavior around it.

const SPIKE_REL = '.lares/supervisor/.claude/skills/orchestration-spike/SKILL.md';

test('EDR-0. the orchestration-spike entry is a v3 removal with both shipped-body hashes frozen', () => {
  const managed = (AgentSupervisor as unknown as {
    SUPERVISOR_FILES: Record<string, { version: number; removed?: boolean; content: string; previousHashes?: Record<number, string> }>;
  }).SUPERVISOR_FILES[SPIKE_REL];
  assert.ok(managed, 'the retirement entry must stay in SUPERVISOR_FILES — dropping it strands not-yet-upgraded workspaces');
  assert.equal(managed.removed, true, 'the entry must be a removal, not content');
  assert.equal(managed.version, 3, 'the retirement is v3');
  assert.equal(managed.previousHashes?.[1], SUPERVISOR_ORCHESTRATION_SPIKE_SKILL_V1_HASH, 'v1 (pre-.lares) body hash must be registered');
  assert.equal(managed.previousHashes?.[2], SUPERVISOR_ORCHESTRATION_SPIKE_SKILL_V2_HASH, 'v2 (last shipped) body hash must be registered');
  assert.notEqual(managed.previousHashes?.[1], managed.previousHashes?.[2], 'the two frozen hashes must differ');
});

test('EDR-1. fresh supervisor scaffold does NOT create the retired skill; sidecar records the removal', () => {
  const workDir = mktmp('sup-spike-fresh');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureSupervisorScaffold(workDir, 'windows');
    const skillPath = path.join(workDir, ...SPIKE_REL.split('/'));
    assert.equal(fs.existsSync(skillPath), false, 'the retired skill must never be scaffolded');
    assert.equal(readSidecar(workDir)['supervisor/.claude/skills/orchestration-spike/SKILL.md'], 3,
      'sidecar must record the applied removal so a user file later created here is left alone');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('EDR-2. deployed copy at sidecar v2 with drifted content → .bak + deleted on next scaffold', () => {
  const workDir = mktmp('sup-spike-v2');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    // The real v2 body is retired from code; any non-matching bytes exercise the
    // conservative branch (backup before removal). The pristine silent-delete
    // branch is unit-tested in scaffold-writer.test.ts R1.
    const skillPath = path.join(workDir, ...SPIKE_REL.split('/'));
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    const body = '---\nname: orchestration-spike\n---\nlocally drifted copy\n';
    fs.writeFileSync(skillPath, body, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/.claude/skills/orchestration-spike/SKILL.md': 2 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    assert.equal(fs.existsSync(skillPath), false, 'the retired skill file must be deleted');
    const dir = path.dirname(skillPath);
    const backups = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith('SKILL.md.bak.')) : [];
    assert.equal(backups.length, 1, `unknown-hash removal must back up first; got: ${backups.join(', ')}`);
    assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf-8'), body, 'backup must hold the drifted content verbatim');
    assert.equal(readSidecar(workDir)['supervisor/.claude/skills/orchestration-spike/SKILL.md'], 3, 'sidecar must record the removal');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('EDR-3. no shipped supervisor scaffold content carries a hidden/detached launch recipe', () => {
  const files = (AgentSupervisor as unknown as {
    SUPERVISOR_FILES: Record<string, { content: string; removed?: boolean }>;
  }).SUPERVISOR_FILES;
  const pattern = /WindowStyle|Start-Process|nohup|WScript|wscript|EncodedCommand/;
  for (const [rel, f] of Object.entries(files)) {
    if (f.removed) continue;
    assert.ok(!pattern.test(f.content), `${rel} must not ship a hidden/detached launch pattern`);
  }
  assert.ok(!pattern.test(SUPERVISOR_AGENT_MD), 'the supervisor persona must not ship a hidden/detached launch pattern');
});

// ── Codex worker standing instructions (AGENTS.md) ───────────────────
//
// The Codex worker lane ships AGENTS.md (standing instructions) alongside its
// config.toml, so a Codex worker gets the same standing instructions as a Claude
// worker. (WP-G retired the seed-once behavioral.md the AGENTS.md used to point
// at.) These exercise the fresh-write + sidecar-record + idempotency of that
// managed file.

function codexPath(workDir: string, ...rel: string[]): string {
  return path.join(workDir, '.lares', 'workers', 'codex', ...rel);
}

test('CX-AGENTS-1. codex scaffold: fresh workspace writes AGENTS.md v1 + records it in the sidecar', () => {
  const workDir = mktmp('codex-agents-fresh');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    const agentsPath = codexPath(workDir, 'AGENTS.md');
    assert.ok(fs.existsSync(agentsPath), 'codex AGENTS.md must exist after scaffold');
    assert.equal(
      fs.readFileSync(agentsPath, 'utf-8'),
      WORKER_CODEX_AGENTS_MD,
      'codex AGENTS.md must be the exact bundled (derived) content',
    );

    const sidecar = readSidecar(workDir);
    assert.equal(
      sidecar['workers/codex/AGENTS.md'], 5,
      `sidecar must record current AGENTS.md v4; got: ${JSON.stringify(sidecar)}`,
    );

    // The config.toml still ships alongside it (unchanged by this WP).
    assert.ok(fs.existsSync(codexPath(workDir, '.codex', 'config.toml')), 'config.toml must still be written');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('CX-AGENTS-2. codex scaffold: idempotent — a pristine AGENTS.md is not rewritten and gets no .bak', async () => {
  const workDir = mktmp('codex-agents-idempotent');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');
    const agentsPath = codexPath(workDir, 'AGENTS.md');

    const beforeMtime = fs.statSync(agentsPath).mtimeMs;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    assert.equal(fs.statSync(agentsPath).mtimeMs, beforeMtime, 'pristine AGENTS.md must not be rewritten on re-run');
    const baks = fs.readdirSync(path.dirname(agentsPath)).filter((n) => n.startsWith('AGENTS.md.bak'));
    assert.equal(baks.length, 0, `no .bak expected on idempotent re-run; got: ${baks.join(', ')}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── memory-lessons v2 (WP-G): codex AGENTS.md v1 → v2 ────────────────
//
// The codex AGENTS.md is DERIVED from WORKER_CLAUDE_MD, so the worker v8→v9
// memory-section rewrite carries into the codex body: v1 = derived-from-v8
// (WORKER_CODEX_AGENTS_MD_V1, frozen), v2 = derived-from-v9 (live
// WORKER_CODEX_AGENTS_MD). previousHashes[1] = the frozen v1 hash upgrades a
// pristine v1 workspace silently.

test('CX-AGENTS-D11. codex v1→v2 inherits the worker memory rewrite; the derivation literals hold', () => {
  const live = WORKER_CODEX_AGENTS_MD, v1 = WORKER_CODEX_AGENTS_MD_V1;
  assert.notEqual(live, v1, 'the codex v2 body must differ from the frozen v1 body');
  // v1 (derived from frozen v8) still carries the retired behavioral.md instruction;
  // v2 (derived from v9) carries the new memory-lessons text.
  assert.ok(v1.includes('The one durable exception is'), 'the frozen v1 codex body carries the old behavioral.md instruction');
  assert.ok(!live.includes('The one durable exception is'), 'the live v2 codex body drops the behavioral.md instruction');
  assert.ok(live.includes('## Memory & lessons') && live.includes('recall_memory'),
    'the live v2 codex body carries the new memory-lessons section');
  // The provider-specific transforms still fired in the derived body.
  assert.ok(!live.includes('.lares/workers/claude/') && live.includes('.lares/workers/codex/'),
    'cwd refs are rewritten to the codex lane');
  assert.ok(!live.includes('AskUserQuestion'), 'the Claude-Code-specific tool name is stripped');
  // The `.lares/supervisor/memory/…` fetch path is provider-neutral — it points at
  // the SUPERVISOR memory for BOTH lanes and is NOT rewritten to a codex path.
  assert.ok(live.includes('.lares/supervisor/memory/'), 'the supervisor memory surface remains provider-neutral in the codex body');
  assert.ok(!live.includes('.lares/supervisor/memory/MEMORY.md'), 'the live body must drop raw index-read guidance');
});

test('CX-AGENTS-3. codex AGENTS.md: pristine v1 silently upgrades to v2 (no .bak)', () => {
  const workDir = mktmp('codex-agents-v1');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const agentsPath = codexPath(workDir, 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
    fs.writeFileSync(agentsPath, WORKER_CODEX_AGENTS_MD_V1, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'workers/codex/AGENTS.md': 1 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    assert.equal(fs.readFileSync(agentsPath, 'utf-8'), WORKER_CODEX_AGENTS_MD,
      'pristine v1 codex AGENTS.md must silently upgrade to the v2 bundled (derived) content');
    const baks = fs.readdirSync(path.dirname(agentsPath)).filter((n) => n.startsWith('AGENTS.md.bak'));
    assert.equal(baks.length, 0, `known-hash v1→v2 upgrade must NOT create a backup; got: ${baks.join(', ')}`);
    assert.equal(readSidecar(workDir)['workers/codex/AGENTS.md'], 5, 'sidecar must record current v5');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── Codex worker config.toml: historical-version silent upgrade ──────
//
// WORKER_CODEX_CONFIG_TOML_V3 is *derived* (not a duplicated literal) so it can
// never drift by hand-copy — but it must be derived from the RIGHT ancestor.
// The v3 → v4 bump ONLY renamed the state folder (.dashboard → .lares) in the
// hook command paths, so the true v3 body is exactly the v4 body with that
// rename reverted. Deriving it from the LIVE body instead (which since gained a
// SessionStart header rewrite and, at v5, a PreToolUse guard block v3 never had)
// reproduces a body v3 never shipped, so previousHashes[3] stops matching a real
// on-disk v3 file and that pristine workspace gets .bak'd + overwritten instead
// of silently upgraded. These pin both the reconstruction shape and the upgrade.

test('CX-CFG-V3-shape. reconstructed v3 config.toml is the true historical body (no guard, no PreToolUse, .dashboard paths)', () => {
  // Structural pins that uniquely distinguish the true v3 body from a
  // live-body-derived reconstruction: v3 long predates the PreToolUse
  // git-discard guard and still used the `.dashboard/` folder throughout.
  assert.ok(
    !WORKER_CODEX_CONFIG_TOML_V3.includes('[[hooks.PreToolUse]]'),
    'v3 predates the guard — reconstruction must NOT contain a PreToolUse block',
  );
  assert.ok(
    !WORKER_CODEX_CONFIG_TOML_V3.includes('guard-git-discard'),
    'v3 predates the guard — reconstruction must NOT reference guard-git-discard.mjs',
  );
  assert.ok(
    WORKER_CODEX_CONFIG_TOML_V3.includes('[[hooks.SessionStart]]'),
    'v3 shipped the SessionStart hook (added at v3)',
  );
  assert.ok(
    !WORKER_CODEX_CONFIG_TOML_V3.includes('/.lares/scripts/'),
    'v3 used the legacy .dashboard/ folder — no /.lares/ path may survive the rename revert',
  );
  assert.ok(
    WORKER_CODEX_CONFIG_TOML_V3.includes('/.dashboard/scripts/dashboard-status.mjs'),
    'v3 hook command must point at the .dashboard/ dashboard-status.mjs path',
  );
  // Ground truth independent of the derivation source: v3 is v2 (Stop +
  // UserPromptSubmit) plus the SessionStart block, all on .dashboard paths.
  const expectedV3 = WORKER_CODEX_CONFIG_TOML_V2 +
    '\n[[hooks.SessionStart]]\n\n' +
    '[[hooks.SessionStart.hooks]]\n' +
    'type = "command"\n' +
    'command = \'node "${WORKSPACE_ROOT}/.dashboard/scripts/dashboard-status.mjs" session-start\'\n' +
    'timeout = 30\n';
  assert.equal(
    WORKER_CODEX_CONFIG_TOML_V3, expectedV3,
    'reconstructed v3 body must be byte-exact v2 + the SessionStart block on .dashboard paths',
  );
});

test('CX-CFG-V3-upgrade. a pristine on-disk v3 codex config.toml upgrades to current SILENTLY, no .bak', () => {
  const workDir = mktmp('codex-cfg-v3');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    // Materialize a genuine historical v3 config.toml INDEPENDENTLY of the
    // WORKER_CODEX_CONFIG_TOML_V3 constant: the true v3 bytes are the v4 body
    // with the .lares → .dashboard rename reverted. If the derivation regresses
    // to the live body, previousHashes[3] no longer matches this file and the
    // assertions below (no .bak, exact content) fail.
    const posixRoot = workDir.replace(/\\/g, '/');
    const trueV3OnDisk = WORKER_CODEX_CONFIG_TOML_V4
      .split('/.lares/scripts/dashboard-status.mjs')
      .join('/.dashboard/scripts/dashboard-status.mjs')
      .replace(/\$\{WORKSPACE_ROOT\}/g, posixRoot);

    const configPath = codexPath(workDir, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, trueV3OnDisk, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'workers/codex/.codex/config.toml': 3 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    const expectedCurrent = WORKER_CODEX_CONFIG_TOML.replace(/\$\{WORKSPACE_ROOT\}/g, posixRoot);
    assert.equal(
      fs.readFileSync(configPath, 'utf-8'), expectedCurrent,
      'pristine v3 config.toml must silently upgrade to the exact current (v6) bundled content',
    );

    const codexDir = codexPath(workDir, '.codex');
    const baks = fs.readdirSync(codexDir).filter((n) => n.startsWith('config.toml.bak'));
    assert.equal(
      baks.length, 0,
      `pristine v3 config.toml must upgrade with NO .bak (previousHashes[3] must match true v3); got: ${baks.join(', ')}`,
    );

    const sidecar = readSidecar(workDir);
    assert.equal(
      sidecar['workers/codex/.codex/config.toml'], 6,
      `sidecar must record the config.toml at v6 after upgrade; got: ${JSON.stringify(sidecar)}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── Codex worker config.toml: v5 → v6 (Path A feature gate) ──────────
//
// v6 (Path A, probe 2026-07-28) makes the worker-cwd config the REAL native-
// Windows hook carrier: it adds `[features] hooks = true` (no profile layer to
// supply the gate) and rewrites the now-stale INERT header. WORKER_CODEX_CONFIG_
// TOML_V5 is the FROZEN pre-Path-A body (verbatim, NOT derived from the live
// constant) so a pristine v5 workspace's materialized config.toml is recognized
// by previousHashes[5] and upgraded silently. (scaffold-content-needs-version-
// bump lesson.)

test('CX-CFG-V5-shape. the frozen v5 body is the true pre-Path-A body (no [features], old INERT header) and differs from live', () => {
  assert.notEqual(
    WORKER_CODEX_CONFIG_TOML_V5, WORKER_CODEX_CONFIG_TOML,
    'the frozen v5 body must differ from the live v6 body (else no content change was made)',
  );
  // The distinguishing v6 additions must be ABSENT from the frozen v5 fixture —
  // otherwise a v5 workspace would already look like v6 and the bump is moot.
  assert.ok(!/^\[features\]$/m.test(WORKER_CODEX_CONFIG_TOML_V5), 'the frozen v5 body must NOT contain the [features] gate');
  assert.ok(/NEVER loads this/.test(WORKER_CODEX_CONFIG_TOML_V5), 'the frozen v5 body must carry the old INERT header');
  // And the v6 additions must be PRESENT in the live body.
  assert.ok(/^\[features\]$/m.test(WORKER_CODEX_CONFIG_TOML), 'the live v6 body must contain the [features] gate');
  assert.ok(!/NEVER loads this/.test(WORKER_CODEX_CONFIG_TOML), 'the live v6 body must have rewritten the INERT header');
  // v5 still shipped all four hook blocks incl. the PreToolUse guard (added at v5).
  assert.ok(WORKER_CODEX_CONFIG_TOML_V5.includes('[[hooks.PreToolUse]]'), 'v5 shipped the PreToolUse guard block');
  assert.ok(WORKER_CODEX_CONFIG_TOML_V5.includes('/.lares/scripts/'), 'v5 used the .lares script paths (post-v4 rename)');
});

test('CX-CFG-V5-upgrade. a pristine on-disk v5 codex config.toml upgrades to v6 SILENTLY, no .bak', () => {
  const workDir = mktmp('codex-cfg-v5');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    // Materialize a genuine historical v5 config.toml from the FROZEN v5 body
    // (independent of the live constant), then confirm the v5→v6 migration
    // recognizes it via previousHashes[5] and upgrades with no .bak.
    const posixRoot = workDir.replace(/\\/g, '/');
    const v5OnDisk = WORKER_CODEX_CONFIG_TOML_V5.replace(/\$\{WORKSPACE_ROOT\}/g, posixRoot);

    const configPath = codexPath(workDir, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, v5OnDisk, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'workers/codex/.codex/config.toml': 5 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    const expectedCurrent = WORKER_CODEX_CONFIG_TOML.replace(/\$\{WORKSPACE_ROOT\}/g, posixRoot);
    assert.equal(
      fs.readFileSync(configPath, 'utf-8'), expectedCurrent,
      'pristine v5 config.toml must silently upgrade to the exact current (v6) bundled content',
    );

    const codexDir = codexPath(workDir, '.codex');
    const baks = fs.readdirSync(codexDir).filter((n) => n.startsWith('config.toml.bak'));
    assert.equal(
      baks.length, 0,
      `pristine v5 config.toml must upgrade with NO .bak (previousHashes[5] must match the frozen v5); got: ${baks.join(', ')}`,
    );

    const sidecar = readSidecar(workDir);
    assert.equal(
      sidecar['workers/codex/.codex/config.toml'], 6,
      `sidecar must record the config.toml at v6 after upgrade; got: ${JSON.stringify(sidecar)}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── normalizeManagedKey: small builder unit ──────────────────────────

test('normalizeManagedKey strips .lares/ AND legacy .dashboard/, and normalizes separators', () => {
  assert.equal(normalizeManagedKey('.lares/scripts/dashboard-status.mjs'), 'scripts/dashboard-status.mjs');
  assert.equal(normalizeManagedKey('.lares\\scripts\\dashboard-status.mjs'), 'scripts/dashboard-status.mjs');
  assert.equal(normalizeManagedKey('.dashboard/scripts/dashboard-status.mjs'), 'scripts/dashboard-status.mjs');
  assert.equal(normalizeManagedKey('.dashboard\\scripts\\dashboard-status.mjs'), 'scripts/dashboard-status.mjs');
  assert.equal(normalizeManagedKey('scripts/dashboard-status.mjs'), 'scripts/dashboard-status.mjs');
  assert.equal(normalizeManagedKey('.dashboard/workers/claude/.claude/settings.json'), 'workers/claude/.claude/settings.json');
});

// ── WP-P0C: planning-surface scaffold deploy (bodies + skill tree) ────
//
// Supervisor CLAUDE.md v20→v21 (adds "Where planning artifacts live" + ARC
// ownership + orient-first), worker CLAUDE.md v9→v10 (drops the retired
// every-turn PLAN-EVENT ceremony, adds the worker planning-surface section),
// codex AGENTS.md v2→v3 (inherits the worker body). The proposal-to-plan skill
// tree deploys into all four skill roots. Freeze-then-derive + hash-guarded
// stale-file cleanup are asserted here.

function supFilesMap(): Record<string, ScaffoldFile> {
  return (AgentSupervisor as unknown as { SUPERVISOR_FILES: Record<string, ScaffoldFile> }).SUPERVISOR_FILES;
}
function workerClaudeFilesMap(): Record<string, ScaffoldFile> {
  return (AgentSupervisor as unknown as { WORKER_FILES_CLAUDE: Record<string, ScaffoldFile> }).WORKER_FILES_CLAUDE;
}
function supCodexFilesMap(): Record<string, ScaffoldFile> {
  return (AgentSupervisor as unknown as { SUPERVISOR_FILES_CODEX: Record<string, ScaffoldFile> }).SUPERVISOR_FILES_CODEX;
}

const PROPOSAL_TO_PLAN_REL_FILES = [
  'SKILL.md',
  'references/activities/capture.md',
  'references/activities/scope.md',
  'references/activities/promote.md',
  'references/activities/deliberate.md',
  'references/activities/integrate.md',
  'references/activities/package.md',
  'references/activities/orient.md',
  'references/contracts/arc.md',
  'references/contracts/folder-schema.md',
  'references/contracts/human-overview.md',
  'references/contracts/intent-lifecycle.md',
  'references/contracts/manifest-lock.md',
  'references/contracts/responsibility.md',
  'references/contracts/work-packages.md',
  'scripts/plan-identity.mjs',
  'scripts/plan-manifest.mjs',
];

test('WP-P0C-S0. precondition: frozen v20 supervisor CLAUDE.md hashes to the shipped constant', () => {
  assert.equal(sha256Hex(SUPERVISOR_AGENT_MD_V20), SUPERVISOR_AGENT_MD_V20_HASH,
    'SUPERVISOR_AGENT_MD_V20 must hash to SUPERVISOR_AGENT_MD_V20_HASH (previousHashes[20]), or pristine v20 workspaces get .bak\'d instead of upgraded');
  const managed = supFilesMap()['.lares/supervisor/CLAUDE.md'];
  assert.equal(managed.version, 22, 'the bundled supervisor CLAUDE.md must be current v22');
  assert.equal(managed.previousHashes?.[20], SUPERVISOR_AGENT_MD_V20_HASH,
    'previousHashes[20] must be SUPERVISOR_AGENT_MD_V20_HASH');
  assert.notEqual(sha256Hex(SUPERVISOR_AGENT_MD), SUPERVISOR_AGENT_MD_V20_HASH,
    'the live v21 body must differ from the frozen v20 hash (did the planning-artifacts section land?)');
});

test('WP-P0C-S1. supervisor v20→v21 is a faithful derive-from-frozen transform', () => {
  // The anchor occurs EXACTLY ONCE in the frozen v20 body.
  assert.equal(countMatches(SUPERVISOR_AGENT_MD_V20, '<!-- section:continuation-request v1 -->'), 1,
    'the continuation-request anchor must occur exactly once in the frozen v20 body');
  // The new section is ABSENT from the frozen v20 and PRESENT in the live v21.
  assert.ok(!SUPERVISOR_AGENT_MD_V20.includes('## Where planning artifacts live'),
    'the frozen v20 body must NOT carry the planning-artifacts section');
  assert.ok(SUPERVISOR_AGENT_MD_V21.includes('## Where planning artifacts live'),
    'the live v21 body must carry the planning-artifacts section');
  assert.ok(SUPERVISOR_AGENT_MD_V21.includes('`ARC.md` is YOUR job'), 'v21 must state ARC.md ownership (ruling 29)');
  assert.ok(SUPERVISOR_AGENT_MD_V21.includes('Orient-first'), 'v21 must state the orient-first rule (ruling 30)');
  assert.ok(SUPERVISOR_AGENT_MD_V21.includes('proposal-to-plan'), 'v21 must name the proposal-to-plan skill');
  // Everything before the anchor is byte-identical (additive-only edit).
  const anchor = '<!-- section:continuation-request v1 -->';
  assert.equal(SUPERVISOR_AGENT_MD_V21.split(anchor)[1], SUPERVISOR_AGENT_MD_V20.split(anchor)[1],
    'the continuation-request section (and everything after the anchor) must be unchanged');
});

test('WP-GEMINI-RM scaffold v21→v22 pins the old body and deploys discontinued-provider guidance', () => {
  const managed = supFilesMap()['.lares/supervisor/CLAUDE.md'];
  assert.equal(sha256Hex(SUPERVISOR_AGENT_MD_V21), SUPERVISOR_AGENT_MD_V21_HASH);
  assert.equal(managed.version, 22);
  assert.equal(managed.previousHashes?.[21], SUPERVISOR_AGENT_MD_V21_HASH);
  assert.match(SUPERVISOR_AGENT_MD, /Gemini is discontinued and cannot be launched or revived/);
  assert.match(SUPERVISOR_AGENT_MD, /use Antigravity \(agy\)/);
  assert.notEqual(sha256Hex(SUPERVISOR_AGENT_MD), SUPERVISOR_AGENT_MD_V21_HASH);
});

test('WP-P0C-W0. precondition: frozen v9 worker CLAUDE.md hashes to the shipped constant', () => {
  assert.equal(sha256Hex(WORKER_CLAUDE_MD_V9), WORKER_CLAUDE_MD_V9_HASH,
    'WORKER_CLAUDE_MD_V9 must hash to WORKER_CLAUDE_MD_V9_HASH (previousHashes[9])');
  const managed = workerClaudeFilesMap()['.lares/workers/claude/CLAUDE.md'];
  assert.equal(managed.version, 12, 'the bundled worker CLAUDE.md must be current v12');
  assert.equal(managed.previousHashes?.[9], WORKER_CLAUDE_MD_V9_HASH, 'previousHashes[9] must be WORKER_CLAUDE_MD_V9_HASH');
  assert.notEqual(sha256Hex(WORKER_CLAUDE_MD), WORKER_CLAUDE_MD_V9_HASH,
    'the live v10 body must differ from the frozen v9 hash (did the ceremony drop land?)');
});

test('WP-P0C-W1. worker v9→v10 drops the retired ceremony and adds the planning-surface section', () => {
  // The retired ceremony is present in the frozen v9 and GONE from the live v10.
  assert.ok(WORKER_CLAUDE_MD_V9.includes('PLAN-EVENT'), 'the frozen v9 body must carry the retired PLAN-EVENT ceremony');
  assert.ok(WORKER_CLAUDE_MD_V9.includes('## Planning surface: editing a plan section'),
    'the frozen v9 body must carry the retired ceremony header');
  assert.ok(!WORKER_CLAUDE_MD.includes('PLAN-EVENT'), 'the live v10 body must NOT carry the retired PLAN-EVENT ceremony');
  assert.ok(!WORKER_CLAUDE_MD.includes('## Planning surface: editing a plan section'),
    'the live v10 body must NOT carry the retired ceremony header');
  // The new worker planning-surface section is present.
  assert.ok(WORKER_CLAUDE_MD.includes('## Planning surface: proposals and plan folders'),
    'the live v10 body must carry the new worker planning-surface section');
  assert.ok(WORKER_CLAUDE_MD.includes('author_role: worker'), 'v10 must tell workers they MAY author a proposal (capture)');
  assert.ok(WORKER_CLAUDE_MD.includes('No per-turn planning sentinel'), 'v10 must state the sentinel obligation is gone');
});

test('WP-P0C-C0. precondition: frozen v2 codex AGENTS.md hashes to the shipped constant + differs from live v3', () => {
  assert.equal(sha256Hex(WORKER_CODEX_AGENTS_MD_V2), WORKER_CODEX_AGENTS_MD_V2_HASH,
    'WORKER_CODEX_AGENTS_MD_V2 must hash to WORKER_CODEX_AGENTS_MD_V2_HASH (previousHashes[2])');
  assert.notEqual(WORKER_CODEX_AGENTS_MD, WORKER_CODEX_AGENTS_MD_V2,
    'the live v3 codex body must differ from the frozen v2 (it inherits the worker v10 ceremony drop)');
  assert.ok(WORKER_CODEX_AGENTS_MD_V2.includes('PLAN-EVENT'), 'the frozen v2 codex body still carries the ceremony');
});

test('WP-P0C-C1. codex AGENTS.md: pristine v2 silently upgrades to v3 (no .bak)', () => {
  const workDir = mktmp('codex-agents-v2');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const agentsPath = codexPath(workDir, 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
    fs.writeFileSync(agentsPath, WORKER_CODEX_AGENTS_MD_V2, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(sidecarPath(workDir),
      JSON.stringify({ 'workers/codex/AGENTS.md': 2 }, null, 2) + '\n', 'utf-8');

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    assert.equal(fs.readFileSync(agentsPath, 'utf-8'), WORKER_CODEX_AGENTS_MD,
      'a pristine v2 codex AGENTS.md must silently upgrade to the exact v3 bundled content');
    const baks = fs.readdirSync(path.dirname(agentsPath)).filter((n) => n.startsWith('AGENTS.md.bak.'));
    assert.equal(baks.length, 0, `known v2-hash upgrade must NOT create a backup; got: ${baks.join(', ')}`);
    assert.equal(readSidecar(workDir)['workers/codex/AGENTS.md'], 5, 'sidecar must record current v5');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── Directional memory flow: worker CLAUDE.md v10→v11 / Codex v3→v4 ──

const DIRECTIONAL_MEMORY_BODY = `Workspace memory is the supervisor's surface; your brief carries the relevant
context. You normally do **not** read \`.lares/supervisor/memory/\` yourself.
Use \`recall_memory\` only when your brief explicitly points you at a capsule.
When something happens that future agents shouldn't have to relearn, use the
\`remember\` skill to draft it for your supervisor — don't hand-write memory or
lesson files.`;

test('MEM-DIR-W0. frozen worker v10 and Codex v3 hashes are pinned in previousHashes', () => {
  assert.equal(sha256Hex(WORKER_CLAUDE_MD_V10), WORKER_CLAUDE_MD_V10_HASH,
    'WORKER_CLAUDE_MD_V10 must hash to previousHashes[10]');
  const managed = workerClaudeFilesMap()['.lares/workers/claude/CLAUDE.md'];
  assert.equal(managed.version, 12, 'the bundled worker CLAUDE.md must be v12');
  assert.equal(managed.previousHashes?.[10], WORKER_CLAUDE_MD_V10_HASH,
    'previousHashes[10] must pin the frozen v10 body');
  assert.equal(sha256Hex(WORKER_CODEX_AGENTS_MD_V3), WORKER_CODEX_AGENTS_MD_V3_HASH,
    'WORKER_CODEX_AGENTS_MD_V3 must hash to previousHashes[3]');
});

test('MEM-DIR-W1. v11 replaces retrieval guidance once and all provider derivations inherit it byte-identically', () => {
  assert.equal(countMatches(WORKER_CLAUDE_MD_V10, 'worker you fetch it two ways:'), 1,
    'the old retrieval block anchor must occur exactly once in frozen v10');
  assert.ok(WORKER_CLAUDE_MD_V10.includes('MEMORY.md'), 'frozen v10 must carry the raw-read guidance');
  assert.ok(!WORKER_CLAUDE_MD.includes('MEMORY.md'), 'live v11 must remove the raw-read guidance');
  assert.ok(!WORKER_CLAUDE_MD.includes('worker you fetch it two ways:'), 'live v11 must remove routine worker retrieval');
  assert.equal(countMatches(WORKER_CLAUDE_MD, DIRECTIONAL_MEMORY_BODY), 1,
    'the exact directional-memory replacement must occur once in live v11');

  for (const [provider, body] of [
    ['codex', WORKER_CODEX_AGENTS_MD],
    ['grok', WORKER_GROK_AGENTS_MD],
    ['agy', WORKER_AGY_AGENTS_MD],
  ] as const) {
    assert.equal(countMatches(body, DIRECTIONAL_MEMORY_BODY), 1,
      `${provider} must inherit the directional-memory section byte-identically`);
  }

  for (const token of [
    '.lares/workers/claude/',
    '`AskUserQuestion`,\nplan-mode approval prompts, `(y/n)` confirmations, ',
    '`WORKER_CLAUDE_MD` constant',
  ]) {
    assert.ok(!DIRECTIONAL_MEMORY_BODY.includes(token),
      `the replacement must not contain provider transform token ${JSON.stringify(token)}`);
  }
});

test('MEM-DIR-W2. pristine worker v10 silently upgrades to v11 (no .bak)', () => {
  const workDir = mktmp('worker-claudemd-v10');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.lares', 'workers', 'claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, WORKER_CLAUDE_MD_V10, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(sidecarPath(workDir), JSON.stringify({ 'workers/claude/CLAUDE.md': 10 }, null, 2) + '\n', 'utf-8');

    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    assert.equal(fs.readFileSync(mdPath, 'utf-8'), WORKER_CLAUDE_MD);
    assert.equal(fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.')).length, 0);
    assert.equal(readSidecar(workDir)['workers/claude/CLAUDE.md'], 12);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('MEM-DIR-C1. pristine Codex AGENTS.md v3 silently upgrades to v4 (no .bak)', () => {
  const workDir = mktmp('codex-agents-v3');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const agentsPath = codexPath(workDir, 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
    fs.writeFileSync(agentsPath, WORKER_CODEX_AGENTS_MD_V3, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(sidecarPath(workDir), JSON.stringify({ 'workers/codex/AGENTS.md': 3 }, null, 2) + '\n', 'utf-8');

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    assert.equal(fs.readFileSync(agentsPath, 'utf-8'), WORKER_CODEX_AGENTS_MD);
    assert.equal(fs.readdirSync(path.dirname(agentsPath)).filter((n) => n.startsWith('AGENTS.md.bak.')).length, 0);
    assert.equal(readSidecar(workDir)['workers/codex/AGENTS.md'], 5);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('WP-B4-WORKER. reporting duty is inherited by every provider body and old managed bodies are pinned', () => {
  assert.equal(sha256Hex(WORKER_CLAUDE_MD_V11), WORKER_CLAUDE_MD_V11_HASH);
  assert.equal(sha256Hex(WORKER_CODEX_AGENTS_MD_V4), WORKER_CODEX_AGENTS_MD_V4_HASH);
  const claudeManaged = workerClaudeFilesMap()['.lares/workers/claude/CLAUDE.md'];
  assert.equal(claudeManaged.version, 12);
  assert.equal(claudeManaged.previousHashes?.[11], WORKER_CLAUDE_MD_V11_HASH);
  for (const body of [WORKER_CLAUDE_MD, WORKER_CODEX_AGENTS_MD, WORKER_GROK_AGENTS_MD, WORKER_AGY_AGENTS_MD]) {
    for (const phrase of [
      '## Production reachability report',
      'every production entry seam, naming its symbol and path',
      'every resource production creates',
      "each declared obligation's revert-refutation status",
      'every check you did not perform',
    ]) assert.ok(body.includes(phrase), `derived worker body missing ${phrase}`);
  }
});

test('WP-B4-WORKER-MIG. pristine worker v11 and Codex v4 silently upgrade without backups', () => {
  for (const entry of [
    { provider: 'claude', rel: '.lares/workers/claude/CLAUDE.md', sidecar: 'workers/claude/CLAUDE.md', body: WORKER_CLAUDE_MD_V11, version: 11, live: WORKER_CLAUDE_MD },
    { provider: 'codex', rel: '.lares/workers/codex/AGENTS.md', sidecar: 'workers/codex/AGENTS.md', body: WORKER_CODEX_AGENTS_MD_V4, version: 4, live: WORKER_CODEX_AGENTS_MD },
  ] as const) {
    const workDir = mktmp(`wp-b4-${entry.provider}`);
    const { supervisor, cleanup } = makeSupervisor();
    try {
      const target = path.join(workDir, ...entry.rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.body, 'utf8');
      fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
      fs.writeFileSync(sidecarPath(workDir), JSON.stringify({ [entry.sidecar]: entry.version }, null, 2) + '\n', 'utf8');
      supervisor.ensureWorkerScaffold(workDir, entry.provider, 'windows');
      assert.equal(fs.readFileSync(target, 'utf8'), entry.live);
      assert.equal(fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith(`${path.basename(target)}.bak.`)).length, 0);
      assert.equal(readSidecar(workDir)[entry.sidecar], entry.version + 1);
    } finally {
      cleanup();
      rmrf(workDir);
    }
  }
});

test('WP-B4-SKILL. prove-production-entry-point is managed in all four native skill roots', () => {
  const roots = [
    '.lares/supervisor/.claude/skills/prove-the-production-entry-point',
    '.lares/supervisor/.agents/skills/prove-the-production-entry-point',
    '.lares/workers/claude/.claude/skills/prove-the-production-entry-point',
    '.lares/workers/codex/.agents/skills/prove-the-production-entry-point',
  ];
  for (const root of roots) {
    const entry = proveProductionEntryPointEntry(root)[`${root}/SKILL.md`];
    assert.deepEqual(entry, { content: PROVE_PRODUCTION_ENTRY_POINT_SKILL, version: 1 });
  }
  assert.equal(supFilesMap()[`${roots[0]}/SKILL.md`].content, PROVE_PRODUCTION_ENTRY_POINT_SKILL);
  assert.equal(supCodexFilesMap()[`${roots[1]}/SKILL.md`].content, PROVE_PRODUCTION_ENTRY_POINT_SKILL);
  assert.equal(workerClaudeFilesMap()[`${roots[2]}/SKILL.md`].content, PROVE_PRODUCTION_ENTRY_POINT_SKILL);
  for (const phrase of ['`prove_reachability` command', '`FAIL` verdict or missing evidence', 'every unperformed check']) {
    assert.ok(PROVE_PRODUCTION_ENTRY_POINT_SKILL.includes(phrase), `managed skill missing gate duty ${phrase}`);
  }
});

test('WP-P0C-TREE-SUP. fresh supervisor scaffold writes the whole proposal-to-plan tree into the Claude AND Codex roots', () => {
  const workDir = mktmp('p2p-tree-sup');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const claudeRoot = path.join(workDir, '.lares', 'supervisor', '.claude', 'skills', 'proposal-to-plan');
    const codexRoot = path.join(workDir, '.lares', 'supervisor', '.agents', 'skills', 'proposal-to-plan');
    for (const rel of PROPOSAL_TO_PLAN_REL_FILES) {
      const expected = rel !== 'references/activities/capture.md';
      assert.equal(fs.existsSync(path.join(claudeRoot, ...rel.split('/'))), expected,
        `Claude root ${expected ? 'missing' : 'must retire'} ${rel}`);
      assert.equal(fs.existsSync(path.join(codexRoot, ...rel.split('/'))), expected,
        `Codex root ${expected ? 'missing' : 'must retire'} ${rel}`);
    }
    // Content byte-exact for a representative file in each root.
    assert.equal(fs.readFileSync(path.join(claudeRoot, 'SKILL.md'), 'utf-8'), PROPOSAL_TO_PLAN_SKILL_MD,
      'SKILL.md must be the exact bundled content');
    assert.equal(fs.readFileSync(path.join(codexRoot, 'references', 'contracts', 'arc.md'), 'utf-8'),
      PROPOSAL_TO_PLAN_CONTRACT_ARC_MD, 'contracts/arc.md must be the exact bundled content in the codex root');
    assert.equal(fs.readFileSync(path.join(claudeRoot, 'scripts', 'plan-manifest.mjs'), 'utf-8'),
      PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS, 'plan-manifest.mjs must be the exact bundled content');
    assert.equal(fs.readFileSync(path.join(codexRoot, 'scripts', 'plan-identity.mjs'), 'utf-8'),
      PROPOSAL_TO_PLAN_SCRIPT_PLAN_IDENTITY_MJS, 'plan-identity.mjs must be the exact bundled content');
    assert.equal(fs.readFileSync(path.join(codexRoot, 'references', 'contracts', 'responsibility.md'), 'utf-8'),
      PROPOSAL_TO_PLAN_CONTRACT_RESPONSIBILITY_MD, 'responsibility contract must ship with its promote citation');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// Every entry is cumulative. WP-4 advances the dispatcher, orient, and responsibility
// contract and permanently retains capture.md as a v4 retirement entry.
const PROPOSAL_TO_PLAN_VERSIONED_FILES = new Map<string, { version: number; previousHashes: Record<number, string> }>([
  ['SKILL.md', { version: 4, previousHashes: {
    1: PROPOSAL_TO_PLAN_SKILL_MD_V1_HASH,
    2: PROPOSAL_TO_PLAN_SKILL_MD_V2_HASH,
    3: PROPOSAL_TO_PLAN_SKILL_MD_V3_HASH,
  } }],
  ['references/activities/capture.md', { version: 4, previousHashes: {
    1: PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V1_HASH,
    2: PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V2_HASH,
    3: PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V3_HASH,
  } }],
  ['references/activities/promote.md', { version: 4, previousHashes: {
    1: PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V1_HASH,
    2: PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V2_HASH,
    3: PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V3_HASH,
  } }],
  ['references/activities/package.md', { version: 4, previousHashes: {
    1: PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V1_HASH,
    2: PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V2_HASH,
    3: PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V3_HASH,
  } }],
  ['references/activities/orient.md', { version: 3, previousHashes: {
    1: PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD_V1_HASH,
    2: PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD_V2_HASH,
  } }],
  ['references/contracts/responsibility.md', { version: 2, previousHashes: {
    1: PROPOSAL_TO_PLAN_CONTRACT_RESPONSIBILITY_MD_V1_HASH,
  } }],
  ['references/contracts/human-overview.md', { version: 2, previousHashes: {
    1: PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD_V1_HASH,
  } }],
  ['references/contracts/work-packages.md', { version: 3, previousHashes: {
    1: PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD_V1_HASH,
    2: PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD_V2_HASH,
  } }],
  ['references/contracts/manifest-lock.md', { version: 2, previousHashes: { 1: PROPOSAL_TO_PLAN_CONTRACT_MANIFEST_LOCK_MD_V1_HASH } }],
  ['scripts/plan-manifest.mjs', { version: 4, previousHashes: {
    1: PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V1_HASH,
    2: PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V2_HASH,
    3: PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V3_HASH,
  } }],
]);

test('WP-P0C-TREE-HELPER. proposalToPlanEntries expands the full tree under a root prefix; scripts are executable', () => {
  const entries = proposalToPlanEntries('.lares/workers/codex/.agents/skills/proposal-to-plan');
  assert.equal(Object.keys(entries).length, PROPOSAL_TO_PLAN_REL_FILES.length);
  for (const rel of PROPOSAL_TO_PLAN_REL_FILES) {
    const key = `.lares/workers/codex/.agents/skills/proposal-to-plan/${rel}`;
    assert.ok(entries[key], `missing entry ${key}`);
    if (PROPOSAL_TO_PLAN_VERSIONED_FILES.has(rel)) {
      const exp = PROPOSAL_TO_PLAN_VERSIONED_FILES.get(rel)!;
      assert.equal(entries[key].version, exp.version, `${rel} is a versioned entry at v${exp.version}`);
      assert.deepEqual(entries[key].previousHashes, exp.previousHashes,
        `${rel} must preserve the full cumulative previousHashes map`);
    } else {
      assert.equal(entries[key].version, 1, `${rel} is an unchanged new-skill v1 entry`);
      assert.equal(entries[key].previousHashes, undefined, `${rel} (unchanged) must carry no previousHashes`);
    }
  }
  const scriptKey = '.lares/workers/codex/.agents/skills/proposal-to-plan/scripts/plan-manifest.mjs';
  assert.equal(entries[scriptKey].executable, true, 'plan-manifest.mjs must be executable');
  assert.equal(entries['.lares/workers/codex/.agents/skills/proposal-to-plan/scripts/plan-identity.mjs'].executable, true,
    'plan-identity.mjs must be executable');
  const captureKey = '.lares/workers/codex/.agents/skills/proposal-to-plan/references/activities/capture.md';
  assert.deepEqual(entries[captureKey], {
    content: '',
    removed: true,
    version: 4,
    previousHashes: {
      1: PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V1_HASH,
      2: PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V2_HASH,
      3: PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V3_HASH,
    },
  }, 'capture.md must remain in the managed tree as a cumulative v4 retirement entry');
});

test('WP-1-PRECONDITION. frozen write-proposal v1 hashes to its literal and differs from the live v2 body', () => {
  assert.equal(
    sha256Hex(WRITE_PROPOSAL_SKILL_MD_V1), WRITE_PROPOSAL_SKILL_MD_V1_HASH,
    'the frozen v1 body must hash to previousHashes[1], or pristine v1 copies cannot silently upgrade',
  );
  assert.notEqual(
    sha256Hex(WRITE_PROPOSAL_SKILL_MD), WRITE_PROPOSAL_SKILL_MD_V1_HASH,
    'the live v2 body must differ from the frozen v1 hash',
  );
});

test('WP-1-CONTENT. write-proposal owns the conceptual model, bounded decisions, reconfirmation, and hand-off', () => {
  const normativeFrontmatterBlock = [
    'author: "<agent title verbatim>" (<lane>, <workspace>)',
    'author_agent_id: <dashboard agent uuid>',
    'author_role: supervisor | worker | researcher',
    'author_provider: claude | codex | grok | agy   # optional but cheap',
    'authored_at: <ISO-8601>',
  ].join('\n');

  assert.ok(WRITE_PROPOSAL_SKILL_MD.includes(normativeFrontmatterBlock),
    'Part 2 frontmatter block must appear verbatim');
  assert.ok(WRITE_PROPOSAL_SKILL_MD.includes('artifact_id: prop_<8 lowercase hex>'));
  assert.ok(WRITE_PROPOSAL_SKILL_MD.includes('scan every\nexisting `artifact_id:`'));
  assert.ok(WRITE_PROPOSAL_SKILL_MD.includes('**fails the contract**'),
    'a generic role label in author must explicitly fail');
  assert.ok(WRITE_PROPOSAL_SKILL_MD.includes('`remember` to\n  create a memory'));
  assert.ok(WRITE_PROPOSAL_SKILL_MD.includes('`remember` to create a lesson'));
  assert.ok(WRITE_PROPOSAL_SKILL_MD.includes('`supporting/` is reserved for a supervisor subscribed to a plan'));
  assert.ok(WRITE_PROPOSAL_SKILL_MD.includes('.lares/proposals/YYYY-MM-DD-<slug>.md'));
  assert.ok(WRITE_PROPOSAL_SKILL_MD.includes('`## In plain terms`'));
  for (const required of [
    '**What it is** - one sentence.',
    '**The problem** - why it matters, in user terms.',
    '**How it works, in parts** - name 3-6 moving parts in plain language',
    '**What changes for you**.',
    '**The main trade-off / open choice**.',
    "**What's up to you** - 0-3 genuine decisions.",
    'Each must be a real, still-open\n   decision, explained in ordinary language and stating what changes depending',
    'It must be understandable by a non-technical reader and must\n   not already be answered by the proposal.',
    'Target 150-300 words and never exceed 450 words.',
    'Use no file paths, identifiers,\nor jargon in this section.',
    'No decision is needed right now - tell me if this model looks wrong',
    'After any material change to the technical body, re-read `## In plain terms`',
    'Update it to match, or explicitly reconfirm that it still\nholds.',
  ]) {
    assert.ok(WRITE_PROPOSAL_SKILL_MD.includes(required), `missing write-proposal contract text: ${required}`);
  }
  assert.ok(WRITE_PROPOSAL_SKILL_MD.includes(
    'Tell the human the proposal exists and where it is; the lifecycle continues only\nfrom the Plans pane.'));
});

test('WP-1-MIG. write-proposal is a managed v2 skill in every native lane', () => {
  const helperEntry = writeProposalEntry('.lares/example/.agents/skills/write-proposal');
  assert.deepEqual(helperEntry['.lares/example/.agents/skills/write-proposal/SKILL.md'], {
    content: WRITE_PROPOSAL_SKILL_MD,
    version: 2,
    previousHashes: { 1: WRITE_PROPOSAL_SKILL_MD_V1_HASH },
  });

  const workDir = mktmp('write-proposal-all-lanes');
  const { supervisor, cleanup } = makeSupervisor();
  const paths = [
    '.lares/supervisor/.claude/skills/write-proposal/SKILL.md',
    '.lares/supervisor/.agents/skills/write-proposal/SKILL.md',
    '.lares/workers/claude/.claude/skills/write-proposal/SKILL.md',
    '.lares/workers/codex/.agents/skills/write-proposal/SKILL.md',
    '.lares/researcher/.claude/skills/write-proposal/SKILL.md',
  ];
  try {
    supervisor.ensureSupervisorScaffold(workDir, 'windows');
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');
    supervisor.ensureResearcherScaffold(workDir, 'windows');

    const sidecar = readSidecar(workDir);
    for (const rel of paths) {
      assert.equal(fs.readFileSync(path.join(workDir, ...rel.split('/')), 'utf8'), WRITE_PROPOSAL_SKILL_MD,
        `${rel} must contain the exact shared skill body`);
      assert.equal(sidecar[rel.replace(/^\.lares\//, '')], 2, `${rel} must be recorded at v2`);
    }
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('WP-1-MIG-UPGRADE. a pristine write-proposal v1 silently upgrades to v2', () => {
  const workDir = mktmp('write-proposal-v1');
  const { supervisor, cleanup } = makeSupervisor();
  const rel = '.lares/workers/codex/.agents/skills/write-proposal/SKILL.md';
  const skillPath = path.join(workDir, ...rel.split('/'));
  const sidecarKey = rel.replace(/^\.lares\//, '');
  try {
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, WRITE_PROPOSAL_SKILL_MD_V1, 'utf8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(sidecarPath(workDir), JSON.stringify({ [sidecarKey]: 1 }, null, 2) + '\n', 'utf8');

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    assert.equal(fs.readFileSync(skillPath, 'utf8'), WRITE_PROPOSAL_SKILL_MD);
    assert.equal(readSidecar(workDir)[sidecarKey], 2);
    assert.equal(
      fs.readdirSync(path.dirname(skillPath)).filter((name) => name.startsWith('SKILL.md.bak.')).length,
      0,
      'a pristine v1 body must upgrade without a backup',
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('WP-3-CONTENT. read-planning-surface is whole-surface, read-only, epistemically bounded reporting', () => {
  for (const phrase of [
    '**never writes**',
    'never launches agents',
    'never appends `assigned`',
    'never refreshes `ARC-META`',
    'promoted-but-bare-card gap',
    'terminal-valid',
    '`ran: unavailable`',
    'whether to look closer',
    'Frontmatter authorship is a **self-claim**',
    '`supporting/` is subordinate',
    'responsibility.md` §`Determination`',
    'it never decides that a supervisor may act',
    'Gallery grouping or collapse',
    'database projections of work packages or responsibility',
    'readiness gates',
    'documentation is deferred to plan_e0001372 after its WP-Z gates',
  ]) {
    assert.ok(READ_PLANNING_SURFACE_SKILL_MD.includes(phrase), `missing WP-3 contract phrase: ${phrase}`);
  }
  assert.ok(READ_PLANNING_SURFACE_SKILL_MD.includes('| Disk evidence | Report | Safe next action |'));
  assert.ok(READ_PLANNING_SURFACE_SKILL_MD.includes('may\nrecommend “run `orient` on plan X” without running it'));
  assert.ok(READ_PLANNING_SURFACE_SKILL_MD.includes('never with\n   `derivePlanSku()`'));
});

test('WP-3-MIG. read-planning-surface is a managed v1 skill in every native lane', () => {
  const helperEntry = readPlanningSurfaceEntry('.lares/example/.agents/skills/read-planning-surface');
  assert.deepEqual(helperEntry['.lares/example/.agents/skills/read-planning-surface/SKILL.md'], {
    content: READ_PLANNING_SURFACE_SKILL_MD,
    version: 1,
  });

  const workDir = mktmp('read-planning-surface-all-lanes');
  const { supervisor, cleanup } = makeSupervisor();
  const paths = [
    '.lares/supervisor/.claude/skills/read-planning-surface/SKILL.md',
    '.lares/supervisor/.agents/skills/read-planning-surface/SKILL.md',
    '.lares/workers/claude/.claude/skills/read-planning-surface/SKILL.md',
    '.lares/workers/codex/.agents/skills/read-planning-surface/SKILL.md',
    '.lares/researcher/.claude/skills/read-planning-surface/SKILL.md',
  ];
  try {
    supervisor.ensureSupervisorScaffold(workDir, 'windows');
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');
    supervisor.ensureResearcherScaffold(workDir, 'windows');

    const sidecar = readSidecar(workDir);
    for (const rel of paths) {
      assert.equal(fs.readFileSync(path.join(workDir, ...rel.split('/')), 'utf8'), READ_PLANNING_SURFACE_SKILL_MD,
        `${rel} must contain the exact shared skill body`);
      assert.equal(sidecar[rel.replace(/^\.lares\//, '')], 1, `${rel} must be recorded at v1`);
    }
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('WP-3-PROMOTE. v3 hash is pinned and EEXIST uses the reader while retaining the loser rule citation', () => {
  const v3 = PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD.replace(
    'Use the read-only\n`read-planning-surface` path against the occupant and read its\n`plan.json.source_proposal.artifact_id`:',
    'Run `orient` against\nthe occupant and read its `plan.json.source_proposal.artifact_id`:',
  );
  assert.equal(sha256Hex(v3), PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V3_HASH,
    'the reconstructed pristine v3 promote body must pin previousHashes[3]');
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD), PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V3_HASH);
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD.includes('Use the read-only\n`read-planning-surface` path'));
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD.includes(
    'responsibility.md` §Determination. If another supervisor is responsible'),
  'the matching-EEXIST loser rule must still cite the responsibility determination');
});

test('WP-3-PROMOTE-MIG. pristine promote v3 silently upgrades to v4', () => {
  const workDir = mktmp('p2p-promote-v3');
  const { supervisor, cleanup } = makeSupervisor();
  const rel = '.lares/workers/codex/.agents/skills/proposal-to-plan/references/activities/promote.md';
  const promotePath = path.join(workDir, ...rel.split('/'));
  const v3 = PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD.replace(
    'Use the read-only\n`read-planning-surface` path against the occupant and read its\n`plan.json.source_proposal.artifact_id`:',
    'Run `orient` against\nthe occupant and read its `plan.json.source_proposal.artifact_id`:',
  );
  try {
    fs.mkdirSync(path.dirname(promotePath), { recursive: true });
    fs.writeFileSync(promotePath, v3, 'utf8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(sidecarPath(workDir), JSON.stringify({
      'workers/codex/.agents/skills/proposal-to-plan/references/activities/promote.md': 3,
    }, null, 2) + '\n', 'utf8');

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    assert.equal(fs.readFileSync(promotePath, 'utf8'), PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD);
    assert.equal(readSidecar(workDir)[
      'workers/codex/.agents/skills/proposal-to-plan/references/activities/promote.md'
    ], 4);
    assert.equal(fs.readdirSync(path.dirname(promotePath)).filter((n) => n.startsWith('promote.md.bak.')).length, 0);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('WP-2-PRECONDITION. frozen pre-Outcome bodies pin both new migration-history entries', () => {
  assert.equal(
    sha256Hex(PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD_V1),
    PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD_V1_HASH,
    'frozen work-packages.md v1 must hash to previousHashes[1]',
  );
  assert.equal(
    sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V2),
    PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V2_HASH,
    'frozen package.md v2 must hash to previousHashes[2]',
  );
  assert.notEqual(
    sha256Hex(PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD),
    PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD_V1_HASH,
    'live work-packages.md v2 must differ from frozen v1',
  );
  assert.notEqual(
    sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD),
    PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V2_HASH,
    'live package.md v3 must differ from frozen v2',
  );
  assert.equal(
    sha256Hex(PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD_V2),
    PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD_V2_HASH,
    'frozen work-packages.md v2 must hash to previousHashes[2]',
  );
  assert.equal(
    sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V3),
    PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V3_HASH,
    'frozen package.md v3 must hash to previousHashes[3]',
  );
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD), PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD_V2_HASH);
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD), PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V3_HASH);
});

test('WP-2-CONTENT. package authoring requires a bounded, semantically checked Outcome', () => {
  for (const phrase of [
    'Files · Dep · Do · Accept · Non-goals · Verify · Entry · Outcome',
    "Re-read each package's `Do`, `Accept`, and `Non-goals`",
    'at least one acceptance condition must observably prove it',
    'Do not declare\n  dispatch readiness if the semantic Outcome check fails.',
  ]) {
    assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD.includes(phrase), `missing package.md Outcome rule: ${phrase}`);
  }
  for (const phrase of [
    '`**Outcome:** <one plain sentence: what the user can newly see or do when this package lands;',
    'No file paths or identifiers.>`',
    'The complete Outcome line must be at most 200 characters.',
    'the Outcome must promise no behavior outside them',
    'it cannot tell a legitimate legacy omission from a new-authoring omission',
    'semantic self-check and review gate',
  ]) {
    assert.ok(PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD.includes(phrase),
      `missing work-packages.md Outcome rule: ${phrase}`);
  }
});

test('WP-B4-CONTRACT. package activity and work-package contract carry the shipped v2 reachability shape', () => {
  for (const phrase of [
    'PLAN-WORK-PACKAGES:v2',
    'Verify · Entry · Outcome',
    'entry_seam_links',
    'production_constructs',
    'Entry: none — <reviewed one-line rationale>',
  ]) assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD.includes(phrase), `package.md missing ${phrase}`);

  for (const phrase of [
    '# Contract reference — PLAN-WORK-PACKAGES:v2',
    '"schema_version": 2',
    '"reachability": {',
    '"entry_seam_links": [',
    '"production_constructs": []',
    'ipc | preload | route | ui-caller | job | other',
    'normalized reachability',
    'v1 remains parseable as a legacy shape',
  ]) assert.ok(PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD.includes(phrase), `work-packages.md missing ${phrase}`);
});

test('WP-2-MIG. pristine historical work-packages and package bodies silently upgrade to current', () => {
  const cases = [
    {
      name: 'work-packages-v1', rel: 'references/contracts/work-packages.md',
      body: PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD_V1, diskVersion: 1,
      live: PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD, currentVersion: 3,
    },
    {
      name: 'work-packages-v2', rel: 'references/contracts/work-packages.md',
      body: PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD_V2, diskVersion: 2,
      live: PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD, currentVersion: 3,
    },
    {
      name: 'package-v1', rel: 'references/activities/package.md',
      body: PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V1, diskVersion: 1,
      live: PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD, currentVersion: 4,
    },
    {
      name: 'package-v2', rel: 'references/activities/package.md',
      body: PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V2, diskVersion: 2,
      live: PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD, currentVersion: 4,
    },
    {
      name: 'package-v3', rel: 'references/activities/package.md',
      body: PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V3, diskVersion: 3,
      live: PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD, currentVersion: 4,
    },
  ] as const;

  for (const entry of cases) {
    const workDir = mktmp(`wp2-${entry.name}`);
    const { supervisor, cleanup } = makeSupervisor();
    const rootRel = '.lares/workers/codex/.agents/skills/proposal-to-plan';
    const fullRel = `${rootRel}/${entry.rel}`;
    const fullPath = path.join(workDir, ...fullRel.split('/'));
    const sidecarKey = fullRel.replace(/^\.lares\//, '');
    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, entry.body, 'utf8');
      fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
      fs.writeFileSync(sidecarPath(workDir), JSON.stringify({
        [sidecarKey]: entry.diskVersion,
      }, null, 2) + '\n', 'utf8');

      supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

      assert.equal(fs.readFileSync(fullPath, 'utf8'), entry.live);
      assert.equal(readSidecar(workDir)[sidecarKey], entry.currentVersion);
      assert.equal(
        fs.readdirSync(path.dirname(fullPath)).filter((name) =>
          name.startsWith(path.basename(fullPath) + '.bak.')).length,
        0,
        `${entry.name} must upgrade without a backup`,
      );
    } finally {
      cleanup();
      rmrf(workDir);
    }
  }
});

test('WP-3-PRECONDITION. frozen human-overview v1 pins the new migration-history entry', () => {
  assert.equal(
    sha256Hex(PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD_V1),
    PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD_V1_HASH,
    'frozen human-overview.md v1 must hash to previousHashes[1]',
  );
  assert.notEqual(
    sha256Hex(PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD),
    PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD_V1_HASH,
    'live human-overview.md v2 must differ from frozen v1',
  );
});

test('WP-3-CONTENT. overview deliberations and packages stay plain, structural, and non-duplicative', () => {
  for (const phrase of [
    'During `package`, the responsible supervisor authors this file; the app then parses and',
    'Application code does not auto-synthesize `OVERVIEW.md`, and its prose is not rewritten',
    '3-6 plain-language bullets stating what was decided and why',
    'decision readout, not a transcript',
    'package-time structural readout only: package count, dependency/start',
    'Do not copy runtime lifecycle state',
    '(ready/executing/done) or per-package Outcome text',
    'See the package board for live progress and outcomes.',
    'Any later change to package count, ordering, or dependencies requires refreshing the Packages',
    'overview before dispatch readiness.',
  ]) {
    assert.ok(PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD.includes(phrase),
      `missing human-overview clarification: ${phrase}`);
  }
  assert.ok(PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD.includes('schema_version: 1'));
  assert.ok(PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD.includes('"schema_version": 1'));
  const indexedTabs = [...PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD.matchAll(/\{ "tab": "([^"]+)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(indexedTabs, ['overview', 'proposal', 'plan', 'deliberations', 'supplements', 'packages'],
    'WP-3 must not add a tab');
});

test('WP-3-MIG. pristine human-overview v1 silently upgrades to v2', () => {
  const workDir = mktmp('wp3-human-overview-v1');
  const { supervisor, cleanup } = makeSupervisor();
  const rel = '.lares/workers/codex/.agents/skills/proposal-to-plan/references/contracts/human-overview.md';
  const overviewPath = path.join(workDir, ...rel.split('/'));
  const sidecarKey = rel.replace(/^\.lares\//, '');
  try {
    fs.mkdirSync(path.dirname(overviewPath), { recursive: true });
    fs.writeFileSync(overviewPath, PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD_V1, 'utf8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(sidecarPath(workDir), JSON.stringify({ [sidecarKey]: 1 }, null, 2) + '\n', 'utf8');

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    assert.equal(fs.readFileSync(overviewPath, 'utf8'), PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD);
    assert.equal(readSidecar(workDir)[sidecarKey], 2);
    assert.equal(
      fs.readdirSync(path.dirname(overviewPath)).filter((name) => name.startsWith('human-overview.md.bak.')).length,
      0,
      'a pristine human-overview v1 body must upgrade without a backup',
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('WP-A-PRE. frozen current bodies pin every additive migration-history entry', () => {
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_SKILL_MD_V2), PROPOSAL_TO_PLAN_SKILL_MD_V2_HASH);
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V1), PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V1_HASH);
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V2), PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V2_HASH);
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V3), PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V3_HASH);
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_SKILL_MD), PROPOSAL_TO_PLAN_SKILL_MD_V2_HASH);
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD), PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V1_HASH);
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD), PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V2_HASH);
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS), PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V3_HASH);
});

test('WP-A-CONTENT. continuity, contracts, and register bytes are pinned through WP-4', () => {
  const captureRow = '| `capture` | Write a stamped **flat** proposal in `.lares/proposals/`; zero ceremony. Terminal-valid. | `references/activities/capture.md` |';
  assert.ok(PROPOSAL_TO_PLAN_SKILL_MD_V2.includes(captureRow));
  assert.ok(PROPOSAL_TO_PLAN_SKILL_MD_V3.includes(captureRow), 'WP-A left the capture row byte-untouched for WP-4');
  const a2Continuity = `## Hardening continuity

Once hardening starts, continue through **\`scope → promote → deliberate → integrate → package\`**
without pausing between phases to ask "phase done, continue?" Resume from durable disk state when a
turn boundary intervenes. The one built-in stop is **after \`package\`**, when the plan is presented
to the workspace owner and waits for the explicit implementation trigger. Escalation for a genuine
Tier-3 decision remains allowed; routine phase-boundary permission checks are not.`;
  assert.ok(PROPOSAL_TO_PLAN_SKILL_MD_V3.includes(a2Continuity), 'the frozen post-WP-A body must carry A2 verbatim');
  assert.ok(PROPOSAL_TO_PLAN_SKILL_MD.includes(a2Continuity), 'WP-4 must preserve the complete A2 continuity block verbatim');
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD.includes(
    'written for the workspace owner — no\nsentinel names, no rung jargon, no file:line.'));
  assert.ok(Buffer.from(PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD, 'utf8').includes(Buffer.from([0xe2, 0x80, 0x94])),
    'package register sentence must contain literal UTF-8 U+2014 bytes');
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD.includes(
    'references/contracts/responsibility.md` §Determination'));
  assert.ok(!PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD.includes('On a matching resume, run `orient`'));
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD.includes('**plan SKU**'));
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD.includes('`## Status` line'));
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD.includes('re-read and verify the expected'));
  assert.ok(PROPOSAL_TO_PLAN_CONTRACT_WORK_PACKAGES_MD.includes('PLAN-WORK-PACKAGES:v2'));
  assert.ok(PROPOSAL_TO_PLAN_CONTRACT_HUMAN_OVERVIEW_MD.includes('PLAN-TAB-OVERVIEWS:v1'));
});

test('WP-4-CONTENT. dispatcher is promotion-prompt-entry only and orient retains write gates', () => {
  const retiredAuthoringVectors = [
    'Use whenever you\n  author a proposal in .lares/proposals/',
    '**capture → scope(+mark) →',
    '| `capture` | Write a stamped **flat** proposal in `.lares/proposals/`; zero ceremony. Terminal-valid. |',
    '`capture` is open to anyone (a worker may author with `author_role: worker`).',
  ];
  for (const vector of retiredAuthoringVectors) {
    assert.ok(PROPOSAL_TO_PLAN_SKILL_MD_V3.includes(vector), `real v3 artifact must seed retired vector: ${vector}`);
    assert.ok(!PROPOSAL_TO_PLAN_SKILL_MD.includes(vector), `promotion-only dispatcher must remove: ${vector}`);
  }
  assert.ok(PROPOSAL_TO_PLAN_SKILL_MD.includes('Plans pane injects its promotion prompt'));
  assert.ok(PROPOSAL_TO_PLAN_SKILL_MD.includes('Invoke only from the injected\n  promotion prompt'));
  assert.ok(PROPOSAL_TO_PLAN_SKILL_MD.includes('Proposal creation belongs to the separate `write-proposal` skill.'));
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD.includes('references/contracts/responsibility.md` §Determination'));
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD.includes('plan-manifest.mjs refresh-arc'));
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD.includes('read-only `read-planning-surface` skill'));
  assert.ok(!PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD.includes('## Decision table'),
    'cross-surface reporting table moved out of orient');
  assert.ok(PROPOSAL_TO_PLAN_CONTRACT_RESPONSIBILITY_MD.includes('## Determination'));
  assert.ok(PROPOSAL_TO_PLAN_CONTRACT_RESPONSIBILITY_MD.includes('stable, normative responsibility-determination anchor'));
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD.includes('references/contracts/responsibility.md` §Determination'));
});

test('WP-4-PRE. frozen pre-WP-4 bodies pin every new cumulative hash entry', () => {
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_SKILL_MD_V3), PROPOSAL_TO_PLAN_SKILL_MD_V3_HASH);
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V3), PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V3_HASH);
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD_V2), PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD_V2_HASH);
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_CONTRACT_RESPONSIBILITY_MD_V1), PROPOSAL_TO_PLAN_CONTRACT_RESPONSIBILITY_MD_V1_HASH);
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_SKILL_MD), PROPOSAL_TO_PLAN_SKILL_MD_V3_HASH);
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD), PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD_V2_HASH);
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_CONTRACT_RESPONSIBILITY_MD), PROPOSAL_TO_PLAN_CONTRACT_RESPONSIBILITY_MD_V1_HASH);
});

test('WP-4-MIG. pristine bodies upgrade silently and pristine or edited capture.md retires cleanly', () => {
  const workDir = mktmp('p2p-wp4-migration');
  const { supervisor, cleanup } = makeSupervisor();
  const codexRoot = '.lares/workers/codex/.agents/skills/proposal-to-plan';
  const claudeRoot = '.lares/workers/claude/.claude/skills/proposal-to-plan';
  const pristine = [
    ['SKILL.md', PROPOSAL_TO_PLAN_SKILL_MD_V3, 3],
    ['references/activities/capture.md', PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V3, 3],
    ['references/activities/orient.md', PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD_V2, 2],
    ['references/contracts/responsibility.md', PROPOSAL_TO_PLAN_CONTRACT_RESPONSIBILITY_MD_V1, 1],
  ] as const;
  try {
    const sidecar: Record<string, number> = {};
    for (const [rel, body, version] of pristine) {
      const full = path.join(workDir, ...codexRoot.split('/'), ...rel.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body, 'utf8');
      sidecar[`workers/codex/.agents/skills/proposal-to-plan/${rel}`] = version;
    }
    const editedCaptureRel = 'references/activities/capture.md';
    const editedCapturePath = path.join(workDir, ...claudeRoot.split('/'), ...editedCaptureRel.split('/'));
    fs.mkdirSync(path.dirname(editedCapturePath), { recursive: true });
    fs.writeFileSync(editedCapturePath, PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V3 + '\n<!-- local edit -->\n', 'utf8');
    sidecar[`workers/claude/.claude/skills/proposal-to-plan/${editedCaptureRel}`] = 3;
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(sidecarPath(workDir), JSON.stringify(sidecar, null, 2) + '\n', 'utf8');

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const codexCapture = path.join(workDir, ...codexRoot.split('/'), ...editedCaptureRel.split('/'));
    assert.ok(!fs.existsSync(codexCapture), 'pristine v3 capture.md must be deleted');
    assert.equal(fs.readdirSync(path.dirname(codexCapture)).filter((n) => n.startsWith('capture.md.bak.')).length, 0,
      'pristine capture retirement must not create a backup');
    assert.ok(!fs.existsSync(editedCapturePath), 'user-modified capture.md must also be retired');
    const editedBackups = fs.readdirSync(path.dirname(editedCapturePath)).filter((n) => n.startsWith('capture.md.bak.'));
    assert.equal(editedBackups.length, 1, 'user-modified capture.md must be backed up exactly once');
    assert.ok(fs.readFileSync(path.join(path.dirname(editedCapturePath), editedBackups[0]), 'utf8').includes('local edit'));

    assert.equal(fs.readFileSync(path.join(workDir, ...codexRoot.split('/'), 'SKILL.md'), 'utf8'), PROPOSAL_TO_PLAN_SKILL_MD);
    assert.equal(fs.readFileSync(path.join(workDir, ...codexRoot.split('/'), 'references/activities/orient.md'), 'utf8'), PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD);
    assert.equal(fs.readFileSync(path.join(workDir, ...codexRoot.split('/'), 'references/contracts/responsibility.md'), 'utf8'), PROPOSAL_TO_PLAN_CONTRACT_RESPONSIBILITY_MD);
    const migratedSidecar = readSidecar(workDir);
    assert.equal(migratedSidecar['workers/codex/.agents/skills/proposal-to-plan/SKILL.md'], 4);
    assert.equal(migratedSidecar['workers/codex/.agents/skills/proposal-to-plan/references/activities/capture.md'], 4);
    assert.equal(migratedSidecar['workers/codex/.agents/skills/proposal-to-plan/references/activities/orient.md'], 3);
    assert.equal(migratedSidecar['workers/codex/.agents/skills/proposal-to-plan/references/contracts/responsibility.md'], 2);
    assert.equal(migratedSidecar['workers/claude/.claude/skills/proposal-to-plan/references/activities/capture.md'], 4);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('WP-A-MIG. pristine prior bodies migrate silently while a local edit is backed up', () => {
  const workDir = mktmp('p2p-wpa-migration');
  const { supervisor, cleanup } = makeSupervisor();
  const rootRel = '.lares/workers/codex/.agents/skills/proposal-to-plan';
  const fixtures = [
    ['SKILL.md', PROPOSAL_TO_PLAN_SKILL_MD_V2, 2],
    ['references/activities/promote.md', PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V2, 2],
    ['scripts/plan-manifest.mjs', PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V3, 3],
  ] as const;
  try {
    const sidecar: Record<string, number> = {};
    for (const [rel, body, version] of fixtures) {
      const full = path.join(workDir, ...rootRel.split('/'), ...rel.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body, 'utf8');
      sidecar[`workers/codex/.agents/skills/proposal-to-plan/${rel}`] = version;
    }
    const packageRel = 'references/activities/package.md';
    const packagePath = path.join(workDir, ...rootRel.split('/'), ...packageRel.split('/'));
    fs.mkdirSync(path.dirname(packagePath), { recursive: true });
    fs.writeFileSync(packagePath, PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD_V1 + '\n<!-- local edit -->\n', 'utf8');
    sidecar[`workers/codex/.agents/skills/proposal-to-plan/${packageRel}`] = 1;
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(sidecarPath(workDir), JSON.stringify(sidecar, null, 2) + '\n', 'utf8');

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    for (const [rel] of fixtures) {
      const full = path.join(workDir, ...rootRel.split('/'), ...rel.split('/'));
      assert.equal(fs.readdirSync(path.dirname(full)).filter((name) => name.startsWith(path.basename(full) + '.bak.')).length, 0,
        `${rel} pristine migration must not create a backup`);
    }
    assert.equal(fs.readFileSync(packagePath, 'utf8'), PROPOSAL_TO_PLAN_ACTIVITY_PACKAGE_MD);
    assert.equal(fs.readdirSync(path.dirname(packagePath)).filter((name) => name.startsWith('package.md.bak.')).length, 1,
      'locally edited package.md must be preserved in one backup');
    assert.ok(fs.existsSync(path.join(workDir, ...rootRel.split('/'), 'scripts', 'plan-identity.mjs')));
    assert.ok(fs.existsSync(path.join(workDir, ...rootRel.split('/'), 'references', 'contracts', 'responsibility.md')));
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('WP-SKILLFIX-PRE. frozen v1 bodies hash to the previousHashes[1] literals AND differ from the live v2 bodies', () => {
  // Precondition: each frozen v1 body hashes to its previousHashes[1] literal, so a
  // pristine v1 deploy upgrades silently instead of being .bak'd.
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_SKILL_MD_V1), PROPOSAL_TO_PLAN_SKILL_MD_V1_HASH);
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V1), PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V1_HASH);
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V1), PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V1_HASH);
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD_V1), PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD_V1_HASH);
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V1), PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V1_HASH);
  // The live v2 bodies must differ from the frozen v1 (the fixes actually landed).
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_SKILL_MD), PROPOSAL_TO_PLAN_SKILL_MD_V1_HASH);
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD), PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V1_HASH);
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD), PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD_V1_HASH);
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD), PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD_V1_HASH);
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS), PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V1_HASH);
});

test('WP-AUTH-FM-PRE. frozen capture v2 hashes to previousHashes[2] and differs from live v3', () => {
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V2), PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V2_HASH,
    'frozen capture.md v2 body must hash to previousHashes[2]');
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD), PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V2_HASH,
    'live capture.md v3 body must differ from frozen v2');
});

test('WP-AUTH-FM-MIG. cumulative history retires pristine capture v2 directly at v4 without a backup', () => {
  const workDir = mktmp('p2p-capture-v2');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const rel = '.lares/workers/codex/.agents/skills/proposal-to-plan/references/activities/capture.md';
    const capturePath = path.join(workDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(capturePath), { recursive: true });
    fs.writeFileSync(capturePath, PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD_V2, 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(sidecarPath(workDir), JSON.stringify({
      'workers/codex/.agents/skills/proposal-to-plan/references/activities/capture.md': 2,
    }, null, 2) + '\n', 'utf-8');

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    assert.ok(!fs.existsSync(capturePath), 'the retired capture file must be absent');
    assert.equal(fs.readdirSync(path.dirname(capturePath)).filter((n) => n.startsWith('capture.md.bak.')).length, 0);
    assert.equal(readSidecar(workDir)[
      'workers/codex/.agents/skills/proposal-to-plan/references/activities/capture.md'
    ], 4);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('WP-SKILLBUMP-PRE. frozen pre-ca7ce2b carrier bodies hash to their new previousHashes literals AND differ from the live corrected bodies', () => {
  // ca7ce2b rewrote plan-manifest.mjs (deployed v2) and manifest-lock.md (unversioned
  // v1) WITHOUT bumping their versions. WP-SKILLBUMP freezes those pre-ca7ce2b bodies
  // as the new previousHashes entries so pristine deployed copies upgrade silently:
  //   plan-manifest.mjs  previousHashes[2]  (v2→v3)
  //   manifest-lock.md   previousHashes[1]  (v1→v2)
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V2), PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V2_HASH,
    'frozen pre-ca7ce2b plan-manifest.mjs body must hash to previousHashes[2]');
  assert.equal(sha256Hex(PROPOSAL_TO_PLAN_CONTRACT_MANIFEST_LOCK_MD_V1), PROPOSAL_TO_PLAN_CONTRACT_MANIFEST_LOCK_MD_V1_HASH,
    'frozen pre-ca7ce2b manifest-lock.md body must hash to previousHashes[1]');
  // The live (post-ca7ce2b) bodies must differ from the frozen ones — proving the
  // correction actually landed and the bump is not a no-op.
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS), PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS_V2_HASH,
    'the live v3 plan-manifest.mjs body must differ from the frozen v2 hash');
  assert.notEqual(sha256Hex(PROPOSAL_TO_PLAN_CONTRACT_MANIFEST_LOCK_MD), PROPOSAL_TO_PLAN_CONTRACT_MANIFEST_LOCK_MD_V1_HASH,
    'the live v2 manifest-lock.md body must differ from the frozen v1 hash');
});

test('WP-SKILLFIX-CONTENT. the four defects are fixed in the live v2 bodies', () => {
  // Fix 1 — orient read-only EXCEPT the responsible-supervisor ARC refresh.
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD.includes('responsible supervisor ONLY'),
    'orient step 4 must gate the ARC refresh on the responsible supervisor');
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD.includes('SKIPS the refresh'),
    'orient must tell a non-supervisor runner to skip the refresh');
  assert.ok(PROPOSAL_TO_PLAN_SKILL_MD.includes('skips the refresh'),
    'SKILL.md must state a non-supervisor orient skips the refresh');
  // Fix 2 — refresh-arc helper mode exists and is routed.
  assert.ok(PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS.includes("case 'refresh-arc':"),
    'plan-manifest.mjs must dispatch a refresh-arc subcommand');
  assert.ok(PROPOSAL_TO_PLAN_SCRIPT_PLAN_MANIFEST_MJS.includes('ARC_META_RE'),
    'refresh-arc must target the ARC-META block');
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_ORIENT_MD.includes('plan-manifest.mjs refresh-arc'),
    'orient must route the ARC-META update through refresh-arc');
  assert.ok(PROPOSAL_TO_PLAN_SKILL_MD.includes('refresh-arc'), 'SKILL.md must list the refresh-arc helper mode');
  // Fix 3 — artifact_id generation rule + collision check.
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD.includes('8 lowercase hex'),
    'capture.md must specify prop_ + 8 lowercase hex generation');
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD.includes('collision check'),
    'capture.md must mandate a collision check');
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD.includes(
    'author: <display name — your agent title (e.g. "P6 mission-board worker") or the human\'s name>'),
  'capture.md must include a displayable author frontmatter field');
  assert.ok(PROPOSAL_TO_PLAN_ACTIVITY_CAPTURE_MD.includes('**\`author\` and \`authored_at\` are required**'),
    'capture.md must require author and authored_at for Plans-pane proposal cards');
  // Fix 4 — sku slug derives from the frontmatter title, not the filename.
  const promoteFlat = PROPOSAL_TO_PLAN_ACTIVITY_PROMOTE_MD.replace(/\s+/g, ' ');
  assert.ok(promoteFlat.includes('slugified proposal `title` frontmatter'),
    'promote.md must document the slug source is the frontmatter title');
  assert.ok(promoteFlat.includes('NOT the proposal filename'),
    'promote.md must say the slug is NOT the filename');
});

test('WP-P0C-STALE-1. hash-guarded removal: an UNCHANGED retired tree file is deleted (no .bak)', () => {
  const workDir = mktmp('p2p-stale-clean');
  const restoreDb = patchDb();
  try {
    const rel = '.lares/supervisor/.claude/skills/proposal-to-plan/references/contracts/arc.md';
    const full = path.join(workDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, PROPOSAL_TO_PLAN_CONTRACT_ARC_MD, 'utf-8');

    // Retire it: bytes match a known prior scaffold hash → silent removal.
    const map: Record<string, ScaffoldFile> = {
      [rel]: { content: '', removed: true, version: 2, previousHashes: { 1: sha256Hex(PROPOSAL_TO_PLAN_CONTRACT_ARC_MD) } },
    };
    writeScaffoldMapRaw(workDir, map, 'windows');

    assert.equal(fs.existsSync(full), false, 'an unmodified retired tree file must be deleted');
    // The clean removal also rmdir's the now-empty parent dir, so guard the read.
    const dir = path.dirname(full);
    const baks = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith('arc.md.bak.')) : [];
    assert.equal(baks.length, 0, `a known-managed removal must NOT create a backup; got: ${baks.join(', ')}`);
    assert.equal(readSidecar(workDir)['supervisor/.claude/skills/proposal-to-plan/references/contracts/arc.md'], 2,
      'sidecar must record the removal at v2');
  } finally {
    restoreDb();
    rmrf(workDir);
  }
});

test('WP-P0C-STALE-2. hash-guarded removal: a MODIFIED retired tree file is preserved (.bak) then removed', () => {
  const workDir = mktmp('p2p-stale-mod');
  const restoreDb = patchDb();
  try {
    const rel = '.lares/supervisor/.claude/skills/proposal-to-plan/references/contracts/arc.md';
    const full = path.join(workDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const edited = PROPOSAL_TO_PLAN_CONTRACT_ARC_MD + '\n<!-- LOCAL EDIT — must be preserved, not clobbered -->\n';
    fs.writeFileSync(full, edited, 'utf-8');

    const map: Record<string, ScaffoldFile> = {
      [rel]: { content: '', removed: true, version: 2, previousHashes: { 1: sha256Hex(PROPOSAL_TO_PLAN_CONTRACT_ARC_MD) } },
    };
    writeScaffoldMapRaw(workDir, map, 'windows');

    assert.equal(fs.existsSync(full), false, 'the retired file itself is removed');
    const baks = fs.readdirSync(path.dirname(full)).filter((n) => n.startsWith('arc.md.bak.'));
    assert.equal(baks.length, 1, `a modified retired file must be backed up before removal; got: ${baks.join(', ')}`);
    assert.equal(fs.readFileSync(path.join(path.dirname(full), baks[0]), 'utf-8'), edited,
      'the backup must hold the modified content verbatim');
  } finally {
    restoreDb();
    rmrf(workDir);
  }
});

// ── Runner ───────────────────────────────────────────────────────────
const RUN_ORCHESTRATION_V5_AVAILABILITY_RULE = `> Resolve the desired lead and reviewer independently using explicit run argument → workspace
> default → built-in default. Then consult \`availableProviders\`. Keep a desired provider when
> it is \`available\`; keep a \`degraded\` desired provider only after stating its caveat in the
> preflight confirmation. When a desired provider is \`unavailable\`, propose a substitute from
> providers marked \`available\`, using task fit and the reported reasons; if no provider is
> \`available\`, a \`degraded\` provider may be proposed with its caveat. State the desired
> provider, preference source, substitute, and reason before spend. Never call
> \`run_orchestration\` until the user confirms the complete effective pair. If every provider is
> \`unavailable\`, do not launch and report the reasons. Same-provider pairs remain valid. No
> persisted fallback order exists in v5; when one is introduced, it governs substitute ranking.`;

function reconstructRunOrchestrationSkillV4(): string {
  return SUPERVISOR_RUN_ORCHESTRATION_SKILL
    .replace(
      '\n\nResumes keep the original lead and reviewer. Supplying a different `lead_provider` or `reviewer_provider` on resume is rejected with 409; omit both unless restating the matching original values.',
      '',
    )
    .replace('### 2. Discover IDs and preflight context', '### 2. Discover IDs')
    .replace(
      '\n\nBefore constructing the call, use `get_my_context` and read both `orchestrationProviderDefaults.groupthink` and `availableProviders`. Resolve each desired slot from an explicit run override, otherwise its workspace default, otherwise the built-in default (lead `claude`, reviewer `codex`). An omitted `lead_provider` or `reviewer_provider` inherits the workspace default; pass the argument only to override that default.',
      '',
    )
    .replace(
      `### 3. Resolve availability, construct, and confirm the call\n\n${RUN_ORCHESTRATION_V5_AVAILABILITY_RULE}\n\nFill in required + useful optional params. Omit provider args to inherit the workspace defaults; include either only for an intentional override, e.g.:`,
      '### 3. Construct and confirm the call\n\nFill in required + useful optional params, e.g.:',
    )
    .replace("\n  lead_provider: 'agy',                 // optional explicit override", '')
    .replace(
      'Show the user the desired pair, each preference source (explicit, workspace default, or built-in), any availability-driven substitute and reason, and the complete effective pair alongside the constructed call. Confirm before launching anything that will burn tokens. Don\'t autonomously launch. The effective lead and reviewer may be the same provider.',
      'Confirm with the user before launching anything that will burn tokens — show the constructed call. Don\'t autonomously launch.',
    );
}

test('WP-B5-0. frozen v4 hash matches the pristine pre-provider-preflight body', () => {
  const v4 = reconstructRunOrchestrationSkillV4();
  assert.equal(sha256Hex(v4), SUPERVISOR_RUN_ORCHESTRATION_SKILL_V4_HASH);
  assert.notEqual(sha256Hex(SUPERVISOR_RUN_ORCHESTRATION_SKILL), SUPERVISOR_RUN_ORCHESTRATION_SKILL_V4_HASH);
});

test('WP-B5-1. v5 skill carries the exact availability and provider-preflight contract', () => {
  assert.ok(SUPERVISOR_RUN_ORCHESTRATION_SKILL.includes(RUN_ORCHESTRATION_V5_AVAILABILITY_RULE),
    'v5 must carry the Decision 5 availability rule verbatim as a blockquote');
  assert.ok(SUPERVISOR_RUN_ORCHESTRATION_SKILL.includes('If every provider is\n> `unavailable`, do not launch'),
    'launch is blocked only when every provider is unavailable');
  assert.ok(SUPERVISOR_RUN_ORCHESTRATION_SKILL.includes('a `degraded` provider may be proposed with its caveat'),
    'degraded providers remain eligible as fallback when none are available');
  for (const source of ['explicit', 'workspace default', 'built-in']) {
    assert.ok(SUPERVISOR_RUN_ORCHESTRATION_SKILL.includes(source), `preflight must name the ${source} preference source`);
  }
  assert.ok(SUPERVISOR_RUN_ORCHESTRATION_SKILL.includes('Same-provider pairs remain valid.'),
    'availability resolution must preserve legal same-provider pairs');
});

test('WP-B5-2. pristine v4 run-orchestration skill silently upgrades to v5', () => {
  const workDir = mktmp('run-orchestration-v4');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const skillPath = path.join(workDir, '.lares', 'supervisor', '.claude', 'skills', 'run-orchestration', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, reconstructRunOrchestrationSkillV4(), 'utf-8');
    fs.mkdirSync(path.dirname(sidecarPath(workDir)), { recursive: true });
    fs.writeFileSync(
      sidecarPath(workDir),
      JSON.stringify({ 'supervisor/.claude/skills/run-orchestration/SKILL.md': 4 }, null, 2) + '\n',
      'utf-8',
    );

    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    assert.equal(fs.readFileSync(skillPath, 'utf-8'), SUPERVISOR_RUN_ORCHESTRATION_SKILL);
    assert.equal(fs.readdirSync(path.dirname(skillPath)).filter((name) => name.startsWith('SKILL.md.bak.')).length, 0,
      'a pristine v4 skill must upgrade without a backup');
    assert.equal(readSidecar(workDir)['supervisor/.claude/skills/run-orchestration/SKILL.md'], 5);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

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
