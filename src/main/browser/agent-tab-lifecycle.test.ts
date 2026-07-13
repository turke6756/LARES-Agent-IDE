// Unit tests for the D3 agent-tab lifecycle logic (plan §5 D3.1 + D3.2). Pure
// module — no Electron, no browser-manager. Covers: lease eligibility matrix,
// per-agent + global cap LRU selection, grace-close (fires after grace,
// exemptions hold, cancel on revival, idempotent arming).
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/browser/agent-tab-lifecycle.test.js

import assert from 'node:assert/strict';
import {
  LeaseLedger,
  isAgentDiscardEligible,
  pickAgentTabsToDiscard,
  closeableAgentTabs,
  GraceCloseScheduler,
  type AgentTabLifecycleInfo,
  type LifecycleTimers,
  type TimerHandle,
} from './agent-tab-lifecycle';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

function tab(over: Partial<AgentTabLifecycleInfo> & { tabId: string }): AgentTabLifecycleInfo {
  return {
    agentId: 'A',
    lruAt: 0,
    loading: false,
    signinPending: false,
    needsHumanAttention: false,
    hasPendingDownload: false,
    ...over,
  };
}

const noLease = () => false;

// ── LeaseLedger ───────────────────────────────────────────────────────────────

test('LeaseLedger holds a lease for leaseMs after touch, then expires', () => {
  const l = new LeaseLedger(10_000);
  l.touch('t1', 1_000);
  assert.equal(l.hasActiveLease('t1', 1_000), true);
  assert.equal(l.hasActiveLease('t1', 10_999), true); // < leaseMs elapsed
  assert.equal(l.hasActiveLease('t1', 11_000), false); // exactly leaseMs → expired
  assert.equal(l.hasActiveLease('t1', 20_000), false);
});

test('LeaseLedger reports no lease for an untouched tab and after release', () => {
  const l = new LeaseLedger(10_000);
  assert.equal(l.hasActiveLease('nope', 0), false);
  l.touch('t1', 0);
  l.release('t1');
  assert.equal(l.hasActiveLease('t1', 1), false);
});

// ── isAgentDiscardEligible (lease/exemption matrix) ────────────────────────────

test('a plain, unleased, idle agent tab is eligible', () => {
  assert.equal(isAgentDiscardEligible(tab({ tabId: 't' }), 0, noLease), true);
});

for (const [label, flags] of [
  ['signinPending', { signinPending: true }],
  ['needsHumanAttention', { needsHumanAttention: true }],
  ['loading', { loading: true }],
  ['hasPendingDownload', { hasPendingDownload: true }],
] as const) {
  test(`is ineligible while ${label}`, () => {
    assert.equal(isAgentDiscardEligible(tab({ tabId: 't', ...flags }), 0, noLease), false);
  });
}

test('is ineligible while an active lease is held, eligible once it expires', () => {
  const ledger = new LeaseLedger(10_000);
  ledger.touch('t', 0);
  const has = (id: string, now: number) => ledger.hasActiveLease(id, now);
  assert.equal(isAgentDiscardEligible(tab({ tabId: 't' }), 5_000, has), false);
  assert.equal(isAgentDiscardEligible(tab({ tabId: 't' }), 10_000, has), true);
});

// ── pickAgentTabsToDiscard ─────────────────────────────────────────────────────

const eligibleAll = () => true;

test('returns nothing when within both caps', () => {
  const tabs = [tab({ tabId: 'a', lruAt: 1 }), tab({ tabId: 'b', lruAt: 2 })];
  assert.deepEqual(pickAgentTabsToDiscard(tabs, eligibleAll, { maxGlobal: 24, maxPerAgent: 6 }), []);
});

test('trims per-agent overflow LRU-first', () => {
  // agent A has 3 tabs, cap 2 → discard the single oldest (lruAt 1).
  const tabs = [
    tab({ tabId: 'a', agentId: 'A', lruAt: 3 }),
    tab({ tabId: 'b', agentId: 'A', lruAt: 1 }),
    tab({ tabId: 'c', agentId: 'A', lruAt: 2 }),
  ];
  assert.deepEqual(pickAgentTabsToDiscard(tabs, eligibleAll, { maxGlobal: 24, maxPerAgent: 2 }), ['b']);
});

test('enforces the global cap across agents, LRU-first', () => {
  // 4 tabs across 4 agents, per-agent cap not tripped, global cap 2 → discard
  // the 2 oldest overall (lruAt 1 and 2).
  const tabs = [
    tab({ tabId: 'a', agentId: 'A', lruAt: 4 }),
    tab({ tabId: 'b', agentId: 'B', lruAt: 1 }),
    tab({ tabId: 'c', agentId: 'C', lruAt: 2 }),
    tab({ tabId: 'd', agentId: 'D', lruAt: 3 }),
  ];
  const picks = pickAgentTabsToDiscard(tabs, eligibleAll, { maxGlobal: 2, maxPerAgent: 6 });
  assert.deepEqual(picks.sort(), ['b', 'c']);
});

test('never picks ineligible (leased) tabs even when over cap', () => {
  // agent A: 3 tabs, cap 1. The two newest are ineligible → only the oldest
  // eligible can be discarded; the group stays over cap intentionally.
  const tabs = [
    tab({ tabId: 'a', agentId: 'A', lruAt: 1 }),
    tab({ tabId: 'b', agentId: 'A', lruAt: 2 }),
    tab({ tabId: 'c', agentId: 'A', lruAt: 3 }),
  ];
  const eligible = (t: AgentTabLifecycleInfo) => t.tabId === 'a';
  assert.deepEqual(pickAgentTabsToDiscard(tabs, eligible, { maxGlobal: 24, maxPerAgent: 1 }), ['a']);
});

test('per-agent picks reduce the remaining global overflow (no double count)', () => {
  // agent A: 4 tabs (cap 2 → 2 discards). Global cap 3 over 4 total tabs → the 1
  // global overflow is already covered by the per-agent picks → no extra pick.
  const tabs = [
    tab({ tabId: 'a1', agentId: 'A', lruAt: 1 }),
    tab({ tabId: 'a2', agentId: 'A', lruAt: 2 }),
    tab({ tabId: 'a3', agentId: 'A', lruAt: 3 }),
    tab({ tabId: 'a4', agentId: 'A', lruAt: 4 }),
  ];
  const picks = pickAgentTabsToDiscard(tabs, eligibleAll, { maxGlobal: 3, maxPerAgent: 2 });
  assert.deepEqual(picks.sort(), ['a1', 'a2']);
});

// ── closeableAgentTabs (grace-close exemptions) ────────────────────────────────

test('closeableAgentTabs returns the agent tabs that are not signin/attention exempt', () => {
  const tabs = [
    tab({ tabId: 'ok1', agentId: 'A' }),
    tab({ tabId: 'signin', agentId: 'A', signinPending: true }),
    tab({ tabId: 'attn', agentId: 'A', needsHumanAttention: true }),
    tab({ tabId: 'other', agentId: 'B' }),
    tab({ tabId: 'ok2', agentId: 'A' }),
  ];
  assert.deepEqual(closeableAgentTabs(tabs, 'A').sort(), ['ok1', 'ok2']);
});

// ── GraceCloseScheduler with a controllable fake timer ─────────────────────────

class FakeTimers implements LifecycleTimers {
  private seq = 1;
  private readonly fns = new Map<number, () => void>();
  set(fn: () => void, _ms: number): TimerHandle {
    const id = this.seq++;
    this.fns.set(id, fn);
    return id as unknown as TimerHandle;
  }
  clear(handle: TimerHandle): void {
    this.fns.delete(handle as unknown as number);
  }
  fireAll(): void {
    const snapshot = [...this.fns.entries()];
    for (const [id, fn] of snapshot) {
      this.fns.delete(id);
      fn();
    }
  }
  get armedCount(): number { return this.fns.size; }
}

function makeScheduler(closeable: Record<string, string[]>) {
  const timers = new FakeTimers();
  const closed: string[] = [];
  const scheduler = new GraceCloseScheduler({
    timers,
    graceMs: 600_000,
    listCloseableTabs: (agentId) => closeable[agentId] ?? [],
    closeTab: (tabId) => closed.push(tabId),
  });
  return { timers, closed, scheduler };
}

test('grace close fires an agent tabs after the grace timer', () => {
  const { timers, closed, scheduler } = makeScheduler({ A: ['t1', 't2'] });
  scheduler.onAgentTerminal('A');
  assert.deepEqual(closed, []); // nothing before the grace elapses
  timers.fireAll();
  assert.deepEqual(closed.sort(), ['t1', 't2']);
  assert.equal(scheduler.isScheduled('A'), false);
});

test('arming is idempotent — a repeated terminal signal does not stack timers', () => {
  const { timers, scheduler } = makeScheduler({ A: ['t1'] });
  scheduler.onAgentTerminal('A');
  scheduler.onAgentTerminal('A');
  assert.equal(timers.armedCount, 1);
});

test('reviving the agent cancels a pending close', () => {
  const { timers, closed, scheduler } = makeScheduler({ A: ['t1'] });
  scheduler.onAgentTerminal('A');
  scheduler.onAgentRevived('A');
  assert.equal(scheduler.isScheduled('A'), false);
  timers.fireAll();
  assert.deepEqual(closed, []);
});

test('exemptions are evaluated at fire time (the lister decides)', () => {
  // The lister is re-consulted when the timer fires; a tab that becomes exempt
  // during the grace window is simply absent from its result.
  const timers = new FakeTimers();
  const closed: string[] = [];
  let closeable = ['t1', 't2'];
  const scheduler = new GraceCloseScheduler({
    timers,
    graceMs: 600_000,
    listCloseableTabs: () => closeable,
    closeTab: (id) => closed.push(id),
  });
  scheduler.onAgentTerminal('A');
  closeable = ['t2']; // t1 became needsHumanAttention mid-grace
  timers.fireAll();
  assert.deepEqual(closed, ['t2']);
});

test('cancelAll clears every armed close', () => {
  const { timers, scheduler } = makeScheduler({ A: ['t1'], B: ['t2'] });
  scheduler.onAgentTerminal('A');
  scheduler.onAgentTerminal('B');
  assert.equal(timers.armedCount, 2);
  scheduler.cancelAll();
  assert.equal(timers.armedCount, 0);
});

// ── Run ─────────────────────────────────────────────────────────────────────

let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${t.name}`);
    console.error(err instanceof Error ? err.stack : String(err));
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} agent-tab-lifecycle tests passed`);
