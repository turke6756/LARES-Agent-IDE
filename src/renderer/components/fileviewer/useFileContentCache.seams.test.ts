// @vitest-environment jsdom
/**
 * Tests for the useFileContentCache seams: the generation-token write ledger
 * (edit-loss Phase 3 §3.2, replacing the Phase-1 recent-writes TTL map),
 * generation-ordered reads (§3.3), and the registerFreshContentHandler
 * registry (WP1-A task 5).
 *
 * The Phase 0 guard-chain defect-locking trio — late echo past the old 10s
 * TTL (H2b), out-of-order revalidate reads (H2c), and the failed-write echo
 * token (R5) — was un-failed in Phase 3
 * (plans/markdown-editor-edit-loss-implementation.md §3.4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  beginWrite,
  consultFreshContentHandler,
  dropWritesBelowGeneration,
  evictTabCache,
  matchRecentWrite,
  registerFreshContentHandler,
  useFileContentCache,
} from './useFileContentCache';
import { contentHash } from './markdownSplice';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { FileContent, FsEvent } from '../../../shared/types';

describe('write ledger (generation tokens, §3.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('matches a committed write for the same tab and hash', () => {
    const h = contentHash('hello\nworld\n');
    const token = beginWrite('tab-wl-1', h);
    token.commit();
    expect(matchRecentWrite('tab-wl-1', h)).toEqual({
      generation: token.generation,
      state: 'committed',
    });
  });

  it('matches a still-pending write (watcher can outrun the write IPC)', () => {
    const h = contentHash('in flight');
    const token = beginWrite('tab-wl-pending', h);
    expect(matchRecentWrite('tab-wl-pending', h)).toEqual({
      generation: token.generation,
      state: 'pending',
    });
  });

  it('does not match a different hash or a different tab', () => {
    beginWrite('tab-wl-2', contentHash('content A')).commit();
    expect(matchRecentWrite('tab-wl-2', contentHash('content B'))).toBeNull();
    expect(matchRecentWrite('tab-wl-other', contentHash('content A'))).toBeNull();
  });

  it('keeps several rapid committed writes for the same tab alive at once', () => {
    beginWrite('tab-wl-3', contentHash('save one')).commit();
    vi.advanceTimersByTime(1_000);
    beginWrite('tab-wl-3', contentHash('save two')).commit();
    expect(matchRecentWrite('tab-wl-3', contentHash('save one'))).not.toBeNull();
    expect(matchRecentWrite('tab-wl-3', contentHash('save two'))).not.toBeNull();
  });

  it('generations are monotonic per tab', () => {
    const a = beginWrite('tab-wl-mono', contentHash('a'));
    const b = beginWrite('tab-wl-mono', contentHash('b'));
    expect(b.generation).toBeGreaterThan(a.generation);
    a.invalidate();
    b.invalidate();
    // Counter never resets, even after the ledger empties.
    const c = beginWrite('tab-wl-mono', contentHash('c'));
    expect(c.generation).toBeGreaterThan(b.generation);
  });

  it('expires committed entries after 5 minutes', () => {
    const h = contentHash('ephemeral');
    beginWrite('tab-wl-4', h).commit();
    vi.advanceTimersByTime(4 * 60_000);
    expect(matchRecentWrite('tab-wl-4', h)).not.toBeNull();
    vi.advanceTimersByTime(61_000);
    expect(matchRecentWrite('tab-wl-4', h)).toBeNull();
  });

  it('invalidate() removes the token so the hash no longer matches', () => {
    const h = contentHash('never landed');
    const token = beginWrite('tab-wl-5', h);
    token.invalidate();
    expect(matchRecentWrite('tab-wl-5', h)).toBeNull();
  });

  it('duplicate-hash entries: matchRecentWrite returns the HIGHEST generation', () => {
    const h = contentHash('same bytes');
    const t1 = beginWrite('tab-wl-dup', h);
    t1.commit();
    const t2 = beginWrite('tab-wl-dup', h);
    t2.commit();
    expect(matchRecentWrite('tab-wl-dup', h)).toEqual({
      generation: t2.generation,
      state: 'committed',
    });
    expect(t2.generation).toBeGreaterThan(t1.generation);
  });

  it('a failed later write with an identical hash leaves the earlier committed token live', () => {
    const h = contentHash('same bytes again');
    const committed = beginWrite('tab-wl-idem', h);
    committed.commit();
    const failed = beginWrite('tab-wl-idem', h);
    failed.invalidate();
    // invalidate() removed THAT EXACT generation only.
    expect(matchRecentWrite('tab-wl-idem', h)).toEqual({
      generation: committed.generation,
      state: 'committed',
    });
  });

  it('caps committed entries at 8 per tab, dropping the oldest by generation', () => {
    const hashes = Array.from({ length: 10 }, (_, i) => contentHash(`save ${i}`));
    for (const h of hashes) beginWrite('tab-wl-cap', h).commit();
    // 10 committed → the 2 oldest generations are GC'd on next ledger touch.
    expect(matchRecentWrite('tab-wl-cap', hashes[0])).toBeNull();
    expect(matchRecentWrite('tab-wl-cap', hashes[1])).toBeNull();
    for (const h of hashes.slice(2)) {
      expect(matchRecentWrite('tab-wl-cap', h)).not.toBeNull();
    }
  });

  it('supersession: dropWritesBelowGeneration removes every older token', () => {
    const hOld = contentHash('older save');
    const hNew = contentHash('newer save');
    beginWrite('tab-wl-sup', hOld).commit();
    const newer = beginWrite('tab-wl-sup', hNew);
    newer.commit();
    dropWritesBelowGeneration('tab-wl-sup', newer.generation);
    expect(matchRecentWrite('tab-wl-sup', hOld)).toBeNull();
    expect(matchRecentWrite('tab-wl-sup', hNew)).not.toBeNull();
  });

  it('a pending token neither committed nor invalidated expires after 30s and DIAG-logs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const h = contentHash('stuck write');
      beginWrite('tab-wl-stuck', h);
      vi.advanceTimersByTime(29_000);
      expect(matchRecentWrite('tab-wl-stuck', h)).not.toBeNull();
      warn.mockClear();
      vi.advanceTimersByTime(2_000);
      expect(matchRecentWrite('tab-wl-stuck', h)).toBeNull();
      // A write that never resolved is a bug in the save path — the expiry
      // must be visible in the DIAG stream.
      expect(
        warn.mock.calls.some((args) => args.includes('write-ledger-pending-expired')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('registerFreshContentHandler registry', () => {
  it('returns null when no handler is registered', () => {
    expect(consultFreshContentHandler('tab-h-none', 'fresh')).toBeNull();
  });

  it('routes fresh content to the registered handler and returns its verdict', () => {
    const handler = vi.fn().mockReturnValue('conflict' as const);
    const dispose = registerFreshContentHandler('tab-h-1', handler);
    expect(consultFreshContentHandler('tab-h-1', 'fresh bytes')).toBe('conflict');
    expect(handler).toHaveBeenCalledWith('fresh bytes');
    dispose();
    expect(consultFreshContentHandler('tab-h-1', 'fresh bytes')).toBeNull();
  });

  it('supports all three verdicts', () => {
    for (const verdict of ['handled', 'conflict', 'fallback'] as const) {
      const dispose = registerFreshContentHandler('tab-h-2', () => verdict);
      expect(consultFreshContentHandler('tab-h-2', 'x')).toBe(verdict);
      dispose();
    }
  });

  it('re-registration replaces the handler; a stale disposer is a no-op', () => {
    const disposeOld = registerFreshContentHandler('tab-h-3', () => 'conflict');
    const disposeNew = registerFreshContentHandler('tab-h-3', () => 'fallback');
    expect(consultFreshContentHandler('tab-h-3', 'x')).toBe('fallback');
    // Disposing the superseded registration must not remove the new handler
    // (remount races: old cleanup can run after the new mount registered).
    disposeOld();
    expect(consultFreshContentHandler('tab-h-3', 'x')).toBe('fallback');
    disposeNew();
    expect(consultFreshContentHandler('tab-h-3', 'x')).toBeNull();
  });
});

// ── Guard-chain tests (edit-loss §0.3(3), un-failed in Phase 3; + §3.4) ─────

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface FilesApiMock {
  watcherCbs: Array<(event: FsEvent) => void>;
  readFile: ReturnType<typeof vi.fn>;
}

function installFilesApi(readImpl: () => Promise<FileContent>): FilesApiMock {
  const watcherCbs: Array<(event: FsEvent) => void> = [];
  const readFile = vi.fn(() => readImpl());
  (window as unknown as { api: unknown }).api = {
    files: {
      readFile,
      writeFile: vi.fn(async () => ({ ok: true })),
      watchDirectory: vi.fn(
        (_dir: string, _pt: string, cb: (event: FsEvent) => void) => {
          watcherCbs.push(cb);
          return () => {};
        },
      ),
    },
  };
  return { watcherCbs, readFile };
}

function fileContent(path: string, content: string): FileContent {
  return { path, content, encoding: 'utf8', size: content.length };
}

interface MountedProbe {
  host: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}

const flushMicrotasks = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

/** Minimal component exposing the hook's current content for assertions. */
function CacheProbe({ tabId, filePath }: { tabId: string; filePath: string }) {
  const { content } = useFileContentCache(tabId, filePath, 'windows');
  return React.createElement('div', {
    'data-testid': 'cache-probe',
    'data-content': content?.content ?? '',
  });
}

async function mountProbe(tabId: string, filePath: string): Promise<MountedProbe> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(CacheProbe, { tabId, filePath }));
  });
  await flushMicrotasks();
  return {
    host,
    root,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function probeContent(probe: MountedProbe): string | null {
  return probe.host
    .querySelector('[data-testid="cache-probe"]')!
    .getAttribute('data-content');
}

describe('guard chain: late own-save echo past the old 10s TTL (H2b)', () => {
  const TAB = 'tab-guard-echo';
  const FILE = 'C:/ws/echo.md';

  beforeEach(() => {
    vi.useFakeTimers();
    useDashboardStore.setState({ openTabs: [], activeTabId: null, tabEditState: {} });
    evictTabCache(TAB);
  });
  afterEach(() => {
    vi.useRealTimers();
    useDashboardStore.setState({ tabEditState: {} });
  });

  it(
    'an echo of our own save arriving >10s later while the user resumed editing never reaches the handler',
    async () => {
      let diskContent = 'old bytes\n';
      const api = installFilesApi(async () => fileContent(FILE, diskContent));
      const mounted = await mountProbe(TAB, FILE);
      const handler = vi.fn(() => 'conflict' as const);
      const dispose = registerFreshContentHandler(TAB, handler);
      try {
        expect(api.watcherCbs.length).toBeGreaterThan(0);

        // The user saved: store rebaselined on the written bytes…
        const SAVED = 'saved bytes\n';
        const store = useDashboardStore.getState();
        store.enterWysiwygMode(TAB, SAVED);
        beginWrite(TAB, contentHash(SAVED)).commit();
        // …then resumed editing (dirty again)…
        store.setDraftContent(TAB, 'saved bytes\nplus resumed edits\n');
        // …and the save evicted the tab cache (dashboard-store.ts saveTab).
        evictTabCache(TAB);

        // The watcher echo lands 11s later (WSL poll backoff / suspend): the
        // old flat TTL would have expired; the ledger keeps committed tokens
        // for 5 minutes, and guard 3.1 backstops on originalContent equality.
        vi.advanceTimersByTime(11_000);
        diskContent = SAVED;

        act(() => {
          for (const cb of api.watcherCbs) cb({ type: 'change', path: FILE, parentDir: 'C:/ws' });
        });
        await flushMicrotasks();

        // Bytes identical to our own save terminate in the guard chain — no
        // handler consult, no banner.
        expect(handler).not.toHaveBeenCalled();
        expect(useDashboardStore.getState().tabEditState[TAB]?.externalChange).toBeFalsy();
      } finally {
        dispose();
        await mounted.unmount();
      }
    },
  );
});

describe('guard chain: byte-identical disk baseline while dirty (§3.1)', () => {
  const TAB = 'tab-guard-baseline';
  const FILE = 'C:/ws/baseline.md';

  beforeEach(() => {
    useDashboardStore.setState({ openTabs: [], activeTabId: null, tabEditState: {} });
    evictTabCache(TAB);
  });
  afterEach(() => {
    useDashboardStore.setState({ tabEditState: {} });
  });

  it('a fresh read matching originalContent never conflicts even with no ledger token', async () => {
    // No beginWrite at all — e.g. the token aged out or the write happened in
    // a previous session. originalContent equality alone must terminate.
    let diskContent = 'old bytes\n';
    const api = installFilesApi(async () => fileContent(FILE, diskContent));
    const mounted = await mountProbe(TAB, FILE);
    const handler = vi.fn(() => 'conflict' as const);
    const dispose = registerFreshContentHandler(TAB, handler);
    try {
      const BASELINE = 'baseline bytes\n';
      const store = useDashboardStore.getState();
      store.enterWysiwygMode(TAB, BASELINE);
      store.setDraftContent(TAB, 'baseline bytes\nplus edits\n'); // dirty
      evictTabCache(TAB);
      diskContent = BASELINE;

      act(() => {
        for (const cb of api.watcherCbs) cb({ type: 'change', path: FILE, parentDir: 'C:/ws' });
      });
      await flushMicrotasks();

      expect(handler).not.toHaveBeenCalled();
      expect(useDashboardStore.getState().tabEditState[TAB]?.externalChange).toBeFalsy();
    } finally {
      dispose();
      await mounted.unmount();
    }
  });
});

describe('guard chain: out-of-order revalidate reads (H2c)', () => {
  const TAB = 'tab-guard-order';
  const FILE = 'C:/ws/order.md';

  beforeEach(() => {
    useDashboardStore.setState({ openTabs: [], activeTabId: null, tabEditState: {} });
    evictTabCache(TAB);
  });

  it('a stale read resolving after a newer one is discarded', async () => {
    // Model the verified main-process behavior: src/main/ipc-handlers.ts:762-773
    // batches fs events per subscription for 50ms with NO deduplication, so one
    // batch delivers multiple events for the same path and each triggers its
    // own revalidate() with an independent readFile.
    interface Deferred {
      resolve: (c: FileContent) => void;
      promise: Promise<FileContent>;
    }
    const deferreds: Deferred[] = [];
    let initialDone = false;
    const api = installFilesApi(() => {
      if (!initialDone) {
        initialDone = true;
        return Promise.resolve(fileContent(FILE, 'v0\n'));
      }
      let resolve!: (c: FileContent) => void;
      const promise = new Promise<FileContent>((r) => {
        resolve = r;
      });
      deferreds.push({ resolve, promise });
      return promise;
    });

    const mounted = await mountProbe(TAB, FILE);
    try {
      expect(probeContent(mounted)).toBe('v0\n');

      // One 50ms batch, two events for the same path → two overlapping reads.
      act(() => {
        for (const cb of api.watcherCbs) {
          cb({ type: 'change', path: FILE, parentDir: 'C:/ws' });
          cb({ type: 'change', path: FILE, parentDir: 'C:/ws' });
        }
      });
      expect(deferreds).toHaveLength(2);

      // The NEWER read (second event) resolves first with the post-write bytes;
      // the STALE pre-write read resolves last.
      await act(async () => {
        deferreds[1].resolve(fileContent(FILE, 'new bytes\n'));
        await Promise.resolve();
      });
      await flushMicrotasks();
      await act(async () => {
        deferreds[0].resolve(fileContent(FILE, 'stale pre-save bytes\n'));
        await Promise.resolve();
      });
      await flushMicrotasks();

      // The stale resolution is discarded — the newest read wins.
      expect(probeContent(mounted)).toBe('new bytes\n');
    } finally {
      await mounted.unmount();
    }
  });

  it('a multi-event 50ms batch (no dedup) coalesces to the latest read', async () => {
    const TAB3 = 'tab-guard-batch';
    const FILE3 = 'C:/ws/batch.md';
    evictTabCache(TAB3);
    interface Deferred {
      resolve: (c: FileContent) => void;
    }
    const deferreds: Deferred[] = [];
    let initialDone = false;
    const api = installFilesApi(() => {
      if (!initialDone) {
        initialDone = true;
        return Promise.resolve(fileContent(FILE3, 'v0\n'));
      }
      let resolve!: (c: FileContent) => void;
      const promise = new Promise<FileContent>((r) => {
        resolve = r;
      });
      deferreds.push({ resolve });
      return promise;
    });

    const mounted = await mountProbe(TAB3, FILE3);
    try {
      // One batch, THREE events for the same path (rapid successive writes).
      act(() => {
        for (const cb of api.watcherCbs) {
          cb({ type: 'change', path: FILE3, parentDir: 'C:/ws' });
          cb({ type: 'change', path: FILE3, parentDir: 'C:/ws' });
          cb({ type: 'change', path: FILE3, parentDir: 'C:/ws' });
        }
      });
      expect(deferreds).toHaveLength(3);

      // Resolutions land wildly out of order: latest first, then the stale two.
      await act(async () => {
        deferreds[2].resolve(fileContent(FILE3, 'v3 final\n'));
        await Promise.resolve();
      });
      await flushMicrotasks();
      await act(async () => {
        deferreds[0].resolve(fileContent(FILE3, 'v1 stale\n'));
        deferreds[1].resolve(fileContent(FILE3, 'v2 stale\n'));
        await Promise.resolve();
      });
      await flushMicrotasks();

      // Only the latest generation's resolution applies.
      expect(probeContent(mounted)).toBe('v3 final\n');
    } finally {
      await mounted.unmount();
    }
  });

  it("an old hook instance's cleanup does not clear the new instance's read generation", async () => {
    const TAB4 = 'tab-guard-cleanup';
    const FILE4 = 'C:/ws/cleanup.md';
    evictTabCache(TAB4);
    interface Deferred {
      resolve: (c: FileContent) => void;
    }
    const deferreds: Deferred[] = [];
    let reads = 0;
    installFilesApi(() => {
      reads += 1;
      if (reads === 1) {
        // First mount's initial read resolves immediately.
        return Promise.resolve(fileContent(FILE4, 'v0\n'));
      }
      let resolve!: (c: FileContent) => void;
      const promise = new Promise<FileContent>((r) => {
        resolve = r;
      });
      deferreds.push({ resolve });
      return promise;
    });

    const first = await mountProbe(TAB4, FILE4);
    expect(probeContent(first)).toBe('v0\n');

    // Second instance mounts for the same tab/file (e.g. tab switch back)
    // and starts its cached-mount revalidate (still in flight)…
    const second = await mountProbe(TAB4, FILE4);
    expect(deferreds).toHaveLength(1);

    // …THEN the old instance's cleanup runs. If cleanup deleted the readGen
    // key, the new instance's in-flight read would be discarded as stale.
    await first.unmount();

    await act(async () => {
      deferreds[0].resolve(fileContent(FILE4, 'fresh after remount\n'));
      await Promise.resolve();
    });
    await flushMicrotasks();

    try {
      expect(probeContent(second)).toBe('fresh after remount\n');
    } finally {
      await second.unmount();
    }
  });
});

describe('guard chain: failed-write echo token (R5)', () => {
  const TAB = 'tab-guard-failed-write';

  beforeEach(() => {
    useDashboardStore.setState({ openTabs: [], activeTabId: null, tabEditState: {} });
  });

  it('a failed save must not leave a live echo token for the bytes that never reached disk', async () => {
    useDashboardStore.setState({
      openTabs: [
        {
          id: TAB,
          filePath: 'C:/ws/failed.md',
          rootDirectory: 'C:/ws',
          pathType: 'windows',
          label: 'failed.md',
        } as never,
      ],
    });
    (window as unknown as { api: unknown }).api = {
      files: { writeFile: vi.fn(async () => ({ ok: false, error: 'disk full' })) },
    };
    const store = useDashboardStore.getState();
    store.enterSourceMode(TAB, 'original\n');
    store.setDraftContent(TAB, 'draft v1\n');

    const ok = await store.saveTab(TAB);
    expect(ok).toBe(false);

    // The failed write's token is invalidated — an identical write arriving
    // from OUTSIDE must be surfaced, not swallowed.
    expect(matchRecentWrite(TAB, contentHash('draft v1\n'))).toBeNull();
  });
});

describe('write-ledger supersession through revalidate (§3.2c consequence)', () => {
  const TAB = 'tab-guard-supersede';
  const FILE = 'C:/ws/supersede.md';

  beforeEach(() => {
    useDashboardStore.setState({ openTabs: [], activeTabId: null, tabEditState: {} });
    evictTabCache(TAB);
  });
  afterEach(() => {
    useDashboardStore.setState({ tabEditState: {} });
  });

  it('an old saved hash arriving after a newer generation was disk-confirmed is a genuine regression — NOT suppressed', async () => {
    const OLD_SAVE = 'first save bytes\n';
    const NEW_SAVE = 'second save bytes\n';
    let diskContent = 'v0\n';
    const api = installFilesApi(async () => fileContent(FILE, diskContent));
    const mounted = await mountProbe(TAB, FILE);
    const handler = vi.fn(() => 'conflict' as const);
    const dispose = registerFreshContentHandler(TAB, handler);
    try {
      const store = useDashboardStore.getState();
      // Two saves landed: gen1 (OLD_SAVE), then gen2 (NEW_SAVE, our baseline).
      beginWrite(TAB, contentHash(OLD_SAVE)).commit();
      beginWrite(TAB, contentHash(NEW_SAVE)).commit();
      store.enterWysiwygMode(TAB, NEW_SAVE);
      evictTabCache(TAB);

      // The NEW save's echo is disk-confirmed → suppressed as our own echo,
      // and every generation below it is dropped from the ledger.
      diskContent = NEW_SAVE;
      act(() => {
        for (const cb of api.watcherCbs) cb({ type: 'change', path: FILE, parentDir: 'C:/ws' });
      });
      await flushMicrotasks();
      expect(handler).not.toHaveBeenCalled();

      // Now the OLD saved bytes reappear on disk (external revert / another
      // writer). That is a genuine regression: it must reach the handler.
      diskContent = OLD_SAVE;
      act(() => {
        for (const cb of api.watcherCbs) cb({ type: 'change', path: FILE, parentDir: 'C:/ws' });
      });
      await flushMicrotasks();

      expect(handler).toHaveBeenCalledWith(OLD_SAVE);
      expect(useDashboardStore.getState().tabEditState[TAB]?.externalChange).toBe(true);
    } finally {
      dispose();
      await mounted.unmount();
    }
  });
});
