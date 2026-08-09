// SC-WP-1H — read-only Save-card IPC contract.
//
//   npm run build:main
//   node dist/main/main/commit-candidates/save-card-ipc.test.js

import assert from 'node:assert/strict';

import {
  registerSaveCardIpc,
  registerSaveCardIntentIpc,
  type IpcLike,
  type SaveCardRoutes,
} from './save-card-ipc';
import {
  SAVECARD_CHANNELS,
  SAVECARD_ADOPT_BASELINE_CHANNEL,
  type SaveCardInventoryRequest,
  type SaveCardInventoryResponse,
} from '../../shared/types';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}

const tests: TestCase[] = [];
function test(name: string, run: () => Promise<void> | void): void {
  tests.push({ name, run });
}

type Handler = (event: unknown, ...args: unknown[]) => unknown;

class FakeIpc implements IpcLike {
  readonly handlers = new Map<string, Handler>();

  handle(channel: string, listener: Handler): void {
    this.handlers.set(channel, listener);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  }
}

function inventoryFixture(): SaveCardInventoryResponse {
  return {
    intentUnits: [],
    unwitnessed: [],
    legacyTaskIdentityUnavailable: [],
    legacyFinalizations: [],
    planningActivities: [],
    quotaWeakening: null,
  };
}

test('audit: registers exactly the one conventionally named read channel and no mutating channel', () => {
  const ipc = new FakeIpc();
  registerSaveCardIpc(ipc, () => null);

  assert.equal(SAVECARD_CHANNELS.getInventory, 'savecard:getInventory');
  assert.deepEqual([...ipc.handlers.keys()], ['savecard:getInventory']);
  assert.deepEqual(Object.values(SAVECARD_CHANNELS), ['savecard:getInventory']);
});

test('inventory fetch round-trips through the lazy routes getter', async () => {
  const ipc = new FakeIpc();
  let routes: SaveCardRoutes | null = null;
  const calls: SaveCardInventoryRequest[] = [];
  registerSaveCardIpc(ipc, () => routes);

  const expected = inventoryFixture();
  routes = {
    getInventory: async (req) => {
      calls.push(req);
      return expected;
    },
  };

  const actual = await ipc.invoke(
    SAVECARD_CHANNELS.getInventory,
    { workspaceId: 'ws-1', ignoredRendererField: 'not-forwarded' },
  );
  assert.deepEqual(actual, expected);
  assert.deepEqual(calls, [{ workspaceId: 'ws-1' }]);
});

test('production intent registration invokes the main-owned baseline route', async () => {
  const ipc = new FakeIpc();
  const calls: SaveCardInventoryRequest[] = [];
  registerSaveCardIntentIpc(ipc, () => ({
    getInventory: async () => inventoryFixture(),
    adoptAllAsBaseline: async (req) => {
      calls.push(req);
      return { intentId: 'intent-baseline', title: 'Baseline 2026-08-09', memberCount: 3 };
    },
  }));
  assert.ok(ipc.handlers.get(SAVECARD_ADOPT_BASELINE_CHANNEL),
    'production registerSaveCardIntentIpc must register baseline adoption');
  const response = await ipc.invoke(SAVECARD_ADOPT_BASELINE_CHANNEL, {
    workspaceId: 'ws-1', rendererInjectedMembers: ['forbidden'],
  });
  assert.deepEqual(calls, [{ workspaceId: 'ws-1' }]);
  assert.deepEqual(response, {
    intentId: 'intent-baseline', title: 'Baseline 2026-08-09', memberCount: 3,
  });
});

test('rejects malformed inventory requests before calling the route', async () => {
  const ipc = new FakeIpc();
  let calls = 0;
  registerSaveCardIpc(ipc, () => ({
    getInventory: async () => {
      calls++;
      return inventoryFixture();
    },
  }));

  await assert.rejects(
    () => ipc.invoke(SAVECARD_CHANNELS.getInventory, null),
    /non-empty workspaceId/i,
  );
  await assert.rejects(
    () => ipc.invoke(SAVECARD_CHANNELS.getInventory, { workspaceId: '' }),
    /non-empty workspaceId/i,
  );
  assert.equal(calls, 0);
});

test('an unwired Save-card engine answers unavailable honestly', async () => {
  const ipc = new FakeIpc();
  registerSaveCardIpc(ipc, () => null);

  await assert.rejects(
    () => ipc.invoke(SAVECARD_CHANNELS.getInventory, { workspaceId: 'ws-1' }),
    /save-card engine unavailable|bootstrapping/i,
  );
});

(async () => {
  let failed = 0;
  for (const entry of tests) {
    try {
      await entry.run();
      console.log(`  ✓ ${entry.name}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${entry.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} save-card-ipc tests passed`);
})();
