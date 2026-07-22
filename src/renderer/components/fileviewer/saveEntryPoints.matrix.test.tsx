// @vitest-environment jsdom
/**
 * Phase 0 save entry-point matrix (plans/markdown-editor-edit-loss-
 * implementation.md §0.3(4), diagnosis H4). The seven user save entry points:
 *
 *   1. header Save            FileViewerHeader.tsx  (handleSave)
 *   2. window Ctrl+S          FileViewerPanel.tsx   (window keydown)
 *   3. canvas Ctrl+S          MilkdownEditor.tsx    (performSave)
 *   4. CodeMirror onSave      FileContentArea.tsx   (onSave prop)
 *   5. detached save-and-close DetachedFileView.tsx (close-query modal)
 *   6. detached Ctrl+S        DetachedFileView.tsx  (window keydown)
 *   7. save-before-detach     FileTabBar.tsx        (handleDragEnd)
 *
 * (4a) Preserved-draft save: passing regression tests for the six bare
 * store-save paths (they read draftContent directly and already write the
 * preserved draft), plus canvas Ctrl+S (un-failed by Phase 1's `saveDirty()`
 * in `performSave` — a draft-mounted canvas writes the preserved store
 * draft).
 *
 * (4b) H4 bypass — a LIVE Milkdown edit inside the ~200ms markdownUpdated
 * debounce window, then each bypass path is invoked. Desired (un-failed in
 * Phase 2): the written bytes contain the live edit (synchronous snapshot
 * flush) AND the editor rebaselines — the post-save watcher echo terminates
 * before the handler and never yields 'conflict'. Today these paths save
 * debounce-stale store content and never rebaseline.
 *
 * Registered per-path with a plain loop (one failing path never hides the
 * others).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { polyfillJsdomForProseMirror } from './prosemirrorJsdomPolyfills';

// -- Heavy leaf components stubbed out (none of them carries a save path
//    except CodeMirrorEditor, whose onSave prop we capture) -----------------
const cmCapture = vi.hoisted(() => ({
  props: null as null | { onSave: () => void; onChange: (draft: string) => void },
}));

vi.mock('./DirectoryTree', () => ({ default: () => null }));
vi.mock('./CodeMirrorEditor', () => ({
  default: (props: { onSave: () => void; onChange: (draft: string) => void }) => {
    cmCapture.props = props;
    return <div data-testid="codemirror-stub" />;
  },
}));
vi.mock('../context-overhead/ContextOverheadPanel', () => ({ default: () => null }));
vi.mock('../agent-knowledge/AgentKnowledgePanel', () => ({ default: () => null }));
vi.mock('../skill-analytics/SkillAnalyticsPanel', () => ({ default: () => null }));
vi.mock('../context-optimizer/ContextOptimizerPanel', () => ({ default: () => null }));
vi.mock('../plan/PlanSurfaceContainer', () => ({ default: () => null }));
vi.mock('../context-optimizer/CapstonePanel', () => ({ default: () => null }));
vi.mock('../watchdog/SystemMemoryView', () => ({ default: () => null }));
vi.mock('../context-gauge/ContextWindowWarningPanel', () => ({ default: () => null }));
// Heavy renderers FileContentArea imports but these tests never route to
// (pdfjs needs DOMMatrix, geo renderers pull native-ish libs).
vi.mock('./FileContentRenderer', () => ({ default: () => null }));
vi.mock('./ImageRenderer', () => ({ default: () => null }));
vi.mock('./PdfRenderer', () => ({ default: () => null }));
vi.mock('./GeoTiffRenderer', () => ({ default: () => null }));
vi.mock('./ShapefileRenderer', () => ({ default: () => null }));
vi.mock('./GeoPackageRenderer', () => ({ default: () => null }));

import { useDashboardStore } from '../../stores/dashboard-store';
import FileViewerHeader from './FileViewerHeader';
import FileViewerPanel from './FileViewerPanel';
import FileContentArea from './FileContentArea';
import FileTabBar from './FileTabBar';
import DetachedFileView from './DetachedFileView';
import MilkdownEditor, { getCanvasEditorHandle } from './MilkdownEditor';
import {
  consultFreshContentHandler,
  evictTabCache,
  registerFreshContentHandler,
  useFileContentCache,
} from './useFileContentCache';
import type { FsEvent } from '../../../shared/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
polyfillJsdomForProseMirror();

const TAB = 'tab-save-matrix';
const FILE = 'C:\\ws\\doc.md';
const DIR = 'C:\\ws';
const DETACHED_TAB = `detached:${FILE}`;

const ORIGINAL =
  '# Title\r\n' +
  '\r\n' +
  'First paragraph stays.\r\n' +
  '\r\n' +
  'Second paragraph to edit.\r\n' +
  '\r\n' +
  '- item one\r\n' +
  '- item two\r\n';

const PRESERVED_DRAFT =
  '# Title\r\n' +
  '\r\n' +
  'First paragraph stays.\r\n' +
  '\r\n' +
  'PRESERVED Second paragraph to edit.\r\n' +
  '\r\n' +
  '- item one\r\n' +
  '- item two\r\n';

// -- window.api mock ---------------------------------------------------------

interface ApiMock {
  written: string[];
  writeFile: ReturnType<typeof vi.fn>;
  watcherCbs: Array<(event: FsEvent) => void>;
  closeQueryCb: ((payload: { requestId: string }) => void) | null;
  closeReply: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  diskContent: () => string;
}

let api: ApiMock;

function installApi(initialDisk: string): ApiMock {
  let disk = initialDisk;
  const mock: ApiMock = {
    written: [],
    writeFile: vi.fn(async (_path: string, _root: string, _pt: string, content: string) => {
      mock.written.push(content);
      disk = content;
      return { ok: true };
    }),
    watcherCbs: [],
    closeQueryCb: null,
    closeReply: vi.fn(async () => {}),
    detach: vi.fn(async () => ({ ok: true, focusedExisting: false })),
    diskContent: () => disk,
  };
  (window as unknown as { api: unknown }).api = {
    files: {
      readFile: vi.fn(async (path: string) => ({
        path,
        content: disk,
        encoding: 'utf8',
        size: disk.length,
      })),
      writeFile: mock.writeFile,
      watchDirectory: vi.fn((_dir: string, _pt: string, cb: (e: FsEvent) => void) => {
        mock.watcherCbs.push(cb);
        return () => {};
      }),
    },
    comments: {
      list: vi.fn(async () => []),
      onChanged: vi.fn(() => () => {}),
    },
    tabs: {
      onCloseQuery: vi.fn((cb: (payload: { requestId: string }) => void) => {
        mock.closeQueryCb = cb;
        return () => {};
      }),
      closeReply: mock.closeReply,
      detach: mock.detach,
    },
    system: {
      openFile: vi.fn(async () => {}),
      openFileInWorkspace: vi.fn(async () => {}),
    },
  };
  return mock;
}

// -- store + mount helpers ---------------------------------------------------

const mainTab = () => ({
  id: TAB,
  filePath: FILE,
  rootDirectory: DIR,
  pathType: 'windows',
  label: 'doc.md',
  workspaceId: 'ws1',
});

function seedMainTab(editState: Record<string, unknown>) {
  useDashboardStore.setState({
    openTabs: [mainTab() as never],
    activeTabId: TAB,
    selectedWorkspaceId: 'ws1',
    fileViewerOpen: true,
    tabEditState: {
      [TAB]: {
        mode: 'wysiwyg',
        draftContent: ORIGINAL,
        originalContent: ORIGINAL,
        dirty: false,
        saving: false,
        error: null,
        ...editState,
      } as never,
    },
  });
}

function setEditState(tabId: string, editState: Record<string, unknown>) {
  useDashboardStore.setState((s) => ({
    tabEditState: {
      ...s.tabEditState,
      [tabId]: {
        mode: 'wysiwyg',
        draftContent: ORIGINAL,
        originalContent: ORIGINAL,
        dirty: false,
        saving: false,
        error: null,
        ...editState,
      } as never,
    },
  }));
}

const sleep = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
/** crepe.create() resolves over several microtask/macrotask hops. */
const flushCrepe = () => sleep(150);
const flushMicrotasks = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

interface Mounted {
  host: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}

const liveMounts: Mounted[] = [];

async function mountElement(element: React.ReactElement): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(element);
  });
  const mounted: Mounted = {
    host,
    root,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      await flushMicrotasks();
      host.remove();
      const i = liveMounts.indexOf(mounted);
      if (i !== -1) liveMounts.splice(i, 1);
    },
  };
  liveMounts.push(mounted);
  return mounted;
}

/** Minimal host for the fs-watcher/read seam when the surface under test
 * doesn't mount FileContentArea itself (header, tab bar). */
function CacheProbe({ tabId, filePath }: { tabId: string; filePath: string }) {
  useFileContentCache(tabId, filePath, 'windows');
  return null;
}

function findButton(scope: ParentNode, label: string): HTMLButtonElement {
  const btn = Array.from(scope.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  expect(btn, `button "${label}" should exist`).toBeTruthy();
  return btn as HTMLButtonElement;
}

/** Find the document position of the text node containing `needle`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findTextPos(view: any, needle: string): number {
  let found = -1;
  view.state.doc.descendants((node: any, pos: number) => {
    if (found !== -1) return false;
    if (node.isText && typeof node.text === 'string' && node.text.includes(needle)) {
      found = pos + node.text.indexOf(needle);
      return false;
    }
    return true;
  });
  expect(found).toBeGreaterThanOrEqual(0);
  return found;
}

const detachedParams = () =>
  new URLSearchParams({
    filePath: FILE,
    rootDirectory: DIR,
    pathType: 'windows',
    workspaceId: 'ws1',
    label: 'doc.md',
  });

async function mountDetached(editState: Record<string, unknown>): Promise<Mounted> {
  const mounted = await mountElement(<DetachedFileView params={detachedParams()} />);
  // The seed effect resets tabEditState — install the edit session after it.
  await flushMicrotasks();
  act(() => {
    setEditState(DETACHED_TAB, editState);
  });
  await flushCrepe();
  return mounted;
}

function dispatchWindowCtrlS() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
    );
  });
}

function dispatchTabDragEnd(host: ParentNode, tabId: string) {
  const el = host.querySelector(`[data-tab-id="${tabId}"]`);
  expect(el, 'tab element should exist').toBeTruthy();
  const ev = new Event('dragend', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { dropEffect: 'none' } });
  act(() => {
    el!.dispatchEvent(ev);
  });
}

beforeEach(() => {
  cmCapture.props = null;
  evictTabCache(TAB);
  evictTabCache(DETACHED_TAB);
  api = installApi(ORIGINAL);
  useDashboardStore.setState({
    openTabs: [],
    activeTabId: null,
    tabEditState: {},
    selectedWorkspaceId: 'ws1',
  });
});

afterEach(async () => {
  vi.useRealTimers();
  // Backstop: a failed assertion inside a driver must not leak a live root
  // (and its window keydown listeners / crepe timers) into the next test.
  for (const m of [...liveMounts]) {
    await m.unmount();
  }
  useDashboardStore.setState({ openTabs: [], activeTabId: null, tabEditState: {} });
});

// -- (4a) preserved-draft save ------------------------------------------------
// Remount from a preserved dirty store draft (the H1 aftermath: draft lives
// only in the store), no new edit, invoke the entry point.

interface BareDriver {
  name: string;
  tabId: string;
  /** save-before-detach hands the tab off to the detached window, which
   * removes the main-strip edit session after the write. */
  editStateRemovedAfterSave?: boolean;
  run: () => Promise<void>;
}

const bareDrivers: BareDriver[] = [
  {
    name: 'header Save button (FileViewerHeader)',
    tabId: TAB,
    run: async () => {
      seedMainTab({ draftContent: PRESERVED_DRAFT, dirty: true });
      const mounted = await mountElement(
        <FileViewerHeader
          tabId={TAB}
          filePath={FILE}
          pathType="windows"
          fileSize={0}
          workingDirectory={DIR}
          onNavigate={() => {}}
        />,
      );
      act(() => {
        findButton(mounted.host, 'Save').click();
      });
      await flushMicrotasks();
    },
  },
  {
    name: 'window Ctrl+S (FileViewerPanel)',
    tabId: TAB,
    run: async () => {
      seedMainTab({ draftContent: PRESERVED_DRAFT, dirty: true });
      await mountElement(<FileViewerPanel />);
      await flushCrepe();
      dispatchWindowCtrlS();
      await flushMicrotasks();
    },
  },
  {
    name: 'CodeMirror onSave (FileContentArea source mode)',
    tabId: TAB,
    run: async () => {
      seedMainTab({ mode: 'source', draftContent: PRESERVED_DRAFT, dirty: true });
      await mountElement(<FileContentArea tabId={TAB} filePath={FILE} pathType="windows" />);
      await flushMicrotasks();
      expect(cmCapture.props, 'CodeMirror stub should have mounted').toBeTruthy();
      act(() => {
        cmCapture.props!.onSave();
      });
      await flushMicrotasks();
    },
  },
  {
    name: 'detached save-and-close (DetachedFileView modal)',
    tabId: DETACHED_TAB,
    run: async () => {
      const mounted = await mountDetached({ draftContent: PRESERVED_DRAFT, dirty: true });
      act(() => {
        api.closeQueryCb!({ requestId: 'rq-1' });
      });
      await flushMicrotasks();
      const overlay = mounted.host.querySelector('.absolute.inset-0');
      expect(overlay, 'dirty close should raise the Save/Discard/Cancel modal').toBeTruthy();
      act(() => {
        findButton(overlay!, 'Save').click();
      });
      await flushMicrotasks();
      expect(api.closeReply).toHaveBeenCalledWith('rq-1', 'save');
    },
  },
  {
    name: 'detached Ctrl+S (DetachedFileView)',
    tabId: DETACHED_TAB,
    run: async () => {
      await mountDetached({ draftContent: PRESERVED_DRAFT, dirty: true });
      dispatchWindowCtrlS();
      await flushMicrotasks();
    },
  },
  {
    name: 'save-before-detach (FileTabBar dragend)',
    tabId: TAB,
    editStateRemovedAfterSave: true,
    run: async () => {
      seedMainTab({ draftContent: PRESERVED_DRAFT, dirty: true });
      const mounted = await mountElement(
        <FileTabBar
          tabs={[mainTab() as never]}
          activeTabId={TAB}
          onSelectTab={() => {}}
          onCloseTab={() => {}}
        />,
      );
      dispatchTabDragEnd(mounted.host, TAB);
      await flushMicrotasks();
      await flushMicrotasks();
      expect(api.detach).toHaveBeenCalled();
    },
  },
];

describe('4a — preserved-draft save: the six bare store-save paths already write the stored draft (regression locks)', () => {
  for (const driver of bareDrivers) {
    it(`${driver.name} writes the preserved draft to disk`, async () => {
      await driver.run();
      expect(api.written).toEqual([PRESERVED_DRAFT]);
      const es = useDashboardStore.getState().tabEditState[driver.tabId];
      if (driver.editStateRemovedAfterSave) {
        // detachTab handed the (now-clean) tab to the detached window.
        expect(es).toBeUndefined();
      } else {
        expect(es?.originalContent).toBe(PRESERVED_DRAFT);
        expect(es?.dirty).toBe(false);
      }
    });
  }
});

describe('4a — preserved-draft save: canvas Ctrl+S (performSave) — fixed in Phase 1', () => {
  // Phase 1 §1.3d: performSave saves when `saveDirty()` (editor dirty OR
  // dirtyRef OR store dirty) — the draft-mounted canvas is editor-pristine
  // (the canvas now mounts FROM the draft, §1.2) but the preserved store
  // draft must still reach disk and become B1.
  it('canvas Ctrl+S writes the preserved store draft to disk', async () => {
    seedMainTab({ draftContent: PRESERVED_DRAFT, dirty: true });
    // Draft-mounted canvas: the store carries the dirty draft at mount time.
    const mounted = await mountElement(
      <MilkdownEditor
        tabId={TAB}
        filePath={FILE}
        content={ORIGINAL}
        registerFreshContentHandler={registerFreshContentHandler}
      />,
    );
    await flushCrepe();
    const container = mounted.host.querySelector('.milkdown-editor')!;
    act(() => {
      container.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    await flushMicrotasks();

    // Desired: the preserved draft reaches disk and becomes B1.
    expect(api.written).toEqual([PRESERVED_DRAFT]);
    expect(useDashboardStore.getState().tabEditState[TAB]?.dirty).toBe(false);
  });
});

// -- (4b) H4 bypass — live edit inside the debounce window --------------------

interface BypassDriver {
  name: string;
  tabId: string;
  /** Mounts the entry-point surface + a live editor + the watcher seam. */
  mount: () => Promise<Mounted>;
  /** Invokes the save entry point (called under fake timers). */
  invoke: (mounted: Mounted) => Promise<void>;
}

/** Header and tab bar don't mount the editor themselves — pair them with a
 * live canvas + cache probe on the same tab, as the real panel layout does. */
const withEditorAndProbe = (surface: React.ReactElement) => (
  <>
    {surface}
    <MilkdownEditor
      tabId={TAB}
      filePath={FILE}
      content={ORIGINAL}
      registerFreshContentHandler={registerFreshContentHandler}
    />
    <CacheProbe tabId={TAB} filePath={FILE} />
  </>
);

const bypassDrivers: BypassDriver[] = [
  {
    name: 'header Save button',
    tabId: TAB,
    mount: async () => {
      seedMainTab({});
      const mounted = await mountElement(
        withEditorAndProbe(
          <FileViewerHeader
            tabId={TAB}
            filePath={FILE}
            pathType="windows"
            fileSize={0}
            workingDirectory={DIR}
            onNavigate={() => {}}
          />,
        ),
      );
      await flushCrepe();
      return mounted;
    },
    invoke: async (mounted) => {
      // Note: today the button is even DISABLED here (store dirty lags the
      // debounce), so the gesture cannot save the visible doc at all.
      act(() => {
        findButton(mounted.host, 'Save').click();
      });
      await flushMicrotasks();
    },
  },
  {
    name: 'window Ctrl+S',
    tabId: TAB,
    mount: async () => {
      seedMainTab({});
      const mounted = await mountElement(<FileViewerPanel />);
      await flushCrepe();
      return mounted;
    },
    invoke: async () => {
      dispatchWindowCtrlS();
      await flushMicrotasks();
    },
  },
  {
    name: 'detached save-and-close',
    tabId: DETACHED_TAB,
    mount: () => mountDetached({}),
    invoke: async (mounted) => {
      act(() => {
        api.closeQueryCb!({ requestId: 'rq-2' });
      });
      await flushMicrotasks();
      // Today the clean-store check replies 'discard' without a modal; the
      // desired behavior saves the live doc. Click Save if the modal exists.
      const overlay = mounted.host.querySelector('.absolute.inset-0');
      if (overlay) {
        act(() => {
          findButton(overlay, 'Save').click();
        });
        await flushMicrotasks();
      }
    },
  },
  {
    name: 'detached Ctrl+S',
    tabId: DETACHED_TAB,
    mount: () => mountDetached({}),
    invoke: async () => {
      dispatchWindowCtrlS();
      await flushMicrotasks();
    },
  },
  {
    name: 'save-before-detach',
    tabId: TAB,
    mount: async () => {
      seedMainTab({});
      const mounted = await mountElement(
        withEditorAndProbe(
          <FileTabBar
            tabs={[mainTab() as never]}
            activeTabId={TAB}
            onSelectTab={() => {}}
            onCloseTab={() => {}}
          />,
        ),
      );
      await flushCrepe();
      return mounted;
    },
    invoke: async (mounted) => {
      dispatchTabDragEnd(mounted.host, TAB);
      await flushMicrotasks();
      await flushMicrotasks();
    },
  },
];

describe('4b — H4 bypass: save with a live edit inside the ~200ms debounce window', () => {
  for (const driver of bypassDrivers) {
    // FIXME(edit-loss): un-fail in Phase 2 — every entry point routes through
    // the save coordinator, which synchronously snapshots the live doc and
    // rebaselines on completion; the post-save watcher echo then terminates
    // before any handler consult and never yields 'conflict'.
    it.fails(`${driver.name} writes the live doc and rebaselines the editor`, async () => {
      const mounted = await driver.mount();
      const view = getCanvasEditorHandle(driver.tabId)!.getEditorView!()!;
      const pos = findTextPos(view, 'Second paragraph');

      vi.useFakeTimers();
      try {
        // Live edit — markdownUpdated (debounced ~200ms) has NOT fired, so
        // the store draft is still the pristine original.
        act(() => {
          view.dispatch(view.state.tr.insertText('LIVE EDIT ', pos));
        });

        await driver.invoke(mounted);

        // (A) Desired: the written bytes contain the live edit (synchronous
        // snapshot flush at the entry point).
        const written = api.written.at(-1) ?? '';
        expect(written).toContain('LIVE EDIT');

        // Let the delayed markdownUpdated settle AFTER the bypass save —
        // this exposes the missing rebaseline (H4) before the echo arrives.
        act(() => {
          vi.advanceTimersByTime(400);
        });
        await flushMicrotasks();

        // (B) Deliver the post-save watcher echo of what actually reached
        // disk. Desired: it terminates in the guard chain before any handler
        // consult and never raises the banner.
        act(() => {
          for (const cb of api.watcherCbs) {
            cb({ type: 'change', path: FILE, parentDir: DIR });
          }
        });
        await flushMicrotasks();
        expect(
          useDashboardStore.getState().tabEditState[driver.tabId]?.externalChange,
        ).toBeFalsy();

        // (C) Desired: the editor rebaselined (loadSerializedRef/dirtyRef
        // coherent with the written bytes) — a fresh-content consult for the
        // written bytes must not answer 'conflict'.
        expect(consultFreshContentHandler(driver.tabId, written)).not.toBe('conflict');
      } finally {
        vi.useRealTimers();
        await mounted.unmount();
      }
    });
  }
});
