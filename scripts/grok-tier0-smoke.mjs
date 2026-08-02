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
//      carrier (3.1). NOTE: 3.1 currently FAILS and is the smoke's headline
//      finding — grok discovers project `.claude/settings.json` hooks at the git
//      PROJECT ROOT, not the deeper worker cwd, so the carrier at
//      `.lares/workers/grok/.claude/settings.json` is never loaded (status hooks +
//      git-guard silently inert). 3.1 runs a projectRoot control to prove this is
//      a carrier-PLACEMENT bug, not a trust/format issue. See the commit summary.
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

      // ── 3c: the four claude-compat hooks load FROM THE WORKER-CWD CARRIER ──
      // Grok discovers project-scope `.claude/settings.json` hooks at the git
      // PROJECT ROOT (the `.git` ancestor), NOT at the deeper cwd. The scaffold
      // writes the carrier at `<workspace>/.lares/workers/grok/.claude/settings.json`
      // (the worker cwd, a subdir), so grok never loads it → the grok worker's
      // status hooks + git-guard are silently inert. To PROVE this is a
      // carrier-PLACEMENT bug (not a trust/format/version issue), run a control:
      // drop the identical settings.json at the projectRoot and confirm grok
      // loads all four hooks there.
      const requiredEvents = ['session_start', 'user_prompt_submit', 'stop', 'pre_tool_use'];
      const enabledClaudeEvents = (insp) => new Set(
        (insp.hooks || []).filter((h) => h.vendor === 'claude' && h.compatibilityStatus === 'enabled').map((h) => h.event),
      );
      const cwdEvents = enabledClaudeEvents(inspected);
      const cwdLoadsAll = requiredEvents.every((e) => cwdEvents.has(e));

      // Control at the projectRoot (workDir = the git root of this smoke's
      // workspace). Use the scaffolded carrier PLUS a deliberately-unknown event
      // name so we can prove grok skips unknown Claude events without rejecting
      // the file (the real carrier's own events — SessionStart/Stop/
      // UserPromptSubmit/Notification/PreToolUse — are ALL recognized by grok, so
      // an injected bogus event is the only way to exercise the skip path).
      const rootCarrierDir = path.join(workDir, '.claude');
      const rootCarrier = path.join(rootCarrierDir, 'settings.json');
      const scaffoldedSettings = fs.readFileSync(path.join(agentCwd, '.claude', 'settings.json'), 'utf-8');
      const withUnknownEvent = (() => {
        const parsed = JSON.parse(scaffoldedSettings);
        parsed.hooks = parsed.hooks || {};
        parsed.hooks.ZzzTotallyUnknownEvent = [{ hooks: [{ type: 'command', command: 'echo nope' }] }];
        return JSON.stringify(parsed, null, 2);
      })();
      let controlLoadsAll = false;
      let controlGuard = null;
      let controlUnknownSkipped = false;
      try {
        fs.mkdirSync(rootCarrierDir, { recursive: true });
        fs.writeFileSync(rootCarrier, withUnknownEvent);
        const rc = runGrok(['inspect', '--json'], agentCwd);
        const rout = `${rc.stdout || ''}`.trim();
        if (rc.status === 0 && rout.startsWith('{')) {
          const cj = JSON.parse(rout);
          const ce = enabledClaudeEvents(cj);
          controlLoadsAll = requiredEvents.every((e) => ce.has(e));
          controlGuard = (cj.hooks || []).find((h) => h.vendor === 'claude' && h.event === 'pre_tool_use');
          // The bogus event must NOT surface as a loaded hook, yet the known ones do.
          const events = (cj.hooks || []).filter((h) => h.vendor === 'claude').map((h) => `${h.event}`.toLowerCase());
          controlUnknownSkipped = !events.some((e) => e.includes('zzz') || e.includes('unknown'));
        }
      } finally {
        try { fs.rmSync(rootCarrierDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }

      // If the worker-cwd carrier IS read (grok changed its model, or the cwd is
      // itself a project root), validate Bash matcher + unknown-skip from the cwd
      // inspect itself; otherwise report the placement bug with the projectRoot
      // control result.
      const cwdGuard = (inspected.hooks || []).find((h) => h.vendor === 'claude' && h.event === 'pre_tool_use');
      if (cwdLoadsAll && cwdGuard && cwdGuard.matcher === 'Bash') {
        pass(3.1, 'four claude-compat hooks load from the worker-cwd carrier (Bash matcher)',
          `hooks=[${[...cwdEvents].join(',')}]`);
      } else {
        fail(3.1, 'four claude-compat hooks load from the worker-cwd carrier',
          `PRODUCT BUG: grok did NOT load the scaffolded carrier at <cwd>/.claude/settings.json `
          + `(worker cwd=${agentCwd} is a subdir of git root=${inspected.projectRoot}). `
          + `grok reads project hooks at <projectRoot>/.claude only. `
          + `CONTROL (identical settings.json placed at the projectRoot): loadsAllFour=${controlLoadsAll}, `
          + `guardMatcher=${controlGuard && controlGuard.matcher}, unknownEventSkipped=${controlUnknownSkipped} `
          + `→ confirms a carrier-PLACEMENT bug, not a trust/format/version issue.`);
      }

      // ── item 6: compat.claude.hooks = false → lane must read NOT healthy. ──
      // Exercised at the projectRoot control location (the ONLY place grok
      // actually loads the compat carrier — see 3.1), so the health signal is
      // tested against real loaded hooks rather than a carrier grok ignores.
      if (versionOk) {
        const cfgPath = path.join(grokHome, 'config.toml');
        try {
          fs.mkdirSync(rootCarrierDir, { recursive: true });
          fs.writeFileSync(rootCarrier, scaffoldedSettings);
          // First confirm the control carrier loads ENABLED with no config…
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
          try { fs.rmSync(rootCarrierDir, { recursive: true, force: true }); } catch { /* best effort */ }
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
