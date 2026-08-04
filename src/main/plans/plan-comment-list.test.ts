// WP-P4D-proj acceptance — plan-comment projection (dual-source; logical-key res).
//
//   npm run build:main
//   node dist/main/main/plans/plan-comment-list.test.js
//
// Pure-service tests with injected deps (no electron, no DB, no fs). Proves the
// WP Accept list:
//   • comments on BOTH `plan_documents` (ordinary physical file_path) and
//     folder-doc logical targets are listed with threaded replies;
//   • logical keys are parsed ONLY in the exact `v1:` form and resolved through
//     the plan's CURRENT folder manifest;
//   • a FOLDER rename keeps folder-doc comments attached (durable
//     `plan_artifact_id`, folder-path-free key);
//   • an individual document rename / removal → an ORPHANED thread (never dropped);
//   • a malformed / bad-rel-path `v1:` key → an orphaned thread; an
//     unknown-version / unparseable key is a member of no plan and is NEVER fed to
//     the path-keyed comment query (the generic-fs-lookup guard);
//   • the compatibility path: ordinary file comments list unchanged.

import assert from 'node:assert/strict';
import path from 'node:path';

import type {
  PlanningReaderListResult,
  SelectionComment,
  SelectionCommentReply,
  Workspace,
} from '../../shared/types';
import type { PlanContext, RegisteredDocumentRow } from './plan-documents';
import type { ListPlanCommentsDeps } from './plan-comments';
import { encodePlanDocKey, listPlanComments, LOGICAL_PLAN_DOC_V1_PREFIX } from './plan-comments';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── fixtures ─────────────────────────────────────────────────────────────────

const WS = 'ws-1';
const ARTIFACT = 'plan_abc123';
const FOLDER_REL = '.lares/plans/sku1';
const DELIB_REL = 'deliberations/2026-08-01-attr.md';

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: WS, title: 'ws', path: 'C:\\ws', pathType: 'windows', description: '',
    defaultCommand: '', createdAt: '', updatedAt: '', lastOpenedAt: null, ...over,
  };
}

function planContext(over: Partial<PlanContext> = {}): PlanContext {
  return { id: 'plan-1', workspaceId: WS, artifactId: ARTIFACT, folderRelPath: FOLDER_REL, ...over };
}

/** A manifest whose plan folder is `sku` (default sku1), carrying the standard
 *  folder docs. Used to prove folder-rename resolution against the current sku. */
function manifest(sku = 'sku1'): PlanningReaderListResult {
  return {
    warnings: [],
    entries: [
      {
        entryId: 'e1', kind: 'plan-folder', title: sku, mtimeMs: 0,
        planArtifactId: ARTIFACT, planSku: sku,
        documents: [
          { docId: 'd-plan', name: 'plan.md', category: 'plan', sizeBytes: 1, mtimeMs: 0 },
          { docId: 'd-arc', name: 'ARC.md', category: 'arc', sizeBytes: 1, mtimeMs: 0 },
          { docId: 'd-delib', name: '2026-08-01-attr.md', category: 'deliberation', sizeBytes: 1, mtimeMs: 0 },
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

function selComment(over: Partial<SelectionComment> = {}): SelectionComment {
  return {
    id: 'c1', workspaceId: WS, targetType: 'file', kind: 'comment', anchorType: 'text',
    pdfAnchor: null, filePath: 'C:\\ws\\a.md', pathType: 'windows', rootDirectory: 'C:\\ws',
    docHash: null, anchorStart: null, anchorEnd: null, lineStart: null, lineEnd: null,
    prefix: null, suffix: null, quotedText: '', body: 'b', status: 'draft',
    sentToAgentId: null, createdAt: '2026-08-01T00:00:00Z', updatedAt: '', sentAt: null, resolvedAt: null, ...over,
  };
}

function reply(over: Partial<SelectionCommentReply> = {}): SelectionCommentReply {
  return { id: 'rep1', commentId: 'c1', body: 'ack', authorAgentId: 'sup-1', createdAt: 1, ...over };
}

/** The physical path the create path stores for the default registered doc — the
 *  projection recomputes it identically to key `listCommentsByPath`. */
const REGISTERED_ABS = path.resolve('C:\\ws', '.lares/proposals/x.md');

/** Records which paths were queried through `listCommentsByPath` so tests can
 *  assert a logical key is NEVER used as an OS-path lookup. */
interface Harness {
  deps: ListPlanCommentsDeps;
  pathQueries: string[];
}

function harness(over: Partial<ListPlanCommentsDeps> = {}, opts: {
  registered?: RegisteredDocumentRow[];
  byPath?: Record<string, SelectionComment[]>;
  logical?: SelectionComment[];
  repliesByComment?: Record<string, SelectionCommentReply[]>;
  manifest?: PlanningReaderListResult;
} = {}): Harness {
  const pathQueries: string[] = [];
  const deps: ListPlanCommentsDeps = {
    getPlanContext: () => planContext(),
    getWorkspace: () => workspace(),
    listPlanningEntries: () => opts.manifest ?? manifest(),
    listRegisteredDocuments: () => opts.registered ?? [],
    listCommentsByPath: (_ws, filePath) => {
      pathQueries.push(filePath);
      return opts.byPath?.[filePath] ?? [];
    },
    listLogicalComments: () => opts.logical ?? [],
    listReplies: (commentId) => opts.repliesByComment?.[commentId] ?? [],
    ...over,
  };
  return { deps, pathQueries };
}

// ── dual-source listing ────────────────────────────────────────────────────────

test('lists comments on BOTH a registered doc and a folder-doc, with reply threads', () => {
  const folderKey = encodePlanDocKey(ARTIFACT, DELIB_REL);
  const regComment = selComment({ id: 'c-reg', filePath: REGISTERED_ABS, createdAt: '2026-08-01T00:00:01Z' });
  const folderComment = selComment({
    id: 'c-fold', filePath: folderKey, pathType: null, rootDirectory: null,
    createdAt: '2026-08-01T00:00:02Z',
  });
  const { deps } = harness({}, {
    registered: [registeredRow()],
    byPath: { [REGISTERED_ABS]: [regComment] },
    logical: [folderComment],
    repliesByComment: { 'c-reg': [reply({ id: 'r-a', commentId: 'c-reg' })], 'c-fold': [reply({ id: 'r-b', commentId: 'c-fold' })] },
  });

  const proj = listPlanComments('plan-1', deps)!;
  assert.equal(proj.planId, 'plan-1');
  assert.equal(proj.threads.length, 2);

  const reg = proj.threads.find((t) => t.comment.id === 'c-reg')!;
  assert.equal(reg.target.kind, 'registered');
  if (reg.target.kind === 'registered') {
    assert.equal(reg.target.documentId, 'r1');
    assert.equal(reg.target.tab, 'proposal');
    assert.equal(reg.target.name, 'x.md');
  }
  assert.equal(reg.replies.length, 1);
  assert.equal(reg.replies[0].id, 'r-a');

  const fold = proj.threads.find((t) => t.comment.id === 'c-fold')!;
  assert.equal(fold.target.kind, 'folder-doc');
  if (fold.target.kind === 'folder-doc') {
    assert.equal(fold.target.documentId, 'd-delib');
    assert.equal(fold.target.tab, 'deliberations');
    assert.equal(fold.target.docRelPath, DELIB_REL);
    assert.equal(fold.target.name, '2026-08-01-attr.md');
  }
  assert.equal(fold.replies[0].id, 'r-b');
});

test('folder-doc comments on plan.md / ARC.md resolve to the plan / overview tabs', () => {
  const cases = [
    { rel: 'plan.md', docId: 'd-plan', tab: 'plan' },
    { rel: 'ARC.md', docId: 'd-arc', tab: 'overview' },
  ] as const;
  for (const { rel, docId, tab } of cases) {
    const key = encodePlanDocKey(ARTIFACT, rel);
    const { deps } = harness({}, { logical: [selComment({ id: `c-${docId}`, filePath: key })] });
    const proj = listPlanComments('plan-1', deps)!;
    assert.equal(proj.threads.length, 1);
    const target = proj.threads[0].target;
    assert.equal(target.kind, 'folder-doc');
    if (target.kind === 'folder-doc') {
      assert.equal(target.documentId, docId);
      assert.equal(target.tab, tab);
    }
  }
});

// ── folder rename survives ───────────────────────────────────────────────────────

test('folder RENAME keeps folder-doc comments ATTACHED (durable plan_artifact_id)', () => {
  const key = encodePlanDocKey(ARTIFACT, DELIB_REL);
  // The plan folder was renamed sku1 → sku2: the plan context + manifest now say
  // sku2, but the stored key (folder-path-free) is unchanged.
  const { deps } = harness(
    { getPlanContext: () => planContext({ folderRelPath: '.lares/plans/sku2' }) },
    { logical: [selComment({ id: 'c-fold', filePath: key })], manifest: manifest('sku2') },
  );
  const proj = listPlanComments('plan-1', deps)!;
  assert.equal(proj.threads.length, 1);
  assert.equal(proj.threads[0].target.kind, 'folder-doc', 'still attached after rename');
});

// ── individual document rename / removal → orphaned ─────────────────────────────

test('an individual doc removal (rel path no longer in manifest) → an ORPHANED thread', () => {
  const key = encodePlanDocKey(ARTIFACT, 'deliberations/deleted.md');
  const { deps } = harness({}, { logical: [selComment({ id: 'c-gone', filePath: key })] });
  const proj = listPlanComments('plan-1', deps)!;
  assert.equal(proj.threads.length, 1, 'never silently dropped');
  const target = proj.threads[0].target;
  assert.equal(target.kind, 'orphaned');
  if (target.kind === 'orphaned') assert.equal(target.docRelPath, 'deliberations/deleted.md');
});

test('an empty / unresolvable folder manifest orphans every folder-doc comment', () => {
  const key = encodePlanDocKey(ARTIFACT, DELIB_REL);
  const { deps } = harness({}, {
    logical: [selComment({ id: 'c-fold', filePath: key })],
    manifest: { entries: [], warnings: [] },
  });
  const proj = listPlanComments('plan-1', deps)!;
  assert.equal(proj.threads.length, 1);
  assert.equal(proj.threads[0].target.kind, 'orphaned');
});

// ── malformed / unknown-version keys ────────────────────────────────────────────

test('a bad-rel-path v1 key (matching artifact) → an ORPHANED thread (docRelPath null)', () => {
  // A `..` rel path is undecodable by the strict decoder but still attributable
  // via the artifact id → it renders as an orphaned target, never a filesystem path.
  const evil = `${LOGICAL_PLAN_DOC_V1_PREFIX}${Buffer.from(
    `{"doc_rel_path_within_folder":"../../secret.md","plan_artifact_id":"${ARTIFACT}"}`,
    'utf-8',
  ).toString('base64url')}`;
  const { deps, pathQueries } = harness({}, { logical: [selComment({ id: 'c-evil', filePath: evil })] });
  const proj = listPlanComments('plan-1', deps)!;
  assert.equal(proj.threads.length, 1);
  const target = proj.threads[0].target;
  assert.equal(target.kind, 'orphaned');
  if (target.kind === 'orphaned') assert.equal(target.docRelPath, null);
  // The `..` key was NEVER used as an OS-path lookup.
  assert.ok(!pathQueries.some((p) => p.includes('secret')), 'bad rel path never path-queried');
});

test('an unknown-version / unparseable key is a member of no plan and never path-queried', () => {
  const rows = [
    selComment({ id: 'c-v2', filePath: 'lares-plan-doc:v2:whatever' }),
    selComment({ id: 'c-garbage', filePath: `${LOGICAL_PLAN_DOC_V1_PREFIX}!!!not-base64!!!` }),
    selComment({ id: 'c-empty', filePath: LOGICAL_PLAN_DOC_V1_PREFIX }),
    // A valid v1 key for a DIFFERENT plan's artifact — excluded from this plan.
    selComment({ id: 'c-other', filePath: encodePlanDocKey('plan_other', DELIB_REL) }),
  ];
  const { deps, pathQueries } = harness({}, { logical: rows });
  const proj = listPlanComments('plan-1', deps)!;
  assert.equal(proj.threads.length, 0, 'none attributed to this plan');
  // No logical key of any kind ever reached the path-keyed comment query.
  assert.ok(!pathQueries.some((p) => p.startsWith('lares-plan-doc:')), 'no logical key path-queried');
});

// ── compatibility: ordinary file comments unchanged ─────────────────────────────

test('ordinary file comments (plain file_path) list unchanged with a registered target', () => {
  const regComment = selComment({ id: 'c-reg', filePath: REGISTERED_ABS });
  const { deps, pathQueries } = harness({}, {
    registered: [registeredRow({ docKind: 'legacy-html', relPath: '.lares/plans/legacy/old.html' })],
    byPath: { [path.resolve('C:\\ws', '.lares/plans/legacy/old.html')]: [regComment] },
  });
  const proj = listPlanComments('plan-1', deps)!;
  assert.equal(proj.threads.length, 1);
  assert.equal(proj.threads[0].comment, regComment, 'comment object passed through unchanged');
  const target = proj.threads[0].target;
  assert.equal(target.kind, 'registered');
  if (target.kind === 'registered') assert.equal(target.tab, 'legacy-html');
  // Only physical paths were queried.
  assert.ok(pathQueries.every((p) => !p.startsWith('lares-plan-doc:')));
});

test('a registered row not belonging to the plan/workspace surfaces no comments', () => {
  const { deps } = harness({}, {
    registered: [registeredRow({ planId: 'other-plan' }), registeredRow({ id: 'r2', workspaceId: 'other-ws' })],
    byPath: { [REGISTERED_ABS]: [selComment({ id: 'c-x', filePath: REGISTERED_ABS })] },
  });
  const proj = listPlanComments('plan-1', deps)!;
  assert.equal(proj.threads.length, 0);
});

// ── degradation / bad input ─────────────────────────────────────────────────────

test('an unknown plan id returns null; an empty id returns null', () => {
  const { deps } = harness({ getPlanContext: () => null });
  assert.equal(listPlanComments('nope', deps), null);
  assert.equal(listPlanComments('', deps), null);
});

test('a missing workspace degrades to an empty projection with a warning', () => {
  const { deps } = harness({ getWorkspace: () => null });
  const proj = listPlanComments('plan-1', deps)!;
  assert.deepEqual(proj.threads, []);
  assert.deepEqual(proj.warnings, ['workspace unavailable']);
});

test('a throwing folder manifest degrades to a warning, keeping registered comments', () => {
  const regComment = selComment({ id: 'c-reg', filePath: REGISTERED_ABS });
  const { deps } = harness(
    { listPlanningEntries: () => { throw new Error('fs down'); } },
    { registered: [registeredRow()], byPath: { [REGISTERED_ABS]: [regComment] } },
  );
  const proj = listPlanComments('plan-1', deps)!;
  assert.equal(proj.threads.length, 1, 'registered comments still listed');
  assert.ok(proj.warnings.some((w) => w.includes('folder manifest unavailable')));
});

test('threads are ordered by comment createdAt then id (stable rail order)', () => {
  const kA = encodePlanDocKey(ARTIFACT, 'plan.md');
  const kB = encodePlanDocKey(ARTIFACT, DELIB_REL);
  const { deps } = harness({}, {
    logical: [
      selComment({ id: 'c-late', filePath: kA, createdAt: '2026-08-02T00:00:00Z' }),
      selComment({ id: 'c-early', filePath: kB, createdAt: '2026-08-01T00:00:00Z' }),
    ],
  });
  const proj = listPlanComments('plan-1', deps)!;
  assert.deepEqual(proj.threads.map((t) => t.comment.id), ['c-early', 'c-late']);
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
