// WP-3e resource acceptance — the whole-system bound.
//
//   npm run test:renderer  (vitest, node env — no jsdom/xterm)
//
// Opens 30 DISTINCT agents through the real LRU cache (`enforceLiveTerminalBound`
// + `evictCachedTerminal`) with the on-screen agent exempt, wiring the real
// main-side `TerminalListenerRegistry` to the eviction's `terminal.detach` call.
// After every scheduled eviction settles (NOT merely after enforce returns), it
// asserts all four resource classes are bounded by `8 + |exempt|`:
//
//   • live xterm instances       (terminalCache entries)
//   • WebGL contexts             (one per un-disposed xterm)
//   • renderer onData listeners  (one per un-unsubbed cache entry)
//   • main activeListeners       (TerminalListenerRegistry entries)
//
// Each xterm disposed by eviction must have released its WebGL context (dispose)
// AND its renderer subscription (unsub) AND had its main listener detached — so
// the four counts stay equal and none leaks past the bound.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub the store the self-starting reaper subscribes to (node env, no renderer).
vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: Object.assign(function () {}, {
    subscribe: () => () => {},
    getState: () => ({ agentStatuses: {}, terminalAgentId: null, terminalPinned: false }),
  }),
}));

import {
  terminalCache,
  touchTerminal,
  enforceLiveTerminalBound,
  awaitTerminalEviction,
  __resetTerminalCacheForTest,
  type CachedTerminal,
} from './terminal-cache';
import { MAX_LIVE_TERMINAL_VIEWS } from '../../../shared/constants';
import { TerminalListenerRegistry } from '../../../main/terminal-listener-registry';

const CAP = MAX_LIVE_TERMINAL_VIEWS; // 8
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── System-under-test resource ledgers ────────────────────────────────
let webglContexts: Set<string>; // one per live xterm
let rendererListeners: Set<string>; // one per live onData subscription
let registry: TerminalListenerRegistry; // main activeListeners
let saveCheckpoint: ReturnType<typeof vi.fn>;
let detach: ReturnType<typeof vi.fn>;
let openedIds: string[];

/** Build a fake cache entry that owns a WebGL context + a renderer listener and
 *  releases both on dispose / unsub, exactly as the real xterm entry does. */
function fakeEntry(id: string, epoch: string): CachedTerminal {
  webglContexts.add(id);
  rendererListeners.add(id);
  return {
    terminal: {
      dispose: vi.fn(() => { webglContexts.delete(id); }),
      write: vi.fn(),
    },
    fitAddon: {},
    serialize: { serialize: vi.fn(() => `SER:${id}`) },
    unsub: vi.fn(() => { rendererListeners.delete(id); }),
    appliedOffset: 0,
    logOffsetsReliable: true,
    epoch,
    lastWrite: Promise.resolve(),
    evicting: false,
  } as unknown as CachedTerminal;
}

/** Open agent `id`: register its main listener under a fresh epoch, insert the
 *  renderer entry, mark it most-recently-used, and enforce the bound with THIS
 *  agent exempt (it is the one now on screen). */
function openAgent(id: string): void {
  const epoch = `ep-${id}`;
  registry.register(id, () => {}, epoch); // main installs the forwarding listener
  terminalCache.set(id, fakeEntry(id, epoch));
  touchTerminal(id);
  openedIds.push(id);
  enforceLiveTerminalBound(new Set([id])); // the on-screen agent is exempt
}

/** Drain scheduled evictions to quiescence (bounded). */
async function settle(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await Promise.all(openedIds.map((id) => awaitTerminalEviction(id)));
    await tick();
    const anyEvicting = [...terminalCache.values()].some((e) => e.evicting);
    if (!anyEvicting) return;
  }
}

/** Count main listeners still registered for the opened agents. */
function mainListenerCount(): number {
  return openedIds.filter((id) => registry.has(id)).length;
}

beforeEach(() => {
  __resetTerminalCacheForTest();
  webglContexts = new Set();
  rendererListeners = new Set();
  registry = new TerminalListenerRegistry();
  openedIds = [];
  saveCheckpoint = vi.fn(() => Promise.resolve(true));
  // Eviction's epoch-scoped detach tears down the matching main listener.
  detach = vi.fn((id: string, epoch?: string | null) => {
    registry.removeForEpoch(id, epoch);
    return Promise.resolve();
  });
  (globalThis as any).window = { api: { terminal: { saveCheckpoint, detach } } };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).window;
});

describe('WP-3e — 30-agent resource acceptance', () => {
  it('after all evictions settle, every resource class is ≤ 8 + |exempt|', async () => {
    for (let i = 0; i < 30; i++) {
      openAgent(`a${i}`);
      await tick(); // let this open's eviction (if any) make progress
    }
    await settle();

    const exemptCount = 1; // exactly one on-screen agent at any time
    const bound = CAP + exemptCount; // 9

    // Live xterm instances.
    expect(terminalCache.size).toBeLessThanOrEqual(bound);
    // The four classes are equal — no class leaks past the others.
    expect(webglContexts.size).toBe(terminalCache.size);
    expect(rendererListeners.size).toBe(terminalCache.size);
    expect(mainListenerCount()).toBe(terminalCache.size);
    // And therefore each is within the bound.
    expect(webglContexts.size).toBeLessThanOrEqual(bound);
    expect(rendererListeners.size).toBeLessThanOrEqual(bound);
    expect(mainListenerCount()).toBeLessThanOrEqual(bound);

    // The exact set retained: the last on-screen agent (exempt) + the CAP
    // most-recently-used others.
    expect(terminalCache.has('a29')).toBe(true); // last opened → exempt, survives
    expect(terminalCache.size).toBe(bound); // steady state exactly at the bound

    // Evictions actually happened and released cleanly.
    expect(saveCheckpoint.mock.calls.length).toBe(30 - bound); // 21 evicted
    expect(detach.mock.calls.length).toBe(30 - bound);
    // No disposed entry left a dangling main listener or renderer subscription.
    for (const id of openedIds) {
      if (!terminalCache.has(id)) {
        expect(registry.has(id)).toBe(false);
        expect(webglContexts.has(id)).toBe(false);
        expect(rendererListeners.has(id)).toBe(false);
      }
    }
  });
});
