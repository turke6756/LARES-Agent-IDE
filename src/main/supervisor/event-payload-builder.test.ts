// Tests for event-payload-builder — focused on BUG-13 Path B Change 2:
// the `Last output:` block in supervisor events must be ANSI-stripped so
// Claude Code's grey ghost-text suggestions (cursor-save / write at input /
// cursor-restore) don't leak into the supervisor as phantom user input or
// raw escape sequences.
//
// Build + run:
//   npm run build:main
//   node dist/main/main/supervisor/event-payload-builder.test.js

import assert from 'node:assert/strict';
import {
  buildConsolidatedPayload,
  buildEventPayload,
  SupervisorEvent,
} from './event-payload-builder';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

function baseStatusEvent(overrides: Partial<SupervisorEvent> = {}): SupervisorEvent {
  return {
    type: 'status_change',
    agentId: '12345678-aaaa-bbbb-cccc-1234567890ab',
    agentTitle: 'demo-agent',
    workspaceId: 'ws-1',
    fromStatus: 'working',
    toStatus: 'idle',
    ...overrides,
  };
}

test('formatLogTail strips CSI/SGR escapes from each line', () => {
  // Real Claude Code-style colored output: green prompt prefix, bold body.
  const logTail = '\x1b[32m> running tests\x1b[0m\n\x1b[1mAll 5 passed\x1b[0m\n';
  const payload = buildEventPayload(baseStatusEvent({ logTail }));
  assert.ok(payload.includes('Last output:'), 'payload should include header');
  // No literal ESC bytes in the rendered output.
  assert.equal(payload.indexOf('\x1b'), -1, 'payload must not contain \\x1b bytes');
  // The legible content survives.
  assert.match(payload, /> running tests/);
  assert.match(payload, /All 5 passed/);
});

test('formatLogTail removes the isolated `❯ commit this` ghost-text line', () => {
  // Synthesized PTY tail combining a legitimate previous line with a ghost-
  // text redraw: cursor-save \x1b[s, grey color \x1b[2;90m, the suggestion
  // payload, then cursor-restore \x1b[u. Mirrors what Claude Code emits when
  // it renders an input suggestion in the idle prompt.
  const logTail = [
    'Last assistant turn complete.',
    '\x1b[s\x1b[2;90m❯ commit this\x1b[0m\x1b[u',
  ].join('\n');
  const payload = buildEventPayload(baseStatusEvent({ logTail }));
  // No raw escape bytes leak through.
  assert.equal(payload.indexOf('\x1b'), -1, 'payload must not contain ESC bytes');
  // The legitimate line is preserved.
  assert.match(payload, /> Last assistant turn complete\./);
  // The ghost-text line — `❯ commit this` after the cursor-restore lands
  // back to its original position — must not appear as a standalone `> ❯`
  // entry in the rendered output. After stripping, the line still contains
  // text, so it survives as a line; but it MUST NOT carry escape bytes and
  // must not appear as a bare `❯ ` (cursor-restore only) row.
  const ghostBareRow = payload.split('\n').find(l => l.trim() === '> ❯');
  assert.equal(ghostBareRow, undefined, 'no bare `> ❯` cursor-only line');
});

test('formatLogTail drops lines that are pure whitespace after stripping', () => {
  // Cursor-restore-only sequence: nothing visible after strip.
  const logTail = [
    'real line 1',
    '\x1b[s\x1b[u',
    'real line 2',
    '\x1b[2K\x1b[?25h', // erase line + show cursor — empty after strip
  ].join('\n');
  const payload = buildEventPayload(baseStatusEvent({ logTail }));
  const block = payload.split('Last output:\n')[1] ?? '';
  // The two empty-after-strip lines must NOT produce blank `>` rows.
  const blankPrefixRows = block.split('\n').filter(l => l === '>' || l === '> ');
  assert.equal(blankPrefixRows.length, 0, 'no blank `>` prefix rows');
  assert.match(payload, /> real line 1/);
  assert.match(payload, /> real line 2/);
});

test('formatLogTail omits the Last output: block when everything strips to empty', () => {
  const logTail = '\x1b[s\x1b[u\n\x1b[2K\n'; // cursor-restore + erase-line only
  const payload = buildEventPayload(baseStatusEvent({ logTail }));
  assert.equal(payload.indexOf('Last output:'), -1, 'no Last output header for empty-after-strip tail');
});

test('formatLogTail caps at maxLines AFTER stripping', () => {
  // 10 visible lines + a noise line that should not count toward the cap.
  const lines: string[] = [];
  for (let i = 1; i <= 10; i++) lines.push(`line ${i}`);
  lines.push('\x1b[s\x1b[u'); // noise: empty after strip, must not push real lines out of the cap
  const logTail = lines.join('\n');
  const payload = buildEventPayload(baseStatusEvent({ logTail }));
  const block = payload.split('Last output:\n')[1] ?? '';
  const visible = block.split('\n').filter(l => l.startsWith('> '));
  // maxLines for status_change is 5 — only the trailing 5 real lines survive.
  assert.equal(visible.length, 5);
  assert.match(visible[0], /> line 6/);
  assert.match(visible[4], /> line 10/);
});

test('formatLogTail keeps colored output legible (smoke)', () => {
  const logTail = '\x1b[31m✗ test failed at line 42\x1b[0m';
  const payload = buildEventPayload(baseStatusEvent({ logTail }));
  assert.match(payload, /> ✗ test failed at line 42/);
  assert.equal(payload.indexOf('\x1b'), -1);
});

// ── BUG-20: chat-first preview + Files touched section ─────────────────

test('BUG-20: lastAssistantMessage replaces logTail when present (no TUI chrome)', () => {
  // Real-world shape: PTY tail contains Claude Code TUI footer chrome only;
  // lastAssistantMessage holds the clean assistant prose. Builder must prefer
  // the latter.
  const logTail = [
    'Opus 4.7 (1M context) | C:\\foo\\bar | Style: default',
    '⏵⏵ bypass permissions on (shift+tab to cycle)',
    '─'.repeat(40),
    'running stop hook · 6s · ↓325 tokens',
  ].join('\n');
  const payload = buildEventPayload(baseStatusEvent({
    logTail,
    lastAssistantMessage: 'I read the file and updated the bug entry. Want me to commit?',
  }));
  assert.match(payload, /Last output:/, 'BUG-20: header present');
  assert.match(
    payload,
    /> I read the file and updated the bug entry\. Want me to commit\?/,
    'BUG-20: real assistant prose rendered',
  );
  assert.equal(payload.indexOf('⏵⏵'), -1, 'BUG-20: TUI permission ribbon must not leak');
  assert.equal(payload.indexOf('Opus 4.7'), -1, 'BUG-20: TUI status bar must not leak');
  assert.equal(payload.indexOf('running stop hook'), -1, 'BUG-20: hook spinner must not leak');
});

test('BUG-20: falls back to logTail when lastAssistantMessage is undefined', () => {
  // Codex / Gemini early-bootstrap path: no parsed chat yet, PTY tail is the
  // only source. Builder must use it.
  const payload = buildEventPayload(baseStatusEvent({
    logTail: 'real PTY line A\nreal PTY line B',
    // lastAssistantMessage intentionally omitted
  }));
  assert.match(payload, /> real PTY line A/, 'BUG-20: logTail fallback line A');
  assert.match(payload, /> real PTY line B/, 'BUG-20: logTail fallback line B');
});

test('BUG-20: falls back to logTail when lastAssistantMessage is empty/whitespace', () => {
  // Defensive: a chat service returning '' or '   ' must not produce a
  // header-only "Last output:" block with no content.
  for (const empty of ['', '   ', '\n  \n']) {
    const payload = buildEventPayload(baseStatusEvent({
      logTail: 'real PTY line',
      lastAssistantMessage: empty,
    }));
    assert.match(payload, /> real PTY line/, `BUG-20: empty='${JSON.stringify(empty)}' should fall back`);
  }
});

// ── Turn-end full output: working → idle carries the whole message ──────

test('turn-end: working → idle renders the FULL message past 10 lines (no preview cap)', () => {
  // The worker's closing ask lives at the END of its last message — the old
  // head-truncation cut it off. working → idle must deliver everything.
  const msg = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n')
    + '\nShould I commit this, or do you want to review first?';
  const payload = buildEventPayload(baseStatusEvent({ lastAssistantMessage: msg }));
  assert.match(payload, /> line 1\n/, 'first line kept');
  assert.match(payload, /> line 25\n/, '25th line kept (beyond old 10-line cap)');
  assert.match(
    payload,
    /> Should I commit this, or do you want to review first\?/,
    'closing question survives',
  );
  assert.doesNotMatch(payload, /\n> …$/, 'no truncation marker on full render');
});

test('turn-end: safety ceiling truncates the MIDDLE, head and tail both survive', () => {
  const head = 'HEADLINE: patch summary follows.';
  const tail = 'FINAL ASK: apply to staging now or review the SQL first?';
  const msg = head + '\n' + 'B'.repeat(20000) + '\n' + tail;
  const payload = buildEventPayload(baseStatusEvent({ lastAssistantMessage: msg }));
  assert.match(payload, /> HEADLINE: patch summary follows\./, 'head survives');
  assert.match(
    payload,
    /> FINAL ASK: apply to staging now or review the SQL first\?/,
    'tail (the ask) survives',
  );
  assert.match(payload, /chars omitted/, 'middle-omission marker present');
  const block = payload.split('Last output:\n')[1] ?? '';
  const bCount = (block.match(/B/g) ?? []).length;
  assert.ok(bCount < 6000, `filler bounded by safety ceiling, got ${bCount}`);
});

test('non-turn-end: compact preview caps still apply (crashed keeps 10 lines)', () => {
  const msg = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');
  const payload = buildEventPayload(baseStatusEvent({
    toStatus: 'crashed',
    lastAssistantMessage: msg,
  }));
  assert.match(payload, /> line 1\n/, 'first line kept');
  assert.match(payload, /> line 10\n/, '10th line kept');
  assert.equal(payload.indexOf('> line 11'), -1, '11th line dropped');
  assert.match(payload, /\n> …/, 'truncation marker present');
});

test('non-turn-end: compact preview caps still apply (crashed keeps 800 chars)', () => {
  const msg = 'A'.repeat(2000); // single long line
  const payload = buildEventPayload(baseStatusEvent({
    toStatus: 'crashed',
    lastAssistantMessage: msg,
  }));
  // body lines under "Last output:" should hold at most ~800 chars of As.
  const block = payload.split('Last output:\n')[1] ?? '';
  const aCount = (block.match(/A/g) ?? []).length;
  assert.ok(aCount <= 800, `chars capped at 800, got ${aCount}`);
  assert.ok(aCount >= 700, `capped near 800, not below; got ${aCount}`);
  assert.match(payload, /> …/, 'truncation marker present');
});

test('non-turn-end: waiting → idle keeps the compact preview', () => {
  const msg = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');
  const payload = buildEventPayload(baseStatusEvent({
    fromStatus: 'waiting',
    lastAssistantMessage: msg,
  }));
  assert.equal(payload.indexOf('> line 11'), -1, '11th line dropped for waiting → idle');
  assert.match(payload, /\n> …/, 'truncation marker present');
});

test('BUG-20: filesTouched section renders one row per file', () => {
  const payload = buildEventPayload(baseStatusEvent({
    lastAssistantMessage: 'done',
    filesTouched: [
      { filePath: 'src/foo.ts', operation: 'write' },
      { filePath: 'src/bar.ts', operation: 'read' },
    ],
  }));
  assert.match(payload, /Files touched in current session:/);
  assert.doesNotMatch(payload, /\nFiles touched:\n/,
    'F3: the ambiguous retained-vs-current heading cannot render');
  assert.match(payload, /> src\/foo\.ts \(write\)/);
  assert.match(payload, /> src\/bar\.ts \(read\)/);
});

test('BUG-20: filesTouched section omitted when undefined or empty', () => {
  for (const filesTouched of [undefined, []] as SupervisorEvent['filesTouched'][]) {
    const payload = buildEventPayload(baseStatusEvent({
      lastAssistantMessage: 'done',
      filesTouched,
    }));
    assert.equal(payload.indexOf('Files touched in current session:'), -1,
      `BUG-20: empty/undefined filesTouched must omit section (input: ${JSON.stringify(filesTouched)})`);
  }
});

test('BUG-20: filesTouched capped at 10 entries with overflow marker', () => {
  const filesTouched: SupervisorEvent['filesTouched'] = Array.from(
    { length: 15 },
    (_, i) => ({ filePath: `src/f${i + 1}.ts`, operation: 'write' as const }),
  );
  const payload = buildEventPayload(baseStatusEvent({
    lastAssistantMessage: 'done',
    filesTouched,
  }));
  // 10 shown, 5 hidden.
  for (let i = 1; i <= 10; i++) {
    assert.match(payload, new RegExp(`> src/f${i}\\.ts \\(write\\)`), `f${i} kept`);
  }
  assert.equal(payload.indexOf('src/f11.ts'), -1, 'f11 dropped');
  assert.match(payload, /> … \(5 more\)/, 'overflow marker shows hidden count');
});

test('BUG-20: filesTouched section appears AFTER Last output (not before)', () => {
  const payload = buildEventPayload(baseStatusEvent({
    lastAssistantMessage: 'all done',
    filesTouched: [{ filePath: 'a.ts', operation: 'write' }],
  }));
  const lastIdx = payload.indexOf('Last output:');
  const filesIdx = payload.indexOf('Files touched in current session:');
  assert.ok(lastIdx >= 0 && filesIdx > lastIdx, 'order: Last output → Files touched');
});

test('BUG-20: consolidated payload includes short hint from lastAssistantMessage', () => {
  const e1: SupervisorEvent = {
    type: 'status_change',
    agentId: 'aaaa1111-...........',
    agentTitle: 'agent-A',
    workspaceId: 'ws-1',
    fromStatus: 'working',
    toStatus: 'idle',
    lastAssistantMessage: 'Migration applied cleanly. Want me to push the branch?',
  };
  const e2: SupervisorEvent = {
    type: 'status_change',
    agentId: 'bbbb2222-...........',
    agentTitle: 'agent-B',
    workspaceId: 'ws-1',
    fromStatus: 'working',
    toStatus: 'idle',
    // no lastAssistantMessage — line stays terse
  };
  const payload = buildConsolidatedPayload([e1, e2]);
  assert.match(
    payload,
    /agent-A.*— "Migration applied cleanly\. Want me to push the branch\?"/,
    'BUG-20: e1 has hint',
  );
  assert.doesNotMatch(payload, /agent-B.*—/, 'BUG-20: e2 (no chat) has no hint suffix');
});

test('BUG-20: consolidated hint capped at 80 chars with ellipsis', () => {
  const long = 'X'.repeat(200);
  const e: SupervisorEvent = {
    type: 'status_change',
    agentId: 'aaaa1111-...........',
    agentTitle: 'agent-A',
    workspaceId: 'ws-1',
    fromStatus: 'working',
    toStatus: 'idle',
    lastAssistantMessage: long,
  };
  const e2: SupervisorEvent = { ...e, agentId: 'bbbb2222-..........', agentTitle: 'agent-B' };
  const payload = buildConsolidatedPayload([e, e2]);
  const line = payload.split('\n').find(l => l.startsWith('- "agent-A"'));
  assert.ok(line, 'agent-A line present');
  // The quoted hint must be at most 80 chars long (including the trailing …).
  const m = line!.match(/— "([^"]+)"/);
  assert.ok(m, 'hint substring present');
  assert.ok(m![1].length <= 80, `hint capped at 80, got ${m![1].length}`);
  assert.match(m![1], /…$/, 'hint ends with …');
});

// ── BUG-22 Step 1: tmux_new_session_failed payload variant ─────────────

test('BUG-22: tmux_new_session_failed payload uses a distinct dashboard header', () => {
  const payload = buildEventPayload({
    type: 'tmux_new_session_failed',
    agentId: '2e11bfc6-aaaa-bbbb-cccc-ddddeeeeffff',
    agentTitle: 'Supervisor',
    workspaceId: 'ws-1',
    tmuxSessionName: 'cad__supervisor__2e11bfc6',
    command: "cd '/home/turke/proj' && claude --add-dir '/foo'",
    tmuxExitCode: 1,
    tmuxStderr: 'bash: syntax error',
    tmuxCommand: "tmux new-session -d ...",
  });
  // Must NOT be confused with a generic status change.
  assert.ok(
    payload.startsWith('[DASHBOARD EVENT] WSL tmux session creation failed'),
    `expected distinct WSL-tmux header; got: ${payload.slice(0, 80)}`,
  );
  assert.equal(
    payload.indexOf('[DASHBOARD EVENT] Agent status changed'), -1,
    'must not include the generic status-change header',
  );
});

test('BUG-22: tmux_new_session_failed payload includes session/exit/stderr/command', () => {
  const payload = buildEventPayload({
    type: 'tmux_new_session_failed',
    agentId: '2e11bfc6',
    agentTitle: 'Supervisor',
    workspaceId: 'ws-1',
    tmuxSessionName: 'cad__supervisor__2e11bfc6',
    command: "cd '/wd' && claude --foo",
    tmuxExitCode: 1,
    tmuxStderr: 'permission denied',
    tmuxCommand: 'tmux new-session ...',
  });
  assert.match(payload, /cad__supervisor__2e11bfc6/);
  assert.match(payload, /tmux exit code: 1/);
  assert.match(payload, /permission denied/);
  assert.match(payload, /cd '\/wd' && claude --foo/);
});

test('BUG-22: tmux_new_session_failed payload renders "(empty)" for blank stderr', () => {
  const payload = buildEventPayload({
    type: 'tmux_new_session_failed',
    agentId: '2e11bfc6',
    agentTitle: 'Supervisor',
    workspaceId: 'ws-1',
    tmuxSessionName: 's',
    command: 'cmd',
    tmuxExitCode: 1,
    tmuxStderr: '',
    tmuxCommand: 't',
  });
  assert.match(payload, /stderr:\n\(empty\)/);
});

test('BUG-22: tmux_new_session_failed appears in consolidated digest as a distinct line', () => {
  const payload = buildConsolidatedPayload([
    {
      type: 'tmux_new_session_failed',
      agentId: '2e11bfc6',
      agentTitle: 'Supervisor',
      workspaceId: 'ws-1',
      tmuxSessionName: 's',
      command: 'cmd',
      tmuxExitCode: 1,
      tmuxStderr: 'x',
      tmuxCommand: 't',
    },
    {
      type: 'status_change',
      agentId: '11111111',
      agentTitle: 'OtherWorker',
      workspaceId: 'ws-1',
      fromStatus: 'working',
      toStatus: 'idle',
    },
  ]);
  assert.match(payload, /WSL tmux session creation failed/);
  assert.match(payload, /OtherWorker.*working → idle/);
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ok  ${t.name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${t.name}`);
    console.error(err);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
