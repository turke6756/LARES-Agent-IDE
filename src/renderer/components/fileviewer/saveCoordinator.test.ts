// @vitest-environment jsdom
/**
 * Save coordinator semantics (edit-loss plan Phase 2 §2.1/§2.4) against the
 * REAL dashboard store with a controllable window.api write and a fake
 * editor adapter. The editor-integrated end of the same contract (synchronous
 * live-doc flush, rebaseline coherence, watcher-echo termination) lives in
 * saveEntryPoints.matrix.test.tsx — here the writes are deferred promises so
 * the in-flight races are deterministic:
 *
 *   - A/B race: two serialized writes, store never blips clean in between,
 *     the B caller resolves only after B lands.
 *   - Debounce-window race, gate (a): a mid-write edit whose noteEdit fired
 *     fails the revision gate — B1-only install, dirty preserved, no B2
 *     rebaseline, latest snapshot enqueued.
 *   - Debounce-window race, gate (b): a mid-write edit whose noteEdit was
 *     suppressed (missed transaction hook) is caught by the serialization
 *     gate — A never marks B clean nor installs B's serialization as the
 *     baseline for disk content A.
 *   - Same-revision coalesce, store-adapter fallback, pristine no-op,
 *     terminal failure, expectedDiskHash derivation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useDashboardStore } from '../../stores/dashboard-store';
import { contentHash } from './markdownSplice';
import {
  currentRevision,
  hasUnsavedWork,
  noteEdit,
  registerSaveAdapter,
  requestSave,
  type SaveAdapter,
  type SaveSnapshot,
} from './saveCoordinator';

const ORIGINAL = 'original content\n';

// ── Deferred write control ───────────────────────────────────────────────────

interface PendingWrite {
  content: string;
  resolve: (r: { ok: boolean; error?: string }) => void;
}

let pendingWrites: PendingWrite[];
let writeFile: ReturnType<typeof vi.fn>;

function installApi() {
  pendingWrites = [];
  writeFile = vi.fn(
    (_path: string, _root: string, _pt: string, content: string) =>
      new Promise<{ ok: boolean; error?: string }>((resolve) => {
        pendingWrites.push({ content, resolve });
      }),
  );
  (window as unknown as { api: unknown }).api = {
    files: { writeFile },
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

async function settleWrite(index: number, ok = true, error?: string) {
  pendingWrites[index].resolve(ok ? { ok: true } : { ok: false, error });
  await flush();
}

// ── Store seeding ────────────────────────────────────────────────────────────

let tabCounter = 0;

function seedTab(overrides: Record<string, unknown> = {}): string {
  // Unique tab per test: the coordinator's per-tab revision map is
  // module-level and deliberately never reset.
  const tabId = `coord-tab-${++tabCounter}`;
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
        mode: 'wysiwyg',
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

const editState = (tabId: string) => useDashboardStore.getState().tabEditState[tabId];

// ── Fake editor adapter ──────────────────────────────────────────────────────
// Mirrors the Milkdown adapter's contract: snapshot() synchronously flushes
// the live doc into the store draft and reports the live serialization;
// rebaseline() records the fully-gated completions.

interface FakeEditor {
  doc: string;
  baseline: string;
  rebaselines: SaveSnapshot[];
  adapter: SaveAdapter;
  unregister: () => void;
}

function attachEditor(tabId: string): FakeEditor {
  const fake: FakeEditor = {
    doc: ORIGINAL,
    baseline: ORIGINAL,
    rebaselines: [],
    adapter: {
      snapshot(): SaveSnapshot | null {
        const es = editState(tabId);
        if (fake.doc === fake.baseline && !es?.dirty) return null;
        useDashboardStore.getState().setDraftContent(tabId, fake.doc);
        return {
          draft: fake.doc,
          revision: currentRevision(tabId),
          editorSerialized: fake.doc,
          expectedDiskHash: es ? contentHash(es.originalContent) : null,
        };
      },
      rebaseline(written: SaveSnapshot) {
        fake.rebaselines.push(written);
        fake.baseline = written.draft;
      },
    },
    unregister: () => {},
  };
  fake.unregister = registerSaveAdapter(tabId, fake.adapter);
  return fake;
}

let cleanups: Array<() => void>;

beforeEach(() => {
  installApi();
  cleanups = [];
});

afterEach(() => {
  for (const c of cleanups) c();
  useDashboardStore.setState({ openTabs: [], tabEditState: {} });
});

describe('saveCoordinator — revision-serialized single-flight drain', () => {
  it('A/B race: two serialized writes, never clean in between, B caller resolves after B', async () => {
    const tabId = seedTab();
    const ed = attachEditor(tabId);
    cleanups.push(ed.unregister);

    // Track every dirty value the store passes through.
    const dirtySeen: boolean[] = [];
    const unsub = useDashboardStore.subscribe((s) => {
      const es = s.tabEditState[tabId];
      if (es) dirtySeen.push(es.dirty);
    });
    cleanups.push(unsub);

    ed.doc = 'content A\n';
    noteEdit(tabId);
    const p1 = requestSave(tabId);
    await flush();
    expect(pendingWrites).toHaveLength(1);
    expect(pendingWrites[0].content).toBe('content A\n');

    // Edit to B while A is in flight, second gesture.
    ed.doc = 'content B\n';
    noteEdit(tabId);
    const p2 = requestSave(tabId);
    let p2Done = false;
    void p2.then(() => {
      p2Done = true;
    });

    dirtySeen.length = 0; // observe only the window between A- and B-completion
    await settleWrite(0);

    // A completed: B1 installed (disk truth), dirty stays true, B write live.
    expect(await p1).toBe(true);
    expect(p2Done).toBe(false);
    expect(editState(tabId)?.originalContent).toBe('content A\n');
    expect(editState(tabId)?.dirty).toBe(true);
    expect(ed.rebaselines).toHaveLength(0); // no B2 rebaseline for the raced write
    expect(pendingWrites).toHaveLength(2);
    expect(pendingWrites[1].content).toBe('content B\n');
    // The store never blipped clean between A-completion and B-completion:
    // every dirty value observed while only A had settled was true (the
    // clean flip belongs to B's completion sequence, below).
    expect(dirtySeen.length).toBeGreaterThan(0);
    expect(dirtySeen.every((d) => d === true)).toBe(true);

    await settleWrite(1);
    expect(await p2).toBe(true);
    expect(editState(tabId)?.originalContent).toBe('content B\n');
    expect(editState(tabId)?.dirty).toBe(false);
    expect(ed.rebaselines.map((r) => r.draft)).toEqual(['content B\n']);
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(dirtySeen.at(-1)).toBe(false);
  });

  it('gate (a): mid-write edit with noteEdit fired — B1-only install, dirty preserved, B enqueued', async () => {
    const tabId = seedTab();
    const ed = attachEditor(tabId);
    cleanups.push(ed.unregister);

    ed.doc = 'content A\n';
    noteEdit(tabId);
    const p = requestSave(tabId);
    await flush();
    expect(pendingWrites).toHaveLength(1);

    // Undebounced edit while A is in flight — NO second gesture.
    ed.doc = 'content B\n';
    noteEdit(tabId);

    await settleWrite(0);
    expect(await p).toBe(true); // the caller's captured revision (A) succeeded

    // B1 only: disk truth installed, dirty true, no rebaseline for A.
    expect(editState(tabId)?.originalContent).toBe('content A\n');
    expect(editState(tabId)?.dirty).toBe(true);
    expect(ed.rebaselines).toHaveLength(0);
    // The newer state was enqueued (plan §2.4: "B enqueued").
    expect(pendingWrites).toHaveLength(2);
    expect(pendingWrites[1].content).toBe('content B\n');

    await settleWrite(1);
    expect(editState(tabId)?.originalContent).toBe('content B\n');
    expect(editState(tabId)?.dirty).toBe(false);
    expect(ed.rebaselines.map((r) => r.draft)).toEqual(['content B\n']);
  });

  it('gate (b): mid-write edit with noteEdit SUPPRESSED — serialization gate catches it', async () => {
    const tabId = seedTab();
    const ed = attachEditor(tabId);
    cleanups.push(ed.unregister);

    ed.doc = 'content A\n';
    noteEdit(tabId);
    const revAtA = currentRevision(tabId);
    const p = requestSave(tabId);
    await flush();
    expect(pendingWrites).toHaveLength(1);

    // Simulated missed transaction hook: the live doc moves, revision doesn't.
    ed.doc = 'content B\n';

    await settleWrite(0);
    expect(await p).toBe(true);

    // A must never mark B clean nor install B's serialization as the
    // baseline for disk content A.
    expect(editState(tabId)?.originalContent).toBe('content A\n');
    expect(editState(tabId)?.dirty).toBe(true);
    expect(ed.rebaselines).toHaveLength(0);
    // The coordinator advanced the revision itself and enqueued the latest.
    expect(currentRevision(tabId)).toBeGreaterThan(revAtA);
    expect(pendingWrites).toHaveLength(2);
    expect(pendingWrites[1].content).toBe('content B\n');

    await settleWrite(1);
    expect(editState(tabId)?.dirty).toBe(false);
    expect(ed.rebaselines.map((r) => r.draft)).toEqual(['content B\n']);
  });

  it('same-revision requests coalesce into one write', async () => {
    const tabId = seedTab();
    const ed = attachEditor(tabId);
    cleanups.push(ed.unregister);

    ed.doc = 'content A\n';
    noteEdit(tabId);
    const p1 = requestSave(tabId);
    const p2 = requestSave(tabId); // same revision, while in flight
    await flush();
    expect(pendingWrites).toHaveLength(1);

    await settleWrite(0);
    expect(await p1).toBe(true);
    expect(await p2).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(editState(tabId)?.dirty).toBe(false);
  });

  it('unregistered-adapter fallback saves the store draft (source mode / post-unmount)', async () => {
    const tabId = seedTab({ draftContent: 'store draft\n', dirty: true, mode: 'source' });

    const p = requestSave(tabId);
    await flush();
    expect(pendingWrites).toHaveLength(1);
    expect(pendingWrites[0].content).toBe('store draft\n');

    await settleWrite(0);
    expect(await p).toBe(true);
    expect(editState(tabId)?.originalContent).toBe('store draft\n');
    expect(editState(tabId)?.dirty).toBe(false);
  });

  it('pristine tab: resolves true without writing', async () => {
    const tabId = seedTab();
    const ed = attachEditor(tabId);
    cleanups.push(ed.unregister);

    expect(hasUnsavedWork(tabId)).toBe(false);
    const ok = await requestSave(tabId);
    expect(ok).toBe(true);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('terminal write failure: caller gets false, draft/dirty retained, error surfaced', async () => {
    const tabId = seedTab();
    const ed = attachEditor(tabId);
    cleanups.push(ed.unregister);

    ed.doc = 'content A\n';
    noteEdit(tabId);
    const p = requestSave(tabId);
    await flush();
    await settleWrite(0, false, 'disk on fire');

    expect(await p).toBe(false);
    const es = editState(tabId);
    expect(es?.dirty).toBe(true);
    expect(es?.draftContent).toBe('content A\n');
    expect(es?.error).toBe('disk on fire');
    expect(ed.rebaselines).toHaveLength(0);
  });

  it('every snapshot derives expectedDiskHash = contentHash(originalContent) (Phase 2, unenforced)', async () => {
    const tabId = seedTab();
    const ed = attachEditor(tabId);
    cleanups.push(ed.unregister);

    // Record the opts the coordinator hands the single write executor.
    const orig = useDashboardStore.getState().saveTab;
    const spy = vi.fn(orig);
    useDashboardStore.setState({ saveTab: spy } as never);
    cleanups.push(() => useDashboardStore.setState({ saveTab: orig } as never));

    ed.doc = 'content A\n';
    noteEdit(tabId);
    const p1 = requestSave(tabId);
    await flush();
    // Second snapshot is captured AFTER A's B1 install — its expected hash
    // must track the moved originalContent, not the mount-time one.
    ed.doc = 'content B\n';
    noteEdit(tabId);
    const p2 = requestSave(tabId);
    await settleWrite(0);
    await settleWrite(1);
    await Promise.all([p1, p2]);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0][1]).toMatchObject({
      content: 'content A\n',
      expectedDiskHash: contentHash(ORIGINAL),
    });
    expect(spy.mock.calls[1][1]).toMatchObject({
      content: 'content B\n',
      expectedDiskHash: contentHash('content A\n'),
    });
  });
});
