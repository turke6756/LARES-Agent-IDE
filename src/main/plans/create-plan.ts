// WP3 — the create primitive (R1 F0). `createPlanSurface()` is the one server
// function behind the `create_plan` MCP tool and the `POST /api/plans` create
// branch; a dashboard button + a markdown-migration path are later callers of
// the same seam. Markdown migration is DEFERRED (F-F): the `seedMarkdown` param
// stays for forward-compat but is INERT here (no transform); the API/MCP
// boundary rejects markdown-migration input with a 400 upstream, never here.
//
// Flow (R1 F0):
//   1. slugify(title) → plans/<slug>.html, numeric collision suffix (slug is
//      path metadata, not identity).
//   2. createOrRevivePlan → server-minted UUID `plans.id` (we never choose it).
//   3. render DEFAULT_SURFACE_TEMPLATE with that UUID (data-plan-id) + title.
//   4. write the file; refresh mtime/size on the row.
//   5. insert one `plan_sections` row per baked seed anchor.
//   6. return { planId, path, slug }.

import fs from 'fs';
import type { Workspace } from '../../shared/types';
import {
  getWorkspace, getPlanByWorkspacePath, createOrRevivePlan, updatePlan,
  insertPlanSection, derivePlanSlug,
} from '../database';
import { SEED_ZONES, renderDefaultSurface } from './templates/default-surface';

export interface CreatePlanSurfaceInput {
  workspaceId: string;
  title: string;
  /** DEFERRED (F-F): forward-compat only — IGNORED here in v1. The boundary
   *  rejects markdown-migration input upstream with a 400; if one somehow
   *  reaches this function it is silently dropped (never transformed). */
  seedMarkdown?: string;
  /** Reserved for future named templates; only the default ships in v1. */
  templateName?: string;
}

export interface CreatePlanSurfaceResult {
  planId: string;
  path: string;
  slug: string;
}

/** Injected side-effects so the create flow is unit-testable without a live DB
 *  or filesystem. `productionCreatePlanDeps()` wires the real helpers. */
export interface CreatePlanDeps {
  getWorkspace(id: string): Workspace | null;
  getPlanByWorkspacePath(workspaceId: string, relPath: string): { id: string } | null;
  createOrRevivePlan: typeof createOrRevivePlan;
  updatePlan: typeof updatePlan;
  insertPlanSection: typeof insertPlanSection;
  /** True when the relPath is already occupied on disk (collision guard). */
  fileExists(ws: Workspace, relPath: string): boolean;
  /** Write the rendered HTML, creating `plans/` if needed. */
  writeFile(ws: Workspace, relPath: string, content: string): void;
  /** Post-write metadata; null when unavailable (e.g. WSL). */
  statFile(ws: Workspace, relPath: string): { mtimeMs: number; sizeBytes: number } | null;
}

const MAX_COLLISION_SUFFIX = 1000;

/** Title → filesystem-safe slug (lowercase, `[a-z0-9]`-runs joined by `-`). */
export function slugifyTitle(title: string): string {
  const base = String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'plan';
}

/** Resolve `plans/<slug>.html`, appending `-2`, `-3`, … until the path is free
 *  in BOTH the DB (any live plan row) and on disk (F0 collision suffix). */
function resolveFreeRelPath(deps: CreatePlanDeps, ws: Workspace, slug: string): { relPath: string; slug: string } {
  for (let n = 1; n <= MAX_COLLISION_SUFFIX; n++) {
    const candidateSlug = n === 1 ? slug : `${slug}-${n}`;
    const relPath = `plans/${candidateSlug}.html`;
    const dbHit = deps.getPlanByWorkspacePath(ws.id, relPath); // live rows only (soft-deleted excluded)
    if (!dbHit && !deps.fileExists(ws, relPath)) {
      return { relPath, slug: candidateSlug };
    }
  }
  throw Object.assign(
    new Error(`could not find a free plan path for slug "${slug}" after ${MAX_COLLISION_SUFFIX} attempts`),
    { statusCode: 409 },
  );
}

export function createPlanSurface(
  input: CreatePlanSurfaceInput,
  deps: CreatePlanDeps = productionCreatePlanDeps(),
): CreatePlanSurfaceResult {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw Object.assign(new Error('title is required'), { statusCode: 400 });
  // Reject U+FFFD at the seam: a replacement char means the client already lost
  // bytes to a bad encoding boundary. Minting it would bake unrecoverable
  // garbage into a durable file (and its <title>/<h1>); surface it here instead.
  if (title.includes('�')) {
    throw Object.assign(
      new Error(
        'title contains U+FFFD replacement characters — the client call likely ' +
        'sent non-UTF-8 bytes; re-send the title as UTF-8',
      ),
      { statusCode: 400 },
    );
  }

  const ws = deps.getWorkspace(input.workspaceId);
  if (!ws) throw Object.assign(new Error('Workspace not found'), { statusCode: 404 });
  // v1 create writes through the Windows fs; WSL write bridge is deferred.
  if (ws.pathType !== 'windows') {
    throw Object.assign(
      new Error('plan creation currently supports Windows-path workspaces only (v1)'),
      { statusCode: 400 },
    );
  }

  const { relPath, slug } = resolveFreeRelPath(deps, ws, slugifyTitle(title));

  // (2) Server mints the UUID id. Create the row first so we can bake it into the
  // template; size/mtime are refreshed after the write.
  const plan = deps.createOrRevivePlan({
    workspaceId: ws.id, path: relPath, format: 'html',
    slug: derivePlanSlug(relPath), mtimeMs: 0, sizeBytes: 0,
  });

  // (3)+(4) Render with the real UUID + write the file.
  const html = renderDefaultSurface(plan.id, title);
  deps.writeFile(ws, relPath, html);

  const stat = deps.statFile(ws, relPath);
  if (stat) deps.updatePlan(plan.id, { mtimeMs: stat.mtimeMs, sizeBytes: stat.sizeBytes });

  // (5) Register the baked seed anchors (idempotent on (plan_id, anchor)).
  for (const zone of SEED_ZONES) {
    deps.insertPlanSection({ planId: plan.id, anchor: zone.anchor });
  }

  return { planId: plan.id, path: relPath, slug };
}

// ── production wiring ─────────────────────────────────────────────────────────

function plansDirFor(ws: Workspace): string {
  const sep = ws.path.includes('\\') ? '\\' : '/';
  const base = ws.path.replace(/[\\/]+$/, '');
  return `${base}${sep}plans`;
}

/** Join a workspace-relative `plans/…` path onto the workspace root (host sep). */
function absOf(ws: Workspace, relPath: string): string {
  const sep = ws.path.includes('\\') ? '\\' : '/';
  const base = ws.path.replace(/[\\/]+$/, '');
  return `${base}${sep}${relPath.replace(/\//g, sep)}`;
}

export function productionCreatePlanDeps(): CreatePlanDeps {
  return {
    getWorkspace,
    getPlanByWorkspacePath: (workspaceId, relPath) => getPlanByWorkspacePath(workspaceId, relPath),
    createOrRevivePlan,
    updatePlan,
    insertPlanSection,
    fileExists: (ws, relPath) => {
      try { return fs.existsSync(absOf(ws, relPath)); } catch { return false; }
    },
    writeFile: (ws, relPath, content) => {
      fs.mkdirSync(plansDirFor(ws), { recursive: true });
      fs.writeFileSync(absOf(ws, relPath), content, 'utf8');
    },
    statFile: (ws, relPath) => {
      try {
        const st = fs.statSync(absOf(ws, relPath));
        return { mtimeMs: st.mtimeMs, sizeBytes: st.size };
      } catch { return null; }
    },
  };
}
