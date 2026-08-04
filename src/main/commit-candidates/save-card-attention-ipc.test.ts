// SC-WP-N2 — checkpoint-expiry attention IPC (read + push) contract.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/save-card-attention-ipc.test.js

import assert from 'node:assert/strict';

import {
  registerSaveCardAttentionIpc,
  broadcastSaveCardAttention,
  type IpcLike,
  type SaveCardAttentionProvider,
  type AttentionSenderLike,
} from './save-card-ipc';
import {
  SAVECARD_CHANNELS,
  SAVECARD_ATTENTION_CHANNEL,
  SAVECARD_ATTENTION_CHANGED_CHANNEL,
  type SaveCardCheckpointExpiryNotice,
  type SaveCardAttentionChangedPayload,
} from '../../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void { tests.push({ name, run }); }

type Handler = (event: unknown, ...args: unknown[]) => unknown;

class FakeIpc implements IpcLike {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, listener: Handler): void { this.handlers.set(channel, listener); }
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  }
}

class FakeSender implements AttentionSenderLike {
  readonly sent: Array<{ channel: string; payload: SaveCardAttentionChangedPayload }> = [];
  send(channel: string, payload: SaveCardAttentionChangedPayload): void {
    this.sent.push({ channel, payload });
  }
}

function noticeFixture(workspaceId = 'ws-1'): SaveCardCheckpointExpiryNotice {
  return {
    observedAt: 1000,
    expiresWithinMs: 60_000,
    edges: [{
      repositoryKey: `repo-of-${workspaceId}`,
      turnId: 'turn-1',
      edge: 'after',
      expiresAt: 2000,
      affectedEntryIds: ['entry-1'],
    }],
  };
}

test('read channel is registered on its own channel, NOT folded into SAVECARD_CHANNELS', () => {
  const ipc = new FakeIpc();
  registerSaveCardAttentionIpc(ipc, () => null);
  assert.equal(ipc.handlers.has(SAVECARD_ATTENTION_CHANNEL), true);
  // The Stage ① audit invariant: getInventory stays the ONLY route in SAVECARD_CHANNELS.
  assert.notEqual(SAVECARD_ATTENTION_CHANNEL, SAVECARD_CHANNELS.getInventory);
});

test('read resolves the provider per workspace and returns its notice', async () => {
  const ipc = new FakeIpc();
  const store = new Map<string, SaveCardCheckpointExpiryNotice>([['ws-1', noticeFixture('ws-1')]]);
  const provider: SaveCardAttentionProvider = (id) => store.get(id) ?? null;
  registerSaveCardAttentionIpc(ipc, () => provider);

  const hit = await ipc.invoke(SAVECARD_ATTENTION_CHANNEL, { workspaceId: 'ws-1' });
  assert.deepEqual(hit, noticeFixture('ws-1'));
  const miss = await ipc.invoke(SAVECARD_ATTENTION_CHANNEL, { workspaceId: 'ws-2' });
  assert.equal(miss, null);
});

test('read answers null (never throws) before the provider is injected', async () => {
  const ipc = new FakeIpc();
  registerSaveCardAttentionIpc(ipc, () => null);
  const result = await ipc.invoke(SAVECARD_ATTENTION_CHANNEL, { workspaceId: 'ws-1' });
  assert.equal(result, null);
});

test('read rejects a request without a non-empty workspaceId', async () => {
  const ipc = new FakeIpc();
  registerSaveCardAttentionIpc(ipc, () => () => noticeFixture());
  await assert.rejects(() => ipc.invoke(SAVECARD_ATTENTION_CHANNEL, {}), /workspaceId/);
  await assert.rejects(() => ipc.invoke(SAVECARD_ATTENTION_CHANNEL, { workspaceId: '' }), /workspaceId/);
  await assert.rejects(() => ipc.invoke(SAVECARD_ATTENTION_CHANNEL, null), /workspaceId/);
});

test('push broadcasts the workspace-keyed payload on the changed channel', () => {
  const sender = new FakeSender();
  const notice = noticeFixture('ws-9');
  broadcastSaveCardAttention(sender, 'ws-9', notice);
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0].channel, SAVECARD_ATTENTION_CHANGED_CHANNEL);
  assert.deepEqual(sender.sent[0].payload, { workspaceId: 'ws-9', notice });
});

test('push carries a null notice (the cleared-attention case)', () => {
  const sender = new FakeSender();
  broadcastSaveCardAttention(sender, 'ws-9', null);
  assert.deepEqual(sender.sent[0].payload, { workspaceId: 'ws-9', notice: null });
});

(async () => {
  let failures = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`ok - ${t.name}`); }
    catch (err) { failures++; console.error(`not ok - ${t.name}`); console.error(err); }
  }
  if (failures > 0) process.exitCode = 1;
  else console.log(`\n${tests.length} attention-ipc tests passed`);
})();
