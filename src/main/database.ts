import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { Agent, AgentProvider, AgentStatus, AgentTemplate, CreateAgentTemplateInput, CreateWorkspaceInput, CreateTeamInput, FileActivity, FileOperation, Team, TeamChannel, TeamMember, TeamMessage, TeamMessageStatus, TeamStatus, TeamTask, TeamTaskStatus, Workspace } from '../shared/types';
import { DEFAULT_COMMAND, DEFAULT_COMMAND_WSL, SUPERVISOR_AGENT_MD } from '../shared/constants';

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

  // Migration: add provider column to existing agents tables
  try { db.exec(`ALTER TABLE agents ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'`); } catch { /* column already exists */ }

  // Migration: add is_supervisor column
  try { db.exec(`ALTER TABLE agents ADD COLUMN is_supervisor INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }

  // Migration: add is_supervised column (opt-in for supervisor event bridge)
  try { db.exec(`ALTER TABLE agents ADD COLUMN is_supervised INTEGER NOT NULL DEFAULT 0`); } catch { /* column already exists */ }

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
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migration: add template_id and system_prompt to agents
  try { db.exec(`ALTER TABLE agents ADD COLUMN template_id TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE agents ADD COLUMN system_prompt TEXT`); } catch { /* exists */ }

  // Seed built-in supervisor template if not present
  const existingSup = queryAll("SELECT id FROM agent_templates WHERE id = 'builtin-supervisor'");
  if (existingSup.length === 0) {
    db.prepare(
      `INSERT INTO agent_templates (id, workspace_id, name, description, system_prompt, role_description, provider, is_supervisor, is_supervised, auto_restart)
       VALUES (?, NULL, ?, ?, ?, ?, 'claude', 1, 0, 1)`
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
    tmuxSessionName: row.tmux_session_name,
    autoRestartEnabled: !!row.auto_restart_enabled,
    resumeSessionId: row.resume_session_id,
    status: row.status as AgentStatus,
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
    `INSERT INTO workspaces (id, title, path, path_type, description, default_command)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.title, input.path, input.pathType, input.description || '', input.defaultCommand || (input.pathType === 'wsl' ? DEFAULT_COMMAND_WSL : DEFAULT_COMMAND)]
  );
  return getWorkspace(id)!;
}

export function getWorkspace(id: string): Workspace | null {
  const row = queryOne('SELECT * FROM workspaces WHERE id = ?', [id]);
  return row ? rowToWorkspace(row) : null;
}

export function getWorkspaces(): Workspace[] {
  return queryAll('SELECT * FROM workspaces ORDER BY last_opened_at DESC, created_at DESC').map(rowToWorkspace);
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
      command, provider, is_supervisor, is_supervised, tmux_session_name, auto_restart_enabled, log_path, template_id, system_prompt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, data.workspaceId, data.title, slug, data.roleDescription, data.workingDirectory,
      data.command, data.provider || 'claude', data.isSupervisor ? 1 : 0, data.isSupervised ? 1 : 0, data.tmuxSessionName, data.autoRestartEnabled ? 1 : 0, data.logPath,
      data.templateId || null, data.systemPrompt || null]
  );
  return getAgent(id)!;
}

export function getAgent(id: string): Agent | null {
  const row = queryOne('SELECT * FROM agents WHERE id = ?', [id]);
  return row ? rowToAgent(row) : null;
}

export function getAgentsByWorkspace(workspaceId: string): Agent[] {
  return queryAll('SELECT * FROM agents WHERE workspace_id = ? ORDER BY created_at DESC', [workspaceId]).map(rowToAgent);
}

export function getAllAgents(): Agent[] {
  return queryAll('SELECT * FROM agents ORDER BY created_at DESC').map(rowToAgent);
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createAgentTemplate(input: CreateAgentTemplateInput): AgentTemplate {
  const id = uuidv4();
  run(
    `INSERT INTO agent_templates (id, workspace_id, name, description, system_prompt, role_description, provider, command, auto_restart, is_supervisor, is_supervised)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.workspaceId || null, input.name, input.description || '', input.systemPrompt || null,
     input.roleDescription || '', input.provider || 'claude', input.command || null,
     input.autoRestart !== false ? 1 : 0, input.isSupervisor ? 1 : 0, input.isSupervised !== false ? 1 : 0]
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
