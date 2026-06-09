#!/usr/bin/env node

/**
 * GroupThink v2 — COMPATIBILITY SHIM (Phase 3 of
 * plans/orchestration-as-mcp-tool.md §6).
 *
 * The GroupThink relay loop now runs IN-PROCESS inside the dashboard
 * (src/main/orchestration/groupthink-v2.ts), driven by the OrchestrationService
 * and reachable via the `run_orchestration` MCP tool. This script no longer
 * contains the orchestration logic — it exists only so that legacy
 * `node scripts/groupthink-v2.js --mode=… --workspaceId=… --supervisorId=…
 * --resume-lead-id=… --resume-reviewer-id=… …` resume_hint lines (already
 * embedded in plan files and `.runs/*`) keep working.
 *
 * It parses the same argv grammar, then POSTs the original command line to
 * `POST /api/orchestrations` as a `legacyCommand`; the dashboard parses it back
 * into structured resume params (groupthink-legacy.ts) and runs the in-process
 * runner. The supervisor receives the same `[DASHBOARD EVENT]` relays as before.
 *
 * New work should call the `run_orchestration` MCP tool directly — not this.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');

const DEFAULT_PORTS = [24678, 24679, 24680, 24681];

// --- argv parsing (same grammar as the old parseArgs: --k=v / --k v / bare) ---
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[arg.slice(2)] = next; i++; }
      else { args[arg.slice(2)] = 'true'; }
    }
  }
  return args;
}

/** Build the `POST /api/orchestrations` body from a legacy argv. workspaceId /
 *  supervisorId travel as top-level params (the route requires them and the
 *  server drops them from the legacyCommand parse); the full original command
 *  line travels as `legacyCommand` for groupthink-legacy.ts to re-parse. */
function buildRequest(argv) {
  const args = parseArgs(argv);
  const legacyCommand = 'node scripts/groupthink-v2.js ' + argv.join(' ');
  const params = {
    workspaceId: args.workspaceId,
    supervisorId: args.supervisorId,
    legacyCommand,
  };
  if (args.keepAgents && args.keepAgents !== 'false') params.keepAgents = true;
  return { name: 'groupthink', params };
}

// --- host / port resolution (ported from the old script) ---
function isWsl() {
  return Boolean(process.env.WSL_DISTRO_NAME) || os.release().toLowerCase().includes('microsoft');
}
function readWslHost() {
  if (!isWsl()) return null;
  try {
    const resolv = fs.readFileSync('/etc/resolv.conf', 'utf8');
    const match = resolv.match(/^nameserver\s+(\S+)/m);
    return match ? match[1] : null;
  } catch { return null; }
}
function resolveHost(args) {
  return args['api-host'] || process.env.AGENT_DASHBOARD_API_HOST || readWslHost() || '127.0.0.1';
}
function candidatePorts(args) {
  const ports = [];
  if (args['api-port']) ports.push(Number(args['api-port']));
  for (const port of DEFAULT_PORTS) ports.push(port);
  return ports.filter((p, i, all) => Number.isInteger(p) && p > 0 && all.indexOf(p) === i);
}

function postJson(host, port, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: host, port, path: apiPath, method: 'POST', timeout: 60000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => text += c);
      res.on('end', () => {
        let json = null;
        if (text) { try { json = JSON.parse(text); } catch { json = null; } }
        resolve({ status: res.statusCode || 0, text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Request timed out: POST ${apiPath}`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const request = buildRequest(argv);

  if (!request.params.workspaceId || !request.params.supervisorId) {
    console.error('Usage (legacy shim): groupthink-v2.js --workspaceId=<id> --supervisorId=<id> ' +
                  '[--mode=serial|parallel] [--resume-lead-id=<id>] [--resume-reviewer-id=<id>] ' +
                  '[--topic=<t>] [--planPath=<p>] [--turn-timeout-ms=<ms>] [--api-host=<h>] [--api-port=<port>]');
    console.error('\nThis script is now a compatibility shim. Prefer the run_orchestration MCP tool.');
    process.exit(1);
  }

  const host = resolveHost(args);
  const ports = candidatePorts(args);
  let lastError = null;
  for (const port of ports) {
    try {
      const res = await postJson(host, port, '/api/orchestrations', request);
      if (res.status >= 200 && res.status < 300) {
        const runId = res.json && res.json.runId;
        console.log(`[groupthink-shim] Forwarded to in-process runner at http://${host}:${port}. runId=${runId}`);
        console.log('[groupthink-shim] Watch for [DASHBOARD EVENT] groupthink.complete / orchestration.groupthink.stalled.');
        process.exit(0);
      }
      lastError = new Error(`HTTP ${res.status}: ${res.text}`);
    } catch (err) {
      lastError = err;
    }
  }
  console.error(`[groupthink-shim] Could not reach the dashboard API on ${host}:${ports.join(',')}: ` +
                `${lastError ? lastError.message : 'unknown error'}`);
  process.exit(1);
}

// Only auto-run when invoked directly; required as a module for unit tests.
if (require.main === module) {
  main().catch(err => { console.error(err.stack || err); process.exit(1); });
}

module.exports = { parseArgs, buildRequest, resolveHost, candidatePorts };
