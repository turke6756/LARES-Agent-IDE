// WP3 (G3) — snapshot export of recommendation drafts: the 'recommendation-drafts'
// capability (v2-OPTIONAL fields, schema stays v2 — no version bump), the
// proposals.csv columns (target_file / target_status / claim / evidence_kinds /
// human_review_required), CSV round-trip, and a golden write→read round-trip.
//   npm run build:main
//   node dist/main/main/analytics-export/recommendation-drafts-export.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { OverheadModel, RecommendationDraft } from '../../shared/types';
import {
  ANALYTICS_SCHEMA_VERSION, SNAPSHOT_CAPABILITIES, computeSnapshotId,
  type AnalyticsSnapshotV2, type OptimizerSurfaceData, type SnapshotProvenance,
  type SnapshotSurface, type SurfaceKey, SURFACE_KEYS,
} from './analytics-types';
import { renderSummaryTables } from './analytics-render';
import { readSnapshotFrom, snapshotCapabilities, writeAnalyticsSnapshot } from './analytics-exporter';

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

const FILE_DRAFT: RecommendationDraft = {
  target: { file: '$WORKSPACE/AGENTS.md' },
  claim: 'Agents touched $WORKSPACE/src/app.ts across 2 stream(s) (4 reads, 3 writes, 0 executes); 2 guidance path prediction(s) were tested against it and 0 matched.',
  evidence: [
    { kind: 'file-heat', rowIds: ['hash-app'], generationId: 'gen-1' },
    { kind: 'coverage-check', rowIds: ['hash-app'], generationId: 'gen-1' },
  ],
  humanReviewRequired: true,
};

const UNRESOLVED_DRAFT: RecommendationDraft = {
  target: { unresolved: true, reason: 'command_family evidence supports only workspace-level candidates' },
  claim: "The command family 'git status' ran 3 time(s) across 2 stream(s); no guidance node covers it.",
  evidence: [{ kind: 'command_family', rowIds: ['add-cluster:supervisor:command_family:git status'], generationId: 'gen-1' }],
  humanReviewRequired: true,
};

function proposal(id: string, draft?: RecommendationDraft): Record<string, unknown> {
  return {
    id, kind: 'add-missing-guidance', title: `t-${id}`, lane: 'supervisor',
    confidence: 'inferred', actionability: 'actionable',
    verification: { verified: false, state: 'unverified' },
    residentTokenDelta: { estimate: 0 }, tokenTurnsWeight: 0, evidenceState: 'unavailable',
    ...(draft ? { recommendationDraft: draft } : {}),
  };
}

function optimizerData(proposals: Record<string, unknown>[]): OptimizerSurfaceData {
  return {
    proposals, proposalDetails: {}, proposalEvidence: {}, clusterExemplars: {},
    fileHeatHot: [], fileHeatGuidanceGaps: [], analyzability: [], meta: null,
  };
}

function snapshotWith(proposals: Record<string, unknown>[], capabilities: string[]): AnalyticsSnapshotV2 {
  const surfaces = {} as AnalyticsSnapshotV2['surfaces'];
  for (const k of SURFACE_KEYS) (surfaces as Record<SurfaceKey, SnapshotSurface<unknown>>)[k] = emptySurface();
  surfaces.optimizer = {
    status: 'ready', generationId: 'g-opt', data: optimizerData(proposals), errors: [], caveatIds: [],
  };
  const s: AnalyticsSnapshotV2 = {
    schemaVersion: 2,
    capabilities,
    snapshotId: '',
    captureStartedAtIso: '2026-07-21T00:00:00.000Z',
    captureCompletedAtIso: '2026-07-21T00:00:01.000Z',
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

test("'recommendation-drafts' is a registered WP3 capability; schema stays v2 (no bump)", () => {
  assert.ok((SNAPSHOT_CAPABILITIES as readonly string[]).includes('recommendation-drafts'));
  assert.equal(ANALYTICS_SCHEMA_VERSION, 2, 'WP3 adds v2-OPTIONAL fields — no version increment');
});

test('snapshotCapabilities declares recommendation-drafts iff a draft is POPULATED', () => {
  const withDraft = snapshotCapabilities(model(), { proposals: [proposal('p1', FILE_DRAFT)] });
  assert.ok(withDraft.includes('recommendation-drafts'));
  const withoutDraft = snapshotCapabilities(model(), { proposals: [proposal('p1')] });
  assert.ok(!withoutDraft.includes('recommendation-drafts'),
    'draft-less proposals honestly withhold the capability');
  const noOptimizer = snapshotCapabilities(model());
  assert.ok(!noOptimizer.includes('recommendation-drafts'));
});

// ── proposals.csv columns + round-trip ────────────────────────────────────────

test('proposals.csv gains the five WP3 columns', () => {
  const s = snapshotWith([proposal('p1', FILE_DRAFT)], ['recommendation-drafts']);
  const csv = renderSummaryTables(s)['proposals.csv'];
  const header = parseCsvLine(csv.split('\r\n')[0]);
  for (const col of ['target_file', 'target_status', 'claim', 'evidence_kinds', 'human_review_required']) {
    assert.ok(header.includes(col), `header has ${col}`);
  }
});

test('CSV round-trip: file-targeted, unresolved, and draft-less rows all render faithfully', () => {
  const s = snapshotWith([
    proposal('p-file', FILE_DRAFT),
    proposal('p-ws', UNRESOLVED_DRAFT),
    proposal('p-none'),
  ], ['recommendation-drafts']);
  const csv = renderSummaryTables(s)['proposals.csv'];
  const lines = csv.trimEnd().split('\r\n');
  const header = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);
  const col = (row: string[], name: string) => row[header.indexOf(name)];

  const fileRow = rows.find((r) => col(r, 'proposal_id') === 'p-file')!;
  assert.equal(col(fileRow, 'target_file'), '$WORKSPACE/AGENTS.md');
  assert.equal(col(fileRow, 'target_status'), 'file');
  assert.equal(col(fileRow, 'claim'), FILE_DRAFT.claim, 'the claim survives CSV quoting round-trip');
  assert.equal(col(fileRow, 'evidence_kinds'), 'coverage-check file-heat');
  assert.equal(col(fileRow, 'human_review_required'), 'true');

  const wsRow = rows.find((r) => col(r, 'proposal_id') === 'p-ws')!;
  assert.equal(col(wsRow, 'target_file'), '', 'an unresolved target names NO file');
  assert.equal(col(wsRow, 'target_status'), 'unresolved');
  assert.equal(col(wsRow, 'evidence_kinds'), 'command_family');
  assert.equal(col(wsRow, 'human_review_required'), 'true');

  const noneRow = rows.find((r) => col(r, 'proposal_id') === 'p-none')!;
  for (const c of ['target_file', 'target_status', 'claim', 'evidence_kinds', 'human_review_required']) {
    assert.equal(col(noneRow, c), '', `draft-less row leaves ${c} empty (v2-OPTIONAL)`);
  }
});

// ── golden round-trip refresh ─────────────────────────────────────────────────

test('golden round-trip: a v2 snapshot with recommendation drafts publishes + parses back intact', async () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp3-golden-'));
  try {
    const snap = snapshotWith([proposal('p1', FILE_DRAFT)], ['agents-md-sources', 'recommendation-drafts']);
    const dir = await writeAnalyticsSnapshot(snap, { keep: 3, prune: false, allowCold: false, outputRoot: root });
    const back = readSnapshotFrom(dir) as AnalyticsSnapshotV2;
    assert.equal(back.schemaVersion, 2, 'schema stays v2 — no version bump');
    assert.ok(back.capabilities!.includes('recommendation-drafts'), 'capability asserted in the golden snapshot');
    const p = (back.surfaces.optimizer.data!.proposals as Array<Record<string, unknown>>)
      .find((x) => x.id === 'p1')!;
    assert.deepEqual(p.recommendationDraft, FILE_DRAFT, 'the draft round-trips byte-faithfully');
    const manifest = JSON.parse(fs.readFileSync(nodePath.join(dir, 'manifest.json'), 'utf8'));
    assert.ok(manifest.capabilities.includes('recommendation-drafts'), 'manifest mirrors the contract');
    const proposalsCsv = fs.readFileSync(nodePath.join(dir, 'tables', 'proposals.csv'), 'utf8');
    assert.match(proposalsCsv.split('\r\n')[0], /target_file,target_status,claim,evidence_kinds,human_review_required/);
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
