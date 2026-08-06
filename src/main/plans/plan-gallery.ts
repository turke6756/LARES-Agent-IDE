// WP-P2C — unified gallery projection + safe proposal read.
//
// A SINGLE server projection for the Plans gallery that unions three durable row
// kinds and nothing else:
//
//   • proposals            — filesystem-owned rows from the `proposals` table.
//   • structured plans      — `plans.format = 'structured'` folder-per-plan rows
//                             (carry `folder_rel_path` + a `hasFolder` flag).
//   • legacy plans          — `plans.format = 'html'` rows, labeled "Legacy Plan".
//
// `plans.format = 'md'` rows are preserved historical records (WP-P2A md-row
// policy) and are NEVER projected here; any other/unknown format is skipped.
//
// Structured readers use the plan FOLDER (`folder_rel_path` + `plan.json`), never
// `plans.path` (which the HTML surfaces own). The exclusion of structured rows
// from the HTML/projection/pane paths is asserted by WP-P2C-compat, not here.
//
// ATTRIBUTION. Proposal authorship is witnessed-first (carried on the proposals
// row: 'supervisor' | 'worker' | 'unknown'). A structured folder row's AUTHOR is
// always `unknown` here — a folder adoption witnesses no author. Its OWNER chip
// is a distinct signal sourced from `plan.json` responsibility history (the last
// `assigned` event); responsibility is never relabeled as author attribution.
//
// This module composes existing WP-P2A accessors + a local read of the extra
// `plans` columns via getDb() (WP-P2A added them but rowToPlan does not surface
// them, and WP-P2B is concurrently editing database.ts, so we keep the query
// local per the WP constraint). `proposal:read` re-derives + re-validates the
// proposal's absolute path (containment inside the state-dir proposals home +
// reparse-point rejection + a per-file byte cap) at read time.

import fs from 'fs';
import path from 'path';
import type {
  PathType,
  PlanGalleryAuthor,
  PlanGalleryOptions,
  PlanGalleryOwner,
  PlanGalleryResult,
  PlanGalleryRow,
  ProposalReadResult,
} from '../../shared/types';
import {
  getDb,
  getWorkspace,
  listProposalsByWorkspace,
  getProposalByWorkspacePath,
  type ProposalRecord,
} from '../database';
import { workspaceStateDir } from '../workspace-state-dir';

// ── Caps (overridable in tests) ──────────────────────────────────────────────
export interface PlanGalleryCaps {
  /** Max bytes read from a `plan.json` when deriving the owner chip. */
  maxPlanJsonBytes: number;
  /** Max bytes returned by `proposal:read` (truncate + flag beyond this). */
  maxReadBytes: number;
}

export const DEFAULT_PLAN_GALLERY_CAPS: PlanGalleryCaps = {
  maxPlanJsonBytes: 1_000_000,
  maxReadBytes: 4_000_000,
};

export interface PlanGalleryDeps {
  pathType?: PathType;
  caps?: Partial<PlanGalleryCaps>;
}

function resolveCaps(caps?: Partial<PlanGalleryCaps>): PlanGalleryCaps {
  return { ...DEFAULT_PLAN_GALLERY_CAPS, ...(caps ?? {}) };
}

// ── Date grouping ────────────────────────────────────────────────────────────

/** Bucket a row's creation timestamp into a `YYYY-MM-DD` group. Proposals stamp
 *  epoch-ms integers; plans stamp SQLite `datetime('now')` text ('YYYY-MM-DD
 *  HH:MM:SS'). Both normalize to the ISO calendar day; an unparseable value
 *  degrades to 'unknown' rather than throwing. */
export function toDateGroup(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return 'unknown';
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString().slice(0, 10);
}

// ── Path safety (self-contained; no coupling to another lane's exports) ───────

/** Normalize a relative path: unify separators, reject absolutes/drive letters
 *  and any `..` traversal. Returns the POSIX-normalized rel path or null. */
function safeRel(rel: string): string | null {
  if (typeof rel !== 'string' || rel === '') return null;
  const unified = rel.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) return null;
  const out: string[] = [];
  for (const seg of unified.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    out.push(seg);
  }
  return out.length ? out.join('/') : null;
}

/** Best-effort realpath: canonicalize the nearest existing ancestor and re-append
 *  the missing tail so containment can be checked for a just-deleted path. */
function realpathBestEffort(abs: string): string {
  try {
    return fs.realpathSync.native(abs);
  } catch {
    let cur = abs;
    const tail: string[] = [];
    for (let i = 0; i < 64; i++) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.unshift(path.basename(cur));
      cur = parent;
      try {
        return path.join(fs.realpathSync.native(cur), ...tail);
      } catch {
        /* keep walking up */
      }
    }
    return path.resolve(abs);
  }
}

/** True iff `child` is the same as or nested inside `parent` (case-insensitive
 *  on win32), using canonical separators. */
function isContained(parent: string, child: string): boolean {
  const norm = (p: string): string => {
    let s = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
    if (process.platform === 'win32') s = s.toLowerCase();
    return s;
  };
  const par = norm(parent);
  const ch = norm(child);
  return ch === par || ch.startsWith(par + '/');
}

/** Resolve an in-boundary relative path enforcing traversal/containment + a
 *  reparse-point (realpath) escape check. Returns the absolute path or null. */
function resolveContained(boundary: string, rel: string): string | null {
  const safe = safeRel(rel);
  if (safe === null) return null;
  const abs = path.resolve(boundary, safe);
  if (!isContained(boundary, abs)) return null;
  if (!isContained(realpathBestEffort(boundary), realpathBestEffort(abs))) return null;
  return abs;
}

function readFileCapped(
  abs: string,
  maxBytes: number,
): { content: string; size: number; truncated: boolean } | null {
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    if (st.size > maxBytes) {
      const fd = fs.openSync(abs, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const n = fs.readSync(fd, buf, 0, maxBytes, 0);
        return { content: buf.slice(0, n).toString('utf-8'), size: st.size, truncated: true };
      } finally {
        fs.closeSync(fd);
      }
    }
    return { content: fs.readFileSync(abs, 'utf-8'), size: st.size, truncated: false };
  } catch {
    return null;
  }
}

// ── Owner chip (plan.json responsibility history; mtime-cached) ───────────────

interface OwnerCacheEntry {
  mtimeMs: number;
  owner: PlanGalleryOwner | null;
}
const ownerCache = new Map<string, OwnerCacheEntry>();

/** Test hook: clear the plan.json owner cache between cases. */
export function resetPlanGalleryCachesForTests(): void {
  ownerCache.clear();
}

/** Derive the current responsible-supervisor / owner from a plan folder's
 *  `plan.json` — the LAST `assigned` responsibility event (§R0). Bounded read,
 *  cached on the file's mtime so a hot gallery does not re-parse every row. Any
 *  failure (missing/oversize/malformed plan.json) yields a null owner + a
 *  warning, never a throw. */
function deriveOwner(
  workspaceRoot: string,
  folderRelPath: string,
  caps: PlanGalleryCaps,
  warnings: string[],
): PlanGalleryOwner | null {
  const folderAbs = resolveContained(workspaceRoot, folderRelPath);
  if (folderAbs === null) {
    warnings.push(`owner: folder path failed containment: ${folderRelPath}`);
    return null;
  }
  const planJsonAbs = resolveContained(folderAbs, 'plan.json');
  if (planJsonAbs === null) return null;

  let mtimeMs = 0;
  try {
    const st = fs.lstatSync(planJsonAbs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    mtimeMs = st.mtimeMs;
  } catch {
    return null;
  }

  const cached = ownerCache.get(planJsonAbs);
  if (cached && cached.mtimeMs === mtimeMs) return cached.owner;

  const owner = parsePlanJsonOwner(planJsonAbs, caps.maxPlanJsonBytes, folderRelPath, warnings);
  ownerCache.set(planJsonAbs, { mtimeMs, owner });
  return owner;
}

function parsePlanJsonOwner(
  planJsonAbs: string,
  maxBytes: number,
  folderRelPath: string,
  warnings: string[],
): PlanGalleryOwner | null {
  const read = readFileCapped(planJsonAbs, maxBytes);
  if (read === null) return null;
  let json: any;
  try {
    json = JSON.parse(read.content);
  } catch {
    warnings.push(`owner: unparseable plan.json in ${folderRelPath}`);
    return null;
  }
  const events = json?.responsibility_events;
  if (!Array.isArray(events)) return null;
  // The CURRENT responsible supervisor = the LAST `assigned` event (§R0,
  // append-only history). Scan from the end for the latest assignment.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || typeof e !== 'object' || e.event !== 'assigned') continue;
    return {
      display: typeof e.display === 'string' ? e.display : null,
      agentId: typeof e.agent_id === 'string' ? e.agent_id : null,
      source: typeof e.source === 'string' ? e.source : null,
    };
  }
  return null;
}

// ── Projection ────────────────────────────────────────────────────────────────

interface RawPlanRow {
  id: string;
  path: string;
  slug: string | null;
  format: string;
  run_state: string | null;
  created_at: string;
  updated_at: string;
  mtime_ms: number | null;
  size_bytes: number | null;
  folder_rel_path: string | null;
}

/** Read the union-eligible plan rows WITH the WP-P2A folder column. `rowToPlan`
 *  drops `folder_rel_path`/`format`-adjacent columns, so we select locally rather
 *  than add an accessor to the concurrently-edited database.ts. Excludes soft-
 *  deleted and `md` rows in SQL; only `structured`/`html` are eligible. */
function readGalleryPlanRows(workspaceId: string): RawPlanRow[] {
  return getDb()
    .prepare(
      `SELECT id, path, slug, format, run_state, created_at, updated_at,
              mtime_ms, size_bytes, folder_rel_path
         FROM plans
        WHERE workspace_id = ?
          AND deleted_at IS NULL
          AND format IN ('structured', 'html')
        ORDER BY updated_at DESC`,
    )
    .all(workspaceId) as RawPlanRow[];
}

const PROPOSAL_AUTHOR = (p: ProposalRecord): PlanGalleryAuthor => ({
  role: p.authorRole,
  display: p.authorDisplay,
  agentId: p.authorAgentId,
});

const UNKNOWN_AUTHOR: PlanGalleryAuthor = { role: 'unknown', display: null, agentId: null };

/**
 * Build the unified gallery projection for one workspace. Proposals + structured
 * + legacy rows, date-grouped, sorted newest-first by the row's update time. By
 * default `archived` and `promoted` proposals are hidden (opt in per flag).
 */
export function buildPlanGallery(
  workspaceId: string,
  opts: PlanGalleryOptions = {},
  deps: PlanGalleryDeps = {},
): PlanGalleryResult {
  const warnings: string[] = [];
  const rows: PlanGalleryRow[] = [];
  if (typeof workspaceId !== 'string' || !workspaceId) {
    return { rows, warnings: ['no workspace id'] };
  }

  const caps = resolveCaps(deps.caps);
  const ws = getWorkspace(workspaceId);

  // ── proposals ──
  for (const p of listProposalsByWorkspace(workspaceId)) {
    if (p.deletedAt !== null) continue;
    if (p.state === 'archived' && !opts.includeArchived) continue;
    if (p.state === 'promoted' && !opts.includePromoted) continue;
    rows.push({
      id: p.id,
      type: 'proposal',
      typeLabel: 'Proposal',
      title: p.title ?? p.slug ?? path.basename(p.path).replace(/\.md$/i, ''),
      artifactId: p.artifactId,
      state: p.state,
      dateGroup: toDateGroup(p.createdAt),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      mtimeMs: p.mtimeMs,
      sizeBytes: p.sizeBytes,
      folderRelPath: null,
      hasFolder: false,
      author: PROPOSAL_AUTHOR(p),
      owner: null,
    });
  }

  // ── structured + legacy plans ──
  const wsRoot = ws?.path ?? null;
  for (const r of readGalleryPlanRows(workspaceId)) {
    const isStructured = r.format === 'structured';
    const folderRelPath = isStructured ? r.folder_rel_path : null;
    const hasFolder = isStructured && !!folderRelPath;

    let owner: PlanGalleryOwner | null = null;
    if (isStructured && folderRelPath) {
      if (wsRoot) {
        // folder_rel_path is workspace-relative; the plan.json read resolves +
        // re-validates containment under the workspace root.
        owner = deriveOwner(wsRoot, folderRelPath, caps, warnings);
      } else {
        warnings.push(`owner: no workspace root for ${workspaceId}; skipping plan.json read`);
      }
    }

    rows.push({
      id: r.id,
      type: isStructured ? 'structured' : 'legacy',
      typeLabel: isStructured ? 'Plan' : 'Legacy Plan',
      title: r.slug ?? path.basename(r.path).replace(/\.(html?|md|markdown)$/i, ''),
      artifactId: null,
      state: r.run_state,
      dateGroup: toDateGroup(r.created_at),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      mtimeMs: r.mtime_ms,
      sizeBytes: r.size_bytes,
      folderRelPath,
      hasFolder,
      // A folder adoption witnesses NO author — structured authorship is unknown
      // unless separately witnessed; the owner chip carries responsibility.
      author: UNKNOWN_AUTHOR,
      owner,
    });
  }

  // Newest-first across the union; unparseable dates sink to the bottom.
  rows.sort((a, b) => toDateGroup(b.updatedAt).localeCompare(toDateGroup(a.updatedAt)));

  return { rows, warnings };
}

/**
 * `proposal:read` — read one proposal's markdown by its proposals-row id. The
 * stored path is re-resolved to an absolute path and RE-VALIDATED at read time:
 * containment inside the workspace's state-dir proposals home, reparse-point
 * rejection, and a per-file byte cap (truncate + flag). Returns `{ error }` for
 * an unknown id, a missing workspace, or a path that fails re-validation.
 */
export function readProposalDocument(
  proposalId: string,
  deps: PlanGalleryDeps = {},
): ProposalReadResult | { error: string } {
  if (typeof proposalId !== 'string' || !proposalId) {
    return { error: 'missing proposal id' };
  }
  const caps = resolveCaps(deps.caps);
  const prop = getProposalById(proposalId);
  if (!prop) return { error: 'unknown proposal id' };

  const ws = getWorkspace(prop.workspaceId);
  if (!ws) return { error: 'unknown workspace for proposal' };
  const pathType: PathType = deps.pathType ?? (ws.pathType as PathType) ?? 'windows';

  const stateDir = workspaceStateDir(ws.path, pathType);
  const proposalsDir = path.join(stateDir, 'proposals');

  // Proposals are FLAT *.md at the top of the proposals home; resolve by basename
  // inside that boundary so a `.lares` vs `.dashboard` drift in the stored path
  // can never widen containment.
  const base = path.basename(prop.path.replace(/\\/g, '/'));
  const abs = resolveContained(proposalsDir, base);
  if (abs === null) return { error: 'proposal path failed containment re-validation' };

  const read = readFileCapped(abs, caps.maxReadBytes);
  if (read === null) return { error: 'proposal unreadable or no longer present' };
  return {
    id: prop.id,
    name: base,
    content: read.content,
    truncated: read.truncated,
    sizeBytes: read.size,
  };
}

/** Point lookup of a proposal by id. Kept local (query in this module) rather
 *  than adding an accessor to the concurrently-edited database.ts. Exported for the
 *  promotion wiring lane's `resolveProposal` seam (WP-P3-wire). */
export function getProposalById(id: string): ProposalRecord | null {
  const workspaceId = (getDb()
    .prepare(`SELECT workspace_id AS ws, path AS p FROM proposals WHERE id = ?`)
    .get(id) as { ws: string; p: string } | undefined);
  if (!workspaceId) return null;
  return getProposalByWorkspacePath(workspaceId.ws, workspaceId.p);
}
