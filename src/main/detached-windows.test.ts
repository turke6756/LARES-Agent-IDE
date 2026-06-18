// Detachable file tabs (detachable-file-tabs-plan §4 1.2 / Phase-1 verification)
// — ownership write-enforcement + duplicate-detach focus, exercised without an
// Electron runtime via the `createWindow` test seam.
//
// Covers:
//   - canWrite: true for any sender on an unowned file; after detach, true for
//     the owning webContents and false for a foreign sender;
//   - createDetachedWindow registers ownership (isDetachedOwned) and marks the
//     window's webContents trusted BEFORE load;
//   - a second createDetachedWindow for the same file focuses the existing
//     window and returns focusedExisting:true without spawning a second window;
//   - 'closed' releases ownership + trust so the same file can be re-detached.
//
//   npm run build:main
//   node dist/main/main/detached-windows.test.js

import assert from 'node:assert/strict';
import {
  createDetachedWindow,
  canWrite,
  isDetachedOwned,
  handleDetachedCloseReply,
  forceCloseAllDetached,
  __resetDetachedRegistryForTest,
  type DetachedWindowDeps,
} from './detached-windows';
import { TAB_CHANNELS, type DetachRequest } from '../shared/types';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

// ── Fake BrowserWindow ───────────────────────────────────────────────
let nextWinId = 1;
let nextWcId = 1000;
interface SentMsg { channel: string; payload: any; }
interface FakeWin {
  id: number;
  webContents: { id: number; setWindowOpenHandler(): void; on(e: string, cb: () => void): void; send(c: string, p: any): void; isDestroyed(): boolean };
  focusCount: number;
  loadedWith: string | null;
  sent: SentMsg[];
  closeCount: number;
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
  let closeCb: ((e: { preventDefault(): void }) => void) | null = null;
  let closedCb: (() => void) | null = null;
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
    closeCount: 0,
    focus() { this.focusCount++; },
    loadURL(url: string) { this.loadedWith = url; },
    loadFile(_file: string, opts: { search: string }) { this.loadedWith = opts.search; },
    isDestroyed() { return destroyed; },
    on(event: string, cb: (e?: any) => void) {
      if (event === 'close') closeCb = cb as (e: { preventDefault(): void }) => void;
      if (event === 'closed') closedCb = cb;
    },
    // Models Electron: 'close' fires first (cancellable); if not prevented the
    // window is destroyed and 'closed' fires. This is also the path the factory's
    // own `win.close()` (confirmed/force close) takes — re-entering the intercept.
    close() {
      this.closeCount++;
      let prevented = false;
      if (closeCb) closeCb({ preventDefault() { prevented = true; } });
      if (!prevented) { destroyed = true; if (closedCb) closedCb(); }
    },
    __fireClosed() { destroyed = true; if (closedCb) closedCb(); },
    __fireRenderGone() { wcListeners['render-process-gone']?.(); },
  };
  return win;
}

function makeDeps(over: Partial<DetachedWindowDeps> = {}): {
  deps: DetachedWindowDeps;
  created: FakeWin[];
  trustedContents: Set<unknown>;
} {
  const created: FakeWin[] = [];
  const trustedContents = new Set<unknown>();
  const deps: DetachedWindowDeps = {
    devServerUrl: 'http://localhost:5173',
    builtIndexHtml: 'index.html',
    theme: 'dark',
    trustedContents: trustedContents as Set<Electron.WebContents>,
    setConstructingDetached: () => {},
    getMainWindow: () => null,
    createWindow: () => {
      const w = makeFakeWindow();
      created.push(w);
      return w as unknown as Electron.BrowserWindow;
    },
    ...over,
  };
  return { deps, created, trustedContents };
}

const REQ: DetachRequest = {
  filePath: 'C:\\ws\\docs\\plan.md',
  rootDirectory: 'C:\\ws',
  pathType: 'windows',
  workspaceId: 'ws-1',
  label: 'plan.md',
  x: 100,
  y: 200,
};

// ── canWrite ─────────────────────────────────────────────────────────
test('canWrite: any sender may write an unowned file', () => {
  __resetDetachedRegistryForTest();
  assert.equal(canWrite(REQ.filePath, 12345), true);
});

test('canWrite: owner true, foreign false after detach', () => {
  __resetDetachedRegistryForTest();
  const { deps, created } = makeDeps();
  const res = createDetachedWindow(REQ, deps);
  assert.equal(res.ok, true);
  assert.equal(res.focusedExisting, undefined);
  const ownerWcId = created[0].webContents.id;
  assert.equal(canWrite(REQ.filePath, ownerWcId), true, 'owner may write');
  assert.equal(canWrite(REQ.filePath, ownerWcId + 777), false, 'foreign sender rejected');
  // Case-insensitive on the Windows drive-letter path (normalizeFileKey).
  assert.equal(canWrite('c:/ws/docs/plan.md', ownerWcId + 777), false, 'foreign rejected via alt spelling');
});

test('createDetachedWindow registers ownership and trusts webContents before load', () => {
  __resetDetachedRegistryForTest();
  const { deps, created, trustedContents } = makeDeps();
  createDetachedWindow(REQ, deps);
  const owner = isDetachedOwned(REQ.filePath);
  assert.ok(owner, 'file is detached-owned');
  assert.equal(owner!.winId, created[0].id);
  assert.equal(owner!.webContentsId, created[0].webContents.id);
  assert.equal(trustedContents.has(created[0].webContents), true, 'webContents trusted');
  assert.ok(created[0].loadedWith && created[0].loadedWith.includes('detached=1'), 'loaded with detached query');
});

// ── Duplicate detach ─────────────────────────────────────────────────
test('duplicate createDetachedWindow focuses existing, returns focusedExisting', () => {
  __resetDetachedRegistryForTest();
  const { deps, created } = makeDeps();
  createDetachedWindow(REQ, deps);
  assert.equal(created.length, 1);
  const res2 = createDetachedWindow(REQ, deps);
  assert.equal(res2.ok, true);
  assert.equal(res2.focusedExisting, true);
  assert.equal(created.length, 1, 'no second window spawned');
  assert.equal(created[0].focusCount, 1, 'existing window focused');
});

// ── Lifecycle ────────────────────────────────────────────────────────
test("'closed' releases ownership + trust; file can be re-detached", () => {
  __resetDetachedRegistryForTest();
  const { deps, created, trustedContents } = makeDeps();
  createDetachedWindow(REQ, deps);
  const first = created[0];
  first.__fireClosed();
  assert.equal(isDetachedOwned(REQ.filePath), undefined, 'ownership released');
  assert.equal(trustedContents.has(first.webContents), false, 'trust released');
  assert.equal(canWrite(REQ.filePath, 999), true, 'unowned again');
  // Re-detach spawns a fresh window (focusedExisting must NOT be set).
  const res = createDetachedWindow(REQ, deps);
  assert.equal(res.focusedExisting, undefined);
  assert.equal(created.length, 2, 'a new window spawned after close');
});

// ── Phase 2: dirty-on-close protocol ─────────────────────────────────
test('user close sends a close-query and keeps the window open', () => {
  __resetDetachedRegistryForTest();
  const { deps, created } = makeDeps();
  createDetachedWindow(REQ, deps);
  const win = created[0];
  win.close(); // user clicks X
  assert.equal(win.sent.length, 1, 'one IPC message sent');
  assert.equal(win.sent[0].channel, TAB_CHANNELS.closeQuery);
  assert.ok(win.sent[0].payload.requestId, 'carries a requestId');
  assert.ok(isDetachedOwned(REQ.filePath), 'still owned — window not yet closed');
  assert.equal(win.isDestroyed(), false, 'window stays open pending the reply');
});

test("close-reply 'cancel' keeps the window open", () => {
  __resetDetachedRegistryForTest();
  const { deps, created } = makeDeps();
  createDetachedWindow(REQ, deps);
  const win = created[0];
  win.close();
  const requestId = win.sent[0].payload.requestId as string;
  handleDetachedCloseReply(requestId, 'cancel');
  assert.ok(isDetachedOwned(REQ.filePath), 'still owned after cancel');
  assert.equal(win.isDestroyed(), false, 'window remains open after cancel');
});

test("close-reply 'save'/'discard' closes the window and releases ownership", () => {
  for (const decision of ['save', 'discard'] as const) {
    __resetDetachedRegistryForTest();
    const { deps, created } = makeDeps();
    createDetachedWindow(REQ, deps);
    const win = created[0];
    win.close();
    const requestId = win.sent[0].payload.requestId as string;
    handleDetachedCloseReply(requestId, decision);
    assert.equal(win.isDestroyed(), true, `window closed on ${decision}`);
    assert.equal(isDetachedOwned(REQ.filePath), undefined, `ownership released on ${decision}`);
  }
});

test('stale/unknown close-reply requestId is a no-op', () => {
  __resetDetachedRegistryForTest();
  const { deps, created } = makeDeps();
  createDetachedWindow(REQ, deps);
  const win = created[0];
  assert.doesNotThrow(() => handleDetachedCloseReply('999:999', 'discard'));
  assert.equal(win.isDestroyed(), false, 'unrelated window untouched');
  assert.ok(isDetachedOwned(REQ.filePath), 'still owned');
});

test('render-process-gone closes the window and returns the file', () => {
  __resetDetachedRegistryForTest();
  const { deps, created } = makeDeps();
  createDetachedWindow(REQ, deps);
  const win = created[0];
  win.__fireRenderGone();
  assert.equal(win.isDestroyed(), true, 'dead renderer window closed');
  assert.equal(isDetachedOwned(REQ.filePath), undefined, 'ownership released');
  assert.equal(win.sent.length, 0, 'no close-query — renderer is gone');
});

test('forceCloseAllDetached closes every window without prompting', () => {
  __resetDetachedRegistryForTest();
  const { deps, created } = makeDeps();
  createDetachedWindow(REQ, deps);
  const REQ2 = { ...REQ, filePath: 'C:\\ws\\docs\\other.md', label: 'other.md' };
  createDetachedWindow(REQ2, deps);
  forceCloseAllDetached();
  assert.equal(created[0].isDestroyed(), true);
  assert.equal(created[1].isDestroyed(), true);
  assert.equal(created[0].sent.length, 0, 'no close-query on force close');
  assert.equal(isDetachedOwned(REQ.filePath), undefined);
  assert.equal(isDetachedOwned(REQ2.filePath), undefined);
});

// Regression: a real Electron BrowserWindow throws "Object has been destroyed"
// when `win.webContents` / `win.id` are accessed AFTER 'closed' fires. The
// factory must capture those references up front; otherwise the throw escapes
// the handler, hits the main-process uncaughtException handler, and exits the
// whole app (crash when the user closes a detached window).
test("'closed' handler does not touch the window after destroy", () => {
  __resetDetachedRegistryForTest();
  let closedCb: (() => void) | null = null;
  let destroyed = false;
  const realWc = { id: 4242, setWindowOpenHandler() {}, on() {} };
  const win = {
    get id() { if (destroyed) throw new TypeError('Object has been destroyed'); return 7; },
    get webContents() {
      if (destroyed) throw new TypeError('Object has been destroyed');
      return realWc;
    },
    focus() {},
    loadURL() {},
    loadFile() {},
    isDestroyed() { return destroyed; },
    on(event: string, cb: () => void) { if (event === 'closed') closedCb = cb; },
  };
  const { deps, trustedContents } = makeDeps({
    createWindow: () => win as unknown as Electron.BrowserWindow,
  });
  createDetachedWindow(REQ, deps);
  assert.equal(trustedContents.has(realWc), true, 'trusted before close');
  // Simulate Electron destroying the window before 'closed' fires.
  destroyed = true;
  assert.doesNotThrow(() => closedCb!(), 'closed handler must not access destroyed window');
  assert.equal(isDetachedOwned(REQ.filePath), undefined, 'ownership released');
  assert.equal(trustedContents.has(realWc), false, 'trust released');
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
