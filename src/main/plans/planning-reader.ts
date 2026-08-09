// WP-P1A (amended) — planning-reader: bounded enumeration + safe read.
//
// A read-only filesystem surface over the two planning homes, both resolved
// through the state-dir migration so the `.dashboard` fallback is honored for
// free (workspaceStateDir → workspaceStateDirName → migrateWorkspaceStateDir):
//
//   • Bare proposals — FLAT markdown files `<stateDir>/proposals/*.md`
//     (top level only; `supporting/` deliberation docs are NOT enumerated here).
//   • Plan folders — §R0 directories `<stateDir>/plans/<sku>/` that carry a
//     valid `plan.json` (`plan_artifact_id`). Stray / plan.json-less dirs are
//     skipped with a diagnostic, never adopted.
//
// SECURITY MODEL. No raw absolute path ever leaves main. Enumeration issues an
// OPAQUE, deterministic manifest document id (`docId`) per document and records
// its resolution (workspace root, the containment boundary it lives under, and
// its in-boundary relative path) in a per-process registry. Reads take ONLY the
// opaque id and RE-VALIDATE at read time — containment against the realpath'd
// boundary, reparse-point rejection (a symlink/junction escaping the boundary
// makes realpath diverge → rejected), `..`-traversal + mixed-separator
// normalization, and a per-file byte cap (truncate + flag). This is TOCTOU-safe:
// a folder atomically replaced by a symlink between list and read is caught at
// read time.
//
// LIFECYCLE (§R1) is derived READ-ONLY for display. We parse PLAN-INTENT
// sentinels + PLAN-INTEGRATION records from the canonical marked doc (`plan.md`,
// falling back to the linked source proposal pre-hardening), the output
// frontmatter of in-folder deliberation/research docs, and the normalized
// Markdown links in `plan.md`. We surface marked / returned / folded-in; `ran`
// is ALWAYS `unavailable-pre-ledger` and a self-declared `orchestration_id` is
// never presented as authoritative. No DB is touched; nothing is written.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { PathType } from '../../shared/types';
import type {
  PlanningReaderDocument,
  PlanningReaderEntry,
  PlanningReaderListResult,
  PlanningReaderReadResult,
  PlanningIntentView,
  PlanningIntentOutputView,
} from '../../shared/types';
import { workspaceStateDir } from '../workspace-state-dir';
import { calculateArcFreshness } from './plan-manifest';

// ── Caps (overridable in tests) ────────────────────────────────────────────
export interface PlanningReaderCaps {
  /** Max entries (proposals + folders) returned by one list. */
  maxEntries: number;
  /** Max documents enumerated per plan folder. */
  maxDocsPerFolder: number;
  /** Max cumulative document bytes enumerated per plan folder. */
  maxManifestBytes: number;
  /** Max bytes returned by a single read (truncated beyond this). */
  maxReadBytes: number;
}

export const DEFAULT_PLANNING_READER_CAPS: PlanningReaderCaps = {
  maxEntries: 1000,
  maxDocsPerFolder: 200,
  maxManifestBytes: 50_000_000,
  maxReadBytes: 4_000_000,
};

export interface PlanningReaderOptions {
  pathType?: PathType;
  caps?: Partial<PlanningReaderCaps>;
}

// ── Opaque-id registry ──────────────────────────────────────────────────────
interface DocResolution {
  workspaceRoot: string;
  /** Absolute containment boundary this doc must stay inside (proposals dir or
   *  the specific plan folder). */
  boundary: string;
  /** Absolute path of the document as enumerated (re-validated on read). */
  absPath: string;
  name: string;
}

/** Per-process docId → resolution. Populated on list; consulted + re-validated
 *  on read. Deterministic ids make repeated lists stable. */
const docRegistry = new Map<string, DocResolution>();

/** Test hook: clear the opaque-id registry between cases. */
export function resetPlanningReaderRegistryForTests(): void {
  docRegistry.clear();
}

function opaqueId(prefix: string, ...parts: string[]): string {
  const h = crypto.createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${prefix}_${h.slice(0, 24)}`;
}

// ── Path safety helpers ──────────────────────────────────────────────────────

/** Normalize a caller/enumerated relative path: unify separators, reject
 *  absolutes, drive letters, and any `..` traversal component. Returns the
 *  POSIX-normalized relative path, or null if it is unsafe. */
export function safeRelPath(rel: string): string | null {
  if (typeof rel !== 'string' || rel === '') return null;
  const unified = rel.replace(/\\/g, '/');
  // Absolute (POSIX or UNC) or drive-letter rooted → reject.
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) return null;
  const parts = unified.split('/');
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null; // no traversal, ever
    out.push(seg);
  }
  if (out.length === 0) return null;
  return out.join('/');
}

/** Realpath a path if it exists; else realpath its nearest existing ancestor and
 *  re-append the missing tail — so containment can be checked even for a path
 *  that was just deleted (returns a best-effort absolute canonical path). */
function realpathBestEffort(abs: string): string {
  try {
    return fs.realpathSync.native(abs);
  } catch {
    // Walk up to the nearest existing ancestor, canonicalize it, re-append.
    let cur = abs;
    const tail: string[] = [];
    for (let i = 0; i < 64; i++) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.unshift(path.basename(cur));
      cur = parent;
      try {
        const real = fs.realpathSync.native(cur);
        return path.join(real, ...tail);
      } catch {
        /* keep walking up */
      }
    }
    return path.resolve(abs);
  }
}

/** True iff `child` is the same as or nested inside `parent` (case-insensitive
 *  on Windows), using canonical separators. */
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

/**
 * Resolve an enumerated in-boundary relative path to an absolute path, enforcing
 * ALL read-time guards, and return it only if safe:
 *   • `..`-traversal + mixed-separator normalization,
 *   • lexical containment inside the boundary,
 *   • realpath (reparse-point) containment — a symlink/junction escaping the
 *     boundary makes the canonical path diverge and is rejected.
 * Returns null when any guard fails.
 */
function resolveContained(boundary: string, rel: string): string | null {
  const safe = safeRelPath(rel);
  if (safe === null) return null;
  const abs = path.resolve(boundary, safe);
  if (!isContained(boundary, abs)) return null; // lexical
  // Reparse-point / symlink escape: the canonical path (and the canonical
  // boundary) must still be contained.
  const realBoundary = realpathBestEffort(boundary);
  const realAbs = realpathBestEffort(abs);
  if (!isContained(realBoundary, realAbs)) return null;
  return abs;
}

/** Resolve the manifest-linked source proposal under the active state root.
 * The manifest may retain either state-dir spelling across migration, but the
 * proposal itself must be one flat markdown file inside proposals/. */
function inspectSourceProposal(
  proposalsDir: string,
  rawRelPath: unknown,
): FolderDoc | null {
  if (typeof rawRelPath !== 'string') return null;
  const safe = safeRelPath(rawRelPath);
  if (safe === null) return null;
  const parts = safe.split('/');
  if (
    parts.length !== 3
    || !['.lares', '.dashboard'].includes(parts[0])
    || parts[1] !== 'proposals'
    || !/\.md$/i.test(parts[2])
  ) return null;
  const abs = resolveContained(proposalsDir, parts[2]);
  if (abs === null) return null;
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    return {
      relPath: parts[2],
      absPath: abs,
      name: parts[2],
      category: 'proposal',
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return null;
  }
}

// ── §R1 markup parsing (read-only) ──────────────────────────────────────────

interface RawIntent {
  intentId: string;
  part: string | null;
  kind: string;
  targets: Array<{ provider?: string; model?: string }>;
  reason: string | null;
  supersedesIntentId: string | null;
}

interface RawIntegration {
  intentId: string;
  outputRelPath: string;
  changed: string | null;
  disposition: 'active' | 'superseded' | 'withdrawn';
}

/** Extract JSON payloads from `<!--NAME ... -->` comment sentinels. Malformed
 *  JSON is skipped (never throws); the count of malformed blocks is reported. */
function parseSentinels(markdown: string, name: string): { records: any[]; malformed: number } {
  const re = new RegExp(`<!--\\s*${name}\\s*([\\s\\S]*?)-->`, 'g');
  const records: any[] = [];
  let malformed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const body = m[1].trim();
    try {
      records.push(JSON.parse(body));
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

function asTargets(v: unknown): Array<{ provider?: string; model?: string }> {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t) => t && typeof t === 'object')
    .map((t) => {
      const o = t as Record<string, unknown>;
      const out: { provider?: string; model?: string } = {};
      if (typeof o.provider === 'string') out.provider = o.provider;
      if (typeof o.model === 'string') out.model = o.model;
      return out;
    });
}

function parseIntents(markdown: string): { intents: RawIntent[]; malformed: number } {
  const { records, malformed } = parseSentinels(markdown, 'PLAN-INTENT');
  const intents: RawIntent[] = [];
  for (const r of records) {
    if (!r || typeof r !== 'object' || typeof r.intent_id !== 'string') continue;
    intents.push({
      intentId: r.intent_id,
      part: typeof r.part === 'string' ? r.part : null,
      kind: typeof r.kind === 'string' ? r.kind : 'unknown',
      targets: asTargets(r.targets),
      reason: typeof r.reason === 'string' ? r.reason : null,
      supersedesIntentId: typeof r.supersedes_intent_id === 'string' ? r.supersedes_intent_id : null,
    });
  }
  return { intents, malformed };
}

function parseIntegrations(markdown: string): RawIntegration[] {
  const { records } = parseSentinels(markdown, 'PLAN-INTEGRATION');
  const out: RawIntegration[] = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.intent_id !== 'string' || typeof r.output_rel_path !== 'string') continue;
    const disp = r.disposition;
    out.push({
      intentId: r.intent_id,
      outputRelPath: r.output_rel_path,
      changed: typeof r.changed === 'string' ? r.changed : null,
      disposition:
        disp === 'superseded' || disp === 'withdrawn' ? disp : 'active',
    });
  }
  return out;
}

/** Parse inline Markdown link targets `[text](target)` → the target path (title
 *  and fragment stripped). External/URL targets and anchors are ignored. */
export function parseMarkdownLinkTargets(markdown: string): string[] {
  const re = /\[[^\]]*\]\(([^)]+)\)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    let target = m[1].trim();
    // Strip an optional title: (path "title") / (path 'title').
    const sp = target.search(/\s/);
    if (sp !== -1) target = target.slice(0, sp);
    // Strip a fragment / query.
    target = target.replace(/[#?].*$/, '');
    if (target === '') continue;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) continue; // scheme (http:, mailto:, …)
    out.push(target);
  }
  return out;
}

/** Parse leading YAML frontmatter (`---` … `---`) as flat `key: value` pairs. */
export function parseFrontmatter(text: string): Record<string, string> | null {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(text);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let val = kv[2].trim();
    // Strip a trailing inline comment and surrounding quotes.
    val = val.replace(/\s+#.*$/, '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[kv[1]] = val;
  }
  return out;
}

// ── Folder enumeration internals ─────────────────────────────────────────────

/** The subdirs a plan folder scatters outputs into. */
const OUTPUT_SUBDIRS = ['deliberations', 'research', 'supplements'] as const;
/** Documents never shown in the manifest. */
const SUPPRESSED = new Set(['.gitkeep', 'plan.json']);

function readFileSafe(abs: string, maxBytes: number): { content: string; size: number; truncated: boolean } | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
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

interface FolderDoc {
  relPath: string; // POSIX, boundary-relative
  absPath: string;
  name: string;
  category: PlanningReaderDocument['category'];
  size: number;
  mtimeMs: number;
}

/** Enumerate the documents of a valid plan folder, bounded by caps. Suppresses
 *  `.gitkeep`/`plan.json`; rejects reparse-point escapes per file. */
function enumerateFolderDocs(
  folder: string,
  caps: PlanningReaderCaps,
  warnings: string[],
): FolderDoc[] {
  const docs: FolderDoc[] = [];
  let totalBytes = 0;

  const push = (rel: string, category: PlanningReaderDocument['category']): boolean => {
    if (docs.length >= caps.maxDocsPerFolder) {
      warnings.push(`document cap (${caps.maxDocsPerFolder}) reached; manifest truncated`);
      return false;
    }
    const abs = resolveContained(folder, rel);
    if (abs === null) return true; // unsafe entry — skip, keep scanning
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return true;
    }
    if (st.isSymbolicLink() || !st.isFile()) return true; // reparse point / non-file → skip
    if (totalBytes + st.size > caps.maxManifestBytes) {
      warnings.push(`manifest byte cap (${caps.maxManifestBytes}) reached; manifest truncated`);
      return false;
    }
    totalBytes += st.size;
    docs.push({
      relPath: rel,
      absPath: abs,
      name: path.basename(rel),
      category,
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
    return true;
  };

  // Top-level canonical docs first (deterministic order).
  let topEntries: fs.Dirent[] = [];
  try {
    topEntries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return docs;
  }
  const topFiles = topEntries
    .filter((e) => e.isFile() && !SUPPRESSED.has(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  for (const name of topFiles) {
    const category: PlanningReaderDocument['category'] =
      name === 'plan.md' ? 'plan' : name === 'ARC.md' ? 'arc' : 'other';
    if (!push(name, category)) return docs;
  }

  // Scoped subdirs.
  for (const sub of OUTPUT_SUBDIRS) {
    const subAbs = resolveContained(folder, sub);
    if (subAbs === null) continue;
    let subEntries: fs.Dirent[] = [];
    try {
      subEntries = fs.readdirSync(subAbs, { withFileTypes: true });
    } catch {
      continue; // absent subdir → fine
    }
    const category: PlanningReaderDocument['category'] =
      sub === 'deliberations' ? 'deliberation' : sub === 'research' ? 'research' : 'supplement';
    const names = subEntries
      .filter((e) => e.isFile() && !SUPPRESSED.has(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (!push(`${sub}/${name}`, category)) return docs;
    }
  }

  return docs;
}

/** Derive each intent's disk lifecycle (§R1) from the canonical marked doc, the
 *  folder's output docs, and `plan.md`'s Markdown links. */
function deriveIntents(
  markedDoc: string,
  planMd: string | null,
  docs: FolderDoc[],
  planArtifactId: string | null,
  readFolderDoc: (rel: string) => string | null,
  warnings: string[],
): PlanningIntentView[] {
  const { intents, malformed } = parseIntents(markedDoc);
  if (malformed > 0) {
    warnings.push(`${malformed} malformed PLAN-INTENT sentinel(s) skipped`);
  }
  if (intents.length === 0) return [];

  const integrations = planMd ? parseIntegrations(planMd) : [];
  // Resolved Markdown-link targets in plan.md (POSIX, boundary-relative).
  const linkTargets = new Set<string>();
  if (planMd) {
    for (const t of parseMarkdownLinkTargets(planMd)) {
      const safe = safeRelPath(t);
      if (safe !== null) linkTargets.add(safe);
    }
  }

  // Index present outputs by declared intent_id (frontmatter identity).
  interface OutRec {
    relPath: string;
    intentId: string;
    orchestrationId: string | null;
    planArtifactId: string | null;
  }
  const outputsByIntent = new Map<string, OutRec[]>();
  for (const d of docs) {
    if (d.category !== 'deliberation' && d.category !== 'research') continue;
    const text = readFolderDoc(d.relPath);
    if (text === null) continue;
    const fm = parseFrontmatter(text);
    if (!fm || typeof fm.intent_id !== 'string') continue;
    const rec: OutRec = {
      relPath: d.relPath,
      intentId: fm.intent_id,
      orchestrationId: typeof fm.orchestration_id === 'string' ? fm.orchestration_id : null,
      planArtifactId: typeof fm.plan_artifact_id === 'string' ? fm.plan_artifact_id : null,
    };
    const list = outputsByIntent.get(rec.intentId) ?? [];
    list.push(rec);
    outputsByIntent.set(rec.intentId, list);
  }

  // Supersession: an intent named by another's supersedes_intent_id is superseded.
  const superseded = new Set<string>();
  for (const it of intents) {
    if (it.supersedesIntentId) superseded.add(it.supersedesIntentId);
  }

  const views: PlanningIntentView[] = [];
  for (const it of intents) {
    const raw = outputsByIntent.get(it.intentId) ?? [];
    const outViews: PlanningIntentOutputView[] = raw.map((o) => {
      const integ = integrations.find(
        (g) => g.intentId === it.intentId && safeRelPath(g.outputRelPath) === o.relPath,
      );
      const disposition = integ ? integ.disposition : 'active';
      // Frontmatter must match the folder's plan_artifact_id when both known.
      const matchesPlan =
        planArtifactId === null || o.planArtifactId === null || o.planArtifactId === planArtifactId;
      const present = true; // only present docs were enumerated
      const foldedIn = present && matchesPlan && linkTargets.has(o.relPath);
      return {
        relPath: o.relPath,
        intentId: o.intentId,
        orchestrationIdSelfDeclared: o.orchestrationId,
        presentOnDisk: present,
        disposition,
        foldedIn,
        integrationNote: integ ? integ.changed : null,
      };
    });

    const activeReturned = outViews.filter(
      (o) => o.presentOnDisk && o.disposition === 'active' && matchesFrontmatterPlan(raw, o, planArtifactId),
    );
    const returned = activeReturned.length > 0;
    const fullyFoldedIn = returned && activeReturned.every((o) => o.foldedIn);

    views.push({
      intentId: it.intentId,
      part: it.part,
      kind: it.kind,
      targets: it.targets,
      reason: it.reason,
      supersedesIntentId: it.supersedesIntentId,
      status: superseded.has(it.intentId) ? 'superseded' : 'active',
      marked: true,
      ran: 'unavailable-pre-ledger',
      returned,
      fullyFoldedIn,
      outputs: outViews,
    });
  }
  return views;
}

/** Whether an output view's declared plan_artifact_id matches the folder. */
function matchesFrontmatterPlan(
  raw: { relPath: string; planArtifactId: string | null }[],
  view: PlanningIntentOutputView,
  planArtifactId: string | null,
): boolean {
  if (planArtifactId === null) return true;
  const rec = raw.find((r) => r.relPath === view.relPath);
  return !rec || rec.planArtifactId === null || rec.planArtifactId === planArtifactId;
}

// ── Public API ────────────────────────────────────────────────────────────

function resolveCaps(caps?: Partial<PlanningReaderCaps>): PlanningReaderCaps {
  return { ...DEFAULT_PLANNING_READER_CAPS, ...(caps ?? {}) };
}

/**
 * Enumerate proposals + §R0 plan folders under the workspace state dir. Read-only
 * and crash-free: an unreadable/renamed/deleted entry is skipped with a
 * diagnostic, never thrown. Registers an opaque `docId` per document.
 */
export function listPlanningEntries(
  workspaceRoot: string,
  opts: PlanningReaderOptions = {},
): PlanningReaderListResult {
  const pathType = opts.pathType ?? 'windows';
  const caps = resolveCaps(opts.caps);
  const warnings: string[] = [];
  const entries: PlanningReaderEntry[] = [];

  const stateDir = workspaceStateDir(workspaceRoot, pathType);
  const proposalsDir = path.join(stateDir, 'proposals');
  const plansDir = path.join(stateDir, 'plans');

  const registerDoc = (boundary: string, absPath: string, rel: string, name: string): string => {
    const docId = opaqueId('pdoc', workspaceRoot, boundary, rel);
    docRegistry.set(docId, { workspaceRoot, boundary, absPath, name });
    return docId;
  };

  // ── Bare proposals: FLAT *.md at the top of proposals/ ──
  let proposalEntries: fs.Dirent[] = [];
  try {
    proposalEntries = fs.readdirSync(proposalsDir, { withFileTypes: true });
  } catch {
    proposalEntries = []; // absent → empty
  }
  const proposalFiles = proposalEntries
    .filter((e) => e.isFile() && /\.md$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  for (const name of proposalFiles) {
    if (entries.length >= caps.maxEntries) {
      warnings.push(`entry cap (${caps.maxEntries}) reached; listing truncated`);
      break;
    }
    const abs = resolveContained(proposalsDir, name);
    if (abs === null) continue;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    const docId = registerDoc(proposalsDir, abs, name, name);
    const doc: PlanningReaderDocument = {
      docId,
      name,
      category: 'proposal',
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
    };
    entries.push({
      entryId: opaqueId('pent', workspaceRoot, proposalsDir, name),
      kind: 'proposal',
      title: name.replace(/\.md$/i, ''),
      documents: [doc],
      mtimeMs: st.mtimeMs,
    });
  }

  // ── Plan folders: §R0-valid directories under plans/ ──
  let planDirEntries: fs.Dirent[] = [];
  try {
    planDirEntries = fs.readdirSync(plansDir, { withFileTypes: true });
  } catch {
    planDirEntries = [];
  }
  const folderNames = planDirEntries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  for (const sku of folderNames) {
    if (entries.length >= caps.maxEntries) {
      warnings.push(`entry cap (${caps.maxEntries}) reached; listing truncated`);
      break;
    }
    const folder = resolveContained(plansDir, sku);
    if (folder === null) continue;
    // Reject a plan-folder that is itself a reparse point escaping plans/.
    try {
      if (fs.lstatSync(folder).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    // §R0 validity: plan.json present + parseable + has plan_artifact_id.
    let planJson: any = null;
    try {
      planJson = JSON.parse(fs.readFileSync(path.join(folder, 'plan.json'), 'utf-8'));
    } catch {
      warnings.push(`skipped ${sku}: missing or unreadable plan.json`);
      continue;
    }
    if (!planJson || typeof planJson.plan_artifact_id !== 'string' || planJson.plan_artifact_id === '') {
      warnings.push(`skipped ${sku}: plan.json has no valid plan_artifact_id`);
      continue;
    }
    const planArtifactId: string = planJson.plan_artifact_id;
    const planSku: string | null = typeof planJson.plan_sku === 'string' ? planJson.plan_sku : sku;

    const entryWarnings: string[] = [];
    const folderDocs = enumerateFolderDocs(folder, caps, entryWarnings);
    let sourceProposal = inspectSourceProposal(proposalsDir, planJson.source_proposal?.rel_path);
    if (sourceProposal && folderDocs.length >= caps.maxDocsPerFolder) {
      entryWarnings.push(`document cap (${caps.maxDocsPerFolder}) reached; source proposal omitted`);
      sourceProposal = null;
    }
    if (
      sourceProposal
      && folderDocs.reduce((total, doc) => total + doc.size, 0) + sourceProposal.size > caps.maxManifestBytes
    ) {
      entryWarnings.push(`manifest byte cap (${caps.maxManifestBytes}) reached; source proposal omitted`);
      sourceProposal = null;
    }

    // Register opaque ids + build the manifest.
    const manifestDocs = sourceProposal ? [...folderDocs, sourceProposal] : folderDocs;
    const arcFreshness = folderDocs.some((d) => d.category === 'arc' && d.name === 'ARC.md')
      ? calculateArcFreshness(folder)
      : null;
    const documents: PlanningReaderDocument[] = manifestDocs.map((d) => ({
      docId: registerDoc(d.category === 'proposal' ? proposalsDir : folder, d.absPath, d.relPath, d.name),
      name: d.name,
      category: d.category,
      sizeBytes: d.size,
      mtimeMs: d.mtimeMs,
      ...(d.category === 'arc' && d.name === 'ARC.md' && arcFreshness ? { stale: arcFreshness.stale } : {}),
    }));

    // Canonical marked doc: plan.md, else the linked source proposal.
    const readFolderDoc = (rel: string): string | null => {
      const abs = resolveContained(folder, rel);
      if (abs === null) return null;
      const r = readFileSafe(abs, caps.maxReadBytes);
      return r ? r.content : null;
    };
    const planMd = readFolderDoc('plan.md');
    let markedDoc = planMd;
    if (markedDoc === null) {
      // Fall back to the linked source proposal (pre-hardening).
      if (sourceProposal) {
        const r = readFileSafe(sourceProposal.absPath, caps.maxReadBytes);
        markedDoc = r ? r.content : null;
      }
    }

    const intents =
      markedDoc !== null
        ? deriveIntents(markedDoc, planMd, folderDocs, planArtifactId, readFolderDoc, entryWarnings)
        : [];

    const mtimeMs = manifestDocs.reduce((mx, d) => Math.max(mx, d.mtimeMs), 0);
    entries.push({
      entryId: opaqueId('pent', workspaceRoot, plansDir, sku),
      kind: 'plan-folder',
      title: planSku ?? sku,
      documents,
      mtimeMs,
      planArtifactId,
      planSku,
      intents,
      ...(entryWarnings.length ? { warnings: entryWarnings } : {}),
    });
  }

  return { entries, warnings };
}

/**
 * Read one document by its OPAQUE manifest id. Re-validates containment +
 * reparse-point safety at read time (TOCTOU-safe) and enforces the per-file byte
 * cap (truncate + flag). Returns `{ error }` for an unknown id or a file that no
 * longer resolves safely.
 */
export function readPlanningDocument(
  docId: string,
  opts: PlanningReaderOptions = {},
): PlanningReaderReadResult | { error: string } {
  const caps = resolveCaps(opts.caps);
  const res = docRegistry.get(docId);
  if (!res) return { error: 'unknown manifest document id' };

  // Re-derive the boundary-relative path and RE-VALIDATE (the folder may have
  // been swapped for a symlink since enumeration).
  const rel = path.relative(res.boundary, res.absPath).replace(/\\/g, '/');
  const abs = resolveContained(res.boundary, rel);
  if (abs === null) return { error: 'document failed containment re-validation' };

  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(abs);
  } catch {
    return { error: 'document unreadable or no longer present' };
  }
  if (lst.isSymbolicLink() || !lst.isFile()) {
    return { error: 'document is a reparse point or not a regular file' };
  }

  const r = readFileSafe(abs, caps.maxReadBytes);
  if (r === null) return { error: 'document unreadable or no longer present' };
  if (res.name === 'ARC.md') {
    const freshness = calculateArcFreshness(res.boundary);
    if (freshness.stale) {
      const detail = freshness.error
        ? `Freshness could not be verified (${freshness.error}).`
        : `Source artifacts are newer than ARC-META by ${Math.ceil(freshness.sourceMtimeMs - freshness.cutoffMs!)} ms.`;
      return {
        docId,
        name: res.name,
        content: `# ARC is stale\n\n${detail} Refresh ARC from current disk and ledger evidence before using its prose as completion state.`,
        truncated: false,
        sizeBytes: r.size,
        stale: true,
      };
    }
  }
  return {
    docId,
    name: res.name,
    content: r.content,
    truncated: r.truncated,
    sizeBytes: r.size,
    ...(res.name === 'ARC.md' ? { stale: false } : {}),
  };
}
