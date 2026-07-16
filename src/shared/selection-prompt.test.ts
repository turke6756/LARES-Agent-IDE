// selection-prompt tests — the shared [SELECTION COMMENT] builder, focused on
// the PDF page-context extension (plan Part 1.7). Pure node:assert:
//   npm run build:main
//   node dist/main/shared/selection-prompt.test.js
//
// Covers: single-page, multi-page, page-label, coordinate-only, and the
// mixed text/PDF-in-one-send rejection. Text-only behavior is already covered
// by selection-comments-send.test.ts; these cases lock the new PDF forms.

import assert from 'node:assert/strict';
import { buildQuotedPrompt, type QuoteItem, type QuotedPromptSource } from './selection-prompt';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error('       ', err instanceof Error ? err.stack || err.message : err);
    failed++;
  }
}

const FILE: QuotedPromptSource = { targetType: 'file', sourceLabel: 'C:\\p\\s41467.pdf' };

test('single-page PDF comment: header Page line, one-based, collapsed body', () => {
  const items: QuoteItem[] = [{ quote: 'photosynthetic yield', pageIndex: 2 }];
  assert.equal(
    buildQuotedPrompt(FILE, items),
    '[SELECTION COMMENT]\nSource: file C:\\p\\s41467.pdf\nPage: 3\n\n> photosynthetic yield',
  );
});

test('single-page PDF comment with a body: Page header + numbered quote', () => {
  const items: QuoteItem[] = [{ quote: 'photosynthetic yield', comment: 'define this', pageIndex: 2 }];
  assert.equal(
    buildQuotedPrompt(FILE, items),
    '[SELECTION COMMENT]\n' +
    'Source: file C:\\p\\s41467.pdf\n' +
    'Page: 3\n' +
    '\n' +
    '1) > photosynthetic yield\n' +
    '   Comment: define this',
  );
});

test('multi-page PDF send: per-quote Anchor lines, no header Page', () => {
  const items: QuoteItem[] = [
    { quote: 'first', comment: 'a', pageIndex: 2 },
    { quote: 'second', comment: 'b', pageIndex: 6 },
  ];
  assert.equal(
    buildQuotedPrompt(FILE, items),
    '[SELECTION COMMENT]\n' +
    'Source: file C:\\p\\s41467.pdf\n' +
    '\n' +
    '1) > first\n' +
    '   Anchor: page 3\n' +
    '   Comment: a\n' +
    '\n' +
    '2) > second\n' +
    '   Anchor: page 7\n' +
    '   Comment: b',
  );
});

test('page label rendered only when it differs from the number', () => {
  const differs: QuoteItem[] = [{ quote: 'front matter', pageIndex: 3, pageLabel: 'iv' }];
  assert.match(buildQuotedPrompt(FILE, differs), /Page: 4 \(labeled "iv"\)/);

  const same: QuoteItem[] = [{ quote: 'body', pageIndex: 2, pageLabel: '3' }];
  const out = buildQuotedPrompt(FILE, same);
  assert.match(out, /Page: 3\n/);
  assert.ok(!out.includes('labeled'), 'no label when it matches the number');
});

test('coordinate-only region note: synthetic marker + Region line, no blockquote', () => {
  const items: QuoteItem[] = [{
    quote: '[Area on PDF page 3]',
    comment: 'what is this figure?',
    pageIndex: 2,
    region: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
  }];
  assert.equal(
    buildQuotedPrompt(FILE, items),
    '[SELECTION COMMENT]\n' +
    'Source: file C:\\p\\s41467.pdf\n' +
    'Page: 3\n' +
    '\n' +
    '1) [Area on PDF page 3]\n' +
    '   Region: x=0.100 y=0.200 w=0.300 h=0.050 (normalized, unrotated)\n' +
    '   Comment: what is this figure?',
  );
});

test('mixing text and PDF anchors in one send is rejected', () => {
  const mixed: QuoteItem[] = [
    { quote: 'text quote', comment: 'a' },
    { quote: 'pdf quote', comment: 'b', pageIndex: 2 },
  ];
  assert.throws(() => buildQuotedPrompt(FILE, mixed), /cannot mix text and PDF/);
});

test('raw anchor JSON is never emitted', () => {
  const items: QuoteItem[] = [{ quote: 'q', pageIndex: 2, comment: 'c' }];
  const out = buildQuotedPrompt(FILE, items);
  assert.ok(!out.includes('fingerprint') && !out.includes('itemIndex') && !out.includes('version'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
