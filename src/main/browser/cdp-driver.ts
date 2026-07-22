// WP2-A task 1 (plans/embedded-browser-implementation-tasks.md) — CDP driver
// over webContents.debugger (protocol '1.3') for persist:agent tabs.
//
// M9: this driver is only ever constructed by browser-manager.ts, and its
// `attach` callback is the manager's attachDebugger() — which throws unless
// the tab lives on persist:agent. There is no other way to reach CDP.
//
// M10: NO raw eval primitive exists here. executeJavaScriptInIsolatedWorld
// appears exactly once, inside getText(), running a fixed innerText capture —
// it is an internal implementation detail, never exposed as a tool, and never
// fed agent-supplied code. The WP-C act primitives added here — focus,
// typeText, pressKey, scrollIntoView, scrollByDelta — are all built from CDP
// DOM/Input/Emulation commands (DOM.focus, Input.insertText,
// Input.dispatchKeyEvent, Input.dispatchMouseEvent,
// Emulation.setFocusEmulationEnabled) carrying fixed, structured payloads; NONE
// of them run agent-supplied script. The one `commands:['selectAll']` payload on
// the type() replace keydown is a built-in Chromium EDITOR command (a named edit
// action), not script — there is no JS string anywhere, and insertText then
// REPLACES that selection. Runtime.evaluate / Runtime.callFunctionOn never
// appear in this file.
//
// PHASE-2 ROOT CAUSE (proven by .dashboard/cdp-trace.phase2-evidence.jsonl):
// agent tabs are HIDDEN WebContentsViews (browser-manager creates them
// setVisible(false)), so the renderer page is never "focused & active". On such
// a view, Input.dispatchKeyEvent EDITING/SUBMIT default-actions — the selectAll
// editor command, Backspace/Delete deletion, and Enter's implicit form submit —
// silently NO-OP, while frame-level Input.insertText still lands. The trace
// showed 13 Backspaces deleting nothing yet insertText appending fine, so a
// "replace" became an append, and Enter submitted no form. The fix
// (assertPageFocused → Emulation.setFocusEmulationEnabled) holds the page
// focused+active so those default-actions fire; the clear is then a
// focus-correct selectAll + insertText (insertText REPLACES the selection) with
// NO Backspace key-events involved.
//
// PHASE-1 INSTRUMENTATION (opt-in CDP trace): the CdpTracer below appends JSONL
// to <workspaceRoot>/.dashboard/cdp-trace.log when enabled, recording the raw
// CDP round-trips of the typeText(replace) and pressKey verbs (method, params,
// result-or-error) plus a few computed-decision notes. It is OFF by default and
// fully no-op when disabled — it adds NO CDP commands and NO eval (it never
// touches Runtime.* or executeJavaScript; it uses only Node fs append + an
// existsSync sentinel probe). It exists to gather live evidence for the
// type/press_key defect and does not change any browser behavior.

import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import type { RawAXNode } from './a11y-snapshot';
import { SELECT_ALL, type CdpKey } from './key-map';

/**
 * Guidance for keyboard-only dropdowns that select_option cannot click: native
 * <select> (browser-chrome popup), select2-style widgets that hide a 0×0 native
 * <select>, and aria-activedescendant comboboxes whose options are JS-injected
 * with no clickable node. Shared by refuseNativeSelect and the manager's
 * empty-geometry / option-not-found branches so all three give the SAME
 * actionable message instead of the misleading "no visible geometry" error.
 * M10: the workaround is keyboard only — no eval, no scripted option list.
 */
export const KEYBOARD_DROPDOWN_GUIDANCE =
  'this dropdown cannot be driven by select_option — open it (click it, or focus ' +
  'it and press_key Enter/ArrowDown), then use press_key ArrowDown/ArrowUp to move ' +
  'and press_key Enter to choose. Native <select>, select2-style, and ' +
  'aria-activedescendant comboboxes expose no clickable option node to target.';

/** Cap on getText output so a pathological page can't flood the agent. */
export const MAX_TEXT_CHARS = 100_000;

/** Private isolated world for the getText capture — never the page's main
 *  world, so page JS cannot tamper with the captured value or observe us. */
const ISOLATED_WORLD_ID = 1999;

export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

// ── Phase-1 opt-in CDP trace ────────────────────────────────────────────────
//
// Enable EITHER way (checked once per traced verb invocation, so a freshly
// dropped sentinel takes effect on the very next type/press_key — NO app
// restart required for the sentinel path):
//   1. env  CDP_TRACE=1                — set before launching Electron.
//   2. sentinel file                   — `touch <workspaceRoot>/.lares/cdp-trace.on`.
// The sentinel is the RELIABLE path for the running Electron main: the env var
// would require relaunching the already-running app, whereas the sentinel is
// re-probed (existsSync) at the start of every traced verb. Output JSONL is
// appended to `<workspaceRoot>/.lares/cdp-trace.log`.
//
// `<workspaceRoot>` resolves from `process.cwd()` — the Electron main process is
// launched via `electron .` (npm `start`) from the project root, so its cwd IS
// the workspace root. `CDP_TRACE_DIR` overrides the `.lares` base dir if a
// deployment ever launches from elsewhere. Diagnostics-only, so this does a
// plain exists-preference (`.lares`, else legacy `.dashboard`) rather than
// triggering the state-dir migration as a module-load side effect.
const TRACE_BASE_DIR = process.env.CDP_TRACE_DIR
  ?? (!existsSync(join(process.cwd(), '.lares')) && existsSync(join(process.cwd(), '.dashboard'))
    ? join(process.cwd(), '.dashboard')
    : join(process.cwd(), '.lares'));
const TRACE_SENTINEL = join(TRACE_BASE_DIR, 'cdp-trace.on');
const TRACE_LOG = join(TRACE_BASE_DIR, 'cdp-trace.log');

function traceEnabled(): boolean {
  if (process.env.CDP_TRACE === '1') return true;
  try {
    return existsSync(TRACE_SENTINEL);
  } catch {
    return false;
  }
}

/** Cap on the JSON byte-size of any single logged CDP result. Some captures
 *  (e.g. full AX trees) are large; over the cap we log the raw byte-size + a
 *  head peek instead of the whole blob so the log stays readable but still
 *  records the raw size the task asked for. */
const TRACE_VALUE_CAP = 4_000;

function summarizeValue(v: unknown): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
  if (json === undefined) return undefined;
  if (json.length <= TRACE_VALUE_CAP) return v;
  return { __truncatedBytes: json.length, head: json.slice(0, 800) };
}

function errToString(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  try {
    return String(err);
  } catch {
    return '[unstringifiable error]';
  }
}

/**
 * Buffers one verb invocation's trace lines and flushes them in a single append
 * at the end. Each line is one JSON object tagged with the verb + the ref
 * backendNodeId it belongs to. `step()` records a raw CDP round-trip (params +
 * result OR error); `note()` records a computed decision (resolveEditable
 * descent, clear plan, insertText fallback, gaps).
 */
class CdpTracer {
  private lines: string[] = [];

  constructor(
    readonly verb: string,
    private readonly backendNodeId: number | undefined,
  ) {}

  private push(obj: Record<string, unknown>): void {
    this.lines.push(
      JSON.stringify({
        ts: new Date().toISOString(),
        verb: this.verb,
        ref: this.backendNodeId,
        ...obj,
      }) + '\n',
    );
  }

  step(method: string, params: unknown, result: unknown, error: unknown): void {
    if (error !== undefined) {
      this.push({ kind: 'cmd', method, params: summarizeValue(params), error: errToString(error) });
    } else {
      this.push({ kind: 'cmd', method, params: summarizeValue(params), result: summarizeValue(result) });
    }
  }

  note(label: string, data: Record<string, unknown>): void {
    this.push({ kind: 'note', label, ...data });
  }

  flush(): void {
    if (this.lines.length === 0) return;
    const payload = this.lines.join('');
    this.lines = [];
    try {
      appendFileSync(TRACE_LOG, payload);
    } catch {
      // Tracing must never break a verb — a bad log path is silently ignored.
    }
  }
}

export class CdpDriver {
  private dbg: Electron.Debugger | null = null;
  private domainsReady = false;
  /** Phase-1 trace context for the verb currently executing. Set by withTrace()
   *  at the top of typeText(replace)/pressKey, read by cmd() to log each CDP
   *  round-trip and by resolveEditable to note computed decisions.
   *  Driver calls are serialized (each awaited end-to-end by browser-manager),
   *  so a single field correctly scopes one verb's nested cmd() calls. */
  private activeTrace: CdpTracer | null = null;

  constructor(
    private readonly wc: WebContents,
    /** Manager's M9-enforced attach helper: attaches '1.3' if not attached,
     *  throws for any non-agent partition. */
    private readonly attach: () => Electron.Debugger,
  ) {}

  /** Attach (or re-attach after a detach event) and re-enable domains. */
  private ensure(): Electron.Debugger {
    const dbg = this.attach();
    if (dbg !== this.dbg) {
      this.dbg = dbg;
      // webContents.debugger is a stable object across attach/detach cycles,
      // so this listener is registered exactly once per driver.
      dbg.on('detach', () => {
        this.domainsReady = false;
      });
    }
    return dbg;
  }

  private async cmd<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const dbg = this.ensure();
    if (!this.domainsReady) {
      await dbg.sendCommand('Page.enable');
      await dbg.sendCommand('DOM.enable');
      await dbg.sendCommand('Accessibility.enable');
      this.domainsReady = true;
    }
    const trace = this.activeTrace;
    if (!trace) return (await dbg.sendCommand(method, params)) as T;
    try {
      const result = await dbg.sendCommand(method, params);
      trace.step(method, params, result, undefined);
      return result as T;
    } catch (err) {
      trace.step(method, params, undefined, err);
      throw err;
    }
  }

  /**
   * Phase-1 instrumentation scope. When tracing is OFF (or already active from
   * an outer traced verb — e.g. pressKey called inside typeText's clear loop)
   * this just runs `fn` unchanged: zero behavior change, no new CDP calls. When
   * tracing is ON and this is the outermost traced verb, it installs a fresh
   * CdpTracer so every cmd() round-trip inside `fn` is logged, then flushes the
   * buffered JSONL once on completion (success or throw).
   */
  private async withTrace<T>(
    verb: string,
    backendNodeId: number | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.activeTrace || !traceEnabled()) return fn();
    const tracer = new CdpTracer(verb, backendNodeId);
    this.activeTrace = tracer;
    try {
      return await fn();
    } finally {
      this.activeTrace = null;
      tracer.flush();
    }
  }

  /**
   * Navigate and wait for the load to settle: resolves on `did-finish-load`,
   * rejects on main-frame `did-fail-load` or after `timeoutMs`. The caller
   * (tools facade) has already run checkNavigation (M11) — and the view's M6
   * will-navigate/will-redirect gates still cover any redirect chain.
   */
  navigateAndWait(url: string, timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS): Promise<void> {
    const wc = this.wc;
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void): void => {
        if (done) return;
        done = true;
        cleanup();
        fn();
      };
      const onFinish = (): void => finish(resolve);
      const onFail = (
        _e: unknown,
        errorCode: number,
        errorDescription: string,
        _validatedURL: string,
        isMainFrame: boolean,
      ): void => {
        if (isMainFrame) {
          finish(() => reject(new Error(`navigation failed (${errorCode}): ${errorDescription}`)));
        }
      };
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`navigation timed out after ${timeoutMs}ms: ${url}`)));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        wc.off('did-finish-load', onFinish);
        wc.off('did-fail-load', onFail);
      };
      wc.on('did-finish-load', onFinish);
      wc.on('did-fail-load', onFail);
      wc.loadURL(url).catch((err: unknown) => {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      });
    });
  }

  /** Page.captureScreenshot → base64 PNG. */
  async captureScreenshot(): Promise<string> {
    const { data } = await this.cmd<{ data: string }>('Page.captureScreenshot', {
      format: 'png',
    });
    return data;
  }

  /** Ensure the DOM agent has a document before node-addressed commands.
   *  Shared by click/focus/scroll so each resolves the document once. */
  private async resolveDocument(): Promise<void> {
    await this.cmd('DOM.getDocument', { depth: 0 });
  }

  /**
   * Click an element by CDP backend DOM node id (resolved from an a11y ref by
   * the tools facade): scroll it into view, take its viewport quad, dispatch
   * a left mouse press/release pair at the quad center.
   */
  async click(backendNodeId: number): Promise<void> {
    await this.resolveDocument();
    try {
      await this.cmd('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    } catch {
      // Non-scrollable/odd layouts: fall through — getContentQuads decides.
    }
    const { quads } = await this.cmd<{ quads: number[][] }>('DOM.getContentQuads', {
      backendNodeId,
    });
    const quad = quads?.[0];
    if (!quad || quad.length < 8) {
      throw new Error(
        'element has no visible geometry (hidden or detached) — re-read the page and use a fresh ref',
      );
    }
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    // The `buttons` bitmask (1 = left held) is required alongside button/
    // clickCount: without it Chrome dispatches mousedown/mouseup but never
    // synthesizes the `click` that fires a <button>/<input type=submit>'s
    // default action (form submit). move(buttons:0) → press(buttons:1) →
    // release(buttons:1) mirrors a real left click.
    await this.cmd('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y, button: 'none', buttons: 0,
    });
    await this.cmd('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    });
    await this.cmd('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 1, clickCount: 1,
    });
  }

  /**
   * Refuse a native HTML <select>: resolve its tag via DOM.describeNode and, if
   * it's a SELECT, throw KEYBOARD_DROPDOWN_GUIDANCE BEFORE any click. A native
   * <select>'s popup is browser-chrome (no DOM option to click), so the only
   * non-eval path is keyboard. Called by select_option ahead of click() so the
   * agent gets the guidance instead of the generic "no visible geometry" error.
   */
  async refuseNativeSelect(backendNodeId: number): Promise<void> {
    await this.resolveDocument();
    const { node } = await this.cmd<{ node?: { nodeName?: string } }>('DOM.describeNode', {
      backendNodeId,
    });
    const nodeName = String(node?.nodeName ?? '').toUpperCase();
    if (nodeName === 'SELECT') {
      throw new Error(KEYBOARD_DROPDOWN_GUIDANCE);
    }
  }

  /**
   * True iff the node has a non-empty content quad (laid out and clickable).
   * select_option uses this to detect keyboard-only widgets — a select2-style
   * 0×0 hidden <select> wrapper or an off-layout ARIA combobox — and refuse
   * them with KEYBOARD_DROPDOWN_GUIDANCE instead of letting click() throw the
   * generic geometry error. Mirrors click()'s own quad check.
   */
  async hasGeometry(backendNodeId: number): Promise<boolean> {
    await this.resolveDocument();
    try {
      await this.cmd('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    } catch {
      // Non-scrollable/odd layouts: fall through — the quad check decides.
    }
    const { quads } = await this.cmd<{ quads: number[][] }>('DOM.getContentQuads', {
      backendNodeId,
    });
    const quad = quads?.[0];
    return !!quad && quad.length >= 8;
  }

  /**
   * Focus an element by backend DOM node id: resolve the document, scroll it
   * into view, then DOM.focus. A non-focusable node (DOM.focus throws) falls
   * back to a click to place the caret — which surfaces the shared
   * "re-read the page and use a fresh ref" error if the node has no geometry.
   */
  async focus(backendNodeId: number): Promise<void> {
    await this.resolveDocument();
    try {
      await this.cmd('DOM.scrollIntoViewIfNeeded', { backendNodeId });
    } catch {
      // Non-scrollable/odd layouts: fall through — focus/click decides.
    }
    try {
      await this.cmd('DOM.focus', { backendNodeId });
    } catch {
      // Non-focusable element: place the caret with a click instead.
      await this.click(backendNodeId);
    }
  }

  /**
   * Resolve the inner editable for a typed-into ref. The agent's ref often
   * lands on a combobox/searchbox WRAPPER (type=search widgets, DDG Lite,
   * Wikipedia) rather than the actual <input>, so focus + the selectAll clear
   * would target the wrong node and the field appends instead
   * of replacing (A2). Push the backend id to the frontend, querySelector its
   * subtree for the first input/textarea/contenteditable, and return THAT
   * node's backend id. No-op (returns the original id) when the node is already
   * the editable — querySelector matches DESCENDANTS only, so a bare <input>
   * has no inner match — or when anything fails. Named CDP only, eval-free.
   */
  private async resolveEditable(backendNodeId: number): Promise<number> {
    try {
      await this.resolveDocument();
      const { nodeIds } = await this.cmd<{ nodeIds?: number[] }>(
        'DOM.pushNodesByBackendIdsToFrontend',
        { backendNodeIds: [backendNodeId] },
      );
      const nodeId = nodeIds?.[0];
      if (!nodeId) {
        this.activeTrace?.note('resolveEditable', {
          branch: 'no-frontend-nodeId',
          descended: false,
          resolved: backendNodeId,
        });
        return backendNodeId;
      }
      const { nodeId: innerNodeId } = await this.cmd<{ nodeId?: number }>('DOM.querySelector', {
        nodeId,
        selector: 'input, textarea, [contenteditable]',
      });
      if (!innerNodeId) {
        this.activeTrace?.note('resolveEditable', {
          branch: 'no-inner-match',
          frontendNodeId: nodeId,
          descended: false,
          resolved: backendNodeId,
        });
        return backendNodeId;
      }
      const { node } = await this.cmd<{ node?: { backendNodeId?: number } }>('DOM.describeNode', {
        nodeId: innerNodeId,
      });
      const resolved = node?.backendNodeId ?? backendNodeId;
      this.activeTrace?.note('resolveEditable', {
        branch: 'descended',
        frontendNodeId: nodeId,
        innerNodeId,
        descended: resolved !== backendNodeId,
        resolved,
      });
      return resolved;
    } catch (err) {
      this.activeTrace?.note('resolveEditable', {
        branch: 'caught',
        descended: false,
        resolved: backendNodeId,
        error: errToString(err),
      });
      return backendNodeId;
    }
  }

  /**
   * Type into the focused element. `opts.replace` clears the field first so
   * insertText replaces rather than appends. Input.insertText commits text
   * IME-style (fires beforeinput/input, no keydown/keyup); if it throws we fall
   * back to per-character `char` events (internal fallback only — never an
   * exposed verb).
   */
  async typeText(backendNodeId: number, text: string, opts: { replace: boolean }): Promise<void> {
    // Non-replace path is unchanged and untraced (Phase-1 instruments only the
    // replace path + pressKey): focus the ref and commit.
    if (!opts.replace) {
      await this.focus(backendNodeId);
      await this.commitText(text);
      return;
    }
    // Replace path, wrapped in the Phase-1 trace scope so resolveEditable /
    // focus / the selectAll clear / insertText round-trip is
    // captured. withTrace is a pure no-op (just runs the body) when tracing is
    // OFF — identical CDP calls in identical order, so unit assertions hold.
    return this.withTrace('type', backendNodeId, async () => {
      this.activeTrace?.note('type:begin', { textLength: text.length, replace: true });
      // M10 gap: the active/focused element is NOT captured. No eval-free named
      // CDP method exposes document.activeElement (DOM.* offers no focus
      // pointer; Accessibility.getFullAXTree would need a heavy full-tree walk
      // for a `focused` flag). Per the brief we log the gap rather than add eval.
      this.activeTrace?.note('focusedElement:gap', {
        reason: 'document.activeElement not readable eval-free within M10; not captured',
      });
      // On replace, descend to the inner editable FIRST so focus and the clear
      // target the actual <input> rather than a combobox/search wrapper (A2).
      // No-op when the ref is already the editable.
      const target = await this.resolveEditable(backendNodeId);
      await this.focus(target);
      // Focus-correct clear, NO eval and NO Backspace key-events. A hidden agent
      // view is never "focused & active", so Input.dispatchKeyEvent EDITING
      // default-actions (selectAll, Backspace/Delete deletion) silently NO-OP —
      // the prior Backspace×N clear deleted nothing while insertText appended, so
      // replace became append (A2, proven by the Phase-2 trace). assertPageFocused
      // (Emulation.setFocusEmulationEnabled) holds the page focused+active so the
      // `selectAll` editor command's default-action fires; it selects the field's
      // entire value, then Input.insertText REPLACES that selection in one commit.
      // dispatchKey (not pressKey) issues the selectAll edge directly because we
      // have already asserted focus and own the active trace scope.
      await this.assertPageFocused();
      this.activeTrace?.note('clear:plan', { target, strategy: 'selectAll+insertText' });
      await this.dispatchKey(SELECT_ALL);
      await this.commitText(text);
    });
  }

  /**
   * Commit `text` into the focused editable. Input.insertText commits IME-style
   * (fires beforeinput/input, no keydown/keyup); if it throws we fall back to
   * per-character `char` events (internal fallback only — never an exposed
   * verb). Shared by the replace and non-replace typeText paths so both emit the
   * exact same CDP sequence. The fallback note only fires under an active trace.
   */
  private async commitText(text: string): Promise<void> {
    try {
      await this.cmd('Input.insertText', { text });
    } catch (err) {
      this.activeTrace?.note('insertText:fallback', { error: errToString(err), chars: text.length });
      for (const ch of text) {
        await this.cmd('Input.dispatchKeyEvent', { type: 'char', text: ch });
      }
    }
  }

  /**
   * Dispatch a key on the focused element.
   *
   * A char-PRODUCING key (k.text set: Enter→'\r', Tab→'\t') emits keyDown →
   * keyUp. The keyDown carries BOTH `text` and `unmodifiedText`: Blink
   * synthesizes the DOM `keypress` event — whose default action runs a form's
   * IMPLICIT SUBMIT — from `unmodifiedText`, not `text`. With `unmodifiedText`
   * omitted (the state every prior round shipped) no keypress fires and no form
   * submits; that omission, not a missing `char` event, was the Enter-submit
   * defect (A3). This mirrors Puppeteer's CDP keyboard path exactly — keyDown
   * {text, unmodifiedText} → keyUp, NO separate `char` event — which alone
   * fires the keypress that submits. An explicit `char` is deliberately NOT
   * emitted: for Enter ('\r') in a <textarea>/contenteditable it inserts a
   * stray newline and can double the keypress.
   *   CONTINGENCY (one-line revert, only if a live re-test proves Enter still
   *   does not submit): re-add after the keyDown, before the keyUp —
   *     await this.cmd('Input.dispatchKeyEvent', { type: 'char', text: k.text });
   * A JS `keydown` handler reading `event.key==='Enter'` sees an unchanged
   * keydown (key:'Enter', VK 13), so ARIA-combobox commit (A7) does not regress.
   *
   * A char-LESS key (arrows, Delete, Backspace, End, the selectAll keydown)
   * stays rawKeyDown → keyUp and emits NO char. `commands` (e.g. ['selectAll'])
   * ride the keydown edge. `nativeVirtualKeyCode` mirrors `windowsVirtualKeyCode`
   * on every edge. `text`/`unmodifiedText`/`commands` are never put on keyUp.
   */
  /**
   * Hold the (hidden) BrowserView's page "focused & active" so key-event
   * EDITING/SUBMIT default-actions fire. Agent tabs are setVisible(false)
   * WebContentsViews with no render/OS input focus; on such a view
   * Input.dispatchKeyEvent's selectAll/Backspace/Delete editor actions and
   * Enter's implicit form submit silently NO-OP (proven by the Phase-2 trace),
   * while frame-level Input.insertText still lands. Emulation.setFocusEmulationEnabled
   * makes the renderer treat the page as focused+active so those default-actions
   * run. It is a standalone CDP command (no Emulation.enable needed), structured
   * payload, no eval (M10). Idempotent and re-asserted per act verb so a
   * cross-renderer navigation that drops the override can't resurrect the bug.
   */
  private async assertPageFocused(): Promise<void> {
    try {
      await this.cmd('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch (err) {
      // Never let a focus-emulation failure abort the verb — worst case is the
      // pre-fix behavior, which the caller's CDP still attempts.
      this.activeTrace?.note('focusEmulation:error', { error: errToString(err) });
    }
  }

  /** Raw keyDown/keyUp dispatch for one key — the wire half of pressKey, with no
   *  focus-emulation assert and no trace scope of its own. typeText's clear calls
   *  this directly (it has already asserted focus and owns the trace); pressKey
   *  wraps it with assertPageFocused + a trace scope. */
  private async dispatchKey(k: CdpKey): Promise<void> {
    const common = {
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.windowsVirtualKeyCode,
      nativeVirtualKeyCode: k.windowsVirtualKeyCode,
      ...(k.modifiers ? { modifiers: k.modifiers } : {}),
    };
    if (k.text) {
      await this.cmd('Input.dispatchKeyEvent', {
        type: 'keyDown',
        ...common,
        ...(k.commands ? { commands: k.commands } : {}),
        text: k.text,
        unmodifiedText: k.text,
      });
      await this.cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
      return;
    }
    await this.cmd('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      ...common,
      ...(k.commands ? { commands: k.commands } : {}),
    });
    await this.cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  }

  async pressKey(k: CdpKey): Promise<void> {
    // Trace scope so a STANDALONE press_key (the verb under investigation, A3)
    // logs its keyDown/keyUp round-trips. When pressKey runs INSIDE typeText's
    // clear loop, withTrace sees the outer trace already active and just runs
    // the body — the cmd() calls below then log to that outer typeText trace.
    // The Input.dispatchKeyEvent params cmd() records already carry the full
    // payload the brief asks for (type, key, text, unmodifiedText, commands).
    return this.withTrace('press_key', undefined, async () => {
      // A3 fix: Enter's keypress→implicit-submit is a default-action gated on the
      // page being focused+active, which a hidden agent view is not. Assert focus
      // emulation BEFORE the dispatch so Enter actually submits the owning form.
      await this.assertPageFocused();
      await this.dispatchKey(k);
    });
  }

  /** Bring an element into view by backend DOM node id (no click). */
  async scrollIntoView(backendNodeId: number): Promise<void> {
    await this.resolveDocument();
    await this.cmd('DOM.scrollIntoViewIfNeeded', { backendNodeId });
  }

  /** Scroll the viewport by a pixel delta (positive dy scrolls down). Anchored
   *  at a safe in-viewport point. */
  async scrollByDelta(dy: number): Promise<void> {
    await this.cmd('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: 10, y: 10, deltaX: 0, deltaY: dy,
    });
  }

  /**
   * Visible page text, captured in a private isolated world and capped both
   * in-page (so an oversized string never crosses the CDP boundary) and here.
   * M10: this fixed script is the ONLY JavaScript this driver ever executes.
   */
  async getText(): Promise<string> {
    this.ensure(); // M9 gate applies to reads too, even though this is not a CDP command
    const result: unknown = await this.wc.executeJavaScriptInIsolatedWorld(
      ISOLATED_WORLD_ID,
      [
        {
          code: `(() => {
            const t = document.body ? document.body.innerText : '';
            return t.length > ${MAX_TEXT_CHARS}
              ? t.slice(0, ${MAX_TEXT_CHARS}) + '\\n…[page text truncated at ${MAX_TEXT_CHARS} chars]'
              : t;
          })()`,
        },
      ],
    );
    return typeof result === 'string' ? result : '';
  }

  /** Raw AX tree for a11y-snapshot.ts to format. */
  async getFullAXTree(): Promise<RawAXNode[]> {
    const { nodes } = await this.cmd<{ nodes: RawAXNode[] }>('Accessibility.getFullAXTree');
    return nodes;
  }
}
