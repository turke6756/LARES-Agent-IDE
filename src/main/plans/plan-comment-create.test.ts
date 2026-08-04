// WP-P4D-create acceptance — plan-comment create + routing (logical-key identity).
//
//   npm run build:main
//   node dist/main/main/plans/plan-comment-create.test.js
//
// Pure-handler tests with injected deps (no electron, no DB, no fs). Proves the
// WP Accept list:
//   • logical-key encode/decode ROUND-TRIP; canonicalization + containment
//     rejection; a NULL-version / malformed key is undecodable;
//   • create validates plan membership for BOTH sources (folder + registered);
//   • a folder-doc comment persists `lares-plan-doc:v1:<…>` over a canonicalized
//     rel path with `path_type` AND `root_directory` NULL; `plan_artifact_id` is
//     the identity (never folder_rel_path / SKU / manifest id);
//   • a registered external doc keeps its ORDINARY file_path / path_type /
//     root_directory;
//   • recipient = the plan's current responsible supervisor, selected
//     server-side; the renderer cannot inject recipient / file / key;
//   • the send adapter resolves the logical key to the physical path WITHOUT
//     mutating the stored row, and surfaces resolution failure as an explicit
//     orphaned plan-document target.

import assert from 'node:assert/strict';
import path from 'node:path';

import type {
  PlanCommentCreateRequest,
  PlanDocumentRef,
  PlanningReaderListResult,
  SelectionComment,
  Workspace,
} from '../../shared/types';
import type { PlanContext, RegisteredDocumentRow } from './plan-documents';
import type { CreatePlanCommentDeps, ResolvePlanCommentDeps } from './plan-comments';
import {
  canonicalDocRelPath,
  createPlanComment,
  decodePlanDocKey,
  encodePlanDocKey,
  isLogicalPlanDocKey,
  LOGICAL_PLAN_DOC_V1_PREFIX,
  resolvePlanCommentForSend,
} from './plan-comments';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── fixtures ─────────────────────────────────────────────────────────────────

const WS = 'ws-1';
const ARTIFACT = 'plan_abc123';
const FOLDER_REL = '.lares/plans/sku1';

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: WS, title: 'ws', path: 'C:\\ws', pathType: 'windows', description: '',
    defaultCommand: '', createdAt: '', updatedAt: '', lastOpenedAt: null, ...over,
  };
}

function planContext(over: Partial<PlanContext> = {}): PlanContext {
  return { id: 'plan-1', workspaceId: WS, artifactId: ARTIFACT, folderRelPath: FOLDER_REL, ...over };
}

function manifest(): PlanningReaderListResult {
  return {
    warnings: [],
    entries: [
      {
        entryId: 'e1', kind: 'plan-folder', title: 'sku1', mtimeMs: 0,
        planArtifactId: ARTIFACT, planSku: 'sku1',
        documents: [
          { docId: 'd-plan', name: 'plan.md', category: 'plan', sizeBytes: 1, mtimeMs: 0 },
          { docId: 'd-arc', name: 'ARC.md', category: 'arc', sizeBytes: 1, mtimeMs: 0 },
          { docId: 'd-delib', name: '2026-08-01-attr.md', category: 'deliberation', sizeBytes: 1, mtimeMs: 0 },
          { docId: 'd-other', name: 'notes.txt', category: 'other', sizeBytes: 1, mtimeMs: 0 },
        ],
      },
    ],
  };
}

function registeredRow(over: Partial<RegisteredDocumentRow> = {}): RegisteredDocumentRow {
  return {
    id: 'r1', planId: 'plan-1', workspaceId: WS, docKind: 'proposal',
    relPath: '.lares/proposals/x.md', sortOrder: 0, ...over,
  };
}

/** Capturing create deps: records the createComment input + route call. */
function createDeps(over: Partial<CreatePlanCommentDeps> = {}): {
  deps: CreatePlanCommentDeps;
  captured: { input?: any; routed?: { commentId: string; recipientId: string }; created: number };
} {
  const captured: { input?: any; routed?: { commentId: string; recipientId: string }; created: number } =
    { created: 0 };
  const deps: CreatePlanCommentDeps = {
    getPlanContext: () => planContext(),
    getWorkspace: () => workspace(),
    listPlanningEntries: () => manifest(),
    getRegisteredDocument: () => registeredRow(),
    getResponsibleSupervisorId: () => 'sup-1',
    createComment: (input) => {
      captured.input = input;
      captured.created++;
      return {
        id: 'c1', workspaceId: input.workspaceId, targetType: 'file', kind: 'comment',
        anchorType: 'text', pdfAnchor: null, filePath: input.filePath,
        pathType: input.pathType ?? null, rootDirectory: input.rootDirectory ?? null,
        docHash: input.docHash ?? null, anchorStart: null, anchorEnd: null,
        lineStart: null, lineEnd: null, prefix: null, suffix: null,
        quotedText: input.quotedText, body: input.body, status: 'draft',
        sentToAgentId: null, createdAt: '', updatedAt: '', sentAt: null, resolvedAt: null,
      };
    },
    route: async (commentId, recipientId) => {
      captured.routed = { commentId, recipientId };
      return { ok: true, agentId: recipientId, launched: false };
    },
    ...over,
  };
  return { deps, captured };
}

function selComment(over: Partial<SelectionComment> = {}): SelectionComment {
  return {
    id: 'c1', workspaceId: WS, targetType: 'file', kind: 'comment', anchorType: 'text',
    pdfAnchor: null, filePath: 'C:\\ws\\a.md', pathType: 'windows', rootDirectory: 'C:\\ws',
    docHash: null, anchorStart: null, anchorEnd: null, lineStart: null, lineEnd: null,
    prefix: null, suffix: null, quotedText: '', body: 'b', status: 'draft',
    sentToAgentId: null, createdAt: '', updatedAt: '', sentAt: null, resolvedAt: null, ...over,
  };
}

function resolveDeps(over: Partial<ResolvePlanCommentDeps> = {}): ResolvePlanCommentDeps {
  return {
    getFolderRelPathByArtifact: () => FOLDER_REL,
    getWorkspace: () => workspace(),
    fileExists: () => true,
    ...over,
  };
}

const folderRef = (documentId: string): PlanDocumentRef => ({ source: 'folder', documentId });
const registeredRef = (documentId: string): PlanDocumentRef => ({ source: 'registered', documentId });
function createReq(over: Partial<PlanCommentCreateRequest> = {}): PlanCommentCreateRequest {
  return { planId: 'plan-1', ref: folderRef('d-delib'), body: 'please review', ...over };
}

// ── logical-key encode / decode ────────────────────────────────────────────────

test('encode → decode ROUND-TRIPS plan_artifact_id + doc_rel_path; prefix + canonical form', () => {
  const key = encodePlanDocKey(ARTIFACT, 'deliberations/2026-08-01-attr.md');
  assert.ok(key.startsWith(LOGICAL_PLAN_DOC_V1_PREFIX), 'carries the v1 prefix');
  assert.ok(isLogicalPlanDocKey(key));
  // No padding (`=`) in the base64url payload.
  assert.ok(!key.slice(LOGICAL_PLAN_DOC_V1_PREFIX.length).includes('='), 'base64url without padding');
  const decoded = decodePlanDocKey(key);
  assert.deepEqual(decoded, {
    planArtifactId: ARTIFACT,
    docRelPathWithinFolder: 'deliberations/2026-08-01-attr.md',
  });
});

test('canonical JSON is sorted-key, whitespace-free (stable key bytes)', () => {
  const key = encodePlanDocKey('plan_x', 'plan.md');
  const json = Buffer.from(key.slice(LOGICAL_PLAN_DOC_V1_PREFIX.length), 'base64url').toString('utf-8');
  assert.equal(json, '{"doc_rel_path_within_folder":"plan.md","plan_artifact_id":"plan_x"}');
});

test('decode rejects a non-logical path, an unknown version, and a malformed payload', () => {
  assert.equal(decodePlanDocKey('C:\\ws\\a.md'), null);
  assert.equal(decodePlanDocKey('lares-plan-doc:v2:ey000'), null, 'unknown version → undecodable');
  assert.equal(decodePlanDocKey(`${LOGICAL_PLAN_DOC_V1_PREFIX}!!!not-base64!!!`), null);
  assert.equal(decodePlanDocKey(LOGICAL_PLAN_DOC_V1_PREFIX), null, 'empty payload');
});

test('decode rejects a key whose rel path escapes / is non-canonical (containment)', () => {
  const evil = `${LOGICAL_PLAN_DOC_V1_PREFIX}${Buffer.from(
    '{"doc_rel_path_within_folder":"../../secret.md","plan_artifact_id":"plan_x"}',
    'utf-8',
  ).toString('base64url')}`;
  assert.equal(decodePlanDocKey(evil), null, 'a `..` traversal in the key is undecodable');
});

test('canonicalDocRelPath normalizes and rejects unsafe rel paths', () => {
  assert.equal(canonicalDocRelPath('deliberations/./x.md'), 'deliberations/x.md');
  assert.equal(canonicalDocRelPath('a/../b'), null, 'traversal rejected');
  assert.equal(canonicalDocRelPath('/abs/x.md'), null, 'absolute rejected');
  assert.equal(canonicalDocRelPath('C:\\x.md'), null, 'drive-rooted rejected');
  assert.equal(canonicalDocRelPath('a\\b.md'), null, 'mixed/backslash separator rejected');
  assert.equal(canonicalDocRelPath(''), null);
});

// ── create: folder target ──────────────────────────────────────────────────────

test('create on a folder doc persists a v1 logical key with NULL path_type/root_directory', async () => {
  const { deps, captured } = createDeps();
  const res = await createPlanComment(createReq({ ref: folderRef('d-delib') }), deps);
  assert.ok(res.ok, 'create succeeds');
  assert.equal(captured.created, 1);
  const stored = captured.input;
  assert.equal(stored.filePath, encodePlanDocKey(ARTIFACT, 'deliberations/2026-08-01-attr.md'));
  assert.equal(stored.pathType, undefined, 'path_type left NULL for a logical target');
  assert.equal(stored.rootDirectory, undefined, 'root_directory left NULL for a logical target');
  // The identity in the stored key is plan_artifact_id — never SKU / folder_rel_path.
  const decoded = decodePlanDocKey(stored.filePath)!;
  assert.equal(decoded.planArtifactId, ARTIFACT);
  assert.ok(!stored.filePath.includes('sku1'), 'SKU is not the stored identity');
  assert.ok(!stored.filePath.includes('.lares/plans'), 'folder_rel_path is not stored');
});

test('create resolves the canonical top-level rel path for ARC.md / plan.md', async () => {
  for (const [docId, rel] of [['d-arc', 'ARC.md'], ['d-plan', 'plan.md']] as const) {
    const { deps, captured } = createDeps();
    const res = await createPlanComment(createReq({ ref: folderRef(docId) }), deps);
    assert.ok(res.ok);
    assert.equal(decodePlanDocKey(captured.input.filePath)!.docRelPathWithinFolder, rel);
  }
});

test('create rejects a non-commentable folder doc (category "other")', async () => {
  const { deps, captured } = createDeps();
  const res = await createPlanComment(createReq({ ref: folderRef('d-other') }), deps);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'document-not-in-plan');
  assert.equal(captured.created, 0, 'nothing stored');
});

test('create rejects a docId absent from the plan folder manifest', async () => {
  const { deps, captured } = createDeps();
  const res = await createPlanComment(createReq({ ref: folderRef('d-ghost') }), deps);
  assert.equal(res.ok, false);
  assert.equal(captured.created, 0);
});

test('create fails closed when the folder is not resolvable (foreign artifact)', async () => {
  const { deps, captured } = createDeps({ getPlanContext: () => planContext({ artifactId: 'plan_other' }) });
  const res = await createPlanComment(createReq({ ref: folderRef('d-delib') }), deps);
  assert.equal(res.ok, false);
  assert.equal(captured.created, 0);
});

// ── create: registered (external) target ────────────────────────────────────────

test('create on a registered external doc keeps ORDINARY file_path / path_type / root_directory', async () => {
  const { deps, captured } = createDeps();
  const res = await createPlanComment(createReq({ ref: registeredRef('r1') }), deps);
  assert.ok(res.ok);
  const stored = captured.input;
  assert.equal(stored.filePath, path.resolve('C:\\ws', '.lares/proposals/x.md'));
  assert.equal(stored.pathType, 'windows', 'ordinary path_type retained');
  assert.equal(stored.rootDirectory, 'C:\\ws', 'ordinary root_directory retained');
  assert.ok(!isLogicalPlanDocKey(stored.filePath), 'no logical key for an external doc');
});

test('create rejects a registered doc that does not belong to the plan', async () => {
  const { deps, captured } = createDeps({ getRegisteredDocument: () => null });
  const res = await createPlanComment(createReq({ ref: registeredRef('r-nope') }), deps);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'document-not-in-plan');
  assert.equal(captured.created, 0);
});

// ── create: recipient selection + renderer trust boundary ───────────────────────

test('recipient is the plan current responsible supervisor, selected server-side', async () => {
  const { deps, captured } = createDeps();
  const res = await createPlanComment(createReq(), deps);
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.recipientId, 'sup-1');
    assert.deepEqual(captured.routed, { commentId: 'c1', recipientId: 'sup-1' });
    assert.ok(res.send && res.send.ok);
  }
});

test('a plan with no responsible supervisor still persists the row (routed=null)', async () => {
  const { deps, captured } = createDeps({ getResponsibleSupervisorId: () => null });
  const res = await createPlanComment(createReq(), deps);
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.recipientId, null);
    assert.equal(res.send, null);
  }
  assert.equal(captured.created, 1, 'the durable row is still created');
  assert.equal(captured.routed, undefined, 'no route attempted without a recipient');
});

test('renderer-supplied recipient / file / key are IGNORED (server derives them)', async () => {
  const { deps, captured } = createDeps();
  // Smuggle extra fields; the request type does not carry them and the server
  // never reads them.
  const raw = {
    ...createReq({ ref: folderRef('d-delib') }),
    sentToAgentId: 'attacker',
    filePath: 'C:\\etc\\passwd',
    pathType: 'windows',
    recipientId: 'attacker',
  };
  const res = await createPlanComment(raw, deps);
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.recipientId, 'sup-1', 'recipient is server-selected');
  assert.equal(captured.input.filePath, encodePlanDocKey(ARTIFACT, 'deliberations/2026-08-01-attr.md'));
  assert.equal(captured.input.pathType, undefined, 'smuggled path_type ignored');
});

test('create rejects a malformed request (missing planId / body / ref)', async () => {
  const { deps } = createDeps();
  for (const raw of [
    {},
    { planId: '', ref: folderRef('d-delib'), body: 'b' },
    { planId: 'plan-1', ref: folderRef('d-delib'), body: '' },
    { planId: 'plan-1', body: 'b' },
    { planId: 'plan-1', ref: { source: 'folder', documentId: '', }, body: 'b' },
    { planId: 'plan-1', ref: { source: 'folder', documentId: 'd', path: 'x' }, body: 'b' },
  ]) {
    const res = await createPlanComment(raw, deps);
    assert.equal(res.ok, false, `expected rejection for ${JSON.stringify(raw)}`);
    if (!res.ok) assert.equal(res.code, 'plan-comment-bad-request');
  }
});

test('create rejects an unknown plan / missing workspace', async () => {
  const r1 = await createPlanComment(createReq(), createDeps({ getPlanContext: () => null }).deps);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.code, 'plan-not-found');
  const r2 = await createPlanComment(createReq(), createDeps({ getWorkspace: () => null }).deps);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.code, 'workspace-not-found');
});

// ── send adapter: resolve-without-mutation + orphaned-on-failure ─────────────────

test('send adapter passes an ORDINARY comment through unchanged', () => {
  const ordinary = selComment({ filePath: 'C:\\ws\\a.md' });
  const out = resolvePlanCommentForSend(ordinary, resolveDeps());
  assert.equal(out, ordinary, 'same object — no clone for a non-logical path');
});

test('send adapter resolves a logical key to the physical path WITHOUT mutating the row', () => {
  const key = encodePlanDocKey(ARTIFACT, 'deliberations/2026-08-01-attr.md');
  const stored = selComment({ filePath: key, pathType: null, rootDirectory: null });
  const out = resolvePlanCommentForSend(stored, resolveDeps())!;
  const expectedFolder = path.resolve('C:\\ws', '.lares/plans/sku1');
  assert.equal(out.filePath, path.resolve(expectedFolder, 'deliberations/2026-08-01-attr.md'));
  assert.equal(out.pathType, 'windows');
  assert.equal(out.rootDirectory, 'C:\\ws');
  // The STORED row is untouched — it still carries the logical key.
  assert.equal(stored.filePath, key, 'stored row keeps the logical key');
  assert.equal(stored.pathType, null);
  assert.notEqual(out, stored, 'a clone, not the same object');
});

test('folder RENAME keeps the comment attached (resolves via current folder_rel_path)', () => {
  const key = encodePlanDocKey(ARTIFACT, 'deliberations/2026-08-01-attr.md');
  const stored = selComment({ filePath: key, pathType: null, rootDirectory: null });
  // The plan folder was renamed sku1 → sku2; artifact id is unchanged.
  const out = resolvePlanCommentForSend(stored, resolveDeps({
    getFolderRelPathByArtifact: () => '.lares/plans/sku2',
  }))!;
  assert.equal(out.filePath, path.resolve('C:\\ws', '.lares/plans/sku2', 'deliberations/2026-08-01-attr.md'));
});

test('send adapter orphans a logical target that no longer resolves (unknown plan)', () => {
  const key = encodePlanDocKey(ARTIFACT, 'deliberations/2026-08-01-attr.md');
  const stored = selComment({ filePath: key, pathType: null, rootDirectory: null });
  const out = resolvePlanCommentForSend(stored, resolveDeps({ getFolderRelPathByArtifact: () => null }))!;
  assert.equal(out.filePath, '[orphaned plan document: deliberations/2026-08-01-attr.md]');
  assert.equal(out.pathType, null);
  assert.equal(out.rootDirectory, null);
  assert.equal(stored.filePath, key, 'stored row unchanged');
});

test('send adapter orphans when the document no longer exists on disk', () => {
  const key = encodePlanDocKey(ARTIFACT, 'deliberations/gone.md');
  const stored = selComment({ filePath: key, pathType: null, rootDirectory: null });
  const out = resolvePlanCommentForSend(stored, resolveDeps({ fileExists: () => false }))!;
  assert.equal(out.filePath, '[orphaned plan document: deliberations/gone.md]');
});

test('send adapter orphans a malformed / unknown-version key (never a filesystem path)', () => {
  const stored = selComment({ filePath: 'lares-plan-doc:v2:whatever', pathType: null, rootDirectory: null });
  const out = resolvePlanCommentForSend(stored, resolveDeps())!;
  assert.equal(out.filePath, '[orphaned plan document]');
  assert.equal(out.pathType, null);
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
