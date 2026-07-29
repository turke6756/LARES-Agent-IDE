// janitor-brief.test.ts — WP-H2 janitor brief + firing classifier + dispatch.
//
// Covers:
//   - renderJanitorBrief is byte-identical for identical inputs and stable under
//     a shuffled queue order (deterministic sort, no timestamps in the body);
//   - the brief carries the honest never-recalled / never-fired /
//     evidence-unavailable wording;
//   - classifyLessonFiring: insufficient coverage (either flag false) →
//     'unavailable' with no absence claim; sufficient coverage classifies each
//     lesson fired / not-fired;
//   - generateJanitorBrief wires the injected reads into the renderer;
//   - registerMemoryReviewIpc with janitor deps registers exactly the three
//     renderer-only channels; dispatchJanitor LAUNCHES an agent through the
//     injected user launch path with the brief as its initial prompt (asserted),
//     while generate/buildJanitorBrief NEVER launches (brief only on dispatch);
//   - a blank workspace id is rejected without a launch.
//
//   npm run build:main
//   node dist/main/main/memory-index/janitor-brief.test.js

import assert from 'node:assert/strict';
import type { LaunchAgentInput } from '../../shared/types';
import type { LessonRow, ReviewFindingRow } from './review-store';
import {
  EVIDENCE_UNAVAILABLE_LINE,
  classifyLessonFiring,
  generateJanitorBrief,
  renderJanitorBrief,
  type JanitorBriefDeps,
  type LessonFiringResult,
} from './janitor-brief';
import {
  MEMORY_REVIEW_CHANNELS,
  buildJanitorBrief,
  dispatchJanitor,
  registerMemoryReviewIpc,
  type IpcLike,
  type MemoryJanitorIpcDeps,
  type MemoryReviewIpcDeps,
} from './memory-ipc';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

// ── fixtures ─────────────────────────────────────────────────────────────
function finding(over: Partial<ReviewFindingRow> & { kind: string }): ReviewFindingRow {
  return {
    findingId: over.findingId ?? `f-${over.kind}-${over.entryId ?? 'x'}`,
    workspaceId: 'ws-1',
    entryId: over.entryId ?? null,
    sourceHash: 'h',
    reason: over.reason ?? `${over.kind} reason`,
    exitCondition: over.exitCondition ?? null,
    status: 'pending',
    firstSeen: over.firstSeen ?? '2026-07-01T00:00:00Z',
    lastSeen: over.lastSeen ?? '2026-07-28T00:00:00Z',
    ...over,
  };
}

function lesson(name: string): LessonRow {
  return {
    workspaceId: 'ws-1',
    lessonId: `mb-2026-07-01-${name}`,
    name,
    canonicalHash: 'h',
    copies: [],
    preexisted: [],
    batchId: null,
    status: 'active',
    createdAt: '2026-07-01T00:00:00Z',
  };
}

const NEVER_RECALLED_REASON = 'never recalled via `recall_memory`; raw-file reads are unobserved.';

/** A representative queue: one of every kind we present. */
function fullQueue(): ReviewFindingRow[] {
  return [
    finding({ kind: 'hard-invalid', reason: 'legacy-format: marker missing' }),
    finding({ kind: 'cap-pressure', reason: 'index over 80% of a budget' }),
    finding({ kind: 'condition-review', entryId: 'mb-2026-06-01-pi', exitCondition: 'pi-integration lands' }),
    finding({ kind: 'never-recalled', entryId: 'mb-2026-05-01-old', reason: NEVER_RECALLED_REASON }),
    finding({ kind: 'stale-active', entryId: 'mb-2026-05-02-x', reason: 'untouched > 14 days' }),
  ];
}

function firingOk(fired: Record<string, boolean>): LessonFiringResult {
  return { coverage: 'ok', fired: new Map(Object.entries(fired)) };
}

// ── renderJanitorBrief determinism ─────────────────────────────────────────
test('brief is byte-identical for identical inputs', () => {
  const input = {
    pending: fullQueue(),
    lessons: [lesson('never-git-stash'), lesson('crlf-guard')],
    firing: firingOk({ 'never-git-stash': true, 'crlf-guard': false }),
  };
  assert.equal(renderJanitorBrief(input), renderJanitorBrief(input));
});

test('brief is stable under a shuffled queue order', () => {
  const q = fullQueue();
  const shuffled = [q[3], q[0], q[4], q[2], q[1]];
  const lessons = [lesson('b-lesson'), lesson('a-lesson')];
  const firing = firingOk({ 'a-lesson': false, 'b-lesson': true });
  const a = renderJanitorBrief({ pending: q, lessons, firing });
  const b = renderJanitorBrief({ pending: shuffled, lessons: [lessons[1], lessons[0]], firing });
  assert.equal(a, b, 'sort is content-stable, not order-dependent');
});

// ── honest wording ─────────────────────────────────────────────────────────
test('brief carries the honest never-recalled wording (from the queue reason)', () => {
  const out = renderJanitorBrief({ pending: fullQueue(), lessons: [], firing: firingOk({}) });
  assert.ok(out.includes('### never-recalled'), 'never-recalled kind heading present');
  assert.ok(out.includes(NEVER_RECALLED_REASON), 'honest never-recalled reason present');
});

test('brief carries honest never-fired wording when coverage is OK and a lesson never fired', () => {
  const out = renderJanitorBrief({
    pending: [],
    lessons: [lesson('unused-lesson')],
    firing: firingOk({ 'unused-lesson': false }),
  });
  assert.ok(out.includes('never fired'), 'never-fired wording present');
  assert.ok(out.includes("Claude's `.claude/projects` corpus"), 'scoped to the Claude corpus, honestly');
  assert.ok(out.includes('Candidate to retire or graduate'), 'framed as a candidate, not a verdict');
});

test('brief emits evidence-unavailable (no absence claim) when coverage is insufficient', () => {
  const out = renderJanitorBrief({
    pending: [],
    lessons: [lesson('some-lesson')],
    firing: { coverage: 'unavailable', fired: new Map() },
  });
  assert.ok(out.includes(EVIDENCE_UNAVAILABLE_LINE), 'exact evidence-unavailable line present');
  assert.ok(!out.includes('never fired'), 'NO absence claim when coverage is unavailable');
});

test('empty queue + no lessons renders a quiet, well-formed brief', () => {
  const out = renderJanitorBrief({ pending: [], lessons: [], firing: firingOk({}) });
  assert.ok(out.includes('## Pending review queue (0)'));
  assert.ok(out.includes('_No pending findings._'));
  assert.ok(out.includes('_No active lessons registered._'));
});

// ── classifyLessonFiring coverage guard ─────────────────────────────────────
test('classifyLessonFiring: incomplete corpus → unavailable, no classification', () => {
  const r = classifyLessonFiring(['a'], new Set(['a']), { corpusComplete: false, attributionReliable: true });
  assert.equal(r.coverage, 'unavailable');
  assert.equal(r.fired.size, 0);
});

test('classifyLessonFiring: unreliable attribution → unavailable, no classification', () => {
  const r = classifyLessonFiring(['a'], new Set(['a']), { corpusComplete: true, attributionReliable: false });
  assert.equal(r.coverage, 'unavailable');
  assert.equal(r.fired.size, 0);
});

test('classifyLessonFiring: sufficient coverage classifies each lesson fired / not', () => {
  const r = classifyLessonFiring(['fired', 'unfired'], new Set(['fired']), {
    corpusComplete: true,
    attributionReliable: true,
  });
  assert.equal(r.coverage, 'ok');
  assert.equal(r.fired.get('fired'), true);
  assert.equal(r.fired.get('unfired'), false);
});

// ── generateJanitorBrief wiring ─────────────────────────────────────────────
function briefDeps(over: Partial<{
  pending: ReviewFindingRow[];
  lessons: LessonRow[];
  firing: LessonFiringResult;
  calls: { assessNames: string[][] };
}> = {}): JanitorBriefDeps & { calls: { assessNames: string[][] } } {
  const calls = over.calls ?? { assessNames: [] };
  return {
    calls,
    listPending: () => over.pending ?? [],
    listActiveLessons: () => over.lessons ?? [],
    assessFiring: (_ws, names) => { calls.assessNames.push(names); return over.firing ?? firingOk({}); },
  };
}

test('generateJanitorBrief passes the active lesson NAMES to the firing check', () => {
  const deps = briefDeps({ lessons: [lesson('l1'), lesson('l2')], firing: firingOk({ l1: true, l2: false }) });
  const out = generateJanitorBrief(deps, 'ws-1');
  assert.deepEqual(deps.calls.assessNames, [['l1', 'l2']]);
  assert.ok(out.includes('# Memory index janitor brief'));
});

// ── IPC dispatch ────────────────────────────────────────────────────────────
function makeIpc(): { ipc: IpcLike; handlers: Map<string, (e: unknown, ...a: unknown[]) => unknown> } {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
  return { handlers, ipc: { handle(ch, l) { handlers.set(ch, l); } } };
}

const noopReviewDeps: MemoryReviewIpcDeps = { listFindings: () => [], getIndexState: () => null };

function janitorDeps(over: Partial<{
  pending: ReviewFindingRow[];
  lessons: LessonRow[];
  firing: LessonFiringResult;
}> = {}): { deps: MemoryJanitorIpcDeps; launches: LaunchAgentInput[] } {
  const launches: LaunchAgentInput[] = [];
  return {
    launches,
    deps: {
      listPending: () => over.pending ?? [],
      listActiveLessons: () => over.lessons ?? [],
      assessFiring: () => over.firing ?? firingOk({}),
      launchAgent: async (input) => { launches.push(input); return { id: 'agent-janitor-1' }; },
    },
  };
}

test('registerMemoryReviewIpc with janitor deps registers exactly the three channels', () => {
  const { ipc, handlers } = makeIpc();
  const { deps } = janitorDeps();
  registerMemoryReviewIpc(ipc, noopReviewDeps, deps);
  assert.equal(handlers.size, 3);
  assert.ok(handlers.has(MEMORY_REVIEW_CHANNELS.listReview));
  assert.ok(handlers.has(MEMORY_REVIEW_CHANNELS.generateJanitorBrief));
  assert.ok(handlers.has(MEMORY_REVIEW_CHANNELS.dispatchJanitor));
});

test('dispatchJanitor LAUNCHES an agent via the injected launch path with the brief as its prompt', async () => {
  const { deps, launches } = janitorDeps({
    pending: fullQueue(),
    lessons: [lesson('l1')],
    firing: firingOk({ l1: false }),
  });
  const res = await dispatchJanitor(deps, 'ws-1');
  assert.equal(res.ok, true);
  assert.equal(res.agentId, 'agent-janitor-1');
  assert.equal(launches.length, 1, 'exactly one agent launched');
  const input = launches[0];
  assert.equal(input.workspaceId, 'ws-1');
  // The brief — not merely markdown returned — is delivered as the initial prompt.
  assert.equal(input.initialUserPrompt, res.brief);
  assert.ok((input.initialUserPrompt ?? '').includes('# Memory index janitor brief'));
});

test('dispatchJanitor rejects a blank workspace id WITHOUT launching', async () => {
  for (const bad of ['', null, undefined, 42]) {
    const { deps, launches } = janitorDeps();
    const res = await dispatchJanitor(deps, bad as unknown);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'invalid_workspace');
    assert.equal(launches.length, 0, `no launch for ${String(bad)}`);
  }
});

test('generate/buildJanitorBrief returns the brief but NEVER launches (brief only on dispatch)', () => {
  const { deps, launches } = janitorDeps({ pending: fullQueue(), lessons: [], firing: firingOk({}) });
  const dto = buildJanitorBrief(deps, 'ws-1');
  assert.equal(dto.ok, true);
  assert.ok(dto.brief.includes('# Memory index janitor brief'));
  assert.equal(launches.length, 0, 'previewing the brief must not launch an agent');
});

test('buildJanitorBrief for a blank workspace id → not ok, empty brief', () => {
  const { deps } = janitorDeps();
  assert.deepEqual(buildJanitorBrief(deps, ''), { ok: false, brief: '' });
});

// ── runner ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); }
    catch (e) { failed++; console.error(`FAIL  ${t.name}\n`, e); }
  }
  if (failed > 0) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log(`\njanitor-brief.test: ${tests.length} passed`);
}
void main();
