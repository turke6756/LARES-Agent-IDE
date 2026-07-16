// WP-P5-A — `comments:send` status machine + prompt format
// (plans/selection-to-agent-primitive-plan.md §1.8, §4, §7 WP-P5-A).
//
// Covers:
//   - sync gate rejections (invalid request, missing comment, mixed files,
//     missing agent, busy agent, input-in-flight) leave rows untouched and
//     return distinct error codes; 'agent-busy' carries the built prompt for
//     the renderer's prompt-staging fallback;
//   - the accepting set mirrors slice-1 selection-dispatch.ts
//     (idle|waiting|done|crashed);
//   - existing-agent happy path: queued → sendInput → sent; rejection and a
//     `false` (nothing typed) resolve both land send_failed + the
//     'agent:send-input-error' surface;
//   - new-agent path: launch carries initialUserPrompt (WP-P2 pending-map
//     seam) with the slice-1 launch shape; queued → sent on launch resolve,
//     send_failed + 'launch-failed' on launch reject;
//   - prompt format: single item collapse, single item + comment numbering,
//     multi-item numbering, empty body → "(no comment …)", Lines: header on
//     single-comment sends only.
//
// Pure dependency fakes — no electron, no SQLite.
//
//   npm run build:main
//   node dist/main/main/selection-comments-send.test.js

import assert from 'node:assert/strict';
import { sendSelectionComments, COMMENT_SEND_ACCEPTING, type SendSelectionCommentsDeps } from './selection-comments-send';
import type { Agent, AgentStatus, LaunchAgentInput, SelectionComment } from '../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function makeComment(over: Partial<SelectionComment> = {}): SelectionComment {
  return {
    id: 'c-1',
    workspaceId: 'ws-1',
    targetType: 'file',
    kind: 'comment',
    filePath: 'C:\\repo\\doc.md',
    pathType: 'windows',
    rootDirectory: 'C:\\repo',
    docHash: 'hash-1',
    anchorStart: 10,
    anchorEnd: 30,
    lineStart: null,
    lineEnd: null,
    prefix: 'pre',
    suffix: 'suf',
    quotedText: 'quoted text',
    body: 'fact check this',
    status: 'draft',
    sentToAgentId: null,
    anchorType: 'text',
    pdfAnchor: null,
    createdAt: '2026-06-12 00:00:00',
    updatedAt: '2026-06-12 00:00:00',
    sentAt: null,
    resolvedAt: null,
    ...over,
  };
}

// A PDF comment fixture: physical page + one paint rect.
function pdfAnchor(pageIndex: number, pageLabel?: string, coordinateOnly = false): SelectionComment['pdfAnchor'] {
  const start = { itemIndex: 0, charOffset: 0 };
  const end = coordinateOnly ? { itemIndex: 0, charOffset: 0 } : { itemIndex: 1, charOffset: 4 };
  return {
    version: 1,
    fingerprint: 'fp-1',
    prefix: 'pre',
    suffix: 'suf',
    pages: [{ pageIndex, pageLabel, start, end, rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }] }],
  };
}

function makeAgent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    workspaceId: 'ws-1',
    title: 'Builder',
    slug: 'builder',
    roleDescription: '',
    workingDirectory: 'C:\\repo',
    command: 'claude',
    provider: 'claude',
    isSupervisor: false,
    isSupervised: false,
    isWorker: true,
    isResearcher: false,
    tmuxSessionName: null,
    autoRestartEnabled: false,
    resumeSessionId: null,
    status: 'idle',
    isAttached: false,
    restartCount: 0,
    lastExitCode: null,
    pid: null,
    logPath: null,
    templateId: null,
    systemPrompt: null,
    createdAt: '2026-06-12 00:00:00',
    updatedAt: '2026-06-12 00:00:00',
    lastOutputAt: null,
    lastAttachedAt: null,
    ownerAgentId: null,
    ...over,
  };
}

interface Harness {
  deps: SendSelectionCommentsDeps;
  comments: Map<string, SelectionComment>;
  agents: Map<string, Agent>;
  inFlight: Set<string>;
  sendInputCalls: Array<{ agentId: string; text: string }>;
  launchCalls: LaunchAgentInput[];
  queuedCalls: Array<{ ids: string[]; agentId: string | null }>;
  sentCalls: Array<{ ids: string[]; agentId: string }>;
  failedCalls: string[][];
  asyncErrors: Array<{ agentId: string; error: string }>;
  changedCalls: string[][];
}

function setup(opts: {
  comments?: SelectionComment[];
  agents?: Agent[];
  sendInputResult?: 'resolve' | 'resolve-false' | Error;
  launchResult?: Agent | Error;
} = {}): Harness {
  const comments = new Map((opts.comments ?? [makeComment()]).map((c) => [c.id, c]));
  const agents = new Map((opts.agents ?? [makeAgent()]).map((a) => [a.id, a]));
  const inFlight = new Set<string>();
  const h: Harness = {
    comments, agents, inFlight,
    sendInputCalls: [], launchCalls: [],
    queuedCalls: [], sentCalls: [], failedCalls: [],
    asyncErrors: [], changedCalls: [],
    deps: {
      getComment: (id) => comments.get(id) ?? null,
      getAgent: (id) => agents.get(id) ?? null,
      isInputInFlight: (id) => inFlight.has(id),
      sendInput: (agentId, text) => {
        h.sendInputCalls.push({ agentId, text });
        const r = opts.sendInputResult ?? 'resolve';
        if (r instanceof Error) return Promise.reject(r);
        return Promise.resolve(r !== 'resolve-false');
      },
      launchAgent: (input) => {
        h.launchCalls.push(input);
        const r = opts.launchResult ?? makeAgent({ id: 'agent-new', title: 'Selection task' });
        if (r instanceof Error) return Promise.reject(r);
        return Promise.resolve(r);
      },
      markQueued: (ids, agentId) => h.queuedCalls.push({ ids: [...ids], agentId }),
      markSent: (ids, agentId) => h.sentCalls.push({ ids: [...ids], agentId }),
      markSendFailed: (ids) => h.failedCalls.push([...ids]),
      onAsyncSendError: (payload) => h.asyncErrors.push(payload),
      onCommentsChanged: (ids) => h.changedCalls.push([...ids]),
    },
  };
  return h;
}

function assertRowsUntouched(h: Harness): void {
  assert.equal(h.queuedCalls.length, 0, 'no queued transition');
  assert.equal(h.sentCalls.length, 0, 'no sent transition');
  assert.equal(h.failedCalls.length, 0, 'no send_failed transition');
}

const EXISTING = { kind: 'existing' as const, agentId: 'agent-1' };

// ── sync gates ───────────────────────────────────────────────────────

test('empty commentIds → invalid-request, rows untouched', async () => {
  const h = setup();
  const result = await sendSelectionComments(h.deps, { commentIds: [], target: EXISTING });
  assert.deepEqual(result, { ok: false, code: 'invalid-request', error: 'commentIds must be a non-empty array and a target is required' });
  assertRowsUntouched(h);
});

test('unknown comment id → comment-not-found, rows untouched', async () => {
  const h = setup();
  const result = await sendSelectionComments(h.deps, { commentIds: ['nope'], target: EXISTING });
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, 'comment-not-found');
  assertRowsUntouched(h);
});

test('comments from two different files → invalid-request', async () => {
  const h = setup({
    comments: [
      makeComment({ id: 'c-1' }),
      makeComment({ id: 'c-2', filePath: 'C:\\repo\\other.md' }),
    ],
  });
  const result = await sendSelectionComments(h.deps, { commentIds: ['c-1', 'c-2'], target: EXISTING });
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, 'invalid-request');
  assertRowsUntouched(h);
});

test('unknown agent → agent-not-found, rows untouched', async () => {
  const h = setup();
  const result = await sendSelectionComments(h.deps, {
    commentIds: ['c-1'],
    target: { kind: 'existing', agentId: 'ghost' },
  });
  assert.equal(result.ok, false);
  assert.equal((result as { code: string }).code, 'agent-not-found');
  assertRowsUntouched(h);
});

test('busy agent (working) → agent-busy with the built prompt, rows stay draft', async () => {
  const h = setup({ agents: [makeAgent({ status: 'working' })] });
  const result = await sendSelectionComments(h.deps, { commentIds: ['c-1'], target: EXISTING });
  assert.equal(result.ok, false);
  const busy = result as { code: string; error: string; prompt: string };
  assert.equal(busy.code, 'agent-busy');
  assert.ok(busy.error.includes('"working"'), 'error reports the gating status');
  assert.equal(
    busy.prompt,
    '[SELECTION COMMENT]\nSource: file C:\\repo\\doc.md\n\n1) > quoted text\n   Comment: fact check this',
    'agent-busy carries the exact prompt for the staging fallback',
  );
  assertRowsUntouched(h);
  assert.equal(h.sendInputCalls.length, 0, 'nothing typed at the agent');
});

test('input-in-flight gates as agent-busy even when status reads idle', async () => {
  const h = setup();
  h.inFlight.add('agent-1');
  const result = await sendSelectionComments(h.deps, { commentIds: ['c-1'], target: EXISTING });
  assert.equal(result.ok, false);
  const busy = result as { code: string; error: string };
  assert.equal(busy.code, 'agent-busy');
  assert.ok(busy.error.includes('"receiving"'), 'in-flight reports as receiving');
  assertRowsUntouched(h);
});

test('the accepting set mirrors slice-1 selection-dispatch.ts', () => {
  assert.deepEqual(
    [...COMMENT_SEND_ACCEPTING].sort(),
    ['crashed', 'done', 'idle', 'waiting'],
  );
});

test('every non-accepting status gates as agent-busy', async () => {
  const blocked: AgentStatus[] = ['launching', 'working', 'restarting', 'receiving'];
  for (const status of blocked) {
    const h = setup({ agents: [makeAgent({ status })] });
    const result = await sendSelectionComments(h.deps, { commentIds: ['c-1'], target: EXISTING });
    assert.equal(result.ok, false, `${status} must gate`);
    assert.equal((result as { code: string }).code, 'agent-busy', `${status} → agent-busy`);
    assertRowsUntouched(h);
  }
});

// ── existing agent delivery ──────────────────────────────────────────

test('idle agent: queued → sendInput(prompt) → sent', async () => {
  const h = setup();
  const result = await sendSelectionComments(h.deps, { commentIds: ['c-1'], target: EXISTING });
  assert.deepEqual(result, { ok: true, agentId: 'agent-1', launched: false });
  assert.deepEqual(h.queuedCalls, [{ ids: ['c-1'], agentId: 'agent-1' }]);

  await flushMicrotasks();
  assert.equal(h.sendInputCalls.length, 1);
  assert.equal(h.sendInputCalls[0].agentId, 'agent-1');
  assert.deepEqual(h.sentCalls, [{ ids: ['c-1'], agentId: 'agent-1' }]);
  assert.equal(h.failedCalls.length, 0);
  assert.equal(h.asyncErrors.length, 0);
  assert.deepEqual(h.changedCalls, [['c-1']], 'final transition surfaced via onCommentsChanged');
});

test('crashed agent is accepting (slice-1 contract): send proceeds', async () => {
  const h = setup({ agents: [makeAgent({ status: 'crashed' })] });
  const result = await sendSelectionComments(h.deps, { commentIds: ['c-1'], target: EXISTING });
  assert.equal(result.ok, true);
  await flushMicrotasks();
  assert.equal(h.sentCalls.length, 1);
});

test('sendInput rejection → send_failed + agent:send-input-error surface', async () => {
  const h = setup({ sendInputResult: new Error('PTY closed mid-typing') });
  const result = await sendSelectionComments(h.deps, { commentIds: ['c-1'], target: EXISTING });
  assert.equal(result.ok, true, 'gate passed; failure is async');
  await flushMicrotasks();
  assert.equal(h.sentCalls.length, 0);
  assert.deepEqual(h.failedCalls, [['c-1']]);
  assert.deepEqual(h.asyncErrors, [{ agentId: 'agent-1', error: 'PTY closed mid-typing' }]);
  assert.deepEqual(h.changedCalls, [['c-1']]);
});

test('sendInput resolving false (nothing typed) → send_failed', async () => {
  const h = setup({ sendInputResult: 'resolve-false' });
  const result = await sendSelectionComments(h.deps, { commentIds: ['c-1'], target: EXISTING });
  assert.equal(result.ok, true);
  await flushMicrotasks();
  assert.equal(h.sentCalls.length, 0);
  assert.deepEqual(h.failedCalls, [['c-1']]);
  assert.equal(h.asyncErrors.length, 1);
});

// ── new agent delivery ───────────────────────────────────────────────

test('new agent: launch carries initialUserPrompt with the slice-1 launch shape; queued → sent', async () => {
  const h = setup();
  const result = await sendSelectionComments(h.deps, { commentIds: ['c-1'], target: { kind: 'new' } });
  assert.deepEqual(result, { ok: true, agentId: 'agent-new', launched: true });

  assert.deepEqual(h.queuedCalls, [{ ids: ['c-1'], agentId: null }], 'queued before launch, no agent id yet');
  assert.equal(h.launchCalls.length, 1);
  const launch = h.launchCalls[0];
  assert.equal(launch.workspaceId, 'ws-1');
  assert.equal(launch.title, 'Selection task');
  assert.equal(launch.provider, 'claude');
  assert.equal(launch.isWorker, true);
  assert.ok(launch.initialUserPrompt!.startsWith('[SELECTION COMMENT]'), 'prompt rides the WP-P2 pending-map seam');
  assert.deepEqual(h.sentCalls, [{ ids: ['c-1'], agentId: 'agent-new' }]);
  assert.equal(h.sendInputCalls.length, 0, 'new-agent path never types directly');
});

test('launch rejection → send_failed + launch-failed code', async () => {
  const h = setup({ launchResult: new Error('Workspace not found') });
  const result = await sendSelectionComments(h.deps, { commentIds: ['c-1'], target: { kind: 'new' } });
  assert.deepEqual(result, { ok: false, code: 'launch-failed', error: 'Workspace not found' });
  assert.equal(h.queuedCalls.length, 1, 'queued before the attempt');
  assert.deepEqual(h.failedCalls, [['c-1']]);
});

// ── prompt format (plan §4, mirrors quoted-prompt.ts semantics) ──────

test('single comment with empty body collapses to a bare blockquote', async () => {
  const h = setup({
    comments: [makeComment({ body: '', quotedText: 'line one\nline two' })],
    agents: [makeAgent({ status: 'working' })],
  });
  const result = await sendSelectionComments(h.deps, { commentIds: ['c-1'], target: EXISTING });
  const busy = result as { prompt: string };
  assert.equal(
    busy.prompt,
    '[SELECTION COMMENT]\nSource: file C:\\repo\\doc.md\n\n> line one\n> line two',
  );
});

test('single comment with line anchors emits a Lines: header', async () => {
  const h = setup({
    comments: [makeComment({ body: '', lineStart: 41, lineEnd: 58 })],
    agents: [makeAgent({ status: 'working' })],
  });
  const result = await sendSelectionComments(h.deps, { commentIds: ['c-1'], target: EXISTING });
  const busy = result as { prompt: string };
  assert.equal(
    busy.prompt,
    '[SELECTION COMMENT]\nSource: file C:\\repo\\doc.md\nLines: 41-58\n\n> quoted text',
  );
});

test('multi-comment send builds ONE numbered prompt and omits Lines:', async () => {
  const h = setup({
    comments: [
      makeComment({ id: 'c-1', quotedText: 'first quote,\nwrapping', body: 'fact check this section', lineStart: 3, lineEnd: 4 }),
      makeComment({ id: 'c-2', quotedText: 'second quote', body: '', lineStart: 9, lineEnd: 9 }),
    ],
    agents: [makeAgent({ status: 'working' })],
  });
  const result = await sendSelectionComments(h.deps, { commentIds: ['c-1', 'c-2'], target: EXISTING });
  const busy = result as { prompt: string };
  assert.equal(
    busy.prompt,
    '[SELECTION COMMENT]\n' +
    'Source: file C:\\repo\\doc.md\n' +
    '\n' +
    '1) > first quote,\n' +
    '   > wrapping\n' +
    '   Comment: fact check this section\n' +
    '\n' +
    '2) > second quote\n' +
    '   (no comment — act on this text directly)',
  );
});

test('multi-id send delivers exactly one sendInput call', async () => {
  const h = setup({
    comments: [makeComment({ id: 'c-1' }), makeComment({ id: 'c-2', body: 'and this' })],
  });
  const result = await sendSelectionComments(h.deps, { commentIds: ['c-1', 'c-2'], target: EXISTING });
  assert.equal(result.ok, true);
  await flushMicrotasks();
  assert.equal(h.sendInputCalls.length, 1, 'one [SELECTION COMMENT] message, not one per comment');
  assert.deepEqual(h.sentCalls, [{ ids: ['c-1', 'c-2'], agentId: 'agent-1' }]);
});

// ── PDF page context (plan Part 1.8) ─────────────────────────────────

test('single-page PDF send carries a header Page line (one-based)', async () => {
  const h = setup({
    comments: [makeComment({ body: '', anchorType: 'pdf', pdfAnchor: pdfAnchor(2), quotedText: 'photosynthetic yield' })],
    agents: [makeAgent({ status: 'working' })],
  });
  const result = await sendSelectionComments(h.deps, { commentIds: ['c-1'], target: EXISTING });
  const busy = result as { prompt: string };
  assert.equal(
    busy.prompt,
    '[SELECTION COMMENT]\nSource: file C:\\repo\\doc.md\nPage: 3\n\n> photosynthetic yield',
  );
});

test('multi-page PDF send carries per-quote Anchor lines from each row', async () => {
  const h = setup({
    comments: [
      makeComment({ id: 'c-1', anchorType: 'pdf', pdfAnchor: pdfAnchor(2), quotedText: 'first', body: 'a' }),
      makeComment({ id: 'c-2', anchorType: 'pdf', pdfAnchor: pdfAnchor(6), quotedText: 'second', body: 'b' }),
    ],
    agents: [makeAgent({ status: 'working' })],
  });
  const result = await sendSelectionComments(h.deps, { commentIds: ['c-1', 'c-2'], target: EXISTING });
  const busy = result as { prompt: string };
  assert.equal(
    busy.prompt,
    '[SELECTION COMMENT]\n' +
    'Source: file C:\\repo\\doc.md\n' +
    '\n' +
    '1) > first\n' +
    '   Anchor: page 3\n' +
    '   Comment: a\n' +
    '\n' +
    '2) > second\n' +
    '   Anchor: page 7\n' +
    '   Comment: b',
  );
});

test('page label flows into the prompt when it differs from the number', async () => {
  const h = setup({
    comments: [makeComment({ body: '', anchorType: 'pdf', pdfAnchor: pdfAnchor(3, 'iv'), quotedText: 'front matter' })],
    agents: [makeAgent({ status: 'working' })],
  });
  const busy = await sendSelectionComments(h.deps, { commentIds: ['c-1'], target: EXISTING }) as { prompt: string };
  assert.match(busy.prompt, /Page: 4 \(labeled "iv"\)/);
});

test('coordinate-only PDF send emits the region marker + Region line', async () => {
  const h = setup({
    comments: [makeComment({
      anchorType: 'pdf',
      pdfAnchor: pdfAnchor(2, undefined, true),
      quotedText: '[Area on PDF page 3]',
      body: 'what is this figure?',
    })],
    agents: [makeAgent({ status: 'working' })],
  });
  const busy = await sendSelectionComments(h.deps, { commentIds: ['c-1'], target: EXISTING }) as { prompt: string };
  assert.equal(
    busy.prompt,
    '[SELECTION COMMENT]\n' +
    'Source: file C:\\repo\\doc.md\n' +
    'Page: 3\n' +
    '\n' +
    '1) [Area on PDF page 3]\n' +
    '   Region: x=0.100 y=0.200 w=0.300 h=0.050 (normalized, unrotated)\n' +
    '   Comment: what is this figure?',
  );
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
