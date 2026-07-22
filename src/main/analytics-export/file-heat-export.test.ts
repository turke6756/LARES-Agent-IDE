// WP6 (G6) — file-heat semantics + columns + truncation metadata:
// the 'file-heat-extended' capability (v2-OPTIONAL, schema stays v2 — no version
// bump), the new file-heat.csv columns (role_reason, score, score_reads,
// score_writes, score_executes, operational_noise, hot_uncovered), CSV round-trip
// with NO comment lines, per-table truncation metadata in manifest.json + surface
// provenance ({ populationAvailable, rowsEmitted, truncated, limit,
// paginationOrder } with the before-WP15 paginationOrder values), the SUMMARY.md
// truncation section, and a golden write→read refresh.
//   npm run build:main
//   node dist/main/main/analytics-export/file-heat-export.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { OverheadModel } from '../../shared/types';
import { classifyFileCoverage, type ClassifyDeps, type FileTouch } from '../context-optimizer/file-coverage';
import { OPTIMIZER_CONFIG } from '../context-optimizer/optimizer-config';
import { AGENT_DTO_CAPS } from '../context-optimizer/agent-dto';
import {
  ANALYTICS_SCHEMA_VERSION, SNAPSHOT_CAPABILITIES, SURFACE_KEYS, computeSnapshotId,
  type AnalyticsSnapshotV2, type SnapshotProvenance, type SnapshotSurface, type SurfaceKey,
  type TableTruncationMetaV1,
} from './analytics-types';
import { renderSummaryMarkdown, renderSummaryTables } from './analytics-render';
import {
  computeTableTruncation, readSnapshotFrom, snapshotCapabilities, writeAnalyticsSnapshot,
} from './analytics-exporter';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

// ── fixtures ──────────────────────────────────────────────────────────────────

const WS = 'C:/ws';

function model(): OverheadModel {
  return {
    workspaceId: 'ws-1', workspaceRoot: WS, pathType: 'windows',
    generatedAt: '2026-07-21T00:00:00.000Z', estimatorMethod: 'chars-heuristic',
    agents: [], globalWarnings: [],
  } as unknown as OverheadModel;
}

/** One redacted file-heat DTO row as the optimizer surface stores it. */
function heatRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pathHash: 'h-aaaa', pathDisplay: '$WORKSPACE/src/foo.ts', pathScope: 'workspace',
    lane: 'worker', coverage: 'uncovered',
    reads: 4, writes: 1, executes: 2, distinctStreams: 3, uncovered: true,
    role: 'product-source', roleReason: 'source extension under the workspace root',
    operationalNoise: false,
    score: 12, scoreComponents: { reads: 4, writes: 1, executes: 2, distinctStreams: 3 },
    guidanceGapCandidate: false, hotUncoveredCandidate: true,
    ...over,
  };
}

function provenance(tableTruncation?: Record<string, TableTruncationMetaV1>): SnapshotProvenance {
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
    ...(tableTruncation ? { tableTruncation } : {}),
  };
}

function emptySurface<T>(): SnapshotSurface<T> {
  return { status: 'empty', generationId: 'g1', data: null, errors: [], caveatIds: [] };
}

function snapshotWith(opts: {
  fileHeatHot?: Record<string, unknown>[];
  capabilities?: string[];
  tableTruncation?: Record<string, TableTruncationMetaV1>;
}): AnalyticsSnapshotV2 {
  const surfaces = {} as AnalyticsSnapshotV2['surfaces'];
  for (const k of SURFACE_KEYS) (surfaces as Record<SurfaceKey, SnapshotSurface<unknown>>)[k] = emptySurface();
  if (opts.fileHeatHot) {
    surfaces.optimizer = {
      status: 'ready', generationId: 'g-opt',
      data: {
        proposals: [], proposalDetails: {}, proposalEvidence: {}, clusterExemplars: {},
        fileHeatHot: opts.fileHeatHot, fileHeatGuidanceGaps: [], analyzability: [], meta: null,
      },
      errors: [], caveatIds: [],
    };
  }
  const s: AnalyticsSnapshotV2 = {
    schemaVersion: 2,
    capabilities: opts.capabilities ?? [],
    snapshotId: '',
    captureStartedAtIso: '2026-07-21T00:00:00.000Z',
    captureCompletedAtIso: '2026-07-21T00:00:01.000Z',
    provenance: provenance(opts.tableTruncation),
    caveats: [],
    surfaces,
  };
  s.snapshotId = computeSnapshotId(s);
  return s;
}

const TRUNC: Record<string, TableTruncationMetaV1> = {
  'file-heat.csv': {
    populationAvailable: 25, rowsEmitted: 20, truncated: true,
    limit: 20, paginationOrder: 'truncate-then-paginate',
  },
  'mcp-tool-usage.csv': {
    populationAvailable: 15, rowsEmitted: 15, truncated: false,
    limit: 15, paginationOrder: 'single-object-truncated',
  },
};

/** Minimal RFC-4180 line splitter for assertion purposes (fixture cells carry no
 *  embedded CR/LF, so splitting records on CRLF is safe here). */
function csvLines(csv: string): string[] {
  return csv.split('\r\n').filter((l) => l.length > 0);
}

const WP6_COLUMNS = [
  'role_reason', 'score', 'score_reads', 'score_writes', 'score_executes',
  'operational_noise', 'hot_uncovered',
];

// ── capability contract ───────────────────────────────────────────────────────

test("'file-heat-extended' is a registered WP6 capability; schema stays v2 (no bump)", () => {
  assert.ok((SNAPSHOT_CAPABILITIES as readonly string[]).includes('file-heat-extended'));
  assert.equal(ANALYTICS_SCHEMA_VERSION, 2, 'WP6 adds v2-OPTIONAL fields — no version increment');
});

test('snapshotCapabilities declares file-heat-extended iff a heat row is POPULATED with role/score', () => {
  const withHeat = snapshotCapabilities(model(), {
    proposals: [], fileHeat: [{ role: 'product-source', score: 12 }],
  });
  assert.ok(withHeat.includes('file-heat-extended'));
  const emptyHeat = snapshotCapabilities(model(), { proposals: [], fileHeat: [] });
  assert.ok(!emptyHeat.includes('file-heat-extended'), 'an empty rollup honestly withholds the capability');
  const preP4 = snapshotCapabilities(model(), {
    proposals: [], fileHeat: [{}],   // pre-Phase-4 row: raw counts only, no role/score
  });
  assert.ok(!preP4.includes('file-heat-extended'), 'possible-but-unpopulated fields withhold the capability');
  const noOpt = snapshotCapabilities(model());
  assert.ok(!noOpt.includes('file-heat-extended'));
});

// ── engine population disclosure (fixture larger than FILE_HEAT_TOP_N) ────────

test('classifyFileCoverage discloses the pre-slice populationSize on a fixture larger than FILE_HEAT_TOP_N', () => {
  const deps: ClassifyDeps = { classifyPathMutability: () => 'user-owned' };
  const n = OPTIMIZER_CONFIG.FILE_HEAT_TOP_N + 5;
  const touches: FileTouch[] = Array.from({ length: n }, (_, i) => ({
    path: `/w/src/f${i}.ts`, reads: i + 1, writes: 0, executes: 0, distinctStreams: 1,
  }));
  const r = classifyFileCoverage('worker', touches, [], [], [], deps);
  assert.equal(r.populationSize, n, 'population BEFORE the slice');
  assert.equal(r.fileHeat.length, OPTIMIZER_CONFIG.FILE_HEAT_TOP_N, 'the slice itself');
  assert.ok(r.populationSize! > r.fileHeat.length, 'the truncation is visible, not silent');
});

// ── computeTableTruncation ────────────────────────────────────────────────────

test('computeTableTruncation: file-heat truncated when population exceeds rows emitted (before-WP15 order)', () => {
  const t = computeTableTruncation({
    fileHeatRowsEmitted: 20, fileHeatPopulation: 25,
    mcpByToolRowsEmitted: 15, mcpByToolPopulation: 18,
  });
  assert.deepEqual(t['file-heat.csv'], {
    populationAvailable: 25, rowsEmitted: 20, truncated: true,
    limit: OPTIMIZER_CONFIG.FILE_HEAT_TOP_N, paginationOrder: 'truncate-then-paginate',
  });
  assert.deepEqual(t['mcp-tool-usage.csv'], {
    populationAvailable: 18, rowsEmitted: 15, truncated: true,
    limit: AGENT_DTO_CAPS.mcp_tool_usage.topTools, paginationOrder: 'single-object-truncated',
  });
});

test('computeTableTruncation: full population reads truncated:false — never conflatable with a capped table', () => {
  const t = computeTableTruncation({
    fileHeatRowsEmitted: 7, fileHeatPopulation: 7,
    mcpByToolRowsEmitted: 3, mcpByToolPopulation: 3,
  });
  assert.equal(t['file-heat.csv'].truncated, false);
  assert.equal(t['mcp-tool-usage.csv'].truncated, false);
  // The paginationOrder still says HOW the rows were produced — a reader can
  // always tell this exporter shape from a WP15 full drain.
  assert.equal(t['file-heat.csv'].paginationOrder, 'truncate-then-paginate');
  assert.equal(t['mcp-tool-usage.csv'].paginationOrder, 'single-object-truncated');
});

test('computeTableTruncation: an undisclosed file-heat population is null/null — unknown is not "not truncated"', () => {
  const t = computeTableTruncation({
    fileHeatRowsEmitted: 20, fileHeatPopulation: undefined,
    mcpByToolRowsEmitted: 15, mcpByToolPopulation: 15,
  });
  assert.equal(t['file-heat.csv'].populationAvailable, null);
  assert.equal(t['file-heat.csv'].truncated, null);
});

// ── CSV round-trip: columns present, NO comment lines ─────────────────────────

test('file-heat.csv carries the WP6 columns and round-trips values; no `#` lines in ANY table', () => {
  const s = snapshotWith({
    fileHeatHot: [
      heatRow(),
      heatRow({
        pathHash: 'h-bbbb', pathDisplay: '$WORKSPACE/dist/bundle.js',
        role: 'build-generated', roleReason: 'built artifact under dist/',
        operationalNoise: true, hotUncoveredCandidate: false,
        reads: 9, writes: 0, executes: 0, distinctStreams: 4,
        score: 9, scoreComponents: { reads: 9, writes: 0, executes: 0, distinctStreams: 4 },
      }),
      // Pre-Phase-4 row: extended cells stay EMPTY (unknown), never zeros.
      heatRow({
        pathHash: 'h-cccc', pathDisplay: '$WORKSPACE/old.ts',
        role: undefined, roleReason: undefined, operationalNoise: undefined,
        score: undefined, scoreComponents: undefined,
        guidanceGapCandidate: undefined, hotUncoveredCandidate: undefined,
      }),
    ],
    capabilities: ['file-heat-extended'],
    tableTruncation: TRUNC,
  });
  const tables = renderSummaryTables(s);

  for (const [name, csv] of Object.entries(tables)) {
    for (const line of csvLines(csv)) {
      assert.ok(!line.startsWith('#'), `${name}: comment line leaked into CSV: ${line}`);
    }
  }

  const lines = csvLines(tables['file-heat.csv']);
  const header = lines[0].split(',');
  for (const col of WP6_COLUMNS) assert.ok(header.includes(col), `missing column ${col}`);
  const idx = (c: string) => header.indexOf(c);

  const row = lines[1].split(',');
  assert.equal(row[idx('role_reason')], 'source extension under the workspace root');
  assert.equal(row[idx('score')], '12');
  assert.equal(row[idx('score_reads')], '4');
  assert.equal(row[idx('score_writes')], '1');
  assert.equal(row[idx('score_executes')], '2');
  // score = executes×3 + writes×2 + reads — checkable per row from its own cells.
  assert.equal(
    Number(row[idx('score_executes')]) * 3 + Number(row[idx('score_writes')]) * 2 + Number(row[idx('score_reads')]),
    Number(row[idx('score')]));
  assert.equal(row[idx('operational_noise')], 'false');
  assert.equal(row[idx('hot_uncovered')], 'true');

  const noise = lines[2].split(',');
  assert.equal(noise[idx('operational_noise')], 'true');
  assert.equal(noise[idx('hot_uncovered')], 'false');

  const preP4 = lines[3].split(',');
  for (const col of WP6_COLUMNS) assert.equal(preP4[idx(col)], '', `${col} must be empty (unknown), not a zero`);
});

// ── SUMMARY.md prints the truncation metadata ─────────────────────────────────

test('SUMMARY.md prints the per-table truncation metadata, and omits the section when absent', () => {
  const md = renderSummaryMarkdown(snapshotWith({ tableTruncation: TRUNC }));
  assert.match(md, /## Table truncation/);
  assert.match(md, /\| file-heat\.csv \| 25 \| 20 \| true \| 20 \| `truncate-then-paginate` \|/);
  assert.match(md, /\| mcp-tool-usage\.csv \| 15 \| 15 \| false \| 15 \| `single-object-truncated` \|/);

  const unknown = renderSummaryMarkdown(snapshotWith({
    tableTruncation: {
      'file-heat.csv': {
        populationAvailable: null, rowsEmitted: 20, truncated: null,
        limit: 20, paginationOrder: 'truncate-then-paginate',
      },
    },
  }));
  assert.match(unknown, /\| file-heat\.csv \| _unknown_ \| 20 \| _unknown_ \| 20 \|/,
    'an undisclosed population prints as unknown, never as not-truncated');

  const without = renderSummaryMarkdown(snapshotWith({}));
  assert.ok(!without.includes('## Table truncation'), 'no metadata → no section (older v2 snapshots)');
});

// ── golden round-trip refresh ─────────────────────────────────────────────────

test('golden round-trip: capability + truncation metadata + columns survive publish → read', async () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp6-golden-'));
  try {
    const snap = snapshotWith({
      fileHeatHot: [heatRow()],
      capabilities: ['file-heat-extended'],
      tableTruncation: TRUNC,
    });
    const dir = await writeAnalyticsSnapshot(snap, { keep: 3, prune: false, allowCold: false, outputRoot: root });
    const back = readSnapshotFrom(dir) as AnalyticsSnapshotV2;
    assert.equal(back.schemaVersion, 2, 'schema stays v2 — no version bump');
    assert.ok(back.capabilities!.includes('file-heat-extended'), 'capability asserted in the golden snapshot');
    assert.deepEqual(back.provenance.tableTruncation, TRUNC, 'surface provenance carries the metadata');

    const manifest = JSON.parse(fs.readFileSync(nodePath.join(dir, 'manifest.json'), 'utf8'));
    assert.ok(manifest.capabilities.includes('file-heat-extended'), 'manifest mirrors the contract');
    assert.deepEqual(manifest.tableTruncation, TRUNC, 'manifest carries the per-table metadata');

    const summary = fs.readFileSync(nodePath.join(dir, 'SUMMARY.md'), 'utf8');
    assert.match(summary, /## Table truncation/);

    const csv = fs.readFileSync(nodePath.join(dir, 'tables', 'file-heat.csv'), 'utf8');
    const header = csvLines(csv)[0].split(',');
    for (const col of WP6_COLUMNS) assert.ok(header.includes(col), `published CSV missing ${col}`);
    for (const line of csvLines(csv)) assert.ok(!line.startsWith('#'), 'no comment lines in the published CSV');
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
