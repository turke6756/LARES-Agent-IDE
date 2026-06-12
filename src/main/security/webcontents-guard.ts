// WP0.3 (plans/embedded-browser-implementation-tasks.md) — M4 seam.
//
// The global web-contents-created guard in index.ts needs to distinguish
// "a view some manager deliberately created" from "an unknown webContents
// appearing in this process". No browser manager exists yet (WP1-A), so the
// default predicate is `() => false`: every non-shell contents is unknown
// until a manager registers itself via setManagedWebContentsCheck.
//
// WP1-A's browser-manager.ts calls
//   setManagedWebContentsCheck(wc => this.isManaged(wc))
// at construction; WP3-A's surface views register through the same manager
// and are covered automatically. Electron import is type-only so this module
// stays loadable under the plain-node test runner.

import type { WebContents } from 'electron';

type ManagedCheck = (wc: WebContents) => boolean;

let isManagedWebContents: ManagedCheck = () => false; // no manager exists yet

export function setManagedWebContentsCheck(fn: ManagedCheck): void {
  isManagedWebContents = fn;
}

export function checkManagedWebContents(wc: WebContents): boolean {
  return isManagedWebContents(wc);
}
