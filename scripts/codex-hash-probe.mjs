import crypto from 'node:crypto';

// Recorded trusted_hash values from ~/.codex/config.toml
const RECORDED = {
  agentdashboard_stop: 'sha256:69878e3dd445973a5fec610097a9c551644dbf981cfa64100eb05bd037afd108',
  agentdashboard_ups:  'sha256:43e8ebe465aa4b850d3869560bc957a0857073de4aa0fec9d3b3eb134fdc448e',
  jobhunt_ups:         'sha256:86eb7bb8165d255748e7408d021eee8046ba2fcf2727c7589bd92f05a08b8b2f',
  jobhunt_stop:        'sha256:6b29eabae7dc03902563b6231b41c4480ef990149df70c885518940bbbac9a23',
};

// Current on-disk commands (materialized) per workspace
const CMD = {
  ad_stop:    'node "C:/Users/turke/Projects/AgentDashboard/.dashboard/scripts/dashboard-status.mjs"',
  ad_working: 'node "C:/Users/turke/Projects/AgentDashboard/.dashboard/scripts/dashboard-status.mjs" working',
  jh_stop:    'node "C:/Users/turke/Projects/JobHunt/.dashboard/scripts/dashboard-status.mjs"',
  jh_working: 'node "C:/Users/turke/Projects/JobHunt/.dashboard/scripts/dashboard-status.mjs" working',
};

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  }
  return v;
}
const sha = (s) => 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');

// Try a matrix of identity shapes to discover Codex's exact normalization.
function* candidates(eventName, command) {
  const hookFull = { type: 'command', command, timeout: 30, async: false };
  const hookNoAsync = { type: 'command', command, timeout: 30 };
  const hook600 = { type: 'command', command, timeout: 600, async: false };
  const hookNoTimeout = { type: 'command', command };
  for (const [hlabel, hook] of Object.entries({ hookFull, hookNoAsync, hook600, hookNoTimeout })) {
    for (const [elabel, ev] of Object.entries({
      snake: eventName,
      Pascal: eventName === 'stop' ? 'Stop' : 'UserPromptSubmit',
    })) {
      const ids = {
        ev_hooks: { event_name: ev, hooks: [hook] },
        hooks_ev: { hooks: [hook], event_name: ev },
        hooks_only: { hooks: [hook] },
        hook_only: hook,
      };
      for (const [ilabel, id] of Object.entries(ids)) {
        yield [`${elabel}|${hlabel}|${ilabel}`, JSON.stringify(sortKeys(id))];
      }
    }
  }
}

function findMatch(label, eventName, command, recorded) {
  for (const [shape, json] of candidates(eventName, command)) {
    if (sha(json) === recorded) {
      console.log(`MATCH  ${label}: shape=[${shape}]  json=${json}`);
      return true;
    }
  }
  console.log(`NO MATCH ${label} (command="${command}")  recorded=${recorded}`);
  return false;
}

console.log('--- AgentDashboard ---');
findMatch('AD stop', 'stop', CMD.ad_stop, RECORDED.agentdashboard_stop);
findMatch('AD user_prompt_submit', 'user_prompt_submit', CMD.ad_working, RECORDED.agentdashboard_ups);
console.log('--- JobHunt ---');
findMatch('JH stop', 'stop', CMD.jh_stop, RECORDED.jobhunt_stop);
findMatch('JH user_prompt_submit', 'user_prompt_submit', CMD.jh_working, RECORDED.jobhunt_ups);
