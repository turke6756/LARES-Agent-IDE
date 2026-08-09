// WP-P2L-ingest acceptance fixtures.
//   npm run build:main
//   node dist/main/main/plans/plan-intent-ledger.test.js
// Not registered here: the P2L stage gate owns scripts/run-main-tests.mjs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

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
    if (!store) { store = new sqlJsCtor(); FakeBetterSqlite.stores.set(dbPath, store); }
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
      try { const result = fn(...args); this.db.exec('COMMIT'); return result; }
      catch (err) { this.db.exec('ROLLBACK'); throw err; }
    };
  }
}

type Projection = {
  intentId: string;
  status: 'active' | 'withdrawn' | 'superseded';
  returned: boolean;
  fullyFoldedIn: boolean;
  open: boolean;
  outputs: Array<{
    relPath: string; presentOnDisk: boolean; disposition: string; foldedIn: boolean;
  }>;
};
type ScanResult = {
  committed: boolean; complete: boolean;
  diagnostics: Array<{ kind: string; detail: string }>;
  intents: Projection[];
};
type LedgerModule = {
  scanPlanIntentLedger(input: {
    workspaceId: string; workspaceRoot: string; planId: string;
    folderAbs: string; folderRelPath: string; now?: () => number;
    maxDocumentBytes?: number; maxOutputBytes?: number; maxOutputFiles?: number;
  }): ScanResult;
  getPlanIntentLedgerProjection(planId: string): Projection[];
};
type DbModule = {
  initDatabase(): void;
  createWorkspace(input: { title: string; path: string; pathType: string }): { id: string };
  adoptStructuredPlan(input: {
    workspaceId: string; artifactId: string; folderRelPath: string; planPath: string;
    mtimeMs: number; sizeBytes: number;
  }): { planId: string };
};
type WatcherModule = {
  PlanFolderWatcher: new () => {
    reconcileWorkspace(ws: { id: string; path: string; pathType: string }, boot: boolean): Promise<unknown>;
  };
};

let dbm: DbModule;
let ledger: LedgerModule;
let watcherModule: WatcherModule;
let root = '';
let folderAbs = '';
let folderRelPath = '';
let workspaceId = '';
let planId = '';
let artifactId = '';
let clock = 10_000;

function intentJson(intentId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    intent_id: intentId,
    part: `part-${intentId}`,
    kind: 'research',
    targets: [{ provider: 'codex', model: 'test' }],
    reason: 'fixture',
    ...extra,
  });
}
function sentinel(json: string): string { return `<!--PLAN-INTENT\n${json}\n-->`; }
function integration(intentId: string, outputRelPath: string, disposition = 'active'): string {
  return `<!--PLAN-INTEGRATION\n${JSON.stringify({ intent_id: intentId, output_rel_path: outputRelPath, changed: 'folded', disposition })}\n-->`;
}
function outputBody(intentId: string, orchestrationId = 'orc_1'): string {
  return `---\nplan_artifact_id: ${artifactId}\nintent_id: ${intentId}\norchestration_id: ${orchestrationId}\nkind: research\n---\n# Result\n`;
}
function writePlan(body: string): void { fs.writeFileSync(path.join(folderAbs, 'plan.md'), body); }
function writeOutput(rel: string, intentId: string, orchestrationId?: string): void {
  const abs = path.join(folderAbs, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, outputBody(intentId, orchestrationId));
}
function scan(overrides: Partial<Parameters<LedgerModule['scanPlanIntentLedger']>[0]> = {}): ScanResult {
  clock += 1;
  return ledger.scanPlanIntentLedger({
    workspaceId, workspaceRoot: root, planId, folderAbs, folderRelPath,
    now: () => clock,
    ...overrides,
  });
}
function byIntent(result: ScanResult, id: string): Projection {
  const found = result.intents.find((item) => item.intentId === id);
  assert.ok(found, `expected projection for ${id}`);
  return found;
}
function freshFixture(planBody = sentinel(intentJson('int_aaaaaaaa'))): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pil-ws-'));
  const sku = `fixture-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  folderRelPath = `.lares/plans/${sku}`;
  folderAbs = path.join(root, '.lares', 'plans', sku);
  artifactId = `plan_${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(folderAbs, { recursive: true });
  fs.writeFileSync(path.join(folderAbs, 'plan.json'), JSON.stringify({
    schema_version: 1,
    plan_artifact_id: artifactId,
    plan_sku: sku,
    source_proposal: { artifact_id: 'prop_f17e0abc', rel_path: '.lares/proposals/source.md' },
  }));
  writePlan(planBody);
  workspaceId = dbm.createWorkspace({ title: sku, path: root, pathType: 'windows' }).id;
  planId = dbm.adoptStructuredPlan({
    workspaceId, artifactId, folderRelPath, planPath: `${folderRelPath}/plan.md`,
    mtimeMs: 1, sizeBytes: Buffer.byteLength(planBody),
  }).planId;
}

test('valid sentinels upsert by (plan_id, intent_id)', () => {
  freshFixture();
  const first = scan();
  const second = scan();
  assert.equal(first.intents.length, 1);
  assert.equal(second.intents.length, 1, 'rescan does not duplicate the intent');
  assert.equal(byIntent(second, 'int_aaaaaaaa').status, 'active');
});

test('pre-hardening scan falls back to the contained linked source proposal', () => {
  freshFixture();
  const sourceAbs = path.join(root, '.lares', 'proposals', 'source.md');
  fs.mkdirSync(path.dirname(sourceAbs), { recursive: true });
  fs.writeFileSync(sourceAbs, sentinel(intentJson('int_50a2ce00')));
  fs.unlinkSync(path.join(folderAbs, 'plan.md'));
  const result = scan();
  assert.equal(result.committed, true);
  assert.equal(byIntent(result, 'int_50a2ce00').status, 'active');
});

test('delete / move / restore preserves output history and current presence', () => {
  freshFixture();
  writeOutput('research/run-1.md', 'int_aaaaaaaa');
  let result = scan();
  assert.equal(byIntent(result, 'int_aaaaaaaa').outputs[0].presentOnDisk, true);

  fs.unlinkSync(path.join(folderAbs, 'research', 'run-1.md'));
  result = scan();
  assert.equal(byIntent(result, 'int_aaaaaaaa').outputs[0].presentOnDisk, false, 'delete marks absent');

  writeOutput('research/run-moved.md', 'int_aaaaaaaa', 'orc_2');
  result = scan();
  assert.equal(byIntent(result, 'int_aaaaaaaa').outputs.length, 2, 'move adds an observation row');
  assert.equal(byIntent(result, 'int_aaaaaaaa').outputs.find((o) => o.relPath === 'research/run-moved.md')!.presentOnDisk, true);

  writeOutput('research/run-1.md', 'int_aaaaaaaa');
  fs.unlinkSync(path.join(folderAbs, 'research', 'run-moved.md'));
  result = scan();
  assert.equal(byIntent(result, 'int_aaaaaaaa').outputs.length, 2);
  assert.equal(byIntent(result, 'int_aaaaaaaa').outputs.find((o) => o.relPath === 'research/run-1.md')!.presentOnDisk, true, 'restore revives row');
});

test('multiple runs of one open intent remain independent observations', () => {
  freshFixture();
  writeOutput('research/run-1.md', 'int_aaaaaaaa', 'orc_1');
  writeOutput('research/run-2.md', 'int_aaaaaaaa', 'orc_2');
  writePlan(`${sentinel(intentJson('int_aaaaaaaa'))}\n[fold first](research/run-1.md)\n${integration('int_aaaaaaaa', 'research/run-1.md')}`);
  const intent = byIntent(scan(), 'int_aaaaaaaa');
  assert.equal(intent.outputs.length, 2);
  assert.equal(intent.outputs.find((o) => o.relPath === 'research/run-1.md')!.foldedIn, true);
  assert.equal(intent.outputs.find((o) => o.relPath === 'research/run-2.md')!.foldedIn, false);
  assert.equal(intent.fullyFoldedIn, false);
  assert.equal(intent.open, true, 'one active unfolded rerun keeps intent open');
});

test('withdrawn outputs are excluded from the fully-folded requirement', () => {
  freshFixture();
  writeOutput('research/active.md', 'int_aaaaaaaa');
  writeOutput('research/withdrawn.md', 'int_aaaaaaaa', 'orc_2');
  writePlan(`${sentinel(intentJson('int_aaaaaaaa'))}\n[active](research/active.md)\n${integration('int_aaaaaaaa', 'research/active.md')}\n${integration('int_aaaaaaaa', 'research/withdrawn.md', 'withdrawn')}`);
  const intent = byIntent(scan(), 'int_aaaaaaaa');
  assert.equal(intent.outputs.find((o) => o.relPath === 'research/withdrawn.md')!.foldedIn, false);
  assert.equal(intent.fullyFoldedIn, true);
  assert.equal(intent.open, false);
});

test('a new intent supersedes the referenced old intent', () => {
  freshFixture();
  scan();
  writePlan(`${sentinel(intentJson('int_aaaaaaaa'))}\n${sentinel(intentJson('int_bbbbbbbb', { supersedes_intent_id: 'int_aaaaaaaa' }))}`);
  const result = scan();
  assert.equal(byIntent(result, 'int_aaaaaaaa').status, 'superseded');
  assert.equal(byIntent(result, 'int_bbbbbbbb').status, 'active');
});

test('fully-valid removal of markup withdraws a known active intent', () => {
  freshFixture();
  scan();
  writePlan('# no marked intents\n');
  assert.equal(byIntent(scan(), 'int_aaaaaaaa').status, 'withdrawn');
});

test('removing an exact reference recomputes folded_in and reopens the intent', () => {
  freshFixture();
  writeOutput('research/result.md', 'int_aaaaaaaa');
  writePlan(`${sentinel(intentJson('int_aaaaaaaa'))}\n[result](research/result.md)\n${integration('int_aaaaaaaa', 'research/result.md')}`);
  let intent = byIntent(scan(), 'int_aaaaaaaa');
  assert.equal(intent.fullyFoldedIn, true);
  assert.equal(intent.open, false);

  writePlan(`${sentinel(intentJson('int_aaaaaaaa'))}\n${integration('int_aaaaaaaa', 'research/result.md')}`);
  intent = byIntent(scan(), 'int_aaaaaaaa');
  assert.equal(intent.outputs[0].foldedIn, false);
  assert.equal(intent.open, true);
});

test('one malformed PLAN-INTENT keeps the prior last-good intent set', () => {
  freshFixture(`${sentinel(intentJson('int_aaaaaaaa'))}\n${sentinel(intentJson('int_bbbbbbbb'))}`);
  scan();
  writePlan(`${sentinel(intentJson('int_aaaaaaaa'))}\n<!--PLAN-INTENT\n{ "intent_id": "int_bbbbbbbb", BROKEN }\n-->`);
  const result = scan();
  assert.equal(result.committed, true, 'valid parsed records may still upsert');
  assert.equal(result.complete, false);
  assert.equal(byIntent(result, 'int_bbbbbbbb').status, 'active', 'malformed omission is not withdrawal');
  assert.ok(result.diagnostics.some((d) => d.kind === 'malformed-intent'));
});

test('over-cap output enumeration leaves the entire prior projection intact', () => {
  freshFixture();
  writeOutput('research/one.md', 'int_aaaaaaaa');
  const before = scan();
  writePlan('# would withdraw if partially applied\n');
  writeOutput('research/two.md', 'int_aaaaaaaa');
  const failed = scan({ maxOutputFiles: 1 });
  assert.equal(failed.committed, false);
  assert.ok(failed.diagnostics.some((d) => d.kind === 'scan-cap-exceeded'));
  assert.deepEqual(failed.intents, before.intents, 'no intent/output/folded partial writes');
});

test('a withdrawn sentinel cannot be reused and emits a diagnostic', () => {
  freshFixture();
  scan();
  writePlan('# removed\n');
  scan();
  writePlan(sentinel(intentJson('int_aaaaaaaa')));
  const result = scan();
  assert.equal(byIntent(result, 'int_aaaaaaaa').status, 'withdrawn');
  assert.ok(result.diagnostics.some((d) => d.kind === 'reused-withdrawn-sentinel'));
});

test('startup reconciliation uses the same last-good cap rule', async () => {
  freshFixture();
  writeOutput('research/one.md', 'int_aaaaaaaa');
  const before = scan();
  writePlan('# boot scan must not withdraw\n');
  writeOutput('research/two.md', 'int_aaaaaaaa');

  // The watcher uses the production cap; make plan.md itself over that cap so
  // its boot-settled scan fails before the transaction. Boot dispatch is
  // detached, but the synchronous scanner completes before its first await.
  writePlan(`# ${'x'.repeat(1_000_100)}`);
  const watcher = new watcherModule.PlanFolderWatcher();
  await watcher.reconcileWorkspace({ id: workspaceId, path: root, pathType: 'windows' }, true);
  const after = ledger.getPlanIntentLedgerProjection(planId);
  assert.deepEqual(after, before.intents, 'failed boot scan preserves the complete prior projection');
});

test('prose/code/comment substrings are rejected; only an exact Markdown link folds', () => {
  freshFixture();
  writeOutput('research/result.md', 'int_aaaaaaaa');
  writePlan(`${sentinel(intentJson('int_aaaaaaaa'))}\nresearch/result.md\n\`research/result.md\`\n<!-- [fake](research/result.md) -->\n\`\`\`md\n[fake](research/result.md)\n\`\`\`\n`);
  let intent = byIntent(scan(), 'int_aaaaaaaa');
  assert.equal(intent.outputs[0].foldedIn, false, 'substring-like forms do not fold');
  writePlan(`${sentinel(intentJson('int_aaaaaaaa'))}\n[exact](./research/result.md)`);
  intent = byIntent(scan(), 'int_aaaaaaaa');
  assert.equal(intent.outputs[0].foldedIn, true, 'normalized exact resolved link folds');
});

(async () => {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'pil-appdata-'));
  process.env.APPDATA = appData;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite,
  } as unknown as NodeJS.Module;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as DbModule;
  dbm.initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ledger = require('./plan-intent-ledger') as LedgerModule;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  watcherModule = require('./plan-folder-watcher') as WatcherModule;

  let passed = 0;
  let failed = 0;
  for (const fixture of tests) {
    try { await fixture.run(); console.log(`  ok  ${fixture.name}`); passed += 1; }
    catch (err) {
      console.error(`  FAIL ${fixture.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed += 1;
    } finally {
      if (root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }
  try { fs.rmSync(appData, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
