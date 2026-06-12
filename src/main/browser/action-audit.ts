// WP2-A task 6 (plans/embedded-browser-implementation-tasks.md) — M16
// day-one slice: append-only JSONL audit of every action-tier browser tool
// call and EVERY denial (any tier), per
// plans/embedded-browser-safety-deepdive.md §3 M16.
//
// Deliberately NO Electron import: the line formatter + hash are the pure
// compiled-node test surface, and the writer takes its file path from the
// caller (browser-manager.ts passes app.getPath('userData') + filename).

import { appendFile } from 'fs';
import { createHash } from 'crypto';

export const AUDIT_FILE_NAME = 'browser-action-audit.jsonl';

export interface AuditEntry {
  /** ISO-8601 timestamp. */
  ts: string;
  /** Phase 2 routes carry no agent identity — absent until the API does. */
  agentId?: string;
  /** Full partition string ('persist:user' | 'persist:agent'), or '' when
   *  the call failed before a tab/partition was resolved. */
  partition: string;
  /** Target URL (navigation target, or the tab's current page for click /
   *  reads); '' when not applicable. */
  url: string;
  verb: string;
  /** sha256 hex of the canonical args JSON — args themselves may contain
   *  page-derived data and are deliberately NOT logged. */
  argsHash: string;
  /** 'ok' | 'denied:<policy-code>' | 'error:<message>'. */
  outcome: string;
}

/** Stable hash of a tool call's arguments. */
export function hashArgs(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args) ?? 'undefined').digest('hex');
}

/**
 * One audit entry → one JSONL line (no trailing newline). Key order is fixed
 * (ts, agentId?, partition, url, verb, argsHash, outcome) and the result is
 * guaranteed single-line: JSON.stringify escapes embedded newlines.
 */
export function formatAuditLine(entry: AuditEntry): string {
  const ordered: Record<string, string> = { ts: entry.ts };
  if (entry.agentId !== undefined) ordered.agentId = entry.agentId;
  ordered.partition = entry.partition;
  ordered.url = entry.url;
  ordered.verb = entry.verb;
  ordered.argsHash = entry.argsHash;
  ordered.outcome = entry.outcome;
  return JSON.stringify(ordered);
}

/**
 * Append-only JSONL writer. fs.appendFile opens with O_APPEND per call —
 * there is no truncate/rewrite path in this module, by design. Write errors
 * are logged, never thrown: auditing must not take the tool layer down (and
 * a denial has already been enforced by policy before it is logged).
 */
export class ActionAudit {
  constructor(private readonly getFilePath: () => string) {}

  record(entry: Omit<AuditEntry, 'ts'>): void {
    const line = formatAuditLine({ ts: new Date().toISOString(), ...entry });
    appendFile(this.getFilePath(), line + '\n', (err) => {
      if (err) console.error('[browser] M16 audit write failed:', err.message);
    });
  }
}
