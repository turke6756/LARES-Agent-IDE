// WP2 provenance spine — plan-touch-tracker unit test (both providers).
//
//   npm run build:main
//   node dist/main/main/plans/plan-touch-tracker.test.js

import assert from 'node:assert/strict';
import type { ToolUseEvent } from '../../shared/session-events';
import type { PlanSectionTouchInput } from '../database';
import {
  PlanTouchTracker,
  PENDING_EDIT_ANCHOR,
  ORIENTATION_ANCHOR,
} from './plan-touch-tracker';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const PLAN_ID = 'plan-1';
const PLAN_PATH = 'C:\\repo\\plans\\auth.html';

function makeTracker(overrides?: { planId?: string | null; planPath?: string | null }) {
  const recorded: PlanSectionTouchInput[] = [];
  const tracker = new PlanTouchTracker({
    getAgentPlanId: () => (overrides && 'planId' in overrides ? overrides.planId ?? null : PLAN_ID),
    getPlanPath: () => (overrides && 'planPath' in overrides ? overrides.planPath ?? null : PLAN_PATH),
    recordPlanSectionTouch: (input) => { recorded.push(input); return 'row-' + recorded.length; },
  });
  return { tracker, recorded };
}

function ev(toolName: string, input: unknown, toolUseId = 'tu-1'): ToolUseEvent {
  return { type: 'tool-use', uuid: 'u1', agentId: 'a1', timestamp: '1970-01-01T00:00:00Z', toolUseId, toolName, input } as ToolUseEvent;
}

// ── Reads (intent) ──────────────────────────────────────────────────────────

test('claude mcp-prefixed read_plan_section records a read touch with anchor + mode', () => {
  const { tracker, recorded } = makeTracker();
  tracker.observeToolUse('a1', ev('mcp__agent-dashboard__read_plan_section', {
    plan_id: PLAN_ID, anchor: 'sec_abc123', mode: 'raw+editWindow',
  }));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, 'read');
  assert.equal(recorded[0].tool, 'read_plan_section');
  assert.equal(recorded[0].sectionAnchor, 'sec_abc123');
  assert.equal(recorded[0].readMode, 'raw+editWindow');
  assert.equal(recorded[0].source, 'transcript');
});

test('codex bare read_plan_section suffix-matches and falls back to agent plan_id', () => {
  const { tracker, recorded } = makeTracker();
  tracker.observeToolUse('a1', ev('read_plan_section', { anchor: 'sec_def456' }));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].planId, PLAN_ID);
  assert.equal(recorded[0].sectionAnchor, 'sec_def456');
});

test('list_plan_sections records a single orientation touch (sentinel *)', () => {
  const { tracker, recorded } = makeTracker();
  tracker.observeToolUse('a1', ev('list_plan_sections', { plan_id: PLAN_ID }));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].sectionAnchor, ORIENTATION_ANCHOR);
  assert.equal(recorded[0].kind, 'read');
});

test('anchorless read_plan_projection is an orientation read', () => {
  const { tracker, recorded } = makeTracker();
  tracker.observeToolUse('a1', ev('read_plan_projection', { plan_id: PLAN_ID }));
  assert.equal(recorded[0].sectionAnchor, ORIENTATION_ANCHOR);
});

test('read with no resolvable plan_id is skipped (cannot attribute)', () => {
  const { tracker, recorded } = makeTracker({ planId: null });
  tracker.observeToolUse('a1', ev('read_plan_section', { anchor: 'sec_abc123' }));
  assert.equal(recorded.length, 0);
});

// ── Native edits (edit-target) ───────────────────────────────────────────────

test('claude Edit on the plan file → PENDING edit-target with old_string fingerprint', () => {
  const { tracker, recorded } = makeTracker();
  tracker.observeToolUse('a1', ev('Edit', {
    file_path: PLAN_PATH, old_string: '<div data-anchor="sec_abc123">old</div>', new_string: 'new',
  }));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, 'edit-target');
  assert.equal(recorded[0].tool, 'edit');
  assert.equal(recorded[0].sectionAnchor, PENDING_EDIT_ANCHOR);
  const payload = JSON.parse(recorded[0].resolvePayload!);
  assert.equal(payload.provider, 'claude');
  assert.equal(payload.editWindows.length, 1);
  assert.ok(payload.editWindows[0].hash, 'stores a hash of old_string');
});

test('claude MultiEdit stores every edit window', () => {
  const { tracker, recorded } = makeTracker();
  tracker.observeToolUse('a1', ev('MultiEdit', {
    file_path: PLAN_PATH,
    edits: [{ old_string: 'aaa', new_string: 'x' }, { old_string: 'bbb', new_string: 'y' }],
  }));
  const payload = JSON.parse(recorded[0].resolvePayload!);
  assert.equal(payload.editWindows.length, 2);
  assert.equal(recorded[0].tool, 'edit');
});

test('claude Write on the plan file → tool "write" edit-target', () => {
  const { tracker, recorded } = makeTracker();
  tracker.observeToolUse('a1', ev('Write', { file_path: PLAN_PATH, content: '<html>…</html>' }));
  assert.equal(recorded[0].tool, 'write');
  assert.equal(recorded[0].kind, 'edit-target');
});

test('claude Edit on a NON-plan file records nothing', () => {
  const { tracker, recorded } = makeTracker();
  tracker.observeToolUse('a1', ev('Edit', { file_path: 'C:\\repo\\src\\index.ts', old_string: 'a', new_string: 'b' }));
  assert.equal(recorded.length, 0);
});

test('edit falls back to the /plans/ path segment when it is not the dispatched plan', () => {
  const { tracker, recorded } = makeTracker({ planPath: null });
  tracker.observeToolUse('a1', ev('Edit', { file_path: 'C:\\repo\\plans\\other.html', old_string: 'a', new_string: 'b' }));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, 'edit-target');
});

test('codex apply_patch touching a plans/ file → PENDING edit-target with hunk context', () => {
  const { tracker, recorded } = makeTracker();
  const patch = [
    '*** Begin Patch',
    '*** Update File: plans/auth.html',
    '@@',
    '-<div data-anchor="sec_abc123">old</div>',
    '+<div data-anchor="sec_abc123">new</div>',
    '*** End Patch',
  ].join('\n');
  tracker.observeToolUse('a1', ev('apply_patch', { input: patch, workdir: 'C:\\repo' }));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, 'edit-target');
  assert.equal(recorded[0].tool, 'apply_patch');
  assert.equal(recorded[0].sectionAnchor, PENDING_EDIT_ANCHOR);
  const payload = JSON.parse(recorded[0].resolvePayload!);
  assert.equal(payload.provider, 'codex');
  assert.ok(payload.hunkContext.includes('data-anchor="sec_abc123"'));
});

test('codex apply_patch touching only non-plan files records nothing', () => {
  const { tracker, recorded } = makeTracker();
  const patch = '*** Begin Patch\n*** Update File: src/index.ts\n@@\n-a\n+b\n*** End Patch';
  tracker.observeToolUse('a1', ev('apply_patch', { input: patch, workdir: 'C:\\repo' }));
  assert.equal(recorded.length, 0);
});

// ── Tolerance ────────────────────────────────────────────────────────────────

test('unknown tool is a no-op', () => {
  const { tracker, recorded } = makeTracker();
  tracker.observeToolUse('a1', ev('Bash', { command: 'ls' }));
  assert.equal(recorded.length, 0);
});

test('malformed / null input never throws', () => {
  const { tracker, recorded } = makeTracker();
  assert.doesNotThrow(() => tracker.observeToolUse('a1', ev('Edit', null)));
  assert.doesNotThrow(() => tracker.observeToolUse('a1', ev('read_plan_section', 42)));
  assert.doesNotThrow(() => tracker.observeToolUse('a1', { type: 'tool-use' } as ToolUseEvent));
  assert.equal(recorded.length, 0);
});

// ── Runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
