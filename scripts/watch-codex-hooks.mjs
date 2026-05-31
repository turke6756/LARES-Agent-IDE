// Watch the dashboard DB for codex hook events (hook-start / hook-stop) in real
// time. Run AFTER `npm run restart`, then launch a supervised codex worker and
// send it a prompt. A `hook-start` line proves the UserPromptSubmit hook fired
// (the thing that was 0 across the whole DB before the profile fix).
//
//   node scripts/watch-codex-hooks.mjs
//
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const dbPath = path.join(process.env.APPDATA, 'AgentDashboard', 'dashboard.db');
const db = new DatabaseSync(dbPath, { readOnly: true });

// Baseline: only report events newer than the latest existing one.
let lastId = db.prepare('SELECT COALESCE(MAX(id),0) m FROM events').get().m;
console.log(`[watch] baseline event id=${lastId}. Watching for codex hook-start / hook-stop...`);
console.log('[watch] launch a supervised codex worker and send it a prompt. Ctrl-C to stop.\n');

const sql = db.prepare(
  `SELECT e.id, e.created_at, a.provider, a.title, e.payload
   FROM events e JOIN agents a ON a.id = e.agent_id
   WHERE e.id > ? AND a.provider='codex'
     AND (e.payload LIKE '%hook-start%' OR e.payload LIKE '%hook-stop%')
   ORDER BY e.id ASC`);

setInterval(() => {
  const rows = sql.all(lastId);
  for (const r of rows) {
    lastId = r.id;
    const kind = r.payload.includes('hook-start') ? 'HOOK-START ✅' : 'hook-stop';
    console.log(`[${r.created_at}] ${kind}  agent="${r.title}"  ${r.payload}`);
  }
}, 1500);
