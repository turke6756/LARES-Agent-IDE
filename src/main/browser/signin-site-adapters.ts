// BrowserSigninSharing plan §D Phase 2 — data-driven sign-in site adapters.
//
// Locked decisions Q4/Q5: the per-site knowledge that drives interactive
// setup-and-verify (which URL to load for visual/auth validation after a cookie
// import, whether a SAFE authenticated probe exists, and which IdP/login
// destinations the human may traverse mid-quarantine) is CONFIG, never
// hardcoded control flow. This module is the config table + pure resolvers; the
// manager (browser-manager.ts) consumes it. An unknown site resolves to
// `undefined` here → the manager falls back to a generic human confirmation
// ("You confirmed this session"), never an automatic "Verified" claim.
//
// PURE + dependency-free (no electron / no db) so it is unit-testable without a
// live Chromium and importable from both the manager and its tests. It stores NO
// cookie material — only hostnames, paths, and origin strings.

export interface SigninSiteAdapter {
  /** Stable id (audit / test identity). */
  id: string;
  /** Registrable-domain suffixes this adapter governs. A hostname matches when
   *  it equals a suffix or ends with `.<suffix>` (subdomain). */
  hostSuffixes: string[];
  /** Path ON THE SERVICE ORIGIN to load in the setup tab after import, useful
   *  for visual/auth validation. Chosen to be an authenticated landing/account
   *  page that redirects to a login wall when logged out — so a logged-out human
   *  is dropped straight onto the real sign-in flow. Same-origin by construction
   *  (the manager prefixes the rule's scheme+hostname), so it never widens the
   *  quarantined open beyond the approved service origin. */
  setupTargetPath: string;
  /** True when this adapter exposes a SAFE authenticated probe. Completion then
   *  REQUIRES the setup tab to be back on the service origin AND not sitting on
   *  a login wall (proving the human reached an authenticated page) before the
   *  grant is marked active — the UI reports "Verified". False → completion is a
   *  human attestation ("You confirmed this session"), never "Verified". */
  hasProbe: boolean;
  /** Extra login-wall path/substring hints (glob or plain substring, NOT regex)
   *  folded into the probe's login-wall test on top of the rule's own
   *  loginUrlPatterns + the global default login paths. Lets the probe reject a
   *  completion that is still parked on this site's specific sign-in surface. */
  loginWallHints: string[];
  /** Known IdP / SSO login-destination ORIGINS the human may traverse while the
   *  tab is quarantined (bounded sign-in redirect policy). This is a traversal
   *  allowlist for the HUMAN's sign-in journey ONLY — it is NEVER written into
   *  the agent visit allowlist, and completing the grant still requires returning
   *  to the service origin. Documentation + a test/assertion surface; the actual
   *  navigation floor is decideNavigation (scheme/SSRF), which already permits
   *  these without granting agent visit permission. */
  loginDestinations: string[];
}

/** Third-party IdP origins common across the job-board adapters — the human may
 *  bounce through these during SSO. Kept separate so every adapter inherits the
 *  same baseline without duplicating the list. Never an agent visit grant. */
export const COMMON_IDP_ORIGINS: readonly string[] = [
  'https://accounts.google.com',
  'https://login.microsoftonline.com',
  'https://login.live.com',
  'https://appleid.apple.com',
];

// The initial job-board scope: LinkedIn, Indeed, Handshake. Each ships an
// authenticated probe (all three redirect a logged-out visitor off the
// authenticated path onto a login wall, so the not-a-login-wall test is a valid
// "the human is actually signed in" proxy).
const ADAPTERS: readonly SigninSiteAdapter[] = [
  {
    id: 'linkedin',
    hostSuffixes: ['linkedin.com'],
    // The member feed 302s to /login (or /checkpoint/...) when logged out.
    setupTargetPath: '/feed/',
    hasProbe: true,
    // NOTE: LinkedIn's guest wall is sometimes a DOM modal served at an otherwise
    // normal URL (no redirect), so these URL-only hints can miss it — URL hints
    // are best-effort, which is exactly why verification reports 'probed' (a
    // best-effort proxy) rather than a hard 'confirmed'/'Verified automatically'.
    loginWallHints: ['/login', '/checkpoint', '/uas/login', '/authwall'],
    loginDestinations: [...COMMON_IDP_ORIGINS],
  },
  {
    id: 'indeed',
    hostSuffixes: ['indeed.com'],
    // The job-seeker account page bounces to secure.indeed.com sign-in when out.
    setupTargetPath: '/account/view',
    hasProbe: true,
    loginWallHints: ['secure.indeed.com', '/account/login', '/auth'],
    loginDestinations: [...COMMON_IDP_ORIGINS, 'https://secure.indeed.com'],
  },
  {
    id: 'handshake',
    hostSuffixes: ['joinhandshake.com'],
    // The Handshake home/dashboard requires a session; logged-out visitors are
    // sent through the school SSO picker (USF → sso.usf.edu / Microsoft).
    setupTargetPath: '/stu',
    hasProbe: true,
    // The real Handshake wall 302s to /access?access_state_id=<token> — without
    // '/access' here a setup tab parked on that wall would falsely pass the
    // not-a-login-wall probe and verify a logged-out session.
    loginWallHints: ['/login', '/auth', '/access', '/schools', '/saml'],
    loginDestinations: [
      ...COMMON_IDP_ORIGINS,
      'https://sso.usf.edu',
      'https://login.microsoftonline.com',
    ],
  },
];

/** Extract a lowercased, trailing-dot-stripped hostname from a full URL or a
 *  bare hostname string. Returns '' when unparseable. */
function hostnameOf(urlOrHostname: string): string {
  if (!urlOrHostname) return '';
  let host = urlOrHostname;
  if (urlOrHostname.includes('://')) {
    try {
      host = new URL(urlOrHostname).hostname;
    } catch {
      return '';
    }
  }
  return host.replace(/\.$/, '').toLowerCase();
}

/** True when `host` equals `suffix` or is a subdomain of it. */
function hostMatchesSuffix(host: string, suffix: string): boolean {
  const s = suffix.replace(/\.$/, '').toLowerCase();
  return host === s || host.endsWith(`.${s}`);
}

/** Resolve the governing sign-in site adapter for a URL or bare hostname, or
 *  `undefined` for an unknown site (→ generic human-confirmation fallback). */
export function resolveSigninAdapter(urlOrHostname: string): SigninSiteAdapter | undefined {
  const host = hostnameOf(urlOrHostname);
  if (!host) return undefined;
  return ADAPTERS.find((a) => a.hostSuffixes.some((suf) => hostMatchesSuffix(host, suf)));
}

/** True when `url`'s origin is one of the adapter's known login/IdP destinations
 *  — i.e. an origin the human may legitimately traverse mid-quarantine on the
 *  way through SSO. Purely informational: it NEVER confers agent visit
 *  permission. Used by the bounded-redirect tests + audit reasoning. */
export function isKnownLoginDestination(url: string, adapter: SigninSiteAdapter): boolean {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return adapter.loginDestinations.includes(origin);
}

/** The full list of adapters (read-only) — exposed for tests / diagnostics. */
export function listSigninAdapters(): readonly SigninSiteAdapter[] {
  return ADAPTERS;
}
