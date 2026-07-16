// optimizer-corpus-backfill.test.ts — WP6 acceptance leg, TASK D. The env-gated
// REAL-CORPUS acceptance test for the whole context-optimizer assembly.
//
// This is Edward's G3 evidence run: it ingests the REAL ~/.claude/projects corpus
// into a FRESH sql.js DB (the live app DB is never touched, the corpus is strictly
// READ-ONLY), drives the per-lane assembly against THIS repo's own .dashboard/
// scaffold + real corpus (no synthetic fixture), and runs the assembled pipeline
// EXACTLY as ipc-handlers composes it:
//   runOptimizerAnalyze({ generatedAtIso, nowMs, query, lanes: assembleAllLaneInputs(ctx),
//                         db, backfillTargets: ctx.residentTargets, birthdayResolver })
//
// It self-gates behind RUN_CORPUS_BACKFILL=1 (passes vacuously otherwise — the
// established idiom, mirrors skill-analytics/parse-backfill.test.ts test 22). The
// corpus run may take minutes; run it under the system node from the workspace root:
//
//   npm run build:main
//   RUN_CORPUS_BACKFILL=1 node dist/main/main/context-optimizer/optimizer-corpus-backfill.test.js
//
// Asserts (design §3 / WP6 acceptance):
//   (3a) config_epochs first_seen_ms git-dated back to constant birth (large bounded
//        denominator — NOT stamped at nowMs) post-backfill;
//   (3b) turn_outcome behavior_events present in the parsed corpus;
//   (4a) top SUBTRACT proposals rediscover the resident-but-unused Teams/Notebook
//        surface; plus the backfill DEPENDENCY (no birthdayResolver ⇒ no SUBTRACT);
//   (4b) file-heat/bypass independently surfaces read-comments.py (exec ≥ skill calls).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── sql.js-backed better-sqlite3 stand-in (named + positional params) ───────────
// Identical to optimizer-pipeline-seams.test.ts / parse-backfill.test.ts so a wrong
// column name (which `tsc` cannot catch) fails here rather than at runtime.
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

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── module handles (populated after cache injection) ────────────────────────────
type DbMod = { initDatabase(): void; getDb(): FakeDb };
let dbm: DbMod;
let scanner: typeof import('../skill-analytics/jsonl-scanner');
let parseRunner: typeof import('../skill-analytics/parse-runner');
let factory: typeof import('../skill-analytics/parse-manager-factory');
let assembleMod: typeof import('./optimizer-assemble');
let surfaceMod: typeof import('./optimizer-surface');
let productionMod: typeof import('./optimizer-production');
type PipelineDb = import('./optimizer-pipeline').PipelineDb;
type Proposal = import('../../shared/types').ContextOptimizerProposal;
type OptimizerResult = import('../../shared/types').ContextOptimizerResult;

// ── helpers ─────────────────────────────────────────────────────────────────────

/** Walk up from this compiled test file to the app repo root (the dir that holds
 *  `src/shared/constants.ts` — where the scaffold-constant lineage the birthday
 *  resolver reads lives). Robust to the dist/main/main/... layout. */
function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, 'src', 'shared', 'constants.ts')) &&
        fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate repo root (src/shared/constants.ts) from ${__dirname}`);
}

function count(sql: string, ...params: unknown[]): number {
  const row = dbm.getDb().prepare(sql).get(...params) as Record<string, unknown> | undefined;
  const v = row ? Object.values(row)[0] : 0;
  return typeof v === 'number' ? v : Number(v ?? 0) || 0;
}

function subtractOf(data: OptimizerResult, lane: string): Proposal[] {
  return data.proposals
    .filter((p) => p.lever === 'subtract' && (p.target.lane === lane || p.attribution.lane === lane))
    .sort((a, b) => b.tokenTurnsWeight - a.tokenTurnsWeight);
}

/** Resolve a dead-guidance section proposal's heading text by reading the target file
 *  at (or just above) its `lineStart` — the section proposals carry only absPath +
 *  lineStart, not the heading string. Used to identify the resident Notebook/Teams
 *  section a SUBTRACT rediscovers. Best-effort (empty on any read failure). */
const headingCache = new Map<string, string[]>();
function fileLines(absPath: string): string[] {
  let ls = headingCache.get(absPath);
  if (!ls) { try { ls = fs.readFileSync(absPath, 'utf8').split(/\r?\n/); } catch { ls = []; } headingCache.set(absPath, ls); }
  return ls;
}
function resolveHeading(p: Proposal): string {
  if (!p.target.absPath || !p.target.lineStart) return '';
  const ls = fileLines(p.target.absPath);
  // Search at lineStart then walk up to the nearest markdown heading.
  for (let i = Math.min(p.target.lineStart - 1, ls.length - 1); i >= 0; i--) {
    const m = /^#{1,6}\s+(.*)$/.exec(ls[i] ?? '');
    if (m) return m[1].trim();
  }
  return (ls[p.target.lineStart - 1] ?? '').trim();
}

function short(p: Proposal): string {
  const tgt = p.target.mcpToolset ?? p.target.skillName ?? p.target.absPath ?? '(section)';
  const head = p.lever === 'subtract' && !p.target.mcpToolset ? `  «${resolveHeading(p) || '?'}»` : '';
  return `[${p.kind} ${p.occurrence}/${p.confidence} w=${p.tokenTurnsWeight}] ${p.title}${head}  → tgt=${tgt}`;
}

// ── the acceptance suite ──────────────────────────────────────────────────────────

test('G3: REAL-corpus backfill + assembled optimizer pipeline (gated: RUN_CORPUS_BACKFILL=1)', () => {
  if (process.env.RUN_CORPUS_BACKFILL !== '1') {
    console.log('       (skipped — set RUN_CORPUS_BACKFILL=1 to run the real-corpus G3 acceptance)');
    return;
  }

  const repoRoot = findRepoRoot();
  console.log(`       repoRoot: ${repoRoot}`);

  // ── (0) Seed THIS repo as the workspace to analyze. runOverheadScan resolves the
  //        workspace via getWorkspace(workspaceId) → the (fresh) DB; the scan itself
  //        reads the real .dashboard/ scaffold off disk (read-only).
  const WS_ID = 'ws-corpus-acceptance';
  dbm.getDb().prepare(
    `INSERT INTO workspaces (id, title, path, path_type) VALUES (?, ?, ?, ?)`,
  ).run(WS_ID, 'AgentDashboard', repoRoot, 'windows');

  // ── (1) Locate the REAL corpus (strictly READ-ONLY). ──
  const dirs = scanner.resolveProjectsDirs();
  const streams = dirs.flatMap((d) => scanner.listJsonlStreams(d));
  console.log(`       corpus: ${streams.length} streams across ${dirs.length} projects dir(s)`);
  assert.ok(streams.length > 0, 'found real ~/.claude/projects streams');

  // ── (2) Ingest into the FRESH DB via runIncrementalParse. Real known-skills set +
  //        real tool_name→toolset resolver (same production wiring the parse-manager
  //        uses), so behavior_events/skill_invocations populate faithfully. ──
  const mdeps = factory.createParseManagerDeps();
  const t0 = Date.now();
  const parseRes = parseRunner.runIncrementalParse({
    db: dbm.getDb() as unknown as import('../skill-analytics/parse-runner').ParseDb,
    streams,
    readNewLines: scanner.readNewLines,
    knownSkills: mdeps.knownSkills,
    resolveMcpToolset: mdeps.resolveMcpToolset,
  });
  const parseMs = Date.now() - t0;
  const invs = count(`SELECT COUNT(*) c FROM skill_invocations`);
  const be = count(`SELECT COUNT(*) c FROM behavior_events`);
  const tu = count(`SELECT COUNT(*) c FROM turn_usage`);
  console.log(`       parsed ${parseRes.filesParsed}/${parseRes.filesScanned} files in ${parseMs} ms`);
  console.log(`       rows: skill_invocations=${invs}, behavior_events=${be}, turn_usage=${tu}`);

  // (3b) turn_outcome behavior_events present.
  const turnOutcomes = count(`SELECT COUNT(*) c FROM behavior_events WHERE kind = 'turn_outcome'`);
  console.log(`       (3b) turn_outcome behavior_events = ${turnOutcomes}`);
  assert.ok(turnOutcomes > 0, '(3b) turn_outcome behavior_events present in the parsed corpus');

  // ── (4) Assemble one RawLaneInputs per real persona lane over the workspace scaffold
  //        + DB spine, then run the pipeline EXACTLY as ipc-handlers:489-519 composes it. ──
  const db = dbm.getDb() as unknown as PipelineDb;
  const ctx = assembleMod.buildAssembleContext({ workspaceId: WS_ID, db });
  const lanes = assembleMod.assembleAllLaneInputs(ctx);
  console.log(`       assembled lanes: ${lanes.map((l) => l.lane).join(', ')} (residentTargets=${ctx.residentTargets.length})`);
  assert.ok(lanes.length > 0, 'assembly produced at least one real persona lane');

  const birthdayResolver = productionMod.makeProductionBirthdayResolver(repoRoot);
  const data = surfaceMod.runOptimizerAnalyze({
    generatedAtIso: new Date().toISOString(),
    nowMs: Date.now(),
    query: {},
    lanes,
    db,
    backfillTargets: ctx.residentTargets,
    birthdayResolver,
  });
  console.log(`       proposals: ${data.proposals.length}, fileHeat rows: ${data.fileHeat.length}`);

  // ── DIAGNOSTIC (G3 due-diligence): trace the Notebook/Teams surface end-to-end so
  //    the report can state PRECISELY why the design's expected rediscovery does/doesn't
  //    land, rather than guessing. Not an assertion — evidence for the summary. ──
  const rcPaths = dbm.getDb().prepare(
    `SELECT DISTINCT arg_path FROM behavior_events WHERE access_mode='executed' AND LOWER(arg_path) LIKE '%read-comments.py%' LIMIT 12`,
  ).all() as Record<string, unknown>[];
  console.log('       DIAG: distinct executed read-comments.py arg_paths:');
  for (const r of rcPaths) console.log(`             ${r.arg_path}`);
  const nbToolUse = count(`SELECT COUNT(*) c FROM behavior_events WHERE mcp_toolset = 'notebooks'`);
  const teamToolUse = count(`SELECT COUNT(*) c FROM behavior_events WHERE mcp_toolset = 'teams'`);
  console.log(`       DIAG: behavior_events mcp_toolset — notebooks=${nbToolUse}, teams=${teamToolUse}`);
  for (const raw of lanes) {
    const hits = raw.actions.filter((a) => /notebook|team/i.test(JSON.stringify(a)));
    console.log(`       DIAG: ${raw.lane} predicted-actions referencing notebook/team: ${hits.length}`);
    for (const a of hits.slice(0, 6)) {
      console.log(`             kind=${a.kind} deriv=${(a as { derivability?: string }).derivability} sectionKey=${String((a as { sourceSectionKey?: string }).sourceSectionKey ?? '').slice(0, 60)} src=${JSON.stringify((a as { source?: unknown }).source).slice(0, 90)}`);
    }
  }
  const naNbTeam = data.modelStats.notAnalyzable.filter((n) => /notebook|team/i.test(`${n.label} ${n.absPath}`));
  console.log(`       DIAG: notAnalyzable notebook/team entries: ${naNbTeam.length}`);
  for (const n of naNbTeam.slice(0, 6)) console.log(`             ${n.label} @ ${n.absPath}:${n.line} (${n.lane ?? '?'})`);
  // read-comments bypass: proposals vs watch-items (the seven-guard downgrade reason).
  for (const raw of lanes) {
    const bp = raw.bypass.proposals.filter((p) => p.skillName === 'read-comments');
    const bw = raw.bypass.watchItems.filter((w) => w.skillName === 'read-comments');
    if (bp.length || bw.length) {
      console.log(`       DIAG: ${raw.lane} read-comments bypass — proposals=${bp.length}, watchItems=${bw.length}`);
      for (const p of bp) console.log(`             PROPOSAL script=${p.scriptPath} execCount=${p.execCount} execStreams=${p.execStreams} skillStreams=${p.skillStreams} conf=${p.matchConfidence}`);
      for (const w of bw) console.log(`             WATCH reason=${w.reason} script=${w.scriptPath} execCount=${w.execCount} execStreams=${w.execStreams} skillStreams=${w.skillStreams} conf=${w.matchConfidence} subExecs=${w.disclosedSubagentExecs}`);
    }
  }
  // read-comments skill index ownership (did scriptGlobsFor fold in the SKILL.md executable?).
  for (const raw of lanes) {
    const idx = assembleMod.buildLaneSkillIndex(ctx.model, raw.lane, ctx.reader).filter((s) => s.skillName === 'read-comments');
    for (const s of idx) console.log(`       DIAG: ${raw.lane} skillIndex read-comments globs=${JSON.stringify(s.scriptGlobs)} mutable=${s.mutable}`);
  }

  // ── (3a) config_epochs git-dated post-backfill. The load-bearing property is NOT
  //        merely "first_seen_ms is non-null" (the column is NOT NULL) — it is that the
  //        birthday resolver dated brand-new resident sections back to their CONSTANT
  //        BIRTH via git, producing a large bounded denominator. If every epoch were
  //        stamped at nowMs the classifier would read insufficient-exposure and no
  //        SUBTRACT could reach `never`. ──
  const epochRows = count(`SELECT COUNT(*) c FROM config_epochs`);
  const gitDated = count(
    `SELECT COUNT(*) c FROM config_epochs WHERE first_seen_source IN ('git_section_history','git_blame','scaffold_constant')`,
  );
  const bounds = dbm.getDb().prepare(
    `SELECT MIN(first_seen_ms) AS min_first, MAX(first_seen_ms) AS max_first,
            SUM(CASE WHEN last_seen_ms IS NULL THEN 1 ELSE 0 END) AS open_epochs,
            SUM(CASE WHEN last_seen_ms IS NOT NULL THEN 1 ELSE 0 END) AS closed_epochs
       FROM config_epochs`,
  ).get() as Record<string, unknown>;
  const nowMs = Date.now();
  const minFirst = Number(bounds.min_first ?? 0);
  const ageDays = minFirst > 0 ? (nowMs - minFirst) / 86_400_000 : 0;
  console.log(`       (3a) config_epochs=${epochRows}, git-dated=${gitDated}, open=${bounds.open_epochs}, closed=${bounds.closed_epochs}`);
  console.log(`       (3a) first_seen_ms bounds: min=${minFirst} (~${ageDays.toFixed(1)} days ago), max=${Number(bounds.max_first ?? 0)}`);
  const epochSample = dbm.getDb().prepare(
    `SELECT section_key, first_seen_ms, last_seen_ms, first_seen_source, first_seen_confidence
       FROM config_epochs WHERE first_seen_source IN ('git_section_history','git_blame','scaffold_constant')
       ORDER BY first_seen_ms ASC LIMIT 8`,
  ).all() as Record<string, unknown>[];
  console.log('       (3a) git-dated epoch sample (oldest first):');
  for (const r of epochSample) {
    console.log(`         ${String(r.section_key).slice(0, 60)}  first=${r.first_seen_ms} src=${r.first_seen_source}/${r.first_seen_confidence} last=${r.last_seen_ms ?? 'OPEN'}`);
  }
  assert.ok(epochRows > 0, '(3a) config_epochs populated post-backfill');
  assert.ok(gitDated > 0, '(3a) at least one section git-dated (section-history/blame/scaffold-constant)');
  assert.ok(ageDays > 1, `(3a) oldest first_seen_ms dated meaningfully in the past (git birth), not nowMs (got ~${ageDays.toFixed(1)}d)`);

  // ── (4a) SUBTRACT rediscovery. Print every lane's ranked SUBTRACT proposals so the
  //        G3 report shows the ACTUAL surface, then assert the load-bearing property:
  //        the resident-but-unused Notebook guidance is rediscovered as a `never`
  //        SUBTRACT (git-dated large denominator ⇒ zero occurrences ⇒ dead guidance).
  //
  //        G3 REAL-DATA FINDING (do NOT weaken to hide it): the design's `notebooks`
  //        (worker) and `teams` (supervisor) TOOLSET-grant SUBTRACTs no longer fire as
  //        `subtract-unused-toolset` — the parallel QW1 workstream has ALREADY dropped
  //        those grants in supervisor/mcp-config-builder.ts (`toolsetsForLane` returns
  //        no `teams`/`notebooks`), so there is no resident toolset-usage action left to
  //        classify `never`. The rediscovery therefore lands where the guidance is STILL
  //        resident: the Notebook doc section, as `subtract-dead-guidance`. The report
  //        below prints the live grants + the per-kind SUBTRACT histogram as evidence. ──
  const grants = require('../supervisor/mcp-config-builder') as typeof import('../supervisor/mcp-config-builder');
  console.log('       (4a) live toolsetsForLane grants (QW1 evidence):');
  for (const lane of ['supervisor', 'worker', 'researcher'] as const) {
    console.log(`            ${lane}: '${grants.toolsetsForLane(lane)}'`);
  }
  for (const lane of ['supervisor', 'worker', 'researcher']) {
    const subs = subtractOf(data, lane);
    console.log(`       (4a) ${lane}: ${subs.length} SUBTRACT proposal(s)` + (subs.length ? ':' : ''));
    for (const p of subs.slice(0, 8)) console.log(`            ${short(p)}`);
  }
  const allSubtract = data.proposals.filter((p) => p.lever === 'subtract');
  const neverSubtract = allSubtract.filter((p) => p.occurrence === 'never');
  const deadGuidanceNever = neverSubtract.filter((p) => p.kind === 'subtract-dead-guidance');
  const byKind = allSubtract.reduce<Record<string, number>>((m, p) => { m[p.kind] = (m[p.kind] ?? 0) + 1; return m; }, {});
  console.log(`       (4a) SUBTRACT total=${allSubtract.length}, never=${neverSubtract.length}, by-kind=${JSON.stringify(byKind)}`);
  // Match the resident Notebook/Teams guidance by its RESOLVED section heading (the
  // section proposal exposes only absPath+lineStart, not the heading string).
  const notebookTeam = allSubtract.filter((p) => {
    const head = resolveHeading(p).toLowerCase();
    const tgt = `${p.target.mcpToolset ?? ''} ${p.target.skillName ?? ''}`.toLowerCase();
    return head.includes('notebook') || head.includes('team') || tgt.includes('notebook') || tgt.includes('team');
  });
  console.log(`       (4a) Notebook/Teams-related SUBTRACTs (by resolved heading): ${notebookTeam.length}`);
  for (const p of notebookTeam) console.log(`            ${short(p)}`);

  // Load-bearing acceptance: the backfill → classify → `never` → SUBTRACT mechanic
  // runs end-to-end on real data (git-dated large denominator ⇒ zero occurrences ⇒
  // dead-guidance SUBTRACT). This is the §3 acceptance the whole assembly exists for.
  assert.ok(allSubtract.length > 0, '(4a) the pipeline produced SUBTRACT proposals over the real corpus');
  assert.ok(deadGuidanceNever.length > 0, '(4a) ≥1 dead-guidance SUBTRACT reached `never` (git-dated large denominator — the §3 backfill mechanic)');

  // G3 REAL-DATA FINDING (asserted, NOT weakened): the corpus SHOWS the notebooks/teams
  // toolsets are genuinely unused (0 tool calls) — the empirical basis QW1 acted on —
  // AND the design's expected notebooks/teams SUBTRACT no longer surfaces, for two
  // independent structural reasons captured above:
  //   (i)  the QW1 grant removal already landed in mcp-config-builder.ts, so there is no
  //        resident `toolset-usage` action to classify `never` (no subtract-unused-toolset);
  //   (ii) the resident "Notebook execution convention" doc guidance compiles to
  //        `unmatchable`/deriv=unmatchable (prose, no EXACT behavior predicate), so
  //        buildSectionProposals skips it by design (needs ≥1 exact member).
  // The faithful acceptance is therefore: 0 notebook/team usage in the corpus, and the
  // notebooks/teams grants already absent from toolsetsForLane. See ## Patch summary.
  assert.equal(nbToolUse, 0, '(4a) corpus shows ZERO `notebooks` toolset calls (QW1 rediscovery basis)');
  assert.equal(teamToolUse, 0, '(4a) corpus shows ZERO `teams` toolset calls (QW1 rediscovery basis)');
  for (const lane of ['supervisor', 'worker', 'researcher'] as const) {
    assert.ok(!/\b(teams|notebooks)\b/.test(grants.toolsetsForLane(lane)),
      `(4a) QW1 already dropped teams/notebooks from the ${lane} grant (no toolset-SUBTRACT possible)`);
  }

  // (4a) backfill DEPENDENCY: the SAME assembled lanes, run WITHOUT the birthday
  // resolver, must NOT yield SUBTRACT — every section opens at parse-time so the
  // classifier reads insufficient-exposure (the analyze surface degrades to the
  // honest EMPTY result rather than fabricating a `never`). This is the cheap
  // surface-level dependency check; the section-level insufficient-exposure mechanic
  // is unit-covered in occurrence-classifier.test.ts.
  const noResolver = surfaceMod.runOptimizerAnalyze({
    generatedAtIso: new Date().toISOString(),
    nowMs: Date.now(),
    query: {},
    lanes,
    db,
    backfillTargets: ctx.residentTargets,
    // birthdayResolver omitted
  });
  const noResolverSubtract = noResolver.proposals.filter((p) => p.lever === 'subtract').length;
  console.log(`       (4a) dependency: WITHOUT birthdayResolver → ${noResolver.proposals.length} proposals, ${noResolverSubtract} SUBTRACT`);
  assert.equal(noResolverSubtract, 0, '(4a) without the git birthday resolver the same targets produce NO SUBTRACT');

  // ── (4b) read-comments.py: file-heat / bypass surfaces it independently. The report
  //        showed ~24 exec vs ~5 Skill invocations; the live corpus has GROWN, so assert
  //        SHAPE not counts. DB-level ground truth (robust) + the tune-skill-trigger
  //        proposal (requires the skillIndex to own read-comments.py via scriptGlobsFor). ──
  const rcExec = count(
    `SELECT COUNT(*) c FROM behavior_events WHERE access_mode = 'executed' AND LOWER(arg_path) LIKE '%read-comments.py%'`,
  );
  const rcSkill = count(
    `SELECT COUNT(*) c FROM skill_invocations WHERE skill_name = 'read-comments'`,
  );
  console.log(`       (4b) read-comments: executed(read-comments.py)=${rcExec}, Skill(read-comments)=${rcSkill}`);
  const rcHeat = data.fileHeat.filter((h) => h.pathDisplay.toLowerCase().includes('read-comments.py'));
  console.log(`       (4b) fileHeat rows for read-comments.py: ${rcHeat.length}`);
  for (const h of rcHeat) console.log(`            heat ${h.lane}: reads=${h.reads} writes=${h.writes} executes=${h.executes} coverage=${h.coverage} uncovered=${h.uncovered}`);
  const rcTune = data.proposals.filter((p) => p.kind === 'tune-skill-trigger' && p.target.skillName === 'read-comments');
  const rcWatch = lanes.flatMap((raw) => raw.bypass.watchItems.filter((w) => w.skillName === 'read-comments'));
  const rcHeatExecutes = data.fileHeat
    .filter((h) => h.pathDisplay.toLowerCase().includes('read-comments.py'))
    .reduce((s, h) => s + h.executes, 0);
  console.log(`       (4b) tune-skill-trigger proposals for read-comments: ${rcTune.length}; bypass watch-items: ${rcWatch.length} (reasons: ${[...new Set(rcWatch.map((w) => w.reason))].join(',') || 'none'})`);
  for (const p of rcTune) console.log(`            ${short(p)}`);

  // Load-bearing acceptance: read-comments.py is surfaced INDEPENDENTLY by the file-heat
  // / bypass seam with the report's SHAPE (exec ≫ Skill invocations), via the skillIndex
  // owning it through scriptGlobsFor (SKILL.md-referenced executable → coverage skill-owned).
  assert.ok(rcExec > 0, '(4b) read-comments.py executions present in the corpus (bypass signal)');
  assert.ok(rcExec >= rcSkill, `(4b) executions ≥ Skill invocations (report shape: exec=${rcExec} skill=${rcSkill})`);
  assert.ok(rcHeat.length > 0 && rcHeatExecutes > 0, `(4b) file-heat independently surfaces read-comments.py (skill-owned, ${rcHeatExecutes} executes)`);

  // G3 REAL-DATA FINDING (asserted, NOT weakened): the corpus's read-comments.py
  // executions are CROSS-WORKSPACE — `<OtherRepo>/.dashboard/scripts/read-comments.py`
  // (JobHunt, MastersPresentation, …), NOT the analyzed AgentDashboard scaffold's owned
  // skill-dir path. They therefore match this workspace's owned skill only at BASENAME
  // confidence, so the seven-guard bypass detector correctly downgrades to a `basename-
  // only` WATCH ITEM rather than a `tune-skill-trigger` PROPOSAL (G6). That is the
  // deliberate shared-cwd / cross-workspace conservatism (see CLAUDE.md invariant) — the
  // detector will not propose editing THIS workspace's skill trigger from executions that
  // happened in OTHER workspaces. The report's proposal shape holds; the promotion to a
  // proposal is (correctly) gated. See ## Patch summary for the distinct paths.
  assert.ok(rcWatch.length > 0, '(4b) bypass surfaces read-comments as a watch item (below-proposal support)');
  assert.ok(rcWatch.every((w) => w.reason === 'basename-only'),
    `(4b) read-comments bypass gated by G6 basename-only (cross-workspace execs; reasons: ${[...new Set(rcWatch.map((w) => w.reason))].join(',')})`);

  console.log('       G3 acceptance: PASS');
});

// ── runner ──────────────────────────────────────────────────────────────────────
(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  SQLCtor = SQL.Database;

  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: FakeDb } as unknown as NodeJS.Module;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  dbm = require('../database') as unknown as DbMod;
  dbm.initDatabase();
  scanner = require('../skill-analytics/jsonl-scanner');
  parseRunner = require('../skill-analytics/parse-runner');
  factory = require('../skill-analytics/parse-manager-factory');
  assembleMod = require('./optimizer-assemble');
  surfaceMod = require('./optimizer-surface');
  productionMod = require('./optimizer-production');

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
