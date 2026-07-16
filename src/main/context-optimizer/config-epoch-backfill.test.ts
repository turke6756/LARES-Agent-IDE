// config-epoch-backfill.ts + git-history.ts tests — WP5 module 0 (git section-hash
// BirthdayResolver + one-shot cold-start backfill). The resolver tests drive a REAL
// `git` against a synthetic fixture repo built in a tmp dir (never the workspace);
// the one-shot guard test drives the real DDL through the sql.js better-sqlite3
// stand-in (same idiom as resident-inventory.test.ts). If `git` is unavailable the
// fixture tests self-skip (logged) rather than failing.
//
//   npm run build:main
//   node dist/main/main/context-optimizer/config-epoch-backfill.test.js

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  blameMaxCommitterMs, execFileGitRunner, listRevisions, repoRootFor,
} from './git-history';
import {
  EPOCHS_BACKFILLED_AT_KEY, EPOCHS_BACKFILLED_VERSION_KEY, isEpochsBackfilled,
  makeGitBirthdayResolver, runEpochBackfill, type GitBirthdayDeps,
} from './config-epoch-backfill';
import {
  deriveAnchors, parseMarkdownSections,
  type BirthdayResolver, type ResidentTarget, type SectionCandidate,
} from './resident-inventory';
import type { GitRunner } from './git-history';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── deterministic fixture dates (UTC; passed verbatim to git and asserted) ──
const JAN = '2026-01-01T00:00:00 +0000';
const JUN = '2026-06-01T00:00:00 +0000';
const JAN_MS = Date.UTC(2026, 0, 1);
const JUN_MS = Date.UTC(2026, 5, 1);

const gitAvailable = execFileGitRunner.run(['--version'], os.tmpdir()) != null;

function sh(repo: string, args: string[], iso?: string): void {
  execFileSync('git', args, {
    cwd: repo,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: iso ? { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } : process.env,
  });
}
function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, ['init', '-q']);
  sh(dir, ['config', 'user.email', 'fixture@test.local']);
  sh(dir, ['config', 'user.name', 'Fixture']);
  sh(dir, ['config', 'commit.gpgsign', 'false']);
}
function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function commit(dir: string, iso: string, msg: string): void {
  sh(dir, ['add', '-A'], iso);
  sh(dir, ['commit', '-q', '-m', msg], iso);
}

/** Find the current section candidate whose heading text matches. */
function sectionByHeading(text: string, heading: string): SectionCandidate {
  const cand = deriveAnchors(parseMarkdownSections(text)).find((s) => s.headingText === heading);
  assert.ok(cand, `no section titled "${heading}"`);
  return cand;
}
function mkTarget(sourcePath: string, text: string, over: Partial<ResidentTarget> = {}): ResidentTarget {
  return {
    targetType: 'markdown_section', targetKey: sourcePath, sourceKind: 'user_file',
    sourcePath, sourceSymbol: null, lanes: ['supervisor'], text, ...over,
  };
}
function mkResolver(over: Partial<GitBirthdayDeps> = {}): BirthdayResolver {
  return makeGitBirthdayResolver({
    git: execFileGitRunner, statMtimeMs: () => null, ...over,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// git_section_history — the cold-start gate (§3.2.1, addendum test #12)
// ─────────────────────────────────────────────────────────────────────────────
test('git_section_history beats blame collapse across a whole-file rewrite', function () {
  if (!gitAvailable) { console.log('    (skipped — git unavailable)'); return; }
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ceb-hist-'));
  try {
    initRepo(repo);
    // commit1 (Jan): clean file.
    write(repo, 'notes.md', '# Teams\nteam v1\n\n# Notebooks\nnb body\n');
    commit(repo, JAN, 'c1');
    // commit2 (Jun): whole-file rewrite — every raw line churns (trailing ws + CRLF),
    // Teams body changes, but Notebooks NORMALIZES byte-identical to commit1.
    const rewritten = '# Teams  \r\nteam v2  \r\n\r\n# Notebooks  \r\nnb body  \r\n';
    write(repo, 'notes.md', rewritten);
    commit(repo, JUN, 'c2');

    const abs = path.join(repo, 'notes.md');
    const target = mkTarget(abs, rewritten);
    const notebooks = sectionByHeading(rewritten, 'Notebooks');

    const got = mkResolver().resolve(target, notebooks, JUN_MS + 999_999);
    assert.equal(got.source, 'git_section_history');
    assert.equal(got.confidence, 'high');
    assert.equal(got.firstSeenMs, JAN_MS, 'dated to the OLD commit, not the rewrite');

    // Prove the collapse it beats: blame over the current Notebooks lines is Jun.
    const root = repoRootFor(execFileGitRunner, repo)!;
    const blamed = blameMaxCommitterMs(execFileGitRunner, root, 'notes.md', 4, 5);
    assert.equal(blamed, JUN_MS, 'blame alone would mis-date to the rewrite commit');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('blameMaxCommitterMs takes MAX over NON-BLANK lines only (§3.2.2)', function () {
  if (!gitAvailable) { console.log('    (skipped — git unavailable)'); return; }
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ceb-blame-'));
  try {
    initRepo(repo);
    write(repo, 'notes.md', '# H\nalpha\nbeta\n');
    commit(repo, JAN, 'c1');
    // Jun edit turns line 2 BLANK; lines 1 & 3 keep their Jan committer time.
    write(repo, 'notes.md', '# H\n\nbeta\n');
    commit(repo, JUN, 'c2');
    const root = repoRootFor(execFileGitRunner, repo)!;
    // Blank line 2 (its only Jun change) is excluded ⇒ MAX over non-blank = Jan.
    assert.equal(blameMaxCommitterMs(execFileGitRunner, root, 'notes.md', 1, 3), JAN_MS);
    // git clamps an over-range END (still fine); a START past EOF errors ⇒ null,
    // never throws — the resolver clamps lineStart to keep this branch usable.
    assert.equal(blameMaxCommitterMs(execFileGitRunner, root, 'notes.md', 1, 99), JAN_MS);
    assert.equal(blameMaxCommitterMs(execFileGitRunner, root, 'notes.md', 99, 100), null);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// scaffold_constant — constant-hash history for a generated/ignored file (§3.2.3)
// ─────────────────────────────────────────────────────────────────────────────
test('scaffold_constant dates an untracked generated file from constant history', function () {
  if (!gitAvailable) { console.log('    (skipped — git unavailable)'); return; }
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ceb-scaf-'));
  try {
    initRepo(repo);
    // A committed constants file carrying the managed section as a template literal.
    write(repo, 'constants.ts', 'export const WORKER_MD = `# Grant\ngrant body\n`;\n');
    commit(repo, JAN, 'c1');
    // The generated runtime file (mirrors the constant) is written but NEVER git-added.
    const genAbs = path.join(repo, 'generated', 'worker.md');
    const genText = '# Grant\ngrant body\n';
    write(repo, 'generated/worker.md', genText);

    const extractConstantText = (raw: string): string | null => {
      const m = /export const WORKER_MD\s*=\s*`([\s\S]*?)`/.exec(raw);
      return m ? m[1] : null;
    };
    const resolver = mkResolver({
      scaffoldConstant: () => ({ repoDir: repo, relPath: 'constants.ts', extractConstantText }),
    });
    const grant = sectionByHeading(genText, 'Grant');
    // Untracked path ⇒ own history empty ⇒ falls through to the constant bridge.
    assert.equal(listRevisions(execFileGitRunner, repo, 'generated/worker.md').length, 0);
    const got = resolver.resolve(mkTarget(genAbs, genText), grant, JUN_MS);
    assert.equal(got.source, 'scaffold_constant');
    assert.equal(got.confidence, 'medium');
    assert.equal(got.firstSeenMs, JAN_MS);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// mtime + none — the honest floors (§3.2.4 / §3.2.5)
// ─────────────────────────────────────────────────────────────────────────────
test('mtime tier for content with no git signal (§3.2.4) — low confidence', function () {
  // A path outside any repo: git yields nothing, statMtimeMs supplies the floor.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceb-mtime-'));
  try {
    const abs = path.join(dir, 'loose.md');
    const text = '# Loose\nbody\n';
    fs.writeFileSync(abs, text);
    const resolver = mkResolver({ statMtimeMs: () => JAN_MS });
    const got = resolver.resolve(mkTarget(abs, text), sectionByHeading(text, 'Loose'), JUN_MS);
    assert.equal(got.source, 'mtime');
    assert.equal(got.confidence, 'low');
    assert.equal(got.firstSeenMs, JAN_MS);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('none tier when nothing dates a section (§3.2.5) — firstSeen = now', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceb-none-'));
  try {
    const abs = path.join(dir, 'loose.md');
    const text = '# Loose\nbody\n';
    fs.writeFileSync(abs, text);
    const resolver = mkResolver({ statMtimeMs: () => null });
    const got = resolver.resolve(mkTarget(abs, text), sectionByHeading(text, 'Loose'), JUN_MS);
    assert.equal(got.source, 'none');
    assert.equal(got.firstSeenMs, JUN_MS, 'undatable ⇒ firstParseMs ⇒ insufficient-exposure');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// One-shot guard: runs once, stamps meta, steady state runs NO git (§1.5 / §3.5)
// ─────────────────────────────────────────────────────────────────────────────
test('runEpochBackfill runs once, stamps the guard, then no-ops (no git)', function () {
  const db = ledger();
  const target = mkTarget('C:/ws/.dashboard/supervisor/CLAUDE.md', '# A\naaa\n# B\nbbb\n');

  // Spy git: any invocation past the first run is a §3.5 violation.
  let gitCalls = 0;
  const spyGit: GitRunner = { run: (a, c) => { gitCalls++; return execFileGitRunner.run(a, c); } };
  const resolver = makeGitBirthdayResolver({ git: spyGit, statMtimeMs: () => JAN_MS });

  assert.equal(isEpochsBackfilled(db), false, 'not backfilled on a fresh ledger');
  const first = runEpochBackfill([target], { db, resolver, nowMs: JUN_MS });
  assert.equal(first.ran, true);
  assert.equal(first.results.length, 1);
  assert.deepEqual(
    [first.results[0].result.opened, first.results[0].result.edited],
    [2, 0],
    'both sections opened on the cold-start pass',
  );
  assert.equal(isEpochsBackfilled(db), true, 'guard stamped');
  assert.equal(db.prepare(`SELECT v FROM skill_analytics_meta WHERE k=@k`).get({ k: EPOCHS_BACKFILLED_AT_KEY })!.v, String(JUN_MS));

  const gitAfterFirst = gitCalls;
  const second = runEpochBackfill([target], { db, resolver, nowMs: JUN_MS + 1000 });
  assert.equal(second.ran, false, 'second pass is a no-op');
  assert.equal(second.results.length, 0);
  assert.equal(gitCalls, gitAfterFirst, 'steady state invokes NO git');

  // Every opened epoch carries the resolver's mtime birthday (git found no repo for C:/ws).
  const rows = db.prepare(`SELECT first_seen_source FROM config_epochs WHERE last_seen_ms IS NULL`).all();
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.first_seen_source, 'mtime');
});

test('parser-version bump re-opens the backfill guard (§1.5)', function () {
  const db = ledger();
  const target = mkTarget('C:/ws/.dashboard/supervisor/CLAUDE.md', '# A\naaa\n');
  const resolver = mkResolver({ statMtimeMs: () => JAN_MS });
  runEpochBackfill([target], { db, resolver, nowMs: JUN_MS, parserVersion: 1 });
  assert.equal(isEpochsBackfilled(db, 1), true);
  assert.equal(isEpochsBackfilled(db, 2), false, 'a newer parser version re-opens backfill');
});

// ─────────────────────────────────────────────────────────────────────────────
// sql.js better-sqlite3 stand-in (mirrors resident-inventory.test.ts) + runner
// ─────────────────────────────────────────────────────────────────────────────
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
function ledger(): import('./resident-inventory').LedgerDb {
  return dbm.getDb() as unknown as import('./resident-inventory').LedgerDb;
}

(async () => {
  const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'ceb-appdata-'));
  process.env.APPDATA = tmpAppData;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  SQLCtor = SQL.Database;
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeDb } as unknown as NodeJS.Module;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as unknown as DbMod;
  dbm.initDatabase();

  let passed = 0; let failed = 0;
  for (const t of tests) {
    // getDb() is a singleton — clear ledger + meta so each DB test is isolated.
    dbm.getDb().exec(
      `DELETE FROM config_epochs; DELETE FROM config_section_anchors; ` +
      `DELETE FROM skill_analytics_meta WHERE k='${EPOCHS_BACKFILLED_AT_KEY}' OR k='${EPOCHS_BACKFILLED_VERSION_KEY}';`,
    );
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  try { fs.rmSync(tmpAppData, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
