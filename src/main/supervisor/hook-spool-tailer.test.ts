// Tests for the P1 spool tailer (plans/p1-hook-spool-multi-transport.md §3,
// §5 E1). Temp-dir spools + a recording sink for the pure tailer behavior;
// a real AgentSupervisor (patched DB, stubbed flips) for the
// applied/duplicate/stale verdicts through the central applier.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/hook-spool-tailer.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HookSpoolTailer,
  resolveSpoolReadPath,
  canonicalSpoolKey,
  SPOOL_LOOKBACK_BYTES,
} from './hook-spool-tailer';
import { AgentSupervisor } from './index';
import type { ParsedHookEvent } from './index';
import { makeAgent } from './test-helpers/fake-bridge-deps';
import type { Agent, AgentStatus } from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

// ── Helpers ──────────────────────────────────────────────────────────

function mktmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ad-spool-${prefix}-`));
}
function rmrf(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function record(state: 'idle' | 'working' | 'active' | 'waiting', ts: number, extra: Partial<ParsedHookEvent> = {}): string {
  const source = state === 'working' ? 'hook-start'
    : state === 'active' ? 'hook-session-start'
    : state === 'waiting' ? 'hook-notification'
    : 'hook-stop';
  const hookEventName = state === 'working' ? 'UserPromptSubmit'
    : state === 'active' ? 'SessionStart'
    : state === 'waiting' ? 'Notification'
    : 'Stop';
  return JSON.stringify({ v: 1, agentId: 'ag-1', state, source, ts, hookEventName, ...extra }) + '\n';
}

function captureWarns(): { warns: string[]; restore: () => void } {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
  return { warns, restore: () => { console.warn = orig; } };
}

/** A tailer over a temp spool with a recording sink. The spool file is
 *  created (empty) BEFORE the tailer unless `preexisting` content is given —
 *  pre-existing content exercises the startup-lookback path. */
function makeTailer(opts: { dir: string; preexisting?: string; now?: () => number }) {
  const spool = path.join(opts.dir, 'pending-status.jsonl');
  if (opts.preexisting !== undefined) {
    fs.writeFileSync(spool, opts.preexisting, 'utf-8');
  }
  const received: ParsedHookEvent[] = [];
  const tailer = new HookSpoolTailer(spool, {
    onRecord: (r) => { received.push(r); },
    now: opts.now,
  });
  return { spool, tailer, received };
}

// ── Pure tailer behavior ─────────────────────────────────────────────

test('fresh append → exactly one record forwarded; re-drain forwards nothing new', () => {
  const dir = mktmp('fresh');
  try {
    const { spool, tailer, received } = makeTailer({ dir });
    fs.appendFileSync(spool, record('idle', Date.now()));
    tailer.drain();
    assert.equal(received.length, 1, 'one fresh record');
    assert.equal(received[0].state, 'idle');
    tailer.drain();
    assert.equal(received.length, 1, 'second drain with no new bytes forwards nothing');
  } finally {
    rmrf(dir);
  }
});

test('fragmented line across two reads → exactly one forward, no warn', () => {
  const dir = mktmp('frag');
  const { warns, restore } = captureWarns();
  try {
    const { spool, tailer, received } = makeTailer({ dir });
    const line = record('working', Date.now());
    // First half (no newline) → must be buffered, never parsed.
    fs.appendFileSync(spool, line.slice(0, 25));
    tailer.drain();
    assert.equal(received.length, 0, 'partial line must not be parsed');
    // Rest of the line, newline-terminated.
    fs.appendFileSync(spool, line.slice(25));
    tailer.drain();
    assert.equal(received.length, 1, 'completed line parses exactly once');
    assert.equal(received[0].state, 'working');
    assert.deepStrictEqual(warns, [], 'no malformed-line warn for a fragmented write');
  } finally {
    restore();
    rmrf(dir);
  }
});

test('malformed complete line → skipped with warn; later lines still apply', () => {
  const dir = mktmp('malformed');
  const { warns, restore } = captureWarns();
  try {
    const { spool, tailer, received } = makeTailer({ dir });
    fs.appendFileSync(spool, '{this is not json}\n' + record('idle', Date.now()));
    tailer.drain();
    assert.equal(received.length, 1, 'valid record after the malformed line still applies');
    assert.ok(warns.some((w) => /malformed/.test(w)), `expected a malformed-line warn; got ${JSON.stringify(warns)}`);
  } finally {
    restore();
    rmrf(dir);
  }
});

test('truncate-shrink → offset reset, partial cleared, new content applies', () => {
  const dir = mktmp('trunc');
  try {
    const { spool, tailer, received } = makeTailer({ dir });
    fs.appendFileSync(spool, record('idle', Date.now()) + record('working', Date.now()));
    tailer.drain();
    assert.equal(received.length, 2);

    // External truncation (e.g. a user clearing the file).
    fs.truncateSync(spool, 0);
    fs.appendFileSync(spool, record('idle', Date.now(), { turnId: 'post-trunc' }));
    tailer.drain();
    assert.equal(received.length, 3, 'record after the truncate applies (offset was reset)');
    assert.equal(received[2].turnId, 'post-trunc');
  } finally {
    rmrf(dir);
  }
});

test('startup lookback: 64 KB window, partial first line discarded, old/active filtered, fresh idle applied', () => {
  const dir = mktmp('lookback');
  const { warns, restore } = captureWarns();
  try {
    const NOW = Date.now();
    // Build > 64 KB of old history so the tailer seeks into the middle of a
    // line (every line is identical length → virtually guaranteed mid-line).
    let history = '';
    const oldTs = NOW - 60 * 60_000; // 1 h old
    while (history.length <= SPOOL_LOOKBACK_BYTES + 4096) {
      history += record('idle', oldTs, { turnId: 'old-old-old-old' });
    }
    // Tail records inside the lookback window:
    history += record('active', NOW - 1_000, { turnId: 'fresh-active' });  // fresh SessionStart of an OLD launch → must be ignored
    history += record('idle', NOW - 20 * 60_000, { turnId: 'too-old' });   // > 10 min old → ignored
    history += record('idle', NOW - 1_000, { turnId: 'fresh-idle' });      // fresh → applied

    const { spool, tailer, received } = makeTailer({ dir, preexisting: history, now: () => NOW });
    tailer.drain();
    assert.equal(received.length, 1, `lookback must apply ONLY the fresh idle; got ${JSON.stringify(received.map(r => r.turnId))}`);
    assert.equal(received[0].turnId, 'fresh-idle');
    assert.deepStrictEqual(warns, [], 'the discarded first partial line must not produce a malformed warn');

    // Records appended AFTER startup are live — 'active' now applies.
    fs.appendFileSync(spool, record('active', NOW, { turnId: 'live-active' }));
    tailer.drain();
    assert.equal(received.length, 2, 'fresh post-startup active record applies normally');
    assert.equal(received[1].turnId, 'live-active');
  } finally {
    restore();
    rmrf(dir);
  }
});

test('startup lookback: stale historical waiting is suppressed (joins active); fresh post-launch waiting applies', () => {
  const dir = mktmp('lookback-waiting');
  const { warns, restore } = captureWarns();
  try {
    const NOW = Date.now();
    // Build > 64 KB of old history so the tailer seeks mid-line on startup.
    let history = '';
    const oldTs = NOW - 60 * 60_000; // 1 h old
    while (history.length <= SPOOL_LOOKBACK_BYTES + 4096) {
      history += record('idle', oldTs, { turnId: 'old-old-old-old' });
    }
    // Tail records inside the lookback window:
    history += record('waiting', NOW - 1_000, { turnId: 'fresh-waiting', waitingExcerpt: 'old wait' }); // fresh-ts but historical Notification → must be suppressed (launch/turn-specific)
    history += record('idle', NOW - 1_000, { turnId: 'fresh-idle' });  // fresh idle → applied (proves the window IS being read)

    const { spool, tailer, received } = makeTailer({ dir, preexisting: history, now: () => NOW });
    tailer.drain();
    assert.equal(received.length, 1, `a historical 'waiting' in the lookback window must be suppressed like 'active'; got ${JSON.stringify(received.map(r => r.turnId))}`);
    assert.equal(received[0].turnId, 'fresh-idle');
    assert.ok(!received.some((r) => r.state === 'waiting'), 'no historical waiting may leak through startup lookback');
    assert.deepStrictEqual(warns, [], 'the discarded first partial line must not produce a malformed warn');

    // A 'waiting' record appended AFTER startup is live → applies.
    fs.appendFileSync(spool, record('waiting', NOW, { turnId: 'live-waiting', waitingExcerpt: 'need input' }));
    tailer.drain();
    assert.equal(received.length, 2, 'a fresh post-startup waiting record applies normally');
    assert.equal(received[1].turnId, 'live-waiting');
    assert.equal(received[1].state, 'waiting');
    assert.equal(received[1].waitingExcerpt, 'need input');
  } finally {
    restore();
    rmrf(dir);
  }
});

test('file missing at construction → later content is LIVE (fresh-workspace SessionStart applies)', () => {
  const dir = mktmp('cold');
  try {
    const spool = path.join(dir, 'pending-status.jsonl');
    const received: ParsedHookEvent[] = [];
    const tailer = new HookSpoolTailer(spool, { onRecord: (r) => { received.push(r); } });
    tailer.drain(); // no file yet — no data, no crash
    fs.writeFileSync(spool, record('active', Date.now(), { turnId: 'first-canary' }));
    tailer.drain();
    assert.equal(received.length, 1, 'a brand-new workspace’s first SessionStart must apply (not lookback-suppressed)');
    assert.equal(received[0].state, 'active');
  } finally {
    rmrf(dir);
  }
});

// ── Canonical-path keying ────────────────────────────────────────────

test('canonical keying: wsl$ and wsl.localhost forms of the same workspace yield one key', () => {
  const a = canonicalSpoolKey(resolveSpoolReadPath('\\\\wsl$\\Ubuntu\\home\\u\\proj'));
  const b = canonicalSpoolKey(resolveSpoolReadPath('\\\\wsl.localhost\\Ubuntu\\home\\u\\proj'));
  assert.equal(a, b, `UNC alias forms must collapse to one tailer key; got ${a} vs ${b}`);
});

test('canonical keying: Windows case/slash variants of the same workspace yield one key', () => {
  const a = canonicalSpoolKey(resolveSpoolReadPath('C:\\Users\\U\\Proj'));
  const b = canonicalSpoolKey(resolveSpoolReadPath('c:/users/u/proj'));
  assert.equal(a, b, `case/separator variants must collapse to one tailer key; got ${a} vs ${b}`);
});

test('canonical keying (supervisor): two workers on path variants of one workspace → one tailer', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const origAddEvent = db.addEvent;
  db.addEvent = () => {};
  try {
    const supervisor = new AgentSupervisor();
    (supervisor as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
    const s = supervisor as unknown as {
      ensureSpoolTailer(agent: Agent): void;
      spoolTailers: Map<string, unknown>;
    };
    s.ensureSpoolTailer(makeAgent('k-1', {
      isWorker: true,
      workingDirectory: 'C:\\Users\\U\\Proj\\.dashboard\\workers\\claude',
    }));
    s.ensureSpoolTailer(makeAgent('k-2', {
      isWorker: true,
      workingDirectory: 'c:\\users\\u\\proj\\.dashboard\\workers\\codex',
    }));
    assert.equal(s.spoolTailers.size, 1,
      'same workspace via case variants must share ONE tailer (keyed by canonical read path)');
  } finally {
    db.addEvent = origAddEvent;
  }
});

// ── Verdicts through the central applier (E1 applied/duplicate/stale) ──

function patchDb(agentsMap: Map<string, Agent>): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const db = require('../database') as Record<string, unknown>;
  const keys = [
    'updateAgentStatus', 'updateAgentHookStatus', 'getAgent', 'addEvent',
    'getActiveAgents', 'getAllAgents', 'getSupervisorAgent',
  ];
  const orig: Record<string, unknown> = {};
  for (const k of keys) orig[k] = db[k];
  db.updateAgentStatus = (id: string, status: AgentStatus) => {
    const a = agentsMap.get(id); if (a) a.status = status;
  };
  db.updateAgentHookStatus = (id: string, hookStatus: NonNullable<Agent['hookStatus']>, lastHookEventAt?: number) => {
    const a = agentsMap.get(id);
    if (a) { a.hookStatus = hookStatus; if (lastHookEventAt !== undefined) a.lastHookEventAt = lastHookEventAt; }
  };
  db.getAgent = (id: string) => agentsMap.get(id) ?? null;
  db.addEvent = () => {};
  db.getActiveAgents = () => Array.from(agentsMap.values());
  db.getAllAgents = () => Array.from(agentsMap.values());
  db.getSupervisorAgent = () => null;
  return () => { for (const k of keys) db[k] = orig[k]; };
}

test('verdicts: fresh spool append → applied EXACTLY once (self-dedupe regression guard); replay → duplicate; older → stale', () => {
  const dir = mktmp('verdicts');
  const agent = makeAgent('ag-1', { provider: 'claude', isWorker: true, status: 'working' });
  const agentsMap = new Map<string, Agent>([[agent.id, agent]]);
  const restoreDb = patchDb(agentsMap);
  try {
    const supervisor = new AgentSupervisor();
    (supervisor as unknown as { writeAgentRegistry: () => void }).writeAgentRegistry = () => {};
    const flips: string[] = [];
    const monitor = (supervisor as unknown as {
      monitor: { forceIdle: (id: string, source: string) => void; forceWorking: (id: string, s: unknown) => void };
    }).monitor;
    monitor.forceIdle = (_id, source) => { flips.push(`idle:${source}`); };
    monitor.forceWorking = (_id, s) => { flips.push(`working:${typeof s === 'string' ? s : (s as { source: string }).source}`); };

    const spool = path.join(dir, 'pending-status.jsonl');
    fs.writeFileSync(spool, ''); // exists-but-empty at tailer creation → all live
    const results: string[] = [];
    const tailer = new HookSpoolTailer(spool, {
      onRecord: (r) => {
        results.push(supervisor.applyHookStatusEvent(agent.id, r, 'spool'));
      },
    });

    const ts = Date.now();
    // (1) Fresh append → applied, NOT duplicate (the tailer must not self-dedupe
    //     or pre-register events; only the central applier dedupes).
    fs.appendFileSync(spool, record('idle', ts, { turnId: 't-1' }));
    tailer.drain();
    assert.deepStrictEqual(results, ['applied'], 'a fresh spool event must return applied (not duplicate)');
    assert.deepStrictEqual(flips, ['idle:hook-spool'], 'spool-delivered flip carries source hook-spool');

    // (2) Same record key delivered earlier via HTTP, then re-read from the
    //     spool → duplicate, no second flip.
    const ts2 = ts + 1_000;
    const httpVerdict = supervisor.applyHookStatusEvent(
      agent.id,
      { v: 1, agentId: agent.id, state: 'working', source: 'hook-start', ts: ts2, hookEventName: 'UserPromptSubmit', turnId: 't-2' },
      'http');
    assert.equal(httpVerdict, 'applied');
    fs.appendFileSync(spool, record('working', ts2, { turnId: 't-2' }));
    tailer.drain();
    assert.equal(results[1], 'duplicate', 'an HTTP-applied event re-read from the spool is a duplicate');
    assert.equal(flips.length, 2, 'no flip on duplicate');

    // (3) An OLDER event arriving late from the spool → stale.
    fs.appendFileSync(spool, record('idle', ts - 5_000, { turnId: 't-0' }));
    tailer.drain();
    assert.equal(results[2], 'stale', 'a laggy spool read older than the applied watermark is stale');
    assert.equal(flips.length, 2, 'no flip on stale');
  } finally {
    restoreDb();
    rmrf(dir);
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
