#!/usr/bin/env node
// Unit tests for the heap-telemetry analysis script.
//   node scripts/analyze-heap-telemetry.test.mjs
//
// Covers the pure analysis core: parse tolerance (mixed old/new + malformed),
// linear-fit exactness, the classify verdict boundaries, and buildReport's
// mixed-kind integration. Written for WB-10 mutation-sensitivity — the fit and
// classify assertions pin exact values / boundaries so a flipped comparison or
// off-by-one slope is caught.

import assert from 'node:assert/strict';
import {
  parseLines,
  linearFit,
  perHour,
  classifySeries,
  summarizeSeries,
  buildReport,
} from './analyze-heap-telemetry.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const T0 = Date.parse('2026-07-25T00:00:00.000Z');
const HOUR = 3_600_000;
/** A heap-kind line at `hoursFromT0` with a given heapUsed. */
const heapLine = (h, used, extra = {}) =>
  JSON.stringify({ kind: 'heap', t: new Date(T0 + h * HOUR).toISOString(), heapUsed: used, heapTotal: used + 1e6, heapLimit: 4 * 1024 ** 3, external: 0, malloced: 0, ...extra });

// ── parse tolerance ───────────────────────────────────────────────────────────

test('parseLines tolerates blank + malformed lines and normalises missing kind to heap', () => {
  const text = [
    '',
    '   ',
    '{ this is not json',
    // An OLD line with no `kind` field — must be read as heap.
    JSON.stringify({ t: new Date(T0).toISOString(), heapUsed: 100, heapTotal: 200, heapLimit: 300, external: 0, malloced: 0 }),
    heapLine(1, 150),
    '{"kind":"subsystems","t":"2026-07-25T02:00:00.000Z","gauges":[{"name":"chat-ring","count":5,"bytes":2048}]}',
    '{"kind":"broken",', // torn final line
  ].join('\n');
  const recs = parseLines(text);
  assert.equal(recs.length, 3, 'two heap + one subsystems survive; junk dropped');
  assert.equal(recs[0].kind, 'heap', 'no-kind line became heap');
  assert.equal(recs[0].heapUsed, 100);
  assert.equal(recs[2].kind, 'subsystems');
  assert.ok(Number.isFinite(recs[0].tMs), 'tMs parsed from ISO t');
});

// ── linear fit exactness (mutation-sensitive) ────────────────────────────────

test('linearFit recovers a known slope and intercept exactly', () => {
  // y = 3x + 7 over x = 0..4
  const pts = [0, 1, 2, 3, 4].map((x) => ({ x, y: 3 * x + 7 }));
  const fit = linearFit(pts);
  assert.ok(Math.abs(fit.slope - 3) < 1e-9, `slope 3, got ${fit.slope}`);
  assert.ok(Math.abs(fit.intercept - 7) < 1e-9, `intercept 7, got ${fit.intercept}`);
  assert.ok(Math.abs(fit.r2 - 1) < 1e-9, 'perfect line ⇒ r2 == 1');
});

test('linearFit handles degenerate input without NaN', () => {
  assert.equal(linearFit([]).slope, 0);
  assert.equal(linearFit([{ x: 5, y: 9 }]).slope, 0);
  // All x identical ⇒ vertical, undefined slope ⇒ return 0 not NaN.
  const flatX = linearFit([{ x: 2, y: 1 }, { x: 2, y: 9 }]);
  assert.equal(flatX.slope, 0);
  assert.ok(Number.isFinite(flatX.intercept));
});

test('perHour scales a per-ms slope to per-hour', () => {
  assert.equal(perHour(2), 2 * HOUR);
});

// ── classify verdict boundaries ──────────────────────────────────────────────

const series = (ys) => ys.map((y, i) => ({ x: T0 + i * HOUR, y }));

test('classifySeries: <3 points is insufficient-data', () => {
  assert.equal(classifySeries(series([1, 2])), 'insufficient-data');
});

test('classifySeries: a constant series is flat', () => {
  assert.equal(classifySeries(series([1000, 1000, 1000, 1000, 1000])), 'flat');
});

test('classifySeries: a declining series is flat (not a leak)', () => {
  assert.equal(classifySeries(series([1000, 900, 800, 700, 600])), 'flat');
});

test('classifySeries: a steady linear climb is monotonic-growth-suspect', () => {
  assert.equal(classifySeries(series([100, 200, 300, 400, 500, 600])), 'monotonic-growth-suspect');
});

test('classifySeries: ramp-then-plateau is grew-then-stabilized', () => {
  // Steep first half, flat second half.
  assert.equal(
    classifySeries(series([100, 300, 500, 700, 720, 725, 728, 730])),
    'grew-then-stabilized',
  );
});

test('classifySeries: a tiny wobble on a big baseline is flat (relative threshold)', () => {
  // <5% net change over the window despite a positive micro-slope.
  assert.equal(classifySeries(series([1_000_000, 1_000_010, 1_000_005, 1_000_020, 1_000_015])), 'flat');
});

// ── summarizeSeries ──────────────────────────────────────────────────────────

test('summarizeSeries reports min/max/last and growth/hour', () => {
  const s = summarizeSeries(series([100, 200, 300, 400, 500]));
  assert.equal(s.min, 100);
  assert.equal(s.max, 500);
  assert.equal(s.last, 500);
  // Absolute epoch-ms x-values cost a little OLS precision; ~100/hr is exact enough.
  assert.ok(Math.abs(s.growthPerHour - 100) < 0.1, `+100/hr, got ${s.growthPerHour}`);
  assert.equal(s.verdict, 'monotonic-growth-suspect');
});

// ── buildReport integration across mixed kinds ───────────────────────────────

test('buildReport sorts subsystem gauges by growth and flags the suspect', () => {
  const recs = parseLines([
    // subsystems: chat-ring bytes climbing hard, live-runners flat count.
    '{"kind":"subsystems","t":"2026-07-25T00:00:00.000Z","gauges":[{"name":"chat-ring","count":10,"bytes":1000000},{"name":"live-runners","count":3}]}',
    '{"kind":"subsystems","t":"2026-07-25T01:00:00.000Z","gauges":[{"name":"chat-ring","count":20,"bytes":3000000},{"name":"live-runners","count":3}]}',
    '{"kind":"subsystems","t":"2026-07-25T02:00:00.000Z","gauges":[{"name":"chat-ring","count":30,"bytes":5000000},{"name":"live-runners","count":3}]}',
    heapLine(0, 1e8),
    heapLine(1, 1e8),
    heapLine(2, 1e8),
    '{"kind":"processes","t":"2026-07-25T00:00:00.000Z","procs":[{"type":"Browser","pid":1,"rss":100000000},{"type":"Tab","pid":2,"rss":50000000}]}',
    '{"kind":"processes","t":"2026-07-25T02:00:00.000Z","procs":[{"type":"Browser","pid":1,"rss":100000000},{"type":"Tab","pid":2,"rss":51000000}]}',
    '{"kind":"agents","t":"2026-07-25T00:00:00.000Z","perAgent":[{"agentId":"a1","rss":200000000,"pidCount":2,"source":"job"}]}',
  ].join('\n'));
  const report = buildReport(recs);
  assert.match(report, /Whole-process V8 heap/);
  assert.match(report, /chat-ring/);
  assert.match(report, /monotonic-growth-suspect/);
  // chat-ring (bytes, climbing) must be listed before live-runners (flat) — sorted by growth.
  const iChat = report.indexOf('chat-ring');
  const iRun = report.indexOf('live-runners');
  assert.ok(iChat >= 0 && iRun >= 0 && iChat < iRun, 'chat-ring sorts above live-runners');
  // The verdict block must name chat-ring as a suspect.
  assert.match(report, /investigate:[^\n]*chat-ring/);
  // Agent snapshot rendered.
  assert.match(report, /a1/);
});

test('buildReport with a clean flat stream reports no suspects', () => {
  const recs = parseLines([heapLine(0, 1e8), heapLine(1, 1e8), heapLine(2, 1e8)].join('\n'));
  const report = buildReport(recs);
  assert.match(report, /No monotonic-growth suspects/);
});

// ── runner ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
for (const t of tests) {
  try { t.fn(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
