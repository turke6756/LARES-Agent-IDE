// @vitest-environment jsdom
/**
 * WP1-A tests for the two useFileContentCache seams added in Phase 1:
 * the write-generation token (recent-writes map, plan §5) and the
 * registerFreshContentHandler registry.
 *
 * Phase 0 (edit-loss) adds the guard-chain defect-locking trio — late echo
 * past the 10s TTL (H2b), out-of-order revalidate reads (H2c), and the
 * failed-write echo token (R5) — as `test.fails` cases
 * (plans/markdown-editor-edit-loss-implementation.md §0.3(3)).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  consultFreshContentHandler,
  evictTabCache,
  isRecentWriteEcho,
  recordRecentWrite,
  registerFreshContentHandler,
  useFileContentCache,
} from './useFileContentCache';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { FileContent, FsEvent } from '../../../shared/types';

describe('recent-writes map (write-generation token)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('matches a write recorded for the same tab and content', () => {
    recordRecentWrite('tab-rw-1', 'hello\nworld\n');
    expect(isRecentWriteEcho('tab-rw-1', 'hello\nworld\n')).toBe(true);
  });

  it('does not match different content or a different tab', () => {
    recordRecentWrite('tab-rw-2', 'content A');
    expect(isRecentWriteEcho('tab-rw-2', 'content B')).toBe(false);
    expect(isRecentWriteEcho('tab-rw-other', 'content A')).toBe(false);
  });

  it('keeps several rapid writes for the same tab alive at once', () => {
    recordRecentWrite('tab-rw-3', 'save one');
    vi.advanceTimersByTime(1_000);
    recordRecentWrite('tab-rw-3', 'save two');
    expect(isRecentWriteEcho('tab-rw-3', 'save one')).toBe(true);
    expect(isRecentWriteEcho('tab-rw-3', 'save two')).toBe(true);
  });

  it('expires entries after the TTL', () => {
    recordRecentWrite('tab-rw-4', 'ephemeral');
    vi.advanceTimersByTime(9_000);
    expect(isRecentWriteEcho('tab-rw-4', 'ephemeral')).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(isRecentWriteEcho('tab-rw-4', 'ephemeral')).toBe(false);
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

// ── Phase 0 guard-chain defect locks (edit-loss §0.3(3)) ────────────────────

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

describe('guard chain: late own-save echo past the 10s TTL (H2b)', () => {
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

  // FIXME(edit-loss): un-fail in Phase 3 — a byte-identical fresh read must
  // never be classified as a conflict regardless of dirty state (drop the
  // `!editState.dirty` restriction at useFileContentCache.ts:135; the write
  // ledger replaces the flat 10s TTL at :129).
  it.fails(
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
        recordRecentWrite(TAB, SAVED);
        // …then resumed editing (dirty again)…
        store.setDraftContent(TAB, 'saved bytes\nplus resumed edits\n');
        // …and the save evicted the tab cache (dashboard-store.ts saveTab).
        evictTabCache(TAB);

        // The watcher echo lands 11s later (WSL poll backoff / suspend): the
        // TTL has expired and the cache is empty.
        vi.advanceTimersByTime(11_000);
        diskContent = SAVED;

        act(() => {
          for (const cb of api.watcherCbs) cb({ type: 'change', path: FILE, parentDir: 'C:/ws' });
        });
        await flushMicrotasks();

        // Desired: bytes identical to our own save terminate in the guard
        // chain — no handler consult, no banner.
        expect(handler).not.toHaveBeenCalled();
        expect(useDashboardStore.getState().tabEditState[TAB]?.externalChange).toBeFalsy();
      } finally {
        dispose();
        await mounted.unmount();
      }
    },
  );
});

describe('guard chain: out-of-order revalidate reads (H2c)', () => {
  const TAB = 'tab-guard-order';
  const FILE = 'C:/ws/order.md';

  beforeEach(() => {
    useDashboardStore.setState({ openTabs: [], activeTabId: null, tabEditState: {} });
    evictTabCache(TAB);
  });

  // FIXME(edit-loss): un-fail in Phase 3 — generation-ordered reads
  // (useFileContentCache.ts §3.3) discard a stale read that resolves last.
  it.fails('a stale read resolving after a newer one is discarded', async () => {
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
      expect(mounted.host.querySelector('[data-testid="cache-probe"]')!.getAttribute('data-content')).toBe('v0\n');

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

      // Desired: the stale resolution is discarded — the newest read wins.
      expect(
        mounted.host.querySelector('[data-testid="cache-probe"]')!.getAttribute('data-content'),
      ).toBe('new bytes\n');
    } finally {
      await mounted.unmount();
    }
  });
});

describe('guard chain: failed-write echo token (R5)', () => {
  const TAB = 'tab-guard-failed-write';

  beforeEach(() => {
    useDashboardStore.setState({ openTabs: [], activeTabId: null, tabEditState: {} });
  });

  // FIXME(edit-loss): un-fail in Phase 3 — beginWrite/invalidate() removes the
  // token when the write fails, so an identical EXTERNAL write is not
  // suppressed as our own echo (today recordRecentWrite fires before the
  // write and survives failure — dashboard-store.ts:806-815).
  it.fails('a failed save must not leave a live echo token for the bytes that never reached disk', async () => {
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

    // Desired: the failed write's token is invalidated — an identical write
    // arriving from OUTSIDE must be surfaced, not swallowed for 10s.
    expect(isRecentWriteEcho(TAB, 'draft v1\n')).toBe(false);
  });
});
