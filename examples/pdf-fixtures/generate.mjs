// Deterministic, dependency-free generator for the PDF text/annotation fixtures
// (plan Part 1.12). Emits small, VALID PDFs used by the dual-viewer text-model,
// anchor, and overlay tests to exercise the hard cases: selectable text, page
// rotation, mixed page sizes, ligatures, image-only (scanned) pages, and link
// annotations.
//
//   node examples/pdf-fixtures/generate.mjs
//
// PDFs are committed so tests need no generation step; re-run this only when a
// fixture must change. Everything here is raw PDF assembly — no external deps —
// so it stays reproducible in CI. Byte offsets in the xref are computed from the
// assembled body, so edits stay valid.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

// ── Minimal PDF assembler ─────────────────────────────────────────────────────
// Build a PDF from a list of object bodies (Buffers or strings). Object N is at
// list index N-1; the xref records each object's byte offset.
function buildPdf(objects) {
  const header = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1');
  const chunks = [header];
  const offsets = [];
  let pos = header.length;
  objects.forEach((body, i) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
    const head = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    offsets.push(pos);
    chunks.push(head, buf, tail);
    pos += head.length + buf.length + tail.length;
  });

  const xrefStart = pos;
  const count = objects.length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, 'latin1'));
  return Buffer.concat(chunks);
}

function stream(dict, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1');
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${body.length} >>\nstream\n`, 'latin1'),
    body,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

// Standard catalog/pages preamble. `pageRefs` are object numbers of the pages.
function catalog(pagesObjNum) {
  return `<< /Type /Catalog /Pages ${pagesObjNum} 0 R >>`;
}

const HELV = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

// ── Fixture: selectable text (multi-line, gives anchor tests real context) ────
function selectableText() {
  const content =
    'BT /F1 18 Tf 72 720 Td (The quick brown fox jumps over the lazy dog.) Tj\n' +
    'T* (Selectable text fixture for the Lares dual PDF viewer.) Tj\n' +
    '0 -22 Td (Second paragraph: anchors need prefix and suffix context.) Tj ET';
  // objects: 1 catalog, 2 pages, 3 page, 4 content, 5 font
  const objs = [
    catalog(2),
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    stream('', content),
    HELV,
  ];
  return buildPdf(objs);
}

// ── Fixture: rotated page (/Rotate 90) ────────────────────────────────────────
function rotated() {
  const content = 'BT /F1 18 Tf 72 720 Td (Rotated 90 degrees clockwise.) Tj ET';
  const objs = [
    catalog(2),
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    stream('', content),
    HELV,
  ];
  return buildPdf(objs);
}

// ── Fixture: mixed page sizes (letter portrait + wide) ────────────────────────
function mixedSize() {
  const c1 = 'BT /F1 18 Tf 72 720 Td (Page 1: US Letter portrait 612 x 792.) Tj ET';
  const c2 = 'BT /F1 18 Tf 72 400 Td (Page 2: a wider 1008 x 612 landscape page.) Tj ET';
  const objs = [
    catalog(2), // 1
    `<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>`, // 2
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>`, // 3
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1008 612] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>`, // 4
    stream('', c1), // 5
    stream('', c2), // 6
    HELV, // 7
  ];
  return buildPdf(objs);
}

// ── Fixture: ligatures (fi / fl via an /Encoding Differences map) ─────────────
// True RTL/CJK needs an embedded font with those glyphs — see README for the
// referenced (not committed) real-world sample. This committed fixture locks the
// ligature-as-one-selectable-unit case that the base-14 fonts CAN express.
function ligature() {
  const content =
    'BT /F1 18 Tf 72 720 Td (o\\001ce a\\002oat: the \\001 and \\002 ligatures.) Tj ET';
  const font =
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ` +
    `/Encoding << /Type /Encoding /Differences [1 /fi /fl] >> >>`;
  const objs = [
    catalog(2),
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    stream('', content),
    font,
  ];
  return buildPdf(objs);
}

// ── Fixture: scanned / image-only page (an image XObject, no text) ────────────
function imageOnly() {
  // A tiny 4x4 DeviceRGB raster (a checker) — enough to be an "image page" with
  // zero extractable text, exercising the coordinate-only note path.
  const w = 4, h = 4;
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = (x + y) % 2 === 0;
      const o = (y * w + x) * 3;
      px[o] = on ? 0x22 : 0xcc;
      px[o + 1] = on ? 0x66 : 0xcc;
      px[o + 2] = on ? 0xaa : 0xcc;
    }
  }
  const content = 'q 400 0 0 300 106 246 cm /Im0 Do Q'; // scale image into the page
  const image = stream(
    `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8`,
    px,
  );
  const objs = [
    catalog(2), // 1
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`, // 2
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`, // 3
    stream('', content), // 4
    image, // 5
  ];
  return buildPdf(objs);
}

// ── Fixture: link annotation (external URI) ───────────────────────────────────
function linkAnnotation() {
  const content = 'BT /F1 18 Tf 72 700 Td (Visit example.com \\(link annotation below\\).) Tj ET';
  const objs = [
    catalog(2), // 1
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`, // 2
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [6 0 R] >>`, // 3
    stream('', content), // 4
    HELV, // 5
    `<< /Type /Annot /Subtype /Link /Rect [72 690 320 712] /Border [0 0 0] ` +
      `/A << /Type /Action /S /URI /URI (https://example.com/) >> >>`, // 6
  ];
  return buildPdf(objs);
}

const FIXTURES = {
  'selectable-text.pdf': selectableText,
  'rotated.pdf': rotated,
  'mixed-size.pdf': mixedSize,
  'ligature.pdf': ligature,
  'image-only.pdf': imageOnly,
  'link-annotation.pdf': linkAnnotation,
};

for (const [name, make] of Object.entries(FIXTURES)) {
  const bytes = make();
  writeFileSync(join(OUT_DIR, name), bytes);
  console.log(`wrote ${name} (${bytes.length} bytes)`);
}
