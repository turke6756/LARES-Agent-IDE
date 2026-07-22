// WP9 (G9) — snapshot export of the fileSequences block: the 'file-sequences'
// capability (v2-OPTIONAL fields, schema stays v2 — no version bump), the
// tables/file-sequences.csv rendering + round-trip, redaction through the
// existing exporter belt, the WP6-shaped truncation disclosure, the
// TOOL_ERROR_RATES_UNAVAILABLE deferral caveat, and a golden write→read
// round-trip.
//   npm run build:main
//   node dist/main/main/analytics-export/file-sequences-export.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { OverheadModel } from '../../shared/types';
import type { RedactionRoots } from '../context-optimizer/agent-dto';
import type { FileSequencesV1 } from '../context-optimizer/behavior-sequences';
import {
  ANALYTICS_SCHEMA_VERSION, SNAPSHOT_CAPABILITIES, computeSnapshotId,
  type AnalyticsSnapshotV2, type OptimizerSurfaceData, type SnapshotProvenance,
  type SnapshotSurface, type SurfaceKey, SURFACE_KEYS, type TableTruncationMetaV1,
} from './analytics-types';
import { renderSummaryTables } from './analytics-render';
import {
  computeTableTruncation, readSnapshotFrom, redactPathsDeep, snapshotCapabilities,
  writeAnalyticsSnapshot,
} from './analytics-exporter';
import { buildCaveats, type CaveatConditions } from './analytics-caveats';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

// ── fixtures ──────────────────────────────────────────────────────────────────

function provenance(): SnapshotProvenance {
  return {
    workspace: { id: 'ws-1', root: '$WORKSPACE', pathType: 'windows' },
    workspaceGitSha: 'abc', workspaceGitBranch: 'main', workspaceGitDirty: false,
    appVersion: '0.0.0', exporterVersion: 1,
    databaseMode: 'readonly-query-only', backfillMode: 'skip', scopeMode: 'strict',
    redactionPolicy: 'agent-safe-v1',
    laneGrantMatrix: {
      supervisor: { toolsets: [], strictMcp: false },
      worker: { toolsets: [], strictMcp: true },
      researcher: { toolsets: [], strictMcp: true },
      legacy: { toolsets: [], strictMcp: true },
    },
    indexState: { epochsBackfilled: true, skillIndexComplete: true },
    generationIds: {},
  };
}

function emptySurface<T>(): SnapshotSurface<T> {
  return { status: 'empty', generationId: 'g1', data: null, errors: [], caveatIds: [] };
}

const GEN = 'gen-wp9';

function trunc(pop: number, emitted: number): FileSequencesV1['truncation']['coTouch'] {
  return {
    populationAvailable: pop, rowsEmitted: emitted, truncated: pop > emitted,
    limit: 10, paginationOrder: 'truncate-then-paginate',
  };
}

function sequencesBlock(): FileSequencesV1 {
  return {
    generationId: GEN,
    metadata: {
      coTouchWindowEvents: 10, coTouchWindowEventKinds: 'any-behavior-event',
      minSupportStreams: 3, predecessorMaxDistanceEvents: 5, topK: 10,
      entryBoundary: 'entry_uuid',
      eventOrdering: ['ts_ms', 'byte_offset', 'block_index', 'event_ordinal', 'id'],
      opClassification: 'file-coverage-access-mode-mapping',
      sessionBoundary: 'stream',
    },
    coTouch: [
      { pathA: '$WORKSPACE/src/a.ts', pathB: '$WORKSPACE/src/b.ts', streamsSupporting: 4, occurrences: 9 },
    ],
    predecessors: [
      { path: '$WORKSPACE/src/b.ts', predecessorPath: '$WORKSPACE/src/a.ts', streamsSupporting: 3, occurrences: 5 },
    ],
    associatedCommandFamilies: [
      { path: '$WORKSPACE/src/build.ts', commandFamily: 'npm-run', streamsSupporting: 3, occurrences: 7, generationId: GEN },
    ],
    attribution: { attributedStreams: 2, unattributedStreams: 5, byAgent: [{ dashboardAgentId: 'agent-A', streams: 2 }] },
    truncation: { coTouch: trunc(1, 1), predecessors: trunc(1, 1), associatedCommandFamilies: trunc(1, 1) },
  };
}

function snapshotWith(seq: FileSequencesV1 | undefined, capabilities: string[]): AnalyticsSnapshotV2 {
  const surfaces = {} as AnalyticsSnapshotV2['surfaces'];
  for (const k of SURFACE_KEYS) (surfaces as Record<SurfaceKey, SnapshotSurface<unknown>>)[k] = emptySurface();
  const data: OptimizerSurfaceData = {
    proposals: [], proposalDetails: {}, proposalEvidence: {}, clusterExemplars: {},
    fileHeatHot: [], fileHeatGuidanceGaps: [], analyzability: [], meta: null,
    ...(seq !== undefined ? { fileSequences: seq } : {}),
  };
  surfaces.optimizer = { status: 'ready', generationId: 'g-opt', data, errors: [], caveatIds: [] };
  const s: AnalyticsSnapshotV2 = {
    schemaVersion: 2,
    capabilities,
    snapshotId: '',
    captureStartedAtIso: '2026-07-22T00:00:00.000Z',
    captureCompletedAtIso: '2026-07-22T00:00:01.000Z',
    provenance: provenance(),
    caveats: [],
    surfaces,
  };
  s.snapshotId = computeSnapshotId(s);
  return s;
}

function model(): OverheadModel {
  return {
    workspaceId: 'ws-1', workspaceRoot: '/ws', pathType: 'wsl',
    generatedAt: 'x', estimatorMethod: 'chars-heuristic',
    agents: [{
      id: 'a1', name: 'A', kind: 'builtin-worker', lane: 'worker',
      workingDir: '/ws/.lares/workers/claude', pathType: 'wsl',
      inheritanceChain: [], mcpServers: [], flatSources: [],
      total: { tokens: 0, bytes: 0, chars: 0, method: 'chars-heuristic', approximate: true },
      totalHeaderView: { tokens: 0, bytes: 0, chars: 0, method: 'chars-heuristic', approximate: true },
      exactness: 'estimated', warnings: [],
      guidanceSources: [],
    }],
    globalWarnings: [],
  } as unknown as OverheadModel;
}

/** Minimal RFC-4180 line parser (quotes + escaped quotes) for round-trip asserts. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// ── capability contract ───────────────────────────────────────────────────────

test("'file-sequences' is a registered WP9 capability; schema stays v2 (no bump)", () => {
  assert.ok((SNAPSHOT_CAPABILITIES as readonly string[]).includes('file-sequences'));
  assert.equal(ANALYTICS_SCHEMA_VERSION, 2, 'WP9 adds v2-OPTIONAL fields — no version increment');
});

test('snapshotCapabilities declares file-sequences iff the block was BUILT', () => {
  const withBlock = snapshotCapabilities(model(), undefined, undefined, undefined, sequencesBlock());
  assert.ok(withBlock.includes('file-sequences'));
  const without = snapshotCapabilities(model(), undefined, undefined, undefined, null);
  assert.ok(!without.includes('file-sequences'), 'a failed/absent build honestly withholds the capability');
  const omitted = snapshotCapabilities(model());
  assert.ok(!omitted.includes('file-sequences'));
});

// ── tables/file-sequences.csv ─────────────────────────────────────────────────

test('file-sequences.csv renders all three kinds and round-trips row-faithfully', () => {
  const seq = sequencesBlock();
  const s = snapshotWith(seq, ['file-sequences']);
  const csv = renderSummaryTables(s)['file-sequences.csv'];
  assert.ok(csv, 'table present when the block exists');
  const lines = csv.trimEnd().split('\r\n');
  const header = parseCsvLine(lines[0]);
  assert.deepEqual(header, ['kind', 'path', 'related', 'streams_supporting', 'pair_count', 'generation_id', 'caveat_codes']);
  const rows = lines.slice(1).map(parseCsvLine);
  const col = (row: string[], name: string) => row[header.indexOf(name)];

  const co = rows.find((r) => col(r, 'kind') === 'co-touch')!;
  assert.deepEqual(
    [col(co, 'path'), col(co, 'related'), col(co, 'streams_supporting'), col(co, 'pair_count'), col(co, 'generation_id')],
    [seq.coTouch[0].pathA, seq.coTouch[0].pathB, '4', '9', GEN]);

  const pred = rows.find((r) => col(r, 'kind') === 'predecessor')!;
  assert.deepEqual(
    [col(pred, 'path'), col(pred, 'related'), col(pred, 'streams_supporting'), col(pred, 'pair_count')],
    [seq.predecessors[0].path, seq.predecessors[0].predecessorPath, '3', '5']);

  const fam = rows.find((r) => col(r, 'kind') === 'command-family')!;
  assert.deepEqual(
    [col(fam, 'path'), col(fam, 'related'), col(fam, 'streams_supporting'), col(fam, 'pair_count'), col(fam, 'generation_id')],
    [seq.associatedCommandFamilies[0].path, 'npm-run', '3', '7', GEN]);

  assert.equal(rows.length, 3, 'exactly one row per entry');
});

test('no fileSequences block → no file-sequences.csv (no fabricated empty table)', () => {
  const s = snapshotWith(undefined, []);
  assert.equal(renderSummaryTables(s)['file-sequences.csv'], undefined);
});

// ── redaction via the existing exporter path ──────────────────────────────────

test('the exporter belt redacts every real path vector inside a fileSequences block', () => {
  // WB-12: vectors mirror the REAL forms behavior_events paths take — drive
  // letter, WSL UNC, POSIX home — plus a slug-shaped token.
  const roots: RedactionRoots = {
    workspaceRoot: 'C:\\Users\\u\\Projects\\W',
    dashboardRoot: 'C:\\Users\\u\\Projects\\W\\.lares',
    homeDir: 'C:\\Users\\u',
  };
  const raw: FileSequencesV1 = {
    ...sequencesBlock(),
    coTouch: [
      { pathA: 'c:/users/u/projects/w/src/a.ts', pathB: 'c:/users/u/projects/w/src/b.ts', streamsSupporting: 3, occurrences: 3 },
      { pathA: '\\\\wsl.localhost\\Ubuntu\\home\\u\\x.ts', pathB: '/home/u/y.ts', streamsSupporting: 3, occurrences: 3 },
    ],
    predecessors: [
      { path: 'c:/users/u/projects/w/src/b.ts', predecessorPath: 'c:/users/u/projects/w/src/a.ts', streamsSupporting: 3, occurrences: 3 },
    ],
    associatedCommandFamilies: [
      { path: 'c:/users/u/projects/w/scripts/build.mjs', commandFamily: 'npm-run', streamsSupporting: 3, occurrences: 3, generationId: GEN },
    ],
  };
  const redacted = redactPathsDeep(raw, roots);
  const text = JSON.stringify(redacted);
  assert.ok(!/[A-Za-z]:[\\/]/.test(text), 'no drive-letter path survives');
  assert.ok(!text.includes('wsl.localhost'), 'no UNC path survives');
  assert.ok(!text.includes('/home/u/'), 'no POSIX home path survives');
  assert.ok(!text.toLowerCase().includes('users'), 'no username-bearing segment survives');
  // Structure survives — counts and identities are untouched.
  assert.equal(redacted.coTouch.length, 2);
  assert.equal(redacted.coTouch[0].streamsSupporting, 3);
  assert.equal(redacted.associatedCommandFamilies[0].generationId, GEN);
  // And the rendered CSV over the redacted block carries no absolute path either.
  const s = snapshotWith(redacted, ['file-sequences']);
  const csv = renderSummaryTables(s)['file-sequences.csv'];
  assert.ok(!/[A-Za-z]:[\\/]/.test(csv) && !csv.includes('wsl.localhost'), 'CSV is clean');
});

// ── WP6-shaped truncation disclosure ──────────────────────────────────────────

test('block truncation entries carry EXACTLY the WP6 TableTruncationMetaV1 field set', () => {
  // Structural mirror check: behavior-sequences must not drift from the WP6 shape.
  const wp6: TableTruncationMetaV1 = computeTableTruncation({
    fileHeatRowsEmitted: 0, fileHeatPopulation: 0, mcpByToolRowsEmitted: 0, mcpByToolPopulation: 0,
  })['file-heat.csv'];
  const blockMeta = sequencesBlock().truncation.coTouch;
  assert.deepEqual(Object.keys(blockMeta).sort(), Object.keys(wp6).sort());
});

test('computeTableTruncation gains a file-sequences.csv entry iff the block exists', () => {
  const seq = sequencesBlock();
  const withSeq = computeTableTruncation({
    fileHeatRowsEmitted: 0, fileHeatPopulation: 0, mcpByToolRowsEmitted: 0, mcpByToolPopulation: 0,
    fileSequences: seq,
  });
  const meta = withSeq['file-sequences.csv'];
  assert.ok(meta, 'entry present');
  assert.equal(meta.rowsEmitted, 3);
  assert.equal(meta.populationAvailable, 3);
  assert.equal(meta.truncated, false);
  assert.equal(meta.limit, 10);
  assert.equal(meta.paginationOrder, 'truncate-then-paginate');

  const without = computeTableTruncation({
    fileHeatRowsEmitted: 0, fileHeatPopulation: 0, mcpByToolRowsEmitted: 0, mcpByToolPopulation: 0,
    fileSequences: null,
  });
  assert.equal(without['file-sequences.csv'], undefined, 'no block → no entry');
});

// ── the deferral caveat ───────────────────────────────────────────────────────

test('TOOL_ERROR_RATES_UNAVAILABLE ships advisory on every snapshot and names the tool_name gap', () => {
  const conditions: CaveatConditions = {
    epochsBackfilled: true, skillIndexComplete: true, estimatorMethod: 'chars-heuristic',
    gitShaAvailable: true, clusterRollupProposalIds: [], unverifiedProposalIds: [],
    foreignStreamIdsDropped: 0, agentsMdSourcesWithoutCompleteCoverage: 0,
  };
  const caveat = buildCaveats(conditions).find((c) => c.id === 'TOOL_ERROR_RATES_UNAVAILABLE');
  assert.ok(caveat, 'caveat emitted unconditionally');
  assert.equal(caveat!.severity, 'advisory');
  assert.match(caveat!.statement, /tool_result/);
  assert.match(caveat!.statement, /tool_name/);
  assert.ok(caveat!.evidence.some((e) => e.file.includes('mcp-tool-usage-queries.ts')));
});

// ── golden round-trip refresh ─────────────────────────────────────────────────

test('golden round-trip: a v2 snapshot with fileSequences publishes + parses back intact', async () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp9-golden-'));
  try {
    const seq = sequencesBlock();
    const snap = snapshotWith(seq, ['surface-provenance', 'file-sequences']);
    const dir = await writeAnalyticsSnapshot(snap, { keep: 3, prune: false, allowCold: false, outputRoot: root });
    const back = readSnapshotFrom(dir) as AnalyticsSnapshotV2;
    assert.equal(back.schemaVersion, 2, 'schema stays v2 — no version bump');
    assert.ok(back.capabilities!.includes('file-sequences'), 'capability asserted in the golden snapshot');
    assert.deepEqual(back.surfaces.optimizer.data!.fileSequences, seq, 'the block round-trips byte-faithfully');
    const manifest = JSON.parse(fs.readFileSync(nodePath.join(dir, 'manifest.json'), 'utf8'));
    assert.ok(manifest.capabilities.includes('file-sequences'), 'manifest mirrors the contract');
    const csv = fs.readFileSync(nodePath.join(dir, 'tables', 'file-sequences.csv'), 'utf8');
    assert.match(csv.split('\r\n')[0], /kind,path,related,streams_supporting,pair_count,generation_id/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack || err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
