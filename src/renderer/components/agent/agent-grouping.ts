import type { Agent, AgentStatus } from '../../../shared/types';

// A node in the owner→children forest the grid renders. `children` is the list
// of agents whose `ownerAgentId` points at `agent`, recursively. Order within
// every level mirrors the input array, so the grid's existing sort is preserved.
export interface AgentTreeNode {
  agent: Agent;
  children: AgentTreeNode[];
}

// Bucket a flat agent list into an ownership forest.
//
// Roots = agents with no `ownerAgentId`, OR whose owner is not present in this
// list (filtered out / different view / terminal-and-purged). Such an "orphan"
// child therefore renders top-level instead of silently disappearing.
//
// Children = agents whose owner IS present; they nest under that owner to any
// depth. Every input agent appears exactly once: a visited set guards against
// cycles (shouldn't occur — launch validates the owner pre-exists — but if one
// did, the un-reachable agents are appended as roots rather than dropped).
export function buildAgentForest(agents: Agent[]): AgentTreeNode[] {
  const presentIds = new Set(agents.map((a) => a.id));
  const childrenOf = new Map<string, Agent[]>();
  const roots: Agent[] = [];

  for (const a of agents) {
    const owner = a.ownerAgentId;
    if (owner && owner !== a.id && presentIds.has(owner)) {
      const bucket = childrenOf.get(owner);
      if (bucket) bucket.push(a);
      else childrenOf.set(owner, [a]);
    } else {
      roots.push(a);
    }
  }

  const visited = new Set<string>();
  const build = (a: Agent): AgentTreeNode => {
    visited.add(a.id);
    const kids = (childrenOf.get(a.id) ?? []).filter((c) => !visited.has(c.id));
    return { agent: a, children: kids.map(build) };
  };

  const forest = roots.map(build);
  // Cycle safety-net: any agent never reached from a root (e.g. A↔B owning each
  // other) is surfaced top-level so it can never vanish from the grid.
  for (const a of agents) {
    if (!visited.has(a.id)) forest.push(build(a));
  }
  return forest;
}

// Collect this node's own agent id plus every descendant id (depth-first,
// owner-first). Used to cascade-delete an owner-container: deleting a supervisor
// bar deletes the supervisor AND every agent it owns, at any nesting depth.
export function collectSubtreeIds(node: AgentTreeNode): string[] {
  const ids: string[] = [node.agent.id];
  for (const child of node.children) {
    ids.push(...collectSubtreeIds(child));
  }
  return ids;
}

// A node renders as an owner-container (full-width band) iff it owns ≥1 agent.
// Deliberately NOT keyed on `agent.isSupervisor`: a childless supervisor must
// degrade to a plain card, and an owned non-supervisor (e.g. a script-launched
// researcher) must become a container.
export function isOwnerContainer(node: AgentTreeNode): boolean {
  return node.children.length > 0;
}

// Default expand state for a container, regardless of child count: ALWAYS
// collapsed. An owner-container (typically a supervisor) opens closed and the
// user must explicitly expand it to see the agents it owns — keeping the grid
// compact and letting the at-a-glance signal be the bar itself (status badge +
// active-border pulse) rather than a wall of expanded child cards. `count` is
// retained in the signature for call-site symmetry but no longer consulted.
export function defaultOwnerExpanded(_count: number): boolean {
  return false;
}

// Statuses that mean an agent is actively doing work right now. Mirrors the
// `pulse: true` rows in StatusBadge MINUS `waiting` — a waiting agent is blocked
// on human input, not "at work". Used to decide whether an owner-container's
// border should pulse to advertise that something inside it is busy.
const ACTIVE_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'launching',
  'working',
  'receiving',
  'restarting',
]);

export function isActiveStatus(status: AgentStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

// True when ANY descendant (child, grandchild, …) of this node is actively
// working. Deliberately excludes the node's own agent — the bar already shows
// that via its StatusBadge; this drives the "even though the supervisor is idle,
// someone it owns is busy" border pulse. Short-circuits on the first hit.
export function hasActiveDescendant(node: AgentTreeNode): boolean {
  for (const child of node.children) {
    if (isActiveStatus(child.agent.status)) return true;
    if (hasActiveDescendant(child)) return true;
  }
  return false;
}
