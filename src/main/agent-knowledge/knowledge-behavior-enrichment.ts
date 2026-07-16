// knowledge-behavior-enrichment.ts — WP3 behavior linkage (load-bearing vs stale).
//
// The pure `extractAgentKnowledge` stays DB-free. This is the SEPARATE impure step
// (mirrors how the optimizer keeps `context-optimizer.ts` pure and `ipc-handlers.ts`
// impure): it attaches an observed-usage signal to every knowledge node so a human
// can judge whether a piece of guidance is actually load-bearing.
//
// The mechanical predicate for a piece of guidance is derived the SAME way the
// optimizer derives it — `compileGuidanceActions([node], deps)` (guidance-action-
// model.ts) → `PredictedAction[]` → `BehaviorStore.countMatching`. So prose guidance
// is judged by the real predicate compiler, not a token-scan hack, and yields the
// honest `unobservable / insufficient-exposure / never-observed / observed` ladder.
//
// HONESTY (cross-cutting req 5): never fabricate a count. A node with no mechanical
// predicate stays `unobservable` with no counts; a file-reference's r/w/x split is a
// real roll-up over `behavior_events` (0 is a real, informative count — "never
// touched" — not a guess). No writes: returns a COPY of the graph.

import type {
  AgentContextOverhead,
  AgentKnowledgeGraph,
  KnowledgeBehaviorEvidence,
  KnowledgeBehaviorStatus,
  KnowledgeFileReferenceStats,
  KnowledgeNode,
  OverheadModel,
} from '../../shared/types';
import {
  buildAssembleContextFromModel,
} from '../context-optimizer/optimizer-assemble';
import {
  compileGuidanceActions,
  type CompileDeps,
  type PredictedAction,
} from '../context-optimizer/guidance-action-model';
import {
  BehaviorStore,
  type BehaviorPredicate,
  type FilePathUsage,
  type Lane,
  type MatchCount,
} from '../context-optimizer/behavior-store';
import type { PipelineDb } from '../context-optimizer/optimizer-pipeline';

const DAY_MS = 864e5;
const DEFAULT_WINDOW_DAYS = 30;

/** The slice of `BehaviorStore` the rollup depends on. Kept narrow so the WP3 unit
 *  test can stub it without a live DB. `BehaviorStore` satisfies it structurally. */
export interface BehaviorReader {
  countMatching(pred: BehaviorPredicate, lanes?: Lane[], sinceMs?: number): MatchCount;
  usageForFilePath(pathGlob: string, lanes?: Lane[], sinceMs?: number): FilePathUsage;
}

export interface EnrichKnowledgeInput {
  graph: AgentKnowledgeGraph;
  agent: AgentContextOverhead;
  model: OverheadModel;
  db: PipelineDb;
  nowMs: number;
  windowDays?: number;
}

/** Map one PredictedAction to the BehaviorStore predicate that observes it, or null
 *  when the action has no mechanical predicate (workflow-sequence / decision-branch /
 *  unmatchable, or a coarse server-only toolset grant we can't match to `mcp_toolset`). */
export function predicateFor(a: PredictedAction): BehaviorPredicate | null {
  switch (a.kind) {
    case 'tool-invocation':
      return a.params.toolName ? { kind: 'tool-invocation', toolName: a.params.toolName } : null;
    case 'skill-invocation':
      return a.params.skillName ? { kind: 'skill-invocation', skillName: a.params.skillName } : null;
    case 'toolset-usage':
      return a.params.toolset ? { kind: 'toolset-usage', toolset: a.params.toolset } : null;
    case 'command-family':
      return a.params.commandFamily ? { kind: 'command-family', family: a.params.commandFamily } : null;
    case 'path-touch':
      return a.params.pathGlob ? { kind: 'path-touch', pathGlob: a.params.pathGlob } : null;
    case 'search-pattern':
      return a.params.queryHash ? { kind: 'search-pattern', signatureHash: a.params.queryHash } : null;
    default:
      return null; // workflow-sequence | decision-branch | unmatchable → unobservable
  }
}

function explanationFor(
  status: KnowledgeBehaviorStatus,
  o: { occurrences: number; distinctStreams: number; exposureTurns: number; windowDays: number; lane: string; kinds: string[] },
): string {
  switch (status) {
    case 'observed':
      return `A matching predicate (${o.kinds.join(', ')}) fired ${o.occurrences}× in the ${o.lane} lane's last ${o.windowDays}d corpus (${o.distinctStreams} stream${o.distinctStreams === 1 ? '' : 's'}).`;
    case 'never-observed':
      return `Enough ${o.lane}-lane activity to judge (${o.exposureTurns} turns), but no matching behavior in ${o.windowDays}d — candidate for trim.`;
    case 'insufficient-exposure':
      return `Observable, but the ${o.lane} lane has too little corpus (${o.exposureTurns} turns) to judge yet.`;
    case 'unobservable':
    default:
      return 'Pure prose — no mechanical predicate to observe. Not judgeable as load-bearing or stale.';
  }
}

/** Roll a node's already-compiled predicted actions up into one behavior verdict.
 *  Exported + reader-injected so the WP3 unit test can exercise the status ladder
 *  without a live DB or the file-IO-heavy assemble context. */
export function rollUpBehavior(
  actions: PredictedAction[],
  reader: BehaviorReader,
  lane: Lane,
  sinceMs: number,
  exposureTurns: number,
  windowDays: number,
): KnowledgeBehaviorEvidence {
  const actionKinds = new Set<string>();
  let anyObservable = false;
  let occurrences = 0;
  let distinctStreams = 0;
  let distinctSlugs = 0;
  let lastObservedMs: number | null = null;

  for (const a of actions) {
    actionKinds.add(a.kind);
    const pred = predicateFor(a);
    if (!pred) continue;
    anyObservable = true;
    const m = reader.countMatching(pred, [lane], sinceMs);
    occurrences += m.occurrences;
    distinctStreams = Math.max(distinctStreams, m.distinctStreams);
    distinctSlugs = Math.max(distinctSlugs, m.distinctSlugs);
    if (m.lastTsMs != null) lastObservedMs = Math.max(lastObservedMs ?? 0, m.lastTsMs);
  }

  let status: KnowledgeBehaviorStatus;
  if (!anyObservable) status = 'unobservable';
  else if (exposureTurns === 0) status = 'insufficient-exposure';
  else if (occurrences === 0) status = 'never-observed';
  else status = 'observed';

  const kinds = [...actionKinds];
  return {
    status,
    actionKinds: kinds,
    occurrences,
    distinctStreams,
    distinctSlugs,
    lastObservedMs,
    exposureTurns,
    windowDays,
    explanation: explanationFor(status, {
      occurrences, distinctStreams, exposureTurns, windowDays, lane, kinds,
    }),
  };
}

/** Normalize a file-reference token into a suffix glob against `arg_path`. The token
 *  is a relative reference (`memory/MEMORY.md`, `@behavioral-notes.md`); `arg_path` is
 *  a fully-normalized absolute path, so we suffix-match. */
function fileRefGlob(label: string): string {
  const token = label.replace(/^@/, '').replace(/\\/g, '/').trim();
  return `*${token}`;
}

export function fileReferenceStatsForNode(
  node: KnowledgeNode,
  reader: BehaviorReader,
  lane: Lane,
  sinceMs: number,
  windowDays: number,
): KnowledgeFileReferenceStats {
  const u = reader.usageForFilePath(fileRefGlob(node.label), [lane], sinceMs);
  return {
    touches: u.touches,
    reads: u.reads,
    writes: u.writes,
    executes: u.executes,
    distinctStreams: u.distinctStreams,
    lastTouchedMs: u.lastTsMs,
    windowDays,
  };
}

/** Attach a behavior signal to every knowledge node. Returns a COPY of the graph
 *  (no writes). Prose / tool / capability / constraint / workflow / memory nodes get
 *  `behavior`; file-reference nodes get `fileReferenceStats`. */
export function enrichKnowledgeWithBehavior(input: EnrichKnowledgeInput): AgentKnowledgeGraph {
  const { graph, agent, model, db, nowMs } = input;
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  const sinceMs = nowMs - windowDays * DAY_MS;
  const lane = agent.lane as Lane;

  const ctx = buildAssembleContextFromModel({ db, model });
  const compileDeps: CompileDeps = {
    residentTargets: ctx.residentTargets,
    estimateTokens: (text: string) => ctx.estimator.estimate(text).tokens,
    openEpochIdFor: ctx.openEpochIdFor,
    mcpServerResolver: ctx.mcpServerResolver,
  };
  const store = new BehaviorStore(db);
  const exposureTurns = store.exposureForLane(lane).turnCount;

  const nodes: KnowledgeNode[] = graph.nodes.map((node) => {
    if (node.type === 'file-reference') {
      return { ...node, fileReferenceStats: fileReferenceStatsForNode(node, store, lane, sinceMs, windowDays) };
    }
    const actions = compileGuidanceActions([node], compileDeps);
    return {
      ...node,
      behavior: rollUpBehavior(actions, store, lane, sinceMs, exposureTurns, windowDays),
    };
  });

  return { ...graph, nodes };
}
