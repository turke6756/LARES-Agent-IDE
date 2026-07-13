// Unit tests for the D3 hydration coordinator (plan §5 D3.3). Pure module — the
// Electron-coupled restore is injected. Covers: already-live fast path, single
// restoration under two concurrent verbs, structured failure (resolved error and
// thrown error), restored:true propagation, retry after a failed restore.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/browser/agent-tab-hydration.test.js

import assert from 'node:assert/strict';
import {
  TabHydrationCoordinator,
  type HydrationResult,
} from './agent-tab-hydration';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

/** A restore that resolves only when we tell it to — lets two callers overlap on
 *  one in-flight restoration deterministically. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('fast-returns restored:false for an already-live tab (restore not called)', async () => {
  let calls = 0;
  const coord = new TabHydrationCoordinator({
    isDiscarded: () => false,
    restore: async (tabId) => {
      calls++;
      return { tabId, restored: true };
    },
  });
  const res = await coord.ensureHydrated('t1');
  assert.deepEqual(res, { tabId: 't1', restored: false });
  assert.equal(calls, 0);
});

test('restores a discarded tab and propagates restored:true', async () => {
  const coord = new TabHydrationCoordinator({
    isDiscarded: () => true,
    restore: async (tabId) => ({ tabId, restored: true }),
  });
  const res = await coord.ensureHydrated('t1');
  assert.deepEqual(res, { tabId: 't1', restored: true });
});

test('serializes two concurrent verbs on ONE restoration', async () => {
  let calls = 0;
  const gate = deferred<HydrationResult>();
  const coord = new TabHydrationCoordinator({
    isDiscarded: () => true,
    restore: (tabId) => {
      calls++;
      return gate.promise.then((r) => ({ ...r, tabId }));
    },
  });
  const p1 = coord.ensureHydrated('t1');
  const p2 = coord.ensureHydrated('t1');
  assert.equal(coord.isRestoring('t1'), true);
  gate.resolve({ tabId: 't1', restored: true });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(calls, 1); // exactly one restoration
  assert.deepEqual(r1, { tabId: 't1', restored: true });
  assert.deepEqual(r2, { tabId: 't1', restored: true });
  assert.equal(coord.isRestoring('t1'), false);
});

test('returns the structured error a failed restore RESOLVES with', async () => {
  const coord = new TabHydrationCoordinator({
    isDiscarded: () => true,
    restore: async (tabId) => ({
      tabId,
      restored: false,
      error: { code: 'load-timeout', message: 'restore did not commit in 8000ms' },
    }),
  });
  const res = await coord.ensureHydrated('t1');
  assert.equal(res.restored, false);
  assert.deepEqual(res.error, { code: 'load-timeout', message: 'restore did not commit in 8000ms' });
});

test('converts a THROWN restore error into a structured result (never hangs)', async () => {
  const coord = new TabHydrationCoordinator({
    isDiscarded: () => true,
    restore: async () => {
      throw new Error('renderer spawn failed under pressure');
    },
  });
  const res = await coord.ensureHydrated('t1');
  assert.equal(res.restored, false);
  assert.equal(res.error?.code, 'restore-failed');
  assert.ok(res.error?.message.includes('renderer spawn failed'));
});

test('clears in-flight state so a later verb can retry a failed restore', async () => {
  let attempt = 0;
  const coord = new TabHydrationCoordinator({
    isDiscarded: () => true,
    restore: async (tabId) => {
      attempt++;
      if (attempt === 1) throw new Error('transient');
      return { tabId, restored: true };
    },
  });
  const first = await coord.ensureHydrated('t1');
  assert.equal(first.error?.code, 'restore-failed');
  const second = await coord.ensureHydrated('t1');
  assert.deepEqual(second, { tabId: 't1', restored: true });
  assert.equal(attempt, 2);
});

// ── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(err instanceof Error ? err.stack : String(err));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} agent-tab-hydration tests passed`);
})();
