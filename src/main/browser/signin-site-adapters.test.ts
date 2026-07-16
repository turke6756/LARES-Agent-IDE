// BrowserSigninSharing plan §D Phase 2 — pure unit tests for the data-driven
// sign-in site adapters (LinkedIn / Indeed / Handshake) + the generic fallback.
// No electron / no db — the module is dependency-free.
//
//   npm run build:main
//   node dist/main/main/browser/signin-site-adapters.test.js

import assert from 'node:assert/strict';
import {
  resolveSigninAdapter,
  isKnownLoginDestination,
  listSigninAdapters,
} from './signin-site-adapters';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

test('resolves LinkedIn from a full URL and a bare hostname', () => {
  const a = resolveSigninAdapter('https://www.linkedin.com/feed/');
  assert.equal(a?.id, 'linkedin');
  assert.equal(resolveSigninAdapter('linkedin.com')?.id, 'linkedin');
});

test('resolves Indeed and Handshake by registrable-domain suffix (subdomains too)', () => {
  assert.equal(resolveSigninAdapter('https://secure.indeed.com/account')?.id, 'indeed');
  assert.equal(resolveSigninAdapter('https://app.joinhandshake.com/stu')?.id, 'handshake');
});

test('unknown site → undefined (generic human-confirmation fallback)', () => {
  assert.equal(resolveSigninAdapter('https://example.com/'), undefined);
  assert.equal(resolveSigninAdapter('https://notlinkedin.evil.com/'), undefined);
  assert.equal(resolveSigninAdapter('not a url'), undefined);
});

test('every adapter ships a same-origin-safe setup target path and a probe', () => {
  for (const a of listSigninAdapters()) {
    assert.ok(a.setupTargetPath.startsWith('/'), `${a.id} setupTargetPath must be a path`);
    assert.equal(a.hasProbe, true, `${a.id} must expose a safe probe in the initial scope`);
    assert.ok(a.loginWallHints.length > 0, `${a.id} must carry login-wall hints`);
  }
});

test("Handshake login-wall hints include '/access' (the real wall 302s to /access?access_state_id=…)", () => {
  const hs = resolveSigninAdapter('https://app.joinhandshake.com/')!;
  assert.ok(
    hs.loginWallHints.includes('/access'),
    "handshake must treat '/access' as a login wall so a wall-parked setup tab can't falsely verify",
  );
});

test('Handshake knows USF SSO as a login destination (bounded redirect), NOT a visit grant', () => {
  const hs = resolveSigninAdapter('https://app.joinhandshake.com/')!;
  assert.ok(isKnownLoginDestination('https://sso.usf.edu/idp/profile/SAML2/Redirect/SSO', hs));
  assert.ok(isKnownLoginDestination('https://login.microsoftonline.com/common/oauth2', hs));
  // The service origin itself is not a "login destination" — it's the return target.
  assert.equal(isKnownLoginDestination('https://app.joinhandshake.com/stu', hs), false);
});

(() => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
