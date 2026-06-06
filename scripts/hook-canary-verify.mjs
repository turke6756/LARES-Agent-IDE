// Canary verification: for one agent, print the hook-health columns
// (hook_status / last_hook_event_at) PLUS the hook-tagged status_change rows.
//
// Why a separate script from hook-evidence-by-agent.mjs: the SessionStart
// health ping (state:'active', source:'hook-session-start') writes NO event
// row by design — it only stamps agents.hook_status / agents.last_hook_event_at
// (supervisor.recordHookSessionStart → updateAgentHookStatus). So the only
// proof the canary cleared is the hook_status column, which the events-only
// script can't show. See HOOK_SYSTEM_DESIGN.md §8.2 / §8.3 step 1.
//
//   node scripts/hook-canary-verify.mjs <agent-id-or-title-substring>
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const needle = process.argv[2];
if (!needle) {
  console.error('usage: node hook-canary-verify.mjs <agent-id-or-title-substring>');
  process.exit(1);
}

const dbPath = path.join(process.env.APPDATA, 'AgentDashboard', 'dashboard.db');
const db = new DatabaseSync(dbPath, { readOnly: true });

const agents = db.prepare(
  `SELECT id, title, provider, is_supervised, is_worker, status,
          hook_status, last_hook_event_at, created_at
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
  const lane = [a.is_supervised ? 'supervised' : null, a.is_worker ? 'worker' : null]
    .filter(Boolean).join('+') || 'non-worker';
  const lastHook = a.last_hook_event_at
    ? `${a.last_hook_event_at} (${new Date(a.last_hook_event_at).toISOString()})`
    : '(none)';
  console.log(`\n=== ${a.title}  [${a.provider}, ${lane}]  ${a.id} ===`);
  console.log(`  status            : ${a.status}`);
  console.log(`  hook_status       : ${a.hook_status}`);
  console.log(`  last_hook_event_at: ${lastHook}`);

  const rows = db.prepare(
    `SELECT created_at, event_type, payload
     FROM events
     WHERE agent_id = ?
       AND (payload LIKE '%hook-start%' OR payload LIKE '%hook-stop%' OR payload LIKE '%hook-session-start%')
     ORDER BY id ASC`
  ).all(a.id);
  if (!rows.length) {
    console.log('  hook event rows   : (none — note: session-start health ping writes no row)');
  } else {
    console.log('  hook event rows   :');
    for (const r of rows) console.log('    ', r.created_at, r.payload);
  }
}

db.close();
