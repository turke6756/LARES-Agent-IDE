// WP3 Stage 6(b) — create-branch + F-F route tests for POST /api/plans, run
// against a REAL in-memory DB (sql.js-backed better-sqlite3 stand-in, same
// precedent as plans-data-layer.test.ts) and a REAL temp Windows workspace dir,
// so `createPlanSurface` actually mints a UUID plan, writes the surface HTML,
// and inserts the six seed `plan_sections` rows. The register-branch + rename
// contract is covered by api-server-plans.test.ts (stubbed DB); this file
// exercises the create seam end-to-end plus the F-F 400 markdown-migration
// matrix at the HTTP boundary.
//
//   npm run build:main
//   node dist/main/main/api-server-plans-create.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import http from 'http';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (mirrors plans-data-layer.test.ts) ───

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
  private dbPath: string;
  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    let store = FakeBetterSqlite.stores.get(dbPath);
    if (!store) { store = new sqlJsCtor(); FakeBetterSqlite.stores.set(dbPath, store); }
    this.db = store;
  }
  pragma(_s: string): unknown { return undefined; }
  close(): void { FakeBetterSqlite.stores.delete(this.dbPath); }
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
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => {
      this.db.exec('BEGIN');
      try { const r = fn(...args); this.db.exec('COMMIT'); return r; }
      catch (err) { this.db.exec('ROLLBACK'); throw err; }
    };
  }
}

// ── module handles (filled after the require.cache injection) ──────────────────

type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  getPlan(id: string): Record<string, any> | null;
  getPlanSections(planId: string, opts?: { includeArchived?: boolean }): Array<Record<string, any>>;
  closeDatabaseForTests(): void;
};
let dbm: DbModule;
let ApiServer: any;
let getApiToken: () => string;

let WS_ID = '';
let WS_DIR = '';

// ── HTTP helper ────────────────────────────────────────────────────────────────

interface Res { status: number; body: string; }
function request(port: number, method: string, p: string, headers: Record<string, string>, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method, headers, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const stubSupervisor = {
  getContextStats: () => null,
  isInputInFlight: () => false,
  emit: () => false,
} as unknown as any;

async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
  const server = new ApiServer(stubSupervisor, 0, undefined, '127.0.0.1');
  const port = await server.start();
  try { await fn(port); } finally { server.stop(); }
}

let AUTH: Record<string, string>;
let JSON_AUTH: Record<string, string>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKDOWN_MIGRATION_FIELDS = [
  'seed_markdown', 'seedMarkdown', 'markdown',
  'migrate', 'migrate_from', 'migrateFrom', 'migrate_md', 'migrateMd',
];

// ── tests ──────────────────────────────────────────────────────────────────────

test('create branch: { workspace_id, title } mints a UUID plan, writes the surface, seeds 6 sections', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ workspace_id: WS_ID, title: 'My Plan' }));
    assert.equal(res.status, 200);
    const plan = JSON.parse(res.body);
    // Server-minted UUID id, decoupled from slug/path.
    assert.match(plan.id, UUID_RE);
    assert.equal(plan.path, 'plans/my-plan.html');
    assert.equal(plan.format, 'html');
    // File written on disk with the baked data-plan-id.
    const abs = path.join(WS_DIR, 'plans', 'my-plan.html');
    assert.ok(fs.existsSync(abs), 'surface HTML written');
    const html = fs.readFileSync(abs, 'utf8');
    assert.ok(html.includes(`data-plan-id="${plan.id}"`), 'UUID baked into data-plan-id');
    // DB rows: the plan + its six seed sections.
    assert.ok(dbm.getPlan(plan.id), 'plan row exists');
    assert.equal(dbm.getPlanSections(plan.id).length, 6, 'six seed plan_sections rows');
  }));

test('create branch: same title twice → collision suffix -2 (slug is path metadata, not identity)', () =>
  withServer(async (port) => {
    const first = JSON.parse((await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ workspace_id: WS_ID, title: 'Collide Me' }))).body);
    const second = JSON.parse((await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ workspace_id: WS_ID, title: 'Collide Me' }))).body);
    assert.equal(first.path, 'plans/collide-me.html');
    assert.equal(second.path, 'plans/collide-me-2.html');
    assert.notEqual(first.id, second.id, 'distinct ids for the two files');
    assert.ok(fs.existsSync(path.join(WS_DIR, 'plans', 'collide-me-2.html')));
  }));

test('create branch: missing workspace_id → 400', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/plans', JSON_AUTH, JSON.stringify({ title: 'Orphan' }));
    assert.equal(res.status, 400);
  }));

test('F-F: every markdown-migration field is rejected 400 "not supported in v1 (deferred)" — never silent-ignored', () =>
  withServer(async (port) => {
    for (const field of MARKDOWN_MIGRATION_FIELDS) {
      const body: Record<string, unknown> = { workspace_id: WS_ID, title: 'MD Migrate', [field]: '# heading\n\nbody' };
      const res = await request(port, 'POST', '/api/plans', JSON_AUTH, JSON.stringify(body));
      assert.equal(res.status, 400, `field ${field} must 400`);
      assert.match(JSON.parse(res.body).error, /markdown migration is not supported in v1 \(deferred\)/,
        `field ${field} must carry the deferred-migration message`);
    }
    // The rejected calls minted nothing — no md-migrate surface leaked to disk.
    assert.ok(!fs.existsSync(path.join(WS_DIR, 'plans', 'md-migrate.html')), 'no surface written for a rejected migration');
  }));

test('F-F: markdown-migration rejection fires BEFORE the create seam (title present, still 400)', () =>
  withServer(async (port) => {
    const res = await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ workspace_id: WS_ID, title: 'Legit Title', seedMarkdown: '# md' }));
    assert.equal(res.status, 400);
  }));

test('U+FFFD guard: a title carrying the replacement char is rejected 400 and mints nothing', () =>
  withServer(async (port) => {
    // A title where the client already lost the em-dash to a bad encoding boundary.
    const title = `Bad Title ${String.fromCharCode(0xfffd)} mojibake`;
    const res = await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ workspace_id: WS_ID, title }));
    assert.equal(res.status, 400, 'U+FFFD title rejected at the seam');
    // Message names the probable cause (client sent non-UTF-8) so it's actionable.
    assert.match(JSON.parse(res.body).error, /U\+FFFD|replacement character/i,
      'error names the U+FFFD / encoding cause');
    // No durable file baked with the garbage title.
    assert.ok(!fs.existsSync(path.join(WS_DIR, 'plans', 'bad-title-mojibake.html')),
      'no surface written for a rejected U+FFFD title');
  }));

test('title HTML-escaping: &, <, >, ", and \' all land escaped in the minted surface', () =>
  withServer(async (port) => {
    const title = `A&B <i>x</i> "q" 'z'`;
    const res = await request(port, 'POST', '/api/plans', JSON_AUTH,
      JSON.stringify({ workspace_id: WS_ID, title }));
    assert.equal(res.status, 200);
    const plan = JSON.parse(res.body);
    // plan.path is 'plans/<slug>.html' (forward-slashed); join onto the temp WS.
    const html = fs.readFileSync(path.join(WS_DIR, ...plan.path.split('/')), 'utf8');
    // Every metacharacter is entity-escaped (title lands in <title> AND <h1>).
    assert.ok(html.includes('A&amp;B'), '& escaped');
    assert.ok(html.includes('&lt;i&gt;x&lt;/i&gt;'), '<, > escaped');
    assert.ok(html.includes('&quot;q&quot;'), '" escaped');
    assert.ok(html.includes('&#39;z&#39;'), "' escaped (single quote)");
    // No raw markup from the title survived into the document.
    assert.ok(!html.includes('<i>x</i>'), 'no raw <i> injected via the title');
  }));

// ── Runner (with sql.js bootstrap + real temp Windows workspace) ────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-create-appdata-'));
  process.env.APPDATA = tmpAppData;
  WS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-create-ws-'));

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('./database') as DbModule;
  dbm.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ({ ApiServer } = require('./api-server'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ({ getApiToken } = require('./security/api-auth'));

  AUTH = { Authorization: `Bearer ${getApiToken()}` };
  JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' };

  // A real Windows-path workspace rooted at the temp dir so createPlanSurface writes there.
  WS_ID = dbm.createWorkspace({ title: 'ws', path: WS_DIR, pathType: 'windows' }).id;

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (err) { failed++; console.error(`  ✗ ${t.name}`); console.error(err instanceof Error ? err.stack : String(err)); }
  }
  try { dbm.closeDatabaseForTests(); } catch { /* best-effort */ }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(WS_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
