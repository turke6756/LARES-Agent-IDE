// WP5 — thin sandboxed plan render-pane manager.
//
// Owns a single `WebContentsView` that renders the currently-focused plan
// surface as a static, JS-disabled document. Mirrors the browser-manager
// factory pattern (own session partition, hardened web preferences, child view
// attached to the main window's contentView) but strips everything a plan pane
// doesn't need: no tabs, no navigation, no persistence.
//
// The *decisions* (web preferences, CSP, sanitize, data-URL) live in the pure,
// unit-tested `plan-render-pane.ts`; this file is just the Electron lifecycle
// (create / attach / loadURL / refresh-on-reparse / destroy) that consumes them.

import { session, WebContentsView } from 'electron';
import type { BrowserWindow, Rectangle } from 'electron';
import type { PlanFormat } from '../../shared/types';
import { PLAN_PANE_WEB_PREFERENCES, buildPlanSurfaceDataUrl, clampPaneBoundsToContent } from './plan-render-pane';
import { getServedPlanProjection } from './watch-plans';
import { getPlan } from '../database';

/** WP-P2C-compat — the production plan-format resolver. Returns the plan's
 *  `format`, or null when the plan is unknown OR the DB is not yet initialized
 *  (very early boot / a unit test with no `initDatabase`). `show()` suppresses the
 *  pane only for a KNOWN `format==='structured'` plan; a null result renders as
 *  before. */
function defaultPlanFormat(planId: string): PlanFormat | null {
  try {
    return getPlan(planId)?.format ?? null;
  } catch {
    return null;
  }
}

/** Ephemeral (non-`persist:`) partition — a plan surface keeps no cookies,
 *  storage, or cache across sessions. */
const PLAN_PANE_PARTITION = 'plan-surface';

export class PlanPaneManager {
  private view: WebContentsView | null = null;
  private currentPlanId: string | null = null;
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private hardened = false;
  // Desired visibility as driven by tab focus (show/hide). A background reparse
  // (`refresh`) re-renders the document but must NOT flip this — otherwise a
  // plan edited by agents in ANOTHER workspace would re-reveal a pane the user
  // had navigated away from, painting over their current view with no way to
  // close it (BUG-47).
  private visible = false;
  // View tear-off (Plans detach): the window the pane attaches to. null → the
  // main window (default). Set by reparentTo when Plans is torn off into its own
  // window; cleared by reparentHome on close. `host()` resolves it, falling back
  // to the main window if the override was destroyed out from under us.
  private hostOverride: BrowserWindow | null = null;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    /** WP-P2C-compat — resolves a plan's `format` so `show()` can exclude a
     *  `format='structured'` surface from the sandboxed HTML pane. Injectable for
     *  tests; defaults to the DB-backed resolver. */
    private readonly getPlanFormat: (planId: string) => PlanFormat | null = defaultPlanFormat,
  ) {}

  /** The window the pane's WebContentsView should attach to right now. */
  private host(): BrowserWindow | null {
    if (this.hostOverride && !this.hostOverride.isDestroyed()) return this.hostOverride;
    return this.getWindow();
  }

  /** Move the pane into `win` (the detached Plans window) so the plan document
   *  paints there. Subsequent show/hide/setBounds from that window's renderer then
   *  drive this pane. If no view exists yet, just record the host — ensureView()
   *  attaches to it on the next show(). */
  reparentTo(win: BrowserWindow): void {
    if (this.hostOverride === win) return;
    const prev = this.host();
    this.hostOverride = win;
    const view = this.view;
    if (!view) return;
    try {
      if (prev && !prev.isDestroyed() && prev !== win) prev.contentView.removeChildView(view);
    } catch { /* old host already gone */ }
    if (!win.isDestroyed()) {
      win.contentView.addChildView(view);
      view.setBounds(this.bounds);
      view.setVisible(this.visible);
    }
  }

  /** Move the pane back to the main window (detached window closing). The pane is
   *  hidden on return — the main window has no active plan tab driving it until the
   *  user opens one, which re-shows via show(). */
  reparentHome(): void {
    if (this.hostOverride === null) return;
    const prev = this.hostOverride;
    this.hostOverride = null;
    const view = this.view;
    if (!view) return;
    try {
      if (prev && !prev.isDestroyed()) prev.contentView.removeChildView(view);
    } catch { /* detached window already gone */ }
    const main = this.getWindow();
    if (main && !main.isDestroyed()) {
      main.contentView.addChildView(view);
      view.setBounds(this.bounds);
    }
    this.visible = false;
    view.setVisible(false);
  }

  /** Deny every optional permission on the plan-surface session (a static doc
   *  needs none), and never persist. Idempotent. */
  private ensureHardened(): void {
    if (this.hardened) return;
    const sess = session.fromPartition(PLAN_PANE_PARTITION);
    sess.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    sess.setPermissionCheckHandler(() => false);
    this.hardened = true;
  }

  /** Lazily create the pane's WebContentsView + attach it to the main window.
   *  Hidden until `show()` selects it. */
  private ensureView(): WebContentsView | null {
    if (this.view) return this.view;
    const win = this.host();
    if (!win || win.isDestroyed()) return null;
    this.ensureHardened();
    const view = new WebContentsView({
      webPreferences: {
        ...PLAN_PANE_WEB_PREFERENCES,
        session: session.fromPartition(PLAN_PANE_PARTITION),
      },
    });
    win.contentView.addChildView(view);
    view.setBounds(this.bounds);
    view.setVisible(false);
    this.view = view;
    return view;
  }

  /** Render (or re-render) a plan surface from raw HTML. Sanitizes + wraps in a
   *  CSP document (via the pure builder) and loads it as a data: URL — a full
   *  re-render, never in-place DOM patching. Falls back to the served projection
   *  source when `rawHtml` is omitted (the reparse-refresh path). */
  show(planId: string, rawHtml?: string): void {
    // WP-P2C-compat: a `format='structured'` (folder-adopted) plan has no HTML
    // document to paint — no-op rather than construct a view and load an
    // empty/mis-rendered doc. Legacy `html`/`md` surfaces (and an unknown/null
    // format) render as before.
    if (this.getPlanFormat(planId) === 'structured') return;
    const view = this.ensureView();
    if (!view) return;
    this.render(view, planId, rawHtml);
    this.visible = true;
    view.setVisible(true);
  }

  /** Render (or re-render) the plan document into the view WITHOUT touching
   *  visibility — the shared core of show()/refresh(). */
  private render(view: WebContentsView, planId: string, rawHtml?: string): void {
    const source = rawHtml ?? getServedPlanProjection(planId)?.source ?? '';
    const { dataUrl } = buildPlanSurfaceDataUrl(source);
    this.currentPlanId = planId;
    void view.webContents.loadURL(dataUrl);
  }

  /** Reparse-refresh entrypoint: when the WP4 watcher reparses the plan that is
   *  currently shown, re-render it from the freshly-served projection. A change
   *  to a different plan is ignored (that pane isn't the current one). No-op if
   *  nothing is shown.
   *
   *  Preserves current visibility: a reparse only updates the DOCUMENT. If the
   *  user has navigated away (pane hidden), it stays hidden — a cross-workspace
   *  plan edit must never pop the pane back open over their current view. */
  refresh(planId: string): void {
    if (!this.view || this.currentPlanId !== planId) return;
    this.render(this.view, planId);
    this.view.setVisible(this.visible);
  }

  /** Clamp the renderer-streamed host rect to the window's visible content area
   *  before it reaches the view, so the pane never runs off the bottom/right of
   *  the screen (a long plan then scrolls INSIDE the clamped viewport). */
  setBounds(bounds: Rectangle): void {
    const clamped = this.clampToWindow(bounds);
    this.bounds = clamped;
    this.view?.setBounds(clamped);
  }

  private clampToWindow(bounds: Rectangle): Rectangle {
    const win = this.host();
    if (!win || win.isDestroyed()) return bounds;
    const { width, height } = win.getContentBounds();
    return clampPaneBoundsToContent(bounds, { width, height });
  }

  hide(): void {
    this.visible = false;
    this.view?.setVisible(false);
  }

  /** Visibility-only toggle for renderer overlays (e.g. the Plans gallery) that
   *  must paint DOM above the pane's bounds. Unlike show(), this NEVER reloads
   *  the document — it flips native visibility only, so re-revealing is instant
   *  and preserves scroll. No-op if no view exists or nothing is loaded. Mirrors
   *  the browser pane's window.api.browser.setVisible primitive. */
  setPaneVisible(visible: boolean): void {
    if (!this.view) return; // no view to toggle — leave desired-visibility untouched
    if (visible && !this.currentPlanId) return; // nothing loaded to reveal — don't mark visible
    this.view.setVisible(visible);
    // Keep the desired-visibility flag in sync so a reparse-driven refresh()
    // respects the overlay's suppression: while the Plans gallery has hidden the
    // pane (setPaneVisible(false)), a background plan edit must NOT re-reveal it
    // over the overlay — same takeover as BUG-47, different door.
    this.visible = visible;
  }

  /** Tear down the pane (e.g. the surface tab was closed). */
  destroy(): void {
    if (!this.view) return;
    const win = this.host();
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(this.view);
      this.view.webContents.close();
    } catch { /* view already gone — nothing to reap */ }
    this.view = null;
    this.currentPlanId = null;
    this.visible = false;
    this.hostOverride = null;
  }
}
