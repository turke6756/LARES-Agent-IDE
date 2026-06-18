// WP1-A task 3 (plans/embedded-browser-implementation-tasks.md) — PURE
// policy/options module for the embedded browser pane. This is the unit-test
// surface for mitigations M2 / M3 / M6 / M9 and the UA shape
// (plans/embedded-browser-safety-deepdive.md §3).
//
// HARD RULE: no Electron imports (not even type-only). The compiled-node test
// runner (test:supervisor pattern) loads this module under plain node; the
// thin Electron glue that applies these decisions lives in browser-manager.ts
// and is verified at human gates.

/** View kinds. 'surface' is the Phase-3 planning surface (WP3-A extends). */
export type BrowserViewKind = 'user' | 'agent' | 'surface';

// ── UA (Ferdium lesson: Google sign-in gates on the exact byte shape) ───────

/**
 * Chrome-stable UA derived from the real engine version so it can never
 * drift from the Chromium that actually runs. Byte-exact shape:
 * `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like
 * Gecko) Chrome/<major>.0.0.0 Safari/537.36` — `537.36` exactly, and the
 * Chrome token zeroes the minor/build/patch components like real Chrome does.
 */
export function buildChromeUA(chromeVersion: string): string {
  const major = chromeVersion.split('.')[0];
  return (
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
  );
}

// ── Client hints + Google sign-in UA (G1 fail ladder, rounds 1+2) ──────────
//
// G1 FAILED 2026-06-11 (round 1): real Google sign-in on persist:user hit
// "This browser or app may not be secure" even with a byte-exact Chrome UA
// *string*. Round 1 responded by forging the full Chrome brand list
// ("Chromium" + "Google Chrome" + grease) into Sec-CH-UA* via a
// session-scoped `webRequest.onBeforeSendHeaders` rewrite.
//
// G1 FAILED AGAIN 2026-06-11 (round 2 trigger): live httpbin verification
// showed round 1's HTTP fingerprint was byte-perfect (UA `Chrome/146.0.0.0`,
// Sec-CH-UA `"Chromium";v="146", "Google Chrome";v="146",
// "Not=A?Brand";v="24"`) and Google STILL blocked — the check is JS-side
// (BotGuard), not header-side. Fresh research against current sources
// (Ferdium 2026, slayzone 2026 Electron-migration notes) established:
//
// - Forging "Google Chrome" into the headers is itself a detectable
//   MISMATCH: `navigator.userAgentData` JS-side still reports the
//   Chromium-only brand list (no non-CDP override exists), and BotGuard
//   cross-checks the two surfaces. Ferdium ships ZERO client-hints handling
//   and works — genuine Chromium hints beat forged Chrome ones. So the
//   round-1 header rewrite is REMOVED; hints now flow unmodified.
// - `navigator.webdriver === true` (Electron's default) is BotGuard's
//   highest-signal tell — fixed globally in index.ts via
//   `disable-blink-features=AutomationControlled`.
// - Ferdium's per-site tactic for accounts.google.com: on `did-navigate`
//   (deliberately NOT will-navigate — a mid-navigation UA swap cancels
//   redirects/POSTs), set the webContents UA to a VERSION-STRIPPED Chrome UA
//   (bare `Chrome` token). See ferdium-app `src/models/UserAgent.ts` L62-90
//   (commit 0a737a98) and their PR #2360. `uaForUrl` below is the pure half;
//   the manager wires it per view.
// - Firefox UA confirmed NON-working (BotGuard detects the Chromium engine
//   regardless) — do not try it.
//
// Still ruled out, unchanged: CDP `Emulation.setUserAgentOverride` (M9
// forbids debugger attach on persist:user); a chrome.runtime/loadTimes
// preload shim (M3 forbids pane preloads without a security review);
// `--disable-features=UserAgentClientHint` (deleted from Blink — verified
// absent at Chromium tag 146.0.7680.216, Electron 41's exact pin).
//
// If round 2 fails, the ladder ends (step 3: halt; pane ships, OAuth moves
// out-of-band to the system browser) — do NOT reach for CDP on persist:user.

/** Hosts that get the version-stripped UA (Ferdium's host test: the Google
 *  sign-in front door only — everything else keeps the full Chrome UA). */
const VERSION_STRIPPED_UA_HOSTS = new Set(['accounts.google.com']);

/**
 * Per-URL UA (Ferdium tactic, round 2): `https://accounts.google.com/...`
 * gets a VERSION-STRIPPED Chrome UA — the `Chrome/<major>.0.0.0` token
 * collapses to bare `Chrome`, which BotGuard accepts where any versioned
 * Electron-shaped UA is blocked. Every other URL (including http:// on the
 * same host, and unparseable strings) gets the normal full UA, so the
 * override self-restores on navigation away. The manager applies this on
 * `did-navigate` per view.
 */
export function uaForUrl(url: string, chromeVersion: string): string {
  const full = buildChromeUA(chromeVersion);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return full;
  }
  if (u.protocol === 'https:' && VERSION_STRIPPED_UA_HOSTS.has(u.hostname.toLowerCase())) {
    return full.replace(/Chrome\/[\d.]+ /, 'Chrome ');
  }
  return full;
}

// ── M3: hardened webPreferences for every pane view ─────────────────────────

/** Structural mirror of the Electron.WebPreferences subset M3 pins down —
 *  declared locally so this module stays Electron-free. The manager spreads
 *  this into `new WebContentsView({ webPreferences })` along with the
 *  partition's session. */
export interface BrowserViewWebPreferences {
  sandbox: boolean;
  contextIsolation: boolean;
  nodeIntegration: boolean;
  nodeIntegrationInSubFrames: boolean;
  webSecurity: boolean;
  allowRunningInsecureContent: boolean;
  webviewTag: boolean;
  preload: string | undefined;
  /** Slice-11: leave Chromium's default hidden-view throttling ON so discarded
   *  / background user tabs burn no CPU while not the active view. */
  backgroundThrottling: boolean;
}

/**
 * Spec-M3 options for a pane view. Every field is set explicitly — the shell
 * window runs `webSecurity:false` / the dashboard preload, and a pane view
 * must NEVER inherit any of that.
 *
 * `preload` is undefined for every kind today. WP3-A later passes the
 * surface-preload path for kind:'surface' (the ONLY allowed exception);
 * 'user' and 'agent' views must stay preload-free forever.
 */
export function buildBrowserWebPreferences(kind: BrowserViewKind): BrowserViewWebPreferences {
  void kind; // kinds diverge in Phase 3 (surface preload); identical today
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,                  // explicit TRUE — never inherit shell's false
    allowRunningInsecureContent: false,
    webviewTag: false,
    preload: undefined,                 // never the dashboard preload
    // Slice-11: explicit (Chromium's default) — hidden background views are
    // throttled so an idle/discarded user tab consumes no CPU while not active.
    backgroundThrottling: true,
  };
}

// ── M2: loopback control-port filter ────────────────────────────────────────

export interface ControlPorts {
  /** ACTUAL bound API port from ApiServer.start() (WP0.1) — survives the
   *  EADDRINUSE auto-increment. Never pass a hardcoded 24678. */
  apiPort: number;
  wsPort: number;
  jupyterBase: number;
  jupyterRetries: number;
}

/** Spec-M2 loopback host list, strengthened (allowed direction only) with
 *  127.0.0.0/8 and `*.localhost`, which resolve to loopback in Chromium. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === '127.0.0.1' || h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '[::1]') {
    return true;
  }
  if (h.endsWith('.localhost')) return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m && m.slice(1).every((o) => Number(o) <= 255)) return true;
  return false;
}

/**
 * M2: should this request from a pane partition be cancelled?
 * Returns true = BLOCK. Blocks loopback requests to the dashboard control
 * plane (API / WS / Jupyter range); `127.0.0.1:8080` stays reachable for the
 * gws OAuth loopback workload (spec §4) — allowlisted precisely, not widened.
 * Unparseable URLs fall through to allow (matching the spec's filter shape;
 * Chromium only hands the filter real URLs).
 */
export function decideLoopbackBlock(url: string, ports: ControlPorts): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!isLoopbackHost(u.hostname)) return false;
  const port = Number(u.port);
  if (!Number.isInteger(port) || port === 0) return false; // default 80/443 — not control ports
  if (port === 8080) return false; // gws OAuth loopback exception
  return (
    port === ports.apiPort ||
    port === ports.wsPort ||
    (port >= ports.jupyterBase && port <= ports.jupyterBase + ports.jupyterRetries)
  );
}

// ── M6: navigation scheme gates ─────────────────────────────────────────────

export interface NavigationDecision {
  allow: boolean;
  reason?: string;
}

/** Allowlist per kind. Deny-by-default: anything not listed is denied, which
 *  covers the spec's explicit deny set (file: media: javascript: data: blob:
 *  chrome: devtools: view-source: …) and everything not yet invented.
 *  Applied to all frames, not just top-level — stricter than the spec
 *  minimum (allowed direction); revisit subframe data:/blob: at G1 if real
 *  sites break. The Phase-3 surface view may only navigate within surface:. */
const ALLOWED_SCHEMES: Record<BrowserViewKind, ReadonlySet<string>> = {
  user: new Set(['http:', 'https:']),
  agent: new Set(['http:', 'https:']),
  surface: new Set(['surface:']),
};

export function decideNavigation(url: string, kind: BrowserViewKind): NavigationDecision {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return { allow: false, reason: `unparseable URL: ${url.slice(0, 100)}` };
  }
  if (ALLOWED_SCHEMES[kind].has(scheme)) return { allow: true };
  return { allow: false, reason: `scheme ${scheme} not allowed for kind '${kind}'` };
}

// ── M9: CDP partition discipline ────────────────────────────────────────────

/**
 * M9 rule: the debugger may only ever attach to `persist:agent` webContents.
 * `persist:user` carries the human's signed-in sessions — automation there is
 * cookie-theft / account-lock territory. The manager's attach helper throws
 * unless this returns true; Phase 2 (WP2-A) builds on the same predicate.
 */
export function mayAttachDebugger(partition: string): boolean {
  return partition === 'persist:agent';
}
