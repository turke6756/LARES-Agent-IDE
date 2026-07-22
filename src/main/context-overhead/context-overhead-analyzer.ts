// Context-Overhead Analyzer — orchestrator / OverheadService (plan §2.3).
//
// Pure except for injected IO. Enumerates the 4 built-in lanes + injected
// personas, runs the lane-agnostic walk-up per agent, attaches the lane's MCP
// inventory (strict-mode applied in the inventory), flattens for charting, and
// sums the agent-variable total (EXCLUDING systemBaseline + strict-excluded MCP).
// The caller (IPC handler) stamps `generatedAt`.

import type {
  AgentContextOverhead,
  AgentPersona,
  AgentRoleLane,
  ConfigSectionWeight,
  ConfigWeightRollup,
  GuidanceSource,
  InheritanceFrame,
  McpServerOverhead,
  OverheadModel,
  OverheadSource,
  PathType,
  TokenCountMethod,
  TokenEstimate,
} from '../../shared/types';
import { classifyPathMutability } from '../shared/path-mutability';
import { TokenEstimator, sumEstimates } from './token-estimator';
import { makePathOps, type PathOps } from './paths';
import { analyzeWalkUp } from './walk-up';
import { classifyAgentConfig, rollupTokens, rollupTokensByFileKind } from './config-weight';
import { appliesToAgent, composeGuidanceSources, providerForAgent } from './guidance-sources';
import type { McpInventory } from './mcp-tool-inventory';

export interface FileReader {
  read(absPath: string): { content: string; bytes: number } | null; // null = missing/unreadable
  exists(absPath: string): boolean;
  listFiles(dirGlob: string): string[]; // for .claude/skills/*/SKILL.md, .claude/rules/*.md
}

export interface OverheadServiceDeps {
  reader: FileReader;
  estimator: TokenEstimator;
  mcpInventory: McpInventory;
  personas: AgentPersona[];
  env: Record<string, string | undefined>;
  userHome: string;
  managedPolicyPath: string | null;
  additionalDirs?: string[];
}

interface BuiltinLane {
  relDir: string;
  name: string;
  kind: AgentContextOverhead['kind'];
  lane: AgentRoleLane;
}

// Disclosure-tier accounting (Wave-2 §C3) RETIRES the old `PHASE0_DISCLOSURE_VALIDATED`
// gate: inclusion in the headline is now decided by each source's `disclosureTier`
// (resident vs on-demand), not by a global boolean. The old "count skill bodies in
// `total`" behavior is preserved exactly by `total = residentTotal + onDemandTotal`.

const BUILTIN_LANES: BuiltinLane[] = [
  { relDir: '.lares/supervisor', name: 'Supervisor', kind: 'builtin-supervisor', lane: 'supervisor' },
  { relDir: '.lares/researcher', name: 'Researcher', kind: 'builtin-researcher', lane: 'researcher' },
  { relDir: '.lares/workers/claude', name: 'Worker (claude)', kind: 'builtin-worker', lane: 'worker' },
  { relDir: '.lares/workers/codex', name: 'Worker (codex)', kind: 'builtin-worker', lane: 'worker' },
];

/** Legacy spelling of a built-in lane dir — probed as a fallback when the
 *  `.lares/**` dir is absent (an unmigrated or rename-failed workspace still
 *  carries `.dashboard/**`). Kept reader-based so the analyzer stays pure. */
function legacyRelDir(relDir: string): string {
  return relDir.replace(/^\.lares\//, '.dashboard/');
}

/** Flatten a frame's sources + their @import children (depth-first, document
 *  order) for chart stacking. */
function flatten(sources: OverheadSource[]): OverheadSource[] {
  const out: OverheadSource[] = [];
  const visit = (s: OverheadSource) => {
    out.push(s);
    for (const c of s.children ?? []) visit(c);
  };
  for (const s of sources) visit(s);
  return out;
}

function deriveExactness(methods: TokenCountMethod[]): AgentContextOverhead['exactness'] {
  if (methods.length === 0) return 'estimated';
  const allExact = methods.every((m) => m === 'anthropic-count-tokens');
  if (allExact) return 'exact';
  const anyExact = methods.some((m) => m === 'anthropic-count-tokens');
  return anyExact ? 'mixed' : 'estimated';
}

function analyzeAgent(
  id: string,
  name: string,
  kind: AgentContextOverhead['kind'],
  lane: AgentRoleLane,
  workingDir: string,
  pathType: PathType,
  workspaceRoot: string,
  deps: OverheadServiceDeps,
): AgentContextOverhead {
  const pathOps = makePathOps(pathType);
  const inheritanceChain: InheritanceFrame[] = analyzeWalkUp(workingDir, workspaceRoot, {
    reader: deps.reader,
    estimator: deps.estimator,
    pathOps,
    userHome: deps.userHome,
    managedPolicyPath: deps.managedPolicyPath,
    additionalDirs: deps.additionalDirs,
    env: deps.env,
    seen: new Set<string>(), // per-agent dedupe; ancestors recur across agents by design
  });

  const mcpServers: McpServerOverhead[] = deps.mcpInventory.forLane(lane);

  // Counted file sources: every source in an INCLUDED frame. Dedup placeholders
  // and uncounted (included:false) frames carry zero-valued estimates, so
  // summing the lot is safe and the chart still shows them.
  const flatSources: OverheadSource[] = [];
  for (const frame of inheritanceChain) {
    if (!frame.included) continue;
    flatSources.push(...flatten(frame.sources));
  }

  // WP2 (G2) — provider-aware guidance sources. The Claude walk-up output above is
  // UNCHANGED; it is merely tagged. AGENTS.md joins as a directory-scoped chain
  // (workspace root → this agent's launch cwd) and is per-agent costed ONLY when
  // this agent's provider is in the file's documented audience — no agent is ever
  // charged for guidance it doesn't load.
  const provider = providerForAgent({ workingDir, kind });
  const guidanceSources = composeGuidanceSources(
    { workingDir, flatSources }, workspaceRoot, { reader: deps.reader, pathOps },
  );
  const guidanceByPath = new Map(guidanceSources.map((g) => [g.path, g]));
  for (const s of flatSources) {
    const g = s.resolvedPath ? guidanceByPath.get(s.resolvedPath) : undefined;
    if (g && g.fileKind !== 'agents-md') s.guidanceSource = g;
  }
  attachApplicableAgentsMd(
    guidanceSources, provider, workingDir, inheritanceChain, flatSources, pathOps, deps,
  );

  // Truthful split (Wave-2 §C3): a source counts toward the resident headline iff
  // its `disclosureTier` is `resident`. On-demand sources (skill bodies, memory
  // body) go to a separate labeled pool, NEVER the headline. Counted MCP schemas
  // are resident (loaded into context each session).
  const residentEstimates: TokenEstimate[] = [];
  const onDemandEstimates: TokenEstimate[] = [];
  for (const s of flatSources) {
    (s.disclosureTier === 'on-demand' ? onDemandEstimates : residentEstimates).push(s.estimate);
  }
  const countedMcp = mcpServers.filter((s) => !s.excludedByStrictMode);
  for (const server of countedMcp) residentEstimates.push(server.total); // MCP schemas are resident

  const residentTotal = sumEstimates(residentEstimates, deps.estimator.method);
  const onDemandTotal = sumEstimates(onDemandEstimates, deps.estimator.method);
  const total = sumEstimates([...residentEstimates, ...onDemandEstimates], deps.estimator.method);
  const totalHeaderView = residentTotal; // header view == resident (kept for back-compat callers)
  const exactness = deriveExactness(residentEstimates.map((e) => e.method));

  // Section-level dead/live weight for this agent's resident config surfaces (§C3).
  // BEHAVIOR SEAM (§D): the structural classifier never emits `live`/`dead`.
  const configWeight = classifyAgentConfig(
    flatSources, mcpServers, deps.reader, deps.estimator, pathOps, workspaceRoot,
  );

  const warnings: string[] = [];
  return {
    id,
    name,
    kind,
    lane,
    workingDir,
    pathType,
    inheritanceChain,
    mcpServers,
    flatSources,
    total,
    totalHeaderView,
    residentTotal,
    onDemandTotal,
    configWeight,
    guidanceSources,
    provider,
    exactness,
    warnings,
  };
}

/** WP2 (G2) — turn each APPLICABLE agents-md chain source into a resident
 *  OverheadSource, attached both to `flatSources` (costing + config-weight +
 *  extraction inputs) and to the inheritance frame of its directory (so the
 *  chart/extractor walk sees it in place). Non-applicable chain files are listed
 *  in `guidanceSources` only — never costed. */
function attachApplicableAgentsMd(
  guidanceSources: GuidanceSource[],
  provider: string,
  workingDir: string,
  inheritanceChain: InheritanceFrame[],
  flatSources: OverheadSource[],
  pathOps: PathOps,
  deps: OverheadServiceDeps,
): void {
  const cwd = pathOps.resolve(workingDir);
  for (const g of guidanceSources) {
    if (g.fileKind !== 'agents-md' || !appliesToAgent(g, provider)) continue;
    const file = deps.reader.read(g.path);
    const dir = pathOps.dirname(pathOps.resolve(g.path));
    const isAgentLevel = dir === cwd;
    const src: OverheadSource = {
      id: `${g.path}#agents-md`,
      kind: 'agents-md',
      label: 'AGENTS.md',
      resolvedPath: g.path,
      dedupeKey: g.path,
      sourceScope: isAgentLevel ? 'agent' : 'workspace-ancestor',
      openable: file !== null,
      exists: file !== null,
      inherited: !isAgentLevel,
      estimate: deps.estimator.estimate(file?.content ?? ''),
      origin: 'walk-up',
      mutable: classifyPathMutability(g.path),
      disclosureTier: 'resident', // loaded into the provider's context each session
      children: [],
      warnings: [],
      guidanceSource: g,
    };
    flatSources.push(src);
    const frame = inheritanceChain.find((f) => f.included && pathOps.resolve(f.dir) === dir);
    if (frame) {
      frame.sources.push(src);
    } else {
      // Distance = steps from the agent cwd up to the file's directory.
      let distance = 0;
      for (let d = cwd; d !== dir && pathOps.dirname(d) !== d; d = pathOps.dirname(d)) distance += 1;
      inheritanceChain.push({
        dir,
        scope: isAgentLevel ? 'agent' : 'workspace-ancestor',
        distanceFromAgentCwd: distance,
        included: true,
        sources: [src],
      });
    }
  }
}

function personaLane(p: AgentPersona): AgentRoleLane {
  if (p.lane) return p.lane;
  return p.isSupervisor ? 'supervisor' : 'legacy';
}

export function analyzeOverhead(
  workspaceId: string,
  workspaceRoot: string,
  pathType: PathType,
  deps: OverheadServiceDeps,
): Omit<OverheadModel, 'generatedAt'> {
  const pathOps = makePathOps(pathType);
  const agents: AgentContextOverhead[] = [];
  const globalWarnings: string[] = [];

  for (const bl of BUILTIN_LANES) {
    // Prefer the live `.lares/**` dir; fall back to the legacy `.dashboard/**`
    // spelling for an unmigrated (or rename-failed) workspace. The stable
    // `builtin:.lares/...` id is kept for BOTH so lane identity survives the
    // on-disk migration.
    let dir = pathOps.join(workspaceRoot, bl.relDir);
    if (!deps.reader.exists(dir)) {
      const legacyDir = pathOps.join(workspaceRoot, legacyRelDir(bl.relDir));
      if (deps.reader.exists(legacyDir)) {
        dir = legacyDir;
      } else {
        globalWarnings.push(`Built-in lane directory not found, skipped: ${bl.relDir}`);
        continue;
      }
    }
    agents.push(
      analyzeAgent(`builtin:${bl.relDir}`, bl.name, bl.kind, bl.lane, dir, pathType, workspaceRoot, deps),
    );
  }

  for (const persona of deps.personas) {
    agents.push(
      analyzeAgent(
        `persona:${persona.name}`,
        persona.name,
        'persona',
        personaLane(persona),
        pathOps.resolve(persona.directory),
        pathType,
        workspaceRoot,
        deps,
      ),
    );
  }

  // Per-workspace dead/live aggregate (§C4): union of workspace-scoped config
  // sections across all agents, deduped by (sourcePath, heading), re-summed.
  const wsRoot = pathOps.resolve(workspaceRoot);
  const seenSection = new Set<string>();
  const wsSections: ConfigSectionWeight[] = [];
  for (const agent of agents) {
    for (const sec of agent.configWeight?.sections ?? []) {
      if (sec.scope !== 'agent' && sec.scope !== 'workspace-ancestor') continue;
      if (!pathOps.isWithin(pathOps.resolve(sec.sourcePath), wsRoot)) continue;
      const key = `${sec.sourcePath}::${sec.heading}::${sec.startLine}`;
      if (seenSection.has(key)) continue;
      seenSection.add(key);
      wsSections.push(sec);
    }
  }
  const workspaceConfigWeight: ConfigWeightRollup = {
    sections: wsSections,
    // WP2 (G2): tokensByClass never sums across fileKind — AGENTS.md sections
    // live only in their own tokensByClassByFileKind bucket.
    tokensByClass: rollupTokens(wsSections),
    tokensByClassByFileKind: rollupTokensByFileKind(wsSections),
  };

  return {
    workspaceId,
    workspaceRoot,
    pathType,
    estimatorMethod: deps.estimator.method,
    agents,
    workspaceConfigWeight,
    globalWarnings,
  };
}
