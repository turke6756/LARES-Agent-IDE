// WP-P2B — proposals-watcher (witnessed attribution, adopt/mint, policies).
//
// Owns `.lares/proposals/` ONLY: the FLAT `*.md` proposal artifacts at the top of
// that directory (deliberation/detail docs under `supporting/` are NOT proposals
// and are never enumerated here). This watcher's events NEVER reach
// `reparsePlanFile` — proposals are a distinct artifact type from plans. It also
// does NOT own the state-dir plans home under `<workspaceStateDir()>/plans/`;
// that is WP-P2B-folder, a separate later package.
//
// The DB INGESTS + enriches these filesystem-owned artifacts, never owns them
// (§R0). Identity is (workspace_id, path). On subscription init the resolved
// `.lares/proposals/` dir is ENSURED (mkdir -p on Windows) so registration works
// even before any supervisor launch has scaffolded the folder.
//
// ── Attribution (witnessed-first) ────────────────────────────────────────────
// author_role is derived from the `file_activities` witness store — the agent
// that actually WROTE the file — NOT from one-agent-per-cwd (many agents share a
// working directory by design) and NOT from the file's self-declared
// `author_role:` frontmatter (untrusted self-claim). No witnessed write ⇒
// author_role='unknown'. Date grouping uses the DB `created_at` stamped at
// registration, which stays STABLE across later edits.
//
// ── Frontmatter artifact_id (adopt / mint) ───────────────────────────────────
//   • present  → ADOPT the id as-is.
//   • absent   → MINT a portable id and safely INSERT it into the frontmatter
//                (into an existing valid block, or a fresh prepended block when
//                there is none). Idempotent: the next scan then adopts it.
//   • malformed frontmatter (an opening `---` with no closing fence) → QUARANTINE:
//                report a diagnostic, do NOT register, and NEVER rewrite the file.
//
// ── Duplicate policy (NORMATIVE) ─────────────────────────────────────────────
// A duplicate `artifact_id` within one workspace (a second path claiming an id
// the canonical row already holds) is left UNREGISTERED with a both-paths
// diagnostic. The canonical row is NEVER rebound.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { PathType, Workspace } from '../shared/types';
import { subscribe } from './fs-watcher';
import {
  type ProposalRecord,
  type ProposalAuthorRole,
  getWorkspaces,
  getAgent,
  insertProposalRecord,
  getProposalByWorkspacePath,
  listProposalsByWorkspace,
  getProposalByWorkspaceArtifactId,
  getLatestWriteWitnessAgentId,
  touchProposalRecord,
  softDeleteProposalRecord,
} from './database';
import { workspaceStateDir, workspaceStateDirName } from './workspace-state-dir';
import { canonicalizeToAbsolute } from './file-activity-normalize';
import { isProposalArtifactId } from '../shared/planning-artifact-ids';

const PROPOSALS_SUBDIR = 'proposals';
const DEBOUNCE_MS = 250;
const WORKSPACE_REFRESH_MS = 30_000;
const MINTED_ID_PREFIX = 'prop_';

export type ProposalDiagnosticKind =
  | 'duplicate-artifact-id'
  | 'malformed-frontmatter'
  | 'non-contract-artifact-id';

export interface ProposalDiagnostic {
  kind: ProposalDiagnosticKind;
  workspaceId: string;
  /** Workspace-relative path of the offending proposal. */
  relPath: string;
  /** For a duplicate: the workspace-relative path of the canonical row. */
  otherRelPath?: string;
  detail: string;
}

export interface ReconcileResult {
  registered: ProposalRecord[];
  diagnostics: ProposalDiagnostic[];
}

// ── Frontmatter analysis (pure, CRLF/BOM-preserving) ─────────────────────────

export type FrontmatterAnalysis =
  | { kind: 'malformed' }
  | { kind: 'absent' }
  | { kind: 'present'; fields: Record<string, string>; openEnd: number };

/** Parse the leading `---`…`---` block WITHOUT normalizing the source (so a
 *  later re-serialize preserves CRLF and BOM byte-for-byte). `openEnd` is the
 *  byte offset in the ORIGINAL string just past the opening fence line — the
 *  safe insertion point for a minted `artifact_id:` line.
 *
 *  A leading `---` with no closing fence is `malformed`; no leading `---` at all
 *  is `absent`; anything else is `present` with the flat key:value scalars. */
export function analyzeFrontmatter(raw: string): FrontmatterAnalysis {
  const bom = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  const s = bom ? raw.slice(1) : raw;

  // Opening fence must be the very first line: `---` (optional trailing ws) + EOL.
  const open = /^---[ \t]*(\r?\n)/.exec(s);
  if (!open) return { kind: 'absent' };

  // Find a closing `---` line after the opening one.
  const rest = s.slice(open[0].length);
  const close = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(rest);
  if (!close) return { kind: 'malformed' };

  const yaml = rest.slice(0, close.index + (close[1] ? close[1].length : 0));
  const fields: Record<string, string> = {};
  for (const line of yaml.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fields[kv[1]] = val;
  }
  return { kind: 'present', fields, openEnd: bom + open[0].length };
}

/** Insert a minted `artifact_id` into `raw`, preserving existing bytes/newlines.
 *  Returns the new content, or null when the frontmatter is malformed (never
 *  rewrite a malformed file). Idempotent: if a valid block already carries an
 *  `artifact_id`, the input is returned unchanged. */
export function insertArtifactId(raw: string, artifactId: string): string | null {
  const a = analyzeFrontmatter(raw);
  if (a.kind === 'malformed') return null;
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  if (a.kind === 'absent') {
    return `---${nl}artifact_id: ${artifactId}${nl}---${nl}${nl}${raw}`;
  }
  if (a.fields.artifact_id !== undefined && a.fields.artifact_id !== '') return raw;
  return raw.slice(0, a.openEnd) + `artifact_id: ${artifactId}${nl}` + raw.slice(a.openEnd);
}

/** Mint a portable proposal artifact id (matches the `prop_<hex>` shape the
 *  capture skill emits). */
export function mintArtifactId(): string {
  return MINTED_ID_PREFIX + crypto.randomBytes(4).toString('hex');
}

// ── Small path/fs helpers (module-owned scoping) ─────────────────────────────

function sepFor(ws: Workspace): string {
  return ws.pathType === 'wsl' ? '/' : (ws.path.includes('\\') ? '\\' : '/');
}

/** Absolute proposals dir for a workspace (state-dir migration aware). */
function proposalsDirFor(ws: Workspace): string {
  return joinNative(workspaceStateDir(ws.path, ws.pathType), PROPOSALS_SUBDIR, ws.pathType);
}

function joinNative(base: string, child: string, pathType: PathType): string {
  const sep = pathType === 'wsl' ? '/' : (base.includes('\\') ? '\\' : '/');
  return `${base.replace(/[\\/]+$/, '')}${sep}${child}`;
}

/** Workspace-relative POSIX path of a proposal file, honoring the `.dashboard`
 *  fallback (`<stateDirName>/proposals/<name>`). */
function relProposalPath(ws: Workspace, name: string): string {
  return `${workspaceStateDirName(ws.path, ws.pathType)}/${PROPOSALS_SUBDIR}/${name}`;
}

/** Ensure the resolved proposals dir exists (Windows mkdir -p). WSL creation is
 *  best-effort deferred — the listing tolerates an absent dir. Never throws. */
export function ensureProposalsDir(ws: Workspace): void {
  if (ws.pathType === 'wsl') return;
  try { fs.mkdirSync(proposalsDirFor(ws), { recursive: true }); }
  catch (err) { log(`ensureProposalsDir failed for ${ws.id}`, err); }
}

function log(msg: string, err?: unknown): void {
  if (err !== undefined) console.error(`[proposals-watcher] ${msg}`, err);
  else console.log(`[proposals-watcher] ${msg}`);
}

// ── Attribution ──────────────────────────────────────────────────────────────

interface WitnessedAuthor {
  authorAgentId: string | null;
  authorRole: ProposalAuthorRole;
  authorDisplay: string | null;
}

const UNKNOWN_AUTHOR: WitnessedAuthor = { authorAgentId: null, authorRole: 'unknown', authorDisplay: null };

/** Witnessed-first author for a proposal at `absPath` in workspace `ws`. Resolves
 *  the writing agent from `file_activities`; unknown when there is no write
 *  witness, the agent no longer exists, or it belongs to another workspace. */
function resolveAuthor(ws: Workspace, absPath: string): WitnessedAuthor {
  // Look up the witness with the SAME canonical form `addFileActivity` stores, so
  // a drive-letter-case / separator difference never hides a real witness.
  const key = canonicalizeToAbsolute(absPath) || absPath;
  const agentId = getLatestWriteWitnessAgentId(key);
  if (!agentId) return UNKNOWN_AUTHOR;
  const agent = getAgent(agentId);
  if (!agent || agent.workspaceId !== ws.id) return UNKNOWN_AUTHOR;
  const role: ProposalAuthorRole = agent.isSupervisor
    ? 'supervisor'
    : (agent.isWorker || agent.isResearcher) ? 'worker' : 'unknown';
  return { authorAgentId: agent.id, authorRole: role, authorDisplay: agent.title || null };
}

// ── ISO → epoch-ms (self-declared authored_at, display detail only) ──────────
function parseAuthoredAt(v: string | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// ── Watcher ──────────────────────────────────────────────────────────────────

interface WorkspaceState {
  ws: Workspace;
  proposalsDir: string;
  unsubscribe: () => void;
  debounce: ReturnType<typeof setTimeout> | null;
}

export interface ProposalsWatcherOptions {
  /** Injected clock for deterministic `created_at`/`updated_at` (tests). */
  now?: () => number;
}

export class ProposalsWatcher {
  private states = new Map<string, WorkspaceState>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private readonly now: () => number;

  constructor(opts: ProposalsWatcherOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.attachAll();
    this.refreshTimer = setInterval(() => { void this.attachAll(); }, WORKSPACE_REFRESH_MS);
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

  private async attachAll(): Promise<void> {
    let workspaces: Workspace[];
    try { workspaces = getWorkspaces(); } catch (err) { log('getWorkspaces failed', err); return; }
    for (const ws of workspaces) {
      if (this.states.has(ws.id)) continue;
      // ENSURE the dir on init — works without a supervisor launch (WP-P2B).
      ensureProposalsDir(ws);
      const state: WorkspaceState = {
        ws, proposalsDir: proposalsDirFor(ws), unsubscribe: () => {}, debounce: null,
      };
      this.states.set(ws.id, state);
      try { this.reconcileWorkspace(ws); }
      catch (err) { log(`boot reconcile failed for ${ws.id}`, err); }
      try {
        state.unsubscribe = subscribe(state.proposalsDir, ws.pathType, () => this.scheduleReconcile(ws.id));
      } catch (err) { log(`subscribe failed for ${ws.id}`, err); }
    }
  }

  private scheduleReconcile(workspaceId: string): void {
    const st = this.states.get(workspaceId);
    if (!st) return;
    if (st.debounce) clearTimeout(st.debounce);
    st.debounce = setTimeout(() => {
      st.debounce = null;
      try { this.reconcileWorkspace(st.ws); }
      catch (err) { log(`reconcile failed for ${workspaceId}`, err); }
    }, DEBOUNCE_MS);
  }

  /**
   * Full scan + register for one workspace. Enumerates FLAT `*.md` at the top of
   * the proposals dir (never `supporting/`), registering new files (adopt/mint +
   * witnessed author), touching changed ones, and soft-deleting vanished rows.
   * Duplicate/malformed handled per NORMATIVE policy. Synchronous + crash-free —
   * a bad entry is skipped with a diagnostic, never thrown.
   */
  reconcileWorkspace(ws: Workspace): ReconcileResult {
    const result: ReconcileResult = { registered: [], diagnostics: [] };
    const dir = proposalsDirFor(ws);

    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { entries = []; } // absent dir → nothing to do

    const presentRel = new Set<string>();
    const names = entries
      .filter((e) => e.isFile() && /\.md$/i.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    for (const name of names) {
      const relPath = relProposalPath(ws, name);
      presentRel.add(relPath);
      try {
        this.reconcileOne(ws, dir, name, relPath, result);
      } catch (err) {
        log(`reconcile of ${relPath} failed`, err);
      }
    }

    // Vanished rows → soft-delete (idempotent).
    for (const row of listProposalsByWorkspace(ws.id)) {
      if (row.deletedAt != null) continue;
      if (!presentRel.has(row.path)) softDeleteProposalRecord(row.id, this.now());
    }

    return result;
  }

  private reconcileOne(
    ws: Workspace, dir: string, name: string, relPath: string, result: ReconcileResult,
  ): void {
    const absPath = joinNative(dir, name, ws.pathType);
    let st: fs.Stats;
    try { st = fs.statSync(absPath); } catch { return; }
    if (!st.isFile()) return;

    const existing = getProposalByWorkspacePath(ws.id, relPath);
    if (existing) {
      if (!isProposalArtifactId(existing.artifactId)) {
        result.diagnostics.push({
          kind: 'non-contract-artifact-id', workspaceId: ws.id, relPath,
          detail: `artifact_id ${existing.artifactId ?? '(missing)'} does not match prop_[0-9a-f]{8}; quarantined from further ingestion: ${relPath}`,
        });
        log(`non-contract artifact_id quarantined: ${relPath}`);
        return;
      }
      // Revive a soft-deleted row's timestamps only when live; otherwise touch fs fields.
      if (existing.deletedAt == null && (existing.mtimeMs !== st.mtimeMs || existing.sizeBytes !== st.size)) {
        const raw = readSmall(absPath);
        const fm = raw != null ? analyzeFrontmatter(raw) : { kind: 'absent' as const };
        const diskArtifactId = fm.kind === 'present' ? fm.fields.artifact_id : undefined;
        if (!isProposalArtifactId(diskArtifactId)) {
          result.diagnostics.push({
            kind: 'non-contract-artifact-id', workspaceId: ws.id, relPath,
            detail: `on-disk artifact_id ${diskArtifactId ?? '(missing)'} does not match prop_[0-9a-f]{8}; changed proposal quarantined without updating its registered row: ${relPath}`,
          });
          log(`changed proposal has non-contract artifact_id; quarantined: ${relPath}`);
          return;
        }
        if (diskArtifactId !== existing.artifactId) {
          result.diagnostics.push({
            kind: 'duplicate-artifact-id', workspaceId: ws.id, relPath,
            detail: `on-disk artifact_id changed from registered ${existing.artifactId} to ${diskArtifactId}; quarantined without rebinding: ${relPath}`,
          });
          log(`proposal artifact_id change quarantined: ${relPath}`);
          return;
        }
        const title = (fm.kind === 'present' && fm.fields.title) || existing.title;
        touchProposalRecord(existing.id, {
          title, mtimeMs: st.mtimeMs, sizeBytes: st.size, updatedAt: this.now(),
        });
      }
      return;
    }

    // ── New file: read + analyze frontmatter ──
    const raw = readSmall(absPath);
    if (raw == null) { log(`unreadable proposal skipped: ${relPath}`); return; }
    let fm = analyzeFrontmatter(raw);
    if (fm.kind === 'malformed') {
      result.diagnostics.push({
        kind: 'malformed-frontmatter', workspaceId: ws.id, relPath,
        detail: `leading --- frontmatter block is unterminated; quarantined (not registered, not rewritten): ${relPath}`,
      });
      log(`malformed frontmatter quarantined: ${relPath}`);
      return;
    }

    // ── artifact_id: adopt when present, else mint + safely insert ──
    let artifactId: string | null =
      fm.kind === 'present' && fm.fields.artifact_id ? fm.fields.artifact_id : null;
    if (!artifactId) {
      const minted = mintArtifactId();
      const patched = insertArtifactId(raw, minted);
      if (patched === null) {
        // Became malformed between analyze and insert — quarantine rather than guess.
        result.diagnostics.push({
          kind: 'malformed-frontmatter', workspaceId: ws.id, relPath,
          detail: `could not safely insert artifact_id; quarantined: ${relPath}`,
        });
        return;
      }
      if (ws.pathType === 'windows' && patched !== raw) {
        try { fs.writeFileSync(absPath, patched, 'utf8'); }
        catch (err) { log(`artifact_id write failed for ${relPath}`, err); }
      }
      artifactId = minted;
      // Re-read the on-disk fields off the patched content for title/authored_at.
      fm = analyzeFrontmatter(patched);
    }

    if (!isProposalArtifactId(artifactId)) {
      result.diagnostics.push({
        kind: 'non-contract-artifact-id', workspaceId: ws.id, relPath,
        detail: `artifact_id ${artifactId} does not match prop_[0-9a-f]{8}; quarantined (not registered, not rewritten): ${relPath}`,
      });
      log(`non-contract artifact_id quarantined: ${relPath}`);
      return;
    }

    // ── Duplicate policy: leave unregistered + both-paths diagnostic ──
    const canonical = getProposalByWorkspaceArtifactId(ws.id, artifactId);
    if (canonical && canonical.path !== relPath) {
      result.diagnostics.push({
        kind: 'duplicate-artifact-id', workspaceId: ws.id, relPath, otherRelPath: canonical.path,
        detail: `artifact_id ${artifactId} already registered to ${canonical.path}; left ${relPath} unregistered (canonical row not rebound)`,
      });
      log(`duplicate artifact_id ${artifactId}: ${relPath} vs ${canonical.path}`);
      return;
    }

    const fields = fm.kind === 'present' ? fm.fields : {};
    const author = resolveAuthor(ws, absPath);
    const nowMs = this.now();
    const slug = name.replace(/\.md$/i, '');
    const record: ProposalRecord = {
      id: crypto.randomUUID(),
      artifactId,
      workspaceId: ws.id,
      path: relPath,
      slug,
      title: fields.title || slug,
      state: 'proposal',
      authorAgentId: author.authorAgentId,
      authorRole: author.authorRole,
      authorDisplay: author.authorDisplay,
      authoredAt: parseAuthoredAt(fields.authored_at),
      createdAt: nowMs,
      updatedAt: nowMs,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      promotedToPlanId: null,
      deletedAt: null,
    };
    try {
      insertProposalRecord(record);
      result.registered.push(record);
    } catch (err) {
      // A concurrent writer may have raced us to the same (path|artifact_id).
      log(`insert failed for ${relPath}`, err);
    }
  }
}

const READ_CAP_BYTES = 2_000_000;

/** Read a small text file, or null on any error / oversize. */
function readSmall(absPath: string): string | null {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > READ_CAP_BYTES) return null;
    return fs.readFileSync(absPath, 'utf8');
  } catch { return null; }
}

export function startProposalsWatcher(opts?: ProposalsWatcherOptions): ProposalsWatcher {
  const w = new ProposalsWatcher(opts);
  w.start();
  return w;
}
