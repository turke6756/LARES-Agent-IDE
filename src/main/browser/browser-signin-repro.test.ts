// BrowserSigninSharing plan §D — sign-in-sharing reproduction (RETIRED).
//
// This file held reproduction (b): importUserSessionForRule upserted the origin
// row to 'active' whenever ANY cookie was copied (including an anonymous `lang`
// preference), asserting a signed-in session that was never verified.
//
// Phase 2 FIXED it — the import path now returns `candidateCookiesCopied` and
// NEVER upserts an active/verified grant from a cookie count (a cookie copy is a
// candidate first step of setup, not proof of sign-in). Mirroring how Phase 1
// retired reproduction (a) into browser-signin-workspace-exact.test.ts, the
// now-green (b) assertion moved onto the full BrowserManager harness at:
//
//   src/main/browser/browser-manager.test.ts
//     → test 'Phase 2 setup-and-verify: (b) an anonymous cookie import copies
//       creds but leaves the origin needs_signin (repro b)' (that file is already
//       chain-registered in package.json `test:supervisor`).
//
// Nothing runs here anymore; this stub is a documented tombstone so the paper
// trail from the red reproduction to the green gate stays discoverable. It is
// intentionally NOT in the `test:supervisor` chain (no tests to run).

export {};
