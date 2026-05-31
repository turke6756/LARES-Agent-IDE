import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const db = new DatabaseSync(path.join(process.env.APPDATA, 'AgentDashboard', 'dashboard.db'), { readOnly: true });
const q = (label, sql) => {
  console.log(`\n=== ${label} ===`);
  try { console.log(JSON.stringify(db.prepare(sql).all(), null, 2)); }
  catch (e) { console.log('ERR', e.message); }
};

// Which workspace + when did each codex agent run?
q('all codex agents (id, workspace, supervised, status, created, last_active)',
  `SELECT a.id, w.path AS workspace, a.is_supervised, a.status, a.created_at, a.last_active_at
   FROM agents a LEFT JOIN workspaces w ON w.id = a.workspace_id
   WHERE a.provider='codex' ORDER BY a.created_at DESC`);

// The one codex stop event: which agent, when
q('codex hook events with agent + workspace',
  `SELECT e.created_at, e.agent_id, w.path AS workspace, e.payload
   FROM events e JOIN agents a ON a.id=e.agent_id LEFT JOIN workspaces w ON w.id=a.workspace_id
   WHERE a.provider='codex' AND (e.payload LIKE '%hook-start%' OR e.payload LIKE '%hook-stop%')
   ORDER BY e.id DESC`);

// Full event trail for codex supervised agents (to see status sources used)
q('all status_change events for codex agents (latest 40)',
  `SELECT e.created_at, e.agent_id, e.event_type, substr(e.payload,1,90) payload
   FROM events e JOIN agents a ON a.id=e.agent_id
   WHERE a.provider='codex' AND e.event_type='status_change'
   ORDER BY e.id DESC LIMIT 40`);

db.close();
