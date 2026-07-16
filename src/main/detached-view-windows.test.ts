// Detachable top-level VIEWS (view tear-off) — registry ownership, duplicate-
// detach focus, closed-notification round-trip, and force-close, exercised
// without an Electron runtime via the `createWindow` test seam. Sibling of
// detached-windows.test.ts (which covers the file-tab tear-off).
//
// Covers:
//   - createDetachedViewWindow registers view ownership (isViewDetached),
//     trusts the window's webContents BEFORE load, and loads with the
//     detached=1&view=<name> query;
//   - a second detach for the same view focuses the existing window and returns
//     focusedExisting:true without spawning a second window;
//   - 'closed' releases ownership + trust AND notifies the main window on
//     VIEW_CHANNELS.closed with the {view, workspaceId} payload, so the shell
//     un-hollows the button; the view can then be re-detached;
//   - render-process-gone closes the window (view returns);
//   - forceCloseAllDetached closes view windows without prompting.
//
//   npm run build:main
//   node dist/main/main/detached-view-windows.test.js

import assert from 'node:assert/strict';
import {
  createDetachedViewWindow,
  isViewDetached,
  getDetachedViewWindows,
  forceCloseAllDetached,
  __resetDetachedRegistryForTest,
  type DetachedWindowDeps,
} from './detached-windows';
import { VIEW_CHANNELS, type ViewDetachRequest } from '../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── Fake BrowserWindow ───────────────────────────────────────────────
let nextWinId = 1;
let nextWcId = 2000;
interface SentMsg { channel: string; payload: any; }
interface FakeWin {
  id: number;
  webContents: { id: number; setWindowOpenHandler(): void; on(e: string, cb: () => void): void; send(c: string, p: any): void; isDestroyed(): boolean };
  focusCount: number;
  loadedWith: string | null;
  sent: SentMsg[];
  focus(): void;
  loadURL(url: string): void;
  loadFile(file: string, opts: { search: string }): void;
  isDestroyed(): boolean;
  on(event: string, cb: (e?: any) => void): void;
  close(): void;
  __fireClosed(): void;
  __fireRenderGone(): void;
}
function makeFakeWindow(): FakeWin {
  let closedCb: (() => void) | null = null;
  let closeCb: (() => void) | null = null;
  const wcListeners: Record<string, () => void> = {};
  let destroyed = false;
  const sent: SentMsg[] = [];
  const win: FakeWin = {
    id: nextWinId++,
    webContents: {
      id: nextWcId++,
      setWindowOpenHandler() {},
      on(e: string, cb: () => void) { wcListeners[e] = cb; },
      send(channel: string, payload: any) { sent.push({ channel, payload }); },
      isDestroyed() { return destroyed; },
    },
    focusCount: 0,
    loadedWith: null,
    sent,
    focus() { this.focusCount++; },
    loadURL(url: string) { this.loadedWith = url; },
    loadFile(_file: string, opts: { search: string }) { this.loadedWith = opts.search; },
    isDestroyed() { return destroyed; },
    on(event: string, cb: (e?: any) => void) {
      // A view window has NO dirty-close intercept (nothing to save), but it
      // DOES listen for 'close' to move a re-parented native pane home before
      // destruction. Real Electron fires 'close' (window still alive) then
      // 'closed' (after destruction); the fake mirrors that ordering.
      if (event === 'closed') closedCb = cb;
      else if (event === 'close') closeCb = cb;
    },
    close() { if (closeCb) closeCb(); destroyed = true; if (closedCb) closedCb(); },
    __fireClosed() { if (closeCb) closeCb(); destroyed = true; if (closedCb) closedCb(); },
    __fireRenderGone() { wcListeners['render-process-gone']?.(); },
  };
  return win;
}

// Fake main window so we can assert the VIEW_CHANNELS.closed round-trip.
function makeFakeMainWindow() {
  const sent: SentMsg[] = [];
  return {
    sent,
    isDestroyed() { return false; },
    webContents: { send(channel: string, payload: any) { sent.push({ channel, payload }); } },
  };
}

function makeDeps(over: Partial<DetachedWindowDeps> = {}): {
  deps: DetachedWindowDeps;
  created: FakeWin[];
  trustedContents: Set<unknown>;
  mainWin: ReturnType<typeof makeFakeMainWindow>;
} {
  const created: FakeWin[] = [];
  const trustedContents = new Set<unknown>();
  const mainWin = makeFakeMainWindow();
  const deps: DetachedWindowDeps = {
    devServerUrl: 'http://localhost:5173',
    builtIndexHtml: 'index.html',
    theme: 'dark',
    trustedContents: trustedContents as Set<Electron.WebContents>,
    setConstructingDetached: () => {},
    getMainWindow: () => mainWin as unknown as Electron.BrowserWindow,
    createWindow: () => {
      const w = makeFakeWindow();
      created.push(w);
      return w as unknown as Electron.BrowserWindow;
    },
    ...over,
  };
  return { deps, created, trustedContents, mainWin };
}

const REQ: ViewDetachRequest = {
  view: 'dashboard',
  workspaceId: 'ws-1',
  label: 'My Workspace',
  x: 100,
  y: 200,
};

// ── Ownership + trust ────────────────────────────────────────────────
test('createDetachedViewWindow registers view ownership and trusts webContents before load', () => {
  __resetDetachedRegistryForTest();
  const { deps, created, trustedContents } = makeDeps();
  const res = createDetachedViewWindow(REQ, deps);
  assert.equal(res.ok, true);
  assert.equal(res.focusedExisting, undefined);
  assert.equal(isViewDetached('dashboard'), true, 'view is detached-owned');
  assert.equal(trustedContents.has(created[0].webContents), true, 'webContents trusted');
  assert.ok(created[0].loadedWith && created[0].loadedWith.includes('detached=1'), 'loaded with detached query');
  assert.ok(created[0].loadedWith && created[0].loadedWith.includes('view=dashboard'), 'loaded with view=dashboard');
  assert.equal(getDetachedViewWindows().length, 1, 'one live detached view window');
});

// ── Duplicate detach ─────────────────────────────────────────────────
test('duplicate detach of the same view focuses existing, returns focusedExisting', () => {
  __resetDetachedRegistryForTest();
  const { deps, created } = makeDeps();
  createDetachedViewWindow(REQ, deps);
  assert.equal(created.length, 1);
  const res2 = createDetachedViewWindow(REQ, deps);
  assert.equal(res2.ok, true);
  assert.equal(res2.focusedExisting, true);
  assert.equal(created.length, 1, 'no second window spawned');
  assert.equal(created[0].focusCount, 1, 'existing window focused');
});

// ── Closed round-trip ────────────────────────────────────────────────
test("'closed' releases ownership + trust, notifies main, and allows re-detach", () => {
  __resetDetachedRegistryForTest();
  const { deps, created, trustedContents, mainWin } = makeDeps();
  createDetachedViewWindow(REQ, deps);
  const first = created[0];
  first.__fireClosed();
  assert.equal(isViewDetached('dashboard'), false, 'ownership released');
  assert.equal(trustedContents.has(first.webContents), false, 'trust released');
  // Main window was told to un-hollow the button.
  assert.equal(mainWin.sent.length, 1, 'one IPC message to main');
  assert.equal(mainWin.sent[0].channel, VIEW_CHANNELS.closed);
  assert.deepEqual(mainWin.sent[0].payload, { view: 'dashboard', workspaceId: 'ws-1' });
  // Re-detach spawns a fresh window (focusedExisting must NOT be set).
  const res = createDetachedViewWindow(REQ, deps);
  assert.equal(res.focusedExisting, undefined);
  assert.equal(created.length, 2, 'a new window spawned after close');
});

// ── Dead renderer ────────────────────────────────────────────────────
test('render-process-gone closes the view window (view returns)', () => {
  __resetDetachedRegistryForTest();
  const { deps, created } = makeDeps();
  createDetachedViewWindow(REQ, deps);
  const win = created[0];
  win.__fireRenderGone();
  assert.equal(win.isDestroyed(), true, 'dead renderer window closed');
  assert.equal(isViewDetached('dashboard'), false, 'ownership released');
});

// ── Force close ──────────────────────────────────────────────────────
test('forceCloseAllDetached closes every view window', () => {
  __resetDetachedRegistryForTest();
  const { deps, created } = makeDeps();
  createDetachedViewWindow(REQ, deps);
  createDetachedViewWindow({ ...REQ, view: 'files' }, deps);
  assert.equal(created.length, 2);
  forceCloseAllDetached();
  assert.equal(created[0].isDestroyed(), true);
  assert.equal(created[1].isDestroyed(), true);
  assert.equal(isViewDetached('dashboard'), false);
  assert.equal(isViewDetached('files'), false);
});

// ── Independent views ────────────────────────────────────────────────
test('different views detach independently; closing one leaves the other', () => {
  __resetDetachedRegistryForTest();
  const { deps, created, mainWin } = makeDeps();
  createDetachedViewWindow(REQ, deps);                        // dashboard
  createDetachedViewWindow({ ...REQ, view: 'files' }, deps);  // files
  assert.equal(isViewDetached('dashboard'), true);
  assert.equal(isViewDetached('files'), true);
  assert.equal(getDetachedViewWindows().length, 2, 'both windows live');
  // Files detach loads its own view=files query — proves per-view routing.
  assert.ok(created[1].loadedWith && created[1].loadedWith.includes('view=files'), 'files window loaded view=files');
  created[0].__fireClosed(); // close the dashboard window
  assert.equal(isViewDetached('dashboard'), false, 'dashboard released');
  assert.equal(isViewDetached('files'), true, 'files still detached');
  assert.equal(mainWin.sent.length, 1, 'exactly one un-hollow notice');
  assert.deepEqual(mainWin.sent[0].payload, { view: 'dashboard', workspaceId: 'ws-1' });
});

// ── Native-pane re-parent hooks (plans / browser) ────────────────────
// The plans/browser views composite a main-process WebContentsView that main
// must move OUT of the main window on detach and back on close. The window
// factory exposes that as the onViewWindowReady / onViewWindowClosing seam
// (index.ts wires them to plan-pane-manager.reparentTo / browser-manager
// .reparentTo etc.). These cases assert the seam fires with the right view +
// window at the right moment, without an Electron runtime.

test('detaching plans fires onViewWindowReady("plans", win) with the created window', () => {
  __resetDetachedRegistryForTest();
  const ready: Array<{ view: string; win: unknown }> = [];
  const { deps, created } = makeDeps({
    onViewWindowReady: (view, win) => ready.push({ view, win: win as unknown }),
  });
  createDetachedViewWindow({ ...REQ, view: 'plans' }, deps);
  assert.equal(ready.length, 1, 'reparent-ready fired once');
  assert.equal(ready[0].view, 'plans');
  assert.equal(ready[0].win, created[0] as unknown, 'hook got the detached window (to re-parent INTO)');
});

test('detaching browser fires onViewWindowReady("browser") with its own window', () => {
  __resetDetachedRegistryForTest();
  const ready: string[] = [];
  const { deps, created } = makeDeps({ onViewWindowReady: (view) => ready.push(view) });
  createDetachedViewWindow({ ...REQ, view: 'browser' }, deps);
  assert.deepEqual(ready, ['browser']);
  assert.ok(created[0].loadedWith && created[0].loadedWith.includes('view=browser'), 'browser window loaded view=browser');
});

test('closing a re-parented view fires onViewWindowClosing BEFORE ownership is released', () => {
  __resetDetachedRegistryForTest();
  const order: string[] = [];
  const { deps, created, mainWin } = makeDeps({
    onViewWindowReady: (view) => order.push(`ready:${view}`),
    // Ownership is still held while the pane moves home (removeChildView needs a
    // live window); we observe that by reading isViewDetached inside the hook.
    onViewWindowClosing: (view) => order.push(`closing:${view}:${isViewDetached('plans')}`),
  });
  createDetachedViewWindow({ ...REQ, view: 'plans' }, deps);
  created[0].__fireClosed(); // fires 'close' (→ closing hook) then 'closed'
  assert.deepEqual(order, ['ready:plans', 'closing:plans:true'],
    'closing hook fired on close, while the window was still owned');
  assert.equal(isViewDetached('plans'), false, 'ownership released after closed');
  // Main window told to un-hollow the Plans button.
  assert.equal(mainWin.sent.length, 1);
  assert.equal(mainWin.sent[0].channel, VIEW_CHANNELS.closed);
  assert.deepEqual(mainWin.sent[0].payload, { view: 'plans', workspaceId: 'ws-1' });
});

test('re-parent hooks are absent for pure-DOM views (dashboard/files) → no crash, still detach', () => {
  __resetDetachedRegistryForTest();
  // Deps WITHOUT the optional hooks — mirrors a caller that owns no managers.
  const { deps, created } = makeDeps();
  const res = createDetachedViewWindow({ ...REQ, view: 'files' }, deps);
  assert.equal(res.ok, true);
  assert.equal(isViewDetached('files'), true);
  created[0].__fireClosed(); // must not throw despite no onViewWindowClosing
  assert.equal(isViewDetached('files'), false);
});

// ── Runner ───────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
