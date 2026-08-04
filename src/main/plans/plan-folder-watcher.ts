// WP-P2B-folder — structured plan-folder ingest (the recursion-aware brain).
//
// This is the ADOPT/reconcile half of the two-root ownership model. `PlansWatcher`
// (src/main/plans-watcher.ts) owns the fs-watcher subscriptions for BOTH roots and
// drives this module per workspace; here we validate §R0 plan folders under the
// state-dir plans home, ADOPT them idempotently by the disk-truth
// `plan.json.plan_artifact_id`, and fire the decoupling `onPlanFolderSettled` seam.
//
// ── Ownership boundary ───────────────────────────────────────────────────────
//   • The LEGACY `<workspace>/plans/` root (flat HTML/markdown) stays with the
//     unchanged reparse pipeline in plans-watcher.ts — never touched here.
//   • The NEW `<workspaceStateDir()>/plans/` root holds STRUCTURED plan
//     DIRECTORIES only (§R0). A folder is a plan iff it carries a `plan.json`
//     with a valid `plan_artifact_id`. Stray / plan.json-less dirs are skipped;
//     malformed `plan.json` is quarantined (diagnostic, never rewritten).
//
// ── What this module does NOT do ─────────────────────────────────────────────
//   • No `author_*` write — those columns do not exist on `plans` (schema-checked
//     by the test). Gallery attribution comes from `plan.json` responsibility
//     history + the §R-ATTR projection, never a folder-adoption author claim.
//   • No `responsible_supervisor_id` / doc-links / P3-owned column writes.
//   • P2L intent-ledger ingest runs at the settled seam after adoption; it does
//     not alter folder validity, adoption, removal, or child-watch decisions.

import fs from 'fs';
import path from 'path';
import type { Workspace } from '../../shared/types';
import { adoptStructuredPlan, softDeletePlan, type StructuredPlanChange } from '../database';
import { workspaceStateDir, workspaceStateDirName } from '../workspace-state-dir';
import { scanPlanIntentLedger } from './plan-intent-ledger';

/** Subdirs a plan folder scatters outputs into (§R0). Watched as bounded child
 *  subscriptions by PlansWatcher; enumerated here for the change signature. */
export const PLAN_FOLDER_OUTPUT_SUBDIRS = ['deliberations', 'research', 'supplements'] as const;

/** Default cap on how many folders get live child subscriptions. Folders beyond
 *  the cap are still ADOPTED and kept current by periodic reconciliation, with a
 *  surfaced `degraded-watch` diagnostic — they never silently stop updating. */
export const DEFAULT_FOLDER_CHILD_SUB_CAP = 64;

const PLAN_JSON_MAX_BYTES = 1_000_000;
/** Bounded fan-out when computing a folder's change signature. */
const SIGNATURE_MAX_FILES = 400;

export type FolderChangeKind = 'boot' | 'adopted' | 'changed';

export type PlanFolderDiagnosticKind =
  | 'malformed-plan-json'
  | 'missing-plan-artifact-id'
  | 'duplicate-artifact-id'
  | 'degraded-watch';

export interface PlanFolderDiagnostic {
  kind: PlanFolderDiagnosticKind;
  workspaceId: string;
  /** Workspace-relative path of the offending / degraded plan folder. */
  relPath: string;
  /** For a duplicate: the workspace-relative path of the canonical folder. */
  otherRelPath?: string;
  detail: string;
}

export interface PlanFolderSettled {
  planId: string;
  folderRelPath: string;
  changeKind: FolderChangeKind;
}

export interface FolderReconcileResult {
  settled: PlanFolderSettled[];
  /** Folder rel paths currently valid + adopted, WITHIN the child-sub cap
   *  (PlansWatcher attaches child subscriptions to exactly these). */
  watchable: string[];
  /** Valid + adopted folder rel paths BEYOND the child-sub cap (periodic
   *  reconciliation only; each carries a `degraded-watch` diagnostic). */
  overCap: string[];
  /** Folder rel paths that were adopted before but are gone/invalid now (their
   *  child subscriptions must be torn down; DB rows soft-deleted). */
  removed: string[];
  diagnostics: PlanFolderDiagnostic[];
}

// ── §R0 folder validity (pure over the filesystem) ───────────────────────────

export type PlanFolderValidity =
  | { valid: true; planArtifactId: string; planSku: string | null }
  | { valid: false; reason: 'absent' | 'malformed' | 'no-artifact-id' };

/** Validate a directory as a §R0 plan folder: `plan.json` must be a regular file
 *  (not a reparse point), parse as JSON, and carry a non-empty string
 *  `plan_artifact_id`. `absent` = no plan.json (a stray dir, skipped silently);
 *  `malformed` / `no-artifact-id` = quarantine with a diagnostic. */
export function validatePlanFolder(folderAbs: string): PlanFolderValidity {
  const planJsonAbs = path.join(folderAbs, 'plan.json');
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(planJsonAbs);
  } catch {
    return { valid: false, reason: 'absent' };
  }
  if (lst.isSymbolicLink() || !lst.isFile() || lst.size > PLAN_JSON_MAX_BYTES) {
    return { valid: false, reason: 'malformed' };
  }
  let json: any;
  try {
    json = JSON.parse(fs.readFileSync(planJsonAbs, 'utf-8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (!json || typeof json.plan_artifact_id !== 'string' || json.plan_artifact_id === '') {
    return { valid: false, reason: 'no-artifact-id' };
  }
  return {
    valid: true,
    planArtifactId: json.plan_artifact_id,
    planSku: typeof json.plan_sku === 'string' ? json.plan_sku : null,
  };
}

/** `plan.md` fs metadata for the row (`path`/`mtime_ms`/`size_bytes`). `plan.md`
 *  may be written late; when absent we fall back to `plan.json`'s metadata so the
 *  row still adopts (validity keys on `plan.json`, not `plan.md`). */
function readPlanMdMeta(folderAbs: string): { mtimeMs: number; sizeBytes: number } {
  for (const name of ['plan.md', 'plan.json']) {
    try {
      const st = fs.lstatSync(path.join(folderAbs, name));
      if (st.isFile() && !st.isSymbolicLink()) return { mtimeMs: st.mtimeMs, sizeBytes: st.size };
    } catch {
      /* try the next */
    }
  }
  return { mtimeMs: 0, sizeBytes: 0 };
}

/** A cheap change signature for a folder: the MAX mtime over `plan.json`,
 *  `plan.md`, `ARC.md`, and the files in the three output subdirs (bounded). A
 *  nested output edit bumps this even when `plan.md` is untouched, so the settled
 *  callback fires precisely on real content change rather than every scan. */
export function computeFolderSignature(folderAbs: string): number {
  let maxMtime = 0;
  let seen = 0;
  const consider = (abs: string): void => {
    if (seen >= SIGNATURE_MAX_FILES) return;
    try {
      const st = fs.lstatSync(abs);
      if (st.isFile() && !st.isSymbolicLink()) {
        seen++;
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
      }
    } catch {
      /* ignore */
    }
  };
  // Top-level files.
  let top: fs.Dirent[] = [];
  try {
    top = fs.readdirSync(folderAbs, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of top) {
    if (e.isFile()) consider(path.join(folderAbs, e.name));
  }
  // Bounded scoped subdirs (depth 1).
  for (const sub of PLAN_FOLDER_OUTPUT_SUBDIRS) {
    let subEntries: fs.Dirent[] = [];
    try {
      subEntries = fs.readdirSync(path.join(folderAbs, sub), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of subEntries) {
      if (e.isFile()) consider(path.join(folderAbs, sub, e.name));
    }
  }
  return maxMtime;
}

// ── Path safety (local; no coupling to another lane's exports) ────────────────

/** Reject a folder name that is unsafe as a single path segment (separators,
 *  traversal, drive letters). Folder listings only yield leaf names, but this
 *  guards a hostile/odd entry from ever composing a path outside the home. */
function safeSegment(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/]/.test(name) && !/^[a-zA-Z]:/.test(name);
}

// ── The ingest reconciler ────────────────────────────────────────────────────

export interface PlanFolderWatcherOptions {
  /** F-C seam: fired AFTER a folder's live `plans` row is resolved (adopt/change),
   *  NEVER on removal. The built-in P2L ledger scan runs first; this optional
   *  callback remains available to downstream consumers. Awaited in a live
   *  reconcile; detach-and-catch on the boot scan. */
  onPlanFolderSettled?: (planId: string, folderRelPath: string, changeKind: FolderChangeKind) => Promise<void> | void;
  /** Injected clock (tests). */
  now?: () => number;
  /** Max folders with live child subscriptions (default 64). */
  childSubCap?: number;
}

interface AdoptedFolder {
  planId: string;
  artifactId: string;
  signature: number;
}

/** Per-workspace ingest state + reconciler. Holds the adopted-folder snapshot so
 *  it can detect newly-valid folders, content changes (signature), and removals
 *  across scans. Synchronous + crash-free: a bad entry is skipped with a
 *  diagnostic, never thrown. */
export class PlanFolderWatcher {
  private readonly onSettled?: PlanFolderWatcherOptions['onPlanFolderSettled'];
  private readonly now: () => number;
  private readonly childSubCap: number;
  /** workspaceId → (folderRelPath → adopted snapshot). */
  private adopted = new Map<string, Map<string, AdoptedFolder>>();

  constructor(opts: PlanFolderWatcherOptions = {}) {
    this.onSettled = opts.onPlanFolderSettled;
    this.now = opts.now ?? (() => Date.now());
    this.childSubCap = opts.childSubCap ?? DEFAULT_FOLDER_CHILD_SUB_CAP;
  }

  /** Absolute state-dir plans home for a workspace (migration-aware). */
  plansHome(ws: Workspace): string {
    return path.join(workspaceStateDir(ws.path, ws.pathType), 'plans');
  }

  /** Workspace-relative POSIX prefix of the state-dir plans home (honors the
   *  `.dashboard` fallback). */
  private relPrefix(ws: Workspace): string {
    return `${workspaceStateDirName(ws.path, ws.pathType)}/plans`;
  }

  /** Full scan + idempotent adopt of every §R0 folder under the state-dir plans
   *  home, then fire settled per resolved live row. Returns the child-subscription
   *  decisions (watchable / overCap / removed) PlansWatcher acts on. */
  async reconcileWorkspace(ws: Workspace, isBoot: boolean): Promise<FolderReconcileResult> {
    const home = this.plansHome(ws);
    const prefix = this.relPrefix(ws);
    const result: FolderReconcileResult = {
      settled: [], watchable: [], overCap: [], removed: [], diagnostics: [],
    };

    const prior = this.adopted.get(ws.id) ?? new Map<string, AdoptedFolder>();
    const next = new Map<string, AdoptedFolder>();
    const seenArtifact = new Map<string, string>(); // artifactId → canonical folderRelPath

    let dirEntries: fs.Dirent[] = [];
    try {
      dirEntries = fs.readdirSync(home, { withFileTypes: true });
    } catch {
      dirEntries = []; // absent home → nothing present; all prior become removals
    }
    const dirNames = dirEntries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter(safeSegment)
      .sort((a, b) => a.localeCompare(b));

    let liveCount = 0;
    for (const name of dirNames) {
      const folderAbs = path.join(home, name);
      // Reject a plan-folder that is itself a reparse point escaping plans/.
      try {
        if (fs.lstatSync(folderAbs).isSymbolicLink()) continue;
      } catch {
        continue;
      }
      const validity = validatePlanFolder(folderAbs);
      if (!validity.valid) {
        if (validity.reason === 'malformed') {
          result.diagnostics.push({
            kind: 'malformed-plan-json', workspaceId: ws.id, relPath: `${prefix}/${name}`,
            detail: `plan.json is unreadable / not valid JSON; quarantined (not adopted, not rewritten): ${prefix}/${name}`,
          });
        } else if (validity.reason === 'no-artifact-id') {
          result.diagnostics.push({
            kind: 'missing-plan-artifact-id', workspaceId: ws.id, relPath: `${prefix}/${name}`,
            detail: `plan.json has no valid plan_artifact_id; not adopted: ${prefix}/${name}`,
          });
        }
        continue; // absent plan.json (stray dir) is skipped silently
      }

      const folderRelPath = `${prefix}/${name}`;

      // Duplicate artifact_id across folders → leave the loser UNREGISTERED with a
      // both-paths diagnostic; the canonical (first, sorted) folder is never rebound.
      const canonical = seenArtifact.get(validity.planArtifactId);
      if (canonical !== undefined) {
        result.diagnostics.push({
          kind: 'duplicate-artifact-id', workspaceId: ws.id, relPath: folderRelPath, otherRelPath: canonical,
          detail: `plan_artifact_id ${validity.planArtifactId} already adopted from ${canonical}; left ${folderRelPath} unregistered`,
        });
        continue;
      }
      seenArtifact.set(validity.planArtifactId, folderRelPath);

      const meta = readPlanMdMeta(folderAbs);
      const signature = computeFolderSignature(folderAbs);

      // Child-subscription cap: over-cap folders are still adopted + reconciled,
      // but get NO live child sub — surface `degraded-watch` so a reader can flag
      // the reduced immediacy. They never silently stop updating (periodic scan).
      liveCount += 1;
      const overCap = liveCount > this.childSubCap;

      let adopt: { planId: string; change: string };
      try {
        adopt = adoptStructuredPlan({
          workspaceId: ws.id,
          artifactId: validity.planArtifactId,
          folderRelPath,
          planPath: `${folderRelPath}/plan.md`,
          mtimeMs: meta.mtimeMs,
          sizeBytes: meta.sizeBytes,
        });
      } catch (err) {
        result.diagnostics.push({
          kind: 'malformed-plan-json', workspaceId: ws.id, relPath: folderRelPath,
          detail: `adopt failed (constraint conflict); left unregistered: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      next.set(folderRelPath, { planId: adopt.planId, artifactId: validity.planArtifactId, signature });
      if (overCap) {
        result.overCap.push(folderRelPath);
        result.diagnostics.push({
          kind: 'degraded-watch', workspaceId: ws.id, relPath: folderRelPath,
          detail: `child-subscription cap (${this.childSubCap}) exceeded; ${folderRelPath} updates via periodic reconciliation only`,
        });
      } else {
        result.watchable.push(folderRelPath);
      }

      // Fire settled on adopt/revive, when the DB row's own metadata moved
      // (`plan.md`/path/mtime — `adopt.change === 'changed'`), or when a NESTED
      // output signature moved against a KNOWN prior snapshot (a `deliberations/`
      // edit the DB row can't see). NEVER on a pure no-op re-scan: a fresh watcher
      // (empty prior) re-scanning a steady-state folder returns `unchanged` from
      // the DB and stays quiet — the DB, not the absence of an in-memory snapshot,
      // is the source of truth for "did this change?".
      const priorSnap = prior.get(folderRelPath);
      let changeKind: FolderChangeKind | null = null;
      if (isBoot) changeKind = 'boot';
      else if (adopt.change === 'adopted' || adopt.change === 'revived') changeKind = 'adopted';
      else if (adopt.change === 'changed' || (priorSnap != null && priorSnap.signature !== signature)) changeKind = 'changed';

      if (changeKind !== null) {
        result.settled.push({ planId: adopt.planId, folderRelPath, changeKind });
        await this.fireSettled(ws, adopt.planId, folderAbs, folderRelPath, changeKind, isBoot);
      }
    }

    // Removals: previously adopted, now gone/invalid → soft-delete + report so the
    // child subscription is torn down. NEVER fire settled on removal.
    for (const [folderRelPath, snap] of prior) {
      if (next.has(folderRelPath)) continue;
      result.removed.push(folderRelPath);
      try {
        softDeletePlan(snap.planId);
      } catch (err) {
        // A row already gone / reclaimed is fine — the folder is gone regardless.
        void err;
      }
    }

    this.adopted.set(ws.id, next);
    return result;
  }

  /** Await in a live reconcile (deterministic ordering); detach-and-catch on the
   *  boot scan so a cold start with many folders isn't serialized (mirrors the
   *  legacy PlansWatcher F-C discipline). */
  private async fireSettled(
    ws: Workspace, planId: string, folderAbs: string, folderRelPath: string,
    changeKind: FolderChangeKind, isBoot: boolean,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const scan = scanPlanIntentLedger({
        workspaceId: ws.id,
        workspaceRoot: ws.path,
        planId,
        folderAbs,
        folderRelPath,
      });
      for (const diagnostic of scan.diagnostics) {
        console.warn(`[plan-intent-ledger] ${diagnostic.kind}: ${diagnostic.detail}`);
      }
      if (this.onSettled) await this.onSettled(planId, folderRelPath, changeKind);
    };
    if (isBoot) {
      Promise.resolve(run())
        .catch((err) => console.error('[plan-folder-watcher] onPlanFolderSettled (boot) threw', err));
    } else {
      await run();
    }
  }

  /** Test/inspection seam: the adopted-folder snapshot for a workspace. */
  adoptedFoldersForTests(workspaceId: string): string[] {
    return [...(this.adopted.get(workspaceId)?.keys() ?? [])];
  }
}

// ── Narrow public idempotent single-folder adopt (WP-P3-reconcile) ────────────
// A P3-owned, explicitly-listed extension of this file — NOT a behavior change to
// the reconciler above. WP-P3-reconcile needs a public, idempotent
// "ensure the adopted row exists for exactly this folder" entrypoint; it reuses
// the SAME per-folder adopt steps `reconcileWorkspace` runs (§R0 validity →
// plan.md/plan.json fs metadata → the disk-truth `adoptStructuredPlan` keyed by
// (workspace_id, plan_artifact_id)). Idempotent: a second call for an
// already-adopted folder is a no-op refresh (`change: 'unchanged'`).

export type AdoptFailureReason = 'absent' | 'malformed' | 'no-artifact-id' | 'conflict';

export interface AdoptResult {
  /** true when a live `plans` row exists for this folder after the call. */
  adopted: boolean;
  /** The resolved `plans` row id when adopted. */
  planId?: string;
  /** What the underlying idempotent adopt did (adopted/revived/changed/unchanged). */
  change?: StructuredPlanChange;
  /** Why the folder was NOT adopted (absent dir/plan.json, malformed, no
   *  artifact-id, or a constraint conflict) — never thrown, always reported. */
  reason?: AdoptFailureReason;
}

/** Idempotently adopt exactly one §R0 plan folder under a workspace's state-dir
 *  plans home, keyed by disk-truth `plan.json.plan_artifact_id`. `planFolderRelPath`
 *  is the workspace-relative folder path (e.g. `.lares/plans/<sku>`); only its leaf
 *  segment is trusted — the absolute path is re-derived from the LIVE state-dir
 *  home (migration-aware), and the stored `folder_rel_path` is reconstructed to the
 *  canonical `<stateDirName>/plans/<leaf>` form the watcher uses, so a reconciler
 *  adopt and a watcher adopt converge on the same row. Never throws: an absent /
 *  malformed / conflicting folder is reported via `reason`. */
export async function adoptPlanFolder(ws: Workspace, planFolderRelPath: string): Promise<AdoptResult> {
  const home = path.join(workspaceStateDir(ws.path, ws.pathType), 'plans');
  const leaf = path.basename(planFolderRelPath.replace(/[\\/]+$/, ''));
  if (!safeSegment(leaf)) return { adopted: false, reason: 'absent' };
  const folderAbs = path.join(home, leaf);

  // Reject a folder that is itself a reparse point escaping plans/ (mirror the
  // reconcileWorkspace guard); an absent path is a clean 'absent', never a throw.
  try {
    if (fs.lstatSync(folderAbs).isSymbolicLink()) return { adopted: false, reason: 'malformed' };
  } catch {
    return { adopted: false, reason: 'absent' };
  }

  const validity = validatePlanFolder(folderAbs);
  if (!validity.valid) {
    return {
      adopted: false,
      reason: validity.reason === 'no-artifact-id' ? 'no-artifact-id'
        : validity.reason === 'malformed' ? 'malformed' : 'absent',
    };
  }

  const folderRelPath = `${workspaceStateDirName(ws.path, ws.pathType)}/plans/${leaf}`;
  const meta = readPlanMdMeta(folderAbs);
  try {
    const adopt = adoptStructuredPlan({
      workspaceId: ws.id,
      artifactId: validity.planArtifactId,
      folderRelPath,
      planPath: `${folderRelPath}/plan.md`,
      mtimeMs: meta.mtimeMs,
      sizeBytes: meta.sizeBytes,
    });
    return { adopted: true, planId: adopt.planId, change: adopt.change };
  } catch {
    // A genuine constraint conflict (foreign path/folder collision) — quarantine,
    // never throw; the caller keeps the request pending with a diagnostic.
    return { adopted: false, reason: 'conflict' };
  }
}
