// @vitest-environment jsdom
/**
 * useAutosave (edit-loss plan §4.2 + §4.4) against the REAL store and save
 * coordinator with a controllable window.api write:
 *
 *   - onEdit increments the revision and (re)arms exactly one idle timer;
 *     one write fires after AUTOSAVE_IDLE_MS quiet; continuous edits never
 *     write.
 *   - Fire-time re-checks: !dirty / saving / externalChange / conflict-paused
 *     all skip the write.
 *   - Flush triggers: focusout leaving the root saves immediately while
 *     intra-root focus moves don't; visibilitychange → hidden saves; unmount
 *     saves via the coordinator's store adapter (no live editor).
 *   - Failure policy (§4.4): io failures retry 5s → 15s → stop; writer-
 *     classified 'too-large'/'permission' stop immediately; a new edit
 *     re-arms the ladder.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { ConditionalWriteResult, WriteErrorCode } from '../../../shared/types';
import { currentRevision, isConflictPaused, requestSave } from './saveCoordinator';
import { useAutosave, AUTOSAVE_IDLE_MS } from './useAutosave';

const ORIGINAL = 'original content\n';

// ── Controllable write ──────────────────────────────────────────────────────

type WriteMode =
  | { kind: 'success' }
  | { kind: 'fail'; error: string; code?: WriteErrorCode }
  | { kind: 'conflict'; freshContent: string }
  | { kind: 'pending' };

let writeMode: WriteMode;
let writeFile: ReturnType<typeof vi.fn>;

function installApi() {
  writeMode = { kind: 'success' };
  writeFile = vi.fn((): Promise<ConditionalWriteResult> => {
    const mode = writeMode;
    if (mode.kind === 'pending') return new Promise(() => {});
    if (mode.kind === 'fail') {
      return Promise.resolve({ ok: false, error: mode.error, code: mode.code });
    }
    if (mode.kind === 'conflict') {
      return Promise.resolve({ ok: false, conflict: true, freshContent: mode.freshContent });
    }
    return Promise.resolve({ ok: true, path: 'x' });
  });
  (window as unknown as { api: unknown }).api = { files: { writeFile } };
}

const microtasks = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

// ── Store seeding ───────────────────────────────────────────────────────────

let tabCounter = 0;

function seedTab(overrides: Record<string, unknown> = {}): string {
  const tabId = `autosave-tab-${++tabCounter}`;
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

const editState = (tabId: string) => useDashboardStore.getState().tabEditState[tabId];

// ── Hook harness ────────────────────────────────────────────────────────────

type Handle = ReturnType<typeof useAutosave>;

function Harness({ tabId, expose }: { tabId: string; expose: (h: Handle) => void }) {
  const h = useAutosave(tabId);
  expose(h);
  return (
    <div ref={h.rootRef}>
      <input data-inside="a" />
      <input data-inside="b" />
    </div>
  );
}

let container: HTMLDivElement;
let outside: HTMLInputElement;
let root: Root | null;
let handle: Handle;

function mount(tabId: string) {
  root = createRoot(container);
  act(() => {
    root!.render(<Harness tabId={tabId} expose={(h) => { handle = h; }} />);
  });
}

function unmount() {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
}

/** Simulate one editor keystroke: revision + timer via onEdit, then the
 * draft push the editors do (CodeMirror onChange / Milkdown listener). */
function edit(tabId: string, draft: string) {
  act(() => {
    handle.onEdit();
    useDashboardStore.getState().setDraftContent(tabId, draft);
  });
}

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await microtasks();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  installApi();
  container = document.createElement('div');
  document.body.appendChild(container);
  outside = document.createElement('input');
  document.body.appendChild(outside);
});

afterEach(() => {
  unmount();
  container.remove();
  outside.remove();
  vi.useRealTimers();
  useDashboardStore.setState({ openTabs: [], tabEditState: {} });
});

describe('useAutosave — idle timer (§4.2)', () => {
  it('onEdit bumps the revision and one write fires after AUTOSAVE_IDLE_MS quiet', async () => {
    const tabId = seedTab();
    mount(tabId);

    const revBefore = currentRevision(tabId);
    edit(tabId, 'edited\n');
    expect(currentRevision(tabId)).toBe(revBefore + 1);

    await advance(AUTOSAVE_IDLE_MS - 1);
    expect(writeFile).not.toHaveBeenCalled();
    await advance(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][3]).toBe('edited\n');
    expect(editState(tabId)?.dirty).toBe(false);
  });

  it('continuous edits keep resetting the timer — no write until quiet', async () => {
    const tabId = seedTab();
    mount(tabId);

    edit(tabId, 'a\n');
    await advance(1500);
    edit(tabId, 'ab\n');
    await advance(1500);
    edit(tabId, 'abc\n');
    await advance(1999);
    expect(writeFile).not.toHaveBeenCalled();
    await advance(1);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][3]).toBe('abc\n');
  });

  it('fire-time re-check: no longer dirty (undo to baseline) ⇒ skip', async () => {
    const tabId = seedTab();
    mount(tabId);

    edit(tabId, 'edited\n');
    edit(tabId, ORIGINAL); // undo back to pristine — dirty recomputes false
    await advance(AUTOSAVE_IDLE_MS + 10);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('fire-time re-check: saving in flight ⇒ skip', async () => {
    const tabId = seedTab();
    mount(tabId);

    edit(tabId, 'edited\n');
    act(() => {
      useDashboardStore.setState((s) => ({
        tabEditState: {
          ...s.tabEditState,
          [tabId]: { ...s.tabEditState[tabId], saving: true } as never,
        },
      }));
    });
    await advance(AUTOSAVE_IDLE_MS + 10);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('fire-time re-check: externalChange banner up ⇒ skip', async () => {
    const tabId = seedTab();
    mount(tabId);

    edit(tabId, 'edited\n');
    act(() => useDashboardStore.getState().markExternalChange(tabId, 'agent bytes\n'));
    await advance(AUTOSAVE_IDLE_MS + 10);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('conflict pause (§4.1): timer fires under a CAS refusal ⇒ no write; disk keeps the external bytes, draft intact', async () => {
    const tabId = seedTab();
    mount(tabId);

    // First autosave runs into an external mutation → CAS refusal.
    writeMode = { kind: 'conflict', freshContent: 'external bytes\n' };
    edit(tabId, 'mine\n');
    await advance(AUTOSAVE_IDLE_MS + 10);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(isConflictPaused(tabId)).toBe(true);
    expect(editState(tabId)?.externalChange).toBe(true);
    expect(editState(tabId)?.draftContent).toBe('mine\n');

    // "Keep my changes" WITHOUT lifting the pause (the UI lifts it; here we
    // exercise the pause alone): the banner drops but autosave stays paused.
    act(() => useDashboardStore.getState().dismissExternalChange(tabId));
    writeMode = { kind: 'success' };
    edit(tabId, 'mine 2\n');
    await advance(AUTOSAVE_IDLE_MS + 10);
    expect(writeFile).toHaveBeenCalledTimes(1); // still paused — no retry into the conflict

    // Manual save is NOT gated by the pause — and its success lifts it.
    let ok = false;
    await act(async () => {
      const p = requestSave(tabId);
      await microtasks();
      ok = await p;
    });
    expect(ok).toBe(true);
    expect(isConflictPaused(tabId)).toBe(false);
  });
});

describe('useAutosave — flush triggers (§4.2)', () => {
  it('focusout leaving the root flushes; intra-root focus moves do not', async () => {
    const tabId = seedTab();
    mount(tabId);
    const [a, b] = Array.from(container.querySelectorAll('input'));

    edit(tabId, 'edited\n');

    // Intra-editor move: a → b.
    await act(async () => {
      a.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: b }));
      await microtasks();
    });
    expect(writeFile).not.toHaveBeenCalled();

    // True editor exit: b → outside.
    await act(async () => {
      b.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }));
      await microtasks();
    });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][3]).toBe('edited\n');
  });

  it('visibilitychange → hidden flushes', async () => {
    const tabId = seedTab();
    mount(tabId);
    edit(tabId, 'edited\n');

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await microtasks();
    });
    Reflect.deleteProperty(document, 'visibilityState');

    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('unmount flushes via the coordinator STORE adapter (post-disposal write of the preserved draft)', async () => {
    const tabId = seedTab();
    mount(tabId);
    edit(tabId, 'unsaved at unmount\n');

    await act(async () => {
      unmount();
      await microtasks();
    });
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][3]).toBe('unsaved at unmount\n');
  });

  it('unmount of a pristine tab writes nothing', async () => {
    const tabId = seedTab();
    mount(tabId);
    await act(async () => {
      unmount();
      await microtasks();
    });
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('useAutosave — failure policy (§4.4, R10)', () => {
  it('io failure: retries at 5s then 15s then stops; draft/dirty retained; error surfaced', async () => {
    const tabId = seedTab();
    mount(tabId);
    writeMode = { kind: 'fail', error: 'disk on fire', code: 'io' };

    edit(tabId, 'edited\n');
    // Advance exactly to the idle fire so the retry clock anchors at t=2000.
    await advance(AUTOSAVE_IDLE_MS);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(editState(tabId)?.dirty).toBe(true);
    expect(editState(tabId)?.error).toBe('disk on fire');

    await advance(4_999);
    expect(writeFile).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(writeFile).toHaveBeenCalledTimes(2); // retry #1 after 5s

    await advance(15_000);
    expect(writeFile).toHaveBeenCalledTimes(3); // retry #2 after 15s

    await advance(120_000);
    expect(writeFile).toHaveBeenCalledTimes(3); // stopped
    expect(editState(tabId)?.dirty).toBe(true);
    expect(editState(tabId)?.draftContent).toBe('edited\n');
  });

  it("'too-large' stops immediately — no retry", async () => {
    const tabId = seedTab();
    mount(tabId);
    writeMode = { kind: 'fail', error: 'File too large', code: 'too-large' };

    edit(tabId, 'edited\n');
    await advance(AUTOSAVE_IDLE_MS + 130_000);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("'permission' stops immediately — no retry", async () => {
    const tabId = seedTab();
    mount(tabId);
    writeMode = { kind: 'fail', error: 'EACCES', code: 'permission' };

    edit(tabId, 'edited\n');
    await advance(AUTOSAVE_IDLE_MS + 130_000);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('a new edit re-arms the exhausted ladder', async () => {
    const tabId = seedTab();
    mount(tabId);
    writeMode = { kind: 'fail', error: 'disk on fire', code: 'io' };

    edit(tabId, 'edited\n');
    await advance(AUTOSAVE_IDLE_MS + 5_000 + 15_000 + 1_000);
    expect(writeFile).toHaveBeenCalledTimes(3); // exhausted

    writeMode = { kind: 'success' };
    edit(tabId, 'edited again\n');
    await advance(AUTOSAVE_IDLE_MS + 10);
    expect(writeFile).toHaveBeenCalledTimes(4);
    expect(editState(tabId)?.dirty).toBe(false);
    expect(editState(tabId)?.error).toBeNull();
  });
});
