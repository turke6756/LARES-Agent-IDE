export interface PackageStateCounts {
  ready: number;
  executing: number;
  blocked: number;
  done: number;
  archived: number;
}

export interface PackageRollup {
  total: number;
  landed: number;
  remaining: number;
  archived: number;
  completed: boolean;
}

export function derivePackageRollup(counts: PackageStateCounts): PackageRollup {
  const total = counts.ready + counts.executing + counts.blocked + counts.done + counts.archived;

  return {
    total,
    landed: counts.done,
    remaining: counts.ready + counts.executing + counts.blocked,
    archived: counts.archived,
    completed: total > 0 && counts.done === total,
  };
}
