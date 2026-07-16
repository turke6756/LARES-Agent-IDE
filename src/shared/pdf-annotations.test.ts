// pdf-annotations tests (plan 1.3) — the durable PDF anchor contract.
// Pure node:assert; compiled by build:main, run under node:
//   npm run build:main
//   node dist/main/shared/pdf-annotations.test.js
//
// Covers: all four rotations; projection at several zooms + offset;
// multi-page ordering; malformed / non-finite / out-of-range JSON;
// serialization round-trips; and the page/rect/byte-size caps.

import assert from 'node:assert/strict';
import {
  MAX_PDF_ANCHOR_JSON_BYTES,
  MAX_PDF_ANCHOR_PAGES,
  MAX_PDF_ANCHOR_RECTS,
  normalizeRotation,
  parsePdfSelectionAnchor,
  projectNormalizedPdfRect,
  rotateNormalizedPdfRect,
  serializePdfSelectionAnchor,
  validatePdfSelectionAnchor,
  type PdfRect,
  type PdfSelectionAnchorV1,
} from './pdf-annotations';

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

function approxRect(a: PdfRect, b: PdfRect, eps = 1e-9): void {
  assert.ok(Math.abs(a.x - b.x) < eps, `x ${a.x} != ${b.x}`);
  assert.ok(Math.abs(a.y - b.y) < eps, `y ${a.y} != ${b.y}`);
  assert.ok(Math.abs(a.width - b.width) < eps, `width ${a.width} != ${b.width}`);
  assert.ok(Math.abs(a.height - b.height) < eps, `height ${a.height} != ${b.height}`);
}

function validAnchor(over: Partial<PdfSelectionAnchorV1> = {}): PdfSelectionAnchorV1 {
  return {
    version: 1,
    fingerprint: 'fp-abc123',
    prefix: 'before the quote',
    suffix: 'after the quote',
    pages: [
      {
        pageIndex: 2,
        pageLabel: '3',
        start: { itemIndex: 4, charOffset: 0 },
        end: { itemIndex: 9, charOffset: 5 },
        rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.05 }],
      },
    ],
    ...over,
  };
}

// ── rotation ────────────────────────────────────────────────────────────────

test('normalizeRotation coerces arbitrary degrees to canonical quarter-turns', () => {
  assert.equal(normalizeRotation(0), 0);
  assert.equal(normalizeRotation(90), 90);
  assert.equal(normalizeRotation(-90), 270);
  assert.equal(normalizeRotation(450), 90);
  assert.equal(normalizeRotation(45), 0, 'non-quarter-turn falls back to 0');
  assert.equal(normalizeRotation(NaN), 0);
});

test('rotateNormalizedPdfRect: 0° is identity', () => {
  const r: PdfRect = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  approxRect(rotateNormalizedPdfRect(r, 0), r);
});

test('rotateNormalizedPdfRect: top-left corner point maps clockwise round the box', () => {
  const tl: PdfRect = { x: 0, y: 0, width: 0, height: 0 };
  approxRect(rotateNormalizedPdfRect(tl, 90), { x: 1, y: 0, width: 0, height: 0 });
  approxRect(rotateNormalizedPdfRect(tl, 180), { x: 1, y: 1, width: 0, height: 0 });
  approxRect(rotateNormalizedPdfRect(tl, 270), { x: 0, y: 1, width: 0, height: 0 });
});

test('rotateNormalizedPdfRect: 90/270 swap width and height', () => {
  const r: PdfRect = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 };
  approxRect(rotateNormalizedPdfRect(r, 90), { x: 1 - 0.25, y: 0.1, width: 0.05, height: 0.3 });
  approxRect(rotateNormalizedPdfRect(r, 270), { x: 0.2, y: 1 - 0.4, width: 0.05, height: 0.3 });
});

test('rotateNormalizedPdfRect: 180 flips both axes, keeps size', () => {
  const r: PdfRect = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 };
  approxRect(rotateNormalizedPdfRect(r, 180), { x: 1 - 0.4, y: 1 - 0.25, width: 0.3, height: 0.05 });
});

test('rotation is a full cycle: four 90° turns return the original', () => {
  let r: PdfRect = { x: 0.15, y: 0.25, width: 0.2, height: 0.1 };
  const start = { ...r };
  for (let i = 0; i < 4; i++) r = rotateNormalizedPdfRect(r, 90);
  approxRect(r, start);
});

// ── projection ────────────────────────────────────────────────────────────

test('projectNormalizedPdfRect scales at several zooms', () => {
  const r: PdfRect = { x: 0.25, y: 0.5, width: 0.5, height: 0.25 };
  for (const [w, h] of [[600, 800], [1200, 1600], [300, 400]]) {
    const px = projectNormalizedPdfRect(r, { width: w, height: h }, 0);
    approxRect(px, { x: 0.25 * w, y: 0.5 * h, width: 0.5 * w, height: 0.25 * h });
  }
});

test('projectNormalizedPdfRect honors the page-box offset', () => {
  const r: PdfRect = { x: 0, y: 0, width: 1, height: 1 };
  const px = projectNormalizedPdfRect(r, { x: 40, y: 100, width: 600, height: 800 }, 0);
  approxRect(px, { x: 40, y: 100, width: 600, height: 800 });
});

test('projectNormalizedPdfRect applies rotation before scaling', () => {
  // At 90°, a top-left unrotated rect lands at the top-right of the rotated box.
  const r: PdfRect = { x: 0, y: 0, width: 0.2, height: 0.1 };
  const px = projectNormalizedPdfRect(r, { width: 400, height: 800 }, 90);
  // rotated rect = { x: 1-0.1, y: 0, width: 0.1, height: 0.2 }
  approxRect(px, { x: 0.9 * 400, y: 0, width: 0.1 * 400, height: 0.2 * 800 });
});

// ── validation: happy path + ordering ─────────────────────────────────────

test('validatePdfSelectionAnchor accepts a well-formed anchor', () => {
  assert.deepEqual(validatePdfSelectionAnchor(validAnchor()), { ok: true });
});

test('multi-page anchor requires strictly ascending pageIndex', () => {
  const ok = validAnchor({
    pages: [
      { pageIndex: 2, start: { itemIndex: 3, charOffset: 0 }, end: { itemIndex: 3, charOffset: 4 }, rects: [] },
      { pageIndex: 6, start: { itemIndex: 0, charOffset: 0 }, end: { itemIndex: 1, charOffset: 2 }, rects: [] },
    ],
  });
  assert.equal(validatePdfSelectionAnchor(ok).ok, true);

  const outOfOrder = validAnchor({
    pages: [
      { pageIndex: 6, start: { itemIndex: 0, charOffset: 0 }, end: { itemIndex: 1, charOffset: 0 }, rects: [] },
      { pageIndex: 2, start: { itemIndex: 0, charOffset: 0 }, end: { itemIndex: 1, charOffset: 0 }, rects: [] },
    ],
  });
  assert.equal(validatePdfSelectionAnchor(outOfOrder).ok, false);

  const dup = validAnchor({
    pages: [
      { pageIndex: 3, start: { itemIndex: 0, charOffset: 0 }, end: { itemIndex: 1, charOffset: 0 }, rects: [] },
      { pageIndex: 3, start: { itemIndex: 0, charOffset: 0 }, end: { itemIndex: 1, charOffset: 0 }, rects: [] },
    ],
  });
  assert.equal(validatePdfSelectionAnchor(dup).ok, false, 'duplicate page index rejected');
});

test('validation rejects an end that precedes its start', () => {
  const a = validAnchor({
    pages: [{ pageIndex: 0, start: { itemIndex: 5, charOffset: 2 }, end: { itemIndex: 5, charOffset: 1 }, rects: [] }],
  });
  assert.equal(validatePdfSelectionAnchor(a).ok, false);
});

// ── validation: malformed / non-finite / out-of-range ──────────────────────

test('validation rejects non-object / wrong version / missing fingerprint', () => {
  assert.equal(validatePdfSelectionAnchor(null).ok, false);
  assert.equal(validatePdfSelectionAnchor(42).ok, false);
  assert.equal(validatePdfSelectionAnchor(validAnchor({ version: 2 as unknown as 1 })).ok, false);
  assert.equal(validatePdfSelectionAnchor(validAnchor({ fingerprint: '' })).ok, false);
  assert.equal(validatePdfSelectionAnchor(validAnchor({ pages: [] })).ok, false);
});

test('validation rejects non-finite and out-of-range rect geometry', () => {
  const nonFinite = validAnchor({
    pages: [{ pageIndex: 0, start: { itemIndex: 0, charOffset: 0 }, end: { itemIndex: 0, charOffset: 1 },
      rects: [{ x: Number.NaN, y: 0, width: 0.1, height: 0.1 }] }],
  });
  assert.equal(validatePdfSelectionAnchor(nonFinite).ok, false);

  const outOfBox = validAnchor({
    pages: [{ pageIndex: 0, start: { itemIndex: 0, charOffset: 0 }, end: { itemIndex: 0, charOffset: 1 },
      rects: [{ x: 0.9, y: 0.1, width: 0.5, height: 0.1 }] }], // x+width = 1.4
  });
  assert.equal(validatePdfSelectionAnchor(outOfBox).ok, false);

  const negOrigin = validAnchor({
    pages: [{ pageIndex: 0, start: { itemIndex: 0, charOffset: 0 }, end: { itemIndex: 0, charOffset: 1 },
      rects: [{ x: -0.2, y: 0.1, width: 0.1, height: 0.1 }] }],
  });
  assert.equal(validatePdfSelectionAnchor(negOrigin).ok, false);
});

test('validation rejects non-integer / negative text positions', () => {
  const frac = validAnchor({
    pages: [{ pageIndex: 0, start: { itemIndex: 1.5, charOffset: 0 }, end: { itemIndex: 2, charOffset: 0 }, rects: [] }],
  });
  assert.equal(validatePdfSelectionAnchor(frac).ok, false);
  const neg = validAnchor({
    pages: [{ pageIndex: 0, start: { itemIndex: 0, charOffset: -1 }, end: { itemIndex: 2, charOffset: 0 }, rects: [] }],
  });
  assert.equal(validatePdfSelectionAnchor(neg).ok, false);
});

test('validation checks pageTextHashes shape', () => {
  const good = validAnchor({ pageTextHashes: { 2: 'h1', 3: 'h2' } });
  assert.equal(validatePdfSelectionAnchor(good).ok, true);
  const badKey = validAnchor({ pageTextHashes: { foo: 'h1' } as unknown as Record<number, string> });
  assert.equal(validatePdfSelectionAnchor(badKey).ok, false);
  const badVal = validAnchor({ pageTextHashes: { 2: 5 } as unknown as Record<number, string> });
  assert.equal(validatePdfSelectionAnchor(badVal).ok, false);
});

// ── caps ────────────────────────────────────────────────────────────────

test('validation enforces the 20-page cap', () => {
  const pages = Array.from({ length: MAX_PDF_ANCHOR_PAGES + 1 }, (_, i) => ({
    pageIndex: i, start: { itemIndex: 0, charOffset: 0 }, end: { itemIndex: 0, charOffset: 1 }, rects: [],
  }));
  assert.equal(validatePdfSelectionAnchor(validAnchor({ pages })).ok, false);
});

test('validation enforces the 2000-rect cap across pages', () => {
  const rects = Array.from({ length: MAX_PDF_ANCHOR_RECTS + 1 }, () => ({ x: 0, y: 0, width: 0.001, height: 0.001 }));
  const a = validAnchor({
    pages: [{ pageIndex: 0, start: { itemIndex: 0, charOffset: 0 }, end: { itemIndex: 0, charOffset: 1 }, rects }],
  });
  assert.equal(validatePdfSelectionAnchor(a).ok, false);
});

test('validation enforces the 256 KiB serialized ceiling', () => {
  const huge = 'x'.repeat(MAX_PDF_ANCHOR_JSON_BYTES + 10);
  const a = validAnchor({ prefix: huge });
  const result = validatePdfSelectionAnchor(a);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /too large/);
});

// ── serialize / parse round-trips ──────────────────────────────────────────

test('serialize → parse round-trips a valid anchor', () => {
  const a = validAnchor({ pageTextHashes: { 2: 'abc' } });
  const json = serializePdfSelectionAnchor(a);
  const back = parsePdfSelectionAnchor(json);
  assert.deepEqual(back, a);
});

test('parse returns null for malformed / invalid / empty JSON (never throws)', () => {
  assert.equal(parsePdfSelectionAnchor('not json'), null);
  assert.equal(parsePdfSelectionAnchor(''), null);
  assert.equal(parsePdfSelectionAnchor(null), null);
  assert.equal(parsePdfSelectionAnchor(undefined), null);
  assert.equal(parsePdfSelectionAnchor('{"version":1}'), null, 'shape-invalid → null');
  assert.equal(parsePdfSelectionAnchor(JSON.stringify(validAnchor({ fingerprint: '' }))), null);
});

// ── runner ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
