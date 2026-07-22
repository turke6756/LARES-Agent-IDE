// @vitest-environment jsdom
/**
 * H1 regression suite (plans/markdown-editor-edit-loss-implementation.md
 * §0.3(1), un-failed by Phase 1 §1.1/§1.2): the external-change banner is
 * chrome, never a tree-shape change — `withExternalChangeBanner` keeps one
 * stable root with a keyed editor slot, so toggling `externalChange` cannot
 * unmount the editor. Legitimate remounts (reloadFromDisk's reloadVersion
 * bump) initialize from the store draft when dirty, and from the disk bytes
 * after an explicit reload reset the store.
 *
 * Cycle counting uses test-only Crepe create/destroy spies (module mock) —
 * NOT the settled `getActiveCrepeInstanceCount()`, which returns to 1 after
 * either behavior and cannot distinguish a remount from a stable mount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// ── Test-only Crepe stand-in with create/destroy spies ─────────────────────
// A module mock (not vi.spyOn on the real class) so the counters are
// deterministic and the test stays independent of Crepe internals; the fake
// implements exactly the surface MilkdownEditor touches.
const crepeSpy = vi.hoisted(() => {
  interface FakeCrepeInstance {
    markdown: string;
    fireMarkdownUpdated: (markdown: string) => void;
  }
  const state = {
    createCalls: 0,
    destroyCalls: 0,
    instances: [] as FakeCrepeInstance[],
    reset() {
      state.createCalls = 0;
      state.destroyCalls = 0;
      state.instances.length = 0;
    },
    latest(): FakeCrepeInstance {
      const inst = state.instances[state.instances.length - 1];
      if (!inst) throw new Error('no FakeCrepe instance created yet');
      return inst;
    },
  };
  return state;
});

vi.mock('@milkdown/crepe', () => {
  class FakeCrepe {
    static Feature = { Latex: 'latex', ImageBlock: 'image-block' };
    markdown: string;
    private listeners: Array<(markdown: string) => void> = [];
    editor = {
      config: (fn: (ctx: unknown) => void) => {
        fn({ update: (_key: unknown, updater: (prev: Record<string, unknown>) => unknown) => updater({}) });
      },
      action: (_fn: unknown) => {
        /* replaceAll etc. — inert in the fake */
      },
      ctx: {
        get: () => {
          throw new Error('no live prosemirror view in FakeCrepe');
        },
      },
    };
    constructor(opts: { defaultValue?: string }) {
      this.markdown = opts.defaultValue ?? '';
      crepeSpy.instances.push({
        markdown: this.markdown,
        fireMarkdownUpdated: (markdown: string) => {
          this.markdown = markdown;
          for (const fn of this.listeners) fn(markdown);
        },
      });
      const rec = crepeSpy.instances[crepeSpy.instances.length - 1];
      // keep the record's markdown in sync with the instance
      Object.defineProperty(rec, 'markdown', { get: () => this.markdown });
    }
    getMarkdown() {
      return this.markdown;
    }
    on(cb: (listener: { markdownUpdated: (fn: (ctx: unknown, md: string) => void) => void }) => void) {
      cb({
        markdownUpdated: (fn: (ctx: unknown, md: string) => void) => {
          this.listeners.push((md) => fn(null, md));
        },
      });
    }
    async create() {
      crepeSpy.createCalls += 1;
    }
    async destroy() {
      crepeSpy.destroyCalls += 1;
    }
  }
  return { Crepe: FakeCrepe };
});

// SelectionSurface stays a pass-through element (its own component type, so
// the banner toggle still swaps the ROOT TYPE exactly like production); the
// comment gutter is irrelevant here.
vi.mock('../selection/SelectionSurface', () => ({
  default: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'selection-surface' }, children),
}));
vi.mock('../selection/FileCommentGutter', () => ({
  default: () => null,
}));

// Heavy renderers FileContentArea imports but this test never routes to
// (pdfjs needs DOMMatrix, geo renderers pull native-ish libs).
vi.mock('./FileContentRenderer', () => ({ default: () => null }));
vi.mock('./CodeMirrorEditor', () => ({ default: () => null }));
vi.mock('./ImageRenderer', () => ({ default: () => null }));
vi.mock('./PdfRenderer', () => ({ default: () => null }));
vi.mock('./GeoTiffRenderer', () => ({ default: () => null }));
vi.mock('./ShapefileRenderer', () => ({ default: () => null }));
vi.mock('./GeoPackageRenderer', () => ({ default: () => null }));

import FileContentArea from './FileContentArea';
import { useDashboardStore } from '../../stores/dashboard-store';
import { evictTabCache } from './useFileContentCache';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TAB = 'tab-remount-1';
const FILE = 'C:/ws/doc.md';
const ORIGINAL = '# Title\n\nHello world.\n';

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

interface Mounted {
  host: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}

async function mountArea(): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<FileContentArea tabId={TAB} filePath={FILE} pathType="windows" />);
  });
  await flush();
  return {
    host,
    root,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      await flush();
      host.remove();
    },
  };
}

beforeEach(() => {
  crepeSpy.reset();
  evictTabCache(TAB);
  (window as unknown as { api: unknown }).api = {
    files: {
      readFile: vi.fn(async () => ({
        path: FILE,
        content: ORIGINAL,
        encoding: 'utf8',
        size: ORIGINAL.length,
      })),
      writeFile: vi.fn(async () => ({ ok: true })),
      watchDirectory: vi.fn(() => () => {}),
    },
  };
  useDashboardStore.setState({
    openTabs: [
      {
        id: TAB,
        filePath: FILE,
        rootDirectory: 'C:/ws',
        pathType: 'windows',
        label: 'doc.md',
        workspaceId: 'ws1',
      } as never,
    ],
    activeTabId: TAB,
    selectedWorkspaceId: 'ws1',
    tabEditState: {
      [TAB]: {
        mode: 'wysiwyg',
        draftContent: ORIGINAL,
        originalContent: ORIGINAL,
        dirty: false,
        saving: false,
        error: null,
      } as never,
    },
  });
});

afterEach(() => {
  useDashboardStore.setState({ openTabs: [], activeTabId: null, tabEditState: {} });
});

/** Make a live edit the way Crepe reports one: the (debounced-in-prod)
 * markdownUpdated listener fires with the new serialization. */
function makeLiveEdit(edited: string) {
  act(() => {
    crepeSpy.latest().fireMarkdownUpdated(edited);
  });
}

describe('external-change banner vs editor subtree (H1)', () => {
  const EDITED = '# Title\n\nHello EDITED world.\n';

  // Phase 1 §1.1: withExternalChangeBanner keeps one stable root (the banner
  // row toggles inside it), so the editor subtree is never unmounted.
  it(
    'toggling externalChange false→true→false never unmounts the editor and the dirty edit stays in the canvas',
    async () => {
      const mounted = await mountArea();
      try {
        expect(crepeSpy.createCalls).toBe(1);

        makeLiveEdit(EDITED);
        const store = useDashboardStore.getState();
        expect(store.tabEditState[TAB]?.dirty).toBe(true);

        const createsBefore = crepeSpy.createCalls;
        const destroysBefore = crepeSpy.destroyCalls;

        // External change lands mid-edit → banner appears IN PLACE…
        await act(async () => {
          useDashboardStore.getState().markExternalChange(TAB, '# Someone else\n');
        });
        await flush();
        expect(mounted.host.textContent).toContain('This file changed on disk');
        // …and "Keep my changes" dismisses it.
        await act(async () => {
          useDashboardStore.getState().dismissExternalChange(TAB);
        });
        await flush();
        expect(mounted.host.textContent).not.toContain('This file changed on disk');

        // Desired: the banner is chrome, not a tree-shape change — zero
        // unmount/mount cycles across both flips…
        expect(crepeSpy.destroyCalls).toBe(destroysBefore);
        expect(crepeSpy.createCalls).toBe(createsBefore);
        // …and the accumulated edit is still in the live canvas…
        expect(crepeSpy.latest().markdown).toContain('EDITED');
        // …and still in the store draft.
        expect(useDashboardStore.getState().tabEditState[TAB]?.draftContent).toContain('EDITED');
      } finally {
        await mounted.unmount();
      }
    },
  );

  it('the dirty draft survives the banner toggle in the STORE and Save stays possible', async () => {
    const mounted = await mountArea();
    makeLiveEdit(EDITED);
    expect(useDashboardStore.getState().tabEditState[TAB]?.dirty).toBe(true);

    await act(async () => {
      useDashboardStore.getState().markExternalChange(TAB, '# Someone else\n');
    });
    await flush();
    await act(async () => {
      useDashboardStore.getState().dismissExternalChange(TAB);
    });
    await flush();

    // The debounced sync landed the draft in the store, and "Keep my changes"
    // must not clobber it: Save stays possible.
    const es = useDashboardStore.getState().tabEditState[TAB];
    expect(es?.dirty).toBe(true);
    expect(es?.draftContent).toContain('EDITED');
    expect(es?.externalChange).toBeFalsy();

    await mounted.unmount();
  });

  it('"Reload from disk" remounts (reloadVersion bump) and the new canvas shows the DISK bytes, store pristine', async () => {
    const DISK = '# Someone else\n\nFresh disk bytes.\n';
    const mounted = await mountArea();
    makeLiveEdit(EDITED);
    expect(useDashboardStore.getState().tabEditState[TAB]?.dirty).toBe(true);

    await act(async () => {
      useDashboardStore.getState().markExternalChange(TAB, DISK);
    });
    await flush();

    const createsBefore = crepeSpy.createCalls;
    await act(async () => {
      useDashboardStore.getState().reloadFromDisk(TAB);
    });
    await flush();

    // A deliberate reload IS a remount (the key includes reloadVersion)…
    expect(crepeSpy.createCalls).toBe(createsBefore + 1);
    // …and the new canvas shows the disk bytes — the dying mount's cleanup
    // flush must NOT resurrect the discarded draft over the reload.
    expect(crepeSpy.latest().markdown).toContain('Fresh disk bytes.');
    expect(crepeSpy.latest().markdown).not.toContain('EDITED');
    const es = useDashboardStore.getState().tabEditState[TAB];
    expect(es?.dirty).toBe(false);
    expect(es?.draftContent).toBe(DISK);
    expect(es?.originalContent).toBe(DISK);
    expect(es?.externalChange).toBeFalsy();

    await mounted.unmount();
  });

  it('a remount while dirty (tab switch away/back) initializes the canvas from the preserved store draft', async () => {
    const mounted = await mountArea();
    makeLiveEdit(EDITED);
    const draftBefore = useDashboardStore.getState().tabEditState[TAB]?.draftContent;
    expect(draftBefore).toContain('EDITED');

    // Simulate leaving and returning to the Files view: full unmount, then a
    // fresh mount with the SAME dirty edit session in the store.
    await mounted.unmount();
    const remounted = await mountArea();

    // Phase 1 §1.2: the new mount reads the store imperatively — a dirty tab
    // mounts from draftContent, never originalContent.
    expect(crepeSpy.latest().markdown).toContain('EDITED');
    // B3 untouched: still dirty, Save stays enabled.
    const es = useDashboardStore.getState().tabEditState[TAB];
    expect(es?.dirty).toBe(true);
    expect(es?.draftContent).toContain('EDITED');

    await remounted.unmount();
  });
});
