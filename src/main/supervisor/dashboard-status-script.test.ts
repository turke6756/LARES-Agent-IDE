// Script-level tests for the v7 dashboard-status.mjs hook script
// (P1 plan §5 E2, plans/p1-hook-spool-multi-transport.md §1).
//
// The bundled DASHBOARD_STATUS_SCRIPT_MJS is materialized into a temp
// workspace and executed under the real `node`, against a real (ephemeral)
// mock HTTP server. The tmux transport is observed by preloading a CJS shim
// that patches child_process.spawnSync BEFORE the ESM script links against it
// (cross-platform — no fake tmux binary on PATH needed).
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/dashboard-status-script.test.js

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  DASHBOARD_STATUS_SCRIPT_MJS,
  DASHBOARD_STATUS_SCRIPT_MJS_V6,
  DASHBOARD_STATUS_SCRIPT_MJS_V3,
} from '../../shared/constants';
import { NON_BLOCKING_NOTIFICATION_TYPES } from '../../shared/notification-classify';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// ── Helpers ──────────────────────────────────────────────────────────

/** CJS preload that records every spawnSync call to TMUX_CAPTURE_FILE and
 *  never actually spawns. Runs before the ESM script links its
 *  `import { spawnSync } from 'node:child_process'` binding, so the script
 *  sees the patched function. Optionally (STDIN_ERROR_AFTER_MS) emits an
 *  'error' on process.stdin after a delay — case (h). */
const PRELOAD_CJS = `
const cp = require('child_process');
const fs = require('fs');
cp.spawnSync = (cmd, args, opts) => {
  try {
    if (process.env.TMUX_CAPTURE_FILE) {
      fs.appendFileSync(process.env.TMUX_CAPTURE_FILE, JSON.stringify({ cmd, args }) + '\\n');
    }
  } catch {}
  return { status: 0, stdout: '', stderr: '', pid: 0, output: [], signal: null };
};
if (process.env.STDIN_ERROR_AFTER_MS) {
  setTimeout(() => {
    try { process.stdin.emit('error', new Error('synthetic stdin error')); } catch {}
  }, Number(process.env.STDIN_ERROR_AFTER_MS)).unref();
}
`;

interface ScriptWorkspace {
  dir: string;
  scriptPath: string;
  preloadPath: string;
  spoolFallbackPath: string; // scriptDir/../pending-status.jsonl
  cleanup(): void;
}

function makeWorkspace(): ScriptWorkspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-v7-script-'));
  const scriptsDir = path.join(dir, '.dashboard', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const scriptPath = path.join(scriptsDir, 'dashboard-status.mjs');
  fs.writeFileSync(scriptPath, DASHBOARD_STATUS_SCRIPT_MJS, 'utf-8');
  const preloadPath = path.join(dir, 'preload.cjs');
  fs.writeFileSync(preloadPath, PRELOAD_CJS, 'utf-8');
  return {
    dir,
    scriptPath,
    preloadPath,
    spoolFallbackPath: path.join(dir, '.dashboard', 'pending-status.jsonl'),
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

interface RunResult {
  status: number | null;
  elapsedMs: number;
  stderr: string;
}

/** Run the materialized script under node. `stdinBody: null` keeps stdin OPEN
 *  for the lifetime of the child (case e); a string writes it then ends;
 *  `'closed'` (default) passes an ignored/closed stdin. */
function runScript(ws: ScriptWorkspace, opts: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  stdinBody?: string | null | 'closed';
  preload?: boolean;
  timeoutMs?: number;
}): Promise<RunResult> {
  const args: string[] = [];
  if (opts.preload) args.push('--require', ws.preloadPath);
  args.push(ws.scriptPath, ...(opts.argv ?? []));
  const stdinMode = opts.stdinBody === undefined ? 'closed' : opts.stdinBody;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: [stdinMode === 'closed' ? 'ignore' : 'pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (c) => { stderr += String(c); });
    if (typeof stdinMode === 'string' && stdinMode !== 'closed') {
      child.stdin?.write(stdinMode);
      child.stdin?.end();
    }
    // stdinBody === null → leave stdin open; the script's 300 ms race must
    // still let the process exit.
    const killer = setTimeout(() => { try { child.kill(); } catch {} }, opts.timeoutMs ?? 15_000);
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ status: code, elapsedMs: Date.now() - started, stderr });
    });
  });
}

interface MockServer {
  port: number;
  received: Array<{ url: string; body: string }>;
  close(): Promise<void>;
}

function startMockServer(): Promise<MockServer> {
  const received: Array<{ url: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      received.push({ url: req.url ?? '', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        port,
        received,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function readSpool(p: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ── Tests ────────────────────────────────────────────────────────────

test('(a) spool is written even when HTTP succeeds (always-write, env path)', async () => {
  const ws = makeWorkspace();
  const server = await startMockServer();
  const spool = path.join(ws.dir, 'custom-spool.jsonl');
  try {
    const res = await runScript(ws, {
      env: {
        AGENT_ID: 'ag-a', DASHBOARD_PORT: String(server.port), DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: spool, CLAUDE_HOOK_EVENT_NAME: 'Stop',
        TMUX: undefined, TMUX_PANE: undefined,
      },
    });
    assert.equal(res.status, 0, `exit 0; stderr=${res.stderr}`);
    assert.equal(server.received.length, 1, 'HTTP POST delivered');
    const records = readSpool(spool);
    assert.equal(records.length, 1, 'spool written even though HTTP succeeded');
    assert.equal(records[0].state, 'idle');
    assert.equal(records[0].agentId, 'ag-a');
  } finally {
    await server.close();
    ws.cleanup();
  }
});

test('(b) HTTP down → spool still written, exit 0; fallback path used when env unset', async () => {
  const ws = makeWorkspace();
  try {
    const res = await runScript(ws, {
      argv: ['working'],
      env: {
        AGENT_ID: 'ag-b', DASHBOARD_PORT: '1', DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: undefined, CLAUDE_HOOK_EVENT_NAME: 'UserPromptSubmit',
        TMUX: undefined, TMUX_PANE: undefined,
      },
    });
    assert.equal(res.status, 0, `exit 0 on HTTP failure; stderr=${res.stderr}`);
    const records = readSpool(ws.spoolFallbackPath);
    assert.equal(records.length, 1, 'spool written at the scriptDir/../ fallback path');
    assert.equal(records[0].state, 'working');
    assert.equal(records[0].source, 'hook-start');
    assert.equal(records[0].hookEventName, 'UserPromptSubmit');
  } finally {
    ws.cleanup();
  }
});

test('(b2) explicit --event overrides state-derived provenance for agy PreInvocation', async () => {
  const ws = makeWorkspace();
  const spool = path.join(ws.dir, 'agy-spool.jsonl');
  try {
    const result = await runScript(ws, {
      argv: ['working', '--event', 'PreInvocation'],
      env: {
        AGENT_ID: 'agy-event-flag', DASHBOARD_SPOOL_PATH: spool,
        CLAUDE_HOOK_EVENT_NAME: undefined, DASHBOARD_PORT: '1',
      },
    });
    assert.equal(result.status, 0);
    const records = readSpool(spool);
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'working');
    assert.equal(records[0].hookEventName, 'PreInvocation');
  } finally { ws.cleanup(); }
});

test('(c) spool unwritable + HTTP down → still exit 0', async () => {
  const ws = makeWorkspace();
  try {
    const res = await runScript(ws, {
      env: {
        AGENT_ID: 'ag-c', DASHBOARD_PORT: '1', DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: path.join(ws.dir, 'no-such-dir', 'deep', 'spool.jsonl'),
        TMUX: undefined, TMUX_PANE: undefined,
      },
    });
    assert.equal(res.status, 0, `exit 0 even with no working transport; stderr=${res.stderr}`);
  } finally {
    ws.cleanup();
  }
});

test('(d) stdin meta lands in both spool line and POST body with identical ts', async () => {
  const ws = makeWorkspace();
  const server = await startMockServer();
  const spool = path.join(ws.dir, 'spool.jsonl');
  try {
    const res = await runScript(ws, {
      env: {
        AGENT_ID: 'ag-d', DASHBOARD_PORT: String(server.port), DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: spool, CLAUDE_HOOK_EVENT_NAME: undefined,
        TMUX: undefined, TMUX_PANE: undefined,
      },
      stdinBody: JSON.stringify({
        hook_event_name: 'Stop', session_id: 'sess-42', turn_id: 'turn-7',
      }),
    });
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.equal(server.received.length, 1);
    const posted = JSON.parse(server.received[0].body);
    const spooled = readSpool(spool);
    assert.equal(spooled.length, 1);
    assert.deepStrictEqual(spooled[0], posted,
      'spool record and POST body must be the SAME record (identical ts → identical dedupe key)');
    assert.equal(posted.hookEventName, 'Stop');
    assert.equal(posted.turnId, 'turn-7');
    assert.equal(posted.sessionId, 'sess-42');
    assert.ok(typeof posted.ts === 'number' && Number.isFinite(posted.ts));
    assert.match(server.received[0].url, /^\/api\/agents\/ag-d\/status$/);
  } finally {
    await server.close();
    ws.cleanup();
  }
});

test('(e) stdin never closes → still exits 0 in ~1 s (300 ms stdin race)', async () => {
  const ws = makeWorkspace();
  try {
    const res = await runScript(ws, {
      env: {
        AGENT_ID: 'ag-e', DASHBOARD_PORT: '1', DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: path.join(ws.dir, 'spool.jsonl'),
        TMUX: undefined, TMUX_PANE: undefined,
      },
      stdinBody: null, // keep stdin open for the child's whole lifetime
      timeoutMs: 10_000,
    });
    assert.equal(res.status, 0, `exit 0 with an unclosed stdin; stderr=${res.stderr}`);
    assert.ok(res.elapsedMs < 5_000,
      `must not hang on open stdin (300 ms race); took ${res.elapsedMs} ms`);
    const records = readSpool(path.join(ws.dir, 'spool.jsonl'));
    assert.equal(records.length, 1, 'event still spooled after the stdin timeout (argv-derived meta)');
  } finally {
    ws.cleanup();
  }
});

test('(f) SubagentStop via env AND via stdin → nothing written anywhere, exit 0', async () => {
  const ws = makeWorkspace();
  const server = await startMockServer();
  const spool = path.join(ws.dir, 'spool.jsonl');
  try {
    // Via env.
    const res1 = await runScript(ws, {
      env: {
        AGENT_ID: 'ag-f', DASHBOARD_PORT: String(server.port), DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: spool, CLAUDE_HOOK_EVENT_NAME: 'SubagentStop',
        TMUX: undefined, TMUX_PANE: undefined,
      },
    });
    assert.equal(res1.status, 0);
    // Via stdin (no env).
    const res2 = await runScript(ws, {
      env: {
        AGENT_ID: 'ag-f', DASHBOARD_PORT: String(server.port), DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: spool, CLAUDE_HOOK_EVENT_NAME: undefined,
        TMUX: undefined, TMUX_PANE: undefined,
      },
      stdinBody: JSON.stringify({ hook_event_name: 'SubagentStop' }),
    });
    assert.equal(res2.status, 0);

    assert.equal(fs.existsSync(spool), false, 'SubagentStop must never spool');
    assert.equal(server.received.length, 0, 'SubagentStop must never POST');
  } finally {
    await server.close();
    ws.cleanup();
  }
});

test('(g) TMUX + TMUX_PANE set → tmux receives set-option -p -t <pane> @agentdashboard-status <line>', async () => {
  const ws = makeWorkspace();
  const spool = path.join(ws.dir, 'spool.jsonl');
  const capture = path.join(ws.dir, 'tmux-capture.jsonl');
  try {
    const res = await runScript(ws, {
      preload: true,
      env: {
        AGENT_ID: 'ag-g', DASHBOARD_PORT: '1', DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: spool, CLAUDE_HOOK_EVENT_NAME: 'Stop',
        TMUX: '/tmp/tmux-1000/default,12,0', TMUX_PANE: '%5',
        TMUX_CAPTURE_FILE: capture,
      },
    });
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    const calls = readSpool(capture) as Array<{ cmd: string; args: string[] }>;
    assert.equal(calls.length, 1, `expected exactly one tmux invocation; got ${JSON.stringify(calls)}`);
    assert.equal(calls[0].cmd, 'tmux');
    const args = calls[0].args;
    assert.deepStrictEqual(args.slice(0, 5), ['set-option', '-p', '-t', '%5', '@agentdashboard-status']);
    const optionValue = args[5];
    const spooled = readSpool(spool);
    assert.equal(spooled.length, 1);
    assert.deepStrictEqual(JSON.parse(optionValue), spooled[0],
      'the tmux option must carry the SAME JSON record as the spool line');
  } finally {
    ws.cleanup();
  }
});

test('(g2) not under tmux → no tmux invocation at all', async () => {
  const ws = makeWorkspace();
  const capture = path.join(ws.dir, 'tmux-capture.jsonl');
  try {
    const res = await runScript(ws, {
      preload: true,
      env: {
        AGENT_ID: 'ag-g2', DASHBOARD_PORT: '1', DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: path.join(ws.dir, 'spool.jsonl'),
        TMUX: undefined, TMUX_PANE: undefined,
        TMUX_CAPTURE_FILE: capture,
      },
    });
    assert.equal(res.status, 0);
    assert.equal(fs.existsSync(capture), false, 'no TMUX env → transport 3 skipped silently');
  } finally {
    ws.cleanup();
  }
});

test('(h) stdin emits error after the timeout fired → script still exits 0', async () => {
  const ws = makeWorkspace();
  try {
    const res = await runScript(ws, {
      preload: true,
      env: {
        AGENT_ID: 'ag-h', DASHBOARD_PORT: '1', DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: path.join(ws.dir, 'spool.jsonl'),
        STDIN_ERROR_AFTER_MS: '500', // after the 300 ms stdin race resolved
        TMUX: undefined, TMUX_PANE: undefined,
      },
      stdinBody: null, // keep stdin open so the timeout path runs the cleanup
      timeoutMs: 10_000,
    });
    assert.equal(res.status, 0,
      `an async stdin 'error' must never break the exit-0 contract; stderr=${res.stderr}`);
  } finally {
    ws.cleanup();
  }
});

test('(w1) waiting argv + Notification stdin → state=waiting, source=hook-notification, excerpt + notificationType', async () => {
  const ws = makeWorkspace();
  const server = await startMockServer();
  const spool = path.join(ws.dir, 'spool.jsonl');
  try {
    const res = await runScript(ws, {
      argv: ['waiting'],
      env: {
        AGENT_ID: 'ag-w1', DASHBOARD_PORT: String(server.port), DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: spool, CLAUDE_HOOK_EVENT_NAME: undefined,
        TMUX: undefined, TMUX_PANE: undefined,
      },
      stdinBody: JSON.stringify({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Bash tool requires permission',
      }),
    });
    assert.equal(res.status, 0, `exit 0; stderr=${res.stderr}`);
    assert.equal(server.received.length, 1, 'HTTP POST delivered');
    const posted = JSON.parse(server.received[0].body);
    const spooled = readSpool(spool);
    assert.equal(spooled.length, 1);
    assert.deepStrictEqual(spooled[0], posted, 'spool record === POST body (same ts)');
    assert.equal(posted.state, 'waiting');
    assert.equal(posted.source, 'hook-notification');
    assert.equal(posted.hookEventName, 'Notification');
    assert.equal(posted.excerpt, 'Bash tool requires permission');
    assert.equal(posted.notificationType, 'permission_prompt');
    assert.match(server.received[0].url, /^\/api\/agents\/ag-w1\/status$/);
  } finally {
    await server.close();
    ws.cleanup();
  }
});

test('(w2) blocking permission prompt: multiline message → CR/LF collapsed to spaces and capped at 300 chars', async () => {
  const ws = makeWorkspace();
  const spool = path.join(ws.dir, 'spool.jsonl');
  try {
    // Build a message with embedded CR/LF AND a length well over the 300-char cap.
    const longTail = 'x'.repeat(500);
    const message = `line one\r\nline two\n\n\rline three ${longTail}`;
    const res = await runScript(ws, {
      argv: ['waiting'],
      env: {
        AGENT_ID: 'ag-w2', DASHBOARD_PORT: '1', DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: spool, CLAUDE_HOOK_EVENT_NAME: undefined,
        TMUX: undefined, TMUX_PANE: undefined,
      },
      stdinBody: JSON.stringify({
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message,
      }),
    });
    assert.equal(res.status, 0, `exit 0; stderr=${res.stderr}`);
    const records = readSpool(spool);
    assert.equal(records.length, 1);
    const excerpt = records[0].excerpt as string;
    assert.equal(typeof excerpt, 'string');
    // No raw CR or LF survive — they are collapsed to spaces.
    assert.ok(!/[\r\n]/.test(excerpt), `excerpt must contain no CR/LF; got ${JSON.stringify(excerpt)}`);
    // Capped at 300 chars.
    assert.equal(excerpt.length, 300, `excerpt capped at 300; got ${excerpt.length}`);
    // The collapsed prefix is preserved (runs of CR/LF → a single space).
    assert.ok(excerpt.startsWith('line one line two line three '),
      `collapsed prefix preserved; got ${JSON.stringify(excerpt.slice(0, 40))}`);
    assert.equal(records[0].state, 'waiting');
    assert.equal(records[0].notificationType, 'permission_prompt');
  } finally {
    ws.cleanup();
  }
});

test('(w3) SubagentStop bails BEFORE any waiting record, even with argv "waiting"', async () => {
  const ws = makeWorkspace();
  const server = await startMockServer();
  const spool = path.join(ws.dir, 'spool.jsonl');
  try {
    const res = await runScript(ws, {
      argv: ['waiting'],
      env: {
        AGENT_ID: 'ag-w3', DASHBOARD_PORT: String(server.port), DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: spool, CLAUDE_HOOK_EVENT_NAME: undefined,
        TMUX: undefined, TMUX_PANE: undefined,
      },
      stdinBody: JSON.stringify({
        hook_event_name: 'SubagentStop',
        notification_type: 'permission_prompt',
        message: 'should never be recorded',
      }),
    });
    assert.equal(res.status, 0, `exit 0; stderr=${res.stderr}`);
    assert.equal(fs.existsSync(spool), false, 'SubagentStop must never spool a waiting record');
    assert.equal(server.received.length, 0, 'SubagentStop must never POST a waiting record');
  } finally {
    await server.close();
    ws.cleanup();
  }
});

test('(w6) idle_prompt Notification (argv "waiting") → nothing written, agent stays idle', async () => {
  const ws = makeWorkspace();
  const server = await startMockServer();
  const spool = path.join(ws.dir, 'spool.jsonl');
  try {
    const res = await runScript(ws, {
      argv: ['waiting'],
      env: {
        AGENT_ID: 'ag-w6', DASHBOARD_PORT: String(server.port), DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: spool, CLAUDE_HOOK_EVENT_NAME: undefined,
        TMUX: undefined, TMUX_PANE: undefined,
      },
      stdinBody: JSON.stringify({
        hook_event_name: 'Notification',
        notification_type: 'idle_prompt',
        message: 'Claude is waiting for your input',
      }),
    });
    assert.equal(res.status, 0, `exit 0; stderr=${res.stderr}`);
    assert.equal(fs.existsSync(spool), false, 'idle_prompt must never spool a waiting record');
    assert.equal(server.received.length, 0, 'idle_prompt must never POST a waiting record');
  } finally {
    await server.close();
    ws.cleanup();
  }
});

test('(w7) no notification_type + message "waiting for your input" → nothing written (regex fallback)', async () => {
  const ws = makeWorkspace();
  const server = await startMockServer();
  const spool = path.join(ws.dir, 'spool.jsonl');
  try {
    const res = await runScript(ws, {
      argv: ['waiting'],
      env: {
        AGENT_ID: 'ag-w7', DASHBOARD_PORT: String(server.port), DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: spool, CLAUDE_HOOK_EVENT_NAME: undefined,
        TMUX: undefined, TMUX_PANE: undefined,
      },
      stdinBody: JSON.stringify({
        hook_event_name: 'Notification',
        // no notification_type (legacy CLI) → message-regex fallback applies.
        message: 'Claude is waiting for your input',
      }),
    });
    assert.equal(res.status, 0, `exit 0; stderr=${res.stderr}`);
    assert.equal(fs.existsSync(spool), false, 'legacy idle reminder must never spool');
    assert.equal(server.received.length, 0, 'legacy idle reminder must never POST');
  } finally {
    await server.close();
    ws.cleanup();
  }
});

test('(w8) no notification_type + unrelated message → record STILL written (fallback must not over-suppress)', async () => {
  const ws = makeWorkspace();
  const server = await startMockServer();
  const spool = path.join(ws.dir, 'spool.jsonl');
  try {
    const res = await runScript(ws, {
      argv: ['waiting'],
      env: {
        AGENT_ID: 'ag-w8', DASHBOARD_PORT: String(server.port), DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: spool, CLAUDE_HOOK_EVENT_NAME: undefined,
        TMUX: undefined, TMUX_PANE: undefined,
      },
      stdinBody: JSON.stringify({
        hook_event_name: 'Notification',
        // no notification_type, and the message is NOT the idle reminder →
        // conservative default: still a waiting record.
        message: 'Bash tool requires permission',
      }),
    });
    assert.equal(res.status, 0, `exit 0; stderr=${res.stderr}`);
    assert.equal(server.received.length, 1, 'unknown blocking notification still POSTs');
    const records = readSpool(spool);
    assert.equal(records.length, 1, 'unknown blocking notification still spools');
    assert.equal(records[0].state, 'waiting');
    assert.equal(records[0].excerpt, 'Bash tool requires permission');
  } finally {
    await server.close();
    ws.cleanup();
  }
});

test('(w9) drift: every NON_BLOCKING_NOTIFICATION_TYPES literal + the fallback regex appear in the script source', () => {
  for (const t of NON_BLOCKING_NOTIFICATION_TYPES) {
    assert.ok(DASHBOARD_STATUS_SCRIPT_MJS.includes(`'${t}'`),
      `script source must inline the non-blocking type literal '${t}' (drift between ` +
      `notification-classify.ts and buildDashboardStatusScript)`);
  }
  assert.ok(/waiting for your input/.test(DASHBOARD_STATUS_SCRIPT_MJS),
    'script source must contain the message-regex fallback text "waiting for your input"');
});

test('(w4) unknown/absent argv still defaults to idle (no waiting leakage)', async () => {
  const ws = makeWorkspace();
  const spool = path.join(ws.dir, 'spool.jsonl');
  try {
    // Unknown argv token.
    const res = await runScript(ws, {
      argv: ['bananas'],
      env: {
        AGENT_ID: 'ag-w4', DASHBOARD_PORT: '1', DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: spool, CLAUDE_HOOK_EVENT_NAME: undefined,
        TMUX: undefined, TMUX_PANE: undefined,
      },
    });
    assert.equal(res.status, 0, `exit 0; stderr=${res.stderr}`);
    const records = readSpool(spool);
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'idle', 'unknown argv defaults to idle');
    assert.equal(records[0].source, 'hook-stop');
    assert.equal(records[0].hookEventName, 'Stop');
    assert.equal(records[0].excerpt, undefined, 'no excerpt for a non-waiting record');
    assert.equal(records[0].notificationType, undefined, 'no notificationType for a non-waiting record');

    // Absent argv (default Stop) also lands idle.
    const spool2 = path.join(ws.dir, 'spool2.jsonl');
    const res2 = await runScript(ws, {
      env: {
        AGENT_ID: 'ag-w4b', DASHBOARD_PORT: '1', DASHBOARD_HOST: '127.0.0.1',
        DASHBOARD_SPOOL_PATH: spool2, CLAUDE_HOOK_EVENT_NAME: undefined,
        TMUX: undefined, TMUX_PANE: undefined,
      },
    });
    assert.equal(res2.status, 0, `exit 0; stderr=${res2.stderr}`);
    const records2 = readSpool(spool2);
    assert.equal(records2.length, 1);
    assert.equal(records2[0].state, 'idle', 'absent argv defaults to idle');
    assert.equal(records2[0].source, 'hook-stop');
  } finally {
    ws.cleanup();
  }
});

test('(w5) frozen V6 builder output AND the V3 literal carry NO waiting branch', () => {
  for (const [label, src] of [
    ['V6', DASHBOARD_STATUS_SCRIPT_MJS_V6],
    ['V3', DASHBOARD_STATUS_SCRIPT_MJS_V3],
  ] as Array<[string, string]>) {
    assert.equal(typeof src, 'string', `${label} is a string`);
    assert.ok(src.length > 0, `${label} is non-empty`);
    assert.ok(!/hook-notification/.test(src),
      `frozen ${label} must NOT contain the waiting source 'hook-notification'`);
    assert.ok(!/rawState === 'waiting'/.test(src),
      `frozen ${label} must NOT contain the rawState waiting branch`);
    assert.ok(!/notification_type/.test(src),
      `frozen ${label} must NOT reference notification_type`);
  }
  // Sanity: the LIVE script DOES carry the waiting branch (guards against a
  // copy-paste regression that froze the wrong source).
  assert.ok(/hook-notification/.test(DASHBOARD_STATUS_SCRIPT_MJS),
    'live script must contain the waiting branch');
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
