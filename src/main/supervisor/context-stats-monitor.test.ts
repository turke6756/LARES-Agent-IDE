// Self-contained tests for ContextStatsMonitor file-activity extraction.
//
//   npm run build:main
//   node dist/main/main/supervisor/context-stats-monitor.test.js

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ContextStatsMonitor, type JsonlFileActivity } from './context-stats-monitor';
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

function makeHarness(): {
  reader: FakeReader;
  monitor: ContextStatsMonitor;
  emitted: JsonlFileActivity[];
} {
  const reader = new FakeReader();
  const monitor = new ContextStatsMonitor(reader as any);
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

test('structured tool duplicate paths are deduped', () => {
  const { reader, emitted } = makeHarness();
  reader.emit('tool-use', toolUse('read_many_files', { paths: ['a.ts', 'a.ts'] }, 'tool-1'));
  reader.emit('tool-use', toolUse('read_file', { file_path: 'a.ts' }, 'tool-2'));
  assert.deepEqual(emitted, [{ agentId: 'agent-1', filePath: 'a.ts', operation: 'read' }]);
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

test('BUG-26: invalidateAgent clears seenFiles dedupe set (re-emit after rebind)', () => {
  const reader = new FakeReader();
  const monitor = new ContextStatsMonitor(reader as any);
  const emitted: JsonlFileActivity[] = [];
  monitor.on('fileActivity', (a) => emitted.push(a));
  monitor.start();

  reader.emit('tool-use', toolUse('read_file', { file_path: 'src/a.ts' }, 'tool-1'));
  reader.emit('tool-use', toolUse('read_file', { file_path: 'src/a.ts' }, 'tool-2'));
  assert.equal(emitted.length, 1, 'pre-rebind: second identical (op,path) deduped');

  monitor.invalidateAgent('agent-1');

  reader.emit('tool-use', toolUse('read_file', { file_path: 'src/a.ts' }, 'tool-3'));
  assert.equal(
    emitted.length,
    2,
    'post-rebind: same (op,path) re-emits because seenFiles was cleared (needed because deleteFileActivitiesForAgent wiped the DB row)'
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
