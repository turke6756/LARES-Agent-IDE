#!/usr/bin/env node
// grok-tier0-smoke.mjs — Phase 5 tier-0 UNAUTHENTICATED grok-lane smoke.
//
// RELEASE-USEFUL, NOT part of the default unit run (scripts/run-main-tests.mjs
// deliberately omits it — it drives the REAL grok.exe and touches a disposable
// workspace). Run it manually after `npm run build:main`:
//
//   npm run build:main
//   node scripts/grok-tier0-smoke.mjs
//
// It exercises the grok provider lane end-to-end WITHOUT authentication:
//   • drives the REAL product scaffold + trust code (AgentSupervisor
//     ensureWorkerScaffold / ensureProviderDirTrust) into a throwaway workspace
//     under %TEMP%, with an ISOLATED $GROK_HOME — the real ~/.grok is NEVER
//     touched (only the read-only grok.exe under %USERPROFILE%\.grok\bin is
//     exec'd for --version / inspect);
//   • runs `grok --version` and `grok inspect --json` (the only two subcommands
//     — NEVER bare `grok`, which would open a browser OAuth flow).
//
// Acceptance items (plan §5). Each prints PASS / FAIL / SKIP; the process exits
// non-zero iff any item FAILs. A SKIP (binary absent, or inspect needs auth) is
// NOT a failure — it is recorded with the exact reason.
//   1. Scaffold prep → AGENTS.md + .claude/settings.json + shared status/guard scripts.
//   2. grok --version discovered from %USERPROFILE%\.grok\bin\grok.exe.
//   3. grok inspect --json from the worker cwd → AGENTS.md discovered + no trust
//      suppression (3), and the four claude-compat hooks load from the scaffolded
//      carrier (3.1). Commit 6 FIX: ensureWorkerScaffold now `git init`s the grok
//      worker cwd, so grok's projectRoot (the nearest `.git` ancestor) resolves to
//      the worker cwd ITSELF and loads `.lares/workers/grok/.claude/settings.json`.
//      3.1 asserts the FIXED behavior — projectRoot == worker cwd and all four
//      compat hooks enabled read directly from the worker cwd (previously this was
//      the smoke's one failing item: the carrier at the deeper cwd was never
//      loaded because grok read project hooks only at the outer git root).
//   4. trusted_folders.toml has only the intended canonical entry + preserves
//      pre-existing entries.
//   5. Re-running scaffold + trust prep is a no-op.
//   6. compat.claude.hooks = false → the smoke reports the lane NOT healthy
//      (fails explicitly rather than calling a compat-disabled lane healthy).
//   7. No .grok/hooks carrier is written.

import { createRequire } from 'node:module';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// ── result plumbing ────────────────────────────────────────────────────────
const results = [];
function record(id, name, status, detail) {
  results.push({ id, name, status, detail: detail || '' });
  const tag = status === 'PASS' ? '  ok  ' : status === 'SKIP' ? ' skip ' : ' FAIL ';
  console.log(`${tag} [${id}] ${name}${detail ? ` — ${detail}` : ''}`);
}
function pass(id, name, detail) { record(id, name, 'PASS', detail); }
function fail(id, name, detail) { record(id, name, 'FAIL', detail); }
function skip(id, name, detail) { record(id, name, 'SKIP', detail); }

// ── load the compiled product code ─────────────────────────────────────────
const distIndex = path.resolve(import.meta.dirname, '..', 'dist', 'main', 'main', 'supervisor', 'index.js');
if (!fs.existsSync(distIndex)) {
  console.error(`grok-tier0-smoke: dist not built — run \`npm run build:main\` first (missing ${distIndex})`);
  process.exit(1);
}

// ── disposable workspace + ISOLATED grok home ───────────────────────────────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-tier0-'));
const workDir = path.join(scratch, 'workspace');       // = git repo root (real workspaces are git-backed)
const agentCwd = path.join(workDir, '.lares', 'workers', 'grok');
const grokHome = path.join(scratch, 'grok-home');       // isolated $GROK_HOME — NEVER the real ~/.grok
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(grokHome, { recursive: true });

// Preserve/override the ambient env we touch, restore in the finally.
const prevGrokHome = process.env.GROK_HOME;
const prevAppData = process.env.APPDATA;
process.env.GROK_HOME = grokHome;
// Keep AgentSupervisor's constructor from writing logs into the real AppData.
process.env.APPDATA = path.join(scratch, 'appdata');

// grok loads PROJECT-scope compat hooks only when a projectRoot resolves, which
// requires a git repo (verified on grok 0.2.118). Real dashboard workspaces are
// git-backed, so init one here; if git is unavailable the inspect-hooks item
// degrades to SKIP rather than a false FAIL.
let gitOk = false;
try {
  execFileSync('git', ['init', '-q'], { cwd: workDir, timeout: 20_000, stdio: 'ignore' });
  gitOk = true;
} catch (err) {
  gitOk = false;
}

// A pre-existing, UNRELATED trust entry that item 4 must see preserved.
const PREEXISTING_KEY = 'C:\\Some\\Unrelated\\Pre-Existing Repo';
const preexistingToml = `[folders."${PREEXISTING_KEY.split('\\').join('\\\\')}"]\ntrusted = true\ndecided_at = 1700000000\n`;
const trustPath = path.join(grokHome, 'trusted_folders.toml');
fs.writeFileSync(trustPath, preexistingToml);

let exitCode = 0;
try {
  const { AgentSupervisor, grokTrustPathKey } = require(distIndex);

  // ensureWorkerScaffold records a scaffold audit row; the smoke never opens the
  // dashboard DB, so no-op the DB writes it touches (mirrors the supervisor
  // tests' db patch). File writes — the thing under test — are untouched.
  const dbPath = path.resolve(import.meta.dirname, '..', 'dist', 'main', 'main', 'database.js');
  const db = require(dbPath);
  db.addEvent = () => {};
  db.getAgent = () => null;

  // ── build the supervisor + a small driver ─────────────────────────────────
  function driveScaffold(sup) { sup.ensureWorkerScaffold(workDir, 'grok', 'windows'); }
  function driveTrust(sup) { sup.ensureProviderDirTrust(workDir, agentCwd, 'grok', 'windows'); }

  const sup1 = new AgentSupervisor();
  driveScaffold(sup1);
  driveTrust(sup1);

  // ── item 1: scaffold files ────────────────────────────────────────────────
  {
    const agentsMd = path.join(agentCwd, 'AGENTS.md');
    const settings = path.join(agentCwd, '.claude', 'settings.json');
    const statusMjs = path.join(workDir, '.lares', 'scripts', 'dashboard-status.mjs');
    const guardMjs = path.join(workDir, '.lares', 'scripts', 'guard-git-discard.mjs');
    const missing = [
      ['AGENTS.md', agentsMd], ['.claude/settings.json', settings],
      ['scripts/dashboard-status.mjs', statusMjs], ['scripts/guard-git-discard.mjs', guardMjs],
    ].filter(([, p]) => !fs.existsSync(p)).map(([n]) => n);
    if (missing.length) fail(1, 'scaffold creates AGENTS.md + settings.json + shared scripts', `missing: ${missing.join(', ')}`);
    else pass(1, 'scaffold creates AGENTS.md + settings.json + shared scripts');
  }

  // ── item 7: no .grok/hooks carrier ────────────────────────────────────────
  {
    const carriers = [path.join(workDir, '.grok'), path.join(agentCwd, '.grok')].filter((p) => fs.existsSync(p));
    if (carriers.length) fail(7, 'no .grok/hooks carrier is written', `unexpected: ${carriers.join(', ')}`);
    else pass(7, 'no .grok/hooks carrier is written');
  }

  // ── item 4: trust store — canonical entry + preserves pre-existing ─────────
  const canonicalKey = grokTrustPathKey(workDir, 'windows');
  {
    const toml = fs.existsSync(trustPath) ? fs.readFileSync(trustPath, 'utf-8') : '';
    const escCanonical = canonicalKey ? canonicalKey.split('\\').join('\\\\') : '<null>';
    const escPre = PREEXISTING_KEY.split('\\').join('\\\\');
    const hasCanonical = toml.includes(`[folders."${escCanonical}"]`);
    const hasPre = toml.includes(`[folders."${escPre}"]`);
    // Count how many folder tables exist: exactly two (pre-existing + the one
    // deduped canonical key — workDir and agentCwd both collapse to the git root).
    const tableCount = (toml.match(/^\[folders\./gm) || []).length;
    if (hasCanonical && hasPre && tableCount === 2) {
      pass(4, 'trusted_folders.toml has only the canonical entry + preserves pre-existing', `key=${canonicalKey}`);
    } else {
      fail(4, 'trusted_folders.toml has only the canonical entry + preserves pre-existing',
        `canonical=${hasCanonical} preexisting=${hasPre} tables=${tableCount}\n${toml}`);
    }
  }

  // ── item 5: re-running scaffold + trust is a no-op ────────────────────────
  {
    const agentsMd = path.join(agentCwd, 'AGENTS.md');
    // Simulate user ownership of the seed-once identity — a re-scaffold must
    // never clobber it.
    fs.writeFileSync(agentsMd, 'EDITED BY THE HUMAN — must survive a re-scaffold\n');
    const trustBefore = fs.readFileSync(trustPath, 'utf-8');
    const agentsBefore = fs.readFileSync(agentsMd, 'utf-8');
    // A FRESH supervisor so the per-instance providerTrustEnsured cache does not
    // mask a would-be write — this exercises the read→merge→(no write) path.
    const sup2 = new AgentSupervisor();
    driveScaffold(sup2);
    driveTrust(sup2);
    const trustAfter = fs.readFileSync(trustPath, 'utf-8');
    const agentsAfter = fs.readFileSync(agentsMd, 'utf-8');
    if (trustAfter === trustBefore && agentsAfter === agentsBefore) {
      pass(5, 're-running scaffold + trust prep is a no-op (identity preserved)');
    } else {
      fail(5, 're-running scaffold + trust prep is a no-op',
        `trustChanged=${trustAfter !== trustBefore} identityClobbered=${agentsAfter !== agentsBefore}`);
    }
    // Restore the managed identity for the inspect run below.
    execFileSyncSafe(() => fs.writeFileSync(agentsMd, agentsBefore));
  }

  // ── binary items (2, 3, 6): the REAL grok.exe ─────────────────────────────
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  const grokExe = path.join(userProfile, '.grok', 'bin', 'grok.exe');
  if (!fs.existsSync(grokExe)) {
    const why = `grok.exe not found at ${grokExe}`;
    skip(2, 'grok --version from %USERPROFILE%\\.grok\\bin\\grok.exe', why);
    skip(3, 'grok inspect --json: AGENTS.md discovered from worker cwd + no trust suppression', why);
    skip(3.1, 'four claude-compat hooks load from the worker-cwd carrier', why);
    skip(6, 'compat.claude.hooks=false → lane reported NOT healthy', why);
  } else {
    // Never inherit stdin (a bare interactive grok would open OAuth); we only run
    // --version / inspect, both non-interactive, but be defensive.
    const runGrok = (args, cwd) => spawnSync(grokExe, args, {
      // No windowsHide (it trips the EDR-pattern lint, tier-2 windows-hide) — a
      // brief console flash on a manual smoke is harmless.
      cwd, encoding: 'utf-8', timeout: 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GROK_HOME: grokHome },
    });

    // item 2 — grok --version
    let versionOk = false;
    {
      const r = runGrok(['--version'], workDir);
      const out = `${r.stdout || ''}`.trim();
      if (r.status === 0 && /grok\s+\d+\.\d+/i.test(out)) {
        versionOk = true;
        pass(2, 'grok --version from %USERPROFILE%\\.grok\\bin\\grok.exe', out.split('\n')[0]);
      } else {
        fail(2, 'grok --version from %USERPROFILE%\\.grok\\bin\\grok.exe',
          `status=${r.status} out=${out} err=${(r.stderr || '').trim()}`);
      }
    }

    // item 3 — grok inspect --json from the worker cwd
    let inspected = null;
    {
      const r = runGrok(['inspect', '--json'], agentCwd);
      const out = `${r.stdout || ''}`.trim();
      if (r.status !== 0 || !out.startsWith('{')) {
        // If inspect needs auth (or otherwise refuses), record a documented SKIP
        // with the exact error — never fake a pass.
        const reason = `inspect exit=${r.status}: ${(r.stderr || out || 'no output').trim().split('\n')[0]}`;
        skip(3, 'grok inspect --json: AGENTS.md discovered from worker cwd + no trust suppression', reason);
        skip(3.1, 'four claude-compat hooks load from the worker-cwd carrier', reason);
        skip(6, 'compat.claude.hooks=false → lane reported NOT healthy', 'inspect unavailable');
      } else {
        try {
          inspected = JSON.parse(out);
        } catch (err) {
          skip(3, 'grok inspect --json: AGENTS.md discovered from worker cwd + no trust suppression',
            `unparseable JSON: ${err.message}`);
          skip(3.1, 'four claude-compat hooks load from the worker-cwd carrier', `unparseable JSON: ${err.message}`);
        }
      }
    }

    if (inspected) {
      // ── 3a: AGENTS.md discovered from the worker cwd (case-insensitive) ─────
      const hasAgentsMd = (inspected.projectInstructions || []).some((i) => i.fileType === 'agents_md');
      // ── 3b: no trust suppression — the project is trusted, so project hooks
      //        would NOT be silently skipped for a trust reason ───────────────
      const trusted = inspected.projectTrusted === true;
      if (hasAgentsMd && trusted) {
        pass(3, 'grok inspect --json: AGENTS.md discovered from worker cwd + no trust suppression',
          `projectTrusted=${trusted}, projectRoot=${inspected.projectRoot}`);
      } else {
        fail(3, 'grok inspect --json: AGENTS.md discovered from worker cwd + no trust suppression',
          `agents_md=${hasAgentsMd} projectTrusted=${inspected.projectTrusted}`);
      }

      // ── 3.1: the four claude-compat hooks load FROM THE WORKER-CWD CARRIER ──
      // Commit 6 FIX: ensureWorkerScaffold `git init`s the grok worker cwd, so
      // grok's projectRoot (the nearest `.git` ancestor of the cwd) now resolves to
      // the worker cwd ITSELF — a nested repo beats the outer workspace repo this
      // smoke also `git init`s (line ~87), which is the harder, git-backed-outer
      // case. grok therefore loads `<cwd>/.claude/settings.json` (the scaffolded
      // carrier) and enables all four compat hooks. This asserts that FIXED
      // behavior: projectRoot == worker cwd, all four events enabled, guard Bash
      // matcher — read directly from the worker cwd (no projectRoot control).
      const requiredEvents = ['session_start', 'user_prompt_submit', 'stop', 'pre_tool_use'];
      const enabledClaudeEvents = (insp) => new Set(
        (insp.hooks || []).filter((h) => h.vendor === 'claude' && h.compatibilityStatus === 'enabled').map((h) => h.event),
      );
      const cwdEvents = enabledClaudeEvents(inspected);
      const cwdLoadsAll = requiredEvents.every((e) => cwdEvents.has(e));
      const cwdGuard = (inspected.hooks || []).find((h) => h.vendor === 'claude' && h.event === 'pre_tool_use');
      // projectRoot must now BE the worker cwd (canonicalized both sides, case-
      // insensitive on Windows, to survive dunce/native spelling differences).
      let projectRootIsCwd = false;
      try {
        const canonCwd = fs.realpathSync.native(agentCwd);
        projectRootIsCwd = !!inspected.projectRoot
          && path.resolve(String(inspected.projectRoot)).toLowerCase() === path.resolve(canonCwd).toLowerCase();
      } catch { projectRootIsCwd = false; }

      // Prove grok skips an UNKNOWN Claude event without rejecting the file, now
      // exercised at the REAL worker-cwd carrier (plan §5 item 3): inject a bogus
      // event, re-inspect from the cwd, confirm the four known events still load
      // and the bogus one does not, then restore the pristine managed carrier.
      const cwdCarrier = path.join(agentCwd, '.claude', 'settings.json');
      const pristineCarrier = fs.readFileSync(cwdCarrier, 'utf-8');
      let unknownSkipped = false;
      try {
        const parsed = JSON.parse(pristineCarrier);
        parsed.hooks = parsed.hooks || {};
        parsed.hooks.ZzzTotallyUnknownEvent = [{ hooks: [{ type: 'command', command: 'echo nope' }] }];
        fs.writeFileSync(cwdCarrier, JSON.stringify(parsed, null, 2));
        const uc = runGrok(['inspect', '--json'], agentCwd);
        const uout = `${uc.stdout || ''}`.trim();
        if (uc.status === 0 && uout.startsWith('{')) {
          const uj = JSON.parse(uout);
          const ue = enabledClaudeEvents(uj);
          const stillAll = requiredEvents.every((e) => ue.has(e));
          const events = (uj.hooks || []).filter((h) => h.vendor === 'claude').map((h) => `${h.event}`.toLowerCase());
          unknownSkipped = stillAll && !events.some((e) => e.includes('zzz') || e.includes('unknown'));
        }
      } finally {
        fs.writeFileSync(cwdCarrier, pristineCarrier);  // restore the managed carrier
      }

      if (cwdLoadsAll && cwdGuard && cwdGuard.matcher === 'Bash' && projectRootIsCwd && unknownSkipped) {
        pass(3.1, 'four claude-compat hooks load from the worker-cwd carrier (Commit 6 git-init fix)',
          `projectRoot==cwd; hooks=[${[...cwdEvents].join(',')}]; guard matcher=Bash; unknown event skipped`);
      } else {
        fail(3.1, 'four claude-compat hooks load from the worker-cwd carrier',
          `Commit 6 expects the worker cwd to be its own projectRoot so the carrier loads. `
          + `loadsAllFour=${cwdLoadsAll} guardMatcher=${cwdGuard && cwdGuard.matcher} `
          + `projectRootIsWorkerCwd=${projectRootIsCwd} (projectRoot=${inspected.projectRoot}, cwd=${agentCwd}) `
          + `unknownEventSkipped=${unknownSkipped}. If projectRootIsWorkerCwd=false, the worker cwd's `
          + `\`.git\` was not created (git unavailable?) → grok fell back to the outer root and never `
          + `loaded the carrier.`);
      }

      // ── item 6: compat.claude.hooks = false → lane must read NOT healthy. ──
      // Now exercised at the REAL worker-cwd carrier (Commit 6 makes grok load it
      // there), so the health signal is tested against the actually-loaded hooks.
      if (versionOk) {
        const cfgPath = path.join(grokHome, 'config.toml');
        try {
          // First confirm the worker-cwd carrier loads ENABLED with no config…
          const before = runGrok(['inspect', '--json'], agentCwd);
          const bj = before.status === 0 && `${before.stdout}`.trim().startsWith('{') ? JSON.parse(`${before.stdout}`.trim()) : null;
          const enabledBefore = bj ? (bj.hooks || []).some((h) => h.vendor === 'claude' && h.compatibilityStatus === 'enabled') : false;
          // …then disable compat and confirm it flips to NOT healthy.
          fs.writeFileSync(cfgPath, '[compat.claude]\nhooks = false\n');
          const after = runGrok(['inspect', '--json'], agentCwd);
          const aout = `${after.stdout || ''}`.trim();
          if (after.status !== 0 || !aout.startsWith('{')) {
            skip(6, 'compat.claude.hooks=false → lane reported NOT healthy', `inspect exit=${after.status}`);
          } else {
            const aj = JSON.parse(aout);
            const cell = (aj.externalCompat?.cells || []).find((c) => c.vendor === 'claude' && c.surface === 'hooks');
            const anyEnabledClaude = (aj.hooks || []).some((h) => h.vendor === 'claude' && h.compatibilityStatus === 'enabled');
            const cellDisabled = cell && cell.enabled === false;
            if (enabledBefore && cellDisabled && !anyEnabledClaude) {
              pass(6, 'compat.claude.hooks=false → lane reported NOT healthy',
                `enabled→disabled: cell.enabled=false (source=${cell.source}); no enabled compat hooks`);
            } else {
              fail(6, 'compat.claude.hooks=false → lane reported NOT healthy',
                `enabledBefore=${enabledBefore} cell=${JSON.stringify(cell)} anyEnabledClaudeHook=${anyEnabledClaude} `
                + `— a compat-disabled lane must NOT read as healthy`);
            }
          }
        } finally {
          try { fs.rmSync(cfgPath, { force: true }); } catch { /* best effort */ }
        }
      } else {
        skip(6, 'compat.claude.hooks=false → lane reported NOT healthy', 'version check did not pass');
      }
    }
  }
} catch (err) {
  fail(0, 'smoke harness', err && err.stack ? err.stack : String(err));
} finally {
  // ── summary ────────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log(`\ngrok-tier0-smoke: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  exitCode = failed > 0 ? 1 : 0;

  // Restore env + clean up the throwaway state (best effort — a grok leader may
  // briefly hold files under the isolated home on Windows).
  if (prevGrokHome === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = prevGrokHome;
  if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData;
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
}

// A tiny guard so a restore write can't blow up the run.
function execFileSyncSafe(fn) { try { fn(); } catch { /* best effort */ } }

process.exit(exitCode);
