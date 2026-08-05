// Self-contained smoke test for GrokSessionReader.
//
// Runs against the synthesized fixture under
// __fixtures__/grok-session-sample/. No private session content is used —
// every byte here is fabricated to match the grok ACP updates.jsonl shape.
//
// Build + run:
//   npm run build:main
//   node dist/main/supervisor/log-readers/grok-session-reader.test.js
//
// Uses node:assert and exits non-zero on failure (project convention — no
// runner wired for main-process tests).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  GrokSessionReader,
  findGroupDirForCwd,
  readActiveSessionIdsForCwd,
  readGrokSummary,
} from './grok-session-reader';
import { SessionLogDispatcher } from '../session-log-dispatcher';
import type { ChatLogReaderSession } from './types';
import type { SessionEvent } from '../../../shared/session-events';

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find repo root from ${start}`);
}

const REPO_ROOT = findRepoRoot(__dirname);
const FIXTURE_DIR = path.join(
  REPO_ROOT, 'src', 'main', 'supervisor', 'log-readers', '__fixtures__', 'grok-session-sample'
);
const FIXTURE_UPDATES = path.join(FIXTURE_DIR, 'updates.jsonl');
const FIXTURE_SESSION_ID = '019fffff-1111-7222-a800-aaaaaaaaaaaa';
const FIXTURE_CWD = 'C:\\Users\\fixture\\grok';

if (!fs.existsSync(FIXTURE_UPDATES)) {
  console.error(`FIXTURE_UPDATES does not exist: ${FIXTURE_UPDATES}`);
  process.exit(2);
}

interface TestCase {
  name: string;
  run(): void | Promise<void>;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

/** Reader with the resolved-path cache pre-seeded to the fixture, so
 *  pollSession reads it directly without touching ~/.grok. */
function makeReader(updatesPath: string = FIXTURE_UPDATES): GrokSessionReader {
  return new (class extends GrokSessionReader {
    constructor() {
      super();
      (this as any).resolvedPaths.set('test-agent', updatesPath);
    }
  })();
}

function makeSession(overrides: Partial<ChatLogReaderSession> = {}): ChatLogReaderSession {
  return {
    agentId: 'test-agent',
    sessionId: FIXTURE_SESSION_ID,
    workingDirectory: FIXTURE_CWD,
    provider: 'grok',
    subscribed: true,
    ...overrides,
  };
}

function pollAll(reader: GrokSessionReader): SessionEvent[] {
  return reader.pollSession(makeSession());
}

function countByType(events: SessionEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[e.type] = (out[e.type] || 0) + 1;
  return out;
}

/** Write a full session dir (updates.jsonl + summary.json) under a temp
 *  `<root>/sessions/<encoded-cwd>/<sid>/` tree so discovery goes through the
 *  reader's real base-dir walk. Returns the temp `.grok` root. */
function writeSessionTree(opts: {
  cwd: string;
  sessionId: string;
  lines: string[];
  activeSessions?: unknown;
  mtimeMs?: number;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
  const groupDir = path.join(root, 'sessions', encodeURIComponent(opts.cwd), opts.sessionId);
  fs.mkdirSync(groupDir, { recursive: true });
  const updates = path.join(groupDir, 'updates.jsonl');
  fs.writeFileSync(updates, opts.lines.join('\n') + '\n');
  fs.writeFileSync(
    path.join(groupDir, 'summary.json'),
    JSON.stringify({ info: { id: opts.sessionId, cwd: opts.cwd }, current_model_id: 'grok-4.5' })
  );
  if (opts.activeSessions !== undefined) {
    fs.writeFileSync(path.join(root, 'active_sessions.json'), JSON.stringify(opts.activeSessions));
  }
  if (opts.mtimeMs != null) {
    const t = opts.mtimeMs / 1000;
    fs.utimesSync(updates, t, t);
  }
  return root;
}

function makeDiscoveryReader(root: string): GrokSessionReader {
  const reader = new GrokSessionReader();
  (reader as any).windowsGrokDir = root;
  (reader as any).wslGrokDir = null;
  return reader;
}

const FIXTURE_LINES = fs.readFileSync(FIXTURE_UPDATES, 'utf-8').split('\n').filter(Boolean);

// ── Parsing tests ──────────────────────────────────────────────────────

test('fixture parses with all expected event types', () => {
  const events = pollAll(makeReader());
  const counts = countByType(events);
  assert.equal(counts['system-init'], 1, 'exactly one system-init');
  assert.equal(counts['user-text'], 2, 'two user turns');
  assert.equal(counts['assistant-text'], 2, 'two assistant turns');
  assert.ok((counts['thinking'] || 0) >= 1, 'at least one thinking');
  assert.equal(counts['tool-use'], 1, 'one tool-use');
  assert.equal(counts['tool-result'], 1, 'one tool-result (in_progress dropped)');
  assert.equal(counts['usage'], 2, 'one usage per turn_completed');
});

test('system-init carries model from summary.json and cwd', () => {
  const events = pollAll(makeReader());
  const init = events.find((e) => e.type === 'system-init');
  assert.ok(init && init.type === 'system-init');
  assert.equal(init.model, 'grok-4.5');
  assert.equal(init.cwd, FIXTURE_CWD);
});

test('user-text comes from user_message_chunk', () => {
  const events = pollAll(makeReader());
  const users = events.filter((e) => e.type === 'user-text');
  assert.equal(users.length, 2);
  assert.ok(users[0].type === 'user-text' && users[0].text === 'list the files');
});

test('assistant-text carries the model tag', () => {
  const events = pollAll(makeReader());
  const assistants = events.filter((e) => e.type === 'assistant-text');
  assert.equal(assistants.length, 2);
  for (const a of assistants) {
    assert.ok(a.type === 'assistant-text');
    assert.equal(a.model, 'grok-4.5', 'assistant-text tagged with the current model');
  }
});

test('in-batch turn_completed tags turnComplete + endsWithQuestion', () => {
  const events = pollAll(makeReader());
  const assistants = events.filter((e) => e.type === 'assistant-text');
  const first = assistants[0];
  const second = assistants[1];
  assert.ok(first.type === 'assistant-text' && second.type === 'assistant-text');
  assert.equal(first.turnComplete, true);
  assert.equal(first.stopReason, 'end_turn');
  assert.equal(first.endsWithQuestion, false, 'first reply ends with a period');
  assert.equal(second.turnComplete, true);
  assert.equal(second.endsWithQuestion, true, 'second reply ends with "?"');
  // No split-batch patch when task completes in the same poll.
  assert.equal(events.filter((e) => e.type === 'assistant-text-patch').length, 0);
});

test('tool-use parses rawInput into structured input and names the tool', () => {
  const events = pollAll(makeReader());
  const tu = events.find((e) => e.type === 'tool-use');
  assert.ok(tu && tu.type === 'tool-use');
  assert.equal(tu.toolUseId, 'call-abc-0');
  assert.equal(tu.toolName, 'run_terminal_command');
  assert.deepEqual(tu.input, { command: 'ls', description: 'list files' });
});

test('tool-result uses rawOutput.output_for_prompt and roundtrips tool id', () => {
  const events = pollAll(makeReader());
  const results = events.filter((e) => e.type === 'tool-result');
  assert.equal(results.length, 1, 'only the completed update yields a tool-result');
  const r = results[0];
  assert.ok(r.type === 'tool-result');
  assert.equal(r.toolUseId, 'call-abc-0');
  assert.equal(r.content, 'exit: 0\na.txt\nb.txt\n');
  assert.equal(r.truncated, false);
  assert.equal(r.isError, false);
});

test('usage reads the grok turn_completed usage shape', () => {
  const events = pollAll(makeReader());
  const usages = events.filter((e) => e.type === 'usage');
  const u = usages[0];
  assert.ok(u && u.type === 'usage');
  assert.equal(u.inputTokens, 12000);
  assert.equal(u.outputTokens, 40);
  assert.equal(u.totalTokens, 12040);
  assert.equal(u.cachedTokens, 8000, 'cachedReadTokens surfaced as cachedTokens');
  assert.equal(u.cacheCreationTokens, 0);
  assert.equal(u.cacheReadTokens, 0);
  assert.equal(u.cumulativeContextTokens, 12000, 'context occupancy = inputTokens');
  // Gauge policy caps at the 200K default role cap.
  assert.equal(u.contextWindowMax, 200_000);
  assert.equal(u.contextPercentage, 6, '12000 / 200000 = 6%');
  assert.equal(u.sessionId, FIXTURE_SESSION_ID);
});

test('thinking emitted from agent_thought_chunk', () => {
  const events = pollAll(makeReader());
  const think = events.filter((e) => e.type === 'thinking');
  assert.ok(think.length >= 1);
  assert.ok(think[0].type === 'thinking' && think[0].text.includes('shell command'));
});

test('hook_execution and session_recap are dropped', () => {
  const events = pollAll(makeReader());
  // 12 fixture lines → 1 hook + 1 recap dropped; every other line maps to
  // exactly one event, plus the synthesized system-init.
  for (const e of events) {
    assert.notEqual(e.type as string, 'hook_execution');
    assert.notEqual(e.type as string, 'session_recap');
  }
});

test('malformed JSON line is skipped without throwing', () => {
  const tmp = path.join(os.tmpdir(), `grok-malformed-${process.pid}.jsonl`);
  fs.writeFileSync(tmp, FIXTURE_LINES.slice(0, 3).join('\n') + '\n{not json\nalso not json\n');
  try {
    const reader = makeReader(tmp);
    const events = reader.pollSession(makeSession());
    assert.ok(events.some((e) => e.type === 'user-text'));
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('getFullToolResult re-reads the original tool_call_update payload', async () => {
  const reader = makeReader();
  const events = pollAll(reader);
  const r = events.find((e) => e.type === 'tool-result');
  assert.ok(r && r.type === 'tool-result');
  const full = await reader.getFullToolResult('test-agent', r.toolUseId);
  assert.equal(full, 'exit: 0\na.txt\nb.txt\n');
});

test('byte-offset tail emits incremental events on second poll (no duplicates)', () => {
  const half = Math.floor(FIXTURE_LINES.length / 2);
  const tmp = path.join(os.tmpdir(), `grok-tail-${process.pid}.jsonl`);
  fs.writeFileSync(tmp, FIXTURE_LINES.slice(0, half).join('\n') + '\n');
  try {
    const reader = makeReader(tmp);
    const first = reader.pollSession(makeSession());
    fs.writeFileSync(tmp, FIXTURE_LINES.join('\n') + '\n');
    const second = reader.pollSession(makeSession());
    assert.ok(first.length > 0 && second.length > 0);
    const firstUuids = new Set(first.map((e) => e.uuid));
    for (const e of second) {
      assert.ok(!firstUuids.has(e.uuid), `duplicate uuid across polls: ${e.uuid}`);
    }
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('split-batch turn_completed emits assistant-text-patch', () => {
  const sid = FIXTURE_SESSION_ID;
  const stage1 = [
    JSON.stringify({
      timestamp: 1785772805, method: 'session/update',
      params: {
        sessionId: sid,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working on it.' } },
        _meta: { eventId: `${sid}-s1`, agentTimestampMs: 1785772805000 },
      },
    }),
  ];
  const stage2Line = JSON.stringify({
    timestamp: 1785772806, method: '_x.ai/session/update',
    params: {
      sessionId: sid,
      update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn', usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 } },
      _meta: { eventId: `${sid}-s2`, agentTimestampMs: 1785772806000 },
    },
  });
  const tmp = path.join(os.tmpdir(), `grok-split-${process.pid}.jsonl`);
  fs.writeFileSync(tmp, stage1.join('\n') + '\n');
  try {
    const reader = makeReader(tmp);
    const first = reader.pollSession(makeSession({ sessionId: sid }));
    const at = first.find((e) => e.type === 'assistant-text');
    assert.ok(at && at.type === 'assistant-text');
    assert.equal(at.turnComplete, undefined, 'not yet complete in stage 1');
    fs.appendFileSync(tmp, stage2Line + '\n');
    const second = reader.pollSession(makeSession({ sessionId: sid }));
    const patch = second.find((e) => e.type === 'assistant-text-patch');
    assert.ok(patch && patch.type === 'assistant-text-patch');
    assert.equal(patch.targetUuid, at.uuid);
    assert.equal(patch.turnComplete, true);
    assert.equal(patch.stopReason, 'end_turn');
  } finally {
    fs.unlinkSync(tmp);
  }
});

// ── Discovery tests ────────────────────────────────────────────────────

test('findGroupDirForCwd resolves the encodeURIComponent group name', () => {
  const root = writeSessionTree({ cwd: FIXTURE_CWD, sessionId: FIXTURE_SESSION_ID, lines: FIXTURE_LINES });
  try {
    const sessionsDir = path.join(root, 'sessions');
    const group = findGroupDirForCwd(sessionsDir, FIXTURE_CWD);
    assert.ok(group, 'group dir located');
    assert.equal(path.basename(group!), encodeURIComponent(FIXTURE_CWD));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cwd discovery tails the session with no bound session id', () => {
  const root = writeSessionTree({ cwd: FIXTURE_CWD, sessionId: FIXTURE_SESSION_ID, lines: FIXTURE_LINES });
  try {
    const reader = makeDiscoveryReader(root);
    const events = reader.pollSession(
      makeSession({ agentId: 'a1', sessionId: '', workingDirectory: FIXTURE_CWD })
    );
    assert.ok(events.some((e) => e.type === 'user-text' && e.text === 'list the files'));
    assert.ok(events.some((e) => e.type === 'assistant-text'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('start floor: a live session whose mtime is just after a SQLite space-form createdAt is ACCEPTED (UTC parse)', () => {
  // Regression for the start-floor timezone misparse: startedAt arrives from the
  // agents table as SQLite `datetime('now')` space-form ("YYYY-MM-DD HH:MM:SS",
  // UTC, no Z). A bare Date.parse reads it as LOCAL time, so on a west-of-UTC
  // host the floor lands hours in the FUTURE and every real session is rejected
  // as stale → discovery null → empty chat. Values use Date.UTC so the assertion
  // holds on any runner timezone (green on UTC CI; proves the fix west of UTC).
  const createdAtUtcMs = Date.UTC(2026, 7, 4, 17, 18, 38); // "2026-08-04 17:18:38" UTC
  const startedAtSpaceForm = '2026-08-04 17:18:38';
  const root = writeSessionTree({
    cwd: FIXTURE_CWD,
    sessionId: FIXTURE_SESSION_ID,
    lines: FIXTURE_LINES,
    mtimeMs: createdAtUtcMs + 5_000, // updates.jsonl written ~5s after the agent row
  });
  try {
    const reader = makeDiscoveryReader(root);
    const events = reader.pollSession(
      makeSession({ agentId: 'a1', sessionId: '', workingDirectory: FIXTURE_CWD, startedAt: startedAtSpaceForm })
    );
    assert.ok(
      events.some((e) => e.type === 'user-text' && e.text === 'list the files'),
      'space-form createdAt must be treated as UTC so a just-after session is not falsely rejected as stale',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('active_sessions.json selects the live session over a newer stale one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
  const cwd = FIXTURE_CWD;
  const groupBase = path.join(root, 'sessions', encodeURIComponent(cwd));
  const liveSid = '019fffff-1111-7222-a800-bbbbbbbbbbbb';
  const staleSid = '019fffff-1111-7222-a800-cccccccccccc';
  // live session (older mtime), stale session (newer mtime)
  for (const [sid, text, tSec] of [
    [liveSid, 'from the live session', 1785772800],
    [staleSid, 'from the stale session', 1785779999],
  ] as [string, string, number][]) {
    const dir = path.join(groupBase, sid);
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      timestamp: tSec, method: 'session/update',
      params: {
        sessionId: sid,
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, _meta: { modelId: 'grok-4.5' } },
        _meta: { eventId: `${sid}-1`, agentTimestampMs: tSec * 1000 },
      },
    });
    fs.writeFileSync(path.join(dir, 'updates.jsonl'), line + '\n');
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ info: { id: sid, cwd }, current_model_id: 'grok-4.5' }));
    const t = tSec;
    fs.utimesSync(path.join(dir, 'updates.jsonl'), t, t);
  }
  fs.writeFileSync(
    path.join(root, 'active_sessions.json'),
    JSON.stringify([{ session_id: liveSid, pid: 111, cwd, opened_at: '2026-08-03T16:00:00Z' }])
  );
  try {
    const reader = makeDiscoveryReader(root);
    const events = reader.pollSession(
      makeSession({ agentId: 'live', sessionId: '', workingDirectory: cwd })
    );
    assert.ok(
      events.some((e) => e.type === 'user-text' && e.text === 'from the live session'),
      'active_sessions.json live id wins even though the stale session dir is newer'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readActiveSessionIdsForCwd matches by cwd (missing file → empty set)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
  try {
    assert.equal(readActiveSessionIdsForCwd(root, FIXTURE_CWD).size, 0, 'missing file → empty');
    fs.writeFileSync(
      path.join(root, 'active_sessions.json'),
      JSON.stringify([
        { session_id: 's-match', cwd: FIXTURE_CWD },
        { session_id: 's-other', cwd: 'C:\\somewhere\\else' },
      ])
    );
    const ids = readActiveSessionIdsForCwd(root, FIXTURE_CWD);
    assert.ok(ids.has('s-match') && !ids.has('s-other'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('readGrokSummary reads model + cwd, tolerates missing file', () => {
  const meta = readGrokSummary(FIXTURE_DIR);
  assert.equal(meta.model, 'grok-4.5');
  assert.equal(meta.cwd, FIXTURE_CWD);
  const empty = readGrokSummary(os.tmpdir());
  assert.equal(empty.model, null);
});

// ── readSessionEventsOnce (dead-agent disk history) ────────────────────

test('readSessionEventsOnce parses a prior session located by id; null when missing', () => {
  const root = writeSessionTree({ cwd: FIXTURE_CWD, sessionId: FIXTURE_SESSION_ID, lines: FIXTURE_LINES });
  try {
    const reader = makeDiscoveryReader(root);
    const events = reader.readSessionEventsOnce(FIXTURE_CWD, FIXTURE_SESSION_ID);
    assert.ok(events, 'located + parsed');
    assert.ok(events!.some((e) => e.type === 'user-text' && e.text === 'list the files'));
    assert.ok(events!.some((e) => e.type === 'assistant-text'));
    // Missing id → null; empty id → null.
    assert.equal(reader.readSessionEventsOnce(FIXTURE_CWD, '019fffff-1111-7222-a800-ffffffffffff'), null);
    assert.equal(reader.readSessionEventsOnce(FIXTURE_CWD, ''), null);
    // No residue in per-agent maps.
    assert.equal((reader as any).fileOffsets.size, 0);
    assert.equal((reader as any).resolvedPaths.size, 0);
    assert.equal((reader as any).emittedSystemInit.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('terminal recovery binds the only Grok session in the agent activity window', () => {
  const root = writeSessionTree({ cwd: FIXTURE_CWD, sessionId: FIXTURE_SESSION_ID, lines: FIXTURE_LINES });
  try {
    const recovered = makeDiscoveryReader(root).recoverSessionEventsOnce(
      FIXTURE_CWD,
      new Date(1785772799000).toISOString(),
      new Date(1785772861000).toISOString(),
    );
    assert.equal(recovered?.sessionId, FIXTURE_SESSION_ID);
    assert.ok(recovered?.events.some((e) => e.type === 'user-text' && e.text === 'list the files'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('terminal recovery refuses ambiguous same-cwd Grok sessions', () => {
  const root = writeSessionTree({ cwd: FIXTURE_CWD, sessionId: FIXTURE_SESSION_ID, lines: FIXTURE_LINES });
  try {
    const group = path.join(root, 'sessions', encodeURIComponent(FIXTURE_CWD));
    fs.cpSync(path.join(group, FIXTURE_SESSION_ID), path.join(group, '019fffff-1111-7222-a800-bbbbbbbbbbbb'), { recursive: true });
    const recovered = makeDiscoveryReader(root).recoverSessionEventsOnce(
      FIXTURE_CWD,
      new Date(1785772799000).toISOString(),
      new Date(1785772861000).toISOString(),
    );
    assert.equal(recovered, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Dispatcher wiring ──────────────────────────────────────────────────

test('dispatcher routes grok events end-to-end via pollNow + getCachedEvents', () => {
  const root = writeSessionTree({ cwd: FIXTURE_CWD, sessionId: FIXTURE_SESSION_ID, lines: FIXTURE_LINES });
  try {
    const agentId = 'grok-agent-1';
    const dispatcher = new SessionLogDispatcher(() => [
      { agentId, sessionId: '', workingDirectory: FIXTURE_CWD, provider: 'grok' },
    ]);
    dispatcher.register(makeDiscoveryReader(root));

    const batches: SessionEvent[][] = [];
    dispatcher.on('chat-events', (b: { events: SessionEvent[] }) => batches.push(b.events));

    dispatcher.pollNow(agentId);

    const { events } = dispatcher.getCachedEvents(agentId);
    const counts = countByType(events);
    assert.ok(counts['user-text'] >= 2, 'user-text reached the ring');
    assert.ok(counts['assistant-text'] >= 2, 'assistant-text reached the ring');
    assert.ok(counts['tool-use'] >= 1 && counts['tool-result'] >= 1, 'tool events routed');
    assert.ok(batches.length >= 1, "chat-events emitted");
    // Idempotent: a second poll with no new bytes adds nothing.
    dispatcher.pollNow(agentId);
    assert.equal(dispatcher.getCachedEvents(agentId).events.length, events.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── Runner ─────────────────────────────────────────────────────────────

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
      console.error('       ', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
