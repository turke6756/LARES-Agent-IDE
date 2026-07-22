// @vitest-environment jsdom
/**
 * Explicit discard vs the dying mount's cleanup flush (edit-loss Phase 2
 * pre-task; defect surfaced by the Phase 1 review).
 *
 * discardTabChanges is unambiguous user intent: the draft is gone. But the
 * discard flips mode to 'view', which unmounts the WYSIWYG editor — and the
 * editor's cleanup runs flushDirtyDraft(), pushing the live (discarded) doc
 * back into the store as a dirty draft. Since Phase 1 mounts the canvas FROM
 * the store draft, the discarded draft resurfaces the next time the user
 * enters Edit.
 *
 * Fix: discardTabChanges bumps reloadVersion — the same supersession gate the
 * cleanup flush already honors for reloadFromDisk — so the dying mount's
 * flush authority is revoked by the explicit discard.
 *
 * Real store + real Crepe instance (the defect lives in the store↔editor
 * lifecycle seam, not in either half alone).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { polyfillJsdomForProseMirror } from './prosemirrorJsdomPolyfills';

import { useDashboardStore } from '../../stores/dashboard-store';
import MilkdownEditor, { getCanvasEditorHandle } from './MilkdownEditor';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
polyfillJsdomForProseMirror();

const TAB = 'tab-discard';
const FILE = 'C:\\ws\\doc.md';

const ORIGINAL =
  '# Title\r\n' +
  '\r\n' +
  'First paragraph stays.\r\n' +
  '\r\n' +
  'Second paragraph to edit.\r\n' +
  '\r\n' +
  '- item one\r\n' +
  '- item two\r\n';

const sleep = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
/** crepe.create() resolves over several microtask/macrotask hops. */
const flushCrepe = () => sleep(150);
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

beforeEach(() => {
  // Minimal window.api for the FileCommentGutter overlay mounted next to the
  // editor (no save path exercised in these tests).
  (window as unknown as { api: unknown }).api = {
    comments: {
      list: vi.fn(async () => []),
      onChanged: vi.fn(() => () => {}),
    },
  };
  useDashboardStore.setState({
    openTabs: [],
    activeTabId: null,
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
  useDashboardStore.setState({ tabEditState: {} });
});

describe('explicit discard survives the dying mount cleanup flush', () => {
  it('edit → discardTabChanges → unmount: the discarded draft must NOT resurface as a dirty store draft', async () => {
    const mounted = await mountEditor(
      <MilkdownEditor tabId={TAB} filePath={FILE} content={ORIGINAL} />,
    );
    await flushDebounce();

    // Live edit, flushed to the store (the tab is genuinely dirty).
    const view = getCanvasEditorHandle(TAB)!.getEditorView!()!;
    const pos = findTextPos(view, 'Second paragraph');
    act(() => {
      view.dispatch(view.state.tr.insertText('DISCARD-ME ', pos));
    });
    await flushDebounce();
    expect(useDashboardStore.getState().tabEditState[TAB]?.dirty).toBe(true);

    // Explicit discard (unambiguous user intent): draft dropped, mode → view.
    act(() => {
      useDashboardStore.getState().discardTabChanges(TAB);
    });
    const afterDiscard = useDashboardStore.getState().tabEditState[TAB]!;
    expect(afterDiscard.dirty).toBe(false);
    expect(afterDiscard.draftContent).toBe(ORIGINAL);

    // The mode flip unmounts the editor; its cleanup flush must NOT push the
    // discarded live doc back into the store.
    await mounted.unmount();

    const after = useDashboardStore.getState().tabEditState[TAB]!;
    expect(after.dirty).toBe(false);
    expect(after.draftContent).toBe(ORIGINAL);
    expect(after.draftContent).not.toContain('DISCARD-ME');
  });

  it('a live edit still inside the debounce window is also dropped by an explicit discard', async () => {
    const mounted = await mountEditor(
      <MilkdownEditor tabId={TAB} filePath={FILE} content={ORIGINAL} />,
    );
    await flushDebounce();

    const view = getCanvasEditorHandle(TAB)!.getEditorView!()!;
    const pos = findTextPos(view, 'Second paragraph');
    // Edit but do NOT wait for markdownUpdated — the store never hears of it.
    act(() => {
      view.dispatch(view.state.tr.insertText('NEVER-FLUSHED ', pos));
    });

    act(() => {
      useDashboardStore.getState().discardTabChanges(TAB);
    });
    await mounted.unmount();

    const after = useDashboardStore.getState().tabEditState[TAB]!;
    expect(after.dirty).toBe(false);
    expect(after.draftContent).toBe(ORIGINAL);
    expect(after.draftContent).not.toContain('NEVER-FLUSHED');
  });
});
