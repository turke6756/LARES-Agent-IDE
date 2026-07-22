// analytics-render.ts — SUMMARY.md and tables/*.csv (plan §3.2, §3.3, §4).
//
// These are DERIVED artifacts: everything here is reproducible from
// `snapshot.json`, which stays the sole schema authority.
//
// The §4 shape guarantees are enforced HERE, structurally, not by a footnote:
//   1. An improvisation-cluster occurrence count never appears in a headline row,
//      in SUMMARY.md prose, or in any CSV column — except under the single literal
//      key `diagnostic_only_routine_tool_shapes`.
//   2. `verified:false` is printed as the wiring state it is. No renderer here maps
//      it to "low confidence", "pending", or any gradable word.
//   3. No row combines a cluster-exemplar count with an MCP-usage count. The two
//      live in different tables with no shared column.
//   4. A degraded snapshot says so in the first line of SUMMARY.md.
//
// Pure. No IO, no Electron, no database.

import type { AnalyticsSnapshotV2, SnapshotCaveatV1, SurfaceKey } from './analytics-types';
import { SURFACE_KEYS } from './analytics-types';
import { blockingCaveats, advisoryCaveats } from './analytics-caveats';

/** The ONLY key under which an improvisation-cluster occurrence count may appear
 *  anywhere in a derived artifact (plan §4.1). */
export const IMPROV_DIAGNOSTIC_KEY = 'diagnostic_only_routine_tool_shapes';

// ── CSV primitives (RFC-4180, no comment lines) ───────────────────────────────

/** Escape one cell. Also defuses spreadsheet formula injection by prefixing a
 *  leading `=`, `+`, `-` or `@` with an apostrophe — a cell that opens a formula
 *  in Excel/Sheets is an execution surface, and these files are meant to be
 *  double-clicked. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

/** Header row + data rows, CRLF-terminated per RFC-4180. NO `#` comment lines —
 *  a comment row is not part of a valid table and renders as data. */
export function csvTable(header: string[], rows: unknown[][]): string {
  return [csvRow(header), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}

// ── helpers ───────────────────────────────────────────────────────────────────

function surfaceCaveatCodes(s: AnalyticsSnapshotV2, key: SurfaceKey): string {
  return (s.surfaces[key].caveatIds ?? []).join(' ');
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function rowsIn(s: AnalyticsSnapshotV2, key: SurfaceKey): number {
  const data = s.surfaces[key].data as unknown;
  if (data === null || data === undefined) return 0;
  if (Array.isArray(data)) return data.length;
  const d = data as Record<string, unknown>;
  if (Array.isArray(d.agents)) return (d.agents as unknown[]).length;
  if (Array.isArray(d.proposals)) return (d.proposals as unknown[]).length;
  if (Array.isArray(d.rows)) return (d.rows as unknown[]).length;
  return 1;
}

/** True when any surface came back degraded — drives the SUMMARY.md lead line. */
export function isDegraded(s: AnalyticsSnapshotV2): boolean {
  return SURFACE_KEYS.some((k) => s.surfaces[k].status === 'degraded');
}

// ── SUMMARY.md (plan §3.2) ────────────────────────────────────────────────────

function renderCaveat(c: SnapshotCaveatV1): string {
  const ev = c.evidence.map((e) => `${e.file}:${e.lines}`).join('; ');
  const observed = c.observed === undefined ? '' : ` _(observed in this snapshot: ${c.observed ? 'yes' : 'no'})_`;
  const matched = c.matchedIds && c.matchedIds.length > 0
    ? `\n  - matched ids: ${c.matchedIds.join(', ')}`
    : '';
  return `- **\`${c.id}\`** — ${c.statement}${observed}\n  - evidence: ${ev}${matched}`;
}

export function renderSummaryMarkdown(s: AnalyticsSnapshotV2): string {
  const out: string[] = [];
  const degraded = isDegraded(s);

  out.push('# Frozen analytics snapshot');
  out.push('');
  if (degraded) {
    // §4.4 — a degraded snapshot says so at the TOP, not only in a field.
    out.push('> ## ⛔ THIS SNAPSHOT IS DEGRADED');
    out.push('>');
    out.push('> Cold-start indexing was incomplete when this capture ran and `--allow-cold`');
    out.push('> was used. At least one surface below is analytically unreliable — read the');
    out.push('> blocking caveats before citing ANY number from it.');
    out.push('');
  }

  out.push(`- snapshot id: \`${s.snapshotId}\``);
  out.push(`- capture interval: ${s.captureStartedAtIso} → ${s.captureCompletedAtIso}`);
  out.push(`- workspace: \`${s.provenance.workspace.id}\` (${s.provenance.workspace.pathType}, root \`${s.provenance.workspace.root}\`)`);
  out.push(`- git: ${s.provenance.workspaceGitSha ?? '_unavailable_'}`
    + `${s.provenance.workspaceGitBranch ? ` (${s.provenance.workspaceGitBranch})` : ''}`
    + `${s.provenance.workspaceGitDirty === null ? '' : s.provenance.workspaceGitDirty ? ' — dirty tree' : ' — clean tree'}`);
  out.push(`- app version: ${s.provenance.appVersion} · exporter v${s.provenance.exporterVersion} · schema v${s.schemaVersion}`);
  // WP-S: the declared contract — check `capabilities` before relying on a v2-optional field.
  out.push(`- capabilities: ${(s.capabilities ?? []).map((c) => `\`${c}\``).join(', ') || '_none declared_'}`);
  out.push(`- database mode: \`${s.provenance.databaseMode}\` · backfill: \`${s.provenance.backfillMode}\` · scope: \`${s.provenance.scopeMode}\` · redaction: \`${s.provenance.redactionPolicy}\``);
  out.push(`- index state: epochsBackfilled=\`${s.provenance.indexState.epochsBackfilled}\`, skillIndexComplete=\`${s.provenance.indexState.skillIndexComplete}\``);
  out.push('');

  // ── 2. The caveats. ALWAYS the first content section. ──
  out.push('## ⚠ Read this before citing any number');
  out.push('');
  const blocking = blockingCaveats(s.caveats);
  const advisory = advisoryCaveats(s.caveats);
  out.push(`### Blocking (${blocking.length})`);
  out.push('');
  for (const c of blocking) out.push(renderCaveat(c));
  out.push('');
  out.push(`### Advisory (${advisory.length})`);
  out.push('');
  for (const c of advisory) out.push(renderCaveat(c));
  out.push('');

  // ── 3. Per-agent overhead. ──
  out.push('## Context overhead per agent');
  out.push('');
  const oh = s.surfaces.contextOverhead.data;
  if (!oh || oh.agents.length === 0) {
    out.push(`_no agents captured (surface status: ${s.surfaces.contextOverhead.status})_`);
  } else {
    out.push('| agent | lane | resident | on-demand | total | exactness | warnings |');
    out.push('|---|---|---:|---:|---:|---|---:|');
    for (const a of [...oh.agents].sort((x, y) => num(y.total?.tokens) - num(x.total?.tokens))) {
      out.push(`| ${a.name} | ${a.lane} | ${num(a.residentTotal?.tokens)} | ${num(a.onDemandTotal?.tokens)} `
        + `| ${num(a.total?.tokens)} | ${a.exactness ?? '—'} | ${(a.warnings ?? []).length} |`);
    }
    out.push('');
    out.push(`> ${oh.systemBaselineNote}`);
  }
  out.push('');

  // ── 3b. WP5 (G5): section behavior axis (capability 'section-behavior-status').
  // A SEPARATE axis from the structural weightClass — never collapsed into it.
  if ((s.capabilities ?? []).includes('section-behavior-status')) {
    out.push('## Config section behavior status (workspace rollup — separate axis from structural weightClass)');
    out.push('');
    const tb = (oh?.workspaceConfigWeight as { tokensByBehavior?: Record<string, number> } | null)
      ?.tokensByBehavior;
    if (!tb) {
      out.push('_no workspace-level behavior rollup (per-agent sections may still carry `behaviorStatus`)_');
    } else {
      out.push('| behaviorStatus | tokens |');
      out.push('|---|---:|');
      for (const [k, v] of Object.entries(tb)) out.push(`| ${k} | ${num(v)} |`);
      out.push('');
      out.push('> `dead` requires every analyzable node dead via the fail-closed never-gates,');
      out.push('> capture coverage `complete`, and zero unmatchable nodes. Sections without a');
      out.push('> joined behavior verdict count under `not-analyzed` — absence is never deadness.');
    }
    out.push('');
  }

  // ── 4. Lane grant matrix (authoritative) vs measured MCP inventory. ──
  out.push('## Lane grants (authoritative — `toolsetsForLane()` / `laneUsesStrictMcp()`)');
  out.push('');
  out.push('| lane | toolsets | strictMcp |');
  out.push('|---|---|---|');
  for (const [lane, g] of Object.entries(s.provenance.laneGrantMatrix)) {
    out.push(`| ${lane} | ${g.toolsets.join(', ') || '_none_'} | ${g.strictMcp} |`);
  }
  out.push('');
  out.push('## Measured MCP inventory (what the SCAN found — NOT the grant)');
  out.push('');
  if (!oh || oh.measuredMcpInventory.length === 0) {
    out.push('_nothing measured_');
  } else {
    out.push('| lane | counted servers | excluded by strict mode | tools | tokens |');
    out.push('|---|---|---|---:|---:|');
    for (const r of oh.measuredMcpInventory) {
      out.push(`| ${r.lane} | ${r.countedServers.join(', ') || '_none_'} | ${r.excludedByStrictMode.join(', ') || '_none_'} `
        + `| ${r.toolCount} | ${r.countedTokens} |`);
    }
  }
  out.push('');

  // ── 5. Proposal counts. verified:false printed as the wiring state it is. ──
  out.push('## Optimizer proposals');
  out.push('');
  const opt = s.surfaces.optimizer.data;
  const proposals = (opt?.proposals ?? []) as Array<Record<string, unknown>>;
  if (proposals.length === 0) {
    out.push(`_no proposals (surface status: ${s.surfaces.optimizer.status})_`);
  } else {
    const byKind = new Map<string, number>();
    for (const p of proposals) {
      const k = String(p.kind ?? 'unknown');
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
    }
    out.push('| kind | count |');
    out.push('|---|---:|');
    for (const [k, n] of [...byKind].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(`| ${k} | ${n} |`);
    }
    out.push('');
    // Verification state, printed literally. NOT a confidence ladder.
    const byState = new Map<string, number>();
    for (const p of proposals) {
      const v = p.verification as { verified?: boolean; state?: string } | undefined;
      const label = `verified=${String(v?.verified ?? 'n/a')} state=${v?.state ?? 'n/a'}`;
      byState.set(label, (byState.get(label) ?? 0) + 1);
    }
    out.push('| verification (wiring state, not a score) | count |');
    out.push('|---|---:|');
    for (const [k, n] of [...byState].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(`| \`${k}\` | ${n} |`);
    }
    out.push('');
    out.push(`- \`unverifiedSuppressedCount\`: ${num((opt?.meta as { unverifiedSuppressedCount?: number } | null)?.unverifiedSuppressedCount)} `
      + '(see caveat: `DERIVATION_GATE_ALWAYS_UNVERIFIED`)');
  }
  out.push('');

  // ── 6. Top-20 file heat, skill usage, MCP tool usage. ──
  out.push('## Top file heat (hot view, top 20)');
  out.push('');
  const heat = (opt?.fileHeatHot ?? []) as Array<Record<string, unknown>>;
  if (heat.length === 0) {
    out.push('_none_');
  } else {
    out.push('| path | scope | lane | reads | writes | executes | streams |');
    out.push('|---|---|---|---:|---:|---:|---:|');
    for (const f of heat.slice(0, 20)) {
      out.push(`| \`${f.pathDisplay}\` | ${f.pathScope} | ${f.lane} | ${num(f.reads)} | ${num(f.writes)} | ${num(f.executes)} | ${num(f.distinctStreams)} |`);
    }
  }
  out.push('');

  out.push('## Top skill usage (top 20)');
  out.push('');
  const skills = (s.surfaces.skillUsage.data?.rows ?? []) as Array<Record<string, unknown>>;
  if (skills.length === 0) {
    out.push(`_none (surface status: ${s.surfaces.skillUsage.status})_`);
  } else {
    out.push('| skill | invocations | avg effectiveness |');
    out.push('|---|---:|---:|');
    for (const r of skills.slice(0, 20)) {
      out.push(`| ${r.skill} | ${num(r.count)} | ${r.avgEffectiveness ?? '—'} |`);
    }
  }
  out.push('');

  // MCP usage stands ALONE. No cluster-exemplar column, no combined figure —
  // caveat CROSS_SURFACE_COUNTS_NOT_COMPARABLE.
  out.push('## MCP tool usage (top 20) — NOT comparable with cluster-exemplar counts');
  out.push('');
  const rollup = s.surfaces.mcpToolUsage.data?.rollup as Record<string, unknown> | undefined | null;
  const byTool = (rollup?.byTool ?? []) as Array<Record<string, unknown>>;
  if (byTool.length === 0) {
    out.push(`_none (surface status: ${s.surfaces.mcpToolUsage.status})_`);
  } else {
    out.push(`- attribution coverage: ${num(rollup?.attributionCoveragePct)}% of ${num(rollup?.totalCalls)} calls`);
    out.push('');
    out.push('| tool | toolset | calls | streams |');
    out.push('|---|---|---:|---:|');
    for (const t of byTool.slice(0, 20)) {
      out.push(`| ${t.toolShort} | ${t.toolset ?? '_unresolved_'} | ${num(t.count)} | ${num(t.distinctStreams)} |`);
    }
  }
  out.push('');

  // ── 7. Plan orientation counts. ──
  out.push('## Plans');
  out.push('');
  const plans = s.surfaces.plans.data ?? [];
  if (plans.length === 0) {
    out.push(`_none (surface status: ${s.surfaces.plans.status})_`);
  } else {
    out.push('| plan | status | sections |');
    out.push('|---|---|---:|');
    for (const p of plans) {
      const sections = (p.sections as { sections?: unknown[] } | null)?.sections?.length ?? 0;
      out.push(`| ${p.plan.title} | ${p.plan.status} | ${sections} |`);
    }
  }
  out.push('');

  // ── 7b. WP7 (G7): the nested guidance inventory, with its declared scan
  // contract and honest completeness metadata (capability 'guidance-inventory'). ──
  const gi = s.surfaces.guidanceInventory;
  if (gi) {
    out.push('## Guidance inventory (workspace-wide, declared scan contract)');
    out.push('');
    const inv = gi.data;
    if (!inv) {
      out.push(`_no inventory (surface status: ${gi.status})_`);
    } else {
      const c = inv.scan.contract;
      out.push(`- scan contract: maxDepth ${c.maxDepth} · maxDirs ${c.maxDirs} · maxFiles ${c.maxFiles} `
        + `· maxBytes/file ${c.maxFileBytes} · symlinks NOT followed · ignored dirs: ${c.ignoredDirNames.join(', ')} `
        + `· ordering \`${c.ordering}\``);
      out.push(`- gitignore applied: ${inv.scan.gitIgnoreApplied} (false = not a git workspace / rules unavailable — disclosed, not silent)`);
      if (inv.scan.scanComplete) {
        out.push('- scan complete: yes (remainder provably zero)');
      } else {
        out.push(`- **scan INCOMPLETE** — stopped by \`${inv.scan.scanStoppedReason}\`; `
          + 'remainder count NOT known (unvisited subtrees are never counted, a number would be fabricated)');
      }
      out.push(`- traversal: ${inv.scan.dirsVisited} dirs · ${inv.scan.filesSeen} files seen`);
      const failures = Object.entries(inv.scan.readFailuresByReason)
        .map(([code, n]) => `${code}:${n}`).join(', ');
      out.push(`- known omissions: symlinks ${inv.scan.skippedSymlinks} · ignored dirs ${inv.scan.skippedIgnoredDirs} `
        + `· git-ignored ${inv.scan.skippedGitIgnored} · oversized ${inv.scan.skippedOversized} `
        + `· read failures ${failures || '_none_'}`);
      out.push('');
      if (inv.entries.length === 0) {
        out.push('_no guidance files found within the contract_');
      } else {
        const shown = inv.entries.slice(0, 50);
        out.push('| file | kind | applicability | audience | tokens | headings | liveness |');
        out.push('|---|---|---|---|---:|---:|---|');
        for (const e of shown) {
          const audience = e.audienceProviders === 'unknown' ? '`unknown`' : e.audienceProviders.join(', ');
          out.push(`| \`${e.path}\` | ${e.fileKind} | ${e.applicability.model} | ${audience} `
            + `| ${num(e.tokens)} | ${e.headings.length} | ${e.liveness} |`);
        }
        if (inv.entries.length > shown.length) {
          out.push('');
          out.push(`_showing ${shown.length} of ${inv.entries.length} entries — the full list is in `
            + '`surfaces/guidanceInventory.json`_');
        }
        out.push('');
        out.push('> `liveness: not-analyzed` is the ONLY value this inventory emits — a nested file');
        out.push('> gains liveness only when a captured session-cwd/task scope proves applicability');
        out.push('> (out of scope for the inventory). `inventory-only` files are listed and costed,');
        out.push('> never per-agent costed.');
      }
    }
    out.push('');
  }

  // ── 8. Surface capture table. ──
  out.push('## Surface capture');
  out.push('');
  out.push('| surface | status | rows | generationId | errors |');
  out.push('|---|---|---:|---|---:|');
  for (const k of SURFACE_KEYS) {
    const sf = s.surfaces[k];
    out.push(`| ${k} | ${sf.status} | ${rowsIn(s, k)} | \`${sf.generationId.slice(0, 16)}\` | ${sf.errors.length} |`);
  }
  if (gi) {
    out.push(`| guidanceInventory | ${gi.status} | ${gi.data?.entries.length ?? 0} `
      + `| \`${gi.generationId.slice(0, 16)}\` | ${gi.errors.length} |`);
  }
  out.push('');

  // ── 8b. WP8 (G8): the provenance table (capability 'surface-provenance').
  // Comparability is decidable from this alone: two surfaces' counts are
  // comparable ONLY when their FULL comparabilityKey values are identical. ──
  if (SURFACE_KEYS.some((k) => s.surfaces[k].provenance) || gi?.provenance) {
    out.push('## Surface provenance (comparability)');
    out.push('');
    out.push(`- snapshot anchor (one clock, every builder): \`${s.provenance.snapshotAnchor ?? '_not recorded_'}\``);
    out.push(`- requested \`--window\`: ${s.provenance.requestedWindowDays != null
      ? `${s.provenance.requestedWindowDays} day(s)` : '_none_'}`
      + ' — a surface that cannot honor it exports its TRUE window below');
    out.push('');
    out.push('| surface | workspace scope | lanes | providers | capture sources | filters | window [start → end) | comparabilityKey |');
    out.push('|---|---|---|---|---|---|---|---|');
    // WP7: the optional guidanceInventory surface joins the same table.
    const provRows: Array<[string, typeof s.surfaces.contextOverhead.provenance]> = [
      ...SURFACE_KEYS.map((k) => [k, s.surfaces[k].provenance] as [string, typeof s.surfaces.contextOverhead.provenance]),
      ...(gi ? [['guidanceInventory', gi.provenance] as [string, typeof s.surfaces.contextOverhead.provenance]] : []),
    ];
    for (const [k, p] of provRows) {
      if (!p) { out.push(`| ${k} | _no provenance_ | | | | | | |`); continue; }
      out.push(`| ${k} | \`${p.workspaceScope.scopeMode}\` | ${p.population.lanes.join(', ') || '—'} `
        + `| ${p.population.providers.join(', ') || '—'} | ${p.population.captureSources.join(', ')} `
        + `| ${p.population.filters.join(', ') || '—'} | ${p.windowStart} → ${p.windowEnd} `
        + `| \`${p.comparabilityKey.slice(0, 16)}\` |`);
    }
    out.push('');
    out.push('> Counts from two surfaces may be combined ONLY when their full `comparabilityKey`');
    out.push('> values (in the surface JSON) are identical. Matching window dates alone never');
    out.push('> qualify — the key hashes the population too (see');
    out.push('> `CROSS_SURFACE_COUNTS_NOT_COMPARABLE`, which downgrades to advisory only on');
    out.push('> identical keys).');
    out.push('');
  }

  // ── 9. WP6 (G6): per-table truncation disclosure. A capped table is never
  // conflatable with a full drain — the machine-readable copy lives in
  // `manifest.json` (`tableTruncation`) and on the surface provenance. ──
  const trunc = s.provenance.tableTruncation;
  if (trunc && Object.keys(trunc).length > 0) {
    out.push('## Table truncation (a capped table is NOT the full population)');
    out.push('');
    out.push('| table | population available | rows emitted | truncated | limit | pagination order |');
    out.push('|---|---:|---:|---|---:|---|');
    for (const [name, t] of Object.entries(trunc).sort((a, b) => a[0].localeCompare(b[0]))) {
      out.push(`| ${name} | ${t.populationAvailable ?? '_unknown_'} | ${t.rowsEmitted} `
        + `| ${t.truncated === null ? '_unknown_' : t.truncated} | ${t.limit} | \`${t.paginationOrder}\` |`);
    }
    out.push('');
    out.push('> `truncated: unknown` means the producing layer did not disclose the population —');
    out.push('> unknown is reported as unknown, never as "not truncated".');
    out.push('');
  }

  return out.join('\n');
}

// ── tables/*.csv (plan §3.3) ──────────────────────────────────────────────────

export function renderSummaryTables(s: AnalyticsSnapshotV2): Record<string, string> {
  const tables: Record<string, string> = {};

  // agents-overhead.csv
  {
    const cav = surfaceCaveatCodes(s, 'contextOverhead');
    const rows = (s.surfaces.contextOverhead.data?.agents ?? []).map((a) => [
      a.id, a.name, a.kind, a.lane,
      num(a.residentTotal?.tokens), num(a.onDemandTotal?.tokens), num(a.total?.tokens),
      a.exactness ?? '', (a.warnings ?? []).length, cav,
    ]);
    tables['agents-overhead.csv'] = csvTable(
      ['agent_id', 'agent_name', 'kind', 'lane', 'resident_tokens', 'on_demand_tokens',
        'total_tokens', 'exactness', 'warning_count', 'caveat_codes'],
      rows);
  }

  // proposals.csv — NO generic occurrence-count column. The improvisation-cluster
  // count exists in exactly one column, under its literal diagnostic-only key, and
  // is populated ONLY for cluster-rollup rows (plan §4.1).
  {
    const cav = surfaceCaveatCodes(s, 'optimizer');
    const proposals = (s.surfaces.optimizer.data?.proposals ?? []) as Array<Record<string, unknown>>;
    const rows = proposals.map((p) => {
      const v = p.verification as { verified?: boolean; state?: string } | undefined;
      const rollupCount = p.kind === 'add-cluster-rollup'
        ? num((p.rollup as { count?: number } | undefined)?.count)
        : '';
      // WP3 (G3) — v2-OPTIONAL recommendation-draft columns (capability
      // 'recommendation-drafts'). Empty cells on rows without a draft.
      const draft = p.recommendationDraft as {
        target?: { file?: string; unresolved?: boolean };
        claim?: string;
        evidence?: Array<{ kind?: string }>;
        humanReviewRequired?: boolean;
      } | undefined;
      const unresolved = draft?.target?.unresolved === true;
      return [
        p.id, p.kind, p.title ?? '', p.lane ?? '', p.confidence ?? '', p.actionability ?? '',
        // Printed literally — never mapped to a confidence word (plan §4.2).
        String(v?.verified ?? ''), v?.state ?? '',
        num((p.residentTokenDelta as { estimate?: number } | undefined)?.estimate),
        num(p.tokenTurnsWeight), p.evidenceState ?? '',
        draft && !unresolved ? String(draft.target?.file ?? '') : '',
        draft ? (unresolved ? 'unresolved' : 'file') : '',
        draft?.claim ?? '',
        draft ? [...new Set((draft.evidence ?? []).map((e) => String(e.kind ?? '')))].sort().join(' ') : '',
        draft ? String(draft.humanReviewRequired === true) : '',
        rollupCount, cav,
      ];
    });
    tables['proposals.csv'] = csvTable(
      ['proposal_id', 'kind', 'title', 'lane', 'confidence', 'actionability',
        'verified', 'verification_state', 'resident_token_delta', 'token_turns_weight',
        'evidence_state',
        // WP3 (G3) v2-optional recommendation-draft columns.
        'target_file', 'target_status', 'claim', 'evidence_kinds', 'human_review_required',
        IMPROV_DIAGNOSTIC_KEY, 'caveat_codes'],
      rows);
  }

  // file-heat.csv
  {
    const cav = surfaceCaveatCodes(s, 'optimizer');
    const hot = (s.surfaces.optimizer.data?.fileHeatHot ?? []) as Array<Record<string, unknown>>;
    const gaps = new Set(
      ((s.surfaces.optimizer.data?.fileHeatGuidanceGaps ?? []) as Array<Record<string, unknown>>)
        .map((f) => String(f.pathHash)));
    const rows = hot.map((f) => {
      // WP6 (G6) — extended role/score semantics (capability 'file-heat-extended').
      // Empty cells on rows without the fields (pre-Phase-4 rollup), never zeros:
      // an absent score is unknown, not 0.
      const sc = f.scoreComponents as { reads?: number; writes?: number; executes?: number } | undefined;
      return [
        f.pathHash, f.pathDisplay, f.pathScope, f.lane, f.coverage,
        num(f.reads), num(f.writes), num(f.executes), num(f.distinctStreams),
        String(f.uncovered ?? ''), f.role ?? '',
        f.roleReason ?? '',
        f.score ?? '',
        sc?.reads ?? '', sc?.writes ?? '', sc?.executes ?? '',
        f.operationalNoise === undefined ? '' : String(f.operationalNoise),
        f.hotUncoveredCandidate === undefined ? '' : String(f.hotUncoveredCandidate),
        String(gaps.has(String(f.pathHash))), cav,
      ];
    });
    tables['file-heat.csv'] = csvTable(
      ['path_hash', 'path_display', 'path_scope', 'lane', 'coverage', 'reads', 'writes',
        'executes', 'distinct_streams', 'uncovered', 'role',
        // WP6 (G6) extended columns — `score = executes×3 + writes×2 + reads`,
        // components printed beside it so the formula is checkable per row.
        'role_reason', 'score', 'score_reads', 'score_writes', 'score_executes',
        'operational_noise', 'hot_uncovered',
        'guidance_gap', 'caveat_codes'],
      rows);
  }

  // skill-usage.csv
  {
    const cav = surfaceCaveatCodes(s, 'skillUsage');
    const rows = ((s.surfaces.skillUsage.data?.rows ?? []) as Array<Record<string, unknown>>).map((r) => [
      r.id, r.skill, num(r.count), r.avgEffectiveness ?? '', r.lastUsedMs ?? '',
      r.observableScore ?? '', num(r.scoredInvocations), cav,
    ]);
    tables['skill-usage.csv'] = csvTable(
      ['skill_id', 'skill', 'invocations', 'avg_effectiveness', 'last_used_ms',
        'observable_score', 'scored_invocations', 'caveat_codes'],
      rows);
  }

  // mcp-tool-usage.csv — deliberately carries NO cluster-exemplar column, so no
  // row here can combine the two incomparable surfaces (caveat
  // CROSS_SURFACE_COUNTS_NOT_COMPARABLE).
  {
    const cav = surfaceCaveatCodes(s, 'mcpToolUsage');
    const rollup = s.surfaces.mcpToolUsage.data?.rollup as Record<string, unknown> | undefined | null;
    const rows = ((rollup?.byTool ?? []) as Array<Record<string, unknown>>).map((t) => [
      t.toolName, t.toolShort, t.toolset ?? '', num(t.count), num(t.distinctStreams),
      t.lastTsMs ?? '', cav,
    ]);
    tables['mcp-tool-usage.csv'] = csvTable(
      ['tool_name', 'tool_short', 'toolset', 'calls', 'distinct_streams', 'last_ts_ms', 'caveat_codes'],
      rows);
  }

  // file-sequences.csv — WP9 (G9, capability 'file-sequences'). One row per
  // co-touch pair / predecessor edge / command-family association, discriminated
  // by `kind`; written ONLY when the block exists (no fabricated empty table).
  {
    const seq = s.surfaces.optimizer.data?.fileSequences;
    if (seq) {
      const cav = surfaceCaveatCodes(s, 'optimizer');
      const rows: unknown[][] = [
        ...seq.coTouch.map((p) => [
          'co-touch', p.pathA, p.pathB, p.streamsSupporting, p.occurrences, seq.generationId, cav,
        ]),
        ...seq.predecessors.map((e) => [
          'predecessor', e.path, e.predecessorPath, e.streamsSupporting, e.occurrences, seq.generationId, cav,
        ]),
        ...seq.associatedCommandFamilies.map((a) => [
          'command-family', a.path, a.commandFamily, a.streamsSupporting, a.occurrences, a.generationId, cav,
        ]),
      ];
      // Column is `pair_count`, not `occurrences`: the exporter-wide guard bars
      // any CSV header matching /occurrence/ (improvisation-count containment,
      // analytics-exporter.test.ts) — the JSON block keeps the plan's
      // `occurrences` field name; only the CSV label differs.
      tables['file-sequences.csv'] = csvTable(
        ['kind', 'path', 'related', 'streams_supporting', 'pair_count', 'generation_id', 'caveat_codes'],
        rows);
    }
  }

  // plans.csv
  {
    const cav = surfaceCaveatCodes(s, 'plans');
    const rows = (s.surfaces.plans.data ?? []).map((p) => {
      const listing = p.sections as { sections?: unknown[]; parseError?: string | null } | null;
      const activity = p.activity as { sections?: Array<{ writeCount?: number; eventCount?: number }> } | null;
      const writes = (activity?.sections ?? []).reduce((n, x) => n + num(x.writeCount), 0);
      const events = (activity?.sections ?? []).reduce((n, x) => n + num(x.eventCount), 0);
      return [
        p.plan.id, p.plan.title, p.plan.status, p.plan.updatedAt,
        listing?.sections?.length ?? 0, listing?.parseError ?? '', writes, events, cav,
      ];
    });
    tables['plans.csv'] = csvTable(
      ['plan_id', 'title', 'status', 'updated_at', 'section_count', 'parse_error',
        'section_write_events', 'section_events', 'caveat_codes'],
      rows);
  }

  return tables;
}
