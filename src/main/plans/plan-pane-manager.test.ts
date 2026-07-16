// WP5 — plan render-pane visibility state machine.
//
// The pane is a native WebContentsView that composites ABOVE renderer DOM, so a
// background reparse must never re-reveal a pane the user has navigated away
// from OR that an overlay (the Plans gallery) has transiently hidden (BUG-47).
// This asserts the desired-visibility flag that show()/hide()/setPaneVisible()
// maintain and refresh() respects.
//
// PlanPaneManager is Electron-coupled (session/WebContentsView) and reads the
// served projection from ./watch-plans, so — mirroring browser-manager.test.ts
// — this injects minimal stand-ins into require.cache BEFORE requiring the
// module under test. No real Chromium view is ever constructed.
//
//   npm run build:main
//   node dist/main/main/plans/plan-pane-manager.test.js

import assert from 'node:assert/strict';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// ── fake WebContentsView: records every setVisible() flip ────────────────────
class FakeView {
  visibleCalls: boolean[] = [];
  loadedUrls: string[] = [];
  webContents = {
    loadURL: (url: string) => { this.loadedUrls.push(url); },
    close: () => {},
  };
  setBounds() {}
  setVisible(v: boolean) { this.visibleCalls.push(v); }
  get lastVisible(): boolean | undefined { return this.visibleCalls[this.visibleCalls.length - 1]; }
}

let lastView: FakeView | null = null;

const electronMock = {
  session: {
    fromPartition: (_p?: string) => ({
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {},
    }),
  },
  WebContentsView: class {
    constructor() {
      const v = new FakeView();
      lastView = v;
      return v as unknown as object;
    }
  },
};

// ── require.cache injections (before requiring the module under test) ─────────
const electronResolved = require.resolve('electron');
require.cache[electronResolved] = {
  id: electronResolved, filename: electronResolved, loaded: true, exports: electronMock,
} as unknown as NodeJS.Module;

const watchPlansResolved = require.resolve('./watch-plans');
require.cache[watchPlansResolved] = {
  id: watchPlansResolved, filename: watchPlansResolved, loaded: true,
  exports: { getServedPlanProjection: (_id: string) => ({ source: '<p data-anchor="sec_a1">plan</p>' }) },
} as unknown as NodeJS.Module;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PlanPaneManager } = require('./plan-pane-manager') as typeof import('./plan-pane-manager');

function fakeWindow(): unknown {
  return {
    isDestroyed: () => false,
    contentView: { addChildView() {}, removeChildView() {} },
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
  };
}

function newManager() {
  lastView = null;
  const mgr = new PlanPaneManager(() => fakeWindow() as never);
  return mgr;
}

// ── the reviewer's repro: overlay hides the pane, a reparse must not re-reveal ─
test('refresh does NOT re-reveal a pane the overlay transiently hid (setPaneVisible sync)', () => {
  const mgr = newManager();
  mgr.show('plan-1');
  const view = lastView!;
  assert.equal(view.lastVisible, true, 'show() reveals the pane');

  // Plans gallery opens → transiently hide the pane above renderer DOM.
  mgr.setPaneVisible(false);
  assert.equal(view.lastVisible, false, 'overlay suppressed the pane');

  // A background plan edit reparses the CURRENT plan → refresh().
  const flipsBefore = view.visibleCalls.length;
  mgr.refresh('plan-1');
  assert.equal(view.lastVisible, false, 'refresh must NOT re-reveal over the overlay');
  assert.ok(view.visibleCalls.length >= flipsBefore, 'refresh still re-rendered');
  assert.ok(view.loadedUrls.length >= 2, 'document was re-rendered on refresh');
});

test('after the overlay restores the pane, refresh keeps it visible', () => {
  const mgr = newManager();
  mgr.show('plan-1');
  const view = lastView!;
  mgr.setPaneVisible(false);
  mgr.setPaneVisible(true); // gallery closed → restore
  assert.equal(view.lastVisible, true, 'overlay restored the pane');

  mgr.refresh('plan-1');
  assert.equal(view.lastVisible, true, 'refresh preserves the restored visibility');
});

test('refresh preserves a hidden pane after navigation-away (hide())', () => {
  const mgr = newManager();
  mgr.show('plan-1');
  const view = lastView!;
  mgr.hide(); // tab unmounted / workspace switched
  assert.equal(view.lastVisible, false);

  mgr.refresh('plan-1');
  assert.equal(view.lastVisible, false, 'a cross-workspace reparse must not pop the pane back open');
});

test('show → hide → show cycles visibility correctly', () => {
  const mgr = newManager();
  mgr.show('plan-1');
  const view = lastView!;
  mgr.hide();
  mgr.show('plan-1');
  assert.equal(view.lastVisible, true);
  mgr.refresh('plan-1');
  assert.equal(view.lastVisible, true, 'refresh keeps a re-shown pane visible');
});

// ── runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
