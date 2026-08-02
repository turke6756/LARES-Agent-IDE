// Save-card SC-WP-2B — resolved stamps reach allocation, including overlap re-open.

import assert from 'node:assert/strict';

import type { AllocateTurnFields, TurnRecord, TurnStatus } from '../database';
import type { GitCapability } from '../../shared/types';
import type { CaptureEdgeParams, EdgeCaptureResult } from './checkpoint-service';
import {
  TurnCoordinator,
  type CompletionSubscription,
  type CoordinatorTurnStore,
  type TurnContext,
} from './turn-coordinator';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

function capability(): GitCapability {
  return {
    resolution: { agentShell: { source: null, note: '' }, internal: null },
    repoState: 'repo', commonDir: '/repo/.git', commonDirQueueKey: '/repo',
    repoRoot: '/repo', workspacePrefix: '', protectedRoot: false, reason: 'ok', detail: null,
  };
}

class RecordingStore implements CoordinatorTurnStore {
  readonly allocations: AllocateTurnFields[] = [];
  readonly statuses = new Map<string, TurnStatus>();

  allocateAndInsertTurn(workspaceId: string, fields: AllocateTurnFields): TurnRecord {
    const id = `turn-${this.allocations.length + 1}`;
    this.allocations.push({ ...fields });
    this.statuses.set(id, 'open');
    return { id, workspaceId, status: 'open' } as TurnRecord;
  }
  updateTurnRecord(): TurnRecord | null { return null; }
  closeTurn(id: string, status: Exclude<TurnStatus, 'open'>): TurnRecord | null {
    this.statuses.set(id, status);
    return { id, status } as TurnRecord;
  }
  getTurnRecord(): TurnRecord | null { return null; }
  listTurnRecords(): TurnRecord[] { return []; }
}

class Completion implements CompletionSubscription {
  onTurnComplete(): () => void { return () => undefined; }
  beginTurn(): void { /* no-op */ }
  reset(): void { /* no-op */ }
}

const capture = async (p: CaptureEdgeParams): Promise<EdgeCaptureResult> => ({
  status: 'ready', edge: p.edge, turnId: p.turnId, oid: 'oid', ref: 'ref', ready: true,
  quality: p.quality, failureReason: null,
});

function ctx(planStamp: NonNullable<TurnContext['planStamp']>): TurnContext {
  return { workspaceId: 'ws-1', agentId: 'agent-1', capability: capability(), planStamp };
}

test('openTurn passes every resolved stamp field into allocateAndInsertTurn', async () => {
  const store = new RecordingStore();
  const coordinator = new TurnCoordinator({ capture, completion: new Completion(), store });
  await coordinator.beforeCheckpoint('agent-1', ctx({
    planId: 'plan-1', planItemId: null, source: 'explicit',
  }));
  assert.deepEqual(
    {
      planId: store.allocations[0].planId,
      planItemId: store.allocations[0].planItemId,
      planStampSource: store.allocations[0].planStampSource,
    },
    { planId: 'plan-1', planItemId: null, planStampSource: 'explicit' },
  );
});

test('overlap re-open stamps the NEW send context, not the interrupted turn', async () => {
  const store = new RecordingStore();
  const coordinator = new TurnCoordinator({ capture, completion: new Completion(), store });
  await coordinator.beforeCheckpoint('agent-1', ctx({
    planId: 'old-plan', planItemId: null, source: 'agent-default',
  }));
  await coordinator.beforeCheckpoint('agent-1', ctx({
    planId: null, planItemId: null, source: 'explicit-none',
  }));

  assert.equal(store.statuses.get('turn-1'), 'interrupted');
  assert.deepEqual(
    {
      planId: store.allocations[1].planId,
      planItemId: store.allocations[1].planItemId,
      planStampSource: store.allocations[1].planStampSource,
    },
    { planId: null, planItemId: null, planStampSource: 'explicit-none' },
  );
});

(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
