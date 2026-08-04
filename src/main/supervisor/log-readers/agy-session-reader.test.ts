// Synthesized SQLite/protobuf fixtures only. No real Antigravity conversation
// content is copied into the repository.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  AgySessionReader,
  decodeAgyWireMessage,
  parseStartedAtMs,
  readAgyHistoryBinding,
} from './agy-session-reader';
import { SessionLogDispatcher } from '../session-log-dispatcher';
import type { ChatLogReaderSession } from './types';
import type { SessionEvent } from '../../../shared/session-events';

interface TestCase { name: string; run(): void | Promise<void> }
const tests: TestCase[] = [];
function test(name: string, run: () => void | Promise<void>): void { tests.push({ name, run }); }

const SID = '11111111-2222-4333-8444-555555555555';
const OTHER_SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CWD = 'C:\\fixture\\workspace\\.lares\\workers\\agy';
const CREATED_MS = Date.parse('2026-08-03T16:55:28.400Z');

type Encoded = Buffer;
function varint(value: number | bigint): Buffer {
  let n = BigInt(value);
  const bytes: number[] = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    bytes.push(byte);
  } while (n);
  return Buffer.from(bytes);
}
function tag(field: number, wire: number): Buffer { return varint((field << 3) | wire); }
function vi(field: number, value: number): Encoded { return Buffer.concat([tag(field, 0), varint(value)]); }
function by(field: number, value: Buffer | string): Encoded {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return Buffer.concat([tag(field, 2), varint(data.length), data]);
}
function msg(...fields: Encoded[]): Encoded { return Buffer.concat(fields); }
function stamp(ms: number): Encoded {
  return msg(vi(1, Math.floor(ms / 1000)), vi(2, (ms % 1000) * 1_000_000));
}
function commonMeta(ms: number, extra: Encoded[] = []): Encoded {
  return msg(by(1, stamp(ms)), ...extra);
}
function userPayload(text: string, ms = CREATED_MS + 1_000): Encoded {
  return msg(vi(1, 14), vi(4, 3), by(5, commonMeta(ms)), by(19, msg(by(2, text), by(3, msg(by(1, text))))));
}
function assistantPayload(text: string, kind = 2, ms = CREATED_MS + 2_000, withUsage = true): Encoded {
  const usage = msg(vi(2, 1_200), vi(3, 40), vi(5, 800));
  return msg(
    vi(1, 15), vi(4, 3),
    by(5, commonMeta(ms, withUsage ? [by(9, usage)] : [])),
    by(20, msg(by(1, text), by(8, text), vi(12, kind))),
  );
}
function toolPayload(opts: {
  id?: string; name?: string; input?: unknown; output?: string; status?: number; ms?: number;
} = {}): Encoded {
  const id = opts.id ?? 'tool-1';
  const name = opts.name ?? 'run_command';
  const input = JSON.stringify(opts.input ?? { CommandLine: 'echo hello', Cwd: CWD });
  const tool = msg(by(1, id), by(2, name), by(3, input), by(9, name));
  const output = msg(by(21, msg(by(1, opts.output ?? 'hello\n'))));
  return msg(
    vi(1, 21), vi(4, opts.status ?? 3),
    by(5, commonMeta(opts.ms ?? CREATED_MS + 3_000, [by(4, tool)])),
    by(28, output),
  );
}

interface FixtureOptions {
  sid?: string;
  cwd?: string;
  createdMs?: number;
  rows?: Array<{ idx: number; type: number; status: number; payload: Buffer; error?: Buffer | null }>;
  mtimeMs?: number;
}
function createFixture(root: string, opts: FixtureOptions = {}): string {
  const sid = opts.sid ?? SID;
  const cwd = opts.cwd ?? CWD;
  const createdMs = opts.createdMs ?? CREATED_MS;
  const conversations = path.join(root, 'conversations');
  fs.mkdirSync(conversations, { recursive: true });
  const dbPath = path.join(conversations, `${sid}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE steps (
      idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL,
      has_subtrajectory NUMERIC NOT NULL DEFAULT false, metadata BLOB,
      error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB,
      step_payload BLOB, step_format INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
    CREATE TABLE trajectory_meta (
      trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER
    );
  `);
  const uri = `file:///${cwd.replace(/\\/g, '/')}`;
  const metadata = msg(by(1, msg(by(1, uri))), by(2, stamp(createdMs)), by(6, sid), by(7, uri));
  db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', metadata);
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, ?)').run('trajectory-fixture', sid, 4, 17);
  const rows = opts.rows ?? [
    { idx: 0, type: 14, status: 3, payload: userPayload('hello') },
    { idx: 1, type: 15, status: 3, payload: assistantPayload('Hello from agy.') },
    { idx: 2, type: 15, status: 3, payload: assistantPayload('Considering the request', 1, CREATED_MS + 2_500, false) },
    { idx: 3, type: 21, status: 3, payload: toolPayload() },
    { idx: 4, type: 23, status: 3, payload: msg(vi(1, 23), vi(4, 3), by(30, msg(by(4, 'recap noise')))) },
  ];
  const insert = db.prepare(
    'INSERT INTO steps (idx, step_type, status, step_payload, error_details) VALUES (?, ?, ?, ?, ?)',
  );
  for (const row of rows) insert.run(row.idx, row.type, row.status, row.payload, row.error ?? null);
  db.close();
  if (opts.mtimeMs != null) fs.utimesSync(dbPath, opts.mtimeMs / 1000, opts.mtimeMs / 1000);
  return dbPath;
}

function tempRoot(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'agy-reader-')); }
function cleanup(root: string): void { fs.rmSync(root, { recursive: true, force: true }); }
function readerAt(root: string): AgySessionReader {
  const reader = new AgySessionReader();
  (reader as any).windowsAgyRoot = root;
  return reader;
}
function session(overrides: Partial<ChatLogReaderSession> = {}): ChatLogReaderSession {
  return {
    agentId: 'agent-1', sessionId: SID, workingDirectory: CWD,
    provider: 'agy', subscribed: true, startedAt: new Date(CREATED_MS - 1_000).toISOString(),
    ...overrides,
  };
}
function types(events: SessionEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1;
  return counts;
}

test('wire decoder reads varints and nested byte fields', () => {
  const decoded = decodeAgyWireMessage(msg(vi(1, 21), by(4, msg(by(2, 'run_command')))));
  assert.equal(decoded.get(1)?.[0], 21n);
  assert.ok(Buffer.isBuffer(decoded.get(4)?.[0]));
});

test('fixture maps every supported event kind and drops recap noise', () => {
  const root = tempRoot();
  try {
    createFixture(root);
    assert.deepEqual(types(readerAt(root).pollSession(session())), {
      'system-init': 1, 'user-text': 1, 'assistant-text': 1,
      usage: 1, thinking: 1, 'tool-use': 1, 'tool-result': 1,
    });
  } finally { cleanup(root); }
});

test('system-init is synthesized from the conversation metadata blob', () => {
  const root = tempRoot();
  try {
    createFixture(root);
    const event = readerAt(root).pollSession(session()).find((e) => e.type === 'system-init');
    assert.ok(event?.type === 'system-init');
    assert.equal(event.cwd, CWD);
    assert.equal(event.model, 'antigravity');
    assert.equal(event.timestamp, new Date(CREATED_MS).toISOString());
  } finally { cleanup(root); }
});

test('user and final assistant content use stable row-derived UUIDs', () => {
  const root = tempRoot();
  try {
    createFixture(root);
    const events = readerAt(root).pollSession(session());
    const user = events.find((e) => e.type === 'user-text');
    const assistant = events.find((e) => e.type === 'assistant-text');
    assert.ok(user?.type === 'user-text' && user.text === 'hello');
    assert.equal(user.uuid, `agy:${SID}:step:0:user`);
    assert.ok(assistant?.type === 'assistant-text' && assistant.text === 'Hello from agy.');
    assert.equal(assistant.uuid, `agy:${SID}:step:1:assistant`);
    assert.equal(assistant.turnComplete, true);
  } finally { cleanup(root); }
});

test('assistant question detection and error stop reason are mapped', () => {
  const root = tempRoot();
  try {
    createFixture(root, { rows: [{ idx: 7, type: 15, status: 7, payload: assistantPayload('Need help?') }] });
    const event = readerAt(root).pollSession(session()).find((e) => e.type === 'assistant-text');
    assert.ok(event?.type === 'assistant-text');
    assert.equal(event.endsWithQuestion, true);
    assert.equal(event.stopReason, 'error');
  } finally { cleanup(root); }
});

test('non-final assistant content maps to thinking', () => {
  const root = tempRoot();
  try {
    createFixture(root, { rows: [{ idx: 2, type: 15, status: 3, payload: assistantPayload('reasoning', 1, CREATED_MS, false) }] });
    const events = readerAt(root).pollSession(session());
    assert.ok(events.some((e) => e.type === 'thinking' && e.text === 'reasoning'));
    assert.ok(!events.some((e) => e.type === 'assistant-text'));
  } finally { cleanup(root); }
});

test('usage maps token counts and role gauge cap', () => {
  const root = tempRoot();
  try {
    createFixture(root);
    const event = readerAt(root).pollSession(session()).find((e) => e.type === 'usage');
    assert.ok(event?.type === 'usage');
    assert.equal(event.inputTokens, 1_200);
    assert.equal(event.outputTokens, 40);
    assert.equal(event.cachedTokens, 800);
    assert.equal(event.totalTokens, 1_240);
    assert.equal(event.sessionId, SID);
  } finally { cleanup(root); }
});

test('terminal tool row maps structured input and canonical output', () => {
  const root = tempRoot();
  try {
    createFixture(root);
    const events = readerAt(root).pollSession(session());
    const use = events.find((e) => e.type === 'tool-use');
    const result = events.find((e) => e.type === 'tool-result');
    assert.ok(use?.type === 'tool-use');
    assert.equal(use.toolUseId, 'tool-1');
    assert.equal(use.toolName, 'run_command');
    assert.deepEqual(use.input, { CommandLine: 'echo hello', Cwd: CWD });
    assert.ok(result?.type === 'tool-result');
    assert.equal(result.content, 'hello\n');
    assert.equal(result.isError, false);
  } finally { cleanup(root); }
});

test('failed terminal tool row uses error_details and marks isError', () => {
  const root = tempRoot();
  try {
    const error = msg(by(1, 'permission denied'));
    createFixture(root, { rows: [{ idx: 3, type: 21, status: 7, payload: toolPayload({ status: 7 }), error }] });
    const result = readerAt(root).pollSession(session()).find((e) => e.type === 'tool-result');
    assert.ok(result?.type === 'tool-result');
    assert.equal(result.content, 'permission denied');
    assert.equal(result.isError, true);
  } finally { cleanup(root); }
});

test('non-terminal tool rows are ignored until terminal', () => {
  const root = tempRoot();
  try {
    const dbPath = createFixture(root, { rows: [{ idx: 3, type: 21, status: 1, payload: toolPayload({ status: 1 }) }] });
    const reader = readerAt(root);
    assert.ok(!reader.pollSession(session()).some((e) => e.type === 'tool-use'));
    const db = new Database(dbPath);
    db.prepare('UPDATE steps SET status = 3, step_payload = ? WHERE idx = 3').run(toolPayload({ status: 3 }));
    db.close();
    assert.equal(reader.pollSession(session()).filter((e) => e.type === 'tool-use').length, 1);
  } finally { cleanup(root); }
});

test('full tool result remains available after chat truncation', async () => {
  const root = tempRoot();
  try {
    const output = 'x'.repeat(25_000);
    createFixture(root, { rows: [{ idx: 3, type: 21, status: 3, payload: toolPayload({ output }) }] });
    const reader = readerAt(root);
    const result = reader.pollSession(session()).find((e) => e.type === 'tool-result');
    assert.ok(result?.type === 'tool-result' && result.truncated);
    assert.equal(await reader.getFullToolResult('agent-1', 'tool-1'), output);
  } finally { cleanup(root); }
});

test('second poll emits no duplicates; newly inserted rows are incremental', () => {
  const root = tempRoot();
  try {
    const dbPath = createFixture(root);
    const reader = readerAt(root);
    assert.ok(reader.pollSession(session()).length > 0);
    assert.deepEqual(reader.pollSession(session()), []);
    const db = new Database(dbPath);
    db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)')
      .run(9, 14, 3, userPayload('later', CREATED_MS + 9_000));
    db.close();
    const delta = reader.pollSession(session());
    assert.equal(delta.length, 1);
    assert.ok(delta[0].type === 'user-text' && delta[0].text === 'later');
  } finally { cleanup(root); }
});

test('invalidatePath resets binding, event dedupe, and full-result cache', async () => {
  const root = tempRoot();
  try {
    createFixture(root);
    const reader = readerAt(root);
    reader.pollSession(session());
    assert.equal(await reader.getFullToolResult('agent-1', 'tool-1'), 'hello\n');
    reader.invalidatePath('agent-1');
    assert.equal(await reader.getFullToolResult('agent-1', 'tool-1'), null);
    assert.ok(reader.pollSession(session()).some((e) => e.type === 'system-init'));
  } finally { cleanup(root); }
});

test('bound session id wins over newer cwd-matching conversations', () => {
  const root = tempRoot();
  try {
    createFixture(root, { sid: SID, rows: [{ idx: 0, type: 14, status: 3, payload: userPayload('bound') }] });
    createFixture(root, { sid: OTHER_SID, rows: [{ idx: 0, type: 14, status: 3, payload: userPayload('newer') }], mtimeMs: CREATED_MS + 50_000 });
    const user = readerAt(root).pollSession(session()).find((e) => e.type === 'user-text');
    assert.ok(user?.type === 'user-text' && user.text === 'bound');
  } finally { cleanup(root); }
});

test('history.jsonl binds an unbound active agent by cwd and conversationId', () => {
  const root = tempRoot();
  try {
    createFixture(root, { sid: OTHER_SID, rows: [{ idx: 0, type: 14, status: 3, payload: userPayload('history-bound') }] });
    fs.writeFileSync(path.join(root, 'history.jsonl'), JSON.stringify({
      display: 'hello', timestamp: CREATED_MS + 1_000, workspace: CWD, conversationId: OTHER_SID,
    }) + '\n');
    assert.equal(readAgyHistoryBinding(root, CWD, new Date(CREATED_MS).toISOString()), OTHER_SID);
    const user = readerAt(root).pollSession(session({ sessionId: '' })).find((e) => e.type === 'user-text');
    assert.ok(user?.type === 'user-text' && user.text === 'history-bound');
  } finally { cleanup(root); }
});

test('SQLite-format startedAt is UTC when binding history rows', () => {
  const root = tempRoot();
  try {
    fs.writeFileSync(path.join(root, 'history.jsonl'), JSON.stringify({
      display: 'hello', timestamp: CREATED_MS + 1_000, workspace: CWD, conversationId: OTHER_SID,
    }) + '\n');
    assert.equal(readAgyHistoryBinding(root, CWD, '2026-08-03 16:55:28'), OTHER_SID);
  } finally { cleanup(root); }
});

test('startedAt parser handles SQLite UTC, ISO-with-Z, and undefined', () => {
  assert.equal(parseStartedAtMs('2026-08-03 16:55:28'), Date.parse('2026-08-03T16:55:28Z'));
  assert.equal(parseStartedAtMs('2026-08-03T16:55:28.400Z'), CREATED_MS);
  assert.equal(parseStartedAtMs(undefined), 0);
});

test('fallback chooses newest post-start DB whose metadata cwd matches', () => {
  const root = tempRoot();
  try {
    createFixture(root, { sid: SID, cwd: 'C:\\other', mtimeMs: CREATED_MS + 30_000 });
    createFixture(root, { sid: OTHER_SID, rows: [{ idx: 0, type: 14, status: 3, payload: userPayload('cwd-match') }], mtimeMs: CREATED_MS + 20_000 });
    const user = readerAt(root).pollSession(session({ sessionId: '' })).find((e) => e.type === 'user-text');
    assert.ok(user?.type === 'user-text' && user.text === 'cwd-match');
  } finally { cleanup(root); }
});

test('SQLite-format startedAt is UTC when resolving by conversation DB mtime', () => {
  const root = tempRoot();
  try {
    createFixture(root, {
      sid: OTHER_SID,
      rows: [{ idx: 0, type: 14, status: 3, payload: userPayload('sqlite-floor-match') }],
      mtimeMs: CREATED_MS + 1_000,
    });
    const events = readerAt(root).pollSession(session({
      sessionId: '',
      startedAt: '2026-08-03 16:55:28',
    }));
    assert.ok(events.some((e) => e.type === 'user-text' && e.text === 'sqlite-floor-match'));
  } finally { cleanup(root); }
});

test('fallback rejects cwd matches older than the agent start floor', () => {
  const root = tempRoot();
  try {
    createFixture(root, { sid: SID, mtimeMs: CREATED_MS - 60_000 });
    const events = readerAt(root).pollSession(session({ sessionId: '', startedAt: new Date(CREATED_MS).toISOString() }));
    assert.deepEqual(events, []);
  } finally { cleanup(root); }
});

test('one-shot read returns disk history only for bound matching cwd', () => {
  const root = tempRoot();
  try {
    createFixture(root);
    const reader = readerAt(root);
    const events = reader.readSessionEventsOnce(CWD, SID);
    assert.ok(events?.some((e) => e.type === 'assistant-text'));
    assert.equal(reader.readSessionEventsOnce('C:\\wrong', SID), null);
    assert.equal(reader.readSessionEventsOnce(CWD, OTHER_SID), null);
  } finally { cleanup(root); }
});

test('sessionFileExists validates both id and workspace metadata', () => {
  const root = tempRoot();
  try {
    createFixture(root);
    const reader = readerAt(root);
    assert.equal(reader.sessionFileExists(CWD, SID), true);
    assert.equal(reader.sessionFileExists('C:\\wrong', SID), false);
    assert.equal(reader.sessionFileExists(CWD, OTHER_SID), false);
  } finally { cleanup(root); }
});

test('corrupt DB and malformed protobuf rows fail soft', () => {
  const root = tempRoot();
  const priorWarn = console.warn;
  console.warn = () => {};
  try {
    fs.mkdirSync(path.join(root, 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(root, 'conversations', `${SID}.db`), 'not sqlite');
    assert.deepEqual(readerAt(root).pollSession(session()), []);
    fs.rmSync(path.join(root, 'conversations', `${SID}.db`));
    createFixture(root, { rows: [{ idx: 0, type: 14, status: 3, payload: Buffer.from([0xff]) }] });
    assert.equal(readerAt(root).pollSession(session()).filter((e) => e.type === 'user-text').length, 0);
  } finally {
    console.warn = priorWarn;
    cleanup(root);
  }
});

test('read-only reader sees committed rows while another WAL connection is open', () => {
  const root = tempRoot();
  try {
    const dbPath = createFixture(root);
    const writer = new Database(dbPath);
    writer.pragma('journal_mode = WAL');
    writer.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)')
      .run(10, 14, 3, userPayload('from wal'));
    try {
      const events = readerAt(root).pollSession(session());
      assert.ok(events.some((e) => e.type === 'user-text' && e.text === 'from wal'));
    } finally { writer.close(); }
  } finally { cleanup(root); }
});

test('dispatcher registration delivers agy assistant messages to its ring', () => {
  const root = tempRoot();
  try {
    createFixture(root);
    const reader = readerAt(root);
    const dispatcher = new SessionLogDispatcher(() => [session()]);
    dispatcher.register(reader);
    dispatcher.pollNow('agent-1');
    assert.ok(dispatcher.getCachedEvents('agent-1').events.some((e) => e.type === 'assistant-text'));
  } finally { cleanup(root); }
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (error) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', error instanceof Error ? error.stack ?? error.message : error);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
