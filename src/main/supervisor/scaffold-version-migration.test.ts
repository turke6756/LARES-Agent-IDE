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
  SCAFFOLD_SIDECAR_REL,
  SUPERVISOR_AGENT_MD_V8_HASH,
  SUPERVISOR_AGENT_MD_V9_HASH,
  SUPERVISOR_AGENT_MD_V10_HASH,
  SUPERVISOR_AGENT_MD_V11_HASH,
  SUPERVISOR_AGENT_MD_V12_HASH,
  SUPERVISOR_AGENT_MD_V13_HASH,
  SUPERVISOR_AGENT_MD_V14_HASH,
  SUPERVISOR_AGENT_MD_V15_HASH,
  SUPERVISOR_ORCHESTRATION_SPIKE_SKILL_V1_HASH,
  SUPERVISOR_ORCHESTRATION_SPIKE_SKILL_V2_HASH,
  WORKER_CLAUDE_MD_V6_HASH,
  RESEARCHER_AGENT_MD_V5_HASH,
  WORKER_CLAUDE_MD_V5_HASH,
  RESEARCHER_AGENT_MD_V4_HASH,
  normalizeManagedKey,
  sha256Hex,
} from './index';
import {
  DASHBOARD_STATUS_SCRIPT_MJS,
  DASHBOARD_STATUS_SCRIPT_MJS_V4,
  DASHBOARD_STATUS_SCRIPT_MJS_V6,
  DASHBOARD_STATUS_SCRIPT_V8_HASH,
  RESEARCH_STORE_README_MD,
  RESEARCHER_AGENT_MD,
  RESEARCHER_CLAUDE_SETTINGS_JSON,
  SUPERVISOR_AGENT_MD,
  SUPERVISOR_CONTEXT_ANALYTICS_SKILL,
  WORKER_CLAUDE_MD,
  WORKER_CLAUDE_MD_V1,
  WORKER_CLAUDE_SETTINGS_JSON,
  WORKER_CLAUDE_SETTINGS_JSON_V6,
} from '../../shared/constants';
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 9, `sidecar must record v6; got: ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 9, `sidecar must record v7; got: ${JSON.stringify(sidecar)}`);
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
function reconstructV8Script(): string {
  const v8 = DASHBOARD_STATUS_SCRIPT_MJS.replace(
    /  \/\/ idle-vs-waiting fix[\s\S]*?if \(isNonBlocking\) return;\n  \}\n\n/,
    '',
  );
  assert.notEqual(v8, DASHBOARD_STATUS_SCRIPT_MJS, 'the v9 bail block must be present in the live script to remove');
  return v8;
}

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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 9, `sidecar must record v9; got: ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 9, `sidecar must record v9; got: ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 9, `sidecar must record v6; got: ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 9, `sidecar must record v6 for the script; got: ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 9, `sidecar must record v6; got: ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 9, `sidecar must record v6; got: ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 9, `sidecar must still record v6 for the script; got: ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 9, `sidecar must be valid JSON with v6; got: ${JSON.stringify(sidecar)}`);

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
      sidecar['scripts/dashboard-status.mjs'], 9,
      `sidecar should be at v9 after concurrent run; got: ${JSON.stringify(sidecar)}`,
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
    assert.equal(readSidecar(workDir)['scripts/dashboard-status.mjs'], 9, 'sidecar must record v9');
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
    assert.equal(readSidecar(workDir)['scripts/dashboard-status.mjs'], 9, 'sidecar must record v9');
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
      JSON.stringify({ 'scripts/dashboard-status.mjs': 9 }, null, 2) + '\n',
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
    assert.equal(readSidecar(workDir)['scripts/dashboard-status.mjs'], 9, 'sidecar must record v9');
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
    assert.equal(sidecar['workers/claude/CLAUDE.md'], 7, `sidecar must record v6; got ${JSON.stringify(sidecar)}`);
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

/** The v6 worker CLAUDE.md — the last pre-`.lares` body — reconstructed by
 *  reverting the state-dir rename (the ONLY v7 change). RN-W0 pins it to
 *  WORKER_CLAUDE_MD_V6_HASH so any drift fails loudly. */
const WORKER_CLAUDE_MD_V6 = WORKER_CLAUDE_MD.split('.lares').join('.dashboard');

test('RN-W0. precondition: reconstructed v6 worker CLAUDE.md hashes to the shipped constant', () => {
  assert.notEqual(WORKER_CLAUDE_MD_V6, WORKER_CLAUDE_MD, 'the v7 rename must change the body');
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

test('D2-1. worker CLAUDE.md: pristine v5 silently upgrades to v6 carrying the mandatory-sentinel wording once', () => {
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
    assert.equal(content, WORKER_CLAUDE_MD, 'v5 worker CLAUDE.md must silently upgrade to v6 bundled content');
    assert.equal(countMatches(content, PLAN_EVENT_MARKER), 1, 'v2 plan-event marker appears exactly once');
    assert.ok(content.includes('End EVERY plan-rail turn'), 'upgraded CLAUDE.md must carry the mandatory-sentinel wording');
    assert.ok(content.includes('reviewed | deliberating | blocked'), 'upgraded CLAUDE.md must carry the expanded status vocabulary');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v5→v6 upgrade must NOT create a backup');
    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['workers/claude/CLAUDE.md'], 7, `sidecar must record v6; got ${JSON.stringify(sidecar)}`);
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
    assert.equal(readSidecar(workDir)['workers/claude/CLAUDE.md'], 7, 'sidecar must record v6');
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
    assert.equal(sidecar['supervisor/CLAUDE.md'], 16, `sidecar must record the current bundled version; got ${JSON.stringify(sidecar)}`);

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
    assert.equal(readSidecar(workDir)['workers/claude/.claude/settings.json'], 7, 'sidecar must record v7');
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
    assert.equal(readSidecar(workDir)['workers/claude/.claude/settings.json'], 7, 'sidecar must record v7');
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
/** The v15 supervisor CLAUDE.md — the last pre-`.lares` body — reconstructed by
 *  reverting the state-dir rename (the ONLY v16 change). RN-S0 pins it to
 *  SUPERVISOR_AGENT_MD_V15_HASH so any drift fails loudly. */
const SUPERVISOR_AGENT_MD_V15 = SUPERVISOR_AGENT_MD.split('.lares').join('.dashboard');

test('RN-S0. precondition: reconstructed v15 supervisor CLAUDE.md hashes to the shipped constant', () => {
  assert.notEqual(SUPERVISOR_AGENT_MD_V15, SUPERVISOR_AGENT_MD, 'the v16 rename must change the body');
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
    assert.equal(sidecar['supervisor/CLAUDE.md'], 16, `sidecar must record the current bundled version; got ${JSON.stringify(sidecar)}`);
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
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 16, 'sidecar must record the current bundled version');
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
    assert.equal(sidecar['supervisor/CLAUDE.md'], 16, `sidecar must record the current bundled version; got ${JSON.stringify(sidecar)}`);
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
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 16, 'sidecar must record the current bundled version');
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
    assert.equal(sidecar['supervisor/CLAUDE.md'], 16, `sidecar must record the current bundled version; got ${JSON.stringify(sidecar)}`);
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
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 16, 'sidecar must record the current bundled version');
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
  assert.equal(previous.version, 16, 'supervisor CLAUDE.md must be at version 16');
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
    assert.equal(sidecar['supervisor/CLAUDE.md'], 16, `sidecar must record the current bundled version; got ${JSON.stringify(sidecar)}`);
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
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 16, 'sidecar must record the current bundled version');
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
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 16, 'sidecar must record the current bundled version');
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
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 16, 'sidecar must record the current bundled version');
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
  assert.equal(managed.version, 16, 'the bundled supervisor CLAUDE.md must be v16');
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
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 16, 'sidecar must record v16');
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
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 16, 'sidecar must record v16');
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
  assert.equal(managed.version, 16, 'the bundled supervisor CLAUDE.md must be v16');
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
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 16, 'sidecar must record v16');
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
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 16, 'sidecar must record v16');
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

// ── normalizeManagedKey: small builder unit ──────────────────────────

test('normalizeManagedKey strips .lares/ AND legacy .dashboard/, and normalizes separators', () => {
  assert.equal(normalizeManagedKey('.lares/scripts/dashboard-status.mjs'), 'scripts/dashboard-status.mjs');
  assert.equal(normalizeManagedKey('.lares\\scripts\\dashboard-status.mjs'), 'scripts/dashboard-status.mjs');
  assert.equal(normalizeManagedKey('.dashboard/scripts/dashboard-status.mjs'), 'scripts/dashboard-status.mjs');
  assert.equal(normalizeManagedKey('.dashboard\\scripts\\dashboard-status.mjs'), 'scripts/dashboard-status.mjs');
  assert.equal(normalizeManagedKey('scripts/dashboard-status.mjs'), 'scripts/dashboard-status.mjs');
  assert.equal(normalizeManagedKey('.dashboard/workers/claude/.claude/settings.json'), 'workers/claude/.claude/settings.json');
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
