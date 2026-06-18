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
  normalizeManagedKey,
  sha256Hex,
} from './index';
import {
  DASHBOARD_STATUS_SCRIPT_MJS,
  DASHBOARD_STATUS_SCRIPT_MJS_V4,
  DASHBOARD_STATUS_SCRIPT_MJS_V6,
  RESEARCH_STORE_README_MD,
  RESEARCHER_AGENT_MD,
  RESEARCHER_CLAUDE_SETTINGS_JSON,
  SUPERVISOR_AGENT_MD,
  WORKER_CLAUDE_MD,
  WORKER_CLAUDE_MD_V1,
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 7, `sidecar must record v6; got: ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 7, `sidecar must record v7; got: ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 7, `sidecar must record v6; got: ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 7, `sidecar must record v6 for the script; got: ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 7, `sidecar must record v6; got: ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 7, `sidecar must record v6; got: ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 7, `sidecar must still record v6 for the script; got: ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['scripts/dashboard-status.mjs'], 7, `sidecar must be valid JSON with v6; got: ${JSON.stringify(sidecar)}`);

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
      sidecar['scripts/dashboard-status.mjs'], 7,
      `sidecar should be at v5 after concurrent run; got: ${JSON.stringify(sidecar)}`,
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

    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['researcher/CLAUDE.md'], 1, `sidecar must record researcher CLAUDE.md v1; got ${JSON.stringify(sidecar)}`);
    assert.equal(sidecar['researcher/.claude/settings.json'], 1, 'sidecar must record settings v1');

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

test('G5. worker CLAUDE.md: pristine v1 silently upgrades to v3 carrying the research-store pointer', () => {
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
    assert.equal(content, WORKER_CLAUDE_MD, 'v1 worker CLAUDE.md must silently upgrade to v3 bundled content');
    assert.equal(countMatches(content, RESEARCH_SECTION_MARKER), 1, 'research-store section appears exactly once (not double-appended)');
    const backups = fs.readdirSync(path.dirname(mdPath)).filter((n) => n.startsWith('CLAUDE.md.bak.'));
    assert.equal(backups.length, 0, 'known-hash v1→v3 upgrade must NOT create a backup');
    const sidecar = readSidecar(workDir);
    assert.equal(sidecar['workers/claude/CLAUDE.md'], 3, `sidecar must record v3; got ${JSON.stringify(sidecar)}`);
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
    assert.equal(sidecar['supervisor/CLAUDE.md'], 6, `sidecar must record v6; got ${JSON.stringify(sidecar)}`);

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
