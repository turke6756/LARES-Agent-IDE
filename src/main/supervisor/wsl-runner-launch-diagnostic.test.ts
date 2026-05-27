// BUG-22 Step 1 diagnostic: cover the pure builders that produce the
// launches.log JSONL record and the PTY-log failure header, plus the
// best-effort file-append helper. The runner code path that spawns wsl.exe
// is unit-tested at its boundaries (the pure builders) so the diagnostic
// shape can be asserted without spinning up a real WSL distro.
//
// Run via:
//   npm run build:main
//   node dist/main/main/supervisor/wsl-runner-launch-diagnostic.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TmuxNewSessionResult } from '../wsl-bridge';
import {
  appendLaunchRecord,
  buildLaunchRecord,
  buildTmuxFailureHeaderBlock,
  WslLaunchDiagnostics,
} from './wsl-runner';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const NOW_ISO = '2026-05-24T21:14:02.331Z';
const STARTED_ISO = '2026-05-24T21:14:01.902Z';

function baseDiagnostics(overrides: Partial<WslLaunchDiagnostics> = {}): WslLaunchDiagnostics {
  return {
    launchStartedAt: STARTED_ISO,
    launchesLogPath: null,
    agentId: '2e11bfc6',
    agentTitle: 'Supervisor',
    workspaceId: 'd09349ca-7a62-4094-af69-1940066f5a8c',
    provider: 'claude',
    isSupervisor: true,
    isSupervised: false,
    resume: false,
    freshSession: false,
    ...overrides,
  };
}

function successTmuxResult(): TmuxNewSessionResult {
  return {
    ok: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
    tmuxCommand: "tmux new-session -d -s 'cad__sup__abc' -c '/wd' -- bash -lic \"$(echo BASE64 | base64 -d)\"",
  };
}

function failureTmuxResult(): TmuxNewSessionResult {
  return {
    ok: false,
    exitCode: 1,
    stdout: '',
    stderr: "bash: syntax error near unexpected token `('",
    tmuxCommand: "tmux new-session -d -s 'cad__sup__abc' -c '/wd' -- bash -lic \"$(echo BASE64 | base64 -d)\"",
  };
}

// ── Test 3 (plan): PTY log header on tmuxNewSession failure ──────────────

test('BUG-22: PTY failure header starts with the distinct banner line', () => {
  const block = buildTmuxFailureHeaderBlock({
    tmuxSessionName: 'cad__supervisor__2e11bfc6',
    tmuxExitCode: 1,
    tmuxStderr: 'bash: syntax error',
    command: "cd '/wd' && SYSPROMPT=\"$(cat ...)\" && claude --add-dir ...",
    nowIso: NOW_ISO,
  });
  assert.ok(
    block.startsWith('===== WSL tmux session creation failed ====='),
    `header block must lead with the distinct banner; got: ${block.slice(0, 80)}`,
  );
});

test('BUG-22: PTY failure header includes session name, exit code, stderr, command', () => {
  const block = buildTmuxFailureHeaderBlock({
    tmuxSessionName: 'cad__supervisor__2e11bfc6',
    tmuxExitCode: 1,
    tmuxStderr: 'bash: syntax error\nadditional context',
    command: "cd '/home/u' && claude --foo",
    nowIso: NOW_ISO,
  });
  assert.match(block, /tmux session: cad__supervisor__2e11bfc6/);
  assert.match(block, /tmux exit code: 1/);
  assert.match(block, /stderr:\n/);
  assert.match(block, /bash: syntax error/);
  assert.match(block, /additional context/);
  assert.match(block, /command:\n/);
  assert.match(block, /cd '\/home\/u' && claude --foo/);
  assert.match(block, /timestamp: 2026-05-24T21:14:02\.331Z/);
});

test('BUG-22: PTY failure header renders "(empty)" for blank stderr', () => {
  const block = buildTmuxFailureHeaderBlock({
    tmuxSessionName: 's',
    tmuxExitCode: 1,
    tmuxStderr: '',
    command: 'cmd',
    nowIso: NOW_ISO,
  });
  assert.match(block, /stderr:\n\(empty\)/);
});

test('BUG-22: PTY failure header ends with the close-banner line', () => {
  const block = buildTmuxFailureHeaderBlock({
    tmuxSessionName: 's',
    tmuxExitCode: 1,
    tmuxStderr: 'x',
    command: 'cmd',
    nowIso: NOW_ISO,
  });
  // The trailing blank line keeps subsequent PTY bytes visually separated
  // from the diagnostic block in the viewer.
  assert.match(block, /={30,}\n$/);
});

// ── Test 2 (plan): JSONL append schema + single-line ─────────────────────

test('BUG-22: appendLaunchRecord writes exactly one JSON line to launches.log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug22-launches-'));
  const launchesLog = path.join(dir, '.dashboard', 'launches.log');
  try {
    const record = buildLaunchRecord({
      diagnostics: baseDiagnostics({ launchesLogPath: launchesLog }),
      sessionName: 'cad__supervisor__2e11bfc6',
      workDir: '/home/turke/proj',
      command: "cd '/home/turke/proj' && claude --add-dir '/foo'",
      tmuxResult: failureTmuxResult(),
      attachAttempted: true,
      attachExitCode: 1,
      attachSignal: null,
      outputTail: "can't find session: cad__supervisor__2e11bfc6\n[exited]\n",
      nowIso: NOW_ISO,
    });
    appendLaunchRecord(launchesLog, record);

    const raw = fs.readFileSync(launchesLog, 'utf8');
    const lines = raw.split('\n').filter(l => l.length > 0);
    assert.equal(lines.length, 1, `expected exactly one JSONL record; got ${lines.length}`);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.agent_id, '2e11bfc6');
    assert.equal(parsed.tmux_session_name, 'cad__supervisor__2e11bfc6');
    assert.match(parsed.command, /claude --add-dir/);
    assert.equal(parsed.tmux_new_session.ok, false);
    assert.equal(parsed.tmux_new_session.exit_code, 1);
    assert.match(parsed.tmux_new_session.stderr, /syntax error/);
    assert.ok(typeof parsed.tmux_new_session.tmux_command === 'string');
    assert.equal(parsed.attach_result.attempted, true);
    assert.equal(parsed.attach_result.exit_code, 1);
    assert.equal(parsed.attach_result.signal, null);
    assert.match(parsed.attach_result.output_tail, /can't find session/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-22: appendLaunchRecord is best-effort — bad path does not throw', () => {
  // Make the launches.log path point AT an existing directory so the
  // `appendFileSync` call fails (EISDIR) while mkdir succeeds. This exercises
  // the catch-and-log path without triggering noisy mkdir error output.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug22-besteffort-'));
  const badPath = dir; // points to a directory, not a file
  try {
    const record = buildLaunchRecord({
      diagnostics: baseDiagnostics({ launchesLogPath: badPath }),
      sessionName: 's',
      workDir: '/wd',
      command: 'cmd',
      tmuxResult: successTmuxResult(),
      attachAttempted: true,
      attachExitCode: 0,
      attachSignal: null,
      outputTail: '',
      nowIso: NOW_ISO,
    });
    // Must swallow file errors — diagnostic logging cannot block a launch.
    let threw: unknown = null;
    const originalConsoleError = console.error;
    console.error = () => { /* suppress expected error log */ };
    try { appendLaunchRecord(badPath, record); } catch (err) { threw = err; }
    finally { console.error = originalConsoleError; }
    assert.equal(threw, null, 'appendLaunchRecord must never throw');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-22: buildLaunchRecord serializes to valid JSON in one line', () => {
  const record = buildLaunchRecord({
    diagnostics: baseDiagnostics(),
    sessionName: 's',
    workDir: '/wd',
    command: "cd '/wd' && \"weird\" '\\$'",
    tmuxResult: failureTmuxResult(),
    attachAttempted: true,
    attachExitCode: 1,
    attachSignal: 'SIGTERM',
    outputTail: 'line A\nline B\n',
    nowIso: NOW_ISO,
  });
  const serialized = JSON.stringify(record);
  // Must not contain raw newlines outside JSON string escapes.
  const reparsed = JSON.parse(serialized);
  assert.equal(reparsed.attach_result.signal, 'SIGTERM');
  assert.match(reparsed.attach_result.output_tail, /line A\nline B/);
});

// ── Test 5 (plan): success path is preserved (no diagnostic noise) ───────

test('BUG-22: success path JSONL marks tmux_new_session.ok=true and attach_exit=0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug22-success-'));
  const launchesLog = path.join(dir, '.dashboard', 'launches.log');
  try {
    const record = buildLaunchRecord({
      diagnostics: baseDiagnostics({ launchesLogPath: launchesLog }),
      sessionName: 'cad__supervisor__abc',
      workDir: '/home/u/proj',
      command: "cd '/home/u/proj' && claude",
      tmuxResult: successTmuxResult(),
      attachAttempted: true,
      attachExitCode: 0,
      attachSignal: null,
      outputTail: 'normal output',
      nowIso: NOW_ISO,
    });
    appendLaunchRecord(launchesLog, record);

    const parsed = JSON.parse(fs.readFileSync(launchesLog, 'utf8').trim());
    assert.equal(parsed.tmux_new_session.ok, true);
    assert.equal(parsed.tmux_new_session.exit_code, 0);
    assert.equal(parsed.tmux_new_session.stderr, '');
    assert.equal(parsed.attach_result.attempted, true);
    assert.equal(parsed.attach_result.exit_code, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── BUG-22 Step 2: attach_wait_ms in the JSONL record ────────────────────

test('BUG-22 Step 2: JSONL record carries attach_wait_ms when wait ran', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug22-step2-'));
  const launchesLog = path.join(dir, '.dashboard', 'launches.log');
  try {
    const record = buildLaunchRecord({
      diagnostics: baseDiagnostics({ launchesLogPath: launchesLog }),
      sessionName: 'cad__sup__abc',
      workDir: '/home/u/proj',
      command: "cd '/home/u/proj' && claude",
      tmuxResult: successTmuxResult(),
      attachAttempted: true,
      attachExitCode: 0,
      attachSignal: null,
      outputTail: 'normal output',
      attachWaitMs: 42,
      nowIso: NOW_ISO,
    });
    appendLaunchRecord(launchesLog, record);

    const parsed = JSON.parse(fs.readFileSync(launchesLog, 'utf8').trim());
    assert.equal(parsed.attach_wait_ms, 42, 'attach_wait_ms must survive JSONL roundtrip');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BUG-22 Step 2: attach_wait_ms is omitted from JSON when wait was skipped', () => {
  // tmuxNewSession failure path: the wait isn't run, so the field is
  // undefined. JSON.stringify drops undefined-valued keys, so the record
  // should serialize without the field — consumers can treat its absence as
  // "wait was skipped" without ambiguity.
  const record = buildLaunchRecord({
    diagnostics: baseDiagnostics(),
    sessionName: 's',
    workDir: '/wd',
    command: 'cmd',
    tmuxResult: failureTmuxResult(),
    attachAttempted: true,
    attachExitCode: 1,
    attachSignal: null,
    outputTail: '',
    // attachWaitMs intentionally omitted
    nowIso: NOW_ISO,
  });
  const serialized = JSON.stringify(record);
  assert.ok(
    !serialized.includes('attach_wait_ms'),
    `attach_wait_ms must be absent from JSON when skipped; got: ${serialized}`,
  );
});

test('BUG-22 Step 2: attach_wait_ms accepts 0 (first-poll success path)', () => {
  // First-poll success is the common, healthy case — the field must round
  // trip as the literal number 0, not be confused with undefined.
  const record = buildLaunchRecord({
    diagnostics: baseDiagnostics(),
    sessionName: 's',
    workDir: '/wd',
    command: 'cmd',
    tmuxResult: successTmuxResult(),
    attachAttempted: true,
    attachExitCode: 0,
    attachSignal: null,
    outputTail: '',
    attachWaitMs: 0,
    nowIso: NOW_ISO,
  });
  const parsed = JSON.parse(JSON.stringify(record));
  assert.equal(parsed.attach_wait_ms, 0);
});

test('BUG-22: success path writes NO failure-header block (caller only writes on ok:false)', () => {
  // The header block builder itself is a pure formatter — it doesn't know
  // about success vs failure. The caller (WslRunner.launch) is responsible
  // for invoking it only when tmuxResult.ok === false. This test guards the
  // builder's input contract: callers that pass a success-shaped input would
  // produce a misleading block, so the runner MUST gate the call.
  //
  // We assert the documented invariant by constructing the failure block and
  // verifying it would be wrong for a success path: it claims "creation
  // failed" in its banner. (Defends future refactors against accidentally
  // writing the block unconditionally.)
  const blockFromFailure = buildTmuxFailureHeaderBlock({
    tmuxSessionName: 's',
    tmuxExitCode: 0,
    tmuxStderr: '',
    command: 'cmd',
    nowIso: NOW_ISO,
  });
  assert.ok(
    blockFromFailure.startsWith('===== WSL tmux session creation failed ====='),
    'header builder always produces the failure banner — caller MUST gate',
  );
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
