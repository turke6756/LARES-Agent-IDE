// WP1-A task 5 (plans/embedded-browser-implementation-tasks.md) — IPC
// surface for the embedded browser pane. Implements the FROZEN WP1 contract
// (channel names + payload shapes in src/shared/browser.ts; renderer side is
// WP1-B's window.api.browser). Registered from index.ts with one call —
// deliberately kept OUT of ipc-handlers.ts to avoid file contention.

import { ipcMain } from 'electron';
import type { BrowserManager } from './browser-manager';
import {
  BROWSER_CHANNELS,
  type BrowserBounds,
  type BrowserCreateTabOptions,
} from '../../shared/browser';

export function registerBrowserIpc(manager: BrowserManager): void {
  ipcMain.handle(BROWSER_CHANNELS.createTab, (_e, opts: BrowserCreateTabOptions) =>
    manager.createTab(opts),
  );
  ipcMain.handle(BROWSER_CHANNELS.closeTab, (_e, tabId: string) => manager.closeTab(tabId));
  ipcMain.handle(BROWSER_CHANNELS.navigate, (_e, tabId: string, url: string) =>
    manager.navigate(tabId, url),
  );
  ipcMain.handle(BROWSER_CHANNELS.goBack, (_e, tabId: string) => manager.goBack(tabId));
  ipcMain.handle(BROWSER_CHANNELS.goForward, (_e, tabId: string) => manager.goForward(tabId));
  ipcMain.handle(BROWSER_CHANNELS.reload, (_e, tabId: string) => manager.reload(tabId));
  ipcMain.handle(BROWSER_CHANNELS.stop, (_e, tabId: string) => manager.stop(tabId));
  ipcMain.handle(BROWSER_CHANNELS.setActiveTab, (_e, tabId: string | null) =>
    manager.setActiveTab(tabId),
  );
  ipcMain.handle(BROWSER_CHANNELS.setBounds, (_e, bounds: BrowserBounds) =>
    manager.setBounds(bounds),
  );
  ipcMain.handle(BROWSER_CHANNELS.setVisible, (_e, visible: boolean) =>
    manager.setVisible(visible),
  );
}
