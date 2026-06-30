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

// ── @import extraction (R5) ──────────────────────────────────────────────────

/** Extract `@path` import targets from a CLAUDE.md body. Skips fenced code
 *  blocks (``` … ```), inline code spans (`…`), and backtick-escaped tokens
 *  (`@README`). Returns raw path strings in document order (relative or
 *  absolute). An `@` only starts an import at a line boundary or after
 *  whitespace, so `foo@bar.com` is never treated as an import. */
export function extractClaudeImports(markdown: string): string[] {
  const noFences = markdown.replace(/```[\s\S]*?```/g, '');
  const noInline = noFences.replace(/`[^`]*`/g, '');
  const out: string[] = [];
  const re = /(?:^|\s)@(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noInline)) !== null) {
    out.push(m[1]);
  }
  return out;
}

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
    children: [],
    warnings: [],
  };
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
      const child = buildSource(deps, importPath, 'import', `@${p}`, source.sourceScope, source.inherited);
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
