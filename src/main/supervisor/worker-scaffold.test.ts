// Class IV worker-scaffold tests — plans/class-iv-worker-hook-scaffold.md §12.
//
// Exercises the per-provider branches of AgentSupervisor.ensureWorkerScaffold:
//   1. Claude: writes .lares/scripts/dashboard-status.mjs +
//      .lares/workers/claude/{CLAUDE.md,.claude/settings.json} verbatim
//      (path expansion deferred to Claude Code's ${CLAUDE_PROJECT_DIR}).
//   2. Codex: writes the shared script + .lares/workers/codex/.codex/config.toml
//      with ${WORKSPACE_ROOT} replaced by the absolute workspace path.
//   3. Never-overwrite: re-running on the same workDir does not clobber an
//      existing settings.json / config.toml.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/worker-scaffold.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSupervisor, ensureWorkerGitRepoRoot, SCAFFOLD_SIDECAR_REL } from './index';
import {
  SUPERVISOR_CLAUDE_SETTINGS_JSON,
  WORKER_CLAUDE_SETTINGS_JSON,
  workerGrokSettingsJson,
  workerAgyHooksJson,
  RESEARCHER_CLAUDE_SETTINGS_JSON,
  WORKER_GROK_AGENTS_MD,
  WORKER_AGY_AGENTS_MD,
  PROPOSAL_TO_PLAN_SKILL_MD,
} from '../../shared/constants';
import {
  AGY_STATUS_HOOK_NAME,
} from './agy-hooks';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// Minimal DB patching: ensureWorkerScaffold only calls addEvent on success.
function patchDb(): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const origAddEvent = db.addEvent;
  db.addEvent = () => {};
  return () => {
    db.addEvent = origAddEvent;
  };
}

function mktmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agentdash-${prefix}-`));
  return dir;
}

function rmrf(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

type SupervisorWithScaffold = {
  ensureWorkerScaffold: (workDir: string, provider: string, pathType: string) => void;
  ensureSupervisorScaffold: (workDir: string, pathType: string) => void;
};

function makeSupervisor(): { supervisor: SupervisorWithScaffold; cleanup: () => void } {
  const restoreDb = patchDb();
  const raw = new AgentSupervisor();
  (raw as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
  const supervisor = raw as unknown as SupervisorWithScaffold;
  return { supervisor, cleanup: restoreDb };
}

// ── Tests ────────────────────────────────────────────────────────────

test('Codex: scaffold writes .codex/config.toml with absolute workspace path interpolated', () => {
  const workDir = mktmp('codex-scaffold');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    const configPath = path.join(workDir, '.lares', 'workers', 'codex', '.codex', 'config.toml');
    assert.ok(fs.existsSync(configPath), `expected ${configPath} to exist`);

    const content = fs.readFileSync(configPath, 'utf-8');

    // Stop hook table must be present (TOML array-of-tables syntax).
    assert.ok(content.includes('[[hooks.Stop]]'), `config.toml missing [[hooks.Stop]]: ${content}`);
    assert.ok(content.includes('[[hooks.Stop.hooks]]'), `config.toml missing [[hooks.Stop.hooks]]: ${content}`);
    assert.ok(content.includes('type = "command"'), `config.toml missing type=command: ${content}`);

    // Absolute path materialized at scaffold time — no unresolved placeholder.
    assert.ok(
      !content.includes('${WORKSPACE_ROOT}'),
      `config.toml still contains unresolved \${WORKSPACE_ROOT}: ${content}`,
    );

    // Forward-slash normalized workspace path appears in the command.
    const expectedScriptPath = `${workDir.replace(/\\/g, '/')}/.lares/scripts/dashboard-status.mjs`;
    assert.ok(
      content.includes(expectedScriptPath),
      `config.toml does not reference the workspace's dashboard-status.mjs path. Expected substring: ${expectedScriptPath}\nGot: ${content}`,
    );

    // The shared script is also written.
    const scriptPath = path.join(workDir, '.lares', 'scripts', 'dashboard-status.mjs');
    assert.ok(fs.existsSync(scriptPath), `expected shared hook script at ${scriptPath}`);

    // Negative: codex scaffold must not write the Claude-side worker files.
    const claudeSettings = path.join(workDir, '.lares', 'workers', 'claude', '.claude', 'settings.json');
    assert.ok(
      !fs.existsSync(claudeSettings),
      `codex scaffold should not create ${claudeSettings}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Codex: scaffold writes AGENTS.md standing instructions + NO behavioral.md (WP-G)', () => {
  const workDir = mktmp('codex-agents-md');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    // AGENTS.md is the file the Codex CLI reads from cwd as standing instructions.
    const agentsPath = path.join(workDir, '.lares', 'workers', 'codex', 'AGENTS.md');
    assert.ok(fs.existsSync(agentsPath), `expected ${agentsPath} to exist`);
    const agents = fs.readFileSync(agentsPath, 'utf-8');

    // The rule this whole file exists to deliver must be present.
    assert.ok(
      agents.includes('## Never use git to discard uncommitted work'),
      'codex AGENTS.md must carry the git-discard section',
    );
    // Turn-ending protocol + shared-cwd present.
    assert.ok(agents.includes('end your turn with the question in plain text'), 'turn-ending protocol present');
    assert.ok(agents.includes('.lares/workers/codex/'), 'cwd references point at the codex lane');
    assert.ok(!agents.includes('.lares/workers/claude/'), 'no leftover claude cwd references');
    // WP-P0C: the retired every-turn PLAN-EVENT ceremony is gone; the worker
    // planning-surface section (proposal-to-plan orientation) is present instead.
    assert.ok(!agents.includes('PLAN-EVENT'), 'retired every-turn PLAN-EVENT ceremony must be dropped (WP-P0C)');
    assert.ok(agents.includes('proposal-to-plan'), 'codex AGENTS.md must carry the proposal-to-plan planning-surface section');
    assert.ok(!agents.includes('AskUserQuestion'), 'Claude-Code-specific tool name removed');
    // v2 (WP-G): the memory-lessons section points at the injected supervisor memory
    // + recall_memory + remember, NOT a seeded behavioral.md.
    assert.ok(agents.includes('## Memory & lessons'), 'codex AGENTS.md carries the new memory-lessons section');
    assert.ok(agents.includes('recall_memory'), 'codex AGENTS.md names the recall_memory fetch tool');
    assert.ok(agents.includes('.lares/supervisor/memory/MEMORY.md'), 'codex AGENTS.md names the raw-read fallback path');
    assert.ok(!agents.includes('The one durable exception is'), 'codex AGENTS.md drops the retired behavioral.md instruction');

    // WP-G retired seeding: fresh Codex scaffold must write NO behavioral.md.
    const memPath = path.join(workDir, '.lares', 'workers', 'codex', 'behavioral.md');
    assert.ok(!fs.existsSync(memPath), `WP-G: no Codex worker behavioral.md must be seeded; found ${memPath}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Codex: never overwrites existing AGENTS.md on second scaffold call', () => {
  const workDir = mktmp('codex-agents-no-overwrite');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');
    const agentsPath = path.join(workDir, '.lares', 'workers', 'codex', 'AGENTS.md');
    const sentinel = '# user-edited-marker-do-not-clobber\n';
    fs.writeFileSync(agentsPath, sentinel, 'utf-8');

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    const after = fs.readFileSync(agentsPath, 'utf-8');
    assert.equal(after, sentinel, `second scaffold call must not overwrite user-edited AGENTS.md; got: ${after}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Codex: never overwrites existing config.toml on second scaffold call', () => {
  const workDir = mktmp('codex-no-overwrite');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    const configPath = path.join(workDir, '.lares', 'workers', 'codex', '.codex', 'config.toml');
    const sentinel = '# user-edited-marker-do-not-clobber\n';
    fs.writeFileSync(configPath, sentinel, 'utf-8');

    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');

    const after = fs.readFileSync(configPath, 'utf-8');
    assert.equal(
      after,
      sentinel,
      `second scaffold call must not overwrite user-edited config.toml; got: ${after}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Codex: WSL scaffold writes config.toml with /mnt-style absolute path', () => {
  const workDir = mktmp('codex-wsl');
  const { supervisor, cleanup } = makeSupervisor();

  // The WSL branch of writeScaffoldMap shells out to wsl.exe — for a unit
  // test we only care about what content WOULD be written. Stub
  // writeScaffoldMap on the instance to capture the file map and skip the
  // actual write.
  const captured: Record<string, string> = {};
  (supervisor as unknown as {
    writeScaffoldMap: (
      wd: string,
      files: Record<string, { content: string; executable?: boolean }>,
      pt: string,
    ) => number;
  }).writeScaffoldMap = (_wd, files, _pt) => {
    for (const [rel, { content }] of Object.entries(files)) {
      captured[rel] = content;
    }
    return Object.keys(files).length;
  };

  try {
    // workDir is a real Windows tmp path (e.g. C:\Users\...\Temp\...). The
    // expected conversion for WSL: drive letter → /mnt/<lowercase>/<rest>.
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'wsl');

    const configRel = '.lares/workers/codex/.codex/config.toml';
    const content = captured[configRel];
    assert.ok(content, `expected captured ${configRel}; got keys: ${Object.keys(captured).join(', ')}`);

    // Derive expected /mnt path from the actual tmp workDir's drive letter.
    const driveMatch = workDir.match(/^([A-Za-z]):\\(.*)/);
    assert.ok(driveMatch, `tmp workDir should look like 'X:\\...'; got: ${workDir}`);
    const expectedDrive = driveMatch![1].toLowerCase();
    const expectedRest = driveMatch![2].replace(/\\/g, '/');
    const expectedPrefix = `/mnt/${expectedDrive}/${expectedRest}`;

    assert.ok(
      content.includes(`${expectedPrefix}/.lares/scripts/dashboard-status.mjs`),
      `WSL config.toml should reference /mnt/${expectedDrive}/... path. Expected substring: ${expectedPrefix}/.lares/scripts/dashboard-status.mjs\nGot: ${content}`,
    );

    // Negative: no leftover Windows-style C:/ in the rendered TOML.
    assert.ok(
      !/[A-Za-z]:\//.test(content),
      `WSL config.toml should not contain Windows drive paths like C:/; got: ${content}`,
    );

    // Standard invariants (placeholder resolved, Stop hook table present).
    assert.ok(
      !content.includes('${WORKSPACE_ROOT}'),
      `WSL config.toml still contains unresolved \${WORKSPACE_ROOT}: ${content}`,
    );
    assert.ok(content.includes('[[hooks.Stop]]'), `WSL config.toml missing [[hooks.Stop]]: ${content}`);
    assert.ok(content.includes('[[hooks.Stop.hooks]]'), `WSL config.toml missing [[hooks.Stop.hooks]]: ${content}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Claude: scaffold writes .claude/settings.json verbatim (no path materialization)', () => {
  const workDir = mktmp('claude-scaffold');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const settingsPath = path.join(workDir, '.lares', 'workers', 'claude', '.claude', 'settings.json');
    assert.ok(fs.existsSync(settingsPath), `expected ${settingsPath}`);

    const content = fs.readFileSync(settingsPath, 'utf-8');

    // Claude's settings keep ${CLAUDE_PROJECT_DIR} unexpanded — Claude Code
    // expands at hook fire time.
    assert.ok(
      content.includes('${CLAUDE_PROJECT_DIR}'),
      `Claude settings.json should retain \${CLAUDE_PROJECT_DIR}; got: ${content}`,
    );

    // Negative: claude scaffold must not write the codex config.
    const codexConfig = path.join(workDir, '.lares', 'workers', 'codex', '.codex', 'config.toml');
    assert.ok(
      !fs.existsSync(codexConfig),
      `claude scaffold should not create ${codexConfig}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Claude: scaffold writes NO worker behavioral.md (WP-G retired seeding)', () => {
  const workDir = mktmp('claude-worker-memory');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    // WP-G (memory-lessons v2): the shared worker behavioral.md is no longer
    // seeded. A worker's CLAUDE.md (v9) points at the injected supervisor memory +
    // the `remember` skill instead. A fresh scaffold must create no behavioral.md.
    const memPath = path.join(workDir, '.lares', 'workers', 'claude', 'behavioral.md');
    assert.ok(!fs.existsSync(memPath), `WP-G: no Claude worker behavioral.md must be seeded; found ${memPath}`);

    // The worker CLAUDE.md IS still written (its own managed file) and carries the
    // new memory-lessons section rather than a behavioral.md instruction.
    const mdPath = path.join(workDir, '.lares', 'workers', 'claude', 'CLAUDE.md');
    assert.ok(fs.existsSync(mdPath), `expected worker CLAUDE.md at ${mdPath}`);
    const md = fs.readFileSync(mdPath, 'utf-8');
    assert.ok(md.includes('## Memory & lessons'), 'worker CLAUDE.md carries the new memory-lessons section');
    assert.ok(md.includes('recall_memory') && md.includes('`remember`'), 'worker CLAUDE.md names recall_memory + remember');
    assert.ok(!md.includes('The one durable exception is'), 'worker CLAUDE.md drops the retired behavioral.md instruction');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Supervisor: scaffold seeds memory/MEMORY.md', () => {
  const workDir = mktmp('supervisor-memory');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const memPath = path.join(workDir, '.lares', 'supervisor', 'memory', 'MEMORY.md');
    assert.ok(fs.existsSync(memPath), `expected ${memPath}`);

    const content = fs.readFileSync(memPath, 'utf-8');
    assert.ok(
      content.includes('# Supervisor Memory'),
      `MEMORY.md should carry the seed header; got: ${content.slice(0, 120)}`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Supervisor: MEMORY.md is seed-once — an edited copy survives relaunch byte-identical, no .bak', () => {
  // Regression guard: MEMORY.md must NOT live in the version-managed
  // SUPERVISOR_FILES map. If it did, a future SUPERVISOR_MEMORY_MD version
  // bump would treat an edited MEMORY.md as "user-modified, unknown hash" and
  // `.bak` + overwrite it, wiping accumulated supervisor memory. The seed-once
  // contract (seedSupervisorMemoryIfAbsent) means a second scaffold pass never
  // touches an existing file regardless of any notional version change.
  const workDir = mktmp('supervisor-memory-durable');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    // First launch seeds it.
    supervisor.ensureSupervisorScaffold(workDir, 'windows');
    const memPath = path.join(workDir, '.lares', 'supervisor', 'memory', 'MEMORY.md');

    // The supervisor (or human) curates memory across sessions — simulate an
    // edit that the scaffold must preserve verbatim.
    const edited = '# Supervisor Memory\n\n- [SM-99] curated note that must survive relaunch\n';
    fs.writeFileSync(memPath, edited, 'utf-8');
    const before = fs.readFileSync(memPath); // raw bytes

    // Second launch (relaunch / re-open workspace). Even if SUPERVISOR_MEMORY_MD
    // were bumped to a new version, MEMORY.md is no longer in the managed map,
    // so this pass must leave the edit untouched.
    supervisor.ensureSupervisorScaffold(workDir, 'windows');

    const after = fs.readFileSync(memPath);
    assert.ok(
      before.equals(after),
      `edited MEMORY.md must survive a second scaffold pass byte-identical; before=${before.length}B after=${after.length}B`,
    );

    // And no .bak file was spawned for it (the managed-file overwrite signature).
    const dir = path.dirname(memPath);
    const baks = fs.readdirSync(dir).filter((f) => f.startsWith('MEMORY.md.bak'));
    assert.equal(baks.length, 0, `MEMORY.md must not be backed up/overwritten; found: ${baks.join(', ')}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── WP-G regression: repo-wide auto-memory stays OFF ─────────────────
//
// memory-lessons v2 does NOT enable Claude's built-in per-project auto-memory —
// the managed supervisor index (injected) + the `remember` skill are the only
// memory path. A lane whose settings.json silently flipped autoMemoryEnabled to
// true would resurrect the isolated per-session memory the design retired.
test('WP-G: every lane settings.json keeps autoMemoryEnabled: false', () => {
  const lanes: Array<[string, string]> = [
    ['supervisor', SUPERVISOR_CLAUDE_SETTINGS_JSON],
    ['worker', WORKER_CLAUDE_SETTINGS_JSON],
    ['researcher', RESEARCHER_CLAUDE_SETTINGS_JSON],
  ];
  for (const [lane, blob] of lanes) {
    const parsed = JSON.parse(blob) as { autoMemoryEnabled?: unknown };
    assert.equal(parsed.autoMemoryEnabled, false,
      `${lane} settings.json must keep autoMemoryEnabled: false (got ${JSON.stringify(parsed.autoMemoryEnabled)})`);
  }
});

// ── Grok Build worker scaffold (plan §2.6) ───────────────────────────
//
// The grok lane rides the claude-compat carrier: a single managed file,
// .lares/workers/grok/.claude/settings.json. Commit 7 (PowerShell-safe): its
// content is the GENERATED workerGrokSettingsJson() — absolute .lares/scripts
// paths materialized at scaffold-write time, no ${CLAUDE_PROJECT_DIR} (grok runs
// hooks via PowerShell, which does not expand it) — registered under its OWN
// scaffold key at version 2. Plus a seed-once AGENTS.md identity that is NOT in
// the managed map. No native .grok/hooks carrier, no remember skill in this scope.

function readSidecar(workDir: string): Record<string, number> {
  const p = path.join(workDir, ...SCAFFOLD_SIDECAR_REL.split('/'));
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, number>;
}

test('Grok: fresh scaffold writes settings.json + AGENTS.md in the grok cwd + shared scripts', () => {
  const workDir = mktmp('grok-scaffold');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows');

    // The compat carrier: grok loads <cwd>/.claude/settings.json natively.
    const settingsPath = path.join(workDir, '.lares', 'workers', 'grok', '.claude', 'settings.json');
    assert.ok(fs.existsSync(settingsPath), `expected ${settingsPath} to exist`);
    const settings = fs.readFileSync(settingsPath, 'utf-8');
    // Commit 7 (PowerShell-safe carrier): the grok carrier is the generated,
    // path-materialized settings — byte-identical to workerGrokSettingsJson() for
    // this workspace root — NOT the shared claude constant.
    const posixWorkspaceRoot = workDir.replace(/\\/g, '/');
    assert.equal(
      settings,
      workerGrokSettingsJson(posixWorkspaceRoot),
      'grok settings.json must be the generated, path-materialized carrier',
    );
    // NOT the shared claude carrier, and it must carry NO ${CLAUDE_PROJECT_DIR}:
    // grok runs hooks via PowerShell where ${VAR} expands to empty, so the paths
    // are absolute and materialized at scaffold-write time.
    assert.notEqual(settings, WORKER_CLAUDE_SETTINGS_JSON,
      'grok settings.json must NOT be the shared claude carrier (that one is PowerShell-broken for grok)');
    assert.ok(!settings.includes('${'),
      `grok settings.json must contain no \${ sequence (PowerShell-safe); got:\n${settings}`);
    // Every hook command carries the ABSOLUTE workspace .lares/scripts path.
    assert.ok(
      settings.includes(`${posixWorkspaceRoot}/.lares/scripts/dashboard-status.mjs`),
      `grok settings.json must embed the absolute dashboard-status.mjs path; got:\n${settings}`,
    );
    assert.ok(
      settings.includes(`${posixWorkspaceRoot}/.lares/scripts/guard-git-discard.mjs`),
      `grok settings.json must embed the absolute guard-git-discard.mjs path; got:\n${settings}`,
    );

    // The seed-once identity file.
    const agentsPath = path.join(workDir, '.lares', 'workers', 'grok', 'AGENTS.md');
    assert.ok(fs.existsSync(agentsPath), `expected ${agentsPath} to exist`);
    const agents = fs.readFileSync(agentsPath, 'utf-8');
    assert.equal(agents, WORKER_GROK_AGENTS_MD, 'grok AGENTS.md must be the exact derived body');

    // Shared status + guard scripts are present (delivered by WORKSPACE_SCRIPT_FILES).
    assert.ok(
      fs.existsSync(path.join(workDir, '.lares', 'scripts', 'dashboard-status.mjs')),
      'shared dashboard-status.mjs must be present for the grok lane',
    );
    assert.ok(
      fs.existsSync(path.join(workDir, '.lares', 'scripts', 'guard-git-discard.mjs')),
      'shared guard-git-discard.mjs must be present for the grok lane',
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Grok: sidecar records workers/grok/.claude/settings.json:2, independent of claude', () => {
  const workDir = mktmp('grok-sidecar');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    // Scaffold BOTH lanes into one workspace so their sidecar entries coexist.
    supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows');
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');

    const sidecar = readSidecar(workDir);
    assert.equal(
      sidecar['workers/grok/.claude/settings.json'], 2,
      `sidecar must record grok carrier v2 (Commit 7 PowerShell-safe bump); got ${JSON.stringify(sidecar)}`,
    );
    // Version independence: the grok carrier key is distinct from the claude
    // carrier key, and the claude carrier is at its own (higher) version — so the
    // two lanes' carrier versions diverge freely.
    assert.equal(
      sidecar['workers/claude/.claude/settings.json'], 8,
      `claude carrier must keep its own version; got ${JSON.stringify(sidecar)}`,
    );
    assert.notEqual(
      sidecar['workers/grok/.claude/settings.json'],
      sidecar['workers/claude/.claude/settings.json'],
      'grok and claude carriers must be version-independent (distinct sidecar keys)',
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Grok: never overwrites an edited AGENTS.md on re-scaffold (seed-once identity)', () => {
  const workDir = mktmp('grok-agents-no-overwrite');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows');
    const agentsPath = path.join(workDir, '.lares', 'workers', 'grok', 'AGENTS.md');

    // The worker/human edits its identity; a relaunch must preserve it verbatim.
    const edited = '# user-edited-marker-do-not-clobber\n';
    fs.writeFileSync(agentsPath, edited, 'utf-8');
    const before = fs.readFileSync(agentsPath);

    supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows');

    const after = fs.readFileSync(agentsPath);
    assert.ok(
      before.equals(after),
      'second scaffold call must not overwrite an edited grok AGENTS.md',
    );
    // And no .bak was spawned (the managed-file overwrite signature) — proves
    // AGENTS.md is seeded, not version-managed.
    const baks = fs.readdirSync(path.dirname(agentsPath)).filter((f) => f.startsWith('AGENTS.md.bak'));
    assert.equal(baks.length, 0, `grok AGENTS.md must not be backed up/overwritten; found: ${baks.join(', ')}`);
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Grok: NO .grok/hooks carrier and NO remember skill in the minimum scope', () => {
  const workDir = mktmp('grok-no-extras');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows');

    // No native grok hook carrier — grok rides the single claude-compat carrier
    // (two active carriers risk the codex Run-D double-fire).
    const grokHooksDir = path.join(workDir, '.lares', 'workers', 'grok', '.grok');
    assert.ok(!fs.existsSync(grokHooksDir), `no .grok carrier must be created; found ${grokHooksDir}`);

    // No remember skill in this commit (plan §2.5).
    const rememberClaude = path.join(workDir, '.lares', 'workers', 'grok', '.claude', 'skills', 'remember', 'SKILL.md');
    const rememberAgents = path.join(workDir, '.lares', 'workers', 'grok', '.agents', 'skills', 'remember', 'SKILL.md');
    assert.ok(!fs.existsSync(rememberClaude), `no remember skill (.claude) in minimum scope; found ${rememberClaude}`);
    assert.ok(!fs.existsSync(rememberAgents), `no remember skill (.agents) in minimum scope; found ${rememberAgents}`);

    // Grok scaffold must not create the claude/codex worker sibling lanes.
    assert.ok(
      !fs.existsSync(path.join(workDir, '.lares', 'workers', 'claude', '.claude', 'settings.json')),
      'grok scaffold must not write the claude worker carrier',
    );
    assert.ok(
      !fs.existsSync(path.join(workDir, '.lares', 'workers', 'codex', '.codex', 'config.toml')),
      'grok scaffold must not write the codex worker carrier',
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

// ── Grok worker cwd is git-init'd (Commit 6 — inert-carrier fix) ─────
//
// grok resolves its projectRoot to the NEAREST `.git` ancestor of the cwd and
// only loads `<projectRoot>/.claude/settings.json`. The carrier lives at the
// worker cwd (a subdir), so unless the worker cwd is its own git repo the
// carrier is never read and the status hooks + git-discard guard go inert.
// ensureWorkerScaffold therefore `git init`s the worker cwd. These tests drive
// the REAL git binary (present in the build env); the git-unavailable case is
// forced by clearing PATH so `git` cannot resolve.

test('Grok: fresh scaffold git-inits the worker cwd (.lares/workers/grok/.git exists)', () => {
  const workDir = mktmp('grok-gitinit');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows');
    const gitDir = path.join(workDir, '.lares', 'workers', 'grok', '.git');
    assert.ok(
      fs.existsSync(gitDir),
      `expected the worker cwd to be its own git repo at ${gitDir} (grok projectRoot = nearest .git)`,
    );
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Grok: healthy repo takes the verified no-init fast path', () => {
  const workDir = mktmp('grok-gitinit-noop');
  try {
    fs.mkdirSync(path.join(workDir, '.git'));
    const calls: string[][] = [];
    ensureWorkerGitRepoRoot(workDir, 'grok', (args) => {
      calls.push(args);
      return `${workDir}\n`;
    });
    assert.deepEqual(calls, [['rev-parse', '--show-toplevel']], 'healthy repo must verify once and skip git init');
  } finally {
    rmrf(workDir);
  }
});

test('Grok: corrupt .git directory is repaired before exact-root verification', () => {
  const workDir = mktmp('grok-gitinit-repair');
  const workerDir = path.join(workDir, '.lares', 'workers', 'grok');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    fs.mkdirSync(path.join(workerDir, '.git'), { recursive: true });
    supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows');
    const root = String(require('node:child_process').execFileSync(
      'git', ['rev-parse', '--show-toplevel'], { cwd: workerDir, encoding: 'utf-8' },
    )).trim();
    assert.equal(path.resolve(root).toLowerCase(), path.resolve(workerDir).toLowerCase());
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('Grok: git unavailable refuses scaffold with a clear launch error', () => {
  const workDir = mktmp('grok-gitinit-nogit');
  const { supervisor, cleanup } = makeSupervisor();
  const origPath = process.env.PATH;
  try {
    process.env.PATH = '';
    assert.throws(
      () => supervisor.ensureWorkerScaffold(workDir, 'grok', 'windows'),
      /Cannot launch Grok worker:.*must be its own Git repository root; status hooks and the git-discard guard cannot load.*git init failed/is,
    );
    assert.ok(
      fs.existsSync(path.join(workDir, '.lares', 'workers', 'grok', '.claude', 'settings.json')),
      'scaffold files may be repaired before the pre-launch refusal',
    );
    assert.ok(
      !fs.existsSync(path.join(workDir, '.lares', 'workers', 'grok', '.git')),
      'no .git should exist when git is unavailable',
    );
  } finally {
    process.env.PATH = origPath;
    cleanup();
    rmrf(workDir);
  }
});

test('Agy: git init failure is also a loud refusal', () => {
  const workDir = mktmp('agy-gitinit-nogit');
  const fakeHome = path.join(workDir, 'fake-home');
  const priorUserProfile = process.env.USERPROFILE;
  const priorPath = process.env.PATH;
  process.env.USERPROFILE = fakeHome;
  process.env.PATH = '';
  const { supervisor, cleanup } = makeSupervisor();
  try {
    assert.throws(
      () => supervisor.ensureWorkerScaffold(workDir, 'agy', 'windows'),
      /Cannot launch Antigravity worker:.*must be its own Git repository root; workspace hooks cannot load.*git init failed/is,
    );
  } finally {
    process.env.PATH = priorPath;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    cleanup();
    rmrf(workDir);
  }
});

// ── Antigravity worker scaffold (agy plan Commit 2 + Phase-0 addendum) ──

test('Agy: fresh scaffold seeds a flat workspace hook carrier in its own git root', () => {
  const workDir = mktmp('agy-scaffold');
  const fakeHome = path.join(workDir, 'fake-home');
  const priorUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = fakeHome;
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'agy', 'windows');

    const workerDir = path.join(workDir, '.lares', 'workers', 'agy');
    assert.equal(
      fs.readFileSync(path.join(workerDir, 'AGENTS.md'), 'utf-8'),
      WORKER_AGY_AGENTS_MD,
      'agy AGENTS.md must be the exact derived seed body',
    );
    assert.ok(
      !fs.existsSync(path.join(workerDir, 'GEMINI.md')),
      'the plan designates one AGENTS.md identity; do not duplicate it through GEMINI.md',
    );
    const carrierPath = path.join(workerDir, '.agents', 'hooks.json');
    assert.ok(fs.existsSync(carrierPath), 'workspace .agents/hooks.json must be scaffolded');
    const carrier = JSON.parse(fs.readFileSync(carrierPath, 'utf-8')) as any;
    const handlers = carrier[AGY_STATUS_HOOK_NAME].PreInvocation;
    assert.equal(handlers.length, 1);
    assert.equal(typeof handlers[0].command, 'string');
    assert.ok(!('matcher' in handlers[0]) && !('hooks' in handlers[0]), 'PreInvocation must be flat');
    assert.ok(!fs.readFileSync(carrierPath, 'utf-8').includes('${'));
    assert.ok(fs.existsSync(path.join(workerDir, '.git')), 'agy worker cwd must be a git root');
    assert.ok(fs.existsSync(path.join(workDir, '.lares', 'scripts', 'dashboard-status.mjs')));

    const generated = JSON.parse(workerAgyHooksJson('C:\\Workspace With Space', 'C:\\Node Runtime\\node.cmd')) as any;
    const encoded = generated[AGY_STATUS_HOOK_NAME].PreInvocation[0].command.match(/-EncodedCommand\s+(\S+)$/)?.[1];
    const invocation = Buffer.from(encoded, 'base64').toString('utf16le');
    assert.match(invocation, /& "C:\/Node Runtime\/node\.cmd" "C:\/Workspace With Space\/\.lares\/scripts\/dashboard-status\.mjs" working --event PreInvocation/);
  } finally {
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    cleanup();
    rmrf(workDir);
  }
});

test('Agy: re-scaffold preserves identity + foreign global hooks and removes obsolete global entry', () => {
  const workDir = mktmp('agy-idempotent');
  const fakeHome = path.join(workDir, 'fake-home');
  const hooksPath = path.join(fakeHome, '.gemini', 'config', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, '{"human-hook":{"PreInvocation":null},"lares-dashboard-status":{"PreInvocation":[]}}\n', 'utf-8');
  const priorUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = fakeHome;
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'agy', 'windows');
    const agentsPath = path.join(workDir, '.lares', 'workers', 'agy', 'AGENTS.md');
    fs.writeFileSync(agentsPath, '# user-owned agy identity\n', 'utf-8');
    const hooksAfterFirst = fs.readFileSync(hooksPath, 'utf-8');

    supervisor.ensureWorkerScaffold(workDir, 'agy', 'windows');

    assert.equal(fs.readFileSync(agentsPath, 'utf-8'), '# user-owned agy identity\n');
    assert.equal(fs.readFileSync(hooksPath, 'utf-8'), hooksAfterFirst, 'second merge must be a no-op');
    const hooks = JSON.parse(hooksAfterFirst) as Record<string, unknown>;
    assert.deepEqual(hooks['human-hook'], { PreInvocation: null }, 'foreign named hook must survive');
    assert.ok(!(AGY_STATUS_HOOK_NAME in hooks), 'obsolete global hook must be removed');
  } finally {
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    cleanup();
    rmrf(workDir);
  }
});

test('Agy: malformed global hooks config is never clobbered', () => {
  const workDir = mktmp('agy-malformed-hooks');
  const fakeHome = path.join(workDir, 'fake-home');
  const hooksPath = path.join(fakeHome, '.gemini', 'config', 'hooks.json');
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  const malformed = '{ user-owned malformed json';
  fs.writeFileSync(hooksPath, malformed, 'utf-8');
  const priorUserProfile = process.env.USERPROFILE;
  const priorWarn = console.warn;
  process.env.USERPROFILE = fakeHome;
  console.warn = () => {};
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'agy', 'windows');
    assert.equal(fs.readFileSync(hooksPath, 'utf-8'), malformed);
  } finally {
    console.warn = priorWarn;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    cleanup();
    rmrf(workDir);
  }
});

test('Agy identity: derived cwd and provider-neutral question protocol stay correct', () => {
  assert.ok(WORKER_AGY_AGENTS_MD.includes('.lares/workers/agy/'));
  assert.ok(!WORKER_AGY_AGENTS_MD.includes('.lares/workers/claude/'));
  assert.ok(!WORKER_AGY_AGENTS_MD.includes('.lares/workers/codex/'));
  assert.ok(!WORKER_AGY_AGENTS_MD.includes('AskUserQuestion'));
  assert.ok(WORKER_AGY_AGENTS_MD.includes('end your turn with the question in plain text'));
  assert.ok(WORKER_AGY_AGENTS_MD.includes('Never use git to discard uncommitted work'));
});

// ── Grok identity derivation parity (anti-drift, plan §2.1) ──────────
//
// WORKER_GROK_AGENTS_MD is DERIVED from WORKER_CLAUDE_MD via the same
// `.split().join()` chain WORKER_CODEX_AGENTS_MD uses — NOT reused from the codex
// body. These guard against drift and against accidentally shipping codex tokens.

test('Grok identity: derived cwd points at the grok lane, never claude or codex', () => {
  assert.ok(WORKER_GROK_AGENTS_MD.includes('.lares/workers/grok/'), 'grok body must reference its own cwd');
  assert.ok(!WORKER_GROK_AGENTS_MD.includes('.lares/workers/claude/'), 'grok body must not reference the claude cwd');
  assert.ok(!WORKER_GROK_AGENTS_MD.includes('.lares/workers/codex/'), 'grok body must not reference the codex cwd (not reused from WORKER_CODEX_AGENTS_MD)');
});

test('Grok identity: git-discard section survived byte-identical; blocking-dialog intent preserved', () => {
  const header = '## Never use git to discard uncommitted work';
  const i = WORKER_GROK_AGENTS_MD.indexOf(header);
  assert.ok(i >= 0, 'grok body must carry the git-discard section');
  // The section contains none of the transformed tokens, so it must enumerate
  // the four forbidden commands verbatim.
  assert.ok(
    WORKER_GROK_AGENTS_MD.includes('git checkout -- <file>') &&
      WORKER_GROK_AGENTS_MD.includes('git restore') &&
      WORKER_GROK_AGENTS_MD.includes('git clean') &&
      WORKER_GROK_AGENTS_MD.includes('git stash'),
    'the git-discard section must still enumerate the four forbidden commands',
  );
  // Claude-Code-specific dialog names gone; the intent preserved.
  assert.ok(!WORKER_GROK_AGENTS_MD.includes('AskUserQuestion'), 'grok body must not name the Claude-specific AskUserQuestion tool');
  assert.ok(!WORKER_GROK_AGENTS_MD.includes('plan-mode approval prompts'), 'grok body must not name Claude plan-mode prompts');
  assert.ok(WORKER_GROK_AGENTS_MD.includes('end your turn with the question in plain text'), 'intent: end the turn in plain text preserved');
});

// ── WP-P0C: proposal-to-plan skill tree on the worker lanes ──────────

const P2P_REL_FILES = [
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
  'references/contracts/intent-lifecycle.md',
  'references/contracts/manifest-lock.md',
  'scripts/plan-manifest.mjs',
];

test('WP-P0C: fresh Claude worker scaffold writes the whole proposal-to-plan tree under .claude/skills', () => {
  const workDir = mktmp('p2p-worker-claude');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'claude', 'windows');
    const root = path.join(workDir, '.lares', 'workers', 'claude', '.claude', 'skills', 'proposal-to-plan');
    for (const rel of P2P_REL_FILES) {
      assert.ok(fs.existsSync(path.join(root, ...rel.split('/'))), `claude worker root missing ${rel}`);
    }
    assert.equal(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf-8'), PROPOSAL_TO_PLAN_SKILL_MD,
      'SKILL.md must be the exact bundled content');
  } finally {
    cleanup();
    rmrf(workDir);
  }
});

test('WP-P0C: fresh Codex worker scaffold writes the whole proposal-to-plan tree under .agents/skills', () => {
  const workDir = mktmp('p2p-worker-codex');
  const { supervisor, cleanup } = makeSupervisor();
  try {
    supervisor.ensureWorkerScaffold(workDir, 'codex', 'windows');
    const root = path.join(workDir, '.lares', 'workers', 'codex', '.agents', 'skills', 'proposal-to-plan');
    for (const rel of P2P_REL_FILES) {
      assert.ok(fs.existsSync(path.join(root, ...rel.split('/'))), `codex worker root missing ${rel}`);
    }
    assert.equal(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf-8'), PROPOSAL_TO_PLAN_SKILL_MD,
      'SKILL.md must be the exact bundled content in the codex root');
  } finally {
    cleanup();
    rmrf(workDir);
  }
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
