// guidance-sources.ts — WP2 (G2) provider-aware guidance-source composition.
//
// Composes the two guidance models into one `GuidanceSource[]` per agent:
//
//   (a) the Claude CLAUDE.md walk-up output — semantics UNCHANGED, merely TAGGED
//       (`fileKind`, `audienceProviders: ['claude']`, `model: 'walk-up-chain'`,
//       `loadingSemanticsConfidence: 'documented'`). This module never re-walks;
//       it maps the already-built `OverheadSource` rows.
//
//   (b) AGENTS.md as a DIRECTORY-SCOPED CHAIN: the AGENTS.md files on the chain
//       from workspace root to a launch cwd of a captured stream form a chain in
//       which deeper files override applicable parent guidance. ONLY files on
//       that root→cwd chain are `directory-chain`-applicable; every below-cwd or
//       off-chain AGENTS.md is `inventory-only` (costed and listed via WP7,
//       NEVER fed to per-agent costing or liveness) until a captured task/file
//       scope proves applicability. Applicability is never inferred from launch
//       cwd alone for below-cwd files.
//
// Honesty boundary: `audienceProviders` holds ACTUAL provider identifiers whose
// loading of AGENTS.md is DOCUMENTED for the lane context; when none is
// documented the value is the explicit literal 'unknown' (disclosed via
// `loadingSemanticsConfidence: 'unknown'`), never a silent default. An
// 'unknown' audience can never support `complete` capture coverage nor a
// resolved recommendation target (WP3 consumes this).
//
// Pure over injected IO (FileReader existence probes + PathOps). No Electron,
// no DB, no clocks.

import type { GuidanceFileKind, GuidanceSource, OverheadSource } from '../../shared/types';
import type { PathOps } from './paths';

/** Minimal existence probe — a full FileReader is not needed here. */
export interface ExistsProbe { exists(absPath: string): boolean }

/**
 * Providers whose loading of AGENTS.md is DOCUMENTED (their public docs state the
 * CLI reads AGENTS.md from the working tree). Kept as an explicit, reviewable
 * constant — extending it is a documentation claim, not a tuning knob.
 * Claude Code is deliberately ABSENT: its documented guidance surface is the
 * CLAUDE.md walk-up, and WP2 does not touch those semantics.
 */
export const AGENTS_MD_DOCUMENTED_PROVIDERS: readonly string[] = ['codex'];

/**
 * Derive the provider identifier an agent's lane context runs under. Built-in
 * worker lanes encode the provider in their directory
 * (`.lares/workers/<provider>` / legacy `.dashboard/workers/<provider>`);
 * supervisor/researcher lanes and personas are Claude Code lanes.
 */
export function providerForAgent(agent: { workingDir: string; kind: string }): string {
  const m = /[\\/](?:\.lares|\.dashboard)[\\/]workers[\\/]([^\\/]+)/i.exec(agent.workingDir);
  if (m) return m[1].toLowerCase();
  return 'claude';
}

const CLAUDE_FILE_KINDS = new Map<string, GuidanceFileKind>([
  ['agent-claude', 'claude-md'],
  ['inherited-claude', 'claude-md'],
  ['user-claude', 'claude-md'],
  ['managed-policy', 'claude-md'],
  ['claude-local', 'claude-local-md'],
]);

/**
 * Tag the Claude walk-up output (UNCHANGED semantics) as guidance sources. Only
 * CLAUDE-family rows map — skills/memory/rules/settings are not `GuidanceSource`
 * file kinds. Deduped by resolved path (walk-up dedup placeholders collapse).
 */
export function claudeGuidanceSources(flatSources: OverheadSource[]): GuidanceSource[] {
  const out: GuidanceSource[] = [];
  const seen = new Set<string>();
  for (const s of flatSources) {
    const fileKind = CLAUDE_FILE_KINDS.get(s.kind);
    if (!fileKind || !s.resolvedPath || !s.exists) continue;
    if (seen.has(s.resolvedPath)) continue;
    seen.add(s.resolvedPath);
    out.push({
      path: s.resolvedPath,
      fileKind,
      audienceProviders: ['claude'],
      applicability: { model: 'walk-up-chain' },
      loadingSemanticsConfidence: 'documented',
    });
  }
  return out;
}

export interface AgentsMdChainOpts {
  /** Providers documented (for this lane context) to load AGENTS.md. Empty or
   *  absent ⇒ the explicit 'unknown' audience with 'unknown' confidence. */
  documentedProviders?: readonly string[];
}

/**
 * The directories from `workspaceRoot` down to `launchCwd`, inclusive, in
 * root→cwd order. Empty when `launchCwd` is not within the workspace (an
 * off-workspace cwd has no root→cwd chain to walk).
 */
export function chainDirs(workspaceRoot: string, launchCwd: string, ops: PathOps): string[] {
  const root = ops.resolve(workspaceRoot);
  const cwd = ops.resolve(launchCwd);
  if (!ops.isWithin(cwd, root)) return [];
  const dirs: string[] = [];
  let dir = cwd;
  for (;;) {
    dirs.push(dir);
    if (dir === root) break;
    const parent = ops.dirname(dir);
    if (parent === dir) break; // filesystem root guard (cannot happen while within root)
    dir = parent;
  }
  return dirs.reverse();
}

/**
 * The AGENTS.md directory chain for one CAPTURED launch cwd: every existing
 * AGENTS.md on the root→cwd chain, in root→cwd order, each linked to its chain
 * parent (the nearest AGENTS.md above it). These are the ONLY
 * `directory-chain`-applicable AGENTS.md files for that cwd.
 */
export function agentsMdChain(
  workspaceRoot: string,
  launchCwd: string,
  deps: { reader: ExistsProbe; pathOps: PathOps },
  opts: AgentsMdChainOpts = {},
): GuidanceSource[] {
  const documented = (opts.documentedProviders ?? AGENTS_MD_DOCUMENTED_PROVIDERS).filter(Boolean);
  const audience: GuidanceSource['audienceProviders'] =
    documented.length > 0 ? [...documented] : 'unknown';
  const confidence: GuidanceSource['loadingSemanticsConfidence'] =
    documented.length > 0 ? 'documented' : 'unknown';

  const out: GuidanceSource[] = [];
  let chainParent: string | undefined;
  for (const dir of chainDirs(workspaceRoot, launchCwd, deps.pathOps)) {
    const candidate = deps.pathOps.join(dir, 'AGENTS.md');
    if (!deps.reader.exists(candidate)) continue;
    out.push({
      path: candidate,
      fileKind: 'agents-md',
      audienceProviders: audience,
      applicability: { model: 'directory-chain', ...(chainParent ? { chainParent } : {}) },
      loadingSemanticsConfidence: confidence,
    });
    chainParent = candidate;
  }
  return out;
}

/**
 * Classify an arbitrary AGENTS.md path against the captured launch cwds:
 * `directory-chain` iff its directory lies ON the root→cwd chain of at least
 * one captured stream (i.e. the file's dir is an ancestor-or-equal of a
 * captured cwd, within the workspace); everything else — below-cwd, off-chain,
 * outside the workspace — is `inventory-only`. Never inferred from launch cwd
 * alone for below-cwd files.
 */
export function classifyAgentsMdApplicability(
  agentsMdPath: string,
  workspaceRoot: string,
  capturedLaunchCwds: string[],
  ops: PathOps,
): 'directory-chain' | 'inventory-only' {
  const dir = ops.dirname(ops.resolve(agentsMdPath));
  const root = ops.resolve(workspaceRoot);
  if (!ops.isWithin(dir, root)) return 'inventory-only';
  for (const cwd of capturedLaunchCwds) {
    const resolved = ops.resolve(cwd);
    if (!ops.isWithin(resolved, root)) continue;
    if (ops.isWithin(resolved, dir)) return 'directory-chain'; // dir is ancestor-or-equal of cwd
  }
  return 'inventory-only';
}

/**
 * An inventory-only record for a known AGENTS.md that is NOT on any captured
 * chain. Costed/listed (WP7), never per-agent costed, never liveness-analyzed.
 */
export function inventoryOnlyAgentsMd(path: string, opts: AgentsMdChainOpts = {}): GuidanceSource {
  const documented = (opts.documentedProviders ?? AGENTS_MD_DOCUMENTED_PROVIDERS).filter(Boolean);
  return {
    path,
    fileKind: 'agents-md',
    audienceProviders: documented.length > 0 ? [...documented] : 'unknown',
    applicability: { model: 'inventory-only' },
    loadingSemanticsConfidence: documented.length > 0 ? 'documented' : 'unknown',
  };
}

/**
 * Does this guidance source enter THIS agent's context? True only when the
 * source's audience is a known provider list containing the agent's provider
 * AND the applicability model actually loads (walk-up or directory chain).
 * `'unknown'` audiences and `inventory-only` files are NEVER per-agent costed.
 */
export function appliesToAgent(source: GuidanceSource, provider: string): boolean {
  if (source.applicability.model === 'inventory-only') return false;
  if (source.audienceProviders === 'unknown') return false;
  return source.audienceProviders.includes(provider);
}

/**
 * Compose the full guidance-source list for one agent: the tagged Claude
 * walk-up output plus the AGENTS.md chain for the agent's launch cwd. The list
 * INCLUDES chain files whose audience excludes this agent's provider — they are
 * listed (so the surface can show them) but `appliesToAgent` keeps them out of
 * per-agent costing.
 */
export function composeGuidanceSources(
  agent: { workingDir: string; flatSources: OverheadSource[] },
  workspaceRoot: string,
  deps: { reader: ExistsProbe; pathOps: PathOps },
  opts: AgentsMdChainOpts = {},
): GuidanceSource[] {
  return [
    ...claudeGuidanceSources(agent.flatSources),
    ...agentsMdChain(workspaceRoot, agent.workingDir, deps, opts),
  ];
}
