// WP5 (G5) — snapshot export of the section behavior axis: the
// 'section-behavior-status' capability (v2-OPTIONAL fields, schema stays v2 —
// no version bump), the overhead-DTO projection (behaviorStatus + per-cohort
// map survive; the path-bearing `sectionKey` join key is stripped),
// `tokensByBehavior`, the SUMMARY.md section, and a golden write→read refresh.
//   npm run build:main
//   node dist/main/main/analytics-export/section-behavior-export.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { ConfigWeightRollup, OverheadModel, SectionBehaviorRecord } from '../../shared/types';
import { annotateConfigWeight } from '../context-optimizer/section-liveness';
import { redactOverheadModel, type RedactedOverheadModelV1 } from '../context-overhead/overhead-dto';
import {
  ANALYTICS_SCHEMA_VERSION, SNAPSHOT_CAPABILITIES, computeSnapshotId,
  type AnalyticsSnapshotV2, type SnapshotProvenance, type SnapshotSurface, type SurfaceKey, SURFACE_KEYS,
} from './analytics-types';
import { renderSummaryMarkdown } from './analytics-render';
import { readSnapshotFrom, snapshotCapabilities, writeAnalyticsSnapshot } from './analytics-exporter';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

// ── fixtures ──────────────────────────────────────────────────────────────────

const WS = 'C:/ws';
const P = `${WS}/CLAUDE.md`;
const KEY = `markdown_section:${P}:h:guide>alpha`;

function rollup(withBehavior: boolean): ConfigWeightRollup {
  const base: ConfigWeightRollup = {
    sections: [{
      sourcePath: P, sourceLabel: 'CLAUDE.md', scope: 'agent',
      heading: 'Alpha', startLine: 5, endLine: 8, tokens: 40,
      weightClass: 'structurally-broken',
      evidence: ['references ./gone.md — file not found'],
      sectionKey: KEY,
    }],
    tokensByClass: {
      live: 0, dead: 0, 'structurally-broken': 40,
      'insufficient-evidence': 0, unobservable: 0, 'not-analyzed': 0,
    },
  };
  if (!withBehavior) return base;
  const records: SectionBehaviorRecord[] = [{
    sectionKey: KEY,
    behaviorStatus: 'mixed',
    behaviorStatusByCohort: { claude: 'live', codex: 'insufficient-evidence' },
    nodeCounts: { total: 2, observed: 1, deadFailClosed: 0, unobservable: 0, captureIncomplete: 0, unpaired: 0 },
  }];
  return annotateConfigWeight(base, records).rollup;
}

function model(withBehavior: boolean): OverheadModel {
  return {
    workspaceId: 'ws-1', workspaceRoot: WS, pathType: 'windows',
    generatedAt: '2026-07-21T00:00:00.000Z', estimatorMethod: 'chars-heuristic',
    agents: [{
      id: 'a1', name: 'A', kind: 'builtin-worker', lane: 'worker',
      workingDir: `${WS}/.lares/workers/claude`, pathType: 'windows',
      inheritanceChain: [], mcpServers: [], flatSources: [],
      total: { tokens: 40, bytes: 0, chars: 0, method: 'chars-heuristic', approximate: true },
      totalHeaderView: { tokens: 40, bytes: 0, chars: 0, method: 'chars-heuristic', approximate: true },
      configWeight: rollup(withBehavior),
      exactness: 'estimated', warnings: [],
      guidanceSources: [],
    }],
    workspaceConfigWeight: rollup(withBehavior),
    globalWarnings: [],
  } as unknown as OverheadModel;
}

const ROOTS = { workspaceRoot: WS, dashboardRoot: `${WS}/.lares`, homeDir: 'C:/Users/u' };

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

function snapshotWith(overhead: RedactedOverheadModelV1, capabilities: string[]): AnalyticsSnapshotV2 {
  const surfaces = {} as AnalyticsSnapshotV2['surfaces'];
  for (const k of SURFACE_KEYS) (surfaces as Record<SurfaceKey, SnapshotSurface<unknown>>)[k] = emptySurface();
  surfaces.contextOverhead = {
    status: 'ready', generationId: 'g-oh', data: overhead, errors: [], caveatIds: [],
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

// ── capability contract ───────────────────────────────────────────────────────

test("'section-behavior-status' is a registered WP5 capability; schema stays v2 (no bump)", () => {
  assert.ok((SNAPSHOT_CAPABILITIES as readonly string[]).includes('section-behavior-status'));
  assert.equal(ANALYTICS_SCHEMA_VERSION, 2, 'WP5 adds v2-OPTIONAL fields — no version increment');
});

test('snapshotCapabilities declares section-behavior-status iff a section is POPULATED with a behaviorStatus', () => {
  const withB = snapshotCapabilities(model(true));
  assert.ok(withB.includes('section-behavior-status'));
  const withoutB = snapshotCapabilities(model(false));
  assert.ok(!withoutB.includes('section-behavior-status'),
    'un-annotated sections honestly withhold the capability');
});

// ── DTO projection: both axes survive, the join key does not ──────────────────

test('redactOverheadModel: behaviorStatus + per-cohort map + tokensByBehavior survive; sectionKey is stripped', () => {
  const red = redactOverheadModel(model(true), ROOTS);
  const section = red.agents[0].configWeight!.sections[0] as unknown as Record<string, unknown>;
  assert.equal(section.weightClass, 'structurally-broken', 'structural axis untouched');
  assert.equal(section.behaviorStatus, 'mixed', 'behavior axis exported beside it');
  assert.deepEqual(section.behaviorStatusByCohort, { claude: 'live', codex: 'insufficient-evidence' },
    'per-cohort map always exported');
  assert.ok(!('sectionKey' in section), 'the path-bearing join key never crosses the boundary');
  const tb = red.workspaceConfigWeight!.tokensByBehavior!;
  assert.equal(tb.mixed, 40);
  assert.equal(tb.dead, 0);
  // No absolute path anywhere in the serialized surface.
  assert.ok(!JSON.stringify(red).includes('C:/ws'), 'no absolute workspace path in the redacted model');
});

// ── SUMMARY.md section ────────────────────────────────────────────────────────

test('SUMMARY.md renders the behavior rollup when the capability is declared, and omits it otherwise', () => {
  const withB = snapshotWith(redactOverheadModel(model(true), ROOTS), ['section-behavior-status']);
  const md = renderSummaryMarkdown(withB);
  assert.match(md, /Config section behavior status/);
  assert.match(md, /\| mixed \| 40 \|/);
  assert.match(md, /absence is never deadness/i);

  const withoutB = snapshotWith(redactOverheadModel(model(false), ROOTS), []);
  assert.ok(!renderSummaryMarkdown(withoutB).includes('Config section behavior status'),
    'no capability → no section (never an implied all-not-analyzed table)');
});

// ── golden round-trip refresh ─────────────────────────────────────────────────

test('golden round-trip: a v2 snapshot with the behavior axis publishes + parses back intact', async () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wp5-golden-'));
  try {
    const snap = snapshotWith(redactOverheadModel(model(true), ROOTS), ['section-behavior-status']);
    const dir = await writeAnalyticsSnapshot(snap, { keep: 3, prune: false, allowCold: false, outputRoot: root });
    const back = readSnapshotFrom(dir) as AnalyticsSnapshotV2;
    assert.equal(back.schemaVersion, 2, 'schema stays v2 — no version bump');
    assert.ok(back.capabilities!.includes('section-behavior-status'), 'capability asserted in the golden snapshot');
    const section = back.surfaces.contextOverhead.data!.agents[0].configWeight!.sections[0] as unknown as Record<string, unknown>;
    assert.equal(section.behaviorStatus, 'mixed');
    assert.equal(section.weightClass, 'structurally-broken', 'both axes round-trip');
    assert.ok(!('sectionKey' in section), 'the join key is absent from the published artifact');
    const manifest = JSON.parse(fs.readFileSync(nodePath.join(dir, 'manifest.json'), 'utf8'));
    assert.ok(manifest.capabilities.includes('section-behavior-status'), 'manifest mirrors the contract');
    const summary = fs.readFileSync(nodePath.join(dir, 'SUMMARY.md'), 'utf8');
    assert.match(summary, /Config section behavior status/);
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
