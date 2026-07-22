/**
 * verify-native.cjs — pre-package native ABI gate (plan §4.2).
 *
 * Runs under Electron:  electron scripts/verify-native.cjs
 * Exits non-zero on any hard failure, so it can gate `npm run pack` / `dist:win`.
 *
 * Why Electron and not node: everything below must be exercised against the same
 * ABI the packaged app uses. Running these requires under the plain node runner
 * would prove nothing (and would in fact fail, since the modules are rebuilt for
 * Electron headers).
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const repoRoot = path.join(__dirname, '..');

const failures = [];
const warnings = [];

function log(...args) {
  // eslint-disable-next-line no-console
  console.log(...args);
}
function pass(name, detail) {
  log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, detail) {
  failures.push(`${name}: ${detail}`);
  log(`  FAIL  ${name} — ${detail}`);
}
function warn(name, detail) {
  warnings.push(`${name}: ${detail}`);
  log(`  WARN  ${name} — ${detail}`);
}

function finish() {
  log('');
  if (warnings.length) {
    log(`verify:native — ${warnings.length} warning(s):`);
    for (const w of warnings) log(`  ! ${w}`);
  }
  if (failures.length) {
    log(`verify:native — FAILED (${failures.length}):`);
    for (const f of failures) log(`  x ${f}`);
    app.exit(1);
    return;
  }
  log('verify:native — OK');
  app.exit(0);
}

async function main() {
  // -- 1. Runtime identity -------------------------------------------------
  log('== verify:native ==');
  log(`  electron=${process.versions.electron}  modules(ABI)=${process.versions.modules}  ` +
      `node=${process.versions.node}  arch=${process.arch}  platform=${process.platform}`);
  if (process.arch !== 'x64') {
    fail('arch', `expected x64, got ${process.arch} (Lares packages Windows x64 only)`);
  }

  // -- 2. better-sqlite3 round trip ---------------------------------------
  log('\n[2] better-sqlite3');
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('lares-sqlite-ok');
    const row = db.prepare('SELECT v FROM t WHERE id = 1').get();
    db.close();
    if (row && row.v === 'lares-sqlite-ok') {
      pass('better-sqlite3', 'in-memory create/insert/select round trip');
    } else {
      fail('better-sqlite3', `round trip returned ${JSON.stringify(row)}`);
    }
  } catch (err) {
    fail('better-sqlite3', `${err && err.message}`);
  }

  // -- 3. node-pty spawns a real console process ---------------------------
  log('\n[3] node-pty');
  await new Promise((resolve) => {
    let settled = false;
    const done = (fn) => {
      if (settled) return;
      settled = true;
      fn();
      resolve();
    };
    let pty;
    try {
      pty = require('node-pty');
    } catch (err) {
      return done(() => fail('node-pty require', `${err && err.message}`));
    }
    const SENTINEL = 'lares-native-ok';
    let out = '';
    let child;
    try {
      child = pty.spawn('cmd.exe', ['/d', '/s', '/c', `echo ${SENTINEL}`], {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: repoRoot,
        env: process.env,
      });
    } catch (err) {
      return done(() => fail('node-pty spawn', `${err && err.message}`));
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      done(() => fail('node-pty spawn', 'timed out after 15s without exiting'));
    }, 15000);

    child.onData((d) => { out += d; });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      done(() => {
        if (!out.includes(SENTINEL)) {
          fail('node-pty spawn', `sentinel "${SENTINEL}" absent from PTY output: ${JSON.stringify(out.slice(0, 300))}`);
        } else if (exitCode !== 0) {
          fail('node-pty spawn', `child exited with code ${exitCode}`);
        } else {
          pass('node-pty', `cmd.exe echoed the sentinel and exited 0`);
        }
      });
    });
  });

  // -- 4. lares-native functional surface (PASS/DEGRADED, never a hard fail) --
  log('\n[4] lares-native');
  const laresNativeIndex = path.join(repoRoot, 'native', 'lares-native', 'index.js');
  try {
    // index.js is documented to never throw at require time (it returns a no-op
    // surface when the binary is missing), so a successful require proves
    // nothing. Exercise the surface instead.
    const native = require(laresNativeIndex);
    if (!native || native.supported !== true) {
      warn('lares-native', `DEGRADED — supported=false, loadError=${native && native.loadError}`);
    } else {
      const platformOk = native.platformSupported();
      const commit = native.getCommitStatus();
      const name = native.jobName('agent-1', 42);
      const commitOk = commit && typeof commit === 'object' &&
        Object.values(commit).some((v) => typeof v === 'number' && v > 0);
      if (!platformOk) {
        warn('lares-native', 'DEGRADED — platformSupported() returned false');
      } else if (!commitOk) {
        warn('lares-native', `DEGRADED — getCommitStatus() returned ${JSON.stringify(commit)}`);
      } else if (name !== 'Local\\Lares.agent.agent-1.42') {
        warn('lares-native', `jobName() returned unexpected ${JSON.stringify(name)}`);
      } else {
        pass('lares-native', `functional — getCommitStatus() -> ${JSON.stringify(commit)}`);
      }
    }
  } catch (err) {
    warn('lares-native', `DEGRADED — ${err && err.message}`);
  }
  const laresNativeBinary = path.join(repoRoot, 'native', 'lares-native', 'build', 'Release', 'lares_native.node');
  if (!fs.existsSync(laresNativeBinary)) {
    warn('lares-native binary', `${laresNativeBinary} missing — extraResources will ship nothing (plan §4.3)`);
  }

  // -- 5. Packaged PTY-helper module resolution (F5) -----------------------
  // The helper does a bare `require('node-pty')`. That only works if the
  // directory it is launched from has a node_modules on its resolution path.
  // Inside the asar it does; from resources/scripts it does NOT.
  log('\n[5] packaged PTY-helper resolution');
  // Plan §5.1 moved the helper to src/main/pty-host.js, copied into
  // dist/main/main/ by scripts/copy-static-main.mjs. The resources/scripts
  // location is the pre-§5.1 layout and is kept here only so this gate reports
  // the F5 failure clearly if anyone moves it back.
  const inBundleHelper = path.join(repoRoot, 'dist', 'main', 'main', 'pty-host.js');
  const inResourcesHelper = path.join(repoRoot, 'scripts', 'pty-host.js');
  const helperSrc = fs.existsSync(inBundleHelper) ? inBundleHelper
    : fs.existsSync(inResourcesHelper) ? inResourcesHelper
      : null;

  if (!helperSrc) {
    fail('pty-host', `pty-host.js found at neither ${inBundleHelper} nor ${inResourcesHelper}`);
  } else {
    const helperDir = path.dirname(helperSrc);
    let resolvedDev = null;
    try {
      resolvedDev = require.resolve('node-pty', { paths: [helperDir] });
    } catch (err) {
      fail('pty-host resolution (dev tree)', `require.resolve('node-pty') from ${helperDir}: ${err && err.message}`);
    }
    if (resolvedDev) {
      pass('pty-host resolution (dev tree)', `${helperDir} -> ${path.relative(repoRoot, resolvedDev)}`);
    }

    // Packaged layout: anything under dist/ lands inside app.asar and therefore
    // sits beside app.asar/node_modules; anything under scripts/ lands in
    // resources/scripts, which has no node_modules ancestor at all.
    const shipsInsideAsar = helperSrc === inBundleHelper;
    if (shipsInsideAsar) {
      pass('pty-host resolution (packaged)', 'helper ships inside app.asar — bare require(\'node-pty\') resolves');
    } else {
      warn(
        'pty-host resolution (packaged)',
        'helper ships to resources/scripts, which has NO node_modules on its resolution path — ' +
        "packaged PTY spawn will die with \"Cannot find module 'node-pty'\" (ground truth F5). " +
        'The fix is plan §5.1 (move the helper into dist/), which is Phase 3 and not yet applied.',
      );
    }
  }

  finish();
}

app.whenReady().then(() => {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('verify:native — unexpected error:', err);
    app.exit(1);
  });
});
