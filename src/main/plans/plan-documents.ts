// WP-P4A — folder-native tab-model projection and guarded document reads.
//
// Folder documents remain owned by planning-reader: this module neither walks a
// plan folder nor resolves their paths. It selects the one manifest entry bound
// to the plan's current folder identity and forwards only its opaque docIds to
// planning-reader:read. Registered proposal/legacy rows keep their separate,
// server-side workspace/root/byte-cap guard.

import fs from 'fs';
import path from 'path';
import type {
  PathType,
  PlanDocumentReadResult,
  PlanDocumentRef,
  PlanDocumentsModel,
  PlanDocumentTab,
  PlanTabDocument,
  PlanTabKey,
  PlanningReaderEntry,
  PlanningReaderListResult,
  PlanningReaderReadResult,
  Workspace,
} from '../../shared/types';
import { getDb, getWorkspace } from '../database';
import { translateStateRelPath, workspaceStateDir } from '../workspace-state-dir';
import { listPlanningEntries, readPlanningDocument } from './planning-reader';

const MAX_REGISTERED_READ_BYTES = 4_000_000;
export const PACKAGES_PLACEHOLDER = 'not yet implemented — pull Implement to begin';

const TAB_KEYS: readonly PlanTabKey[] = [
  'overview', 'proposal', 'plan', 'deliberations', 'research',
  'supplements', 'packages', 'legacy-html',
];

export interface PlanContext {
  id: string;
  workspaceId: string;
  artifactId: string | null;
  folderRelPath: string | null;
}

export interface RegisteredDocumentRow {
  id: string;
  planId: string;
  workspaceId: string;
  docKind: string;
  relPath: string;
  sortOrder: number;
}

export interface PlanDocumentsDeps {
  getPlanContext?: (planId: string) => PlanContext | null;
  getWorkspace?: (workspaceId: string) => Workspace | null;
  listPlanningEntries?: (workspaceRoot: string, opts: { pathType?: PathType }) => PlanningReaderListResult;
  readPlanningDocument?: (
    docId: string,
    opts: { pathType?: PathType },
  ) => PlanningReaderReadResult | { error: string };
  listRegisteredDocuments?: (planId: string) => RegisteredDocumentRow[];
  getRegisteredDocument?: (planId: string, documentId: string) => RegisteredDocumentRow | null;
  hasWorkPackages?: (planId: string) => boolean;
  maxRegisteredReadBytes?: number;
}

function defaultPlanContext(planId: string): PlanContext | null {
  const row = getDb().prepare(
    `SELECT id, workspace_id, artifact_id, folder_rel_path
       FROM plans WHERE id = ? AND deleted_at IS NULL`,
  ).get(planId) as any;
  return row ? {
    id: row.id,
    workspaceId: row.workspace_id,
    artifactId: row.artifact_id ?? null,
    folderRelPath: row.folder_rel_path ?? null,
  } : null;
}

function rowToRegistered(row: any): RegisteredDocumentRow {
  return {
    id: row.id,
    planId: row.plan_id,
    workspaceId: row.workspace_id,
    docKind: row.doc_kind,
    relPath: row.rel_path,
    sortOrder: row.sort_order,
  };
}

function defaultListRegistered(planId: string): RegisteredDocumentRow[] {
  return (getDb().prepare(
    `SELECT id, plan_id, workspace_id, doc_kind, rel_path, sort_order
       FROM plan_documents
      WHERE plan_id = ? AND doc_kind IN ('proposal', 'legacy-html')
      ORDER BY sort_order, id`,
  ).all(planId) as any[]).map(rowToRegistered);
}

function defaultGetRegistered(planId: string, documentId: string): RegisteredDocumentRow | null {
  const row = getDb().prepare(
    `SELECT id, plan_id, workspace_id, doc_kind, rel_path, sort_order
       FROM plan_documents
      WHERE plan_id = ? AND id = ? AND doc_kind IN ('proposal', 'legacy-html')`,
  ).get(planId, documentId);
  return row ? rowToRegistered(row) : null;
}

/** Optional pre-P5 capability: absence of the table is a normal false result. */
export function hasPlanWorkPackagesInDb(
  database: { prepare(sql: string): { get(...params: unknown[]): unknown } },
  planId: string,
): boolean {
  try {
    const table = database.prepare(
      `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'plan_work_packages'`,
    ).get();
    if (!table) return false;
    return !!database.prepare(`SELECT 1 AS ok FROM plan_work_packages WHERE plan_id = ? LIMIT 1`).get(planId);
  } catch {
    return false;
  }
}

function defaultHasWorkPackages(planId: string): boolean {
  return hasPlanWorkPackagesInDb(getDb(), planId);
}

function depsWithDefaults(deps: PlanDocumentsDeps) {
  return {
    getPlanContext: deps.getPlanContext ?? defaultPlanContext,
    getWorkspace: deps.getWorkspace ?? getWorkspace,
    listPlanningEntries: deps.listPlanningEntries ?? listPlanningEntries,
    readPlanningDocument: deps.readPlanningDocument ?? readPlanningDocument,
    listRegisteredDocuments: deps.listRegisteredDocuments ?? defaultListRegistered,
    getRegisteredDocument: deps.getRegisteredDocument ?? defaultGetRegistered,
    hasWorkPackages: deps.hasWorkPackages ?? defaultHasWorkPackages,
    maxRegisteredReadBytes: deps.maxRegisteredReadBytes ?? MAX_REGISTERED_READ_BYTES,
  };
}

function safeRel(rel: string): string | null {
  if (typeof rel !== 'string' || !rel) return null;
  const unified = rel.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) return null;
  const parts = unified.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length || parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

function contained(parent: string, child: string): boolean {
  const norm = (p: string) => {
    let v = path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
    if (process.platform === 'win32') v = v.toLowerCase();
    return v;
  };
  const p = norm(parent);
  const c = norm(child);
  return c === p || c.startsWith(`${p}/`);
}

function realpathBestEffort(abs: string): string {
  try { return fs.realpathSync.native(abs); } catch {
    let cursor = abs;
    const tail: string[] = [];
    for (let i = 0; i < 64; i++) {
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      tail.unshift(path.basename(cursor));
      cursor = parent;
      try { return path.join(fs.realpathSync.native(cursor), ...tail); } catch { /* keep climbing */ }
    }
    return path.resolve(abs);
  }
}

function resolveContained(boundary: string, rel: string): string | null {
  const safe = safeRel(rel);
  if (!safe) return null;
  const abs = path.resolve(boundary, safe);
  if (!contained(boundary, abs)) return null;
  if (!contained(realpathBestEffort(boundary), realpathBestEffort(abs))) return null;
  return abs;
}

function folderSku(folderRelPath: string): string | null {
  const safe = safeRel(folderRelPath);
  if (!safe) return null;
  const parts = safe.split('/');
  if (parts.length !== 3 || !['.lares', '.dashboard'].includes(parts[0]) || parts[1] !== 'plans') return null;
  return parts[2];
}

/** Select exactly the current folder's entry; same-workspace foreign folders fail closed. */
function currentFolderEntry(
  context: PlanContext,
  result: PlanningReaderListResult,
): PlanningReaderEntry | null {
  if (!context.folderRelPath || !context.artifactId) return null;
  const sku = folderSku(context.folderRelPath);
  if (!sku) return null;
  const matches = result.entries.filter((entry) =>
    entry.kind === 'plan-folder' &&
    entry.planArtifactId === context.artifactId &&
    (entry.planSku === sku || entry.title === sku),
  );
  return matches.length === 1 ? matches[0] : null;
}

function folderTab(kind: string, name: string): PlanTabKey | null {
  if (name === 'plan.json' || name === '.gitkeep') return null;
  if (kind === 'arc' && name === 'ARC.md') return 'overview';
  if (kind === 'plan' && name === 'plan.md') return 'plan';
  if (kind === 'deliberation') return 'deliberations';
  if (kind === 'research') return 'research';
  if (kind === 'supplement') return 'supplements';
  return null;
}

function registeredTab(kind: string): PlanTabKey | null {
  return kind === 'proposal' ? 'proposal' : kind === 'legacy-html' ? 'legacy-html' : null;
}

function inspectRegistered(
  row: RegisteredDocumentRow,
  workspace: Workspace,
): { abs: string; name: string; sizeBytes: number; mtimeMs: number } | null {
  if (row.workspaceId !== workspace.id) return null;
  const translated = translateStateRelPath(workspace.path, row.relPath, workspace.pathType);
  const safe = safeRel(translated);
  if (!safe) return null;
  const stateDir = workspaceStateDir(workspace.path, workspace.pathType);
  const stateName = path.basename(stateDir.replace(/\\/g, '/'));
  const allowed = [
    `${stateName}/proposals`,
    `${stateName}/proposals/supporting`,
    `${stateName}/research/cleared`,
    `${stateName}/plans/legacy`,
  ];
  if (!allowed.some((root) => safe === root || safe.startsWith(`${root}/`))) return null;
  const abs = resolveContained(workspace.path, safe);
  if (!abs) return null;
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return { abs, name: path.basename(abs), sizeBytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function emptyTabs(hasPackages: boolean): PlanDocumentTab[] {
  return TAB_KEYS.map((key) => ({
    key,
    populated: key === 'packages' ? hasPackages : false,
    documents: [],
    ...(key === 'packages' && !hasPackages ? { placeholder: PACKAGES_PLACEHOLDER } : {}),
  }));
}

export function buildPlanDocuments(
  planId: string,
  deps: PlanDocumentsDeps = {},
): PlanDocumentsModel | null {
  if (typeof planId !== 'string' || !planId) return null;
  const d = depsWithDefaults(deps);
  const context = d.getPlanContext(planId);
  if (!context) return null;
  const workspace = d.getWorkspace(context.workspaceId);
  if (!workspace) return { planId, tabs: emptyTabs(false), warnings: ['workspace unavailable'] };

  const warnings: string[] = [];
  let manifest: PlanningReaderListResult = { entries: [], warnings: [] };
  try {
    manifest = d.listPlanningEntries(workspace.path, { pathType: workspace.pathType });
    warnings.push(...manifest.warnings);
  } catch (err) {
    warnings.push(`folder manifest unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entry = currentFolderEntry(context, manifest);
  const tabs = emptyTabs(d.hasWorkPackages(planId));
  const byKey = new Map(tabs.map((tab) => [tab.key, tab]));

  for (const doc of entry?.documents ?? []) {
    const key = folderTab(doc.category, doc.name);
    if (!key) continue;
    const projected: PlanTabDocument = {
      ref: { source: 'folder', documentId: doc.docId },
      name: doc.name,
      kind: doc.category as PlanTabDocument['kind'],
      sizeBytes: doc.sizeBytes,
      mtimeMs: doc.mtimeMs,
    };
    byKey.get(key)!.documents.push(projected);
  }

  for (const row of d.listRegisteredDocuments(planId)) {
    const key = registeredTab(row.docKind);
    if (!key || row.planId !== planId) continue;
    const inspected = inspectRegistered(row, workspace);
    if (!inspected) continue;
    byKey.get(key)!.documents.push({
      ref: { source: 'registered', documentId: row.id },
      name: inspected.name,
      kind: row.docKind as 'proposal' | 'legacy-html',
      sizeBytes: inspected.sizeBytes,
      mtimeMs: inspected.mtimeMs,
    });
  }

  for (const tab of tabs) {
    if (tab.key !== 'packages') tab.populated = tab.documents.length > 0;
  }
  return { planId, tabs, warnings };
}

function isDocumentRef(value: unknown): value is PlanDocumentRef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (v.source === 'folder' || v.source === 'registered') &&
    typeof v.documentId === 'string' && v.documentId.length > 0 &&
    !('path' in v) && !('relPath' in v);
}

export function readPlanDocument(
  planId: string,
  rawRef: unknown,
  deps: PlanDocumentsDeps = {},
): PlanDocumentReadResult | { error: string } {
  if (typeof planId !== 'string' || !planId) return { error: 'missing plan id' };
  if (!isDocumentRef(rawRef)) return { error: 'invalid or unregistered document reference' };
  const d = depsWithDefaults(deps);
  const context = d.getPlanContext(planId);
  if (!context) return { error: 'unknown plan id' };
  const workspace = d.getWorkspace(context.workspaceId);
  if (!workspace) return { error: 'unknown workspace for plan' };

  if (rawRef.source === 'folder') {
    let listed: PlanningReaderListResult;
    try {
      listed = d.listPlanningEntries(workspace.path, { pathType: workspace.pathType });
    } catch {
      return { error: 'plan folder unavailable' };
    }
    const entry = currentFolderEntry(context, listed);
    const manifestDoc = entry?.documents.find((doc) =>
      doc.docId === rawRef.documentId && folderTab(doc.category, doc.name) !== null,
    );
    if (!manifestDoc) return { error: 'document is not registered to the plan folder' };
    const read = d.readPlanningDocument(rawRef.documentId, { pathType: workspace.pathType });
    if ('error' in read) return read;
    return { ref: rawRef, name: read.name, content: read.content, truncated: read.truncated, sizeBytes: read.sizeBytes };
  }

  const row = d.getRegisteredDocument(planId, rawRef.documentId);
  if (!row || row.planId !== planId || !registeredTab(row.docKind)) {
    return { error: 'document is not registered to the plan' };
  }
  const inspected = inspectRegistered(row, workspace);
  if (!inspected) return { error: 'registered document failed path validation or is unavailable' };
  const cap = d.maxRegisteredReadBytes;
  try {
    const fd = fs.openSync(inspected.abs, 'r');
    try {
      const length = Math.min(inspected.sizeBytes, cap);
      const buffer = Buffer.alloc(length);
      const bytes = fs.readSync(fd, buffer, 0, length, 0);
      return {
        ref: rawRef,
        name: inspected.name,
        content: buffer.subarray(0, bytes).toString('utf-8'),
        truncated: inspected.sizeBytes > cap,
        sizeBytes: inspected.sizeBytes,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { error: 'registered document unreadable or no longer present' };
  }
}
