// analytics-diff.ts — keyed snapshot diff (plan §5).
//
// Reads two already-captured snapshots and NEVER opens the database. Every
// surface is diffed by a KEY, never by array position, so a reorder alone
// produces an empty diff.
//
// Two §4 shape guarantees are enforced here as well as in the renderer:
//   - An improvisation-cluster occurrence delta is marked `diagnosticOnly:true`,
//     is never converted into a percentage, and never appears in a headline row
//     under any name but `diagnostic_only_routine_tool_shapes`.
//   - No diff row combines a cluster-exemplar count with an MCP-usage count; the
//     two surfaces are diffed independently and never joined.
//
// Verification-state transitions are diffed NORMALLY. The current wiring cannot
// reach `verified`, but unverified ↔ unverified-no-reference ↔ stale transitions
// are real, and a future wiring fix must become VISIBLE in a diff rather than be
// suppressed by an assumption that it can never happen.
//
// Pure. No IO, no Electron, no database.

import type { AnalyticsSnapshotV1, AnalyticsSnapshotV2, SnapshotCaveatV1, SurfaceKey } from './analytics-types';
import { ANALYTICS_SCHEMA_VERSION, SURFACE_KEYS, canonicalJson } from './analytics-types';
import { IMPROV_DIAGNOSTIC_KEY } from './analytics-render';

export interface FieldDelta {
  field: string;
  before: unknown;
  after: unknown;
  /** Numeric delta when both sides are numbers. Never rendered as a percentage
   *  when `diagnosticOnly` is set. */
  delta?: number;
  /** Set on improvisation-cluster occurrence counts (plan §4.1 / §5). */
  diagnosticOnly?: boolean;
}

export interface KeyedChange {
  key: string;
  label?: string;
  changes: FieldDelta[];
}

export interface SurfaceDiff {
  surface: string;
  added: Array<{ key: string; label?: string }>;
  removed: Array<{ key: string; label?: string }>;
  changed: KeyedChange[];
}

export interface AnalyticsSnapshotDiffV1 {
  schemaVersion: 1;
  provenance: {
    beforeSnapshotId: string;
    afterSnapshotId: string;
    beforeGitSha: string | null;
    afterGitSha: string | null;
    beforeCapturedAtIso: string;
    afterCapturedAtIso: string;
    captureGapMs: number;
    /** Per surface: did the generationId hold across the two snapshots. When it
     *  did NOT, deltas on that surface include organic corpus drift. */
    generationIds: Record<string, { before: string; after: string; equal: boolean }>;
    /** Plain-language statement of what the deltas below can and cannot mean. */
    interpretation: string;
    /** WP-S: present iff a v1 snapshot was adapted to v2 for this diff — the
     *  deltas cover only the fields common to both schemas. */
    schemaAdaptation?: {
      note: 'SCHEMA_ADAPTED_V1_V2';
      beforeSchemaVersion: number;
      afterSchemaVersion: number;
      statement: string;
    };
    /** WP-S: declared contracts of the two snapshots. `mismatch` is true when
     *  two v2 snapshots declare DIFFERENT capability lists — fields present on
     *  one side only must not be read as changed-to/absent. */
    capabilities?: {
      before: string[];
      after: string[];
      mismatch: boolean;
      note?: 'CAPABILITY_MISMATCH';
      statement?: string;
    };
  };
  overheadDeltas: Array<{
    agentId: string; agentName: string;
    resident: { before: number; after: number; delta: number; deltaPct: number | null };
    onDemand: { before: number; after: number; delta: number; deltaPct: number | null };
    total: { before: number; after: number; delta: number; deltaPct: number | null };
  }>;
  surfaces: SurfaceDiff[];
  caveats: {
    /** Present in `after` but not `before`. */
    newInAfter: SnapshotCaveatV1[];
    /** Severity changed between the two. */
    severityChanged: Array<{ id: string; before: string; after: string }>;
    /** Every caveat from BOTH snapshots propagates — a diff never drops one. */
    all: SnapshotCaveatV1[];
  };
}

export class SnapshotDiffError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = 'SnapshotDiffError';
  }
}

// ── keying helpers ────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function pct(before: number, delta: number): number | null {
  if (before === 0) return null;
  return Math.round((delta / before) * 10000) / 100;
}

function indexBy(rows: Row[], key: (r: Row) => string): Map<string, Row> {
  const m = new Map<string, Row>();
  for (const r of rows) m.set(key(r), r);
  return m;
}

/** Compare a fixed field list on two keyed rows. Values are compared by canonical
 *  JSON so object/array field order can never fabricate a change. */
function diffFields(
  before: Row, after: Row, fields: string[],
  diagnosticFields: Set<string> = new Set(),
): FieldDelta[] {
  const out: FieldDelta[] = [];
  for (const f of fields) {
    const b = before[f];
    const a = after[f];
    if (canonicalJson(b ?? null) === canonicalJson(a ?? null)) continue;
    const d: FieldDelta = { field: f, before: b ?? null, after: a ?? null };
    if (typeof b === 'number' && typeof a === 'number') d.delta = a - b;
    if (diagnosticFields.has(f)) d.diagnosticOnly = true;
    out.push(d);
  }
  return out;
}

function diffKeyed(
  surface: string,
  beforeRows: Row[], afterRows: Row[],
  key: (r: Row) => string,
  fields: string[],
  label?: (r: Row) => string,
  diagnosticFields?: Set<string>,
): SurfaceDiff {
  const b = indexBy(beforeRows, key);
  const a = indexBy(afterRows, key);
  const diff: SurfaceDiff = { surface, added: [], removed: [], changed: [] };
  for (const [k, row] of a) {
    if (!b.has(k)) { diff.added.push({ key: k, ...(label ? { label: label(row) } : {}) }); continue; }
    const changes = diffFields(b.get(k)!, row, fields, diagnosticFields);
    if (changes.length > 0) diff.changed.push({ key: k, ...(label ? { label: label(row) } : {}), changes });
  }
  for (const [k, row] of b) {
    if (!a.has(k)) diff.removed.push({ key: k, ...(label ? { label: label(row) } : {}) });
  }
  diff.added.sort((x, y) => x.key.localeCompare(y.key));
  diff.removed.sort((x, y) => x.key.localeCompare(y.key));
  diff.changed.sort((x, y) => x.key.localeCompare(y.key));
  return diff;
}

// ── surface extraction ────────────────────────────────────────────────────────

function optRows(s: AnalyticsSnapshotV2, field: 'proposals' | 'fileHeatHot' | 'analyzability'): Row[] {
  return ((s.surfaces.optimizer.data?.[field] ?? []) as Row[]);
}

/** Flatten the proposal DTO into the scalar fields the diff compares, hoisting the
 *  cluster-rollup occurrence count into its literal diagnostic-only key. */
function proposalRow(p: Row): Row {
  const v = (p.verification ?? {}) as Row;
  const row: Row = {
    id: p.id,
    kind: p.kind,
    title: p.title ?? null,
    lane: p.lane ?? null,
    confidence: p.confidence ?? null,
    actionability: p.actionability ?? null,
    // Printed as the wiring state it is — never mapped to a confidence word.
    verified: v.verified ?? null,
    verificationState: v.state ?? null,
    residentTokenDelta: num((p.residentTokenDelta as Row | undefined)?.estimate),
    tokenTurnsWeight: num(p.tokenTurnsWeight),
    evidenceState: p.evidenceState ?? null,
  };
  if (p.kind === 'add-cluster-rollup') {
    row[IMPROV_DIAGNOSTIC_KEY] = num((p.rollup as Row | undefined)?.count);
  }
  return row;
}

function knowledgeRows(s: AnalyticsSnapshotV2): Row[] {
  const out: Row[] = [];
  for (const entry of s.surfaces.agentKnowledge.data ?? []) {
    for (const n of (entry.nodes ?? []) as Row[]) {
      out.push({ _key: `${entry.agentId}|${n.id}`, agentId: entry.agentId, ...n });
    }
  }
  return out;
}

function planSectionRows(s: AnalyticsSnapshotV2): Row[] {
  const out: Row[] = [];
  for (const entry of s.surfaces.plans.data ?? []) {
    const listing = entry.sections as { sections?: Row[] } | null;
    const activity = entry.activity as { sections?: Row[] } | null;
    const act = new Map((activity?.sections ?? []).map((a) => [String(a.anchor), a]));
    for (const sec of listing?.sections ?? []) {
      const a = act.get(String(sec.anchor));
      out.push({
        _key: `${entry.plan.id}|${sec.anchor}`,
        planId: entry.plan.id,
        heading: sec.heading ?? null,
        zone: sec.zone ?? null,
        tokenEstimate: num(sec.tokenEstimate),
        writeCount: num(a?.writeCount),
        eventCount: num(a?.eventCount),
        archived: a?.archived ?? false,
      });
    }
  }
  return out;
}

function overheadAgents(s: AnalyticsSnapshotV2): Row[] {
  return ((s.surfaces.contextOverhead.data?.agents ?? []) as unknown as Row[]);
}

// ── entry point ───────────────────────────────────────────────────────────────

/** WP-S — lift a v1 snapshot into the v2 shape. v1 is structurally v2 minus the
 *  v2-optional additions, so the adapter maps the common diffable fields
 *  (per-lane/agent tokens, keyed table rows, generationIds) 1:1 and declares an
 *  EMPTY capability contract. */
export function adaptV1ToV2(s: AnalyticsSnapshotV1): AnalyticsSnapshotV2 {
  const { schemaVersion: _v1, ...rest } = s;
  return { ...rest, schemaVersion: 2, capabilities: [] };
}

const KNOWN_SCHEMA_VERSIONS = new Set<number>([1, ANALYTICS_SCHEMA_VERSION]);

export function diffAnalyticsSnapshots(
  beforeIn: AnalyticsSnapshotV2 | AnalyticsSnapshotV1,
  afterIn: AnalyticsSnapshotV2 | AnalyticsSnapshotV1,
): AnalyticsSnapshotDiffV1 {
  // WP-S version gate: v1 adapts through the compatibility adapter (disclosed);
  // v2 is native; anything ELSE — in particular a FUTURE version this tool does
  // not understand — is refused rather than silently mis-read.
  for (const [side, s] of [['before', beforeIn], ['after', afterIn]] as const) {
    if (!KNOWN_SCHEMA_VERSIONS.has(s.schemaVersion as number)) {
      throw new SnapshotDiffError(
        `unknown schemaVersion ${String(s.schemaVersion)} on the '${side}' snapshot. This diff `
        + `tool understands v1 (via the compatibility adapter) and v${ANALYTICS_SCHEMA_VERSION} only; `
        + 'a newer snapshot needs a newer tool — refusing rather than guessing at its contract.', 1);
    }
  }
  const adapted = beforeIn.schemaVersion === 1 || afterIn.schemaVersion === 1;
  const before: AnalyticsSnapshotV2 =
    beforeIn.schemaVersion === 1 ? adaptV1ToV2(beforeIn) : beforeIn;
  const after: AnalyticsSnapshotV2 =
    afterIn.schemaVersion === 1 ? adaptV1ToV2(afterIn) : afterIn;

  // WP-S capability contracts. A mismatch is disclosed only between two NATIVE
  // v2 snapshots — an adapted v1 side is already covered by SCHEMA_ADAPTED_V1_V2.
  const beforeCaps = [...(before.capabilities ?? [])].sort();
  const afterCaps = [...(after.capabilities ?? [])].sort();
  const capsMismatch = !adapted && canonicalJson(beforeCaps) !== canonicalJson(afterCaps);

  // ── 1. Provenance ──
  const generationIds: AnalyticsSnapshotDiffV1['provenance']['generationIds'] = {};
  let anyDrift = false;
  for (const k of SURFACE_KEYS) {
    const b = before.surfaces[k].generationId;
    const a = after.surfaces[k].generationId;
    const equal = b === a;
    if (!equal) anyDrift = true;
    generationIds[k] = { before: b, after: a, equal };
  }
  const gapMs = Date.parse(after.captureStartedAtIso) - Date.parse(before.captureStartedAtIso);

  // ── 2. Overhead deltas, sorted by |Δ total| ──
  const bAgents = indexBy(overheadAgents(before), (r) => String(r.id));
  const aAgents = indexBy(overheadAgents(after), (r) => String(r.id));
  const agentIds = [...new Set([...bAgents.keys(), ...aAgents.keys()])];
  const tokensOf = (r: Row | undefined, f: string): number => num((r?.[f] as Row | undefined)?.tokens);
  const overheadDeltas = agentIds.map((id) => {
    const b = bAgents.get(id);
    const a = aAgents.get(id);
    const leg = (f: string) => {
      const bv = tokensOf(b, f);
      const av = tokensOf(a, f);
      const d = av - bv;
      return { before: bv, after: av, delta: d, deltaPct: pct(bv, d) };
    };
    return {
      agentId: id,
      agentName: String(a?.name ?? b?.name ?? id),
      resident: leg('residentTotal'),
      onDemand: leg('onDemandTotal'),
      total: leg('total'),
    };
  }).sort((x, y) => Math.abs(y.total.delta) - Math.abs(x.total.delta) || x.agentId.localeCompare(y.agentId));

  // ── 3. Keyed per-surface diffs ──
  const surfaces: SurfaceDiff[] = [];

  surfaces.push(diffKeyed('contextOverhead',
    overheadAgents(before), overheadAgents(after),
    (r) => String(r.id),
    ['lane', 'kind', 'exactness'],
    (r) => String(r.name ?? '')));

  surfaces.push(diffKeyed('optimizer.proposals',
    optRows(before, 'proposals').map(proposalRow), optRows(after, 'proposals').map(proposalRow),
    (r) => String(r.id),
    ['kind', 'title', 'lane', 'confidence', 'actionability', 'verified', 'verificationState',
      'residentTokenDelta', 'tokenTurnsWeight', 'evidenceState', IMPROV_DIAGNOSTIC_KEY],
    (r) => String(r.title ?? ''),
    new Set([IMPROV_DIAGNOSTIC_KEY])));

  surfaces.push(diffKeyed('optimizer.fileHeat',
    optRows(before, 'fileHeatHot'), optRows(after, 'fileHeatHot'),
    (r) => String(r.pathHash),
    ['lane', 'coverage', 'reads', 'writes', 'executes', 'distinctStreams', 'uncovered', 'role'],
    (r) => String(r.pathDisplay ?? '')));

  const analyzKey = (r: Row): string =>
    `${r.sectionId}|${[...((r.lanes ?? []) as string[])].sort().join(',')}`;
  surfaces.push(diffKeyed('optimizer.analyzability',
    optRows(before, 'analyzability'), optRows(after, 'analyzability'),
    analyzKey,
    ['residentTokens', 'exposureTurns', 'actionCount', 'trappedCostWeight']));

  surfaces.push(diffKeyed('skillUsage',
    (before.surfaces.skillUsage.data?.rows ?? []) as Row[],
    (after.surfaces.skillUsage.data?.rows ?? []) as Row[],
    (r) => String(r.id),
    ['count', 'avgEffectiveness', 'observableScore', 'scoredInvocations'],
    (r) => String(r.skill ?? '')));

  const mcpRows = (s: AnalyticsSnapshotV2): Row[] =>
    (((s.surfaces.mcpToolUsage.data?.rollup as Row | undefined | null)?.byTool ?? []) as Row[]);
  surfaces.push(diffKeyed('mcpToolUsage',
    mcpRows(before), mcpRows(after),
    (r) => String(r.toolName),
    ['count', 'distinctStreams', 'toolset'],
    (r) => String(r.toolShort ?? '')));

  surfaces.push(diffKeyed('agentKnowledge',
    knowledgeRows(before), knowledgeRows(after),
    (r) => String(r._key),
    ['type', 'label', 'tokenEstimate', 'sourceKind']));

  surfaces.push(diffKeyed('plans',
    planSectionRows(before), planSectionRows(after),
    (r) => String(r._key),
    ['heading', 'zone', 'tokenEstimate', 'writeCount', 'eventCount', 'archived']));

  // ── 4. Caveat diff — every caveat from BOTH snapshots propagates ──
  const bCav = new Map(before.caveats.map((c) => [c.id, c]));
  const aCav = new Map(after.caveats.map((c) => [c.id, c]));
  const newInAfter = [...aCav.values()].filter((c) => !bCav.has(c.id));
  const severityChanged: AnalyticsSnapshotDiffV1['caveats']['severityChanged'] = [];
  for (const [id, a] of aCav) {
    const b = bCav.get(id);
    if (b && b.severity !== a.severity) severityChanged.push({ id, before: b.severity, after: a.severity });
  }
  const all = [...new Map([...before.caveats, ...after.caveats].map((c) => [c.id, c])).values()]
    .sort((x, y) => x.id.localeCompare(y.id));

  return {
    schemaVersion: 1,
    provenance: {
      beforeSnapshotId: before.snapshotId,
      afterSnapshotId: after.snapshotId,
      beforeGitSha: before.provenance.workspaceGitSha,
      afterGitSha: after.provenance.workspaceGitSha,
      beforeCapturedAtIso: before.captureStartedAtIso,
      afterCapturedAtIso: after.captureStartedAtIso,
      captureGapMs: Number.isFinite(gapMs) ? gapMs : 0,
      generationIds,
      ...(adapted ? {
        schemaAdaptation: {
          note: 'SCHEMA_ADAPTED_V1_V2' as const,
          beforeSchemaVersion: beforeIn.schemaVersion,
          afterSchemaVersion: afterIn.schemaVersion,
          statement:
            'A v1 snapshot was adapted to the v2 shape through the WP-S compatibility '
            + 'adapter. Only the fields COMMON to both schemas are diffed; a v2-optional '
            + 'field appearing on the v2 side is new surface area, not a change.',
        },
      } : {}),
      capabilities: {
        before: beforeCaps,
        after: afterCaps,
        mismatch: capsMismatch,
        ...(capsMismatch ? {
          note: 'CAPABILITY_MISMATCH' as const,
          statement:
            'These two v2 snapshots declare DIFFERENT capability contracts. A field '
            + 'governed by a capability present on only one side must not be read as '
            + 'added/removed data — it was never populated on the other side.',
        } : {}),
      },
      interpretation: anyDrift
        ? 'At least one surface changed generationId between these snapshots, so the deltas '
          + 'below include ORGANIC CORPUS DRIFT as well as any change you made. Do not '
          + 'attribute a delta on a drifted surface to a single cause.'
        : 'Every surface kept its generationId across both snapshots, so the deltas below '
          + 'are real changes to the same analysed generation, not corpus drift.',
    },
    overheadDeltas,
    surfaces: surfaces.filter((d) => d.added.length + d.removed.length + d.changed.length > 0),
    caveats: { newInAfter, severityChanged, all },
  };
}

// ── markdown rendering ────────────────────────────────────────────────────────

export function renderDiffMarkdown(d: AnalyticsSnapshotDiffV1): string {
  const out: string[] = [];
  out.push('# Analytics snapshot diff');
  out.push('');
  out.push('## Provenance');
  out.push('');
  out.push(`- before: \`${d.provenance.beforeSnapshotId}\` @ ${d.provenance.beforeCapturedAtIso} (git ${d.provenance.beforeGitSha ?? '_unavailable_'})`);
  out.push(`- after:  \`${d.provenance.afterSnapshotId}\` @ ${d.provenance.afterCapturedAtIso} (git ${d.provenance.afterGitSha ?? '_unavailable_'})`);
  out.push(`- capture gap: ${d.provenance.captureGapMs} ms`);
  out.push('');
  out.push(`> ${d.provenance.interpretation}`);
  out.push('');
  if (d.provenance.schemaAdaptation) {
    const a = d.provenance.schemaAdaptation;
    out.push(`> **${a.note}** (v${a.beforeSchemaVersion} → v${a.afterSchemaVersion}): ${a.statement}`);
    out.push('');
  }
  if (d.provenance.capabilities) {
    const c = d.provenance.capabilities;
    out.push(`- capabilities before: ${c.before.join(', ') || '_none declared_'}`);
    out.push(`- capabilities after: ${c.after.join(', ') || '_none declared_'}`);
    out.push('');
    if (c.mismatch && c.statement) {
      out.push(`> **${c.note}**: ${c.statement}`);
      out.push('');
    }
  }
  out.push('| surface | generationId held |');
  out.push('|---|---|');
  for (const [k, g] of Object.entries(d.provenance.generationIds)) {
    out.push(`| ${k} | ${g.equal ? 'yes' : `**no** (\`${g.before.slice(0, 12)}\` → \`${g.after.slice(0, 12)}\`)`} |`);
  }
  out.push('');

  out.push('## Overhead deltas');
  out.push('');
  if (d.overheadDeltas.length === 0) {
    out.push('_no agents on either side_');
  } else {
    out.push('| agent | resident Δ | on-demand Δ | total before | total after | total Δ | total Δ% |');
    out.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const a of d.overheadDeltas) {
      out.push(`| ${a.agentName} | ${a.resident.delta} | ${a.onDemand.delta} | ${a.total.before} `
        + `| ${a.total.after} | ${a.total.delta} | ${a.total.deltaPct === null ? '—' : `${a.total.deltaPct}%`} |`);
    }
  }
  out.push('');

  out.push('## Changes by surface');
  out.push('');
  if (d.surfaces.length === 0) {
    out.push('_no keyed changes on any surface_');
  }
  for (const sd of d.surfaces) {
    out.push(`### ${sd.surface}`);
    out.push('');
    out.push(`- added: ${sd.added.length} · removed: ${sd.removed.length} · changed: ${sd.changed.length}`);
    for (const a of sd.added) out.push(`  - **+** \`${a.key}\`${a.label ? ` — ${a.label}` : ''}`);
    for (const r of sd.removed) out.push(`  - **−** \`${r.key}\`${r.label ? ` — ${r.label}` : ''}`);
    for (const c of sd.changed) {
      out.push(`  - **~** \`${c.key}\`${c.label ? ` — ${c.label}` : ''}`);
      for (const f of c.changes) {
        // A diagnostic-only delta is printed as a raw before→after pair under its
        // literal key. Never a percentage, never a recommendation (§4.1).
        const suffix = f.diagnosticOnly ? '  _(diagnostic only — routine tool shapes, not an opportunity)_' : '';
        out.push(`    - \`${f.field}\`: ${JSON.stringify(f.before)} → ${JSON.stringify(f.after)}`
          + `${f.delta !== undefined && !f.diagnosticOnly ? ` (Δ ${f.delta})` : ''}${suffix}`);
      }
    }
    out.push('');
  }

  out.push('## Caveats');
  out.push('');
  out.push(`- new in \`after\`: ${d.caveats.newInAfter.map((c) => c.id).join(', ') || '_none_'}`);
  out.push(`- severity changed: ${d.caveats.severityChanged.map((c) => `${c.id} ${c.before}→${c.after}`).join(', ') || '_none_'}`);
  out.push('');
  out.push('All caveats from BOTH snapshots (none are dropped by a diff):');
  out.push('');
  for (const c of d.caveats.all) out.push(`- **\`${c.id}\`** (${c.severity}) — ${c.statement}`);
  out.push('');
  return out.join('\n');
}
