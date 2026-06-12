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
// fed agent-supplied code.

import type { WebContents } from 'electron';
import type { RawAXNode } from './a11y-snapshot';

/** Cap on getText output so a pathological page can't flood the agent. */
export const MAX_TEXT_CHARS = 100_000;

/** Private isolated world for the getText capture — never the page's main
 *  world, so page JS cannot tamper with the captured value or observe us. */
const ISOLATED_WORLD_ID = 1999;

export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

export class CdpDriver {
  private dbg: Electron.Debugger | null = null;
  private domainsReady = false;

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
    return (await dbg.sendCommand(method, params)) as T;
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

  /**
   * Click an element by CDP backend DOM node id (resolved from an a11y ref by
   * the tools facade): scroll it into view, take its viewport quad, dispatch
   * a left mouse press/release pair at the quad center.
   */
  async click(backendNodeId: number): Promise<void> {
    // Ensure the DOM agent has a document before node-addressed commands.
    await this.cmd('DOM.getDocument', { depth: 0 });
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
    await this.cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cmd('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1,
    });
    await this.cmd('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
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
