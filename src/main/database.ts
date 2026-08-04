import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { AgentStopReason, deriveHookAvailability, isAgentStopReason, parseStopReason, PersistedAgentStatus } from '../shared/types';
import { Agent, AgentProvider, AgentSessionRow, AgentStatus, AgentTemplate, CreateAgentTemplateInput, CreateSelectionCommentInput, CreateSelectionCommentReplyInput, CreateWorkspaceInput, CreateTeamInput, FileActivity, FileOperation, Plan, PlanFormat, PlanTabKey, PlanTabOverview, RepoActivityEvidenceV1, SelectionComment, SelectionCommentReply, SelectionCommentStatus, SupervisorFocus, Team, TeamChannel, TeamMember, TeamMessage, TeamMessageStatus, TeamStatus, TeamTask, TeamTaskStatus, UpdateSelectionCommentInput, Workspace } from '../shared/types';
import { parsePdfSelectionAnchor, serializePdfSelectionAnchor, validatePdfSelectionAnchor, type PdfSelectionAnchorV1, type SelectionAnchorType } from '../shared/pdf-annotations';
import { DEFAULT_COMMAND, DEFAULT_COMMAND_WSL, SUPERVISOR_AGENT_MD } from '../shared/constants';
import { parseRepoActivityEvidence } from './plans/repo-activity';
import { OrchestrationBinding, OrchestrationEvent, OrchestrationRun, OrchestrationPlanBindingMode } from './orchestration/types';
import { resolveWorkspaceForCwd, WORKSPACE_LINEAGE_VERSION, type WorkspaceRecordLite } from './skill-analytics/workspace-lineage';
import { unwrapOsc8, stripTerminalEscapes, canonicalizeToAbsolute, looksPolluted } from './file-activity-normalize';
import type { ResolvedPlanStamp } from '../shared/commit-candidates';

let db: Database.Database;
let dbPath: string;

/** Pure path computation — NO side effects. Split out of getDbPath() so the
 *  read-only analytics path cannot create the AppData directory (plan §2.1). */
export function getDbPathExisting(): string {
  const appData = process.env.APPDATA || path.join(process.env.HOME || '', '.config');
  return path.join(appData, 'AgentDashboard', 'dashboard.db');
}

function getDbPath(): string {
  const dbFile = getDbPathExisting();
  const dir = path.dirname(dbFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dbFile;
}

/**
 * Read-only, query-only open for the analytics exporter (plan §2.1). Never
 * creates the directory or the file, never migrates, never changes journal mode
 * (a second read-only connection coexists with the running app's WAL database).
 */
export function initDatabaseReadOnly(): void {
  dbPath = getDbPathExisting();
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('foreign_keys = ON');
}

/** Close the module singleton. Generalizes the former test-only seam. */
export function closeDatabase(): void {
  db?.close();
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

  // Migration: normalize legacy framework-default commands that still carry a
  // standalone `--chrome` token. Earlier builds seeded
  // `workspaces.default_command` with the legacy framework default
  // (`claude --dangerously-skip-permissions --chrome`, or the WSL `ccode`
  // variant); the framework default has since dropped `--chrome`
  // (DEFAULT_COMMAND / DEFAULT_COMMAND_WSL), and the stale rows cause downstream
  // launch bugs. Rewrite ONLY rows that ARE the legacy framework default modulo
  // a standalone `--chrome` token down to the current framework default —
  // genuinely custom commands that merely happen to contain `--chrome` are left
  // untouched. Idempotent (an already-normalized row has no `--chrome` to strip,
  // so it matches nothing) and wrapped in try/catch like the sibling migrations
  // so a failure never blocks DB init.
  try { normalizeLegacyChromeDefaultCommands(db); } catch { /* best-effort; never block init */ }

  // Migration: add provider column to existing agents tables
  try { db.exec(`ALTER TABLE agents ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`); } catch { /* column already exists */ }

  // Migration: add is_supervisor column
  try { db.exec(`ALTER TABLE agents ADD COLUMN is_supervisor INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }

  // Migration: add is_supervised column (opt-in for supervisor event bridge)
  try { db.exec(`ALTER TABLE agents ADD COLUMN is_supervised INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }

  // Migration: add is_worker column (hook-based status lane — launches from
  // .lares/workers/<provider>/, disables PTY + chat-event inference; does
  // NOT notify a supervisor). Orthogonal to is_supervised; see Agent.isWorker.
  try { db.exec(`ALTER TABLE agents ADD COLUMN is_worker INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }

  // Migration: add is_researcher column (browser-parity-and-capability-isolation
  // §0, D-1) — the researcher role-lane: scaffolded into .lares/researcher,
  // browser MCP only, native dangerous tools withheld. Mutually exclusive with
  // the other lane flags; see Agent.isResearcher.
  try { db.exec(`ALTER TABLE agents ADD COLUMN is_researcher INTEGER DEFAULT 0`); } catch { /* column already exists */ }

  // Migration: add privilege_lane column (#19 supervisor-tools-for-personas) — a
  // persona declaring the 'supervisor' privilege lane is granted the supervisor
  // MCP toolset WITHOUT becoming the structural supervisor (is_supervisor stays
  // 0, so it renders as its own card). NULL/absent → no elevated grant. Read at
  // the MCP-injection sites via roleLaneOf; see Agent.privilegeLane.
  try { db.exec(`ALTER TABLE agents ADD COLUMN privilege_lane TEXT`); } catch { /* column already exists */ }

  // Migration: add wants_codex_hooks column (Bug 2 / Edit 2.6 — codex-persona
  // hook parity). Persists the launch-time decision (provider==='codex' AND
  // worker-lane OR persona) so the runner's hook-env gate
  // (roleLaneOf(agent) !== 'legacy' || isCodexHookPersona(agent)) is
  // re-derivable from the STORED row on reconcile/respawn — when the transient
  // launch input is gone. Defaults to 0 so every pre-existing row is unaffected.
  try { db.exec(`ALTER TABLE agents ADD COLUMN wants_codex_hooks INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }

  // Agent-ownership primitive: the launcher (owner) of a child agent, so the
  // child's lifecycle events resolve to its launcher — not just the structural
  // workspace supervisor. NULL for dashboard-internal / unowned launches.
  try { db.exec(`ALTER TABLE agents ADD COLUMN owner_agent_id TEXT`); } catch { /* exists */ }

  // notifyOwner mute: decouples ownership from lifecycle-event subscription. An
  // owned agent with notify_owner = 0 stays owned (owner_agent_id intact) but its
  // owner-directed events are suppressed at the EventBridge choke point. Defaults
  // to 1 (notify) so every pre-existing row preserves today's behavior.
  try { db.exec(`ALTER TABLE agents ADD COLUMN notify_owner INTEGER DEFAULT 1`); } catch { /* exists */ }

  // Context-brick Inc 4 (4.3) — continuation generation. Dedicated column:
  // restart_count keeps meaning crash restarts; this counts continuation
  // handoffs. Bumped ONLY via the attempt's successorGen inside the atomic
  // relaunch transaction (commitContinuationRelaunch), never ad-hoc.
  try { db.exec(`ALTER TABLE agents ADD COLUMN continuation_generation INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }

  // Per-agent continuation toggle (Edward 2026-07-05). When 0, the continuation
  // watcher must NEVER open a handoff attempt for this agent — it records a
  // `continuation-disabled` trigger blocker. Defaults to 1 so every pre-existing
  // row keeps today's opt-in-by-default behavior. Read via Agent.continuationEnabled.
  try { db.exec(`ALTER TABLE agents ADD COLUMN continuation_enabled INTEGER NOT NULL DEFAULT 1`); } catch { /* exists */ }

  // Context-brick Phase 4 — stamp each file activity with the session (and
  // generation) it happened under, so continuations retain prior-session
  // activity instead of wiping it, and the UI can partition current vs prior.
  // `session_id` is the true partition key (a `/clear` can mint a same-generation
  // sibling); `generation` is a display label. Additive; legacy rows keep
  // generation 0 / session_id NULL.
  try { db.exec(`ALTER TABLE file_activities ADD COLUMN generation INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE file_activities ADD COLUMN session_id TEXT`); } catch { /* exists */ }

  // Context-brick Inc 4 (4.3) — server-minted handoff attempts. The attempt
  // OWNS the successor generation (allocated at open = agent gen + 1); the
  // brick and the agent row both COPY it, never independently computed. At
  // most one 'open' attempt per agent (enforced in the create helper).
  db.exec(`
    CREATE TABLE IF NOT EXISTS continuation_handoff_attempts (
      id                     TEXT PRIMARY KEY,
      dashboard_agent_id     TEXT NOT NULL,
      generation             INTEGER NOT NULL,
      started_at             TEXT NOT NULL,
      closed_at              TEXT,
      status                 TEXT NOT NULL DEFAULT 'open',
      reason                 TEXT,
      threshold_context_pct  INTEGER
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_continuation_attempts_agent_status
           ON continuation_handoff_attempts (dashboard_agent_id, status)`);

  // Save-card SC-WP-2F: persist the continuation binding independently of
  // mutable agent state and turn history so the wake survives app restart.
  try { db.exec(`ALTER TABLE continuation_handoff_attempts ADD COLUMN plan_id TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE continuation_handoff_attempts ADD COLUMN plan_item_id TEXT`); } catch { /* exists */ }
  try {
    db.exec(`ALTER TABLE continuation_handoff_attempts ADD COLUMN plan_stamp_source TEXT NOT NULL
      DEFAULT 'legacy-unstamped'
      CHECK (plan_stamp_source IN ('legacy-unstamped', 'explicit', 'agent-default',
        'fork-carry', 'revive-carry', 'continuation-carry', 'explicit-none',
        'unbound-manual'))`);
  } catch { /* exists */ }

  // Context-brick Inc 4 (4.3) — append-only brick rows. Soft supersede only
  // (superseded_at); NO hard delete, NO cascade FK — the graveyard must
  // survive agent deletion.
  db.exec(`
    CREATE TABLE IF NOT EXISTS continuation_bricks (
      id                  TEXT PRIMARY KEY,
      dashboard_agent_id  TEXT NOT NULL,
      handoff_attempt_id  TEXT NOT NULL,
      generation          INTEGER NOT NULL,
      note                TEXT NOT NULL,
      note_source         TEXT NOT NULL,
      byte_len            INTEGER NOT NULL,
      written_at          TEXT NOT NULL,
      superseded_at       TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_continuation_bricks_agent_written
           ON continuation_bricks (dashboard_agent_id, written_at DESC)`);

  // Context-brick Phase 1 (D1) — durable session lineage. One dashboard agent
  // id spans many sessions across continuations and `/clear` rotations. This is
  // the durable map agent id → ordered generations→session ids that survives
  // the mutable single-column agents.resume_session_id being overwritten on
  // every transition.
  //
  // Keyed UNIQUE(dashboard_agent_id, session_id) — NOT generation. `generation`
  // is an ordering HINT that may REPEAT (a `/clear` mints a new session WITHOUT
  // bumping the generation), so it can never be a unique/partition key. Order
  // by started_at + row id; partition current vs prior by session_id.
  // working_directory is stored ONLY to recompute the JSONL slug — many agents
  // share one cwd/slug by design, so it is NEVER an identity key.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      dashboard_agent_id TEXT NOT NULL,
      generation         INTEGER NOT NULL,   -- ordering HINT ONLY; may repeat (/clear)
      session_id         TEXT NOT NULL,
      working_directory  TEXT NOT NULL,      -- to recompute the JSONL slug; NEVER an identity key
      provider           TEXT NOT NULL,
      started_at         TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at           TEXT,               -- set when superseded by the next session
      jsonl_present      INTEGER DEFAULT 1,  -- best-effort; provider may prune
      UNIQUE(dashboard_agent_id, session_id) -- D1: session_id, NOT generation
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent
           ON agent_sessions(dashboard_agent_id, started_at, id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      payload     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Cross-workspace collaboration audit (plans/cross-workspace-collaboration.md
  // WP0.3). `addEvent` is single-agent_id-keyed and cannot express discovery
  // events (list / list_workspaces have no natural target agent), so this
  // dedicated table records every cross-workspace/foreign-target operation —
  // SUCCESSES AND every denied/failed attempt. It NEVER stores message contents
  // (only `queued_message_len`); `detail` is a sanitized fixed-key allowlist JSON,
  // never a raw error string or message body.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cross_workspace_audit (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL,
      operation TEXT NOT NULL,            -- list_agents | list_workspaces | read_agent | send_message | launch | revive
      actor_agent_id TEXT, actor_workspace_id TEXT, actor_lane TEXT,   -- lane | 'global-bearer'
      target_agent_id TEXT, target_workspace_id TEXT,
      force INTEGER DEFAULT 0, queued_message_len INTEGER,             -- length only, NEVER contents
      outcome TEXT NOT NULL,              -- 'ok' | 'denied:<code>' | 'error:<code>'
      detail TEXT                          -- sanitized allowlist JSON (fixed keys) — never a raw error string/body
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cwa_ts ON cross_workspace_audit(ts)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cwa_target_ws ON cross_workspace_audit(target_workspace_id, ts)`);

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
      error             TEXT,
      plan_id           TEXT,            -- WP6 planning-surface rail (nullable)
      section_anchor    TEXT,            -- WP6 writeback target sec_ anchor
      plan_item_id      TEXT,            -- Stage II plan-only; reserved for Stage III
      plan_binding_mode TEXT NOT NULL DEFAULT 'agent-default'
    )
  `);
  // WP6: guarded ALTERs so pre-WP6 orchestrations tables gain the plan rail
  // columns without a table rebuild (own subsystem — NOT the planning-surface
  // migration region; the orchestrations table is disjoint from initDatabase's
  // agents/provenance regions).
  try { db.exec(`ALTER TABLE orchestrations ADD COLUMN plan_id TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE orchestrations ADD COLUMN section_anchor TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE orchestrations ADD COLUMN plan_item_id TEXT`); } catch { /* exists */ }
  let orchestrationBindingModeAdded = false;
  try {
    db.exec(`ALTER TABLE orchestrations ADD COLUMN plan_binding_mode TEXT NOT NULL DEFAULT 'agent-default'`);
    orchestrationBindingModeAdded = true;
  } catch { /* exists */ }
  if (orchestrationBindingModeAdded) {
    db.exec(`UPDATE orchestrations SET plan_binding_mode = 'explicit' WHERE plan_id IS NOT NULL`);
  }

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

  // ── Slice 13: user-only downloads (app-managed download pipeline) ──────────
  // Every download (agent + user) is recorded here with its normalized filename,
  // app-managed save path, originating partition/workspace, byte progress, and
  // lifecycle state. The browser MANAGER enforces the decision gate (agent
  // downloads only from allowlisted origins; user downloads only after a
  // trusted-chrome confirmation) and normalizes filenames / blocks path
  // traversal before writing; this table just persists the resulting records.
  // The thin service is src/main/browser/downloads-store.ts (getDb()). The
  // `partition` CHECK pins each row to the two known partitions, and the
  // `state` CHECK to the four lifecycle states. Times are epoch-ms.
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_downloads (
      id             TEXT PRIMARY KEY,
      url            TEXT NOT NULL,
      filename       TEXT NOT NULL,                  -- normalized basename (no separators / traversal)
      save_path      TEXT NOT NULL,                  -- absolute path inside the app-managed downloads dir
      partition      TEXT NOT NULL CHECK (partition IN ('user','agent')),
      workspace_id   TEXT,                           -- nullable; matches the originating tab's workspaceId
      origin         TEXT NOT NULL DEFAULT '',       -- new URL(url).origin, '' if unparseable
      bytes_received INTEGER NOT NULL DEFAULT 0,
      total_bytes    INTEGER NOT NULL DEFAULT 0,     -- 0 = unknown (server sent no content-length)
      state          TEXT NOT NULL CHECK (state IN ('in-progress','completed','failed','cancelled')),
      started_at     INTEGER NOT NULL,
      ended_at       INTEGER                         -- set when state leaves 'in-progress'
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_downloads_started
      ON browser_downloads(started_at DESC)
  `);

  // ── Slice 15: per-site zoom (USER PARTITION ONLY) ──────────────────────────
  // Persisted zoom keyed by origin (new URL(url).origin) for the user partition.
  // Applied on committed navigation of a user tab (fallback 100% when no row).
  // Agent zoom stays per-tab and is NEVER persisted (cross-cutting rule #1) — the
  // manager only ever writes a user tab's origin here. The thin service is
  // src/main/browser/zoom-store.ts (getDb()). zoom_factor is the raw multiplier
  // (1 = 100%); updated_at is epoch-ms.
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_zoom (
      origin       TEXT PRIMARY KEY,        -- new URL(url).origin (http/https user tabs only)
      zoom_factor  REAL NOT NULL,           -- raw multiplier (1 = 100%)
      updated_at   INTEGER NOT NULL
    )
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

  // Signed-in tabs (on-demand user sign-in for research agents — WI-1): the
  // durable session lifecycle for a tracked origin. `session_state='active'` (the
  // default) = a live confirmed session; a login-wall redirect / explicit expiry
  // flips it to `'expired'` (the row + durable consent are PRESERVED so consent is
  // never lost), and a re-sign-in upserts it back to `'active'`. `expired_at` is
  // the optional epoch-ms of the last expiry flip (NULL while active). Both are
  // ALTER-only (added even to fresh tables — the CREATE above omits them), guarded
  // try/catch ALTER (house idiom — see the signed_in_at sibling above). The NOT
  // NULL DEFAULT 'active' backfills every legacy row as a live session.
  try {
    db.exec(
      `ALTER TABLE browser_access_signed_in_origins ADD COLUMN session_state TEXT NOT NULL DEFAULT 'active' CHECK (session_state IN ('active','expired'))`,
    );
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE browser_access_signed_in_origins ADD COLUMN expired_at INTEGER`);
  } catch { /* column already exists */ }

  // Signed-in tabs (WI-1): per-rule consent + login-wall tuning on the access
  // rules. `consent_acked_at` = epoch-ms the human acknowledged the 4-point
  // sharing consent when the origin became `allow_signed_in` (NULL = not yet
  // acknowledged / legacy row). `login_url_patterns` = optional JSON array of
  // glob/substring patterns that EXTEND the default warm-expiry heuristic for
  // false-positive-prone SSO/board origins (NULL/'[]' = defaults only). ALTER-only,
  // guarded (house idiom — see the workspace_id sibling above).
  try {
    db.exec(`ALTER TABLE browser_access_rules ADD COLUMN consent_acked_at INTEGER`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE browser_access_rules ADD COLUMN login_url_patterns TEXT`);
  } catch { /* column already exists */ }

  // Phase 1 (BrowserSigninSharing plan §D — workspace-EXACT login grants). The
  // legacy browser_access_signed_in_origins table is keyed (rule_id, origin) with
  // no workspace in the KEY, so a NULL-workspace wildcard rule cannot hold
  // independent per-workspace sessions — the exact defect Phase 0 reproduced (a
  // grant established in one workspace's agent partition was consumed as `ready`
  // by another). This ADDITIVE table makes workspace part of the primary key so a
  // single wildcard visit-rule can carry independent login grants per workspace,
  // and it stores DURABLE consent separately from RUNTIME session state:
  //   - workspace_key : the effective workspace whose agent partition
  //                     (persist:agent:<key>) actually holds the credentials.
  //                     NOT NULL — null/'' normalizes to 'default' (mirrors
  //                     agentPartitionForWorkspace), so the key is 1:1 with the
  //                     partition the session lives in.
  //   - consent_state : durable human permission ('granted' | 'setup_required').
  //   - session_state : runtime session ('setup_required' | 'active' | 'expired').
  // The old table is retained unchanged (revocation origin-breadth + the
  // workspace-agnostic session-center listing still read it); this table is the
  // workspace-exact authority classifyOriginState consults. No cookie material is
  // ever stored here (ids, an origin, states, timestamps only).
  db.exec(`
    CREATE TABLE IF NOT EXISTS browser_access_login_grants (
      rule_id       TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      origin        TEXT NOT NULL,
      consent_state TEXT NOT NULL DEFAULT 'granted'
                      CHECK (consent_state IN ('setup_required','granted')),
      session_state TEXT NOT NULL DEFAULT 'setup_required'
                      CHECK (session_state IN ('setup_required','active','expired')),
      signed_in_at  INTEGER,
      last_used_at  INTEGER,
      verified_at   INTEGER,
      expired_at    INTEGER,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (rule_id, workspace_key, origin)
    )
  `);
  // Upgrade synthesis: park each ACTIVE legacy null-workspace signed-in origin as
  // an explicit **Setup required** grant under the default workspace key. We do
  // NOT create an 'active' grant and we NEVER clone one default cookie jar into
  // every workspace — Electron cannot safely infer that Ed's saved login should
  // become a live session in a named workspace without his re-confirmation. A
  // 'setup_required' grant is not 'active', so classifyOriginState still returns
  // needs_signin until a real per-workspace setup lands (Phase 2). INSERT OR
  // IGNORE keeps it idempotent and never downgrades an existing active grant.
  // No-op on a fresh DB (nothing to synthesize).
  try {
    db.exec(`
      INSERT OR IGNORE INTO browser_access_login_grants
        (rule_id, workspace_key, origin, consent_state, session_state, created_at)
      SELECT s.rule_id, 'default', s.origin, 'granted', 'setup_required',
             COALESCE(s.signed_in_at, 0)
        FROM browser_access_signed_in_origins s
        JOIN browser_access_rules r ON r.id = s.rule_id
       WHERE r.allow_signed_in = 1
         AND r.workspace_id IS NULL
         AND COALESCE(s.session_state, 'active') <> 'expired'
    `);
  } catch { /* best-effort synthesis — never blocks startup */ }

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

  // Additive migration for the PDF dual-viewer trunk (plan Part 1.4). A row is
  // a 'text' anchor (markdown/plaintext) unless explicitly 'pdf', in which case
  // `anchor_json` carries the serialized PdfSelectionAnchorV1. Existing rows
  // default to 'text' so every markdown caller is unchanged.
  try {
    db.exec(`ALTER TABLE selection_comments ADD COLUMN anchor_type TEXT NOT NULL DEFAULT 'text'`);
  } catch { /* column already exists */ }
  try {
    db.exec(`ALTER TABLE selection_comments ADD COLUMN anchor_json TEXT`);
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
  // WP5 (hook-absence-resilience) — the unified three-state SendOutcome of the
  // most recent submit (JSON blob or NULL). Supersedes last_send_error as
  // consumers migrate; read projection only, never gates status.
  try { db.exec(`ALTER TABLE agents ADD COLUMN last_send TEXT`); } catch { /* exists */ }
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

  // ── B2: Plan subscription tables ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
      path          TEXT NOT NULL,
      slug          TEXT,
      format        TEXT NOT NULL,
      run_state     TEXT,
      mtime_ms      INTEGER NOT NULL,
      size_bytes    INTEGER NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at    TEXT,
      UNIQUE(workspace_id, path)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plans_workspace ON plans(workspace_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plans_workspace_active ON plans(workspace_id) WHERE deleted_at IS NULL`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_focus (
      supervisor_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      plan_id           TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      focused_at        TEXT NOT NULL DEFAULT (datetime('now')),
      last_attended_at  TEXT NOT NULL DEFAULT (datetime('now')),
      notes             TEXT,
      PRIMARY KEY (supervisor_id, plan_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_supervisor_focus_supervisor ON supervisor_focus(supervisor_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_supervisor_focus_plan ON supervisor_focus(plan_id)`);

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

  // ── Planning surface: provenance + snapshots ──
  // Disjoint migration region (amendments §F-G) placed AFTER both file_activities
  // cleanup blocks and BEFORE the Context-brick Phase 1 lineage backfill. The B2
  // region above already created `plans`, so every FK → plans(id) here resolves.
  // Serial WP order means WP1/WP2/WP4 append their sub-blocks below without
  // concurrent edits.

  // WP1: agents plan rail. GUARDED ALTERs — SQLite has no ALTER … ADD COLUMN IF
  // NOT EXISTS, so each add is wrapped in try/catch (the owner_agent_id idiom at
  // ~:140). MUST live here, NOT in B2's gap (B2 forbids ALTERing agents there),
  // and clear of B1a's agents-ALTER markers. plan_id is a logical FK → plans.id
  // frozen onto the row at launch; plan_section is the target section anchor.
  try { db.exec(`ALTER TABLE agents ADD COLUMN plan_id TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN plan_section TEXT`); } catch { /* exists */ }

  // Idle-agent lifecycle §B2 — idle/stop bookkeeping columns. Runs inside its
  // own transaction with ONE captured `migratedAt`, so every backfilled row
  // agrees on the migration instant (a per-row datetime('now') would smear the
  // idle clock across the backfill and make "idle for N hours" unreproducible).
  migrateLifecycleColumns(db);

  // Terminal-log retention — the reclaimed-marker column. Additive, no backfill
  // (legacy rows stay NULL = "never reclaimed"); idempotent PRAGMA guard.
  migrateTerminalHistoryReclaimedColumn(db);

  // WP2: provenance spine — all CREATE TABLE IF NOT EXISTS (idempotent regardless
  // of landing order). Four tables: plan_sections (anchor registry, R1 §2),
  // plan_events (reconciled schema, amendments §F-A — canonical dispatched-target
  // column is `dispatched_section_anchor`), plan_section_touches (read/edit-target
  // breadcrumbs, R2 §2.1) and plan_section_changes (effect store, R2 §2.4). The
  // section_anchor rename to dispatched_* is scoped to plan_events ONLY; touches
  // and changes keep their `section_anchor` columns.

  // plan_sections — the durable side of addressability (R1 §2). HTML defines which
  // sections exist and their prose; this table records anchor identity, lifecycle
  // and lineage only (no title/status — those drift on reword).
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_sections (
      id                TEXT PRIMARY KEY,   -- row uuid
      plan_id           TEXT NOT NULL,      -- FK → plans.id
      anchor            TEXT NOT NULL,      -- the data-anchor value; provenance key
      parent_section_id TEXT,               -- split/merge lineage
      created_at        TEXT NOT NULL,
      archived_at       TEXT,               -- soft-delete; provenance is append-only
      UNIQUE (plan_id, anchor)
    )
  `);

  // plan_events — RECONCILED DDL, pasted verbatim from amendments §F-A. The
  // dispatched-target column is `dispatched_section_anchor` (R1's bare
  // `section_anchor` is collapsed into it and does NOT survive here).
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_events (
      id                        TEXT PRIMARY KEY,           -- R1: row uuid
      plan_id                   TEXT NOT NULL,              -- R1: FK → plans.id
      agent_id                  TEXT NOT NULL,              -- R1: emitting agent
      event_type                TEXT NOT NULL,              -- R1: turn outcome / lifecycle
      created_at                TEXT NOT NULL,              -- R1: insertion time

      -- Dispatched target (trusted launch fact). R1 called this section_anchor;
      -- collapsed into R2 §2.6's clearer name. Written from frozen agents.plan_section.
      dispatched_section_anchor TEXT,                       -- R1 ⊕ R2 §2.6 (canonical; R1 dup removed)

      -- Derived attribution — output of resolveTargetAnchor (R2 §2.5).
      observed_section_anchor   TEXT,                       -- R1 ⊕ R2 §2.6 (declared in both; single copy)
      observed_via              TEXT,                       -- R2 §2.6
      attribution_confidence    TEXT,                       -- R2 §2.6 (derivable from observed_via)
      observed_candidates_json  TEXT,                       -- R2 §2.6 (audit trail)
      read_intent_anchor        TEXT,                       -- R2 §2.6 (trusted fact; may be null)
      edit_target_anchor        TEXT,                       -- R2 §2.6 (derived; may be null)

      -- Divergence flags — declared in both R1 & R2 (single copy each).
      section_mismatch          INTEGER NOT NULL DEFAULT 0, -- R1 ⊕ R2 §2.6
      mismatch_reason           TEXT,                       -- R2 §2.6 ('intent-effect-divergence'|'dispatch-drift'|'multi-section'|null)

      -- Payloads.
      trusted_envelope_json     TEXT NOT NULL,              -- R1: agent_id, plan_id, section, files-touched, timing
      claimed_payload_json      TEXT,                       -- R1: scraped sentinel; NULL on scrape failure
      claimed_section_anchor    TEXT                        -- R2 §2.6/§3: mirrored from sentinel; diagnostics-only, never drives the join
    )
  `);
  // Primary projection query is plan + observed-anchor ORDER BY time → the composite covers the sort.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_plan_events_plan_observed_created
      ON plan_events (plan_id, observed_section_anchor, created_at)
  `);
  // Full activity trail for a plan, time-ordered.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_plan_events_plan_created
      ON plan_events (plan_id, created_at)
  `);
  // GT-A WP-A1 (§2 A1.1) — sibling migrations, same idiom as initDatabase's other
  // ALTERs. `written_section_anchors_json` = JSON array of anchors the turn
  // actually WROTE (effect set = uniq(changed), `[]` for no-write turns —
  // editTargets are audit signals, never counted as writes, D-4). `change_count`
  // = the RAW fs-diff section-change cardinality (D-5). The idempotent
  // NULL-guarded backfill below reconstructs both for historical rows.
  try { db.exec(`ALTER TABLE plan_events ADD COLUMN written_section_anchors_json TEXT`); } catch { /* column already exists */ }
  try { db.exec(`ALTER TABLE plan_events ADD COLUMN change_count INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }
  // Fix-4 (witnessed repo-activity) — nullable JSON blob of the turn's capped repo
  // evidence (RepoActivityEvidenceV1). NULL = pre-fix-4 / not captured (no backfill:
  // historical windows are unreconstructable). Guarded by a hard byte cap at write
  // time + tolerant parse on read, so the column can never break the row or projection.
  try { db.exec(`ALTER TABLE plan_events ADD COLUMN repo_activity_json TEXT`); } catch { /* column already exists */ }

  // plan_section_touches — read=intent + edit-target breadcrumbs (R2 §2.1). Keeps
  // its own `section_anchor` column (rename is scoped to plan_events only). The
  // resolve_payload column stores native-edit material (old_string hash+slices /
  // apply_patch hunk context) for the Stop-time resolver.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_section_touches (
      id             TEXT PRIMARY KEY,        -- row uuid
      agent_id       TEXT NOT NULL,
      plan_id        TEXT NOT NULL,           -- resolved from tool args, else agents.plan_id
      section_anchor TEXT NOT NULL,           -- the data-anchor named/resolved (or pending sentinel)
      block_anchor   TEXT,                    -- optional sub-section anchor (N7)
      tool           TEXT NOT NULL,           -- 'read_plan_section' | 'list_plan_sections' | 'read_plan_projection' | 'edit' | 'apply_patch' | 'write'
      kind           TEXT NOT NULL,           -- 'read' | 'edit-target'
      read_mode      TEXT,                    -- for reads: 'outline'|'text'|'raw'|'raw+editWindow'|...
      source         TEXT NOT NULL,           -- 'handler' | 'transcript'
      tool_use_id    TEXT,                    -- dedup key across the two sources
      resolve_payload TEXT,                   -- edit-target material for Stop-time anchor resolution
      observed_at    TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pst_agent_time ON plan_section_touches (agent_id, observed_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pst_plan ON plan_section_touches (plan_id, section_anchor)`);

  // plan_section_changes — effect store (R2 §2.4). One row per section/block whose
  // byte-exact inner-HTML hash moved on a reparse. Keeps its `section_anchor`
  // column (rename scoped to plan_events only).
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_section_changes (
      id             TEXT PRIMARY KEY,
      plan_id        TEXT NOT NULL,
      section_anchor TEXT NOT NULL,
      block_anchor   TEXT,
      content_hash   TEXT NOT NULL,      -- hash of the section's byte-exact inner HTML after reparse
      changed_at     TEXT NOT NULL       -- reparse timestamp
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_psc_plan_time ON plan_section_changes (plan_id, changed_at)`);

  // GT-A WP-A1 (§2 A1.4) — reconstruct written-sets/change_count for pre-column
  // plan_events rows. Called AFTER plan_section_changes exists (it reads that
  // table). NULL-guarded + idempotent: a strict no-op once every row is backfilled.
  backfillPlanEventWrittenSets();

  // WP4: snapshot history (amendments §F-B, DDL verbatim). Content-addressed blob
  // split — each distinct HTML body stored exactly ONCE globally; plan_snapshots is
  // the per-plan ordered reference history (consecutive-dedup skips no-op reparses).
  // An A→B→A cycle reuses A's blob via INSERT OR IGNORE. Both FKs → tables above.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_snapshot_blobs (
      content_hash  TEXT PRIMARY KEY,   -- sha256 hex of the full HTML
      html          TEXT NOT NULL,
      byte_size     INTEGER NOT NULL,
      first_seen_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_snapshots (
      id           TEXT PRIMARY KEY,    -- row uuid
      plan_id      TEXT NOT NULL,       -- FK → plans.id
      content_hash TEXT NOT NULL,       -- FK → plan_snapshot_blobs.content_hash
      created_at   TEXT NOT NULL        -- reparse timestamp
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_snapshots_plan_time ON plan_snapshots (plan_id, created_at)`);

  // Context-brick Phase 1 — one-time, best-effort lineage backfill from the
  // append-only events trail. Per-agent guarded (skips agents already carrying
  // rows) + ON CONFLICT DO NOTHING, so it is idempotent across boots and never
  // fights the live gen-0/transition inserts. Wrapped so a malformed payload
  // can never crash DB init.
  try {
    backfillAgentSessionsFromEvents();
  } catch (err) {
    console.warn('[database] agent_sessions backfill failed:', err);
  }

  initContextOptimizerSchema();
  initMemoryV2Schema();
}

// ─────────────────────────────────────────────────────────────────────────────
// Context-optimizer WP2 — parse-foundation schema (P0 + WP2b, ONE parser_version,
// ONE backfill). Self-contained, ADDITIVE region: every statement is
// CREATE TABLE/INDEX IF NOT EXISTS or a guarded ALTER, so it is idempotent and
// never reorders or mutates any pre-existing region (incl. the planning-surface
// `plan_*` provenance spine above, which is a DIFFERENT workstream's "WP2").
// Specs of record: dashboard-skill-observability-tools.md §P0.6/P0.7;
// behavior-grounded-optimizer-design.md §4.1; hardening-wp2b-capture.md §1;
// hardening-epochs-outcomes.md §1 (config_* / optimizer_* CREATEs land here,
// writers live in WP5/WP6 — Fix-6).
// ─────────────────────────────────────────────────────────────────────────────
function initContextOptimizerSchema(): void {
  // WAL is already enabled at init (line ~23); no pragma needed here (wp2b §1.6).

  // ── P0.6 — monotonic parse cursor (byte_offset = start of next unparsed line) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_parse_cursors (
      jsonl_path        TEXT PRIMARY KEY,
      first_fingerprint TEXT NOT NULL DEFAULT '',   -- rotation/rebuild discriminator (P0.3)
      byte_offset       INTEGER NOT NULL DEFAULT 0,
      size_bytes        INTEGER NOT NULL DEFAULT 0,
      parser_version    INTEGER NOT NULL DEFAULT 1,
      last_parsed_at    INTEGER NOT NULL DEFAULT 0
    );
  `);

  // ── P0.6 — skill invocations (window rows) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_invocations (
      id            TEXT PRIMARY KEY,            -- tool_use: \`\${entryUuid}#\${blockIndex}\`; slash: \`\${entryUuid}#slash:\${matchIndex}\`
      stream_id     TEXT NOT NULL,               -- normalized jsonl_path — window key
      jsonl_path    TEXT NOT NULL,
      session_id    TEXT,
      parent_session_id TEXT,                    -- subagent files; null for top-level
      sub_agent_name TEXT,                       -- \`agent-*\` stem; null for top-level
      working_dir   TEXT, workspace_root TEXT, slug TEXT,
      ts_ms         INTEGER NOT NULL,
      skill_name    TEXT NOT NULL, args TEXT,
      detector      TEXT NOT NULL,               -- 'tool_use' | 'slash_command'
      window_open        INTEGER NOT NULL DEFAULT 1,
      window_last_ts     INTEGER,
      window_tool_calls  INTEGER NOT NULL DEFAULT 0,
      window_error_results INTEGER NOT NULL DEFAULT 0,
      window_output_tokens INTEGER NOT NULL DEFAULT 0,
      window_dur_ms      INTEGER,
      ended_with_question INTEGER,
      repeated_search    INTEGER,
      window_truncated   INTEGER NOT NULL DEFAULT 0,
      effectiveness_score REAL
    );
    CREATE INDEX IF NOT EXISTS idx_skill_inv_ts     ON skill_invocations(ts_ms);
    CREATE INDEX IF NOT EXISTS idx_skill_inv_skill  ON skill_invocations(skill_name);
    CREATE INDEX IF NOT EXISTS idx_skill_inv_stream ON skill_invocations(stream_id, window_open);
  `);
  // Gap-A (classifier addendum §1): time bounds for bypass window-exclusion.
  try { db.exec(`ALTER TABLE skill_invocations ADD COLUMN start_ts_ms INTEGER`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE skill_invocations ADD COLUMN end_ts_ms   INTEGER`); } catch { /* exists */ }
  // Gap-A index (classifier addendum §1): bypass window-exclusion join by stream + ts bounds.
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_si_stream_ts ON skill_invocations(stream_id, start_ts_ms, end_ts_ms)`); } catch { /* exists */ }
  // A8 (wp2b §1.3) — per-window usage rollup persisted at finalize (skill_window_events is pruned).
  try { db.exec(`ALTER TABLE skill_invocations ADD COLUMN start_turn_index INTEGER`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE skill_invocations ADD COLUMN end_turn_index   INTEGER`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE skill_invocations ADD COLUMN window_fresh_input_tokens  INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE skill_invocations ADD COLUMN window_cache_read_tokens   INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE skill_invocations ADD COLUMN window_usage_output_tokens INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE skill_invocations ADD COLUMN window_usage_turns         INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }

  // ── P0.7 — exactly-once counter guard for window-affecting events ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_window_events (
      id            TEXT PRIMARY KEY,            -- \`\${entryUuid}#\${blockIndex}:\${eventKind}\`
      invocation_id TEXT NOT NULL,
      ts_ms         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_swe_inv ON skill_window_events(invocation_id);
  `);

  // ── P0.6 — search events (unioned with behavior_events by behavior-store) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_events (
      id            TEXT PRIMARY KEY,            -- \`\${entryUuid}#\${blockIndex}\`
      stream_id     TEXT NOT NULL,
      invocation_id TEXT,                        -- open window on this stream, if any
      slug TEXT, working_dir TEXT, ts_ms INTEGER NOT NULL,
      tool_name TEXT,
      normalized_query TEXT NOT NULL,
      search_signature_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_hash ON search_events(search_signature_hash);
  `);
  // Fix-8 (wp2b §1.5) — citation columns so search hits are citable / A9-eligible.
  try { db.exec(`ALTER TABLE search_events ADD COLUMN entry_uuid  TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE search_events ADD COLUMN block_index INTEGER`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE search_events ADD COLUMN byte_offset INTEGER`); } catch { /* exists */ }

  // ── P0.6 — effectiveness signals (two-tier, extensible rows; see P2.4) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_effectiveness_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invocation_id TEXT NOT NULL,
      signal        TEXT NOT NULL,               -- 'tool_error','repeated_search','ended_with_question',…
      tier          TEXT NOT NULL,               -- 'observable' | 'heuristic'
      value_num     REAL, value_text TEXT,
      window_json   TEXT,
      created_at    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_eff_inv ON skill_effectiveness_signals(invocation_id);
  `);

  // ── design §4.1 — behavior events (generic tool-use/outcome histogram) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS behavior_events (
      id             TEXT PRIMARY KEY,          -- \`\${entryUuid}#\${blockIndex}:\${kind}:\${eventOrdinal}\` (wp2b §1.1)
      stream_id      TEXT NOT NULL,
      entry_uuid     TEXT, block_index INTEGER,
      byte_offset    INTEGER NOT NULL,          -- citation pointer
      ts_ms          INTEGER NOT NULL,
      session_id     TEXT, sub_agent_name TEXT, slug TEXT,
      kind           TEXT NOT NULL,             -- 'tool_use' | 'tool_result' | 'file_touch' | 'turn_outcome'
      tool_name      TEXT,
      tool_kind      TEXT,                      -- 'builtin' | 'mcp' | 'skill'
      mcp_toolset    TEXT,
      command_family TEXT,
      arg_path       TEXT,                      -- canonical normalized target path (LOWER() is the heat key)
      input_shape_hash TEXT,
      outcome        TEXT,
      observable     INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_be_stream  ON behavior_events(stream_id);
    CREATE INDEX IF NOT EXISTS idx_be_tool    ON behavior_events(tool_name);
    CREATE INDEX IF NOT EXISTS idx_be_toolset ON behavior_events(mcp_toolset);
    CREATE INDEX IF NOT EXISTS idx_be_family  ON behavior_events(command_family);
    CREATE INDEX IF NOT EXISTS idx_be_shape   ON behavior_events(input_shape_hash);
    CREATE INDEX IF NOT EXISTS idx_be_ts      ON behavior_events(ts_ms);
  `);
  // wp2b §1.1 — event-identity ordinal + A1 executed-file capture columns.
  try { db.exec(`ALTER TABLE behavior_events ADD COLUMN event_ordinal INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE behavior_events ADD COLUMN access_mode         TEXT`); } catch { /* exists */ } // 'read'|'write'|'executed'
  try { db.exec(`ALTER TABLE behavior_events ADD COLUMN arg_path_raw        TEXT`); } catch { /* exists */ } // exactly as seen
  try { db.exec(`ALTER TABLE behavior_events ADD COLUMN arg_path_confidence TEXT`); } catch { /* exists */ } // 'exact'|'normalized'|'unresolved'
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_be_argpath     ON behavior_events(arg_path)`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_be_access_mode ON behavior_events(access_mode)`); } catch { /* exists */ }
  // WP-1B (Priority 0) — cwd-RESOLVED path identity for the guidance→file-access match.
  //   arg_path_canonical    : the raw arg resolved against the stream's recorded cwd and
  //                           folded to a single Windows/WSL/POSIX form (LOWER() is the key).
  //   arg_path_workspace_rel: root-anchored workspace-relative form (fwd-slash), when known.
  // Historical rows have neither → they stay unresolved and are NEVER suffix-matched.
  try { db.exec(`ALTER TABLE behavior_events ADD COLUMN arg_path_canonical     TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE behavior_events ADD COLUMN arg_path_workspace_rel TEXT`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_be_argpath_canon ON behavior_events(arg_path_canonical)`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_be_argpath_wsrel ON behavior_events(arg_path_workspace_rel)`); } catch { /* exists */ }
  // R2 WP-4B (Step 3) — redaction-safe exemplar drill. The SORTED input KEY NAMES (the
  // same set that produced `input_shape_hash`), comma-joined. Key names only — never a
  // value — so a cluster-exemplar drill can show the input SHAPE without leaking any raw
  // input. Historical rows have NULL → the drill degrades to the tool short name only.
  try { db.exec(`ALTER TABLE behavior_events ADD COLUMN input_key_set TEXT`); } catch { /* exists */ }

  // ── design §4.1 — single home of lane + exposure denominator (one row per stream) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS stream_lane_stats (
      stream_id   TEXT PRIMARY KEY,
      lane        TEXT NOT NULL,                -- 'supervisor'|'worker'|'researcher'|'legacy'|'unknown'
      slug        TEXT,
      working_dir TEXT,
      turn_count  INTEGER NOT NULL DEFAULT 0,   -- end_turn events = exposure denominator
      first_ts_ms INTEGER, last_ts_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sls_lane ON stream_lane_stats(lane);
  `);
  // A3 — subagent flag (stream path under /subagents/); lane still inherited from cwd.
  try { db.exec(`ALTER TABLE stream_lane_stats ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  // A10 — workspace attribution (first-entry launch cwd folded to its workspace root).
  try { db.exec(`ALTER TABLE stream_lane_stats ADD COLUMN workspace_root TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE stream_lane_stats ADD COLUMN workspace_id   TEXT`); } catch { /* exists */ }
  // WP-2B (Priority 0) — record HOW a workspace_id was derived ('explicit' launch-time
  // association vs 'root' cwd-fold) + the resolver version, so a later correction never
  // masquerades as a direct ingestion-time identity. NULL on rows with no workspace id.
  try { db.exec(`ALTER TABLE stream_lane_stats ADD COLUMN workspace_attribution_method  TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE stream_lane_stats ADD COLUMN workspace_attribution_version INTEGER`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_sls_workspace ON stream_lane_stats(workspace_id)`); } catch { /* exists */ }

  // ── A8 (wp2b §1.2) — per-turn usage (entry-level id; NOT stream+turn_index) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_usage (
      id                    TEXT PRIMARY KEY,          -- \`\${entryUuid}:usage\`
      stream_id             TEXT NOT NULL,
      invocation_id         TEXT,                      -- open skill window on this stream at usage time, else null
      session_id            TEXT,
      is_subagent           INTEGER NOT NULL DEFAULT 0,
      ts_ms                 INTEGER NOT NULL,
      turn_index            INTEGER NOT NULL,          -- monotonic assistant-turn ordinal (ORDERING ONLY)
      model                 TEXT,
      input_tokens          INTEGER NOT NULL DEFAULT 0,  -- fresh UNCACHED input (marginal spend)
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,  -- context written to cache (marginal spend)
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,  -- resident re-read (NOT spend; separate)
      output_tokens         INTEGER NOT NULL DEFAULT 0   -- generation (marginal spend)
    );
    CREATE INDEX IF NOT EXISTS idx_tu_stream ON turn_usage(stream_id);
    CREATE INDEX IF NOT EXISTS idx_tu_inv    ON turn_usage(invocation_id);
    CREATE INDEX IF NOT EXISTS idx_tu_ts     ON turn_usage(ts_ms);
  `);

  // ── A9 (wp2b §1.4) — trigger-phrase snippets (over-captured in WP2; WP5 filters) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS trigger_snippets (
      event_id          TEXT PRIMARY KEY,   -- skill_invocations.id OR behavior_events.id OR search_events.id
      event_type        TEXT NOT NULL,      -- 'skill_invocation'|'executed_file'|'command'|'search'
      stream_id         TEXT NOT NULL,
      snippet           TEXT,               -- truncated; NULL when no qualifying message
      snippet_hash      TEXT,               -- sha256 of FULL normalized source text
      source_kind       TEXT NOT NULL,      -- 'user_message'|'supervisor_brief'|'subagent_brief'|'command_args'|'none'
      source_entry_uuid TEXT,
      source_byte_offset INTEGER,
      distance_entries  INTEGER,
      selection_reason  TEXT NOT NULL,      -- 'matched' | 'no_qualifying_user_message'
      src_ts_ms         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ts_stream ON trigger_snippets(stream_id);
    CREATE INDEX IF NOT EXISTS idx_ts_hash   ON trigger_snippets(snippet_hash);
  `);

  // ── A6 (wp2b §1.6) — backfill state marker ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_analytics_meta (k TEXT PRIMARY KEY, v TEXT);
  `);

  // ── A2 (hardening-epochs-outcomes §1) — config/optimizer ledger: CREATEs ONLY.
  // Writers live in WP5 resident-inventory (anchors/epochs) + WP6 (actions/links)
  // — Fix-6. WP2 must NOT write these; it only guarantees the tables exist.
  db.exec(`
    CREATE TABLE IF NOT EXISTS config_section_anchors (
      anchor_uid          TEXT PRIMARY KEY,
      target_type         TEXT NOT NULL,
      target_key          TEXT NOT NULL,
      section_key         TEXT NOT NULL,
      anchor_kind         TEXT NOT NULL,
      current_source_path TEXT,
      current_heading_text TEXT,
      current_heading_path TEXT,
      current_line_start  INTEGER,
      current_line_end    INTEGER,
      last_content_hash   TEXT,
      last_semantic_fingerprint TEXT,
      created_at_ms       INTEGER NOT NULL,
      updated_at_ms       INTEGER NOT NULL,
      UNIQUE(target_type, target_key, anchor_uid)
    );
    CREATE INDEX IF NOT EXISTS idx_csa_target ON config_section_anchors(target_type, target_key);

    CREATE TABLE IF NOT EXISTS config_epochs (
      id                    TEXT PRIMARY KEY,
      section_key           TEXT NOT NULL,
      anchor_uid            TEXT NOT NULL,
      target_type           TEXT NOT NULL,
      target_key            TEXT NOT NULL,
      lanes_json            TEXT NOT NULL,
      source_kind           TEXT NOT NULL,
      source_path           TEXT NOT NULL,
      source_symbol         TEXT,
      heading_text          TEXT,
      heading_path          TEXT,
      content_hash          TEXT NOT NULL,
      semantic_fingerprint  TEXT NOT NULL,
      first_seen_ms         INTEGER NOT NULL,
      first_seen_source     TEXT NOT NULL,
      first_seen_confidence TEXT NOT NULL,
      origin_first_seen_ms  INTEGER,
      last_seen_ms          INTEGER,
      last_seen_reason      TEXT,
      superseded_by         TEXT,
      moved_from_epoch_id   TEXT,
      moved_to_section_key  TEXT,
      parser_version        INTEGER NOT NULL,
      created_at_ms         INTEGER NOT NULL,
      updated_at_ms         INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ce_open ON config_epochs(section_key) WHERE last_seen_ms IS NULL;
    CREATE INDEX IF NOT EXISTS idx_ce_anchor ON config_epochs(anchor_uid);
    CREATE INDEX IF NOT EXISTS idx_ce_target ON config_epochs(target_type, target_key);
    CREATE INDEX IF NOT EXISTS idx_ce_hash   ON config_epochs(content_hash);

    CREATE TABLE IF NOT EXISTS optimizer_actions (
      id                    TEXT PRIMARY KEY,
      proposal_id           TEXT,
      kind                  TEXT NOT NULL,
      lane                  TEXT,
      target_json           TEXT NOT NULL,
      target_predicate_hash TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'marked_applied',
      applied_at_ms         INTEGER NOT NULL,
      detected_at_ms        INTEGER,
      after_start_ms        INTEGER,
      reverted_at_ms        INTEGER,
      note                  TEXT,
      created_at_ms         INTEGER NOT NULL,
      updated_at_ms         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oa_proposal  ON optimizer_actions(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_oa_predicate ON optimizer_actions(target_predicate_hash);
    CREATE INDEX IF NOT EXISTS idx_oa_applied   ON optimizer_actions(applied_at_ms);

    CREATE TABLE IF NOT EXISTS optimizer_action_epoch_links (
      action_id  TEXT NOT NULL,
      epoch_id   TEXT NOT NULL,
      relation   TEXT NOT NULL,
      confidence TEXT NOT NULL,
      PRIMARY KEY(action_id, epoch_id, relation)
    );

    -- classifier addendum §2.5 — user-editable, retroactive file-coverage ignore-list.
    CREATE TABLE IF NOT EXISTS file_coverage_ignores (
      id             TEXT PRIMARY KEY,
      pattern        TEXT NOT NULL,        -- normalized (LOWER, wp2b §4.3 path form)
      pattern_kind   TEXT NOT NULL,        -- 'glob' | 'path-prefix' | 'exact-path'
      scope          TEXT NOT NULL,        -- 'global' | 'lane' | 'workspace'
      lane           TEXT,                 -- when scope='lane'
      workspace_slug TEXT,                 -- when scope='workspace'
      reason         TEXT NOT NULL,
      created_by     TEXT NOT NULL,        -- 'system-default' | 'human'
      created_at_ms  INTEGER NOT NULL,
      disabled_at_ms INTEGER               -- soft-delete: disabling re-exposes historical rows
    );
    CREATE INDEX IF NOT EXISTS idx_fci_scope ON file_coverage_ignores(scope, disabled_at_ms);

    -- classifier addendum §4 — per-lane compiler-parity sign-off (WP6 IPC writer; no MCP mutation).
    CREATE TABLE IF NOT EXISTS optimizer_derivation_verifications (
      gate_name                     TEXT PRIMARY KEY,   -- '<lane>-compiler-parity'
      lane                          TEXT NOT NULL,
      status                        TEXT NOT NULL,      -- 'unverified'|'verified'|'stale'|'mismatch'|'no-reference'
      parser_version                INTEGER NOT NULL,
      compiler_version              INTEGER NOT NULL,   -- PREDICTED_ACTION_COMPILER_VERSION
      corpus_fingerprint            TEXT NOT NULL,
      config_fingerprint            TEXT NOT NULL,
      toolset_inventory_fingerprint TEXT NOT NULL,
      empirical_report_fingerprint  TEXT NOT NULL,
      signed_histogram_json         TEXT NOT NULL,      -- {lane: orchestrationInvocations} at sign-off
      signed_split_json             TEXT NOT NULL,      -- {occurs,never,insufficient,unobservable}
      artifact_path                 TEXT NOT NULL,
      artifact_sha256               TEXT NOT NULL,
      signed_off_by                 TEXT,
      signed_off_at_ms              INTEGER,
      notes                         TEXT                -- explanation of any accepted deltas
    );
    CREATE INDEX IF NOT EXISTS idx_odv_lane ON optimizer_derivation_verifications(lane);
  `);

  // Git-Native WP-A0 — durable turn spine + recovery-operation ledger. Lands
  // before the checkpoint engine so that service fills these columns rather
  // than defining them. `agent_id`/`agent_title` are PLAIN attributes with NO
  // FK cascade (memory §4.2): deleteAgent must never purge these rows.
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_records (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      turn_seq INTEGER NOT NULL,
      agent_id TEXT, agent_title TEXT,          -- plain attributes, NO FK cascade
      owner_agent_id TEXT, owner_brick_generation INTEGER,  -- stamped server-side at dispatch
      session_id TEXT, task_label TEXT,
      started_at INTEGER, ended_at INTEGER,
      status TEXT NOT NULL DEFAULT 'open',       -- see transition table in accessors
      before_oid TEXT, after_oid TEXT,           -- CANDIDATE commit OIDs, persisted inside finalize
      before_ref TEXT, after_ref TEXT,           -- deterministic ref names (encoder, G1.3a)
      before_ready INTEGER NOT NULL DEFAULT 0,   -- edge verified: ref exists AND == oid
      after_ready  INTEGER NOT NULL DEFAULT 0,
      before_quality TEXT,                       -- BOUNDARY: guaranteed | late | degraded
      after_quality  TEXT,                       -- hook | session-log | terminal | idle-fallback | none
      before_raw_filter_bypassed INTEGER NOT NULL DEFAULT 0, -- CONTENT semantics, BEFORE edge only
      before_filtered_paths TEXT,                -- JSON [path,...], BEFORE edge only
      before_pruned_at INTEGER, after_pruned_at INTEGER,  -- hints; git rev-parse is the authority
      touched TEXT,                              -- JSON [{path, op}] witnessed write/create
      diff_stats TEXT,                           -- JSON {witnessed:{...}, window:{...}}
      compact_diff TEXT,                         -- WITNESSED-PATH diff only, bounded (~100KB)
      compact_diff_provenance TEXT,              -- always 'witnessed' (never raw-window)
      failure_reason TEXT,
      UNIQUE(workspace_id, turn_seq)
    );
    CREATE TABLE IF NOT EXISTS recovery_operations (
      id TEXT PRIMARY KEY,                -- operationId
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL,                 -- restore_paths | revert_turn | whole_tree(human)
      actor TEXT NOT NULL,                -- supervisor agentId | 'human-ipc'
      source_turn_id TEXT,
      pre_ref TEXT, pre_oid TEXT,         -- refs/lares/recovery/<enc(ws)>/<enc(operationId)>/pre
      pre_ready INTEGER NOT NULL DEFAULT 0,  -- pre-restore safety checkpoint verified
      pre_included_paths TEXT,           -- JSON [{ path, state, oid?, mode? }] (path-scoped, NON-ignored only)
      requested_paths TEXT,              -- JSON
      preview_token TEXT,
      status TEXT NOT NULL,              -- pending | ready | completed | partial | failed
      completed_paths TEXT,              -- JSON — partial-restore recoverability
      result TEXT, failure_reason TEXT,
      created_at INTEGER, ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_turn_records_ws_seq ON turn_records(workspace_id, turn_seq);
    CREATE INDEX IF NOT EXISTS idx_turn_records_agent ON turn_records(agent_id);
  `);

  // Save-card SC-WP-2A — immutable plan attribution, frozen at turn-open.
  // SQLite has no ADD COLUMN IF NOT EXISTS, so legacy databases use the same
  // guarded migration idiom as agents.plan_id. These are plain attributes: no
  // FK/cascade may erase historical attribution when an agent is deleted.
  try { db.exec(`ALTER TABLE turn_records ADD COLUMN plan_id TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE turn_records ADD COLUMN plan_item_id TEXT`); } catch { /* exists */ }
  try {
    db.exec(`ALTER TABLE turn_records ADD COLUMN plan_stamp_source TEXT NOT NULL
      DEFAULT 'legacy-unstamped'
      CHECK (plan_stamp_source IN ('legacy-unstamped', 'explicit', 'agent-default',
        'fork-carry', 'revive-carry', 'continuation-carry', 'explicit-none',
        'unbound-manual'))`);
  } catch { /* exists */ }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_turn_records_ws_plan_seq
      ON turn_records(workspace_id, plan_id, turn_seq);
    CREATE INDEX IF NOT EXISTS idx_turn_records_ws_plan_item_seq
      ON turn_records(workspace_id, plan_item_id, turn_seq);
    CREATE TRIGGER IF NOT EXISTS turn_records_plan_stamp_immutable
    BEFORE UPDATE OF plan_id, plan_item_id, plan_stamp_source ON turn_records
    WHEN NEW.plan_id IS NOT OLD.plan_id OR NEW.plan_item_id IS NOT OLD.plan_item_id
      OR NEW.plan_stamp_source IS NOT OLD.plan_stamp_source
    BEGIN SELECT RAISE(ABORT, 'turn plan stamp is immutable'); END;
  `);

  // Save-card SC-WP-2G — durable commit-protection ledger. This DDL is the
  // byte-for-byte column contract from the shared bundle specification. The
  // cached pushed count is deliberately only a reconciliation hint; protection
  // reads prove remote reachability from live remote-tracking refs.
  db.exec(`
    CREATE TABLE IF NOT EXISTS commit_records (
      repository_key TEXT NOT NULL,
      commit_oid TEXT NOT NULL,
      parent_oid TEXT,
      observed_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      pushed_remote_count INTEGER NOT NULL DEFAULT 0,
      last_reconciled_at INTEGER,
      PRIMARY KEY (repository_key, commit_oid),
      CHECK (source IN ('lares','external')),
      CHECK (pushed_remote_count >= 0)
    );
    CREATE TABLE IF NOT EXISTS commit_turn_links (
      repository_key TEXT NOT NULL,
      commit_oid TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      plan_id TEXT, plan_item_id TEXT,
      relation TEXT NOT NULL,
      capture_quality TEXT,
      PRIMARY KEY (repository_key, commit_oid, turn_id),
      CHECK (relation IN ('candidate_member','exact_path_match','metadata_only'))
    );
    CREATE TABLE IF NOT EXISTS commit_path_links (
      repository_key TEXT NOT NULL,
      commit_oid TEXT NOT NULL,
      path_bytes_base64 TEXT NOT NULL,
      expected_state TEXT NOT NULL,
      raw_blob_oid_at_commit TEXT,
      commit_blob_oid TEXT,
      commit_mode TEXT,
      contributing_turn_ids TEXT,
      overlap_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (repository_key, commit_oid, path_bytes_base64),
      CHECK (expected_state IN ('present','absent')),
      CHECK (overlap_count >= 0)
    );
  `);

  // Save-card SC-WP-3A — plan_work_packages: the authoritative item entity that
  // item stamping validates against (§11 of the shared bundle contract). Until
  // this table lands, a non-null plan_item_id is REJECTED as unsupported; it is
  // never equated with plan_sections.anchor (that would bake legacy HTML plan
  // architecture into the new structured model) and never validated through an
  // always-true seam. Item validation is against (workspace_id, plan_id, id).
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_work_packages (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      title TEXT NOT NULL,
      acceptance_condition TEXT,
      state TEXT NOT NULL,
      assignee_agent_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (state IN ('ready','executing','blocked','done','archived')),
      CHECK (revision > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_plan_work_packages_plan ON plan_work_packages(plan_id);
  `);

  // Save-card SC-WP-3B — package_finalizations (§5 of the shared bundle contract):
  // the finalization boundary frozen by an explicit human/supervisor plan-package
  // `done` transition or a DISTINCT fleet-adhoc mark-done/mint step. No boundary is
  // ever auto-derived from `accepted`. `member_manifest_json` freezes the per-path
  // manifest (raw --no-filters + clean-filtered) at finalize time; `boundary_ref` is
  // the durable Lares ref retention treats as protected while lifecycle_status='active'.
  // WP-3B lands only the schema + lifecycle accessors; the ordering/re-finalization/
  // restart SERVICE is WP-3C. The plan-item revision uniqueness is partial (plan-package
  // only) so fleet-adhoc rows (plan_item_id NULL) never contend on it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS package_finalizations (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL,
      repository_key TEXT NOT NULL,
      finalization_kind TEXT NOT NULL,
      plan_id TEXT,
      plan_item_id TEXT,
      package_revision INTEGER NOT NULL,
      finalized_at INTEGER NOT NULL,
      finalized_by TEXT NOT NULL,
      checkpoint_turn_id TEXT,
      checkpoint_oid TEXT,
      boundary_ref TEXT,
      boundary_status TEXT NOT NULL,
      lifecycle_status TEXT NOT NULL,
      superseded_by_finalization_id TEXT,
      released_at INTEGER,
      member_manifest_json TEXT NOT NULL,
      contract_version INTEGER NOT NULL,
      failure_reason TEXT,
      created_from_workspace_id TEXT,
      CHECK (finalization_kind IN ('plan-package','fleet-adhoc')),
      CHECK (boundary_status IN ('ready','unavailable','pruned')),
      CHECK (lifecycle_status IN ('active','superseded','committed','abandoned')),
      CHECK (package_revision > 0),
      CHECK (
        (finalization_kind='plan-package' AND plan_id IS NOT NULL AND plan_item_id IS NOT NULL)
        OR
        (finalization_kind='fleet-adhoc'  AND plan_id IS NULL AND plan_item_id IS NULL)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_package_finalizations_revision
      ON package_finalizations(package_id, package_revision);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_package_finalizations_plan_revision
      ON package_finalizations(plan_item_id, package_revision) WHERE finalization_kind = 'plan-package';
    CREATE INDEX IF NOT EXISTS idx_package_finalizations_repo
      ON package_finalizations(repository_key, package_id);
  `);

  // Planning-surface WP-P2A — proposals registry table + plans folder/promotion
  // columns + md-row policy. DDL-serialized in the NEXT serial slot after
  // SC-WP-3A (plan_work_packages, §11) and SC-WP-3B (package_finalizations, §5)
  // inside this optimizer-schema init. The `plans` table is created in the B2
  // region of initDatabase() BEFORE this init runs, so the guarded ALTERs below
  // resolve; the ALTERs use the try/catch idiom (SQLite has no ADD COLUMN IF NOT
  // EXISTS). `responsible_supervisor_id` is deliberately NOT added here — it is
  // P3A's, with its own inline FK.
  //
  // `proposals`: filesystem-owned artifacts (flat `.lares/proposals/*.md`) the DB
  // INGESTS and enriches, never owns (§R0, ruling 10). Identity is
  // (workspace_id, path); `artifact_id` is the portable frontmatter id, unique
  // per workspace ONLY when present (partial index). `author_role` is
  // witnessed-first — 'unknown' until an attribution witness proves otherwise.
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposals (
      id                   TEXT PRIMARY KEY,
      artifact_id          TEXT,
      workspace_id         TEXT NOT NULL,
      path                 TEXT NOT NULL,
      slug                 TEXT,
      title                TEXT,
      state                TEXT NOT NULL DEFAULT 'proposal',
      author_agent_id      TEXT,
      author_role          TEXT NOT NULL DEFAULT 'unknown',
      author_display       TEXT,
      authored_at          INTEGER,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      mtime_ms             INTEGER,
      size_bytes           INTEGER,
      promoted_to_plan_id  TEXT,
      deleted_at           INTEGER,
      UNIQUE(workspace_id, path),
      CHECK (state IN ('proposal','promoted','archived')),
      CHECK (author_role IN ('supervisor','worker','unknown'))
    );
    CREATE INDEX IF NOT EXISTS idx_proposals_workspace ON proposals(workspace_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_artifact
      ON proposals(workspace_id, artifact_id) WHERE artifact_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_promoted_plan
      ON proposals(promoted_to_plan_id) WHERE promoted_to_plan_id IS NOT NULL;
  `);

  // FIVE guarded plans columns (exactly five — no more): the promotion + folder
  // linkage the P2/P3 pipeline enriches onto the structured plan row. All NULL for
  // legacy/proposal-only rows. `folder_rel_path` is the workspace-relative path of
  // the plan folder under <workspaceStateDir()>/plans/ (§R0), NULL for legacy HTML
  // rows. Partial unique indexes enforce one-per-workspace identity only when the
  // enriching value is present, so legacy NULL rows never collide.
  try { db.exec(`ALTER TABLE plans ADD COLUMN artifact_id TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE plans ADD COLUMN source_proposal_id TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE plans ADD COLUMN promoted_at INTEGER`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE plans ADD COLUMN promoted_content_hash TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE plans ADD COLUMN folder_rel_path TEXT`); } catch { /* exists */ }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_artifact
    ON plans(workspace_id, artifact_id) WHERE artifact_id IS NOT NULL`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_source_proposal
    ON plans(source_proposal_id) WHERE source_proposal_id IS NOT NULL`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_folder_rel_path
    ON plans(workspace_id, folder_rel_path) WHERE folder_rel_path IS NOT NULL`);

  // Planning-surface WP-P2L-schema — planning-intent LEDGER (STAGE P2L). DDL-
  // serialized in the NEXT serial slot after WP-P2A (above), inside this optimizer-
  // schema init. Two additive tables + one guarded ALTER on `orchestrations`
  // (created in initDatabase() BEFORE this init runs, so the ALTER resolves).
  //
  // SINGLE run-state authority stays in `orchestrations`; the ledger holds intent
  // identity/status + presence-aware output OBSERVATIONS only — NO copied
  // orchestration run-state, no second mutable run-state authority (rulings
  // 12–14/16/17/20). `plan_intents` identity is (plan_id, intent_id): `intent_id`
  // is unique only WITHIN a plan, so both the UNIQUE constraint and every join key
  // are composite. `plan_id` is NOT NULL — P2L depends on P2 folder adoption having
  // produced the `plans` row; `plan_artifact_id` is carried for display/lineage,
  // NOT identity. No `author_*` columns: authorship is the proposal record's, never
  // duplicated here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_intents (
      id                   TEXT PRIMARY KEY,
      workspace_id         TEXT NOT NULL,
      plan_id              TEXT NOT NULL,
      plan_artifact_id     TEXT NOT NULL,
      intent_id            TEXT NOT NULL,
      part_slug            TEXT,
      kind                 TEXT NOT NULL,
      targets_json         TEXT,
      reason               TEXT,
      source_doc_rel_path  TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'active',
      supersedes_intent_id TEXT,
      integration_note     TEXT,
      first_seen_at        INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL,
      last_scanned_at      INTEGER NOT NULL,
      UNIQUE(plan_id, intent_id),
      CHECK (kind IN ('groupthink-serial','groupthink-parallel','research')),
      CHECK (status IN ('active','withdrawn','superseded'))
    );
  `);

  // `plan_intent_outputs`: multiple runs → multiple rows; each is an OBSERVATION
  // (present/missing, disposition, folded_in) keyed by (plan_id, intent_id,
  // rel_path). The composite FK references plan_intents(plan_id, intent_id) — a
  // SAME-PLAN-only constraint that mechanically rejects a cross-plan output insert
  // (foreign_keys is ON, and the parent's table-level UNIQUE(plan_id, intent_id)
  // supplies the required unique index). `orchestration_id` is a self-declared
  // cross-check, NOT run-state authority — plain attribute, no FK cascade.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_intent_outputs (
      plan_id         TEXT NOT NULL,
      intent_id       TEXT NOT NULL,
      rel_path        TEXT NOT NULL,
      orchestration_id TEXT,
      present_on_disk INTEGER NOT NULL DEFAULT 1,
      disposition     TEXT NOT NULL DEFAULT 'active',
      folded_in       INTEGER NOT NULL DEFAULT 0,
      first_seen_at   INTEGER NOT NULL,
      last_present_at INTEGER,
      last_scanned_at INTEGER NOT NULL,
      PRIMARY KEY (plan_id, intent_id, rel_path),
      FOREIGN KEY (plan_id, intent_id) REFERENCES plan_intents(plan_id, intent_id),
      CHECK (present_on_disk IN (0,1)),
      CHECK (disposition IN ('active','superseded','withdrawn')),
      CHECK (folded_in IN (0,1))
    );
  `);

  // Guarded orchestration link: a PLAIN nullable attribute + a composite index for
  // the `ran` join. The join is on BOTH (plan_id, planning_intent_id) because
  // intent_id is unique only within a plan. try/catch ALTER idiom (SQLite has no
  // ADD COLUMN IF NOT EXISTS); the index is IF NOT EXISTS. No FK cascade to
  // orchestrations run-state — orchestrations stays the sole run-state authority.
  try { db.exec(`ALTER TABLE orchestrations ADD COLUMN planning_intent_id TEXT`); } catch { /* exists */ }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_orchestrations_plan_intent
    ON orchestrations(plan_id, planning_intent_id)`);

  // ── Planning-surface WP-P3A′ — responsibility + doc-link + tab-overview schema
  //    + promotion_requests (§R-A2). Single A2-serialized DDL slot, rebased onto the
  //    current initDatabase() head (immediately after the WP-P2L-schema plan_intents
  //    block above). Established guarded-migration idiom: CREATE TABLE/INDEX IF NOT
  //    EXISTS for tables/indexes, try/catch ALTER for the one column add (SQLite has
  //    no portable ADD COLUMN IF NOT EXISTS). `plans` and `agents` were created in
  //    the B2 region BEFORE this init runs, so every FK → plans(id)/agents(id) here
  //    resolves. supervisor_focus keeps its existing cascade — NOT altered here. ──

  // plans.responsible_supervisor_id — the plan's server-side responsible supervisor.
  // Inline FK → agents(id) ON DELETE SET NULL (deleting the supervisor nulls the
  // pointer, never the plan). Added ONLY here (P2A deliberately deferred it). Guarded
  // ALTER; SQLite permits ADD COLUMN with an inline REFERENCES clause because the new
  // column defaults to NULL. The SET NULL action fires only when foreign_keys is ON.
  try { db.exec(`ALTER TABLE plans ADD COLUMN responsible_supervisor_id TEXT REFERENCES agents(id) ON DELETE SET NULL`); } catch { /* exists */ }

  // supervisor_active_plan — at most one active plan per supervisor (supervisor_id is
  // the PK). BOTH FKs cascade: deleting the supervisor OR the referenced plan removes
  // the row (no dangling active-plan pointer survives either delete).
  db.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_active_plan (
      supervisor_id  TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      plan_id        TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      activated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_supervisor_active_plan_plan ON supervisor_active_plan(plan_id)`);

  // plan_documents — enrichment-time doc links, REL PATHS ONLY (no body column: the
  // §R0 folder is the document set, never mirrored). §P3-GAP: P3 writes exactly ONE
  // row per plan — the source proposal (doc_kind='proposal'). The doc_kind enum is
  // fixed here; no selection field/table exists. Cascades away with its plan.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_documents (
      id           TEXT PRIMARY KEY,
      plan_id      TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      doc_kind     TEXT NOT NULL,
      rel_path     TEXT NOT NULL,
      artifact_ref TEXT,
      tab          TEXT,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (doc_kind IN ('proposal','deliberation','research','legacy-html'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_documents_plan ON plan_documents(plan_id)`);

  // plan_tab_overviews — per-tab overview body, revisioned. PK(plan_id, tab): one
  // overview row per (plan, tab). Cascades away with its plan.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_tab_overviews (
      plan_id     TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      tab         TEXT NOT NULL,
      body        TEXT,
      revision    INTEGER NOT NULL DEFAULT 1,
      updated_by  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (plan_id, tab)
    )
  `);

  // promotion_requests (§R-A2 — frozen DDL; columns/constraints reproduced verbatim,
  // not altered). The durable cross-restart de-dup seam is
  // UNIQUE(workspace_id, proposal_artifact_id); CHECK(state) bounds the lifecycle set.
  // created_at/updated_at are INTEGER epochs (service-owned, not datetime defaults).
  db.exec(`
    CREATE TABLE IF NOT EXISTS promotion_requests (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      proposal_artifact_id TEXT NOT NULL,
      plan_artifact_id TEXT NOT NULL,
      target_folder_rel_path TEXT NOT NULL,
      supervisor_id TEXT,
      orchestration_id TEXT,
      state TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(workspace_id, proposal_artifact_id),
      CHECK (state IN ('pending','adopted','failed'))
    )
  `);

  // selection_comment_replies (WP-P4D-reply — A2 DDL slot; frozen shape from the
  // planning-surface plan §WP-P4D-reply / P4-P8 rescope §WP-P4D-reply). A COMPANION
  // reply row keyed to the question comment: it never overwrites selection_comments.body
  // and never overloads that row's delivery-status `status` machine. author_agent_id is
  // nullable (system/undeclared replies allowed); created_at is a service-owned INTEGER
  // epoch. The answer service + answer_plan_comment MCP tool are deferred (they depend
  // on WP-P4D-create) — this slot lands the guarded DDL only.
  db.exec(`
    CREATE TABLE IF NOT EXISTS selection_comment_replies (
      id TEXT PRIMARY KEY,
      comment_id TEXT NOT NULL REFERENCES selection_comments(id),
      body TEXT NOT NULL,
      author_agent_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  // Threads are read by comment_id (P4D-proj joins replies onto their question) —
  // index it, matching the sibling idx_plan_documents_plan(plan_id) precedent.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_selcomment_replies_comment
    ON selection_comment_replies(comment_id)`);

  // Planning-surface WP-P5A (schema + paths) — the A2-serialized DDL slot for the
  // first Stage-P5 nodes, rebased onto the current initContextOptimizerSchema()
  // head (immediately after the P4D selection_comment_replies block). Two COMPANION
  // tables over SC-WP-3A `plan_work_packages` (created above at the SC-WP-3A block,
  // so both FK → plan_work_packages(id) resolve). No 12th column is added to
  // SC-WP-3A's frozen 11-column shape; no lifecycle-state machine lands here (P5B
  // owns transitions). Guarded CREATE TABLE/INDEX IF NOT EXISTS idiom, matching the
  // sibling P3A/P4D DDL.

  // plan_work_package_layout (WP-P5A-schema) — the ordering companion. One row per
  // package (PK = package_id) carrying an explicit sort_order; packages with no row
  // fall back to created_at ordering in the projection. Cascades away with its
  // package so a deleted package leaves no dangling layout row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_work_package_layout (
      package_id  TEXT PRIMARY KEY REFERENCES plan_work_packages(id) ON DELETE CASCADE,
      sort_order  INTEGER NOT NULL
    )
  `);

  // plan_work_package_paths (WP-P5A-paths) — planned (workspace-relative) paths per
  // package; the populate seam is written from the editor and feeds P7B contention.
  // Composite PK (package_id, path) enforces one row per planned path per package
  // (idempotent re-save) without a synthetic id column. intent_kind is a free TEXT
  // hint ('edit'/'create'/'delete'/…); created_at is a service-owned INTEGER epoch.
  // The (workspace_id, path) index is the contention read seam. Cascades with its
  // package.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_work_package_paths (
      package_id    TEXT NOT NULL REFERENCES plan_work_packages(id) ON DELETE CASCADE,
      workspace_id  TEXT NOT NULL,
      path          TEXT NOT NULL,
      intent_kind   TEXT,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (package_id, path)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_wp_paths_ws_path
    ON plan_work_package_paths(workspace_id, path)`);

  // Planning-surface WP-P5B — plan_wp_lifecycle_events: the append-only ledger of
  // NON-terminal package state transitions (ready/executing/blocked/archived) on
  // SC-WP-3A plan_work_packages. WP-P5B's plan-lifecycle service is the sole writer.
  // It NEVER records a `done` transition — `done` is SC-WP-3C's authoritative
  // channel — and the CHECK(to_state IN (…)) makes a `done` to_state unledgerable at
  // the schema level. from_state is the recorded prior state (any value, including a
  // historical `done`, for faithful history). Cascades with its package. A2-serialized
  // DDL slot, immediately after the P5A companions.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_wp_lifecycle_events (
      id          TEXT PRIMARY KEY,
      package_id  TEXT NOT NULL REFERENCES plan_work_packages(id) ON DELETE CASCADE,
      plan_id     TEXT NOT NULL,
      from_state  TEXT NOT NULL,
      to_state    TEXT NOT NULL,
      actor       TEXT NOT NULL,
      reason      TEXT,
      ts          INTEGER NOT NULL,
      CHECK (to_state IN ('ready','executing','blocked','archived'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_wp_lifecycle_pkg
    ON plan_wp_lifecycle_events(package_id, ts)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_wp_lifecycle_plan
    ON plan_wp_lifecycle_events(plan_id, ts)`);

  // Planning-surface WP-P5C — plan_execution_runs: the durable record of a human
  // Implement trigger pull. One row per execution run of a structured plan, pinning
  // the execution BASELINE. `baseline_ref` is a durable Git ref
  // (`refs/lares/plans/<planId>/<runId>`) created at the pinned HEAD OID BEFORE this
  // row commits — an OID stored only in SQLite would not protect an unreachable
  // commit from Git GC, so the ref is what actually pins the baseline. The
  // (baseline_kind) CHECK plus the paired-nullability CHECK make the unborn case an
  // EXPLICIT marker (kind='unborn', no oid, no ref) rather than a bare nullable OID:
  // a `head` run must carry both an OID and a ref; an `unborn` run must carry
  // neither. `trigger_source` is always the app's factual origin tag
  // ('renderer-user-action') and `app_user_id` a real app-observed identity — never
  // a claimed human identity the app cannot prove. `lifecycle_state` starts 'active'
  // and is closed to 'archived' by WP-P5-archive (never here). Cascades with its
  // plan (plan deletion is the sole normal ref-release path — the ref sweep is the
  // reconciler in plan-baseline-refs.ts). A2-serialized DDL slot, after the P5B
  // ledger.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plan_execution_runs (
      id                 TEXT PRIMARY KEY,
      plan_id            TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      repository_key     TEXT,
      baseline_kind      TEXT NOT NULL CHECK (baseline_kind IN ('head','unborn')),
      baseline_head_oid  TEXT,
      baseline_ref       TEXT,
      trigger_source     TEXT NOT NULL,
      app_user_id        TEXT,
      triggered_at       INTEGER NOT NULL,
      lifecycle_state    TEXT NOT NULL CHECK (lifecycle_state IN ('active','archived')),
      CHECK (
        (baseline_kind = 'unborn' AND baseline_head_oid IS NULL AND baseline_ref IS NULL) OR
        (baseline_kind = 'head'   AND baseline_head_oid IS NOT NULL AND baseline_ref IS NOT NULL)
      )
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_exec_runs_plan
    ON plan_execution_runs(plan_id, lifecycle_state)`);

  // WP-2B (Priority 0) — one-time, resumable workspace-lineage backfill. Populates
  // stream_lane_stats.workspace_id/workspace_root by folding each stream's launch cwd
  // to a root owned by EXACTLY one workspace. Idempotent (only NULL rows, ON a unique
  // match) + wrapped so a malformed workspace path can never crash DB init.
  try {
    backfillStreamWorkspaceLineage();
  } catch (err) {
    console.warn('[database] workspace-lineage backfill failed:', err);
  }

  // Checkpoint Surface Hardening WP2 — remediate defect-1 pollution (OSC-8 /
  // terminal-escape residue) in the historical witness-bearing path stores. Follows
  // the file_activities cleanup precedent above (self-limiting via `looksPolluted`,
  // no version table); wrapped so a malformed row can never crash DB init.
  try {
    sanitizeHistoricalWitnessPaths(db);
  } catch (err) {
    console.warn('[database] WP2 witness-path sanitize migration failed:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory & Lessons v2 — durable state (WP-B). Self-contained, ADDITIVE region:
// every statement is CREATE TABLE/INDEX IF NOT EXISTS, so it is idempotent, never
// hand-drops a table on the shared DB, and never reorders any pre-existing region.
// The store/reconciliation layer lives in src/main/memory-index/review-store.ts
// (reached via getDb()); this function only guarantees the tables exist. Spec of
// record: plans/memory-lessons-v2-implementation.md §WP-B.
// ─────────────────────────────────────────────────────────────────────────────
function initMemoryV2Schema(): void {
  // Last-known-good SOURCE (not projected bytes) + durable runtime-error state.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_index_state (
      workspace_id          TEXT PRIMARY KEY,
      source_text           TEXT,
      source_hash           TEXT,
      parsed_json           TEXT,
      validated_at          TEXT,
      last_runtime_error    TEXT,
      last_runtime_error_at TEXT
    );
  `);

  // Pending-review queue. finding_id = sha256(workspace_id | kind |
  // COALESCE(entry_id,'') | source_hash), computed in JS by the store. status ∈
  // {pending, cleared, resolved}. Hard-invalid findings carry entry_id = NULL + a
  // whole-index source_hash. Rows are NEVER deleted (clear-not-delete).
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_review_queue (
      finding_id      TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL,
      kind            TEXT NOT NULL,
      entry_id        TEXT,
      source_hash     TEXT,
      reason          TEXT,
      exit_condition  TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      first_seen      TEXT NOT NULL,
      last_seen       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mrq_ws_status ON memory_review_queue(workspace_id, status);
  `);

  // Recall-only usage tally. Documented semantics: an approximate tally of
  // SUCCESSFUL recall API requests; one atomic increment per successful request;
  // NO idempotency key and therefore no retry deduplication; consumed only as a
  // `>0 vs 0` signal (never a precise count).
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_usage_counts (
      workspace_id  TEXT NOT NULL,
      entry_id      TEXT NOT NULL,
      count         INTEGER NOT NULL DEFAULT 0,
      last_recalled TEXT,
      PRIMARY KEY (workspace_id, entry_id)
    );
  `);

  // Canonical lesson registry — single enumeration source (enables cross-provider
  // drift repair). status ∈ {pending, active, conflict}. copies_json = intended
  // target paths; preexisted_json = which targets pre-existed at publish time.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_lessons (
      workspace_id    TEXT NOT NULL,
      lesson_id       TEXT NOT NULL,
      name            TEXT NOT NULL,
      canonical_hash  TEXT,
      copies_json     TEXT,
      preexisted_json TEXT,
      batch_id        TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TEXT NOT NULL,
      PRIMARY KEY (workspace_id, lesson_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mlessons_ws_name ON memory_lessons(workspace_id, name);
    CREATE INDEX IF NOT EXISTS idx_mlessons_batch   ON memory_lessons(batch_id);
  `);

  // Batch-level durable crash state for publish_lessons_batch. status ∈
  // {pending, active, conflict}.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_lesson_batches (
      batch_id      TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      snapshot_id   TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    TEXT NOT NULL
    );
  `);

  // Graduation proposals. status ∈ {pending, approved, applied, rejected,
  // needs-reapproval}. target_hash_at_proposal captures the target's hash (or an
  // explicit ABSENT sentinel) at proposal time for later CAS.
  db.exec(`
    CREATE TABLE IF NOT EXISTS graduation_proposals (
      proposal_id             TEXT PRIMARY KEY,
      workspace_id            TEXT NOT NULL,
      target                  TEXT NOT NULL,
      target_hash_at_proposal TEXT,
      text                    TEXT,
      rationale               TEXT,
      source_agent            TEXT,
      status                  TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_grad_ws_status ON graduation_proposals(workspace_id, status);
  `);

  // Signed migration approvals (keyed per snapshot).
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_approvals (
      workspace_id  TEXT NOT NULL,
      snapshot_id   TEXT NOT NULL,
      table_hash    TEXT,
      approved_by   TEXT,
      approved_at   TEXT,
      PRIMARY KEY (workspace_id, snapshot_id)
    );
  `);
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

/** WP5 — decode the `last_send` JSON blob into the typed SendOutcome field. */
function parseLastSend(raw: unknown): Agent['lastSend'] {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.disposition === 'string' &&
      typeof parsed.agentId === 'string' &&
      typeof parsed.delivered === 'boolean' &&
      typeof parsed.completedAt === 'number'
    ) {
      return parsed as NonNullable<Agent['lastSend']>;
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
    privilegeLane: row.privilege_lane === 'supervisor' ? 'supervisor' : undefined,
    // Bug 2 / Edit 2.6 — codex-persona hook parity. 1 → true, 0/NULL → false.
    wantsCodexHooks: !!row.wants_codex_hooks,
    tmuxSessionName: row.tmux_session_name,
    autoRestartEnabled: !!row.auto_restart_enabled,
    resumeSessionId: row.resume_session_id,
    status: row.status as AgentStatus,
    hookStatus: (row.hook_status || 'unknown') as Agent['hookStatus'],
    // WP2 (hook-absence-resilience) — DERIVED from hook_status (still the sole
    // authority; no new column). 'broken'/'degraded' → hooksUnavailable, with a
    // distinct reason for the card badge tooltip.
    ...deriveHookAvailability((row.hook_status || 'unknown') as Agent['hookStatus']),
    lastHookEventAt: row.last_hook_event_at ?? undefined,
    lastSendError: parseLastSendError(row.last_send_error),
    lastSend: parseLastSend(row.last_send),
    isAttached: !!row.is_attached,
    restartCount: row.restart_count,
    // Inc 4: continuation handoff generation (distinct from restart_count).
    continuationGeneration: row.continuation_generation ?? 0,
    // Per-agent continuation toggle: 0 → false; 1/NULL → true (default-enabled).
    continuationEnabled: row.continuation_enabled === 0 ? false : true,
    lastExitCode: row.last_exit_code,
    pid: row.pid,
    logPath: row.log_path,
    templateId: row.template_id || null,
    systemPrompt: row.system_prompt || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOutputAt: row.last_output_at,
    lastAttachedAt: row.last_attached_at,
    ownerAgentId: row.owner_agent_id || null,
    // notifyOwner mute: 1 → true, 0 → false, NULL/absent → true (default-notify).
    notifyOwner: row.notify_owner === 0 ? false : true,
    // Planning surface WP1: frozen-at-launch plan rail (NULL for unbound launches).
    planId: row.plan_id || null,
    planSection: row.plan_section || null,
    // Idle-agent lifecycle §B3.1. `status_changed_at` is nullable in SQLite
    // (rows written before the migration, or by a raw INSERT) but non-null at
    // the TS boundary — coalesce through the same fallback the migration used.
    statusChangedAt: row.status_changed_at ?? row.updated_at ?? row.created_at,
    idleSince: row.idle_since ?? null,
    stoppedAt: row.stopped_at ?? null,
    lastStopReason: parseStopReason(row.last_stop_reason ?? null),
    // Terminal-log retention — NULL (pre-migration / never reclaimed) → null.
    terminalHistoryReclaimedAt: row.terminal_history_reclaimed_at ?? null,
  };
}

// ── Checkpoint Surface Hardening WP2: historical witness-path backfill ────────
//
// Idempotent boot-time remediation of defect-1 pollution (OSC-8 / terminal-escape
// residue) in the four witness-bearing path stores, following the
// `initDatabase` file_activities-cleanup precedent (self-limiting `WHERE` via the
// `looksPolluted` prefilter, try/catch, NO version table) wrapped in ONE
// `db.transaction`. Re-running is a no-op once the polluted rows/entries are
// cleaned — the prefilter no longer matches them.
//
// Two NON-interchangeable canonical forms are preserved per-store (plan §"Two
// explicit, non-interchangeable canonicalizers"):
//   • `file_activities.file_path`  → verified absolute NATIVE path. The historical
//     cwd/home are NOT immutably attributable, so ONLY context-independent spelling
//     transforms run (`file:` URI decode, percent-decode, separator/drive-case) —
//     NEVER `~`/relative resolution (empty ctx passed to `canonicalizeToAbsolute`).
//     A value that recovers ambiguous, empty, or only to a relative/`~` path → the
//     ROW is DELETED (quarantine == delete; there is no quarantine store).
//   • `turn_records.touched[]` and `recovery_operations.{pre_included_paths,
//     requested_paths,completed_paths}` → validated workspace-relative POSIX. These
//     were stored via `normalizeWitnessPath`, so the only corruption is embedded
//     escape text; after unwrap the repoRoot-INDEPENDENT structural subset of the
//     witness checks runs (relative, POSIX-separated, non-empty, not `..`-escaping).
//     `repoRoot`/`workspacePrefix` are unavailable at migration time, so the full
//     scope re-check is not run; an entry that comes out absolute, drive-rooted,
//     outward-traversing, or ambiguous is REMOVED from the array (never coerced).
//     Entries are re-deduped after cleaning.
//
// No blanket separator conversion across the two representations — native for
// `file_activities`, POSIX for the JSON arrays, handled per-store.

type SanitizeCounts = { repaired: number; discarded: number; merged: number };

/** Post-`canonicalizeToAbsolute` (empty ctx) verified-absolute predicate: a
 *  Windows drive-rooted path, a UNC share, or a POSIX-absolute (WSL) path. A
 *  relative or unexpanded-`~` residue fails this → the row is discarded. */
function isVerifiedAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}

/** Clean a stored workspace-relative POSIX witness path (defect-1 unwrap only)
 *  and validate it against the repoRoot-independent structural subset. Returns the
 *  normalized POSIX path to keep, or `null` to REMOVE the entry (ambiguous /
 *  absolute / drive-rooted / backslash / outward-traversing / empty). Never
 *  coerces a failing shape into a passing one. */
function cleanWorkspaceRelativePath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const clean = unwrapOsc8(raw);
  if ('ambiguous' in clean) return null;
  const t = stripTerminalEscapes(clean.text).trim();
  if (t === '') return null;
  if (t.includes('\\')) return null;                        // not POSIX-separated
  if (t.includes('\x1b') || t.includes(']8;')) return null; // residual pollution
  if (/^[A-Za-z]:[\\/]/.test(t)) return null;               // drive-rooted (absolute)
  if (t.startsWith('/')) return null;                       // absolute
  const norm = path.posix.normalize(t);
  if (norm === '' || norm === '.') return null;
  if (norm === '..' || norm.startsWith('../')) return null; // outward traversal
  return norm;
}

/**
 * Remediate defect-1 pollution across the witness-bearing path stores. Idempotent;
 * runs inside ONE transaction (rolls back on error). Emits and logs aggregate
 * `{ repaired, discarded, merged }` per table.
 */
export function sanitizeHistoricalWitnessPaths(handle: Database.Database): {
  file_activities: SanitizeCounts;
  turn_records: SanitizeCounts;
  recovery_operations: SanitizeCounts;
} {
  const tx = handle.transaction(() => {
    const fa: SanitizeCounts = { repaired: 0, discarded: 0, merged: 0 };
    const tr: SanitizeCounts = { repaired: 0, discarded: 0, merged: 0 };
    const ro: SanitizeCounts = { repaired: 0, discarded: 0, merged: 0 };

    // ── file_activities.file_path → verified absolute NATIVE path ───────────────
    const faDelete = handle.prepare('DELETE FROM file_activities WHERE id = ?');
    const faUpdate = handle.prepare('UPDATE file_activities SET file_path = ? WHERE id = ?');
    const faRows = handle
      .prepare('SELECT id, agent_id, file_path, operation, generation, session_id FROM file_activities')
      .all() as Array<{
        id: number; agent_id: string; file_path: string; operation: string;
        generation: number; session_id: string | null;
      }>;
    // Identity tuples touched by a repair — the ONLY groups a post-normalization
    // collision merge is allowed to collapse (a group never touched by repair is
    // left untouched, so genuinely-clean rows are never merged).
    const repairedIdentities: Array<{
      agent_id: string; file_path: string; operation: string;
      generation: number; session_id: string | null;
    }> = [];
    for (const r of faRows) {
      if (!looksPolluted(r.file_path)) continue;
      const clean = unwrapOsc8(r.file_path);
      if ('ambiguous' in clean) { faDelete.run(r.id); fa.discarded++; continue; }
      // Empty ctx: context-independent transforms ONLY — never ~/relative resolution.
      const abs = canonicalizeToAbsolute(stripTerminalEscapes(clean.text), {});
      if (abs === '' || !isVerifiedAbsolutePath(abs)) { faDelete.run(r.id); fa.discarded++; continue; }
      faUpdate.run(abs, r.id);
      fa.repaired++;
      repairedIdentities.push({
        agent_id: r.agent_id, file_path: abs, operation: r.operation,
        generation: r.generation, session_id: r.session_id,
      });
    }
    // Collision merge — production dedupe identity
    // (agent_id, file_path, operation, generation, session_id) with null-safe `IS`.
    // Keep the lowest `id` (earliest event identity), delete the rest.
    const faGroup = handle.prepare(
      `SELECT id FROM file_activities
       WHERE agent_id = ? AND file_path = ? AND operation = ? AND generation = ? AND session_id IS ?
       ORDER BY id ASC`
    );
    const mergedKeys = new Set<string>();
    for (const idn of repairedIdentities) {
      const key = JSON.stringify([idn.agent_id, idn.file_path, idn.operation, idn.generation, idn.session_id]);
      if (mergedKeys.has(key)) continue;
      mergedKeys.add(key);
      const dupes = faGroup.all(
        idn.agent_id, idn.file_path, idn.operation, idn.generation, idn.session_id
      ) as Array<{ id: number }>;
      for (let i = 1; i < dupes.length; i++) { faDelete.run(dupes[i].id); fa.merged++; }
    }

    // ── turn_records.touched[] → validated workspace-relative POSIX ─────────────
    const trUpdate = handle.prepare('UPDATE turn_records SET touched = ? WHERE id = ?');
    const trRows = handle
      .prepare('SELECT id, touched FROM turn_records WHERE touched IS NOT NULL')
      .all() as Array<{ id: string; touched: string }>;
    for (const r of trRows) {
      if (!looksPolluted(r.touched)) continue;
      let arr: unknown;
      try { arr = JSON.parse(r.touched); } catch { continue; }
      if (!Array.isArray(arr)) continue;
      const seen = new Set<string>();
      const cleaned: Array<Record<string, unknown>> = [];
      for (const entry of arr) {
        if (!entry || typeof entry !== 'object') { tr.discarded++; continue; }
        const e = entry as Record<string, unknown>;
        const cp = cleanWorkspaceRelativePath(e.path);
        if (cp === null) { tr.discarded++; continue; }
        const dk = JSON.stringify([cp, e.op]);
        if (seen.has(dk)) { tr.merged++; continue; } // re-dedupe (path, op)
        seen.add(dk);
        cleaned.push({ ...e, path: cp });
      }
      const next = JSON.stringify(cleaned);
      if (next !== r.touched) { trUpdate.run(next, r.id); tr.repaired++; }
    }

    // ── recovery_operations.{pre_included,requested,completed}_paths → POSIX ─────
    const roCols = ['pre_included_paths', 'requested_paths', 'completed_paths'] as const;
    const roRows = handle
      .prepare('SELECT id, pre_included_paths, requested_paths, completed_paths FROM recovery_operations')
      .all() as Array<Record<string, string | null> & { id: string }>;
    for (const r of roRows) {
      const updates: Record<string, string> = {};
      for (const col of roCols) {
        const rawJson = r[col];
        if (rawJson == null || !looksPolluted(rawJson)) continue;
        let arr: unknown;
        try { arr = JSON.parse(rawJson); } catch { continue; }
        if (!Array.isArray(arr)) continue;
        const seen = new Set<string>();
        const cleaned: unknown[] = [];
        for (const entry of arr) {
          const isObj = !!entry && typeof entry === 'object';
          const pathVal = isObj ? (entry as Record<string, unknown>).path
            : (typeof entry === 'string' ? entry : undefined);
          const cp = cleanWorkspaceRelativePath(pathVal);
          if (cp === null) { ro.discarded++; continue; }
          const rebuilt = isObj ? { ...(entry as Record<string, unknown>), path: cp } : cp;
          const dk = isObj ? JSON.stringify(rebuilt) : cp;
          if (seen.has(dk)) { ro.merged++; continue; } // re-dedupe after normalization
          seen.add(dk);
          cleaned.push(rebuilt);
        }
        const next = JSON.stringify(cleaned);
        if (next !== rawJson) updates[col] = next;
      }
      const cols = Object.keys(updates);
      if (cols.length > 0) {
        handle
          .prepare(`UPDATE recovery_operations SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
          .run(...cols.map((c) => updates[c]), r.id);
        ro.repaired++;
      }
    }

    return { file_activities: fa, turn_records: tr, recovery_operations: ro };
  });

  const counts = tx();
  console.log('[database] WP2 witness-path sanitize:', JSON.stringify(counts));
  return counts;
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

/**
 * Data-hygiene migration: rewrite stored `workspaces.default_command` values
 * that are the legacy framework default *modulo a standalone `--chrome` token*
 * down to the matching current framework default (DEFAULT_COMMAND /
 * DEFAULT_COMMAND_WSL).
 *
 * A `default_command` qualifies ONLY if removing its standalone `--chrome`
 * token(s) yields exactly a framework default — e.g.
 * `claude --dangerously-skip-permissions --chrome` → DEFAULT_COMMAND, or
 * `ccode --dangerously-skip-permissions --chrome` → DEFAULT_COMMAND_WSL. A
 * genuinely-custom command that merely contains `--chrome`
 * (e.g. `claude --dangerously-skip-permissions --chrome --foo`) does NOT
 * reduce to a framework default and is left untouched.
 *
 * Idempotent: a row already equal to a framework default has no standalone
 * `--chrome` token, so the strip is a no-op and the row is skipped. Exported so
 * the migration can be unit-tested against an isolated DB handle.
 */
export function normalizeLegacyChromeDefaultCommands(database: Database.Database): void {
  const rows = database
    .prepare(`SELECT id, default_command FROM workspaces`)
    .all() as { id: string; default_command: string | null }[];
  const update = database.prepare(
    `UPDATE workspaces SET default_command = ? WHERE id = ?`
  );
  for (const row of rows) {
    const cmd = row.default_command ?? '';
    // Drop standalone `--chrome` word tokens; collapse the surrounding
    // whitespace so the result can be compared verbatim to a framework default.
    const stripped = cmd.split(/\s+/).filter((tok) => tok !== '--chrome').join(' ').trim();
    if (stripped === cmd) continue; // no standalone `--chrome` token present
    if (stripped === DEFAULT_COMMAND || stripped === DEFAULT_COMMAND_WSL) {
      update.run(stripped, row.id);
    }
  }
}

/**
 * Idle-agent lifecycle §B2 — additive migration for the four idle/stop
 * bookkeeping columns on `agents`.
 *
 *   status_changed_at  when `status` last CHANGED. Backfilled to
 *                      COALESCE(updated_at, migratedAt). INFORMATIONAL ONLY —
 *                      it is deliberately NOT an eligibility clock, because
 *                      `updated_at` is bumped by dozens of unrelated writes
 *                      (last output, pid, exit code, hook status…).
 *   idle_since         when the agent entered `idle`, else NULL. Backfilled to
 *                      migratedAt for rows already `idle`. THE sole stale-idle
 *                      eligibility clock.
 *   stopped_at         when the last real stop landed.
 *   last_stop_reason   why (an AgentStopReason), NULL when never stopped.
 *
 * Idempotent: each column is added only when `PRAGMA table_info(agents)` says
 * it is absent, and the backfill is scoped to the columns this run actually
 * added — a second pass is a no-op and can never re-stamp a live idle clock.
 * Exported so the migration can be unit-tested against an isolated handle.
 */
export function migrateLifecycleColumns(database: Database.Database): void {
  const agentsColumnExists = (col: string): boolean => {
    // Fixed identifier (`agents`); the column name is compared in JS, never
    // interpolated into SQL.
    const cols = database.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[];
    return cols.some((c) => c.name === col);
  };

  const migratedAt = (database.prepare(`SELECT datetime('now') AS t`).get() as { t: string }).t;

  database.transaction(() => {
    if (!agentsColumnExists('status_changed_at')) {
      database.exec(`ALTER TABLE agents ADD COLUMN status_changed_at TEXT`);
      database
        .prepare(`UPDATE agents SET status_changed_at = COALESCE(updated_at, ?)`)
        .run(migratedAt);
    }
    if (!agentsColumnExists('idle_since')) {
      database.exec(`ALTER TABLE agents ADD COLUMN idle_since TEXT`);
      // Only rows that are idle RIGHT NOW get a clock; everything else stays
      // NULL so the sweep can never see a fabricated idle age.
      database
        .prepare(`UPDATE agents SET idle_since = CASE WHEN status = 'idle' THEN ? ELSE NULL END`)
        .run(migratedAt);
    }
    if (!agentsColumnExists('stopped_at')) {
      database.exec(`ALTER TABLE agents ADD COLUMN stopped_at TEXT`);
    }
    if (!agentsColumnExists('last_stop_reason')) {
      database.exec(`ALTER TABLE agents ADD COLUMN last_stop_reason TEXT`);
    }
  })();
}

/**
 * Terminal-log retention — additive migration for the single
 * `terminal_history_reclaimed_at TEXT NULL` (ISO-8601) marker on `agents`.
 *
 * Mirrors `migrateLifecycleColumns`: PRAGMA `table_info(agents)`-guarded so the
 * `ALTER` runs at most once, and — critically — there is NO backfill. Legacy
 * rows stay NULL, which is the "history never reclaimed" state; a backfill would
 * fabricate a disclosure for logs that were never touched. Idempotent: a second
 * pass sees the column present and does nothing. Exported for unit tests.
 */
export function migrateTerminalHistoryReclaimedColumn(database: Database.Database): void {
  const agentsColumnExists = (col: string): boolean => {
    // Fixed identifier (`agents`); the column name is compared in JS, never
    // interpolated into SQL.
    const cols = database.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[];
    return cols.some((c) => c.name === col);
  };

  if (!agentsColumnExists('terminal_history_reclaimed_at')) {
    database.exec(`ALTER TABLE agents ADD COLUMN terminal_history_reclaimed_at TEXT`);
  }
}

/**
 * Terminal-log retention — stamp the reclaimed marker. Idempotent by SQL: the
 * `AND terminal_history_reclaimed_at IS NULL` guard preserves the FIRST non-null
 * value, so a marker survives revival and a re-sweep never overwrites it.
 * Touches ONLY this column — never `status`, never `updated_at` — and never
 * clears it.
 */
export function markAgentTerminalHistoryReclaimed(agentId: string, iso: string): void {
  run(
    `UPDATE agents SET terminal_history_reclaimed_at = ? WHERE id = ? AND terminal_history_reclaimed_at IS NULL`,
    [iso, agentId],
  );
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

/** Test seam — reset the module singleton cleanly (B2 A6). */
export function closeDatabaseForTests(): void {
  closeDatabase();
}

// ── B2: Plans data layer (P1-01) ──

/** Slug = basename without a known plan extension (DEC-4). `html` is reserved for
 *  a future data-plan-id hook and is ignored in B2. Never feeds plans.id (R2). */
export function derivePlanSlug(planPath: string, _html?: string | null): string {
  return path.basename(planPath).replace(/\.(html?|md|markdown)$/i, '');
}

function rowToPlan(row: any): Plan {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    slug: row.slug ?? null,
    format: row.format,
    runState: row.run_state ?? null,
    mtimeMs: row.mtime_ms,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at ?? null,
  };
}

/** Maps a supervisor_focus row; when the SELECT joined the plan columns (aliased
 *  `plan_*`), attaches the joined `plan` projection. */
function rowToSupervisorFocus(row: any): SupervisorFocus {
  const focus: SupervisorFocus = {
    supervisorId: row.supervisor_id,
    planId: row.plan_id,
    focusedAt: row.focused_at,
    lastAttendedAt: row.last_attended_at,
    notes: row.notes ?? null,
  };
  if (row.plan_id_j !== undefined && row.plan_id_j !== null) {
    focus.plan = rowToPlan({
      id: row.plan_id_j,
      workspace_id: row.plan_workspace_id,
      path: row.plan_path,
      slug: row.plan_slug,
      format: row.plan_format,
      run_state: row.plan_run_state,
      mtime_ms: row.plan_mtime_ms,
      size_bytes: row.plan_size_bytes,
      created_at: row.plan_created_at,
      updated_at: row.plan_updated_at,
      deleted_at: row.plan_deleted_at,
    });
  }
  return focus;
}

type CreateOrRevivePlanInput = {
  workspaceId: string; path: string; format: PlanFormat;
  slug?: string | null; runState?: string | null;
  mtimeMs?: number; sizeBytes?: number;   // default 0 (DEC-2)
};
type UpdatePlanInput = Partial<{
  path: string; slug: string | null; format: PlanFormat;
  runState: string | null; mtimeMs: number; sizeBytes: number;
}>;

export function getPlans(filters?: { workspaceId?: string; includeDeleted?: boolean }): Plan[] {
  const clauses: string[] = [];
  const params: any[] = [];
  if (filters?.workspaceId) { clauses.push('workspace_id = ?'); params.push(filters.workspaceId); }
  if (!filters?.includeDeleted) { clauses.push('deleted_at IS NULL'); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return queryAll(`SELECT * FROM plans ${where} ORDER BY updated_at DESC`, params).map(rowToPlan);
}

export function getPlan(id: string): Plan | null {
  const row = queryOne('SELECT * FROM plans WHERE id = ?', [id]);
  return row ? rowToPlan(row) : null;
}

export function getPlanByWorkspacePath(workspaceId: string, planPath: string): Plan | null {
  const row = queryOne('SELECT * FROM plans WHERE workspace_id = ? AND path = ?', [workspaceId, planPath]);
  return row ? rowToPlan(row) : null;
}

/** Idempotent on (workspace_id, path). INSERT mints a fresh uuid; ON CONFLICT keeps
 *  the existing id, refreshes metadata, and REVIVES a soft-deleted row (clears
 *  deleted_at) so re-creating a file at the same path preserves focus rows.
 *  id is NEVER slug/path-derived (R2/D-01). */
export function createOrRevivePlan(input: CreateOrRevivePlanInput): Plan {
  const id = uuidv4();
  const slug = input.slug ?? derivePlanSlug(input.path);
  run(
    `INSERT INTO plans (id, workspace_id, path, slug, format, run_state, mtime_ms, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, path) DO UPDATE SET
       slug = COALESCE(excluded.slug, plans.slug),
       format = excluded.format,
       mtime_ms = excluded.mtime_ms,
       size_bytes = excluded.size_bytes,
       deleted_at = NULL,
       updated_at = datetime('now')`,
    [id, input.workspaceId, input.path, slug, input.format,
     input.runState ?? null, input.mtimeMs ?? 0, input.sizeBytes ?? 0]
  );
  return getPlanByWorkspacePath(input.workspaceId, input.path)!;
}

/** Partial update; bumps updated_at; ALWAYS preserves id. Setting path/slug is the
 *  rename REBIND (D-01). Applies DEC-1 destination handling before the path write.
 *  Returns null if the target id does not exist; throws {statusCode:409} on a live
 *  destination-path conflict. */
export function updatePlan(id: string, updates: UpdatePlanInput): Plan | null {
  const current = getPlan(id);
  if (!current) return null;
  if (updates.path !== undefined && updates.path !== current.path) {
    const dest = getPlanByWorkspacePath(current.workspaceId, updates.path);
    if (dest && dest.id !== id) {
      if (dest.deletedAt) hardDeletePlanRow(dest.id);   // DEC-1: reclaim tombstone (focus cascades)
      else throw Object.assign(new Error('Destination path already in use by a live plan'), { statusCode: 409 });
    }
  }
  const sets: string[] = [];
  const params: any[] = [];
  if (updates.path !== undefined) { sets.push('path = ?'); params.push(updates.path); }
  if (updates.slug !== undefined) { sets.push('slug = ?'); params.push(updates.slug); }
  if (updates.format !== undefined) { sets.push('format = ?'); params.push(updates.format); }
  if (updates.runState !== undefined) { sets.push('run_state = ?'); params.push(updates.runState); }
  if (updates.mtimeMs !== undefined) { sets.push('mtime_ms = ?'); params.push(updates.mtimeMs); }
  if (updates.sizeBytes !== undefined) { sets.push('size_bytes = ?'); params.push(updates.sizeBytes); }
  if (sets.length === 0) return getPlan(id);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  run(`UPDATE plans SET ${sets.join(', ')} WHERE id = ?`, params);
  return getPlan(id);
}

export function softDeletePlan(id: string): Plan | null {
  run(
    `UPDATE plans SET deleted_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND deleted_at IS NULL`,
    [id]
  );
  return getPlan(id);
}

/** INTERNAL ONLY — used by updatePlan's DEC-1 tombstone reclaim. Never exposed as a
 *  route (the API never hard-deletes plans; soft only). Relies on ON DELETE CASCADE. */
function hardDeletePlanRow(id: string): void {
  run('DELETE FROM plans WHERE id = ?', [id]);
}

// ── WP-P2B-folder — structured plan-folder adoption (§R0) ─────────────────────
// The folder watcher ADOPTS a §R0 plan folder into a `plans` row keyed by the
// disk-truth `plan.json.plan_artifact_id`. These accessors use ONLY the WP-P2A
// columns (`artifact_id`, `folder_rel_path`); they write NO `author_*` (those
// columns do not exist on `plans`) and NEVER touch the P3-owned enrichment
// columns (`source_proposal_id`, `promoted_at`, `promoted_content_hash`, and the
// P3A `responsible_supervisor_id`). Convergence with P3: the
// (workspace_id, artifact_id) partial unique index makes the adopted row the
// EXACT row P3 later enriches.

/** A plan row surfaced WITH the WP-P2A columns `rowToPlan` drops. Only the fields
 *  the folder-adoption path needs. */
export interface StructuredPlanRow {
  id: string;
  workspaceId: string;
  artifactId: string | null;
  folderRelPath: string | null;
  path: string;
  format: string;
  runState: string | null;
  mtimeMs: number;
  sizeBytes: number;
  deletedAt: string | null;
}

function rowToStructuredPlan(row: any): StructuredPlanRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    artifactId: row.artifact_id ?? null,
    folderRelPath: row.folder_rel_path ?? null,
    path: row.path,
    format: row.format,
    runState: row.run_state ?? null,
    mtimeMs: row.mtime_ms,
    sizeBytes: row.size_bytes,
    deletedAt: row.deleted_at ?? null,
  };
}

/** Point read of a plan row by its disk-truth `plan_artifact_id` (workspace-
 *  scoped), surfacing the WP-P2A columns `rowToPlan` drops so the adopt path can
 *  stay idempotent. INCLUDES soft-deleted rows so a folder that reappears after a
 *  transient absence revives its existing row rather than minting a new id. */
export function getPlanByWorkspaceArtifactId(workspaceId: string, artifactId: string): StructuredPlanRow | null {
  const row = queryOne(
    `SELECT * FROM plans WHERE workspace_id = ? AND artifact_id = ?`,
    [workspaceId, artifactId],
  );
  return row ? rowToStructuredPlan(row) : null;
}

export interface AdoptStructuredPlanInput {
  workspaceId: string;
  /** disk-truth `plan.json.plan_artifact_id` — the adoption key. */
  artifactId: string;
  /** workspace-relative path of the plan FOLDER under <workspaceStateDir()>/plans/. */
  folderRelPath: string;
  /** workspace-relative path of the folder's `plan.md` (the row's `path`). */
  planPath: string;
  mtimeMs: number;
  sizeBytes: number;
}

export type StructuredPlanChange = 'adopted' | 'revived' | 'changed' | 'unchanged';

/** Idempotent adopt of a §R0 plan folder keyed by (workspace_id, artifact_id).
 *  INSERT mints a fresh uuid with `format='structured'` / `run_state='hardening'`.
 *  A later adopt of the same artifact refreshes ONLY the folder/path/fs columns
 *  (and REVIVES a soft-deleted row), never `run_state` and never a P3-owned
 *  enrichment column. Returns the resolved row id + what changed. Throws on a
 *  genuine constraint violation (a foreign path/folder collision) — the caller
 *  quarantines with a diagnostic. */
export function adoptStructuredPlan(input: AdoptStructuredPlanInput): { planId: string; change: StructuredPlanChange } {
  const existing = getPlanByWorkspaceArtifactId(input.workspaceId, input.artifactId);
  if (existing) {
    const revived = existing.deletedAt != null;
    const metaChanged =
      existing.folderRelPath !== input.folderRelPath ||
      existing.path !== input.planPath ||
      existing.mtimeMs !== input.mtimeMs ||
      existing.sizeBytes !== input.sizeBytes;
    if (revived || metaChanged) {
      run(
        `UPDATE plans SET folder_rel_path = ?, path = ?, format = 'structured',
                mtime_ms = ?, size_bytes = ?, deleted_at = NULL, updated_at = datetime('now')
           WHERE id = ?`,
        [input.folderRelPath, input.planPath, input.mtimeMs, input.sizeBytes, existing.id],
      );
    }
    return { planId: existing.id, change: revived ? 'revived' : metaChanged ? 'changed' : 'unchanged' };
  }
  const id = uuidv4();
  const slug = derivePlanSlug(input.folderRelPath);
  run(
    `INSERT INTO plans (id, workspace_id, path, slug, format, run_state, mtime_ms, size_bytes, artifact_id, folder_rel_path)
     VALUES (?, ?, ?, ?, 'structured', 'hardening', ?, ?, ?, ?)`,
    [id, input.workspaceId, input.planPath, slug, input.mtimeMs, input.sizeBytes, input.artifactId, input.folderRelPath],
  );
  return { planId: id, change: 'adopted' };
}

// ── B2: Supervisor focus (P1-03 data surface) ──

type FocusInput = { supervisorId: string; planId: string; notes?: string | null };

const FOCUS_JOIN_SELECT = `
  SELECT f.supervisor_id, f.plan_id, f.focused_at, f.last_attended_at, f.notes,
         p.id AS plan_id_j, p.workspace_id AS plan_workspace_id, p.path AS plan_path,
         p.slug AS plan_slug, p.format AS plan_format, p.run_state AS plan_run_state,
         p.mtime_ms AS plan_mtime_ms, p.size_bytes AS plan_size_bytes,
         p.created_at AS plan_created_at, p.updated_at AS plan_updated_at,
         p.deleted_at AS plan_deleted_at
  FROM supervisor_focus f JOIN plans p ON p.id = f.plan_id`;

export function getSupervisorFocus(filters?: { supervisorId?: string; workspaceId?: string }): SupervisorFocus[] {
  const clauses: string[] = [];
  const params: any[] = [];
  if (filters?.supervisorId) { clauses.push('f.supervisor_id = ?'); params.push(filters.supervisorId); }
  if (filters?.workspaceId) { clauses.push('p.workspace_id = ?'); params.push(filters.workspaceId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return queryAll(`${FOCUS_JOIN_SELECT} ${where} ORDER BY f.last_attended_at DESC`, params)
    .map(rowToSupervisorFocus);
}

function getSupervisorFocusRow(supervisorId: string, planId: string): SupervisorFocus | null {
  const row = queryOne(`${FOCUS_JOIN_SELECT} WHERE f.supervisor_id = ? AND f.plan_id = ?`,
    [supervisorId, planId]);
  return row ? rowToSupervisorFocus(row) : null;
}

export function upsertSupervisorFocus(input: FocusInput): SupervisorFocus {
  run(
    `INSERT INTO supervisor_focus (supervisor_id, plan_id, notes)
     VALUES (?, ?, ?)
     ON CONFLICT(supervisor_id, plan_id) DO UPDATE SET
       notes = COALESCE(excluded.notes, supervisor_focus.notes)`,
    [input.supervisorId, input.planId, input.notes ?? null]
  );
  return getSupervisorFocusRow(input.supervisorId, input.planId)!;
}

export function deleteSupervisorFocus(supervisorId: string, planId: string): void {
  run('DELETE FROM supervisor_focus WHERE supervisor_id = ? AND plan_id = ?', [supervisorId, planId]);
}

/** P1-07 ONLY — defined now, NOT wired to middleware in this slice. No-op when no
 *  row exists; never throws. */
export function bumpSupervisorFocusAttended(supervisorId: string, planId: string): SupervisorFocus | null {
  run(
    `UPDATE supervisor_focus SET last_attended_at = datetime('now')
     WHERE supervisor_id = ? AND plan_id = ?`,
    [supervisorId, planId]
  );
  return getSupervisorFocusRow(supervisorId, planId);
}

// ── WP-P4C-backend — plan_tab_overviews accessors (revisioned; PK(plan_id, tab)) ──
//
// Accessors ONLY over the P3A `plan_tab_overviews` table (no DDL here — the table
// exists). Reads are open; the supervisor-privilege gate lives at the IPC boundary
// (plan-ipc.ts), not in the DB layer. `setPlanTabOverview` is a single-statement
// upsert keyed on the (plan_id, tab) PK: a first write lands revision 1, and every
// rewrite of the SAME key bumps `revision` by one and re-stamps `updated_at`. The
// `tab` free-text column is keyed by the stable `PlanTabKey` domain by callers.

function rowToPlanTabOverview(row: any): PlanTabOverview {
  return {
    planId: row.plan_id,
    tab: row.tab as PlanTabKey,
    body: row.body ?? null,
    revision: Number(row.revision),
    updatedBy: row.updated_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The stored per-tab overview for (planId, tab), or null when the key is unset. */
export function getPlanTabOverview(planId: string, tab: string): PlanTabOverview | null {
  const row = queryOne(
    `SELECT * FROM plan_tab_overviews WHERE plan_id = ? AND tab = ?`,
    [planId, tab],
  );
  return row ? rowToPlanTabOverview(row) : null;
}

export interface PlanTabOverviewInput {
  planId: string;
  tab: string;
  body: string | null;
  /** The revalidated supervisor id recorded as the writer. */
  updatedBy: string;
}

/** Upsert the per-tab overview. First write → revision 1; a rewrite of the same
 *  (plan_id, tab) key bumps `revision` and re-stamps `updated_at`. Returns the
 *  freshly-stored row (never null — the upsert always leaves a row). */
export function setPlanTabOverview(input: PlanTabOverviewInput): PlanTabOverview {
  run(
    `INSERT INTO plan_tab_overviews (plan_id, tab, body, revision, updated_by, updated_at)
     VALUES (?, ?, ?, 1, ?, datetime('now'))
     ON CONFLICT(plan_id, tab) DO UPDATE SET
       body = excluded.body,
       revision = plan_tab_overviews.revision + 1,
       updated_by = excluded.updated_by,
       updated_at = datetime('now')`,
    [input.planId, input.tab, input.body, input.updatedBy],
  );
  return getPlanTabOverview(input.planId, input.tab)!;
}

export type FocusedPlanSummary = {
  planId: string;
  path: string;
  slug: string | null;
  format: string;
  focusedAt: string;
  lastAttendedAt: string;
  notes: string | null;
};

/** The calling supervisor's focused plans, shaped for the get_my_context
 *  orientation payload: most-recently-attended first (SQLite sorts NULLs last on
 *  DESC, so a never-attended row falls back to focused_at), deleted plans
 *  excluded, capped. Empty array for a supervisor with no subscriptions. */
export function getSupervisorFocusedPlans(supervisorId: string, limit = 10): FocusedPlanSummary[] {
  return queryAll(
    `SELECT f.plan_id AS planId, p.path AS path, p.slug AS slug, p.format AS format,
            f.focused_at AS focusedAt, f.last_attended_at AS lastAttendedAt, f.notes AS notes
     FROM supervisor_focus f JOIN plans p ON p.id = f.plan_id
     WHERE f.supervisor_id = ? AND p.deleted_at IS NULL
     ORDER BY f.last_attended_at DESC, f.focused_at DESC
     LIMIT ?`,
    [supervisorId, limit]
  ) as FocusedPlanSummary[];
}

// ── WP2: Provenance spine — breadcrumb touches (R2 §2.1) ────────────────────

/** A read=intent or edit-target breadcrumb captured from the MCP handler or the
 *  transcript. `sectionAnchor` may be a pending sentinel for unresolved native
 *  edits (resolved to a real anchor at Stop by the resolver, R2 §2.3/§2.5). */
export type PlanSectionTouchInput = {
  agentId: string;
  planId: string;
  sectionAnchor: string;
  blockAnchor?: string | null;
  tool: string;                 // 'read_plan_section' | 'list_plan_sections' | 'read_plan_projection' | 'edit' | 'apply_patch' | 'write'
  kind: 'read' | 'edit-target';
  readMode?: string | null;
  source: 'handler' | 'transcript';
  toolUseId?: string | null;
  resolvePayload?: string | null;
  observedAt?: string;          // ISO; defaults to now
};

export type PlanSectionTouchRow = {
  id: string;
  agentId: string;
  planId: string;
  sectionAnchor: string;
  blockAnchor: string | null;
  tool: string;
  kind: 'read' | 'edit-target';
  readMode: string | null;
  source: 'handler' | 'transcript';
  toolUseId: string | null;
  resolvePayload: string | null;
  observedAt: string;
};

function rowToPlanSectionTouch(row: any): PlanSectionTouchRow {
  return {
    id: row.id,
    agentId: row.agent_id,
    planId: row.plan_id,
    sectionAnchor: row.section_anchor,
    blockAnchor: row.block_anchor ?? null,
    tool: row.tool,
    kind: row.kind,
    readMode: row.read_mode ?? null,
    source: row.source,
    toolUseId: row.tool_use_id ?? null,
    resolvePayload: row.resolve_payload ?? null,
    observedAt: row.observed_at,
  };
}

/** Insert a breadcrumb with cross-source dedup (R2 §2.1): if a row with the same
 *  non-null `tool_use_id` already exists, or (when `tool_use_id` is null) a row
 *  matching (agent_id, tool, section_anchor, block_anchor) within a 2-second
 *  bucket of `observed_at`, this is a no-op. This lets the handler (source:handler)
 *  and the transcript (source:transcript) both fire without double counting.
 *  Returns the inserted row id, or null when deduped. Never throws on caller data
 *  the way the tracker feeds it — callers upstream stay tolerant. */
export function recordPlanSectionTouch(input: PlanSectionTouchInput): string | null {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const blockAnchor = input.blockAnchor ?? null;

  if (input.toolUseId) {
    const dup = queryOne(
      'SELECT id FROM plan_section_touches WHERE tool_use_id = ?',
      [input.toolUseId],
    );
    if (dup) return null;
  } else {
    // No tool_use_id → 2-second time-bucket dedup on the identifying tuple.
    const dup = queryOne(
      `SELECT id FROM plan_section_touches
       WHERE agent_id = ? AND tool = ? AND section_anchor = ?
         AND (block_anchor IS ? OR block_anchor = ?)
         AND ABS((julianday(observed_at) - julianday(?)) * 86400.0) <= 2.0`,
      [input.agentId, input.tool, input.sectionAnchor, blockAnchor, blockAnchor, observedAt],
    );
    if (dup) return null;
  }

  const id = uuidv4();
  run(
    `INSERT INTO plan_section_touches
       (id, agent_id, plan_id, section_anchor, block_anchor, tool, kind, read_mode, source, tool_use_id, resolve_payload, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.agentId, input.planId, input.sectionAnchor, blockAnchor, input.tool, input.kind,
     input.readMode ?? null, input.source, input.toolUseId ?? null, input.resolvePayload ?? null, observedAt],
  );
  return id;
}

/** Window query for the Stop-time resolver (R2 §2.1/§2.5): all touches for an
 *  agent within [sinceIso, untilIso], ordered by observed_at. */
export function getTurnSectionTouches(agentId: string, sinceIso: string, untilIso: string): PlanSectionTouchRow[] {
  return queryAll(
    `SELECT * FROM plan_section_touches
     WHERE agent_id = ? AND observed_at >= ? AND observed_at <= ?
     ORDER BY observed_at ASC`,
    [agentId, sinceIso, untilIso],
  ).map(rowToPlanSectionTouch);
}

/** GT-A WP-A2 shared parse helper: tolerantly decode a JSON anchor array (the
 *  `written_section_anchors_json` column). Returns `[]` on null / non-array /
 *  malformed input and drops non-string members — never throws. Deliberately NOT
 *  a `json_each` SQL dependency (A2.1): the aggregation is done in JS so the
 *  SQLite build needs no JSON1 extension. */
function parseAnchorList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
  } catch { /* malformed anchor JSON — treat as no anchors, never throw */ }
  return [];
}

/** Lexicographic max of two nullable ISO-8601 timestamps (null = absent). ISO
 *  strings sort chronologically, so `>=` is a valid time comparison. */
function maxIso(a: string | null, b: string | null): string | null {
  if (a == null) return b;
  if (b == null) return a;
  return a >= b ? a : b;
}

/** WP3 `read_plan_projection` roll-up, GT-A WP-A2.1 reshaped: per section anchor,
 *  split the trusted `plan_events` trail into WRITE turns (an anchor in the turn's
 *  effect set `written_section_anchors_json`, D-4) and PRESENCE turns (empty effect
 *  set — no-op deliberation "holding the rail," keyed dispatched-first per D-6).
 *  JS aggregation, NO `json_each` (A2.1). `'*'` orientation touches never appear
 *  here (they live in plan_section_touches, not plan_events).
 *
 *  A multi-section write turn fans its `writeCount` onto EVERY written anchor
 *  (fixes I-2). Back-compat: `eventCount = writeCount + presenceCount`,
 *  `lastEventAt = max(lastWriteAt, lastPresenceAt)`. */
export function getPlanEventRollup(planId: string): {
  sectionAnchor: string;
  writeCount: number;
  presenceCount: number;
  lastWriteAt: string | null;
  lastPresenceAt: string | null;
  eventCount: number;
  lastEventAt: string | null;
  // Fix-4 — witnessed repo counts, fanned with the SAME event-attribution semantics
  // as writeCount/presenceCount (I-8: NOT a parallel SUM…GROUP BY). tests*/lastCommit
  // are inert in cut 1 (no capture) but present so downstream reads don't branch.
  repoFilesRead: number;
  repoFilesEdited: number;
  repoFilesCreated: number;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  lastCommit: string | null;
}[] {
  const rows = queryAll(
    `SELECT observed_section_anchor, dispatched_section_anchor,
            written_section_anchors_json, change_count, created_at,
            repo_activity_json
     FROM plan_events
     WHERE plan_id = ?`,
    [planId],
  );
  type Acc = {
    writeCount: number; presenceCount: number; lastWriteAt: string | null; lastPresenceAt: string | null;
    repoFilesRead: number; repoFilesEdited: number; repoFilesCreated: number;
    testsRun: number; testsPassed: number; testsFailed: number; lastCommit: string | null;
  };
  const acc = new Map<string, Acc>();
  const bucket = (anchor: string): Acc => {
    let a = acc.get(anchor);
    if (!a) {
      a = {
        writeCount: 0, presenceCount: 0, lastWriteAt: null, lastPresenceAt: null,
        repoFilesRead: 0, repoFilesEdited: 0, repoFilesCreated: 0,
        testsRun: 0, testsPassed: 0, testsFailed: 0, lastCommit: null,
      };
      acc.set(anchor, a);
    }
    return a;
  };
  for (const r of rows) {
    const createdAt: string | null = r.created_at ?? null;
    // Parse the repo blob once per row (tolerant → null); fan the same totals onto
    // every bucket the turn is attributed to, identical to writeCount fan (I-8).
    const repo = parseRepoActivityEvidence(r.repo_activity_json);
    const addRepo = (a: Acc): void => {
      if (!repo) return;
      a.repoFilesRead    += repo.totals.filesRead;
      a.repoFilesEdited  += repo.totals.filesEdited;
      a.repoFilesCreated += repo.totals.filesCreated;
      a.testsRun    += repo.totals.testsRun;    // 0 in cut 1
      a.testsPassed += repo.totals.testsPassed;
      a.testsFailed += repo.totals.testsFailed;
      // lastCommit reserved — no commit capture in cut 1, stays null.
    };
    const written = parseAnchorList(r.written_section_anchors_json);
    if (written.length > 0) {
      // write side (D-4): fan the turn onto every anchor it actually wrote.
      for (const anchor of written) {
        const a = bucket(anchor);
        a.writeCount += 1;
        a.lastWriteAt = maxIso(a.lastWriteAt, createdAt);
        addRepo(a);
      }
    } else {
      // presence side (D-6): empty effect set → key dispatched-first.
      const key = r.dispatched_section_anchor ?? r.observed_section_anchor;
      if (!key) continue; // no section to attribute this presence turn to → drop
      const a = bucket(key);
      a.presenceCount += 1;
      a.lastPresenceAt = maxIso(a.lastPresenceAt, createdAt);
      addRepo(a);
    }
  }
  return Array.from(acc.entries()).map(([sectionAnchor, a]) => ({
    sectionAnchor,
    writeCount: a.writeCount,
    presenceCount: a.presenceCount,
    lastWriteAt: a.lastWriteAt,
    lastPresenceAt: a.lastPresenceAt,
    eventCount: a.writeCount + a.presenceCount,
    lastEventAt: maxIso(a.lastWriteAt, a.lastPresenceAt),
    repoFilesRead: a.repoFilesRead,
    repoFilesEdited: a.repoFilesEdited,
    repoFilesCreated: a.repoFilesCreated,
    testsRun: a.testsRun,
    testsPassed: a.testsPassed,
    testsFailed: a.testsFailed,
    lastCommit: a.lastCommit,
  }));
}

/** One trusted `plan_events` row projected for the WP5 tier-2 render (R2 §2.6):
 *  the resolver's attribution facts plus the kept-separate claimed self-report.
 *  `claimedPayload` is parsed from `claimed_payload_json` for display only — it
 *  is diagnostics data, never merged into the trusted fields. */
export type PlanEventRenderRow = {
  id: string;
  agentId: string;
  agentTitle: string | null;
  createdAt: string;
  observedSectionAnchor: string | null;
  dispatchedSectionAnchor: string | null;
  observedVia: string | null;
  attributionConfidence: string | null;
  sectionMismatch: boolean;
  mismatchReason: string | null;
  claimedSectionAnchor: string | null;
  claimedPayload: Record<string, unknown> | null;
  // GT-C §3.1 — no-op-vs-write discrimination (I-3) + honest multi-section hint
  // (render side of I-2). `changeCount` is the RAW fs-diff cardinality read from
  // the new `change_count` column (GT-A WP-A1 promoted it from the envelope to a
  // real column; the backfill populates it for historical rows). `observedCandidates`
  // is the audit candidate list, tolerantly parsed. Both never throw.
  changeCount: number;
  observedCandidates: string[];
  // GT-A WP-A2.2 — the turn's effect set (anchors it actually wrote), parsed from
  // the `written_section_anchors_json` column via `parseAnchorList` (tolerant, `[]`
  // on null/malformed). Empty = presence/no-op turn; length drives the renderer's
  // "wrote N sections" affordance (D-5: NOT `changeCount`).
  writtenSectionAnchors: string[];
  // Fix-4 — the turn's witnessed repo evidence, tolerantly parsed from the
  // `repo_activity_json` column (NULL/malformed/oversized → null, never throws;
  // mirrors the `claimedPayload` parse). Feeds the Layer-2 digest + Tier-1/2 counts.
  repoActivity: RepoActivityEvidenceV1 | null;
};

/** Per-event trusted rows for a plan's render surface (WP5 tier-2), oldest
 *  first. Unlike `getPlanEventRollup` (aggregate counts for the tier-1 chip),
 *  this returns each event's full attribution so the renderer can show the
 *  trusted/claimed split + mismatch flag. Events with no observed anchor are
 *  still returned (the renderer folds them into the Archived group, F-E). */
export function getPlanEventsForRender(planId: string): PlanEventRenderRow[] {
  return queryAll(
    `SELECT e.id, e.agent_id, a.title AS agent_title, e.created_at,
            e.observed_section_anchor, e.dispatched_section_anchor,
            e.observed_via, e.attribution_confidence,
            e.section_mismatch, e.mismatch_reason,
            e.claimed_section_anchor, e.claimed_payload_json,
            e.change_count, e.observed_candidates_json,
            e.written_section_anchors_json, e.repo_activity_json
     FROM plan_events e
     LEFT JOIN agents a ON a.id = e.agent_id
     WHERE e.plan_id = ?
     ORDER BY e.created_at ASC`,
    [planId],
  ).map((r) => {
    let claimedPayload: Record<string, unknown> | null = null;
    if (r.claimed_payload_json) {
      try {
        const parsed = JSON.parse(r.claimed_payload_json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) claimedPayload = parsed;
      } catch { /* malformed claimed payload is diagnostics-only — ignore, never throw */ }
    }
    // GT-C §3.1 — tolerant parse of the audit candidate list; malformed / non-array → [].
    let observedCandidates: string[] = [];
    if (r.observed_candidates_json) {
      try {
        const parsed = JSON.parse(r.observed_candidates_json);
        if (Array.isArray(parsed)) observedCandidates = parsed.filter((x) => typeof x === 'string');
      } catch { /* malformed candidates JSON — ignore, never throw */ }
    }
    return {
      id: r.id,
      agentId: r.agent_id,
      agentTitle: r.agent_title ?? null,
      createdAt: r.created_at,
      observedSectionAnchor: r.observed_section_anchor ?? null,
      dispatchedSectionAnchor: r.dispatched_section_anchor ?? null,
      observedVia: r.observed_via ?? null,
      attributionConfidence: r.attribution_confidence ?? null,
      sectionMismatch: Number(r.section_mismatch) === 1,
      mismatchReason: r.mismatch_reason ?? null,
      claimedSectionAnchor: r.claimed_section_anchor ?? null,
      claimedPayload,
      changeCount: Number(r.change_count) || 0,
      observedCandidates,
      writtenSectionAnchors: parseAnchorList(r.written_section_anchors_json),
      repoActivity: parseRepoActivityEvidence(r.repo_activity_json),
    };
  });
}

/** Fix-4 Tier-3 drill-down — one event's capped witnessed repo evidence, read
 *  straight from its `repo_activity_json` blob (tolerant parse → null). The
 *  `plan_id` in the WHERE prevents cross-plan id probing; api-server wraps the
 *  result in `RepoActivityDetail` via `toTier3Detail`. */
export function getPlanEventRepoActivity(planId: string, planEventId: string): RepoActivityEvidenceV1 | null {
  const row = queryOne(
    `SELECT repo_activity_json FROM plan_events WHERE id = ? AND plan_id = ?`,
    [planEventId, planId],
  );
  return row ? parseRepoActivityEvidence(row.repo_activity_json) : null;
}

// ── WP2: Provenance spine — effect store (R2 §2.4) + plan_events ────────────

export type PlanSectionChangeRow = {
  id: string;
  planId: string;
  sectionAnchor: string;
  blockAnchor: string | null;
  contentHash: string;
  changedAt: string;
};

function rowToPlanSectionChange(row: any): PlanSectionChangeRow {
  return {
    id: row.id,
    planId: row.plan_id,
    sectionAnchor: row.section_anchor,
    blockAnchor: row.block_anchor ?? null,
    contentHash: row.content_hash,
    changedAt: row.changed_at,
  };
}

/** Insert one effect row for a section/block whose byte-exact inner-HTML hash
 *  moved on a reparse (R2 §2.4). Written by section-cache.ts on reparse. */
export function recordPlanSectionChange(input: {
  planId: string;
  sectionAnchor: string;
  blockAnchor?: string | null;
  contentHash: string;
  changedAt?: string;
}): string {
  const id = uuidv4();
  run(
    `INSERT INTO plan_section_changes (id, plan_id, section_anchor, block_anchor, content_hash, changed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.planId, input.sectionAnchor, input.blockAnchor ?? null, input.contentHash,
     input.changedAt ?? new Date().toISOString()],
  );
  return id;
}

/** Effect anchors changed within [sinceIso, untilIso] for a plan (R2 §2.5 `changed`
 *  input), ordered by changed_at.
 *
 *  GT-C §1.8 — `sec_exectr` (the system-owned Execution Trail zone, a materialized
 *  cache of plan_events) is EXCLUDED: a system trail write must never register as
 *  an agent effect (attribution safety, distinct from clobber safety). Without
 *  this, materializing the trail would forge a phantom write onto whichever turn
 *  window happened to overlap the trail write. */
export function getTurnSectionChanges(planId: string, sinceIso: string, untilIso: string): PlanSectionChangeRow[] {
  return queryAll(
    `SELECT * FROM plan_section_changes
     WHERE plan_id = ? AND changed_at >= ? AND changed_at <= ?
       AND section_anchor != 'sec_exectr'
     ORDER BY changed_at ASC`,
    [planId, sinceIso, untilIso],
  ).map(rowToPlanSectionChange);
}

/** Fix-4: witnessed repo activity for a turn window. `file_activities.timestamp`
 *  is SQLite `datetime('now')` format (`YYYY-MM-DD HH:MM:SS`) but the compose
 *  window is ISO (`…T…Z`). Compare with `datetime()` on BOTH sides so the two
 *  formats normalize before comparison — a raw string compare (`timestamp >= ?`)
 *  would silently drop every row (`'2026-…T…Z' > '2026-… …'`). Second-precision
 *  timestamps make same-second rows common, so break ties by insert order (`id`).
 *
 *  I-10 (capture-drift): this is the SECOND consumer of `file_activities`; the
 *  `datetime()`-both-sides semantics + operation set are pinned by a drift test. */
export function getTurnRepoActivity(agentId: string, sinceIso: string, untilIso: string): FileActivity[] {
  return queryAll(
    `SELECT * FROM file_activities
     WHERE agent_id = ?
       AND datetime(timestamp) >= datetime(?)
       AND datetime(timestamp) <= datetime(?)
     ORDER BY datetime(timestamp) ASC, id ASC`,
    [agentId, sinceIso, untilIso],
  ).map(rowToFileActivity);
}

/** Order-preserving de-dup of a nullable anchor list (drops null/empty). Shared by
 *  the WP-A1 backfill's effect-set reconstruction. */
function uniqAnchors(anchors: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of anchors) {
    if (!a || seen.has(a)) continue;
    seen.add(a);
    out.push(a);
  }
  return out;
}

/** GT-A WP-A1 (§2 A1.4) — reconstruct `written_section_anchors_json` +
 *  `change_count` for historical plan_events rows written before the columns
 *  existed. Idempotent + NULL-guarded: only rows where
 *  `written_section_anchors_json IS NULL` are processed, and every processed row
 *  is set to a non-NULL value (malformed envelope / missing window / parse throw
 *  → `[]` / 0), so a second run is a strict no-op and no row is ever reprocessed.
 *
 *  Accurate for the historical run: workers had no plan tools then (I-1), so the
 *  fs-diff `changed` set (plan_section_changes over the turn window) was the only
 *  write signal anyway. `change_count` is the RAW change cardinality (D-5), NOT
 *  the de-duplicated written-set length. One transaction; per-row try/catch keeps
 *  one bad row from aborting the batch. */
export function backfillPlanEventWrittenSets(): void {
  const rows = queryAll(
    `SELECT id, trusted_envelope_json FROM plan_events WHERE written_section_anchors_json IS NULL`,
  );
  if (rows.length === 0) return; // strict no-op once every row is backfilled
  const update = db.prepare(
    `UPDATE plan_events
       SET written_section_anchors_json = ?, change_count = ?
     WHERE id = ?`,
  );
  const tx = db.transaction((batch: any[]) => {
    for (const r of batch) {
      try {
        const env = JSON.parse(r.trusted_envelope_json ?? '');
        const planId = env?.planId;
        const since = env?.window?.since;
        const until = env?.window?.until;
        if (typeof planId !== 'string' || typeof since !== 'string' || typeof until !== 'string') {
          update.run('[]', 0, r.id); // missing/malformed window → [] / 0, never NULL again
          continue;
        }
        const changes = getTurnSectionChanges(planId, since, until);
        const written = uniqAnchors(changes.map((c) => c.sectionAnchor));
        update.run(JSON.stringify(written), changes.length, r.id); // change_count = RAW cardinality (D-5)
      } catch {
        update.run('[]', 0, r.id); // parse throw → [] / 0, never NULL again
      }
    }
  });
  tx(rows);
}

// ── WP4: Section registry (R1 §2) — plan_sections helpers ───────────────────
// The durable side of addressability. HTML defines which sections exist and
// their prose; this table records anchor identity, lifecycle and lineage only.
// registerSectionsFromHtml (section-anchors.ts) drives inserts + soft-archives
// through these; kept here so the DB layer owns all SQL.

export type PlanSectionRow = {
  id: string;
  planId: string;
  anchor: string;
  parentSectionId: string | null;
  createdAt: string;
  archivedAt: string | null;
};

function rowToPlanSection(row: any): PlanSectionRow {
  return {
    id: row.id,
    planId: row.plan_id,
    anchor: row.anchor,
    parentSectionId: row.parent_section_id ?? null,
    createdAt: row.created_at,
    archivedAt: row.archived_at ?? null,
  };
}

/** All registered sections for a plan (archived included by default so orphan
 *  events still resolve to a NAMED archived section, never "unknown", F-E). */
export function getPlanSections(planId: string, opts?: { includeArchived?: boolean }): PlanSectionRow[] {
  const includeArchived = opts?.includeArchived ?? true;
  const sql = includeArchived
    ? `SELECT * FROM plan_sections WHERE plan_id = ? ORDER BY created_at ASC`
    : `SELECT * FROM plan_sections WHERE plan_id = ? AND archived_at IS NULL ORDER BY created_at ASC`;
  return queryAll(sql, [planId]).map(rowToPlanSection);
}

/** Look up one section by its (plan, anchor) identity — archived or not. */
export function getPlanSectionByAnchor(planId: string, anchor: string): PlanSectionRow | null {
  const row = queryOne(`SELECT * FROM plan_sections WHERE plan_id = ? AND anchor = ?`, [planId, anchor]);
  return row ? rowToPlanSection(row) : null;
}

/** Insert a section row (server-minted anchor). Idempotent on (plan_id, anchor)
 *  via INSERT OR IGNORE — a re-registered anchor never duplicates. Returns the
 *  row id (existing or new). */
export function insertPlanSection(input: {
  planId: string;
  anchor: string;
  parentSectionId?: string | null;
  createdAt?: string;
}): string {
  const existing = getPlanSectionByAnchor(input.planId, input.anchor);
  if (existing) {
    // A previously-archived section that reappears un-archives (its prose came back).
    if (existing.archivedAt) {
      run(`UPDATE plan_sections SET archived_at = NULL WHERE id = ?`, [existing.id]);
    }
    return existing.id;
  }
  const id = uuidv4();
  run(
    `INSERT INTO plan_sections (id, plan_id, anchor, parent_section_id, created_at, archived_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    [id, input.planId, input.anchor, input.parentSectionId ?? null, input.createdAt ?? new Date().toISOString()],
  );
  return id;
}

/** Soft-delete: set archived_at for an anchor that disappeared from the reparsed
 *  HTML (F-E). NEVER DELETE the row; its plan_events stay resolvable. No-op if
 *  the anchor is unknown or already archived. */
export function archivePlanSection(planId: string, anchor: string, archivedAt?: string): void {
  run(
    `UPDATE plan_sections SET archived_at = ? WHERE plan_id = ? AND anchor = ? AND archived_at IS NULL`,
    [archivedAt ?? new Date().toISOString(), planId, anchor],
  );
}

// ── WP4: Snapshot history (amendments §F-B) — content-addressed blob store ────

/** sha256 hex of the full HTML — the content-addressing key. */
export function hashPlanHtml(html: string): string {
  return crypto.createHash('sha256').update(html, 'utf8').digest('hex');
}

/**
 * Record a reparse snapshot (F-B). Consecutive-dedup: if the plan's latest
 * snapshot already carries this hash, nothing is written (a no-op reparse never
 * spams identical history rows). Otherwise the blob INSERT-OR-IGNORE (stores the
 * HTML once globally, even across A→B→A) and the history reference row are
 * written in ONE transaction, so a crash leaves neither an orphan blob nor a
 * dangling reference. Returns the new snapshot row id, or null on dedup skip.
 */
export function recordPlanSnapshot(planId: string, html: string, createdAt?: string): string | null {
  const hash = hashPlanHtml(html);
  const latest = queryOne(
    `SELECT content_hash FROM plan_snapshots WHERE plan_id = ? ORDER BY created_at DESC LIMIT 1`,
    [planId],
  );
  if (latest && latest.content_hash === hash) return null; // consecutive-dedup: reparse changed nothing
  const now = createdAt ?? new Date().toISOString();
  const id = uuidv4();
  const tx = db.transaction(() => {
    run(
      `INSERT OR IGNORE INTO plan_snapshot_blobs (content_hash, html, byte_size, first_seen_at)
       VALUES (?, ?, ?, ?)`,
      [hash, html, Buffer.byteLength(html, 'utf8'), now],
    );
    run(
      `INSERT INTO plan_snapshots (id, plan_id, content_hash, created_at) VALUES (?, ?, ?, ?)`,
      [id, planId, hash, now],
    );
  });
  tx();
  return id;
}

/** Latest successful snapshot HTML for a plan (F-E parse-failure reconstruction:
 *  reparse this blob when the live parse fails and no in-memory last-good exists). */
export function getLatestPlanSnapshotHtml(planId: string): string | null {
  const row = queryOne(
    `SELECT b.html AS html FROM plan_snapshots s
       JOIN plan_snapshot_blobs b ON b.content_hash = s.content_hash
      WHERE s.plan_id = ? ORDER BY s.created_at DESC LIMIT 1`,
    [planId],
  );
  return row ? (row.html as string) : null;
}

/** Observable growth metric (F-B; retention is "none, observable" in v1). Scoped
 *  to one plan's reference rows when planId is given; blob counts/bytes are
 *  global (blobs are shared content-addressed storage). */
export function getPlanSnapshotStats(planId?: string): {
  snapshotRows: number; blobRows: number; totalBlobBytes: number;
} {
  const snapshotRows = planId
    ? (queryOne(`SELECT COUNT(*) AS c FROM plan_snapshots WHERE plan_id = ?`, [planId])?.c ?? 0)
    : (queryOne(`SELECT COUNT(*) AS c FROM plan_snapshots`)?.c ?? 0);
  const blobRows = queryOne(`SELECT COUNT(*) AS c FROM plan_snapshot_blobs`)?.c ?? 0;
  const totalBlobBytes = queryOne(`SELECT COALESCE(SUM(byte_size), 0) AS s FROM plan_snapshot_blobs`)?.s ?? 0;
  return { snapshotRows: Number(snapshotRows), blobRows: Number(blobRows), totalBlobBytes: Number(totalBlobBytes) };
}

/** Compose row shape written by composePlanEvent (F-A columns). */
export type InsertPlanEventInput = {
  planId: string;
  agentId: string;
  eventType: string;
  dispatchedSectionAnchor?: string | null;
  observedSectionAnchor?: string | null;
  observedVia?: string | null;
  attributionConfidence?: string | null;
  observedCandidatesJson?: string | null;
  readIntentAnchor?: string | null;
  editTargetAnchor?: string | null;
  sectionMismatch?: boolean;
  mismatchReason?: string | null;
  trustedEnvelopeJson: string;
  claimedPayloadJson?: string | null;
  claimedSectionAnchor?: string | null;
  // GT-A WP-A1 (§2 A1.2) — effect-set columns. `writtenSectionAnchorsJson` = JSON
  // array of anchors the turn actually wrote (uniq(changed); `[]`/omitted → NULL
  // is never written by composePlanEvent, it always passes '[]'). `changeCount` =
  // RAW fs-diff change cardinality (D-5).
  writtenSectionAnchorsJson?: string | null;
  changeCount?: number;
  // Fix-4 — serialized RepoActivityEvidenceV1 (byte-capped at write time). NULL =
  // not captured (deps absent / rollup failed / no plan context). Never blocks the row.
  repoActivityJson?: string | null;
  createdAt?: string;
};

export function insertPlanEvent(input: InsertPlanEventInput): string {
  const id = uuidv4();
  run(
    `INSERT INTO plan_events
       (id, plan_id, agent_id, event_type, created_at,
        dispatched_section_anchor, observed_section_anchor, observed_via,
        attribution_confidence, observed_candidates_json, read_intent_anchor,
        edit_target_anchor, section_mismatch, mismatch_reason,
        trusted_envelope_json, claimed_payload_json, claimed_section_anchor,
        written_section_anchors_json, change_count, repo_activity_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.planId, input.agentId, input.eventType, input.createdAt ?? new Date().toISOString(),
     input.dispatchedSectionAnchor ?? null, input.observedSectionAnchor ?? null, input.observedVia ?? null,
     input.attributionConfidence ?? null, input.observedCandidatesJson ?? null, input.readIntentAnchor ?? null,
     input.editTargetAnchor ?? null, input.sectionMismatch ? 1 : 0, input.mismatchReason ?? null,
     input.trustedEnvelopeJson, input.claimedPayloadJson ?? null, input.claimedSectionAnchor ?? null,
     input.writtenSectionAnchorsJson ?? null, input.changeCount ?? 0, input.repoActivityJson ?? null],
  );
  return id;
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
  privilegeLane?: 'supervisor';
  // Bug 2 / Edit 2.6 — persist the codex-hook decision so the runner env gate is
  // re-derivable from the stored row on reconcile. Defaults to false when absent.
  wantsCodexHooks?: boolean;
  tmuxSessionName: string | null;
  autoRestartEnabled: boolean;
  logPath: string;
  templateId?: string | null;
  systemPrompt?: string | null;
  ownerAgentId?: string | null;
  // notifyOwner mute (default true). undefined/true → notify_owner = 1; false → 0.
  notifyOwner?: boolean;
  // Planning surface WP1: frozen-at-launch plan rail. plan_id references an
  // existing plans row (validated at the launch route); plan_section is the
  // target section anchor. Both stay NULL for unbound launches.
  planId?: string | null;
  planSection?: string | null;
}): Agent {
  const id = uuidv4();
  const slug = slugify(data.title);
  run(
    `INSERT INTO agents (id, workspace_id, title, slug, role_description, working_directory,
      command, provider, is_supervisor, is_supervised, is_worker, is_researcher, privilege_lane, wants_codex_hooks, tmux_session_name, auto_restart_enabled, log_path, template_id, system_prompt, owner_agent_id, notify_owner, plan_id, plan_section)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, data.workspaceId, data.title, slug, data.roleDescription, data.workingDirectory,
      data.command, data.provider || 'claude', data.isSupervisor ? 1 : 0, data.isSupervised ? 1 : 0, data.isWorker ? 1 : 0, data.isResearcher ? 1 : 0, data.privilegeLane === 'supervisor' ? 'supervisor' : null, data.wantsCodexHooks ? 1 : 0, data.tmuxSessionName, data.autoRestartEnabled ? 1 : 0, data.logPath,
      data.templateId || null, data.systemPrompt || null, data.ownerAgentId || null, data.notifyOwner === false ? 0 : 1,
      data.planId || null, data.planSection || null]
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

/**
 * Resolve the agent that should RECEIVE `worker`'s lifecycle events.
 * Returns a recipient that is NOT necessarily the owner:
 *  1. Explicit owner edge (the launcher), if alive  → the owner.
 *  2. Terminal/missing explicit owner               → structural supervisor backstop.
 *  3. No owner edge but supervised                  → structural supervisor (legacy).
 *  4. Otherwise                                     → null (unowned + unsupervised → drop).
 * The backstop (2) is an operational visibility fallback only: it is NOT fanout
 * and NOT a retry. Busy/compacted owners are NEVER routed here — they queue in
 * EventBridge.deliver(); only a missing or terminal owner falls back.
 */
export function getOwnerForWorker(worker: Agent): Agent | null {
  if (worker.ownerAgentId) {
    const owner = getAgent(worker.ownerAgentId);
    if (owner && !['done', 'crashed'].includes(owner.status)) return owner;
    return getSupervisorAgent(worker.workspaceId); // terminal/missing-owner backstop (may be null)
  }
  if (worker.isSupervised) return getSupervisorAgent(worker.workspaceId);
  return null;
}

export function getActiveAgents(): Agent[] {
  return queryAll(
    "SELECT * FROM agents WHERE status NOT IN ('done', 'crashed') ORDER BY created_at DESC"
  ).map(rowToAgent);
}

/**
 * One-writer-per-plan agent guard (GT-C §O.1). Returns the first non-exempt agent
 * still bound to this plan that could ACTIVELY write it, else null.
 *
 * AMENDED ownership model (maintainer sign-off, planning-surface-issues.md §4.4,
 * authoritative over gt-c §O.1/O.4/O.5): filter to ACTIVELY-WORKING statuses only —
 * `status IN ('working','launching')` — NOT the artifact's `NOT IN ('done','crashed')`.
 * An IDLE plan-bound agent keeps its `plan_id` binding (re-messageable to continue
 * its section; rail env intact) but MUST NOT reserve the plan — the Lares pattern of
 * keeping a seed worker idle across GT phases stays legal, so an idle plan-bound
 * agent resolves to null here. `exemptAgentIds` lets a completing run exclude its
 * own members. Ordered by created_at ASC so the reservation is stable/deterministic.
 */
export function getLiveRailAgentForPlan(planId: string, exemptAgentIds: string[] = []): Agent | null {
  const rows = queryAll(
    "SELECT * FROM agents WHERE plan_id = ? AND status IN ('working', 'launching') ORDER BY created_at ASC",
    [planId],
  ).map(rowToAgent);
  return rows.find((a) => !exemptAgentIds.includes(a.id)) ?? null;
}

/** GT-C §1.8 — count of agents actively writing this plan (`working`/`launching`).
 *  Diagnostics only; shares the amended actively-working filter with
 *  `getLiveRailAgentForPlan` (idle plan-bound agents are NOT counted). */
export function getActiveRailWriterCount(planId: string): number {
  const row = queryOne(
    "SELECT COUNT(*) AS c FROM agents WHERE plan_id = ? AND status IN ('working', 'launching')",
    [planId],
  );
  return Number(row?.c) || 0;
}

/** Context-brick Inc 3 (3.1) — the agents a given agent LAUNCHED (its owner
 *  edge, `owner_agent_id`, stamped from SELF_ID at launch — read-only here).
 *  Default is the live set (terminal statuses excluded, same done/crashed set
 *  as getActiveAgents); `includeTerminal` adds the finished/crashed rows — the
 *  graveyard window a revived supervisor pulls to see what it was running.
 *  Newest first. */
export function getAgentsByOwner(ownerAgentId: string, opts?: { includeTerminal?: boolean }): Agent[] {
  const sql = opts?.includeTerminal
    ? 'SELECT * FROM agents WHERE owner_agent_id = ? ORDER BY created_at DESC'
    : "SELECT * FROM agents WHERE owner_agent_id = ? AND status NOT IN ('done', 'crashed') ORDER BY created_at DESC";
  return queryAll(sql, [ownerAgentId]).map(rowToAgent);
}

/**
 * Idle-agent lifecycle §B3 — THE single atomic status-transition writer.
 *
 * Every status write goes through here so the idle/stop bookkeeping columns
 * stay truthful. If any writer bypasses it, `idle_since` silently goes wrong
 * and the whole stale-idle feature becomes untrustworthy.
 *
 * Returns the in-transaction prior status alongside the new one, so a
 * `statusChanged` emitter can carry an honest `fromStatus` WITHOUT a second,
 * racy `getAgent()` read. Returns null when the row does not exist.
 *
 * Invariants (all enforced in one UPDATE, inside one transaction):
 *   - `idle_since` is stamped on entering idle, PRESERVED across an idle→idle
 *     write, and cleared the instant the agent leaves idle.
 *   - `status_changed_at` moves only on a genuine status change.
 *   - `stopped_at` / `last_stop_reason` are SET when a reason is supplied,
 *     cleared on a genuine status change with no reason, and otherwise LEFT
 *     INTACT — so a redundant reasonless `done → done` write can never erase
 *     "Stopped manually".
 *   - `receiving` is projection-only and is rejected at runtime as well as by
 *     the `PersistedAgentStatus` parameter type.
 *   - an invalid stop reason is rejected BEFORE anything is persisted.
 *
 * Positional `?` parameters (rather than the named `@s`/`@now` form) so the
 * statement binds identically under better-sqlite3 and under the sql.js
 * stand-in the main-process tests use.
 */
export function applyStatusTransition(
  id: string,
  status: PersistedAgentStatus,
  opts?: { stopReason?: AgentStopReason },
): { prior: AgentStatus; current: AgentStatus } | null {
  if ((status as AgentStatus) === 'receiving') {
    throw new Error('receiving is projection-only and must not be persisted');
  }
  const reason = opts?.stopReason ?? null;
  if (reason !== null && !isAgentStopReason(reason)) {
    throw new Error(`invalid stop reason: ${String(reason)}`);
  }
  return db.transaction(() => {
    const row = db.prepare(`SELECT status FROM agents WHERE id = ?`).get(id) as
      | { status: AgentStatus }
      | undefined;
    if (!row) return null;
    const now = (db.prepare(`SELECT datetime('now') AS t`).get() as { t: string }).t;
    db.prepare(
      `UPDATE agents SET
         idle_since = CASE
           WHEN ? = 'idle' AND status <> 'idle' THEN ?
           WHEN ? <> 'idle'                     THEN NULL
           ELSE idle_since END,
         status_changed_at = CASE WHEN status <> ? THEN ? ELSE status_changed_at END,
         stopped_at = CASE
           WHEN ? IS NOT NULL THEN ?     -- a real stop (reason present) sets it
           WHEN status <> ?   THEN NULL  -- a genuine status change clears it
           ELSE stopped_at END,          -- redundant same-status write PRESERVES it
         last_stop_reason = CASE
           WHEN ? IS NOT NULL THEN ?
           WHEN status <> ?   THEN NULL
           ELSE last_stop_reason END,
         status = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      status, now, status,      // idle_since
      status, now,              // status_changed_at
      reason, now, status,      // stopped_at
      reason, reason, status,   // last_stop_reason
      status, now, id,          // status / updated_at / WHERE
    );
    return { prior: row.status, current: status as AgentStatus };
  })();
}

/** Shim for the many non-emitting status writes. Kept so existing callers
 *  compile unchanged while still routing through the transition writer — there
 *  is no status-write path that bypasses `applyStatusTransition`. */
export function updateAgentStatus(id: string, status: PersistedAgentStatus): void {
  applyStatusTransition(id, status);
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

/** WP5 — persist the unified SendOutcome for an agent (or clear it with null).
 *  A later `confirmed` outcome supersedes a prior `delivered-unconfirmed`; the
 *  caller owns that ordering. Read projection only — never gates status. */
export function updateAgentLastSend(
  id: string,
  outcome: import('../shared/types').SendOutcome | null,
): void {
  run(
    "UPDATE agents SET last_send = ?, updated_at = datetime('now') WHERE id = ?",
    [outcome ? JSON.stringify(outcome) : null, id],
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

// ── Context-brick Inc 4 (4.3) — continuation attempts + bricks ─────────────

export type ContinuationAttemptStatus = 'open' | 'committed' | 'aborted' | 'relaunched';

export interface ContinuationHandoffAttempt {
  id: string;
  dashboardAgentId: string;
  /** The successor generation this attempt owns (agent gen + 1 at open). */
  generation: number;
  startedAt: string;
  closedAt: string | null;
  status: ContinuationAttemptStatus;
  reason: string | null;
  thresholdContextPct: number | null;
}

export type ContinuationAttemptBinding = ResolvedPlanStamp | {
  planId: null;
  planItemId: null;
  source: 'legacy-unstamped';
};

export interface ContinuationBrickRow {
  id: string;
  dashboardAgentId: string;
  handoffAttemptId: string;
  generation: number;
  note: string;
  noteSource: 'tool' | 'scrape';
  byteLen: number;
  writtenAt: string;
  supersededAt: string | null;
}

function rowToContinuationAttempt(row: any): ContinuationHandoffAttempt {
  return {
    id: row.id,
    dashboardAgentId: row.dashboard_agent_id,
    generation: row.generation,
    startedAt: row.started_at,
    closedAt: row.closed_at ?? null,
    status: row.status as ContinuationAttemptStatus,
    reason: row.reason ?? null,
    thresholdContextPct: row.threshold_context_pct ?? null,
  };
}

function rowToContinuationBrick(row: any): ContinuationBrickRow {
  return {
    id: row.id,
    dashboardAgentId: row.dashboard_agent_id,
    handoffAttemptId: row.handoff_attempt_id,
    generation: row.generation,
    note: row.note,
    noteSource: row.note_source as 'tool' | 'scrape',
    byteLen: row.byte_len,
    writtenAt: row.written_at,
    supersededAt: row.superseded_at ?? null,
  };
}

/** Millisecond-resolution timestamp so `written_at > attempt.started_at`
 *  comparisons don't collapse inside `datetime('now')`'s 1-second grain. */
const NOW_MS_SQL = `strftime('%Y-%m-%d %H:%M:%f','now')`;

export function setContinuationGeneration(agentId: string, gen: number): void {
  run("UPDATE agents SET continuation_generation = ?, updated_at = datetime('now') WHERE id = ?", [gen, agentId]);
}

/** Per-agent continuation toggle (Edward 2026-07-05). Persisted so the watcher's
 *  `continuation-disabled` blocker survives restart/reconcile — the watcher reads
 *  the flag live from the DB row via its isContinuationEnabled effect. */
export function setContinuationEnabled(agentId: string, enabled: boolean): void {
  run("UPDATE agents SET continuation_enabled = ?, updated_at = datetime('now') WHERE id = ?", [enabled ? 1 : 0, agentId]);
}

/** Mint a handoff attempt, allocating successorGen = agent gen + 1. The
 *  attempt OWNS that generation. Throws if the agent is missing or already
 *  has an open attempt (one-open-max). */
export function createContinuationHandoffAttempt(
  agentId: string,
  opts?: { reason?: string; thresholdContextPct?: number },
): ContinuationHandoffAttempt {
  const tx = db.transaction(() => {
    const agentRow = queryOne('SELECT continuation_generation FROM agents WHERE id = ?', [agentId]);
    if (!agentRow) throw new Error(`createContinuationHandoffAttempt: no agent ${agentId}`);
    const open = queryOne(
      "SELECT id FROM continuation_handoff_attempts WHERE dashboard_agent_id = ? AND status = 'open'",
      [agentId],
    );
    if (open) throw new Error(`createContinuationHandoffAttempt: agent ${agentId} already has open attempt ${open.id}`);
    const id = uuidv4();
    const successorGen = (agentRow.continuation_generation ?? 0) + 1;
    run(
      `INSERT INTO continuation_handoff_attempts (id, dashboard_agent_id, generation, started_at, status, reason, threshold_context_pct)
       VALUES (?, ?, ?, ${NOW_MS_SQL}, 'open', ?, ?)`,
      [id, agentId, successorGen, opts?.reason ?? null, opts?.thresholdContextPct ?? null],
    );
    return id;
  });
  const id = tx();
  return getContinuationAttempt(id)!;
}

export function getContinuationAttempt(id: string): ContinuationHandoffAttempt | null {
  const row = queryOne('SELECT * FROM continuation_handoff_attempts WHERE id = ?', [id]);
  return row ? rowToContinuationAttempt(row) : null;
}

/** Persist the continuation's active binding exactly once before teardown. */
export function freezeContinuationAttemptBinding(
  attemptId: string,
  binding: ResolvedPlanStamp,
): ContinuationAttemptBinding {
  if (binding.source !== 'continuation-carry') {
    throw new Error(`continuation attempt requires continuation-carry, got '${binding.source}'`);
  }
  if (binding.planItemId !== null) {
    throw new Error('plan_item_id is unsupported until plan_work_packages exists');
  }
  const tx = db.transaction(() => {
    const attempt = queryOne(
      'SELECT plan_id, plan_item_id, plan_stamp_source FROM continuation_handoff_attempts WHERE id = ?',
      [attemptId],
    );
    if (!attempt) throw new Error(`freezeContinuationAttemptBinding: no attempt ${attemptId}`);
    if (attempt.plan_stamp_source === 'legacy-unstamped') {
      run(
        `UPDATE continuation_handoff_attempts
            SET plan_id = ?, plan_item_id = ?, plan_stamp_source = ?
          WHERE id = ? AND plan_stamp_source = 'legacy-unstamped'`,
        [binding.planId, binding.planItemId, binding.source, attemptId],
      );
      return;
    }
    if (attempt.plan_stamp_source !== 'continuation-carry') {
      throw new Error(`continuation attempt ${attemptId} has invalid frozen source '${String(attempt.plan_stamp_source)}'`);
    }
    // Idempotent retry: once frozen, the stored value wins even if mutable live
    // agent state changed after a prior relaunch attempt failed.
  });
  tx();
  return getContinuationAttemptBinding(attemptId)!;
}

/** Read only the attempt-frozen binding. Legacy attempts stay explicitly
 * unavailable instead of falling back to turn_records or agents.plan_id. */
export function getContinuationAttemptBinding(attemptId: string): ContinuationAttemptBinding | null {
  const row = queryOne(
    'SELECT plan_id, plan_item_id, plan_stamp_source FROM continuation_handoff_attempts WHERE id = ?',
    [attemptId],
  );
  if (!row) return null;
  const source = row.plan_stamp_source as PersistedTurnPlanStampSource;
  if (source === 'legacy-unstamped') {
    return { planId: null, planItemId: null, source };
  }
  if (!TURN_PLAN_STAMP_SOURCES.has(source)) {
    throw new Error(`invalid continuation attempt plan stamp source '${String(row.plan_stamp_source)}'`);
  }
  return {
    planId: row.plan_id ?? null,
    planItemId: row.plan_item_id ?? null,
    source,
  };
}

/** Latest attempt for an agent, optionally filtered by status (newest by
 *  started_at). Used by the relaunch route's server-side re-check. */
export function getLatestContinuationAttempt(
  agentId: string,
  status?: ContinuationAttemptStatus,
): ContinuationHandoffAttempt | null {
  const row = status
    ? queryOne(
        'SELECT * FROM continuation_handoff_attempts WHERE dashboard_agent_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1',
        [agentId, status],
      )
    : queryOne(
        'SELECT * FROM continuation_handoff_attempts WHERE dashboard_agent_id = ? ORDER BY started_at DESC LIMIT 1',
        [agentId],
      );
  return row ? rowToContinuationAttempt(row) : null;
}

/** Inc 4 (4.4) relaunch gate — is any orchestration owned by this supervisor
 *  live? Only 'starting'|'running' block; 'stalled'/'aborted' are ended-but-
 *  resumable and deliberately non-blocking (revisit if a live-but-not-running
 *  RunStatus is ever added). */
export function hasRunningOrchestrationForSupervisor(supervisorId: string): boolean {
  return !!queryOne(
    "SELECT run_id FROM orchestrations WHERE supervisor_id = ? AND status IN ('starting','running') LIMIT 1",
    [supervisorId],
  );
}

/** Phase 5B (Option B) — the durable EFFORT BUDGET that authorizes a note-less
 *  "escape" relaunch (replacing the deleted context-% hard ceiling). Scoped to
 *  the CURRENT successor cycle: only attempts for this agent at
 *  `successorGeneration` that were created AFTER the most recent 'relaunched'
 *  attempt count, so a prior generation's failures can never pre-exhaust a fresh
 *  cycle.
 *   - `abortedCount` = those attempts closed 'aborted'.
 *   - `firstAttemptStartedAt` = min(started_at) across ALL such attempts,
 *     INCLUDING the current still-open one — so the alive-time clock starts at
 *     the first attempt and can trip before any abort is recorded.
 *  Timestamps are the millisecond-resolution UTC strings written via NOW_MS_SQL
 *  ('YYYY-MM-DD HH:MM:SS.fff'); the caller converts to epoch ms as UTC. */
export function getContinuationEscapeBudget(
  agentId: string,
  successorGeneration: number,
): { abortedCount: number; firstAttemptStartedAt: string | null } {
  // High-water mark: the most recent 'relaunched' attempt's start. Attempts
  // at/before it belong to a prior, already-resolved cycle. Empty string when
  // the agent has never relaunched (every current-gen attempt then qualifies).
  const lastRelaunch = queryOne(
    "SELECT started_at FROM continuation_handoff_attempts WHERE dashboard_agent_id = ? AND status = 'relaunched' ORDER BY started_at DESC LIMIT 1",
    [agentId],
  );
  const since: string = (lastRelaunch?.started_at as string) ?? '';
  const row = queryOne(
    `SELECT SUM(CASE WHEN status = 'aborted' THEN 1 ELSE 0 END) AS aborted_count,
            MIN(started_at) AS first_started_at
       FROM continuation_handoff_attempts
      WHERE dashboard_agent_id = ? AND generation = ? AND started_at > ?`,
    [agentId, successorGeneration, since],
  );
  return {
    abortedCount: (row?.aborted_count as number) ?? 0,
    firstAttemptStartedAt: (row?.first_started_at as string | null) ?? null,
  };
}

export function getOpenContinuationAttempt(agentId: string): ContinuationHandoffAttempt | null {
  const row = queryOne(
    "SELECT * FROM continuation_handoff_attempts WHERE dashboard_agent_id = ? AND status = 'open'",
    [agentId],
  );
  return row ? rowToContinuationAttempt(row) : null;
}

export function getAllOpenContinuationAttempts(): ContinuationHandoffAttempt[] {
  return queryAll(
    "SELECT * FROM continuation_handoff_attempts WHERE status = 'open' ORDER BY started_at ASC",
  ).map(rowToContinuationAttempt);
}

/** Application-boot lifecycle op (NOT schema init — tests and some processes call
 *  initDatabase more than once; this must run exactly once per app start).
 *
 *  An 'open' attempt row is owned by one live watcher cycle, and that ownership
 *  is in-memory only — it does not survive process exit. Left alone the row 409s
 *  every future attempt-open forever, silently disabling handoff for the agent.
 *
 *  We do NOT blanket-abort, because an attempt stays 'open' until relaunch closes
 *  it 'relaunched' — so the window between brick-commit and relaunch is an open
 *  row that ALREADY earned kill authorization. Aborting that row would destroy a
 *  committed note and burn an escape-budget abort. Resumability is therefore
 *  keyed on a DURABLE fact (a tool-source brick written after the attempt opened
 *  — the same predicate as isKillAuthorized), never on generation equality, which
 *  proves the row targets the next generation but proves nothing about ownership. */
export function reconcileStaleOpenContinuationAttempts(): {
  aborted: Array<{ agentId: string; attemptId: string; reason: string }>;
  resumable: Array<{ agentId: string; attemptId: string }>;
} {
  const aborted: Array<{ agentId: string; attemptId: string; reason: string }> = [];
  const resumable: Array<{ agentId: string; attemptId: string }> = [];
  const tx = db.transaction(() => {
    for (const att of getAllOpenContinuationAttempts()) {
      const agent = getAgent(att.dashboardAgentId);
      let reason: string | null = null;
      if (!agent) reason = 'agent no longer exists';
      else if (agent.status === 'done' || agent.status === 'crashed') reason = `agent is ${agent.status}`;
      else if (att.generation !== (agent.continuationGeneration ?? 0) + 1) {
        reason = `stale generation ${att.generation} (successor is ${(agent.continuationGeneration ?? 0) + 1})`;
      } else {
        const brick = getLatestBrickForAttempt(att.dashboardAgentId, att.id, { source: 'tool' });
        if (!brick || !(brick.writtenAt > att.startedAt)) reason = 'no continuation note was committed';
      }
      if (reason === null) {
        resumable.push({ agentId: att.dashboardAgentId, attemptId: att.id });
        addEvent(att.dashboardAgentId, 'continuation_attempt_resumable', JSON.stringify({
          attemptId: att.id, generation: att.generation,
          detail: 'open attempt survived an app restart WITH a committed note; the watcher may adopt it',
        }));
        continue;
      }
      closeContinuationHandoffAttempt(att.id, 'aborted');
      addEvent(att.dashboardAgentId, 'continuation_aborted', JSON.stringify({
        attemptId: att.id, detail: `abandoned across app restart — ${reason}`,
      }));
      aborted.push({ agentId: att.dashboardAgentId, attemptId: att.id, reason });
    }
  });
  tx();
  return { aborted, resumable };
}

export function closeContinuationHandoffAttempt(id: string, status: ContinuationAttemptStatus): void {
  run(
    `UPDATE continuation_handoff_attempts SET status = ?, closed_at = ${NOW_MS_SQL} WHERE id = ?`,
    [status, id],
  );
}

/** Append a brick row (append-only) and soft-supersede the agent's prior
 *  current brick in the same transaction. Returns the new brick id (noteId). */
export function insertContinuationBrick(input: {
  agentId: string;
  handoffAttemptId: string;
  generation: number;
  note: string;
  noteSource: 'tool' | 'scrape';
}): string {
  const id = uuidv4();
  const byteLen = Buffer.byteLength(input.note, 'utf8');
  const tx = db.transaction(() => {
    run(
      `UPDATE continuation_bricks SET superseded_at = ${NOW_MS_SQL}
       WHERE dashboard_agent_id = ? AND superseded_at IS NULL`,
      [input.agentId],
    );
    run(
      `INSERT INTO continuation_bricks (id, dashboard_agent_id, handoff_attempt_id, generation, note, note_source, byte_len, written_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ${NOW_MS_SQL})`,
      [id, input.agentId, input.handoffAttemptId, input.generation, input.note, input.noteSource, byteLen],
    );
  });
  tx();
  return id;
}

/** Gate authority read: latest brick for a specific attempt, optionally
 *  filtered by note_source ('tool' is the only kill-authorizing source). */
export function getLatestBrickForAttempt(
  agentId: string,
  attemptId: string,
  opts?: { source?: 'tool' | 'scrape' },
): ContinuationBrickRow | null {
  const row = opts?.source
    ? queryOne(
        `SELECT * FROM continuation_bricks
         WHERE dashboard_agent_id = ? AND handoff_attempt_id = ? AND note_source = ?
         ORDER BY written_at DESC LIMIT 1`,
        [agentId, attemptId, opts.source],
      )
    : queryOne(
        `SELECT * FROM continuation_bricks
         WHERE dashboard_agent_id = ? AND handoff_attempt_id = ?
         ORDER BY written_at DESC LIMIT 1`,
        [agentId, attemptId],
      );
  return row ? rowToContinuationBrick(row) : null;
}

/** Builder-gate fallback: the agent's current (non-superseded) brick. */
export function getCurrentBrick(agentId: string): ContinuationBrickRow | null {
  const row = queryOne(
    `SELECT * FROM continuation_bricks
     WHERE dashboard_agent_id = ? AND superseded_at IS NULL
     ORDER BY written_at DESC LIMIT 1`,
    [agentId],
  );
  return row ? rowToContinuationBrick(row) : null;
}

/** Context-brick Inc 4 (4.1 step 3) — the atomic relaunch transaction:
 *  new session id + generation bump (to the attempt's successorGen) +
 *  attempt close ('relaunched'), all-or-nothing. This is the ONLY place the
 *  agent's continuation_generation advances. */
export function commitContinuationRelaunch(
  agentId: string,
  newSessionId: string,
  successorGen: number,
  attemptId: string,
): void {
  const tx = db.transaction(() => {
    // Phase 1 — capture the session transition BEFORE resume_session_id is
    // overwritten (it still holds the OUTGOING id here). Close the outgoing
    // session and append the successor at the attempt's successorGen. Lineage
    // keys on session_id, so the successor is always a distinct row even if a
    // future `/clear` reuses this generation.
    const row = queryOne(
      'SELECT resume_session_id, working_directory, provider FROM agents WHERE id = ?',
      [agentId],
    );
    if (row) {
      const outgoing = row.resume_session_id as string | null;
      if (outgoing) closeAgentSession(agentId, outgoing);
      insertAgentSession(
        agentId,
        successorGen,
        newSessionId,
        row.working_directory as string,
        (row.provider || 'claude') as string,
      );
    }
    updateAgentResumeSessionId(agentId, newSessionId);
    setContinuationGeneration(agentId, successorGen);
    closeContinuationHandoffAttempt(attemptId, 'relaunched');
  });
  tx();
}

// ── Context-brick Phase 1: durable session lineage helpers ─────────────────

function rowToAgentSession(row: any): AgentSessionRow {
  return {
    id: row.id,
    dashboardAgentId: row.dashboard_agent_id,
    generation: row.generation,
    sessionId: row.session_id,
    workingDirectory: row.working_directory,
    provider: (row.provider || 'claude') as AgentSessionRow['provider'],
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    jsonlPresent: row.jsonl_present ?? null,
  };
}

/** Record a session in the durable lineage. Idempotent: keyed on
 *  (dashboard_agent_id, session_id), a re-observed session (e.g. a plain
 *  restart resuming the same id) is a no-op rather than a duplicate row.
 *  `generation` is an ordering hint only — NEVER used to dedup. */
export function insertAgentSession(
  agentId: string,
  generation: number,
  sessionId: string,
  workingDirectory: string,
  provider: string,
): void {
  run(
    `INSERT INTO agent_sessions
       (dashboard_agent_id, generation, session_id, working_directory, provider)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(dashboard_agent_id, session_id) DO NOTHING`,
    [agentId, generation, sessionId, workingDirectory, provider],
  );
}

/** Mark a session superseded — set ended_at now, only for a still-open row of
 *  this agent+session. Idempotent (a second close leaves ended_at unchanged). */
export function closeAgentSession(agentId: string, sessionId: string): void {
  run(
    `UPDATE agent_sessions SET ended_at = datetime('now')
     WHERE dashboard_agent_id = ? AND session_id = ? AND ended_at IS NULL`,
    [agentId, sessionId],
  );
}

/** The full ordered lineage for an agent. Ordered by started_at then row id —
 *  NEVER by generation (generations repeat across `/clear`). */
export function getAgentSessions(agentId: string): AgentSessionRow[] {
  return queryAll(
    `SELECT * FROM agent_sessions WHERE dashboard_agent_id = ?
     ORDER BY started_at, id`,
    [agentId],
  ).map(rowToAgentSession);
}

/** The session immediately preceding a given lineage row, walking back by row
 *  id / started_at — NEVER by generation. Returns null at the head of the
 *  lineage (gen-0, or the oldest backfilled row). */
export function getPriorSession(
  agentId: string,
  beforeSessionRowId: number,
): AgentSessionRow | null {
  const anchor = queryOne(
    `SELECT started_at, id FROM agent_sessions WHERE id = ? AND dashboard_agent_id = ?`,
    [beforeSessionRowId, agentId],
  );
  if (!anchor) return null;
  // Strictly-earlier by (started_at, id) — the composite ordering key the
  // lineage index is built on, so two same-generation `/clear` siblings still
  // resolve to a deterministic predecessor.
  const row = queryOne(
    `SELECT * FROM agent_sessions
     WHERE dashboard_agent_id = ?
       AND (started_at < ? OR (started_at = ? AND id < ?))
     ORDER BY started_at DESC, id DESC
     LIMIT 1`,
    [agentId, anchor.started_at, anchor.started_at, anchor.id],
  );
  return row ? rowToAgentSession(row) : null;
}

/** Phase 1 one-time backfill — reconstruct lineage from the append-only events
 *  trail (`continuation` records the session switched TO + its generation;
 *  `clear_session_rotated` records a `/clear` successor id at the same
 *  generation). Per-agent guarded and ON CONFLICT-safe so it never duplicates
 *  or fights live inserts.
 *
 *  Rows are stamped with started_at = the SOURCE EVENT's timestamp (not
 *  datetime('now')) because backfilled autoincrement ids are minted after any
 *  live rows, so correct ordering must rely on started_at. jsonl_present is
 *  NULL (unknown — the provider may have pruned old files). gen-0 originals are
 *  unrecoverable (events record the session switched TO, never FROM) — the gap
 *  is accepted. */
export function backfillAgentSessionsFromEvents(): void {
  // Candidate agents: those carrying at least one lineage-bearing event.
  const agents = queryAll(
    `SELECT DISTINCT agent_id FROM events
     WHERE event_type IN ('continuation', 'clear_session_rotated')`,
  ) as { agent_id: string }[];

  const insertBackfill = db.prepare(
    `INSERT INTO agent_sessions
       (dashboard_agent_id, generation, session_id, working_directory, provider, started_at, ended_at, jsonl_present)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(dashboard_agent_id, session_id) DO NOTHING`,
  );

  for (const { agent_id: agentId } of agents) {
    // Per-agent idempotency guard: skip any agent that already has lineage
    // rows (live gen-0/transition inserts, or a prior backfill pass).
    const existing = queryOne(
      `SELECT COUNT(*) AS n FROM agent_sessions WHERE dashboard_agent_id = ?`,
      [agentId],
    );
    if (existing && existing.n > 0) continue;

    // Need cwd/provider to stamp the row; skip if the agent record is gone
    // (best-effort — lineage of a deleted agent isn't reconstructable).
    const agentRow = queryOne(
      `SELECT working_directory, provider FROM agents WHERE id = ?`,
      [agentId],
    );
    if (!agentRow) continue;

    const events = queryAll(
      `SELECT event_type, payload, created_at FROM events
       WHERE agent_id = ? AND event_type IN ('continuation', 'clear_session_rotated')
       ORDER BY created_at, id`,
      [agentId],
    ) as { event_type: string; payload: string | null; created_at: string }[];

    // Build the ordered (sessionId, generation, startedAt) chain.
    const chain: { sessionId: string; generation: number; startedAt: string }[] = [];
    let runningGen = 0; // ordering hint; /clear leaves it unchanged
    for (const ev of events) {
      let sessionId: string | null = null;
      if (ev.event_type === 'continuation') {
        try {
          const parsed = JSON.parse(ev.payload || '{}');
          sessionId = typeof parsed.newSession === 'string' ? parsed.newSession : null;
          if (typeof parsed.generation === 'number') runningGen = parsed.generation;
        } catch { /* malformed payload — skip this event */ }
      } else {
        // clear_session_rotated: payload IS the successor session id string.
        sessionId = ev.payload && ev.payload.length > 0 ? ev.payload : null;
        // /clear does NOT bump the generation — reuse runningGen.
      }
      if (sessionId) chain.push({ sessionId, generation: runningGen, startedAt: ev.created_at });
    }

    // Each session is superseded by the next in the chain; the last stays open.
    const tx = db.transaction(() => {
      for (let i = 0; i < chain.length; i++) {
        const cur = chain[i];
        const endedAt = i + 1 < chain.length ? chain[i + 1].startedAt : null;
        insertBackfill.run(
          agentId,
          cur.generation,
          cur.sessionId,
          agentRow.working_directory,
          agentRow.provider || 'claude',
          cur.startedAt,
          endedAt,
        );
      }
    });
    tx();
  }
}

// ── WP-2B (Priority 0) — workspace-lineage backfill for stream_lane_stats ──────────
//
// skill_analytics_meta keys (co-located with the parse-manager's own markers). The
// completion marker is stamped with the resolver VERSION so bumping
// WORKSPACE_LINEAGE_VERSION re-arms a fresh pass (a corrected fold never keeps a stale
// completion). Resumable: only NULL-workspace rows are touched, so a killed pass simply
// continues on the next boot.
const WS_LINEAGE_DONE_KEY = 'workspace_lineage_backfill_at';
const WS_LINEAGE_VERSION_KEY = 'workspace_lineage_version';

function readSkillMeta(k: string): string | null {
  try {
    const row = queryOne(`SELECT v FROM skill_analytics_meta WHERE k = ?`, [k]);
    return row ? String(row.v) : null;
  } catch { return null; }
}
function writeSkillMeta(k: string, v: string): void {
  run(`INSERT OR REPLACE INTO skill_analytics_meta (k, v) VALUES (?, ?)`, [k, v]);
}

/** Live indexing state for the workspace-lineage backfill, so a surface can report
 *  "indexing" honestly (resumable state, brief item 3). `remaining` counts NULL-
 *  workspace streams that still carry a working_dir (i.e. still resolvable candidates). */
export function workspaceLineageIndexState(): {
  done: boolean; version: number; resolved: number; remaining: number;
} {
  const doneAt = readSkillMeta(WS_LINEAGE_DONE_KEY);
  const ver = Number(readSkillMeta(WS_LINEAGE_VERSION_KEY) ?? 0);
  const done = doneAt != null && ver === WORKSPACE_LINEAGE_VERSION;
  const resolvedRow = queryOne(`SELECT COUNT(*) AS n FROM stream_lane_stats WHERE workspace_id IS NOT NULL`);
  const remainingRow = queryOne(
    `SELECT COUNT(*) AS n FROM stream_lane_stats WHERE workspace_id IS NULL AND working_dir IS NOT NULL`,
  );
  return {
    done,
    version: WORKSPACE_LINEAGE_VERSION,
    resolved: resolvedRow ? Number(resolvedRow.n) : 0,
    remaining: remainingRow ? Number(remainingRow.n) : 0,
  };
}

/** One-time, resumable backfill: fold each stream's launch cwd → workspace root and,
 *  when that root is owned by EXACTLY one workspace, persist workspace_id/root + the
 *  attribution method ('root') + version. Idempotent — only NULL-workspace rows are
 *  updated, on a UNIQUE match (shared-cwd invariant: cwd identifies a WORKSPACE, never
 *  an agent). A no-op once complete at the current resolver version. */
export function backfillStreamWorkspaceLineage(): void {
  // Complete at the current version → strict no-op (avoids re-walking every boot).
  if (readSkillMeta(WS_LINEAGE_DONE_KEY) != null
      && Number(readSkillMeta(WS_LINEAGE_VERSION_KEY) ?? 0) === WORKSPACE_LINEAGE_VERSION) {
    return;
  }

  const workspaces = (queryAll(`SELECT id, path FROM workspaces`) as { id: string; path: string }[])
    .filter((w): w is WorkspaceRecordLite => !!w.path);

  // Candidates: streams with a launch cwd but no resolved workspace yet (resumable).
  const candidates = queryAll(
    `SELECT stream_id, working_dir FROM stream_lane_stats
     WHERE workspace_id IS NULL AND working_dir IS NOT NULL`,
  ) as { stream_id: string; working_dir: string }[];

  const upd = db.prepare(
    `UPDATE stream_lane_stats
       SET workspace_id = ?, workspace_root = ?,
           workspace_attribution_method = ?, workspace_attribution_version = ?
     WHERE stream_id = ? AND workspace_id IS NULL`,
  );

  const tx = db.transaction(() => {
    for (const c of candidates) {
      const lineage = resolveWorkspaceForCwd(c.working_dir, workspaces);
      if (!lineage) continue; // ambiguous / no unique owner → retain NULL (never guess)
      upd.run(lineage.workspaceId, lineage.workspaceRoot, lineage.method, WORKSPACE_LINEAGE_VERSION, c.stream_id);
    }
  });
  tx();

  // Mark complete at the current version only after the pass finishes (kill-resume:
  // a partial/aborted pass leaves the marker unset and simply resumes next boot).
  writeSkillMeta(WS_LINEAGE_DONE_KEY, new Date().toISOString());
  writeSkillMeta(WS_LINEAGE_VERSION_KEY, String(WORKSPACE_LINEAGE_VERSION));
}

export function addEvent(agentId: string, eventType: string, payload?: string): void {
  run('INSERT INTO events (agent_id, event_type, payload) VALUES (?, ?, ?)', [agentId, eventType, payload || null]);
}

// ── Cross-workspace collaboration audit (plans/cross-workspace-collaboration.md WP0.3) ──

/** The operations recorded in `cross_workspace_audit`. */
export type CrossWorkspaceAuditOperation =
  | 'list_agents' | 'list_workspaces' | 'read_agent' | 'send_message' | 'launch' | 'revive';

/** A raw audit entry as supplied by a route. `detail` is SANITIZED here to a
 *  fixed key allowlist before storage — a caller can pass a wider object and only
 *  the allowlisted keys survive. Message contents are NEVER accepted (callers
 *  pass `queuedMessageLen`, a length, instead). */
export interface CrossWorkspaceAuditEntry {
  operation: CrossWorkspaceAuditOperation;
  actorAgentId?: string | null;
  actorWorkspaceId?: string | null;
  /** The actor's privilege lane, or the literal `'global-bearer'` for the trusted path. */
  actorLane?: string | null;
  targetAgentId?: string | null;
  targetWorkspaceId?: string | null;
  force?: boolean;
  /** Length ONLY — never the message text. */
  queuedMessageLen?: number | null;
  /** `'ok' | 'denied:<code>' | 'error:<code>'`. */
  outcome: string;
  /** Sanitized to the fixed allowlist below; anything else is dropped. */
  detail?: Record<string, unknown> | null;
}

export interface CrossWorkspaceAuditRow {
  id: string;
  ts: number;
  operation: string;
  actorAgentId: string | null;
  actorWorkspaceId: string | null;
  actorLane: string | null;
  targetAgentId: string | null;
  targetWorkspaceId: string | null;
  force: boolean;
  queuedMessageLen: number | null;
  outcome: string;
  detail: Record<string, unknown> | null;
}

/** The ONLY keys allowed to survive into a stored `detail` blob. Deliberately
 *  narrow (fixed, non-free-text) so `detail` can never become a path/error/body
 *  disclosure side channel. */
const CROSS_WORKSPACE_AUDIT_DETAIL_KEYS = ['code', 'gate', 'successorId', 'provider'] as const;

/** Reduce an arbitrary detail object to the fixed allowlist, coercing values to
 *  strings so a raw Error/body object can never smuggle nested content through. */
function sanitizeCrossWorkspaceAuditDetail(
  detail: Record<string, unknown> | null | undefined,
): Record<string, string> | null {
  if (!detail || typeof detail !== 'object') return null;
  const out: Record<string, string> = {};
  for (const key of CROSS_WORKSPACE_AUDIT_DETAIL_KEYS) {
    const v = (detail as Record<string, unknown>)[key];
    if (v === undefined || v === null) continue;
    out[key] = String(v);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Insert a cross-workspace audit row. Records successes AND every denied/failed
 *  attempt. `detail` is sanitized to the fixed key allowlist; message contents
 *  are never stored (only `queuedMessageLen`). */
export function recordCrossWorkspaceAudit(entry: CrossWorkspaceAuditEntry): void {
  const id = uuidv4();
  const detail = sanitizeCrossWorkspaceAuditDetail(entry.detail);
  run(
    `INSERT INTO cross_workspace_audit
       (id, ts, operation, actor_agent_id, actor_workspace_id, actor_lane,
        target_agent_id, target_workspace_id, force, queued_message_len, outcome, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, Date.now(), entry.operation,
      entry.actorAgentId ?? null, entry.actorWorkspaceId ?? null, entry.actorLane ?? null,
      entry.targetAgentId ?? null, entry.targetWorkspaceId ?? null,
      entry.force ? 1 : 0, entry.queuedMessageLen ?? null, entry.outcome,
      detail ? JSON.stringify(detail) : null,
    ],
  );
}

function rowToCrossWorkspaceAudit(row: any): CrossWorkspaceAuditRow {
  let detail: Record<string, unknown> | null = null;
  if (row.detail) {
    try { detail = JSON.parse(row.detail); } catch { detail = null; }
  }
  return {
    id: row.id,
    ts: Number(row.ts),
    operation: row.operation,
    actorAgentId: row.actor_agent_id ?? null,
    actorWorkspaceId: row.actor_workspace_id ?? null,
    actorLane: row.actor_lane ?? null,
    targetAgentId: row.target_agent_id ?? null,
    targetWorkspaceId: row.target_workspace_id ?? null,
    force: !!row.force,
    queuedMessageLen: row.queued_message_len === null || row.queued_message_len === undefined
      ? null : Number(row.queued_message_len),
    outcome: row.outcome,
    detail,
  };
}

/** Read cross-workspace audit rows, newest first. Optionally filter by a lower
 *  timestamp bound and/or a target workspace, and cap the count. */
export function getCrossWorkspaceAudit(
  opts: { sinceTs?: number; workspaceId?: string; limit?: number } = {},
): CrossWorkspaceAuditRow[] {
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts.sinceTs !== undefined) { clauses.push('ts >= ?'); params.push(opts.sinceTs); }
  if (opts.workspaceId !== undefined) { clauses.push('target_workspace_id = ?'); params.push(opts.workspaceId); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = opts.limit !== undefined && opts.limit > 0 ? Math.floor(opts.limit) : 200;
  params.push(limit);
  return queryAll(
    `SELECT * FROM cross_workspace_audit ${where} ORDER BY ts DESC, id DESC LIMIT ?`,
    params,
  ).map(rowToCrossWorkspaceAudit);
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
    generation: row.generation ?? 0,
    sessionId: row.session_id ?? null,
  };
}

// ── Git-Native WP-G1.7: witness-join observer seam ───────────────────────────
//
// Both witness sources — the Claude PTY scraper (`file-activity-tracker.ts`) and
// the multi-provider structured monitor (`context-stats-monitor.ts` → supervisor)
// — converge on `addFileActivity`. To feed a turn's `touched[]` we need a choke
// point ABOVE the 5-second live-cache dedupe below (which would otherwise drop a
// repeat touch that the turn spine must still witness). The observer is invoked
// AFTER the WP1 ingress normalization (unwrap + canonicalize) but BEFORE that
// dedupe early-return, so it always sees the canonical absolute path and a
// dropped-as-ambiguous value never reaches it. It owns its OWN independent
// transactional `(turnId,path,op)` dedupe (see `recordWitnessedActivity`).
// Injected via a setter (there is no class here to take constructor injection);
// `clearWitnessObserver()` restores the null default for test isolation and
// supervisor teardown. Failures are swallowed so the witness join can NEVER break
// the `file_activities` insert path.
export type WitnessObserver = (agentId: string, filePath: string, operation: FileOperation) => void;
let witnessObserver: WitnessObserver | null = null;
export function setWitnessObserver(fn: WitnessObserver | null): void {
  witnessObserver = fn;
}
export function clearWitnessObserver(): void {
  witnessObserver = null;
}

export function addFileActivity(agentId: string, rawFilePath: string, operation: FileOperation): FileActivity | null {
  // WP1 (checkpoint-surface-hardening): `addFileActivity` is the authoritative
  // ingress chokepoint for witnessed paths (defects 1 + 4). Order matters —
  //   1. agents-row lookup FIRST (session + generation for dedupe/insert, AND the
  //      working directory used as the cwd for canonicalization),
  //   2. unwrap the OSC-8 terminal-hyperlink pollution (drop if ambiguous),
  //   3. canonicalize to an absolute native path (drop if empty),
  //   4. THEN fire the witness observer with the canonical path,
  //   5. THEN the live-cache dedupe + INSERT.
  //
  // Stamp with the agent's CURRENT session + generation so a continuation's new
  // session inserts distinct rows instead of colliding with the prior session's.
  // resume_session_id is the live session id; continuation_generation is the
  // display label. `working_directory` is stored purely to recompute slugs, but
  // here it doubles as the cwd for resolving a relative/`~` witnessed path.
  const stamp = queryOne(
    'SELECT continuation_generation, resume_session_id, working_directory FROM agents WHERE id = ?',
    [agentId]
  );
  const generation: number = stamp?.continuation_generation ?? 0;
  const sessionId: string | null = stamp?.resume_session_id ?? null;
  const cwd: string | undefined = stamp?.working_directory ?? undefined;
  const home: string | undefined = os.homedir() || undefined;

  // Unwrap OSC-8 hyperlink residue. An ambiguous recovery is authorization-
  // adjacent evidence, so it is DROPPED (no insert, no witness) — never guessed.
  const clean = unwrapOsc8(rawFilePath);
  if ('ambiguous' in clean) return null;

  // Canonicalize to an absolute native path. Empty (control-only / undecodable)
  // → drop. A relative path with no known cwd stays as its normalized value
  // rather than being dropped — file_activities is display-only; the witness
  // join independently scope-rejects via `normalizeWitnessPath`.
  const filePath = canonicalizeToAbsolute(stripTerminalEscapes(clean.text), { cwd, home });
  if (filePath === '') return null;

  // Git-Native WP-G1.7 witness join — fire the choke point AFTER normalize but
  // BEFORE the live-cache dedupe early-return, so two same-path writes 1s apart
  // both reach the turn spine even though only the first inserts a
  // `file_activities` row. Never lets a witness failure disturb the (unchanged)
  // file_activities role below.
  if (witnessObserver) {
    try {
      witnessObserver(agentId, filePath, operation);
    } catch {
      /* witness join is best-effort — never break file_activities */
    }
  }

  // Dedup: skip if the same (agent, file, operation) landed within the last 5
  // seconds UNDER THE SAME session + generation. Matching the session too means
  // a rebind mid-window doesn't dedup the new session's activity against the old
  // one. `session_id IS ?` is NULL-aware equality (legacy NULL rows dedup too).
  const recent = queryOne(
    `SELECT id FROM file_activities
     WHERE agent_id = ? AND file_path = ? AND operation = ?
     AND generation = ? AND session_id IS ?
     AND timestamp > datetime('now', '-5 seconds')`,
    [agentId, filePath, operation, generation, sessionId]
  );
  if (recent) return null;

  run(
    'INSERT INTO file_activities (agent_id, file_path, operation, generation, session_id) VALUES (?, ?, ?, ?, ?)',
    [agentId, filePath, operation, generation, sessionId]
  );

  const row = queryOne(
    'SELECT * FROM file_activities WHERE agent_id = ? AND file_path = ? ORDER BY id DESC LIMIT 1',
    [agentId, filePath]
  );
  return row ? rowToFileActivity(row) : null;
}

// `currentOnly` filters to the agent's live session (`resume_session_id`) — the
// dashboard tabs pass it via `current_only`; the default returns ALL retained
// sessions so "has any prior session touched X?" callers (MCP/HTTP) still work.
export function getFileActivities(agentId: string, operation?: FileOperation, currentOnly?: boolean): FileActivity[] {
  const clauses = ['agent_id = ?'];
  const params: unknown[] = [agentId];
  if (operation) {
    clauses.push('operation = ?');
    params.push(operation);
  }
  if (currentOnly) {
    // Live session = the agent's current resume_session_id. A subquery keeps it
    // atomic; NULL-safe `IS` so a null live session matches only null rows.
    clauses.push('session_id IS (SELECT resume_session_id FROM agents WHERE id = ?)');
    params.push(agentId);
  }
  return queryAll(
    `SELECT * FROM file_activities WHERE ${clauses.join(' AND ')} ORDER BY timestamp DESC`,
    params
  ).map(rowToFileActivity);
}

/**
 * Context-brick Phase 4 retention cap. Instead of the old universal purge on
 * rebind, keep only the `keepSessions` most-recently-active sessions' activity
 * for an agent and delete the rest, so `file_activities` stays bounded across
 * many rotations. Sessions are ranked by their most recent activity timestamp;
 * a NULL session_id (legacy rows) counts as its own bucket. Returns what was
 * pruned so the caller can log it (no silent truncation).
 */
export function pruneFileActivitiesToRecentSessions(
  agentId: string,
  keepSessions: number
): { prunedRows: number; prunedSessions: number } {
  // Rank sessions by recency (NULL bucketed via a sentinel key). COALESCE the
  // key so the NULL session collapses to one group rather than per-row.
  const sessions = queryAll(
    `SELECT COALESCE(session_id, ' null') AS skey, MAX(timestamp) AS last_ts
       FROM file_activities WHERE agent_id = ?
       GROUP BY skey ORDER BY last_ts DESC`,
    [agentId]
  ) as { skey: string; last_ts: string }[];

  if (sessions.length <= keepSessions) return { prunedRows: 0, prunedSessions: 0 };

  const drop = sessions.slice(keepSessions); // oldest beyond the cap
  let prunedRows = 0;
  for (const s of drop) {
    if (s.skey === ' null') {
      const before = queryOne(
        `SELECT COUNT(*) AS n FROM file_activities WHERE agent_id = ? AND session_id IS NULL`,
        [agentId]
      );
      run(`DELETE FROM file_activities WHERE agent_id = ? AND session_id IS NULL`, [agentId]);
      prunedRows += (before?.n as number) ?? 0;
    } else {
      const before = queryOne(
        `SELECT COUNT(*) AS n FROM file_activities WHERE agent_id = ? AND session_id = ?`,
        [agentId, s.skey]
      );
      run(`DELETE FROM file_activities WHERE agent_id = ? AND session_id = ?`, [agentId, s.skey]);
      prunedRows += (before?.n as number) ?? 0;
    }
  }
  return { prunedRows, prunedSessions: drop.length };
}

export function deleteAgent(id: string): void {
  run('DELETE FROM file_activities WHERE agent_id = ?', [id]);
  run('DELETE FROM events WHERE agent_id = ?', [id]);
  // Git-Native WP-A0 (memory §4.2): deliberately DO NOT touch `turn_records` or
  // `recovery_operations`. Their `agent_id`/`agent_title` are PLAIN attributes
  // (no FK cascade) so the durable turn spine + recovery ledger survive agent
  // deletion — a restore/revert must remain possible after the agent is gone.
  // Regression-guarded in turn-records.test.ts.
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

// ── Git-Native WP-A0: turn_records + recovery_operations accessors ───────────
//
// The durable turn spine. Accessors are exported functions here (the raw
// singleton is never re-exposed for these tables). Status transitions and the
// atomic sequence allocation are enforced in code, not left to callers.

/** Turn lifecycle statuses. `open` is the only non-terminal state; every other
 *  value is terminal and immutable once written (see updateTurnRecord). */
export type TurnStatus =
  | 'open'
  | 'accepted'
  | 'interrupted'
  | 'crashed'
  | 'stopped'
  | 'delivery_failed'
  | 'skipped'
  | 'reverted';

/** Valid transition targets out of `open`. Mirrors the plan's transition table:
 *  `open → { accepted, interrupted, crashed, stopped, delivery_failed, skipped,
 *  reverted }`. Everything in this set is terminal. */
const TURN_TERMINAL_STATUSES: ReadonlySet<TurnStatus> = new Set<TurnStatus>([
  'accepted',
  'interrupted',
  'crashed',
  'stopped',
  'delivery_failed',
  'skipped',
  'reverted',
]);

export type TurnWitnessOp = 'write' | 'create' | string;

/** Runtime plan-stamp sources. `legacy-unstamped` is migration-only and is
 * deliberately excluded from allocation input. */
export type TurnPlanStampSource = ResolvedPlanStamp['source'];
export type PersistedTurnPlanStampSource = TurnPlanStampSource | 'legacy-unstamped';

const TURN_PLAN_STAMP_SOURCES: ReadonlySet<string> = new Set<TurnPlanStampSource>([
  'explicit',
  'agent-default',
  'fork-carry',
  'revive-carry',
  'continuation-carry',
  'explicit-none',
  'unbound-manual',
]);

// ── Save-card commit-protection ledger (SC-WP-2G) ───────────────────────────

export type CommitRecordSource = 'lares' | 'external';
export type CommitTurnRelation = 'candidate_member' | 'exact_path_match' | 'metadata_only';
export type CommitExpectedState = 'present' | 'absent';

export interface CommitRecord {
  repositoryKey: string;
  commitOid: string;
  parentOid: string | null;
  observedAt: number;
  source: CommitRecordSource;
  pushedRemoteCount: number;
  lastReconciledAt: number | null;
}

export interface CommitTurnLink {
  repositoryKey: string;
  commitOid: string;
  turnId: string;
  planId: string | null;
  planItemId: string | null;
  relation: CommitTurnRelation;
  captureQuality: string | null;
}

export interface CommitPathLink {
  repositoryKey: string;
  commitOid: string;
  pathBytesBase64: string;
  expectedState: CommitExpectedState;
  rawBlobOidAtCommit: string | null;
  commitBlobOid: string | null;
  commitMode: string | null;
  contributingTurnIds: string[];
  overlapCount: number;
}

export interface CommitLedgerWrite {
  record: CommitRecord;
  turnLinks?: readonly CommitTurnLink[];
  pathLinks?: readonly CommitPathLink[];
}

function rowToCommitRecord(row: any): CommitRecord {
  return {
    repositoryKey: row.repository_key,
    commitOid: row.commit_oid,
    parentOid: row.parent_oid ?? null,
    observedAt: row.observed_at,
    source: row.source,
    pushedRemoteCount: row.pushed_remote_count,
    lastReconciledAt: row.last_reconciled_at ?? null,
  };
}

function rowToCommitTurnLink(row: any): CommitTurnLink {
  return {
    repositoryKey: row.repository_key,
    commitOid: row.commit_oid,
    turnId: row.turn_id,
    planId: row.plan_id ?? null,
    planItemId: row.plan_item_id ?? null,
    relation: row.relation,
    captureQuality: row.capture_quality ?? null,
  };
}

function rowToCommitPathLink(row: any): CommitPathLink {
  let contributingTurnIds: string[] = [];
  try {
    const parsed = JSON.parse(row.contributing_turn_ids ?? '[]');
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) {
      contributingTurnIds = parsed;
    }
  } catch { /* corrupt optional provenance degrades to no contributing turns */ }
  return {
    repositoryKey: row.repository_key,
    commitOid: row.commit_oid,
    pathBytesBase64: row.path_bytes_base64,
    expectedState: row.expected_state,
    rawBlobOidAtCommit: row.raw_blob_oid_at_commit ?? null,
    commitBlobOid: row.commit_blob_oid ?? null,
    commitMode: row.commit_mode ?? null,
    contributingTurnIds,
    overlapCount: row.overlap_count,
  };
}

export function upsertCommitRecord(record: CommitRecord): void {
  run(
    `INSERT INTO commit_records (
       repository_key, commit_oid, parent_oid, observed_at, source,
       pushed_remote_count, last_reconciled_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repository_key, commit_oid) DO UPDATE SET
       parent_oid = excluded.parent_oid,
       observed_at = MIN(commit_records.observed_at, excluded.observed_at),
       source = CASE WHEN excluded.source = 'lares' THEN 'lares' ELSE commit_records.source END,
       pushed_remote_count = excluded.pushed_remote_count,
       last_reconciled_at = excluded.last_reconciled_at`,
    [record.repositoryKey, record.commitOid, record.parentOid, record.observedAt,
      record.source, record.pushedRemoteCount, record.lastReconciledAt],
  );
}

export function getCommitRecord(repositoryKey: string, commitOid: string): CommitRecord | null {
  const row = queryOne(
    `SELECT * FROM commit_records WHERE repository_key = ? AND commit_oid = ?`,
    [repositoryKey, commitOid],
  );
  return row ? rowToCommitRecord(row) : null;
}

export function listCommitRecords(repositoryKey: string): CommitRecord[] {
  return queryAll(
    `SELECT * FROM commit_records WHERE repository_key = ? ORDER BY observed_at, commit_oid`,
    [repositoryKey],
  ).map(rowToCommitRecord);
}

export function upsertCommitTurnLink(link: CommitTurnLink): void {
  run(
    `INSERT INTO commit_turn_links (
       repository_key, commit_oid, turn_id, plan_id, plan_item_id, relation, capture_quality
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repository_key, commit_oid, turn_id) DO UPDATE SET
       plan_id = excluded.plan_id, plan_item_id = excluded.plan_item_id,
       relation = excluded.relation, capture_quality = excluded.capture_quality`,
    [link.repositoryKey, link.commitOid, link.turnId, link.planId, link.planItemId,
      link.relation, link.captureQuality],
  );
}

export function listCommitTurnLinks(repositoryKey: string, commitOid: string): CommitTurnLink[] {
  return queryAll(
    `SELECT * FROM commit_turn_links
     WHERE repository_key = ? AND commit_oid = ? ORDER BY turn_id`,
    [repositoryKey, commitOid],
  ).map(rowToCommitTurnLink);
}

export function upsertCommitPathLink(link: CommitPathLink): void {
  run(
    `INSERT INTO commit_path_links (
       repository_key, commit_oid, path_bytes_base64, expected_state,
       raw_blob_oid_at_commit, commit_blob_oid, commit_mode,
       contributing_turn_ids, overlap_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repository_key, commit_oid, path_bytes_base64) DO UPDATE SET
       expected_state = excluded.expected_state,
       raw_blob_oid_at_commit = excluded.raw_blob_oid_at_commit,
       commit_blob_oid = excluded.commit_blob_oid,
       commit_mode = excluded.commit_mode,
       contributing_turn_ids = excluded.contributing_turn_ids,
       overlap_count = excluded.overlap_count`,
    [link.repositoryKey, link.commitOid, link.pathBytesBase64, link.expectedState,
      link.rawBlobOidAtCommit, link.commitBlobOid, link.commitMode,
      JSON.stringify(link.contributingTurnIds), link.overlapCount],
  );
}

/** One batched lookup for protection reads; an empty path set never emits SQL. */
export function listCommitPathLinks(
  repositoryKey: string,
  pathBytesBase64?: readonly string[],
): CommitPathLink[] {
  if (pathBytesBase64 && pathBytesBase64.length === 0) return [];
  const uniquePaths = pathBytesBase64 ? [...new Set(pathBytesBase64)] : null;
  const pathClause = uniquePaths
    ? ` AND path_bytes_base64 IN (${uniquePaths.map(() => '?').join(',')})`
    : '';
  return queryAll(
    `SELECT * FROM commit_path_links WHERE repository_key = ?${pathClause}
     ORDER BY commit_oid, path_bytes_base64`,
    [repositoryKey, ...(uniquePaths ?? [])],
  ).map(rowToCommitPathLink);
}

// ── Save-card SC-WP-3A — plan_work_packages CRUD + item-validity accessor ──────

export type PlanWorkPackageState =
  | 'ready' | 'executing' | 'blocked' | 'done' | 'archived';

export interface PlanWorkPackage {
  id: string;
  workspaceId: string;
  planId: string;
  title: string;
  acceptanceCondition: string | null;
  state: PlanWorkPackageState;
  assigneeAgentId: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

function rowToPlanWorkPackage(row: any): PlanWorkPackage {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    planId: row.plan_id,
    title: row.title,
    acceptanceCondition: row.acceptance_condition ?? null,
    state: row.state,
    assigneeAgentId: row.assignee_agent_id ?? null,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertPlanWorkPackage(pkg: PlanWorkPackage): void {
  run(
    `INSERT INTO plan_work_packages (
       id, workspace_id, plan_id, title, acceptance_condition, state,
       assignee_agent_id, revision, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       workspace_id = excluded.workspace_id, plan_id = excluded.plan_id,
       title = excluded.title, acceptance_condition = excluded.acceptance_condition,
       state = excluded.state, assignee_agent_id = excluded.assignee_agent_id,
       revision = excluded.revision, updated_at = excluded.updated_at`,
    [pkg.id, pkg.workspaceId, pkg.planId, pkg.title, pkg.acceptanceCondition,
      pkg.state, pkg.assigneeAgentId, pkg.revision, pkg.createdAt, pkg.updatedAt],
  );
}

export function getPlanWorkPackage(id: string): PlanWorkPackage | null {
  const row = queryOne(`SELECT * FROM plan_work_packages WHERE id = ?`, [id]);
  return row ? rowToPlanWorkPackage(row) : null;
}

export function listPlanWorkPackages(planId: string): PlanWorkPackage[] {
  return queryAll(
    `SELECT * FROM plan_work_packages WHERE plan_id = ? ORDER BY created_at, id`,
    [planId],
  ).map(rowToPlanWorkPackage);
}

/**
 * Authoritative item-validity check for plan-stamp resolution (SC-WP-3A). A work
 * package is valid for a binding only when its own row matches the full
 * (workspace_id, plan_id, id) tuple — never a plan_sections.anchor, never an
 * always-true seam. Archived packages are still valid stamp targets (a completed
 * item may still receive attribution); only a missing/mismatched row is rejected.
 */
export function planItemInPlan(workspaceId: string, planId: string, planItemId: string): boolean {
  const row = queryOne(
    `SELECT 1 AS ok FROM plan_work_packages
      WHERE id = ? AND workspace_id = ? AND plan_id = ?`,
    [planItemId, workspaceId, planId],
  );
  return row !== null;
}

// ── Planning-surface WP-P5A — work-package layout + planned-path companions ─────
//
// DB-layer primitives over the two P5A companion tables. WP-P5A-schema owns the
// ordering companion + the same-workspace assignee validation; WP-P5A-paths owns
// the planned-path populate/read seam. NO lifecycle-state transition lives here —
// `state` mutations (`ready`/`executing`/`blocked`/`archived`) are WP-P5B's sole
// domain, and `done` is SC-WP-3C's. `assignPlanWorkPackage` reuses SC-WP-3A CRUD
// (get + upsert) rather than adding a column, so the frozen 11-column shape is
// untouched.

/** Set the explicit ordering slot for one package. Idempotent (PK upsert). */
export function setPlanWorkPackageLayout(packageId: string, sortOrder: number): void {
  run(
    `INSERT INTO plan_work_package_layout (package_id, sort_order)
     VALUES (?, ?)
     ON CONFLICT(package_id) DO UPDATE SET sort_order = excluded.sort_order`,
    [packageId, sortOrder],
  );
}

/** The stored sort_order for a package, or null when it has no layout row. */
export function getPlanWorkPackageLayoutOrder(packageId: string): number | null {
  const row = queryOne(
    `SELECT sort_order FROM plan_work_package_layout WHERE package_id = ?`,
    [packageId],
  );
  return row ? (row.sort_order as number) : null;
}

/**
 * Reorder a plan's packages by writing a dense 0..n-1 sort_order to the layout
 * companion, in the given id order, inside one transaction. Only ids that belong
 * to `planId` are written — a stray id is ignored, never silently reparented.
 */
export function reorderPlanWorkPackages(planId: string, orderedPackageIds: string[]): void {
  const database = getDb();
  const tx = database.transaction((ids: string[]) => {
    let slot = 0;
    for (const id of ids) {
      const owns = queryOne(
        `SELECT 1 AS ok FROM plan_work_packages WHERE id = ? AND plan_id = ?`,
        [id, planId],
      );
      if (!owns) continue;
      setPlanWorkPackageLayout(id, slot);
      slot += 1;
    }
  });
  tx(orderedPackageIds);
}

/**
 * List a plan's packages in display order: explicit layout sort_order first (rows
 * without a layout entry sort after, by created_at), then created_at, then id for
 * a stable total order. Projection over SC-WP-3A + the layout companion.
 */
export function listPlanWorkPackagesOrdered(planId: string): PlanWorkPackage[] {
  return queryAll(
    `SELECT wp.* FROM plan_work_packages wp
       LEFT JOIN plan_work_package_layout l ON l.package_id = wp.id
      WHERE wp.plan_id = ?
      ORDER BY (l.sort_order IS NULL), l.sort_order, wp.created_at, wp.id`,
    [planId],
  ).map(rowToPlanWorkPackage);
}

/**
 * Assign (or clear, with `agentId=null`) a package's responsible agent. The
 * assignee MUST be an agent in the package's OWN workspace — a cross-workspace or
 * missing agent is rejected, never silently accepted. Reuses SC-WP-3A CRUD; no
 * lifecycle state is touched.
 */
export function assignPlanWorkPackage(
  packageId: string,
  agentId: string | null,
  updatedAt: number,
): void {
  const pkg = getPlanWorkPackage(packageId);
  if (!pkg) throw new Error(`assignPlanWorkPackage: no package ${packageId}`);
  if (agentId !== null) {
    const ok = queryOne(
      `SELECT 1 AS ok FROM agents WHERE id = ? AND workspace_id = ?`,
      [agentId, pkg.workspaceId],
    );
    if (!ok) {
      throw new Error(
        `assignPlanWorkPackage: agent ${agentId} is not in workspace ${pkg.workspaceId}`,
      );
    }
  }
  upsertPlanWorkPackage({ ...pkg, assigneeAgentId: agentId, updatedAt });
}

export interface PlanWorkPackagePath {
  packageId: string;
  workspaceId: string;
  path: string;
  intentKind: string | null;
  createdAt: number;
}

export interface PlanWorkPackagePathInput {
  path: string;
  intentKind?: string | null;
}

function rowToPlanWorkPackagePath(row: any): PlanWorkPackagePath {
  return {
    packageId: row.package_id,
    workspaceId: row.workspace_id,
    path: row.path,
    intentKind: row.intent_kind ?? null,
    createdAt: row.created_at,
  };
}

/**
 * Reject anything that is not a clean workspace-relative path: absolute (POSIX,
 * UNC, or drive-rooted), empty, or outward-traversing. Returns the normalized
 * POSIX path to store, or null to reject. Never coerces a failing shape into a
 * passing one — a rejected entry is the caller's error, not a silent drop.
 */
function normalizePlannedPath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t === '') return null;
  if (t.includes('\\')) return null;              // not POSIX-separated / UNC
  if (isVerifiedAbsolutePath(t)) return null;     // absolute / drive-rooted
  const norm = path.posix.normalize(t);
  if (norm === '' || norm === '.') return null;
  if (norm === '..' || norm.startsWith('../')) return null; // outward traversal
  return norm;
}

/**
 * Populate the planned paths for a package (WP-P5A-paths). Replace semantics: the
 * package's existing path rows are cleared and the given entries written, inside
 * one transaction, so a re-save from the editor is idempotent. Every path must be
 * workspace-relative — an absolute/traversing/empty path throws and rolls the
 * whole populate back (no partial write). Duplicate paths in one call collapse to
 * the last entry (PK = package_id, path).
 */
export function setPlanWorkPackagePaths(
  packageId: string,
  workspaceId: string,
  entries: PlanWorkPackagePathInput[],
  createdAt: number,
): void {
  const normalized = entries.map((e) => {
    const p = normalizePlannedPath(e.path);
    if (p === null) {
      throw new Error(`setPlanWorkPackagePaths: not a workspace-relative path: ${JSON.stringify(e.path)}`);
    }
    return { path: p, intentKind: e.intentKind ?? null };
  });
  const database = getDb();
  const tx = database.transaction(() => {
    run(`DELETE FROM plan_work_package_paths WHERE package_id = ?`, [packageId]);
    for (const e of normalized) {
      run(
        `INSERT INTO plan_work_package_paths (package_id, workspace_id, path, intent_kind, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(package_id, path) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           intent_kind = excluded.intent_kind,
           created_at = excluded.created_at`,
        [packageId, workspaceId, e.path, e.intentKind, createdAt],
      );
    }
  });
  tx();
}

/** The planned paths for a package, in stable (created_at, path) order. */
export function listPlanWorkPackagePaths(packageId: string): PlanWorkPackagePath[] {
  return queryAll(
    `SELECT * FROM plan_work_package_paths WHERE package_id = ? ORDER BY created_at, path`,
    [packageId],
  ).map(rowToPlanWorkPackagePath);
}

// ── Planning-surface WP-P5B — package lifecycle-event ledger primitives ─────────
//
// DB-layer primitives for the WP-P5B plan-lifecycle service: the atomic
// state-transition + ledger write, the ledger read, and the responsible-supervisor
// validity check Mark-Ready consumes. The SERVICE that composes these (Mark-Ready's
// three-condition gate, archive delegation) is src/main/plans/plan-lifecycle.ts.
// `done` is NEVER written here — the `to_state` type excludes it, the DDL CHECK
// rejects it, and a `done` package is terminal (its state is SC-WP-3C's).

/** The non-terminal transition targets this ledger owns. `done` is excluded by
 *  design — SC-WP-3C is the authoritative `done` channel. */
export type PlanWpTransitionState = 'ready' | 'executing' | 'blocked' | 'archived';

export interface PlanWpLifecycleEvent {
  id: string;
  packageId: string;
  planId: string;
  fromState: string;
  toState: PlanWpTransitionState;
  actor: string;
  reason: string | null;
  ts: number;
}

function rowToPlanWpLifecycleEvent(row: any): PlanWpLifecycleEvent {
  return {
    id: row.id,
    packageId: row.package_id,
    planId: row.plan_id,
    fromState: row.from_state,
    toState: row.to_state,
    actor: row.actor,
    reason: row.reason ?? null,
    ts: row.ts,
  };
}

/**
 * Atomically transition a package's `state` to a non-terminal target AND ledger the
 * transition, in ONE transaction — the sole writer of `plan_work_packages.state`
 * lifecycle moves. Rejects a `done` target (guard + DDL CHECK) and refuses to move a
 * package that is already `done` (terminal, SC-WP-3C-owned). from_state is captured
 * from the live row so the ledger is self-consistent. Returns the recorded event.
 */
export function transitionPlanWorkPackageState(input: {
  eventId: string;
  packageId: string;
  toState: PlanWpTransitionState;
  actor: string;
  reason?: string | null;
  ts: number;
}): PlanWpLifecycleEvent {
  if ((input.toState as string) === 'done') {
    throw new Error('transitionPlanWorkPackageState: `done` is SC-WP-3C-owned, never ledgered here');
  }
  const database = getDb();
  const tx = database.transaction((): PlanWpLifecycleEvent => {
    const pkg = getPlanWorkPackage(input.packageId);
    if (!pkg) throw new Error(`transitionPlanWorkPackageState: no package ${input.packageId}`);
    if (pkg.state === 'done') {
      throw new Error(`transitionPlanWorkPackageState: package ${input.packageId} is done (terminal)`);
    }
    const fromState = pkg.state;
    run(
      `UPDATE plan_work_packages SET state = ?, updated_at = ? WHERE id = ?`,
      [input.toState, input.ts, input.packageId],
    );
    run(
      `INSERT INTO plan_wp_lifecycle_events
         (id, package_id, plan_id, from_state, to_state, actor, reason, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.eventId, input.packageId, pkg.planId, fromState, input.toState,
        input.actor, input.reason ?? null, input.ts],
    );
    return {
      id: input.eventId, packageId: input.packageId, planId: pkg.planId,
      fromState, toState: input.toState, actor: input.actor,
      reason: input.reason ?? null, ts: input.ts,
    };
  });
  return tx();
}

/** A package's lifecycle history, oldest first (ts, then id for a stable order). */
export function listPlanWpLifecycleEvents(packageId: string): PlanWpLifecycleEvent[] {
  return queryAll(
    `SELECT * FROM plan_wp_lifecycle_events WHERE package_id = ? ORDER BY ts, id`,
    [packageId],
  ).map(rowToPlanWpLifecycleEvent);
}

/**
 * True only when the plan has a responsible supervisor that is a REAL, valid
 * supervisor: a non-null `responsible_supervisor_id` pointing at an agent that
 * exists IN THE PLAN'S OWN WORKSPACE and is structurally a supervisor (or holds the
 * supervisor privilege lane). A null pointer, a missing agent, a cross-workspace
 * agent, or a non-supervisor agent all fail. One of Mark-Ready's three conditions.
 */
export function planHasValidResponsibleSupervisor(planId: string): boolean {
  const row = queryOne(
    `SELECT 1 AS ok
       FROM plans p
       JOIN agents a ON a.id = p.responsible_supervisor_id
      WHERE p.id = ?
        AND a.workspace_id = p.workspace_id
        AND (a.is_supervisor = 1 OR a.privilege_lane = 'supervisor')`,
    [planId],
  );
  return row !== null;
}

// ── Planning-surface WP-P5C — plan_execution_runs primitives ───────────────────
//
// DB-layer primitives for the WP-P5C Implement service (src/main/plans/
// plan-implement.ts): the run-row read paths and the ATOMIC "activate" write — the
// single txn that inserts the run row AND flips `plans.run_state ready→executing`.
// The service creates the durable baseline ref BEFORE calling the activating insert,
// so a txn failure here leaves only an orphan ref (reconciled at startup by
// plan-baseline-refs.ts), never an executing run without a baseline. `done`/finish
// is nowhere near this surface. Run CLOSURE (lifecycle_state → 'archived') is
// WP-P5-archive's job, not here.

export type PlanBaselineKind = 'head' | 'unborn';
export type PlanRunLifecycleState = 'active' | 'archived';

export interface PlanExecutionRun {
  id: string;
  planId: string;
  repositoryKey: string | null;
  baselineKind: PlanBaselineKind;
  baselineHeadOid: string | null;
  baselineRef: string | null;
  triggerSource: string;
  appUserId: string | null;
  triggeredAt: number;
  lifecycleState: PlanRunLifecycleState;
}

function rowToPlanExecutionRun(row: any): PlanExecutionRun {
  return {
    id: row.id,
    planId: row.plan_id,
    repositoryKey: row.repository_key ?? null,
    baselineKind: row.baseline_kind,
    baselineHeadOid: row.baseline_head_oid ?? null,
    baselineRef: row.baseline_ref ?? null,
    triggerSource: row.trigger_source,
    appUserId: row.app_user_id ?? null,
    triggeredAt: row.triggered_at,
    lifecycleState: row.lifecycle_state,
  };
}

export interface InsertPlanExecutionRunInput {
  id: string;
  planId: string;
  repositoryKey?: string | null;
  baselineKind: PlanBaselineKind;
  baselineHeadOid?: string | null;
  baselineRef?: string | null;
  triggerSource: string;
  appUserId?: string | null;
  triggeredAt: number;
}

/**
 * Insert a `plan_execution_runs` row AND flip the plan `run_state ready→executing`,
 * atomically in ONE transaction. Guards that the plan is currently `ready` (re-read
 * inside the txn so a raced state change aborts cleanly) — a plan that is not `ready`
 * throws, and because the caller has already created the baseline ref, that failure
 * leaves an orphan ref for startup reconciliation, never a half-activated plan. The
 * new run is always `lifecycle_state='active'`. Returns the persisted row.
 */
export function insertPlanExecutionRunActivating(
  input: InsertPlanExecutionRunInput,
): PlanExecutionRun {
  const database = getDb();
  const tx = database.transaction((): PlanExecutionRun => {
    const plan = getPlan(input.planId);
    if (!plan) throw new Error(`insertPlanExecutionRunActivating: no plan ${input.planId}`);
    if (plan.runState !== 'ready') {
      throw new Error(
        `insertPlanExecutionRunActivating: plan ${input.planId} is '${plan.runState}', not 'ready'`,
      );
    }
    run(
      `INSERT INTO plan_execution_runs
         (id, plan_id, repository_key, baseline_kind, baseline_head_oid, baseline_ref,
          trigger_source, app_user_id, triggered_at, lifecycle_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [input.id, input.planId, input.repositoryKey ?? null, input.baselineKind,
        input.baselineHeadOid ?? null, input.baselineRef ?? null,
        input.triggerSource, input.appUserId ?? null, input.triggeredAt],
    );
    run(
      `UPDATE plans SET run_state = 'executing', updated_at = datetime('now')
         WHERE id = ? AND run_state = 'ready'`,
      [input.planId],
    );
    return getPlanExecutionRun(input.id)!;
  });
  return tx();
}

/** A single execution run by id, or null. */
export function getPlanExecutionRun(id: string): PlanExecutionRun | null {
  const row = queryOne('SELECT * FROM plan_execution_runs WHERE id = ?', [id]);
  return row ? rowToPlanExecutionRun(row) : null;
}

/** The current ACTIVE execution run for a plan (latest by triggered_at), or null.
 *  This is the "is there an active run?" gate the pre-Implement seam / dispatch
 *  default (P5C-gate / P5D) read. */
export function getActivePlanExecutionRun(planId: string): PlanExecutionRun | null {
  const row = queryOne(
    `SELECT * FROM plan_execution_runs
       WHERE plan_id = ? AND lifecycle_state = 'active'
       ORDER BY triggered_at DESC, id DESC LIMIT 1`,
    [planId],
  );
  return row ? rowToPlanExecutionRun(row) : null;
}

/** Every execution-run id in the DB, REGARDLESS of lifecycle_state — the truth set
 *  the baseline-ref orphan reconciler diffs `refs/lares/plans/*` against. An archived
 *  run still has a row (and keeps its ref); only a ref with NO row at all is an
 *  orphan. */
export function listAllPlanExecutionRunIds(): Set<string> {
  const rows = queryAll('SELECT id FROM plan_execution_runs', []);
  return new Set(rows.map((r: any) => String(r.id)));
}

// ── Planning-surface WP-P5-archive — plan archive (run closure) primitive ──────
//
// The atomic "archive" write that pairs the run-lifecycle closure with the plan-level
// state flip — the mirror of insertPlanExecutionRunActivating. Run CLOSURE
// (lifecycle_state active→archived) lives here, NOT in the P5C activate block. The
// closed run row and its baseline ref are RETAINED for audit (release is only via plan
// deletion / orphan reconciliation, per WP-P5C); package states are NOT touched (no
// package-content rollback — WP-P5-archive non-goal). Re-Implement mints a FRESH run
// via insertPlanExecutionRunActivating and never resurrects the closed row.

export interface ArchivePlanClosingRunResult {
  plan: Plan;
  /** The execution run this archive closed (lifecycle_state active→archived), or null
   *  when the plan had no active run (e.g. a `ready` plan never Implemented). */
  closedRun: PlanExecutionRun | null;
}

/**
 * Atomically archive a plan in ONE transaction: close its ACTIVE execution run
 * (lifecycle_state active→archived, when one exists) AND flip `plans.run_state`
 * executing/ready→archived. Guards that the plan is currently `executing` or `ready`
 * (re-read inside the txn so a raced flip aborts cleanly). The archived run KEEPS its
 * baseline ref for audit; package states are left untouched. Returns the archived plan
 * and the run it closed (null if none).
 */
export function archivePlanClosingRun(planId: string): ArchivePlanClosingRunResult {
  const database = getDb();
  const tx = database.transaction((): ArchivePlanClosingRunResult => {
    const plan = getPlan(planId);
    if (!plan) throw new Error(`archivePlanClosingRun: no plan ${planId}`);
    if (plan.runState !== 'executing' && plan.runState !== 'ready') {
      throw new Error(
        `archivePlanClosingRun: plan ${planId} is '${plan.runState}', not executing/ready`,
      );
    }
    const active = getActivePlanExecutionRun(planId);
    if (active) {
      run(
        `UPDATE plan_execution_runs SET lifecycle_state = 'archived' WHERE id = ?`,
        [active.id],
      );
    }
    run(
      `UPDATE plans SET run_state = 'archived', updated_at = datetime('now')
         WHERE id = ? AND run_state IN ('executing','ready')`,
      [planId],
    );
    return { plan: getPlan(planId)!, closedRun: active ? getPlanExecutionRun(active.id) : null };
  });
  return tx();
}

// ── Save-card SC-WP-3B — package_finalizations schema types + lifecycle accessors ──
//
// DB-layer primitives only: insert, point/latest reads, revision high-water mark, and
// the single-row lifecycle transitions (supersede / boundary-status / committed-release).
// The ordering, JCS re-finalization comparison, ref creation, and restart reconciler
// that COMPOSE these primitives are WP-3C's finalization service, not this layer.

export type FinalizationKind = 'plan-package' | 'fleet-adhoc';
export type FinalizationBoundaryStatus = 'ready' | 'unavailable' | 'pruned';
export type FinalizationLifecycleStatus =
  | 'active' | 'superseded' | 'committed' | 'abandoned';

export interface PackageFinalization {
  id: string;
  packageId: string;
  repositoryKey: string;
  finalizationKind: FinalizationKind;
  planId: string | null;
  planItemId: string | null;
  packageRevision: number;
  finalizedAt: number;
  finalizedBy: string;
  checkpointTurnId: string | null;
  checkpointOid: string | null;
  boundaryRef: string | null;
  boundaryStatus: FinalizationBoundaryStatus;
  lifecycleStatus: FinalizationLifecycleStatus;
  supersededByFinalizationId: string | null;
  releasedAt: number | null;
  memberManifestJson: string;
  contractVersion: number;
  failureReason: string | null;
  createdFromWorkspaceId: string | null;
}

function rowToPackageFinalization(row: any): PackageFinalization {
  return {
    id: row.id,
    packageId: row.package_id,
    repositoryKey: row.repository_key,
    finalizationKind: row.finalization_kind,
    planId: row.plan_id ?? null,
    planItemId: row.plan_item_id ?? null,
    packageRevision: row.package_revision,
    finalizedAt: row.finalized_at,
    finalizedBy: row.finalized_by,
    checkpointTurnId: row.checkpoint_turn_id ?? null,
    checkpointOid: row.checkpoint_oid ?? null,
    boundaryRef: row.boundary_ref ?? null,
    boundaryStatus: row.boundary_status,
    lifecycleStatus: row.lifecycle_status,
    supersededByFinalizationId: row.superseded_by_finalization_id ?? null,
    releasedAt: row.released_at ?? null,
    memberManifestJson: row.member_manifest_json,
    contractVersion: row.contract_version,
    failureReason: row.failure_reason ?? null,
    createdFromWorkspaceId: row.created_from_workspace_id ?? null,
  };
}

/**
 * Insert a finalization row. Insert-only (no upsert): a re-finalization allocates a NEW
 * `package_revision` under the same `package_id` (WP-3C), so a duplicate `id` or a
 * duplicate `(package_id, package_revision)` is a caller bug the unique indexes reject.
 */
export function insertPackageFinalization(f: PackageFinalization): void {
  run(
    `INSERT INTO package_finalizations (
       id, package_id, repository_key, finalization_kind, plan_id, plan_item_id,
       package_revision, finalized_at, finalized_by, checkpoint_turn_id, checkpoint_oid,
       boundary_ref, boundary_status, lifecycle_status, superseded_by_finalization_id,
       released_at, member_manifest_json, contract_version, failure_reason,
       created_from_workspace_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [f.id, f.packageId, f.repositoryKey, f.finalizationKind, f.planId, f.planItemId,
      f.packageRevision, f.finalizedAt, f.finalizedBy, f.checkpointTurnId, f.checkpointOid,
      f.boundaryRef, f.boundaryStatus, f.lifecycleStatus, f.supersededByFinalizationId,
      f.releasedAt, f.memberManifestJson, f.contractVersion, f.failureReason,
      f.createdFromWorkspaceId],
  );
}

export function getPackageFinalization(id: string): PackageFinalization | null {
  const row = queryOne(`SELECT * FROM package_finalizations WHERE id = ?`, [id]);
  return row ? rowToPackageFinalization(row) : null;
}

/** All finalization revisions for a stable package, newest revision first. */
export function listPackageFinalizations(packageId: string): PackageFinalization[] {
  return queryAll(
    `SELECT * FROM package_finalizations WHERE package_id = ?
      ORDER BY package_revision DESC`,
    [packageId],
  ).map(rowToPackageFinalization);
}

/**
 * The current `active` finalization for a package, if any. The `(package_id,
 * package_revision)` unique index plus the supersede-on-refinalize discipline (WP-3C)
 * keep at most one row `active`; this returns the highest-revision such row defensively.
 */
export function getActivePackageFinalization(packageId: string): PackageFinalization | null {
  const row = queryOne(
    `SELECT * FROM package_finalizations
      WHERE package_id = ? AND lifecycle_status = 'active'
      ORDER BY package_revision DESC LIMIT 1`,
    [packageId],
  );
  return row ? rowToPackageFinalization(row) : null;
}

/** Highest allocated revision for a package (0 when none) — WP-3C's `max+1` source. */
export function maxPackageRevision(packageId: string): number {
  const row = queryOne(
    `SELECT MAX(package_revision) AS mx FROM package_finalizations WHERE package_id = ?`,
    [packageId],
  );
  return (row?.mx as number | null) ?? 0;
}

/**
 * Supersede one active finalization by a newer one, atomically. The prior row flips to
 * `lifecycle_status='superseded'` and records `superseded_by_finalization_id`; used by
 * WP-3C inside the same SQLite txn that inserts the superseding row.
 */
export function supersedePackageFinalization(id: string, supersededBy: string): void {
  run(
    `UPDATE package_finalizations
        SET lifecycle_status = 'superseded', superseded_by_finalization_id = ?
      WHERE id = ?`,
    [supersededBy, id],
  );
}

/** Set the boundary status (e.g. downgrade a stale `ready` ref to `unavailable`/`pruned`). */
export function setPackageFinalizationBoundaryStatus(
  id: string, status: FinalizationBoundaryStatus,
): void {
  run(
    `UPDATE package_finalizations SET boundary_status = ? WHERE id = ?`,
    [status, id],
  );
}

/**
 * Close a finalization: transition `lifecycle_status='committed'` and stamp `released_at`
 * (releasing the durable `boundary_ref` for retention). The closure PROOF over the full
 * manifest lives in WP-3C/retention; this is the row-level commit of that decision.
 */
export function markPackageFinalizationCommitted(id: string, releasedAt: number): void {
  run(
    `UPDATE package_finalizations
        SET lifecycle_status = 'committed', released_at = ?
      WHERE id = ?`,
    [releasedAt, id],
  );
}

// ── Planning-surface WP-P2A — proposals schema-layer primitives + md-row diag ──
//
// DDL-layer primitives ONLY: a plain insert, point/list reads, and the md-row
// inventory diagnostic. The witnessed-attribution watcher (adopt/mint, duplicate/
// malformed policy, dir-ensure) that COMPOSES these is WP-P2B, not this layer.

export type ProposalState = 'proposal' | 'promoted' | 'archived';
export type ProposalAuthorRole = 'supervisor' | 'worker' | 'unknown';

export interface ProposalRecord {
  id: string;
  artifactId: string | null;
  workspaceId: string;
  path: string;
  slug: string | null;
  title: string | null;
  state: ProposalState;
  authorAgentId: string | null;
  authorRole: ProposalAuthorRole;
  authorDisplay: string | null;
  authoredAt: number | null;
  createdAt: number;
  updatedAt: number;
  mtimeMs: number | null;
  sizeBytes: number | null;
  promotedToPlanId: string | null;
  deletedAt: number | null;
}

function rowToProposal(row: any): ProposalRecord {
  return {
    id: row.id,
    artifactId: row.artifact_id ?? null,
    workspaceId: row.workspace_id,
    path: row.path,
    slug: row.slug ?? null,
    title: row.title ?? null,
    state: row.state,
    authorAgentId: row.author_agent_id ?? null,
    authorRole: row.author_role,
    authorDisplay: row.author_display ?? null,
    authoredAt: row.authored_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    mtimeMs: row.mtime_ms ?? null,
    sizeBytes: row.size_bytes ?? null,
    promotedToPlanId: row.promoted_to_plan_id ?? null,
    deletedAt: row.deleted_at ?? null,
  };
}

/** Plain schema-layer insert of a fully-formed proposals row (throws on the
 *  (workspace_id, path) or (workspace_id, artifact_id) uniqueness violation). The
 *  attribution/adopt-or-mint policy lives in WP-P2B; this is the primitive it
 *  builds on. */
export function insertProposalRecord(rec: ProposalRecord): void {
  run(
    `INSERT INTO proposals (
       id, artifact_id, workspace_id, path, slug, title, state,
       author_agent_id, author_role, author_display, authored_at,
       created_at, updated_at, mtime_ms, size_bytes, promoted_to_plan_id, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [rec.id, rec.artifactId, rec.workspaceId, rec.path, rec.slug, rec.title, rec.state,
      rec.authorAgentId, rec.authorRole, rec.authorDisplay, rec.authoredAt,
      rec.createdAt, rec.updatedAt, rec.mtimeMs, rec.sizeBytes, rec.promotedToPlanId,
      rec.deletedAt],
  );
}

export function getProposalByWorkspacePath(workspaceId: string, path: string): ProposalRecord | null {
  const row = queryOne(
    `SELECT * FROM proposals WHERE workspace_id = ? AND path = ?`,
    [workspaceId, path],
  );
  return row ? rowToProposal(row) : null;
}

export function listProposalsByWorkspace(workspaceId: string): ProposalRecord[] {
  return queryAll(
    `SELECT * FROM proposals WHERE workspace_id = ? ORDER BY created_at, id`,
    [workspaceId],
  ).map(rowToProposal);
}

// ── WP-P2B — proposals-watcher composition primitives ────────────────────────
// The witnessed-attribution watcher (adopt/mint, duplicate/malformed policy)
// composes these on top of the WP-P2A insert/get/list. They are thin, policy-free
// reads/writes; the NORMATIVE duplicate/malformed rulings live in the watcher.

/** Point read by the portable frontmatter `artifact_id`, scoped to one workspace.
 *  The watcher calls this BEFORE inserting so a duplicate `artifact_id` is left
 *  unregistered (diagnostic) rather than thrown by the partial unique index. */
export function getProposalByWorkspaceArtifactId(
  workspaceId: string,
  artifactId: string,
): ProposalRecord | null {
  const row = queryOne(
    `SELECT * FROM proposals WHERE workspace_id = ? AND artifact_id = ?`,
    [workspaceId, artifactId],
  );
  return row ? rowToProposal(row) : null;
}

/** Refresh the mutable filesystem-derived fields of an already-registered
 *  proposal on a content change. NEVER touches `created_at` (stable date-grouping
 *  key) or the witnessed author columns (attribution is fixed at registration). */
export function touchProposalRecord(
  id: string,
  fields: { title: string | null; mtimeMs: number | null; sizeBytes: number | null; updatedAt: number },
): void {
  run(
    `UPDATE proposals SET title = ?, mtime_ms = ?, size_bytes = ?, updated_at = ? WHERE id = ?`,
    [fields.title, fields.mtimeMs, fields.sizeBytes, fields.updatedAt, id],
  );
}

/** Soft-delete a proposal row whose backing `.md` vanished. Idempotent — the row
 *  survives (history/promotion linkage) with `deleted_at` stamped. */
export function softDeleteProposalRecord(id: string, deletedAt: number): void {
  run(`UPDATE proposals SET deleted_at = ?, updated_at = ? WHERE id = ?`, [deletedAt, deletedAt, id]);
}

/** Witnessed-author resolution for the proposals watcher (WP-P2B). Returns the
 *  agent id that most recently WROTE/CREATED `filePath` per the display-only
 *  `file_activities` witness store, or null when no write witness exists. This is
 *  the ONLY attribution signal the watcher uses — it never assumes
 *  one-agent-per-cwd (many agents share a working directory by design). */
export function getLatestWriteWitnessAgentId(filePath: string): string | null {
  const row = queryOne(
    `SELECT agent_id FROM file_activities
     WHERE file_path = ? AND operation IN ('write', 'create')
     ORDER BY timestamp DESC, id DESC LIMIT 1`,
    [filePath],
  );
  return row ? String(row.agent_id) : null;
}

/** Diagnostic inventory count of legacy `plans(format='md')` rows. These stay
 *  hidden preserved historical records — never shown as plans, never duplicated
 *  into `proposals`. This count is the sole surface of their existence (WP-P2A
 *  md-row policy). Counts every md row regardless of soft-deletion; pass a
 *  workspaceId to scope. */
export function countHiddenMdPlanRows(workspaceId?: string): number {
  const row = workspaceId
    ? queryOne(`SELECT COUNT(*) AS n FROM plans WHERE format = 'md' AND workspace_id = ?`, [workspaceId])
    : queryOne(`SELECT COUNT(*) AS n FROM plans WHERE format = 'md'`);
  return row ? Number(row.n) : 0;
}

/** Persist a commit and all of its exact evidence atomically. Replays are safe. */
export function recordCommitLedger(write: CommitLedgerWrite): void {
  db.transaction(() => {
    upsertCommitRecord(write.record);
    for (const link of write.turnLinks ?? []) upsertCommitTurnLink(link);
    for (const link of write.pathLinks ?? []) upsertCommitPathLink(link);
  })();
}

export interface TurnWitnessEntry {
  path: string;
  op: TurnWitnessOp;
}

export interface TurnRecord {
  id: string;
  workspaceId: string;
  turnSeq: number;
  agentId: string | null;
  agentTitle: string | null;
  ownerAgentId: string | null;
  ownerBrickGeneration: number | null;
  /** Present on records read from the current schema. Optional only so older
   * test/store adapters can structurally model pre-migration rows. */
  planId?: string | null;
  planItemId?: string | null;
  planStampSource?: PersistedTurnPlanStampSource;
  sessionId: string | null;
  taskLabel: string | null;
  startedAt: number | null;
  endedAt: number | null;
  status: TurnStatus;
  beforeOid: string | null;
  afterOid: string | null;
  beforeRef: string | null;
  afterRef: string | null;
  beforeReady: boolean;
  afterReady: boolean;
  beforeQuality: string | null;
  afterQuality: string | null;
  beforeRawFilterBypassed: boolean;
  beforeFilteredPaths: string[] | null;
  beforePrunedAt: number | null;
  afterPrunedAt: number | null;
  touched: TurnWitnessEntry[] | null;
  diffStats: unknown | null;
  compactDiff: string | null;
  compactDiffProvenance: string | null;
  failureReason: string | null;
}

/** Fields accepted at allocation. Identity/attribution only — OIDs, refs, and
 *  diff payloads are filled later by updateTurnRecord as the edge is captured. */
export interface AllocateTurnFields {
  id?: string;
  agentId?: string | null;
  agentTitle?: string | null;
  ownerAgentId?: string | null;
  ownerBrickGeneration?: number | null;
  planId?: string | null;
  planItemId?: string | null;
  planStampSource?: TurnPlanStampSource;
  sessionId?: string | null;
  taskLabel?: string | null;
  startedAt?: number | null;
  status?: TurnStatus;
}

/** Mutable columns, keyed camelCase → { col, json? }. Anything not in this map
 *  can never be written through updateTurnRecord/closeTurn (typo + injection
 *  guard). `turn_seq`, `workspace_id`, and `id` are intentionally absent —
 *  identity is immutable. */
const TURN_UPDATABLE_COLUMNS: Record<string, { col: string; json?: boolean; bool?: boolean }> = {
  agentId: { col: 'agent_id' },
  agentTitle: { col: 'agent_title' },
  ownerAgentId: { col: 'owner_agent_id' },
  ownerBrickGeneration: { col: 'owner_brick_generation' },
  sessionId: { col: 'session_id' },
  taskLabel: { col: 'task_label' },
  startedAt: { col: 'started_at' },
  endedAt: { col: 'ended_at' },
  status: { col: 'status' },
  beforeOid: { col: 'before_oid' },
  afterOid: { col: 'after_oid' },
  beforeRef: { col: 'before_ref' },
  afterRef: { col: 'after_ref' },
  beforeReady: { col: 'before_ready', bool: true },
  afterReady: { col: 'after_ready', bool: true },
  beforeQuality: { col: 'before_quality' },
  afterQuality: { col: 'after_quality' },
  beforeRawFilterBypassed: { col: 'before_raw_filter_bypassed', bool: true },
  beforeFilteredPaths: { col: 'before_filtered_paths', json: true },
  beforePrunedAt: { col: 'before_pruned_at' },
  afterPrunedAt: { col: 'after_pruned_at' },
  touched: { col: 'touched', json: true },
  diffStats: { col: 'diff_stats', json: true },
  compactDiff: { col: 'compact_diff' },
  compactDiffProvenance: { col: 'compact_diff_provenance' },
  failureReason: { col: 'failure_reason' },
};

function parseJsonColumn<T>(raw: unknown): T | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function rowToTurnRecord(row: any): TurnRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    turnSeq: row.turn_seq,
    agentId: row.agent_id ?? null,
    agentTitle: row.agent_title ?? null,
    ownerAgentId: row.owner_agent_id ?? null,
    ownerBrickGeneration: row.owner_brick_generation ?? null,
    planId: row.plan_id ?? null,
    planItemId: row.plan_item_id ?? null,
    planStampSource: (row.plan_stamp_source ?? 'legacy-unstamped') as PersistedTurnPlanStampSource,
    sessionId: row.session_id ?? null,
    taskLabel: row.task_label ?? null,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    status: (row.status as TurnStatus) ?? 'open',
    beforeOid: row.before_oid ?? null,
    afterOid: row.after_oid ?? null,
    beforeRef: row.before_ref ?? null,
    afterRef: row.after_ref ?? null,
    beforeReady: !!row.before_ready,
    afterReady: !!row.after_ready,
    beforeQuality: row.before_quality ?? null,
    afterQuality: row.after_quality ?? null,
    beforeRawFilterBypassed: !!row.before_raw_filter_bypassed,
    beforeFilteredPaths: parseJsonColumn<string[]>(row.before_filtered_paths),
    beforePrunedAt: row.before_pruned_at ?? null,
    afterPrunedAt: row.after_pruned_at ?? null,
    touched: parseJsonColumn<TurnWitnessEntry[]>(row.touched),
    diffStats: parseJsonColumn<unknown>(row.diff_stats),
    compactDiff: row.compact_diff ?? null,
    compactDiffProvenance: row.compact_diff_provenance ?? null,
    failureReason: row.failure_reason ?? null,
  };
}

/** True for better-sqlite3 (`err.code` starts `SQLITE_CONSTRAINT`) AND the
 *  sql.js test stand-in (message `UNIQUE constraint failed: …`). */
function isUniqueConstraintError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /UNIQUE constraint failed/i.test(message);
}

export function getTurnRecord(id: string): TurnRecord | null {
  const row = queryOne('SELECT * FROM turn_records WHERE id = ?', [id]);
  return row ? rowToTurnRecord(row) : null;
}

/** Filters for {@link listTurnRecords}. Checkpoint Surface Hardening WP4. */
export interface ListTurnRecordsOpts {
  agentId?: string;
  /** Exclusive `turn_seq` lower bound — the lossless workspace paging cursor
   *  (`turn_seq` is workspace-wide monotonic, so no shared-millisecond skip). */
  since?: number;
  /** Coarse `started_at >=` epoch-ms floor. A SEPARATE filter, NEVER the cursor. */
  sinceTime?: number;
  /** Bounded page size. Callers validate the range ([1,200]); undefined → 50. */
  limit?: number;
  /** Workspace-relative POSIX path. Matches a turn whose `touched[]` contains it
   *  (op-agnostic path-presence). Applied in WHERE — evaluated BEFORE `LIMIT`. */
  file?: string;
}

export function listTurnRecords(
  workspaceId: string,
  opts?: ListTurnRecordsOpts
): TurnRecord[] {
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (opts?.agentId) {
    clauses.push('agent_id = ?');
    params.push(opts.agentId);
  }
  if (opts?.since !== undefined) {
    clauses.push('turn_seq > ?');
    params.push(opts.since);
  }
  if (opts?.sinceTime !== undefined) {
    clauses.push('started_at >= ?');
    params.push(opts.sinceTime);
  }
  if (opts?.file !== undefined) {
    // JSON1 path-presence predicate (op-agnostic — `touched[]` holds only
    // write/create today, and this stays correct if the op set grows). The
    // `touched IS NOT NULL` guard keeps `json_each(NULL)` out of the plan. It
    // lives in WHERE, so SQLite applies it BEFORE `ORDER BY … LIMIT`: an older
    // matching turn beyond the newest-N window is still found.
    clauses.push(
      "touched IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(turn_records.touched) je "
      + "WHERE json_extract(je.value, '$.path') = ?)"
    );
    params.push(opts.file);
  }
  const limit = opts?.limit ?? 50;
  // Newest-first bounded window (the cursor is `turn_seq`), then reversed to the
  // ascending API contract that `dashboard-store` / `FileHistoryView` expect.
  const rows = queryAll(
    `SELECT * FROM turn_records WHERE ${clauses.join(' AND ')} ORDER BY turn_seq DESC LIMIT ?`,
    [...params, limit]
  ).map(rowToTurnRecord);
  rows.reverse();
  return rows;
}

// ── SC-WP-1A: query-only turn witness reads (bundle contract §3) ─────────────
//
// An IMMUTABLE, read-only projection of `turn_records` for the Save-card
// witness join: per turn, its agent id, the owner/supervisor attribution FROZEN
// on the row at dispatch (owner_agent_id / owner_brick_generation), and the
// witnessed write/create paths. This is a READ accessor only — no DDL, no schema
// change, no writes.
//
// DELIBERATELY narrow SELECT (never `SELECT *`): it must NOT read or expose
// `agents.plan_id` — Stage ① performs no plan attribution for legacy/unstamped
// turns, and `agents.plan_id` must never backfill history. `touched[]` is
// filtered to write/create ops (contract §3: "write/create only").

export interface TurnWitnessRead {
  turnId: string;
  agentId: string | null;
  /** Owner/supervisor attribution frozen on the row at dispatch, if any. */
  ownerAgentId: string | null;
  ownerBrickGeneration: number | null;
  /** Witnessed write/create paths (workspace-relative POSIX, as recorded). */
  touched: TurnWitnessEntry[];
}

/** Write/create are the only ops that witness a bundle member (contract §3);
 *  the guard keeps the projection correct if the op set later grows. */
function isWitnessingOp(op: TurnWitnessOp): boolean {
  return op === 'write' || op === 'create';
}

/**
 * Immutable witness reads for a workspace's turns, ascending by `turn_seq`.
 * Query-only — mirrors the free-function `queryAll(...).map` convention.
 */
export function getTurnWitnessReads(workspaceId: string): TurnWitnessRead[] {
  return queryAll(
    `SELECT id, agent_id, owner_agent_id, owner_brick_generation, touched
       FROM turn_records WHERE workspace_id = ? ORDER BY turn_seq ASC`,
    [workspaceId]
  ).map((row: any): TurnWitnessRead => ({
    turnId: row.id,
    agentId: row.agent_id ?? null,
    ownerAgentId: row.owner_agent_id ?? null,
    ownerBrickGeneration: row.owner_brick_generation ?? null,
    touched: (parseJsonColumn<TurnWitnessEntry[]>(row.touched) ?? []).filter(
      (e) => e && typeof e.path === 'string' && isWitnessingOp(e.op)
    ),
  }));
}

/**
 * Atomic sequence allocation + insert. `MAX(turn_seq)+1` AND the insert run
 * inside ONE `db.transaction(...)`; on a `UNIQUE(workspace_id, turn_seq)`
 * violation the whole transaction is retried ONCE (a second racer having taken
 * the seq re-reads a fresh MAX). Returns the inserted record.
 */
export function allocateAndInsertTurn(
  workspaceId: string,
  fields: AllocateTurnFields = {}
): TurnRecord {
  const id = fields.id ?? uuidv4();
  const status: TurnStatus = fields.status ?? 'open';
  // SC-WP-3A: plan_work_packages now exists, so a resolved item stamp is stored.
  // The item was already validated against (workspace_id, plan_id, id) at the
  // dispatch boundary/resolver; allocation trusts that resolved stamp (exactly as
  // it trusts a resolved plan_id). An item is incoherent without a plan, though —
  // reject that rather than persist an orphan item stamp.
  const planItemId = fields.planItemId ?? null;
  if (planItemId !== null && (fields.planId ?? null) === null) {
    throw new Error('plan_item_id requires a plan_id');
  }
  // Preserve compatibility for pre-stamping call sites while still writing an
  // enum-valid runtime origin explicitly (never the column's migration default).
  const planStampSource = fields.planStampSource ?? 'agent-default';
  if (!TURN_PLAN_STAMP_SOURCES.has(planStampSource)) {
    throw new Error(`invalid turn plan stamp source '${String(planStampSource)}'`);
  }

  const insertOnce = db.transaction((): TurnRecord => {
    const next = db
      .prepare(
        'SELECT COALESCE(MAX(turn_seq), 0) + 1 AS next FROM turn_records WHERE workspace_id = ?'
      )
      .get(workspaceId) as { next: number };
    const turnSeq = next.next;
    db.prepare(
      `INSERT INTO turn_records
         (id, workspace_id, turn_seq, agent_id, agent_title, owner_agent_id,
          owner_brick_generation, plan_id, plan_item_id, plan_stamp_source,
          session_id, task_label, started_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      workspaceId,
      turnSeq,
      fields.agentId ?? null,
      fields.agentTitle ?? null,
      fields.ownerAgentId ?? null,
      fields.ownerBrickGeneration ?? null,
      fields.planId ?? null,
      planItemId,
      planStampSource,
      fields.sessionId ?? null,
      fields.taskLabel ?? null,
      fields.startedAt ?? null,
      status
    );
    return rowToTurnRecord(
      db.prepare('SELECT * FROM turn_records WHERE id = ?').get(id)
    );
  });

  try {
    return insertOnce();
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      // One racer took our seq; a fresh MAX read on retry resolves it.
      return insertOnce();
    }
    throw err;
  }
}

function buildTurnUpdate(updates: Record<string, unknown>): { sql: string; params: unknown[] } {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const spec = TURN_UPDATABLE_COLUMNS[key];
    if (!spec) continue; // ignore unknown keys (identity columns, typos)
    sets.push(`${spec.col} = ?`);
    if (value === null || value === undefined) {
      params.push(null);
    } else if (spec.json) {
      params.push(JSON.stringify(value));
    } else if (spec.bool) {
      params.push(value ? 1 : 0);
    } else {
      params.push(value);
    }
  }
  return { sql: sets.join(', '), params };
}

/**
 * Update a turn record with status-transition enforcement:
 *  - a terminal row is IMMUTABLE — any update throws.
 *  - a `status` change is legal only `open → <terminal target>`; an illegal
 *    target throws. Setting `status` to the same value (a no-op) is allowed.
 * Returns the updated record, or null if `id` is unknown.
 */
export function updateTurnRecord(
  id: string,
  updates: Partial<Record<keyof typeof TURN_UPDATABLE_COLUMNS, unknown>>
): TurnRecord | null {
  const tx = db.transaction((): TurnRecord | null => {
    const current = db.prepare('SELECT * FROM turn_records WHERE id = ?').get(id) as
      | { status: TurnStatus }
      | undefined;
    if (!current) return null;

    if (current.status !== 'open') {
      throw new Error(
        `turn_records ${id} is terminal ('${current.status}') and immutable`
      );
    }

    const nextStatus = (updates as { status?: TurnStatus }).status;
    if (nextStatus !== undefined && nextStatus !== current.status) {
      if (!TURN_TERMINAL_STATUSES.has(nextStatus)) {
        throw new Error(
          `illegal turn transition 'open' → '${nextStatus}' for ${id}`
        );
      }
    }

    const { sql, params } = buildTurnUpdate(updates as Record<string, unknown>);
    if (sql.length > 0) {
      db.prepare(`UPDATE turn_records SET ${sql} WHERE id = ?`).run(...params, id);
    }
    return rowToTurnRecord(db.prepare('SELECT * FROM turn_records WHERE id = ?').get(id));
  });
  return tx();
}

/**
 * Reconciliation-only writer (Git-Native WP-G1.8). Unlike {@link updateTurnRecord}
 * this may write to a TERMINAL row, because a persisted-but-non-ready edge routinely
 * outlives its turn's close: finalize (WP-G1.3b) persists the candidate OID + ref
 * INSIDE the durable section, then may overrun the wall-clock deadline before the
 * ref is verified — delivery is released and the row eventually closes with the edge
 * still `*_ready=0`. Startup reconciliation regenerates/adopts the ref and must be
 * able to flip `before_ready`/`after_ready` (+ backfill the reconciled `*_quality` /
 * `failure_reason`) on that already-terminal row. It NEVER changes `status` (identity
 * of the terminal outcome is immutable) and only touches the whitelisted columns.
 * Returns the updated record, or null if `id` is unknown.
 */
export function reconcileTurnRecord(
  id: string,
  updates: Partial<Record<keyof typeof TURN_UPDATABLE_COLUMNS, unknown>>
): TurnRecord | null {
  if ('status' in updates) {
    throw new Error('reconcileTurnRecord may never change status');
  }
  const { sql, params } = buildTurnUpdate(updates as Record<string, unknown>);
  if (sql.length === 0) return getTurnRecord(id);
  const info = db
    .prepare(`UPDATE turn_records SET ${sql} WHERE id = ?`)
    .run(...params, id) as { changes?: number };
  if (info && info.changes === 0) return null;
  return getTurnRecord(id);
}

/**
 * Idempotent close: transition an OPEN turn to a terminal `status` (stamping
 * `ended_at` and any extra fields). If the turn is ALREADY terminal this is a
 * no-op that returns the existing record unchanged — this closes the
 * double-close / after-edge race. Returns null if `id` is unknown.
 */
export function closeTurn(
  id: string,
  status: Exclude<TurnStatus, 'open'>,
  extra?: Partial<Record<keyof typeof TURN_UPDATABLE_COLUMNS, unknown>>,
  endedAt?: number | null
): TurnRecord | null {
  if (!TURN_TERMINAL_STATUSES.has(status)) {
    throw new Error(`closeTurn requires a terminal status, got '${status}'`);
  }
  const tx = db.transaction((): TurnRecord | null => {
    const current = db.prepare('SELECT * FROM turn_records WHERE id = ?').get(id) as
      | { status: TurnStatus }
      | undefined;
    if (!current) return null;
    // Idempotent: already terminal → return as-is, never re-close.
    if (current.status !== 'open') return rowToTurnRecord(current);

    const merged: Record<string, unknown> = {
      ...(extra ?? {}),
      status,
      endedAt: endedAt ?? Date.now(),
    };
    const { sql, params } = buildTurnUpdate(merged);
    db.prepare(`UPDATE turn_records SET ${sql} WHERE id = ?`).run(...params, id);
    return rowToTurnRecord(db.prepare('SELECT * FROM turn_records WHERE id = ?').get(id));
  });
  return tx();
}

/**
 * Append a witnessed write/create to a turn's `touched` JSON array, with
 * transactional `(turnId, path, op)` dedupe: the read-modify-write runs inside
 * one transaction, and an already-present `(path, op)` tuple is a no-op.
 * Returns true if a new entry was appended, false if it was a dedupe no-op or
 * the turn is unknown.
 */
export function recordWitnessedActivity(
  turnId: string,
  filePath: string,
  op: TurnWitnessOp
): boolean {
  const tx = db.transaction((): boolean => {
    const row = db.prepare('SELECT touched FROM turn_records WHERE id = ?').get(turnId) as
      | { touched: string | null }
      | undefined;
    if (!row) return false;
    const entries = parseJsonColumn<TurnWitnessEntry[]>(row.touched) ?? [];
    if (entries.some((e) => e.path === filePath && e.op === op)) return false; // dedupe
    entries.push({ path: filePath, op });
    db.prepare('UPDATE turn_records SET touched = ? WHERE id = ?').run(
      JSON.stringify(entries),
      turnId
    );
    return true;
  });
  return tx();
}

// ── turn_records export projection ───────────────────────────────────────────
//
// Named allowlist for any analytics/export path that serializes turn_records.
// Refs and diffs contain raw workspace bytes / path lists (cross-cutting
// invariant §7 — keep local, exclude from telemetry/export by default), so
// `compact_diff`, `touched`, and `before_filtered_paths` are DELIBERATELY
// excluded. Callers that need those must opt in explicitly, never by default.
export const TURN_RECORD_EXPORT_ALLOWLIST = [
  'id',
  'workspace_id',
  'turn_seq',
  'agent_id',
  'agent_title',
  'owner_agent_id',
  'owner_brick_generation',
  'session_id',
  'task_label',
  'started_at',
  'ended_at',
  'status',
  'before_oid',
  'after_oid',
  'before_ref',
  'after_ref',
  'before_ready',
  'after_ready',
  'before_quality',
  'after_quality',
  'before_raw_filter_bypassed',
  'before_pruned_at',
  'after_pruned_at',
  'diff_stats',
  'compact_diff_provenance',
  'failure_reason',
] as const;

/** Columns intentionally withheld from the default export (invariant §7). */
export const TURN_RECORD_EXPORT_EXCLUDED = [
  'compact_diff',
  'touched',
  'before_filtered_paths',
] as const;

/**
 * Project turn_records rows to the export allowlist. The returned objects
 * NEVER carry `compact_diff`, `touched`, or `before_filtered_paths`.
 */
export function exportTurnRecords(
  workspaceId: string,
  opts?: { agentId?: string }
): Record<string, unknown>[] {
  const cols = TURN_RECORD_EXPORT_ALLOWLIST.join(', ');
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (opts?.agentId) {
    clauses.push('agent_id = ?');
    params.push(opts.agentId);
  }
  return queryAll(
    `SELECT ${cols} FROM turn_records WHERE ${clauses.join(' AND ')} ORDER BY turn_seq ASC`,
    params
  ) as Record<string, unknown>[];
}

// ── recovery_operations CRUD ─────────────────────────────────────────────────

export type RecoveryOperationKind = 'restore_paths' | 'revert_turn' | 'whole_tree' | string;
export type RecoveryOperationStatus =
  | 'pending'
  | 'ready'
  | 'completed'
  | 'partial'
  | 'failed'
  | string;

export interface RecoveryOperation {
  id: string;
  workspaceId: string;
  kind: RecoveryOperationKind;
  actor: string;
  sourceTurnId: string | null;
  preRef: string | null;
  preOid: string | null;
  preReady: boolean;
  preIncludedPaths: unknown | null;
  requestedPaths: unknown | null;
  previewToken: string | null;
  status: RecoveryOperationStatus;
  completedPaths: unknown | null;
  result: string | null;
  failureReason: string | null;
  createdAt: number | null;
  endedAt: number | null;
}

const RECOVERY_UPDATABLE_COLUMNS: Record<string, { col: string; json?: boolean; bool?: boolean }> = {
  kind: { col: 'kind' },
  actor: { col: 'actor' },
  sourceTurnId: { col: 'source_turn_id' },
  preRef: { col: 'pre_ref' },
  preOid: { col: 'pre_oid' },
  preReady: { col: 'pre_ready', bool: true },
  preIncludedPaths: { col: 'pre_included_paths', json: true },
  requestedPaths: { col: 'requested_paths', json: true },
  previewToken: { col: 'preview_token' },
  status: { col: 'status' },
  completedPaths: { col: 'completed_paths', json: true },
  result: { col: 'result' },
  failureReason: { col: 'failure_reason' },
  endedAt: { col: 'ended_at' },
};

function rowToRecoveryOperation(row: any): RecoveryOperation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    actor: row.actor,
    sourceTurnId: row.source_turn_id ?? null,
    preRef: row.pre_ref ?? null,
    preOid: row.pre_oid ?? null,
    preReady: !!row.pre_ready,
    preIncludedPaths: parseJsonColumn<unknown>(row.pre_included_paths),
    requestedPaths: parseJsonColumn<unknown>(row.requested_paths),
    previewToken: row.preview_token ?? null,
    status: row.status,
    completedPaths: parseJsonColumn<unknown>(row.completed_paths),
    result: row.result ?? null,
    failureReason: row.failure_reason ?? null,
    createdAt: row.created_at ?? null,
    endedAt: row.ended_at ?? null,
  };
}

export interface InsertRecoveryOperationFields {
  id?: string;
  kind: RecoveryOperationKind;
  actor: string;
  status?: RecoveryOperationStatus;
  sourceTurnId?: string | null;
  preRef?: string | null;
  preOid?: string | null;
  preReady?: boolean;
  preIncludedPaths?: unknown;
  requestedPaths?: unknown;
  previewToken?: string | null;
  completedPaths?: unknown;
  result?: string | null;
  failureReason?: string | null;
  createdAt?: number | null;
}

export function insertRecoveryOperation(
  workspaceId: string,
  fields: InsertRecoveryOperationFields
): RecoveryOperation {
  const id = fields.id ?? uuidv4();
  db.prepare(
    `INSERT INTO recovery_operations
       (id, workspace_id, kind, actor, source_turn_id, pre_ref, pre_oid,
        pre_ready, pre_included_paths, requested_paths, preview_token, status,
        completed_paths, result, failure_reason, created_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    workspaceId,
    fields.kind,
    fields.actor,
    fields.sourceTurnId ?? null,
    fields.preRef ?? null,
    fields.preOid ?? null,
    fields.preReady ? 1 : 0,
    fields.preIncludedPaths !== undefined ? JSON.stringify(fields.preIncludedPaths) : null,
    fields.requestedPaths !== undefined ? JSON.stringify(fields.requestedPaths) : null,
    fields.previewToken ?? null,
    fields.status ?? 'pending',
    fields.completedPaths !== undefined ? JSON.stringify(fields.completedPaths) : null,
    fields.result ?? null,
    fields.failureReason ?? null,
    fields.createdAt ?? Date.now()
  );
  return rowToRecoveryOperation(
    db.prepare('SELECT * FROM recovery_operations WHERE id = ?').get(id)
  );
}

export function getRecoveryOperation(id: string): RecoveryOperation | null {
  const row = queryOne('SELECT * FROM recovery_operations WHERE id = ?', [id]);
  return row ? rowToRecoveryOperation(row) : null;
}

export function listRecoveryOperations(
  workspaceId: string,
  opts?: { sourceTurnId?: string }
): RecoveryOperation[] {
  const clauses = ['workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (opts?.sourceTurnId) {
    clauses.push('source_turn_id = ?');
    params.push(opts.sourceTurnId);
  }
  return queryAll(
    `SELECT * FROM recovery_operations WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`,
    params
  ).map(rowToRecoveryOperation);
}

export function updateRecoveryOperation(
  id: string,
  updates: Partial<Record<keyof typeof RECOVERY_UPDATABLE_COLUMNS, unknown>>
): RecoveryOperation | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const spec = RECOVERY_UPDATABLE_COLUMNS[key];
    if (!spec) continue;
    sets.push(`${spec.col} = ?`);
    if (value === null || value === undefined) params.push(null);
    else if (spec.json) params.push(JSON.stringify(value));
    else if (spec.bool) params.push(value ? 1 : 0);
    else params.push(value);
  }
  if (sets.length === 0) return getRecoveryOperation(id);
  const info = db
    .prepare(`UPDATE recovery_operations SET ${sets.join(', ')} WHERE id = ?`)
    .run(...params, id) as { changes?: number };
  if (info && info.changes === 0) return null;
  return getRecoveryOperation(id);
}

export function deleteRecoveryOperation(id: string): void {
  run('DELETE FROM recovery_operations WHERE id = ?', [id]);
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
    // Defensive parse: a corrupt anchor_json degrades to no anchor, never a
    // throw that would blow up a whole comment list (plan Part 1.4).
    anchorType: (row.anchor_type ?? 'text') as SelectionAnchorType,
    pdfAnchor: parsePdfSelectionAnchor(row.anchor_json ?? null),
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

// Validate + serialize a PDF anchor for a write (plan Part 1.4): reject an
// invalid PdfSelectionAnchorV1 rather than store a corrupt row, and surface the
// fingerprint so callers can pin it into doc_hash. A 'text' anchor (or a null
// pdfAnchor) serializes to no JSON.
function resolvePdfAnchorForWrite(
  anchorType: SelectionAnchorType | undefined,
  pdfAnchor: PdfSelectionAnchorV1 | null | undefined,
): { anchorJson: string | null; fingerprint: string | null } {
  if (anchorType !== 'pdf') return { anchorJson: null, fingerprint: null };
  if (!pdfAnchor) throw new Error('createSelectionComment: anchorType "pdf" requires a pdfAnchor');
  const validation = validatePdfSelectionAnchor(pdfAnchor);
  if (!validation.ok) throw new Error(`Invalid PDF anchor: ${validation.error}`);
  return { anchorJson: serializePdfSelectionAnchor(pdfAnchor), fingerprint: pdfAnchor.fingerprint };
}

export function createSelectionComment(input: CreateSelectionCommentInput): SelectionComment {
  const id = uuidv4();
  const anchorType: SelectionAnchorType = input.anchorType ?? 'text';
  const { anchorJson, fingerprint } = resolvePdfAnchorForWrite(anchorType, input.pdfAnchor);
  // For a PDF row the document fingerprint IS the reattach doc_hash; an explicit
  // docHash still wins if a caller passes one.
  const docHash = input.docHash ?? fingerprint ?? null;
  run(
    `INSERT INTO selection_comments (
       id, workspace_id, target_type, kind, file_path, path_type, root_directory,
       doc_hash, anchor_start, anchor_end, line_start, line_end, prefix, suffix,
       quoted_text, body, status, anchor_type, anchor_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    [
      id, input.workspaceId, input.targetType ?? 'file', input.kind ?? 'comment',
      input.filePath,
      input.pathType ?? null, input.rootDirectory ?? null, docHash,
      input.anchorStart ?? null, input.anchorEnd ?? null,
      input.lineStart ?? null, input.lineEnd ?? null,
      input.prefix ?? null, input.suffix ?? null,
      input.quotedText, input.body,
      anchorType, anchorJson,
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

/** Forgiving path-based comment lookup that ports `.lares/scripts/read-comments.py`
 *  in-process for the `read_comments` MCP tool — removing the app's only hard
 *  Python dependency (clean Windows VMs ship no real Python, only a 0-byte Store
 *  stub). Matches ACROSS every workspace by file path: the DB is global and the
 *  stored file path is the disambiguator, not the workspace (the script is
 *  likewise workspace-agnostic). Normalizes slashes + case, prefers an exact-path
 *  match, and falls back to a basename match with a `matchedByFilename` warning
 *  flag. Resolved/orphaned rows are excluded unless `includeResolved`. Sorted by
 *  line_start (null anchors last) then created_at — byte-for-byte the script's
 *  ordering. */
export function findSelectionCommentsByPath(
  targetPath: string,
  includeResolved: boolean,
): { comments: SelectionComment[]; matchedByFilename: boolean } {
  const norm = (p: string | null | undefined): string =>
    p ? p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
  const baseOf = (p: string): string => {
    const i = p.lastIndexOf('/');
    return i >= 0 ? p.slice(i + 1) : p;
  };

  const rows = queryAll(
    `SELECT * FROM selection_comments WHERE file_path IS NOT NULL`
  ).map(rowToSelectionComment);

  const nt = norm(targetPath);
  const base = baseOf(nt);
  const exact = rows.filter((r) => norm(r.filePath) === nt);
  let matched = exact.length > 0
    ? exact
    : rows.filter((r) => baseOf(norm(r.filePath)) === base);
  if (!includeResolved) {
    matched = matched.filter((r) => r.status !== 'resolved' && r.status !== 'orphaned');
  }
  matched.sort((a, b) => {
    const aNull = a.lineStart == null;
    const bNull = b.lineStart == null;
    if (aNull !== bNull) return aNull ? 1 : -1;
    const al = a.lineStart ?? 0;
    const bl = b.lineStart ?? 0;
    if (al !== bl) return al - bl;
    return (a.createdAt || '').localeCompare(b.createdAt || '');
  });
  return { comments: matched, matchedByFilename: exact.length === 0 && matched.length > 0 };
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

  // Anchor repointing (plan Part 1.4): touched only when the caller passes
  // anchorType or pdfAnchor. anchorType 'pdf' (or a non-null pdfAnchor) writes a
  // validated anchor + pins doc_hash to its fingerprint; 'text'/null clears it.
  if (updates.anchorType !== undefined || updates.pdfAnchor !== undefined) {
    const nextType: SelectionAnchorType =
      updates.anchorType ?? (updates.pdfAnchor ? 'pdf' : 'text');
    const { anchorJson, fingerprint } = resolvePdfAnchorForWrite(nextType, updates.pdfAnchor);
    sets.push('anchor_type = ?'); params.push(nextType);
    sets.push('anchor_json = ?'); params.push(anchorJson);
    // Keep doc_hash in step with the fingerprint unless docHash was set above.
    if (updates.docHash === undefined && fingerprint !== null) {
      sets.push('doc_hash = ?'); params.push(fingerprint);
    }
  }

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

// ── WP-P4D-reply — companion reply accessors (ACCESSORS ONLY; DDL landed A2) ──
//
// A reply is a COMPANION row in `selection_comment_replies` keyed to its question
// comment. These accessors ONLY touch that table — they never update
// `selection_comments` (its `body` / `status` machine is untouched by an answer).
// `created_at` is an epoch-ms INTEGER owned here; `author_agent_id` is nullable.

function rowToSelectionCommentReply(row: any): SelectionCommentReply {
  return {
    id: row.id,
    commentId: row.comment_id,
    body: row.body,
    authorAgentId: row.author_agent_id ?? null,
    createdAt: row.created_at,
  };
}

export function createSelectionCommentReply(input: CreateSelectionCommentReplyInput): SelectionCommentReply {
  const id = uuidv4();
  const createdAt = input.createdAt ?? Date.now();
  run(
    `INSERT INTO selection_comment_replies (id, comment_id, body, author_agent_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, input.commentId, input.body, input.authorAgentId ?? null, createdAt],
  );
  return getSelectionCommentReply(id)!;
}

export function getSelectionCommentReply(id: string): SelectionCommentReply | null {
  const row = queryOne('SELECT * FROM selection_comment_replies WHERE id = ?', [id]);
  return row ? rowToSelectionCommentReply(row) : null;
}

/** All replies for one question comment, oldest first (thread order) — the join
 *  P4D-proj folds onto its question row. Ordered by `created_at` then `id` so
 *  same-millisecond replies still have a stable order. */
export function listSelectionCommentReplies(commentId: string): SelectionCommentReply[] {
  return queryAll(
    `SELECT * FROM selection_comment_replies
     WHERE comment_id = ?
     ORDER BY created_at ASC, id ASC`,
    [commentId],
  ).map(rowToSelectionCommentReply);
}

/** Registered external plan documents (the create path's `proposal` / `legacy-html`
 *  targets) for one workspace, with their owning plan. The reply service reverse-
 *  matches a non-logical comment `file_path` against these rows to resolve which
 *  plan a registered-doc comment belongs to (folder-doc comments resolve durably
 *  from their `lares-plan-doc:v1:` key instead). */
export interface RegisteredPlanDocumentRow {
  id: string;
  planId: string;
  workspaceId: string;
  docKind: string;
  relPath: string;
}

export function listRegisteredPlanDocumentsByWorkspace(workspaceId: string): RegisteredPlanDocumentRow[] {
  return queryAll(
    `SELECT id, plan_id, workspace_id, doc_kind, rel_path
       FROM plan_documents
      WHERE workspace_id = ? AND doc_kind IN ('proposal', 'legacy-html')`,
    [workspaceId],
  ).map((row) => ({
    id: row.id,
    planId: row.plan_id,
    workspaceId: row.workspace_id,
    docKind: row.doc_kind,
    relPath: row.rel_path,
  }));
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
    planId: row.plan_id ?? undefined,
    planningIntentId: row.planning_intent_id ?? null,
    planItemId: row.plan_item_id ?? null,
    sectionAnchor: row.section_anchor ?? undefined,
    planBindingMode: row.plan_binding_mode ?? (row.plan_id ? 'explicit' : 'agent-default'),
  };
}

/** Insert or update a run row (upsert keyed on run_id). */
export function insertOrchestration(r: OrchestrationRun): void {
  run(
    `INSERT INTO orchestrations (
       run_id, name, mode, status, workspace_id, supervisor_id, topic, plan_path,
       lead_provider, reviewer_provider, turn_timeout_ms, lead_id, reviewer_id,
       turn, round, last_relayed_ts, started_at, updated_at, ended_at, error,
       plan_id, section_anchor, plan_item_id, plan_binding_mode, planning_intent_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       name = excluded.name, mode = excluded.mode, status = excluded.status,
       workspace_id = excluded.workspace_id, supervisor_id = excluded.supervisor_id,
       topic = excluded.topic, plan_path = excluded.plan_path,
       lead_provider = excluded.lead_provider, reviewer_provider = excluded.reviewer_provider,
       turn_timeout_ms = excluded.turn_timeout_ms, lead_id = excluded.lead_id,
       reviewer_id = excluded.reviewer_id, turn = excluded.turn, round = excluded.round,
       last_relayed_ts = excluded.last_relayed_ts, started_at = excluded.started_at,
       updated_at = excluded.updated_at, ended_at = excluded.ended_at, error = excluded.error,
       plan_id = excluded.plan_id, section_anchor = excluded.section_anchor,
       plan_item_id = excluded.plan_item_id, plan_binding_mode = excluded.plan_binding_mode,
       planning_intent_id = COALESCE(orchestrations.planning_intent_id, excluded.planning_intent_id)`,
    [
      r.runId, r.name, r.mode, r.status, r.workspaceId, r.supervisorId,
      r.topic, r.planPath, r.leadProvider, r.reviewerProvider, r.turnTimeoutMs,
      r.leadId ?? null, r.reviewerId ?? null, r.turn ?? null, r.round ?? null,
      JSON.stringify(r.lastRelayedTs || {}), r.startedAt, r.updatedAt,
      r.endedAt ?? null, r.error ?? null,
      r.planId ?? null, r.sectionAnchor ?? null, r.planItemId ?? null,
      r.planBindingMode ?? (r.planId ? 'explicit' : 'agent-default'),
      r.planningIntentId ?? null,
    ]
  );
}

/** Trusted launch-boundary lookup for a requested planning intent. Identity is
 * composite: the same intent_id may exist in another plan or workspace. */
export function getActivePlanningIntentForLaunch(
  workspaceId: string,
  planId: string,
  intentId: string,
): { planId: string; intentId: string; status: 'active' } | null {
  const row = queryOne(
    `SELECT plan_id, intent_id, status FROM plan_intents
     WHERE workspace_id = ? AND plan_id = ? AND intent_id = ? AND status = 'active'`,
    [workspaceId, planId, intentId],
  );
  return row ? { planId: row.plan_id, intentId: row.intent_id, status: 'active' } : null;
}

/** Persist progress on an existing run (same upsert path as insert). */
export function updateOrchestration(r: OrchestrationRun): void {
  insertOrchestration(r);
}

export function getOrchestrationRun(runId: string): OrchestrationRun | null {
  const row = queryOne('SELECT * FROM orchestrations WHERE run_id = ?', [runId]);
  return row ? rowToOrchestrationRun(row) : null;
}

/** Read the binding frozen on an orchestration run. Invalid persisted modes are
 * rejected rather than silently falling back to a live agent default. */
export function getOrchestrationBinding(orchestrationId: string): OrchestrationBinding | null {
  const row = queryOne(
    'SELECT plan_id, plan_item_id, plan_binding_mode FROM orchestrations WHERE run_id = ?',
    [orchestrationId],
  );
  if (!row) return null;
  const mode = row.plan_binding_mode as OrchestrationPlanBindingMode;
  if (mode !== 'explicit' && mode !== 'agent-default') {
    throw new Error(`Invalid orchestration plan binding mode: ${String(row.plan_binding_mode)}`);
  }
  return {
    planId: row.plan_id ?? null,
    planItemId: row.plan_item_id ?? null,
    mode,
  };
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
 *  they were BEFORE the update so the caller can emit resume hints.
 *
 *  WP-P3B-core: `name <> 'promotion'` is scoped INTO the SQL (both the SELECT and
 *  the UPDATE) rather than filtered afterward in orchestration/service.ts —
 *  because the DB function here is what actually aborts every starting/running
 *  row, a post-call filter would be too late. Promotion rows legitimately live in
 *  `starting` (reserved / bound-unconfirmed) and `running` (confirmed delivery);
 *  they are reconciled by the pending-promotion reconciler (WP-P3-reconcile),
 *  never boot-aborted, so they must survive this sweep. */
export function markActiveRunsAborted(reason: string): OrchestrationRun[] {
  const rows = queryAll(
    "SELECT * FROM orchestrations WHERE status IN ('starting', 'running') AND name <> 'promotion'"
  ).map(rowToOrchestrationRun);
  if (rows.length > 0) {
    run(
      "UPDATE orchestrations SET status = 'aborted', error = ?, ended_at = ?, updated_at = ? WHERE status IN ('starting', 'running') AND name <> 'promotion'",
      [reason, new Date().toISOString(), new Date().toISOString()]
    );
  }
  return rows;
}

// ── Promotion-request accessors (WP-P3B-core) ──────────────────────────────
// ACCESSORS ONLY — the promotion_requests DDL is frozen (§R-A2, landed by
// WP-P3A′); the A2 window is CLOSED, so nothing here adds a table or column.
// These back the durable de-dup seam (UNIQUE(workspace_id, proposal_artifact_id))
// and the crash-safe two-phase bind-before-deliver lifecycle: Phase 1 reserves
// the promotion orchestration row AND binds it onto the request atomically;
// Phase 2a binds the worker agent + member + `promotion.agent_bound` event
// atomically inside launchAgent; Phase 2b records `promotion.delivered` only
// after a confirmed turn start. Timestamps are service-owned INTEGER epochs.

export interface PromotionRequestRow {
  id: string;
  workspaceId: string;
  proposalId: string;
  proposalArtifactId: string;
  planArtifactId: string;
  targetFolderRelPath: string;
  supervisorId: string | null;
  orchestrationId: string | null;
  state: 'pending' | 'adopted' | 'failed';
  attemptCount: number;
  failureReason: string | null;
  createdAt: number;
  updatedAt: number;
}

function rowToPromotionRequest(row: any): PromotionRequestRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    proposalId: row.proposal_id,
    proposalArtifactId: row.proposal_artifact_id,
    planArtifactId: row.plan_artifact_id,
    targetFolderRelPath: row.target_folder_rel_path,
    supervisorId: row.supervisor_id ?? null,
    orchestrationId: row.orchestration_id ?? null,
    state: row.state,
    attemptCount: row.attempt_count,
    failureReason: row.failure_reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Durable cross-restart de-dup seam. Insert a fresh `pending` request, or read
 *  the existing row for `(workspace_id, proposal_artifact_id)` — the UNIQUE
 *  constraint is authoritative, so a cross-process INSERT loser reads the
 *  winner's row instead of duplicating (§R-P3 point 8). The identity
 *  (plan_artifact_id / target_folder_rel_path) is caller-resolved (claim-scan
 *  FIRST, then deterministic derivation) and persisted verbatim. */
export function insertOrReadPromotionRequest(input: {
  id: string;
  workspaceId: string;
  proposalId: string;
  proposalArtifactId: string;
  planArtifactId: string;
  targetFolderRelPath: string;
  supervisorId?: string | null;
}): { row: PromotionRequestRow; created: boolean } {
  const readExisting = (): PromotionRequestRow | null => {
    const existing = queryOne(
      'SELECT * FROM promotion_requests WHERE workspace_id = ? AND proposal_artifact_id = ?',
      [input.workspaceId, input.proposalArtifactId],
    );
    return existing ? rowToPromotionRequest(existing) : null;
  };
  const pre = readExisting();
  if (pre) return { row: pre, created: false };
  const now = Date.now();
  try {
    run(
      `INSERT INTO promotion_requests
         (id, workspace_id, proposal_id, proposal_artifact_id, plan_artifact_id,
          target_folder_rel_path, supervisor_id, orchestration_id, state,
          attempt_count, failure_reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', 0, NULL, ?, ?)`,
      [input.id, input.workspaceId, input.proposalId, input.proposalArtifactId,
        input.planArtifactId, input.targetFolderRelPath, input.supervisorId ?? null, now, now],
    );
  } catch (err: any) {
    // A racing writer (this process or another) won the UNIQUE(workspace_id,
    // proposal_artifact_id) constraint between our read and insert — read theirs.
    const raced = readExisting();
    if (raced) return { row: raced, created: false };
    throw err;
  }
  return { row: rowToPromotionRequest(queryOne('SELECT * FROM promotion_requests WHERE id = ?', [input.id])), created: true };
}

export function getPromotionRequestById(id: string): PromotionRequestRow | null {
  const row = queryOne('SELECT * FROM promotion_requests WHERE id = ?', [id]);
  return row ? rowToPromotionRequest(row) : null;
}

export function getPromotionRequestByProposal(
  workspaceId: string, proposalArtifactId: string,
): PromotionRequestRow | null {
  const row = queryOne(
    'SELECT * FROM promotion_requests WHERE workspace_id = ? AND proposal_artifact_id = ?',
    [workspaceId, proposalArtifactId],
  );
  return row ? rowToPromotionRequest(row) : null;
}

export function getPromotionRequestByOrchestration(orchestrationId: string): PromotionRequestRow | null {
  const row = queryOne(
    'SELECT * FROM promotion_requests WHERE orchestration_id = ?',
    [orchestrationId],
  );
  return row ? rowToPromotionRequest(row) : null;
}

export function listPendingPromotionRequests(): PromotionRequestRow[] {
  return queryAll("SELECT * FROM promotion_requests WHERE state = 'pending' ORDER BY created_at ASC")
    .map(rowToPromotionRequest);
}

/** Phase 1 (§R-P3 points 5, 6) — reserve the promotion orchestration row AND bind
 *  its id onto the request, atomically, BEFORE any delivery. `incrementAttempt`
 *  distinguishes a first reservation (request stays `pending`, attempt_count
 *  unchanged) from a `failed → pending` retry (attempt_count++, failure_reason
 *  cleared, orchestration_id replaced with the new attempt). The deterministic
 *  identity on the request is retained across retries — only the attempt's
 *  orchestration changes. */
export function reservePromotionOrchestration(input: {
  requestId: string;
  run: OrchestrationRun;
  ts: string;
  incrementAttempt: boolean;
}): void {
  const tx = db.transaction(() => {
    insertOrchestration(input.run);
    insertOrchestrationEvent({
      runId: input.run.runId, ts: input.ts, kind: 'promotion.reserved',
      payload: { requestId: input.requestId },
    });
    if (input.incrementAttempt) {
      run(
        `UPDATE promotion_requests
           SET orchestration_id = ?, state = 'pending', failure_reason = NULL,
               attempt_count = attempt_count + 1, updated_at = ?
         WHERE id = ?`,
        [input.run.runId, Date.now(), input.requestId],
      );
    } else {
      run(
        `UPDATE promotion_requests SET orchestration_id = ?, updated_at = ? WHERE id = ?`,
        [input.run.runId, Date.now(), input.requestId],
      );
    }
  });
  tx();
}

/** Phase 2a (§R-P3 point 5) — the atomic agent/member/event transaction. In ONE
 *  DB transaction: create the agent row, bind it as the run's `worker` member,
 *  persist the `promotion.agent_bound` event, and touch the orchestration
 *  (status stays `starting`). A crash before COMMIT leaves neither the agent row
 *  nor the member (no unbound orphan); a crash after COMMIT always yields the
 *  exact bound agent. Invoked from AgentSupervisor.launchAgent under a trusted
 *  InternalLaunchContext — the process spawn happens only after this returns. */
export function bindPromotionAgentAtomic(
  createAgentInput: Parameters<typeof createAgent>[0],
  binding: { runId: string; ts: string },
): Agent {
  const tx = db.transaction((): Agent => {
    const agent = createAgent(createAgentInput);
    insertOrchestrationMember(binding.runId, 'worker', agent.id);
    insertOrchestrationEvent({
      runId: binding.runId, ts: binding.ts, kind: 'promotion.agent_bound',
      payload: { agentId: agent.id },
    });
    run(
      "UPDATE orchestrations SET status = 'starting', updated_at = ? WHERE run_id = ?",
      [binding.ts, binding.runId],
    );
    return agent;
  });
  return tx();
}

/** The bound worker agent id for a promotion run, or null if Phase 2a never
 *  committed (→ the oracle's `reserved-unbound`). */
export function getPromotionWorkerMember(runId: string): string | null {
  const row = queryOne(
    "SELECT agent_id FROM orchestration_members WHERE run_id = ? AND role = 'worker'",
    [runId],
  );
  return row ? row.agent_id : null;
}

/** Existence probe over the promotion event ledger — the oracle reads phase
 *  markers (`promotion.delivery_attempt`, `promotion.delivered`, …) this way. */
export function hasOrchestrationEvent(runId: string, kind: OrchestrationEvent['kind']): boolean {
  return !!queryOne(
    'SELECT 1 FROM orchestration_events WHERE run_id = ? AND kind = ? LIMIT 1',
    [runId, kind],
  );
}

/** Phase 2b — record that the confirmed-send body was submitted (before the send
 *  resolves) so restart inspection can tell "never attempted" from "attempt
 *  interrupted". The stable `promotion:<requestId>` marker rides the payload. */
export function recordPromotionDeliveryAttempt(runId: string, ts: string, marker: string): void {
  insertOrchestrationEvent({
    runId, ts, kind: 'promotion.delivery_attempt', payload: { marker },
  });
}

/** Phase 2b terminal-success — write `promotion.delivered` AND flip the run to
 *  `running`, atomically. Called ONLY after a matching turn-start confirmation,
 *  never on submission and never on launchAgent return. */
export function recordPromotionDelivered(runId: string, ts: string): void {
  const tx = db.transaction(() => {
    insertOrchestrationEvent({ runId, ts, kind: 'promotion.delivered', payload: {} });
    run("UPDATE orchestrations SET status = 'running', updated_at = ? WHERE run_id = ?", [ts, runId]);
  });
  tx();
}

/** Terminal failure for an attempt (§R-P3 point 5) — `promotion.failed` event +
 *  the request row's `state='failed'` + `failure_reason`, atomically. The
 *  orchestration row (if any) is flipped to `error` so it reads terminal. A
 *  retry (failed → pending) goes through reservePromotionOrchestration with
 *  incrementAttempt=true, only after the prior attempt is witnessed terminal. */
export function recordPromotionFailed(input: {
  requestId: string;
  runId?: string | null;
  ts: string;
  reason: string;
}): void {
  const tx = db.transaction(() => {
    if (input.runId) {
      insertOrchestrationEvent({
        runId: input.runId, ts: input.ts, kind: 'promotion.failed',
        payload: { reason: input.reason },
      });
      run(
        "UPDATE orchestrations SET status = 'error', error = ?, ended_at = ?, updated_at = ? WHERE run_id = ?",
        [input.reason, input.ts, input.ts, input.runId],
      );
    }
    run(
      "UPDATE promotion_requests SET state = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?",
      [input.reason, Date.now(), input.requestId],
    );
  });
  tx();
}
// ── WP-P3B-enrich — the ONE SQLite transaction of the enrichment saga ──────────
// ACCESSORS ONLY (A2 DDL window CLOSED). Runs SECOND, AFTER the manifest step has
// observed the deterministic responsibility event outside SQLite (SQLite and
// plan.json never share a transaction). In ONE transaction, atomically (§R-P3
// points 3/4): attach the plan's `source_proposal_id` + `responsible_supervisor_id`,
// set the supervisor's `supervisor_active_plan` + an ordinary `supervisor_focus`,
// mark the source proposal `state='promoted'` + `promoted_to_plan_id`, write
// EXACTLY ONE `plan_documents` row (the source proposal, idempotent — nothing else
// is ever mirrored; the folder is the document set, §P3-GAP), and flip
// `promotion_requests` pending → adopted. NEVER replaces the adopted `plans` row and
// NEVER writes a P2-owned column (folder_rel_path / path / format / run_state /
// artifact_id / mtime_ms / size_bytes). Idempotent across re-enrichment (a live
// retry or the pending-scan reconciler redoes the same work with no duplicate row /
// no state churn). The single `plan_documents` write is caller-id'd so a genuine PK
// collision surfaces as a clean throw that rolls the WHOLE transaction back.
export function enrichAdoptedPlanRow(input: {
  requestId: string;
  planId: string;
  workspaceId: string;
  sourceProposalId: string;
  responsibleSupervisorId: string | null;
  /** From `plan.json.source_proposal.rel_path`; containment-checked by the caller. */
  sourceProposalRelPath: string;
  /** Caller-generated id for the single source-proposal `plan_documents` row. */
  docId: string;
  /** Service-owned epoch ms for the INTEGER `updated_at`/`promoted_at` columns. */
  nowMs: number;
}): void {
  const tx = db.transaction(() => {
    // 1. Plan enrichment columns — P3-owned only. P2 columns are never named here.
    run(
      `UPDATE plans
         SET source_proposal_id = ?, responsible_supervisor_id = ?,
             promoted_at = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [input.sourceProposalId, input.responsibleSupervisorId, input.nowMs, input.planId],
    );
    if (input.responsibleSupervisorId) {
      // 2. supervisor_active_plan — at most one active plan per supervisor (PK).
      run(
        `INSERT INTO supervisor_active_plan (supervisor_id, plan_id)
         VALUES (?, ?)
         ON CONFLICT(supervisor_id) DO UPDATE SET
           plan_id = excluded.plan_id, activated_at = datetime('now')`,
        [input.responsibleSupervisorId, input.planId],
      );
      // 3. Ordinary supervisor focus (idempotent — never disturbs an existing note).
      run(
        `INSERT INTO supervisor_focus (supervisor_id, plan_id)
         VALUES (?, ?)
         ON CONFLICT(supervisor_id, plan_id) DO NOTHING`,
        [input.responsibleSupervisorId, input.planId],
      );
    }
    // 4. Source proposal → promoted, linked to the adopted plan.
    run(
      `UPDATE proposals SET state = 'promoted', promoted_to_plan_id = ?, updated_at = ?
       WHERE id = ?`,
      [input.planId, input.nowMs, input.sourceProposalId],
    );
    // 5. plan_documents — EXACTLY ONE row (source proposal), idempotent by
    //    (plan_id, doc_kind='proposal', rel_path). Nothing else is ever mirrored.
    const existingDoc = queryOne(
      `SELECT id FROM plan_documents WHERE plan_id = ? AND doc_kind = 'proposal' AND rel_path = ?`,
      [input.planId, input.sourceProposalRelPath],
    );
    if (!existingDoc) {
      run(
        `INSERT INTO plan_documents (id, plan_id, workspace_id, doc_kind, rel_path, sort_order)
         VALUES (?, ?, ?, 'proposal', ?, 0)`,
        [input.docId, input.planId, input.workspaceId, input.sourceProposalRelPath],
      );
    }
    // 6. Flip the request pending → adopted INSIDE this same transaction — the
    //    request becomes 'adopted' ONLY here, and only if every step above committed.
    run(
      `UPDATE promotion_requests SET state = 'adopted', updated_at = ? WHERE id = ?`,
      [input.nowMs, input.requestId],
    );
  });
  tx();
}
