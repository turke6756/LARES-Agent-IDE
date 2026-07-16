// jsonl-scanner unit tests (P0.3) — pure core + the split-line fixture.
// Pure — system-Node runner (FROM WORKSPACE ROOT):
//   npm run build:main
//   node dist/main/main/skill-analytics/jsonl-scanner.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  normalizeStreamId,
  deriveStreamMeta,
  splitCompleteLines,
  computeFingerprint,
  rebuildDecision,
  readNewLines,
  type CursorState,
} from './jsonl-scanner';

const FIX = path.resolve(process.cwd(), 'src/main/skill-analytics/__fixtures__');
const SPLIT_DIR = path.join(FIX, 'split-line');
const STREAM = path.join(SPLIT_DIR, 'stream.jsonl');
const OFFSETS = JSON.parse(readFileSync(path.join(SPLIT_DIR, 'offsets.json'), 'utf8'));

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

// ── normalizeStreamId ──
test('normalizeStreamId: uppercase drive, backslashes', () => {
  assert.equal(normalizeStreamId('c:/Users/x/.claude/projects/s/a.jsonl'), 'C:\\Users\\x\\.claude\\projects\\s\\a.jsonl');
  assert.equal(normalizeStreamId('C:\\Users\\x\\a.jsonl'), 'C:\\Users\\x\\a.jsonl');
  // WSL UNC left structurally intact
  assert.equal(normalizeStreamId('\\\\wsl.localhost\\Ubuntu\\home\\me\\a.jsonl'), '\\\\wsl.localhost\\Ubuntu\\home\\me\\a.jsonl');
});

// ── deriveStreamMeta ──
test('deriveStreamMeta: top-level → session=stem, no subagent', () => {
  const proj = 'C:\\Users\\turke\\.claude\\projects';
  const p = 'C:\\Users\\turke\\.claude\\projects\\C--Users-turke\\8b3a378c-fc68-4bb6-9295-b04bee027448.jsonl';
  const m = deriveStreamMeta(p, proj);
  assert.equal(m.slug, 'C--Users-turke');
  assert.equal(m.sessionId, '8b3a378c-fc68-4bb6-9295-b04bee027448');
  assert.equal(m.subAgentName, null);
  assert.equal(m.parentSessionId, null);
  assert.equal(m.isSubagent, false);
  assert.equal(m.streamId, normalizeStreamId(p));
});

test('deriveStreamMeta: subagent → agent stem + parent session dir', () => {
  const proj = 'C:\\Users\\turke\\.claude\\projects';
  const p = 'C:\\Users\\turke\\.claude\\projects\\C--slug--dashboard-researcher\\78e964af-e4cc-4cb9-a4b3-53b282328023\\subagents\\agent-a067449b8feb2ebdd.jsonl';
  const m = deriveStreamMeta(p, proj);
  assert.equal(m.slug, 'C--slug--dashboard-researcher');
  assert.equal(m.subAgentName, 'agent-a067449b8feb2ebdd');
  assert.equal(m.parentSessionId, '78e964af-e4cc-4cb9-a4b3-53b282328023');
  assert.equal(m.sessionId, '78e964af-e4cc-4cb9-a4b3-53b282328023');
  assert.equal(m.isSubagent, true);
});

// ── splitCompleteLines: the partial-line cursor rule (byte-accurate) ──
test('splitCompleteLines: mid-line chunk yields only complete lines, fragment left unconsumed', () => {
  const buf = readFileSync(STREAM);
  // chunk boundary lands mid-line-2 (byte 1065 is within line 2 [693,1452])
  const chunk = buf.subarray(0, OFFSETS.midOfSecondLine);
  const { lines, nextOffset } = splitCompleteLines(chunk, 0);
  assert.equal(lines.length, 1, 'only the first (complete) line survives');
  assert.equal(nextOffset, OFFSETS.firstLineEnd, 'cursor advances only past line 1 \\n');
  assert.equal(lines[0].byteOffset, 0);
  assert.equal(JSON.parse(lines[0].text).uuid, '33caf188-6d56-4aa6-82fb-f48cb1ae9ca6');
});

test('splitCompleteLines: next pass from the advanced cursor reads the remaining lines', () => {
  const buf = readFileSync(STREAM);
  const { lines, nextOffset } = splitCompleteLines(buf.subarray(OFFSETS.firstLineEnd), OFFSETS.firstLineEnd);
  assert.equal(lines.length, 2);
  assert.equal(nextOffset, OFFSETS.totalBytes, 'trailing \\n → cursor at EOF');
  assert.equal(JSON.parse(lines[0].text).uuid, 'ee73d79a-f426-49e7-9621-d4fe7c4cccad');
  assert.equal(lines[0].byteOffset, OFFSETS.firstLineEnd);
  assert.equal(JSON.parse(lines[1].text).uuid, 'a6f88530-d1c2-42b7-833d-2bdd264b5e3d');
  assert.equal(lines[1].byteOffset, OFFSETS.secondLineEnd);
});

test('splitCompleteLines: no terminating newline → zero lines, cursor unmoved', () => {
  const buf = Buffer.from('{"partial":true} no newline here', 'utf8');
  const { lines, nextOffset } = splitCompleteLines(buf, 500);
  assert.equal(lines.length, 0);
  assert.equal(nextOffset, 500);
});

test('splitCompleteLines: CRLF trailing \\r is stripped from line text', () => {
  const buf = Buffer.from('{"a":1}\r\n{"b":2}\r\n', 'utf8');
  const { lines } = splitCompleteLines(buf, 0);
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0].text), { a: 1 });
  assert.deepEqual(JSON.parse(lines[1].text), { b: 2 });
});

// ── rebuildDecision ──
test('rebuildDecision: additive tail when nothing changed', () => {
  const cur: CursorState = { byteOffset: 100, firstFingerprint: 'abc', parserVersion: 1 };
  assert.equal(rebuildDecision(cur, 200, 'abc', 1), null);
});
test('rebuildDecision: truncation (size < offset)', () => {
  const cur: CursorState = { byteOffset: 300, firstFingerprint: 'abc', parserVersion: 1 };
  assert.equal(rebuildDecision(cur, 200, 'abc', 1), 'truncation');
});
test('rebuildDecision: fingerprint change (rotation / in-place rewrite)', () => {
  const cur: CursorState = { byteOffset: 100, firstFingerprint: 'abc', parserVersion: 1 };
  assert.equal(rebuildDecision(cur, 200, 'xyz', 1), 'fingerprint');
});
test('rebuildDecision: parser_version bump', () => {
  const cur: CursorState = { byteOffset: 100, firstFingerprint: 'abc', parserVersion: 1 };
  assert.equal(rebuildDecision(cur, 200, 'abc', 2), 'parser_version');
});
test('rebuildDecision: empty stored fingerprint never forces a rebuild on its own', () => {
  const cur: CursorState = { byteOffset: 100, firstFingerprint: '', parserVersion: 1 };
  assert.equal(rebuildDecision(cur, 200, 'abc', 1), null);
});

// ── readNewLines (FS, read-only, against the fixture) ──
test('readNewLines: full read from 0 yields all 3 lines + EOF cursor', () => {
  const r = readNewLines(STREAM, 0);
  assert.equal(r.lines.length, 3);
  assert.equal(r.sizeBytes, OFFSETS.totalBytes);
  assert.equal(r.nextOffset, OFFSETS.totalBytes);
  assert.ok(r.firstFingerprint.length === 16);
  assert.equal(computeFingerprint(r.lines[0].text), r.firstFingerprint);
});

test('readNewLines: additive tail from a mid-file cursor reads only the remainder', () => {
  const r = readNewLines(STREAM, OFFSETS.firstLineEnd);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].byteOffset, OFFSETS.firstLineEnd);
  assert.equal(r.nextOffset, OFFSETS.totalBytes);
});

test('readNewLines: cursor at EOF yields nothing (idempotent tail)', () => {
  const r = readNewLines(STREAM, OFFSETS.totalBytes);
  assert.equal(r.lines.length, 0);
  assert.equal(r.nextOffset, OFFSETS.totalBytes);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
