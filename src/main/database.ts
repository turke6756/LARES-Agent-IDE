import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { Agent, AgentProvider, AgentStatus, AgentTemplate, CreateAgentTemplateInput, CreateSelectionCommentInput, CreateWorkspaceInput, CreateTeamInput, FileActivity, FileOperation, SelectionComment, SelectionCommentStatus, Team, TeamChannel, TeamMember, TeamMessage, TeamMessageStatus, TeamStatus, TeamTask, TeamTaskStatus, UpdateSelectionCommentInput, Workspace } from '../shared/types';
import { DEFAULT_COMMAND, DEFAULT_COMMAND_WSL, SUPERVISOR_AGENT_MD } from '../shared/constants';
import { OrchestrationEvent, OrchestrationRun } from './orchestration/types';

let db: Database.Database;
let dbPath: string;

function getDbPath(): string {
  const appData = process.env.APPDATA || path.join(process.env.HOME || '', '.config');
  const dir = path.join(appData, 'AgentDashboard');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'dashboard.db');
}

export function initDatabase(): void {
  dbPath = getDbPath();
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id              TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      path            TEXT NOT NULL,
      path_type       TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      default_command TEXT NOT NULL DEFAULT '${DEFAULT_COMMAND}',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      last_opened_at  TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id                    TEXT PRIMARY KEY,
      workspace_id          TEXT NOT NULL,
      title                 TEXT NOT NULL,
      slug                  TEXT NOT NULL,
      role_description      TEXT NOT NULL DEFAULT '',
      working_directory     TEXT NOT NULL,
      command               TEXT NOT NULL,
      tmux_session_name     TEXT,
      auto_restart_enabled  INTEGER NOT NULL DEFAULT 1,
      resume_session_id     TEXT,
      status                TEXT NOT NULL DEFAULT 'launching',
      is_attached           INTEGER NOT NULL DEFAULT 0,
      restart_count         INTEGER NOT NULL DEFAULT 0,
      last_exit_code        INTEGER,
      pid                   INTEGER,
      log_path              TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      last_output_at        TEXT,
      last_attached_at      TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS file_activities (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      operation   TEXT NOT NULL,
      timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migration: add sort_order column for manual workspace ordering (drag to
  // reorder in the sidebar). Backfill NULLs in the legacy display order
  // (last_opened_at DESC) so the migration doesn't visibly reshuffle the list.
  try { db.exec(`ALTER TABLE workspaces ADD COLUMN sort_order INTEGER`); } catch { /* column already exists */ }
  const unsorted = db.prepare(
    `SELECT id FROM workspaces WHERE sort_order IS NULL ORDER BY last_opened_at DESC, created_at DESC`
  ).all() as { id: string }[];
  if (unsorted.length > 0) {
    const maxRow = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS max FROM workspaces`).get() as { max: number };
    const setOrder = db.prepare(`UPDATE workspaces SET sort_order = ? WHERE id = ?`);
    unsorted.forEach((row, i) => setOrder.run(maxRow.max + 1 + i, row.id));
  }

  // Migration: add provider column to existing agents tables
  try { db.exec(`ALTER TABLE agents ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`); } catch { /* column already exists */ }

  // Migration: add is_supervisor column
  try { db.exec(`ALTER TABLE agents ADD COLUMN is_supervisor INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }

  // Migration: add is_supervised column (opt-in for supervisor event bridge)
  try { db.exec(`ALTER TABLE agents ADD COLUMN is_supervised INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }

  // Migration: add is_worker column (hook-based status lane — launches from
  // .dashboard/workers/<provider>/, disables PTY + chat-event inference; does
  // NOT notify a supervisor). Orthogonal to is_supervised; see Agent.isWorker.
  try { db.exec(`ALTER TABLE agents ADD COLUMN is_worker INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }

  // Migration: add is_researcher column (browser-parity-and-capability-isolation
  // §0, D-1) — the researcher role-lane: scaffolded into .dashboard/researcher,
  // browser MCP only, native dangerous tools withheld. Mutually exclusive with
  // the other lane flags; see Agent.isResearcher.
  try { db.exec(`ALTER TABLE agents ADD COLUMN is_researcher INTEGER DEFAULT 0`); } catch { /* column already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      payload     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ── Team tables ─────────────────────────────────────────────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      template        TEXT,
      status          TEXT NOT NULL DEFAULT 'active',
      manifest        TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      disbanded_at    TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS team_members (
      team_id     TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'member',
      joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team_id, agent_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS team_channels (
      id          TEXT PRIMARY KEY,
      team_id     TEXT NOT NULL,
      from_agent  TEXT NOT NULL,
      to_agent    TEXT NOT NULL,
      label       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(team_id, from_agent, to_agent)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS team_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id       TEXT NOT NULL,
      from_agent    TEXT NOT NULL,
      to_agent      TEXT NOT NULL,
      subject       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'update',
      summary       TEXT NOT NULL,
      detail        TEXT,
      need          TEXT,
      delivered_at  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS team_tasks (
      id            TEXT PRIMARY KEY,
      team_id       TEXT NOT NULL,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT 'todo',
      assigned_to   TEXT,
      blocked_by    TEXT NOT NULL DEFAULT '[]',
      created_by    TEXT NOT NULL,
      notes         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ── Orchestration tables ──────────────────────────────────────────────
  // Dashboard-owned orchestration runs (e.g. groupthink). Persisted so runs
  // survive a dashboard restart (boot reconcile marks orphans aborted) and so
  // run history is a first-class observability surface.

  db.exec(`
    CREATE TABLE IF NOT EXISTS orchestrations (
      run_id            TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      mode              TEXT NOT NULL,
      status            TEXT NOT NULL,
      workspace_id      TEXT NOT NULL,
      supervisor_id     TEXT NOT NULL,
      topic             TEXT,
      plan_path         TEXT,
      lead_provider     TEXT,
      reviewer_provider TEXT,
      turn_timeout_ms   INTEGER,
      lead_id           TEXT,
      reviewer_id       TEXT,
      turn              INTEGER,
      round             INTEGER,
      last_relayed_ts   TEXT,            -- JSON
      started_at        TEXT,
      updated_at        TEXT,
      ended_at          TEXT,
      error             TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS orchestration_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id      TEXT NOT NULL,
      ts          TEXT NOT NULL,
      kind        TEXT NOT NULL,
      payload     TEXT                   -- JSON
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS orchestration_members (
      run_id      TEXT NOT NULL,
      role        TEXT NOT NULL,         -- 'lead' | 'reviewer'
      agent_id    TEXT NOT NULL,
      PRIMARY KEY (run_id, role)
    )
  `);

  // ── Embedded-browser tables (overhaul WP3/WP4) ─────────────────────────
  // Bookmarks + history persistence for the embedded browser. USER-PARTITION
  // ONLY — the browser manager enforces the partition gate; these tables never
  // receive agent-partition URLs (persistence half of the M9 discipline). The
  // thin services live in src/main/browser/{bookmarks,history}-store.ts; they
  // reach the singleton handle via getDb(). Times are epoch-ms integers
  // (Date.now()), unlike the team/agent tables' datetime('now') text columns,
  // because the renderer-facing Bookmark/HistoryEntry contracts use numbers.

  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_bookmarks (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      url         TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      sort_order  INTEGER NOT NULL
    )
  `);
  // Slice-7 (premium browser) — bookmarks become a real manager: cache the
  // active USER tab's favicon at add time, support ONE level of folders, and
  // track an edit timestamp. Additive nullable columns via the house guarded
  // ALTER idiom (try/catch = idempotent; legacy rows read NULL = top-level,
  // no favicon, never edited).
  try { db.exec(`ALTER TABLE browser_bookmarks ADD COLUMN favicon TEXT`); } catch { /* column already exists */ }
  try { db.exec(`ALTER TABLE browser_bookmarks ADD COLUMN folder TEXT`); } catch { /* column already exists */ }
  try { db.exec(`ALTER TABLE browser_bookmarks ADD COLUMN updated_at INTEGER`); } catch { /* column already exists */ }

  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_history (
      id           TEXT PRIMARY KEY,
      url          TEXT NOT NULL,
      title        TEXT,
      visited_at   INTEGER NOT NULL,
      visit_count  INTEGER NOT NULL DEFAULT 1
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_history_visited
      ON browser_history(visited_at DESC)
  `);
  // Slice-8 (premium browser) — history upgrade. Cache the visited page's
  // favicon (USER-PARTITION ONLY by construction; agent navigations never reach
  // this table) via the house guarded-ALTER idiom (legacy rows read NULL).
  try { db.exec(`ALTER TABLE browser_history ADD COLUMN favicon TEXT`); } catch { /* column already exists */ }
  // Top-sites (visit_count DESC, visited_at DESC) drives the NTP (Slice-9) and
  // the omnibox frequency rank; index the leading frequency key.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_history_visit_count
      ON browser_history(visit_count DESC, visited_at DESC)
  `);
  // Title/URL search (listHistory + omnibox LIKE) — substring LIKE can't use a
  // plain B-tree, so back it with a small case-insensitive FTS-free index pair
  // that at least covers ordered prefix scans and keeps the planner honest.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_history_title
      ON browser_history(title)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_history_url
      ON browser_history(url)
  `);

  // ── Slice 10/11: session restore + frozen/discarded tab model ──────────────
  // browser_session persists the OPEN user-partition tabs (live + frozen) so a
  // restart re-materializes them as frozen snapshots (lazy WebContentsView on
  // first activation). browser_closed_tabs is the persistent reopen stack
  // (Ctrl+Shift+T), capped 25 per workspace, FIFO. USER-PARTITION ONLY — the
  // `partition` CHECK pins each row to 'user' so an agent row is a hard DB error,
  // defense-in-depth atop the manager-side gate (cross-cutting rule #1). The thin
  // service lives in src/main/browser/session-store.ts (getDb()). Times epoch-ms.
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_session (
      tab_id       TEXT PRIMARY KEY,
      workspace_id TEXT,                                   -- nullable; matches tab.workspaceId
      url          TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      favicon      TEXT,
      partition    TEXT NOT NULL DEFAULT 'user' CHECK (partition IN ('user')),  -- USER ONLY
      pinned       INTEGER NOT NULL DEFAULT 0,
      sort_order   INTEGER NOT NULL,                       -- dense display order AFTER pinned-left normalization
      group_id     TEXT,                                   -- DB-reserved passthrough (composes w/ tab-groups track)
      active       INTEGER NOT NULL DEFAULT 0,             -- writer-enforced <=1 (the activeTabId's row); restore hint
      scroll_y     INTEGER,                                -- nullable best-effort scroll restore
      updated_at   INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_closed_tabs (
      id           TEXT PRIMARY KEY,                       -- uuid of this closed-tab record
      workspace_id TEXT,
      url          TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      favicon      TEXT,
      partition    TEXT NOT NULL DEFAULT 'user' CHECK (partition IN ('user')),  -- USER ONLY
      group_id     TEXT,
      closed_at    INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_closed_tabs_ws
      ON browser_closed_tabs(workspace_id, closed_at DESC)
  `);

  // ── Website-access policy tables (plans/website-allowlist-simplification.md) ─
  // ONE human-curated agent allowlist for the embedded browser. Stored in the
  // dashboard DB (userData, outside the workspace) so the agent's file tools can
  // never reach them — a prompt-injected agent cannot widen its own allowlist.
  // Enforcement is keyed SOLELY to the Agent Actions toggle (no per-list mode).
  // The legacy two-valued `list` column is retained (NOT NULL) and pinned to
  // 'agent' by the store; the browser_access_modes table is LEGACY and unused
  // (no code reads it). Times are epoch-ms.

  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_access_rules (
      id                 TEXT PRIMARY KEY,
      list               TEXT NOT NULL CHECK (list IN ('agent','human')),
      hostname           TEXT NOT NULL,              -- normalized via new URL().hostname
      include_subdomains INTEGER NOT NULL DEFAULT 1,
      scheme             TEXT NOT NULL DEFAULT 'https' CHECK (scheme IN ('https','http','any')),
      path_prefix        TEXT,                       -- optional; starts with '/'; NULL = whole host
      note               TEXT,
      allow_signed_in    INTEGER NOT NULL DEFAULT 0, -- §13: per-row "allow while signed in" (List-A only)
      enabled            INTEGER NOT NULL DEFAULT 1,
      created_at         INTEGER NOT NULL
    )
  `);
  // §13 additive migration for installs created before allow_signed_in existed
  // (house try/catch ALTER idiom — no PRAGMA/version table; see siblings below).
  try {
    db.exec(`ALTER TABLE browser_access_rules ADD COLUMN allow_signed_in INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column already exists */ }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_access_rules_list
      ON browser_access_rules(list, enabled)
  `);

  // LEGACY (website-allowlist-simplification): the per-list off/enforce mode was
  // removed — enforcement is now keyed solely to the Agent Actions toggle. The
  // table is left in place for old installs but NO code reads or writes it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_access_modes (
      list       TEXT PRIMARY KEY CHECK (list IN ('agent','human')),
      mode       TEXT NOT NULL CHECK (mode IN ('off','enforce')),
      updated_at INTEGER NOT NULL
    )
  `);

  // §13: per-rule authenticated origins (for revocation breadth — origin-scoped
  // storage cannot be wildcard-cleared, so the authenticated origins are tracked).
  // Survives restart (the cookies do); rows deleted when the rule is deleted.
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_access_signed_in_origins (
      rule_id TEXT NOT NULL,
      origin  TEXT NOT NULL,
      PRIMARY KEY (rule_id, origin)
    )
  `);

  // §18.2: agent-initiated access requests. INERT — a pending request grants
  // ZERO access; only a human approval creates a real browser_access_rules row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_access_requests (
      id                 TEXT PRIMARY KEY,
      list               TEXT NOT NULL DEFAULT 'agent' CHECK (list IN ('agent')),
      hostname           TEXT NOT NULL,              -- normalized, server-side
      include_subdomains INTEGER NOT NULL DEFAULT 1,
      scheme             TEXT NOT NULL DEFAULT 'https' CHECK (scheme IN ('https','http','any')),
      path_prefix        TEXT,
      want_signed_in     INTEGER NOT NULL DEFAULT 0,
      requested_by       TEXT NOT NULL,              -- agent id
      requested_by_title TEXT,                       -- agent title at request time (display)
      reason             TEXT,                       -- UNTRUSTED free text; render escaped
      status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
      created_at         INTEGER NOT NULL,
      decided_at         INTEGER
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_access_requests_status
      ON browser_access_requests(status, created_at)
  `);

  // Slice-4 (premium browser — workspace-scoped agent partitions): nullable
  // workspace_id on each access table so rules / requests / signed-in origins are
  // scoped to the workspace whose agent partition they govern. NULL = legacy
  // default (back-compat): a NULL-workspace row applies to every workspace, so
  // installs created before this column keep working unchanged. Guarded
  // try/catch ALTER (the house idiom — see the allow_signed_in sibling above).
  try {
    db.exec(`ALTER TABLE browser_access_rules ADD COLUMN workspace_id TEXT`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE browser_access_requests ADD COLUMN workspace_id TEXT`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE browser_access_signed_in_origins ADD COLUMN workspace_id TEXT`);
  } catch { /* column already exists */ }

  // Slice 12 (handoff/session center): per signed-in origin session-age fields.
  // signed_in_at = first/most-recent successful handoff-ready commit; last_used_at
  // = last time an agent drove the authenticated origin; verified_at = optional
  // last explicit re-verification. All nullable (legacy rows null). Guarded
  // try/catch ALTER (house idiom).
  try {
    db.exec(`ALTER TABLE browser_access_signed_in_origins ADD COLUMN signed_in_at INTEGER`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE browser_access_signed_in_origins ADD COLUMN last_used_at INTEGER`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE browser_access_signed_in_origins ADD COLUMN verified_at INTEGER`);
  } catch { /* column already exists */ }

  // ── Selection comments table ──────────────────────────────────────────
  // WP-P5 — persisted file-target selection comments. Schema recorded in
  // plans/selection-to-agent-primitive-plan.md §5; copied exactly. No generic
  // target_id column by design; chat/note columns are added by ALTER TABLE if
  // and when those targets are ever built. SQLite's updated_at default is
  // insert-only — every update helper below maintains it explicitly.

  db.exec(`
    CREATE TABLE IF NOT EXISTS selection_comments (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('file','chat-message','note')),
      -- file target columns (the only target implemented; chat/note columns are added by
      -- ALTER TABLE if and when those targets are ever built — do not pre-create them)
      file_path TEXT,
      path_type TEXT,
      root_directory TEXT,
      doc_hash TEXT,
      anchor_start INTEGER,
      anchor_end INTEGER,
      line_start INTEGER,
      line_end INTEGER,
      prefix TEXT,
      suffix TEXT,
      -- generic
      quoted_text TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN
        ('draft','queued','sent','send_failed','needs-review','resolved','orphaned')),
      sent_to_agent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT,
      resolved_at TEXT
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_selcomments_ws_file
      ON selection_comments (workspace_id, file_path, status)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_selcomments_agent
      ON selection_comments (sent_to_agent_id)
  `);

  // Additive migration for installs predating the highlight feature (house
  // try/catch ALTER idiom — see the browser_access_rules sibling above). A
  // row is a comment unless explicitly a 'highlight'.
  try {
    db.exec(`ALTER TABLE selection_comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment'`);
  } catch { /* column already exists */ }

  // ── Agent templates table ────────────────────────────────────────────

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_templates (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT,
      name              TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      system_prompt     TEXT,
      role_description  TEXT NOT NULL DEFAULT '',
      provider          TEXT NOT NULL DEFAULT 'claude',
      command           TEXT,
      auto_restart      INTEGER NOT NULL DEFAULT 1,
      is_supervisor     INTEGER NOT NULL DEFAULT 0,
      is_supervised     INTEGER NOT NULL DEFAULT 1,
      is_worker         INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migration: add template_id and system_prompt to agents
  try { db.exec(`ALTER TABLE agents ADD COLUMN template_id TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN system_prompt TEXT`); } catch { /* exists */ }
  // Migration: add hook-scaffold health columns (HOOK_SYSTEM_DESIGN.md §5.4).
  // hook_status defaults to 'unknown' until the launch canary or a hook event
  // resolves it; last_hook_event_at is the wall-clock ms of the last hook POST.
  try { db.exec(`ALTER TABLE agents ADD COLUMN hook_status TEXT NOT NULL DEFAULT 'unknown'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN last_hook_event_at INTEGER`); } catch { /* exists */ }
  // Migration: C1 synchronous-submit-confirmation failure surface
  // (plans/global-hook-rollout-and-submit-confirmation.md §3.1). JSON blob
  // `{message,ts}` or NULL; set when confirm-and-retry exhausts, cleared on a
  // confirmed submit. Read projection only — never gates status.
  try { db.exec(`ALTER TABLE agents ADD COLUMN last_send_error TEXT`); } catch { /* exists */ }
  // Migration: add is_worker to agent_templates (default 1 — worker is the
  // default lane for user-launched claude/codex agents).
  try { db.exec(`ALTER TABLE agent_templates ADD COLUMN is_worker INTEGER NOT NULL DEFAULT 1`); } catch { /* exists */ }

  // Seed built-in supervisor template if not present
  const existingSup = queryAll("SELECT id FROM agent_templates WHERE id = 'builtin-supervisor'");
  if (existingSup.length === 0) {
    db.prepare(
      `INSERT INTO agent_templates (id, workspace_id, name, description, system_prompt, role_description, provider, is_supervisor, is_supervised, is_worker, auto_restart)
       VALUES (?, NULL, ?, ?, ?, ?, 'claude', 1, 0, 0, 1)`
    ).run(
      'builtin-supervisor',
      'Supervisor',
      'Coordinates worker agents, approves continuations, manages context.',
      SUPERVISOR_AGENT_MD,
      'Autonomous supervisor agent — coordinates workers, approves continuations, manages context.'
    );
  }

  // Phase 4a cleanup: purge file_activities rows where the legacy PTY-based tracker
  // captured codex/gemini TUI output as a comma-separated "file_path" string.
  // Naturally idempotent — the tracker is now gated to claude-only, so re-running
  // this delete is a no-op once the bad rows are cleared.
  try {
    db.exec(`
      DELETE FROM file_activities
      WHERE file_path LIKE '%, %'
        AND agent_id IN (SELECT id FROM agents WHERE provider <> 'claude')
    `);
  } catch (err) {
    console.warn('[database] phase-4a file_activities purge failed:', err);
  }

  // Cleanup for Claude/Codex/Gemini aggregate context summaries that are not
  // files, e.g. "3 files, listed 1 directory" or "1 file, recalled 2 memories".
  try {
    db.exec(`
      DELETE FROM file_activities
      WHERE lower(file_path) LIKE '%listed % director%'
         OR lower(file_path) LIKE '%recalled % memor%'
    `);
  } catch (err) {
    console.warn('[database] aggregate file_activities purge failed:', err);
  }
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 30);
}

function rowToWorkspace(row: any): Workspace {
  return {
    id: row.id,
    title: row.title,
    path: row.path,
    pathType: row.path_type,
    description: row.description,
    defaultCommand: row.default_command,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
  };
}

/** C1 — decode the `last_send_error` JSON blob into the typed Agent field.
 *  Tolerates legacy/garbage values by returning null (never throws on read). */
function parseLastSendError(raw: unknown): Agent['lastSendError'] {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.message === 'string' && typeof parsed.ts === 'number') {
      return { message: parsed.message, ts: parsed.ts };
    }
  } catch { /* fall through */ }
  return null;
}

function rowToAgent(row: any): Agent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    slug: row.slug,
    roleDescription: row.role_description,
    workingDirectory: row.working_directory,
    command: row.command,
    provider: (row.provider || 'claude') as AgentProvider,
    isSupervisor: !!row.is_supervisor,
    isSupervised: !!row.is_supervised,
    isWorker: !!row.is_worker,
    isResearcher: !!row.is_researcher,
    tmuxSessionName: row.tmux_session_name,
    autoRestartEnabled: !!row.auto_restart_enabled,
    resumeSessionId: row.resume_session_id,
    status: row.status as AgentStatus,
    hookStatus: (row.hook_status || 'unknown') as Agent['hookStatus'],
    lastHookEventAt: row.last_hook_event_at ?? undefined,
    lastSendError: parseLastSendError(row.last_send_error),
    isAttached: !!row.is_attached,
    restartCount: row.restart_count,
    lastExitCode: row.last_exit_code,
    pid: row.pid,
    logPath: row.log_path,
    templateId: row.template_id || null,
    systemPrompt: row.system_prompt || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOutputAt: row.last_output_at,
    lastAttachedAt: row.last_attached_at,
  };
}

/** Accessor for the process-wide better-sqlite3 handle. Used by sibling main
 *  modules (e.g. the embedded-browser bookmarks/history stores) that own their
 *  own prepared statements but must share the one initialized connection.
 *  Throws if called before initDatabase() — a programming error, not a runtime
 *  condition to handle. */
export function getDb(): Database.Database {
  if (!db) throw new Error('getDb() called before initDatabase()');
  return db;
}

function queryAll(sql: string, params: any[] = []): any[] {
  return db.prepare(sql).all(...params) as any[];
}

function queryOne(sql: string, params: any[] = []): any | null {
  return (db.prepare(sql).get(...params) as any) ?? null;
}

function run(sql: string, params: any[] = []): void {
  db.prepare(sql).run(...params);
}

// Workspace operations
export function createWorkspace(input: CreateWorkspaceInput): Workspace {
  const id = uuidv4();
  run(
    `INSERT INTO workspaces (id, title, path, path_type, description, default_command, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM workspaces))`,
    [id, input.title, input.path, input.pathType, input.description || '', input.defaultCommand || (input.pathType === 'wsl' ? DEFAULT_COMMAND_WSL : DEFAULT_COMMAND)]
  );
  return getWorkspace(id)!;
}

export function getWorkspace(id: string): Workspace | null {
  const row = queryOne('SELECT * FROM workspaces WHERE id = ?', [id]);
  return row ? rowToWorkspace(row) : null;
}

export function getWorkspaces(): Workspace[] {
  // Manual order (drag to reorder in the sidebar); NULL sort_order sorts last
  // as a safety net — initDatabase backfills it, so NULLs shouldn't persist.
  return queryAll(
    'SELECT * FROM workspaces ORDER BY (sort_order IS NULL), sort_order ASC, last_opened_at DESC, created_at DESC'
  ).map(rowToWorkspace);
}

/** Persist a full manual ordering: ids[i] gets sort_order = i. */
export function reorderWorkspaces(ids: string[]): void {
  const setOrder = db.prepare(`UPDATE workspaces SET sort_order = ? WHERE id = ?`);
  const tx = db.transaction((ordered: string[]) => {
    ordered.forEach((id, i) => setOrder.run(i, id));
  });
  tx(ids);
}

export function deleteWorkspace(id: string): void {
  run('DELETE FROM agents WHERE workspace_id = ?', [id]);
  run('DELETE FROM workspaces WHERE id = ?', [id]);
}

export function touchWorkspace(id: string): void {
  run("UPDATE workspaces SET last_opened_at = datetime('now') WHERE id = ?", [id]);
}

// Agent operations
export function createAgent(data: {
  workspaceId: string;
  title: string;
  roleDescription: string;
  workingDirectory: string;
  command: string;
  provider?: AgentProvider;
  isSupervisor?: boolean;
  isSupervised?: boolean;
  isWorker?: boolean;
  isResearcher?: boolean;
  tmuxSessionName: string | null;
  autoRestartEnabled: boolean;
  logPath: string;
  templateId?: string | null;
  systemPrompt?: string | null;
}): Agent {
  const id = uuidv4();
  const slug = slugify(data.title);
  run(
    `INSERT INTO agents (id, workspace_id, title, slug, role_description, working_directory,
      command, provider, is_supervisor, is_supervised, is_worker, is_researcher, tmux_session_name, auto_restart_enabled, log_path, template_id, system_prompt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, data.workspaceId, data.title, slug, data.roleDescription, data.workingDirectory,
      data.command, data.provider || 'claude', data.isSupervisor ? 1 : 0, data.isSupervised ? 1 : 0, data.isWorker ? 1 : 0, data.isResearcher ? 1 : 0, data.tmuxSessionName, data.autoRestartEnabled ? 1 : 0, data.logPath,
      data.templateId || null, data.systemPrompt || null]
  );
  return getAgent(id)!;
}

export function getAgent(id: string): Agent | null {
  const row = queryOne('SELECT * FROM agents WHERE id = ?', [id]);
  return row ? rowToAgent(row) : null;
}

export function getAgentsByWorkspace(workspaceId: string): Agent[] {
  return queryAll('SELECT * FROM agents WHERE workspace_id = ? ORDER BY created_at ASC', [workspaceId]).map(rowToAgent);
}

export function getAllAgents(): Agent[] {
  return queryAll('SELECT * FROM agents ORDER BY created_at ASC').map(rowToAgent);
}

export function getSupervisorAgent(workspaceId: string): Agent | null {
  const row = queryOne('SELECT * FROM agents WHERE workspace_id = ? AND is_supervisor = 1 ORDER BY created_at DESC LIMIT 1', [workspaceId]);
  return row ? rowToAgent(row) : null;
}

export function getActiveAgents(): Agent[] {
  return queryAll(
    "SELECT * FROM agents WHERE status NOT IN ('done', 'crashed') ORDER BY created_at DESC"
  ).map(rowToAgent);
}

export function updateAgentStatus(id: string, status: AgentStatus): void {
  run("UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, id]);
}

/** HOOK_SYSTEM_DESIGN.md §5.4 — set the hook-scaffold health field. When a hook
 *  event arrives, callers pass `lastHookEventAt` to also stamp the timestamp;
 *  the launch canary / B2 degrade path omit it (no event occurred). */
export function updateAgentHookStatus(
  id: string,
  hookStatus: NonNullable<Agent['hookStatus']>,
  lastHookEventAt?: number,
): void {
  if (lastHookEventAt !== undefined) {
    run(
      "UPDATE agents SET hook_status = ?, last_hook_event_at = ?, updated_at = datetime('now') WHERE id = ?",
      [hookStatus, lastHookEventAt, id],
    );
  } else {
    run(
      "UPDATE agents SET hook_status = ?, updated_at = datetime('now') WHERE id = ?",
      [hookStatus, id],
    );
  }
}

/** C1 — set or clear the synchronous-submit-confirmation failure surface.
 *  Pass `null` to clear it (on a confirmed submit); pass `{message,ts}` when
 *  confirm-and-retry exhausts. Mirrors the `updateAgentHookStatus` pattern. */
export function updateAgentLastSendError(
  id: string,
  err: { message: string; ts: number } | null,
): void {
  run(
    "UPDATE agents SET last_send_error = ?, updated_at = datetime('now') WHERE id = ?",
    [err ? JSON.stringify(err) : null, id],
  );
}

export function updateAgentPid(id: string, pid: number | null): void {
  run("UPDATE agents SET pid = ?, updated_at = datetime('now') WHERE id = ?", [pid, id]);
}

export function updateAgentAttached(id: string, attached: boolean): void {
  run(
    "UPDATE agents SET is_attached = ?, last_attached_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    [attached ? 1 : 0, id]
  );
}

export function updateAgentExitCode(id: string, code: number): void {
  run("UPDATE agents SET last_exit_code = ?, updated_at = datetime('now') WHERE id = ?", [code, id]);
}

export function incrementRestartCount(id: string): void {
  run("UPDATE agents SET restart_count = restart_count + 1, updated_at = datetime('now') WHERE id = ?", [id]);
}

export function updateAgentLastOutput(id: string): void {
  run("UPDATE agents SET last_output_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [id]);
}

export function updateAgentResumeSessionId(id: string, sessionId: string): void {
  run("UPDATE agents SET resume_session_id = ?, updated_at = datetime('now') WHERE id = ?", [sessionId, id]);
}

export function updateAgentSupervised(id: string, supervised: boolean): void {
  run("UPDATE agents SET is_supervised = ?, updated_at = datetime('now') WHERE id = ?", [supervised ? 1 : 0, id]);
}

export function addEvent(agentId: string, eventType: string, payload?: string): void {
  run('INSERT INTO events (agent_id, event_type, payload) VALUES (?, ?, ?)', [agentId, eventType, payload || null]);
}

// Agent template operations

function rowToAgentTemplate(row: any): AgentTemplate {
  return {
    id: row.id,
    workspaceId: row.workspace_id || null,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt || null,
    roleDescription: row.role_description,
    provider: (row.provider || 'claude') as AgentProvider,
    command: row.command || null,
    autoRestart: !!row.auto_restart,
    isSupervisor: !!row.is_supervisor,
    isSupervised: !!row.is_supervised,
    isWorker: !!row.is_worker,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createAgentTemplate(input: CreateAgentTemplateInput): AgentTemplate {
  const id = uuidv4();
  run(
    `INSERT INTO agent_templates (id, workspace_id, name, description, system_prompt, role_description, provider, command, auto_restart, is_supervisor, is_supervised, is_worker)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.workspaceId || null, input.name, input.description || '', input.systemPrompt || null,
     input.roleDescription || '', input.provider || 'claude', input.command || null,
     input.autoRestart !== false ? 1 : 0, input.isSupervisor ? 1 : 0, input.isSupervised !== false ? 1 : 0,
     input.isWorker !== false ? 1 : 0]
  );
  return getAgentTemplate(id)!;
}

export function getAgentTemplate(id: string): AgentTemplate | null {
  const row = queryOne('SELECT * FROM agent_templates WHERE id = ?', [id]);
  return row ? rowToAgentTemplate(row) : null;
}

export function listAgentTemplates(workspaceId?: string): AgentTemplate[] {
  if (workspaceId) {
    return queryAll(
      'SELECT * FROM agent_templates WHERE workspace_id = ? OR workspace_id IS NULL ORDER BY name',
      [workspaceId]
    ).map(rowToAgentTemplate);
  }
  return queryAll('SELECT * FROM agent_templates ORDER BY name').map(rowToAgentTemplate);
}

export function updateAgentTemplate(id: string, updates: Partial<CreateAgentTemplateInput>): AgentTemplate {
  const sets: string[] = [];
  const params: any[] = [];

  if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
  if (updates.systemPrompt !== undefined) { sets.push('system_prompt = ?'); params.push(updates.systemPrompt); }
  if (updates.roleDescription !== undefined) { sets.push('role_description = ?'); params.push(updates.roleDescription); }
  if (updates.provider !== undefined) { sets.push('provider = ?'); params.push(updates.provider); }
  if (updates.command !== undefined) { sets.push('command = ?'); params.push(updates.command); }
  if (updates.autoRestart !== undefined) { sets.push('auto_restart = ?'); params.push(updates.autoRestart ? 1 : 0); }
  if (updates.isSupervisor !== undefined) { sets.push('is_supervisor = ?'); params.push(updates.isSupervisor ? 1 : 0); }
  if (updates.isSupervised !== undefined) { sets.push('is_supervised = ?'); params.push(updates.isSupervised ? 1 : 0); }
  if (updates.isWorker !== undefined) { sets.push('is_worker = ?'); params.push(updates.isWorker ? 1 : 0); }
  if (updates.workspaceId !== undefined) { sets.push('workspace_id = ?'); params.push(updates.workspaceId); }

  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    params.push(id);
    run(`UPDATE agent_templates SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  return getAgentTemplate(id)!;
}

export function deleteAgentTemplate(id: string): void {
  run('DELETE FROM agent_templates WHERE id = ?', [id]);
}

// File activity operations
function rowToFileActivity(row: any): FileActivity {
  return {
    id: row.id,
    agentId: row.agent_id,
    filePath: row.file_path,
    operation: row.operation as FileOperation,
    timestamp: row.timestamp,
  };
}

export function addFileActivity(agentId: string, filePath: string, operation: FileOperation): FileActivity | null {
  // Dedup: skip if same (agent, file, operation) within last 5 seconds
  const recent = queryOne(
    `SELECT id FROM file_activities
     WHERE agent_id = ? AND file_path = ? AND operation = ?
     AND timestamp > datetime('now', '-5 seconds')`,
    [agentId, filePath, operation]
  );
  if (recent) return null;

  run(
    'INSERT INTO file_activities (agent_id, file_path, operation) VALUES (?, ?, ?)',
    [agentId, filePath, operation]
  );

  const row = queryOne(
    'SELECT * FROM file_activities WHERE agent_id = ? AND file_path = ? ORDER BY id DESC LIMIT 1',
    [agentId, filePath]
  );
  return row ? rowToFileActivity(row) : null;
}

export function getFileActivities(agentId: string, operation?: FileOperation): FileActivity[] {
  if (operation) {
    return queryAll(
      'SELECT * FROM file_activities WHERE agent_id = ? AND operation = ? ORDER BY timestamp DESC',
      [agentId, operation]
    ).map(rowToFileActivity);
  }
  return queryAll(
    'SELECT * FROM file_activities WHERE agent_id = ? ORDER BY timestamp DESC',
    [agentId]
  ).map(rowToFileActivity);
}

export function deleteAgent(id: string): void {
  run('DELETE FROM file_activities WHERE agent_id = ?', [id]);
  run('DELETE FROM events WHERE agent_id = ?', [id]);
  run('DELETE FROM agents WHERE id = ?', [id]);
}

/**
 * BUG-26 Layer 2: purge derived `file_activities` rows for an agent without
 * deleting the agent record. Called from the supervisor's `'agent-rebound'`
 * listener after `SessionLogDispatcher.rebindAgent`. The `file_activities`
 * table is INSERT-only at the producer side and does not self-heal, so
 * wrong rows inserted under the agent's id during the pre-binding window
 * (`session.sessionId === ''` + cwd-fallback misattribution) would
 * otherwise persist in every `Files touched:` event for the agent until
 * the agent is deleted. By definition an agent that needed a rebind had
 * at most pre-binding activity — any "real" pre-binding activity for
 * that agent came from the same misattribution leak — so wiping is correct.
 */
export function deleteFileActivitiesForAgent(agentId: string): void {
  run('DELETE FROM file_activities WHERE agent_id = ?', [agentId]);
}

export function checkAgentMdExists(workingDirectory: string, pathType: string): { found: boolean; fileName: string | null } {
  const candidates = ['agent.md', 'AGENT.md'];

  if (pathType === 'wsl') {
    const { execFileSync } = require('child_process');
    for (const name of candidates) {
      try {
        execFileSync('wsl.exe', ['bash', '-lc', `test -f '${workingDirectory}/${name}' && echo found`], {
          encoding: 'utf-8',
          timeout: 3000,
        });
        return { found: true, fileName: name };
      } catch {
        // not found
      }
    }
  } else {
    const path = require('path');
    const fs = require('fs');
    for (const name of candidates) {
      const fullPath = path.join(workingDirectory, name);
      if (fs.existsSync(fullPath)) {
        return { found: true, fileName: name };
      }
    }
  }
  return { found: false, fileName: null };
}

export function getWorkspaceAgentSummary(): { workspaceId: string; activeCount: number; workingCount: number }[] {
  return queryAll(`
    SELECT workspace_id,
      COUNT(*) as active_count,
      SUM(CASE WHEN status = 'working' THEN 1 ELSE 0 END) as working_count
    FROM agents
    WHERE status NOT IN ('done', 'crashed')
    GROUP BY workspace_id
  `).map(row => ({
    workspaceId: row.workspace_id,
    activeCount: row.active_count,
    workingCount: row.working_count,
  }));
}

// ── Team operations ───────────────────────────────────────────────────────

function rowToTeam(row: any): Team {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    template: row.template,
    status: row.status as TeamStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    disbandedAt: row.disbanded_at,
  };
}

function rowToTeamMember(row: any): TeamMember {
  return {
    teamId: row.team_id,
    agentId: row.agent_id,
    role: row.role,
    joinedAt: row.joined_at,
    // Enrichment fields (present when joined with agents table)
    title: row.title,
    provider: row.provider,
    status: row.agent_status,
  };
}

function rowToTeamChannel(row: any): TeamChannel {
  return {
    id: row.id,
    teamId: row.team_id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    label: row.label,
  };
}

function rowToTeamMessage(row: any): TeamMessage {
  return {
    id: row.id,
    teamId: row.team_id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    subject: row.subject,
    status: row.status as TeamMessageStatus,
    summary: row.summary,
    detail: row.detail,
    need: row.need,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    fromTitle: row.from_title,
    toTitle: row.to_title,
  };
}

function rowToTeamTask(row: any): TeamTask {
  return {
    id: row.id,
    teamId: row.team_id,
    title: row.title,
    description: row.description,
    status: row.status as TeamTaskStatus,
    assignedTo: row.assigned_to,
    blockedBy: JSON.parse(row.blocked_by || '[]'),
    createdBy: row.created_by,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createTeam(input: CreateTeamInput): Team {
  const id = uuidv4();
  run(
    `INSERT INTO teams (id, workspace_id, name, description, template) VALUES (?, ?, ?, ?, ?)`,
    [id, input.workspaceId, input.name, input.description || '', input.template || null]
  );

  // Add members
  for (const m of input.members) {
    run('INSERT INTO team_members (team_id, agent_id, role) VALUES (?, ?, ?)',
      [id, m.agentId, m.role || 'member']);
  }

  // Generate channels based on template
  if (input.template === 'mesh') {
    // All-to-all: every member can message every other member
    for (const a of input.members) {
      for (const b of input.members) {
        if (a.agentId !== b.agentId) {
          run('INSERT INTO team_channels (id, team_id, from_agent, to_agent) VALUES (?, ?, ?, ?)',
            [uuidv4(), id, a.agentId, b.agentId]);
        }
      }
    }
  } else if (input.template === 'pipeline') {
    // Linear chain: A↔B↔C (bidirectional between adjacent)
    for (let i = 0; i < input.members.length - 1; i++) {
      const a = input.members[i].agentId;
      const b = input.members[i + 1].agentId;
      run('INSERT INTO team_channels (id, team_id, from_agent, to_agent) VALUES (?, ?, ?, ?)',
        [uuidv4(), id, a, b]);
      run('INSERT INTO team_channels (id, team_id, from_agent, to_agent) VALUES (?, ?, ?, ?)',
        [uuidv4(), id, b, a]);
    }
  }

  // Add explicit channels (for 'custom' template or additions on top of template)
  if (input.channels) {
    for (const c of input.channels) {
      // Skip if channel already exists (from template generation)
      const exists = queryOne(
        'SELECT 1 FROM team_channels WHERE team_id = ? AND from_agent = ? AND to_agent = ?',
        [id, c.from, c.to]
      );
      if (!exists) {
        run('INSERT INTO team_channels (id, team_id, from_agent, to_agent, label) VALUES (?, ?, ?, ?, ?)',
          [uuidv4(), id, c.from, c.to, c.label || null]);
      }
    }
  }

  return getTeam(id)!;
}

export function getTeam(id: string): Team | null {
  const row = queryOne('SELECT * FROM teams WHERE id = ?', [id]);
  if (!row) return null;
  const team = rowToTeam(row);
  team.members = getTeamMembers(id);
  team.channels = listChannels(id);
  return team;
}

export function listTeams(workspaceId: string): Team[] {
  const rows = queryAll('SELECT * FROM teams WHERE workspace_id = ? ORDER BY created_at DESC', [workspaceId]);
  return rows.map(row => {
    const team = rowToTeam(row);
    team.members = getTeamMembers(team.id);
    team.channels = listChannels(team.id);
    return team;
  });
}

export function updateTeamStatus(id: string, status: TeamStatus): void {
  if (status === 'disbanded') {
    run("UPDATE teams SET status = ?, disbanded_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [status, id]);
  } else {
    run("UPDATE teams SET status = ?, updated_at = datetime('now') WHERE id = ?", [status, id]);
  }
}

export function saveTeamManifest(id: string, manifest: string): void {
  run("UPDATE teams SET manifest = ?, updated_at = datetime('now') WHERE id = ?", [manifest, id]);
}

export function getTeamManifest(id: string): string | null {
  const row = queryOne('SELECT manifest FROM teams WHERE id = ?', [id]);
  return row?.manifest || null;
}

// ── Team members ────────────────────────────────────────────────────────

export function addTeamMember(teamId: string, agentId: string, role: string = 'member'): void {
  run('INSERT INTO team_members (team_id, agent_id, role) VALUES (?, ?, ?)', [teamId, agentId, role]);
  run("UPDATE teams SET updated_at = datetime('now') WHERE id = ?", [teamId]);
}

export function removeTeamMember(teamId: string, agentId: string): void {
  run('DELETE FROM team_members WHERE team_id = ? AND agent_id = ?', [teamId, agentId]);
  // Clean up channels involving this agent
  run('DELETE FROM team_channels WHERE team_id = ? AND (from_agent = ? OR to_agent = ?)', [teamId, agentId, agentId]);
  run("UPDATE teams SET updated_at = datetime('now') WHERE id = ?", [teamId]);
}

export function getTeamMembers(teamId: string): TeamMember[] {
  return queryAll(
    `SELECT tm.*, a.title, a.provider, a.status as agent_status
     FROM team_members tm
     LEFT JOIN agents a ON tm.agent_id = a.id
     WHERE tm.team_id = ?`,
    [teamId]
  ).map(rowToTeamMember);
}

export function getTeamMembership(agentId: string): { teamId: string; role: string } | null {
  const row = queryOne(
    `SELECT tm.team_id, tm.role FROM team_members tm
     JOIN teams t ON tm.team_id = t.id
     WHERE tm.agent_id = ? AND t.status = 'active'
     LIMIT 1`,
    [agentId]
  );
  return row ? { teamId: row.team_id, role: row.role } : null;
}

// ── Team channels ───────────────────────────────────────────────────────

export function createChannel(teamId: string, fromAgent: string, toAgent: string, label?: string): TeamChannel {
  const id = uuidv4();
  run('INSERT INTO team_channels (id, team_id, from_agent, to_agent, label) VALUES (?, ?, ?, ?, ?)',
    [id, teamId, fromAgent, toAgent, label || null]);
  run("UPDATE teams SET updated_at = datetime('now') WHERE id = ?", [teamId]);
  return { id, teamId, fromAgent, toAgent, label: label || null };
}

export function removeChannel(channelId: string): void {
  const channel = queryOne('SELECT team_id FROM team_channels WHERE id = ?', [channelId]);
  run('DELETE FROM team_channels WHERE id = ?', [channelId]);
  if (channel) {
    run("UPDATE teams SET updated_at = datetime('now') WHERE id = ?", [channel.team_id]);
  }
}

export function getChannel(teamId: string, fromAgent: string, toAgent: string): TeamChannel | null {
  const row = queryOne(
    'SELECT * FROM team_channels WHERE team_id = ? AND from_agent = ? AND to_agent = ?',
    [teamId, fromAgent, toAgent]
  );
  return row ? rowToTeamChannel(row) : null;
}

export function listChannels(teamId: string): TeamChannel[] {
  return queryAll('SELECT * FROM team_channels WHERE team_id = ?', [teamId]).map(rowToTeamChannel);
}

// ── Team messages ───────────────────────────────────────────────────────

export function createTeamMessage(input: {
  teamId: string;
  fromAgent: string;
  toAgent: string;
  subject: string;
  status: TeamMessageStatus;
  summary: string;
  detail?: string;
  need?: string;
}): TeamMessage {
  run(
    `INSERT INTO team_messages (team_id, from_agent, to_agent, subject, status, summary, detail, need)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.teamId, input.fromAgent, input.toAgent, input.subject, input.status, input.summary, input.detail || null, input.need || null]
  );
  const row = queryOne('SELECT * FROM team_messages WHERE team_id = ? ORDER BY id DESC LIMIT 1', [input.teamId]);
  return rowToTeamMessage(row);
}

export function getPendingMessages(agentId: string): TeamMessage[] {
  return queryAll(
    `SELECT tm.*, fa.title as from_title, ta.title as to_title
     FROM team_messages tm
     LEFT JOIN agents fa ON tm.from_agent = fa.id
     LEFT JOIN agents ta ON tm.to_agent = ta.id
     WHERE tm.to_agent = ? AND tm.delivered_at IS NULL
     ORDER BY tm.created_at ASC`,
    [agentId]
  ).map(rowToTeamMessage);
}

export function markMessageDelivered(messageId: number): void {
  run("UPDATE team_messages SET delivered_at = datetime('now') WHERE id = ?", [messageId]);
}

export function getTeamMessages(teamId: string, agentId?: string, limit: number = 50): TeamMessage[] {
  if (agentId) {
    return queryAll(
      `SELECT tm.*, fa.title as from_title, ta.title as to_title
       FROM team_messages tm
       LEFT JOIN agents fa ON tm.from_agent = fa.id
       LEFT JOIN agents ta ON tm.to_agent = ta.id
       WHERE tm.team_id = ? AND (tm.from_agent = ? OR tm.to_agent = ?)
       ORDER BY tm.created_at DESC LIMIT ?`,
      [teamId, agentId, agentId, limit]
    ).map(rowToTeamMessage);
  }
  return queryAll(
    `SELECT tm.*, fa.title as from_title, ta.title as to_title
     FROM team_messages tm
     LEFT JOIN agents fa ON tm.from_agent = fa.id
     LEFT JOIN agents ta ON tm.to_agent = ta.id
     WHERE tm.team_id = ?
     ORDER BY tm.created_at DESC LIMIT ?`,
    [teamId, limit]
  ).map(rowToTeamMessage);
}

export function getRecentMessageCount(teamId: string, windowMinutes: number = 5): number {
  const row = queryOne(
    `SELECT COUNT(*) as cnt FROM team_messages
     WHERE team_id = ? AND created_at > datetime('now', '-' || ? || ' minutes')`,
    [teamId, windowMinutes]
  );
  return row?.cnt || 0;
}

export function getRecentPairMessages(teamId: string, agentA: string, agentB: string, limit: number = 12): TeamMessage[] {
  return queryAll(
    `SELECT * FROM team_messages
     WHERE team_id = ?
       AND ((from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?))
     ORDER BY created_at DESC LIMIT ?`,
    [teamId, agentA, agentB, agentB, agentA, limit]
  ).map(rowToTeamMessage);
}

// ── Team tasks ──────────────────────────────────────────────────────────

export function createTeamTask(input: {
  teamId: string;
  title: string;
  description?: string;
  assignedTo?: string;
  blockedBy?: string[];
  createdBy: string;
}): TeamTask {
  const id = uuidv4();
  run(
    `INSERT INTO team_tasks (id, team_id, title, description, assigned_to, blocked_by, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, input.teamId, input.title, input.description || '', input.assignedTo || null,
     JSON.stringify(input.blockedBy || []), input.createdBy]
  );
  return getTeamTask(id)!;
}

export function getTeamTask(id: string): TeamTask | null {
  const row = queryOne('SELECT * FROM team_tasks WHERE id = ?', [id]);
  return row ? rowToTeamTask(row) : null;
}

export function updateTeamTask(taskId: string, updates: {
  status?: TeamTaskStatus;
  assignedTo?: string;
  notes?: string;
}): TeamTask | null {
  const sets: string[] = [];
  const params: any[] = [];

  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.assignedTo !== undefined) { sets.push('assigned_to = ?'); params.push(updates.assignedTo); }
  if (updates.notes !== undefined) { sets.push('notes = ?'); params.push(updates.notes); }

  if (sets.length === 0) return getTeamTask(taskId);

  sets.push("updated_at = datetime('now')");
  params.push(taskId);
  run(`UPDATE team_tasks SET ${sets.join(', ')} WHERE id = ?`, params);
  return getTeamTask(taskId);
}

export function getTeamTasks(teamId: string): TeamTask[] {
  return queryAll('SELECT * FROM team_tasks WHERE team_id = ? ORDER BY created_at ASC', [teamId])
    .map(rowToTeamTask);
}

// ── Selection comment operations (WP-P5-A) ─────────────────────────────────
// Every mutation helper maintains updated_at explicitly — the column default
// only covers the insert (plan §5 note).

function rowToSelectionComment(row: any): SelectionComment {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    targetType: row.target_type,
    kind: row.kind ?? 'comment',
    filePath: row.file_path ?? null,
    pathType: row.path_type ?? null,
    rootDirectory: row.root_directory ?? null,
    docHash: row.doc_hash ?? null,
    anchorStart: row.anchor_start ?? null,
    anchorEnd: row.anchor_end ?? null,
    lineStart: row.line_start ?? null,
    lineEnd: row.line_end ?? null,
    prefix: row.prefix ?? null,
    suffix: row.suffix ?? null,
    quotedText: row.quoted_text,
    body: row.body,
    status: row.status as SelectionCommentStatus,
    sentToAgentId: row.sent_to_agent_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at ?? null,
    resolvedAt: row.resolved_at ?? null,
  };
}

export function createSelectionComment(input: CreateSelectionCommentInput): SelectionComment {
  const id = uuidv4();
  run(
    `INSERT INTO selection_comments (
       id, workspace_id, target_type, kind, file_path, path_type, root_directory,
       doc_hash, anchor_start, anchor_end, line_start, line_end, prefix, suffix,
       quoted_text, body, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
    [
      id, input.workspaceId, input.targetType ?? 'file', input.kind ?? 'comment',
      input.filePath,
      input.pathType ?? null, input.rootDirectory ?? null, input.docHash ?? null,
      input.anchorStart ?? null, input.anchorEnd ?? null,
      input.lineStart ?? null, input.lineEnd ?? null,
      input.prefix ?? null, input.suffix ?? null,
      input.quotedText, input.body,
    ]
  );
  return getSelectionComment(id)!;
}

export function getSelectionComment(id: string): SelectionComment | null {
  const row = queryOne('SELECT * FROM selection_comments WHERE id = ?', [id]);
  return row ? rowToSelectionComment(row) : null;
}

/** All comments for one file in one workspace, every status, oldest first
 *  (gutter order). The renderer filters by status as needed. */
export function listSelectionComments(workspaceId: string, filePath: string): SelectionComment[] {
  return queryAll(
    `SELECT * FROM selection_comments
     WHERE workspace_id = ? AND file_path = ?
     ORDER BY created_at ASC, id ASC`,
    [workspaceId, filePath]
  ).map(rowToSelectionComment);
}

export function updateSelectionComment(id: string, updates: UpdateSelectionCommentInput): SelectionComment | null {
  const sets: string[] = [];
  const params: any[] = [];

  if (updates.body !== undefined) { sets.push('body = ?'); params.push(updates.body); }
  if (updates.quotedText !== undefined) { sets.push('quoted_text = ?'); params.push(updates.quotedText); }
  if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
  if (updates.docHash !== undefined) { sets.push('doc_hash = ?'); params.push(updates.docHash); }
  if (updates.anchorStart !== undefined) { sets.push('anchor_start = ?'); params.push(updates.anchorStart); }
  if (updates.anchorEnd !== undefined) { sets.push('anchor_end = ?'); params.push(updates.anchorEnd); }
  if (updates.lineStart !== undefined) { sets.push('line_start = ?'); params.push(updates.lineStart); }
  if (updates.lineEnd !== undefined) { sets.push('line_end = ?'); params.push(updates.lineEnd); }
  if (updates.prefix !== undefined) { sets.push('prefix = ?'); params.push(updates.prefix); }
  if (updates.suffix !== undefined) { sets.push('suffix = ?'); params.push(updates.suffix); }

  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    params.push(id);
    run(`UPDATE selection_comments SET ${sets.join(', ')} WHERE id = ?`, params);
  }
  return getSelectionComment(id);
}

export function deleteSelectionComment(id: string): void {
  run('DELETE FROM selection_comments WHERE id = ?', [id]);
}

export function resolveSelectionComment(id: string): SelectionComment | null {
  run(
    `UPDATE selection_comments
     SET status = 'resolved', resolved_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`,
    [id]
  );
  return getSelectionComment(id);
}

// `comments:send` status machine (plan §1.8: transitions written next to the
// DB by the main process, not chased from the renderer).

export function markSelectionCommentsQueued(ids: string[], agentId: string | null): void {
  const stmt = db.prepare(
    `UPDATE selection_comments
     SET status = 'queued', sent_to_agent_id = ?, updated_at = datetime('now')
     WHERE id = ?`
  );
  for (const id of ids) stmt.run(agentId, id);
}

export function markSelectionCommentsSent(ids: string[], agentId: string): void {
  const stmt = db.prepare(
    `UPDATE selection_comments
     SET status = 'sent', sent_to_agent_id = ?, sent_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`
  );
  for (const id of ids) stmt.run(agentId, id);
}

export function markSelectionCommentsSendFailed(ids: string[]): void {
  const stmt = db.prepare(
    `UPDATE selection_comments
     SET status = 'send_failed', updated_at = datetime('now')
     WHERE id = ?`
  );
  for (const id of ids) stmt.run(id);
}

// ── Orchestration operations ──────────────────────────────────────────────

function rowToOrchestrationRun(row: any): OrchestrationRun {
  let lastRelayedTs: Record<string, string> = {};
  if (row.last_relayed_ts) {
    try {
      const parsed = JSON.parse(row.last_relayed_ts);
      if (parsed && typeof parsed === 'object') lastRelayedTs = parsed;
    } catch { /* tolerate garbage — start with empty highwater marks */ }
  }
  return {
    runId: row.run_id,
    name: row.name,
    mode: row.mode,
    status: row.status,
    workspaceId: row.workspace_id,
    supervisorId: row.supervisor_id,
    topic: row.topic ?? '',
    planPath: row.plan_path ?? '',
    leadProvider: row.lead_provider ?? 'claude',
    reviewerProvider: row.reviewer_provider ?? 'codex',
    turnTimeoutMs: row.turn_timeout_ms ?? 600000,
    leadId: row.lead_id ?? undefined,
    reviewerId: row.reviewer_id ?? undefined,
    turn: row.turn ?? undefined,
    round: row.round ?? undefined,
    lastRelayedTs,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at ?? undefined,
    error: row.error ?? undefined,
  };
}

/** Insert or update a run row (upsert keyed on run_id). */
export function insertOrchestration(r: OrchestrationRun): void {
  run(
    `INSERT INTO orchestrations (
       run_id, name, mode, status, workspace_id, supervisor_id, topic, plan_path,
       lead_provider, reviewer_provider, turn_timeout_ms, lead_id, reviewer_id,
       turn, round, last_relayed_ts, started_at, updated_at, ended_at, error
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       name = excluded.name, mode = excluded.mode, status = excluded.status,
       workspace_id = excluded.workspace_id, supervisor_id = excluded.supervisor_id,
       topic = excluded.topic, plan_path = excluded.plan_path,
       lead_provider = excluded.lead_provider, reviewer_provider = excluded.reviewer_provider,
       turn_timeout_ms = excluded.turn_timeout_ms, lead_id = excluded.lead_id,
       reviewer_id = excluded.reviewer_id, turn = excluded.turn, round = excluded.round,
       last_relayed_ts = excluded.last_relayed_ts, started_at = excluded.started_at,
       updated_at = excluded.updated_at, ended_at = excluded.ended_at, error = excluded.error`,
    [
      r.runId, r.name, r.mode, r.status, r.workspaceId, r.supervisorId,
      r.topic, r.planPath, r.leadProvider, r.reviewerProvider, r.turnTimeoutMs,
      r.leadId ?? null, r.reviewerId ?? null, r.turn ?? null, r.round ?? null,
      JSON.stringify(r.lastRelayedTs || {}), r.startedAt, r.updatedAt,
      r.endedAt ?? null, r.error ?? null,
    ]
  );
}

/** Persist progress on an existing run (same upsert path as insert). */
export function updateOrchestration(r: OrchestrationRun): void {
  insertOrchestration(r);
}

export function getOrchestrationRun(runId: string): OrchestrationRun | null {
  const row = queryOne('SELECT * FROM orchestrations WHERE run_id = ?', [runId]);
  return row ? rowToOrchestrationRun(row) : null;
}

export function listOrchestrationRuns(): OrchestrationRun[] {
  return queryAll('SELECT * FROM orchestrations ORDER BY started_at DESC').map(rowToOrchestrationRun);
}

export function insertOrchestrationEvent(evt: OrchestrationEvent): void {
  run(
    'INSERT INTO orchestration_events (run_id, ts, kind, payload) VALUES (?, ?, ?, ?)',
    [evt.runId, evt.ts, evt.kind, evt.payload === undefined ? null : JSON.stringify(evt.payload)]
  );
}

export function listOrchestrationEvents(runId: string): OrchestrationEvent[] {
  return queryAll(
    'SELECT * FROM orchestration_events WHERE run_id = ? ORDER BY id ASC',
    [runId]
  ).map((row: any) => ({
    runId: row.run_id,
    ts: row.ts,
    kind: row.kind,
    payload: row.payload ? JSON.parse(row.payload) : null,
  }));
}

export function insertOrchestrationMember(runId: string, role: string, agentId: string): void {
  run(
    `INSERT INTO orchestration_members (run_id, role, agent_id) VALUES (?, ?, ?)
     ON CONFLICT(run_id, role) DO UPDATE SET agent_id = excluded.agent_id`,
    [runId, role, agentId]
  );
}

/** Boot reconcile: any run still 'starting'/'running' belonged to a dashboard
 *  process that died. Mark them aborted (error = reason) and return the rows as
 *  they were BEFORE the update so the caller can emit resume hints. */
export function markActiveRunsAborted(reason: string): OrchestrationRun[] {
  const rows = queryAll(
    "SELECT * FROM orchestrations WHERE status IN ('starting', 'running')"
  ).map(rowToOrchestrationRun);
  if (rows.length > 0) {
    run(
      "UPDATE orchestrations SET status = 'aborted', error = ?, ended_at = ?, updated_at = ? WHERE status IN ('starting', 'running')",
      [reason, new Date().toISOString(), new Date().toISOString()]
    );
  }
  return rows;
}
