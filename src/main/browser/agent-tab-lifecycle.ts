// Agent-tab lifecycle: the D3 renderer-leak controls from the
// 2026-07-11 memory-exhaustion incident (plan §5 D3). PURE / injected-dependency
// logic only — NO Electron, NO WebContentsView — so it unit-tests under plain
// node. `browser-manager.ts` owns the live view teardown/close and feeds this
// module a snapshot of the current agent tabs plus an injected clock, timers,
// tab-lister and closer.
//
// Three concerns (plan §5 D3 items 1 + 2):
//   1. Grace-close scheduler — when the supervisor marks an agent done/crashed,
//      close its agent-partition tabs after a grace period, EXEMPTING tabs
//      flagged needsHumanAttention / signinPending; cancel on agent revival.
//   2. Lease ledger — a browser-tool verb executed against a tab within the last
//      N minutes holds an "active-operation lease" that makes the tab ineligible
//      for cap-discard.
//   3. Discard picker — enforce MAX_LIVE_AGENT_VIEWS (global + per-agent) by
//      suspending (NOT closing) the least-recently-active *eligible* agent tabs.
//
// Hydration (restoring a discarded agent tab before a verb runs) lives in the
// sibling agent-tab-hydration.ts.

/** Default grace period between an agent reaching a terminal status and its
 *  tabs being closed (plan §5 D3.1). Configurable via the constructor. */
export const DEFAULT_AGENT_TAB_GRACE_CLOSE_MS = 10 * 60_000;

/** Default active-operation lease window (plan §5 D3.2): a tab a verb touched
 *  within this window is ineligible for cap-discard. */
export const DEFAULT_AGENT_TAB_LEASE_MS = 10 * 60_000;

/** Default global cap on live (non-discarded) agent views (plan §5 D3.2). */
export const DEFAULT_MAX_LIVE_AGENT_VIEWS = 24;

/** Default per-agent cap on live agent views (plan §5 D3.2). */
export const DEFAULT_MAX_LIVE_AGENT_VIEWS_PER_AGENT = 6;

/** The minimal per-tab projection the lifecycle logic needs. `browser-manager`
 *  builds these live (reading webContents.isLoading(), the pending-download map,
 *  the signin/attention flags, and lastActiveAt ?? createdAt). */
export interface AgentTabLifecycleInfo {
  tabId: string;
  /** openedByAgentId — the owning agent. undefined tabs are treated as their own
   *  singleton agent-group ('') so a cap can never silently skip them. */
  agentId?: string;
  /** LRU key in ms: lastActiveAt ?? createdAt. Older = discarded first. */
  lruAt: number;
  /** webContents.isLoading() — a loading tab holds an implicit lease. */
  loading: boolean;
  /** §12-A sign-in quarantine — never discard or grace-close. */
  signinPending: boolean;
  /** Agent-raised attention flag — never discard or grace-close. */
  needsHumanAttention: boolean;
  /** A pending download confirm is anchored to this tab — never discard. */
  hasPendingDownload: boolean;
}

/**
 * Per-tab active-operation lease ledger (plan §5 D3.2). A verb execution
 * `touch`es the tab; the tab then holds a lease until `leaseMs` elapses. Cheap
 * in-memory Map — the browser manager owns one instance.
 */
export class LeaseLedger {
  private readonly leases = new Map<string, number>();

  constructor(private readonly leaseMs: number = DEFAULT_AGENT_TAB_LEASE_MS) {}

  /** Record that a verb ran against `tabId` at `now` (ms). */
  touch(tabId: string, now: number): void {
    this.leases.set(tabId, now);
  }

  /** Drop a tab's lease (called when the tab is closed/discarded so the Map does
   *  not leak entries for gone tabs). */
  release(tabId: string): void {
    this.leases.delete(tabId);
  }

  /** True while the last touch is younger than the lease window. */
  hasActiveLease(tabId: string, now: number): boolean {
    const at = this.leases.get(tabId);
    return at !== undefined && now - at < this.leaseMs;
  }
}

/**
 * PURE discard-eligibility predicate (plan §5 D3.2). A live agent tab may be
 * cap-discarded ONLY when it holds no active-operation lease and is not pinned by
 * a human-facing / in-flight condition. `hasActiveLease` is injected so the same
 * predicate is testable without a live ledger.
 */
export function isAgentDiscardEligible(
  tab: AgentTabLifecycleInfo,
  now: number,
  hasActiveLease: (tabId: string, now: number) => boolean,
): boolean {
  if (tab.signinPending) return false;
  if (tab.needsHumanAttention) return false;
  if (tab.loading) return false;
  if (tab.hasPendingDownload) return false;
  if (hasActiveLease(tab.tabId, now)) return false;
  return true;
}

/** Group key for the per-agent cap — undefined agentId collapses to '' so such
 *  tabs still count against (and can be trimmed by) a group. */
function agentKey(tab: AgentTabLifecycleInfo): string {
  return tab.agentId ?? '';
}

/**
 * PURE cap-discard picker (plan §5 D3.2). Given every LIVE agent tab, decide the
 * set to suspend so that no agent exceeds `maxPerAgent` live views and the fleet
 * as a whole stays within `maxGlobal`. Ineligible tabs still COUNT toward the
 * caps (they occupy a live view) but are never chosen; among eligible tabs the
 * least-recently-active go first (LRU). Per-agent overflow is trimmed before the
 * global cap, and already-picked tabs reduce the remaining global overflow.
 */
export function pickAgentTabsToDiscard(
  tabs: AgentTabLifecycleInfo[],
  isEligible: (tab: AgentTabLifecycleInfo) => boolean,
  opts: { maxGlobal: number; maxPerAgent: number },
): string[] {
  const picks = new Set<string>();
  // LRU order (oldest first) — the canonical discard order for both passes.
  const eligibleLru = tabs.filter(isEligible).sort((a, b) => a.lruAt - b.lruAt);

  // 1) Per-agent cap. A group's live count includes ineligible tabs, so a group
  //    can stay over-cap when its excess is all leased — that is intentional
  //    (never break a lease); the global pass will not touch them either.
  const byAgent = new Map<string, number>();
  for (const tab of tabs) {
    byAgent.set(agentKey(tab), (byAgent.get(agentKey(tab)) ?? 0) + 1);
  }
  for (const [key, liveCount] of byAgent) {
    let overflow = liveCount - opts.maxPerAgent;
    if (overflow <= 0) continue;
    for (const tab of eligibleLru) {
      if (overflow <= 0) break;
      if (agentKey(tab) !== key || picks.has(tab.tabId)) continue;
      picks.add(tab.tabId);
      overflow--;
    }
  }

  // 2) Global cap on whatever live views remain after the per-agent trim.
  let globalOverflow = tabs.length - picks.size - opts.maxGlobal;
  if (globalOverflow > 0) {
    for (const tab of eligibleLru) {
      if (globalOverflow <= 0) break;
      if (picks.has(tab.tabId)) continue;
      picks.add(tab.tabId);
      globalOverflow--;
    }
  }

  return [...picks];
}

/**
 * PURE exemption filter for the grace-close (plan §5 D3.1). Of an agent's tabs,
 * the closeable ones are those NOT flagged needsHumanAttention or signinPending.
 * Evaluated at close time (not schedule time) so a flag that appears during the
 * grace window still spares the tab.
 */
export function closeableAgentTabs(
  tabs: AgentTabLifecycleInfo[],
  agentId: string,
): string[] {
  return tabs
    .filter(
      (t) =>
        t.agentId === agentId && !t.signinPending && !t.needsHumanAttention,
    )
    .map((t) => t.tabId);
}

/** Opaque timer handle — `number` under node/browser, an object under some
 *  runtimes. The scheduler only ever round-trips it through the injected timers. */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** Injected timer surface so tests drive grace expiry with a fake clock instead
 *  of real setTimeout. */
export interface LifecycleTimers {
  set(fn: () => void, ms: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

export interface GraceCloseDeps {
  timers: LifecycleTimers;
  /** Grace period (ms) from terminal status to close. */
  graceMs: number;
  /** Enumerate the tabIds to close for an agent AT FIRE TIME — the browser
   *  manager passes a live-evaluated `closeableAgentTabs(...)` so exemptions are
   *  honored against the tab's state when the timer fires, not when scheduled. */
  listCloseableTabs: (agentId: string) => string[];
  /** Close one tab (the trusted-chrome closeTab, not a tool verb). */
  closeTab: (tabId: string) => void;
}

/**
 * Grace-close scheduler (plan §5 D3.1). One pending timer per agent. Arming is
 * idempotent — a repeated terminal signal does not stack timers. Reviving an
 * agent (status back to idle/working) cancels its pending close.
 */
export class GraceCloseScheduler {
  private readonly pending = new Map<string, TimerHandle>();

  constructor(private readonly deps: GraceCloseDeps) {}

  /** The agent reached a terminal status (done/crashed) — arm its grace close.
   *  No-op if one is already armed for this agent. */
  onAgentTerminal(agentId: string): void {
    if (this.pending.has(agentId)) return;
    const handle = this.deps.timers.set(() => {
      this.pending.delete(agentId);
      for (const tabId of this.deps.listCloseableTabs(agentId)) {
        this.deps.closeTab(tabId);
      }
    }, this.deps.graceMs);
    this.pending.set(agentId, handle);
  }

  /** The agent transitioned back out of a terminal status — cancel its pending
   *  close (the tabs belong to a live agent again). */
  onAgentRevived(agentId: string): void {
    const handle = this.pending.get(agentId);
    if (handle === undefined) return;
    this.deps.timers.clear(handle);
    this.pending.delete(agentId);
  }

  /** True while a close is armed for the agent (introspection for tests/UI). */
  isScheduled(agentId: string): boolean {
    return this.pending.has(agentId);
  }

  /** Cancel every pending close (shutdown/drain). */
  cancelAll(): void {
    for (const handle of this.pending.values()) this.deps.timers.clear(handle);
    this.pending.clear();
  }
}
