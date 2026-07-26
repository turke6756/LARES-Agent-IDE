// WP-3d LRU cache unit tests — bound enforcement, single-flight eviction,
// checkpoint-on-evict, epoch-scoped detach, and the local (rebound) disposer.
//
//   npm run test:renderer  (vitest, node env — no jsdom/xterm)
//
// The real xterm/serialize/IPC are faked: an "entry" is a plain object carrying
// the fields the cache touches (serialize.serialize(), lastWrite, terminal.dispose,
// unsub, epoch, appliedOffset, logOffsetsReliable). `window.api.terminal.{save
// Checkpoint,detach}` are vi.fns whose resolution the tests control to exercise
// the finally-always-releases and single-flight contracts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The store is only used by the self-starting reaper; stub it so importing the
// cache module in node env doesn't drag the real renderer store in.
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
  evictCachedTerminal,
  awaitTerminalEviction,
  disposeCachedTerminalLocal,
  __resetTerminalCacheForTest,
  type CachedTerminal,
} from './terminal-cache';
import { MAX_LIVE_TERMINAL_VIEWS } from '../../../shared/constants';

const CAP = MAX_LIVE_TERMINAL_VIEWS; // 8

/** Flush all pending microtasks (and the setTimeout(0) macrotask) so an async
 *  eviction advances to its next held await. */
const tick = () => new Promise((r) => setTimeout(r, 0));

interface FakeExtras {
  __events: string[];
  __disposed: () => boolean;
}
type FakeEntry = CachedTerminal & FakeExtras;

function fakeEntry(id: string, opts: { epoch?: string; logOffsetsReliable?: boolean; appliedOffset?: number } = {}): FakeEntry {
  const events: string[] = [];
  let disposed = false;
  const entry = {
    terminal: {
      dispose: vi.fn(() => { disposed = true; events.push('dispose'); }),
      write: vi.fn(),
    },
    fitAddon: {},
    serialize: { serialize: vi.fn(() => { events.push('serialize'); return `SER:${id}`; }) },
    unsub: vi.fn(() => { events.push('unsub'); }),
    appliedOffset: opts.appliedOffset ?? 0,
    logOffsetsReliable: opts.logOffsetsReliable ?? true,
    epoch: opts.epoch ?? 'e1',
    lastWrite: Promise.resolve().then(() => { events.push('lastWrite'); }),
    evicting: false,
    __events: events,
    __disposed: () => disposed,
  } as unknown as FakeEntry;
  return entry;
}

/** Insert `id` and stamp it as most-recently-used (advances the LRU clock). */
function put(id: string, opts?: Parameters<typeof fakeEntry>[1]): FakeEntry {
  const e = fakeEntry(id, opts);
  terminalCache.set(id, e);
  touchTerminal(id);
  return e;
}

let saveCheckpoint: ReturnType<typeof vi.fn>;
let detach: ReturnType<typeof vi.fn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetTerminalCacheForTest();
  saveCheckpoint = vi.fn(() => Promise.resolve(true));
  detach = vi.fn(() => Promise.resolve());
  (globalThis as any).window = { api: { terminal: { saveCheckpoint, detach } } };
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  delete (globalThis as any).window;
});

describe('enforceLiveTerminalBound — LRU + exemptions', () => {
  it('evicts the oldest non-exempt entries down to the cap', async () => {
    for (let i = 0; i < CAP + 3; i++) put(`a${i}`); // 11 entries → 3 overflow
    enforceLiveTerminalBound(new Set());
    await tick();
    // The 3 oldest (a0,a1,a2) evicted; the newest CAP remain.
    for (const id of ['a0', 'a1', 'a2']) expect(terminalCache.has(id)).toBe(false);
    expect(terminalCache.size).toBe(CAP);
  });

  it('never evicts an exempt entry even when it is the oldest', async () => {
    for (let i = 0; i < CAP + 2; i++) put(`a${i}`); // a0 oldest
    enforceLiveTerminalBound(new Set(['a0'])); // a0 exempt though oldest
    await tick();
    expect(terminalCache.has('a0')).toBe(true);
    // eligible = a1..a9 (9), overflow 1 → only a1 (oldest eligible) evicted.
    expect(terminalCache.has('a1')).toBe(false);
    expect(terminalCache.size).toBe(CAP + 1); // a0 (exempt) + CAP survivors
  });

  it('deterministic LRU via the monotonic clock — a re-touch makes an old entry newest', async () => {
    for (let i = 0; i < CAP + 1; i++) put(`a${i}`); // 9 entries, overflow 1
    touchTerminal('a0'); // a0 becomes MOST-recently-used; a1 is now oldest
    enforceLiveTerminalBound(new Set());
    await tick();
    expect(terminalCache.has('a1')).toBe(false); // oldest by clock → evicted
    expect(terminalCache.has('a0')).toBe(true); // re-touched → survives
  });

  it('exempt set larger than the cap → only non-exempt overflow is evicted', async () => {
    const exempt = new Set<string>();
    for (let i = 0; i < CAP + 2; i++) { const id = `x${i}`; put(id); exempt.add(id); } // 10 exempt
    for (let i = 0; i < CAP + 1; i++) put(`n${i}`); // 9 non-exempt, overflow 1
    enforceLiveTerminalBound(exempt);
    await tick();
    for (const id of exempt) expect(terminalCache.has(id)).toBe(true); // all 10 exempt survive
    expect(terminalCache.has('n0')).toBe(false); // one non-exempt evicted
    expect(saveCheckpoint).toHaveBeenCalledTimes(1);
  });

  it('repeated enforce before evictions resolve → exactly (n-cap) total victims (no over-eviction)', async () => {
    detach = vi.fn(() => new Promise<void>(() => {})); // never resolves — evictions stay in-flight
    (globalThis as any).window.api.terminal.detach = detach;
    for (let i = 0; i < CAP + 2; i++) put(`a${i}`); // 10 entries → 2 overflow
    enforceLiveTerminalBound(new Set());
    await tick(); // save done; stuck at detach; entries flagged evicting, still cached
    enforceLiveTerminalBound(new Set()); // eligible now excludes the 2 evicting → overflow 0
    await tick();
    expect(saveCheckpoint).toHaveBeenCalledTimes(2); // exactly 2 victims total
    expect(saveCheckpoint.mock.calls.map((c) => c[0]).sort()).toEqual(['a0', 'a1']);
  });

  it('a NEWER entry already evicting (death-reaper) is not double-counted → no over-eviction', async () => {
    detach = vi.fn(() => new Promise<void>(() => {})); // hold evictions in-flight
    (globalThis as any).window.api.terminal.detach = detach;
    for (let i = 0; i < CAP + 1; i++) put(`a${i}`); // 9 entries, a8 is NEWEST
    // The newest agent died → the reaper evicts it out-of-band (mid-flight).
    void evictCachedTerminal('a8');
    await tick(); // a8 now flagged evicting, still cached (detach held)
    // Enforce: 8 non-evicting remain (a0..a7) ⇒ overflow 0. If `evicting` were
    // NOT excluded, eligible would be 9 (incl. a8) ⇒ overflow 1 ⇒ a0 wrongly evicted.
    enforceLiveTerminalBound(new Set());
    await tick();
    expect(terminalCache.has('a0')).toBe(true); // NOT over-evicted
    expect(saveCheckpoint).toHaveBeenCalledTimes(1); // only the reaper's a8
    expect(saveCheckpoint.mock.calls[0][0]).toBe('a8');
  });
});

describe('evictCachedTerminal', () => {
  it('saves a checkpoint (awaiting lastWrite first) then detaches, disposes, and removes', async () => {
    const e = put('a', { epoch: 'epZ', appliedOffset: 42 });
    await evictCachedTerminal('a');
    // lastWrite awaited BEFORE serialize; serialize feeds saveCheckpoint.
    expect(e.__events.indexOf('lastWrite')).toBeLessThan(e.__events.indexOf('serialize'));
    expect(saveCheckpoint).toHaveBeenCalledWith('a', 'epZ', 'SER:a', 42);
    expect(detach).toHaveBeenCalledWith('a', 'epZ'); // epoch-scoped
    expect(e.__disposed()).toBe(true);
    expect(terminalCache.has('a')).toBe(false);
    expect(awaitTerminalEviction('a')).toBeInstanceOf(Promise); // resolved, no lingering entry
  });

  it('is single-flight — a second call returns the same in-flight promise, saving once', async () => {
    detach = vi.fn(() => new Promise<void>(() => {})); // hold in-flight
    (globalThis as any).window.api.terminal.detach = detach;
    const e = put('a');
    const p1 = evictCachedTerminal('a');
    const p2 = evictCachedTerminal('a');
    expect(p1).toBe(p2);
    expect(awaitTerminalEviction('a')).toBe(p1); // reopen would await the same promise
    await tick();
    expect(saveCheckpoint).toHaveBeenCalledTimes(1);
    expect(e.evicting).toBe(true);
    expect(terminalCache.has('a')).toBe(true); // stays cached until eviction settles
  });

  it('disposes + removes even when saveCheckpoint REJECTS (finally always runs)', async () => {
    saveCheckpoint = vi.fn(() => Promise.reject(new Error('save boom')));
    (globalThis as any).window.api.terminal.saveCheckpoint = saveCheckpoint;
    const e = put('a');
    await evictCachedTerminal('a');
    expect(warnSpy).toHaveBeenCalled(); // checkpoint failure → warn
    expect(detach).toHaveBeenCalled(); // still detaches after a failed save
    expect(e.__disposed()).toBe(true);
    expect(terminalCache.has('a')).toBe(false);
  });

  it('disposes + removes even when detach REJECTS, and logs it distinctly from a save failure', async () => {
    detach = vi.fn(() => Promise.reject(new Error('detach boom')));
    (globalThis as any).window.api.terminal.detach = detach;
    const e = put('a');
    await evictCachedTerminal('a');
    expect(errorSpy).toHaveBeenCalled(); // detach failure → error (not warn)
    expect(warnSpy).not.toHaveBeenCalled(); // save succeeded → no warn
    expect(e.__disposed()).toBe(true);
    expect(terminalCache.has('a')).toBe(false);
  });

  it('a degraded entry (logOffsetsReliable:false) is evicted WITHOUT a checkpoint save', async () => {
    const e = put('a', { logOffsetsReliable: false });
    await evictCachedTerminal('a');
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect((e.serialize.serialize as any)).not.toHaveBeenCalled(); // never even serialized
    expect(detach).toHaveBeenCalledWith('a', 'e1');
    expect(e.__disposed()).toBe(true);
    expect(terminalCache.has('a')).toBe(false);
  });

  it('an unknown id resolves without touching IPC', async () => {
    await evictCachedTerminal('ghost');
    expect(saveCheckpoint).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
  });

  it('holds the entry visible in the cache while save+detach are pending (rapid-reopen window)', async () => {
    detach = vi.fn(() => new Promise<void>(() => {}));
    (globalThis as any).window.api.terminal.detach = detach;
    const e = put('a');
    void evictCachedTerminal('a');
    expect(e.evicting).toBe(true); // set synchronously
    await tick();
    // Still present (a reopen must await eviction rather than see a disposed xterm).
    expect(terminalCache.has('a')).toBe(true);
    expect(e.__disposed()).toBe(false);
  });
});

describe('disposeCachedTerminalLocal (rebound-only)', () => {
  it('drops the subscription + xterm but never calls the main detach', () => {
    const e = put('a');
    const ok = disposeCachedTerminalLocal('a');
    expect(ok).toBe(true);
    expect(e.unsub).toHaveBeenCalled();
    expect(e.__disposed()).toBe(true);
    expect(detach).not.toHaveBeenCalled(); // main already tore down the retired epoch
    expect(terminalCache.has('a')).toBe(false);
  });

  it('returns false for an unknown id', () => {
    expect(disposeCachedTerminalLocal('ghost')).toBe(false);
  });
});
