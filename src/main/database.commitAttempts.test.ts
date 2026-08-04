// Save-card SC-WP-4C — commit_attempts pending + outcome persistence.
//
//   npm run build:main
//   node dist/main/main/database.commitAttempts.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

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
  private static stores = new Map<string, SqlJsDatabase>();
  private db: SqlJsDatabase;

  constructor(dbPath = ':memory:') {
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) {
      store = new sqlJsCtor();
      FakeBetterSqlite.stores.set(dbPath, store);
    }
    this.db = store;
  }

  pragma(_sql: string): unknown { return undefined; }
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
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
  }
}

type OutcomeStatus =
  | 'committed'
  | 'committed-integrity-mismatch'
  | 'repository-state-uncertain'
  | 'aborted-stale'
  | 'aborted-error';

interface PendingCommitAttempt {
  attemptId: string;
  repositoryKey: string;
  candidateId: string;
  tokenId: string;
  pinnedHeadOid: string;
  reflogAction: string;
  startedAt: number;
}

interface CommitAttempt extends PendingCommitAttempt {
  resolvedHeadOid: string | null;
  identifiedCommitOid: string | null;
  outcomeStatus: OutcomeStatus | null;
  endedAt: number | null;
}

type DbModule = {
  initDatabase(): void;
  insertPendingCommitAttempt(attempt: PendingCommitAttempt): void;
  getCommitAttempt(attemptId: string): CommitAttempt | null;
  resolveCommitAttempt(attemptId: string, resolution: {
    resolvedHeadOid: string;
    identifiedCommitOid: string | null;
    outcomeStatus: OutcomeStatus;
    endedAt: number;
  }): void;
};

let dbm: DbModule;

function pending(attemptId: string): PendingCommitAttempt {
  return {
    attemptId,
    repositoryKey: 'repo-key-1',
    candidateId: 'candidate-1',
    tokenId: 'token-1',
    pinnedHeadOid: '1111111111111111111111111111111111111111',
    reflogAction: `lares-commit:${attemptId}`,
    startedAt: 1_722_800_000_000,
  };
}

test('insert persists a pending attempt before any resolution fields exist', () => {
  const attempt = pending('attempt-pending');
  dbm.insertPendingCommitAttempt(attempt);

  assert.deepEqual(dbm.getCommitAttempt(attempt.attemptId), {
    ...attempt,
    resolvedHeadOid: null,
    identifiedCommitOid: null,
    outcomeStatus: null,
    endedAt: null,
  });
});

test('resolution round-trips observed HEAD, identified commit, outcome, and end time', () => {
  const attempt = pending('attempt-committed');
  dbm.insertPendingCommitAttempt(attempt);
  dbm.resolveCommitAttempt(attempt.attemptId, {
    resolvedHeadOid: '3333333333333333333333333333333333333333',
    identifiedCommitOid: '2222222222222222222222222222222222222222',
    outcomeStatus: 'committed',
    endedAt: attempt.startedAt + 250,
  });

  assert.deepEqual(dbm.getCommitAttempt(attempt.attemptId), {
    ...attempt,
    resolvedHeadOid: '3333333333333333333333333333333333333333',
    identifiedCommitOid: '2222222222222222222222222222222222222222',
    outcomeStatus: 'committed',
    endedAt: attempt.startedAt + 250,
  });
});

test('uncertain outcome retains a marked OID for later attribution evidence', () => {
  const attempt = pending('attempt-uncertain');
  dbm.insertPendingCommitAttempt(attempt);
  dbm.resolveCommitAttempt(attempt.attemptId, {
    resolvedHeadOid: '4444444444444444444444444444444444444444',
    identifiedCommitOid: '5555555555555555555555555555555555555555',
    outcomeStatus: 'repository-state-uncertain',
    endedAt: attempt.startedAt + 500,
  });

  const stored = dbm.getCommitAttempt(attempt.attemptId);
  assert.equal(stored?.outcomeStatus, 'repository-state-uncertain');
  assert.equal(stored?.identifiedCommitOid, '5555555555555555555555555555555555555555');
});

test('duplicate attempt IDs are rejected without replacing pending evidence', () => {
  const attempt = pending('attempt-duplicate');
  dbm.insertPendingCommitAttempt(attempt);
  assert.throws(() => dbm.insertPendingCommitAttempt({ ...attempt, candidateId: 'other' }));
  assert.equal(dbm.getCommitAttempt(attempt.attemptId)?.candidateId, 'candidate-1');
});

test('unknown attempts read as null', () => {
  assert.equal(dbm.getCommitAttempt('not-present'), null);
});

(async () => {
  const tmpAppData = fs.mkdtempSync(`${os.tmpdir()}${process.platform === 'win32' ? '\\' : '/'}commit-attempts-`);
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('./database') as DbModule;
  dbm.initDatabase();

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    }
  }

  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
