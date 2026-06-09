import { RunOrchestrationRequest } from './types';

/** Parse a legacy `node scripts/groupthink-v2.js --mode=serial --resume-lead-id=…
 *  --resume-reviewer-id=… --topic="…" --planPath="…" --turn-timeout-ms=…` command
 *  string into structured params. Reuses the same `--key=value` / `--key value`
 *  grammar as the script's parseArgs (groupthink-v2.js:58–76). Returns only the
 *  resume-relevant fields; workspaceId/supervisorId come from the live MCP call,
 *  NOT the stale string. */
export function parseLegacyGroupthinkCommand(cmd: string): Partial<RunOrchestrationRequest> {
  const tokens = tokenize(cmd);
  const args: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq === -1) {
      const key = tok.slice(2);
      const next = tokens[i + 1];
      // `--key value` form; but a bare boolean flag (e.g. --keepAgents) has no
      // following value token (or the next token is another --flag).
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = 'true';
      }
    } else {
      args[tok.slice(2, eq)] = tok.slice(eq + 1);
    }
  }

  const out: Partial<RunOrchestrationRequest> = {};
  if (args.mode === 'serial' || args.mode === 'parallel') out.mode = args.mode;
  if (args['resume-lead-id']) out.resumeLeadId = args['resume-lead-id'];
  if (args['resume-reviewer-id']) out.resumeReviewerId = args['resume-reviewer-id'];
  if (args.topic) out.topic = args.topic;
  if (args.planPath) out.planPath = args.planPath;
  if (args.leadProvider) out.leadProvider = args.leadProvider;
  if (args.reviewerProvider) out.reviewerProvider = args.reviewerProvider;
  if (args['turn-timeout-ms']) {
    const n = Number(args['turn-timeout-ms']);
    if (Number.isFinite(n) && n > 0) out.turnTimeoutMs = n;
  }
  return out;
}

/** Shell-ish tokenizer: split on unquoted whitespace, consuming single/double
 *  quotes so a quoted multi-word value (even mid-token, e.g. `--topic="A B C"`)
 *  stays one token with the quotes stripped. */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let started = false;
  let inSingle = false;
  let inDouble = false;
  for (const ch of cmd) {
    if (inSingle) {
      if (ch === "'") inSingle = false; else cur += ch;
      started = true;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false; else cur += ch;
      started = true;
      continue;
    }
    if (ch === "'") { inSingle = true; started = true; continue; }
    if (ch === '"') { inDouble = true; started = true; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started) { tokens.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) tokens.push(cur);
  return tokens;
}
