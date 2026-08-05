// Unit tests for the Windows provider-CLI resolver (packaging plan §6.1).
//
// These deliberately use the REAL filesystem and the REAL resolver rather than
// mocks. The whole point of this module is "does it find the binary where
// Windows actually puts it", so a test that stubs the lookup would assert
// nothing. Each case builds a throwaway home directory, points the resolver's
// env at it, and asks the same question a launch asks.
//
// Compile + run:
//   npm run build:main
//   node dist/main/main/supervisor/provider-resolver.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findWindowsProviderBinary,
  findWindowsClaudePath,
  probeWindowsProvider,
  missingProviderMessage,
  getWindowsSystemPath,
} from './provider-resolver';

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

/** A scratch %USERPROFILE% with the env vars the resolver reads pointed at it.
 *  Restores the previous env on dispose so cases can't leak into each other. */
function withFakeHome(
  homeName: string,
  build: (home: string) => void,
): { home: string; restore: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-prereq-'));
  const home = path.join(root, homeName);
  fs.mkdirSync(home, { recursive: true });
  build(home);

  const saved = {
    USERPROFILE: process.env.USERPROFILE,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PATH: process.env.PATH,
  };
  process.env.USERPROFILE = home;
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  // Empty PATH so the `where.exe` fallback finds nothing and the test measures
  // the candidate-directory search alone. (cmd.exe is still located through
  // %SystemRoot%, which is exactly why getWindowsSystemPath exists.)
  process.env.PATH = '';

  return {
    home,
    restore: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

function writeShim(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '@echo off\r\necho fake\r\n');
}

// ── The npm-shim case (plan V13) ───────────────────────────────────────────
// This is the failure that motivated commit 7e99959: `npm i -g @openai/codex`
// drops a `codex.cmd` in %APPDATA%\npm, which is on the user's SHELL PATH but
// often not on the login PATH that Electron inherits. The resolver must find it
// by looking in the directory directly, not by asking PATH.
test('finds an npm-global .cmd shim without consulting PATH', async () => {
  const fake = withFakeHome('user', (home) => {
    writeShim(path.join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'));
  });
  try {
    const found = await findWindowsProviderBinary('codex');
    assert.ok(found, 'expected the npm-global codex.cmd to be found');
    assert.ok(found.endsWith('codex.cmd'), `unexpected resolution: ${found}`);
    assert.ok(fs.existsSync(found), 'resolver returned a path that does not exist');
  } finally {
    fake.restore();
  }
});

// ── Paths containing spaces ────────────────────────────────────────────────
// "C:\Users\Firstname Lastname\..." is completely ordinary on Windows and is
// where naive quoting breaks. The resolver must return the path intact.
test('resolves codex through a home directory containing spaces', async () => {
  const fake = withFakeHome('Firstname Lastname', (home) => {
    writeShim(path.join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'));
  });
  try {
    const found = await findWindowsProviderBinary('codex');
    assert.ok(found, 'expected codex.cmd under a spaced home to be found');
    assert.ok(found.includes('Firstname Lastname'), `space lost in path: ${found}`);
    assert.ok(fs.existsSync(found), 'resolver returned a path that does not exist');
  } finally {
    fake.restore();
  }
});

// ── The native-installer location for claude ───────────────────────────────
// The Windows PowerShell installer we recommend in PROVIDER_INSTALL_HINTS puts
// claude.exe at %USERPROFILE%\.local\bin. If this ever stops matching, the
// install command we hand users produces a claude that Lares cannot find — so
// this test is really guarding the advice, not just the code.
test('finds claude at the documented native-installer path', async () => {
  const fake = withFakeHome('user', (home) => {
    writeShim(path.join(home, '.local', 'bin', 'claude.exe'));
  });
  try {
    const found = await findWindowsClaudePath(process.env as NodeJS.ProcessEnv);
    assert.ok(found.endsWith('claude.exe'), `unexpected resolution: ${found}`);
    assert.ok(fs.existsSync(found));
  } finally {
    fake.restore();
  }
});

// ── The missing case ───────────────────────────────────────────────────────
test('returns null for a provider that is genuinely absent', async () => {
  const fake = withFakeHome('user', () => { /* nothing installed */ });
  try {
    assert.equal(await findWindowsProviderBinary('codex'), null);
  } finally {
    fake.restore();
  }
});

// ── Grok: the documented installer location wins FIRST ─────────────────────
// The xAI PowerShell installer (irm https://x.ai/cli/install.ps1 | iex) puts
// grok.exe at %USERPROFILE%\.grok\bin\grok.exe. provider-resolver unshifts it as
// the FIRST candidate — so even with a competing npm-global grok.cmd present, the
// installer binary must win. If this stops matching, PROVIDER_INSTALL_HINTS' grok
// command produces a grok Lares would skip past to a shim, so this guards advice.
test('grok resolves .grok\\bin\\grok.exe before an npm shim', async () => {
  const fake = withFakeHome('user', (home) => {
    // Both present: the installer path AND an npm-global shim.
    writeShim(path.join(home, '.grok', 'bin', 'grok.exe'));
    writeShim(path.join(home, 'AppData', 'Roaming', 'npm', 'grok.cmd'));
  });
  try {
    const found = await findWindowsProviderBinary('grok');
    assert.ok(found, 'expected grok to be found');
    assert.ok(
      found.endsWith(path.join('.grok', 'bin', 'grok.exe')),
      `expected the .grok\\bin\\grok.exe installer path to win, got: ${found}`,
    );
    assert.ok(fs.existsSync(found));
  } finally {
    fake.restore();
  }
});

// ── Grok: candidate-directory fallback (npm-global shim) ───────────────────
// With no installer binary, grok must still resolve from the npm-global dir the
// same way codex does — the fallback path a `where.exe`-on-PATH install
// also rides.
test('grok falls back to an npm-global shim when the installer path is absent', async () => {
  const fake = withFakeHome('user', (home) => {
    writeShim(path.join(home, 'AppData', 'Roaming', 'npm', 'grok.cmd'));
  });
  try {
    const found = await findWindowsProviderBinary('grok');
    assert.ok(found, 'expected the npm-global grok.cmd to be found');
    assert.ok(found.endsWith('grok.cmd'), `unexpected resolution: ${found}`);
    assert.ok(fs.existsSync(found));
  } finally {
    fake.restore();
  }
});

// ── Grok: genuinely absent → null (drives the Grok-specific message) ───────
test('grok resolves to null when nothing is installed', async () => {
  const fake = withFakeHome('user', () => { /* nothing installed */ });
  try {
    assert.equal(await findWindowsProviderBinary('grok'), null);
    assert.equal(await probeWindowsProvider('grok'), null);
  } finally {
    fake.restore();
  }
});

test('agy resolves %LOCALAPPDATA%\\agy\\bin\\agy.exe before an npm shim', async () => {
  const fake = withFakeHome('user', (home) => {
    writeShim(path.join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe'));
    writeShim(path.join(home, 'AppData', 'Roaming', 'npm', 'agy.cmd'));
  });
  try {
    const found = await findWindowsProviderBinary('agy');
    assert.ok(found);
    assert.ok(found.endsWith(path.join('agy', 'bin', 'agy.exe')), `unexpected resolution: ${found}`);
  } finally {
    fake.restore();
  }
});

test('agy falls back to an npm-global shim when the installer path is absent', async () => {
  const fake = withFakeHome('user', (home) => {
    writeShim(path.join(home, 'AppData', 'Roaming', 'npm', 'agy.cmd'));
  });
  try {
    const found = await findWindowsProviderBinary('agy');
    assert.ok(found?.endsWith('agy.cmd'), `unexpected resolution: ${found}`);
  } finally {
    fake.restore();
  }
});

// probeWindowsProvider is what preflight calls. Its contract is "never throws";
// findWindowsClaudePath REJECTS when claude is absent, so the wrapper has to
// absorb that. A regression here would crash the whole health check.
test('probeWindowsProvider absorbs the claude rejection instead of throwing', async () => {
  const fake = withFakeHome('user', () => { /* nothing installed */ });
  try {
    assert.equal(await probeWindowsProvider('claude'), null);
  } finally {
    fake.restore();
  }
});

// ── Preflight and launch must agree ────────────────────────────────────────
// This is the invariant the whole module exists for: whatever preflight
// reports, launch must be able to use, because they are the same call.
test('preflight resolves to exactly what the launcher would use', async () => {
  const fake = withFakeHome('user', (home) => {
    writeShim(path.join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'));
    writeShim(path.join(home, '.local', 'bin', 'claude.exe'));
  });
  try {
    assert.equal(await probeWindowsProvider('codex'), await findWindowsProviderBinary('codex'));
    assert.equal(
      await probeWindowsProvider('claude'),
      await findWindowsClaudePath(process.env as NodeJS.ProcessEnv),
    );
  } finally {
    fake.restore();
  }
});

// ── The user-facing copy (plan §6.4) ───────────────────────────────────────
test('missing-provider copy says Lares is fine and names the restart step', () => {
  for (const p of ['claude', 'codex', 'grok', 'agy'] as const) {
    const msg = missingProviderMessage(p);
    assert.match(msg, /was not found/, `${p}: must state what is missing`);
    assert.match(msg, /Lares is installed correctly/, `${p}: must not read as "Lares is broken"`);
    assert.match(msg, /separate command-line tool/, `${p}: must explain it is a separate program`);
    assert.match(msg, /quit and restart/i, `${p}: must name the PATH restart requirement`);
    assert.match(msg, /Check prerequisites/, `${p}: must point at the full report`);
    // No stack traces, no exit codes, no executable names in error-ese.
    assert.doesNotMatch(msg, /ENOENT|exit code|is not recognized/i, `${p}: leaked diagnostic text`);
  }
  assert.match(missingProviderMessage('codex'), /^Codex CLI was not found\./);
  // Grok brands as "Grok Build" — the label must reach the copy.
  assert.match(missingProviderMessage('grok'), /^Grok Build CLI was not found\./);
  assert.match(missingProviderMessage('agy'), /^Antigravity CLI was not found\./);
});

test('getWindowsSystemPath does not depend on PATH', () => {
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = 'C:\\Windows';
  try {
    assert.equal(getWindowsSystemPath('cmd.exe'), 'C:\\Windows\\System32\\cmd.exe');
  } finally {
    if (saved === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = saved;
  }
});

async function main(): Promise<void> {
  let failures = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failures++;
      console.error(`  FAIL  ${t.name}`);
      console.error(err instanceof Error ? err.stack : err);
    }
  }
  console.log(`\nprovider-resolver: ${tests.length - failures}/${tests.length} passed`);
  if (failures) process.exit(1);
}

void main();
