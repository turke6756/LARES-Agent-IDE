import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PlanningReaderListResult, Workspace } from '../../shared/types';
import type { ProposalRecord } from '../database';
import { resetWorkspaceStateDirCacheForTests } from '../workspace-state-dir';
import { registerProposalDeleteIpc } from './plan-ipc';
import { deleteProposal, type ProposalDeleteDeps } from './proposal-delete';
import { listPlanningEntries, resetPlanningReaderRegistryForTests } from './planning-reader';

interface TestCase { name: string; run(): void | Promise<void> }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-delete-'));

function makeWorkspace(name: string): Workspace {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(path.join(root, '.lares', 'proposals', 'supporting'), { recursive: true });
  fs.mkdirSync(path.join(root, '.lares', 'plans'), { recursive: true });
  return {
    id: name,
    title: name,
    path: root,
    pathType: 'windows',
    description: '',
    defaultCommand: '',
    createdAt: '',
    updatedAt: '',
    lastOpenedAt: null,
  };
}

function proposalRow(
  workspace: Workspace,
  name = 'ordinary.md',
  overrides: Partial<ProposalRecord> = {},
): ProposalRecord {
  return {
    id: `row-${workspace.id}`,
    artifactId: 'prop_1234abcd',
    workspaceId: workspace.id,
    path: `.lares/proposals/${name}`,
    slug: name.replace(/\.md$/, ''),
    title: 'Proposal',
    state: 'proposal',
    authorAgentId: null,
    authorRole: 'unknown',
    authorDisplay: null,
    authoredAt: null,
    createdAt: 1,
    updatedAt: 1,
    mtimeMs: 1,
    sizeBytes: 1,
    promotedToPlanId: null,
    deletedAt: null,
    ...overrides,
  };
}

function writeAndList(workspace: Workspace, name = 'ordinary.md'): string {
  fs.writeFileSync(
    path.join(workspace.path, '.lares', 'proposals', name),
    '---\nartifact_id: prop_1234abcd\n---\n# Proposal\n',
  );
  return listPlanningEntries(workspace.path, { pathType: workspace.pathType })
    .entries.find((entry) => entry.kind === 'proposal' && entry.documents[0]?.name === name)!
    .documents[0].docId;
}

function deps(workspace: Workspace, row: ProposalRecord): Partial<ProposalDeleteDeps> {
  return {
    getWorkspace: (id) => id === workspace.id ? workspace : null,
    getProposalByWorkspacePath: (workspaceId, relPath) =>
      workspaceId === row.workspaceId && relPath === row.path ? row : null,
  };
}

function listedDocument(docId: string, name: string, category: 'proposal' | 'plan' = 'proposal'): PlanningReaderListResult {
  return {
    entries: [{
      entryId: 'entry',
      kind: 'proposal',
      title: name,
      documents: [{ docId, name, category, sizeBytes: 1, mtimeMs: 1 }],
      mtimeMs: 1,
    }],
    warnings: [],
  };
}

test('refuses both promoted proposal-row signals', () => {
  for (const [suffix, fields] of [
    ['state', { state: 'promoted' as const }],
    ['link', { promotedToPlanId: 'plan-1' }],
  ] as const) {
    resetPlanningReaderRegistryForTests();
    const workspace = makeWorkspace(`promoted-${suffix}`);
    const docId = writeAndList(workspace);
    const row = proposalRow(workspace, 'ordinary.md', fields);
    assert.deepEqual(deleteProposal({ workspaceId: workspace.id, proposalDocumentId: docId }, deps(workspace, row)), {
      ok: false, reason: 'promoted',
    });
    assert.equal(fs.existsSync(path.join(workspace.path, '.lares', 'proposals', 'ordinary.md')), true);
  }
});

test('refuses plan.json source references by artifact_id or rel_path', () => {
  for (const [suffix, source] of [
    ['artifact', { artifact_id: 'prop_1234abcd', rel_path: '.lares/proposals/different.md' }],
    ['path', { artifact_id: 'prop_deadbeef', rel_path: '.dashboard\\proposals\\ordinary.md' }],
  ] as const) {
    resetPlanningReaderRegistryForTests();
    const workspace = makeWorkspace(`source-${suffix}`);
    const docId = writeAndList(workspace);
    const planDir = path.join(workspace.path, '.lares', 'plans', 'claimed');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, 'plan.json'), JSON.stringify({
      plan_artifact_id: 'plan_1234abcd',
      source_proposal: source,
    }));
    const result = deleteProposal(
      { workspaceId: workspace.id, proposalDocumentId: docId },
      deps(workspace, proposalRow(workspace)),
    );
    assert.deepEqual(result, { ok: false, reason: 'plan-source-reference' });
  }
});

test('refuses a reparse target at the destructive boundary', () => {
  resetPlanningReaderRegistryForTests();
  const workspace = makeWorkspace('reparse');
  const target = path.join(tempRoot, 'reparse-target');
  fs.mkdirSync(target, { recursive: true });
  const link = path.join(workspace.path, '.lares', 'proposals', 'linked.md');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const row = proposalRow(workspace, 'linked.md');
  const result = deleteProposal(
    { workspaceId: workspace.id, proposalDocumentId: 'opaque' },
    {
      ...deps(workspace, row),
      listPlanningEntries: () => listedDocument('opaque', 'linked.md'),
    },
  );
  assert.deepEqual(result, { ok: false, reason: 'unsafe-path' });
  assert.equal(fs.existsSync(target), true);
});

test('refuses out-of-proposals and supporting handles without touching either file', () => {
  const workspace = makeWorkspace('outside');
  const outside = path.join(workspace.path, '.lares', 'outside.md');
  const supporting = path.join(workspace.path, '.lares', 'proposals', 'supporting', 'notes.md');
  fs.writeFileSync(outside, '# outside');
  fs.writeFileSync(supporting, '# supporting');
  for (const name of ['../outside.md', 'supporting/notes.md']) {
    const result = deleteProposal(
      { workspaceId: workspace.id, proposalDocumentId: 'opaque' },
      {
        ...deps(workspace, proposalRow(workspace, name)),
        listPlanningEntries: () => listedDocument('opaque', name),
      },
    );
    assert.deepEqual(result, { ok: false, reason: 'unsafe-path' });
  }
  assert.equal(fs.existsSync(outside), true);
  assert.equal(fs.existsSync(supporting), true);
});

test('refuses a foreign-workspace opaque handle and category mismatch as not-found', () => {
  resetPlanningReaderRegistryForTests();
  const source = makeWorkspace('foreign-source');
  const target = makeWorkspace('foreign-target');
  const sourceDocId = writeAndList(source);
  writeAndList(target);
  assert.deepEqual(deleteProposal(
    { workspaceId: target.id, proposalDocumentId: sourceDocId },
    deps(target, proposalRow(target)),
  ), { ok: false, reason: 'not-found' });
  assert.deepEqual(deleteProposal(
    { workspaceId: target.id, proposalDocumentId: 'opaque' },
    {
      ...deps(target, proposalRow(target)),
      listPlanningEntries: () => listedDocument('opaque', 'ordinary.md', 'plan'),
    },
  ), { ok: false, reason: 'not-found' });
});

test('deletes exactly one ordinary markdown file and leaves supporting intact', () => {
  resetPlanningReaderRegistryForTests();
  const workspace = makeWorkspace('ordinary');
  const docId = writeAndList(workspace);
  const supporting = path.join(workspace.path, '.lares', 'proposals', 'supporting', 'keep.md');
  fs.writeFileSync(supporting, '# keep');
  assert.deepEqual(deleteProposal(
    { workspaceId: workspace.id, proposalDocumentId: docId },
    deps(workspace, proposalRow(workspace)),
  ), { ok: true });
  assert.equal(fs.existsSync(path.join(workspace.path, '.lares', 'proposals', 'ordinary.md')), false);
  assert.equal(fs.readFileSync(supporting, 'utf8'), '# keep');
});

test('returns not-found for vanished and stale handles', () => {
  resetPlanningReaderRegistryForTests();
  const workspace = makeWorkspace('stale');
  const docId = writeAndList(workspace);
  fs.unlinkSync(path.join(workspace.path, '.lares', 'proposals', 'ordinary.md'));
  assert.deepEqual(deleteProposal(
    { workspaceId: workspace.id, proposalDocumentId: docId },
    deps(workspace, proposalRow(workspace)),
  ), { ok: false, reason: 'not-found' });
  assert.deepEqual(deleteProposal(
    { workspaceId: workspace.id, proposalDocumentId: 'never-issued' },
    deps(workspace, proposalRow(workspace)),
  ), { ok: false, reason: 'not-found' });
});

test('refuses when the bound file identity changes before the final unlink boundary', () => {
  resetPlanningReaderRegistryForTests();
  const workspace = makeWorkspace('identity-swap');
  const docId = writeAndList(workspace);
  const proposalPath = path.join(workspace.path, '.lares', 'proposals', 'ordinary.md');
  let unlinked = false;
  const result = deleteProposal(
    { workspaceId: workspace.id, proposalDocumentId: docId },
    {
      ...deps(workspace, proposalRow(workspace)),
      scanPlanSources: () => {
        fs.writeFileSync(proposalPath, '# replacement with a different identity\n');
        return { ok: true, references: [] };
      },
      unlink: () => { unlinked = true; },
    },
  );
  assert.deepEqual(result, { ok: false, reason: 'unsafe-path' });
  assert.equal(unlinked, false);
  assert.equal(fs.existsSync(proposalPath), true);
});

test('IPC validates identity-only input and drops renderer path fields', () => {
  let listener: ((event: unknown, raw: unknown) => unknown) | null = null;
  let received: unknown = null;
  registerProposalDeleteIpc({
    handle: (_channel, callback) => { listener = callback; },
  }, (request) => { received = request; return { ok: true }; });
  assert.deepEqual(listener!(null, {
    workspaceId: 'ws',
    proposalDocumentId: 'opaque',
    workspacePath: 'C:\\attacker',
    proposalPath: 'C:\\attacker\\victim.md',
  }), { ok: true });
  assert.deepEqual(received, { workspaceId: 'ws', proposalDocumentId: 'opaque' });
  assert.deepEqual(listener!(null, { workspaceId: 'ws' }), { ok: false, reason: 'not-found' });
});

(async () => {
  let passed = 0;
  let failed = 0;
  try {
    for (const item of tests) {
      try {
        await item.run();
        console.log(`  ok  ${item.name}`);
        passed++;
      } catch (error) {
        console.error(`  FAIL ${item.name}`);
        console.error('       ', error instanceof Error ? error.stack ?? error.message : error);
        failed++;
      }
    }
  } finally {
    resetWorkspaceStateDirCacheForTests();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
