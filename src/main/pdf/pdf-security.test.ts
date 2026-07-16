// pdf-security policy tests (plan Part 1.11). Pure node:assert:
//   npm run build:main
//   node dist/main/main/pdf/pdf-security.test.js
//
// Covers: the exact-confined-initial-URL rule; denial of foreign media:// and
// file:/javascript:/data:/blob:/chrome:/chrome-extension:/about: navigation;
// popup denial; the gesture-gated external-link handoff; the pinned PDFium
// artifact metadata; and the malformed/oversized document-size guard.
import assert from 'assert';
import {
  PDFIUM_ARTIFACT,
  MAX_PDF_DOCUMENT_BYTES,
  assertPdfDocumentSize,
  buildConfinedPdfUrl,
  evaluatePdfNavigation,
  isAllowedInitialUrl,
  isDocumentSizeAllowed,
  shouldDenyPdfPopup,
} from './pdf-security';

type Test = { name: string; run: () => void };
const tests: Test[] = [];
function test(name: string, run: () => void): void { tests.push({ name, run }); }

const WORKSPACE_PDF = 'C:\\ws\\docs\\paper.pdf';
const EXPECTED = buildConfinedPdfUrl(WORKSPACE_PDF);

test('the exact confined initial URL is allowed; a sibling is not', () => {
  assert.equal(isAllowedInitialUrl(EXPECTED, EXPECTED), true);
  const other = buildConfinedPdfUrl('C:\\ws\\docs\\other.pdf');
  assert.equal(isAllowedInitialUrl(other, EXPECTED), false);
});

test('a prefix of the expected URL does not pass (no normalization slack)', () => {
  assert.equal(isAllowedInitialUrl(EXPECTED + '/..%2Fsecret', EXPECTED), false);
  assert.equal(isAllowedInitialUrl('', EXPECTED), false);
});

test('evaluatePdfNavigation allows exactly the initial URL', () => {
  assert.deepEqual(evaluatePdfNavigation(EXPECTED, { expectedInitialUrl: EXPECTED }), { action: 'allow' });
});

test('any OTHER media:// path is denied', () => {
  const foreign = buildConfinedPdfUrl('C:\\ws\\..\\etc\\passwd');
  const d = evaluatePdfNavigation(foreign, { expectedInitialUrl: EXPECTED });
  assert.equal(d.action, 'deny');
});

test('dangerous schemes are denied', () => {
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'blob:media://x',
    'chrome://settings',
    'chrome-extension://abc/evil.html',
    'about:blank',
    'devtools://devtools/bundled/x.html',
  ]) {
    const d = evaluatePdfNavigation(url, { expectedInitialUrl: EXPECTED });
    assert.equal(d.action, 'deny', `${url} should be denied`);
  }
});

test('an unparseable URL is denied', () => {
  const d = evaluatePdfNavigation('not a url', { expectedInitialUrl: EXPECTED });
  assert.equal(d.action, 'deny');
});

test('external http(s) requires a user gesture, then routes externally', () => {
  const noGesture = evaluatePdfNavigation('https://example.com/a', { expectedInitialUrl: EXPECTED });
  assert.equal(noGesture.action, 'deny');

  const withGesture = evaluatePdfNavigation('https://example.com/a', {
    expectedInitialUrl: EXPECTED,
    userGesture: true,
  });
  assert.deepEqual(withGesture, { action: 'external', url: 'https://example.com/a' });
});

test('popups are always denied', () => {
  assert.equal(shouldDenyPdfPopup(), true);
});

test('the PDFium artifact is pinned with license + checksum fields', () => {
  assert.equal(PDFIUM_ARTIFACT.dependency, '@hyzyla/pdfium');
  assert.equal(PDFIUM_ARTIFACT.version, '2.1.13');
  assert.equal(PDFIUM_ARTIFACT.wrapperLicense, 'MIT');
  assert.equal(PDFIUM_ARTIFACT.coreLicense, 'BSD-3-Clause');
  assert.equal(typeof PDFIUM_ARTIFACT.sha256, 'string');
  assert.ok(PDFIUM_ARTIFACT.sha256.length > 0);
});

test('document-size guard rejects malformed and oversized sizes', () => {
  assert.equal(isDocumentSizeAllowed(1024), true);
  assert.equal(isDocumentSizeAllowed(0), true);
  assert.equal(isDocumentSizeAllowed(MAX_PDF_DOCUMENT_BYTES), true);
  assert.equal(isDocumentSizeAllowed(MAX_PDF_DOCUMENT_BYTES + 1), false);
  assert.equal(isDocumentSizeAllowed(-1), false);
  assert.equal(isDocumentSizeAllowed(Number.NaN), false);
  assert.equal(isDocumentSizeAllowed(Number.POSITIVE_INFINITY), false);
  assert.equal(isDocumentSizeAllowed(3.5), false);
  assert.throws(() => assertPdfDocumentSize(MAX_PDF_DOCUMENT_BYTES + 1));
  assert.throws(() => assertPdfDocumentSize(Number.NaN));
  assert.doesNotThrow(() => assertPdfDocumentSize(2048));
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      t.run();
      console.log(`  ✓ ${t.name}`);
    } catch (error) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} pdf-security test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} pdf-security tests passed`);
})();
