// Save-card SC-WP-2D — orchestration run-frozen binding, including follow-ups.
//   npm run build:main
//   node dist/main/main/orchestration/orchestration-binding.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DispatchContext } from '../git-checkpoints/dispatch-context';
import type { DashboardClient, OrchestrationRun } from './types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

type SqlJsDatabase = {
  exec(sql: string): unknown;
  run(sql: string, params?: unknown[]): unknown;
  prepare(sql: string): {
    bind(params: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  };
};
let sqlJsCtor: new () => SqlJsDatabase;

class FakeBetterSqlite {
  private db = new sqlJsCtor();
  pragma(_sql: string): unknown { return undefined; }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : undefined; }
        finally { stmt.free(); }
      },
      all: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          const rows: Record<string, unknown>[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows;
        } finally { stmt.free(); }
      },
    };
  }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) { return (...args: A) => fn(...args); }
  close(): void {}
}

function makeRun(overrides: Partial<OrchestrationRun> = {}): OrchestrationRun {
  return {
    runId: 'binding-run', name: 'groupthink', mode: 'serial', status: 'running',
    workspaceId: 'ws-1', supervisorId: 'supervisor-1', topic: 'Binding test',
    planPath: path.join(os.tmpdir(), `orchestration-binding-${process.pid}.md`),
    leadProvider: 'claude', reviewerProvider: 'codex', turnTimeoutMs: 1000,
    lastRelayedTs: {}, startedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z', submitRecoveryPolicy: 'raw',
    recoveryRepollMs: 5,
    ...overrides,
  };
}

(async () => {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;
  const sqlitePath = require.resolve('better-sqlite3');
  require.cache[sqlitePath] = {
    id: sqlitePath, filename: sqlitePath, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  const db = require('../database') as typeof import('../database');
  const { getOrchestrationDispatch, runSerial } = require('./groupthink-v2') as typeof import('./groupthink-v2');
  const { createDashboardClient } = require('./dashboard-client') as typeof import('./dashboard-client');
  const { buildDispatchTurnContext } = require('../git-checkpoints/dispatch-context') as typeof import('../git-checkpoints/dispatch-context');
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestration-binding-db-'));
  process.env.APPDATA = tmpAppData;
  db.initDatabase();

  test('orchestrations persist and expose explicit/default run bindings', () => {
    const explicit = makeRun({ runId: 'explicit-db', planId: 'plan-explicit', planBindingMode: 'explicit' });
    const defaulted = makeRun({ runId: 'default-db', planBindingMode: 'agent-default' });
    db.insertOrchestration(explicit);
    db.insertOrchestration(defaulted);
    assert.deepEqual(db.getOrchestrationBinding(explicit.runId), {
      planId: 'plan-explicit', planItemId: null, mode: 'explicit',
    });
    assert.deepEqual(db.getOrchestrationBinding(defaulted.runId), {
      planId: null, planItemId: null, mode: 'agent-default',
    });
    assert.equal(db.getOrchestrationBinding('missing'), null);
  });

  test('explicit plan-only wins while omitted binding freezes worker default with no item', async () => {
    const explicitRun = makeRun({ planId: 'plan-explicit', planBindingMode: 'explicit' });
    const defaultRun = makeRun({ runId: 'default-context', planBindingMode: 'agent-default' });
    const deps = {
      getAgent: () => ({ workspaceId: 'ws-1', planId: 'live-plan-changed' }),
      resolveCapability: async () => ({ repoRoot: 'C:\\repo' }) as any,
    };
    const explicitCtx = await buildDispatchTurnContext(deps, 'worker', getOrchestrationDispatch(explicitRun));
    const defaultCtx = await buildDispatchTurnContext(deps, 'worker', getOrchestrationDispatch(defaultRun));
    assert.deepEqual(explicitCtx?.planStamp, {
      planId: 'plan-explicit', planItemId: null, source: 'explicit',
    });
    assert.deepEqual(defaultCtx?.planStamp, {
      planId: null, planItemId: null, source: 'agent-default',
    });
  });

  test('SC-WP-3A: an explicit plan+item run wins and carries the frozen item through dispatch', async () => {
    const itemRun = makeRun({
      runId: 'explicit-item', planId: 'plan-explicit', planItemId: 'item-1',
      planBindingMode: 'explicit',
    });
    // The frozen run-item survives a persistence round-trip (restart rehydration).
    db.insertOrchestration(itemRun);
    assert.deepEqual(db.getOrchestrationBinding('explicit-item'), {
      planId: 'plan-explicit', planItemId: 'item-1', mode: 'explicit',
    });
    const deps = {
      getAgent: () => ({ workspaceId: 'ws-1', planId: 'live-plan-changed' }),
      resolveCapability: async () => ({ repoRoot: '/repo' } as any),
      planInWorkspace: () => true,
    };
    const ctx = await buildDispatchTurnContext(deps, 'worker', getOrchestrationDispatch(itemRun));
    assert.deepEqual(ctx?.planStamp, {
      planId: 'plan-explicit', planItemId: 'item-1', source: 'explicit',
    });
  });

  test('dashboard adapter carries orchestration context through raw and confirmed sends', async () => {
    const dispatch = getOrchestrationDispatch(makeRun({ planId: 'adapter-plan', planBindingMode: 'explicit' }));
    const seen: DispatchContext[] = [];
    const supervisor = {
      sendInput: async (_id: string, _text: string, _opts: unknown, ctx: DispatchContext) => {
        seen.push(ctx); return true;
      },
      sendInputWithOutcome: async (_id: string, _text: string, _opts: unknown, ctx: DispatchContext) => {
        seen.push(ctx);
        return { delivered: true, disposition: 'confirmed', confirmationSource: 'hook' };
      },
    } as any;
    const client = createDashboardClient(supervisor);
    await client.sendInput('worker', 'initial', dispatch);
    await client.sendInputConfirmed('worker', 'follow-up', dispatch);
    assert.deepEqual(seen, [dispatch, dispatch]);
  });

  test('initial kickoffs and follow-up relay reuse one run-frozen dispatch context', async () => {
    const run = makeRun({ planId: 'plan-frozen', planBindingMode: 'explicit' });
    try { fs.rmSync(run.planPath, { force: true }); } catch { /* absent */ }
    const agents = new Map<string, { id: string; status: string; sends: number; reads: number; latest?: { content: string; ts: string; turnComplete: boolean } }>();
    const dispatches: DispatchContext[] = [];
    let seq = 0;
    const client: DashboardClient = {
      launchAgent: async () => {
        const id = `worker-${++seq}`;
        agents.set(id, { id, status: 'idle', sends: 0, reads: 0 });
        return { id, status: 'idle' } as any;
      },
      getAgent: (id) => agents.get(id) as any ?? null,
      getMessages: async (id) => {
        const agent = agents.get(id)!;
        agent.reads += 1;
        const revealAt = agent.sends === 1 ? 2 : 1;
        if (agent.sends > 0 && agent.reads >= revealAt && agent.latest?.ts !== `${id}-${agent.sends}`) {
          agent.latest = { content: `turn ${agent.sends}`, ts: `${id}-${agent.sends}`, turnComplete: true };
        }
        return agent.latest ? [{ ...agent.latest }] : [];
      },
      recoverChatBinding: () => {},
      sendInput: async (id, _text, dispatch) => {
        const agent = agents.get(id)!;
        agent.sends += 1;
        agent.reads = 0;
        dispatches.push(dispatch);
        if (dispatches.length === 3) fs.writeFileSync(run.planPath, '# complete');
      },
      sendInputConfirmed: async () => ({ delivered: true, confirmed: true, mode: 'hook' }),
      resubmitEnter: () => {},
      isInputInFlight: () => false,
      stopAgent: async () => {},
      sectionChangedSince: () => false,
    };
    await runSerial(client, {
      run, signal: new AbortController().signal, persist: () => {}, emit: () => {},
    });
    assert.equal(dispatches.length, 3, 'lead kickoff, reviewer kickoff, and relay follow-up all sent');
    assert.ok(dispatches.every((dispatch) => dispatch === dispatches[0]), 'every message reuses the exact frozen context');
  });

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed += 1; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error(err); failed += 1; }
  }
  try { db.closeDatabase(); } catch { /* best effort */ }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
