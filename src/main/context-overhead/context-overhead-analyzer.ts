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
  InheritanceFrame,
  McpServerOverhead,
  OverheadModel,
  OverheadSource,
  PathType,
  TokenCountMethod,
  TokenEstimate,
} from '../../shared/types';
import { TokenEstimator, sumEstimates } from './token-estimator';
import { makePathOps } from './paths';
import { analyzeWalkUp } from './walk-up';
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

const BUILTIN_LANES: BuiltinLane[] = [
  { relDir: '.dashboard/supervisor', name: 'Supervisor', kind: 'builtin-supervisor', lane: 'supervisor' },
  { relDir: '.dashboard/researcher', name: 'Researcher', kind: 'builtin-researcher', lane: 'researcher' },
  { relDir: '.dashboard/workers/claude', name: 'Worker (claude)', kind: 'builtin-worker', lane: 'worker' },
  { relDir: '.dashboard/workers/codex', name: 'Worker (codex)', kind: 'builtin-worker', lane: 'worker' },
];

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

  const countedEstimates: TokenEstimate[] = flatSources.map((s) => s.estimate);
  const countedMcp = mcpServers.filter((s) => !s.excludedByStrictMode);
  for (const server of countedMcp) countedEstimates.push(server.total);

  const total = sumEstimates(countedEstimates, deps.estimator.method);
  const exactness = deriveExactness(countedEstimates.map((e) => e.method));

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
    exactness,
    warnings,
  };
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
    const dir = pathOps.join(workspaceRoot, bl.relDir);
    if (!deps.reader.exists(dir)) {
      globalWarnings.push(`Built-in lane directory not found, skipped: ${bl.relDir}`);
      continue;
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

  return {
    workspaceId,
    workspaceRoot,
    pathType,
    estimatorMethod: deps.estimator.method,
    agents,
    globalWarnings,
  };
}
