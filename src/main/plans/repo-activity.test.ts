// Fix-4 — pure repo-activity module tests (no I/O). Node-assert harness (matches
// build:main compiles it, then run the emitted JS:
//
//   npm run build:main
//   node dist/main/main/plans/repo-activity.test.js

import assert from 'node:assert/strict';
import type { FileActivity, RepoActivityEvidenceV1 } from '../../shared/types';
import {
  rollupRepoActivity,
  serializeRepoActivityEvidence,
  parseRepoActivityEvidence,
  formatRepoDigest,
  toTier2Digest,
  toTier3Detail,
  FILE_OPS,
  FILE_DETAIL_MAX,
  BLOB_BYTE_CAP,
} from './repo-activity';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const WIN = 'C:/Users/turke/Projects/AgentDashboard';
const WSL = '/home/edward/agentdashboard';

let seq = 0;
function fa(o: Partial<FileActivity> & { filePath: string; operation: FileActivity['operation'] }): FileActivity {
  return {
    id: ++seq,
    agentId: 'ag-1',
    filePath: o.filePath,
    operation: o.operation,
    timestamp: o.timestamp ?? '2026-07-09 12:00:00',
    generation: o.generation ?? 0,
    sessionId: o.sessionId ?? null,
    ...('id' in o ? { id: o.id! } : {}),
  };
}

const opts = (over: Partial<Parameters<typeof rollupRepoActivity>[1]> = {}) => ({
  sinceIso: '2026-07-09T12:00:00.000Z',
  untilIso: '2026-07-09T13:00:00.000Z',
  workspaceRoot: WIN,
  planRelPath: null as string | null,
  ...over,
});

// ── relativize ────────────────────────────────────────────────────────────────

test('relativize — Windows abs path under root → forward-slash relative', () => {
  const ev = rollupRepoActivity([fa({ filePath: 'C:\\Users\\turke\\Projects\\AgentDashboard\\src\\main\\index.ts', operation: 'write' })], opts());
  assert.equal(ev.files.items.length, 1);
  assert.equal(ev.files.items[0].path, 'src/main/index.ts');
  assert.equal(ev.files.items[0].outsideWorkspace, undefined);
});

test('relativize — WSL/POSIX abs path under a POSIX root → relative', () => {
  const ev = rollupRepoActivity([fa({ filePath: WSL + '/src/shared/types.ts', operation: 'read' })], opts({ workspaceRoot: WSL }));
  assert.equal(ev.files.items[0].path, 'src/shared/types.ts');
  assert.equal(ev.files.items[0].outsideWorkspace, undefined);
});

test('relativize — drive-letter case-insensitivity (c: vs C:)', () => {
  const ev = rollupRepoActivity([fa({ filePath: 'c:/users/turke/projects/agentdashboard/src/a.ts', operation: 'write' })], opts());
  // relative slice preserves the ORIGINAL casing of the tail
  assert.equal(ev.files.items[0].path, 'src/a.ts');
  assert.equal(ev.files.items[0].outsideWorkspace, undefined);
});

test('relativize — path outside root → outsideWorkspace:true, full path kept', () => {
  const ev = rollupRepoActivity([fa({ filePath: 'C:/OtherRepo/x.ts', operation: 'read' })], opts());
  assert.equal(ev.files.items[0].outsideWorkspace, true);
  assert.equal(ev.files.items[0].path, 'C:/OtherRepo/x.ts');
});

// ── exclusion ───────────────────────────────────────────────────────────────

test('exclusion — the plan file itself is dropped (provenance is plan_section_changes)', () => {
  const ev = rollupRepoActivity(
    [fa({ filePath: WIN + '/plans/my-plan.html', operation: 'write' }),
     fa({ filePath: WIN + '/src/x.ts', operation: 'write' })],
    opts({ planRelPath: 'plans/my-plan.html' }),
  );
  assert.deepEqual(ev.files.items.map((i) => i.path), ['src/x.ts']);
});

test('exclusion — .dashboard/** is dropped (worker infra noise)', () => {
  const ev = rollupRepoActivity(
    [fa({ filePath: WIN + '/.dashboard/workers/claude/behavioral.md', operation: 'write' }),
     fa({ filePath: WIN + '/.dashboard/research/inbox/note.md', operation: 'read' }),
     fa({ filePath: WIN + '/src/keep.ts', operation: 'write' })],
    opts(),
  );
  assert.deepEqual(ev.files.items.map((i) => i.path), ['src/keep.ts']);
});

test('exclusion — prefix is slash-anchored: `.dashboardfoo` is NOT excluded', () => {
  const ev = rollupRepoActivity([fa({ filePath: WIN + '/.dashboardfoo/x.ts', operation: 'write' })], opts());
  assert.equal(ev.files.items.length, 1);
  assert.equal(ev.files.items[0].path, '.dashboardfoo/x.ts');
});

// ── Fix rec-4 defensive: unresolved RELATIVE plan/.dashboard rows (legacy) ─────
// Ingress now canonicalizes paths to absolute, but a legacy/unresolved relative
// row still reaches rollup. `toRel` flags it `outside`; the defensive branch must
// still exclude plan/.dashboard so they never leak as outside-workspace evidence.

test('defensive — relative plan path (legacy row) is excluded, not surfaced as outside', () => {
  const ev = rollupRepoActivity(
    [fa({ filePath: 'plans/my-plan.html', operation: 'write' }),
     fa({ filePath: WIN + '/src/x.ts', operation: 'write' })],
    opts({ planRelPath: 'plans/my-plan.html' }),
  );
  assert.deepEqual(ev.files.items.map((i) => i.path), ['src/x.ts']);
});

test('defensive — relative .dashboard paths (incl. leading ./) are excluded', () => {
  const ev = rollupRepoActivity(
    [fa({ filePath: '.dashboard/state.json', operation: 'read' }),
     fa({ filePath: './.dashboard/workers/claude/behavioral.md', operation: 'write' }),
     fa({ filePath: '.dashboard\\research\\inbox\\n.md', operation: 'read' }), // backslash relative
     fa({ filePath: WIN + '/src/keep.ts', operation: 'write' })],
    opts(),
  );
  assert.deepEqual(ev.files.items.map((i) => i.path), ['src/keep.ts']);
});

test('defensive — a genuinely-outside ABSOLUTE path is still classified outside (not swept up)', () => {
  const ev = rollupRepoActivity([fa({ filePath: 'C:/OtherRepo/.dashboard/x.ts', operation: 'read' })], opts());
  assert.equal(ev.files.items.length, 1);
  assert.equal(ev.files.items[0].outsideWorkspace, true);
  assert.equal(ev.files.items[0].path, 'C:/OtherRepo/.dashboard/x.ts');
});

test('defensive — a NON-excluded relative path stays outside (unresolved, but kept as evidence)', () => {
  const ev = rollupRepoActivity([fa({ filePath: 'src/legacy.ts', operation: 'write' })], opts());
  assert.equal(ev.files.items.length, 1);
  assert.equal(ev.files.items[0].outsideWorkspace, true, 'unresolved relative → outside');
  assert.equal(ev.files.items[0].path, 'src/legacy.ts');
});

// ── fold ───────────────────────────────────────────────────────────────────

test('fold — same path read+write across rows → one item, ops union, counts summed', () => {
  const ev = rollupRepoActivity([
    fa({ filePath: WIN + '/src/a.ts', operation: 'read', timestamp: '2026-07-09 12:00:01' }),
    fa({ filePath: WIN + '/src/a.ts', operation: 'write', timestamp: '2026-07-09 12:00:05' }),
    fa({ filePath: WIN + '/src/a.ts', operation: 'read', timestamp: '2026-07-09 12:00:03' }),
  ], opts());
  assert.equal(ev.files.items.length, 1);
  const it = ev.files.items[0];
  assert.deepEqual(it.operations, ['read', 'write']);
  assert.deepEqual(it.counts, { read: 2, write: 1, create: 0 });
  assert.equal(it.firstAt, '2026-07-09T12:00:01.000Z');
  assert.equal(it.lastAt, '2026-07-09T12:00:05.000Z');
});

// ── totals honesty ───────────────────────────────────────────────────────────

test('totals — filesEdited counts distinct write-touched files, fileEvents sums every op', () => {
  const ev = rollupRepoActivity([
    fa({ filePath: WIN + '/src/a.ts', operation: 'write' }),
    fa({ filePath: WIN + '/src/a.ts', operation: 'write' }),  // same file, 2 write events
    fa({ filePath: WIN + '/src/b.ts', operation: 'read' }),
    fa({ filePath: WIN + '/src/c.ts', operation: 'create' }),
  ], opts());
  assert.equal(ev.totals.filesEdited, 1, 'one distinct write-touched file');
  assert.equal(ev.totals.filesRead, 1);
  assert.equal(ev.totals.filesCreated, 1);
  assert.equal(ev.totals.distinctFiles, 3);
  assert.equal(ev.totals.fileEvents, 4, 'every op counted');
  assert.equal(ev.totals.testsRun, 0);
  assert.equal(ev.totals.testsPassed, 0);
  assert.equal(ev.totals.testsFailed, 0);
});

// ── FILE_DETAIL_MAX ──────────────────────────────────────────────────────────

test('FILE_DETAIL_MAX — 250 files → items capped at 200, truncated, totals pre-cap, keeps most-recent', () => {
  const rows: FileActivity[] = [];
  for (let i = 0; i < 250; i++) {
    // lastAt increases with i so the highest-i files are most recent
    const secs = String(i % 60).padStart(2, '0');
    const mins = String(Math.floor(i / 60)).padStart(2, '0');
    rows.push(fa({ filePath: WIN + `/src/f${i}.ts`, operation: 'write', timestamp: `2026-07-09 12:${mins}:${secs}` }));
  }
  const ev = rollupRepoActivity(rows, opts());
  assert.equal(ev.files.items.length, FILE_DETAIL_MAX);
  assert.equal(ev.files.truncated, true);
  assert.equal(ev.totals.distinctFiles, 250, 'pre-cap total preserved');
  assert.equal(ev.totals.filesEdited, 250);
  // most-recent kept: f249 present, f0 dropped
  const paths = new Set(ev.files.items.map((i) => i.path));
  assert.ok(paths.has('src/f249.ts'), 'newest kept');
  assert.ok(!paths.has('src/f0.ts'), 'oldest dropped');
});

// ── byte cap ─────────────────────────────────────────────────────────────────

test('byte cap — multibyte paths pushing > 32KB → serialized byte length ≤ cap, totals intact', () => {
  const rows: FileActivity[] = [];
  // Each path ~400 multibyte bytes; ~120 of them blows past 32_768 bytes.
  const chunk = 'café/файл/日本語'.repeat(8); // multibyte, char-count << byte-count
  for (let i = 0; i < 120; i++) rows.push(fa({ filePath: WIN + `/src/${chunk}/f${i}.ts`, operation: 'write' }));
  const ev = rollupRepoActivity(rows, opts());
  const json = serializeRepoActivityEvidence(ev);
  assert.ok(Buffer.byteLength(json, 'utf8') <= BLOB_BYTE_CAP, `byte length ${Buffer.byteLength(json, 'utf8')} ≤ cap`);
  const parsed = JSON.parse(json) as RepoActivityEvidenceV1;
  assert.equal(parsed.files.truncated, true);
  assert.equal(parsed.totals.distinctFiles, 120, 'totals never truncated');
  assert.equal(parsed.totals.filesEdited, 120);
});

test('byte cap — char-count under cap but byte-count over: a json.length cap would under-count', () => {
  // Build a single evidence whose JSON has fewer CHARS than BLOB_BYTE_CAP but more BYTES.
  const rows: FileActivity[] = [];
  const multibyte = '日'.repeat(30); // 1 char = 3 bytes utf8
  for (let i = 0; i < 400; i++) rows.push(fa({ filePath: WIN + `/src/${multibyte}${i}.ts`, operation: 'read' }));
  const ev = rollupRepoActivity(rows, opts());
  const json = serializeRepoActivityEvidence(ev);
  assert.ok(Buffer.byteLength(json, 'utf8') <= BLOB_BYTE_CAP, 'byte length within cap');
});

test('byte cap — degenerate items→[] still returns valid JSON with intact totals', () => {
  // One monstrous path that alone exceeds the cap → items must shrink to [] and still be valid.
  const huge = 'x'.repeat(BLOB_BYTE_CAP * 2);
  const ev = rollupRepoActivity([fa({ filePath: WIN + '/src/' + huge + '.ts', operation: 'write' })], opts());
  const json = serializeRepoActivityEvidence(ev);
  const parsed = JSON.parse(json) as RepoActivityEvidenceV1; // must not throw
  assert.equal(parsed.files.items.length, 0);
  assert.equal(parsed.files.truncated, true);
  assert.equal(parsed.totals.filesEdited, 1, 'totals survive an empty items list');
});

// ── timestamp normalization ──────────────────────────────────────────────────

test('timestamp — datetime() format normalized to ISO …T…Z', () => {
  const ev = rollupRepoActivity([fa({ filePath: WIN + '/src/a.ts', operation: 'read', timestamp: '2026-07-09 12:34:56' })], opts());
  assert.equal(ev.files.items[0].firstAt, '2026-07-09T12:34:56.000Z');
  assert.equal(ev.files.items[0].lastAt, '2026-07-09T12:34:56.000Z');
});

test('timestamp — already-ISO passes through; unparseable kept verbatim', () => {
  const ev = rollupRepoActivity([
    fa({ filePath: WIN + '/src/a.ts', operation: 'read', timestamp: '2026-07-09T09:00:00.000Z' }),
    fa({ filePath: WIN + '/src/b.ts', operation: 'read', timestamp: 'not-a-date' }),
  ], opts());
  const byPath = new Map(ev.files.items.map((i) => [i.path, i]));
  assert.equal(byPath.get('src/a.ts')!.firstAt, '2026-07-09T09:00:00.000Z');
  assert.equal(byPath.get('src/b.ts')!.firstAt, 'not-a-date');
});

test('timestamp — sort order correct across mixed formats (most-recent first when capped)', () => {
  const ev = rollupRepoActivity([
    fa({ filePath: WIN + '/src/old.ts', operation: 'write', timestamp: '2026-07-09 08:00:00' }),
    fa({ filePath: WIN + '/src/new.ts', operation: 'write', timestamp: '2026-07-09T12:00:00.000Z' }),
  ], opts({ fileDetailMax: 1 }));
  assert.equal(ev.files.items.length, 1);
  assert.equal(ev.files.items[0].path, 'src/new.ts', 'most-recent survives the cap');
  assert.equal(ev.files.truncated, true);
});

// ── op guard ─────────────────────────────────────────────────────────────────

test('op guard — a row with an unknown operation is dropped, no NaN / stray keys', () => {
  const ev = rollupRepoActivity([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fa({ filePath: WIN + '/src/a.ts', operation: 'chmod' as any }),
    fa({ filePath: WIN + '/src/b.ts', operation: 'write' }),
  ], opts());
  assert.deepEqual(ev.files.items.map((i) => i.path), ['src/b.ts']);
  for (const it of ev.files.items) {
    assert.deepEqual(Object.keys(it.counts).sort(), ['create', 'read', 'write']);
    assert.ok(!Number.isNaN(it.counts.read + it.counts.write + it.counts.create));
  }
});

// ── parse tolerance ──────────────────────────────────────────────────────────

test('parse tolerance — null/empty/malformed/wrong-version/oversized → null', () => {
  assert.equal(parseRepoActivityEvidence(null), null);
  assert.equal(parseRepoActivityEvidence(undefined), null);
  assert.equal(parseRepoActivityEvidence(''), null);
  assert.equal(parseRepoActivityEvidence('{'), null);
  assert.equal(parseRepoActivityEvidence('{"schemaVersion":2}'), null);
  assert.equal(parseRepoActivityEvidence('x'.repeat(BLOB_BYTE_CAP * 2 + 1)), null, 'oversized guard');
});

test('parse tolerance — valid round-trip deep-equals', () => {
  const ev = rollupRepoActivity([fa({ filePath: WIN + '/src/a.ts', operation: 'write' })], opts());
  const round = parseRepoActivityEvidence(serializeRepoActivityEvidence(ev));
  assert.deepEqual(round, ev);
});

// ── digest wording ───────────────────────────────────────────────────────────

test('digest — all-zero totals → null', () => {
  const ev = rollupRepoActivity([], opts());
  assert.equal(formatRepoDigest(ev.totals), null);
  assert.equal(formatRepoDigest(null), null);
});

test('digest — edits only → "witnessed: 9 repo files edited"', () => {
  const totals = { filesRead: 0, filesEdited: 9, filesCreated: 0, fileEvents: 9, distinctFiles: 9, testsRun: 0, testsPassed: 0, testsFailed: 0 };
  assert.equal(formatRepoDigest(totals), 'witnessed: 9 repo files edited');
});

test('digest — mixed → "witnessed: 9 repo files edited; 2 created; 14 read"; no paths, no double space, no reserved clauses', () => {
  const totals = { filesRead: 14, filesEdited: 9, filesCreated: 2, fileEvents: 40, distinctFiles: 20, testsRun: 0, testsPassed: 0, testsFailed: 0 };
  const line = formatRepoDigest(totals)!;
  assert.equal(line, 'witnessed: 9 repo files edited; 2 created; 14 read');
  assert.ok(!line.includes('/'), 'no path substrings');
  assert.ok(!line.includes('  '), 'no double space');
  assert.ok(!/suites green|commit/.test(line), 'reserved tests/commit clause absent in cut 1');
});

// ── toTier2Digest ────────────────────────────────────────────────────────────

test('toTier2Digest — null evidence → not-captured, totals null, line null', () => {
  assert.deepEqual(toTier2Digest(null), { status: 'not-captured', totals: null, line: null });
});

test('toTier2Digest — captured-zero → captured, line null; captured-active → line set', () => {
  const zero = rollupRepoActivity([], opts());
  const d0 = toTier2Digest(zero);
  assert.equal(d0.status, 'captured');
  assert.equal(d0.line, null);
  assert.ok(d0.totals);

  const active = rollupRepoActivity([fa({ filePath: WIN + '/src/a.ts', operation: 'write' })], opts());
  const d1 = toTier2Digest(active);
  assert.equal(d1.status, 'captured');
  assert.equal(d1.line, 'witnessed: 1 repo files edited');
});

// ── toTier3Detail ────────────────────────────────────────────────────────────

test('toTier3Detail — shape carries planEventId + files + totals + window', () => {
  const ev = rollupRepoActivity([fa({ filePath: WIN + '/src/a.ts', operation: 'write' })], opts());
  const d = toTier3Detail('evt-123', ev);
  assert.equal(d.planEventId, 'evt-123');
  assert.deepEqual(d.files, ev.files);
  assert.deepEqual(d.totals, ev.totals);
  assert.deepEqual(d.window, ev.window);
});

// ── FILE_OPS drift pin (I-10) ────────────────────────────────────────────────

test('FILE_OPS — keys are exactly the FileOperation union', () => {
  assert.deepEqual(Object.keys(FILE_OPS).sort(), ['create', 'read', 'write']);
});

// ── Runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try {
    t.run();
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
