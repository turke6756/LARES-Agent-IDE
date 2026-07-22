// behavior-sequences.test.ts — WP9 (G9) sequence/co-touch + command-family
// association + pinned identity, against the REAL database.ts DDL via the sql.js
// better-sqlite3 stand-in (same pattern as optimizer-pipeline-seams.test.ts).
// Each test group runs on a FRESH database (the database module is re-required)
// so top-k / min-support assertions can be exact.
//
//   npm run build:main
//   node dist/main/main/context-optimizer/behavior-sequences.test.js

import assert from 'node:assert/strict';

// ── sql.js-backed better-sqlite3 stand-in (named + positional params) ──────────
let SQLCtor: { new (): SqlJsDatabase };
interface SqlJsStatement { bind(p: unknown): boolean; step(): boolean; getAsObject(): Record<string, unknown>; free(): boolean; }
interface SqlJsDatabase { run(sql: string, params?: unknown): unknown; prepare(sql: string): SqlJsStatement; getRowsModified(): number; }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v);
}
function toBind(args: unknown[]): unknown {
  if (args.length === 1 && isPlainObject(args[0])) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args[0])) o['@' + k] = v === undefined ? null : v;
    return o;
  }
  return args.map((v) => (v === undefined ? null : v));
}
class FakeDb {
  private db: SqlJsDatabase;
  constructor() { this.db = new SQLCtor(); }
  pragma(): void { /* no-op */ }
  exec(sql: string): this { this.db.run(sql); return this; }
  prepare(sql: string) {
    const inner = this.db;
    return {
      run: (...args: unknown[]) => { inner.run(sql, toBind(args)); return { changes: inner.getRowsModified() }; },
      get: (...args: unknown[]) => {
        const s = inner.prepare(sql);
        try { s.bind(toBind(args)); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); }
      },
      all: (...args: unknown[]) => {
        const s = inner.prepare(sql);
        try {
          s.bind(toBind(args));
          const rows: Record<string, unknown>[] = [];
          while (s.step()) rows.push(s.getAsObject());
          return rows;
        } finally { s.free(); }
      },
    };
  }
  transaction<A extends unknown[]>(fn: (...a: A) => unknown) {
    return (...a: A) => {
      this.db.run('BEGIN');
      try { const r = fn(...a); this.db.run('COMMIT'); return r; }
      catch (e) { this.db.run('ROLLBACK'); throw e; }
    };
  }
}

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

type DbMod = { initDatabase(): void; getDb(): FakeDb };
let dbm: DbMod;
let seq: typeof import('./behavior-sequences');
let ident: typeof import('./stream-identity');
let draft: typeof import('./recommendation-draft');

/** Re-require the database module so every test group gets a FRESH db built by
 *  the REAL initDatabase() DDL (exact top-k / support counts need isolation). */
function freshDb(): FakeDb {
  const resolved = require.resolve('../database');
  delete require.cache[resolved];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as unknown as DbMod;
  dbm.initDatabase();
  return dbm.getDb();
}

// ── row insert helpers ─────────────────────────────────────────────────────────
let evtSeq = 0;
interface EvOpts {
  stream: string; ts: number;
  id?: string; bo?: number; bi?: number; eo?: number;
  kind?: string; entry?: string | null;
  path?: string | null; access?: string | null;
  family?: string | null; session?: string | null;
}
function ev(o: EvOpts): void {
  dbm.getDb().prepare(
    `INSERT INTO behavior_events
       (id, stream_id, entry_uuid, block_index, byte_offset, ts_ms, session_id, kind,
        command_family, arg_path, access_mode, event_ordinal, observable)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    o.id ?? `e${evtSeq++}`, o.stream, o.entry ?? null, o.bi ?? 0, o.bo ?? evtSeq * 10,
    o.ts, o.session ?? null, o.kind ?? 'file_touch',
    o.family ?? null, o.path ?? null, o.access ?? 'read', o.eo ?? 0,
  );
}
/** A non-touch behavior event (any-kind window filler). */
function filler(stream: string, ts: number, n = 1): void {
  for (let i = 0; i < n; i++) ev({ stream, ts: ts + i, kind: 'tool_use', path: null, access: null });
}
function agentRow(id: string, workspaceId = 'ws-1'): void {
  dbm.getDb().prepare(
    `INSERT INTO agents (id, workspace_id, title, slug, working_directory, command)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, workspaceId, id, id, '/w', 'claude');
}
function sessionRow(sessionId: string, agentId: string, generation = 1): void {
  dbm.getDb().prepare(
    `INSERT INTO agent_sessions (dashboard_agent_id, generation, session_id, working_directory, provider)
     VALUES (?, ?, ?, ?, 'claude')`,
  ).run(agentId, generation, sessionId, '/w');
}

const GEN = 'gen-test-1';
function build(): import('./behavior-sequences').FileSequencesV1 {
  return seq.buildFileSequences(
    dbm.getDb() as unknown as import('./behavior-store').QueryDb, { generationId: GEN });
}

// ── op mapping (reused, not reinvented) ────────────────────────────────────────

test('classifyAccessOp mirrors the file-coverage mapping exactly (executed/write/else-read)', () => {
  assert.equal(seq.classifyAccessOp('executed'), 'execute');
  assert.equal(seq.classifyAccessOp('write'), 'write');
  assert.equal(seq.classifyAccessOp('read'), 'read');
  assert.equal(seq.classifyAccessOp(null), 'read');
  assert.equal(seq.classifyAccessOp('anything-else'), 'read');
});

test('aggregateFileTouches (optimizer-pipeline) and classifyAccessOp agree on every mode', () => {
  // The pipeline's rollup is THE historical mapping; the extracted classifier
  // must bucket identically for every access mode the store can carry.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pipeline = require('./optimizer-pipeline') as typeof import('./optimizer-pipeline');
  const modes: Array<string | null> = ['executed', 'write', 'read', null, 'weird'];
  const rows = modes.map((m, i) => ({
    streamId: `s${i}`, tsMs: i, path: '/same.ts', lane: 'worker' as const,
    subAgentName: null, accessMode: m, argPathConfidence: 'exact',
  }));
  const [rolled] = pipeline.aggregateFileTouches(rows);
  const expected = { execute: 0, write: 0, read: 0 };
  for (const m of modes) expected[seq.classifyAccessOp(m)]++;
  assert.deepEqual(
    [rolled.executes, rolled.writes, rolled.reads],
    [expected.execute, expected.write, expected.read]);
});

// ── ordering incl. tiebreak columns ────────────────────────────────────────────

test('event ordering applies the full (ts_ms, byte_offset, block_index, event_ordinal, id) tuple', () => {
  freshDb();
  // Each tiebreak pair is ISOLATED by >5 filler events, so exactly one
  // predecessor edge exists per pair (4 total — far below top-k, no lex cut).
  for (const s of ['o1', 'o2', 'o3']) {
    // Same ts: byte_offset decides — /a (bo 5) BEFORE /b (bo 9), inserted b-first.
    ev({ stream: s, ts: 100, bo: 9, path: '/tie/b', entry: 'e1' });
    ev({ stream: s, ts: 100, bo: 5, path: '/tie/a', entry: 'e2' });
    filler(s, 110, 6);
    // Same ts+bo: block_index decides — /c (bi 0) BEFORE /d (bi 1).
    ev({ stream: s, ts: 200, bo: 20, bi: 1, path: '/tie/d', entry: 'e3' });
    ev({ stream: s, ts: 200, bo: 20, bi: 0, path: '/tie/c', entry: 'e4' });
    filler(s, 210, 6);
    // Same ts+bo+bi: event_ordinal decides — /e (eo 0) BEFORE /f (eo 1).
    ev({ stream: s, ts: 300, bo: 30, bi: 0, eo: 1, path: '/tie/f', entry: 'e5' });
    ev({ stream: s, ts: 300, bo: 30, bi: 0, eo: 0, path: '/tie/e', entry: 'e6' });
    filler(s, 310, 6);
    // Same everything: id decides — /g (id …a) BEFORE /h (id …b).
    ev({ stream: s, ts: 400, bo: 40, bi: 0, eo: 0, id: `${s}-zb`, path: '/tie/h', entry: 'e7' });
    ev({ stream: s, ts: 400, bo: 40, bi: 0, eo: 0, id: `${s}-za`, path: '/tie/g', entry: 'e8' });
  }
  const out = build();
  const edge = (p: string, pre: string) =>
    out.predecessors.some((e) => e.path === p && e.predecessorPath === pre);
  assert.ok(edge('/tie/b', '/tie/a'), 'byte_offset tiebreak: a precedes b');
  assert.ok(!edge('/tie/a', '/tie/b'), 'no reversed edge for byte_offset pair');
  assert.ok(edge('/tie/d', '/tie/c'), 'block_index tiebreak: c precedes d');
  assert.ok(!edge('/tie/c', '/tie/d'), 'no reversed edge for block_index pair');
  assert.ok(edge('/tie/f', '/tie/e'), 'event_ordinal tiebreak: e precedes f');
  assert.ok(!edge('/tie/e', '/tie/f'), 'no reversed edge for event_ordinal pair');
  assert.ok(edge('/tie/h', '/tie/g'), 'id tiebreak: g precedes h');
  assert.ok(!edge('/tie/g', '/tie/h'), 'no reversed edge for id pair');
});

// ── entry_uuid dedup ───────────────────────────────────────────────────────────

test('consecutive same-op same-path touches within ONE entry_uuid collapse to one', () => {
  freshDb();
  for (const s of ['d1', 'd2', 'd3']) {
    ev({ stream: s, ts: 10, path: '/dup', access: 'read', entry: 'E' });
    ev({ stream: s, ts: 11, path: '/dup', access: 'read', entry: 'E' });
    ev({ stream: s, ts: 12, path: '/dup', access: 'read', entry: 'E' });
    ev({ stream: s, ts: 13, path: '/other', access: 'read', entry: 'E' });
  }
  const out = build();
  const pair = out.coTouch.find((p) => p.pathA === '/dup' && p.pathB === '/other');
  assert.ok(pair, 'pair present');
  assert.equal(pair!.streamsSupporting, 3);
  assert.equal(pair!.occurrences, 3, 'ONE deduped /dup touch per stream → 1 pair × 3 streams');
});

test('same path+op consecutive across DIFFERENT entry_uuids does NOT collapse', () => {
  freshDb();
  for (const s of ['d4', 'd5', 'd6']) {
    ev({ stream: s, ts: 10, path: '/dup2', access: 'read', entry: 'E1' });
    ev({ stream: s, ts: 11, path: '/dup2', access: 'read', entry: 'E2' });
    ev({ stream: s, ts: 12, path: '/other2', access: 'read', entry: 'E2' });
  }
  const out = build();
  const pair = out.coTouch.find((p) => p.pathA === '/dup2' && p.pathB === '/other2');
  assert.equal(pair!.occurrences, 6, 'both /dup2 touches kept → 2 pairs × 3 streams');
});

test('same path DIFFERENT op within one entry_uuid does NOT collapse', () => {
  freshDb();
  for (const s of ['d7', 'd8', 'd9']) {
    ev({ stream: s, ts: 10, path: '/dup3', access: 'read', entry: 'E' });
    ev({ stream: s, ts: 11, path: '/dup3', access: 'write', entry: 'E' });
    ev({ stream: s, ts: 12, path: '/other3', access: 'read', entry: 'E' });
  }
  const out = build();
  const pair = out.coTouch.find((p) => p.pathA === '/dup3' && p.pathB === '/other3');
  assert.equal(pair!.occurrences, 6, 'read+write both kept → 2 pairs × 3 streams');
});

// ── ±10 any-kind window composition ────────────────────────────────────────────

test('co-touch window is ±10 behavior events OF ANY KIND: distance 10 in, 11 out', () => {
  freshDb();
  for (const s of ['w1', 'w2', 'w3']) {
    // 9 intervening non-touch events → index distance 10 → qualifies.
    ev({ stream: s, ts: 100, path: '/win/in-a' });
    filler(s, 101, 9);
    ev({ stream: s, ts: 120, path: '/win/in-b' });
    // Isolate the next cluster (>10 events away from everything above).
    filler(s, 200, 12);
    // 10 intervening non-touch events → index distance 11 → does NOT qualify.
    ev({ stream: s, ts: 300, path: '/win/out-a' });
    filler(s, 301, 10);
    ev({ stream: s, ts: 330, path: '/win/out-b' });
  }
  const out = build();
  assert.ok(
    out.coTouch.some((p) => p.pathA === '/win/in-a' && p.pathB === '/win/in-b'),
    'distance-10 pair (through any-kind events) counted');
  assert.ok(
    !out.coTouch.some((p) => p.pathA === '/win/out-a' && p.pathB === '/win/out-b'),
    'distance-11 pair not counted');
  assert.equal(out.metadata.coTouchWindowEvents, 10);
  assert.equal(out.metadata.coTouchWindowEventKinds, 'any-behavior-event', 'window kind stated in metadata');
});

// ── min support ────────────────────────────────────────────────────────────────

test('min support: pair in 3 streams survives, pair in 2 streams does not', () => {
  freshDb();
  for (const s of ['m1', 'm2', 'm3']) {
    ev({ stream: s, ts: 10, path: '/sup/a' });
    ev({ stream: s, ts: 11, path: '/sup/b' });
  }
  for (const s of ['m1', 'm2']) {
    filler(s, 100, 12);
    ev({ stream: s, ts: 200, path: '/sup/c' });
    ev({ stream: s, ts: 201, path: '/sup/d' });
  }
  const out = build();
  assert.ok(out.coTouch.some((p) => p.pathA === '/sup/a' && p.pathB === '/sup/b'), '3-stream pair present');
  assert.ok(!out.coTouch.some((p) => p.pathA === '/sup/c' && p.pathB === '/sup/d'), '2-stream pair absent');
});

// ── predecessor distance ≤5 ────────────────────────────────────────────────────

test('predecessor edges require distance ≤5 events (6 is out)', () => {
  freshDb();
  for (const s of ['p1', 'p2', 'p3']) {
    // 4 intervening events → distance 5 → qualifies.
    ev({ stream: s, ts: 10, path: '/pred/a' });
    filler(s, 11, 4);
    ev({ stream: s, ts: 20, path: '/pred/b' });
    filler(s, 100, 12);
    // 5 intervening events → distance 6 → out (but still within co-touch ±10).
    ev({ stream: s, ts: 300, path: '/pred/c' });
    filler(s, 301, 5);
    ev({ stream: s, ts: 320, path: '/pred/d' });
  }
  const out = build();
  assert.ok(
    out.predecessors.some((e) => e.path === '/pred/b' && e.predecessorPath === '/pred/a'),
    'distance-5 predecessor counted');
  assert.ok(
    !out.predecessors.some((e) => e.path === '/pred/d' && e.predecessorPath === '/pred/c'),
    'distance-6 predecessor not counted');
  assert.ok(
    out.coTouch.some((p) => p.pathA === '/pred/c' && p.pathB === '/pred/d'),
    'the same distance-6 pair IS still a co-touch (window 10)');
  assert.equal(out.metadata.predecessorMaxDistanceEvents, 5);
});

// ── top-k + tie-break ──────────────────────────────────────────────────────────

test('top-k 10 with (support desc, path lex) tie-break; truncation metadata per WP6 shape', () => {
  freshDb();
  // 12 co-touch pairs, all support 3 (tied) — lex order decides the cut.
  // Pair i = (/tk/a<i>, /tk/b<i>) with two-digit suffixes for stable lex order.
  for (const s of ['t1', 't2', 't3']) {
    for (let i = 0; i < 12; i++) {
      const n = String(i).padStart(2, '0');
      if (i > 0) filler(s, i * 1000, 12); // isolate pairs from each other
      ev({ stream: s, ts: i * 1000 + 500, path: `/tk/a${n}` });
      ev({ stream: s, ts: i * 1000 + 501, path: `/tk/b${n}` });
    }
  }
  const out = build();
  assert.equal(out.coTouch.length, 10, 'top-k slice');
  assert.deepEqual(
    out.coTouch.map((p) => p.pathA),
    Array.from({ length: 10 }, (_, i) => `/tk/a${String(i).padStart(2, '0')}`),
    'tied support → path-lex ascending decides');
  const t = out.truncation.coTouch;
  assert.deepEqual(
    Object.keys(t).sort(),
    ['limit', 'paginationOrder', 'populationAvailable', 'rowsEmitted', 'truncated'],
    'WP6 TableTruncationMetaV1 field set, exactly');
  assert.equal(t.populationAvailable, 12);
  assert.equal(t.rowsEmitted, 10);
  assert.equal(t.truncated, true);
  assert.equal(t.limit, 10);
});

test('support outranks lex order when not tied', () => {
  freshDb();
  const streams = ['r1', 'r2', 'r3', 'r4'];
  for (const s of streams) {
    ev({ stream: s, ts: 10, path: '/rank/zz-a' });
    ev({ stream: s, ts: 11, path: '/rank/zz-b' });
  }
  for (const s of streams.slice(0, 3)) {
    filler(s, 100, 12);
    ev({ stream: s, ts: 200, path: '/rank/aa-a' });
    ev({ stream: s, ts: 201, path: '/rank/aa-b' });
  }
  const out = build();
  assert.equal(out.coTouch[0].pathA, '/rank/zz-a', 'support 4 ranks above support 3 despite lex');
  assert.equal(out.coTouch[1].pathA, '/rank/aa-a');
});

// ── associatedCommandFamilies join ─────────────────────────────────────────────

test('command family co-occurring with a file across 3 streams → associated (generationId stamped); 2 → not', () => {
  freshDb();
  for (const s of ['f1', 'f2', 'f3']) {
    ev({ stream: s, ts: 10, kind: 'tool_use', path: null, access: null, family: 'npm-run' });
    ev({ stream: s, ts: 11, path: '/proj/build.ts' });
  }
  for (const s of ['f1', 'f2']) {
    filler(s, 100, 12);
    ev({ stream: s, ts: 200, kind: 'tool_use', path: null, access: null, family: 'git' });
    ev({ stream: s, ts: 201, path: '/proj/repo.ts' });
  }
  const out = build();
  const assoc = out.associatedCommandFamilies.find(
    (a) => a.path === '/proj/build.ts' && a.commandFamily === 'npm-run');
  assert.ok(assoc, '3-stream association present');
  assert.equal(assoc!.streamsSupporting, 3);
  assert.equal(assoc!.occurrences, 3);
  assert.equal(assoc!.generationId, GEN, 'stamped with THIS analysis generation');
  assert.ok(
    !out.associatedCommandFamilies.some((a) => a.commandFamily === 'git'),
    '2-stream association absent');
});

test('family event outside the declared window does not associate', () => {
  freshDb();
  for (const s of ['f4', 'f5', 'f6']) {
    ev({ stream: s, ts: 10, kind: 'tool_use', path: null, access: null, family: 'far-away' });
    filler(s, 11, 10); // distance 11 to the touch
    ev({ stream: s, ts: 100, path: '/proj/far.ts' });
  }
  const out = build();
  assert.ok(!out.associatedCommandFamilies.some((a) => a.commandFamily === 'far-away'));
});

// ── pinned identity + unattributed bucket ──────────────────────────────────────

test('identity resolves ONLY via the pinned session→agent join; unresolved streams land in the bucket', () => {
  freshDb();
  agentRow('agent-A');
  sessionRow('sess-1', 'agent-A');
  // Stream i1: events carry sess-1 → attributed to agent-A.
  ev({ stream: 'i1', ts: 10, path: '/id/a', session: 'sess-1' });
  ev({ stream: 'i1', ts: 11, path: '/id/b', session: 'sess-1' });
  // Stream i2: NO session id → unattributed, even though it shares paths (and,
  // in the real store, would share a cwd/slug — never an identity signal).
  ev({ stream: 'i2', ts: 10, path: '/id/a' });
  // Stream i3: session id that maps to nothing → unattributed.
  ev({ stream: 'i3', ts: 10, path: '/id/a', session: 'sess-unknown' });
  const out = build();
  assert.equal(out.attribution.attributedStreams, 1);
  assert.equal(out.attribution.unattributedStreams, 2, 'no-session + unmapped-session both bucketed');
  assert.deepEqual(out.attribution.byAgent, [{ dashboardAgentId: 'agent-A', streams: 1 }]);
});

// ── identity-helper equivalence with optimizer-pipeline.ts:502-515 ─────────────

/** The AUTHORITATIVE join exactly as optimizer-pipeline.ts:502-515 (HEAD) wrote
 *  it inline — the reference the shared helper must stay equivalent to. */
const PIPELINE_REFERENCE_JOIN = `
  LEFT JOIN (
    SELECT session_id, MIN(dashboard_agent_id) AS dashboard_agent_id
    FROM agent_sessions GROUP BY session_id
  ) asx ON asx.session_id = ev.session_id
  LEFT JOIN agents ag ON ag.id = asx.dashboard_agent_id
`;

test('streamAgentIdentityJoin emits the optimizer-pipeline join verbatim (default aliases)', () => {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  assert.equal(norm(ident.streamAgentIdentityJoin()), norm(PIPELINE_REFERENCE_JOIN));
});

test('resolveStreamAgents ≡ a query through the verbatim pipeline join, per stream', () => {
  freshDb();
  agentRow('agent-X');
  agentRow('agent-Y');
  sessionRow('sess-x', 'agent-X');
  sessionRow('sess-y1', 'agent-Y');
  sessionRow('sess-y2', 'agent-Y');
  // Duplicate session rows for one session id → MIN() determinism leg.
  agentRow('agent-Z');
  sessionRow('sess-x', 'agent-Z'); // second mapping for sess-x → MIN('agent-X','agent-Z')
  ev({ stream: 'q1', ts: 1, path: '/q/a', session: 'sess-x' });
  ev({ stream: 'q2', ts: 1, path: '/q/a', session: 'sess-y1' });
  ev({ stream: 'q2', ts: 2, path: '/q/b', session: 'sess-y2' });
  ev({ stream: 'q3', ts: 1, path: '/q/a' });                        // no session
  ev({ stream: 'q4', ts: 1, path: '/q/a', session: 'sess-ghost' }); // unmapped session

  const db = dbm.getDb() as unknown as import('./behavior-store').QueryDb;
  const reference = new Map<string, string | null>();
  for (const r of db.prepare(
    `SELECT ev.stream_id AS s, MIN(ag.id) AS agent_id
       FROM behavior_events ev
       ${PIPELINE_REFERENCE_JOIN}
      GROUP BY ev.stream_id`,
  ).all()) {
    reference.set(String(r.s), r.agent_id == null ? null : String(r.agent_id));
  }

  const got = ident.resolveStreamAgents(db);
  for (const [streamId, agentId] of reference) {
    if (agentId === null) {
      assert.ok(got.unattributedStreamIds.includes(streamId), `${streamId} unattributed in both`);
    } else {
      assert.equal(got.attributed.get(streamId), agentId, `${streamId} attributed identically`);
    }
  }
  assert.equal(
    got.attributed.size + got.unattributedStreamIds.length, reference.size,
    'every stream classified exactly once');
});

// ── WP3 bar lift (recommendation-draft integration) ────────────────────────────

function familyDraftInput(
  over: Partial<import('./recommendation-draft').BuildRecommendationDraftInput> = {},
): import('./recommendation-draft').BuildRecommendationDraftInput {
  return {
    target: { file: 'C:/ws/CLAUDE.md' },
    claimTemplate: draft.commandFamilyClaimTemplate({
      family: 'npm-run', count: 9, distinctStreams: 3, rowId: 'row-1',
    }),
    evidence: [{ kind: 'command_family', rowIds: ['row-1'], generationId: GEN, surface: 'optimizer' }],
    generationId: GEN,
    ...over,
  };
}

test('WP9 lift: command_family + file target builds ONLY with a matching 3-stream same-generation association', () => {
  const assoc = {
    path: 'c:/ws/claude.md', commandFamily: 'npm-run',
    streamsSupporting: 3, occurrences: 9, generationId: GEN,
  };
  const out = draft.buildRecommendationDraft(familyDraftInput({ associatedCommandFamilies: [assoc] }));
  assert.deepEqual(out.target, { file: 'C:/ws/CLAUDE.md' });
  assert.equal(out.humanReviewRequired, true);
});

test('WP9 lift refused: no associations (the original WP3 bar)', () => {
  assert.throws(() => draft.buildRecommendationDraft(familyDraftInput()),
    /associatedCommandFamilies join/);
});

test('WP9 lift refused: only 2 supporting streams', () => {
  const assoc = { path: 'c:/ws/claude.md', commandFamily: 'npm-run', streamsSupporting: 2, occurrences: 4, generationId: GEN };
  assert.throws(() => draft.buildRecommendationDraft(familyDraftInput({ associatedCommandFamilies: [assoc] })),
    /associatedCommandFamilies join/);
});

test('WP9 lift refused: association from ANOTHER generation (prospective only — no retroactive causality)', () => {
  const assoc = { path: 'c:/ws/claude.md', commandFamily: 'npm-run', streamsSupporting: 3, occurrences: 9, generationId: 'gen-OLDER' };
  assert.throws(() => draft.buildRecommendationDraft(familyDraftInput({ associatedCommandFamilies: [assoc] })),
    /associatedCommandFamilies join/);
});

test('WP9 lift refused: association names a DIFFERENT file than the target', () => {
  const assoc = { path: 'c:/ws/other.md', commandFamily: 'npm-run', streamsSupporting: 3, occurrences: 9, generationId: GEN };
  assert.throws(() => draft.buildRecommendationDraft(familyDraftInput({ associatedCommandFamilies: [assoc] })),
    /associatedCommandFamilies join/);
});

test('workspace-level command_family drafts (target.unresolved) still need no association', () => {
  const out = draft.buildRecommendationDraft(familyDraftInput({
    target: { unresolved: true, reason: 'workspace-level candidate' },
  }));
  assert.ok((out.target as { unresolved?: boolean }).unresolved);
});

// ── runner ──────────────────────────────────────────────────────────────────────
(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  SQLCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeDb } as unknown as NodeJS.Module;

  freshDb();
  seq = require('./behavior-sequences');
  ident = require('./stream-identity');
  draft = require('./recommendation-draft');

  let passed = 0;
  let failed = 0;
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
})();
