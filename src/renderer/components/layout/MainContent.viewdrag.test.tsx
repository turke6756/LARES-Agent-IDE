// @vitest-environment jsdom
/**
 * Detachable top-level views — MainContent Dashboard-button tear-off (view-
 * detach §5, mirrors FileTabBar.dragend.test.tsx). The store, browser store,
 * window.api and heavy child panes are mocked; the dragend gesture runs against
 * real DOM events in jsdom.
 *
 * Covers:
 *   - dropEffect 'none' on the Dashboard button → window.api.views.detach is
 *     called with the view id, workspace, label and captured screen coords, and
 *     markViewDetached('dashboard') hollows the button;
 *   - an accepted drop (dropEffect !== 'none') → NOT detached;
 *   - while detached, the button is non-draggable + aria-disabled and the center
 *     slot renders the "open in a separate window" placeholder instead of the grid.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MainContent from './MainContent';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
if (typeof (globalThis as any).ResizeObserver !== 'function') {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

const storeMock = vi.hoisted(() => {
  const state: any = {
    workspaces: [{ id: 'ws-1', title: 'My Workspace', path: '/ws', pathType: 'windows' }],
    selectedWorkspaceId: 'ws-1',
    fileViewerOpen: false,
    browserOpen: false,
    openTabs: [],
    detachedViews: [] as string[],
    showFileViewer: vi.fn(),
    showBrowser: vi.fn(),
    showDashboard: vi.fn(),
    markViewDetached: vi.fn((v: string) => { state.detachedViews = [...state.detachedViews, v]; }),
  };
  const useDashboardStore: any = (selector: (s: typeof state) => unknown) => selector(state);
  useDashboardStore.getState = () => state;
  return { state, useDashboardStore };
});

vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: storeMock.useDashboardStore,
}));
vi.mock('../../stores/browser-store', () => ({
  useBrowserStore: (selector: (s: any) => unknown) => selector({ paneAttention: false }),
  ensureBrowserBridge: () => {},
}));

// Heavy child panes — irrelevant to the drag gesture; stub to keep the render cheap.
vi.mock('../agent/AgentGrid', () => ({ default: () => React.createElement('div', { 'data-testid': 'agent-grid' }) }));
vi.mock('../agent/AgentLaunchDialog', () => ({ default: () => null }));
vi.mock('../fileviewer/FileViewerPanel', () => ({ default: () => null }));
vi.mock('../browser/BrowserPanel', () => ({ default: () => null }));
// PlansMenu is its own component; here we only care that MainContent wires the
// view-detach drag props onto it (draggable/aria-disabled + the drag handlers,
// already bound to view:'plans'). Render a minimal button that forwards them so
// the drag gesture can be exercised end-to-end through MainContent.
vi.mock('../plan/PlansMenu', () => ({
  default: (props: any) => React.createElement('button', {
    'data-testid': 'view-btn-plans',
    draggable: !props.detached,
    'aria-disabled': props.detached ? 'true' : undefined,
    onDragStart: props.onDragStart,
    onDragEnd: props.onDragEnd,
  }),
}));
vi.mock('../../assets/material-icons/vscode.svg', () => ({ default: 'vscode.svg' }));

const detach = vi.fn(async () => ({ ok: true, focusedExisting: false }));

let container: HTMLDivElement;
let root: Root;

function makeDataTransfer() {
  return { dropEffect: 'none', effectAllowed: 'none', setData: () => {}, getData: () => '' };
}
function fireDrag(el: Element, type: string, props: Record<string, unknown>) {
  const ev: any = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, props);
  act(() => { el.dispatchEvent(ev); });
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function render() {
  act(() => { root.render(React.createElement(MainContent)); });
}
const dashBtn = () => container.querySelector('[data-testid="view-btn-dashboard"]') as HTMLElement;
const filesBtn = () => container.querySelector('[data-testid="view-btn-files"]') as HTMLElement;
const browserBtn = () => container.querySelector('[data-testid="view-btn-browser"]') as HTMLElement;
const plansBtn = () => container.querySelector('[data-testid="view-btn-plans"]') as HTMLElement;

beforeEach(() => {
  storeMock.state.detachedViews = [];
  storeMock.state.fileViewerOpen = false;
  storeMock.state.browserOpen = false;
  storeMock.state.markViewDetached = vi.fn((v: string) => { storeMock.state.detachedViews = [...storeMock.state.detachedViews, v]; });
  detach.mockClear();
  detach.mockResolvedValue({ ok: true, focusedExisting: false });
  (globalThis as any).window.api = {
    views: { detach },
    workspaces: { openInVSCode: vi.fn() },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MainContent Dashboard-button tear-off (handleViewDragEnd)', () => {
  it('detaches on dropEffect "none", with view/workspace/label + captured coords', async () => {
    render();
    fireDrag(dashBtn(), 'dragend', { dataTransfer: makeDataTransfer(), screenX: 640, screenY: 480 });
    await flush();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledWith(
      expect.objectContaining({ view: 'dashboard', workspaceId: 'ws-1', label: 'My Workspace', x: 640, y: 480 }),
    );
    expect(storeMock.state.markViewDetached).toHaveBeenCalledWith('dashboard');
  });

  it('does NOT detach when the drop was accepted (dropEffect !== "none")', async () => {
    render();
    fireDrag(dashBtn(), 'dragend', {
      dataTransfer: { ...makeDataTransfer(), dropEffect: 'move' }, screenX: 10, screenY: 10,
    });
    await flush();
    expect(detach).not.toHaveBeenCalled();
    expect(storeMock.state.markViewDetached).not.toHaveBeenCalled();
  });

  it('hollows the Dashboard button and shows a placeholder while detached', () => {
    storeMock.state.detachedViews = ['dashboard'];
    render();
    const btn = dashBtn();
    expect(btn.getAttribute('draggable')).toBe('false');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(container.textContent).toContain('The Dashboard is open in a separate window');
    // The grid slot is replaced by the placeholder — no agent grid rendered.
    expect(container.querySelector('[data-testid="agent-grid"]')).toBeNull();
  });

  it('detaches Files on dropEffect "none" with view:"files" + captured coords', async () => {
    render();
    fireDrag(filesBtn(), 'dragend', { dataTransfer: makeDataTransfer(), screenX: 320, screenY: 240 });
    await flush();
    expect(detach).toHaveBeenCalledWith(
      expect.objectContaining({ view: 'files', workspaceId: 'ws-1', label: 'My Workspace', x: 320, y: 240 }),
    );
    expect(storeMock.state.markViewDetached).toHaveBeenCalledWith('files');
  });

  it('hollows the Files button and shows a placeholder while detached (files was active)', () => {
    storeMock.state.detachedViews = ['files'];
    storeMock.state.fileViewerOpen = true; // Files was the active center view when torn off
    render();
    const btn = filesBtn();
    expect(btn.getAttribute('draggable')).toBe('false');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(container.textContent).toContain('The Files is open in a separate window');
  });
});

// Browser + Plans are the native-view-backed views this slice adds to the drag
// rail. Their panes re-parent in the main process, but the RENDERER gesture is
// identical to Dashboard/Files: dragend with dropEffect 'none' → views.detach.
describe('MainContent Browser-button tear-off', () => {
  it('detaches Browser on dropEffect "none" with view:"browser" + captured coords', async () => {
    render();
    fireDrag(browserBtn(), 'dragend', { dataTransfer: makeDataTransfer(), screenX: 800, screenY: 600 });
    await flush();
    expect(detach).toHaveBeenCalledWith(
      expect.objectContaining({ view: 'browser', workspaceId: 'ws-1', label: 'My Workspace', x: 800, y: 600 }),
    );
    expect(storeMock.state.markViewDetached).toHaveBeenCalledWith('browser');
  });

  it('does NOT detach Browser when the drop was accepted', async () => {
    render();
    fireDrag(browserBtn(), 'dragend', {
      dataTransfer: { ...makeDataTransfer(), dropEffect: 'move' }, screenX: 10, screenY: 10,
    });
    await flush();
    expect(detach).not.toHaveBeenCalled();
  });

  it('hollows the Browser button and shows a placeholder while detached (browser was active)', () => {
    storeMock.state.detachedViews = ['browser'];
    storeMock.state.browserOpen = true; // Browser was the active center view when torn off
    render();
    const btn = browserBtn();
    expect(btn.getAttribute('draggable')).toBe('false');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(container.textContent).toContain('The Browser is open in a separate window');
  });
});

describe('MainContent Plans-button tear-off (drag props forwarded to PlansMenu)', () => {
  it('detaches Plans on dropEffect "none" with view:"plans" + captured coords', async () => {
    render();
    fireDrag(plansBtn(), 'dragend', { dataTransfer: makeDataTransfer(), screenX: 128, screenY: 256 });
    await flush();
    expect(detach).toHaveBeenCalledWith(
      expect.objectContaining({ view: 'plans', workspaceId: 'ws-1', label: 'My Workspace', x: 128, y: 256 }),
    );
    expect(storeMock.state.markViewDetached).toHaveBeenCalledWith('plans');
  });

  it('ghosts the Plans button (non-draggable + aria-disabled) while detached', () => {
    storeMock.state.detachedViews = ['plans'];
    render();
    const btn = plansBtn();
    expect(btn.getAttribute('draggable')).toBe('false');
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  });
});
