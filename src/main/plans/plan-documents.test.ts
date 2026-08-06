// WP-P4A — folder-native tab projection and dual guarded body paths.
// Run: npm run build:main && node dist/main/main/plans/plan-documents.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  PlanningReaderDocument,
  PlanningReaderEntry,
  PlanningReaderListResult,
  Workspace,
} from '../../shared/types';
import {
  buildPlanDocuments,
  hasPlanWorkPackagesInDb,
  readPlanDocument,
  type PlanContext,
  type PlanDocumentsDeps,
  type RegisteredDocumentRow,
} from './plan-documents';

const PLAN_ID = 'plan-1';
const ARTIFACT_ID = 'plan_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SKU = '2026-08-03-example-aaaaaaaa';

function doc(
  docId: string,
  name: string,
  category: PlanningReaderDocument['category'],
): PlanningReaderDocument {
  return { docId, name, category, sizeBytes: 10, mtimeMs: 20 };
}

function folderEntry(
  documents: PlanningReaderDocument[],
  overrides: Partial<PlanningReaderEntry> = {},
): PlanningReaderEntry {
  return {
    entryId: 'entry-current',
    kind: 'plan-folder',
    title: SKU,
    documents,
    mtimeMs: 20,
    planArtifactId: ARTIFACT_ID,
    planSku: SKU,
    ...overrides,
  };
}

interface Fixture {
  root: string;
  context: PlanContext;
  workspace: Workspace;
  manifest: PlanningReaderListResult;
  registered: RegisteredDocumentRow[];
  deps: PlanDocumentsDeps;
  dispose(): void;
}

function fixture(documents: PlanningReaderDocument[] = []): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-documents-'));
  fs.mkdirSync(path.join(root, '.lares', 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(root, '.lares', 'plans', 'legacy'), { recursive: true });
  const context: PlanContext = {
    id: PLAN_ID,
    workspaceId: 'ws-1',
    artifactId: ARTIFACT_ID,
    folderRelPath: `.lares/plans/${SKU}`,
  };
  const workspace: Workspace = {
    id: 'ws-1', title: 'Workspace', path: root, pathType: 'windows', description: '',
    defaultCommand: '', createdAt: '', updatedAt: '', lastOpenedAt: null,
  };
  const manifest: PlanningReaderListResult = { entries: [folderEntry(documents)], warnings: [] };
  const registered: RegisteredDocumentRow[] = [];
  const deps: PlanDocumentsDeps = {
    getPlanContext: (id) => id === PLAN_ID ? context : null,
    getWorkspace: (id) => id === workspace.id ? workspace : null,
    listPlanningEntries: () => manifest,
    readPlanningDocument: (id) => ({
      docId: id, name: `${id}.md`, content: `body:${id}`,
      truncated: false, sizeBytes: 7,
    }),
    listRegisteredDocuments: () => registered,
    getRegisteredDocument: (planId, id) =>
      registered.find((row) => row.planId === planId && row.id === id) ?? null,
    hasWorkPackages: () => false,
    getSourceProposalProjectionState: () => null,
  };
  return { root, context, workspace, manifest, registered, deps, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function tab(model: NonNullable<ReturnType<typeof buildPlanDocuments>>, key: string) {
  return model.tabs.find((candidate) => candidate.key === key)!;
}

test('ARC.md maps to overview while plan.md maps to plan', () => {
  const f = fixture([doc('arc-id', 'ARC.md', 'arc'), doc('plan-id', 'plan.md', 'plan')]);
  try {
    const model = buildPlanDocuments(PLAN_ID, f.deps)!;
    assert.deepEqual(tab(model, 'overview').documents.map((d) => d.ref), [{ source: 'folder', documentId: 'arc-id' }]);
    assert.equal(tab(model, 'overview').populated, true);
    assert.deepEqual(tab(model, 'plan').documents.map((d) => d.ref), [{ source: 'folder', documentId: 'plan-id' }]);
  } finally { f.dispose(); }
});

test('plan.json and every .gitkeep are suppressed defensively', () => {
  const f = fixture([
    doc('json-id', 'plan.json', 'other'),
    doc('keep-top', '.gitkeep', 'other'),
    doc('keep-delib', '.gitkeep', 'deliberation'),
  ]);
  try {
    const model = buildPlanDocuments(PLAN_ID, f.deps)!;
    assert.equal(model.tabs.flatMap((t) => t.documents).length, 0);
  } finally { f.dispose(); }
});

test('cross-folder manifest documents fail the current folder membership check', () => {
  const f = fixture([doc('ours', 'ARC.md', 'arc')]);
  f.manifest.entries.push(folderEntry(
    [doc('foreign', 'plan.md', 'plan')],
    { entryId: 'entry-foreign', title: 'other-sku', planSku: 'other-sku' },
  ));
  try {
    assert.deepEqual(readPlanDocument(PLAN_ID, { source: 'folder', documentId: 'foreign' }, f.deps), {
      error: 'document is not registered to the plan folder',
    });
    assert.equal(tab(buildPlanDocuments(PLAN_ID, f.deps)!, 'plan').populated, false);
  } finally { f.dispose(); }
});

test('external proposal and legacy-html rows union with folder documents', () => {
  const f = fixture([doc('arc-id', 'ARC.md', 'arc')]);
  fs.writeFileSync(path.join(f.root, '.lares', 'proposals', 'source.md'), '# proposal');
  fs.writeFileSync(path.join(f.root, '.lares', 'plans', 'legacy', 'old.md'), '# legacy');
  f.registered.push(
    { id: 'proposal-row', planId: PLAN_ID, workspaceId: 'ws-1', docKind: 'proposal', relPath: '.lares/proposals/source.md', sortOrder: 0 },
    { id: 'legacy-row', planId: PLAN_ID, workspaceId: 'ws-1', docKind: 'legacy-html', relPath: '.lares/plans/legacy/old.md', sortOrder: 1 },
  );
  try {
    const model = buildPlanDocuments(PLAN_ID, f.deps)!;
    assert.equal(tab(model, 'proposal').populated, true);
    assert.equal(tab(model, 'legacy-html').populated, true);
    assert.match((readPlanDocument(PLAN_ID, { source: 'registered', documentId: 'proposal-row' }, f.deps) as any).content, /proposal/);
  } finally { f.dispose(); }
});

test('manifest source proposal fills the Proposal tab until a registered row exists', () => {
  const f = fixture([doc('manifest-proposal', 'source.md', 'proposal')]);
  fs.writeFileSync(path.join(f.root, '.lares', 'proposals', 'source.md'), '# proposal');
  try {
    let model = buildPlanDocuments(PLAN_ID, f.deps)!;
    assert.deepEqual(tab(model, 'proposal').documents.map((document) => document.ref), [
      { source: 'folder', documentId: 'manifest-proposal' },
    ]);
    assert.match(
      (readPlanDocument(PLAN_ID, { source: 'folder', documentId: 'manifest-proposal' }, f.deps) as any).content,
      /manifest-proposal/,
    );

    f.registered.push({
      id: 'proposal-row', planId: PLAN_ID, workspaceId: 'ws-1', docKind: 'proposal',
      relPath: '.lares/proposals/source.md', sortOrder: 0,
    });
    model = buildPlanDocuments(PLAN_ID, f.deps)!;
    assert.deepEqual(tab(model, 'proposal').documents.map((document) => document.ref), [
      { source: 'registered', documentId: 'proposal-row' },
    ]);
  } finally { f.dispose(); }
});

test('deleted deliberation degrades to an empty tab on re-list', () => {
  const f = fixture([doc('delib-id', 'answer.md', 'deliberation')]);
  try {
    assert.equal(tab(buildPlanDocuments(PLAN_ID, f.deps)!, 'deliberations').populated, true);
    f.manifest.entries[0].documents = [];
    const refreshed = buildPlanDocuments(PLAN_ID, f.deps)!;
    assert.equal(tab(refreshed, 'deliberations').populated, false);
    assert.deepEqual(tab(refreshed, 'deliberations').documents, []);
  } finally { f.dispose(); }
});

test('absent plan_work_packages table yields Packages populated:false without throwing', () => {
  const db = { prepare: () => ({ get: () => undefined }) };
  assert.equal(hasPlanWorkPackagesInDb(db, PLAN_ID), false);
  const f = fixture();
  try {
    f.deps.hasWorkPackages = (id) => hasPlanWorkPackagesInDb(db, id);
    const packages = tab(buildPlanDocuments(PLAN_ID, f.deps)!, 'packages');
    assert.equal(packages.populated, false);
    assert.match(packages.placeholder!, /not yet implemented/);
  } finally { f.dispose(); }
});

test('present plan_work_packages rows make Packages populated:true', () => {
  const db = {
    prepare: (sql: string) => ({
      get: (...params: unknown[]) => sql.includes('sqlite_master')
        ? { ok: 1 }
        : params[0] === PLAN_ID ? { ok: 1 } : undefined,
    }),
  };
  const f = fixture();
  try {
    f.deps.hasWorkPackages = (id) => hasPlanWorkPackagesInDb(db, id);
    const packages = tab(buildPlanDocuments(PLAN_ID, f.deps)!, 'packages');
    assert.equal(packages.populated, true);
    assert.equal(packages.placeholder, undefined);
  } finally { f.dispose(); }
});

test('invalid and conflicting source projections surface durable warnings', () => {
  const f = fixture();
  try {
    f.deps.getSourceProposalProjectionState = () => ({
      planId: PLAN_ID, workspaceId: f.workspace.id, status: 'conflict',
      sourceArtifactId: 'prop_x', sourceRelPath: '.lares/proposals/x.md',
      diagnosticCode: 'duplicate-proposal-documents', diagnosticsJson: '[]',
      observedManifestMtime: 1, reconciledAt: 2,
    });
    assert.deepEqual(buildPlanDocuments(PLAN_ID, f.deps)!.warnings,
      ['source proposal conflict: duplicate-proposal-documents']);
  } finally { f.dispose(); }
});

test('renderer-supplied paths and unknown handles are rejected on both body paths', () => {
  const f = fixture([doc('known-folder', 'plan.md', 'plan')]);
  try {
    for (const source of ['folder', 'registered'] as const) {
      assert.match(
        (readPlanDocument(PLAN_ID, { source, path: 'C:\\outside\\secret.md' }, f.deps) as any).error,
        /invalid|unregistered/,
      );
      assert.match(
        (readPlanDocument(PLAN_ID, { source, documentId: 'unknown' }, f.deps) as any).error,
        /not registered/,
      );
    }
  } finally { f.dispose(); }
});
