// WP1-A acceptance tests (plans/embedded-browser-implementation-tasks.md) —
// pure decision functions only, NO Electron objects (testing ground rule).
// Maps to safety-spec §5 acceptance tests #7 and #8 (decision halves); the
// Electron-glue halves are verified at human gate G1.
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/browser/browser-decisions.test.js

import assert from 'node:assert/strict';
import {
  buildChromeUA,
  buildBrowserWebPreferences,
  decideLoopbackBlock,
  decideNavigation,
  mayAttachDebugger,
  uaForUrl,
  type BrowserViewKind,
  type ControlPorts,
} from './browser-decisions';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

// ── buildChromeUA ───────────────────────────────────────────────────────────

test('buildChromeUA: byte-exact Chrome-stable shape (537.36 exactly)', () => {
  const ua = buildChromeUA('146.0.7106.0');
  assert.match(
    ua,
    /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/,
  );
  assert.equal(
    ua,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
  );
});

test('buildChromeUA: only the major version is carried (no Electron token)', () => {
  const ua = buildChromeUA('123.4.5678.90');
  assert.ok(ua.includes('Chrome/123.0.0.0'));
  assert.ok(!/electron/i.test(ua));
  assert.ok(!ua.includes('123.4'));
});

// ── uaForUrl (G1 fail ladder round 2 — Ferdium per-site tactic) ─────────────

test('uaForUrl: version-stripped UA on https accounts.google.com (bare Chrome token)', () => {
  const ua = uaForUrl('https://accounts.google.com/v3/signin/identifier', '146.0.7680.216');
  assert.equal(
    ua,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36',
  );
  // No version digits anywhere near the Chrome token.
  assert.ok(ua.includes(' Chrome Safari/537.36'));
  assert.ok(!/Chrome\/\d/.test(ua));
  // Host match is case-insensitive (URL hostnames normalize, belt-and-braces).
  assert.equal(uaForUrl('https://ACCOUNTS.GOOGLE.COM/signin', '146.0.7680.216'), ua);
});

test('uaForUrl: full Chrome UA everywhere else (restore on navigation away)', () => {
  const full = buildChromeUA('146.0.7680.216');
  assert.equal(uaForUrl('https://mail.google.com/mail/u/0/', '146.0.7680.216'), full);
  assert.equal(uaForUrl('https://www.google.com/', '146.0.7680.216'), full);
  assert.equal(uaForUrl('https://example.com/', '146.0.7680.216'), full);
  // Lookalike / suffix hosts are NOT the sign-in front door.
  assert.equal(uaForUrl('https://accounts.google.com.evil.example/', '146.0.7680.216'), full);
  assert.equal(uaForUrl('https://myaccounts.google.com/', '146.0.7680.216'), full);
});

test('uaForUrl: https only; unparseable URLs fall through to the full UA', () => {
  const full = buildChromeUA('146.0.7680.216');
  assert.equal(uaForUrl('http://accounts.google.com/signin', '146.0.7680.216'), full);
  assert.equal(uaForUrl('not a url', '146.0.7680.216'), full);
  assert.equal(uaForUrl('', '146.0.7680.216'), full);
});

// ── buildBrowserWebPreferences (M3) ─────────────────────────────────────────

test('buildBrowserWebPreferences: every M3 field, per kind', () => {
  for (const kind of ['user', 'agent', 'surface'] as BrowserViewKind[]) {
    const wp = buildBrowserWebPreferences(kind);
    assert.equal(wp.sandbox, true, `${kind}: sandbox`);
    assert.equal(wp.contextIsolation, true, `${kind}: contextIsolation`);
    assert.equal(wp.nodeIntegration, false, `${kind}: nodeIntegration`);
    assert.equal(wp.nodeIntegrationInSubFrames, false, `${kind}: nodeIntegrationInSubFrames`);
    assert.equal(wp.webSecurity, true, `${kind}: webSecurity (never inherit shell's false)`);
    assert.equal(wp.allowRunningInsecureContent, false, `${kind}: allowRunningInsecureContent`);
    assert.equal(wp.webviewTag, false, `${kind}: webviewTag`);
    // No preload for any kind today; WP3-A adds the surface preload as the
    // only exception. user/agent must stay preload-free forever.
    assert.equal(wp.preload, undefined, `${kind}: preload`);
    // Slice-11: hidden background views stay throttled (Chromium default) so an
    // idle/discarded user tab burns no CPU while not the active view.
    assert.equal(wp.backgroundThrottling, true, `${kind}: backgroundThrottling`);
    // Exactly the M3 field set — a typo'd extra key would silently no-op.
    assert.deepEqual(
      Object.keys(wp).sort(),
      [
        'allowRunningInsecureContent', 'backgroundThrottling', 'contextIsolation', 'nodeIntegration',
        'nodeIntegrationInSubFrames', 'preload', 'sandbox', 'webSecurity', 'webviewTag',
      ],
      `${kind}: exact key set`,
    );
  }
});

// ── decideLoopbackBlock (M2) ────────────────────────────────────────────────

// Post-increment API port: the real server EADDRINUSE-bumped 24678 → 24679
// and the manager passes the ACTUAL bound port, so the filter sees 24679.
const PORTS: ControlPorts = { apiPort: 24679, wsPort: 4545, jupyterBase: 18888, jupyterRetries: 50 };

test('decideLoopbackBlock: blocks the actual (post-increment) API port on loopback', () => {
  assert.equal(decideLoopbackBlock('http://127.0.0.1:24679/api/agents', PORTS), true);
  assert.equal(decideLoopbackBlock('http://localhost:24679/api/agents', PORTS), true);
  assert.equal(decideLoopbackBlock('https://127.0.0.1:24679/', PORTS), true);
  // The default port is NOT blocked when it is not the bound port — the
  // filter tracks reality, not the constant.
  assert.equal(decideLoopbackBlock('http://127.0.0.1:24678/api/agents', PORTS), false);
});

test('decideLoopbackBlock: blocks the WS control port incl. ws:// scheme', () => {
  assert.equal(decideLoopbackBlock('ws://127.0.0.1:4545/', PORTS), true);
  assert.equal(decideLoopbackBlock('http://localhost:4545/', PORTS), true);
});

test('decideLoopbackBlock: blocks the whole Jupyter port range', () => {
  assert.equal(decideLoopbackBlock('http://127.0.0.1:18888/', PORTS), true);   // base
  assert.equal(decideLoopbackBlock('http://127.0.0.1:18913/', PORTS), true);   // mid
  assert.equal(decideLoopbackBlock('http://127.0.0.1:18938/', PORTS), true);   // base+retries
  assert.equal(decideLoopbackBlock('http://127.0.0.1:18939/', PORTS), false);  // one past
  assert.equal(decideLoopbackBlock('http://127.0.0.1:18887/', PORTS), false);  // one before
});

test('decideLoopbackBlock: covers every loopback host spelling', () => {
  for (const host of ['127.0.0.1', 'localhost', '0.0.0.0', '[::1]', '127.0.0.5', 'foo.localhost']) {
    assert.equal(decideLoopbackBlock(`http://${host}:24679/x`, PORTS), true, host);
  }
});

test('decideLoopbackBlock: allows the :8080 gws OAuth loopback exception', () => {
  assert.equal(decideLoopbackBlock('http://127.0.0.1:8080/callback', PORTS), false);
  assert.equal(decideLoopbackBlock('http://localhost:8080/callback', PORTS), false);
});

test('decideLoopbackBlock: allows ordinary web traffic', () => {
  assert.equal(decideLoopbackBlock('https://example.com/', PORTS), false);
  assert.equal(decideLoopbackBlock('https://accounts.google.com/signin', PORTS), false);
  // Control-port number on a NON-loopback host is someone else's port.
  assert.equal(decideLoopbackBlock('https://example.com:4545/', PORTS), false);
  assert.equal(decideLoopbackBlock('https://example.com:24679/', PORTS), false);
  // Loopback on a non-control port (dev servers etc.) is not this filter's job.
  assert.equal(decideLoopbackBlock('http://127.0.0.1:9999/', PORTS), false);
  // No explicit port → default 80/443, never a control port.
  assert.equal(decideLoopbackBlock('http://localhost/', PORTS), false);
  // Unparseable falls through to allow (Chromium only hands the filter real URLs).
  assert.equal(decideLoopbackBlock('not a url', PORTS), false);
});

// ── decideNavigation (M6) ───────────────────────────────────────────────────

const DENIED_URLS = [
  'file:///C:/Users/turke/.ssh/id_rsa',
  'media://file/C%3A%2Fsecrets.png',
  // eslint-disable-next-line no-script-url
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'blob:https://example.com/uuid',
  'chrome://settings',
  'devtools://devtools/bundled/inspector.html',
  'view-source:https://example.com',
];

test('decideNavigation: denies every dangerous scheme on user + agent tabs', () => {
  for (const kind of ['user', 'agent'] as BrowserViewKind[]) {
    for (const url of DENIED_URLS) {
      const d = decideNavigation(url, kind);
      assert.equal(d.allow, false, `${kind} should deny ${url}`);
      assert.ok(d.reason, `${kind} deny carries a reason for ${url}`);
    }
    // Deny-by-default: schemes not on any list are denied too.
    assert.equal(decideNavigation('about:blank', kind).allow, false);
    assert.equal(decideNavigation('ftp://example.com/x', kind).allow, false);
    assert.equal(decideNavigation('surface://host/index.html', kind).allow, false);
    assert.equal(decideNavigation('%%%not-a-url', kind).allow, false);
  }
});

test('decideNavigation: allows http/https on user + agent tabs', () => {
  for (const kind of ['user', 'agent'] as BrowserViewKind[]) {
    assert.equal(decideNavigation('https://example.com/', kind).allow, true);
    assert.equal(decideNavigation('http://example.com/', kind).allow, true);
  }
});

test('decideNavigation: surface kind navigates only within surface://', () => {
  assert.equal(decideNavigation('surface://host/index.html', 'surface').allow, true);
  assert.equal(decideNavigation('https://example.com/', 'surface').allow, false);
  for (const url of DENIED_URLS) {
    assert.equal(decideNavigation(url, 'surface').allow, false, `surface should deny ${url}`);
  }
});

// ── mayAttachDebugger (M9) ──────────────────────────────────────────────────

test("mayAttachDebugger: only 'persist:agent', everything else refused", () => {
  assert.equal(mayAttachDebugger('persist:agent'), true);
  assert.equal(mayAttachDebugger('persist:user'), false);
  assert.equal(mayAttachDebugger('persist:surface'), false);
  assert.equal(mayAttachDebugger(''), false);
  assert.equal(mayAttachDebugger('agent'), false); // short form is not a partition
});

// ── Run ─────────────────────────────────────────────────────────────────────

let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${t.name}`);
    console.error(err instanceof Error ? err.stack : String(err));
  }
}
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} browser-decisions tests passed`);
