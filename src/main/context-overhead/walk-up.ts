// Context-Overhead Analyzer — pure walk-up + @import extraction (plan §2.2 / §3).
//
// Split out of the orchestrator so the import parser and the ancestor walk are
// unit-tested directly. Electron-free + side-effect-free: all IO is injected via
// `FileReader`, all path math via `PathOps`. The algorithm mirrors the
// legitimacy report §1.1–1.5 (walk to filesystem root, user/managed pseudo-
// frames at NEGATIVE distance, @import ≤4 hops, --add-dir gated by env var).

import type {
  InheritanceFrame,
  InheritanceScope,
  OverheadSource,
  OverheadSourceKind,
} from '../../shared/types';
import { extractClaudeImports } from '../shared/claude-import-resolver';
import { splitFrontmatter } from '../shared/frontmatter-split';
import { classifyPathMutability } from '../shared/path-mutability';
import type { FileReader } from './context-overhead-analyzer';
import type { PathOps } from './paths';
import type { TokenEstimator } from './token-estimator';

export interface WalkUpDeps {
  reader: FileReader;
  estimator: TokenEstimator;
  pathOps: PathOps;
  userHome: string;
  managedPolicyPath: string | null;
  additionalDirs?: string[];
  env: Record<string, string | undefined>;
  /** Per-scan memo of resolved-path → built source, so overlapping ancestors are
   *  read + estimated once. Shared with the analyzer's MCP-free passes. */
  seen?: Set<string>;
}

const IMPORT_MAX_DEPTH = 4;

// `@import` extraction now lives in the shared `claude-import-resolver` module
// (base plan §3.2) and is imported above — walk-up no longer carries a private
// byte-identical copy.

// ── source construction ──────────────────────────────────────────────────────

function kindForCandidate(rel: string, isAgentLevel: boolean): OverheadSourceKind {
  const lower = rel.toLowerCase();
  if (lower.endsWith('claude.local.md')) return 'claude-local';
  if (lower.endsWith('claude.md')) return isAgentLevel ? 'agent-claude' : 'inherited-claude';
  if (lower.includes('/rules/')) return 'rules';
  if (lower.endsWith('memory/memory.md')) return 'memory';
  if (lower.endsWith('behavioral.md')) return 'behavioral';
  if (lower.endsWith('settings.json')) return 'settings-hooks';
  if (lower.endsWith('skill.md')) return 'skill';
  return 'unknown';
}

function relLabel(ops: PathOps, dir: string, resolved: string): string {
  const base = ops.resolve(dir);
  if (ops.isWithin(resolved, base) && resolved !== base) {
    const prefix = base.endsWith('/') ? base : `${base}/`;
    return resolved.slice(prefix.length);
  }
  const idx = resolved.lastIndexOf('/');
  return idx >= 0 ? resolved.slice(idx + 1) : resolved;
}

function buildSource(
  deps: WalkUpDeps,
  resolved: string,
  kind: OverheadSourceKind,
  label: string,
  scope: InheritanceScope,
  inherited: boolean,
  origin: OverheadSource['origin'] = 'walk-up',
): OverheadSource {
  const file = deps.reader.read(resolved);
  const exists = file !== null;
  const estimate = exists
    ? deps.estimator.estimate(file!.content)
    : deps.estimator.estimate('');
  return {
    id: `${resolved}#${kind}`,
    kind,
    label,
    resolvedPath: resolved,
    dedupeKey: resolved,
    sourceScope: scope,
    openable: exists, // all candidate kinds are viewable text/JSON files
    exists,
    inherited,
    estimate,
    origin,
    mutable: classifyPathMutability(resolved),
    disclosureTier: 'resident', // generic config surfaces are injected each session
    children: [],
    warnings: [],
  };
}

/** Split a SKILL.md into two costed sources (P1.1): a `skill-header`
 *  (resident YAML frontmatter, always-on baseline) and a `skill-body`
 *  (on-invoke body, scenario overlay). Both carry the same `resolvedPath` so
 *  clicking either opens the file; `@import` resolution attaches to the body. */
function buildSkillSources(
  deps: WalkUpDeps,
  resolved: string,
  label: string,
  scope: InheritanceScope,
  inherited: boolean,
): OverheadSource[] {
  const file = deps.reader.read(resolved);
  const exists = file !== null;
  const mutable = classifyPathMutability(resolved);
  const base = {
    label,
    resolvedPath: resolved,
    dedupeKey: resolved,
    sourceScope: scope,
    openable: exists,
    exists,
    inherited,
    origin: 'frontmatter-split' as const,
    mutable,
  };
  if (!exists) {
    // Missing skill: emit a single header row so the row is still visible.
    return [{
      ...base,
      id: `${resolved}#skill-header`,
      kind: 'skill-header',
      disclosureState: 'advertised-header',
      disclosureTier: 'resident',
      estimate: deps.estimator.estimate(''),
      children: [],
      warnings: [],
    }];
  }
  const split = splitFrontmatter(file!.content);
  const header: OverheadSource = {
    ...base,
    id: `${resolved}#skill-header`,
    kind: 'skill-header',
    disclosureState: 'advertised-header',
    disclosureTier: 'resident', // YAML header is the always-on baseline
    estimate: deps.estimator.estimate(split.header),
    children: [],
    warnings: split.confidence === 'low'
      ? ['No valid YAML frontmatter fence — header is a synthesized estimate.']
      : [],
  };
  const body: OverheadSource = {
    ...base,
    id: `${resolved}#skill-body`,
    kind: 'skill-body',
    disclosureState: 'scenario-body',
    disclosureTier: 'on-demand', // body loads only when the skill runs
    estimate: deps.estimator.estimate(split.body),
    children: [],
    warnings: split.approximate ? ['Body exceeded the max-readable cap — truncated estimate.'] : [],
  };
  return [header, body];
}

/** Split a MEMORY.md into two costed rows (Wave-2 §C2), modeled on
 *  `buildSkillSources`: a `memory-index` (resident, 0 tokens — the manual "check
 *  MEMORY.md" pointer already lives inside CLAUDE.md) and a `memory-body`
 *  (on-demand, MEASURED size for the labeled pool but NOT injected each session).
 *  Both carry the same `resolvedPath` so clicking either opens the file. */
function buildMemorySources(
  deps: WalkUpDeps,
  resolved: string,
  label: string,
  scope: InheritanceScope,
  inherited: boolean,
): OverheadSource[] {
  const file = deps.reader.read(resolved);
  const exists = file !== null;
  const mutable = classifyPathMutability(resolved);
  const base = {
    label,
    resolvedPath: resolved,
    dedupeKey: resolved,
    sourceScope: scope,
    openable: exists,
    exists,
    inherited,
    origin: 'frontmatter-split' as const,
    mutable,
  };
  const index: OverheadSource = {
    ...base,
    id: `${resolved}#memory-index`,
    kind: 'memory-index',
    disclosureTier: 'resident',
    estimate: deps.estimator.estimate(''), // resident cost is 0 — pointer counted inside CLAUDE.md
    children: [],
    warnings: ['MEMORY.md is progressively disclosed (autoMemoryEnabled:false; CLAUDE.md instructs a manual read at session start). No index is injected, so resident cost is 0 — the one-line pointer is already counted inside CLAUDE.md.'],
  };
  if (!exists) return [index];
  const body: OverheadSource = {
    ...base,
    id: `${resolved}#memory-body`,
    kind: 'memory-body',
    disclosureTier: 'on-demand',
    estimate: deps.estimator.estimate(file!.content), // measured size, on-demand pool only
    children: [],
    warnings: [],
  };
  return [index, body];
}

/** A dedup placeholder: the file was already counted via another frame, so it is
 *  shown (so the UI can explain the overlap) but NOT re-counted. */
function dedupPlaceholder(
  resolved: string,
  kind: OverheadSourceKind,
  label: string,
  scope: InheritanceScope,
  inherited: boolean,
  estimator: TokenEstimator,
): OverheadSource {
  return {
    id: `${resolved}#${kind}#dup`,
    kind,
    label,
    resolvedPath: resolved,
    dedupeKey: resolved,
    sourceScope: scope,
    openable: true,
    exists: true,
    inherited,
    estimate: estimator.estimate(''), // zero — counted elsewhere
    origin: 'walk-up',
    mutable: classifyPathMutability(resolved),
    disclosureTier: 'resident',
    children: [],
    warnings: ['Already counted via a nearer scope (deduped).'],
  };
}

// ── candidate enumeration ─────────────────────────────────────────────────────

interface Candidate { rel: string; }

function candidatesAt(deps: WalkUpDeps, dir: string, isAgentLevel: boolean): Candidate[] {
  const ops = deps.pathOps;
  const cands: Candidate[] = [];
  const push = (rel: string) => cands.push({ rel });

  // CLAUDE family — at every level.
  push('CLAUDE.md');
  push('.claude/CLAUDE.md');
  push('CLAUDE.local.md');

  if (isAgentLevel) {
    // The agent's own dir contributes its full local set (memory/behavioral/
    // settings/skills/rules). Ancestors contribute only the CLAUDE family.
    push('memory/MEMORY.md');
    push('behavioral.md');
    push('.claude/settings.json');
    for (const f of deps.reader.listFiles(ops.join(dir, '.claude/rules/*.md'))) {
      cands.push({ rel: relLabel(ops, dir, ops.resolve(f)) });
    }
    for (const f of deps.reader.listFiles(ops.join(dir, '.claude/skills/*/SKILL.md'))) {
      cands.push({ rel: relLabel(ops, dir, ops.resolve(f)) });
    }
  }
  return cands;
}

// ── walk-up ───────────────────────────────────────────────────────────────────

export function analyzeWalkUp(
  agentCwd: string,
  workspaceRoot: string,
  deps: WalkUpDeps,
): InheritanceFrame[] {
  const ops = deps.pathOps;
  const seen = deps.seen ?? new Set<string>();
  const frames: InheritanceFrame[] = [];

  const resolveImports = (source: OverheadSource, depth: number): void => {
    if (!source.exists || !source.resolvedPath) return;
    if (depth >= IMPORT_MAX_DEPTH) {
      source.warnings = source.warnings ?? [];
      source.warnings.push(`import depth limit (${IMPORT_MAX_DEPTH}) reached`);
      return;
    }
    const file = deps.reader.read(source.resolvedPath);
    if (!file) return;
    for (const p of extractClaudeImports(file.content)) {
      const importPath = ops.isAbsolute(p)
        ? ops.resolve(p)
        : ops.join(ops.dirname(source.resolvedPath), p);
      const child = buildSource(deps, importPath, 'import', `@${p}`, source.sourceScope, source.inherited, 'import');
      if (seen.has(importPath)) {
        source.children!.push(
          dedupPlaceholder(importPath, 'import', `@${p}`, source.sourceScope, source.inherited, deps.estimator),
        );
        continue;
      }
      seen.add(importPath);
      resolveImports(child, depth + 1);
      source.children!.push(child);
    }
  };

  const buildFrameSources = (
    dir: string,
    scope: InheritanceScope,
    isAgentLevel: boolean,
  ): OverheadSource[] => {
    const sources: OverheadSource[] = [];
    for (const cand of candidatesAt(deps, dir, isAgentLevel)) {
      const resolved = ops.join(dir, cand.rel);
      const kind = kindForCandidate(cand.rel, isAgentLevel);
      const inherited = !isAgentLevel;
      if (seen.has(resolved)) {
        sources.push(dedupPlaceholder(resolved, kind, cand.rel, scope, inherited, deps.estimator));
        continue;
      }
      // Skip non-existent candidates silently (a missing CLAUDE.md is the norm).
      if (!deps.reader.exists(resolved)) continue;
      seen.add(resolved);
      if (kind === 'skill') {
        // Split into skill-header (baseline) + skill-body (scenario) (P1.1).
        const [header, body] = buildSkillSources(deps, resolved, cand.rel, scope, inherited);
        // @imports live in the body markdown → attach them under the body row.
        if (body) resolveImports(body, 0);
        sources.push(header);
        if (body) sources.push(body);
        continue;
      }
      if (kind === 'memory') {
        // Split into memory-index (resident, 0) + memory-body (on-demand, measured) (§C2).
        const [index, body] = buildMemorySources(deps, resolved, cand.rel, scope, inherited);
        if (body) resolveImports(body, 0); // memory indexes may @import
        sources.push(index);
        if (body) sources.push(body);
        continue;
      }
      const source = buildSource(deps, resolved, kind, cand.rel, scope, inherited);
      resolveImports(source, 0);
      sources.push(source);
    }
    return sources;
  };

  // 1. Ancestor chain: agentCwd up to FILESYSTEM ROOT (no repo/home stop).
  let dir = ops.resolve(agentCwd);
  let distance = 0;
  for (;;) {
    const scope: InheritanceScope =
      distance === 0
        ? 'agent'
        : ops.isWithin(dir, ops.resolve(workspaceRoot))
          ? 'workspace-ancestor'
          : 'parent-ancestor';
    const sources = buildFrameSources(dir, scope, distance === 0);
    // Always emit the agent frame; emit ancestor frames only when they carry
    // something (keeps the chain readable instead of one frame per empty dir).
    if (distance === 0 || sources.length > 0) {
      frames.push({ dir, scope, distanceFromAgentCwd: distance, included: true, sources });
    }
    if (ops.isFilesystemRoot(dir)) break;
    const parent = ops.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    distance += 1;
  }

  // 2. User scope (pseudo-frame, distance = -1).
  const userClaudeDir = ops.join(deps.userHome, '.claude');
  const userSources: OverheadSource[] = [];
  const userClaude = ops.join(userClaudeDir, 'CLAUDE.md');
  if (!seen.has(userClaude) && deps.reader.exists(userClaude)) {
    seen.add(userClaude);
    const s = buildSource(deps, userClaude, 'user-claude', 'CLAUDE.md', 'user', true);
    resolveImports(s, 0);
    userSources.push(s);
  }
  for (const f of deps.reader.listFiles(ops.join(userClaudeDir, 'rules/*.md'))) {
    const resolved = ops.resolve(f);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    userSources.push(buildSource(deps, resolved, 'rules', relLabel(ops, userClaudeDir, resolved), 'user', true));
  }
  if (userSources.length > 0) {
    frames.push({ dir: userClaudeDir, scope: 'user', distanceFromAgentCwd: -1, included: true, sources: userSources });
  }

  // 3. Managed policy (pseudo-frame, distance = -2).
  if (deps.managedPolicyPath) {
    const resolved = ops.resolve(deps.managedPolicyPath);
    if (!seen.has(resolved) && deps.reader.exists(resolved)) {
      seen.add(resolved);
      const s = buildSource(deps, resolved, 'managed-policy', 'CLAUDE.md', 'managed', true);
      resolveImports(s, 0);
      frames.push({
        dir: ops.dirname(resolved),
        scope: 'managed',
        distanceFromAgentCwd: -2,
        included: true,
        sources: [s],
      });
    }
  }

  // 5. --add-dir gate. The workspace --add-dir is already an ancestor (counted in
  //    step 1, deduped here). Non-ancestor additional dirs only contribute
  //    inheritance when CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD === '1';
  //    otherwise they are shown as a visible-but-uncounted frame.
  const addDirEnabled = deps.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD === '1';
  for (const addDir of deps.additionalDirs ?? []) {
    const resolvedDir = ops.resolve(addDir);
    if (ops.isWithin(ops.resolve(agentCwd), resolvedDir)) continue; // already an ancestor
    if (addDirEnabled) {
      const sources = buildFrameSources(resolvedDir, 'additional-dir', false);
      if (sources.length > 0) {
        frames.push({ dir: resolvedDir, scope: 'additional-dir', distanceFromAgentCwd: 0, included: true, sources });
      }
    } else {
      // Visible, NOT counted: probe candidates without adding to `seen`/total.
      const probe: OverheadSource[] = [];
      for (const rel of ['CLAUDE.md', '.claude/CLAUDE.md']) {
        const resolved = ops.join(resolvedDir, rel);
        if (deps.reader.exists(resolved)) {
          probe.push(dedupPlaceholder(resolved, 'inherited-claude', rel, 'additional-dir', true, deps.estimator));
        }
      }
      if (probe.length > 0) {
        frames.push({ dir: resolvedDir, scope: 'additional-dir', distanceFromAgentCwd: 0, included: false, sources: probe });
      }
    }
  }

  return frames;
}
