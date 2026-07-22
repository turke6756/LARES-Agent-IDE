// WP-S — schema v2 migration tests: golden round-trip, v1→v2 diff adapter with
// the SCHEMA_ADAPTED_V1_V2 disclosure, CAPABILITY_MISMATCH, unknown-version
// refusal, and the WP2 capability + caveat wiring.
//   npm run build:main
//   node dist/main/main/analytics-export/analytics-schema-v2.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import {
  ANALYTICS_SCHEMA_VERSION, SNAPSHOT_CAPABILITIES, computeSnapshotId,
  type AnalyticsSnapshotV1, type AnalyticsSnapshotV2, type SnapshotProvenance,
  type SnapshotSurface, type SurfaceKey, SURFACE_KEYS,
} from './analytics-types';
import {
  adaptV1ToV2, diffAnalyticsSnapshots, renderDiffMarkdown, SnapshotDiffError,
} from './analytics-diff';
import {
  countAnalyzedAgentsMdWithoutCompleteCoverage, readSnapshotFrom,
  snapshotCapabilities, writeAnalyticsSnapshot,
} from './analytics-exporter';
import { buildCaveats, CAVEAT_IDS, type CaveatConditions } from './analytics-caveats';
import type { GuidanceSource, OverheadModel } from '../../shared/types';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }

// ── minimal snapshot builders ─────────────────────────────────────────────────

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

function v2Snapshot(over: Partial<AnalyticsSnapshotV2> = {}): AnalyticsSnapshotV2 {
  const surfaces = {} as AnalyticsSnapshotV2['surfaces'];
  for (const k of SURFACE_KEYS) (surfaces as Record<SurfaceKey, SnapshotSurface<unknown>>)[k] = emptySurface();
  const s: AnalyticsSnapshotV2 = {
    schemaVersion: 2,
    capabilities: ['agents-md-sources'],
    snapshotId: '',
    captureStartedAtIso: '2026-07-21T00:00:00.000Z',
    captureCompletedAtIso: '2026-07-21T00:00:01.000Z',
    provenance: provenance(),
    caveats: [],
    surfaces,
    ...over,
  };
  s.snapshotId = computeSnapshotId(s);
  return s;
}

function v1Snapshot(): AnalyticsSnapshotV1 {
  const { schemaVersion: _v, capabilities: _c, ...rest } = v2Snapshot();
  const s = { ...rest, schemaVersion: 1 as const };
  s.snapshotId = computeSnapshotId({ ...s, schemaVersion: 2 });
  return s;
}

// ── the version constant itself ───────────────────────────────────────────────

test('exactly one version increment: the program-wide schema version is 2', () => {
  assert.equal(ANALYTICS_SCHEMA_VERSION, 2);
  assert.ok((SNAPSHOT_CAPABILITIES as readonly string[]).includes('agents-md-sources'));
});

// ── golden round-trip: write → read → assert ─────────────────────────────────

test('golden round-trip: a published v2 snapshot parses back with version + capability intact', async () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'wps-golden-'));
  try {
    const snap = v2Snapshot();
    const dir = await writeAnalyticsSnapshot(snap, { keep: 3, prune: false, allowCold: false, outputRoot: root });
    const back = readSnapshotFrom(dir);
    assert.equal(back.schemaVersion, 2);
    assert.deepEqual((back as AnalyticsSnapshotV2).capabilities, ['agents-md-sources'],
      'the WP2 capability is asserted present in the golden snapshot');
    assert.equal(back.snapshotId, snap.snapshotId);
    // The manifest mirrors the contract at schemaVersion 2.
    const manifest = JSON.parse(fs.readFileSync(nodePath.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 2);
    assert.deepEqual(manifest.capabilities, ['agents-md-sources']);
    // SUMMARY.md declares the contract for human readers too.
    const summary = fs.readFileSync(nodePath.join(dir, 'SUMMARY.md'), 'utf8');
    assert.match(summary, /capabilities: .*agents-md-sources/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── diff: v1 adapts, v2↔v2 clean, mismatch disclosed, v3 refused ─────────────

test('adaptV1ToV2 lifts the common fields and declares an empty contract', () => {
  const v1 = v1Snapshot();
  const lifted = adaptV1ToV2(v1);
  assert.equal(lifted.schemaVersion, 2);
  assert.deepEqual(lifted.capabilities, []);
  assert.equal(lifted.snapshotId, v1.snapshotId);
  assert.deepEqual(Object.keys(lifted.surfaces).sort(), [...SURFACE_KEYS].sort());
});

test('a v1 snapshot diffs against a v2 export THROUGH the adapter, with the disclosed note', () => {
  const d = diffAnalyticsSnapshots(v1Snapshot(), v2Snapshot());
  assert.equal(d.provenance.schemaAdaptation?.note, 'SCHEMA_ADAPTED_V1_V2');
  assert.equal(d.provenance.schemaAdaptation?.beforeSchemaVersion, 1);
  assert.equal(d.provenance.schemaAdaptation?.afterSchemaVersion, 2);
  // The adapted path never claims a capability mismatch — the adaptation note covers it.
  assert.equal(d.provenance.capabilities?.mismatch, false);
  const md = renderDiffMarkdown(d);
  assert.match(md, /SCHEMA_ADAPTED_V1_V2/);
});

test('v2 ↔ v2 with the SAME contract diffs clean — no adaptation, no mismatch', () => {
  const d = diffAnalyticsSnapshots(v2Snapshot(), v2Snapshot());
  assert.equal(d.provenance.schemaAdaptation, undefined);
  assert.equal(d.provenance.capabilities?.mismatch, false);
  assert.equal(d.provenance.capabilities?.note, undefined);
});

test('two v2 snapshots with DIFFERENT contracts disclose CAPABILITY_MISMATCH', () => {
  const d = diffAnalyticsSnapshots(
    v2Snapshot({ capabilities: [] }),
    v2Snapshot({ capabilities: ['agents-md-sources'] }));
  assert.equal(d.provenance.capabilities?.mismatch, true);
  assert.equal(d.provenance.capabilities?.note, 'CAPABILITY_MISMATCH');
  assert.deepEqual(d.provenance.capabilities?.after, ['agents-md-sources']);
  assert.match(renderDiffMarkdown(d), /CAPABILITY_MISMATCH/);
});

test('an unknown FUTURE version (v3) is refused with a clear error', () => {
  const v3 = { ...v2Snapshot(), schemaVersion: 3 } as unknown as AnalyticsSnapshotV2;
  assert.throws(() => diffAnalyticsSnapshots(v3, v2Snapshot()),
    (e: unknown) => e instanceof SnapshotDiffError && /unknown schemaVersion 3/.test((e as Error).message));
  assert.throws(() => diffAnalyticsSnapshots(v2Snapshot(), v3),
    (e: unknown) => e instanceof SnapshotDiffError && /'after'/.test((e as Error).message));
});

// ── WP2 capability + caveat wiring ────────────────────────────────────────────

function modelWith(guidanceSources: GuidanceSource[] | undefined): OverheadModel {
  return {
    workspaceId: 'ws-1', workspaceRoot: '/ws', pathType: 'wsl',
    generatedAt: 'x', estimatorMethod: 'chars-heuristic',
    agents: [{
      id: 'a1', name: 'A', kind: 'builtin-worker', lane: 'worker',
      workingDir: '/ws/.lares/workers/codex', pathType: 'wsl',
      inheritanceChain: [], mcpServers: [], flatSources: [],
      total: { tokens: 0, bytes: 0, chars: 0, method: 'chars-heuristic', approximate: true },
      totalHeaderView: { tokens: 0, bytes: 0, chars: 0, method: 'chars-heuristic', approximate: true },
      exactness: 'estimated', warnings: [],
      ...(guidanceSources ? { guidanceSources } : {}),
    }],
    globalWarnings: [],
  };
}

test('snapshotCapabilities: agents-md-sources iff every agent carries guidanceSources', () => {
  assert.deepEqual(snapshotCapabilities(modelWith([])), ['agents-md-sources']);
  assert.deepEqual(snapshotCapabilities(modelWith(undefined)), [],
    'a model without the WP2 fields honestly withholds the capability');
});

test('countAnalyzedAgentsMdWithoutCompleteCoverage counts distinct directory-chain files only', () => {
  const chain: GuidanceSource = {
    path: '/ws/AGENTS.md', fileKind: 'agents-md', audienceProviders: ['codex'],
    applicability: { model: 'directory-chain' }, loadingSemanticsConfidence: 'documented',
  };
  const inventory: GuidanceSource = {
    path: '/ws/sub/AGENTS.md', fileKind: 'agents-md', audienceProviders: ['codex'],
    applicability: { model: 'inventory-only' }, loadingSemanticsConfidence: 'documented',
  };
  const claudeMd: GuidanceSource = {
    path: '/ws/CLAUDE.md', fileKind: 'claude-md', audienceProviders: ['claude'],
    applicability: { model: 'walk-up-chain' }, loadingSemanticsConfidence: 'documented',
  };
  assert.equal(countAnalyzedAgentsMdWithoutCompleteCoverage(modelWith([chain, inventory, claudeMd])), 1);
  assert.equal(countAnalyzedAgentsMdWithoutCompleteCoverage(modelWith([])), 0);
});

test('AGENTS_MD_AUDIENCE_PARTIALLY_UNOBSERVED: advisory, in the registry, observed iff >0', () => {
  assert.ok((CAVEAT_IDS as readonly string[]).includes('AGENTS_MD_AUDIENCE_PARTIALLY_UNOBSERVED'));
  const base: CaveatConditions = {
    epochsBackfilled: true, skillIndexComplete: true,
    estimatorMethod: 'tiktoken-approx', gitShaAvailable: true,
    clusterRollupProposalIds: [], unverifiedProposalIds: [],
    foreignStreamIdsDropped: 0, agentsMdSourcesWithoutCompleteCoverage: 0,
  };
  const quiet = buildCaveats(base).find((c) => c.id === 'AGENTS_MD_AUDIENCE_PARTIALLY_UNOBSERVED')!;
  assert.ok(quiet, 'emitted on EVERY snapshot, unconditionally');
  assert.equal(quiet.severity, 'advisory');
  assert.equal(quiet.observed, false);
  const hot = buildCaveats({ ...base, agentsMdSourcesWithoutCompleteCoverage: 2 })
    .find((c) => c.id === 'AGENTS_MD_AUDIENCE_PARTIALLY_UNOBSERVED')!;
  assert.equal(hot.observed, true);
  assert.match(hot.statement, /complete/i);
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
