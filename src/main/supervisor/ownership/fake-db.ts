// TEST-ONLY helper. better-sqlite3's native binding is built against Electron's
// ABI and won't load under the system Node that `npm run test:supervisor` uses,
// so the ownership unit tests run their SQL on a sql.js (wasm SQLite) stand-in
// that presents the subset of the better-sqlite3 `Database` surface the
// OwnershipStore consumes (exec + prepare().run/get/all + pragma). Real SQL still
// executes — CREATE TABLE, CHECKs, ON CONFLICT upserts — just on wasm.
//
// Never imported by production code (the store takes its `db` via injected deps);
// `sql.js` is required lazily so it is only loaded when a test calls initFakeDb.

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

let sqlJsCtor: (new () => SqlJsDatabase) | null = null;

/** Load the sql.js wasm module once. Call before constructing any fake DB. */
export async function initFakeDb(): Promise<void> {
  if (sqlJsCtor) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;
}

/** A minimal better-sqlite3-compatible wrapper over one fresh in-memory sql.js DB. */
export class FakeBetterSqlite {
  private db: SqlJsDatabase;
  constructor() {
    if (!sqlJsCtor) throw new Error('initFakeDb() must be awaited before makeFakeDb()');
    this.db = new sqlJsCtor();
  }
  pragma(_s: string): unknown { return undefined; }
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
}

/** Fresh, isolated in-memory DB. Cast to the better-sqlite3 Database type at the
 *  call site (the store only uses the subset implemented here). */
export function makeFakeDb(): any {
  return new FakeBetterSqlite();
}
