// Self-contained tests for ContextStatsMonitor file-activity extraction.
//
//   npm run build:main
//   node dist/main/main/supervisor/context-stats-monitor.test.js

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ContextStatsMonitor, normalizeCapturedPath, type JsonlFileActivity } from './context-stats-monitor';
import type { ToolResultEvent, ToolUseEvent, UsageEvent } from '../../shared/session-events';

class FakeReader extends EventEmitter {
  pollNow(): void {}
}

interface TestCase {
  name: string;
  run(): void | Promise<void>;
}

const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

function makeHarness(workspaceRoot?: string): {
  reader: FakeReader;
  monitor: ContextStatsMonitor;
  emitted: JsonlFileActivity[];
} {
  const reader = new FakeReader();
  const monitor = new ContextStatsMonitor(reader as any, workspaceRoot ? () => workspaceRoot : undefined);
  const emitted: JsonlFileActivity[] = [];
  monitor.on('fileActivity', (a) => emitted.push(a));
  monitor.start();
  return { reader, monitor, emitted };
}

function toolUse(toolName: string, input: unknown, toolUseId = 'tool-1'): ToolUseEvent {
  return {
    type: 'tool-use',
    uuid: `use:${toolUseId}`,
    timestamp: '2026-05-02T12:00:00.000Z',
    agentId: 'agent-1',
    toolUseId,
    toolName,
    input,
  };
}

function toolResult(toolUseId: string, content: string, isError = false): ToolResultEvent {
  return {
    type: 'tool-result',
    uuid: `result:${toolUseId}`,
    timestamp: '2026-05-02T12:00:01.000Z',
    agentId: 'agent-1',
    toolUseId,
    content,
    truncated: false,
    isError,
  };
}

test('Gemini read_file with file_path emits one read', () => {
  const { reader, emitted } = makeHarness();
  reader.emit('tool-use', toolUse('read_file', { file_path: 'src/a.ts' }));
  assert.deepEqual(emitted, [{ agentId: 'agent-1', filePath: 'src/a.ts', operation: 'read' }]);
});

test('Gemini read_many_files with paths emits multiple reads', () => {
  const { reader, emitted } = makeHarness();
  reader.emit('tool-use', toolUse('read_many_files', { paths: ['a.ts', 'b.ts'] }));
  assert.deepEqual(emitted, [
    { agentId: 'agent-1', filePath: 'a.ts', operation: 'read' },
    { agentId: 'agent-1', filePath: 'b.ts', operation: 'read' },
  ]);
});

test('Gemini read_many_files with file_paths ignores non-string members', () => {
  const { reader, emitted } = makeHarness();
  reader.emit('tool-use', toolUse('read_many_files', { file_paths: ['a.ts', 42, null, 'b.ts'] }));
  assert.deepEqual(emitted, [
    { agentId: 'agent-1', filePath: 'a.ts', operation: 'read' },
    { agentId: 'agent-1', filePath: 'b.ts', operation: 'read' },
  ]);
});

test('Grok structured and terminal tools capture a read and a write', () => {
  const { reader, emitted } = makeHarness('C:\\repo');
  reader.emit('tool-use', toolUse('read_file', { target_file: 'src/grok-read.ts' }, 'grok-read'));
  reader.emit('tool-use', toolUse('list_dir', { target_directory: 'src/grok-dir' }, 'grok-list'));
  reader.emit('tool-use', toolUse(
    'run_terminal_command',
    { command: 'Set-Content src/grok-write.ts -Value updated' },
    'grok-write',
  ));
  reader.emit('tool-result', toolResult('grok-write', 'exit: 0'));
  assert.deepEqual(emitted, [
    { agentId: 'agent-1', filePath: 'C:\\repo\\src\\grok-read.ts', operation: 'read' },
    { agentId: 'agent-1', filePath: 'C:\\repo\\src\\grok-dir', operation: 'read' },
    { agentId: 'agent-1', filePath: 'C:\\repo\\src\\grok-write.ts', operation: 'write' },
  ]);
});

test('Antigravity run_command captures CommandLine reads and writes using Cwd', () => {
  const { reader, emitted } = makeHarness();
  reader.emit('tool-use', toolUse(
    'run_command',
    { CommandLine: 'Get-Content src/agy-read.ts', Cwd: 'C:\\repo' },
    'agy-read',
  ));
  reader.emit('tool-result', toolResult('agy-read', 'read contents'));
  reader.emit('tool-use', toolUse(
    'run_command',
    { CommandLine: 'Set-Content src/agy-write.ts -Value updated', Cwd: 'C:\\repo' },
    'agy-write',
  ));
  reader.emit('tool-result', toolResult('agy-write', 'write complete'));
  assert.deepEqual(emitted, [
    { agentId: 'agent-1', filePath: 'C:\\repo\\src\\agy-read.ts', operation: 'read' },
    { agentId: 'agent-1', filePath: 'C:\\repo\\src\\agy-write.ts', operation: 'write' },
  ]);
});

test('newer Codex shell alias captures file activity', () => {
  const { reader, emitted } = makeHarness();
  reader.emit('tool-use', toolUse('shell', { command: 'Get-Content src/codex-read.ts', workdir: 'C:\\repo' }, 'codex-shell'));
  reader.emit('tool-result', toolResult('codex-shell', 'Exit code: 0\ncontents'));
  assert.deepEqual(emitted, [
    { agentId: 'agent-1', filePath: 'C:\\repo\\src\\codex-read.ts', operation: 'read' },
  ]);
});

test('unknown tool is still dropped', () => {
  const { reader, emitted } = makeHarness();
  reader.emit('tool-use', toolUse('unknown_file_tool', { file_path: 'src/ignored.ts' }));
  assert.deepEqual(emitted, []);
});

test('structured tool duplicate paths WITHIN ONE tool-use are deduped', () => {
  const { reader, emitted } = makeHarness();
  reader.emit('tool-use', toolUse('read_many_files', { paths: ['a.ts', 'a.ts'] }, 'tool-1'));
  assert.deepEqual(emitted, [{ agentId: 'agent-1', filePath: 'a.ts', operation: 'read' }]);
});

test('replaying the SAME tool-use id is deduped (idempotent replay guard)', () => {
  const { reader, emitted } = makeHarness();
  reader.emit('tool-use', toolUse('read_file', { file_path: 'a.ts' }, 'tool-1'));
  reader.emit('tool-use', toolUse('read_file', { file_path: 'a.ts' }, 'tool-1')); // replay, same id
  assert.deepEqual(emitted, [{ agentId: 'agent-1', filePath: 'a.ts', operation: 'read' }]);
});

// Fix rec-3: dedupe is TOOL-USE-ID scoped, NOT agent-lifetime. Two DISTINCT
// tool-use ids reading the same path (e.g. a later turn) BOTH emit; the old
// `op:path` lifetime key suppressed the second, hiding real later-turn work.
test('same (op,path) under DIFFERENT tool-use ids each emit (no lifetime suppression)', () => {
  const { reader, emitted } = makeHarness();
  reader.emit('tool-use', toolUse('read_file', { file_path: 'a.ts' }, 'tool-1'));
  reader.emit('tool-use', toolUse('read_file', { file_path: 'a.ts' }, 'tool-2'));
  assert.deepEqual(emitted, [
    { agentId: 'agent-1', filePath: 'a.ts', operation: 'read' },
    { agentId: 'agent-1', filePath: 'a.ts', operation: 'read' },
  ]);
});

// The review's exact repro: turn 1 read+edit a file, turn 2 read+edit the SAME
// file (same agent/session, distinct tool-use ids) → turn 2 MUST still emit
// witnessed rows. Under the old lifetime dedupe, turn 2 emitted zero.
test('review repro — repeated read+edit in a later turn still emits witnessed rows', () => {
  const { reader, emitted } = makeHarness();
  // Turn 1
  reader.emit('tool-use', toolUse('read_file', { file_path: 'src/a.ts' }, 't1-read'));
  reader.emit('tool-use', toolUse('replace', { file_path: 'src/a.ts' }, 't1-edit'));
  assert.equal(emitted.length, 2, 'turn 1 emits read + write');
  // Turn 2 — same file, new tool-use ids
  reader.emit('tool-use', toolUse('read_file', { file_path: 'src/a.ts' }, 't2-read'));
  reader.emit('tool-use', toolUse('replace', { file_path: 'src/a.ts' }, 't2-edit'));
  assert.deepEqual(
    emitted.slice(2),
    [
      { agentId: 'agent-1', filePath: 'src/a.ts', operation: 'read' },
      { agentId: 'agent-1', filePath: 'src/a.ts', operation: 'write' },
    ],
    'turn 2 re-emits both ops — no false-negative',
  );
});

test('apply_patch activity is emitted only after successful tool-result', () => {
  const { reader, emitted } = makeHarness();
  const patch = '*** Begin Patch\n*** Update File: src/foo.ts\n@@\n+const x = 1;\n*** End Patch';
  reader.emit('tool-use', toolUse('apply_patch', { input: patch, workdir: 'C:\\repo' }, 'patch-1'));
  assert.equal(emitted.length, 0, 'tool-use should only stash pending activity');
  reader.emit('tool-result', toolResult('patch-1', 'patch applied successfully'));
  assert.deepEqual(emitted, [{ agentId: 'agent-1', filePath: 'C:\\repo\\src\\foo.ts', operation: 'write' }]);
});

test('failed apply_patch result drops pending activity', () => {
  const { reader, emitted } = makeHarness();
  const patch = '*** Begin Patch\n*** Add File: src/new.ts\n+const x = 1;\n*** End Patch';
  reader.emit('tool-use', toolUse('apply_patch', { input: patch, workdir: 'C:\\repo' }, 'patch-1'));
  reader.emit('tool-result', toolResult('patch-1', 'Exit code: 1\nfailed'));
  assert.deepEqual(emitted, []);
});

// ── BUG-26 Layer 3: invalidateAgent ────────────────────────────────────

function makeUsage(agentId: string, sessionId: string, overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    type: 'usage',
    uuid: overrides.uuid ?? `usage:${Math.random()}`,
    timestamp: '2026-05-24T10:00:00.000Z',
    agentId,
    sessionId,
    model: 'openai/0.128.0',
    inputTokens: 100,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 50,
    cumulativeContextTokens: 150,
    contextWindowMax: 200_000,
    contextPercentage: 1,
    cachedTokens: 0,
    totalTokens: 150,
    ...overrides,
  };
}

test('BUG-26: invalidateAgent clears stats (getStats returns null)', () => {
  const { reader, monitor } = makeHarness();
  // Seed stats from a wrong-attribution usage event.
  reader.emit('usage', makeUsage('agent-1', 'wrong-session', {
    inputTokens: 9999, outputTokens: 9999, cumulativeContextTokens: 19_998, contextPercentage: 60,
  }));
  const before = monitor.getStats('agent-1');
  assert.ok(before, 'pre-condition: stats are populated');
  assert.equal(before.contextPercentage, 60, 'pre-condition: wrong 60% cached');

  monitor.invalidateAgent('agent-1');
  assert.equal(monitor.getStats('agent-1'), null, 'invalidateAgent drops cached stats');
});

test('last context reading survives monitor recreation and is cleared on session rebind', () => {
  const persisted = new Map<string, any>();
  const persistence = {
    load: (agentId: string) => persisted.get(agentId) ?? null,
    save: (stats: any) => persisted.set(stats.agentId, structuredClone(stats)),
    delete: (agentId: string) => { persisted.delete(agentId); },
  };

  const firstReader = new FakeReader();
  const first = new ContextStatsMonitor(firstReader as any, undefined, persistence);
  first.start();
  firstReader.emit('usage', makeUsage('agent-1', 'session-1', {
    cumulativeContextTokens: 84_000,
    contextPercentage: 42,
  }));

  // Simulate an app restart: the new monitor has no live in-memory reading.
  const restored = new ContextStatsMonitor(new FakeReader() as any, undefined, persistence);
  assert.equal(restored.getStats('agent-1')?.contextPercentage, 42);
  assert.equal(restored.getStats('agent-1')?.sessionId, 'session-1');

  // A rebound starts a new conversation, so the old session's bar must not be
  // restored while waiting for the new session's first real usage event.
  restored.invalidateAgent('agent-1');
  const afterRebind = new ContextStatsMonitor(new FakeReader() as any, undefined, persistence);
  assert.equal(afterRebind.getStats('agent-1'), null);
});

test('BUG-26: invalidateAgent does NOT emit statsChanged (next legitimate usage will)', () => {
  const reader = new FakeReader();
  const monitor = new ContextStatsMonitor(reader as any);
  let statsChangedCount = 0;
  monitor.on('statsChanged', () => { statsChangedCount += 1; });
  monitor.start();

  reader.emit('usage', makeUsage('agent-1', 'wrong'));
  assert.equal(statsChangedCount, 1, 'pre-condition: usage fired statsChanged once');

  monitor.invalidateAgent('agent-1');
  assert.equal(
    statsChangedCount,
    1,
    'invalidateAgent must NOT emit statsChanged — absence of stats is not a stats snapshot'
  );

  reader.emit('usage', makeUsage('agent-1', 'right'));
  assert.equal(statsChangedCount, 2, 'next legitimate usage repopulates and fires statsChanged');
});

test('BUG-26: invalidateAgent clears seenFiles dedupe set (SAME tool-use id re-emits after rebind)', () => {
  const reader = new FakeReader();
  const monitor = new ContextStatsMonitor(reader as any);
  const emitted: JsonlFileActivity[] = [];
  monitor.on('fileActivity', (a) => emitted.push(a));
  monitor.start();

  reader.emit('tool-use', toolUse('read_file', { file_path: 'src/a.ts' }, 'tool-1'));
  reader.emit('tool-use', toolUse('read_file', { file_path: 'src/a.ts' }, 'tool-1')); // replay same id
  assert.equal(emitted.length, 1, 'pre-rebind: replay of the same tool-use id deduped');

  monitor.invalidateAgent('agent-1');

  // After a rebind wiped the DB rows, a replay of the SAME tool-use id must
  // re-emit so the agent's own (now-correctly-attributed) activity re-inserts.
  reader.emit('tool-use', toolUse('read_file', { file_path: 'src/a.ts' }, 'tool-1'));
  assert.equal(
    emitted.length,
    2,
    'post-rebind: same tool-use id re-emits because seenFiles was cleared'
  );
});

test('BUG-26: invalidateAgent clears pendingShellActivity entries prefixed with agentId only', () => {
  const reader = new FakeReader();
  const monitor = new ContextStatsMonitor(reader as any);
  const emitted: JsonlFileActivity[] = [];
  monitor.on('fileActivity', (a) => emitted.push(a));
  monitor.start();

  // Seed two pending shell activities — one on agent-1, one on agent-2.
  const patch = '*** Begin Patch\n*** Update File: src/foo.ts\n@@\n+x\n*** End Patch';
  const apply1: ToolUseEvent = {
    type: 'tool-use', uuid: 'use:p1', timestamp: '2026-05-24T10:00:00.000Z',
    agentId: 'agent-1', toolUseId: 'p1', toolName: 'apply_patch',
    input: { input: patch, workdir: 'C:\\repo' },
  };
  const apply2: ToolUseEvent = {
    type: 'tool-use', uuid: 'use:p2', timestamp: '2026-05-24T10:00:00.000Z',
    agentId: 'agent-2', toolUseId: 'p2', toolName: 'apply_patch',
    input: { input: patch, workdir: 'C:\\repo' },
  };
  reader.emit('tool-use', apply1);
  reader.emit('tool-use', apply2);
  const pending = (monitor as any).pendingShellActivity as Map<string, unknown>;
  assert.equal(pending.has('agent-1:p1'), true, 'pre-condition: agent-1 pending entry set');
  assert.equal(pending.has('agent-2:p2'), true, 'pre-condition: agent-2 pending entry set');

  monitor.invalidateAgent('agent-1');
  assert.equal(pending.has('agent-1:p1'), false, 'agent-1 pending key dropped');
  assert.equal(pending.has('agent-2:p2'), true, 'agent-2 pending key untouched (no prefix collision)');
});

test('BUG-26: invalidateAgent on agent A does not touch agent B state', () => {
  const reader = new FakeReader();
  const monitor = new ContextStatsMonitor(reader as any);
  monitor.start();

  reader.emit('usage', makeUsage('agent-A', 'sess-A'));
  reader.emit('usage', makeUsage('agent-B', 'sess-B'));
  assert.ok(monitor.getStats('agent-A'));
  assert.ok(monitor.getStats('agent-B'));

  monitor.invalidateAgent('agent-A');
  assert.equal(monitor.getStats('agent-A'), null);
  assert.ok(monitor.getStats('agent-B'), 'agent-B stats survive invalidating agent-A');
});

// ── Fix rec-4: path normalization at ingress ────────────────────────────────

const WIN_ROOT = 'C:\\Users\\turke\\Projects\\AgentDashboard';
const WSL_ROOT = '/home/edward/agentdashboard';

function makeHarnessWithRoot(root: string | null): {
  reader: FakeReader;
  emitted: JsonlFileActivity[];
} {
  const reader = new FakeReader();
  const monitor = new ContextStatsMonitor(reader as any, () => root);
  const emitted: JsonlFileActivity[] = [];
  monitor.on('fileActivity', (a) => emitted.push(a));
  monitor.start();
  return { reader, emitted };
}

test('normalizeCapturedPath — relative resolved against Windows root → absolute', () => {
  assert.equal(
    normalizeCapturedPath('plans/example.html', WIN_ROOT),
    'C:\\Users\\turke\\Projects\\AgentDashboard\\plans\\example.html',
  );
});

test('normalizeCapturedPath — leading ./ stripped before resolve', () => {
  assert.equal(
    normalizeCapturedPath('./.dashboard/state.json', WIN_ROOT),
    'C:\\Users\\turke\\Projects\\AgentDashboard\\.dashboard\\state.json',
  );
});

test('normalizeCapturedPath — relative resolved against WSL/POSIX root (forward-slash join)', () => {
  assert.equal(
    normalizeCapturedPath('plans/example.html', WSL_ROOT),
    '/home/edward/agentdashboard/plans/example.html',
  );
});

test('normalizeCapturedPath — absolute paths pass through verbatim (Windows / WSL / UNC)', () => {
  assert.equal(normalizeCapturedPath('C:\\repo\\src\\foo.ts', WIN_ROOT), 'C:\\repo\\src\\foo.ts');
  assert.equal(normalizeCapturedPath('/home/edward/other/x.ts', WIN_ROOT), '/home/edward/other/x.ts');
  assert.equal(normalizeCapturedPath('\\\\server\\share\\x.ts', WIN_ROOT), '\\\\server\\share\\x.ts');
});

test('normalizeCapturedPath — no root → relative kept verbatim (best-effort)', () => {
  assert.equal(normalizeCapturedPath('plans/example.html', null), 'plans/example.html');
});

test('normalizeCapturedPath — empty / whitespace-only → null (quarantined)', () => {
  assert.equal(normalizeCapturedPath('', WIN_ROOT), null);
  assert.equal(normalizeCapturedPath('   ', WIN_ROOT), null);
});

test('ingress — relative plan/.dashboard paths are resolved to absolute before emit', () => {
  const { reader, emitted } = makeHarnessWithRoot(WIN_ROOT);
  reader.emit('tool-use', toolUse('read_file', { file_path: 'plans/example.html' }, 't1'));
  reader.emit('tool-use', toolUse('read_file', { file_path: '.dashboard/state.json' }, 't2'));
  assert.deepEqual(emitted.map((e) => e.filePath), [
    'C:\\Users\\turke\\Projects\\AgentDashboard\\plans\\example.html',
    'C:\\Users\\turke\\Projects\\AgentDashboard\\.dashboard\\state.json',
  ]);
});

test('ingress — an already-absolute captured path is unchanged', () => {
  const { reader, emitted } = makeHarnessWithRoot(WIN_ROOT);
  reader.emit('tool-use', toolUse('replace', { file_path: 'C:\\Users\\turke\\Projects\\AgentDashboard\\src\\a.ts' }, 't1'));
  assert.deepEqual(emitted, [
    { agentId: 'agent-1', filePath: 'C:\\Users\\turke\\Projects\\AgentDashboard\\src\\a.ts', operation: 'write' },
  ]);
});

test('ingress — a genuinely-outside relative path resolves under root (classification is repo-activity’s job)', () => {
  // Normalization only makes the path ABSOLUTE + workspace-anchored; whether it
  // lands inside/outside is decided later by repo-activity.toRel. A '../' escape
  // resolves above the root and will be flagged outside there.
  const { reader, emitted } = makeHarnessWithRoot(WIN_ROOT);
  reader.emit('tool-use', toolUse('read_file', { file_path: '../OtherRepo/x.ts' }, 't1'));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].filePath, 'C:\\Users\\turke\\Projects\\OtherRepo\\x.ts');
});

// ── Context Window Warning: recomputeContextWindows ────────────────────

test('recomputeContextWindows re-derives window+percentage and emits statsChanged', () => {
  const reader = new FakeReader();
  const monitor = new ContextStatsMonitor(reader as any);
  let statsChangedCount = 0;
  monitor.on('statsChanged', () => { statsChangedCount += 1; });
  monitor.start();

  // claude-opus resolves to the 1M window; the reader capped the gauge at 200K.
  reader.emit('usage', makeUsage('agent-1', 's1', {
    model: 'claude-opus-4-7',
    cumulativeContextTokens: 100_000,
    contextWindowMax: 200_000,
    contextPercentage: 50,
  }));
  assert.equal(statsChangedCount, 1);

  // Raise the cap to 400K → window 400K (< the 1M model window), 25%.
  monitor.recomputeContextWindows(() => 400_000);
  const stats = monitor.getStats('agent-1');
  assert.ok(stats);
  assert.equal(stats.contextWindowMax, 400_000);
  assert.equal(stats.contextPercentage, 25);
  assert.equal(statsChangedCount, 2, 'recompute emits statsChanged for the moved reading');

  // Same cap again → no change, no emission.
  monitor.recomputeContextWindows(() => 400_000);
  assert.equal(statsChangedCount, 2, 'a no-op recompute stays silent');
});

test('recomputeContextWindows never exceeds the model window and skips null (gemini) agents', () => {
  const reader = new FakeReader();
  const monitor = new ContextStatsMonitor(reader as any);
  monitor.start();

  // claude-sonnet-4-5 → 200K real window; a 1M cap must clamp to 200K.
  reader.emit('usage', makeUsage('agent-small', 's1', {
    model: 'claude-sonnet-4-5',
    cumulativeContextTokens: 100_000,
    contextWindowMax: 150_000,
    contextPercentage: 67,
  }));
  // gemini-style agent the caller opts out of via null.
  reader.emit('usage', makeUsage('agent-gemini', 's2', {
    model: 'gemini-2.5-pro',
    cumulativeContextTokens: 500_000,
    contextWindowMax: 1_000_000,
    contextPercentage: 50,
  }));

  monitor.recomputeContextWindows((agentId) => (agentId === 'agent-gemini' ? null : 1_000_000));
  assert.equal(monitor.getStats('agent-small')!.contextWindowMax, 200_000,
    'cap is min(model window, configured) — never the raw configured value');
  assert.equal(monitor.getStats('agent-small')!.contextPercentage, 50);
  assert.equal(monitor.getStats('agent-gemini')!.contextWindowMax, 1_000_000,
    'null from capForAgent leaves the reading untouched');
});

// ── WP-1b: grow-forever cap eviction (SEEN_UUID_MAX / SEEN_FILES_MAX /
//    PENDING_SHELL_MAX all = 6000) ───────────────────────────────────────────
//
// WB-10 mutation notes are inline: each test asserts the EXACT boundary (size
// === 6000, oldest evicted, newest retained). Removing a cap makes size 6001
// (fails); off-by-one on the constant fails the oldest/newest assertions.

const CAP = 6000;

test('WP-1b: seenUuids caps at 6000 (oldest evicted, newest retained)', () => {
  const { reader, monitor } = makeHarness();
  for (let i = 0; i < CAP + 1; i++) {
    reader.emit('usage', makeUsage('agent-1', 's', { uuid: `u${i}` }));
  }
  const seen = (monitor as any).seenUuids.get('agent-1') as Set<string>;
  assert.equal(seen.size, CAP, 'seenUuids bounded at exactly 6000');
  assert.equal(seen.has('u0'), false, 'oldest UUID evicted');
  assert.equal(seen.has(`u${CAP}`), true, 'newest UUID retained');
});

test('WP-1b: seenFiles caps at 6000 (oldest evicted, newest retained)', () => {
  const { reader, monitor } = makeHarness();
  // Each distinct toolUseId yields a distinct dedupe key.
  for (let i = 0; i < CAP + 1; i++) {
    reader.emit('tool-use', toolUse('read_file', { file_path: 'a.ts' }, `t${i}`));
  }
  const seen = (monitor as any).seenFiles.get('agent-1') as Set<string>;
  assert.equal(seen.size, CAP, 'seenFiles bounded at exactly 6000');
  assert.equal(seen.has(JSON.stringify(['t0', 'read', 'a.ts'])), false, 'oldest key evicted');
  assert.equal(seen.has(JSON.stringify([`t${CAP}`, 'read', 'a.ts'])), true, 'newest key retained');
});

test('WP-1b: pendingShellActivity caps at 6000 under missing-result traffic', () => {
  const { reader, monitor } = makeHarness();
  const patch = '*** Begin Patch\n*** Update File: src/foo.ts\n@@\n+x\n*** End Patch';
  // > 6000 apply_patch / shell_command tool-uses whose tool-results never arrive.
  for (let i = 0; i < CAP + 1; i++) {
    const name = i % 2 === 0 ? 'apply_patch' : 'shell_command';
    const input = name === 'apply_patch'
      ? { input: patch, workdir: 'C:\\repo' }
      : { command: 'cat src/foo.ts', workdir: 'C:\\repo' };
    reader.emit('tool-use', toolUse(name, input, `p${i}`));
  }
  const pending = (monitor as any).pendingShellActivity as Map<string, unknown>;
  assert.equal(pending.size, CAP, 'pendingShellActivity bounded at exactly 6000');
  assert.equal(pending.has('agent-1:p0'), false, 'oldest pending entry evicted');
  assert.equal(pending.has(`agent-1:p${CAP}`), true, 'newest pending entry retained');
});

test('WP-1b: invalidateAgent empties all three capped structures', () => {
  const { reader, monitor } = makeHarness();
  // Populate seenUuids + seenFiles + pendingShellActivity for agent-1.
  reader.emit('usage', makeUsage('agent-1', 's', { uuid: 'u1' }));
  reader.emit('tool-use', toolUse('read_file', { file_path: 'a.ts' }, 't1'));
  reader.emit('tool-use', toolUse('shell_command', { command: 'cat x', workdir: 'C:\\repo' }, 'p1'));
  assert.ok((monitor as any).seenUuids.get('agent-1'), 'pre: seenUuids populated');
  assert.ok((monitor as any).seenFiles.get('agent-1'), 'pre: seenFiles populated');
  assert.equal((monitor as any).pendingShellActivity.has('agent-1:p1'), true, 'pre: pending populated');

  monitor.invalidateAgent('agent-1');

  assert.equal((monitor as any).seenUuids.has('agent-1'), false, 'seenUuids cleared');
  assert.equal((monitor as any).seenFiles.has('agent-1'), false, 'seenFiles cleared');
  assert.equal((monitor as any).pendingShellActivity.has('agent-1:p1'), false, 'pendingShellActivity cleared');
});

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
