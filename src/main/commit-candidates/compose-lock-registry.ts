// SC-WP-4B — repository-exclusive compose latch.
//
// The lock is deliberately synchronous: WP-4D must acquire it before attempting
// the token CAS, and must release it immediately when that CAS loses a race.

export interface ComposeLockLease {
  readonly repositoryKey: string;
  release(): void;
}

export class ComposeLockRegistry {
  private readonly held = new Set<string>();

  tryAcquire(repositoryKey: string): ComposeLockLease | null {
    if (this.held.has(repositoryKey)) return null;
    this.held.add(repositoryKey);

    let released = false;
    return {
      repositoryKey,
      release: () => {
        if (released) return;
        released = true;
        this.held.delete(repositoryKey);
      },
    };
  }

  isHeld(repositoryKey: string): boolean {
    return this.held.has(repositoryKey);
  }
}
