import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type SqlDb = { exec(sql: string): unknown; run(sql: string, params?: unknown[]): unknown; prepare(sql: string): any };
let SqlCtor: new () => SqlDb;
class FakeBetterSqlite {
  private static stores = new Map<string, SqlDb>();
  private db: SqlDb;
  constructor(file = ':memory:') {
    this.db = FakeBetterSqlite.stores.get(file) ?? new SqlCtor();
    FakeBetterSqlite.stores.set(file, this.db);
  }
  pragma(): undefined { return undefined; }
  close(): void { /* persisted fake store */ }
  exec(sql: string): this { this.db.exec(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...params: unknown[]) => { inner.run(sql, params); return {}; },
      get: (...params: unknown[]) => { const s = inner.prepare(sql); try { s.bind(params); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } },
      all: (...params: unknown[]) => { const s = inner.prepare(sql); const rows: unknown[] = []; try { s.bind(params); while (s.step()) rows.push(s.getAsObject()); return rows; } finally { s.free(); } },
    };
  }
  transaction<A extends unknown[]>(fn: (...args: A) => unknown) {
    return (...args: A) => { this.db.exec('BEGIN'); try { const v = fn(...args); this.db.exec('COMMIT'); return v; } catch (e) { this.db.exec('ROLLBACK'); throw e; } };
  }
}

(async () => {
  const initSqlJs = require('sql.js');
  SqlCtor = (await initSqlJs()).Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeBetterSqlite } as NodeJS.Module;
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'source-projection-db-'));
  process.env.APPDATA = appData;
  const dbm = require('../database') as typeof import('../database');
  dbm.initDatabase();
  const reconciler = require('./plan-source-proposal-reconciler') as typeof import('./plan-source-proposal-reconciler');
  const coordinator = require('./plan-folder-reconciler') as typeof import('./plan-folder-reconciler');

  let passed = 0;
  const run = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try { await fn(); console.log(`  ok  ${name}`); passed += 1; }
    catch (err) { console.error(`  FAIL ${name}`, err); process.exitCode = 1; }
  };
  let seq = 0;
  function fixture(opts: { mismatchingDocument?: boolean } = {}) {
    seq += 1;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `source-projection-ws-${seq}-`));
    const ws = dbm.createWorkspace({ title: `ws-${seq}`, path: root, pathType: 'windows' });
    const artifactHex = seq.toString(16).padStart(8, '0');
    const artifact = `prop_${artifactHex}`;
    const planArtifact = `plan_${artifactHex}`;
    const proposalRel = `.lares/proposals/source-${seq}.md`;
    fs.mkdirSync(path.join(root, '.lares', 'proposals'), { recursive: true });
    fs.writeFileSync(path.join(root, proposalRel), `---\nartifact_id: ${artifact}\nauthored_at: 2026-08-06\ntitle: Source ${seq}\n---\n# Source\n`);
    const folderRel = `.lares/plans/source-${seq}`;
    const folderAbs = path.join(root, folderRel);
    fs.mkdirSync(folderAbs, { recursive: true });
    fs.writeFileSync(path.join(folderAbs, 'plan.md'), '# Plan\n');
    fs.writeFileSync(path.join(folderAbs, 'plan.json'), JSON.stringify({
      schema_version: 1, plan_artifact_id: planArtifact, plan_sku: `source-${seq}`,
      source_proposal: { artifact_id: artifact, rel_path: proposalRel },
      responsibility_events: [], created_at: 1_786_000_000_000, updated_at: 1_786_000_000_000,
    }));
    const plan = dbm.adoptStructuredPlan({ workspaceId: ws.id, artifactId: planArtifact,
      folderRelPath: folderRel, planPath: `${folderRel}/plan.md`, mtimeMs: 1, sizeBytes: 1 });
    dbm.insertProposalRecord({ id: `proposal-row-${seq}`, artifactId: artifact, workspaceId: ws.id,
      path: proposalRel, slug: null, title: `Source ${seq}`, state: 'proposal', authorAgentId: null,
      authorRole: 'unknown', authorDisplay: null, authoredAt: null, createdAt: 10, updatedAt: 10,
      mtimeMs: 1, sizeBytes: 1, promotedToPlanId: null, deletedAt: null });
    if (opts.mismatchingDocument) dbm.getDb().prepare(`INSERT INTO plan_documents
      (id, plan_id, workspace_id, doc_kind, rel_path, artifact_ref) VALUES (?, ?, ?, 'proposal', ?, ?)`)
      .run(`foreign-doc-${seq}`, plan.planId, ws.id, `.lares/proposals/foreign-${seq}.md`, `prop_foreign_${seq}`);
    return { root, ws, artifact, planArtifact, proposalRel, folderAbs, planId: plan.planId };
  }

  await run('valid source transaction is isolated, idempotent, and preserves promoted_at', () => {
    const f = fixture();
    const input = { workspace: f.ws, planId: f.planId, folderAbs: f.folderAbs,
      expectedPlanArtifactId: f.planArtifact, now: () => 1_786_000_000_100 };
    const first = reconciler.reconcilePlanSourceProposal(input);
    assert.equal(first.status, 'synced');
    const raw = dbm.getDb();
    const plan = raw.prepare('SELECT source_proposal_id, promoted_at, responsible_supervisor_id FROM plans WHERE id = ?').get(f.planId) as any;
    assert.equal(plan.source_proposal_id, 'proposal-row-1');
    assert.equal(plan.promoted_at, 1_786_000_000_000);
    assert.equal(plan.responsible_supervisor_id, null);
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM plan_documents WHERE plan_id = ? AND doc_kind='proposal'").get(f.planId) as any).n, 1);
    assert.equal((raw.prepare('SELECT artifact_ref FROM plan_documents WHERE plan_id = ?').get(f.planId) as any).artifact_ref, f.artifact);
    raw.prepare('UPDATE plans SET promoted_at = 123 WHERE id = ?').run(f.planId);
    assert.equal(reconciler.reconcilePlanSourceProposal(input).status, 'synced');
    assert.equal((raw.prepare('SELECT promoted_at FROM plans WHERE id = ?').get(f.planId) as any).promoted_at, 123);
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM supervisor_active_plan').get() as any).n, 0);
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM plan_work_packages WHERE plan_id = ?').get(f.planId) as any).n, 0);
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM promotion_requests').get() as any).n, 0);
  });

  await run('mismatching proposal document records conflict with no linkage or deletion', () => {
    const f = fixture({ mismatchingDocument: true });
    const result = reconciler.reconcilePlanSourceProposal({ workspace: f.ws, planId: f.planId,
      folderAbs: f.folderAbs, expectedPlanArtifactId: f.planArtifact });
    assert.equal(result.status, 'conflict');
    assert.equal(result.diagnosticCode, 'proposal-document-mismatch');
    const raw = dbm.getDb();
    assert.equal((raw.prepare('SELECT source_proposal_id FROM plans WHERE id = ?').get(f.planId) as any).source_proposal_id, null);
    assert.equal((raw.prepare('SELECT state FROM proposals WHERE id = ?').get(`proposal-row-${seq}`) as any).state, 'proposal');
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM plan_documents WHERE plan_id = ? AND doc_kind='proposal'").get(f.planId) as any).n, 1);
  });

  await run('coordinator is single-flight and callbacks observe source plus responsibility completion', async () => {
    const f = fixture();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const services = {
      scanIntentLedger: (() => { order.push('intent'); return { committed: true, complete: true, diagnostics: [], intents: [] }; }) as any,
      reconcileSourceProposal: (() => { order.push('source'); return {
        planId: f.planId, workspaceId: f.ws.id, status: 'synced', sourceArtifactId: f.artifact,
        sourceRelPath: f.proposalRel, diagnosticCode: null, diagnosticsJson: '[]', diagnostics: [],
        observedManifestMtime: 1, reconciledAt: 1,
      }; }) as any,
      reconcilePlanningState: (() => { order.push('responsibility-packages-overview'); return {
        responsibility: { status: 'valid', supervisorId: 'supervisor-1' },
        workPackages: { status: 'synced', diagnostics: [] },
        overview: { status: 'synced', diagnostics: [] },
      }; }) as any,
    };
    const first = coordinator.reconcilePlanFolderProjections({ workspace: f.ws,
      planFolderRelPath: `.lares/plans/source-${seq}`, services,
      downstreamCallbacks: [async (result) => {
        assert.equal(result.sourceProposal.status, 'synced');
        assert.equal(result.responsibility.status, 'valid');
        order.push('callback');
        await gate;
      }],
    });
    const joined = coordinator.reconcilePlanFolderProjections({ workspace: f.ws,
      planFolderRelPath: `.lares/plans/source-${seq}`, services,
      downstreamCallbacks: [() => { order.push('joined-callback'); }],
    });
    assert.equal(joined, first, 'concurrent callers join the same promise');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['intent', 'source', 'responsibility-packages-overview', 'callback']);
    release();
    await Promise.all([first, joined]);
    assert.deepEqual(order, ['intent', 'source', 'responsibility-packages-overview', 'callback', 'joined-callback']);
  });

  await run('source failure is durable and does not prevent responsibility/package/overview convergence', async () => {
    const f = fixture();
    let planningRan = false;
    const result = await coordinator.reconcilePlanFolderProjections({ workspace: f.ws,
      planFolderRelPath: `.lares/plans/source-${seq}`,
      services: {
        scanIntentLedger: (() => ({ committed: true, complete: true, diagnostics: [], intents: [] })) as any,
        reconcileSourceProposal: (() => { throw new Error('injected source failure'); }) as any,
        reconcilePlanningState: (() => {
          planningRan = true;
          return {
            responsibility: { status: 'valid', supervisorId: 'supervisor-1' },
            workPackages: { status: 'synced', diagnostics: [] },
            overview: { status: 'synced', diagnostics: [] },
          };
        }) as any,
      },
    });
    assert.equal(planningRan, true);
    assert.equal(result.sourceProposal.status, 'invalid');
    assert.equal(result.responsibility.status, 'valid');
  });

  await run('dirty duplicate groups defer the partial unique index and retain every row', () => {
    const f = fixture();
    const raw = dbm.getDb();
    raw.exec('DROP INDEX idx_plan_documents_one_proposal_per_plan');
    raw.prepare(`INSERT INTO plan_documents (id, plan_id, workspace_id, doc_kind, rel_path)
      VALUES (?, ?, ?, 'proposal', ?), (?, ?, ?, 'proposal', ?)`)
      .run(`dup-a-${seq}`, f.planId, f.ws.id, f.proposalRel, `dup-b-${seq}`, f.planId, f.ws.id, f.proposalRel);
    dbm.initDatabase();
    assert.equal((dbm.getDb().prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='idx_plan_documents_one_proposal_per_plan'").get() as any).n, 0);
    assert.equal((dbm.getDb().prepare("SELECT COUNT(*) AS n FROM plan_documents WHERE plan_id = ? AND doc_kind='proposal'").get(f.planId) as any).n, 2);
    assert.equal(dbm.getPlanSourceProposalProjectionState(f.planId)?.status, 'conflict');
  });

  console.log(`\n${passed} passed, ${process.exitCode ? 1 : 0} failed`);
  try { fs.rmSync(appData, { recursive: true, force: true }); } catch { /* best effort */ }
})();
