// WP4 — reparse pipeline (amendments §F-C, §F-B, §F-E).
//
// NOT a second `fs-watcher.subscribe`: `plans-watcher.ts` is the SOLE `plans/`
// subscription owner (F-C). This module exports `reparsePlanFile(plan)`, invoked
// via that watcher's injected `onPlanSettled` callback AFTER registration mints a
// plan_id — so reparse can never run without one. The pipeline:
//
//   read file → parse → mint/backfill + soft-archive anchors (section-anchors)
//     → section-cache.observeReparse → plan_section_changes rows
//     → recordPlanSnapshot (content-addressed, §F-B)
//
// Degradation (§F-E): a failed parse serves the in-memory last-good projection,
// else reconstructs from the latest snapshot blob, else an empty projection with
// `parseError` — and writes NO snapshot and NO change rows. Anchor corruption is
// a repair warning on the projection, never a crash.
//
// The byte-range matcher `resolveEditTargetAnchorForPlan` is wired into
// plan-events' optional `resolveEditTargetAnchor` dep (WP2 seam).

import crypto from 'crypto';
import fs from 'fs';
import type { Plan, PathType, Workspace } from '../../shared/types';
import { readFileContents } from '../file-reader';
import {
  getWorkspace, getPlan, recordPlanSectionChange, recordPlanSnapshot, getLatestPlanSnapshotHtml,
} from '../database';
import { SectionCache, type ParsedSectionHash } from './section-cache';
import {
  parsePlanHtml, parsePlanHtmlSafe, type PlanProjection,
} from './section-reader';
import {
  registerSectionsFromHtml, dbSectionRegistryDeps, type SectionRegistryDeps,
} from './section-anchors';

function log(msg: string, err?: unknown): void {
  if (err !== undefined) console.error(`[watch-plans] ${msg}`, err);
  else console.log(`[watch-plans] ${msg}`);
}

/** Hash the byte-exact INNER HTML of a section/block. Inner (not outer) so that
 *  minting a `data-anchor` or rewording `data-zone` — both in the OPEN tag — is
 *  never mis-attributed as a content change. */
function hashInner(projectionSource: string, startOffset: number, endOffset: number): string {
  return crypto.createHash('sha256').update(projectionSource.slice(startOffset, endOffset), 'utf8').digest('hex');
}

function sectionHashes(projection: PlanProjection): ParsedSectionHash[] {
  const out: ParsedSectionHash[] = [];
  for (const s of projection.sections) {
    if (!s.anchor) continue; // anchorless sections are minted before this runs
    out.push({ sectionAnchor: s.anchor, blockAnchor: null, contentHash: hashInner(projection.source, s.innerStartOffset, s.innerEndOffset) });
    for (const b of s.blocks) {
      if (!b.anchor) continue;
      out.push({ sectionAnchor: s.anchor, blockAnchor: b.anchor, contentHash: hashInner(projection.source, b.innerStartOffset, b.innerEndOffset) });
    }
  }
  return out;
}

// ── injectable deps (production defaults below; tests inject fakes) ────────────

export interface ReparseDeps {
  resolveAbsolutePath(plan: Plan): { absPath: string; pathType: PathType } | null;
  readFile(absPath: string, pathType: PathType): Promise<{ content: string; error?: string }>;
  writeFile(absPath: string, content: string, pathType: PathType): Promise<void>;
  registry: SectionRegistryDeps;
  recordPlanSectionChange(input: {
    planId: string; sectionAnchor: string; blockAnchor?: string | null;
    contentHash: string; changedAt?: string;
  }): string;
  recordPlanSnapshot(planId: string, html: string): string | null;
  getLatestPlanSnapshotHtml(planId: string): string | null;
  /** Parser seam — a throw here triggers the F-E degradation chain. Defaults to
   *  the strict parser so a genuine parse5 failure degrades; tests inject a
   *  throwing parser to exercise the fallback. */
  parse(html: string): PlanProjection;
  now(): string;
}

export interface ReparseOutcome {
  planId: string;
  ok: boolean;
  /** WP-P2C-compat — the plan was mechanically excluded from the HTML reparse
   *  pipeline because it is a `format='structured'` (folder-adopted) plan, which
   *  has no HTML surface. A structured-not-applicable outcome: no parse, no anchor
   *  mint, no snapshot, no change rows, `ok:false`. (Legacy `html`/`md` rows are
   *  untouched — only `structured` is gated.) */
  notApplicable: boolean;
  parseError: string | null;
  degradedFrom: 'memory' | 'snapshot' | 'empty' | null;
  mintedAnchors: string[];
  mintedBlockAnchors: string[];
  archivedAnchors: string[];
  changedAnchors: string[];
  snapshotId: string | null;
  htmlWritten: boolean;
  warnings: string[];
}

export class PlanReparser {
  private readonly cache: SectionCache;
  /** Last successfully-served projection per plan (F-E last-good, in memory). */
  private readonly lastGood = new Map<string, PlanProjection>();

  constructor(private readonly deps: ReparseDeps) {
    this.cache = new SectionCache({ recordPlanSectionChange: deps.recordPlanSectionChange });
  }

  /** The projection currently served for a plan (for WP3/WP5 render/read). */
  getServedProjection(planId: string): PlanProjection | null {
    return this.lastGood.get(planId) ?? null;
  }

  /**
   * Byte-range matcher (WP2 `resolveEditTargetAnchor` seam). Given a native-edit
   * payload (an old_string / hunk fragment), find the section whose byte-exact
   * fragment CONTAINS it → that section is the edit target. Prefers the most
   * specific (smallest containing) section. Returns null when nothing matches.
   */
  resolveEditTargetAnchor(payload: string | null, planId: string): string | null {
    if (!payload) return null;
    const projection = this.lastGood.get(planId);
    if (!projection) return null;
    let best: { anchor: string; size: number } | null = null;
    for (const s of projection.sections) {
      if (!s.anchor) continue;
      if (s.raw.includes(payload)) {
        const size = s.raw.length;
        if (!best || size < best.size) best = { anchor: s.anchor, size };
      }
    }
    return best ? best.anchor : null;
  }

  async reparse(plan: Plan): Promise<ReparseOutcome> {
    const planId = plan.id;
    const base: ReparseOutcome = {
      planId, ok: false, notApplicable: false, parseError: null, degradedFrom: null,
      mintedAnchors: [], mintedBlockAnchors: [], archivedAnchors: [], changedAnchors: [],
      snapshotId: null, htmlWritten: false, warnings: [],
    };

    // WP-P2C-compat: a `format='structured'` (folder-adopted) plan has no HTML
    // surface — mechanically exclude it from the HTML reparse pipeline here: no
    // parse, no anchor mint/backfill write, no snapshot, no change rows, no crash.
    // Legacy `html`/`md` rows are unaffected (md keeps its existing HTML-parsed path).
    if (plan.format === 'structured') {
      base.notApplicable = true;
      return base;
    }

    const resolved = this.deps.resolveAbsolutePath(plan);
    if (!resolved) { log(`could not resolve path for plan ${planId}`); return base; }

    let read: { content: string; error?: string };
    try {
      read = await this.deps.readFile(resolved.absPath, resolved.pathType);
    } catch (err) {
      log(`read failed for ${planId}`, err); return base;
    }
    if (read.error || typeof read.content !== 'string') {
      log(`read error for ${planId}: ${read.error ?? 'no content'}`);
      return base;
    }
    const source = read.content;

    // ── parse (degradation seam) ───────────────────────────────────────────────
    let liveOk = true;
    let parseError: string | null = null;
    try {
      const probe = this.deps.parse(source);
      if (probe.parseError) { liveOk = false; parseError = probe.parseError; }
    } catch (err) {
      liveOk = false;
      parseError = err instanceof Error ? err.message : String(err);
    }

    if (!liveOk) {
      return this.degrade(planId, parseError, base);
    }

    // ── live parse OK → register (mint/backfill + soft-archive) ────────────────
    let register;
    try {
      register = registerSectionsFromHtml(this.deps.registry, planId, source, this.deps.now());
    } catch (err) {
      // A register-time throw (corruption slipping past the probe) still degrades.
      return this.degrade(planId, err instanceof Error ? err.message : String(err), base);
    }
    const projection = register.projection;
    base.mintedAnchors = register.mintedAnchors;
    base.mintedBlockAnchors = register.mintedBlockAnchors;
    base.archivedAnchors = register.archivedAnchors;
    base.warnings = register.warnings;

    // Persist the anchor backfill to disk so anchors are stable across reparses.
    if (register.htmlChanged) {
      try {
        await this.deps.writeFile(resolved.absPath, register.html, resolved.pathType);
        base.htmlWritten = true;
      } catch (err) {
        log(`anchor-backfill write failed for ${planId} (anchors still registered in DB)`, err);
      }
    }

    // ── effect store: section_changes for moved hashes ─────────────────────────
    const changed = this.cache.observeReparse(planId, sectionHashes(projection), this.deps.now());
    base.changedAnchors = changed.map((c) => c.blockAnchor ?? c.sectionAnchor);

    // ── snapshot (content-addressed, consecutive-dedup) ────────────────────────
    try {
      base.snapshotId = this.deps.recordPlanSnapshot(planId, register.html);
    } catch (err) {
      log(`snapshot failed for ${planId}`, err);
    }

    this.lastGood.set(planId, projection);
    base.ok = true;
    return base;
  }

  /** F-E fallback chain: in-memory last-good → latest snapshot blob → empty. No
   *  snapshot and no change rows are written on a failed parse. */
  private degrade(planId: string, parseError: string | null, base: ReparseOutcome): ReparseOutcome {
    base.parseError = parseError;
    const memory = this.lastGood.get(planId);
    if (memory) {
      base.degradedFrom = 'memory';
      // Re-serve the last-good projection, now stamped with the parse error.
      this.lastGood.set(planId, { ...memory, parseError });
      return base;
    }
    const blobHtml = this.deps.getLatestPlanSnapshotHtml(planId);
    if (blobHtml) {
      const reconstructed = parsePlanHtmlSafe(blobHtml);
      if (!reconstructed.parseError) {
        base.degradedFrom = 'snapshot';
        this.lastGood.set(planId, { ...reconstructed, parseError });
        return base;
      }
    }
    base.degradedFrom = 'empty';
    this.lastGood.set(planId, { sections: [], parseError, warnings: [], source: '' });
    return base;
  }
}

// ── module singleton + production wiring ──────────────────────────────────────

let reparser: PlanReparser | null = null;

/** Wire the production reparser (called from index.ts). Idempotent. */
export function configureReparser(deps?: Partial<ReparseDeps>): PlanReparser {
  reparser = new PlanReparser({ ...productionDeps(), ...deps });
  return reparser;
}

/** F-C entrypoint: invoked by plans-watcher's `onPlanSettled` after a live plan
 *  row is resolved. Lazily wires production deps if not configured. */
export async function reparsePlanFile(plan: Plan): Promise<ReparseOutcome> {
  if (!reparser) reparser = new PlanReparser(productionDeps());
  return reparser.reparse(plan);
}

/** The byte-range matcher, exported for plan-events' `resolveEditTargetAnchor`
 *  dep (WP2 seam). No-op (null) until the reparser is configured. */
export function resolveEditTargetAnchorForPlan(payload: string | null, planId: string): string | null {
  if (!reparser) return null;
  return reparser.resolveEditTargetAnchor(payload, planId);
}

/** The served projection accessor for WP3/WP5. */
export function getServedPlanProjection(planId: string): PlanProjection | null {
  if (!reparser) return null;
  // WP-P2C-compat: a `format='structured'` (folder-adopted) plan never has an HTML
  // projection — even if one somehow got seeded into last-good, mechanically refuse
  // to serve it down the HTML render/read paths. The DB lookup is wrapped so a
  // not-yet-initialized DB (very early boot / a unit test that never called
  // initDatabase) falls through to the in-memory lookup, which is empty for such
  // plans anyway. Legacy `html`/`md` rows are unaffected.
  try {
    const plan = getPlan(planId);
    if (plan && plan.format === 'structured') return null;
  } catch { /* DB not ready — fall through to the in-memory served projection */ }
  return reparser.getServedProjection(planId);
}

/** Test seam — reset the singleton between suites. */
export function __resetReparserForTests(): void { reparser = null; }

function productionDeps(): ReparseDeps {
  return {
    resolveAbsolutePath: (plan) => {
      const ws = getWorkspace(plan.workspaceId);
      if (!ws) return null;
      return { absPath: joinWorkspacePath(ws, plan.path), pathType: ws.pathType };
    },
    readFile: async (absPath, pathType) => {
      const fc = await readFileContents(absPath, pathType);
      return { content: fc.content, error: fc.error };
    },
    writeFile: async (absPath, content, pathType) => {
      if (pathType === 'wsl') {
        // WSL backfill-write is deferred; anchors are still registered in DB.
        // (Windows is the primary path; a WSL write would need a base64 bridge.)
        log(`WSL anchor-backfill write skipped for ${absPath} (deferred)`);
        return;
      }
      fs.writeFileSync(absPath, content, 'utf8');
    },
    registry: dbSectionRegistryDeps(),
    recordPlanSectionChange,
    recordPlanSnapshot,
    getLatestPlanSnapshotHtml,
    parse: parsePlanHtml,
    now: () => new Date().toISOString(),
  };
}

function joinWorkspacePath(ws: Workspace, relPath: string): string {
  const sep = ws.pathType === 'wsl' ? '/' : (ws.path.includes('\\') ? '\\' : '/');
  const base = ws.path.replace(/[\\/]+$/, '');
  const rel = relPath.replace(/^[\\/]+/, '');
  return `${base}${sep}${rel}`;
}
