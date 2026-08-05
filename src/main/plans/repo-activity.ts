// Fix-4: witnessed repo-activity — pure caps / normalization / digest wording.
// NO DB/FS I/O. Imports ONLY
// shared types; this module owns the LOGIC and the cap/wording constants.
import type {
  FileActivity,
  RepoActivityEvidenceV1,
  RepoActivityFileItem,
  RepoActivityDigest,
  RepoActivityDetail,
  FileOperation,
} from '../../shared/types';

export const FILE_DETAIL_MAX = 200;
export const BLOB_BYTE_CAP = 32_768;
// Both spellings: `.lares` is the live state dir; `.dashboard` still appears
// in historical provenance rows and rename-failed fallback sessions.
export const DEFAULT_EXCLUDE_DIRS = ['.lares', '.dashboard'];

// Runtime-testable exhaustive op set; the drift test (I-10) asserts its keys, and
// the `satisfies` clause breaks compile if the FileOperation union changes.
export const FILE_OPS = { read: true, write: true, create: true } satisfies Record<FileOperation, true>;

export interface RollupOpts {
  sinceIso: string;
  untilIso: string;
  workspaceRoot: string;
  planRelPath: string | null;
  excludeDirs?: string[];
  fileDetailMax?: number;
}

// file_activities.timestamp is SQLite datetime('now') ('YYYY-MM-DD HH:MM:SS'), but
// evidence stores ISO. Normalize before storing / sorting.
function normalizeActivityTimestamp(ts: string): string {
  if (/^\d{4}-\d{2}-\d{2}T/.test(ts)) return ts;
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? ts : d.toISOString();
}

// Relativize a file_activities path against the workspace root. Tolerant of
// Windows + WSL/POSIX roots; path-util has no workspace-relative helper.
function toRel(filePath: string, workspaceRoot: string): { rel: string; outside: boolean } {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const f = norm(filePath), root = norm(workspaceRoot);
  const ci = /^[a-zA-Z]:/.test(f) && /^[a-zA-Z]:/.test(root); // Windows drive → case-insensitive
  const fp = ci ? f.toLowerCase() : f, rp = ci ? root.toLowerCase() : root;
  if (fp === rp) return { rel: '', outside: false };
  if (fp.startsWith(rp + '/')) return { rel: f.slice(root.length + 1), outside: false };
  return { rel: f, outside: true }; // keep full path, flag it
}

// Fix rec-4 (defensive, read-time): a path that ingress canonicalization did NOT
// resolve to absolute — a legacy/ambiguous row, or one captured before the
// workspace root was known — reaches here still RELATIVE and `toRel` flags it
// `outside`. If it is a workspace-relative plan or `.dashboard` path it must
// still be excluded, never surfaced as outside-workspace evidence. Returns the
// forward-slashed relative candidate, or null when the path is absolute (a
// genuinely-outside absolute path stays outside).
function relativeExclusionCandidate(filePath: string): string | null {
  const s = filePath.replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(s) || s.startsWith('/')) return null; // absolute → not workspace-relative
  return s.replace(/^\.\//, '').replace(/\/+$/, '');
}

const byteLen = (s: string) => Buffer.byteLength(s, 'utf8');

export function rollupRepoActivity(rows: FileActivity[], opts: RollupOpts): RepoActivityEvidenceV1 {
  const excludeDirs = opts.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;
  const cap = opts.fileDetailMax ?? FILE_DETAIL_MAX;
  const planRel = opts.planRelPath ? opts.planRelPath.replace(/\\/g, '/') : null;

  const byPath = new Map<string, RepoActivityFileItem>();
  for (const r of rows) {
    // DB rows are strings; drop unknown ops before they corrupt counts.
    if (r.operation !== 'read' && r.operation !== 'write' && r.operation !== 'create') continue;
    const { rel, outside } = toRel(r.filePath, opts.workspaceRoot);
    if (!outside) {
      if (planRel && rel === planRel) continue;                                    // I7: plan's own HTML
      if (excludeDirs.some((d) => rel === d || rel.startsWith(d + '/'))) continue; // I7: .dashboard/**
    } else {
      // Defensive: an unresolved RELATIVE plan/.dashboard path (legacy row) is
      // classified `outside` — exclude it here too so it can't leak as evidence.
      const cand = relativeExclusionCandidate(r.filePath);
      if (cand !== null) {
        if (planRel && cand === planRel) continue;
        if (excludeDirs.some((d) => cand === d || cand.startsWith(d + '/'))) continue;
      }
    }
    const at = normalizeActivityTimestamp(r.timestamp);
    const key = outside ? '::' + r.filePath : rel;
    let item = byPath.get(key);
    if (!item) {
      item = {
        path: rel,
        operations: [],
        counts: { read: 0, write: 0, create: 0 },
        firstAt: at,
        lastAt: at,
        ...(outside ? { outsideWorkspace: true } : {}),
      };
      byPath.set(key, item);
    }
    const op = r.operation as 'read' | 'write' | 'create';
    item.counts[op] += 1;
    if (!item.operations.includes(op)) item.operations.push(op);
    if (at < item.firstAt) item.firstAt = at;
    if (at > item.lastAt) item.lastAt = at;
  }

  const all = Array.from(byPath.values());
  const totals = {
    filesRead:    all.filter((i) => i.counts.read   > 0).length,
    filesEdited:  all.filter((i) => i.counts.write  > 0).length,
    filesCreated: all.filter((i) => i.counts.create > 0).length,
    fileEvents:   all.reduce((n, i) => n + i.counts.read + i.counts.write + i.counts.create, 0),
    distinctFiles: all.length,
    testsRun: 0, testsPassed: 0, testsFailed: 0,
  };
  // FILE_DETAIL_MAX: keep the most-recently-touched N; totals stay pre-cap.
  const sorted = all.slice().sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  const truncated = sorted.length > cap;
  const items = truncated ? sorted.slice(0, cap) : sorted;

  return {
    schemaVersion: 1, status: 'captured',
    window: { sinceIso: opts.sinceIso, untilIso: opts.untilIso },
    totals,
    files: { truncated, items },
    tests:   { truncated: false, items: [] },
    commits: { truncated: false, items: [] },
    caps: { fileDetailMax: cap },
  };
}

// BLOB_BYTE_CAP is a BYTE cap (paths may be non-ASCII) — measure with Buffer.byteLength.
export function serializeRepoActivityEvidence(evidence: RepoActivityEvidenceV1): string {
  let ev = evidence, json = JSON.stringify(ev);
  if (byteLen(json) <= BLOB_BYTE_CAP) return json;
  let items = ev.files.items.slice();
  while (items.length > 0 && byteLen(json) > BLOB_BYTE_CAP) {
    items = items.slice(0, Math.max(0, Math.floor(items.length / 2)));
    ev = { ...ev, files: { truncated: true, items } };
    json = JSON.stringify(ev);
  }
  return json; // totals untouched even when items === []
}

// Tolerant — never throws; malformed / oversized / wrong-version → null.
export function parseRepoActivityEvidence(json: string | null | undefined): RepoActivityEvidenceV1 | null {
  if (!json || typeof json !== 'string') return null;
  if (byteLen(json) > BLOB_BYTE_CAP * 2) return null; // oversized guard (bytes)
  try {
    const p = JSON.parse(json);
    if (p && typeof p === 'object' && p.schemaVersion === 1 && p.status === 'captured' && p.totals && p.files)
      return p as RepoActivityEvidenceV1;
  } catch { /* malformed → null */ }
  return null;
}

// Counts only; omit zero clauses; NO paths. tests/commit clause is RESERVED (dead
// in cut 1 — testsRun/commits always 0/empty). Internal separator is ASCII '; '.
export function formatRepoDigest(totals: RepoActivityEvidenceV1['totals'] | null): string | null {
  if (!totals) return null;
  const parts: string[] = [];
  if (totals.filesEdited  > 0) parts.push(`${totals.filesEdited} repo files edited`);
  if (totals.filesCreated > 0) parts.push(`${totals.filesCreated} created`);
  if (totals.filesRead    > 0) parts.push(`${totals.filesRead} read`);
  if (totals.testsRun > 0) parts.push(`${totals.testsPassed} suites green`); // RESERVED
  if (parts.length === 0) return null; // no-activity turn adds nothing to the <li>
  return 'witnessed: ' + parts.join('; ');
}

export function toTier2Digest(evidence: RepoActivityEvidenceV1 | null): RepoActivityDigest {
  if (!evidence) return { status: 'not-captured', totals: null, line: null };
  return { status: 'captured', totals: evidence.totals, line: formatRepoDigest(evidence.totals) };
}

export function toTier3Detail(planEventId: string, evidence: RepoActivityEvidenceV1): RepoActivityDetail {
  return { planEventId, files: evidence.files, totals: evidence.totals, window: evidence.window };
}
