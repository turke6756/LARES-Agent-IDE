// "What This Agent Knows" — impure IPC wiring (base plan P3.2 / master WP4).
//
// Runs the SAME walk-up scan the picker was populated from (`runOverheadScan`),
// finds the requested agent, and feeds its resolved surfaces to the pure
// `extractAgentKnowledge`. The only impure bits: the overhead scan + a WSL-aware
// FileReader (reused from the overhead deps, no duplication). The IPC handler is
// a thin try/catch around `runKnowledgeExtract`.

import type { AgentKnowledgeGraph } from '../../shared/types';
import { runOverheadScan, makeFileReader } from '../context-overhead/ipc-deps';
import { extractAgentKnowledge } from './knowledge-extractor';
import { enrichKnowledgeWithBehavior } from './knowledge-behavior-enrichment';
import { getDb } from '../database';

/** Resolve the workspace + agent, run the deterministic extractor, then attach the
 *  behavior linkage (WP3), and stamp `generatedAtIso`. Throws on a missing
 *  workspace/agent (the handler turns it into the error variant of the discriminated
 *  result). The pure extractor stays DB-free; only this runner touches the DB. */
export function runKnowledgeExtract(workspaceId: string, agentId: string): AgentKnowledgeGraph {
  const model = runOverheadScan(workspaceId);
  const agent = model.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`Agent not found in workspace scan: ${agentId}`);

  const reader = makeFileReader(model.pathType);
  const { nodes, sourceFiles, agentName } = extractAgentKnowledge(agent, {
    readFile: (absPath) => reader.read(absPath)?.content ?? null,
  }, { workspaceRoot: model.workspaceRoot });

  let graph: AgentKnowledgeGraph = {
    agentId: agent.id,
    agentName,
    nodes,
    sourceFiles,
    generatedAtIso: new Date().toISOString(),
  };

  // WP3 — behavior enrichment (impure). Best-effort: if the analytics DB is
  // unavailable we return the un-enriched graph rather than fabricate counts or fail
  // the whole extract.
  try {
    graph = enrichKnowledgeWithBehavior({ graph, agent, model, db: getDb(), nowMs: Date.now() });
  } catch (err) {
    console.warn('[knowledge-extract] behavior enrichment skipped:', err instanceof Error ? err.message : err);
  }

  return graph;
}
