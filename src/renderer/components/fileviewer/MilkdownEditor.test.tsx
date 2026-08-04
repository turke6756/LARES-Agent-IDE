// @vitest-environment jsdom
/**
 * WP1-B acceptance: Crepe lifecycle (WP0.3 carryover), baseline/dirty/splice
 * flow against a real Crepe instance (edits via the editor API, spliced draft
 * asserted against the original bytes), explicit-save flush + rebaseline,
 * fresh-content handler seam, editor handle registry, event propagation, and
 * image URL resolution. The dashboard store is mocked — the component's whole
 * store surface is setDraftContent/saveTab.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { polyfillJsdomForProseMirror } from './prosemirrorJsdomPolyfills';

const storeMock = vi.hoisted(() => {
  const calls: Array<{ kind: 'setDraftContent' | 'saveTab'; tabId: string; content?: string }> = [];
  let saveResult = true;
  const state = {
    setDraftContent: (tabId: string, content: string) => {
      calls.push({ kind: 'setDraftContent', tabId, content });
    },
    saveTab: async (tabId: string) => {
      calls.push({ kind: 'saveTab', tabId });
      return saveResult;
    },
    // Read by the FileCommentGutter overlay (WP-P5-B) mounted next to the
    // editor; empty tabs = the gutter renders nothing in these tests.
    openTabs: [] as Array<{ id: string }>,
    tabEditState: {} as Record<string, unknown>,
    agents: [] as unknown[],
    selectedWorkspaceId: null as string | null,
  };
  const useDashboardStore = (selector: (s: typeof state) => unknown) => selector(state);
  useDashboardStore.getState = () => state;
  return {
    calls,
    useDashboardStore,
    setSaveResult: (v: boolean) => {
      saveResult = v;
    },
  };
});

vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: storeMock.useDashboardStore,
}));

import MilkdownEditor, {
  getActiveCrepeInstanceCount,
  getCanvasEditorHandle,
  resolveImageUrl,
  type FreshContentHandler,
} from './MilkdownEditor';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

polyfillJsdomForProseMirror();

const drafts = () =>
  storeMock.calls.filter((c) => c.kind === 'setDraftContent');
const saves = () => storeMock.calls.filter((c) => c.kind === 'saveTab');
const lastDraft = () => drafts().at(-1)?.content;

beforeEach(() => {
  storeMock.calls.length = 0;
  storeMock.setSaveResult(true);
  (window as unknown as { api: unknown }).api = {
    comments: {
      list: vi.fn(async () => []),
      onChanged: vi.fn(() => () => {}),
    },
  };
});

const sleep = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

/** crepe.create() resolves over several microtask/macrotask hops. */
const flushCrepe = () => sleep(120);
/** markdownUpdated is debounced 200ms inside @milkdown/plugin-listener. */
const flushDebounce = () => sleep(350);

interface Mounted {
  host: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}

async function mountEditor(element: React.ReactElement): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(element);
  });
  await flushCrepe();
  return {
    host,
    root,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      await flushCrepe();
      host.remove();
    },
  };
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

const ORIGINAL =
  '# Title\r\n' +
  '\r\n' +
  'First paragraph stays.\r\n' +
  '\r\n' +
  'Second paragraph to edit.\r\n' +
  '\r\n' +
  '- item one\r\n' +
  '- item two\r\n';

describe('MilkdownEditor lifecycle', () => {
  it('mounts/unmounts twice (StrictMode) without throwing or leaking', async () => {
    expect(getActiveCrepeInstanceCount()).toBe(0);

    for (let cycle = 0; cycle < 2; cycle++) {
      const mounted = await mountEditor(
        <StrictMode>
          <MilkdownEditor
            tabId={`lifecycle-${cycle}`}
            filePath="C:\\ws\\doc.md"
            content={'# Spike\n\nA paragraph.\n\n- a\n- b\n'}
          />
        </StrictMode>,
      );

      // StrictMode double-invokes the effect: the throwaway instance must be
      // gone, exactly one live instance may remain while mounted.
      expect(getActiveCrepeInstanceCount()).toBe(1);
      expect(mounted.host.querySelector('.milkdown')).toBeTruthy();

      await mounted.unmount();
      expect(getActiveCrepeInstanceCount()).toBe(0);
    }
  });
});

describe('baseline / dirty / splice flow', () => {
  it('persists an embedded WYSIWYG edit through the explicit file adapter', async () => {
    const embeddedId = 'embedded:C:\\ws\\proposal.md';
    let draft = ORIGINAL;
    let saveHandler: (() => Promise<boolean>) | null = null;
    const writes: string[] = [];
    const mounted = await mountEditor(
      <MilkdownEditor
        tabId={embeddedId}
        filePath="C:\\ws\\proposal.md"
        content={ORIGINAL}
        embeddedPersistence={{
          draftContent: draft,
          dirty: false,
          onDraftChange: (next) => { draft = next; },
          onSave: async (next) => { writes.push(next); return true; },
          onUnmountFlush: () => {},
          registerSaveHandler: (save) => { saveHandler = save; return () => { saveHandler = null; }; },
          workspaceId: 'ws-1',
        }}
      />,
    );

    const view = getCanvasEditorHandle(embeddedId)!.getEditorView!()!;
    const pos = findTextPos(view, 'Second paragraph');
    act(() => { view.dispatch(view.state.tr.insertText('PLAN ', pos)); });
    expect(saveHandler).not.toBeNull();
    await act(async () => { await saveHandler!(); });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('PLAN Second paragraph to edit.');
    expect(draft).toBe(writes[0]);
    await mounted.unmount();
  });

  it('stays store-silent while pristine, then pushes a minimal spliced draft on edit', async () => {
    const mounted = await mountEditor(
      <MilkdownEditor tabId="t1" filePath="C:\\ws\\doc.md" content={ORIGINAL} />,
    );

    // Pristine: Crepe normalization alone must never reach the store.
    await flushDebounce();
    expect(drafts()).toHaveLength(0);

    const view = getCanvasEditorHandle('t1')!.getEditorView!()!;
    const pos = findTextPos(view, 'Second paragraph');
    act(() => {
      view.dispatch(view.state.tr.insertText('EDITED ', pos));
    });
    await flushDebounce();

    const draft = lastDraft()!;
    expect(draft).toContain('EDITED Second paragraph to edit.');
    // Untouched top-level blocks are byte-identical, CRLF intact; exactly one
    // block differs from the original (minimal-diff assertion).
    const origBlocks = ORIGINAL.split('\r\n\r\n');
    const draftBlocks = draft.split('\r\n\r\n');
    expect(draftBlocks).toHaveLength(origBlocks.length);
    const changed = draftBlocks.filter((b, i) => b !== origBlocks[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('EDITED');

    // Undo back to pristine: the draft returns to the exact original bytes.
    act(() => {
      view.dispatch(view.state.tr.delete(pos, pos + 'EDITED '.length));
    });
    await flushDebounce();
    expect(lastDraft()).toBe(ORIGINAL);

    await mounted.unmount();
  });

  it('flushes a dirty draft on unmount before the debounced listener fires', async () => {
    const mounted = await mountEditor(
      <MilkdownEditor tabId="leave-fast" filePath="C:\\ws\\doc.md" content={ORIGINAL} />,
    );
    const view = getCanvasEditorHandle('leave-fast')!.getEditorView!()!;

    const pos = findTextPos(view, 'Second paragraph');
    act(() => {
      view.dispatch(view.state.tr.insertText('LEAVING ', pos));
    });

    // No debounce wait: leaving the Files view unmounts the editor immediately.
    expect(drafts()).toHaveLength(0);
    await mounted.unmount();

    expect(lastDraft()).toContain('LEAVING Second paragraph to edit.');
  });

  it('Ctrl+S flushes the splice ahead of the debounce, saves, and rebaselines', async () => {
    const mounted = await mountEditor(
      <MilkdownEditor tabId="t2" filePath="C:\\ws\\doc.md" content={ORIGINAL} />,
    );
    const view = getCanvasEditorHandle('t2')!.getEditorView!()!;

    const pos = findTextPos(view, 'Second paragraph');
    act(() => {
      view.dispatch(view.state.tr.insertText('SAVED ', pos));
    });
    // No debounce wait: Ctrl+S inside the editor must flush synchronously.
    const container = mounted.host.querySelector('.milkdown-editor')!;
    act(() => {
      container.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });

    expect(saves()).toHaveLength(1);
    expect(saves()[0].tabId).toBe('t2');
    const savedDraft = drafts().at(-1)!.content!;
    expect(savedDraft).toContain('SAVED Second paragraph to edit.');
    // setDraftContent must precede saveTab so the store writes the new draft.
    const order = storeMock.calls.map((c) => c.kind);
    expect(order.indexOf('setDraftContent')).toBeLessThan(order.indexOf('saveTab'));

    // Rebaseline: a follow-up edit splices against the saved bytes — the
    // previously-saved change is now part of the untouched baseline.
    await flushDebounce();
    const pos2 = findTextPos(view, 'First paragraph');
    act(() => {
      view.dispatch(view.state.tr.insertText('AGAIN ', pos2));
    });
    await flushDebounce();
    const next = lastDraft()!;
    expect(next).toContain('AGAIN First paragraph stays.');
    expect(next).toContain('SAVED Second paragraph to edit.');
    const savedBlocks = savedDraft.split('\r\n\r\n');
    const nextBlocks = next.split('\r\n\r\n');
    expect(nextBlocks).toHaveLength(savedBlocks.length);
    expect(nextBlocks.filter((b, i) => b !== savedBlocks[i])).toHaveLength(1);

    // Pristine editor: Ctrl+S is a no-op (explicit save, never a blind write).
    storeMock.calls.length = 0;
    act(() => {
      view.dispatch(view.state.tr.delete(pos2, pos2 + 'AGAIN '.length));
    });
    await flushDebounce();
    storeMock.calls.length = 0;
    act(() => {
      container.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(saves()).toHaveLength(0);

    await mounted.unmount();
  });
});

describe('fresh-content handler seam', () => {
  it("registers at mount, answers 'fallback' clean / 'conflict' dirty, unregisters at unmount", async () => {
    let handler: FreshContentHandler | undefined;
    let unregistered = false;
    const register = (tabId: string, h: FreshContentHandler) => {
      expect(tabId).toBe('t3');
      handler = h;
      return () => {
        unregistered = true;
      };
    };

    const mounted = await mountEditor(
      <MilkdownEditor
        tabId="t3"
        filePath="C:\\ws\\doc.md"
        content={ORIGINAL}
        registerFreshContentHandler={register}
      />,
    );

    expect(handler).toBeDefined();
    expect(handler!('whatever came from disk')).toBe('fallback');

    const view = getCanvasEditorHandle('t3')!.getEditorView!()!;
    const pos = findTextPos(view, 'Second paragraph');
    act(() => {
      view.dispatch(view.state.tr.insertText('DIRTY ', pos));
    });
    await flushDebounce();
    expect(handler!('whatever came from disk')).toBe('conflict');

    // Back to clean → fallback again.
    act(() => {
      view.dispatch(view.state.tr.delete(pos, pos + 'DIRTY '.length));
    });
    await flushDebounce();
    expect(handler!('whatever came from disk')).toBe('fallback');

    await mounted.unmount();
    expect(unregistered).toBe(true);
  });

  it('swaps fresh content in place (no remount) when the prop changes while clean', async () => {
    const FRESH = '# Title\r\n\r\nReplaced from disk.\r\n';
    const element = (content: string) => (
      <MilkdownEditor tabId="t4" filePath="C:\\ws\\doc.md" content={content} />
    );
    const mounted = await mountEditor(element(ORIGINAL));
    const handleBefore = getCanvasEditorHandle('t4')!;

    await act(async () => {
      mounted.root.render(element(FRESH));
    });
    await flushDebounce();

    expect(getActiveCrepeInstanceCount()).toBe(1); // same instance — no remount
    expect(getCanvasEditorHandle('t4')).toBe(handleBefore);
    expect(handleBefore.getMarkdown()).toContain('Replaced from disk.');
    // Baseline refreshed: still pristine, so no draft was pushed.
    expect(drafts()).toHaveLength(0);

    await mounted.unmount();
  });
});

describe('TOCTOU (H3, closed by Phase 1 §1.3c): fresh content applied inside the markdownUpdated debounce window', () => {
  // applyFreshContent re-checks the LIVE doc (crepe.getMarkdown() vs
  // loadSerializedRef) at replacement time — the ~200ms-debounced dirtyRef is
  // never the deciding guard, so a transaction applied just before a clean
  // 'fallback' content swap survives.
  it('a transaction applied just before the content prop changes survives the swap', async () => {
    const element = (content: string) => (
      <MilkdownEditor tabId="toctou" filePath="C:\\ws\\doc.md" content={content} />
    );
    const mounted = await mountEditor(element(ORIGINAL));
    try {
      // Settle any pending pristine-side debounce before freezing time.
      await flushDebounce();
      const view = getCanvasEditorHandle('toctou')!.getEditorView!()!;
      const pos = findTextPos(view, 'Second paragraph');

      vi.useFakeTimers();
      try {
        // Live edit — the debounced markdownUpdated has NOT fired, so dirtyRef
        // is still false (the consult-to-commit gap).
        act(() => {
          view.dispatch(view.state.tr.insertText('SURVIVES ', pos));
        });
        // Fresh disk content arrives via the content prop inside that gap
        // (the 'fallback' path: handler judged the editor clean).
        const FRESH = '# Title\r\n\r\nFresh from disk.\r\n';
        act(() => {
          mounted.root.render(element(FRESH));
        });
        // Desired: the live transaction survives the replacement.
        expect(getCanvasEditorHandle('toctou')!.getMarkdown()).toContain('SURVIVES');
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await mounted.unmount();
    }
  });

  it('a clean editor still swaps fresh content after the live re-check passes', async () => {
    const element = (content: string) => (
      <MilkdownEditor tabId="toctou-clean" filePath="C:\\ws\\doc.md" content={content} />
    );
    const mounted = await mountEditor(element(ORIGINAL));
    try {
      await flushDebounce();
      // No live edit: getMarkdown() === loadSerializedRef, store pristine —
      // the R7 triple-check must NOT over-block the legitimate clean swap.
      const FRESH = '# Title\r\n\r\nFresh from disk.\r\n';
      await act(async () => {
        mounted.root.render(element(FRESH));
      });
      await flushDebounce();
      expect(getCanvasEditorHandle('toctou-clean')!.getMarkdown()).toContain('Fresh from disk.');
    } finally {
      await mounted.unmount();
    }
  });
});

describe('mount-from-draft (Phase 1 §1.2/§1.3)', () => {
  const DRAFT =
    '# Title\r\n' +
    '\r\n' +
    'First paragraph stays.\r\n' +
    '\r\n' +
    'PRESERVED Second paragraph to edit.\r\n' +
    '\r\n' +
    '- item one\r\n' +
    '- item two\r\n';

  const seedDirtyDraft = (tabId: string) => {
    storeMock.useDashboardStore.getState().tabEditState[tabId] = {
      mode: 'wysiwyg',
      draftContent: DRAFT,
      originalContent: ORIGINAL,
      dirty: true,
      saving: false,
      error: null,
    };
  };
  const clearEditState = (tabId: string) => {
    delete storeMock.useDashboardStore.getState().tabEditState[tabId];
  };

  it('a dirty tab mounts the canvas from the store DRAFT, store dirty state untouched', async () => {
    seedDirtyDraft('dm1');
    try {
      const mounted = await mountEditor(
        <MilkdownEditor tabId="dm1" filePath="C:\\ws\\doc.md" content={ORIGINAL} />,
      );
      await flushDebounce();

      // The canvas shows the draft — and the post-create
      // applyFreshContent(contentRef = original) was BLOCKED by the
      // store-dirty check (§1.3c), or it would replaceAll(original) over the
      // just-mounted draft.
      expect(getCanvasEditorHandle('dm1')!.getMarkdown()).toContain(
        'PRESERVED Second paragraph',
      );
      // B3 untouched: no draft push at mount (the store already holds it).
      expect(drafts()).toHaveLength(0);

      await mounted.unmount();
    } finally {
      clearEditState('dm1');
    }
  });

  it('a content-prop change while store-dirty never replaces the draft-mounted canvas', async () => {
    seedDirtyDraft('dm2');
    try {
      const element = (content: string) => (
        <MilkdownEditor tabId="dm2" filePath="C:\\ws\\doc.md" content={content} />
      );
      const mounted = await mountEditor(element(ORIGINAL));
      await flushDebounce();

      const FRESH = '# Title\r\n\r\nFresh from disk.\r\n';
      await act(async () => {
        mounted.root.render(element(FRESH));
      });
      await flushDebounce();

      const md = getCanvasEditorHandle('dm2')!.getMarkdown();
      expect(md).toContain('PRESERVED Second paragraph');
      expect(md).not.toContain('Fresh from disk.');

      await mounted.unmount();
    } finally {
      clearEditState('dm2');
    }
  });

  it('pristine-branch preservation: edit → undo back to the MOUNT state restores the mounted draft bytes, not the disk original', async () => {
    seedDirtyDraft('dm3');
    try {
      const mounted = await mountEditor(
        <MilkdownEditor tabId="dm3" filePath="C:\\ws\\doc.md" content={ORIGINAL} />,
      );
      await flushDebounce();
      const view = getCanvasEditorHandle('dm3')!.getEditorView!()!;

      const pos = findTextPos(view, 'First paragraph');
      act(() => {
        view.dispatch(view.state.tr.insertText('TEMP ', pos));
      });
      await flushDebounce();
      expect(lastDraft()).toContain('TEMP First paragraph stays.');

      // Undo back to exactly what THIS mount loaded (the draft): the store
      // draft must return to the mounted draft bytes — never the splice
      // baseline's disk original, which would silently mark the tab clean
      // while the canvas still shows unsaved work (§1.3a).
      act(() => {
        view.dispatch(view.state.tr.delete(pos, pos + 'TEMP '.length));
      });
      await flushDebounce();
      expect(lastDraft()).toBe(DRAFT);
      expect(lastDraft()).not.toBe(ORIGINAL);

      await mounted.unmount();
    } finally {
      clearEditState('dm3');
    }
  });
});

describe('editor handle registry', () => {
  it('exposes a small handle per tabId while mounted, gone after unmount', async () => {
    expect(getCanvasEditorHandle('t5')).toBeUndefined();
    const mounted = await mountEditor(
      <MilkdownEditor tabId="t5" filePath="C:\\ws\\doc.md" content={ORIGINAL} />,
    );

    const handle = getCanvasEditorHandle('t5');
    expect(handle).toBeDefined();
    expect(handle!.getMarkdown()).toContain('# Title');
    const view = handle!.getEditorView!();
    expect(view).toBeDefined();
    expect(typeof view!.dispatch).toBe('function');
    // The handle is the seam interface, not the raw Crepe instance.
    expect(handle).not.toHaveProperty('destroy');
    expect(handle).not.toHaveProperty('editor');

    await mounted.unmount();
    expect(getCanvasEditorHandle('t5')).toBeUndefined();
  });
});

describe('event propagation (plan §6.2 selection-primitive seam)', () => {
  it('contextmenu and mouseup from inside the editor reach document-level listeners', async () => {
    const mounted = await mountEditor(
      <MilkdownEditor tabId="t6" filePath="C:\\ws\\doc.md" content={ORIGINAL} />,
    );

    const inner =
      mounted.host.querySelector('.milkdown p') ?? mounted.host.querySelector('.milkdown')!;
    expect(inner).toBeTruthy();

    for (const type of ['contextmenu', 'mouseup'] as const) {
      const seen: Event[] = [];
      const listener = (e: Event) => seen.push(e);
      document.addEventListener(type, listener);
      const event = new MouseEvent(type, { bubbles: true, cancelable: true });
      act(() => {
        inner.dispatchEvent(event);
      });
      document.removeEventListener(type, listener);
      expect(seen).toHaveLength(1);
      expect(seen[0].defaultPrevented).toBe(false);
    }

    await mounted.unmount();
  });
});

describe('input rules / keymap sanity (WP1-B task 5)', () => {
  it('`# ` heading input rule and Ctrl+B strong keymap are wired', async () => {
    const mounted = await mountEditor(
      <MilkdownEditor
        tabId="t7"
        filePath="C:\\ws\\doc.md"
        content={'plain start\n\nbold me\n'}
      />,
    );
    const view = getCanvasEditorHandle('t7')!.getEditorView!()!;

    // Input rule: type "#" then a space at the start of the first paragraph —
    // prosemirror-inputrules listens via the handleTextInput prop.
    const pos = findTextPos(view, 'plain start');
    act(() => {
      view.dispatch(view.state.tr.insertText('#', pos));
    });
    let ruleFired = false;
    act(() => {
      ruleFired = !!view.someProp('handleTextInput', (f: any) => f(view, pos + 1, pos + 1, ' '));
    });
    expect(ruleFired).toBe(true);
    expect(getCanvasEditorHandle('t7')!.getMarkdown()).toContain('# plain start');

    // Keymap: select "bold me" and send Mod-b through the keydown prop.
    const boldPos = findTextPos(view, 'bold me');
    const { TextSelection } = await import('@milkdown/kit/prose/state');
    act(() => {
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(view.state.doc, boldPos, boldPos + 'bold me'.length),
        ),
      );
    });
    let keyHandled = false;
    act(() => {
      keyHandled = !!view.someProp('handleKeyDown', (f: any) =>
        f(view, new KeyboardEvent('keydown', { key: 'b', ctrlKey: true })),
      );
    });
    expect(keyHandled).toBe(true);
    expect(getCanvasEditorHandle('t7')!.getMarkdown()).toContain('**bold me**');

    await mounted.unmount();
  });
});

describe('resolveImageUrl', () => {
  const doc = 'C:\\ws\\docs\\guide.md';

  it('passes real URLs through untouched', () => {
    expect(resolveImageUrl('https://x.dev/a.png', doc)).toBe('https://x.dev/a.png');
    expect(resolveImageUrl('http://x.dev/a.png', doc)).toBe('http://x.dev/a.png');
    expect(resolveImageUrl('data:image/png;base64,AAAA', doc)).toBe('data:image/png;base64,AAAA');
    expect(resolveImageUrl('media://file/x', doc)).toBe('media://file/x');
    expect(resolveImageUrl('//cdn.x.dev/a.png', doc)).toBe('//cdn.x.dev/a.png');
    expect(resolveImageUrl('#anchor', doc)).toBe('#anchor');
    expect(resolveImageUrl('', doc)).toBe('');
  });

  it("resolves relative paths against the doc's directory as media://file/", () => {
    expect(resolveImageUrl('shot.png', doc)).toBe(
      `media://file/${encodeURIComponent('C:\\ws\\docs\\shot.png')}`,
    );
    expect(resolveImageUrl('./img/shot.png', doc)).toBe(
      `media://file/${encodeURIComponent('C:\\ws\\docs\\img\\shot.png')}`,
    );
    expect(resolveImageUrl('../assets/logo.svg', doc)).toBe(
      `media://file/${encodeURIComponent('C:\\ws\\assets\\logo.svg')}`,
    );
  });

  it('handles posix doc paths, absolute paths, and percent-encoded names', () => {
    expect(resolveImageUrl('img/a.png', '/home/me/notes/doc.md')).toBe(
      `media://file/${encodeURIComponent('/home/me/notes/img/a.png')}`,
    );
    expect(resolveImageUrl('/abs/path/a.png', doc)).toBe(
      `media://file/${encodeURIComponent('/abs/path/a.png')}`,
    );
    expect(resolveImageUrl('D:\\elsewhere\\a.png', doc)).toBe(
      `media://file/${encodeURIComponent('D:\\elsewhere\\a.png')}`,
    );
    expect(resolveImageUrl('my%20shot.png', doc)).toBe(
      `media://file/${encodeURIComponent('C:\\ws\\docs\\my shot.png')}`,
    );
  });
});
