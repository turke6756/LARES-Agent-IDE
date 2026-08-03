// WP-P2C-compat — structured-format guards at the real HTML call sites.
//
// Proves the acceptance item: a `format='structured'` (folder-adopted) plan is
// mechanically excluded from EVERY HTML path, each returning a structured-not-
// applicable outcome, never a crash; legacy `html`/`md` plans are unaffected (the
// exclusion is scoped to `structured`, so the existing md-through-projection
// behavior the registered api-server suites rely on is preserved). One assertion
// per guarded site:
//
//   1. PlanReparser.reparse / reparsePlanFile  → `notApplicable` outcome, no
//      parse / mint / snapshot / change rows, no fs touch.
//   2. PlanPaneManager.show                     → no-op (no view, no loadURL).
//   3. api-server resolvePlanProjection         → null (→ the /api/plans/:id/…
//      projection routes 404 and the plan:projection IPC returns null).
//   4. watch-plans getServedPlanProjection      → null even for a projection that
//      IS in last-good, once the row's format flips away from html.
//
// Sections 1–2 are fully injected (no DB/fs). Sections 3–4 run the REAL database +
// api-server + watch-plans modules against a sql.js-backed better-sqlite3 stand-in
// (same precedent as plan-gallery.test.ts / api-server-plans-create.test.ts) and a
// real temp Windows workspace on disk, plus the plan-pane-manager Electron stand-in
// injected into require.cache (mirrors plan-pane-manager.test.ts).
//
//   npm run build:main
//   node dist/main/main/plans/structured-exclusion.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Plan, PlanFormat } from '../../shared/types';
import type { PlanSectionRow } from '../database';
import type { PlanProjection } from './section-reader';
import type { ReparseDeps } from './watch-plans';

// Runtime handles for value imports that transitively pull in `../database` (and
// thus the native better-sqlite3). They are `require()`d in the runner ONLY AFTER
// the sql.js stand-in is injected into require.cache — a static `import` here would
// load the real native binding before the injection and defeat it.
let PlanReparser: typeof import('./watch-plans').PlanReparser;
let parsePlanHtml: typeof import('./section-reader').parsePlanHtml;

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

const HTML_PLAN: Plan = {
  id: 'plan-html', workspaceId: 'ws-1', path: 'plans/p.html', slug: null, format: 'html',
  runState: null, mtimeMs: 0, sizeBytes: 0, createdAt: 'T', updatedAt: 'T', deletedAt: null,
};
const STRUCTURED_PLAN: Plan = { ...HTML_PLAN, id: 'plan-struct', path: '.lares/plans/x/plan.md', format: 'structured' };
const MD_PLAN: Plan = { ...HTML_PLAN, id: 'plan-md', path: '.lares/proposals/a.md', format: 'md' };

// ── Section 1: reparse pure guard (injected deps, no DB/fs) ─────────────────────

/** A ReparseDeps whose every effect throws — so the ONLY way reparse returns
 *  cleanly for a non-html plan is the format short-circuit firing before any dep
 *  is touched. */
function tripwireDeps(): { deps: ReparseDeps; touched: string[] } {
  const touched: string[] = [];
  const deps: ReparseDeps = {
    resolveAbsolutePath: () => { touched.push('resolveAbsolutePath'); throw new Error('resolveAbsolutePath must not run'); },
    readFile: async () => { touched.push('readFile'); throw new Error('readFile must not run'); },
    writeFile: async () => { touched.push('writeFile'); throw new Error('writeFile must not run'); },
    registry: {
      getPlanSections: () => { touched.push('getPlanSections'); return [] as PlanSectionRow[]; },
      getPlanSectionByAnchor: () => null,
      insertPlanSection: () => { touched.push('insertPlanSection'); return 'x'; },
      archivePlanSection: () => { touched.push('archivePlanSection'); },
    },
    recordPlanSectionChange: () => { touched.push('recordPlanSectionChange'); return 'chg'; },
    recordPlanSnapshot: () => { touched.push('recordPlanSnapshot'); return 'snap'; },
    getLatestPlanSnapshotHtml: () => null,
    parse: () => { touched.push('parse'); return parsePlanHtml(''); },
    now: () => '2026-08-03T00:00:00.000Z',
  };
  return { deps, touched };
}

test('reparse: a structured plan returns a not-applicable outcome, touching NO dep', async () => {
  const { deps, touched } = tripwireDeps();
  const out = await new PlanReparser(deps).reparse(STRUCTURED_PLAN);
  assert.equal(out.notApplicable, true, 'structured → notApplicable');
  assert.equal(out.ok, false);
  assert.equal(out.parseError, null, 'no parse attempted → no parse error');
  assert.equal(out.snapshotId, null, 'no snapshot recorded');
  assert.equal(out.htmlWritten, false, 'no backfill write');
  assert.deepEqual(out.mintedAnchors, []);
  assert.deepEqual(out.changedAnchors, []);
  assert.deepEqual(touched, [], 'the guard fired before any parse / DB / fs effect');
});

function workingDeps(): ReparseDeps {
  const files = new Map<string, string>([['/ws/plans/p.html', '<body><section data-zone="r"><h2>H</h2><p>x</p></section></body>']]);
  const rows: PlanSectionRow[] = [];
  const deps: ReparseDeps = {
    resolveAbsolutePath: () => ({ absPath: '/ws/plans/p.html', pathType: 'windows' }),
    readFile: async (absPath) => ({ content: files.get(absPath) ?? '', error: files.has(absPath) ? undefined : 'missing' }),
    writeFile: async (absPath, content) => { files.set(absPath, content); },
    registry: {
      getPlanSections: (planId, opts) => rows.filter((r) => r.planId === planId && (opts?.includeArchived === false ? r.archivedAt === null : true)),
      getPlanSectionByAnchor: (planId, anchor) => rows.find((r) => r.planId === planId && r.anchor === anchor) ?? null,
      insertPlanSection: ({ planId, anchor }) => {
        const e = rows.find((r) => r.planId === planId && r.anchor === anchor);
        if (e) { if (e.archivedAt) e.archivedAt = null; return e.id; }
        const id = 'row-' + (rows.length + 1);
        rows.push({ id, planId, anchor, parentSectionId: null, createdAt: 'T', archivedAt: null });
        return id;
      },
      archivePlanSection: () => {},
    },
    recordPlanSectionChange: () => 'chg',
    recordPlanSnapshot: () => 'snap-1',
    getLatestPlanSnapshotHtml: () => null,
    parse: parsePlanHtml,
    now: () => '2026-08-03T00:00:00.000Z',
  };
  return deps;
}

test('reparse: a legacy html plan is UNaffected — the pipeline runs normally', async () => {
  const out = await new PlanReparser(workingDeps()).reparse(HTML_PLAN);
  assert.equal(out.notApplicable, false, 'html is not excluded');
  assert.equal(out.ok, true, 'html reparses to completion');
  assert.equal(out.snapshotId, 'snap-1', 'html records a snapshot');
});

test('reparse: an md plan is NOT excluded — only structured is gated', async () => {
  // md keeps its pre-existing HTML-parsed path (the registered api-server suites
  // exercise md through the projection ladder); the guard is scoped to structured.
  const out = await new PlanReparser(workingDeps()).reparse(MD_PLAN);
  assert.equal(out.notApplicable, false, 'md is not gated');
  assert.equal(out.ok, true, 'md still runs the pipeline');
});

// ── Section 2: PlanPaneManager.show guard (Electron stand-in, injected resolver) ─

// Fake WebContentsView recording every loadURL / setVisible. Injected via
// require.cache before ./plan-pane-manager is required (mirrors plan-pane-manager.test.ts).
class FakeView {
  loadedUrls: string[] = [];
  visibleCalls: boolean[] = [];
  webContents = { loadURL: (u: string) => { this.loadedUrls.push(u); }, close: () => {} };
  setBounds() {}
  setVisible(v: boolean) { this.visibleCalls.push(v); }
}
let lastView: FakeView | null = null;
const electronMock = {
  session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
  WebContentsView: class { constructor() { const v = new FakeView(); lastView = v; return v as unknown as object; } },
};

function fakeWindow(): unknown {
  return {
    isDestroyed: () => false,
    contentView: { addChildView() {}, removeChildView() {} },
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
  };
}

// Filled in the runner after the require.cache injections.
let PlanPaneManagerCtor: typeof import('./plan-pane-manager').PlanPaneManager;

function paneWith(format: PlanFormat | null) {
  lastView = null;
  return new PlanPaneManagerCtor(() => fakeWindow() as never, () => format);
}

test('show: a structured plan is a no-op — no view constructed, nothing loaded', () => {
  const mgr = paneWith('structured');
  mgr.show('plan-struct');
  assert.equal(lastView, null, 'structured must not construct a WebContentsView');
});

test('show: an md plan is NOT excluded — it renders (only structured is gated)', () => {
  const mgr = paneWith('md');
  mgr.show('plan-md');
  assert.ok(lastView, 'md renders as before');
});

test('show: a legacy html plan renders — view constructed, a data URL loaded', () => {
  const mgr = paneWith('html');
  mgr.show('plan-html');
  assert.ok(lastView, 'html constructs the view');
  assert.ok(lastView!.loadedUrls.length >= 1, 'html loads a document');
});

test('show: an UNKNOWN format (null) is NOT excluded — unchanged behavior', () => {
  const mgr = paneWith(null);
  mgr.show('plan-unknown');
  assert.ok(lastView, 'a null/unknown format still renders (guard only excludes KNOWN non-html)');
});

// ── Sections 3–4: resolvePlanProjection + getServedPlanProjection (real DB/fs) ───

type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  createOrRevivePlan(input: { workspaceId: string; path: string; format: PlanFormat; mtimeMs?: number; sizeBytes?: number }): Plan;
  updatePlan(id: string, updates: { format?: PlanFormat }): Plan | null;
  getPlan(id: string): Plan | null;
};
type ApiModule = { resolvePlanProjection(planId: string): Promise<{ plan: Plan; projection: PlanProjection } | null> };
type WatchModule = {
  configureReparser(): unknown;
  reparsePlanFile(plan: Plan): Promise<{ ok: boolean; notApplicable: boolean }>;
  getServedPlanProjection(planId: string): PlanProjection | null;
};

let dbm: DbModule;
let api: ApiModule;
let watch: WatchModule;
let WS_ID = '';
let WS_DIR = '';

test('resolvePlanProjection: a structured plan resolves to null (routes/IPC 404, no crash)', async () => {
  const struct = dbm.createOrRevivePlan({ workspaceId: WS_ID, path: '.lares/plans/s/plan.md', format: 'structured' });
  assert.equal(await api.resolvePlanProjection(struct.id), null, 'structured excluded from the projection ladder');
});

test('resolvePlanProjection: a legacy html plan resolves normally', async () => {
  fs.mkdirSync(path.join(WS_DIR, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(WS_DIR, 'plans', 'legacy.html'), '<body><section data-zone="r"><h2>H</h2><p>hi</p></section></body>');
  const html = dbm.createOrRevivePlan({ workspaceId: WS_ID, path: 'plans/legacy.html', format: 'html' });
  const resolved = await api.resolvePlanProjection(html.id);
  assert.ok(resolved, 'html resolves');
  assert.equal(resolved!.plan.format, 'html');
});

test('resolvePlanProjection: an md plan still resolves — the guard is structured-only', async () => {
  // Locks in the behavior the registered api-server-plans / api-identity suites
  // depend on: md rows keep flowing through the projection ladder.
  fs.writeFileSync(path.join(WS_DIR, 'plans', 'legacy-md.md'), '<body><section data-zone="r"><p>md body</p></section></body>');
  const md = dbm.createOrRevivePlan({ workspaceId: WS_ID, path: 'plans/legacy-md.md', format: 'md' });
  const resolved = await api.resolvePlanProjection(md.id);
  assert.ok(resolved, 'md is not excluded from resolvePlanProjection');
  assert.equal(resolved!.plan.format, 'md');
});

test('getServedPlanProjection: refuses to serve once a served plan flips to structured', async () => {
  // Seed last-good for a genuinely html plan, then flip its row to structured and
  // prove the guard filters the projection that is STILL in memory.
  fs.mkdirSync(path.join(WS_DIR, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(WS_DIR, 'plans', 'flip.html'), '<body><section data-anchor="sec_flip01" data-zone="r"><p>served</p></section></body>');
  const flip = dbm.createOrRevivePlan({ workspaceId: WS_ID, path: 'plans/flip.html', format: 'html' });

  watch.configureReparser();
  const out = await watch.reparsePlanFile(dbm.getPlan(flip.id)!);
  assert.equal(out.ok, true, 'html seeds a served projection');
  assert.ok(watch.getServedPlanProjection(flip.id), 'html projection is served');

  dbm.updatePlan(flip.id, { format: 'structured' });
  assert.equal(watch.getServedPlanProjection(flip.id), null, 'the format guard refuses to serve it down HTML paths');
});

// ── Runner ──────────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-excl-appdata-'));
  process.env.APPDATA = tmpAppData;
  WS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-excl-ws-'));

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const sqlJsCtor: new () => Record<string, any> = SQL.Database;

  // sql.js-backed better-sqlite3 stand-in (mirrors the sibling suites).
  class FakeBetterSqlite {
    private static stores = new Map<string, any>();
    private db: any;
    constructor(dbPath = ':memory:') {
      let store = FakeBetterSqlite.stores.get(dbPath);
      if (!store) { store = new sqlJsCtor(); FakeBetterSqlite.stores.set(dbPath, store); }
      this.db = store;
    }
    pragma(_s: string): unknown { return undefined; }
    close(): void {}
    exec(sql: string): this { this.db.exec(sql); return this; }
    prepare(sql: string) {
      const inner = this.db;
      return {
        run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
        get: (...params: unknown[]) => {
          const stmt = inner.prepare(sql);
          try { stmt.bind(params); return stmt.step() ? stmt.getAsObject() : undefined; } finally { stmt.free(); }
        },
        all: (...params: unknown[]) => {
          const stmt = inner.prepare(sql);
          try { stmt.bind(params); const rows: Record<string, unknown>[] = []; while (stmt.step()) rows.push(stmt.getAsObject()); return rows; }
          finally { stmt.free(); }
        },
      };
    }
    transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
      return (...args: A) => { this.db.exec('BEGIN'); try { const r = fn(...args); this.db.exec('COMMIT'); return r; } catch (err) { this.db.exec('ROLLBACK'); throw err; } };
    }
  }

  const sqliteResolved = require.resolve('better-sqlite3');
  require.cache[sqliteResolved] = {
    id: sqliteResolved, filename: sqliteResolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;

  // Electron stand-in — only ./plan-pane-manager imports electron.
  const electronResolved = require.resolve('electron');
  require.cache[electronResolved] = {
    id: electronResolved, filename: electronResolved, loaded: true, exports: electronMock,
  } as unknown as NodeJS.Module;

  /* eslint-disable @typescript-eslint/no-var-requires */
  dbm = require('../database') as DbModule;
  dbm.initDatabase();
  api = require('../api-server') as ApiModule;
  const watchMod = require('./watch-plans') as typeof import('./watch-plans');
  watch = watchMod as unknown as WatchModule;
  PlanReparser = watchMod.PlanReparser;
  parsePlanHtml = (require('./section-reader') as typeof import('./section-reader')).parsePlanHtml;
  ({ PlanPaneManager: PlanPaneManagerCtor } = require('./plan-pane-manager') as typeof import('./plan-pane-manager'));
  /* eslint-enable @typescript-eslint/no-var-requires */

  WS_ID = dbm.createWorkspace({ title: 'ws', path: WS_DIR, pathType: 'windows' }).id;

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(WS_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
