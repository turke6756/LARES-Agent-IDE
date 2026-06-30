import { describe, it, expect } from 'vitest';
import type { Agent } from '../../../shared/types';
import {
  buildAgentForest,
  isOwnerContainer,
  defaultOwnerExpanded,
  isActiveStatus,
  hasActiveDescendant,
  type AgentTreeNode,
} from './agent-grouping';
import type { AgentStatus } from '../../../shared/types';

// Minimal fixture — only the fields buildAgentForest reads matter; the rest of
// the Agent shape is irrelevant to bucketing, so we cast a partial.
function mk(id: string, ownerAgentId: string | null = null, status: AgentStatus = 'idle'): Agent {
  return { id, ownerAgentId, status } as unknown as Agent;
}

// Flatten a forest into "id:childIds" descriptors for easy assertions.
function shape(agents: Agent[]) {
  return buildAgentForest(agents).map(function describe(node): unknown {
    return node.children.length
      ? { id: node.agent.id, children: node.children.map(describe) }
      : node.agent.id;
  });
}

describe('buildAgentForest', () => {
  it('keeps a flat, owner-less list flat and in order', () => {
    expect(shape([mk('a'), mk('b'), mk('c')])).toEqual(['a', 'b', 'c']);
  });

  it('buckets a parent with two owned children beneath it', () => {
    const forest = buildAgentForest([mk('p'), mk('c1', 'p'), mk('c2', 'p')]);
    expect(forest).toHaveLength(1);
    expect(forest[0].agent.id).toBe('p');
    expect(forest[0].children.map((n) => n.agent.id)).toEqual(['c1', 'c2']);
  });

  it('renders an orphan child (owner absent from list) at top level', () => {
    // owner "ghost" is not present — the child must not disappear.
    expect(shape([mk('child', 'ghost'), mk('solo')])).toEqual(['child', 'solo']);
  });

  it('nests grandchildren to arbitrary depth', () => {
    expect(shape([mk('a'), mk('b', 'a'), mk('c', 'b')])).toEqual([
      { id: 'a', children: [{ id: 'b', children: ['c'] }] },
    ]);
  });

  it('preserves child order from the input array', () => {
    const forest = buildAgentForest([mk('p'), mk('z', 'p'), mk('a', 'p')]);
    expect(forest[0].children.map((n) => n.agent.id)).toEqual(['z', 'a']);
  });

  it('never drops an agent, even under a mutual-ownership cycle', () => {
    // a↔b own each other: neither is a natural root. Both must still surface.
    const ids = buildAgentForest([mk('a', 'b'), mk('b', 'a')])
      .flatMap(function collect(n): string[] {
        return [n.agent.id, ...n.children.flatMap(collect)];
      });
    expect(new Set(ids)).toEqual(new Set(['a', 'b']));
  });

  it('ignores a self-referential owner', () => {
    expect(shape([mk('a', 'a')])).toEqual(['a']);
  });

  it('nests an owner→owner→worker chain two levels deep', () => {
    // supervisor → researcher (itself an owner) → worker. Both the supervisor
    // and the mid-level researcher must be owner-containers; the leaf is not.
    const forest = buildAgentForest([
      mk('sup'),
      mk('res', 'sup'),
      mk('wrk', 'res'),
    ]);
    expect(forest).toHaveLength(1);
    const sup = forest[0];
    expect(sup.agent.id).toBe('sup');
    expect(isOwnerContainer(sup)).toBe(true);

    const res = sup.children[0];
    expect(res.agent.id).toBe('res');
    expect(isOwnerContainer(res)).toBe(true);

    const wrk = res.children[0];
    expect(wrk.agent.id).toBe('wrk');
    expect(isOwnerContainer(wrk)).toBe(false);
  });
});

describe('isOwnerContainer', () => {
  const node = (id: string, children: AgentTreeNode[] = []): AgentTreeNode => ({
    agent: mk(id),
    children,
  });

  it('is true for a node with children', () => {
    expect(isOwnerContainer(node('p', [node('c')]))).toBe(true);
  });

  it('is false for a childless node (a childless supervisor degrades to a card)', () => {
    expect(isOwnerContainer(node('lonely'))).toBe(false);
  });
});

describe('defaultOwnerExpanded', () => {
  it('always defaults collapsed, regardless of child count', () => {
    expect(defaultOwnerExpanded(0)).toBe(false);
    expect(defaultOwnerExpanded(1)).toBe(false);
    expect(defaultOwnerExpanded(6)).toBe(false);
    expect(defaultOwnerExpanded(50)).toBe(false);
  });
});

describe('isActiveStatus', () => {
  it('is true for actively-working statuses', () => {
    for (const s of ['launching', 'working', 'receiving', 'restarting'] as AgentStatus[]) {
      expect(isActiveStatus(s)).toBe(true);
    }
  });

  it('is false for idle/blocked/terminal statuses (incl. waiting)', () => {
    for (const s of ['idle', 'waiting', 'done', 'crashed'] as AgentStatus[]) {
      expect(isActiveStatus(s)).toBe(false);
    }
  });
});

describe('hasActiveDescendant', () => {
  it('is false for a childless node even when it is itself working', () => {
    const node: AgentTreeNode = { agent: mk('solo', null, 'working'), children: [] };
    expect(hasActiveDescendant(node)).toBe(false);
  });

  it('ignores the owner own status — only descendants count', () => {
    // Owner working, sole child idle → no descendant is active.
    const forest = buildAgentForest([mk('p', null, 'working'), mk('c', 'p', 'idle')]);
    expect(hasActiveDescendant(forest[0])).toBe(false);
  });

  it('is true when a direct child is working', () => {
    const forest = buildAgentForest([mk('p', null, 'idle'), mk('c', 'p', 'working')]);
    expect(hasActiveDescendant(forest[0])).toBe(true);
  });

  it('is true when a deep grandchild is working (idle owner + idle child)', () => {
    const forest = buildAgentForest([
      mk('sup', null, 'idle'),
      mk('res', 'sup', 'idle'),
      mk('wrk', 'res', 'working'),
    ]);
    expect(hasActiveDescendant(forest[0])).toBe(true);
  });
});
