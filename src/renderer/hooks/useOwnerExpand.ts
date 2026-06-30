import { useCallback, useState } from 'react';
import { defaultOwnerExpanded } from '../components/agent/agent-grouping';

// Per-owner expand/collapse state for the agent-grid owner-containers, persisted
// to localStorage so a collapsed band survives reload. Key style mirrors the
// existing panel-layout / resize precedent (a stable string prefix + id).
const KEY_PREFIX = 'owner-expand:';

function storageKey(ownerId: string): string {
  return `${KEY_PREFIX}${ownerId}`;
}

function readStored(ownerId: string): boolean | null {
  try {
    const raw = localStorage.getItem(storageKey(ownerId));
    if (raw === '1') return true;
    if (raw === '0') return false;
    return null;
  } catch {
    return null;
  }
}

// `useOwnerExpand(ownerId, childCount)` → `[expanded, toggle]`.
// Honors a persisted preference when present, otherwise falls back to
// `defaultOwnerExpanded(childCount)` (expanded for small cohorts, collapsed past
// the threshold). `toggle` flips the state and persists it.
export function useOwnerExpand(ownerId: string, childCount: number): [boolean, () => void] {
  const [expanded, setExpanded] = useState<boolean>(() => {
    const stored = readStored(ownerId);
    return stored !== null ? stored : defaultOwnerExpanded(childCount);
  });

  const toggle = useCallback(() => {
    setExpanded((cur) => {
      const next = !cur;
      try {
        localStorage.setItem(storageKey(ownerId), next ? '1' : '0');
      } catch {
        // localStorage unavailable (private mode / quota) — degrade to
        // in-memory-only state for this session rather than throwing.
      }
      return next;
    });
  }, [ownerId]);

  return [expanded, toggle];
}

// GC: drop `owner-expand:<id>` entries for owners that no longer exist, mirroring
// AgentGrid's unreadIds/selectedIds pruning so localStorage doesn't accumulate
// keys for ephemeral agent ids. Returns the number of keys removed (for tests).
export function pruneOwnerExpandKeys(liveIds: Set<string>): number {
  let removed = 0;
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(KEY_PREFIX)) {
        const id = key.slice(KEY_PREFIX.length);
        if (!liveIds.has(id)) stale.push(key);
      }
    }
    for (const key of stale) {
      localStorage.removeItem(key);
      removed++;
    }
  } catch {
    // localStorage unavailable — nothing to prune.
  }
  return removed;
}
