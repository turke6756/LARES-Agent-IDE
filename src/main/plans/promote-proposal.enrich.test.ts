// WP-P3B-enrich acceptance — saga-ordered transactional enrichment of the adopted
// plan row.
//
// Proves (mapping to the spec's Accept list):
//   - enrichment runs against an ADOPTED row and the manifest step STRICTLY
//     precedes the DB step ("DB-first is not valid ordering" asserted);
//   - the deterministic responsibility event is observed EXACTLY ONCE — never
//     duplicated across retries, whether present or appended-because-absent;
//   - the DB enrichment + `state='adopted'` flip commit ATOMICALLY (a
//     mid-transaction failure rolls the WHOLE thing back, leaving `pending`);
//   - a crash BETWEEN the manifest and DB steps leaves `pending`, and a
//     reconciler-style retry completes it with NO duplicate event;
//   - enrichment never REPLACES the adopted row / never overwrites P2-owned columns;
//   - a concurrent (non-locking) skill `plan.json` edit during observe/append is
//     PRESERVED (lock + CAS guard re-read);
//   - a MANUAL folder's matching `manual-skill` assignment is observed (no append),
//     while a MISMATCH is diagnosed and NEVER overwritten;
//   - the ONLY `plan_documents` write is the single source-proposal row (idempotent
//     across re-enrichment; no folder-internal document ever mirrored);
//   - the source-proposal rel path is containment-checked against the workspace.
//
// It is INTENTIONALLY not registered in scripts/run-main-tests.mjs (P3Z owns that
// registry). It needs the compiled service module + real plan.json folders on disk:
//   npm run build:main
//   node dist/main/main/plans/promote-proposal.enrich.test.js

import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js-backed better-sqlite3 stand-in (promote-proposal.core.test precedent) ─
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
  pragma(_s: string): unknown { return undefined; }
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

/* eslint-disable @typescript-eslint/no-explicit-any */
let dbm: any;
let promote: any;
let manifestMod: any;
let wsId = '';
const tmpDirs: string[] = [];

const PLANS_HOME_REL = '.lares/plans';

interface Ctx {
  home: string;
  wsRoot: string;
  folderName: string;
  folder: string;
  planId: string;
  request: any;
  responsibilityEventId: string;
  supervisorId: string;
  proposalId: string;
  manifestSrcRel: string;
}

async function readManifest(folder: string): Promise<any> {
  return JSON.parse(await fsp.readFile(path.join(folder, 'plan.json'), 'utf8'));
}
async function readEvents(folder: string): Promise<any[]> {
  return (await readManifest(folder)).responsibility_events ?? [];
}

/** Seed a fully adopted, filesystem-scaffolded, still-`pending` promotion for `hex`. */
async function mk(hex: string, opts: {
  buildEvents?: (responsibilityEventId: string, supervisorId: string) => any[];
  manifestSrcRel?: string;
  supervisorId?: string;
} = {}): Promise<Ctx> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), `enrich-home-${hex}-`));
  const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `enrich-ws-${hex}-`));
  tmpDirs.push(home, wsRoot);

  const folderName = `2026-08-03-feat-${hex}`;
  const folder = path.join(home, folderName);
  await fsp.mkdir(folder, { recursive: true });

  const supervisorId = opts.supervisorId ?? `sup-${hex}`;
  const requestId = `promreq-${hex}`;
  const responsibilityEventId = promote.deriveResponsibilityEventId(requestId);
  const manifestSrcRel = opts.manifestSrcRel ?? `.lares/proposals/2026-08-03-feature-${hex}.md`;
  const proposalPath = `.lares/proposals/2026-08-03-feature-${hex}.md`;

  const manifest = {
    schema_version: 1,
    plan_artifact_id: `plan_${hex}`,
    plan_sku: folderName,
    source_proposal: { artifact_id: `prop_${hex}`, rel_path: manifestSrcRel },
    responsibility_events: opts.buildEvents ? opts.buildEvents(responsibilityEventId, supervisorId) : [],
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  await fsp.writeFile(path.join(folder, 'plan.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const proposalId = `prop-row-${hex}`;
  dbm.insertProposalRecord({
    id: proposalId, artifactId: `prop_${hex}`, workspaceId: wsId, path: proposalPath,
    slug: null, title: null, state: 'proposal', authorAgentId: null, authorRole: 'unknown',
    authorDisplay: null, authoredAt: null, createdAt: Date.now(), updatedAt: Date.now(),
    mtimeMs: null, sizeBytes: null, promotedToPlanId: null, deletedAt: null,
  });

  const adopt = dbm.adoptStructuredPlan({
    workspaceId: wsId, artifactId: `plan_${hex}`, folderRelPath: `${PLANS_HOME_REL}/${folderName}`,
    planPath: `${PLANS_HOME_REL}/${folderName}/plan.md`, mtimeMs: 1, sizeBytes: 10,
  });
  const planId = adopt.planId;

  const { row: request } = dbm.insertOrReadPromotionRequest({
    id: requestId, workspaceId: wsId, proposalId, proposalArtifactId: `prop_${hex}`,
    planArtifactId: `plan_${hex}`, targetFolderRelPath: `${PLANS_HOME_REL}/${folderName}`,
    supervisorId,
  });
  assert.equal(request.state, 'pending', 'seed request is pending (folder-adopted, not yet enriched)');

  return { home, wsRoot, folderName, folder, planId, request, responsibilityEventId, supervisorId, proposalId, manifestSrcRel };
}

function makeEnrich(ctx: Ctx, over: Record<string, unknown> = {}): any {
  return promote.makeEnrichAdoptedPlan({
    resolvePlansHomeRoot: () => ctx.home,
    resolveWorkspaceRoot: () => ctx.wsRoot,
    plansHomeRelPath: PLANS_HOME_REL,
    ...over,
  });
}

function planRow(planId: string): any {
  return dbm.getDb().prepare('SELECT * FROM plans WHERE id = ?').get(planId);
}
function docRows(planId: string): any[] {
  return dbm.getDb().prepare('SELECT * FROM plan_documents WHERE plan_id = ?').all(planId);
}
function activePlan(supervisorId: string): any {
  return dbm.getDb().prepare('SELECT * FROM supervisor_active_plan WHERE supervisor_id = ?').get(supervisorId);
}
function focusRow(supervisorId: string, planId: string): any {
  return dbm.getDb().prepare('SELECT * FROM supervisor_focus WHERE supervisor_id = ? AND plan_id = ?').get(supervisorId, planId);
}

const serviceEvent = (eid: string, agentId: string) =>
  ({ event_id: eid, event: 'assigned', agent_id: agentId, at: Date.now(), source: 'promotion-service' });
const manualEvent = (agentId: string) =>
  ({ event_id: 'rev_manual', event: 'assigned', agent_id: agentId, at: Date.now(), source: 'manual-skill' });

// ── cases ─────────────────────────────────────────────────────────────────────

test('manifest step STRICTLY precedes the DB step — DB-first is not valid ordering', async () => {
  const ctx = await mk('order1', { buildEvents: (eid, sup) => [serviceEvent(eid, sup)] });
  const order: string[] = [];

  // Happy path: manifest observed BEFORE the DB transaction runs.
  const enrich = makeEnrich(ctx, {
    readManifest: async (_root: string, _rel: string) => {
      order.push('manifest');
      return readManifest(ctx.folder);
    },
    runDbStep: (input: any) => { order.push('db'); return dbm.enrichAdoptedPlanRow(input); },
  });
  await enrich({ request: ctx.request, planId: ctx.planId, responsibilityEventId: ctx.responsibilityEventId });
  assert.deepEqual(order, ['manifest', 'db'], 'manifest observation runs strictly before the DB transaction');
  assert.equal(dbm.getPromotionRequestById(ctx.request.id).state, 'adopted');

  // DB-first is not valid: if the manifest step throws, the DB step never runs and
  // the request stays pending.
  const ctx2 = await mk('order2', { buildEvents: (eid, sup) => [serviceEvent(eid, sup)] });
  let dbCalled = false;
  const enrich2 = makeEnrich(ctx2, {
    readManifest: async () => { throw new Error('manifest unavailable'); },
    runDbStep: (input: any) => { dbCalled = true; return dbm.enrichAdoptedPlanRow(input); },
  });
  await assert.rejects(() => enrich2({ request: ctx2.request, planId: ctx2.planId, responsibilityEventId: ctx2.responsibilityEventId }));
  assert.equal(dbCalled, false, 'the DB step is never reached when the manifest step fails');
  assert.equal(dbm.getPromotionRequestById(ctx2.request.id).state, 'pending', 'request stays pending — DB-first is not valid ordering');
});

test('deterministic event PRESENT → observed exactly once; retry never duplicates', async () => {
  const ctx = await mk('obs1', { buildEvents: (eid, sup) => [serviceEvent(eid, sup)] });
  const enrich = makeEnrich(ctx);

  await enrich({ request: ctx.request, planId: ctx.planId, responsibilityEventId: ctx.responsibilityEventId });
  let events = await readEvents(ctx.folder);
  assert.equal(events.length, 1, 'no append when the deterministic event is already present');
  assert.equal(events[0].event_id, ctx.responsibilityEventId);
  assert.equal(dbm.getPromotionRequestById(ctx.request.id).state, 'adopted');

  // Reconciler-style retry (re-read the now-adopted request) — still exactly one.
  const retryReq = dbm.getPromotionRequestById(ctx.request.id);
  await enrich({ request: retryReq, planId: ctx.planId, responsibilityEventId: ctx.responsibilityEventId });
  events = await readEvents(ctx.folder);
  assert.equal(events.length, 1, 'retry does not duplicate the observed event');
  assert.equal(docRows(ctx.planId).length, 1, 'retry does not duplicate the plan_documents row');
});

test('deterministic event ABSENT → appended exactly once; retry never duplicates', async () => {
  const ctx = await mk('obs2'); // events: []
  const enrich = makeEnrich(ctx);

  await enrich({ request: ctx.request, planId: ctx.planId, responsibilityEventId: ctx.responsibilityEventId });
  let events = await readEvents(ctx.folder);
  assert.equal(events.length, 1, 'the deterministic event was appended because it was absent');
  assert.equal(events[0].event_id, ctx.responsibilityEventId);
  assert.equal(events[0].source, 'promotion-service');
  assert.equal(events[0].agent_id, ctx.supervisorId);

  const retryReq = dbm.getPromotionRequestById(ctx.request.id);
  await enrich({ request: retryReq, planId: ctx.planId, responsibilityEventId: ctx.responsibilityEventId });
  events = await readEvents(ctx.folder);
  assert.equal(events.length, 1, 'retry re-observes (no second append)');
});

test('DB enrichment + adopted flip commit atomically (full happy-path surface)', async () => {
  const ctx = await mk('atomic1', { buildEvents: (eid, sup) => [serviceEvent(eid, sup)] });
  await makeEnrich(ctx)({ request: ctx.request, planId: ctx.planId, responsibilityEventId: ctx.responsibilityEventId });

  const plan = planRow(ctx.planId);
  assert.equal(plan.source_proposal_id, ctx.proposalId, 'plan attached to its source proposal');
  assert.equal(plan.responsible_supervisor_id, ctx.supervisorId, 'plan got the responsible supervisor');
  assert.ok(plan.promoted_at, 'promoted_at stamped');

  const ap = activePlan(ctx.supervisorId);
  assert.equal(ap.plan_id, ctx.planId, 'supervisor_active_plan points at the enriched plan');
  assert.ok(focusRow(ctx.supervisorId, ctx.planId), 'an ordinary supervisor_focus row exists');

  const prop = dbm.getDb().prepare('SELECT * FROM proposals WHERE id = ?').get(ctx.proposalId);
  assert.equal(prop.state, 'promoted', 'source proposal state=promoted');
  assert.equal(prop.promoted_to_plan_id, ctx.planId, 'source proposal linked to the plan');

  const docs = docRows(ctx.planId);
  assert.equal(docs.length, 1, 'exactly one plan_documents row');
  assert.equal(docs[0].doc_kind, 'proposal');
  assert.equal(docs[0].rel_path, ctx.manifestSrcRel);

  assert.equal(dbm.getPromotionRequestById(ctx.request.id).state, 'adopted', 'request flipped to adopted');
});

test('atomic: a mid-transaction failure rolls the WHOLE transaction back (request stays pending)', async () => {
  const ctx = await mk('rollback1', { buildEvents: (eid, sup) => [serviceEvent(eid, sup)] });

  // Pre-seed a plan_documents row (a DIFFERENT plan) whose PK the enrichment will
  // collide with, forcing the INSERT — step 5 — to throw AFTER steps 1–4 have run.
  dbm.getDb().prepare(
    `INSERT INTO plan_documents (id, plan_id, workspace_id, doc_kind, rel_path, sort_order, created_at)
     VALUES ('dup-doc-id', 'other-plan', ?, 'proposal', '.lares/proposals/other.md', 0, datetime('now'))`,
  ).run(wsId);

  assert.throws(() => dbm.enrichAdoptedPlanRow({
    requestId: ctx.request.id, planId: ctx.planId, workspaceId: wsId,
    sourceProposalId: ctx.proposalId, responsibleSupervisorId: ctx.supervisorId,
    sourceProposalRelPath: ctx.manifestSrcRel, docId: 'dup-doc-id', nowMs: Date.now(),
  }), 'the colliding plan_documents PK makes the transaction throw');

  // Nothing partially committed.
  assert.equal(dbm.getPromotionRequestById(ctx.request.id).state, 'pending', 'request untouched (still pending)');
  assert.equal(planRow(ctx.planId).source_proposal_id, null, 'plan enrichment rolled back');
  assert.equal(planRow(ctx.planId).responsible_supervisor_id, null, 'responsible supervisor rolled back');
  assert.equal(activePlan(ctx.supervisorId), undefined, 'no supervisor_active_plan row');
  assert.equal(dbm.getDb().prepare('SELECT state FROM proposals WHERE id = ?').get(ctx.proposalId).state, 'proposal', 'proposal not promoted');
  assert.equal(docRows(ctx.planId).length, 0, 'no plan_documents row for our plan');
});

test('crash BETWEEN manifest and DB leaves pending; reconciler retry completes with NO duplicate event', async () => {
  const ctx = await mk('crash1'); // events: [] → step 1 appends

  // First pass: manifest appends the event, then the DB step "crashes".
  const enrichCrash = makeEnrich(ctx, {
    runDbStep: () => { throw new Error('simulated crash after manifest, before DB commit'); },
  });
  await assert.rejects(() => enrichCrash({ request: ctx.request, planId: ctx.planId, responsibilityEventId: ctx.responsibilityEventId }));

  assert.equal(dbm.getPromotionRequestById(ctx.request.id).state, 'pending', 'crash leaves the request pending');
  let events = await readEvents(ctx.folder);
  assert.equal(events.length, 1, 'the event was appended exactly once before the crash');

  // Reconciler-style retry with the real DB step: re-observes (no second append),
  // then completes the DB transaction.
  const retryReq = dbm.getPromotionRequestById(ctx.request.id);
  await makeEnrich(ctx)({ request: retryReq, planId: ctx.planId, responsibilityEventId: ctx.responsibilityEventId });

  assert.equal(dbm.getPromotionRequestById(ctx.request.id).state, 'adopted', 'retry completes the enrichment');
  events = await readEvents(ctx.folder);
  assert.equal(events.length, 1, 'no duplicate responsibility event across the crash + retry');
});

test('never REPLACES the adopted row / never overwrites P2-owned columns', async () => {
  const ctx = await mk('p2cols1', { buildEvents: (eid, sup) => [serviceEvent(eid, sup)] });
  const before = planRow(ctx.planId);

  await makeEnrich(ctx)({ request: ctx.request, planId: ctx.planId, responsibilityEventId: ctx.responsibilityEventId });
  const after = planRow(ctx.planId);

  assert.equal(after.id, before.id, 'the adopted row is the SAME row (never replaced)');
  for (const col of ['folder_rel_path', 'path', 'format', 'run_state', 'artifact_id', 'mtime_ms', 'size_bytes']) {
    assert.equal(after[col], before[col], `P2-owned column ${col} is untouched`);
  }
  // Only the P3-owned columns changed.
  assert.equal(before.source_proposal_id, null);
  assert.equal(after.source_proposal_id, ctx.proposalId, 'only the P3 enrichment column changed');
});

test('concurrent (non-locking) skill plan.json edit during observe/append is PRESERVED (lock + CAS)', async () => {
  const ctx = await mk('cas1'); // events: [] → enrich appends the service event
  let injected = false;
  const skillEvent = { event_id: 'rev_skill', event: 'note', agent_id: 'skill-x', at: Date.now(), source: 'manual-skill' };

  // A one-shot rogue writer: between the CAS read and rename, a non-locking writer
  // slips a skill event into plan.json. The guard re-read must re-apply the service
  // append against the fresh manifest so BOTH survive.
  const appendWithRogue = (root: string, rel: string, event: any) =>
    manifestMod.casAppendResponsibilityEvent(root, rel, event, {
      ownerKind: 'service',
      onAfterRead: async (planJsonPath: string) => {
        if (injected) return;
        injected = true;
        const cur = JSON.parse(await fsp.readFile(planJsonPath, 'utf8'));
        cur.responsibility_events = [...(cur.responsibility_events ?? []), skillEvent];
        await fsp.writeFile(planJsonPath, `${JSON.stringify(cur, null, 2)}\n`);
      },
    });

  await makeEnrich(ctx, { appendResponsibilityEvent: appendWithRogue })(
    { request: ctx.request, planId: ctx.planId, responsibilityEventId: ctx.responsibilityEventId },
  );

  const events = await readEvents(ctx.folder);
  const ids = new Set(events.map((e) => e.event_id));
  assert.ok(ids.has('rev_skill'), 'the concurrent skill edit was preserved (no clobber)');
  assert.ok(ids.has(ctx.responsibilityEventId), 'the service append landed too');
  assert.equal(events.length, 2, 'exactly the two events — no lost update, no duplicate');
});

test('MANUAL folder: a matching manual-skill assignment is observed (no append), enrichment proceeds', async () => {
  const ctx = await mk('manual1', { buildEvents: (_eid, sup) => [manualEvent(sup)] });
  await makeEnrich(ctx)({ request: ctx.request, planId: ctx.planId, responsibilityEventId: ctx.responsibilityEventId });

  const events = await readEvents(ctx.folder);
  assert.equal(events.length, 1, 'the matching manual assignment is observed, not re-appended');
  assert.equal(events[0].source, 'manual-skill');
  assert.equal(dbm.getPromotionRequestById(ctx.request.id).state, 'adopted', 'enrichment proceeds on a match');
});

test('MANUAL folder: a mismatched manual-skill assignment is diagnosed and NEVER overwritten', async () => {
  const ctx = await mk('manual2', { buildEvents: () => [manualEvent('someone-else')] });
  await assert.rejects(
    () => makeEnrich(ctx)({ request: ctx.request, planId: ctx.planId, responsibilityEventId: ctx.responsibilityEventId }),
    /mismatch/i,
    'a supervisor mismatch is diagnosed',
  );

  const events = await readEvents(ctx.folder);
  assert.equal(events.length, 1, 'the manifest was NOT touched');
  assert.equal(events[0].agent_id, 'someone-else', 'the pre-existing assignment was never overwritten');
  assert.equal(dbm.getPromotionRequestById(ctx.request.id).state, 'pending', 'no DB enrichment on a mismatch');
  assert.equal(planRow(ctx.planId).source_proposal_id, null, 'plan not enriched on a mismatch');
});

test('plan_documents single-row guard: idempotent across re-enrichment; only the source-proposal row', async () => {
  const ctx = await mk('docs1', { buildEvents: (eid, sup) => [serviceEvent(eid, sup)] });
  const enrich = makeEnrich(ctx);

  await enrich({ request: ctx.request, planId: ctx.planId, responsibilityEventId: ctx.responsibilityEventId });
  let docs = docRows(ctx.planId);
  assert.equal(docs.length, 1, 'the ONLY plan_documents write is the single source-proposal row');
  assert.equal(docs[0].doc_kind, 'proposal');
  assert.equal(docs[0].rel_path, ctx.manifestSrcRel);
  const docId = docs[0].id;

  // Re-enrich (reconciler retry) — still exactly one row, same id (no duplicate,
  // nothing else ever mirrored).
  await enrich({ request: dbm.getPromotionRequestById(ctx.request.id), planId: ctx.planId, responsibilityEventId: ctx.responsibilityEventId });
  docs = docRows(ctx.planId);
  assert.equal(docs.length, 1, 're-enrichment never duplicates the row');
  assert.equal(docs[0].id, docId, 'the same single row is reused');
  const nonProposal = docs.filter((d) => d.doc_kind !== 'proposal');
  assert.equal(nonProposal.length, 0, 'no folder-internal document is ever mirrored');
});

test('source_proposal.rel_path is containment-checked — an escaping path is rejected, no DB write', async () => {
  const ctx = await mk('contain1', {
    buildEvents: (eid, sup) => [serviceEvent(eid, sup)],
    manifestSrcRel: '../../../../etc/passwd',
  });
  await assert.rejects(
    () => makeEnrich(ctx)({ request: ctx.request, planId: ctx.planId, responsibilityEventId: ctx.responsibilityEventId }),
    /escapes the workspace/i,
  );
  assert.equal(dbm.getPromotionRequestById(ctx.request.id).state, 'pending', 'no enrichment on an escaping rel path');
  assert.equal(docRows(ctx.planId).length, 0, 'no plan_documents row written');
});

// ── Runner ──────────────────────────────────────────────────────────────────
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-enrich-'));
  process.env.APPDATA = tmpAppData;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  sqlJsCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database');
  promote = require('./promote-proposal');
  manifestMod = require('./plan-manifest');
  dbm.initDatabase();
  wsId = dbm.createWorkspace({ title: 'promote-enrich-ws', path: 'C:\\tmp\\ws', pathType: 'windows' }).id;

  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
