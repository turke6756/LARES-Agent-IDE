// @vitest-environment jsdom
/**
 * saveCoordinator.flushAll (edit-loss plan §4.3, renderer side of the
 * app-close handshake) against the REAL store with a controllable write:
 * per-tab outcomes (saved / pristine / conflict / error / timeout), 'retry'
 * targeting by tabIds, and 'force' targeting ONLY conflict tabs with an
 * unconditional write.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { ConditionalWriteResult } from '../../../shared/types';
import { flushAll, isConflictPaused, noteEdit, requestSave } from './saveCoordinator';

const ORIGINAL = 'original content\n';

interface PendingWrite {
  path: string;
  content: string;
  expectedHash: string | null | undefined;
  resolve: (r: ConditionalWriteResult) => void;
}

let pendingWrites: PendingWrite[];
let writeFile: ReturnType<typeof vi.fn>;

function installApi() {
  pendingWrites = [];
  writeFile = vi.fn(
    (path: string, _root: string, _pt: string, content: string, expectedHash: string | null | undefined) =>
      new Promise<ConditionalWriteResult>((resolve) => {
        pendingWrites.push({ path, content, expectedHash, resolve });
      }),
  );
  (window as unknown as { api: unknown }).api = { files: { writeFile } };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

let tabCounter = 0;

function seedTab(overrides: Record<string, unknown> = {}): string {
  const tabId = `flush-tab-${++tabCounter}`;
  useDashboardStore.setState((s) => ({
    openTabs: [
      ...s.openTabs,
      {
        id: tabId,
        filePath: `C:\\ws\\${tabId}.md`,
        rootDirectory: 'C:\\ws',
        pathType: 'windows',
        label: `${tabId}.md`,
        workspaceId: 'ws1',
      } as never,
    ],
    tabEditState: {
      ...s.tabEditState,
      [tabId]: {
        mode: 'source',
        draftContent: ORIGINAL,
        originalContent: ORIGINAL,
        dirty: false,
        saving: false,
        error: null,
        ...overrides,
      } as never,
    },
  }));
  return tabId;
}

const byTab = (results: Awaited<ReturnType<typeof flushAll>>, tabId: string) =>
  results.find((r) => r.tabId === tabId);

/** Drive a tab into the conflict-paused state via a real CAS refusal. */
async function conflictTab(): Promise<string> {
  const tabId = seedTab({ draftContent: 'mine\n', dirty: true });
  noteEdit(tabId);
  const p = requestSave(tabId);
  await flush();
  const w = pendingWrites.pop()!;
  w.resolve({ ok: false, conflict: true, freshContent: 'external\n' });
  await flush();
  expect(await p).toBe(false);
  expect(isConflictPaused(tabId)).toBe(true);
  return tabId;
}

beforeEach(() => {
  installApi();
});

afterEach(() => {
  useDashboardStore.setState({ openTabs: [], tabEditState: {} });
});

describe('flushAll (§4.3)', () => {
  it('reports pristine / saved outcomes and file basenames', async () => {
    const clean = seedTab();
    const dirty = seedTab({ draftContent: 'work\n', dirty: true });

    const p = flushAll(5_000);
    await flush();
    expect(pendingWrites).toHaveLength(1);
    expect(pendingWrites[0].content).toBe('work\n');
    pendingWrites[0].resolve({ ok: true, path: 'x' });
    const results = await p;

    expect(byTab(results, clean)).toMatchObject({ outcome: 'pristine', fileName: `${clean}.md` });
    expect(byTab(results, dirty)).toMatchObject({ outcome: 'saved', fileName: `${dirty}.md` });
  });

  it('a conflict-paused tab reports conflict WITHOUT re-attempting the doomed write', async () => {
    const paused = await conflictTab();
    const before = writeFile.mock.calls.length;

    const results = await flushAll(5_000);
    expect(byTab(results, paused)?.outcome).toBe('conflict');
    expect(writeFile.mock.calls.length).toBe(before); // no new write
  });

  it('a failed save reports error with the store message', async () => {
    const tabId = seedTab({ draftContent: 'work\n', dirty: true });
    const p = flushAll(5_000);
    await flush();
    pendingWrites[0].resolve({ ok: false, error: 'disk on fire', code: 'io' });
    const results = await p;
    expect(byTab(results, tabId)).toMatchObject({ outcome: 'error', error: 'disk on fire' });
  });

  it('a write that outlives the deadline reports timeout', async () => {
    const tabId = seedTab({ draftContent: 'work\n', dirty: true });
    const results = await flushAll(30); // write never settles
    expect(byTab(results, tabId)?.outcome).toBe('timeout');
  });

  it("'retry' targets only the listed tabs", async () => {
    seedTab({ draftContent: 'other\n', dirty: true }); // dirty but NOT listed
    const listed = seedTab({ draftContent: 'listed\n', dirty: true });

    const p = flushAll(5_000, { action: 'retry', tabIds: [listed] });
    await flush();
    expect(pendingWrites).toHaveLength(1);
    expect(pendingWrites[0].content).toBe('listed\n');
    pendingWrites[0].resolve({ ok: true, path: 'x' });
    const results = await p;
    expect(results.map((r) => r.tabId)).toEqual([listed]);
  });

  it("'force' targets ONLY conflict tabs and writes unconditionally (expectedHash undefined)", async () => {
    seedTab({ draftContent: 'plain dirty\n', dirty: true }); // dirty, NOT in conflict
    const paused = await conflictTab();

    const p = flushAll(5_000, { action: 'force' });
    await flush();
    expect(pendingWrites).toHaveLength(1);
    expect(pendingWrites[0].content).toBe('mine\n');
    expect(pendingWrites[0].expectedHash).toBeUndefined(); // unconditional
    pendingWrites[0].resolve({ ok: true, path: 'x' });
    const results = await p;
    expect(results.map((r) => r.tabId)).toEqual([paused]);
    expect(byTab(results, paused)?.outcome).toBe('saved');
    expect(isConflictPaused(paused)).toBe(false); // success lifts the pause
  });
});
