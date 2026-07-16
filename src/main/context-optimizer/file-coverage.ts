// file-coverage.ts — A1 coverage buckets + skill-bypass detector (WP5).
//
// Spec of record: plans/hardening-classifier-agent-surface.md §2.
//
// Runs AFTER the §5.1 compiler (guidance-action-model.ts): it consumes the
// compiler's `path-touch` PredictedActions plus a SkillOwnedIndex, and answers
// two questions about the paths agents actually touched (`behavior_events`):
//
//   1. COVERAGE — for each distinct touched path, which single bucket owns it
//      (strict precedence  ignored → scaffold-vendor → skill-owned →
//      config-referenced → uncovered). `uncovered`-hot files are the ADD signal.
//   2. SKILL-BYPASS — a skill-owned *script* EXECUTED outside its owning skill's
//      invocation window is a `tune-skill-trigger` candidate, behind seven guards
//      (G1..G7, §2.4). Below-support cases become watch items, never proposals.
//
// Pure + IO-free. Deterministic (stable ordering, no clocks, integer math). All
// DB access is the caller's job: the caller runs the §2.4 SQL / touch rollups and
// injects the rows here. This mirrors attribution.ts / occurrence-classifier.ts —
// a pure classifier over injected data with explicit dep seams.

import type { AgentRoleLane, PathRole, FileHeatScoreComponents } from '../../shared/types';
import type { MutabilityClass } from '../shared/path-mutability';
import type { PredictedAction } from './guidance-action-model';
import { sha256Hex } from './resident-inventory';
import {
  OPTIMIZER_CONFIG,
  SKILL_SCRIPT_EXTS,
  GENERIC_SCRIPT_NAMES,
  SYSTEM_FILE_COVERAGE_IGNORES,
} from './optimizer-config';

// ─────────────────────────────────────────────────────────────────────────────
// Types — SkillOwnedIndex (§2.1)
// ─────────────────────────────────────────────────────────────────────────────

/** One skill's ownership of scripts, the glob source of truth for the `skill-owned`
 *  bucket + the bypass detector (§2.1). Built once per WP5 pass from each lane's
 *  resolved skill inventory (the same enumeration P0 uses). Script-only: never
 *  `${skillRoot}/**` — docs/assets are heat-only `skill-owned-resource`. */
export interface SkillScriptOwnership {
  skillName: string;
  /** Normalized (LOWER, forward-slash — wp2b §4.3 path form). */
  skillRoot: string;
  /** Lanes that inherit this skill (a script exec only counts for these, G3). */
  lanes: AgentRoleLane[];
  /** classifyPathMutability(skillRoot). `generated-vendor` ⇒ trigger not ours to
   *  edit (G5): heat only, and the root wins `scaffold-vendor` over `skill-owned`. */
  mutable: MutabilityClass;
  /** Script-extension files + SKILL.md-referenced executables ONLY. Each a
   *  normalized exact resolved path (LOWER, forward-slash). */
  scriptGlobs: string[];
}

export type SkillOwnedIndex = SkillScriptOwnership[];

// ─────────────────────────────────────────────────────────────────────────────
// Types — ignore list (§2.5)
// ─────────────────────────────────────────────────────────────────────────────

/** An active `file_coverage_ignores` row (soft-delete: `disabledAtMs != null` ⇒
 *  ignored). Human-editable, retroactive at query time — the engine never auto-adds. */
export interface FileCoverageIgnore {
  pattern: string;                                 // normalized (LOWER, wp2b §4.3)
  patternKind: 'glob' | 'path-prefix' | 'exact-path';
  scope: 'global' | 'lane' | 'workspace';
  lane?: AgentRoleLane | null;
  workspaceSlug?: string | null;
  disabledAtMs?: number | null;                    // soft-delete: non-null ⇒ inactive
}

// ─────────────────────────────────────────────────────────────────────────────
// Types — touch input + coverage output (§2.2 / §2.3)
// ─────────────────────────────────────────────────────────────────────────────

export type CoverageBucket =
  | 'ignored'
  | 'scaffold-vendor'
  | 'skill-owned'
  | 'skill-owned-resource'
  | 'config-referenced'
  | 'uncovered';

/** How firmly a touched path was tied to an owned script (§2.2 rule 3 / G6). Only
 *  `exact`/`suffix` are proposal-eligible; `basename` is heat-only. */
export type MatchConfidence = 'exact' | 'suffix' | 'basename';

/** One distinct touched path's read/write/execute rollup for a lane (the caller
 *  produces this from `behavior_events` JOIN `stream_lane_stats`, grouped by
 *  `LOWER(arg_path)`). `path` is already normalized (LOWER, forward-slash). */
export interface FileTouch {
  path: string;
  reads: number;
  writes: number;
  executes: number;
  distinctStreams: number;
}

/** One row of the file-heat rollup (§2.3). `pathDisplay`/`pathScope` redaction is a
 *  WP7 (agent-dto) concern; here `pathDisplay` carries the normalized path and
 *  `pathHash` its sha256 so downstream can redact without re-deriving. */
export interface FileHeatEntry {
  pathDisplay: string;
  pathHash: string;
  coverage: CoverageBucket;
  reads: number;
  writes: number;
  executes: number;
  distinctStreams: number;
  matchConfidence?: MatchConfidence;
  // ── WP-4A (Phase 4) — role classification + canonical score (spec 260-273). ──
  /** Repository-relative path role (spec 260-271), classified before coverage. */
  role?: PathRole;
  /** WHY this role was chosen — one explainable clause (spec risk 2). */
  roleReason?: string;
  /** Low-value operational role (build-generated / dependency-or-vendor / test-or-fixture):
   *  kept in diagnostics, excluded from the DEFAULT hot-files view (spec 271). */
  operationalNoise?: boolean;
  /** The ONE canonical heat score (spec 273) — the SAME value engine + DTO sort by. */
  score?: number;
  /** Raw components behind `score`. */
  scoreComponents?: FileHeatScoreComponents;
  /** Met the guidance-gap-candidate bar: uncovered ∧ workflow-level artifact ∧ repeated
   *  cross-stream activity (spec 273). A strict subset of `uncovered`. */
  guidanceGapCandidate?: boolean;
}

export interface FileCoverageResult {
  lane: AgentRoleLane;
  fileHeat: FileHeatEntry[];                        // top-N, deterministically sorted
  bucketCounts: Record<CoverageBucket, number>;
  /** ADD-candidate signal: uncovered paths, hottest first (subset of fileHeat). */
  uncoveredHot: FileHeatEntry[];
  // ── WP-4A (Phase 4) additive disclosure counts (never delete rows — spec 271).
  //    Optional so pre-Phase-4 fixtures still satisfy the type; classifyFileCoverage
  //    always populates them. ──
  /** Rows in `fileHeat` tagged operational-noise (excluded from the default view). */
  operationalNoiseCount?: number;
  /** Rows in `fileHeat` meeting the guidance-gap-candidate bar (spec 273). */
  guidanceGapCandidateCount?: number;
}

export interface ClassifyDeps {
  /** absPath → mutability (WP0 path-mutability). Injected for purity/testability.
   *  Called with the normalized touch path. */
  classifyPathMutability: (absPath: string) => MutabilityClass;
  /** Is a config epoch OPEN (config_epochs.last_seen_ms IS NULL)? A closed/removed
   *  reference must NOT create a config-referenced umbrella (§2.2 rule 4). Default:
   *  a resolved (non-empty) epoch id is treated as open; an unresolved ('') id is
   *  NOT open (honest — we can't confirm coverage). */
  isOpenEpoch?: (epochId: string) => boolean;
  /** Top-N cap for the file-heat rollup. Defaults to OPTIMIZER_CONFIG.FILE_HEAT_TOP_N. */
  topN?: number;
  /** WP-4A — optional workspace/dashboard roots that ENABLE the `external` role (a path
   *  under none of the known roots is another project's file). Absent ⇒ `external` is
   *  never emitted (Step-1 workspace scoping already drops cross-project rows). */
  workspaceRoot?: string;
  dashboardRoot?: string;
  homeDir?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Glob / path helpers (deterministic)
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize a path to the wp2b §4.3 comparison form: lowercase, backslashes →
 *  forward slashes, collapse repeated slashes, strip a trailing slash. */
export function normPath(p: string): string {
  return p
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

/** Translate a glob (supporting `**`, `*`, `?`, and `{a,b}` alternation) into an
 *  anchored RegExp against normalized (lowercased, forward-slash) paths. */
function globToRegExp(glob: string): RegExp {
  const g = normPath(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**` — any chars including slash. Swallow an optional following slash so
        // `a/**/b` also matches `a/b`.
        i++;
        if (g[i + 1] === '/') i++;
        re += '.*';
      } else {
        re += '[^/]*';                               // `*` — any chars except slash
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const close = g.indexOf('}', i);
      if (close === -1) { re += '\\{'; continue; }
      const alts = g.slice(i + 1, close).split(',').map(escapeRe).join('|');
      re += `(?:${alts})`;
      i = close;
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(`^${re}$`);
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does `path` match a single glob pattern? (normalized both sides). */
export function globMatch(glob: string, path: string): boolean {
  return globToRegExp(glob).test(normPath(path));
}

const SYSTEM_IGNORE_RES: RegExp[] = SYSTEM_FILE_COVERAGE_IGNORES.map(globToRegExp);

function basenameOf(path: string): string {
  const n = normPath(path);
  const slash = n.lastIndexOf('/');
  return slash === -1 ? n : n.slice(slash + 1);
}
function stemOf(basename: string): string {
  const dot = basename.lastIndexOf('.');
  return dot <= 0 ? basename : basename.slice(0, dot);
}
function hasScriptExt(path: string): boolean {
  const b = basenameOf(path);
  return SKILL_SCRIPT_EXTS.some((e) => b.endsWith(e));
}

// ─────────────────────────────────────────────────────────────────────────────
// SkillOwnedIndex construction helper (§2.1)
// ─────────────────────────────────────────────────────────────────────────────

/** Given a skill's root, the enumerated files under it, and the executable paths
 *  referenced in SKILL.md command/code spans, compute the script-only `scriptGlobs`:
 *  script-extension files (excluding SKILL.md, docs, tests, fixtures, and any
 *  SYSTEM_FILE_COVERAGE_IGNORES match) PLUS the SKILL.md-referenced executables,
 *  each normalized. Non-script files under the root are intentionally omitted (they
 *  are heat-only `skill-owned-resource`). Deterministic: sorted + de-duped. */
export function scriptGlobsFor(input: {
  skillRoot: string;
  filesUnderRoot: string[];
  skillMdReferencedExecutables?: string[];
}): string[] {
  const root = normPath(input.skillRoot);
  const out = new Set<string>();
  for (const f of input.filesUnderRoot) {
    const n = normPath(f);
    const base = basenameOf(n);
    if (base === 'skill.md') continue;                     // never the manifest
    if (!hasScriptExt(n)) continue;                        // script-extension only
    if (SYSTEM_IGNORE_RES.some((re) => re.test(n))) continue;
    if (/(^|\/)(tests?|__tests__|fixtures?)\//.test(n)) continue;
    out.add(n);
  }
  for (const exe of input.skillMdReferencedExecutables ?? []) {
    // Resolve relative to skillRoot when not already absolute-ish.
    const n = normPath(exe);
    out.add(n.startsWith(root) || n.startsWith('/') ? n : normPath(`${root}/${exe}`));
  }
  return [...out].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// WP-4A (Phase 4) — path-role classification + canonical heat score (spec 260-273)
// ─────────────────────────────────────────────────────────────────────────────

/** The ONE canonical heat score (spec 273): executes and writes weigh heavier than
 *  reads (matching the engine's old executes→writes→reads intent), collapsed to a
 *  single integer BOTH the engine sort and the DTO sort use — killing the prior
 *  engine-vs-DTO disagreement. Integer math ⇒ byte-deterministic. */
export function canonicalHeatScore(c: FileHeatScoreComponents): number {
  return c.executes * 3 + c.writes * 2 + c.reads;
}

/** Low-value roles excluded from the DEFAULT hot-files view (kept in diagnostics). */
const OPERATIONAL_NOISE_ROLES: ReadonlySet<PathRole> = new Set<PathRole>([
  'build-generated', 'dependency-or-vendor', 'test-or-fixture',
]);

export function isOperationalNoiseRole(role: PathRole): boolean {
  return OPERATIONAL_NOISE_ROLES.has(role);
}

export interface PathRoleDeps {
  classifyPathMutability: (absPath: string) => MutabilityClass;
  /** Skills visible to this lane make a path `skill-owned`. Optional. */
  skillIndex?: SkillOwnedIndex;
  lane?: AgentRoleLane;
  /** Roots that enable the `external` role (see ClassifyDeps). */
  workspaceRoot?: string;
  dashboardRoot?: string;
  homeDir?: string;
}

export interface PathRoleVerdict {
  role: PathRole;
  reason: string;
}

const BUILD_GENERATED_SEG = /(^|\/)(dist|build|out|coverage|\.next|\.turbo|\.cache|caches|__pycache__)\//;
const VENDOR_SEG = /(^|\/)(node_modules|vendor|site-packages|\.venv|bower_components)\//;
const TEST_SEG = /(^|\/)(__tests__|tests?|spec|fixtures?|__fixtures__|__mocks__|__snapshots__)\//;
const SKILLS_SEG = /(^|\/)(\.claude|\.dashboard)\/.*(^|\/)?skills\//;
const SOURCE_EXTS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.php',
  '.scala', '.sh', '.bash', '.zsh', '.ps1', '.lua', '.r', '.pl', '.vue', '.svelte', '.sql',
];
const CONFIG_EXTS = ['.md', '.yaml', '.yml', '.json', '.toml', '.ini', '.cfg', '.conf', '.config', '.env'];
const CONFIG_DOTFILES = /^\.(gitignore|gitattributes|npmrc|nvmrc|editorconfig|eslintrc.*|prettierrc.*|babelrc.*|dockerignore)$/;

/** Is `n` (normalized) a descendant of `root` (normalized)? */
function underNormRoot(n: string, root: string | undefined): boolean {
  if (!root) return false;
  const r = normPath(root);
  return n === r || n.startsWith(`${r}/`);
}

function looksAbsolute(n: string): boolean {
  return n.startsWith('/') || /^[a-z]:\//.test(n);
}

/** Classify a touched path into ONE repository-relative role BEFORE coverage (spec
 *  260-271). Each verdict carries an explainable `reason` (spec risk 2). Precedence
 *  is first-match; the caller derives `operationalNoise` from the role. Pure. */
export function classifyPathRole(path: string, deps: PathRoleDeps): PathRoleVerdict {
  const n = normPath(path);
  const b = basenameOf(n);

  // 1. build-generated — compiled/output trees + source maps + minified bundles.
  if (BUILD_GENERATED_SEG.test(n)) {
    const seg = BUILD_GENERATED_SEG.exec(n)?.[2] ?? 'generated';
    return { role: 'build-generated', reason: `under a '${seg}/' build-output tree` };
  }
  if (b.endsWith('.map')) return { role: 'build-generated', reason: 'a source map (.map)' };
  if (/\.min\.[^/]+$/.test(b)) return { role: 'build-generated', reason: 'a minified bundle (.min.*)' };

  // 2. dependency-or-vendor — third-party trees, lockfiles, and generated-vendor mutability.
  if (VENDOR_SEG.test(n)) {
    const seg = VENDOR_SEG.exec(n)?.[2] ?? 'vendor';
    return { role: 'dependency-or-vendor', reason: `under a '${seg}/' dependency tree` };
  }
  if (/-lock\.(json|yaml)$/.test(b) || b === 'yarn.lock' || b === 'package-lock.json' || b === 'pnpm-lock.yaml') {
    return { role: 'dependency-or-vendor', reason: 'a dependency lockfile' };
  }
  if (deps.classifyPathMutability(n) === 'generated-vendor') {
    return { role: 'dependency-or-vendor', reason: 'generated-vendor path mutability (plugin/cache)' };
  }

  // 3. skill-owned — under a lane-visible skill root, or a `.claude`/`.dashboard` skills tree.
  const laneSkills = (deps.skillIndex ?? []).filter((s) => !deps.lane || s.lanes.includes(deps.lane!));
  const owningSkill = laneSkills.find((s) => underNormRoot(n, s.skillRoot));
  if (owningSkill) return { role: 'skill-owned', reason: `under skill root '${owningSkill.skillName}'` };
  if (SKILLS_SEG.test(n)) return { role: 'skill-owned', reason: 'under a `.claude`/`.dashboard` skills tree' };

  // 4. external — another project's file (only when a workspace root is known to compare against).
  if (deps.workspaceRoot && looksAbsolute(n)
      && !underNormRoot(n, deps.workspaceRoot)
      && !underNormRoot(n, deps.dashboardRoot)
      && !underNormRoot(n, deps.homeDir)) {
    return { role: 'external', reason: 'outside the analyzed workspace/dashboard/home roots' };
  }

  // 5. test-or-fixture — test/fixture directories or `*.test.*` / `*.spec.*` basenames.
  if (TEST_SEG.test(n)) {
    const seg = TEST_SEG.exec(n)?.[2] ?? 'tests';
    return { role: 'test-or-fixture', reason: `under a '${seg}/' test/fixture tree` };
  }
  if (/\.(test|spec)\.[^/]+$/.test(b)) return { role: 'test-or-fixture', reason: 'a `*.test.*` / `*.spec.*` file' };

  // 6. guidance-or-config — docs/config the workflow reads (CLAUDE.md, *.md, config exts, dotfiles).
  if (CONFIG_DOTFILES.test(b)) return { role: 'guidance-or-config', reason: `a config dotfile ('${b}')` };
  if (b === 'claude.md' || b === 'agents.md') return { role: 'guidance-or-config', reason: `agent guidance ('${b}')` };
  const cfgExt = CONFIG_EXTS.find((e) => b.endsWith(e));
  if (cfgExt) return { role: 'guidance-or-config', reason: `a ${cfgExt} guidance/config file` };

  // 7. product-source — recognized source-code extension the user authors.
  const srcExt = SOURCE_EXTS.find((e) => b.endsWith(e));
  if (srcExt) return { role: 'product-source', reason: `a ${srcExt} source file` };

  // 8. unknown — no rule matched (honest residual).
  return { role: 'unknown', reason: 'no role rule matched' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bucket classification (§2.2)
// ─────────────────────────────────────────────────────────────────────────────

interface BucketVerdict {
  bucket: CoverageBucket;
  matchConfidence?: MatchConfidence;
}

/** Match a touched path against a skill's `scriptGlobs`: exact resolved path (a),
 *  path-suffix `…/<skill-rel>/name.ext` (b), or basename-only (c, allowed only when
 *  the stem ∉ GENERIC_SCRIPT_NAMES and length ≥ 4). Returns the strongest match. */
function matchOwnedScript(path: string, skill: SkillScriptOwnership): MatchConfidence | null {
  const n = normPath(path);
  let best: MatchConfidence | null = null;
  for (const g of skill.scriptGlobs) {
    if (n === g) return 'exact';                           // (a) — strongest, short-circuit
    if (n.endsWith(`/${g}`) || g.endsWith(`/${n}`)) { best = best ?? 'suffix'; continue; } // (b)
    // suffix by shared trailing segments: `…/read-comments/read.py` vs g `…/read.py`
    const gb = basenameOf(g);
    const nb = basenameOf(n);
    if (gb === nb) {
      const stem = stemOf(nb);
      const generic = (GENERIC_SCRIPT_NAMES as readonly string[]).includes(stem);
      if (!generic && stem.length >= 4 && best === null) best = 'basename';         // (c)
    }
  }
  return best;
}

/** Is a path under a skill root? (prefix on normalized paths, slash-boundary safe). */
function underRoot(path: string, root: string): boolean {
  const n = normPath(path);
  const r = normPath(root);
  return n === r || n.startsWith(`${r}/`);
}

function isIgnored(path: string, lane: AgentRoleLane, ignores: FileCoverageIgnore[]): boolean {
  const n = normPath(path);
  for (const ig of ignores) {
    if (ig.disabledAtMs != null) continue;                 // soft-deleted → inactive
    if (ig.scope === 'lane' && ig.lane && ig.lane !== lane) continue;
    // workspace-scope filtering is the caller's responsibility (it knows the slug);
    // rows reaching here already apply to this lane/workspace.
    const p = normPath(ig.pattern);
    const hit =
      ig.patternKind === 'glob' ? globMatch(p, n)
      : ig.patternKind === 'path-prefix' ? (n === p || n.startsWith(`${p}/`))
      : /* exact-path */ n === p;
    if (hit) return true;
  }
  return false;
}

/** Classify one touched path into exactly one bucket, strict precedence (§2.2). */
export function classifyPathBucket(
  path: string,
  lane: AgentRoleLane,
  predictedActions: PredictedAction[],
  skillIndex: SkillOwnedIndex,
  ignores: FileCoverageIgnore[],
  deps: ClassifyDeps,
): BucketVerdict {
  const n = normPath(path);
  const isOpenEpoch = deps.isOpenEpoch ?? ((id: string) => id !== '');

  // 1. ignored
  if (isIgnored(n, lane, ignores)) return { bucket: 'ignored' };

  // Skills visible to this lane, split by vendored-ness.
  const laneSkills = skillIndex.filter((s) => s.lanes.includes(lane));

  // 2. scaffold-vendor — generated-vendor path, OR under a vendored skill root.
  //    Precedes skill-owned so a plugin/vendored skill script never reads as tunable.
  if (deps.classifyPathMutability(n) === 'generated-vendor') return { bucket: 'scaffold-vendor' };
  const vendoredSkill = laneSkills.find(
    (s) => s.mutable === 'generated-vendor' && underRoot(n, s.skillRoot),
  );
  if (vendoredSkill) return { bucket: 'scaffold-vendor' };

  // 3. skill-owned — matches a (non-vendored) skill's scriptGlobs; else a non-script
  //    file under a non-vendored skill root → skill-owned-resource (heat only).
  const editableSkills = laneSkills.filter((s) => s.mutable !== 'generated-vendor');
  let bestScript: MatchConfidence | null = null;
  for (const s of editableSkills) {
    const m = matchOwnedScript(n, s);
    if (m === 'exact') { bestScript = 'exact'; break; }
    if (m && (bestScript === null || (m === 'suffix' && bestScript === 'basename'))) bestScript = m;
  }
  if (bestScript) return { bucket: 'skill-owned', matchConfidence: bestScript };
  const underEditableRoot = editableSkills.some((s) => underRoot(n, s.skillRoot));
  if (underEditableRoot) return { bucket: 'skill-owned-resource' };

  // 4. config-referenced — glob-matches an EXACT + open-epoch path-touch action
  //    whose lanes include this lane.
  const covered = predictedActions.some(
    (a) =>
      a.kind === 'path-touch' &&
      a.derivability === 'exact' &&
      a.lanes.includes(lane) &&
      isOpenEpoch(a.sourceEpochId) &&
      typeof a.params.pathGlob === 'string' &&
      globMatch(a.params.pathGlob, n),
  );
  if (covered) return { bucket: 'config-referenced' };

  // 5. uncovered — residual (the ADD-candidate signal).
  return { bucket: 'uncovered' };
}

// ─────────────────────────────────────────────────────────────────────────────
// File-coverage rollup (§2.2 + §2.3)
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_BUCKETS = (): Record<CoverageBucket, number> => ({
  ignored: 0,
  'scaffold-vendor': 0,
  'skill-owned': 0,
  'skill-owned-resource': 0,
  'config-referenced': 0,
  uncovered: 0,
});

/** Heat sort: canonical score DESC → distinctStreams DESC → pathDisplay ASC (stable,
 *  byte-deterministic). WP-4A: the primary key is the ONE canonical score so this
 *  engine sort and the DTO sort agree (spec 273). */
function heatCmp(a: FileHeatEntry, b: FileHeatEntry): number {
  const sa = a.score ?? canonicalHeatScore(a);
  const sb = b.score ?? canonicalHeatScore(b);
  return (
    sb - sa ||
    b.distinctStreams - a.distinctStreams ||
    (a.pathDisplay < b.pathDisplay ? -1 : a.pathDisplay > b.pathDisplay ? 1 : 0)
  );
}

/** Classify every touched path for a lane into a bucket and roll up the file-heat.
 *  `ignored` paths are dropped from the rollup (raw events remain in the DB). */
export function classifyFileCoverage(
  lane: AgentRoleLane,
  touches: FileTouch[],
  predictedActions: PredictedAction[],
  skillIndex: SkillOwnedIndex,
  ignores: FileCoverageIgnore[],
  deps: ClassifyDeps,
): FileCoverageResult {
  const topN = deps.topN ?? OPTIMIZER_CONFIG.FILE_HEAT_TOP_N;
  const bucketCounts = EMPTY_BUCKETS();
  const heat: FileHeatEntry[] = [];
  const roleDeps: PathRoleDeps = {
    classifyPathMutability: deps.classifyPathMutability,
    skillIndex, lane,
    workspaceRoot: deps.workspaceRoot,
    dashboardRoot: deps.dashboardRoot,
    homeDir: deps.homeDir,
  };

  for (const t of touches) {
    const v = classifyPathBucket(t.path, lane, predictedActions, skillIndex, ignores, deps);
    bucketCounts[v.bucket]++;
    if (v.bucket === 'ignored') continue;               // dropped from fileHeat + bypass
    // WP-4A: classify role (before coverage), score canonically, flag noise + gap.
    const role = classifyPathRole(t.path, roleDeps);
    const scoreComponents: FileHeatScoreComponents = {
      reads: t.reads, writes: t.writes, executes: t.executes, distinctStreams: t.distinctStreams,
    };
    const operationalNoise = isOperationalNoiseRole(role.role);
    // Guidance-gap bar (spec 273): uncovered ∧ workflow-level artifact (guidance/config,
    // never arbitrary source/test) ∧ repeated cross-stream activity.
    const guidanceGapCandidate =
      v.bucket === 'uncovered' &&
      !operationalNoise &&
      role.role === 'guidance-or-config' &&
      t.distinctStreams >= OPTIMIZER_CONFIG.REPEAT_MIN_STREAMS &&
      t.reads + t.writes + t.executes >= OPTIMIZER_CONFIG.REPEAT_MIN;
    heat.push({
      pathDisplay: normPath(t.path),
      pathHash: sha256Hex(normPath(t.path)),
      coverage: v.bucket,
      reads: t.reads,
      writes: t.writes,
      executes: t.executes,
      distinctStreams: t.distinctStreams,
      ...(v.matchConfidence ? { matchConfidence: v.matchConfidence } : {}),
      role: role.role,
      roleReason: role.reason,
      operationalNoise,
      score: canonicalHeatScore(scoreComponents),
      scoreComponents,
      guidanceGapCandidate,
    });
  }

  heat.sort(heatCmp);
  const fileHeat = heat.slice(0, topN);
  const uncoveredHot = fileHeat.filter((h) => h.coverage === 'uncovered');
  const operationalNoiseCount = fileHeat.filter((h) => h.operationalNoise).length;
  const guidanceGapCandidateCount = fileHeat.filter((h) => h.guidanceGapCandidate).length;
  return { lane, fileHeat, bucketCounts, uncoveredHot, operationalNoiseCount, guidanceGapCandidateCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill-bypass detector (§2.4) — the seven guards G1..G7
// ─────────────────────────────────────────────────────────────────────────────

/** One `access_mode='executed'` `behavior_events` row for a skill-owned script.
 *  The caller runs the §2.4 SQL (already exec-filtered + lane-joined) and injects
 *  these rows; the detector re-applies the guards defensively. */
export interface BypassExecEvent {
  streamId: string;
  tsMs: number;
  path: string;                                    // normalized (LOWER, forward-slash)
  lane: AgentRoleLane;
  subAgentName: string | null;
  /** access_mode — only 'executed' is a bypass candidate (G1). */
  accessMode: 'read' | 'write' | 'executed';
  /** arg_path confidence — only exact/normalized qualify (G1). */
  argPathConfidence: 'exact' | 'normalized' | 'heuristic' | 'unknown';
}

/** A `skill_invocations` window (Gap-A ts bounds) — the legitimate-invocation span
 *  an exec must fall OUTSIDE of to be a bypass (G2). */
export interface SkillInvocationWindow {
  streamId: string;
  skillName: string;
  lane: AgentRoleLane;
  startTsMs: number;
  endTsMs: number;
}

/** Per-(lane, skill) exposure — the min-exposure gate in G7. */
export interface SkillLaneExposure {
  skillName: string;
  lane: AgentRoleLane;
  exposureTurns: number;
}

export interface BypassDeps {
  execEvents: BypassExecEvent[];
  windows: SkillInvocationWindow[];
  exposures: SkillLaneExposure[];
}

export interface BypassProposal {
  kind: 'tune-skill-trigger';
  skillName: string;
  lane: AgentRoleLane;
  scriptPath: string;
  matchConfidence: 'exact' | 'suffix';
  execCount: number;
  execStreams: number;
  skillStreams: number;
  /** Executing streams cited as evidence (sorted, deterministic). */
  citedStreams: string[];
  /** Subagent execs excluded from the count (G4), surfaced as a card note. */
  disclosedSubagentExecs: number;
  triggerMutability: MutabilityClass;
  /** Direct behavior, not compiler-derived → the parity gate does not govern it (§4.5). */
  requiresDerivationGate: false;
}

export type BypassWatchReason =
  | 'below-support'
  | 'basename-only'
  | 'vendored-trigger'
  | 'insufficient-exposure';

export interface BypassWatchItem {
  skillName: string;
  lane: AgentRoleLane;
  scriptPath: string;
  reason: BypassWatchReason;
  execCount: number;
  execStreams: number;
  skillStreams: number;
  disclosedSubagentExecs: number;
  matchConfidence: MatchConfidence;
}

export interface BypassResult {
  proposals: BypassProposal[];
  watchItems: BypassWatchItem[];
}

/** Does any invocation window on the same stream contain the exec ts? (G2). */
function insideWindow(ev: BypassExecEvent, skill: string, windows: SkillInvocationWindow[]): boolean {
  return windows.some(
    (w) =>
      w.streamId === ev.streamId &&
      w.skillName === skill &&
      ev.tsMs >= w.startTsMs &&
      ev.tsMs <= w.endTsMs,
  );
}

/** Detect skill-bypass proposals + watch items for a lane. One (skill, script)
 *  pair yields at most one proposal OR one watch item. */
export function detectSkillBypass(
  lane: AgentRoleLane,
  skillIndex: SkillOwnedIndex,
  deps: BypassDeps,
): BypassResult {
  const proposals: BypassProposal[] = [];
  const watchItems: BypassWatchItem[] = [];
  const cfg = OPTIMIZER_CONFIG;

  // Only skills visible to this lane (G3 at the skill level).
  const laneSkills = skillIndex.filter((s) => s.lanes.includes(lane));

  for (const skill of laneSkills) {
    // Legitimate-invocation streams for this skill in this lane (skillStreams denom).
    const skillStreams = new Set(
      deps.windows
        .filter((w) => w.skillName === skill.skillName && w.lane === lane)
        .map((w) => w.streamId),
    ).size;

    const exposure =
      deps.exposures.find((e) => e.skillName === skill.skillName && e.lane === lane)?.exposureTurns ?? 0;

    for (const script of skill.scriptGlobs) {
      // Collect exec events that match THIS script path, applying guards.
      let execCount = 0;
      let disclosedSubagentExecs = 0;
      const execStreamSet = new Set<string>();
      let matchConfidence: MatchConfidence | null = null;

      for (const ev of deps.execEvents) {
        // G3 lane scope — only this lane's streams.
        if (ev.lane !== lane) continue;
        // G1 executed-only + confident path.
        if (ev.accessMode !== 'executed') continue;
        if (ev.argPathConfidence !== 'exact' && ev.argPathConfidence !== 'normalized') continue;
        // Match the exec path to this owned script (exact/suffix/basename).
        const m = matchOwnedScript(ev.path, { ...skill, scriptGlobs: [script] });
        if (!m) continue;
        if (matchConfidence === null || (m === 'exact') || (m === 'suffix' && matchConfidence === 'basename')) {
          matchConfidence = m;
        }
        // G2 window exclusion — inside a legit window ⇒ expected, not a bypass.
        if (insideWindow(ev, skill.skillName, deps.windows)) continue;
        // G4 subagent exclusion — count separately, never in the proposal count.
        if (ev.subAgentName !== null) { disclosedSubagentExecs++; continue; }
        execCount++;
        execStreamSet.add(ev.streamId);
      }

      if (execCount === 0 && disclosedSubagentExecs === 0) continue;   // this script untouched
      const execStreams = execStreamSet.size;
      const conf = matchConfidence ?? 'basename';

      const watch = (reason: BypassWatchReason): void => {
        watchItems.push({
          skillName: skill.skillName,
          lane,
          scriptPath: script,
          reason,
          execCount,
          execStreams,
          skillStreams,
          disclosedSubagentExecs,
          matchConfidence: conf,
        });
      };

      // G5 trigger mutability — a vendored skill's trigger isn't ours to edit.
      if (skill.mutable === 'generated-vendor') { watch('vendored-trigger'); continue; }
      // G6 match confidence — basename-only is heat, never a proposal.
      if (conf === 'basename') { watch('basename-only'); continue; }
      // G7 min-support flood guard.
      const ratioOk =
        skillStreams === 0
          ? execStreams >= cfg.BYPASS_MIN_EXEC_STREAMS_WHEN_ZERO_SKILL_CALLS
          : execStreams / skillStreams >= cfg.BYPASS_MIN_RATIO_WITH_SKILL_CALLS;
      const supported =
        execCount >= cfg.BYPASS_MIN_EXECUTIONS &&
        execStreams >= cfg.BYPASS_MIN_EXEC_STREAMS &&
        execStreams >= skillStreams + cfg.BYPASS_MIN_STREAM_DELTA_OVER_SKILL &&
        ratioOk;
      if (!supported) { watch('below-support'); continue; }
      // Exposure floor — else insufficient-exposure, no proposal.
      if (exposure < OPTIMIZER_CONFIG.MIN_EXPOSURE_TURNS) { watch('insufficient-exposure'); continue; }

      proposals.push({
        kind: 'tune-skill-trigger',
        skillName: skill.skillName,
        lane,
        scriptPath: script,
        matchConfidence: conf,
        execCount,
        execStreams,
        skillStreams,
        citedStreams: [...execStreamSet].sort(),
        disclosedSubagentExecs,
        triggerMutability: skill.mutable,
        requiresDerivationGate: false,
      });
    }
  }

  // Deterministic ordering.
  proposals.sort(
    (a, b) =>
      b.execStreams - a.execStreams ||
      b.execCount - a.execCount ||
      (a.skillName < b.skillName ? -1 : a.skillName > b.skillName ? 1 : 0) ||
      (a.scriptPath < b.scriptPath ? -1 : a.scriptPath > b.scriptPath ? 1 : 0),
  );
  watchItems.sort(
    (a, b) =>
      (a.skillName < b.skillName ? -1 : a.skillName > b.skillName ? 1 : 0) ||
      (a.scriptPath < b.scriptPath ? -1 : a.scriptPath > b.scriptPath ? 1 : 0) ||
      (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
  );
  return { proposals, watchItems };
}
