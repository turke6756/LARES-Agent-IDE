// Dead-agent chat history: disk fallback + ring release.
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/agent-chat-history.test.js

import assert from 'node:assert/strict';
import {
  resolveAgentChatEvents,
  isTerminalChatStatus,
  type ChatHistoryAgent,
  type ChatHistoryDeps,
} from './agent-chat-history';
import { SessionLogDispatcher } from './session-log-dispatcher';
import type { ChatLogReader, ChatLogReaderSession } from './log-readers/types';
import type { SessionEvent, UserTextEvent } from '../../shared/session-events';

interface TestCase {
  name: string;
  run(): void | Promise<void>;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

// NOTE `agentId` matters for the dispatcher tests below: the dedupe map is
// keyed on the EVENT's agentId (`markEventUuidSeen(ev.agentId, …)`), while
// `forgetAgent`/`rebindAgent` delete by the dispatcher's agent id. Those are
// the same id in production (readers stamp events with the polled session's
// agent id), but a fixture that mismatches them silently swallows re-reads.
function ev(uuid: string, text: string, agentId = 'a1'): UserTextEvent {
  return {
    type: 'user-text',
    uuid,
    timestamp: '2026-07-20T10:00:00.000Z',
    agentId,
    text,
  };
}

interface Recorder {
  deps: ChatHistoryDeps;
  polled: string[];
  diskReads: Array<[string, string, string]>;
}

function makeDeps(opts: {
  agent?: ChatHistoryAgent | null;
  ring?: SessionEvent[];
  truncated?: boolean;
  disk?: SessionEvent[] | null;
}): Recorder {
  const polled: string[] = [];
  const diskReads: Array<[string, string, string]> = [];
  const ring = opts.ring ?? [];
  return {
    polled,
    diskReads,
    deps: {
      getAgent: () => (opts.agent === undefined ? liveAgent : opts.agent),
      getCachedEvents: (_id, since) => {
        if (!since) return { events: ring.slice(), truncated: opts.truncated ?? false };
        const idx = ring.findIndex((e) => e.uuid === since);
        return {
          events: idx < 0 ? ring.slice() : ring.slice(idx + 1),
          truncated: opts.truncated ?? false,
        };
      },
      pollNow: (id) => polled.push(id),
      readPriorSessionEvents: (p, wd, sid) => {
        diskReads.push([p, wd, sid]);
        return opts.disk ?? null;
      },
    },
  };
}

const liveAgent: ChatHistoryAgent = {
  status: 'working',
  provider: 'claude',
  workingDirectory: '/repo',
  resumeSessionId: 'sess-1',
};
const deadAgent: ChatHistoryAgent = { ...liveAgent, status: 'done' };

// ── Terminal-status predicate ────────────────────────────────────────

test('isTerminalChatStatus: only done/crashed are terminal', () => {
  assert.equal(isTerminalChatStatus('done'), true);
  assert.equal(isTerminalChatStatus('crashed'), true);
  // `restarting` is the status every same-id revival path passes through — it
  // must NOT read as terminal or a restarting agent would lose its live ring.
  for (const s of ['working', 'idle', 'waiting', 'launching', 'restarting', '', null, undefined]) {
    assert.equal(isTerminalChatStatus(s), false, `${s} must not be terminal`);
  }
});

// ── Live agents keep the existing behavior exactly ───────────────────

test('live agent reads the RAM ring and never touches disk', () => {
  const r = makeDeps({ agent: liveAgent, ring: [ev('u1', 'hi')], disk: [ev('d1', 'from disk')] });
  const out = resolveAgentChatEvents(r.deps, 'a1', { pollLive: true });
  assert.equal(out.source, 'live');
  assert.deepEqual(out.events.map((e) => e.uuid), ['u1']);
  assert.deepEqual(r.polled, ['a1'], 'pollLive forces a fresh tail');
  assert.equal(r.diskReads.length, 0, 'a live agent must never hit the disk reader');
});

test('pollLive:false does not force a poll', () => {
  const r = makeDeps({ agent: liveAgent, ring: [ev('u1', 'hi')] });
  const out = resolveAgentChatEvents(r.deps, 'a1');
  assert.equal(out.source, 'live');
  assert.deepEqual(r.polled, []);
});

test('renderer history hydration force-polls live Grok and Agy agents before returning records', () => {
  for (const provider of ['grok', 'agy'] as const) {
    const polled: string[] = [];
    let ring: SessionEvent[] = [];
    const deps: ChatHistoryDeps = {
      getAgent: () => ({ ...liveAgent, provider }),
      getCachedEvents: () => ({ events: ring, truncated: false }),
      pollNow: (id) => {
        polled.push(id);
        // Model the provider reader filling the shared structured-event ring.
        ring = [ev(`${provider}-user`, `hello from ${provider}`)];
      },
      readPriorSessionEvents: () => null,
    };

    const out = resolveAgentChatEvents(deps, 'a1', { pollLive: true });
    assert.deepEqual(polled, ['a1'], `${provider} hydration must poll its reader`);
    assert.equal(out.source, 'live');
    assert.deepEqual(out.events.map((event) => event.uuid), [`${provider}-user`]);
  }
});

// ── Dead agents come off disk ────────────────────────────────────────

test('dead agent with an EMPTY ring still returns its history, read from disk', () => {
  // This is the reported bug: after `forgetAgent` (or an app restart) the ring
  // is empty and `pollNow` is a no-op for a terminal agent, so the pane and
  // `read_agent_chat` both went blank despite an intact session log on disk.
  const r = makeDeps({ agent: deadAgent, ring: [], disk: [ev('d1', 'past turn'), ev('d2', 'reply')] });
  const out = resolveAgentChatEvents(r.deps, 'a1', { pollLive: true });
  assert.equal(out.source, 'disk');
  assert.deepEqual(out.events.map((e) => e.uuid), ['d1', 'd2']);
  assert.deepEqual(r.diskReads, [['claude', '/repo', 'sess-1']]);
  assert.deepEqual(r.polled, [], 'never force-poll a terminal agent — it is a no-op by construction');
});

test('dead agent: disk wins over a stale warm ring', () => {
  // The ring at the moment of death is capped at RING_BUFFER_MAX and can be a
  // truncated tail; the session log is complete. Prefer disk.
  const r = makeDeps({ agent: deadAgent, ring: [ev('u9', 'tail only')], disk: [ev('d1', 'a'), ev('d2', 'b')] });
  const out = resolveAgentChatEvents(r.deps, 'a1');
  assert.equal(out.source, 'disk');
  assert.deepEqual(out.events.map((e) => e.uuid), ['d1', 'd2']);
});

test('renderer history route returns terminal Grok and Agy records from the shared disk path', () => {
  for (const provider of ['grok', 'agy'] as const) {
    const records = [ev(`${provider}-user`, `past ${provider} turn`)];
    const r = makeDeps({ agent: { ...deadAgent, provider }, ring: [], disk: records });
    const out = resolveAgentChatEvents(r.deps, 'a1', { pollLive: true });

    assert.equal(out.source, 'disk');
    assert.deepEqual(out.events, records);
    assert.deepEqual(r.diskReads, [[provider, '/repo', 'sess-1']]);
    assert.deepEqual(r.polled, [], `${provider} terminal history must not poll a dead runner`);
  }
});

test('dead agent: sinceUuid slices the disk read exactly like the live ring', () => {
  const r = makeDeps({ agent: deadAgent, disk: [ev('d1', 'a'), ev('d2', 'b'), ev('d3', 'c')] });
  assert.deepEqual(
    resolveAgentChatEvents(r.deps, 'a1', { sinceUuid: 'd1' }).events.map((e) => e.uuid),
    ['d2', 'd3'],
  );
  // Unknown uuid → FULL list (caller re-syncs), matching getCachedEvents.
  assert.deepEqual(
    resolveAgentChatEvents(r.deps, 'a1', { sinceUuid: 'nope' }).events.map((e) => e.uuid),
    ['d1', 'd2', 'd3'],
  );
});

// ── Graceful degradation ─────────────────────────────────────────────

test('dead agent on a provider with no one-shot reader degrades to `unavailable`', () => {
  // codex/gemini today: readPriorSessionEvents returns null. The pane must be
  // able to say "history not available" rather than render a silent empty chat.
  const r = makeDeps({ agent: { ...deadAgent, provider: 'codex' }, ring: [], disk: null });
  const out = resolveAgentChatEvents(r.deps, 'a1');
  assert.equal(out.source, 'unavailable');
  assert.deepEqual(out.events, []);
});

test('dead agent with no resumeSessionId never attempts a disk read', () => {
  const r = makeDeps({ agent: { ...deadAgent, resumeSessionId: null }, ring: [], disk: null });
  const out = resolveAgentChatEvents(r.deps, 'a1');
  assert.equal(out.source, 'unavailable');
  assert.equal(r.diskReads.length, 0);
});

test('dead agent, disk unavailable but ring still warm: serve the ring, not an empty pane', () => {
  // Between the status flip and the deferred release, or for a pruned session
  // file, whatever is still in RAM beats nothing.
  const r = makeDeps({ agent: { ...deadAgent, provider: 'gemini' }, ring: [ev('u1', 'hi')], disk: null });
  const out = resolveAgentChatEvents(r.deps, 'a1');
  assert.equal(out.source, 'live');
  assert.deepEqual(out.events.map((e) => e.uuid), ['u1']);
});

test('unknown agent id returns empty without throwing', () => {
  const r = makeDeps({ agent: null });
  const out = resolveAgentChatEvents(r.deps, 'ghost');
  assert.deepEqual(out.events, []);
  assert.equal(out.truncated, false);
});

// ── The release half: SessionLogDispatcher.forgetAgent ───────────────

class FakeReader implements ChatLogReader {
  readonly provider = 'codex' as const;
  queue: SessionEvent[] = [];
  invalidated: string[] = [];
  pollSession(_s: ChatLogReaderSession): SessionEvent[] {
    const out = this.queue;
    this.queue = [];
    return out;
  }
  invalidatePath(agentId: string): void {
    this.invalidated.push(agentId);
  }
}

function makeDispatcher() {
  const reader = new FakeReader();
  const dispatcher = new SessionLogDispatcher(() => [
    { agentId: 'agent-1', sessionId: 'sess-1', workingDirectory: '/repo', provider: 'codex' as const },
  ]);
  dispatcher.register(reader);
  return { dispatcher, reader };
}

test('forgetAgent empties the ring and delegates invalidatePath to every reader', () => {
  const { dispatcher, reader } = makeDispatcher();
  reader.queue.push(ev('u1', 'hello', 'agent-1'));
  dispatcher.pollNow('agent-1');
  assert.equal(dispatcher.getCachedEvents('agent-1').events.length, 1, 'ring populated by the poll');

  dispatcher.forgetAgent('agent-1');
  assert.equal(dispatcher.getCachedEvents('agent-1').events.length, 0, 'ring released');
  assert.deepEqual(reader.invalidated, ['agent-1'], 'reader file offsets dropped too');
});

test('forgetAgent is idempotent and safe for an unknown agent', () => {
  const { dispatcher } = makeDispatcher();
  dispatcher.forgetAgent('never-seen');
  dispatcher.forgetAgent('never-seen');
  assert.deepEqual(dispatcher.getCachedEvents('never-seen').events, []);
});

test('forgetAgent does NOT emit agent-rebound', () => {
  // `rebindAgent` clears the same maps but also fires 'agent-rebound', which
  // purges context stats + file_activities. That is a misattribution repair —
  // firing it on every stop would wipe a dead agent's derived history.
  const { dispatcher } = makeDispatcher();
  let rebounds = 0;
  dispatcher.on('agent-rebound', () => rebounds++);
  dispatcher.forgetAgent('agent-1');
  assert.equal(rebounds, 0);
});

test('forgetAgent clears the seen-uuid set, so a later re-read is not swallowed', () => {
  // The dedupe set must go with the ring: if it survived, a resurrected or
  // re-polled agent's events would be dropped as "already seen" and the chat
  // would silently stay empty.
  const { dispatcher, reader } = makeDispatcher();
  const e = ev('u1', 'hello', 'agent-1');
  reader.queue.push(e);
  dispatcher.pollNow('agent-1');
  dispatcher.forgetAgent('agent-1');

  reader.queue.push(e); // same uuid again
  dispatcher.pollNow('agent-1');
  assert.equal(dispatcher.getCachedEvents('agent-1').events.length, 1, 're-read accepted after forget');
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
