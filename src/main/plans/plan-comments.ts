// WP-P4D-create — plan-comment create + routing (durable logical-key identity).
//
// Two responsibilities, both server-side and both keeping the renderer out of
// the trust path:
//
//   1. createPlanComment — validate that a document belongs to a plan (EITHER a
//      registered `plan_documents` row OR a folder-manifest doc under the plan's
//      current folder, containment-validated via the WP-P1A manifest), build the
//      durable `file_path`, create the row with the plan's current responsible
//      supervisor as recipient, and route it through the existing send path. The
//      renderer supplies only `planId` + a `PlanDocumentRef` + `body`.
//
//   2. resolvePlanCommentForSend — the plan-aware send/notification adapter. A
//      folder target is stored as a versioned LOGICAL KEY in `file_path`
//      (`selection_comments` has no folder columns and this rescope adds no DDL);
//      for a send the key is resolved to the CURRENT physical path on a CLONE so
//      the prompt/display shows a real path while the stored row is never
//      mutated. A logical target that no longer resolves is surfaced explicitly
//      as an orphaned plan-document target — never a bare path, never a filesystem
//      fall-through.
//
// ── Durable folder-doc comment identity (no DDL) ──
//   lares-plan-doc:v1:<base64url( canonical-json )>
//     canonical-json = {"doc_rel_path_within_folder":"…","plan_artifact_id":"plan_<hex>"}
// Canonical JSON = sorted keys, no insignificant whitespace, UTF-8; base64url
// WITHOUT padding; the `v1:` segment enables a future migration without ambiguity.
// `plan_artifact_id` (R0 durable identity) is the identity — never
// `folder_rel_path` / SKU / the opaque manifest id. For a logical target the row
// stores `path_type = NULL` and `root_directory = NULL` (`PathType` is
// 'windows' | 'wsl' — there is no out-of-domain sentinel that could reach
// path-conversion code). The exact `lares-plan-doc:v1:` prefix is the SOLE
// logical-target discriminator; external `plan_documents` targets keep their
// ordinary `file_path` / `path_type` / `root_directory` unchanged.

import fs from 'fs';
import path from 'path';
import type {
  CreateSelectionCommentInput,
  PathType,
  PlanCommentCreateRequest,
  PlanCommentCreateResult,
  PlanDocumentRef,
  PlanningReaderDocument,
  PlanningReaderEntry,
  PlanningReaderListResult,
  SelectionComment,
  SendSelectionCommentsResult,
  Workspace,
} from '../../shared/types';
import { getDb, getWorkspace } from '../database';
import { translateStateRelPath } from '../workspace-state-dir';
import { listPlanningEntries } from './planning-reader';
import type { PlanContext, RegisteredDocumentRow } from './plan-documents';

// ── Logical-key constants + discriminator ─────────────────────────────────────

/** The general logical-target discriminator (any version). Any generic
 *  filesystem comment lookup must treat a `file_path` with this prefix as a
 *  logical target, never an OS path. */
export const LOGICAL_PLAN_DOC_PREFIX = 'lares-plan-doc:';
/** The one version this WP encodes and decodes. */
export const LOGICAL_PLAN_DOC_V1_PREFIX = 'lares-plan-doc:v1:';

export function isLogicalPlanDocKey(filePath: string | null | undefined): boolean {
  return typeof filePath === 'string' && filePath.startsWith(LOGICAL_PLAN_DOC_PREFIX);
}

// ── Canonicalization ──────────────────────────────────────────────────────────

/**
 * Strict canonicalizer for a doc-rel-path-within-folder: normalize to POSIX and
 * reject a mixed-separator (any backslash), an absolute / drive-rooted path, and
 * any `..` traversal. Returns the POSIX relative path or null. A legitimately
 * encoded key never carries a backslash, so rejecting them outright makes a
 * malformed key undecodable rather than silently reinterpreted.
 */
export function canonicalDocRelPath(rel: unknown): string | null {
  if (typeof rel !== 'string' || rel === '') return null;
  if (rel.includes('\\')) return null; // mixed / backslash separators → reject
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return null; // absolute / drive
  const out: string[] = [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    out.push(seg);
  }
  return out.length ? out.join('/') : null;
}

// ── Logical-key encode / decode ───────────────────────────────────────────────

export interface DecodedPlanDocKey {
  planArtifactId: string;
  docRelPathWithinFolder: string;
}

/** Encode a folder target as the versioned logical key. `docRelPathWithinFolder`
 *  MUST already be canonical (POSIX, contained). The canonical JSON is written
 *  with sorted keys and no whitespace; base64url omits padding. */
export function encodePlanDocKey(planArtifactId: string, docRelPathWithinFolder: string): string {
  // Sorted keys ('doc_rel_path_within_folder' < 'plan_artifact_id'), no
  // whitespace; JSON.stringify handles UTF-8 string escaping.
  const canonical =
    `{"doc_rel_path_within_folder":${JSON.stringify(docRelPathWithinFolder)},` +
    `"plan_artifact_id":${JSON.stringify(planArtifactId)}}`;
  const b64 = Buffer.from(canonical, 'utf-8').toString('base64url');
  return `${LOGICAL_PLAN_DOC_V1_PREFIX}${b64}`;
}

/**
 * Decode a stored `file_path` ONLY when it is the exact `lares-plan-doc:v1:`
 * form. Returns null for a non-logical path, an unknown/other version, a
 * malformed payload, or a non-canonical rel path — every one of which the caller
 * treats as an orphaned plan-document target, never a filesystem path.
 */
export function decodePlanDocKey(filePath: string | null | undefined): DecodedPlanDocKey | null {
  if (typeof filePath !== 'string' || !filePath.startsWith(LOGICAL_PLAN_DOC_V1_PREFIX)) return null;
  const b64 = filePath.slice(LOGICAL_PLAN_DOC_V1_PREFIX.length);
  if (b64 === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  const planArtifactId = rec.plan_artifact_id;
  const rawRel = rec.doc_rel_path_within_folder;
  if (typeof planArtifactId !== 'string' || planArtifactId === '') return null;
  const docRelPathWithinFolder = canonicalDocRelPath(rawRel);
  if (!docRelPathWithinFolder) return null;
  return { planArtifactId, docRelPathWithinFolder };
}

// ── Manifest cross-index helpers (shared with the folder-native tab model) ─────

function safeRel(rel: string | null | undefined): string | null {
  if (typeof rel !== 'string' || !rel) return null;
  const unified = rel.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) return null;
  const parts = unified.split('/').filter((p) => p !== '' && p !== '.');
  if (!parts.length || parts.some((p) => p === '..')) return null;
  return parts.join('/');
}

/** SKU from a `<stateDir>/plans/<sku>` folder-rel-path (mirrors WP-P4A). */
function folderSku(folderRelPath: string): string | null {
  const safe = safeRel(folderRelPath);
  if (!safe) return null;
  const parts = safe.split('/');
  if (parts.length !== 3 || !['.lares', '.dashboard'].includes(parts[0]) || parts[1] !== 'plans') return null;
  return parts[2];
}

/** Select exactly the plan's current folder entry (same-workspace foreign
 *  folders fail closed), keyed on the durable `plan_artifact_id`. */
function currentFolderEntry(
  context: PlanContext,
  result: PlanningReaderListResult,
): PlanningReaderEntry | null {
  if (!context.folderRelPath || !context.artifactId) return null;
  const sku = folderSku(context.folderRelPath);
  if (!sku) return null;
  const matches = result.entries.filter(
    (entry) =>
      entry.kind === 'plan-folder' &&
      entry.planArtifactId === context.artifactId &&
      (entry.planSku === sku || entry.title === sku),
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Manifest-resolved in-folder rel path for a commentable folder doc. Inverse of
 * `enumerateFolderDocs` (planning-reader): a scoped subdir doc lives under its
 * category's subdir, a canonical top-level doc (`plan.md`/`ARC.md`) at the root.
 * Only categories that project to a plan tab are commentable; `other`/`proposal`
 * return null (proposals are the registered-doc source, not a folder target).
 */
function commentableFolderDocRelPath(doc: PlanningReaderDocument): string | null {
  switch (doc.category) {
    case 'plan':
    case 'arc':
      return doc.name; // canonical top-level doc
    case 'deliberation':
      return `deliberations/${doc.name}`;
    case 'research':
      return `research/${doc.name}`;
    case 'supplement':
      return `supplements/${doc.name}`;
    default:
      return null; // 'other' / 'proposal' → not a commentable folder tab doc
  }
}

// ── Physical-path helpers ─────────────────────────────────────────────────────

function joinWorkspacePath(base: string, rel: string, pathType: PathType): string {
  if (pathType === 'wsl') return `${base.replace(/\/+$/, '')}/${rel}`;
  return path.resolve(base, rel);
}

function isContainedLexical(parent: string, child: string, pathType: PathType): boolean {
  const norm = (p: string): string => {
    let v = (pathType === 'wsl' ? p : path.resolve(p)).replace(/\\/g, '/').replace(/\/+$/, '');
    if (process.platform === 'win32' && pathType !== 'wsl') v = v.toLowerCase();
    return v;
  };
  const par = norm(parent);
  const ch = norm(child);
  return ch === par || ch.startsWith(`${par}/`);
}

function defaultFileExists(abs: string, pathType: PathType): boolean {
  // WSL paths are not stat-able from the Windows host here; treat containment as
  // sufficient (best-effort) rather than falsely orphaning them.
  if (pathType === 'wsl') return true;
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

// ── Default db/reader accessors ───────────────────────────────────────────────

function defaultGetPlanContext(planId: string): PlanContext | null {
  const row = getDb()
    .prepare(
      `SELECT id, workspace_id, artifact_id, folder_rel_path
         FROM plans WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(planId) as any;
  return row
    ? {
        id: row.id,
        workspaceId: row.workspace_id,
        artifactId: row.artifact_id ?? null,
        folderRelPath: row.folder_rel_path ?? null,
      }
    : null;
}

function defaultGetRegisteredDocument(planId: string, documentId: string): RegisteredDocumentRow | null {
  const row = getDb()
    .prepare(
      `SELECT id, plan_id, workspace_id, doc_kind, rel_path, sort_order
         FROM plan_documents
        WHERE plan_id = ? AND id = ? AND doc_kind IN ('proposal', 'legacy-html')`,
    )
    .get(planId, documentId) as any;
  return row
    ? {
        id: row.id,
        planId: row.plan_id,
        workspaceId: row.workspace_id,
        docKind: row.doc_kind,
        relPath: row.rel_path,
        sortOrder: row.sort_order,
      }
    : null;
}

function defaultGetResponsibleSupervisorId(planId: string): string | null {
  const row = getDb()
    .prepare(`SELECT responsible_supervisor_id FROM plans WHERE id = ? AND deleted_at IS NULL`)
    .get(planId) as any;
  return row?.responsible_supervisor_id ?? null;
}

/** Current folder-rel-path for a plan identified by its durable artifact id — the
 *  send adapter's `plan_artifact_id → current folder` resolution (a folder rename
 *  updates this row, so the comment stays attached). */
function defaultGetFolderRelPathByArtifact(workspaceId: string, planArtifactId: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT folder_rel_path FROM plans
        WHERE workspace_id = ? AND artifact_id = ? AND deleted_at IS NULL`,
    )
    .get(workspaceId, planArtifactId) as any;
  return row?.folder_rel_path ?? null;
}

// ── createPlanComment ─────────────────────────────────────────────────────────

export interface CreatePlanCommentDeps {
  getPlanContext(planId: string): PlanContext | null;
  getWorkspace(workspaceId: string): Workspace | null;
  listPlanningEntries(workspaceRoot: string, opts: { pathType?: PathType }): PlanningReaderListResult;
  getRegisteredDocument(planId: string, documentId: string): RegisteredDocumentRow | null;
  getResponsibleSupervisorId(planId: string): string | null;
  createComment(input: CreateSelectionCommentInput): SelectionComment;
  /** The plan-aware send/notification path (existing `comments:send`), wired by
   *  ipc-handlers so this module stays free of the supervisor/electron seam. */
  route(commentId: string, recipientId: string): Promise<SendSelectionCommentsResult>;
}

export function defaultCreatePlanCommentDeps(
  createComment: (input: CreateSelectionCommentInput) => SelectionComment,
  route: (commentId: string, recipientId: string) => Promise<SendSelectionCommentsResult>,
): CreatePlanCommentDeps {
  return {
    getPlanContext: defaultGetPlanContext,
    getWorkspace,
    listPlanningEntries,
    getRegisteredDocument: defaultGetRegisteredDocument,
    getResponsibleSupervisorId: defaultGetResponsibleSupervisorId,
    createComment,
    route,
  };
}

function isDocumentRef(value: unknown): value is PlanDocumentRef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (v.source === 'folder' || v.source === 'registered') &&
    typeof v.documentId === 'string' &&
    v.documentId.length > 0 &&
    !('path' in v) &&
    !('relPath' in v)
  );
}

type BuiltTarget =
  | { filePath: string; pathType?: PathType; rootDirectory?: string }
  | { error: string };

/** Folder target → the `lares-plan-doc:v1:` logical key (path_type/root NULL). */
function buildFolderTarget(
  context: PlanContext,
  workspace: Workspace,
  ref: PlanDocumentRef,
  deps: CreatePlanCommentDeps,
): BuiltTarget {
  if (!context.artifactId) return { error: 'plan has no durable artifact identity for a folder target' };
  let manifest: PlanningReaderListResult;
  try {
    manifest = deps.listPlanningEntries(workspace.path, { pathType: workspace.pathType });
  } catch {
    return { error: 'plan folder unavailable' };
  }
  const entry = currentFolderEntry(context, manifest);
  if (!entry) return { error: 'plan folder is not resolvable in the current manifest' };
  const doc = entry.documents.find((d) => d.docId === ref.documentId);
  if (!doc) return { error: 'document is not registered to the plan folder' };
  const rawRel = commentableFolderDocRelPath(doc);
  if (!rawRel) return { error: 'document is not a commentable plan-folder document' };
  // Manifest membership establishes folder containment; the canonicalizer is the
  // separator/traversal gate over the manifest-resolved rel path.
  const canonical = canonicalDocRelPath(rawRel);
  if (!canonical) return { error: 'document rel path failed canonicalization' };
  return { filePath: encodePlanDocKey(context.artifactId, canonical) };
  // path_type / root_directory intentionally omitted → stored NULL.
}

/** Registered external doc → its ordinary physical `file_path` (unchanged). */
function buildRegisteredTarget(
  planId: string,
  workspace: Workspace,
  ref: PlanDocumentRef,
  deps: CreatePlanCommentDeps,
): BuiltTarget {
  const row = deps.getRegisteredDocument(planId, ref.documentId);
  if (!row || row.planId !== planId || row.workspaceId !== workspace.id) {
    return { error: 'document is not registered to the plan' };
  }
  const translated = translateStateRelPath(workspace.path, row.relPath, workspace.pathType);
  const safe = safeRel(translated);
  if (!safe) return { error: 'registered document failed path validation' };
  const abs = joinWorkspacePath(workspace.path, safe, workspace.pathType);
  if (!isContainedLexical(workspace.path, abs, workspace.pathType)) {
    return { error: 'registered document escapes the workspace' };
  }
  return { filePath: abs, pathType: workspace.pathType, rootDirectory: workspace.path };
}

/**
 * Server-side plan-comment create. Validates plan membership for both document
 * sources, builds the durable `file_path`, creates the row, and routes it to the
 * plan's current responsible supervisor via the existing send path. Returns a
 * discriminated result; a rejected create never creates a row.
 */
export async function createPlanComment(
  raw: unknown,
  deps: CreatePlanCommentDeps,
): Promise<PlanCommentCreateResult> {
  const req = (raw && typeof raw === 'object' ? raw : null) as PlanCommentCreateRequest | null;
  if (!req || typeof req.planId !== 'string' || req.planId === '') {
    return { ok: false, code: 'plan-comment-bad-request', error: 'a non-empty planId is required' };
  }
  if (typeof req.body !== 'string' || req.body === '') {
    return { ok: false, code: 'plan-comment-bad-request', error: 'a non-empty body is required' };
  }
  if (!isDocumentRef(req.ref)) {
    return { ok: false, code: 'plan-comment-bad-request', error: 'a valid document ref is required' };
  }

  const context = deps.getPlanContext(req.planId);
  if (!context) return { ok: false, code: 'plan-not-found', error: `plan not found: ${req.planId}` };
  const workspace = deps.getWorkspace(context.workspaceId);
  if (!workspace) {
    return { ok: false, code: 'workspace-not-found', error: `workspace not found for plan: ${req.planId}` };
  }

  const built =
    req.ref.source === 'folder'
      ? buildFolderTarget(context, workspace, req.ref, deps)
      : buildRegisteredTarget(req.planId, workspace, req.ref, deps);
  if ('error' in built) {
    return { ok: false, code: 'document-not-in-plan', error: built.error };
  }

  const comment = deps.createComment({
    workspaceId: context.workspaceId,
    targetType: 'file',
    filePath: built.filePath,
    pathType: built.pathType,
    rootDirectory: built.rootDirectory,
    quotedText: req.quotedText ?? '',
    body: req.body,
    lineStart: req.lineStart,
    lineEnd: req.lineEnd,
    anchorStart: req.anchorStart,
    anchorEnd: req.anchorEnd,
    prefix: req.prefix,
    suffix: req.suffix,
    docHash: req.docHash,
  });

  // Recipient is selected server-side — never supplied by the renderer.
  const recipientId = deps.getResponsibleSupervisorId(req.planId);
  const send = recipientId ? await deps.route(comment.id, recipientId) : null;
  return { ok: true, comment, recipientId, send };
}

// ── resolvePlanCommentForSend (plan-aware send/notification adapter) ───────────

export interface ResolvePlanCommentDeps {
  getFolderRelPathByArtifact(workspaceId: string, planArtifactId: string): string | null;
  getWorkspace(workspaceId: string): Workspace | null;
  fileExists?(abs: string, pathType: PathType): boolean;
}

export function defaultResolvePlanCommentDeps(): ResolvePlanCommentDeps {
  return {
    getFolderRelPathByArtifact: defaultGetFolderRelPathByArtifact,
    getWorkspace,
    fileExists: defaultFileExists,
  };
}

/** Explicit orphaned-target label — never a bare path, never a raw logical key. */
function orphanLabel(docRelPath?: string): string {
  return docRelPath
    ? `[orphaned plan document: ${docRelPath}]`
    : '[orphaned plan document]';
}

function orphanClone(comment: SelectionComment, docRelPath?: string): SelectionComment {
  return { ...comment, filePath: orphanLabel(docRelPath), pathType: null, rootDirectory: null };
}

/**
 * The send/notification adapter. For an ordinary comment (no logical prefix) the
 * row is returned UNCHANGED. For a `lares-plan-doc:*` target the logical key is
 * resolved to the CURRENT physical path on a CLONE (the stored row is never
 * mutated); a malformed / unknown-version key, an unknown plan, or a rel path
 * that no longer resolves is surfaced as an explicit orphaned plan-document
 * target rather than falling through to filesystem handling.
 */
export function resolvePlanCommentForSend(
  comment: SelectionComment | null,
  deps: ResolvePlanCommentDeps = defaultResolvePlanCommentDeps(),
): SelectionComment | null {
  if (!comment) return comment;
  if (!isLogicalPlanDocKey(comment.filePath)) return comment; // ordinary path — unchanged

  const decoded = decodePlanDocKey(comment.filePath); // only the exact v1 form decodes
  if (!decoded) return orphanClone(comment); // malformed / unknown version → orphaned

  const folderRelPath = deps.getFolderRelPathByArtifact(comment.workspaceId, decoded.planArtifactId);
  const workspace = deps.getWorkspace(comment.workspaceId);
  if (!folderRelPath || !workspace) return orphanClone(comment, decoded.docRelPathWithinFolder);

  const folderSafe = safeRel(translateStateRelPath(workspace.path, folderRelPath, workspace.pathType));
  if (!folderSafe) return orphanClone(comment, decoded.docRelPathWithinFolder);
  const folderAbs = joinWorkspacePath(workspace.path, folderSafe, workspace.pathType);
  const abs = joinWorkspacePath(folderAbs, decoded.docRelPathWithinFolder, workspace.pathType);
  const fileExists = deps.fileExists ?? defaultFileExists;
  if (
    !isContainedLexical(folderAbs, abs, workspace.pathType) ||
    !fileExists(abs, workspace.pathType)
  ) {
    return orphanClone(comment, decoded.docRelPathWithinFolder);
  }
  return { ...comment, filePath: abs, pathType: workspace.pathType, rootDirectory: workspace.path };
}
