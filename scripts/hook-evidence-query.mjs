import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const dbPath = path.join(process.env.APPDATA, 'AgentDashboard', 'dashboard.db');
const db = new DatabaseSync(dbPath, { readOnly: true });

const q = (label, sql, params = []) => {
  console.log(`\n=== ${label} ===`);
  try {
    const rows = db.prepare(sql).all(...params);
    console.log(JSON.stringify(rows, null, 2));
  } catch (e) {
    console.log('ERR', e.message);
  }
};

q('event_types containing "hook" (type or payload)',
  `SELECT event_type, COUNT(*) n FROM events
   WHERE event_type LIKE '%hook%' OR payload LIKE '%hook%'
   GROUP BY event_type ORDER BY n DESC`);

q('hook source tags by provider (payload LIKE hook-start / hook-stop)',
  `SELECT a.provider,
          SUM(CASE WHEN e.payload LIKE '%hook-start%' THEN 1 ELSE 0 END) AS hook_start,
          SUM(CASE WHEN e.payload LIKE '%hook-stop%'  THEN 1 ELSE 0 END) AS hook_stop
   FROM events e JOIN agents a ON a.id = e.agent_id
   GROUP BY a.provider`);

q('sample events mentioning hook-start/hook-stop (latest 25)',
  `SELECT e.created_at, a.provider, e.event_type, substr(e.payload,1,120) payload
   FROM events e JOIN agents a ON a.id = e.agent_id
   WHERE e.payload LIKE '%hook-start%' OR e.payload LIKE '%hook-stop%'
   ORDER BY e.id DESC LIMIT 25`);

q('agent census by provider + supervised',
  `SELECT provider, is_supervised, COUNT(*) n FROM agents GROUP BY provider, is_supervised`);

db.close();
