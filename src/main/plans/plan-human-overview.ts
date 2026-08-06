import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  PLAN_TAB_KEYS,
  isPlanTabKey,
  type ObservedOverviewSourceToken,
  type PlanTabKey,
} from '../../shared/types';
import {
  applyPlanOverviewSnapshot,
  recordPlanOverviewProjectionStatus,
  type PlanOverviewApplyMutationStage,
} from '../database';
import { parseStrictJson } from './strict-json';

export const PLAN_HUMAN_OVERVIEW_MAX_BYTES = 1_048_576;
export type { ObservedOverviewSourceToken } from '../../shared/types';

export type PlanHumanOverviewDiagnosticCode =
  | 'overview-source-absent'
  | 'overview-source-unsafe'
  | 'overview-source-unreadable'
  | 'overview-source-oversized'
  | 'overview-source-raced'
  | 'overview-manifest-invalid'
  | 'overview-frontmatter-invalid'
  | 'overview-identity-mismatch'
  | 'overview-index-missing'
  | 'overview-index-ambiguous'
  | 'overview-json-invalid'
  | 'overview-schema-invalid'
  | 'overview-section-invalid'
  | 'overview-apply-failed';

export interface PlanHumanOverviewDiagnostic {
  code: PlanHumanOverviewDiagnosticCode;
  detail: string;
}

export interface ParsedPlanHumanOverview {
  planArtifactId: string;
  bodies: ReadonlyMap<PlanTabKey, { body: string; bodyHash: string }>;
}

export type ParsePlanHumanOverviewResult =
  | { ok: true; projection: ParsedPlanHumanOverview }
  | { ok: false; diagnostics: PlanHumanOverviewDiagnostic[] };

export interface OverviewSourceObservation {
  token: ObservedOverviewSourceToken;
  present: boolean;
  safeRegularFile: boolean;
  oversized: boolean;
  bytes: Buffer | null;
  diagnostics: PlanHumanOverviewDiagnostic[];
}

export interface PlanHumanOverviewReconcileResult {
  status: 'absent' | 'synced' | 'invalid' | 'apply-error';
  token: ObservedOverviewSourceToken;
  diagnostics: PlanHumanOverviewDiagnostic[];
}

type OutsideComment = { start: number; end: number; inner: string };

function diagnostic(code: PlanHumanOverviewDiagnosticCode, detail: string): PlanHumanOverviewDiagnostic {
  return { code, detail };
}

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function samePath(a: string, b: string): boolean {
  const normalize = process.platform === 'win32' ? (value: string) => value.toLowerCase() : (value: string) => value;
  return normalize(path.resolve(a)) === normalize(path.resolve(b));
}

function statIdentity(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** Hash exact source bytes in bounded chunks. Bodies are retained only within the parse limit. */
export function observeOverviewSource(folderAbs: string): OverviewSourceObservation {
  const overviewAbs = path.join(folderAbs, 'OVERVIEW.md');
  let canonicalFolder: string;
  try {
    const folderStat = fs.lstatSync(folderAbs);
    if (!folderStat.isDirectory() || folderStat.isSymbolicLink()) {
      return { token: 'unsafe', present: true, safeRegularFile: false, oversized: false, bytes: null,
        diagnostics: [diagnostic('overview-source-unsafe', 'plan folder is not a canonical regular directory')] };
    }
    canonicalFolder = fs.realpathSync(folderAbs);
  } catch (err) {
    return { token: 'unreadable', present: true, safeRegularFile: false, oversized: false, bytes: null,
      diagnostics: [diagnostic('overview-source-unreadable', String(err))] };
  }

  let lst: fs.Stats;
  try { lst = fs.lstatSync(overviewAbs); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { token: 'absent', present: false, safeRegularFile: false, oversized: false, bytes: null,
        diagnostics: [diagnostic('overview-source-absent', 'OVERVIEW.md is absent')] };
    }
    return { token: 'unreadable', present: true, safeRegularFile: false, oversized: false, bytes: null,
      diagnostics: [diagnostic('overview-source-unreadable', String(err))] };
  }
  if (lst.isSymbolicLink() || !lst.isFile()) {
    return { token: 'unsafe', present: true, safeRegularFile: false, oversized: false, bytes: null,
      diagnostics: [diagnostic('overview-source-unsafe', 'OVERVIEW.md must be a regular non-symlink file')] };
  }
  try {
    const canonicalSource = fs.realpathSync(overviewAbs);
    if (!samePath(path.dirname(canonicalSource), canonicalFolder)) {
      return { token: 'unsafe', present: true, safeRegularFile: false, oversized: false, bytes: null,
        diagnostics: [diagnostic('overview-source-unsafe', 'OVERVIEW.md canonical parent escapes the plan folder')] };
    }
  } catch (err) {
    return { token: 'unreadable', present: true, safeRegularFile: false, oversized: false, bytes: null,
      diagnostics: [diagnostic('overview-source-unreadable', String(err))] };
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(overviewAbs, 'r');
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || statIdentity(opened) !== statIdentity(lst)) {
      throw Object.assign(new Error('OVERVIEW.md changed before observation'), { code: 'ERACED' });
    }
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      const slice = chunk.subarray(0, count);
      hash.update(slice);
      total += count;
      if (total <= PLAN_HUMAN_OVERVIEW_MAX_BYTES) chunks.push(Buffer.from(slice));
    }
    const finished = fs.fstatSync(fd);
    const after = fs.lstatSync(overviewAbs);
    if (statIdentity(opened) !== statIdentity(finished) || statIdentity(opened) !== statIdentity(after)) {
      throw Object.assign(new Error('OVERVIEW.md changed during observation'), { code: 'ERACED' });
    }
    const token = `sha256:${hash.digest('hex')}` as const;
    const oversized = total > PLAN_HUMAN_OVERVIEW_MAX_BYTES;
    return {
      token, present: true, safeRegularFile: true, oversized,
      bytes: oversized ? null : Buffer.concat(chunks, total),
      diagnostics: oversized
        ? [diagnostic('overview-source-oversized', `OVERVIEW.md exceeds ${PLAN_HUMAN_OVERVIEW_MAX_BYTES} bytes`)]
        : [],
    };
  } catch (err) {
    const raced = (err as NodeJS.ErrnoException).code === 'ERACED';
    return { token: 'unreadable', present: true, safeRegularFile: false, oversized: false, bytes: null,
      diagnostics: [diagnostic(raced ? 'overview-source-raced' : 'overview-source-unreadable', String(err))] };
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

function parseFrontmatter(body: string): Record<string, string> | null {
  const normalized = body.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const close = normalized.indexOf('\n---\n', 4);
  const terminalClose = normalized.endsWith('\n---') ? normalized.length - 4 : -1;
  const end = close >= 0 ? close : terminalClose;
  if (end < 0) return null;
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of normalized.slice(4, end).split('\n')) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    if (/^[ \t]/.test(line) || /^(?:-|\?|\[|\{|&|\*|!|>|\||@|`)/.test(line)) return null;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*?)[ \t]*$/);
    if (!match || Object.prototype.hasOwnProperty.call(result, match[1])) return null;
    let scalar = match[2];
    if (scalar === '' || /^(?:\||>|&|\*|!|\[|\{)/.test(scalar)) return null;
    if ((scalar.startsWith('"') && scalar.endsWith('"'))
        || (scalar.startsWith("'") && scalar.endsWith("'"))) scalar = scalar.slice(1, -1);
    if (/\r|\n/.test(scalar)) return null;
    result[match[1]] = scalar;
  }
  return result;
}

function fencedRanges(body: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let active: { char: '`' | '~'; length: number; start: number } | null = null;
  let offset = 0;
  for (const lineWithBreak of body.match(/.*(?:\n|$)/g) ?? []) {
    if (lineWithBreak === '') continue;
    const line = lineWithBreak.endsWith('\n') ? lineWithBreak.slice(0, -1) : lineWithBreak;
    if (!active) {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (open) active = { char: open[1][0] as '`' | '~', length: open[1].length, start: offset };
    } else {
      const close = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (close && close[1][0] === active.char && close[1].length >= active.length) {
        ranges.push({ start: active.start, end: offset + lineWithBreak.length });
        active = null;
      }
    }
    offset += lineWithBreak.length;
  }
  if (active) ranges.push({ start: active.start, end: body.length });
  return ranges;
}

function isInRanges(offset: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

function outsideComments(body: string, ranges: Array<{ start: number; end: number }>): OutsideComment[] {
  const result: OutsideComment[] = [];
  for (const match of body.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (match.index === undefined || isInRanges(match.index, ranges)) continue;
    result.push({ start: match.index, end: match.index + match[0].length, inner: match[1] });
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsArrowString(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('-->');
  if (Array.isArray(value)) return value.some(containsArrowString);
  return isRecord(value) && Object.values(value).some(containsArrowString);
}

/** Pure, newline-normalizing parser. Source-byte hashes are deliberately handled by the observer. */
export function parsePlanHumanOverview(
  source: string,
  expectedPlanArtifactId: string,
): ParsePlanHumanOverviewResult {
  if (Buffer.byteLength(source, 'utf8') > PLAN_HUMAN_OVERVIEW_MAX_BYTES) {
    return { ok: false, diagnostics: [diagnostic('overview-source-oversized', 'OVERVIEW.md exceeds the parse limit')] };
  }
  const body = source.replace(/\r\n?/g, '\n');
  const frontmatter = parseFrontmatter(body);
  if (!frontmatter || frontmatter.kind !== 'human-overview' || frontmatter.schema_version !== '1'
      || !frontmatter.plan_artifact_id) {
    return { ok: false, diagnostics: [diagnostic('overview-frontmatter-invalid',
      'frontmatter must uniquely declare plan_artifact_id, kind: human-overview, and schema_version: 1')] };
  }
  if (frontmatter.plan_artifact_id !== expectedPlanArtifactId) {
    return { ok: false, diagnostics: [diagnostic('overview-identity-mismatch',
      'frontmatter plan_artifact_id does not match plan.json')] };
  }
  const ranges = fencedRanges(body);
  const comments = outsideComments(body, ranges);
  const indices = comments.filter((comment) => /^PLAN-TAB-OVERVIEWS:v1(?:\s|$)/.test(comment.inner));
  if (indices.length === 0) {
    return { ok: false, diagnostics: [diagnostic('overview-index-missing', 'PLAN-TAB-OVERVIEWS:v1 index is missing')] };
  }
  if (indices.length !== 1 || [...body.matchAll(/<!--PLAN-TAB-OVERVIEWS:v1\b/g)]
    .filter((match) => match.index !== undefined && !isInRanges(match.index, ranges)).length !== 1) {
    return { ok: false, diagnostics: [diagnostic('overview-index-ambiguous',
      'exactly one complete PLAN-TAB-OVERVIEWS:v1 index outside fenced code is required')] };
  }
  let raw: unknown;
  try { raw = parseStrictJson(indices[0].inner.replace(/^PLAN-TAB-OVERVIEWS:v1\s*/, '')); }
  catch (err) {
    return { ok: false, diagnostics: [diagnostic('overview-json-invalid', err instanceof Error ? err.message : String(err))] };
  }
  if (!isRecord(raw) || Object.keys(raw).some((key) => !['schema_version', 'plan_artifact_id', 'sections'].includes(key))
      || raw.schema_version !== 1 || raw.plan_artifact_id !== expectedPlanArtifactId
      || containsArrowString(raw) || !Array.isArray(raw.sections)) {
    return { ok: false, diagnostics: [diagnostic('overview-schema-invalid', 'overview index schema or identity is invalid')] };
  }
  const entries: Array<{ tab: PlanTabKey; heading: string }> = [];
  const tabs = new Set<string>();
  const headings = new Set<string>();
  for (const item of raw.sections) {
    if (!isRecord(item) || Object.keys(item).some((key) => !['tab', 'heading'].includes(key))
        || !isPlanTabKey(item.tab) || typeof item.heading !== 'string'
        || item.heading.trim() !== item.heading || item.heading === '' || /[\r\n]/.test(item.heading)
        || tabs.has(item.tab) || headings.has(item.heading)) {
      return { ok: false, diagnostics: [diagnostic('overview-schema-invalid', 'section entries require unique stable tabs and headings')] };
    }
    tabs.add(item.tab); headings.add(item.heading);
    entries.push({ tab: item.tab, heading: item.heading });
  }

  const delimiterComments = comments.filter((comment) => /^PLAN-TAB-SECTION:/.test(comment.inner.trim()));
  if (delimiterComments.length !== entries.length * 2) {
    return { ok: false, diagnostics: [diagnostic('overview-section-invalid', 'indexed sections must have exactly one begin/end delimiter pair and no unindexed delimiters')] };
  }
  const bodies = new Map<PlanTabKey, { body: string; bodyHash: string }>();
  const delimiterSequence = delimiterComments
    .map((comment) => ({ comment, match: comment.inner.trim().match(/^PLAN-TAB-SECTION:([^:]+):(BEGIN|END)$/) }))
    .sort((a, b) => a.comment.start - b.comment.start);
  const openTabs: string[] = [];
  for (const item of delimiterSequence) {
    if (!item.match || !tabs.has(item.match[1])) {
      return { ok: false, diagnostics: [diagnostic('overview-section-invalid', 'unindexed or malformed section delimiter')] };
    }
    if (item.match[2] === 'BEGIN') openTabs.push(item.match[1]);
    else if (openTabs.pop() !== item.match[1]) {
      return { ok: false, diagnostics: [diagnostic('overview-section-invalid', 'section delimiters are crossed or nested')] };
    }
    if (openTabs.length > 1) {
      return { ok: false, diagnostics: [diagnostic('overview-section-invalid', 'section delimiters may not be nested')] };
    }
  }
  if (openTabs.length !== 0) {
    return { ok: false, diagnostics: [diagnostic('overview-section-invalid', 'section delimiter is unclosed')] };
  }
  for (const entry of entries) {
    const beginText = `PLAN-TAB-SECTION:${entry.tab}:BEGIN`;
    const endText = `PLAN-TAB-SECTION:${entry.tab}:END`;
    const begins = delimiterComments.filter((comment) => comment.inner.trim() === beginText);
    const ends = delimiterComments.filter((comment) => comment.inner.trim() === endText);
    if (begins.length !== 1 || ends.length !== 1 || ends[0].start <= begins[0].end) {
      return { ok: false, diagnostics: [diagnostic('overview-section-invalid', `section delimiters are missing, duplicate, crossed, or nested for ${entry.tab}`)] };
    }
    const section = body.slice(begins[0].end, ends[0].start);
    const headingMatch = section.match(/^(?:[ \t]*\n)*##[ \t]+([^\n]+?)[ \t]*\n/);
    if (!headingMatch || headingMatch[1] !== entry.heading) {
      return { ok: false, diagnostics: [diagnostic('overview-section-invalid', `first nonblank line for ${entry.tab} must be ## ${entry.heading}`)] };
    }
    const sectionBody = section.slice(headingMatch[0].length).replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
    if (sectionBody.trim() === '') {
      return { ok: false, diagnostics: [diagnostic('overview-section-invalid', `section ${entry.tab} has an empty body`)] };
    }
    bodies.set(entry.tab, { body: sectionBody, bodyHash: sha256Bytes(sectionBody) });
  }
  return { ok: true, projection: { planArtifactId: expectedPlanArtifactId, bodies } };
}

function readManifestArtifactId(folderAbs: string): string | null {
  try {
    const stat = fs.lstatSync(path.join(folderAbs, 'plan.json'));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PLAN_HUMAN_OVERVIEW_MAX_BYTES) return null;
    const raw = parseStrictJson(fs.readFileSync(path.join(folderAbs, 'plan.json'), 'utf8'));
    return isRecord(raw) && typeof raw.plan_artifact_id === 'string' && raw.plan_artifact_id !== ''
      ? raw.plan_artifact_id : null;
  } catch { return null; }
}

export function reconcilePlanHumanOverview(input: {
  workspaceId: string;
  planId: string;
  folderAbs: string;
  folderRelPath: string;
  expectedPlanArtifactId?: string | null;
  updatedBy: string | null;
  reconciledAt: number;
  observe?: (folderAbs: string) => OverviewSourceObservation;
  afterMutationStage?: (stage: PlanOverviewApplyMutationStage) => void;
}): PlanHumanOverviewReconcileResult {
  const observation = (input.observe ?? observeOverviewSource)(input.folderAbs);
  const record = (status: 'absent' | 'invalid' | 'apply-error', diagnostics: PlanHumanOverviewDiagnostic[]) => {
    recordPlanOverviewProjectionStatus({
      workspaceId: input.workspaceId, planId: input.planId, status,
      sourceHash: observation.token.startsWith('sha256:') ? observation.token : null,
      diagnostics, reconciledAt: input.reconciledAt, observedPresent: observation.present,
    });
    return { status, token: observation.token, diagnostics } as PlanHumanOverviewReconcileResult;
  };
  if (!observation.present) return record('absent', observation.diagnostics);
  if (!observation.safeRegularFile || observation.oversized || !observation.bytes) {
    return record('invalid', observation.diagnostics);
  }
  const artifactId = input.expectedPlanArtifactId ?? readManifestArtifactId(input.folderAbs);
  if (!artifactId) {
    return record('invalid', [diagnostic('overview-manifest-invalid', 'plan.json identity is invalid')]);
  }
  const parsed = parsePlanHumanOverview(observation.bytes.toString('utf8'), artifactId);
  if (!parsed.ok) return record('invalid', parsed.diagnostics);
  try {
    applyPlanOverviewSnapshot({
      workspaceId: input.workspaceId,
      planId: input.planId,
      sourceRelPath: 'OVERVIEW.md',
      sourceHash: observation.token,
      bodies: parsed.projection.bodies,
      updatedBy: input.updatedBy,
      reconciledAt: input.reconciledAt,
      afterMutationStage: input.afterMutationStage,
    });
    return { status: 'synced', token: observation.token, diagnostics: [] };
  } catch (err) {
    return record('apply-error', [diagnostic('overview-apply-failed', err instanceof Error ? err.message : String(err))]);
  }
}

/** Guard against the parser and projection domain drifting independently. */
export const PLAN_HUMAN_OVERVIEW_STABLE_TABS = PLAN_TAB_KEYS;
