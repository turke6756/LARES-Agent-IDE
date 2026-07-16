import type { PlanSectionChangeRow } from '../database';

/**
 * WP2 provenance spine — the effect store's in-memory diff engine (R2 §2.4).
 *
 * Holds the last-seen byte-exact `content_hash` per
 * `(plan_id, section_anchor[, block_anchor])`. On each reparse (driven by WP4's
 * watcher), `observeReparse` inserts a `plan_section_changes` row for every
 * section/block whose hash MOVED — turning "which section changed during
 * [turnStart, Stop]" into a durable query instead of an in-memory diff that
 * races the Stop event.
 *
 * First-seen semantics: a section observed for the first time SEEDS the cache
 * silently — a "move" requires a prior value, and recording every section on the
 * boot reparse would spam unattributable change rows. (Caveat: the cache is
 * in-memory, so a change that lands while the app is down is missed on the next
 * cold reparse; WP4 owns snapshot-based reconstruction if that gap matters.)
 */

export interface ParsedSectionHash {
  sectionAnchor: string;
  blockAnchor?: string | null;
  /** Hash of the section/block's byte-exact inner HTML after reparse. */
  contentHash: string;
}

export interface SectionCacheDeps {
  recordPlanSectionChange(input: {
    planId: string;
    sectionAnchor: string;
    blockAnchor?: string | null;
    contentHash: string;
    changedAt?: string;
  }): string;
}

function key(planId: string, sectionAnchor: string, blockAnchor: string | null): string {
  return `${planId}\x00${sectionAnchor}\x00${blockAnchor ?? ''}`;
}

export class SectionCache {
  private lastSeen = new Map<string, string>();

  constructor(private readonly deps: SectionCacheDeps) {}

  /** Prime the cache without recording changes — for boot / snapshot restore so
   *  the first live reparse diffs against a real baseline. */
  seed(planId: string, sections: ParsedSectionHash[]): void {
    for (const s of sections) {
      this.lastSeen.set(key(planId, s.sectionAnchor, s.blockAnchor ?? null), s.contentHash);
    }
  }

  /** Diff `sections` against the last-seen hashes; insert a change row for each
   *  MOVED hash (never for a first-seen section). Returns the sections that
   *  changed (for the caller / tests). */
  observeReparse(
    planId: string,
    sections: ParsedSectionHash[],
    changedAt?: string,
  ): ParsedSectionHash[] {
    const changed: ParsedSectionHash[] = [];
    for (const s of sections) {
      const k = key(planId, s.sectionAnchor, s.blockAnchor ?? null);
      const prev = this.lastSeen.get(k);
      if (prev === s.contentHash) continue; // unchanged
      this.lastSeen.set(k, s.contentHash);
      if (prev === undefined) continue; // first-seen → seed silently, not a move
      this.deps.recordPlanSectionChange({
        planId,
        sectionAnchor: s.sectionAnchor,
        blockAnchor: s.blockAnchor ?? null,
        contentHash: s.contentHash,
        changedAt,
      });
      changed.push(s);
    }
    return changed;
  }

  /** Test/introspection seam — the current hash for a key, if any. */
  peek(planId: string, sectionAnchor: string, blockAnchor?: string | null): string | undefined {
    return this.lastSeen.get(key(planId, sectionAnchor, blockAnchor ?? null));
  }
}

export type { PlanSectionChangeRow };
