// BUG-26 Layer 2 + Layer 3 integration test — simulates the live repro
// where one codex agent's session.sessionId is empty (Designer) and the
// reader's cwd-fallback misattributes another peer's events under the
// Designer's id. After `rebindAgent('X')` fires, both the in-memory
// context-stats cache AND the `file_activities` DB rows must be purged;
// a subsequent correctly-attributed usage event must repopulate fresh stats.
//
// Wires the actual `SessionLogDispatcher` + `ContextStatsMonitor` and
// installs the same `'agent-rebound'` listener the supervisor installs in
// production (`index.ts` constructor). The `file_activities` DB role is
// played by a Map-backed stub with the same `addFileActivity` /
// `getFileActivities` / `deleteFileActivitiesForAgent` contract — the real
// `better-sqlite3` binding is built against Electron's Node ABI and cannot
// load under a plain `node` test runner, so the stub keeps the test
// hermetic. The wiring shape (handler → invalidate + delete + getter
// returns empty) is what BUG-26 Layer 2 needed.
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/bug-26-layer23-integration.test.js

import assert from 'node:assert/strict';
import { SessionLogDispatcher } from './session-log-dispatcher';
import { ContextStatsMonitor, type JsonlFileActivity } from './context-stats-monitor';
import type { ChatLogReader, ChatLogReaderSession } from './log-readers/types';
import type { SessionEvent, ToolUseEvent, UsageEvent } from '../../shared/session-events';
import type { FileOperation } from '../../shared/types';

class FakeReader implements ChatLogReader {
  readonly provider = 'codex' as const;
  queue: SessionEvent[] = [];
  pollSession(_session: ChatLogReaderSession): SessionEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }
  invalidatePath(_agentId: string): void {}
}

// Map-backed stand-in for the database module's file_activities table.
// Same contract surface as `src/main/database.ts`'s addFileActivity /
// getFileActivities / deleteFileActivitiesForAgent so the test exercises
// the supervisor's handler wiring without loading the native sqlite binding.
interface StubFileActivity { id: number; agentId: string; filePath: string; operation: FileOperation; }
function makeFileActivityStub() {
  let nextId = 1;
  const rows: StubFileActivity[] = [];
  return {
    addFileActivity(agentId: string, filePath: string, operation: FileOperation): StubFileActivity {
      const row = { id: nextId++, agentId, filePath, operation };
      rows.push(row);
      return row;
    },
    getFileActivities(agentId: string): StubFileActivity[] {
      return rows.filter(r => r.agentId === agentId);
    },
    deleteFileActivitiesForAgent(agentId: string): void {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].agentId === agentId) rows.splice(i, 1);
      }
    },
  };
}

interface TestCase {
  name: string;
  run(): void | Promise<void>;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

function makeYToolUse(agentIdTaggedAs: string, toolUseId: string, filePath: string): ToolUseEvent {
  // agentId here is the misattributed Designer id (X), because the
  // dispatcher tagged Y's events with X's id when X had sessionId='' and
  // the reader's cwd-fallback resolved to Y's rollout. This is the exact
  // shape that pre-BUG-26 produced.
  return {
    type: 'tool-use',
    uuid: `Ytuse:${toolUseId}`,
    timestamp: '2026-05-24T10:00:00.000Z',
    agentId: agentIdTaggedAs,
    toolUseId,
    toolName: 'read_file',
    input: { file_path: filePath },
  };
}

function makeYUsage(agentIdTaggedAs: string, uuid: string): UsageEvent {
  return {
    type: 'usage',
    uuid,
    timestamp: '2026-05-24T10:00:00.000Z',
    agentId: agentIdTaggedAs,
    sessionId: 'Y-session', // wrong session — Y's rollout
    model: 'openai/0.128.0',
    inputTokens: 88_888,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 1_234,
    cumulativeContextTokens: 90_122,
    contextWindowMax: 200_000,
    contextPercentage: 60,
    cachedTokens: 0,
    totalTokens: 90_122,
  };
}

function makeXUsage(uuid: string): UsageEvent {
  return {
    type: 'usage',
    uuid,
    timestamp: '2026-05-24T10:05:00.000Z',
    agentId: 'agent-X',
    sessionId: 'X-session', // correct session, post-rebind
    model: 'openai/0.128.0',
    inputTokens: 1_500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 200,
    cumulativeContextTokens: 1_700,
    contextWindowMax: 200_000,
    contextPercentage: 1,
    cachedTokens: 0,
    totalTokens: 1_700,
  };
}

// Wire the full producer chain the way the supervisor does in production
// (src/main/supervisor/index.ts, the `'agent-rebound'` listener installed
// next to the `contextStatsMonitor.on('fileActivity', …)` write path):
//   dispatcher → reader.pollSession → emits usage/tool-use
//   ContextStatsMonitor consumes those, emits fileActivity
//   handler writes file_activities rows (via stub)
//   dispatcher.on('agent-rebound') → invalidateAgent + deleteFileActivitiesForAgent
function wire(sessions: Array<{ agentId: string; sessionId: string; workingDirectory: string }>): {
  dispatcher: SessionLogDispatcher;
  monitor: ContextStatsMonitor;
  reader: FakeReader;
  db: ReturnType<typeof makeFileActivityStub>;
  fileActivitiesPurgedFor: string[];
} {
  const reader = new FakeReader();
  const dispatcher = new SessionLogDispatcher(
    () => sessions.map(s => ({ ...s, provider: 'codex' as const }))
  );
  dispatcher.register(reader);
  const monitor = new ContextStatsMonitor(dispatcher as any);
  monitor.start();
  const db = makeFileActivityStub();
  monitor.on('fileActivity', (activity: JsonlFileActivity) => {
    db.addFileActivity(activity.agentId, activity.filePath, activity.operation);
  });
  const fileActivitiesPurgedFor: string[] = [];
  dispatcher.on('agent-rebound', ({ agentId }) => {
    monitor.invalidateAgent(agentId);
    db.deleteFileActivitiesForAgent(agentId);
    fileActivitiesPurgedFor.push(agentId);
  });
  return { dispatcher, monitor, reader, db, fileActivitiesPurgedFor };
}

test('BUG-26 live-repro: rebindAgent purges both context-stats and file_activities for X', () => {
  const { dispatcher, monitor, reader, db, fileActivitiesPurgedFor } = wire([
    { agentId: 'agent-X', sessionId: '', workingDirectory: '/repo' },
  ]);

  // 1. Pre-rebind: reader returns Y's tool-use + usage tagged with X's id
  //    (because findByCwd resolved Y's rollout under X's empty sessionId).
  reader.queue.push(
    makeYToolUse('agent-X', 'Y-read-1', '/repo/secrets/Y_owned_file.txt'),
    makeYUsage('agent-X', 'Y-usage-pre-rebind'),
  );
  dispatcher.pollNow();

  // ContextStatsMonitor's cache now has X's `stats` populated with Y's
  // tokens (the live-capture 60% / cumulative-90k snapshot shape).
  const beforeStats = monitor.getStats('agent-X');
  assert.ok(beforeStats, 'pre-rebind: stats are misattributed to X');
  assert.equal(beforeStats.contextPercentage, 60, 'pre-rebind: wrong 60% cached under X');
  assert.equal(beforeStats.inputTokens, 88_888, 'pre-rebind: Y\'s input_tokens leaked under X');

  // file_activities DB has Y's read row inserted under X.
  const beforeFiles = db.getFileActivities('agent-X');
  assert.equal(beforeFiles.length, 1, 'pre-rebind: one wrong file_activities row under X');
  assert.equal(beforeFiles[0].filePath, '/repo/secrets/Y_owned_file.txt');

  // 2. Late binding: rebindAgent fires.
  dispatcher.rebindAgent('agent-X');

  // Layer 3 assertion: getStats('X') returns null (next legitimate usage
  // will repopulate; until then UI shows "no stats yet").
  assert.equal(monitor.getStats('agent-X'), null, 'post-rebind: stats cleared');

  // Layer 2 assertion: file_activities rows for X are gone.
  const afterFiles = db.getFileActivities('agent-X');
  assert.equal(afterFiles.length, 0, 'post-rebind: file_activities rows purged');

  // The supervisor handler did its work.
  assert.deepEqual(fileActivitiesPurgedFor, ['agent-X'], 'agent-rebound handler ran exactly once for X');
});

test('BUG-26 live-repro: post-rebind, a correctly-attributed usage event populates X\'s own stats', () => {
  const { dispatcher, monitor, reader } = wire([
    { agentId: 'agent-X', sessionId: '', workingDirectory: '/repo' },
  ]);

  // Pre-rebind misattribution as above.
  reader.queue.push(
    makeYToolUse('agent-X', 'Y-read-1', '/repo/secrets/Y_owned_file.txt'),
    makeYUsage('agent-X', 'Y-usage-pre-rebind'),
  );
  dispatcher.pollNow();
  assert.ok(monitor.getStats('agent-X'));

  // Rebind purges everything.
  dispatcher.rebindAgent('agent-X');
  assert.equal(monitor.getStats('agent-X'), null);

  // 3. The newly-bound rollout flushes a real usage event for X.
  reader.queue.push(makeXUsage('X-usage-post-rebind'));
  dispatcher.pollNow();

  const fresh = monitor.getStats('agent-X');
  assert.ok(fresh, 'post-rebind: next legitimate usage repopulates stats');
  assert.equal(fresh.sessionId, 'X-session', 'stats reflect X\'s own session id');
  assert.equal(fresh.inputTokens, 1_500, 'stats reflect X\'s own input_tokens (1.5k, not Y\'s 88k)');
  assert.equal(fresh.contextPercentage, 1, 'stats reflect X\'s own 1% (not Y\'s 60%)');
  assert.equal(fresh.turnCount, 1, 'turn count starts fresh after invalidate (not 2)');
});

test('BUG-26 live-repro: rebindAgent does not touch a sibling agent Y\'s state', () => {
  const { dispatcher, monitor, reader, db } = wire([
    { agentId: 'agent-X', sessionId: '', workingDirectory: '/repo' },
    { agentId: 'agent-Y', sessionId: 'Y-session', workingDirectory: '/repo' },
  ]);

  // Both agents accumulate legitimate state.
  reader.queue.push(
    {
      type: 'tool-use',
      uuid: 'Ytool:own',
      timestamp: '2026-05-24T10:01:00.000Z',
      agentId: 'agent-Y',
      toolUseId: 'Y-own-read',
      toolName: 'read_file',
      input: { file_path: '/repo/Y_real.txt' },
    } as ToolUseEvent,
    makeXUsage('X-usage'),
    {
      type: 'usage',
      uuid: 'Y-real-usage',
      timestamp: '2026-05-24T10:01:00.000Z',
      agentId: 'agent-Y',
      sessionId: 'Y-session',
      model: 'openai/0.128.0',
      inputTokens: 2_222,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 200,
      cumulativeContextTokens: 2_422,
      contextWindowMax: 200_000,
      contextPercentage: 1,
      cachedTokens: 0,
      totalTokens: 2_422,
    } as UsageEvent,
  );
  dispatcher.pollNow();
  assert.ok(monitor.getStats('agent-X'), 'pre: X has stats');
  assert.ok(monitor.getStats('agent-Y'), 'pre: Y has stats');
  assert.equal(db.getFileActivities('agent-Y').length, 1, 'pre: Y has its own file activity');

  // Rebind X only.
  dispatcher.rebindAgent('agent-X');

  assert.equal(monitor.getStats('agent-X'), null, 'post: X cleared');
  const ystats = monitor.getStats('agent-Y');
  assert.ok(ystats, 'post: Y stats untouched');
  assert.equal(ystats.inputTokens, 2_222, 'post: Y\'s own tokens preserved');
  assert.equal(db.getFileActivities('agent-Y').length, 1, 'post: Y\'s file_activities untouched');
  assert.equal(db.getFileActivities('agent-X').length, 0, 'post: X\'s file_activities purged');
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
      console.error('       ', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
