// B2 Task D (P1-04) — workspace `plans/` filesystem watcher.
//
// Boots one subscription per workspace, reconciles the `plans/` directory into
// the `plans` table via the Task-A DB helpers (DEC-5 — direct calls, no HTTP
// loopback), and correlates unlink+add pairs into a rename REBIND so a plan's
// stable uuid `id` (and its `supervisor_focus` rows) survive a rename.
//
// F-C: this module is the SOLE `fs-watcher.subscribe` owner for `plans/`. It
// exposes an injected async-safe `onPlanSettled(plan, change)` callback, fired
// AFTER each live plan row is resolved (never on soft-delete). The callback is a
// constructor dependency, not a hard import — the watcher runs callback-less
// (pure B2 behavior) until WP4 wires `reparsePlanFile`, so the two workstreams
// ship independently.

import crypto from 'crypto';
import fs from 'fs';
import type { PathType, PlanFormat, Plan, Workspace } from '../shared/types';
import { subscribe } from './fs-watcher';
import { listDirectoryEntriesAsync, readFileContents } from './file-reader';
import {
  getWorkspaces, createOrRevivePlan, updatePlan, softDeletePlan,
  getPlanByWorkspacePath, derivePlanSlug, getPlans, getPlan,
} from './database';

const PLANS_SUBDIR = 'plans';
const PLAN_EXT = /\.(html?|md|markdown)$/i;
const DEBOUNCE_MS = 250;            // batch an unlink+add of one rename into one diff
const DELETE_GRACE_MS = 1500;       // cross-cycle grace before a removal becomes a soft delete
const WORKSPACE_REFRESH_MS = 30_000;
const HASH_MAX_BYTES = 1_000_000;

export type PlanChange = 'boot' | 'created' | 'revived' | 'changed' | 'renamed' | 'adopted';

export interface PlansWatcherOptions {
  /** F-C: fired AFTER each live plan row is resolved (never on soft-delete).
   *  Awaited inside the debounced reconcile; `.catch`'d in the boot scan.
   *  Constructor dependency — the watcher runs callback-less until WP4 wires it. */
  onPlanSettled?: (plan: Plan, change: PlanChange) => Promise<void> | void;
  /** Adoption-aware registration (WP3/C6): extract the file's embedded
   *  `data-plan-id`, or null when absent/unreadable. Injectable for tests;
   *  defaults to a file read + attribute scrape. */
  readPlanId?: (ws: Workspace, relPath: string) => Promise<string | null>;
  /** Adoption mint-and-patch: write the resolved server UUID into the file's
   *  `data-plan-id`. Injectable for tests; defaults to a Windows fs read+write
   *  (WSL write is deferred, matching WP4's backfill policy). */
  patchPlanId?: (ws: Workspace, relPath: string, planId: string) => Promise<boolean>;
}

/** Extract a `data-plan-id="…"` value from plan HTML (adoption identity, C6). */
export function extractPlanId(html: string): string | null {
  const m = html.match(/data-plan-id\s*=\s*"([^"]*)"/i);
  return m && m[1] ? m[1] : null;
}

/** Insert/replace `data-plan-id="<id>"` on the file's root element. Replaces an
 *  existing (possibly empty) attribute; else inserts on the first `<body …>`,
 *  else `<html …>`. Returns the patched HTML, or null when no anchor tag exists
 *  (patch skipped — the DB row still owns identity). */
export function patchPlanIdInHtml(html: string, planId: string): string | null {
  if (/data-plan-id\s*=\s*"[^"]*"/i.test(html)) {
    return html.replace(/data-plan-id\s*=\s*"[^"]*"/i, `data-plan-id="${planId}"`);
  }
  for (const tag of ['body', 'html']) {
    const re = new RegExp(`<${tag}(\\s|>)`, 'i');
    if (re.test(html)) {
      return html.replace(re, (_m, tail) => `<${tag} data-plan-id="${planId}"${tail}`);
    }
  }
  return null;
}

export type PlanFileSnapshot = {
  relPath: string; format: PlanFormat; sizeBytes: number; mtimeMs: number;
  dev?: number; ino?: number; contentHash?: string; planId?: string;
};

/** A file that vanished from the listing, held for a grace period so a rename
 *  whose unlink and add land in different debounce cycles is still correlated. */
type PendingRemoval = { snapshot: PlanFileSnapshot; deadline: number };

/** One entry of a fresh directory listing (planId is not yet known). */
export type PlanFileEntry = {
  relPath: string; format: PlanFormat; sizeBytes: number; mtimeMs: number;
  dev?: number; ino?: number; contentHash?: string;
};

export type ReconcileAction =
  | { kind: 'create'; entry: PlanFileEntry }
  | { kind: 'update'; planId: string; entry: PlanFileEntry }
  | { kind: 'rename'; planId: string; oldRelPath: string; entry: PlanFileEntry }
  | { kind: 'soft-delete'; planId: string; relPath: string };

/** `.html`/`.htm` → 'html'; `.md`/`.markdown` → 'md' (D4). */
export function inferFormat(relPath: string): PlanFormat {
  return /\.html?$/i.test(relPath) ? 'html' : 'md';
}

/** Rename identity match, strongest first (D4):
 *   1. same dev + ino,
 *   2. same cached contentHash,
 *   3. same sizeBytes + rounded mtimeMs — ONLY when exactly one removal is
 *      pending with a matching extension (guards against false positives). */
function matchRenameTarget(
  entry: PlanFileEntry,
  pending: Map<string, PendingRemoval>,
): PendingRemoval | null {
  const removals = [...pending.values()];
  // tier 1 — dev + ino
  if (entry.dev !== undefined && entry.ino !== undefined) {
    const hit = removals.find(r => r.snapshot.dev === entry.dev && r.snapshot.ino === entry.ino);
    if (hit) return hit;
  }
  // tier 2 — content hash
  if (entry.contentHash) {
    const hit = removals.find(r => r.snapshot.contentHash && r.snapshot.contentHash === entry.contentHash);
    if (hit) return hit;
  }
  // tier 3 — size + rounded mtime, only when exactly one pending shares the extension
  const ext = extOf(entry.relPath);
  const sameExt = removals.filter(r => extOf(r.snapshot.relPath) === ext);
  if (sameExt.length === 1) {
    const r = sameExt[0];
    if (r.snapshot.sizeBytes === entry.sizeBytes
        && Math.round(r.snapshot.mtimeMs) === Math.round(entry.mtimeMs)) {
      return r;
    }
  }
  return null;
}

function extOf(relPath: string): string {
  const m = relPath.match(PLAN_EXT);
  return m ? m[0].toLowerCase() : '';
}

/**
 * Pure reconcile reducer (D4) — diffs a fresh listing against the stored
 * snapshot + pending-removal state and returns the DB actions to apply plus the
 * next pending-removal map. No fs, no DB, no timers — the D6 tests drive this
 * directly with synthesized listings.
 */
export function reconcilePlanListing(params: {
  listing: PlanFileEntry[];
  snapshots: Map<string, PlanFileSnapshot>;
  pending: Map<string, PendingRemoval>;
  now: number;
  graceMs?: number;
}): { actions: ReconcileAction[]; pending: Map<string, PendingRemoval> } {
  const graceMs = params.graceMs ?? DELETE_GRACE_MS;
  const actions: ReconcileAction[] = [];
  const pending = new Map(params.pending);
  const present = new Set(params.listing.map(e => e.relPath));

  // (a) Snapshots absent from the listing → move to pending (once; deadline
  //     survives across cycles). A matched rename clears the entry in (b).
  for (const [relPath, snap] of params.snapshots) {
    if (present.has(relPath)) continue;
    if (!pending.has(relPath)) {
      pending.set(relPath, { snapshot: snap, deadline: params.now + graceMs });
    }
  }

  // (b) Walk the listing: existing path → no-op / update; new path → rename or create.
  for (const entry of params.listing) {
    const snap = params.snapshots.get(entry.relPath);
    if (snap) {
      if (snap.planId && (snap.mtimeMs !== entry.mtimeMs || snap.sizeBytes !== entry.sizeBytes)) {
        actions.push({ kind: 'update', planId: snap.planId, entry });
      }
      continue; // unchanged → snapshot refresh happens in the applier
    }
    // New path — try to correlate with a pending removal (rename).
    const match = matchRenameTarget(entry, pending);
    if (match && match.snapshot.planId) {
      actions.push({ kind: 'rename', planId: match.snapshot.planId, oldRelPath: match.snapshot.relPath, entry });
      pending.delete(match.snapshot.relPath);
    } else {
      actions.push({ kind: 'create', entry });
    }
  }

  // (c) Pending removals whose grace expired unmatched → soft-delete.
  for (const [relPath, removal] of pending) {
    if (removal.deadline <= params.now && removal.snapshot.planId) {
      actions.push({ kind: 'soft-delete', planId: removal.snapshot.planId, relPath });
      pending.delete(relPath);
    }
  }

  return { actions, pending };
}

// ── Watcher ─────────────────────────────────────────────────────────────────

type WorkspaceState = {
  ws: Workspace;
  plansDir: string;
  snapshots: Map<string, PlanFileSnapshot>;
  pending: Map<string, PendingRemoval>;
  unsubscribe: () => void;
  debounce: ReturnType<typeof setTimeout> | null;
};

function log(msg: string, err?: unknown): void {
  if (err !== undefined) console.error(`[plans-watcher] ${msg}`, err);
  else console.log(`[plans-watcher] ${msg}`);
}

export class PlansWatcher {
  private states = new Map<string, WorkspaceState>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(private readonly opts: PlansWatcherOptions = {}) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.attachAll(true);
    this.refreshTimer = setInterval(() => { void this.attachAll(false); }, WORKSPACE_REFRESH_MS);
  }

  stop(): void {
    this.started = false;
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    for (const st of this.states.values()) {
      if (st.debounce) clearTimeout(st.debounce);
      try { st.unsubscribe(); } catch { /* ignore */ }
    }
    this.states.clear();
  }

  /** (Re)attach a watcher for every workspace whose `plans/` dir exists but is
   *  not yet watched. Never creates `plans/` as a side effect. */
  private async attachAll(isBoot: boolean): Promise<void> {
    let workspaces: Workspace[];
    try { workspaces = getWorkspaces(); } catch (err) { log('getWorkspaces failed', err); return; }
    for (const ws of workspaces) {
      if (this.states.has(ws.id)) continue;
      const plansDir = plansDirFor(ws);
      if (!dirExists(ws, plansDir)) continue;
      const state: WorkspaceState = {
        ws, plansDir, snapshots: new Map(), pending: new Map(),
        unsubscribe: () => {}, debounce: null,
      };
      this.states.set(ws.id, state);
      // Boot reconcile BEFORE subscribing so the initial listing seeds snapshots.
      try { await this.reconcileWorkspace(ws, isBoot); }
      catch (err) { log(`boot reconcile failed for ${ws.id}`, err); }
      try {
        state.unsubscribe = subscribe(plansDir, ws.pathType, () => this.scheduleReconcile(ws.id));
      } catch (err) { log(`subscribe failed for ${ws.id}`, err); }
    }
  }

  private scheduleReconcile(workspaceId: string): void {
    const st = this.states.get(workspaceId);
    if (!st) return;
    if (st.debounce) clearTimeout(st.debounce);
    st.debounce = setTimeout(() => {
      st.debounce = null;
      void this.reconcileWorkspace(st.ws, false).catch(err => log(`reconcile failed for ${workspaceId}`, err));
    }, DEBOUNCE_MS);
  }

  /** Full scan + diff for one workspace, then apply the actions + fire callbacks. */
  async reconcileWorkspace(ws: Workspace, isBoot: boolean): Promise<void> {
    const st = this.states.get(ws.id);
    if (!st) return;
    const listing = await this.listPlanFiles(ws, st.plansDir);
    const { actions, pending } = reconcilePlanListing({
      listing, snapshots: st.snapshots, pending: st.pending, now: nowMs(),
    });
    st.pending = pending;

    // Apply actions against the DB, then fire onPlanSettled per resolved live row.
    for (const action of actions) {
      try {
        if (action.kind === 'create') {
          const { plan, change } = await this.applyCreate(ws, action.entry, isBoot);
          this.setSnapshot(st, action.entry, plan.id);
          await this.fireSettled(plan, change, isBoot);
        } else if (action.kind === 'update') {
          const plan = updatePlan(action.planId, {
            mtimeMs: action.entry.mtimeMs, sizeBytes: action.entry.sizeBytes, runState: null,
          });
          this.setSnapshot(st, action.entry, action.planId);
          if (plan) await this.fireSettled(plan, 'changed', isBoot);
        } else if (action.kind === 'rename') {
          const plan = updatePlan(action.planId, {
            path: action.entry.relPath, slug: derivePlanSlug(action.entry.relPath),
            mtimeMs: action.entry.mtimeMs, sizeBytes: action.entry.sizeBytes,
          });
          st.snapshots.delete(action.oldRelPath);
          this.setSnapshot(st, action.entry, action.planId);
          if (plan) await this.fireSettled(plan, 'renamed', isBoot);
        } else if (action.kind === 'soft-delete') {
          softDeletePlan(action.planId);
          st.snapshots.delete(action.relPath);
          // NEVER fire onPlanSettled on soft-delete (F-C).
        }
      } catch (err) {
        log(`action ${action.kind} failed for ${ws.id}`, err);
      }
    }

    // Refresh snapshots for unchanged present files (keep dev/ino/hash current).
    for (const entry of listing) {
      const snap = st.snapshots.get(entry.relPath);
      if (snap?.planId) this.setSnapshot(st, entry, snap.planId);
    }
  }

  /**
   * Adoption-aware create (C6). If the file embeds a `data-plan-id` that names a
   * live plan in THIS workspace, ADOPT it: rebind that plan's path to the file
   * (never remint) → 'adopted'. Otherwise mint via path-idempotent
   * createOrRevivePlan and PATCH the minted id back into the file's
   * `data-plan-id` (mint-and-patch on unknown/missing id). The server UUID
   * always wins; the file's id is reconciled to it (R1 C6).
   */
  private async applyCreate(ws: Workspace, entry: PlanFileEntry, isBoot: boolean): Promise<{ plan: Plan; change: PlanChange }> {
    const embeddedId = await this.resolvePlanId(ws, entry.relPath);
    if (embeddedId) {
      const known = getPlan(embeddedId);
      if (known && known.workspaceId === ws.id && !known.deletedAt) {
        const plan = updatePlan(known.id, {
          path: entry.relPath, slug: derivePlanSlug(entry.relPath),
          format: entry.format, mtimeMs: entry.mtimeMs, sizeBytes: entry.sizeBytes,
        }) ?? known;
        return { plan, change: 'adopted' };
      }
    }
    // Unknown/missing id → mint (path-idempotent) then patch the file's id.
    const existing = getPlanByWorkspacePath(ws.id, entry.relPath);
    const change: PlanChange = isBoot ? 'boot' : (existing?.deletedAt ? 'revived' : 'created');
    const plan = createOrRevivePlan({
      workspaceId: ws.id, path: entry.relPath, format: entry.format,
      mtimeMs: entry.mtimeMs, sizeBytes: entry.sizeBytes,
    });
    if (embeddedId !== plan.id) {
      try { await this.reconcilePlanId(ws, entry.relPath, plan.id); }
      catch (err) { log(`data-plan-id patch failed for ${entry.relPath}`, err); }
    }
    return { plan, change };
  }

  private async resolvePlanId(ws: Workspace, relPath: string): Promise<string | null> {
    if (this.opts.readPlanId) return this.opts.readPlanId(ws, relPath);
    try {
      const fc = await readFileContents(joinWorkspacePath(ws, relPath), ws.pathType);
      if (fc.error || typeof fc.content !== 'string') return null;
      return extractPlanId(fc.content);
    } catch { return null; }
  }

  private async reconcilePlanId(ws: Workspace, relPath: string, planId: string): Promise<boolean> {
    if (this.opts.patchPlanId) return this.opts.patchPlanId(ws, relPath, planId);
    if (ws.pathType !== 'windows') { log(`data-plan-id patch skipped (WSL deferred) for ${relPath}`); return false; }
    try {
      const abs = joinWorkspacePath(ws, relPath);
      const fc = await readFileContents(abs, ws.pathType);
      if (fc.error || typeof fc.content !== 'string') return false;
      const patched = patchPlanIdInHtml(fc.content, planId);
      if (patched === null || patched === fc.content) return false;
      fs.writeFileSync(abs, patched, 'utf8');
      return true;
    } catch (err) { log(`reconcilePlanId failed for ${relPath}`, err); return false; }
  }

  private setSnapshot(st: WorkspaceState, entry: PlanFileEntry, planId: string): void {
    st.snapshots.set(entry.relPath, {
      relPath: entry.relPath, format: entry.format, sizeBytes: entry.sizeBytes,
      mtimeMs: entry.mtimeMs, dev: entry.dev, ino: entry.ino,
      contentHash: entry.contentHash, planId,
    });
  }

  /** Await in the debounced reconcile (deterministic ordering); detach-and-catch
   *  in the boot scan so a cold start with many plans isn't serialized (F-C). */
  private async fireSettled(plan: Plan, change: PlanChange, isBoot: boolean): Promise<void> {
    if (!this.opts.onPlanSettled) return;
    if (isBoot) {
      Promise.resolve(this.opts.onPlanSettled(plan, change)).catch(err => log('onPlanSettled (boot) threw', err));
    } else {
      await Promise.resolve(this.opts.onPlanSettled(plan, change));
    }
  }

  private async listPlanFiles(ws: Workspace, plansDir: string): Promise<PlanFileEntry[]> {
    let entries;
    try { entries = await listDirectoryEntriesAsync(plansDir, ws.pathType); }
    catch (err) { log(`listing failed for ${ws.id}`, err); return []; }
    const out: PlanFileEntry[] = [];
    for (const e of entries) {
      if (e.isDirectory || !PLAN_EXT.test(e.name)) continue;
      const relPath = `${PLANS_SUBDIR}/${e.name}`;
      out.push({
        relPath, format: inferFormat(relPath),
        sizeBytes: e.size ?? 0, mtimeMs: e.mtimeMs ?? 0,
        dev: e.dev, ino: e.ino,
        contentHash: this.hashIfCheap(ws, e.path, e.size ?? 0),
      });
    }
    return out;
  }

  /** Proactive content hash (≤ HASH_MAX_BYTES) so it survives the unlink and can
   *  correlate a rename on WSL where dev/ino may be unavailable. Windows only —
   *  a synchronous read; WSL relies on dev/ino + size/mtime tiers (open q. #1). */
  private hashIfCheap(ws: Workspace, absPath: string, size: number): string | undefined {
    if (ws.pathType !== 'windows' || size > HASH_MAX_BYTES) return undefined;
    try { return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex'); }
    catch { return undefined; }
  }
}

export function startPlansWatcher(opts?: PlansWatcherOptions): PlansWatcher {
  const w = new PlansWatcher(opts);
  w.start();
  return w;
}

// ── small fs/path helpers (kept local so the module owns its scoping) ─────────

function plansDirFor(ws: Workspace): string {
  // Workspace paths are stored with the host's separator; plans/ is a child dir.
  const sep = ws.pathType === 'wsl' ? '/' : (ws.path.includes('\\') ? '\\' : '/');
  const base = ws.path.replace(/[\\/]+$/, '');
  return `${base}${sep}${PLANS_SUBDIR}`;
}

/** Join a workspace-relative `plans/…` path onto the workspace root (host sep). */
function joinWorkspacePath(ws: Workspace, relPath: string): string {
  const sep = ws.pathType === 'wsl' ? '/' : (ws.path.includes('\\') ? '\\' : '/');
  const base = ws.path.replace(/[\\/]+$/, '');
  return `${base}${sep}${relPath.replace(/\//g, sep)}`;
}

function dirExists(ws: Workspace, dir: string): boolean {
  if (ws.pathType === 'wsl') return true; // WSL existence is validated by the listing (best-effort)
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

// Indirection so tests / callers never depend on Date directly at module scope.
function nowMs(): number { return Date.now(); }

// Re-export for callers that only need the query surface.
export { getPlans };
