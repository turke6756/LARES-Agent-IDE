// WP2-A task 6 (plans/embedded-browser-implementation-tasks.md) — M16
// day-one slice: append-only JSONL audit of every action-tier browser tool
// call and EVERY denial (any tier), per
// plans/embedded-browser-safety-deepdive.md §3 M16.
//
// Deliberately NO Electron import: the line formatter + hash are the pure
// compiled-node test surface, and the writer takes its file path from the
// caller (browser-manager.ts passes app.getPath('userData') + filename).

import { appendFile, readFileSync } from 'fs';
import { createHash } from 'crypto';
// Type-only import — erased at compile time, so this adds NO runtime dependency
// (action-audit stays the pure compiled-node test surface; it never loads the DB).
import type { CredentialedOpenDiagnostic } from './access-policy-store';

export const AUDIT_FILE_NAME = 'browser-action-audit.jsonl';

export interface AuditEntry {
  /** ISO-8601 timestamp. */
  ts: string;
  /** Slice-2 agent identity, stamped by the trusted API layer (never the
   *  agent's own tool args). Absent for human-opened tabs / pre-Slice-2 rows. */
  agentId?: string;
  agentTitle?: string;
  /** Slice-3: the workspace this action belonged to (per-workspace isolation),
   *  when resolvable from the tab/opts. Absent for unscoped/legacy rows. */
  workspaceId?: string;
  /** Slice-3: the tab the action targeted, when one exists. Absent for opens
   *  that failed before a tab was created. */
  tabId?: string;
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
  /** 'ok' | 'denied:<policy-code>' | 'error:<message>' | 'diag:<grantState>'. */
  outcome: string;
  /** Phase 0 (BrowserSigninSharing plan §D): trusted signed-in diagnostics for a
   *  credentialed open / startup consistency flag — ruleId, rule + caller
   *  workspace, computed session partitions, and the classified grant state +
   *  reason. Emitted ONLY on the diagnostic verbs (additive; every legacy row
   *  omits it). Contains NO cookie names or values by construction. */
  signin?: CredentialedOpenDiagnostic;
}

/** Stable hash of a tool call's arguments. */
export function hashArgs(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args) ?? 'undefined').digest('hex');
}

/**
 * One audit entry → one JSONL line (no trailing newline). Key order is fixed
 * (ts, agentId?, agentTitle?, workspaceId?, tabId?, partition, url, verb,
 * argsHash, outcome) and the result is guaranteed single-line: JSON.stringify
 * escapes embedded newlines. The Slice-3 identity/scope fields are additive and
 * only emitted when present, so legacy lines keep the original key set.
 */
export function formatAuditLine(entry: AuditEntry): string {
  const ordered: Record<string, unknown> = { ts: entry.ts };
  if (entry.agentId !== undefined) ordered.agentId = entry.agentId;
  if (entry.agentTitle !== undefined) ordered.agentTitle = entry.agentTitle;
  if (entry.workspaceId !== undefined) ordered.workspaceId = entry.workspaceId;
  if (entry.tabId !== undefined) ordered.tabId = entry.tabId;
  ordered.partition = entry.partition;
  ordered.url = entry.url;
  ordered.verb = entry.verb;
  ordered.argsHash = entry.argsHash;
  ordered.outcome = entry.outcome;
  // Phase 0: additive diagnostic object, appended AFTER outcome so the legacy key
  // order is untouched. JSON.stringify keeps the line single-line (escapes any
  // embedded newlines) and the object carries no cookie material.
  if (entry.signin !== undefined) ordered.signin = entry.signin;
  return JSON.stringify(ordered);
}

/**
 * Append-only JSONL writer. fs.appendFile opens with O_APPEND per call —
 * there is no truncate/rewrite path in this module, by design. Write errors
 * are logged, never thrown: auditing must not take the tool layer down (and
 * a denial has already been enforced by policy before it is logged).
 */
export class ActionAudit {
  /**
   * @param getFilePath  resolves the JSONL path (caller passes
   *   app.getPath('userData') + AUDIT_FILE_NAME).
   * @param onRecord  Slice-3 in-process tap: every recorded entry (with its
   *   stamped `ts`) is also handed here so the manager can forward it to the
   *   renderer on the auditEvent push channel. Optional so the pure-node tests
   *   construct the writer without any Electron/forwarding glue. A throwing
   *   listener is swallowed — auditing must never take the tool layer down.
   */
  constructor(
    private readonly getFilePath: () => string,
    private readonly onRecord?: (entry: AuditEntry) => void,
  ) {}

  record(entry: Omit<AuditEntry, 'ts'>): void {
    const full: AuditEntry = { ts: new Date().toISOString(), ...entry };
    const line = formatAuditLine(full);
    appendFile(this.getFilePath(), line + '\n', (err) => {
      if (err) console.error('[browser] M16 audit write failed:', err.message);
    });
    if (this.onRecord) {
      try {
        this.onRecord(full);
      } catch (err) {
        console.error(
          '[browser] M16 audit listener threw:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /**
   * Slice-3: tail-parse the JSONL and return the last `limit` entries
   * (oldest→newest within that tail). Used to prime the renderer Activity
   * drawer on mount. Best-effort: a missing/unreadable file yields []; any
   * malformed line is skipped, never thrown — the drawer must render even if a
   * partial write or external edit corrupted a line.
   */
  getRecent(limit = 200): AuditEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.getFilePath(), 'utf8');
    } catch {
      return []; // file absent / unreadable
    }
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    const tail = limit > 0 ? lines.slice(-limit) : lines;
    const out: AuditEntry[] = [];
    for (const line of tail) {
      try {
        const parsed = JSON.parse(line) as AuditEntry;
        if (parsed && typeof parsed.ts === 'string' && typeof parsed.outcome === 'string') {
          out.push(parsed);
        }
      } catch {
        // skip malformed line
      }
    }
    return out;
  }
}
