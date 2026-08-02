// SC-WP-2F: continuation binding persistence and restart reconciliation.
//
//   npm run build:main
//   node dist/main/main/continuation-binding.restart.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DirtyEntry, EncodedGitPath, RepositoryIdentity } from '../shared/commit-candidates';
import type { GitCapability } from '../shared/types';
import type { DispatchContext } from './git-checkpoints/dispatch-context';
import { assembleConflictComponents } from './commit-candidates/component-assembler';

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

let SqlJsCtor: new () => SqlJsDatabase;
let liveDb: FakeBetterSqlite | null = null;

class FakeBetterSqlite {
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;
  constructor(dbPath = ':memory:') {
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) {
      store = new SqlJsCtor();
      FakeBetterSqlite.stores.set(dbPath, store);
    }
    this.db = store;
    liveDb = this;
  }
  pragma(): undefined { return undefined; }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => {
        const stmt = inner.prepare(sql);
        try {
          stmt.bind(params);
          return stmt.step() ? stmt.getAsObject() : undefined;
        } finally { stmt.free(); }
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
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => {
      this.db.exec('BEGIN');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    };
  }
}

function rawRun(sql: string, params: unknown[] = []): void {
  (liveDb!.prepare(sql) as { run: (...values: unknown[]) => unknown }).run(...params);
}

function rawCount(sql: string, params: unknown[] = []): number {
  const row = (liveDb!.prepare(sql) as {
    get: (...values: unknown[]) => Record<string, unknown> | undefined;
  }).get(...params);
  return Number(row?.n ?? 0);
}

function encodedPath(value: string): EncodedGitPath {
  return {
    pathBytesBase64: Buffer.from(value).toString('base64'),
    displayPath: value,
    utf8Clean: true,
  };
}

function dirtyEntry(entryId: string): DirtyEntry {
  const encoded = encodedPath('manual.txt');
  return {
    entryId,
    path: encoded,
    originalPath: null,
    entryKind: 'ordinary',
    indexStatus: '.',
    worktreeStatus: 'M',
    headMode: '100644',
    indexMode: '100644',
    worktreeMode: '100644',
    submoduleState: null,
    renameOrCopyScore: null,
    expectedWorktreeState: 'present',
    rawWorktreeBlobOid: 'a'.repeat(40),
    gitLevelEligibility: 'supported',
    commitPathspecs: [encoded],
  };
}

void (async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-binding-db-'));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-binding-ws-'));
  process.env.APPDATA = appData;
  process.env.DASHBOARD_RECONCILE_STAGGER_MS = '1';

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    SqlJsCtor = SQL.Database;
    const sqlitePath = require.resolve('better-sqlite3');
    require.cache[sqlitePath] = {
      id: sqlitePath,
      filename: sqlitePath,
      loaded: true,
      exports: FakeBetterSqlite,
    } as unknown as NodeJS.Module;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const db = require('./database') as typeof import('./database');
    db.initDatabase();
    const workspace = db.createWorkspace({ title: 'binding-ws', path: workspacePath, pathType: 'windows' });
    const agent = db.createAgent({
      workspaceId: workspace.id,
      title: 'continuation-binding-agent',
      roleDescription: '',
      workingDirectory: workspacePath,
      command: 'claude --dangerously-skip-permissions',
      provider: 'claude',
      tmuxSessionName: null,
      autoRestartEnabled: false,
      logPath: path.join(workspacePath, 'agent.log'),
      planId: 'plan-frozen',
    });
    db.updateAgentResumeSessionId(agent.id, 'session-before');
    const attempt = db.createContinuationHandoffAttempt(agent.id, { reason: 'test' });
    const noteId = db.insertContinuationBrick({
      agentId: agent.id,
      handoffAttemptId: attempt.id,
      generation: attempt.generation,
      note: 'continue with frozen attribution',
      noteSource: 'tool',
    });
    db.closeContinuationHandoffAttempt(attempt.id, 'committed');

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AgentSupervisor } = require('./supervisor/index') as typeof import('./supervisor/index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { buildDispatchTurnContext } = require('./git-checkpoints/dispatch-context') as typeof import('./git-checkpoints/dispatch-context');

    const first = new AgentSupervisor();
    const firstPrivate = first as unknown as Record<string, unknown>;
    let bindingSeenBeforeTeardown: unknown;
    firstPrivate.stopAgentLocked = async () => {
      bindingSeenBeforeTeardown = db.getContinuationAttemptBinding(attempt.id);
      // Both forbidden fallback sources now disagree with the frozen row.
      rawRun('UPDATE agents SET plan_id = ? WHERE id = ?', ['plan-live-after-freeze', agent.id]);
      db.allocateAndInsertTurn(workspace.id, {
        agentId: agent.id,
        planId: 'plan-latest-turn',
        planItemId: null,
        planStampSource: 'explicit',
        status: 'accepted',
      });
      return { outcome: 'stopped' };
    };
    firstPrivate.continuationLaunchTail = () => {};
    (firstPrivate.monitor as Record<string, unknown>).forgetAgent = () => {};
    (firstPrivate.sessionLogReader as Record<string, unknown>).rebindAgent = () => {};

    await first.continuationRelaunch(agent.id, {
      handoffAttemptId: attempt.id,
      noteId,
      reason: 'test',
      note: 'continue with frozen attribution',
      workspaceId: workspace.id,
    });
    assert.deepEqual(bindingSeenBeforeTeardown, {
      planId: 'plan-frozen', planItemId: null, source: 'continuation-carry',
    }, 'binding is durable before stopAgentLocked begins teardown');

    const firstPending = (firstPrivate.pendingInitialPrompts as Map<string, {
      dispatch: DispatchContext;
    }>).get(agent.id);
    assert.ok(firstPending, 'live relaunch stages the continuation kickoff');

    // A new supervisor instance models the in-memory half of an app restart.
    // Reconciliation must reconstruct the dispatch from the attempt columns.
    const restarted = new AgentSupervisor();
    const restartedPrivate = restarted as unknown as Record<string, unknown>;
    const tailCalls: Array<[string, string]> = [];
    restartedPrivate.continuationLaunchTail = (id: string, sessionId: string) => tailCalls.push([id, sessionId]);
    (restartedPrivate.sessionLogReader as Record<string, unknown>).sessionFileExists = () => false;
    restartedPrivate.retireStaleRootMcpConfig = () => {};
    await restarted.reconcile();
    assert.deepEqual(tailCalls, [[agent.id, db.getAgent(agent.id)!.resumeSessionId!]]);

    const restartedPending = (restartedPrivate.pendingInitialPrompts as Map<string, {
      dispatch: DispatchContext;
    }>).get(agent.id);
    assert.ok(restartedPending, 'restart reconciliation re-stages the kickoff');
    const ctx = await buildDispatchTurnContext({
      getAgent: (id) => db.getAgent(id),
      resolveCapability: async () => ({ repoRoot: workspacePath } as unknown as GitCapability),
      planInWorkspace: () => true,
    }, agent.id, restartedPending!.dispatch);
    assert.deepEqual(ctx?.planStamp, {
      planId: 'plan-frozen', planItemId: null, source: 'continuation-carry',
    }, 'restart reads frozen attempt columns, not live agents.plan_id or latest turn_records');

    // Raw xterm typing is deliberately not a dispatch boundary. It writes bytes
    // only, creates no synthetic turn/stamp, and therefore leaves dirty paths in
    // the assembler's independent unattributed inventory.
    const turnsBefore = rawCount('SELECT COUNT(*) AS n FROM turn_records WHERE agent_id = ?', [agent.id]);
    const writes: string[] = [];
    (restartedPrivate.windowsRunners as Map<string, unknown>).set(agent.id, {
      write: (data: string) => writes.push(data),
    });
    restarted.writeToAgent(agent.id, 'manual raw typing');
    const turnsAfter = rawCount('SELECT COUNT(*) AS n FROM turn_records WHERE agent_id = ?', [agent.id]);
    assert.deepEqual(writes, ['manual raw typing']);
    assert.equal(turnsAfter, turnsBefore, 'raw typing fabricates no turn or plan stamp');

    const repository: RepositoryIdentity = {
      repositoryKey: 'repo',
      objectDatabaseKey: 'objects',
      gitObjectFormat: 'sha1',
      bareRepo: false,
      workspaces: [{ workspaceId: workspace.id, workspacePrefix: '' }],
    };
    const assembled = assembleConflictComponents({
      repository,
      entries: [dirtyEntry('manual-entry')],
    }, []);
    assert.deepEqual(assembled.inventory.unattributedEntryIds, ['manual-entry']);
    assert.deepEqual(assembled.components, []);

    console.log('ok - continuation freezes before teardown');
    console.log('ok - restart reconciliation reads frozen attempt columns');
    console.log('ok - manual raw typing remains unattributed without a fabricated turn/stamp');
  } finally {
    fs.rmSync(appData, { recursive: true, force: true });
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
