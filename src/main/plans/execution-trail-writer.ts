// GT-C Decision 1 (§1.4) — the serialized async Execution-Trail materializer.
//
// The app CANNOT mutex against agent writes: agents edit the plan file through
// their own harness `Edit`, not through the app. Clobber defence is therefore
// TEMPORAL — only write `sec_exectr` at points where no orchestrator will begin
// another rail turn on the plan (§1.1). Three layers:
//   1. Ownership gate (`isQuiescent`) — never write unless the plan is quiescent.
//   2. Byte-exact single-section splice (`spliceExecTrail`) — only `sec_exectr`'s
//      inner range is ever in the write set, so another section's content present
//      in the read cannot be lost.
//   3. Re-read-and-verify before write, bounded retry — after splice, re-read; if
//      the file hash changed, recompute the splice against the fresh bytes
//      (≤3 attempts); a pre-write quiescence recheck aborts if the plan went
//      non-quiescent mid-loop (the next safe trigger regenerates — self-healing).
//   4. Compare-and-swap at the write itself (P0 hardening, review rec #5) — the
//      quiescence gate only covers ORCHESTRATED writers; a human/out-of-band save
//      landing between the last reread and the rename-over-target would otherwise
//      be clobbered by our stale full-file buffer. So the write is conditional on
//      the file still hashing to the bytes we spliced from. When the dep exposes
//      `writePlanFileIfUnchanged`, that check is atomic (a synchronous
//      reread→compare→rename with no event-loop gap). Otherwise we fall back to a
//      just-before-write guard reread + plain write, which closes the JS-scheduling
//      gap (not a truly concurrent external OS writer). On contention we leave the
//      file UNTOUCHED, mark the plan "trail pending due to concurrent edit"
//      (`isTrailPending`), and requeue the materialization so it eventually lands
//      against the human's fresh bytes.
//
// `onWriteEvent` (plan-events §1.5) is a TRIGGER SIGNAL only, never the source of
// materialized truth: the materializer always re-derives its entries from the DB
// (`listTrailEntries`), so trigger payload and file content cannot diverge.

import { spliceExecTrail, type TrailEntry } from './execution-trail';

export interface TrailWriterDeps {
  readPlanFile(planId: string): Promise<string | null>;
  writePlanFile(planId: string, html: string): Promise<void>;
  /**
   * OPTIONAL conditional replace (compare-and-swap). Atomically — a synchronous
   * reread → hash-compare → rename-over with NO intervening event-loop turn —
   * write `html` only when the file still hashes to `expectedHash`. Returns
   * `'written'` on success, or `'conflict'` when the bytes changed under us (a
   * human/out-of-band save landed after our last reread). When this dep is
   * absent, the materializer falls back to a just-before-write guard reread plus
   * the plain `writePlanFile`, which closes the in-process scheduling gap but not
   * a truly concurrent external OS writer. Wiring this seam is what makes the
   * P0 clobber defence genuinely atomic (review rec #5).
   */
  writePlanFileIfUnchanged?(
    planId: string,
    html: string,
    expectedHash: string,
  ): Promise<'written' | 'conflict'>;
  hasLiveOrchestration(planId: string, exemptRunId?: string): boolean;
  getLiveRailAgentForPlan(planId: string, exemptAgentIds: string[]): { id: string } | null;
  listTrailEntries(planId: string): TrailEntry[]; // last ≤200 write-events, oldest→newest
  hashHtml(html: string): string;
  /** OPTIONAL: notified when a plan enters/leaves the "trail pending due to
   *  concurrent edit" state, so a consumer can surface it on the plan pane.
   *  No-op safe; requires no wiring. */
  onTrailPendingChange?(planId: string, pending: boolean): void;
}

export interface MaterializeOpts {
  completingRunId?: string;
  exemptAgentIds?: string[];
}

const MAX_REREAD_ATTEMPTS = 3;

/** Delay before an auto-requeue after a concurrent-edit conflict. Small so the
 *  trail lands promptly once the human's save settles, but non-zero (and unref'd)
 *  so a persistently-edited file can't busy-spin the write chain. Mutable so tests
 *  can drive the requeue deterministically. */
const DEFAULT_REQUEUE_DELAY_MS = 25;

export class TrailMaterializer {
  private deps: TrailWriterDeps | null = null;
  /** Per-plan write chain so system writes never interleave (§1.4). */
  private chains = new Map<string, Promise<void>>();
  /** Plans whose read→gate-recheck→write window is in flight (for the 409 predicate). */
  private inFlight = new Set<string>();
  /** Plans whose trail write was skipped because a concurrent edit landed at the
   *  write boundary. Surfaced via `isTrailPending`; cleared when a later
   *  materialize successfully writes (or finds nothing owed). */
  private pending = new Set<string>();
  /** One coalesced auto-requeue timer per plan. */
  private requeueTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private requeueDelayMs = DEFAULT_REQUEUE_DELAY_MS;

  /** Configure ONCE at main startup. Before this, all methods are inert. */
  configure(deps: TrailWriterDeps): void {
    this.deps = deps;
  }

  /** In-flight guard for the `assertPlanRailFree` 409 predicate. Fail-open (`false`)
   *  before `configure` so the guards never throw during the startup window. */
  isMaterializing(planId: string): boolean {
    return this.inFlight.has(planId);
  }

  /** True while a materialization is owed because a concurrent human/out-of-band
   *  edit was detected at the write boundary and the file was left untouched.
   *  Fail-open (`false`) before `configure`. This is the "trail pending due to
   *  concurrent edit" status seam (review rec #5). */
  isTrailPending(planId: string): boolean {
    return this.pending.has(planId);
  }

  private setPending(planId: string, pending: boolean): void {
    const changed = pending ? !this.pending.has(planId) : this.pending.has(planId);
    if (pending) this.pending.add(planId);
    else this.pending.delete(planId);
    if (changed) {
      try {
        this.deps?.onTrailPendingChange?.(planId, pending);
      } catch {
        /* status notification is best-effort; never affects the write path */
      }
    }
  }

  /** Coalesced, unref'd requeue after a write-boundary conflict, so the trail
   *  eventually lands against the human's fresh bytes without busy-spinning. */
  private scheduleRequeue(planId: string, opts?: MaterializeOpts): void {
    if (this.requeueTimers.has(planId)) return; // one pending requeue per plan
    const t = setTimeout(() => {
      this.requeueTimers.delete(planId);
      void this.materialize(planId, opts);
    }, this.requeueDelayMs);
    // A trail requeue must never keep the process alive on its own.
    (t as any)?.unref?.();
    this.requeueTimers.set(planId, t);
  }

  /** Best-effort turn-end request: chains a materialize that runs only if quiescent.
   *  Never throws to the caller. No-op before `configure`. */
  request(planId: string): void {
    if (!this.deps) return;
    void this.materialize(planId);
  }

  /**
   * Explicit trigger (T1 / T2). Chains per-plan so concurrent triggers serialize;
   * best-effort — never throws to the caller. No-op before `configure`.
   */
  materialize(planId: string, opts?: MaterializeOpts): Promise<void> {
    if (!this.deps) return Promise.resolve();
    const prior = this.chains.get(planId) ?? Promise.resolve();
    const next = prior
      .catch(() => undefined) // a prior failure must not poison the chain
      .then(() => this.runMaterialize(planId, opts));
    this.chains.set(planId, next);
    // Drop the chain entry once this is the tail, so the map doesn't grow unbounded.
    void next.finally(() => {
      if (this.chains.get(planId) === next) this.chains.delete(planId);
    });
    return next;
  }

  private isQuiescent(planId: string, opts?: MaterializeOpts): boolean {
    const deps = this.deps!;
    if (deps.hasLiveOrchestration(planId, opts?.completingRunId)) return false;
    if (deps.getLiveRailAgentForPlan(planId, opts?.exemptAgentIds ?? []) !== null) return false;
    return true;
  }

  private async runMaterialize(planId: string, opts?: MaterializeOpts): Promise<void> {
    const deps = this.deps;
    if (!deps) return;
    // 1. Gate: never write unless quiescent.
    if (!this.isQuiescent(planId, opts)) return;
    // 2. Claim the in-flight window for the ENTIRE read → recheck → write.
    this.inFlight.add(planId);
    try {
      // 3. Read the current bytes.
      let first = await deps.readPlanFile(planId);
      if (first === null) return;
      // 4. Re-derive entries from the DB (never from the trigger payload) + splice.
      const entries = deps.listTrailEntries(planId);
      let spliced = spliceExecTrail(first, entries);
      // 5. Re-read / hash-verify with bounded retry: if the file changed under us,
      //    recompute the splice against the fresh bytes so an agent's edit to a
      //    DIFFERENT section (present in the fresh read) is preserved.
      for (let attempt = 0; attempt < MAX_REREAD_ATTEMPTS; attempt++) {
        const fresh = await deps.readPlanFile(planId);
        if (fresh === null) return;
        if (deps.hashHtml(fresh) === deps.hashHtml(first)) break; // stable → good to write
        // Bytes moved — a concurrent edit landed. Recompute against the fresh bytes.
        if (!this.isQuiescent(planId, opts)) return; // went non-quiescent mid-loop → abort
        first = fresh;
        spliced = spliceExecTrail(fresh, entries);
      }
      // 6. Pre-write quiescence recheck (the active-state race, §1.1 layer 1).
      if (!this.isQuiescent(planId, opts)) return;
      // 7. Compare-and-swap write. `first` is the exact byte-image `spliced` was
      //    derived from; the write is conditional on the file STILL hashing to it,
      //    so a human/out-of-band save that lands between the last reread and the
      //    rename cannot be clobbered by our stale buffer (review rec #5).
      const expectedHash = deps.hashHtml(first);
      let outcome: 'written' | 'conflict';
      if (deps.writePlanFileIfUnchanged) {
        // Atomic path: reread→compare→rename happens with no event-loop gap.
        outcome = await deps.writePlanFileIfUnchanged(planId, spliced, expectedHash);
      } else {
        // Fallback: guard reread immediately before the plain write. Closes the
        // in-process scheduling gap (not a truly concurrent external OS writer).
        const guard = await deps.readPlanFile(planId);
        if (guard === null) return;
        if (deps.hashHtml(guard) !== expectedHash) {
          outcome = 'conflict';
        } else {
          await deps.writePlanFile(planId, spliced);
          outcome = 'written';
        }
      }
      if (outcome === 'conflict') {
        // A concurrent edit landed at the write boundary. Leave the file UNTOUCHED,
        // mark the trail pending, and requeue so it lands against the fresh bytes.
        this.setPending(planId, true);
        this.scheduleRequeue(planId, opts);
        return;
      }
      // Wrote cleanly — nothing is owed anymore.
      this.setPending(planId, false);
    } catch (err: any) {
      // Best-effort: a read/splice/write failure never propagates. The next safe
      // trigger regenerates from the full plan_events stream.
      console.warn(`[exec-trail] materialize failed for ${planId}: ${err?.message || err}`);
    } finally {
      // 8. Release the in-flight window.
      this.inFlight.delete(planId);
    }
  }
}

export const trailMaterializer = new TrailMaterializer();
