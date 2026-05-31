// Scoped hook-evidence query: show status_change events (with hook source tags)
// for a single agent, identified by id or title-substring.
//   node scripts/hook-evidence-by-agent.mjs <agent-id-or-title-substring>
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const needle = process.argv[2];
if (!needle) {
  console.error('usage: node hook-evidence-by-agent.mjs <agent-id-or-title-substring>');
  process.exit(1);
}

const dbPath = path.join(process.env.APPDATA, 'AgentDashboard', 'dashboard.db');
const db = new DatabaseSync(dbPath, { readOnly: true });

const agents = db.prepare(
  `SELECT id, title, provider, is_supervised, created_at
   FROM agents
   WHERE id = ? OR title LIKE '%' || ? || '%'
   ORDER BY created_at DESC`
).all(needle, needle);

if (!agents.length) {
  console.log('no agent matched', JSON.stringify(needle));
  db.close();
  process.exit(0);
}

for (const a of agents) {
  console.log(`\n=== ${a.title}  [${a.provider}${a.is_supervised ? ', supervised' : ''}]  ${a.id} ===`);
  const rows = db.prepare(
    `SELECT created_at, event_type, payload
     FROM events
     WHERE agent_id = ?
       AND (payload LIKE '%hook-start%' OR payload LIKE '%hook-stop%')
     ORDER BY id ASC`
  ).all(a.id);
  if (!rows.length) {
    console.log('  (no hook-tagged status_change events)');
  } else {
    for (const r of rows) console.log('  ', r.created_at, r.payload);
  }
}

db.close();
