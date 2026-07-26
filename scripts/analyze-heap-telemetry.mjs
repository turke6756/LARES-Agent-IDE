#!/usr/bin/env node
// Analyze the main-process heap-telemetry JSONL (crash diagnosability "Layer 3").
//
//   node scripts/analyze-heap-telemetry.mjs [path-to-heap-telemetry.jsonl]
//
// Reads the live file AND its rotated `.1` sibling, tolerating mixed old/new
// lines (pre-`kind` lines are read as heap samples), and prints a compact,
// self-explanatory report:
//   • whole-process heap trend — linear-fit growth/hour + min/max + verdict
//   • per-subsystem trend table — one row per named gauge, sorted by growth
//   • per-process table — Electron process working sets by type
//   • per-agent snapshot — latest per-agent child-process working set
// Each series gets a verdict: flat / grew-then-stabilized / monotonic-growth-
// suspect — the last is the one to investigate. No dependencies beyond node
// stdlib; the pure helpers are exported for the unit test.
//
// Line kinds are documented in src/main/watchdog/heap-telemetry.ts.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── pure analysis helpers (exported for the test) ────────────────────────────

/** Parse a JSONL blob into records, skipping blank/malformed lines. A line with
 *  no `kind` is normalised to `heap` (backward compatibility with the original
 *  pre-`kind` stream). Each record gains `tMs` (epoch ms, NaN if unparseable). */
export function parseLines(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // tolerate a torn final line / partial write
    }
    if (rec === null || typeof rec !== 'object') continue;
    if (!rec.kind) rec.kind = 'heap';
    rec.tMs = typeof rec.t === 'string' ? Date.parse(rec.t) : NaN;
    out.push(rec);
  }
  return out;
}

/** Ordinary-least-squares fit of `points` [{x,y}] → {slope, intercept, r2}.
 *  slope is dy/dx in the raw units of x (ms here). Degenerate input (no spread
 *  in x, <2 points) returns a zero slope rather than NaN. */
export function linearFit(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? points[0].y : 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const p of points) {
    sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n, r2: 0 };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const rDenom = (n * sxx - sx * sx) * (n * syy - sy * sy);
  const r = rDenom > 0 ? (n * sxy - sx * sy) / Math.sqrt(rDenom) : 0;
  return { slope, intercept, r2: r * r };
}

const MS_PER_HOUR = 3_600_000;

/** Growth per hour implied by a fit slope (dy/dms → dy/hour). */
export function perHour(slope) {
  return slope * MS_PER_HOUR;
}

/** Classify a time series into one of the leak-verdict buckets:
 *    'insufficient-data'          — fewer than 3 usable points.
 *    'flat'                       — negligible or non-positive net change.
 *    'grew-then-stabilized'       — grew overall but the late slope collapsed
 *                                   toward zero (a warm-up, not a leak).
 *    'monotonic-growth-suspect'   — grew overall AND is still climbing late.
 *  Thresholds are relative to the series mean so the same rule works for a
 *  4 GiB heap and a 12-entry map. */
export function classifySeries(points) {
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (usable.length < 3) return 'insufficient-data';
  usable.sort((a, b) => a.x - b.x);
  const xs = usable.map((p) => p.x);
  const ys = usable.map((p) => p.y);
  const fit = linearFit(usable);
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const span = xs[xs.length - 1] - xs[0];
  const denom = Math.max(Math.abs(mean), 1);
  const relRise = (fit.slope * span) / denom; // predicted fractional change end-to-end

  const FLAT = 0.05; // < 5% net change over the whole window ⇒ flat
  if (Math.abs(relRise) < FLAT || fit.slope <= 0) return 'flat';

  // Growing overall — split at the temporal midpoint and compare early vs late.
  const mid = xs[0] + span / 2;
  const first = usable.filter((p) => p.x <= mid);
  const second = usable.filter((p) => p.x > mid);
  const s1 = first.length >= 2 ? linearFit(first).slope : fit.slope;
  const s2 = second.length >= 2 ? linearFit(second).slope : fit.slope;

  // Late slope collapsed (non-positive, or < 30% of the early slope) ⇒ stabilized.
  if (s2 <= 0 || (s1 > 0 && s2 <= 0.3 * s1)) return 'grew-then-stabilized';
  return 'monotonic-growth-suspect';
}

/** Summarise a series: point count, min/max, net growth/hour, and verdict.
 *  `points` are {x:ms, y:value}. */
export function summarizeSeries(points) {
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const ys = usable.map((p) => p.y);
  const fit = linearFit(usable);
  return {
    n: usable.length,
    min: ys.length ? Math.min(...ys) : 0,
    max: ys.length ? Math.max(...ys) : 0,
    last: ys.length ? ys[ys.length - 1] : 0,
    growthPerHour: perHour(fit.slope),
    verdict: classifySeries(usable),
  };
}

// ── formatting ───────────────────────────────────────────────────────────────

const mib = (b) => (b / (1024 * 1024)).toFixed(1);
const signedMib = (b) => (b >= 0 ? '+' : '') + mib(b);
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);

/** Build the whole report string from parsed records. Pure (no I/O) so it is
 *  exercisable in tests. */
export function buildReport(records) {
  const lines = [];
  const heap = records.filter((r) => r.kind === 'heap');
  const subs = records.filter((r) => r.kind === 'subsystems');
  const procs = records.filter((r) => r.kind === 'processes');
  const agents = records.filter((r) => r.kind === 'agents');

  const window = describeWindow(records);
  lines.push('══ Heap telemetry analysis ══');
  lines.push(`records: ${records.length}  (heap ${heap.length}, subsystems ${subs.length}, processes ${procs.length}, agents ${agents.length})`);
  if (window) lines.push(`window:  ${window}`);
  lines.push('');

  // ── whole-process heap ──
  lines.push('── Whole-process V8 heap (heapUsed) ──');
  const heapPts = heap.map((r) => ({ x: r.tMs, y: Number(r.heapUsed) }));
  const hs = summarizeSeries(heapPts);
  if (hs.n === 0) {
    lines.push('  (no heap samples)');
  } else {
    lines.push(`  used  min ${mib(hs.min)} MiB  max ${mib(hs.max)} MiB  last ${mib(hs.last)} MiB`);
    lines.push(`  trend ${signedMib(hs.growthPerHour)} MiB/hour   →  ${hs.verdict}`);
    const lastLimit = Number(heap[heap.length - 1].heapLimit);
    if (Number.isFinite(lastLimit) && lastLimit > 0) {
      lines.push(`  ceiling ${mib(lastLimit)} MiB (limit); last heap at ${((hs.last / lastLimit) * 100).toFixed(1)}% of it`);
    }
  }
  lines.push('');

  // ── per-subsystem gauges ──
  lines.push('── Per-subsystem gauges (sorted by growth) ──');
  const subSeries = collectGaugeSeries(subs);
  if (subSeries.length === 0) {
    lines.push('  (no subsystem lines — provider not wired, or file predates them)');
  } else {
    const rows = subSeries.map(({ name, unit, points }) => {
      const s = summarizeSeries(points);
      return { name, unit, s };
    });
    rows.sort((a, b) => b.s.growthPerHour - a.s.growthPerHour);
    lines.push(`  ${pad('gauge', 30)} ${pad('unit', 6)} ${padL('min', 12)} ${padL('max', 12)} ${padL('last', 12)} ${padL('growth/hr', 14)}  verdict`);
    for (const { name, unit, s } of rows) {
      const fmt = unit === 'bytes' ? mib : (v) => String(Math.round(v));
      const fmtG = unit === 'bytes' ? signedMib : (v) => (v >= 0 ? '+' : '') + Math.round(v);
      lines.push(
        `  ${pad(name, 30)} ${pad(unit, 6)} ${padL(fmt(s.min), 12)} ${padL(fmt(s.max), 12)} ${padL(fmt(s.last), 12)} ${padL(fmtG(s.growthPerHour), 14)}  ${s.verdict}`,
      );
    }
    lines.push('  (bytes shown in MiB; count gauges show raw entries)');
  }
  lines.push('');

  // ── per-process ──
  lines.push('── Electron processes (working set by type) ──');
  const procSeries = collectProcessSeries(procs);
  if (procSeries.length === 0) {
    lines.push('  (no process lines)');
  } else {
    lines.push(`  ${pad('type', 14)} ${padL('min', 12)} ${padL('max', 12)} ${padL('last', 12)} ${padL('growth/hr', 14)}  verdict`);
    for (const { type, points } of procSeries) {
      const s = summarizeSeries(points);
      lines.push(
        `  ${pad(type, 14)} ${padL(mib(s.min), 12)} ${padL(mib(s.max), 12)} ${padL(mib(s.last), 12)} ${padL(signedMib(s.growthPerHour), 14)}  ${s.verdict}`,
      );
    }
    lines.push('  (MiB; Browser = main process, Tab = renderer windows, GPU/Utility as named)');
  }
  lines.push('');

  // ── per-agent ──
  lines.push('── Per-agent child-process working set ──');
  const agentReport = summarizeAgents(agents);
  if (!agentReport) {
    lines.push('  (no agent lines — provider not wired, or no agents sampled)');
  } else {
    const totalS = summarizeSeries(agentReport.totalPoints);
    lines.push(`  total agent RSS  last ${mib(totalS.last)} MiB  trend ${signedMib(totalS.growthPerHour)} MiB/hour  →  ${totalS.verdict}`);
    lines.push(`  latest snapshot: ${agentReport.latest.length} agent(s)`);
    for (const a of agentReport.latest.slice(0, 12)) {
      lines.push(`    ${pad(a.agentId, 26)} ${padL(mib(a.rss), 10)} MiB  (pids ${a.pidCount ?? '?'}, ${a.source ?? '?'})`);
    }
    lines.push('  (agent RSS scaling with agent count is EXPECTED — that is workload, not a leak)');
  }
  lines.push('');

  // ── overall verdict ──
  const suspects = [
    ...(hs.verdict === 'monotonic-growth-suspect' ? ['whole-process heap'] : []),
    ...subSeries
      .map(({ name, points }) => ({ name, v: classifySeries(points) }))
      .filter((r) => r.v === 'monotonic-growth-suspect')
      .map((r) => r.name),
    ...procSeries
      .map(({ type, points }) => ({ type, v: classifySeries(points) }))
      .filter((r) => r.v === 'monotonic-growth-suspect')
      .map((r) => `process:${r.type}`),
  ];
  lines.push('══ Verdict ══');
  if (suspects.length === 0) {
    lines.push('  No monotonic-growth suspects. Nothing looks like an unbounded internal leak.');
  } else {
    lines.push(`  ${suspects.length} monotonic-growth suspect(s) — investigate: ${suspects.join(', ')}`);
  }
  return lines.join('\n');
}

/** Group subsystem lines into one series per gauge name. A gauge's unit is
 *  'bytes' if ANY reading carried bytes, else 'count'. */
function collectGaugeSeries(subs) {
  const byName = new Map();
  for (const rec of subs) {
    if (!Array.isArray(rec.gauges)) continue;
    for (const g of rec.gauges) {
      if (!g || typeof g.name !== 'string') continue;
      let e = byName.get(g.name);
      if (!e) { e = { name: g.name, hasBytes: false, points: [] }; byName.set(g.name, e); }
      const hasB = typeof g.bytes === 'number';
      if (hasB) e.hasBytes = true;
      e.points.push({ x: rec.tMs, y: hasB ? g.bytes : Number(g.count), _count: Number(g.count), _bytes: hasB ? g.bytes : undefined });
    }
  }
  // If a gauge is bytes-typed, use bytes for every point (fall back to 0 where a
  // stray reading lacked bytes); else use count.
  const out = [];
  for (const e of byName.values()) {
    const unit = e.hasBytes ? 'bytes' : 'count';
    const points = e.points.map((p) => ({
      x: p.x,
      y: unit === 'bytes' ? (typeof p._bytes === 'number' ? p._bytes : 0) : p._count,
    }));
    out.push({ name: e.name, unit, points });
  }
  return out;
}

/** Group process lines into one series per process type (summing working set
 *  across every process of that type at each timestamp). */
function collectProcessSeries(procs) {
  const byType = new Map();
  for (const rec of procs) {
    if (!Array.isArray(rec.procs)) continue;
    const sums = new Map();
    for (const p of rec.procs) {
      if (!p || typeof p.type !== 'string') continue;
      sums.set(p.type, (sums.get(p.type) ?? 0) + Number(p.rss || 0));
    }
    for (const [type, rss] of sums) {
      let arr = byType.get(type);
      if (!arr) { arr = []; byType.set(type, arr); }
      arr.push({ x: rec.tMs, y: rss });
    }
  }
  return [...byType.entries()]
    .map(([type, points]) => ({ type, points }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

/** Per-agent: a total-RSS-over-time series plus the most recent snapshot. */
function summarizeAgents(agentRecs) {
  if (agentRecs.length === 0) return null;
  const totalPoints = [];
  for (const rec of agentRecs) {
    if (!Array.isArray(rec.perAgent)) continue;
    const total = rec.perAgent.reduce((s, a) => s + Number(a.rss || 0), 0);
    totalPoints.push({ x: rec.tMs, y: total });
  }
  const last = agentRecs[agentRecs.length - 1];
  const latest = Array.isArray(last.perAgent)
    ? [...last.perAgent].sort((a, b) => Number(b.rss || 0) - Number(a.rss || 0))
    : [];
  return { totalPoints, latest };
}

function describeWindow(records) {
  const ts = records.map((r) => r.tMs).filter(Number.isFinite).sort((a, b) => a - b);
  if (ts.length < 2) return null;
  const durH = (ts[ts.length - 1] - ts[0]) / MS_PER_HOUR;
  return `${new Date(ts[0]).toISOString()} → ${new Date(ts[ts.length - 1]).toISOString()}  (${durH.toFixed(2)} h)`;
}

// ── file loading + CLI ───────────────────────────────────────────────────────

/** Read the live file plus its `.1` rotation (rotated first, so records are in
 *  rough chronological order) and parse. Missing files contribute nothing. */
export function loadRecords(filePath) {
  const parts = [];
  const rotated = `${filePath}.1`;
  if (existsSync(rotated)) parts.push(readFileSync(rotated, 'utf8'));
  if (existsSync(filePath)) parts.push(readFileSync(filePath, 'utf8'));
  const recs = parts.flatMap((t) => parseLines(t));
  // Guard against any out-of-order rotation by sorting on timestamp.
  recs.sort((a, b) => (a.tMs || 0) - (b.tMs || 0));
  return recs;
}

/** Best-effort default location of the live telemetry file (Electron userData). */
function defaultPath() {
  const appData = process.env.APPDATA
    || (process.platform === 'darwin'
      ? path.join(process.env.HOME || '', 'Library', 'Application Support')
      : path.join(process.env.HOME || '', '.config'));
  // The Electron app name is the productName; the dev build uses the package name.
  for (const name of ['lares-app', 'agent-dashboard', 'AgentDashboard', 'Lares', 'lares']) {
    const p = path.join(appData, name, 'logs', 'heap-telemetry.jsonl');
    if (existsSync(p)) return p;
  }
  return null;
}

function main() {
  const arg = process.argv[2];
  const filePath = arg || defaultPath();
  if (!filePath) {
    console.error('usage: node scripts/analyze-heap-telemetry.mjs <path-to-heap-telemetry.jsonl>');
    console.error('       (no path given and no file found in the default userData/logs location)');
    process.exit(2);
  }
  if (!existsSync(filePath) && !existsSync(`${filePath}.1`)) {
    console.error(`no telemetry file at ${filePath} (or its .1 rotation)`);
    process.exit(2);
  }
  const records = loadRecords(filePath);
  console.log(`source: ${filePath}${existsSync(`${filePath}.1`) ? ' (+ .1)' : ''}\n`);
  console.log(buildReport(records));
}

// Run only as a CLI, not when imported by the test.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
