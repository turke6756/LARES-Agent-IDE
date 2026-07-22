// @vitest-environment jsdom
/**
 * Detachable file tabs — FileTabBar tear-off detection (detachable-file-tabs-
 * plan §4 1.6 / Phase-1 verification). The store and window.api are mocked; the
 * dragstart→dragover→dragend chain runs against real DOM events in jsdom.
 *
 * Covers:
 *   - dropEffect 'none' on a file tab → window.api.tabs.detach is called with
 *     the captured screen coords;
 *   - an accepted drop (dropEffect !== 'none') → NOT called;
 *   - a directory-only tab (no filePath) → NOT called;
 *   - a reorder (handleDragOver fired) → NOT called;
 *   - save-before-detach: a dirty tab whose saveTab resolves false aborts the
 *     detach (saveTab called, detach NOT called).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FileTabBar from './FileTabBar';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

const storeMock = vi.hoisted(() => {
  const state: any = {
    tabEditState: {} as Record<string, { dirty?: boolean; mode?: string }>,
    selectedWorkspaceId: 'ws-1',
    moveTab: vi.fn(),
    setTabColor: vi.fn(),
    saveTab: vi.fn(async () => true),
    detachTab: vi.fn(),
  };
  const useDashboardStore: any = (selector: (s: typeof state) => unknown) => selector(state);
  useDashboardStore.getState = () => state;
  return { state, useDashboardStore };
});

vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: storeMock.useDashboardStore,
}));

// drag-file payload helper — only setData/effectAllowed are touched.
vi.mock('../../utils/drag-file', () => ({
  fileDragStart: (e: any) => { e.dataTransfer.setData('text/plain', 'x'); },
}));

const detach = vi.fn(async () => ({ ok: true, focusedExisting: false }));

const FILE_TAB = {
  id: 'tab-1',
  filePath: 'C:\\ws\\docs\\plan.md',
  rootDirectory: 'C:\\ws',
  pathType: 'windows' as const,
  workspaceId: 'ws-1',
  label: 'plan.md',
};
const FILE_TAB_2 = {
  id: 'tab-2',
  filePath: 'C:\\ws\\notes.txt',
  rootDirectory: 'C:\\ws',
  pathType: 'windows' as const,
  workspaceId: 'ws-1',
  label: 'notes.txt',
};
const DIR_TAB = {
  id: 'dir-1',
  filePath: '',
  rootDirectory: 'C:\\ws',
  pathType: 'windows' as const,
  workspaceId: 'ws-1',
  label: 'ws/',
};

let container: HTMLDivElement;
let root: Root;

function makeDataTransfer() {
  return {
    dropEffect: 'none',
    effectAllowed: 'none',
    setData: () => {},
    getData: () => '',
  };
}

function fireDrag(el: Element, type: string, props: Record<string, unknown>) {
  const ev: any = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, props);
  act(() => { el.dispatchEvent(ev); });
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function render(tabs: any[]) {
  act(() => {
    root.render(
      React.createElement(FileTabBar, {
        tabs,
        activeTabId: tabs[0]?.id ?? null,
        onSelectTab: () => {},
        onCloseTab: () => {},
      }),
    );
  });
}

function draggableTabs(): Element[] {
  return Array.from(container.querySelectorAll('[draggable="true"]'));
}

beforeEach(() => {
  storeMock.state.tabEditState = {};
  storeMock.state.saveTab = vi.fn(async () => true);
  storeMock.state.detachTab = vi.fn();
  storeMock.state.moveTab = vi.fn();
  detach.mockClear();
  (globalThis as any).window.api = {
    tabs: { detach },
    system: { openFileInWorkspace: vi.fn() },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('FileTabBar tear-off (handleDragEnd)', () => {
  it('detaches on dropEffect "none" over a file tab, with captured screen coords', async () => {
    render([FILE_TAB]);
    const el = draggableTabs()[0];
    fireDrag(el, 'dragend', { dataTransfer: makeDataTransfer(), screenX: 640, screenY: 480 });
    await flush();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: FILE_TAB.filePath, workspaceId: 'ws-1', x: 640, y: 480 }),
    );
    expect(storeMock.state.detachTab).toHaveBeenCalledWith('tab-1');
  });

  it('does NOT detach when the drop was accepted (dropEffect !== "none")', async () => {
    render([FILE_TAB]);
    const el = draggableTabs()[0];
    fireDrag(el, 'dragend', {
      dataTransfer: { ...makeDataTransfer(), dropEffect: 'move' },
      screenX: 10, screenY: 10,
    });
    await flush();
    expect(detach).not.toHaveBeenCalled();
  });

  it('does NOT detach a directory-only tab', async () => {
    render([DIR_TAB]);
    const el = draggableTabs()[0];
    fireDrag(el, 'dragend', { dataTransfer: makeDataTransfer(), screenX: 5, screenY: 5 });
    await flush();
    expect(detach).not.toHaveBeenCalled();
  });

  it('does NOT detach after a reorder (handleDragOver fired)', async () => {
    render([FILE_TAB, FILE_TAB_2]);
    const els = draggableTabs();
    // Drag tab-2 (index 1) start, then dragOver tab-1 (index 0). jsdom
    // getBoundingClientRect is all-zero → midpoint 0; fromIdx(1) > toIdx(0) so
    // clientX < 0 triggers the reorder branch (reorderHappenedRef = true).
    fireDrag(els[1], 'dragstart', { dataTransfer: makeDataTransfer() });
    fireDrag(els[0], 'dragover', { dataTransfer: makeDataTransfer(), clientX: -1 });
    expect(storeMock.state.moveTab).toHaveBeenCalled();
    fireDrag(els[1], 'dragend', { dataTransfer: makeDataTransfer(), screenX: 1, screenY: 1 });
    await flush();
    expect(detach).not.toHaveBeenCalled();
  });

  it('aborts detach when a dirty tab fails to save (save-before-detach)', async () => {
    // Phase 2: the save routes through the coordinator, which snapshots the
    // store draft (no editor adapter here) and passes it to saveTab as opts.
    storeMock.state.tabEditState = {
      'tab-1': { dirty: true, mode: 'source', draftContent: 'DRAFT', originalContent: 'ORIG' },
    };
    storeMock.state.saveTab = vi.fn(async () => false);
    render([FILE_TAB]);
    const el = draggableTabs()[0];
    fireDrag(el, 'dragend', { dataTransfer: makeDataTransfer(), screenX: 1, screenY: 1 });
    await flush();
    expect(storeMock.state.saveTab).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ content: 'DRAFT' }),
    );
    expect(detach).not.toHaveBeenCalled();
    expect(storeMock.state.detachTab).not.toHaveBeenCalled();
  });
});
