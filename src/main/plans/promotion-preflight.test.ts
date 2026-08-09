import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PlanningReaderListResult, Workspace } from '../../shared/types';
import type { PromotionRequestRow, StructuredPlanRow } from '../database';
import { listPlanningEntries, resetPlanningReaderRegistryForTests } from './planning-reader';
import {
  PromotionPreflightError,
  runPromotionPreflight,
  type ClaimScanResult,
  type PromotionPreflightDeps,
} from './promotion-preflight';
import { dispatchPromotion } from './promotion-dispatch';

interface TestCase { name: string; run(): Promise<void> | void }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-preflight-'));
function workspace(id: string): Workspace {
  const root = path.join(tempRoot, id);
  fs.mkdirSync(path.join(root, '.lares', 'proposals'), { recursive: true });
  return {
    id, title: id, path: root, pathType: 'windows', description: '', defaultCommand: '',
    createdAt: '', updatedAt: '', lastOpenedAt: null,
  };
}

function writeProposal(ws: Workspace, name = 'filename-does-not-match-title.md'): string {
  fs.writeFileSync(
    path.join(ws.path, '.lares', 'proposals', name),
    '---\nartifact_id: prop_1234abcd\nauthored_at: 2026-08-06T12:00:00Z\ntitle: Canonical Title\n---\n# Body\n',
  );
  const listed = listPlanningEntries(ws.path, { pathType: ws.pathType });
  return listed.entries.find((entry) => entry.kind === 'proposal')!.documents[0].docId;
}

function legacyRow(state: PromotionRequestRow['state'] = 'pending'): PromotionRequestRow {
  return {
    id: 'promreq-1', workspaceId: 'ws-1', proposalId: 'old-proposal',
    proposalArtifactId: 'prop_1234abcd', planArtifactId: 'plan_1234abcd',
    targetFolderRelPath: '.lares/plans/old', supervisorId: null, orchestrationId: null,
    state, attemptCount: 1, failureReason: null, createdAt: 1, updatedAt: 1,
  };
}

function planRow(folderRelPath: string): StructuredPlanRow {
  return {
    id: 'plan-row-1', workspaceId: 'ws-1', artifactId: 'plan_manual', folderRelPath,
    path: `${folderRelPath}/plan.md`, format: 'structured', runState: null,
    mtimeMs: 1, sizeBytes: 1, deletedAt: null,
  };
}

test('promotion dispatch rejects non-contract portable identity before reservation or launch', async () => {
  let launched = false;
  const request = { ...legacyRow(), proposalArtifactId: 'prop_pigt5a83', planArtifactId: 'plan_pigt5a83' };
  await assert.rejects(dispatchPromotion({
    request, workspaceId: request.workspaceId, supervisorId: 'sup-1', prompt: 'x', marker: 'x',
    launchInput: {} as any, retry: false,
    deliverer: {
      async launchAgent() { launched = true; throw new Error('must not launch'); },
      async sendInputConfirmed() { throw new Error('must not send'); },
    },
    now: () => '2026-08-08T00:00:00.000Z', genRunId: () => 'run-never',
  }), /rejected non-contract or mismatched portable artifact identity/);
  assert.equal(launched, false);
});

function deps(
  ws: Workspace,
  scan: ClaimScanResult = { kind: 'none' },
  over: Partial<PromotionPreflightDeps> = {},
): Partial<PromotionPreflightDeps> {
  return {
    getWorkspace: (id) => id === ws.id ? ws : null,
    scanClaims: async () => scan,
    getLegacyRequest: () => null,
    getPlanByArtifactId: () => null,
    reconcileFolder: async () => undefined,
    ...over,
  };
}

test('allowed identity and path come from the same server-read bytes, not the filename', async () => {
  resetPlanningReaderRegistryForTests();
  const ws = workspace('ws-allowed');
  const docId = writeProposal(ws);
  const result = await runPromotionPreflight({
    workspaceId: ws.id, proposalDocumentId: docId, artifactIdCrossCheck: 'prop_1234abcd',
  }, deps(ws));
  assert.deepEqual(result, {
    status: 'allowed',
    proposalRelPath: '.lares/proposals/filename-does-not-match-title.md',
    planArtifactId: 'plan_1234abcd',
    targetFolderRelPath: '.lares/plans/2026-08-06-canonical-title-1234abcd',
  });
});

test('spoofed artifact cross-check rejects', async () => {
  resetPlanningReaderRegistryForTests();
  const ws = workspace('ws-spoof');
  const docId = writeProposal(ws);
  await assert.rejects(
    runPromotionPreflight({ workspaceId: ws.id, proposalDocumentId: docId, artifactIdCrossCheck: 'prop_deadbeef' }, deps(ws)),
    (error: unknown) => error instanceof PromotionPreflightError
      && error.code === 'preflight-artifact-cross-check-rejected',
  );
});

test('cross-workspace and stale opaque handles reject before reading bytes', async () => {
  resetPlanningReaderRegistryForTests();
  const source = workspace('ws-source');
  const target = workspace('ws-target');
  const docId = writeProposal(source);
  await assert.rejects(
    runPromotionPreflight({ workspaceId: target.id, proposalDocumentId: docId }, deps(target)),
    /stale, foreign, or not a proposal/,
  );
  fs.unlinkSync(path.join(source.path, '.lares', 'proposals', 'filename-does-not-match-title.md'));
  await assert.rejects(
    runPromotionPreflight({ workspaceId: source.id, proposalDocumentId: docId }, deps(source)),
    /stale, foreign, or not a proposal/,
  );
});

test('foreign categories and unsafe proposal names reject', async () => {
  const ws = workspace('ws-category');
  const listing = (category: 'plan' | 'proposal', name: string): PlanningReaderListResult => ({
    entries: [{
      entryId: 'entry', kind: 'proposal', title: 'x', mtimeMs: 1,
      documents: [{ docId: 'opaque', name, category, sizeBytes: 1, mtimeMs: 1 }],
    }],
    warnings: [],
  });
  await assert.rejects(
    runPromotionPreflight({ workspaceId: ws.id, proposalDocumentId: 'opaque' }, deps(ws, { kind: 'none' }, {
      listPlanningEntries: () => listing('plan', 'plan.md'),
    })),
    /not a proposal/,
  );
  await assert.rejects(
    runPromotionPreflight({ workspaceId: ws.id, proposalDocumentId: 'opaque' }, deps(ws, { kind: 'none' }, {
      listPlanningEntries: () => listing('proposal', '../escape.md'),
    })),
    /path is unsafe/,
  );
});

test('all claim and legacy outcomes are typed and only converged adoption navigates', async () => {
  resetPlanningReaderRegistryForTests();
  const ws = workspace('ws-outcomes');
  const docId = writeProposal(ws);
  const request = { workspaceId: ws.id, proposalDocumentId: docId };

  assert.equal((await runPromotionPreflight(request, deps(ws, {
    kind: 'duplicate', folderRelPaths: ['a', 'b'], diagnostic: 'duplicate',
  }))).status, 'duplicate-blocked');
  assert.equal((await runPromotionPreflight(request, deps(ws, {
    kind: 'foreign', folderRelPath: '.lares/plans/foreign', diagnostic: 'foreign',
  }))).status, 'foreign-blocked');
  assert.equal((await runPromotionPreflight(request, deps(ws, { kind: 'none' }, {
    getLegacyRequest: () => legacyRow(),
  }))).status, 'legacy-draining');

  const folder = '.lares/plans/manual-folder';
  const claim: ClaimScanResult = { kind: 'claimed', planArtifactId: 'plan_manual', folderRelPath: folder };
  assert.equal((await runPromotionPreflight(request, deps(ws, claim, {
    reconcileFolder: async () => { throw new Error('not settled'); },
  }))).status, 'folder-awaiting-adoption');

  let reconciled = false;
  const adopted = await runPromotionPreflight(request, deps(ws, claim, {
    reconcileFolder: async () => { reconciled = true; },
    getPlanByArtifactId: () => reconciled ? planRow(folder) : null,
  }));
  assert.equal(adopted.status, 'already-adopted');
  assert.equal(reconciled, true, 'coordinator must settle before the adopted-row read');
});

test('source guard rejects a revived filename-derived identity implementation', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  const plansDir = path.join(repoRoot, 'src', 'main', 'plans');
  const forbiddenSymbol = 'derivePlan' + 'Sku';
  const productionFiles = fs.readdirSync(plansDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  for (const name of productionFiles) {
    const source = fs.readFileSync(path.join(plansDir, name), 'utf8');
    assert.equal(source.includes(forbiddenSymbol), false, `${name} revived the retired identity helper`);
  }
  assert.equal(fs.existsSync(path.join(plansDir, 'promote-proposal.ts')), false);
  const canonical = fs.readFileSync(path.join(repoRoot, 'src', 'shared', 'plan-identity.ts'), 'utf8');
  assert.equal((canonical.match(/export function derivePlanIdentity\(/g) ?? []).length, 1);
  const preflight = fs.readFileSync(path.join(plansDir, 'promotion-preflight.ts'), 'utf8');
  assert.match(preflight, /derivePlanIdentityFromMarkdown\(read\.content\)/);

  const ipc = fs.readFileSync(path.join(plansDir, 'plan-ipc.ts'), 'utf8');
  const preload = fs.readFileSync(path.join(repoRoot, 'src', 'preload', 'index.ts'), 'utf8');
  const sharedTypes = fs.readFileSync(path.join(repoRoot, 'src', 'shared', 'types.ts'), 'utf8');
  for (const source of [ipc, preload, sharedTypes]) {
    assert.equal(source.includes('proposal:' + 'promote'), false, 'retired mutate channel survived');
    assert.equal(source.includes('proposal:' + 'promotionStatus'), false, 'retired status channel survived');
  }
  assert.match(ipc, /proposal:promotionPreflight/);
  assert.match(preload, /proposal:promotionPreflight/);
  assert.match(sharedTypes, /promotionPreflight: \(input: PromotionPreflightRequest\)/);
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
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
