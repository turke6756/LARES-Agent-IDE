import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  applyPlanWorkPackageSnapshot,
  getPlanFolderProjectionState,
  reconcilePlanResponsibility,
  recordPlanWorkPackageProjectionStatus,
  type ApplyPlanWorkPackageSnapshotResult,
  type ReconciledPlanWorkPackageInput,
  type ReconciledPlanWorkPackageState,
} from '../database';
import { parseStrictJson } from './strict-json';

export const PLAN_WORK_PACKAGE_MAX_BYTES = 1_000_000;

const TOP_LEVEL_KEYS = new Set(['schema_version', 'plan_artifact_id', 'packages']);
const PACKAGE_KEYS = new Set([
  'id', 'order', 'title', 'initial_state', 'acceptance_conditions', 'paths', 'depends_on',
]);
const PATH_KEYS = new Set(['path', 'intent_kind']);
const INTENT_KINDS = new Set(['create', 'edit', 'delete', 'verify']);
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type PlanWorkPackageDiagnosticCode =
  | 'manifest-invalid'
  | 'source-absent'
  | 'source-ambiguous'
  | 'source-unsafe'
  | 'source-unreadable'
  | 'source-oversized'
  | 'source-raced'
  | 'frontmatter-invalid'
  | 'identity-mismatch'
  | 'block-missing'
  | 'block-ambiguous'
  | 'block-oversized'
  | 'json-invalid'
  | 'schema-invalid'
  | 'package-invalid'
  | 'dependency-invalid'
  | 'prose-mismatch'
  | 'apply-conflict'
  | 'apply-failed';

export interface PlanWorkPackageDiagnostic {
  code: PlanWorkPackageDiagnosticCode;
  detail: string;
  sourceRelPath?: string;
  packageId?: string;
}

export interface ParsedPlanWorkPackageProjection {
  planArtifactId: string;
  projectionHash: string;
  packages: ReconciledPlanWorkPackageInput[];
}

export type ParsePlanWorkPackageDocumentResult =
  | { ok: true; projection: ParsedPlanWorkPackageProjection }
  | { ok: false; diagnostics: PlanWorkPackageDiagnostic[] };

export interface PlanFolderProjectionReconcileResult {
  responsibility: ReturnType<typeof reconcilePlanResponsibility>;
  workPackages: {
    status: 'synced' | 'unpackaged' | 'invalid' | 'conflict';
    diagnostics: PlanWorkPackageDiagnostic[];
    applyResult?: ApplyPlanWorkPackageSnapshotResult;
  };
}

type ManifestRead = {
  value: Record<string, unknown> | null;
  diagnostics: PlanWorkPackageDiagnostic[];
};

type SourceObservation = {
  absPath: string;
  sourceRelPath: string;
  body: string;
  token: string;
};

type LocatedSource =
  | { ok: true; source: SourceObservation }
  | { ok: false; diagnostics: PlanWorkPackageDiagnostic[]; absent: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function foldedId(value: string): string { return value.toLowerCase(); }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function rejectArrowStrings(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('-->');
  if (Array.isArray(value)) return value.some(rejectArrowStrings);
  return isRecord(value) && Object.values(value).some(rejectArrowStrings);
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>): string | null {
  return Object.keys(value).find((key) => !allowed.has(key)) ?? null;
}

function parseFrontmatter(body: string): Record<string, string> | null {
  const normalized = body.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const close = normalized.indexOf('\n---\n', 4);
  const terminalClose = normalized.endsWith('\n---') ? normalized.length - 4 : -1;
  const end = close >= 0 ? close : terminalClose;
  if (end < 0) return null;
  const result: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (!match || Object.prototype.hasOwnProperty.call(result, match[1])) return null;
    let scalar = match[2];
    if ((scalar.startsWith('"') && scalar.endsWith('"'))
        || (scalar.startsWith("'") && scalar.endsWith("'"))) scalar = scalar.slice(1, -1);
    result[match[1]] = scalar;
  }
  return result;
}

function normalizedPlanPath(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0')) return null;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('//')) return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function prosePackageHeadings(body: string): Array<{ id: string; title: string }> {
  const visible = body.replace(/<!--PLAN-WORK-PACKAGES:v1[\s\S]*?-->/g, '');
  const headings: Array<{ id: string; title: string }> = [];
  for (const match of visible.matchAll(/^##\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s+(?:-|â€”|—)\s+(.+?)\s*$/gm)) {
    headings.push({ id: match[1], title: match[2] });
  }
  return headings;
}

function invalid(
  code: PlanWorkPackageDiagnosticCode,
  detail: string,
  sourceRelPath?: string,
  packageId?: string,
): ParsePlanWorkPackageDocumentResult {
  return { ok: false, diagnostics: [{ code, detail, sourceRelPath, packageId }] };
}

/** Pure parser for one already-bounded work-package supplement. */
export function parsePlanWorkPackageDocument(
  body: string,
  expectedPlanArtifactId: string,
  sourceRelPath = 'supplements/work-packages.md',
): ParsePlanWorkPackageDocumentResult {
  if (Buffer.byteLength(body, 'utf8') > PLAN_WORK_PACKAGE_MAX_BYTES) {
    return invalid('source-oversized', `source exceeds ${PLAN_WORK_PACKAGE_MAX_BYTES} bytes`, sourceRelPath);
  }
  const frontmatter = parseFrontmatter(body);
  if (!frontmatter || frontmatter.kind !== 'work-packages' || !frontmatter.plan_artifact_id) {
    return invalid('frontmatter-invalid', 'frontmatter must declare kind: work-packages and plan_artifact_id', sourceRelPath);
  }
  if (frontmatter.plan_artifact_id !== expectedPlanArtifactId) {
    return invalid('identity-mismatch', 'frontmatter plan_artifact_id does not match plan.json', sourceRelPath);
  }

  const starts = [...body.matchAll(/<!--PLAN-WORK-PACKAGES:v1\b/g)];
  const blocks = [...body.matchAll(/<!--PLAN-WORK-PACKAGES:v1\s*([\s\S]*?)-->/g)];
  if (starts.length === 0) return invalid('block-missing', 'PLAN-WORK-PACKAGES:v1 block is missing', sourceRelPath);
  if (starts.length !== 1 || blocks.length !== 1) {
    return invalid('block-ambiguous', 'exactly one complete PLAN-WORK-PACKAGES:v1 block is required', sourceRelPath);
  }
  const block = blocks[0][1];
  if (Buffer.byteLength(block, 'utf8') > PLAN_WORK_PACKAGE_MAX_BYTES) {
    return invalid('block-oversized', `machine block exceeds ${PLAN_WORK_PACKAGE_MAX_BYTES} bytes`, sourceRelPath);
  }

  let raw: unknown;
  try { raw = parseStrictJson(block); }
  catch (err) {
    return invalid('json-invalid', err instanceof Error ? err.message : String(err), sourceRelPath);
  }
  if (!isRecord(raw)) return invalid('schema-invalid', 'machine block must be an object', sourceRelPath);
  const unknownTop = exactKeys(raw, TOP_LEVEL_KEYS);
  if (unknownTop) return invalid('schema-invalid', `unknown top-level key ${unknownTop}`, sourceRelPath);
  if (rejectArrowStrings(raw)) return invalid('schema-invalid', 'strings may not contain -->', sourceRelPath);
  if (raw.schema_version !== 1 || raw.plan_artifact_id !== expectedPlanArtifactId
      || raw.plan_artifact_id !== frontmatter.plan_artifact_id) {
    return invalid('identity-mismatch', 'schema version or block/frontmatter/manifest identity does not match', sourceRelPath);
  }
  if (!Array.isArray(raw.packages) || raw.packages.length === 0) {
    return invalid('schema-invalid', 'packages must be a non-empty array', sourceRelPath);
  }

  type Validated = ReconciledPlanWorkPackageInput & { dependsOn: string[] };
  const packages: Validated[] = [];
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const item of raw.packages) {
    if (!isRecord(item)) return invalid('package-invalid', 'every package must be an object', sourceRelPath);
    const localId = typeof item.id === 'string' ? item.id : '';
    const unknown = exactKeys(item, PACKAGE_KEYS);
    if (unknown) return invalid('package-invalid', `unknown package key ${unknown}`, sourceRelPath, localId || undefined);
    const folded = foldedId(localId);
    if (!PACKAGE_ID.test(localId) || ids.has(folded)) {
      return invalid('package-invalid', `invalid or duplicate package id ${JSON.stringify(localId)}`, sourceRelPath, localId || undefined);
    }
    if (!Number.isInteger(item.order) || (item.order as number) < 0 || orders.has(item.order as number)) {
      return invalid('package-invalid', `invalid or duplicate order for ${localId}`, sourceRelPath, localId);
    }
    if (typeof item.title !== 'string' || item.title.trim() !== item.title || item.title.length === 0 || item.title.length > 300) {
      return invalid('package-invalid', `invalid title for ${localId}`, sourceRelPath, localId);
    }
    if (item.initial_state !== 'ready' && item.initial_state !== 'blocked') {
      return invalid('package-invalid', `invalid initial_state for ${localId}`, sourceRelPath, localId);
    }
    if (!Array.isArray(item.acceptance_conditions) || item.acceptance_conditions.length === 0
        || item.acceptance_conditions.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
      return invalid('package-invalid', `invalid acceptance_conditions for ${localId}`, sourceRelPath, localId);
    }
    if (!Array.isArray(item.paths)) return invalid('package-invalid', `invalid paths for ${localId}`, sourceRelPath, localId);
    const paths: ReconciledPlanWorkPackageInput['paths'][number][] = [];
    const seenPaths = new Set<string>();
    for (const entry of item.paths) {
      if (!isRecord(entry)) return invalid('package-invalid', `invalid path entry for ${localId}`, sourceRelPath, localId);
      const unknownPath = exactKeys(entry, PATH_KEYS);
      const normalized = normalizedPlanPath(entry.path);
      if (unknownPath || normalized === null || seenPaths.has(normalized)
          || (entry.intent_kind !== undefined && (typeof entry.intent_kind !== 'string' || !INTENT_KINDS.has(entry.intent_kind)))) {
        return invalid('package-invalid', `invalid path entry for ${localId}`, sourceRelPath, localId);
      }
      seenPaths.add(normalized);
      paths.push({ path: normalized, intentKind: entry.intent_kind as string | undefined });
    }
    if (!Array.isArray(item.depends_on)
        || item.depends_on.some((entry) => typeof entry !== 'string' || !PACKAGE_ID.test(entry))) {
      return invalid('dependency-invalid', `invalid depends_on for ${localId}`, sourceRelPath, localId);
    }
    const dependsOn = (item.depends_on as string[]).map(foldedId);
    if (new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(folded)) {
      return invalid('dependency-invalid', `duplicate or self dependency for ${localId}`, sourceRelPath, localId);
    }
    const canonicalContent = {
      acceptance_conditions: item.acceptance_conditions,
      depends_on: dependsOn,
      id: folded,
      initial_state: item.initial_state,
      paths: paths.map((entry) => ({ intent_kind: entry.intentKind ?? null, path: entry.path })),
      title: item.title,
    };
    packages.push({
      id: `wp:${expectedPlanArtifactId}:${folded}`,
      sourceLocalId: localId,
      title: item.title,
      acceptanceCondition: (item.acceptance_conditions as string[]).join('\n'),
      declaredState: item.initial_state as ReconciledPlanWorkPackageState,
      contentHash: sha256(canonicalJson(canonicalContent)),
      sortOrder: item.order as number,
      paths,
      dependsOn,
    });
    ids.add(folded);
    orders.add(item.order as number);
  }

  const byId = new Map(packages.map((pkg) => [foldedId(pkg.sourceLocalId), pkg]));
  for (const pkg of packages) {
    for (const dependency of pkg.dependsOn) {
      const target = byId.get(dependency);
      if (!target || target.sortOrder >= pkg.sortOrder) {
        return invalid('dependency-invalid', `dependency ${dependency} for ${pkg.sourceLocalId} must exist at a lower order`, sourceRelPath, pkg.sourceLocalId);
      }
    }
  }

  const headings = prosePackageHeadings(body);
  const headingById = new Map<string, { id: string; title: string }>();
  for (const heading of headings) {
    const key = foldedId(heading.id);
    if (headingById.has(key)) return invalid('prose-mismatch', `duplicate prose heading for ${heading.id}`, sourceRelPath, heading.id);
    headingById.set(key, heading);
  }
  if (headings.length !== packages.length) {
    return invalid('prose-mismatch', 'prose package headings do not exactly match the projection', sourceRelPath);
  }
  for (const pkg of packages) {
    const heading = headingById.get(foldedId(pkg.sourceLocalId));
    if (!heading || heading.id !== pkg.sourceLocalId || heading.title !== pkg.title) {
      return invalid('prose-mismatch', `prose heading does not match ${pkg.sourceLocalId}`, sourceRelPath, pkg.sourceLocalId);
    }
  }

  const ordered = [...packages].sort((a, b) => a.sortOrder - b.sortOrder
    || foldedId(a.sourceLocalId).localeCompare(foldedId(b.sourceLocalId)));
  const projectionHash = sha256(canonicalJson(ordered.map((pkg) => ({
    acceptance_condition: pkg.acceptanceCondition,
    content_hash: pkg.contentHash,
    declared_state: pkg.declaredState,
    id: foldedId(pkg.sourceLocalId),
    order: pkg.sortOrder,
    paths: pkg.paths,
    title: pkg.title,
  }))));
  return { ok: true, projection: { planArtifactId: expectedPlanArtifactId, projectionHash, packages: ordered } };
}

function statToken(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function locateSource(folderAbs: string): LocatedSource {
  const supplementsAbs = path.join(folderAbs, 'supplements');
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(supplementsAbs, { withFileTypes: true }); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, absent: true, diagnostics: [{ code: 'source-absent', detail: 'supplements directory is absent' }] };
    return { ok: false, absent: false, diagnostics: [{ code: 'source-unreadable', detail: String(err) }] };
  }
  const candidates: SourceObservation[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    const absPath = path.join(supplementsAbs, entry.name);
    const sourceRelPath = `supplements/${entry.name}`;
    let stat: fs.Stats;
    try { stat = fs.lstatSync(absPath); }
    catch (err) { return { ok: false, absent: false, diagnostics: [{ code: 'source-unreadable', detail: String(err), sourceRelPath }] }; }
    if (stat.isSymbolicLink()) {
      return { ok: false, absent: false, diagnostics: [{ code: 'source-unsafe', detail: 'Markdown supplements may not be symlinks', sourceRelPath }] };
    }
    if (!stat.isFile()) continue;
    if (stat.size > PLAN_WORK_PACKAGE_MAX_BYTES) {
      return { ok: false, absent: false, diagnostics: [{ code: 'source-oversized', detail: `source exceeds ${PLAN_WORK_PACKAGE_MAX_BYTES} bytes`, sourceRelPath }] };
    }
    let body: string;
    try { body = fs.readFileSync(absPath, 'utf8'); }
    catch (err) { return { ok: false, absent: false, diagnostics: [{ code: 'source-unreadable', detail: String(err), sourceRelPath }] }; }
    const frontmatter = parseFrontmatter(body);
    // A malformed frontmatter file that visibly claims this contract (or carries
    // its machine sentinel) is an invalid source, not an absent source. This is
    // what keeps malformed replacements fail-closed after an earlier apply.
    const claimsWorkPackages = frontmatter?.kind === 'work-packages'
      || /^kind:\s*work-packages\s*$/m.test(body.replace(/\r\n/g, '\n'))
      || body.includes('<!--PLAN-WORK-PACKAGES:v1');
    if (claimsWorkPackages) candidates.push({ absPath, sourceRelPath, body, token: statToken(stat) });
  }
  if (candidates.length === 0) return { ok: false, absent: true, diagnostics: [{ code: 'source-absent', detail: 'no work-packages supplement is present' }] };
  if (candidates.length !== 1) return { ok: false, absent: false, diagnostics: [{ code: 'source-ambiguous', detail: 'multiple work-packages supplements are present' }] };
  return { ok: true, source: candidates[0] };
}

function sourceStillMatches(source: SourceObservation): boolean {
  try { return statToken(fs.lstatSync(source.absPath)) === source.token; }
  catch { return false; }
}

function readManifest(folderAbs: string): ManifestRead {
  try {
    const body = fs.readFileSync(path.join(folderAbs, 'plan.json'), 'utf8');
    const value = parseStrictJson(body);
    if (!isRecord(value)) throw new Error('plan.json must be an object');
    return { value, diagnostics: [] };
  } catch (err) {
    return { value: null, diagnostics: [{ code: 'manifest-invalid', detail: err instanceof Error ? err.message : String(err) }] };
  }
}

function responsibilityInput(manifest: Record<string, unknown> | null): Parameters<typeof reconcilePlanResponsibility>[0] {
  if (!manifest) return { planId: '', workspaceId: '', status: 'invalid', eventId: null, supervisorId: null,
    detail: JSON.stringify({ code: 'manifest-invalid', detail: 'plan.json could not be parsed strictly' }), reconciledAt: 0 };
  const events = manifest.responsibility_events;
  if (events === undefined || (Array.isArray(events) && events.length === 0)) {
    return { planId: '', workspaceId: '', status: 'absent', eventId: null, supervisorId: null, detail: null, reconciledAt: 0 };
  }
  if (!Array.isArray(events)) {
    return { planId: '', workspaceId: '', status: 'invalid', eventId: null, supervisorId: null,
      detail: JSON.stringify({ code: 'history-invalid', detail: 'responsibility_events must be an array' }), reconciledAt: 0 };
  }
  const seen = new Set<string>();
  let latest: Record<string, unknown> | null = null;
  for (const event of events) {
    if (!isRecord(event) || typeof event.event_id !== 'string' || event.event_id.trim() === ''
        || typeof event.event !== 'string' || seen.has(event.event_id)) {
      return { planId: '', workspaceId: '', status: 'invalid', eventId: null, supervisorId: null,
        detail: JSON.stringify({ code: 'history-invalid', detail: 'responsibility event shape or event_id uniqueness is invalid' }), reconciledAt: 0 };
    }
    seen.add(event.event_id);
    if (event.event === 'assigned') latest = event;
  }
  if (!latest) return { planId: '', workspaceId: '', status: 'absent', eventId: null, supervisorId: null, detail: null, reconciledAt: 0 };
  const eventId = latest.event_id as string;
  if (typeof latest.agent_id !== 'string' || latest.agent_id.trim() === '') {
    return { planId: '', workspaceId: '', status: 'invalid', eventId, supervisorId: null,
      detail: JSON.stringify({ code: 'assignment-invalid', detail: 'latest assigned event has no agent_id' }), reconciledAt: 0 };
  }
  return { planId: '', workspaceId: '', status: 'valid', eventId, supervisorId: latest.agent_id,
    detail: null, reconciledAt: 0 };
}

function persistWpStatus(input: {
  workspaceId: string; planId: string; status: 'unpackaged' | 'invalid' | 'conflict';
  diagnostics: PlanWorkPackageDiagnostic[]; reconciledAt: number;
}): void {
  recordPlanWorkPackageProjectionStatus(input);
}

/**
 * Common settled-seam service. WP-D extends this function with the overview
 * projection; watcher and explicit single-folder refresh callers must continue
 * to call this one service rather than composing projections independently.
 */
export function reconcilePlanFolderPlanningState(input: {
  workspaceId: string;
  planId: string;
  folderAbs: string;
  folderRelPath: string;
  now?: () => number;
  /** Test-only race seam, called after a valid parse and before the required re-stat. */
  beforeSourceRestat?: (attempt: number, sourceAbs: string) => void;
}): PlanFolderProjectionReconcileResult {
  const reconciledAt = (input.now ?? (() => Date.now()))();
  const manifest = readManifest(input.folderAbs);
  const parsedResponsibility = responsibilityInput(manifest.value);
  const responsibility = reconcilePlanResponsibility({ ...parsedResponsibility,
    workspaceId: input.workspaceId, planId: input.planId, reconciledAt });

  const artifactId = manifest.value?.plan_artifact_id;
  if (typeof artifactId !== 'string' || artifactId === '') {
    const diagnostics = manifest.diagnostics.length > 0 ? manifest.diagnostics
      : [{ code: 'manifest-invalid' as const, detail: 'plan.json has no plan_artifact_id' }];
    persistWpStatus({ workspaceId: input.workspaceId, planId: input.planId,
      status: 'invalid', diagnostics, reconciledAt });
    return { responsibility, workPackages: { status: 'invalid', diagnostics } };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const located = locateSource(input.folderAbs);
    if (!located.ok) {
      const prior = getPlanFolderProjectionState(input.planId);
      const status = located.absent && !prior?.wpProjectionHash ? 'unpackaged'
        : located.absent ? 'conflict' : 'invalid';
      const diagnostics = located.absent && prior?.wpProjectionHash
        ? [{ code: 'source-absent' as const, detail: 'previously ingested work-package source is missing' }]
        : located.diagnostics;
      persistWpStatus({ workspaceId: input.workspaceId, planId: input.planId, status, diagnostics, reconciledAt });
      return { responsibility, workPackages: { status, diagnostics } };
    }
    const parsed = parsePlanWorkPackageDocument(located.source.body, artifactId, located.source.sourceRelPath);
    if (!parsed.ok) {
      persistWpStatus({ workspaceId: input.workspaceId, planId: input.planId,
        status: 'invalid', diagnostics: parsed.diagnostics, reconciledAt });
      return { responsibility, workPackages: { status: 'invalid', diagnostics: parsed.diagnostics } };
    }
    input.beforeSourceRestat?.(attempt, located.source.absPath);
    if (!sourceStillMatches(located.source)) {
      if (attempt === 0) continue;
      const diagnostics: PlanWorkPackageDiagnostic[] = [{ code: 'source-raced',
        detail: 'work-package source changed twice before apply', sourceRelPath: located.source.sourceRelPath }];
      persistWpStatus({ workspaceId: input.workspaceId, planId: input.planId,
        status: 'invalid', diagnostics, reconciledAt });
      return { responsibility, workPackages: { status: 'invalid', diagnostics } };
    }
    try {
      const applyResult = applyPlanWorkPackageSnapshot({
        workspaceId: input.workspaceId,
        planId: input.planId,
        sourceRelPath: located.source.sourceRelPath,
        projectionHash: parsed.projection.projectionHash,
        packages: parsed.projection.packages,
        reconciledAt,
      });
      if (applyResult.status === 'conflict') {
        const diagnostics = applyResult.diagnostics.map((detail): PlanWorkPackageDiagnostic =>
          ({ code: 'apply-conflict', detail, sourceRelPath: located.source.sourceRelPath }));
        persistWpStatus({ workspaceId: input.workspaceId, planId: input.planId,
          status: 'conflict', diagnostics, reconciledAt });
        return { responsibility, workPackages: { status: 'conflict', diagnostics, applyResult } };
      }
      return { responsibility, workPackages: { status: 'synced', diagnostics: [], applyResult } };
    } catch (err) {
      const diagnostics: PlanWorkPackageDiagnostic[] = [{ code: 'apply-failed',
        detail: err instanceof Error ? err.message : String(err), sourceRelPath: located.source.sourceRelPath }];
      persistWpStatus({ workspaceId: input.workspaceId, planId: input.planId,
        status: 'invalid', diagnostics, reconciledAt });
      return { responsibility, workPackages: { status: 'invalid', diagnostics } };
    }
  }
  throw new Error('unreachable work-package retry state');
}
