// Save-card SC-WP-3B — package_finalizations schema + CRUD + lifecycle accessors +
// unique-index enforcement.
//
//   npm run build:main
//   node dist/main/main/database.finalizations.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

type PackageFinalization = {
  id: string;
  packageId: string;
  repositoryKey: string;
  finalizationKind: string;
  planId: string | null;
  planItemId: string | null;
  packageRevision: number;
  finalizedAt: number;
  finalizedBy: string;
  checkpointTurnId: string | null;
  checkpointOid: string | null;
  boundaryRef: string | null;
  boundaryStatus: string;
  lifecycleStatus: string;
  supersededByFinalizationId: string | null;
  releasedAt: number | null;
  memberManifestJson: string;
  contractVersion: number;
  failureReason: string | null;
  createdFromWorkspaceId: string | null;
};
type DbModule = {
  initDatabase(): void;
  insertPackageFinalization(f: PackageFinalization): void;
  getPackageFinalization(id: string): PackageFinalization | null;
  listPackageFinalizations(packageId: string): PackageFinalization[];
  getActivePackageFinalization(packageId: string): PackageFinalization | null;
  listActiveBoundaryRefs(repositoryKey: string): string[];
  maxPackageRevision(packageId: string): number;
  supersedePackageFinalization(id: string, supersededBy: string): void;
  setPackageFinalizationBoundaryStatus(id: string, status: string): void;
  markPackageFinalizationCommitted(id: string, releasedAt: number): void;
};

let dbm: DbModule;

const MANIFEST = JSON.stringify([
  { pathBytesBase64: 'c3JjL2EudHM=', expectedState: 'present',
    checkpointBlobOid: 'aaa', checkpointMode: '100644',
    expectedCommitBlobOid: 'bbb', expectedCommitMode: '100644' },
]);

// One in-memory DB is shared across every test, so (plan_item_id, package_revision)
// and (package_id, package_revision) must stay globally unique unless a test is
// deliberately provoking a collision. Defaults derive packageId/planItemId from the
// row id; tests that share a package across revisions pass those fields explicitly.
function planPackage(over: Partial<PackageFinalization> = {}): PackageFinalization {
  const id = over.id ?? 'fin-1';
  return {
    id, packageId: `pkg-${id}`, repositoryKey: 'repo-1',
    finalizationKind: 'plan-package', planId: 'plan-1', planItemId: `wp-${id}`,
    packageRevision: 1, finalizedAt: 1000, finalizedBy: 'human-ipc',
    checkpointTurnId: 'turn-1', checkpointOid: 'oid-1',
    boundaryRef: 'refs/lares/finalizations/pkg-1/1', boundaryStatus: 'ready',
    lifecycleStatus: 'active', supersededByFinalizationId: null, releasedAt: null,
    memberManifestJson: MANIFEST, contractVersion: 1, failureReason: null,
    createdFromWorkspaceId: 'ws-1',
    ...over,
  };
}

function fleetAdhoc(over: Partial<PackageFinalization> = {}): PackageFinalization {
  return planPackage({
    id: 'fin-fleet', packageId: 'pkg-fleet', finalizationKind: 'fleet-adhoc',
    planId: null, planItemId: null,
    boundaryRef: 'refs/lares/finalizations/pkg-fleet/1',
    ...over,
  });
}

test('CRUD round-trips a plan-package finalization and lists it under its package', () => {
  const f = planPackage({ id: 'fin-crud', packageId: 'pkg-crud' });
  dbm.insertPackageFinalization(f);
  assert.deepEqual(dbm.getPackageFinalization('fin-crud'), f);
  assert.deepEqual(dbm.listPackageFinalizations('pkg-crud'), [f]);
  assert.deepEqual(dbm.listPackageFinalizations('pkg-none'), []);
});

test('CRUD round-trips a fleet-adhoc finalization with NULL plan attribution', () => {
  const f = fleetAdhoc({ id: 'fin-fleet-crud', packageId: 'pkg-fleet-crud' });
  dbm.insertPackageFinalization(f);
  assert.deepEqual(dbm.getPackageFinalization('fin-fleet-crud'), f);
});

test('listPackageFinalizations orders revisions newest-first', () => {
  const p = 'pkg-order';
  dbm.insertPackageFinalization(planPackage({ id: 'ord-1', packageId: p, packageRevision: 1 }));
  dbm.insertPackageFinalization(planPackage({
    id: 'ord-2', packageId: p, packageRevision: 2, planItemId: 'wp-ord',
    lifecycleStatus: 'superseded',
  }));
  dbm.insertPackageFinalization(planPackage({
    id: 'ord-3', packageId: p, packageRevision: 3, planItemId: 'wp-ord2',
  }));
  assert.deepEqual(
    dbm.listPackageFinalizations(p).map((f) => f.packageRevision),
    [3, 2, 1],
  );
});

test('maxPackageRevision is 0 when absent and the high-water mark otherwise', () => {
  assert.equal(dbm.maxPackageRevision('pkg-empty'), 0);
  dbm.insertPackageFinalization(planPackage({ id: 'mx-1', packageId: 'pkg-mx', packageRevision: 1 }));
  dbm.insertPackageFinalization(planPackage({
    id: 'mx-2', packageId: 'pkg-mx', packageRevision: 7, planItemId: 'wp-mx',
  }));
  assert.equal(dbm.maxPackageRevision('pkg-mx'), 7);
});

test('getActivePackageFinalization returns only the active revision', () => {
  const p = 'pkg-active';
  dbm.insertPackageFinalization(planPackage({
    id: 'act-1', packageId: p, packageRevision: 1, lifecycleStatus: 'superseded',
    supersededByFinalizationId: 'act-2',
  }));
  dbm.insertPackageFinalization(planPackage({
    id: 'act-2', packageId: p, packageRevision: 2, planItemId: 'wp-act',
  }));
  assert.equal(dbm.getActivePackageFinalization(p)?.id, 'act-2');
});

test('getActivePackageFinalization is null when none active', () => {
  dbm.insertPackageFinalization(planPackage({
    id: 'noact-1', packageId: 'pkg-noact', lifecycleStatus: 'committed', releasedAt: 5,
  }));
  assert.equal(dbm.getActivePackageFinalization('pkg-noact'), null);
});

test('listActiveBoundaryRefs returns only active non-null refs for the requested repository', () => {
  const rows: Array<[string, string, PackageFinalization['lifecycleStatus'], string | null]> = [
    ['bref-active', 'repo-boundary', 'active', 'refs/lares/finalizations/active/1'],
    ['bref-committed', 'repo-boundary', 'committed', 'refs/lares/finalizations/committed/1'],
    ['bref-superseded', 'repo-boundary', 'superseded', 'refs/lares/finalizations/superseded/1'],
    ['bref-abandoned', 'repo-boundary', 'abandoned', 'refs/lares/finalizations/abandoned/1'],
    ['bref-null', 'repo-boundary', 'active', null],
    ['bref-other-repo', 'repo-other', 'active', 'refs/lares/finalizations/other/1'],
  ];
  for (const [id, repositoryKey, lifecycleStatus, boundaryRef] of rows) {
    dbm.insertPackageFinalization(planPackage({
      id,
      packageId: `pkg-${id}`,
      planItemId: `wp-${id}`,
      repositoryKey,
      lifecycleStatus,
      boundaryRef,
    }));
  }
  assert.deepEqual(
    dbm.listActiveBoundaryRefs('repo-boundary'),
    ['refs/lares/finalizations/active/1'],
  );
  assert.deepEqual(dbm.listActiveBoundaryRefs('repo-missing'), []);
});

test('supersedePackageFinalization flips status and records the successor', () => {
  dbm.insertPackageFinalization(planPackage({ id: 'sup-1', packageId: 'pkg-sup' }));
  dbm.supersedePackageFinalization('sup-1', 'sup-2');
  const after = dbm.getPackageFinalization('sup-1');
  assert.equal(after?.lifecycleStatus, 'superseded');
  assert.equal(after?.supersededByFinalizationId, 'sup-2');
});

test('setPackageFinalizationBoundaryStatus downgrades a stale ready ref', () => {
  dbm.insertPackageFinalization(planPackage({ id: 'bs-1', packageId: 'pkg-bs' }));
  dbm.setPackageFinalizationBoundaryStatus('bs-1', 'pruned');
  assert.equal(dbm.getPackageFinalization('bs-1')?.boundaryStatus, 'pruned');
});

test('markPackageFinalizationCommitted transitions committed and stamps released_at', () => {
  dbm.insertPackageFinalization(planPackage({ id: 'cm-1', packageId: 'pkg-cm' }));
  dbm.markPackageFinalizationCommitted('cm-1', 9999);
  const after = dbm.getPackageFinalization('cm-1');
  assert.equal(after?.lifecycleStatus, 'committed');
  assert.equal(after?.releasedAt, 9999);
});

test('unique index rejects a duplicate (package_id, package_revision) with no second row', () => {
  dbm.insertPackageFinalization(planPackage({ id: 'dup-a', packageId: 'pkg-dup', packageRevision: 1 }));
  assert.throws(() => dbm.insertPackageFinalization(planPackage({
    id: 'dup-b', packageId: 'pkg-dup', packageRevision: 1, planItemId: 'wp-dup',
  })));
  assert.equal(dbm.getPackageFinalization('dup-b'), null);
});

test('partial unique index rejects a duplicate (plan_item_id, package_revision) for plan-package', () => {
  dbm.insertPackageFinalization(planPackage({
    id: 'pit-a', packageId: 'pkg-pit-a', packageRevision: 1, planItemId: 'wp-shared',
  }));
  // Same plan item + same revision under a DIFFERENT package_id still collides.
  assert.throws(() => dbm.insertPackageFinalization(planPackage({
    id: 'pit-b', packageId: 'pkg-pit-b', packageRevision: 1, planItemId: 'wp-shared',
  })));
  assert.equal(dbm.getPackageFinalization('pit-b'), null);
});

test('partial index does not constrain fleet-adhoc rows (plan_item_id NULL)', () => {
  // Two fleet-adhoc rows: NULL plan_item_id is excluded from the partial unique index,
  // and distinct package_ids keep the (package_id, revision) index clear.
  dbm.insertPackageFinalization(fleetAdhoc({ id: 'fa-1', packageId: 'pkg-fa-1', packageRevision: 1 }));
  dbm.insertPackageFinalization(fleetAdhoc({ id: 'fa-2', packageId: 'pkg-fa-2', packageRevision: 1 }));
  assert.equal(dbm.getPackageFinalization('fa-1')?.id, 'fa-1');
  assert.equal(dbm.getPackageFinalization('fa-2')?.id, 'fa-2');
});

test('finalization_kind CHECK rejects an unknown kind with no row', () => {
  assert.throws(() => dbm.insertPackageFinalization(planPackage({
    id: 'badkind', finalizationKind: 'auto-derived',
  })));
  assert.equal(dbm.getPackageFinalization('badkind'), null);
});

test('boundary_status CHECK rejects an unknown status with no row', () => {
  assert.throws(() => dbm.insertPackageFinalization(planPackage({
    id: 'badbs', packageId: 'pkg-badbs', boundaryStatus: 'maybe',
  })));
  assert.equal(dbm.getPackageFinalization('badbs'), null);
});

test('lifecycle_status CHECK rejects an unknown status with no row', () => {
  assert.throws(() => dbm.insertPackageFinalization(planPackage({
    id: 'badls', packageId: 'pkg-badls', lifecycleStatus: 'pending',
  })));
  assert.equal(dbm.getPackageFinalization('badls'), null);
});

test('package_revision CHECK rejects a non-positive revision with no row', () => {
  assert.throws(() => dbm.insertPackageFinalization(planPackage({
    id: 'badrev', packageId: 'pkg-badrev', packageRevision: 0,
  })));
  assert.equal(dbm.getPackageFinalization('badrev'), null);
});

test('kind/attribution coupling CHECK rejects a plan-package with NULL plan attribution', () => {
  assert.throws(() => dbm.insertPackageFinalization(planPackage({
    id: 'badcoup1', packageId: 'pkg-bc1', planId: null, planItemId: null,
  })));
  assert.equal(dbm.getPackageFinalization('badcoup1'), null);
});

test('kind/attribution coupling CHECK rejects a fleet-adhoc carrying plan attribution', () => {
  assert.throws(() => dbm.insertPackageFinalization(fleetAdhoc({
    id: 'badcoup2', packageId: 'pkg-bc2', planId: 'plan-x', planItemId: 'wp-x',
  })));
  assert.equal(dbm.getPackageFinalization('badcoup2'), null);
});

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-fin-'));
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
