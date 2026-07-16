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
  WORKER_CLAUDE_MD,
  WORKER_CLAUDE_MD_V1,
  WORKER_CLAUDE_SETTINGS_JSON,
  WORKER_CLAUDE_SETTINGS_JSON_V6,
} from '../../shared/constants';

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
  return path.join(workDir, '.dashboard', 'scripts', 'dashboard-status.mjs');
}
function sidecarPath(workDir: string): string {
  return path.join(workDir, ...SCAFFOLD_SIDECAR_REL.split('/'));
}

function listBackups(workDir: string): string[] {
  const dir = path.join(workDir, '.dashboard', 'scripts');
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
      path.join(workDir, '.dashboard', 'scripts', backups[0]),
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
      path.join(workDir, '.dashboard', 'scripts', backups[0]),
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
// .dashboard/scripts/dashboard-status.mjs they depend on. These exercise that
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
      fs.readFileSync(path.join(workDir, '.dashboard', 'scripts', backups[0]), 'utf-8'),
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
  return path.join(workDir, '.dashboard', 'research', ...rel);
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
  return path.join(workDir, '.dashboard', 'researcher', ...rel);
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
    assert.equal(sidecar['researcher/CLAUDE.md'], 5, `sidecar must record researcher CLAUDE.md v5; got ${JSON.stringify(sidecar)}`);
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

/** The v4 researcher CLAUDE.md, reconstructed by stripping the v5 `## Signed-in
 *  sites` section back out of the current bundled constant. The precondition test
 *  pins this to RESEARCHER_AGENT_MD_V4_HASH so any drift fails loudly. */
const RESEARCHER_AGENT_MD_V4 = RESEARCHER_AGENT_MD.replace(
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
    assert.equal(sidecar['researcher/CLAUDE.md'], 5, `sidecar must record v5; got ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('G5. worker CLAUDE.md: pristine v1 silently upgrades to current carrying the research-store pointer', () => {
  const workDir = mktmp('worker-claudemd-v1');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.dashboard', 'workers', 'claude', 'CLAUDE.md');
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
    assert.equal(sidecar['workers/claude/CLAUDE.md'], 6, `sidecar must record v6; got ${JSON.stringify(sidecar)}`);
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

/** The v5 worker CLAUDE.md, reconstructed by swapping the current v6 plan-event
 *  sentinel section back to its v5 form. The precondition test pins this to
 *  WORKER_CLAUDE_MD_V5_HASH. */
const WORKER_CLAUDE_MD_V5 = WORKER_CLAUDE_MD.replace(
  /<!-- section:plan-event-sentinel v2 -->[\s\S]*?<!-- \/section:plan-event-sentinel -->/,
  PLAN_EVENT_SECTION_V5,
);

function workerClaudeMdPath(workDir: string): string {
  return path.join(workDir, '.dashboard', 'workers', 'claude', 'CLAUDE.md');
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
    assert.equal(sidecar['workers/claude/CLAUDE.md'], 6, `sidecar must record v6; got ${JSON.stringify(sidecar)}`);
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
    assert.equal(readSidecar(workDir)['workers/claude/CLAUDE.md'], 6, 'sidecar must record v6');
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

    const mdPath = path.join(workDir, '.dashboard', 'supervisor', 'CLAUDE.md');
    const content = fs.readFileSync(mdPath, 'utf-8');
    assert.equal(content, SUPERVISOR_AGENT_MD, 'supervisor CLAUDE.md must be exact bundled content');
    assert.equal(countMatches(content, RESEARCH_SECTION_MARKER), 1, 'research-store section appears exactly once');
    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['supervisor/CLAUDE.md'], 11, `sidecar must record v11; got ${JSON.stringify(sidecar)}`);

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

// ── Usage-limits statusLine: worker settings.json v6 → v7 migration ──────
//
// plans/usage-limits-mcp-and-ui.md §1.4 — the worker .claude/settings.json gains
// a `statusLine` block (v6 → v7). A pristine v6 file must silently upgrade; a
// locally-edited one must be .bak'd + overwritten.

function workerSettingsPath(workDir: string): string {
  return path.join(workDir, '.dashboard', 'workers', 'claude', '.claude', 'settings.json');
}
function listSettingsBackups(workDir: string): string[] {
  const dir = path.join(workDir, '.dashboard', 'workers', 'claude', '.claude');
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
      fs.readFileSync(path.join(workDir, '.dashboard', 'workers', 'claude', '.claude', backups[0]), 'utf-8'),
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

/** The v9 supervisor CLAUDE.md, reconstructed by removing the one v10 addition
 *  (the planning-surface sentinel block) from the current bundled constant. The
 *  precondition test below pins this reconstruction to SUPERVISOR_AGENT_MD_V9_HASH
 *  — if the append stops being clean, the hash check fails loudly. */
const SUPERVISOR_AGENT_MD_V9 = SUPERVISOR_AGENT_MD
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
    const mdPath = path.join(workDir, '.dashboard', 'supervisor', 'CLAUDE.md');
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
    assert.ok(content.includes('**get_my_context**'), 'upgraded CLAUDE.md must carry the get_my_context tool bullet');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v8→current upgrade must NOT create a backup');
    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['supervisor/CLAUDE.md'], 11, `sidecar must record v11; got ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('CB-2. supervisor CLAUDE.md: locally-edited v8 (unknown hash) → .bak + overwrite with current', () => {
  const workDir = mktmp('sup-claudemd-v8-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.dashboard', 'supervisor', 'CLAUDE.md');
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
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 11, 'sidecar must record v11');
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
    const mdPath = path.join(workDir, '.dashboard', 'supervisor', 'CLAUDE.md');
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
    assert.equal(sidecar['supervisor/CLAUDE.md'], 11, `sidecar must record v11; got ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('PS-2. supervisor CLAUDE.md: locally-edited v9 (unknown hash) → .bak + overwrite with v10', () => {
  const workDir = mktmp('sup-claudemd-v9-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.dashboard', 'supervisor', 'CLAUDE.md');
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
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 11, 'sidecar must record v11');
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
const SUPERVISOR_AGENT_MD_V10 = SUPERVISOR_AGENT_MD.replace(
  /\n<!-- section:planning-surface v1 -->[\s\S]*?<!-- \/section:planning-surface -->\n/,
  '\n' + PLANNING_SURFACE_SECTION_V10 + '\n',
);

test('ET-0. precondition: reconstructed v10 supervisor CLAUDE.md hashes to the shipped constant', () => {
  assert.notEqual(SUPERVISOR_AGENT_MD_V10, SUPERVISOR_AGENT_MD, 'the v11 planning-surface block must differ from v10');
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
    const mdPath = path.join(workDir, '.dashboard', 'supervisor', 'CLAUDE.md');
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
    assert.equal(sidecar['supervisor/CLAUDE.md'], 11, `sidecar must record v11; got ${JSON.stringify(sidecar)}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('ET-2. supervisor CLAUDE.md: locally-edited v10 (unknown hash) → .bak + overwrite with v11', () => {
  const workDir = mktmp('sup-claudemd-v10-edited');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    const mdPath = path.join(workDir, '.dashboard', 'supervisor', 'CLAUDE.md');
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
    assert.equal(readSidecar(workDir)['supervisor/CLAUDE.md'], 11, 'sidecar must record v11');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── normalizeManagedKey: small builder unit ──────────────────────────

test('normalizeManagedKey strips .dashboard/ and normalizes separators', () => {
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
