// WP-P4D-reply-service acceptance — companion reply (answer) service.
//
//   npm run build:main
//   node dist/main/main/plans/plan-comment-reply.test.js
//
// Pure-handler tests with injected deps (no electron, no DB, no fs). Proves the
// WP Accept list:
//   • a reply persists in the COMPANION table with author + a companion row is the
//     ONLY mutation — the question comment's body / status machine is untouched;
//   • the caller must BE the plan's current responsible supervisor — a
//     non-responsible caller (wrong id, no responsible, non-privileged agent,
//     wrong workspace) is rejected and NO row is written;
//   • bad requests / unknown comment / unresolvable plan are rejected cleanly;
//   • comment → plan resolution: a folder-doc comment resolves DURABLY from the
//     `lares-plan-doc:v1:` key (folder rename keeps it attached; malformed /
//     unknown-version key → unresolvable); a registered-doc comment reverse-matches
//     its stored physical path to exactly one owning plan (ambiguous → fail closed).

import assert from 'node:assert/strict';
import path from 'node:path';

import type {
  Agent,
  SelectionComment,
  SelectionCommentReply,
  Workspace,
} from '../../shared/types';
import type { PlanContext } from './plan-documents';
import type {
  AnswerPlanCommentDeps,
  ResolveCommentPlanDeps,
  ResolvedCommentPlan,
  ResolverPlanRow,
} from './plan-comments';
import {
  answerPlanComment,
  encodePlanDocKey,
  resolvePlanForComment,
} from './plan-comments';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── fixtures ─────────────────────────────────────────────────────────────────

const WS = 'ws-1';
const ARTIFACT = 'plan_abc123';
const PLAN_ID = 'plan-1';
const SUP = 'sup-1';

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: WS, title: 'ws', path: 'C:\\ws', pathType: 'windows', description: '',
    defaultCommand: '', createdAt: '', updatedAt: '', lastOpenedAt: null, ...over,
  };
}

function agent(over: Partial<Agent> = {}): Agent {
  // Only the fields the responsible-supervisor gate reads matter here.
  return {
    id: SUP, workspaceId: WS, isSupervisor: true, privilegeLane: 'supervisor',
    ...over,
  } as Agent;
}

function selComment(over: Partial<SelectionComment> = {}): SelectionComment {
  return {
    id: 'c1', workspaceId: WS, targetType: 'file', kind: 'comment', anchorType: 'text',
    pdfAnchor: null, filePath: 'C:\\ws\\a.md', pathType: 'windows', rootDirectory: 'C:\\ws',
    docHash: null, anchorStart: null, anchorEnd: null, lineStart: null, lineEnd: null,
    prefix: null, suffix: null, quotedText: 'q', body: 'question body', status: 'sent',
    sentToAgentId: SUP, createdAt: 'ts', updatedAt: 'ts', sentAt: 'ts', resolvedAt: null, ...over,
  };
}

const resolved = (over: Partial<ResolvedCommentPlan> = {}): ResolvedCommentPlan => ({
  planId: PLAN_ID, workspaceId: WS, responsibleSupervisorId: SUP, ...over,
});

/** Capturing answer deps: records the createReply input + how many rows written. */
function answerDeps(over: Partial<AnswerPlanCommentDeps> = {}): {
  deps: AnswerPlanCommentDeps;
  captured: { input?: any; created: number };
} {
  const captured: { input?: any; created: number } = { created: 0 };
  const deps: AnswerPlanCommentDeps = {
    getComment: () => selComment(),
    resolvePlanForComment: () => resolved(),
    getAgent: () => agent(),
    createReply: (input): SelectionCommentReply => {
      captured.input = input;
      captured.created++;
      return {
        id: 'r1', commentId: input.commentId, body: input.body,
        authorAgentId: input.authorAgentId ?? null, createdAt: input.createdAt ?? 123,
      };
    },
    ...over,
  };
  return { deps, captured };
}

const req = (over: Record<string, unknown> = {}) =>
  ({ commentId: 'c1', body: 'the answer', callerAgentId: SUP, ...over });

// ── success + companion-row-only ─────────────────────────────────────────────

test('a valid answer persists a companion reply with author + commentId', async () => {
  const { deps, captured } = answerDeps();
  const res = await answerPlanComment(req(), deps);
  assert.ok(res.ok, 'answer succeeds');
  assert.equal(captured.created, 1);
  assert.equal(captured.input.commentId, 'c1');
  assert.equal(captured.input.body, 'the answer');
  assert.equal(captured.input.authorAgentId, SUP, 'author = the responsible supervisor');
  if (res.ok) {
    assert.equal(res.reply.commentId, 'c1');
    assert.equal(res.reply.authorAgentId, SUP);
  }
});

test('the answer NEVER mutates the question comment (companion row is the only write)', async () => {
  // The deps expose no comment-update seam at all; the service can only append a
  // reply. Prove the question comment object is returned untouched and only
  // createReply was invoked.
  const question = selComment({ body: 'ORIGINAL question', status: 'sent' });
  let updates = 0;
  const { deps, captured } = answerDeps({
    getComment: () => question,
    // Any hypothetical mutation would have to go through a dep — none is offered.
    createReply: (input) => {
      updates++;
      captured.created++;
      captured.input = input;
      return { id: 'r1', commentId: input.commentId, body: input.body, authorAgentId: input.authorAgentId ?? null, createdAt: 1 };
    },
  });
  const res = await answerPlanComment(req(), deps);
  assert.ok(res.ok);
  assert.equal(updates, 1, 'exactly one companion write');
  assert.equal(question.body, 'ORIGINAL question', 'question body untouched');
  assert.equal(question.status, 'sent', 'question delivery-status machine untouched');
});

// ── responsible-supervisor gate ──────────────────────────────────────────────

test('rejects a caller who is not the plan responsible supervisor (wrong id)', async () => {
  const { deps, captured } = answerDeps();
  const res = await answerPlanComment(req({ callerAgentId: 'other-agent' }), deps);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-responsible-supervisor');
  assert.equal(captured.created, 0, 'no row written for a non-responsible caller');
});

test('rejects when the plan has no current responsible supervisor', async () => {
  const { deps, captured } = answerDeps({ resolvePlanForComment: () => resolved({ responsibleSupervisorId: null }) });
  const res = await answerPlanComment(req(), deps);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'not-responsible-supervisor');
  assert.equal(captured.created, 0);
});

test('rejects the responsible id when the agent record is missing / demoted / foreign', async () => {
  // id matches responsible, but defense-in-depth agent checks still gate it.
  for (const badAgent of [
    null,
    agent({ isSupervisor: false, privilegeLane: undefined }),
    agent({ workspaceId: 'ws-other' }),
  ]) {
    const { deps, captured } = answerDeps({ getAgent: () => badAgent });
    const res = await answerPlanComment(req(), deps);
    assert.equal(res.ok, false, `expected rejection for agent=${JSON.stringify(badAgent)}`);
    if (!res.ok) assert.equal(res.code, 'not-responsible-supervisor');
    assert.equal(captured.created, 0);
  }
});

// ── request / lookup validation ──────────────────────────────────────────────

test('rejects a malformed request (missing commentId / body / callerAgentId)', async () => {
  const { deps } = answerDeps();
  for (const raw of [
    {},
    { commentId: '', body: 'b', callerAgentId: SUP },
    { commentId: 'c1', body: '', callerAgentId: SUP },
    { commentId: 'c1', body: 'b', callerAgentId: '' },
    { commentId: 'c1', body: 'b' },
    null,
  ]) {
    const res = await answerPlanComment(raw, deps);
    assert.equal(res.ok, false, `expected rejection for ${JSON.stringify(raw)}`);
    if (!res.ok) assert.equal(res.code, 'reply-bad-request');
  }
});

test('rejects an unknown comment', async () => {
  const { deps, captured } = answerDeps({ getComment: () => null });
  const res = await answerPlanComment(req(), deps);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'comment-not-found');
  assert.equal(captured.created, 0);
});

test('rejects a comment that does not resolve to a live plan', async () => {
  const { deps, captured } = answerDeps({ resolvePlanForComment: () => null });
  const res = await answerPlanComment(req(), deps);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, 'plan-not-found');
  assert.equal(captured.created, 0);
});

// ── resolvePlanForComment: durable logical key ────────────────────────────────

function resolveDeps(over: Partial<ResolveCommentPlanDeps> = {}): ResolveCommentPlanDeps {
  return {
    getWorkspace: () => workspace(),
    getPlanByArtifact: (_ws, artifactId): ResolverPlanRow | null =>
      artifactId === ARTIFACT ? { id: PLAN_ID, workspaceId: WS, deletedAt: null } : null,
    listRegisteredDocuments: () => [{ planId: PLAN_ID, relPath: '.lares/proposals/x.md' }],
    getPlanContext: (planId): PlanContext | null =>
      planId === PLAN_ID ? { id: PLAN_ID, workspaceId: WS, artifactId: ARTIFACT, folderRelPath: '.lares/plans/sku1' } : null,
    getResponsibleSupervisorId: () => SUP,
    ...over,
  };
}

test('resolves a folder-doc comment DURABLY from its logical key', () => {
  const key = encodePlanDocKey(ARTIFACT, 'deliberations/2026-08-01-attr.md');
  const out = resolvePlanForComment(selComment({ filePath: key, pathType: null, rootDirectory: null }), resolveDeps());
  assert.deepEqual(out, { planId: PLAN_ID, workspaceId: WS, responsibleSupervisorId: SUP });
});

test('a folder RENAME keeps the comment attached (artifact id, not folder path)', () => {
  const key = encodePlanDocKey(ARTIFACT, 'deliberations/2026-08-01-attr.md');
  // The plan folder moved sku1 → sku2; getPlanByArtifact still finds it by artifact.
  const out = resolvePlanForComment(
    selComment({ filePath: key, pathType: null, rootDirectory: null }),
    resolveDeps({
      getPlanContext: () => ({ id: PLAN_ID, workspaceId: WS, artifactId: ARTIFACT, folderRelPath: '.lares/plans/sku2' }),
    }),
  );
  assert.ok(out);
  assert.equal(out!.planId, PLAN_ID);
});

test('a malformed / unknown-version logical key resolves to null (orphaned, never a path)', () => {
  for (const bad of ['lares-plan-doc:v2:whatever', 'lares-plan-doc:v1:!!!not-b64!!!']) {
    assert.equal(resolvePlanForComment(selComment({ filePath: bad, pathType: null, rootDirectory: null }), resolveDeps()), null);
  }
});

test('a logical key for a deleted / unknown plan resolves to null', () => {
  const key = encodePlanDocKey('plan_missing', 'plan.md');
  assert.equal(resolvePlanForComment(selComment({ filePath: key, pathType: null, rootDirectory: null }), resolveDeps()), null);
  // present but soft-deleted → also null
  const key2 = encodePlanDocKey(ARTIFACT, 'plan.md');
  const out = resolvePlanForComment(
    selComment({ filePath: key2, pathType: null, rootDirectory: null }),
    resolveDeps({ getPlanByArtifact: () => ({ id: PLAN_ID, workspaceId: WS, deletedAt: 'ts' }) }),
  );
  assert.equal(out, null);
});

// ── resolvePlanForComment: registered-doc reverse-match ───────────────────────

test('resolves a registered-doc comment by reverse-matching its stored physical path', () => {
  const abs = path.resolve('C:\\ws', '.lares/proposals/x.md');
  const out = resolvePlanForComment(selComment({ filePath: abs, pathType: 'windows', rootDirectory: 'C:\\ws' }), resolveDeps());
  assert.deepEqual(out, { planId: PLAN_ID, workspaceId: WS, responsibleSupervisorId: SUP });
});

test('a registered path owned by NO plan resolves to null', () => {
  const abs = path.resolve('C:\\ws', '.lares/proposals/not-linked.md');
  assert.equal(resolvePlanForComment(selComment({ filePath: abs, pathType: 'windows', rootDirectory: 'C:\\ws' }), resolveDeps()), null);
});

test('an AMBIGUOUS registered path (two plans) fails closed → null', () => {
  const abs = path.resolve('C:\\ws', '.lares/proposals/x.md');
  const out = resolvePlanForComment(
    selComment({ filePath: abs, pathType: 'windows', rootDirectory: 'C:\\ws' }),
    resolveDeps({
      listRegisteredDocuments: () => [
        { planId: 'plan-1', relPath: '.lares/proposals/x.md' },
        { planId: 'plan-2', relPath: '.lares/proposals/x.md' },
      ],
    }),
  );
  assert.equal(out, null);
});

test('end-to-end: a folder-doc answer routes the durable-key comment to a companion reply', async () => {
  // Wire the real resolver into the answer service (default getAgent/createReply stubbed).
  const key = encodePlanDocKey(ARTIFACT, 'plan.md');
  const { deps, captured } = answerDeps({
    getComment: () => selComment({ filePath: key, pathType: null, rootDirectory: null }),
    resolvePlanForComment: (c) => resolvePlanForComment(c, resolveDeps()),
  });
  const res = await answerPlanComment(req(), deps);
  assert.ok(res.ok, 'answer succeeds through the real resolver');
  assert.equal(captured.created, 1);
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
