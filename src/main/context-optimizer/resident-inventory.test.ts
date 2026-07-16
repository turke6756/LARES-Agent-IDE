// resident-inventory.ts tests — WP5 module 1 (config_section_anchors/config_epochs
// writer). Pure sectioning/hashing/anchor tests run standalone; the §2.5 diff writer
// tests drive the real DDL through the sql.js better-sqlite3 stand-in (same idiom as
// behavior-store.test.ts, because better-sqlite3's native binding won't load under
// the system Node that `npm run test:supervisor` uses).
//
//   npm run build:main
//   node dist/main/main/context-optimizer/resident-inventory.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── sql.js better-sqlite3 stand-in (named + positional) ──
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
      get: (...args: unknown[]) => { const s = inner.prepare(sql); try { s.bind(toBind(args)); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } },
      all: (...args: unknown[]) => { const s = inner.prepare(sql); try { s.bind(toBind(args)); const rows: Record<string, unknown>[] = []; while (s.step()) rows.push(s.getAsObject()); return rows; } finally { s.free(); } },
    };
  }
  transaction<A extends unknown[]>(fn: (...a: A) => unknown) {
    return (...a: A) => { this.db.run('BEGIN'); try { const r = fn(...a); this.db.run('COMMIT'); return r; } catch (e) { this.db.run('ROLLBACK'); throw e; } };
  }
}

type DbMod = { initDatabase(): void; getDb(): FakeDb };
let dbm: DbMod;
let ri: typeof import('./resident-inventory');
type LedgerDb = import('./resident-inventory').LedgerDb;
type ResidentTarget = import('./resident-inventory').ResidentTarget;

const T1 = 1_700_000_000_000;
const T2 = T1 + 60_000;
const T3 = T2 + 60_000;

function ledger(): LedgerDb { return dbm.getDb() as unknown as LedgerDb; }
function mkTarget(text: string, over: Partial<ResidentTarget> = {}): ResidentTarget {
  return {
    targetType: 'markdown_section', targetKey: 'C:/ws/.dashboard/supervisor/CLAUDE.md',
    sourceKind: 'user_file', sourcePath: 'C:/ws/.dashboard/supervisor/CLAUDE.md',
    sourceSymbol: null, lanes: ['supervisor'], text, ...over,
  };
}
function openEpochs(tk = 'C:/ws/.dashboard/supervisor/CLAUDE.md'): Record<string, unknown>[] {
  return dbm.getDb().prepare(
    `SELECT * FROM config_epochs WHERE target_key = @tk AND last_seen_ms IS NULL ORDER BY section_key`,
  ).all({ tk });
}
function allEpochs(tk = 'C:/ws/.dashboard/supervisor/CLAUDE.md'): Record<string, unknown>[] {
  return dbm.getDb().prepare(`SELECT * FROM config_epochs WHERE target_key = @tk ORDER BY first_seen_ms`).all({ tk });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: normalization + hashing
// ─────────────────────────────────────────────────────────────────────────────
test('normalize strips sentinels, CRLF, trailing ws, collapses blanks, strips leading #', () => {
  const norm = ri.normalizeSectionText;
  assert.equal(norm('<!-- section:teams v1 -->\r\n## Teams  \r\n\n\nbody\n'), 'Teams\n\nbody');
  // cosmetic reflow (extra blank run) is byte-identical after normalize → same hash
  assert.equal(
    ri.contentHashOf('## A', 'line1\n\n\n\nline2'),
    ri.contentHashOf('## A', 'line1\n\nline2'),
  );
  // heading excluded from the semantic fingerprint
  assert.equal(ri.semanticFingerprintOf('shared'), ri.semanticFingerprintOf('shared'));
  assert.notEqual(ri.contentHashOf('## A', 'x'), ri.contentHashOf('## B', 'x'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure: section parsing + anchor derivation
// ─────────────────────────────────────────────────────────────────────────────
test('parseMarkdownSections: preamble + heading nesting breadcrumb', () => {
  const secs = ri.parseMarkdownSections('preamble text\n# Top\nt\n## Sub\ns\n');
  assert.equal(secs.length, 3);
  assert.equal(secs[0].headingText, null);          // preamble
  assert.equal(secs[1].headingPath, 'top');
  assert.equal(secs[2].headingPath, 'top>sub');     // breadcrumb includes ancestor
});

test('deriveAnchors: sentinel wins; duplicate heading-path gets :nthOccurrence', () => {
  const secs = ri.deriveAnchors(ri.parseMarkdownSections(
    '<!-- section:teams v1 -->\n## Teams\nbody\n<!-- /section:teams -->\n' +
    '## Dup\na\n## Dup\nb\n',
  ));
  const teams = secs.find((s) => s.headingText === 'Teams')!;
  assert.equal(teams.rawAnchor, 'sentinel:teams');
  assert.equal(teams.anchorKind, 'sentinel');
  const dups = secs.filter((s) => s.headingText === 'Dup');
  assert.deepEqual(dups.map((d) => d.rawAnchor), ['h:dup:0', 'h:dup:1']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Writer: the §2.5 diff
// ─────────────────────────────────────────────────────────────────────────────
const THREE = '# A\naaa\n# B\nbbb\n# C\nccc\n';

test('first pass opens one epoch per section, all open', () => {
  const r = ri.reconcileTarget(ledger(), mkTarget(THREE), { nowMs: T1 });
  assert.deepEqual([r.opened, r.edited, r.unchanged, r.closed], [3, 0, 0, 0]);
  assert.equal(openEpochs().length, 3);
});

test('reorder: unchanged anchors, zero new epochs', () => {
  ri.reconcileTarget(ledger(), mkTarget(THREE), { nowMs: T1 });
  const before = openEpochs().map((e) => e.id).sort();
  const r = ri.reconcileTarget(ledger(), mkTarget('# C\nccc\n# A\naaa\n# B\nbbb\n'), { nowMs: T2 });
  assert.deepEqual([r.opened, r.edited, r.unchanged, r.closed], [0, 0, 3, 0]);
  assert.deepEqual(openEpochs().map((e) => e.id).sort(), before, 'same epoch ids survive reorder');
});

test('whole-file rewrite touching ONE section: 1 edit, others stay open', () => {
  ri.reconcileTarget(ledger(), mkTarget(THREE), { nowMs: T1 });
  // whole-file rewrite churns CRLF + trailing ws everywhere (normalize absorbs it)
  // but only C's body actually changes → per-section compare keeps A,B open.
  const r = ri.reconcileTarget(ledger(), mkTarget('# A\r\naaa  \r\n# B\r\nbbb\r\n# C\r\nCHANGED\r\n'), { nowMs: T2 });
  assert.deepEqual([r.opened, r.edited, r.unchanged, r.closed], [0, 1, 2, 0]);
  assert.equal(openEpochs().length, 3, 'A,B stay open + new C epoch');
  assert.equal(allEpochs().length, 4, 'old C closed, new C opened');
});

test('sentinel heading rename: same anchor, new epoch, old superseded', () => {
  const wrapped = (h: string) => `<!-- section:teams v1 -->\n## ${h}\nbody\n<!-- /section:teams -->\n`;
  ri.reconcileTarget(ledger(), mkTarget(wrapped('Teams')), { nowMs: T1 });
  const anchorBefore = openEpochs()[0].anchor_uid;
  const r = ri.reconcileTarget(ledger(), mkTarget(wrapped('Team Directory')), { nowMs: T2 });
  assert.deepEqual([r.opened, r.edited, r.unchanged, r.closed], [0, 1, 0, 0]);
  assert.equal(openEpochs()[0].anchor_uid, anchorBefore, 'sentinel anchor survives rename');
  const closed = allEpochs().find((e) => e.last_seen_ms != null)!;
  assert.equal(closed.last_seen_reason, 'edited');
  assert.ok(closed.superseded_by, 'old epoch points at its successor');
});

test('non-sentinel rename with identical body: same anchor via fingerprint (2b), new epoch', () => {
  ri.reconcileTarget(ledger(), mkTarget('## Alpha\nshared body\n'), { nowMs: T1 });
  const anchorBefore = String(openEpochs()[0].anchor_uid);
  assert.ok(anchorBefore.endsWith(':h:alpha'));
  const r = ri.reconcileTarget(ledger(), mkTarget('## Beta\nshared body\n'), { nowMs: T2 });
  assert.deepEqual([r.opened, r.edited, r.unchanged, r.closed], [0, 1, 0, 0]);
  assert.equal(openEpochs()[0].anchor_uid, anchorBefore, 'lineage preserved through rename (no fuzzy tier)');
  assert.equal(openEpochs()[0].heading_text, 'Beta', 'new epoch carries the new heading');
});

test('removed section closes as removed', () => {
  ri.reconcileTarget(ledger(), mkTarget(THREE), { nowMs: T1 });
  const r = ri.reconcileTarget(ledger(), mkTarget('# A\naaa\n# B\nbbb\n'), { nowMs: T2 });
  assert.deepEqual([r.opened, r.edited, r.unchanged, r.closed], [0, 0, 2, 1]);
  const removed = allEpochs().find((e) => e.last_seen_reason === 'removed');
  assert.ok(removed, 'C closed with reason=removed');
});

test('birthday resolver dates brand-new sections (cold-start seam)', () => {
  const birthday = {
    resolve: () => ({ firstSeenMs: 111, source: 'git_section_history' as const, confidence: 'high' as const }),
  };
  ri.reconcileTarget(ledger(), mkTarget('# A\naaa\n'), { nowMs: T1, birthday });
  const e = openEpochs()[0];
  assert.equal(e.first_seen_ms, 111);
  assert.equal(e.first_seen_source, 'git_section_history');
});

// ─────────────────────────────────────────────────────────────────────────────
// Extraction: sources taken VERBATIM from the walk-up chain (A11) + scan hygiene
// ─────────────────────────────────────────────────────────────────────────────
test('collectMarkdownTargets: lane union, verbatim from walk-up, .bak/plans excluded', () => {
  const src = (p: string, kind: string, lane: string) => ({ resolvedPath: p, kind, sourceScope: 'agent', children: [] });
  const frame = (sources: unknown[]) => ({ included: true, sources });
  const agent = (lane: string, paths: [string, string][]) => ({
    lane, inheritanceChain: [frame(paths.map(([p, k]) => src(p, k, lane)))],
  });
  const model = {
    agents: [
      agent('supervisor', [
        ['C:/ws/.dashboard/supervisor/CLAUDE.md', 'agent-claude'],
        ['C:/ws/CLAUDE.md', 'inherited-claude'],          // shared ancestor
        ['C:/ws/CLAUDE.md.bak.123', 'inherited-claude'],  // excluded: backup
        ['C:/ws/plans/x.md', 'import'],                   // excluded: plans/
      ]),
      agent('worker', [
        ['C:/ws/CLAUDE.md', 'inherited-claude'],          // same file, worker lane too
        ['C:/ws/.dashboard/workers/claude/CLAUDE.md', 'agent-claude'],
      ]),
    ],
  } as unknown as import('../../shared/types').OverheadModel;
  const files = new Map<string, string>([
    ['C:/ws/.dashboard/supervisor/CLAUDE.md', '# S\nx\n'],
    ['C:/ws/CLAUDE.md', '# Root\ny\n'],
    ['C:/ws/.dashboard/workers/claude/CLAUDE.md', '# W\nz\n'],
  ]);
  const reader = {
    read: (p: string) => files.has(p) ? { content: files.get(p)!, bytes: files.get(p)!.length } : null,
    exists: (p: string) => files.has(p), listFiles: () => [],
  };
  const targets = ri.collectMarkdownTargets(model, reader);
  const byPath = new Map(targets.map((t) => [t.sourcePath, t]));
  assert.ok(!byPath.has('C:/ws/CLAUDE.md.bak.123'), 'backup excluded');
  assert.ok(!byPath.has('C:/ws/plans/x.md'), 'plans excluded');
  assert.deepEqual(byPath.get('C:/ws/CLAUDE.md')!.lanes, ['supervisor', 'worker'], 'lanes unioned across agents');
  assert.equal(byPath.get('C:/ws/.dashboard/workers/claude/CLAUDE.md')!.sourceKind, 'ignored_scaffold');
});

// ── runner ──
(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-inv-'));
  process.env.APPDATA = tmpAppData;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  SQLCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeDb } as unknown as NodeJS.Module;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as unknown as DbMod;
  ri = require('./resident-inventory');
  dbm.initDatabase();

  let passed = 0; let failed = 0;
  for (const t of tests) {
    // getDb() is a singleton — clear the ledger tables so each writer test is isolated.
    dbm.getDb().exec('DELETE FROM config_epochs; DELETE FROM config_section_anchors;');
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
