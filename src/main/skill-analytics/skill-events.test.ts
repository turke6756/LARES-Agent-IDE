// skill-events unit tests (P0.2 detectors, A8 turn_usage, design §4.4 behavior
// events, A9 §3.2 trigger snippets). Real-corpus fixtures under __fixtures__/.
// Pure — system-Node runner (FROM WORKSPACE ROOT):
//   npm run build:main
//   node dist/main/main/skill-analytics/skill-events.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  detectSkillInvocations,
  classifyToolUse,
  toolKindOf,
  extractTurnUsage,
  extractUsageOutputTokens,
  extractBehaviorEvents,
  selectTriggerSnippet,
  isEndTurn,
  endsWithQuestion,
  TRIGGER_SNIPPET_MAX_CHARS,
  type RawEntry,
  type StreamCtx,
  type PriorUserEntry,
} from './skill-events';

// Fixtures resolve from the source tree; tests run with cwd = workspace root.
const FIX = path.resolve(process.cwd(), 'src/main/skill-analytics/__fixtures__');
function loadFixture(name: string): RawEntry[] {
  const raw = readFileSync(path.join(FIX, name), 'utf8');
  return raw.split(/\r?\n/).filter((l) => l.trim().length).map((l) => JSON.parse(l) as RawEntry);
}

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${(e as Error).message}`);
  }
}

function baseCtx(overrides: Partial<StreamCtx> = {}): StreamCtx {
  return {
    jsonlPath: 'x.jsonl',
    streamId: 'x.jsonl',
    isSubagent: false,
    lane: 'supervisor',
    knownSkills: new Set<string>(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P0.2 — skill invocation detection
// ─────────────────────────────────────────────────────────────────────────────
test('detectSkillInvocations: tool_use (top-level) → run-orchestration', () => {
  const [meta, asst] = loadFixture('skill-toplevel.jsonl');
  // the isMeta user entry yields nothing
  assert.equal(detectSkillInvocations(meta, baseCtx(), 0).length, 0);
  const invs = detectSkillInvocations(asst, baseCtx(), 0);
  assert.equal(invs.length, 1);
  assert.equal(invs[0].skillName, 'run-orchestration');
  assert.equal(invs[0].detector, 'tool_use');
  assert.ok(invs[0].args && invs[0].args.startsWith('groupthink parallel'));
  assert.equal(invs[0].blockIndex, 0);
});

test('detectSkillInvocations: tool_use (subagent) → deep-research', () => {
  const [, asst] = loadFixture('skill-subagent.jsonl');
  const invs = detectSkillInvocations(asst, baseCtx({ isSubagent: true }), 0);
  assert.equal(invs.length, 1);
  assert.equal(invs[0].skillName, 'deep-research');
  assert.equal(invs[0].detector, 'tool_use');
});

test('detectSkillInvocations: slash /clear dropped (built-in), /deep-research kept when known', () => {
  const [clearEntry, drEntry] = loadFixture('slash-command.jsonl');
  const ctx = baseCtx({ knownSkills: new Set(['deep-research']) });
  // /clear is a built-in → never emitted, even if listed
  assert.equal(detectSkillInvocations(clearEntry, ctx, 0).length, 0);
  const invs = detectSkillInvocations(drEntry, ctx, 100);
  assert.equal(invs.length, 1);
  assert.equal(invs[0].skillName, 'deep-research');
  assert.equal(invs[0].detector, 'slash_command');
  assert.equal(invs[0].args, 'latest electron ipc security advisories 2026');
});

test('detectSkillInvocations: slash unknown skill dropped', () => {
  const [, drEntry] = loadFixture('slash-command.jsonl');
  // knownSkills empty → /deep-research not emitted (only known skills survive)
  assert.equal(detectSkillInvocations(drEntry, baseCtx(), 0).length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// P0.2 — tool_use classification
// ─────────────────────────────────────────────────────────────────────────────
test('toolKindOf: skill / mcp / builtin', () => {
  assert.equal(toolKindOf('Skill'), 'skill');
  assert.equal(toolKindOf('mcp__agent-dashboard__list_agents'), 'mcp');
  assert.equal(toolKindOf('Bash'), 'builtin');
});

test('classifyToolUse: PowerShell is builtin, not search', () => {
  const [, tu] = loadFixture('window-complete.jsonl');
  const infos = classifyToolUse(tu);
  assert.equal(infos.length, 1);
  assert.equal(infos[0].toolName, 'PowerShell');
  assert.equal(infos[0].toolKind, 'builtin');
  assert.equal(infos[0].isSearch, false);
});

test('classifyToolUse: Grep is a search with normalized query + signature', () => {
  const entry: RawEntry = {
    type: 'assistant',
    uuid: 'g1',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'FOO', path: 'C:\\Users\\x\\proj' } } as any] },
  };
  const [info] = classifyToolUse(entry);
  assert.equal(info.isSearch, true);
  assert.equal(info.normalizedQuery, 'foo');
  assert.ok(info.searchSignatureHash && info.searchSignatureHash.length === 16);
});

// ─────────────────────────────────────────────────────────────────────────────
// A8 — turn usage
// ─────────────────────────────────────────────────────────────────────────────
test('extractTurnUsage: four disjoint fields + model', () => {
  const [, asst] = loadFixture('skill-toplevel.jsonl');
  const u = extractTurnUsage(asst);
  assert.ok(u);
  assert.equal(u!.input_tokens, 2);
  assert.equal(u!.cache_creation_tokens, 586);
  assert.equal(u!.cache_read_tokens, 81212);
  assert.equal(u!.output_tokens, 2244);
  assert.equal(u!.model, 'claude-fable-5');
});

test('extractTurnUsage: no usage → null (no zero row)', () => {
  const entries = loadFixture('usage-turns.jsonl');
  const noUsage = entries.find((e) => e.uuid === 'ut-nousage-0003')!;
  assert.equal(extractTurnUsage(noUsage), null);
  assert.equal(extractUsageOutputTokens(noUsage), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// end_turn signals
// ─────────────────────────────────────────────────────────────────────────────
test('isEndTurn / endsWithQuestion', () => {
  const entries = loadFixture('window-complete.jsonl');
  const end = entries.find((e) => e.uuid === 'wc-end-0004')!;
  const inv = entries.find((e) => e.uuid === 'wc-inv-0001')!;
  assert.equal(isEndTurn(end), true);
  assert.equal(isEndTurn(inv), false);          // stop_reason: tool_use
  assert.equal(endsWithQuestion(end), false);   // ends with '.'
});

test('endsWithQuestion: true when last text ends with ?', () => {
  const entry: RawEntry = {
    type: 'assistant', uuid: 'q1',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Which approach do you prefer?' } as any] },
  };
  assert.equal(endsWithQuestion(entry), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// design §4.4 — behavior events over the full window
// ─────────────────────────────────────────────────────────────────────────────
test('extractBehaviorEvents: window-complete emits the expected per-entry events', () => {
  const entries = loadFixture('window-complete.jsonl');
  const ctx = baseCtx({ lane: 'worker', workingDir: 'C:\\Users\\turke\\.dashboard\\workers\\claude' });

  // wc-inv-0001: Skill tool_use → one generic tool_use event, no file_touch, no outcome
  const inv = extractBehaviorEvents(entries[0], ctx, 0);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].kind, 'tool_use');
  assert.equal(inv[0].toolName, 'Skill');
  assert.equal(inv[0].toolKind, 'skill');

  // wc-tu-0002: PowerShell Get-ChildItem (no script, no pm-family) → one tool_use event only
  const tu = extractBehaviorEvents(entries[1], ctx, 0);
  assert.equal(tu.length, 1);
  assert.equal(tu[0].kind, 'tool_use');
  assert.equal(tu[0].toolName, 'PowerShell');
  assert.equal(tu[0].commandFamily ?? null, null);

  // wc-err-0003: user tool_result is_error → one tool_result event, outcome 'error'
  const res = extractBehaviorEvents(entries[2], ctx, 0);
  assert.equal(res.length, 1);
  assert.equal(res[0].kind, 'tool_result');
  assert.equal(res[0].outcome, 'error');

  // wc-end-0004: end_turn text → one turn_outcome event
  const end = extractBehaviorEvents(entries[3], ctx, 0);
  assert.equal(end.length, 1);
  assert.equal(end[0].kind, 'turn_outcome');
  assert.equal(end[0].outcome, 'end_turn');
});

test('extractBehaviorEvents: Read tool → file_touch (read, exact)', () => {
  const entry: RawEntry = {
    type: 'assistant', uuid: 'r1',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'C:\\proj\\a.ts' } } as any] },
  };
  const evs = extractBehaviorEvents(entry, baseCtx(), 0);
  assert.equal(evs.length, 2);
  const ft = evs.find((e) => e.kind === 'file_touch')!;
  assert.equal(ft.accessMode, 'read');
  assert.equal(ft.argPath, 'C:\\proj\\a.ts');
  assert.equal(ft.argPathConfidence, 'exact');
});

test('extractBehaviorEvents: executed script → file_touch (executed) resolved via cwd', () => {
  const entry: RawEntry = {
    type: 'assistant', uuid: 'b1',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'node scripts/foo.js' } } as any] },
  };
  const evs = extractBehaviorEvents(entry, baseCtx({ workingDir: 'C:\\proj' }), 0);
  const ft = evs.find((e) => e.kind === 'file_touch');
  assert.ok(ft, 'expected an executed file_touch');
  assert.equal(ft!.accessMode, 'executed');
  assert.equal(ft!.argPathRaw, 'scripts/foo.js');
  assert.equal(ft!.argPath, 'C:\\proj\\scripts\\foo.js');
});

test('extractBehaviorEvents: two scripts in one Bash block → distinct event_ordinal', () => {
  const entry: RawEntry = {
    type: 'assistant', uuid: 'b2',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'python a.py && node b.js' } } as any] },
  };
  const evs = extractBehaviorEvents(entry, baseCtx({ workingDir: 'C:\\proj' }), 0);
  const touches = evs.filter((e) => e.kind === 'file_touch');
  assert.equal(touches.length, 2);
  assert.deepEqual(touches.map((t) => t.eventOrdinal).sort(), [0, 1]);
});

test('extractBehaviorEvents: npm run <name> → no file_touch, tool_use tagged commandFamily (pm-family patch)', () => {
  const entry: RawEntry = {
    type: 'assistant', uuid: 'b3',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm run build' } } as any] },
  };
  const evs = extractBehaviorEvents(entry, baseCtx({ workingDir: 'C:\\proj' }), 0);
  assert.equal(evs.filter((e) => e.kind === 'file_touch').length, 0);
  const tuEvt = evs.find((e) => e.kind === 'tool_use')!;
  assert.ok(tuEvt.commandFamily, 'expected commandFamily on the tool_use event');
});

// ─────────────────────────────────────────────────────────────────────────────
// A9 §3.2 — trigger snippet selection (walk-back)
// ─────────────────────────────────────────────────────────────────────────────
function priorsFrom(name: string, firstIdx: number): { priors: PriorUserEntry[]; entries: RawEntry[] } {
  const entries = loadFixture(name);
  const users = entries.filter((e) => e.type === 'user');
  const priors: PriorUserEntry[] = users.map((entry, i) => ({
    entry,
    entryUuid: entry.uuid!,
    byteOffset: i * 1000,
    tsMs: Date.parse(entry.timestamp ?? '2026-01-01T00:00:00Z'),
    isFirstSubstantiveUser: i === firstIdx,
  }));
  return { priors, entries };
}

test('selectTriggerSnippet: plain user query → user_message (supervisor lane)', () => {
  const { priors } = priorsFrom('trigger-user.jsonl', 0);
  const r = selectTriggerSnippet(priors, baseCtx({ lane: 'supervisor' }));
  assert.equal(r.selectionReason, 'matched');
  assert.equal(r.sourceKind, 'user_message');
  assert.equal(r.distanceEntries, 0);
  assert.equal(r.sourceEntryUuid, 'd90af019-ebf1-4056-a4b1-dca3f2015424');
  assert.ok(r.snippet && r.snippet.startsWith('i have on this computer'));
  assert.ok(r.snippetHash && r.snippetHash.length === 64);
  // long query → truncated with ellipsis
  assert.ok(r.snippet!.length <= TRIGGER_SNIPPET_MAX_CHARS + 1);
  assert.ok(r.snippet!.endsWith('…'));
});

test('selectTriggerSnippet: worker first turn → supervisor_brief', () => {
  const { priors } = priorsFrom('trigger-user.jsonl', 0);
  const r = selectTriggerSnippet(priors, baseCtx({ lane: 'worker' }));
  assert.equal(r.sourceKind, 'supervisor_brief');
});

test('selectTriggerSnippet: subagent first turn → subagent_brief', () => {
  const { priors } = priorsFrom('trigger-user.jsonl', 0);
  const r = selectTriggerSnippet(priors, baseCtx({ isSubagent: true, lane: 'researcher' }));
  assert.equal(r.sourceKind, 'subagent_brief');
});

test('selectTriggerSnippet: [DASHBOARD EVENT] turn skipped, walks back to brief', () => {
  const { priors } = priorsFrom('trigger-dashboard.jsonl', 0);
  const r = selectTriggerSnippet(priors, baseCtx({ lane: 'worker' }));
  assert.equal(r.selectionReason, 'matched');
  assert.equal(r.sourceEntryUuid, 'td-brief-0001');
  assert.equal(r.distanceEntries, 1);         // dashboard event at d=0 skipped
  assert.equal(r.sourceKind, 'supervisor_brief');
});

test('selectTriggerSnippet: isMeta + pure tool_result skipped, walks back to query', () => {
  const { priors } = priorsFrom('trigger-toolresult.jsonl', 0);
  const r = selectTriggerSnippet(priors, baseCtx({ lane: 'worker' }));
  assert.equal(r.selectionReason, 'matched');
  assert.equal(r.sourceEntryUuid, 'tr-query-0001');
  assert.equal(r.distanceEntries, 2);         // tool_result (d=0) + isMeta (d=1) skipped
});

test('selectTriggerSnippet: no qualifying user message → NULL row still written', () => {
  const dashboardOnly: RawEntry = {
    type: 'user', uuid: 'donly',
    message: { role: 'user', content: '[DASHBOARD EVENT] something happened\nmore telemetry' },
  };
  const priors: PriorUserEntry[] = [{ entry: dashboardOnly, entryUuid: 'donly', byteOffset: 0, tsMs: 0, isFirstSubstantiveUser: false }];
  const r = selectTriggerSnippet(priors, baseCtx());
  assert.equal(r.selectionReason, 'no_qualifying_user_message');
  assert.equal(r.sourceKind, 'none');
  assert.equal(r.snippet, null);
  assert.equal(r.snippetHash, null);
});

test('selectTriggerSnippet: <command-name>/deep-research + <command-args> → command_args snippet = the args (wp2b §7 #13)', () => {
  const slash: RawEntry = {
    type: 'user', uuid: 'cmd1',
    message: { role: 'user', content: '<command-name>/deep-research</command-name>\n<command-message>deep-research is running…</command-message>\n<command-args>WP2 token pricing across lanes</command-args>' },
  };
  const priors: PriorUserEntry[] = [{ entry: slash, entryUuid: 'cmd1', byteOffset: 0, tsMs: 0, isFirstSubstantiveUser: true }];
  const r = selectTriggerSnippet(priors, baseCtx({ lane: 'supervisor' }));
  assert.equal(r.selectionReason, 'matched');
  assert.equal(r.sourceKind, 'command_args', 'a slash-command turn is classified command_args, not user_message/brief');
  assert.equal(r.snippet, 'WP2 token pricing across lanes', 'snippet is the <command-args> payload, wrappers stripped');
  assert.ok(r.snippetHash && r.snippetHash.length === 64);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
