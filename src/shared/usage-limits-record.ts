// Pure, dependency-free builders for the dashboard statusline script.
//
// These two functions are the ONLY logic the on-disk
// `.lares/scripts/dashboard-statusline.mjs` needs beyond stdin/IO plumbing.
// They are embedded verbatim into DASHBOARD_STATUSLINE_SCRIPT_MJS via
// Function.prototype.toString() (see src/shared/constants.ts) AND imported
// directly by usage-limits-watcher.test.ts — so the tested logic and the bytes
// that actually run in the harness are the SAME source (zero drift).
//
// HARD CONSTRAINTS (because the source is stringified into a standalone .mjs):
//   - No module-scope references, no cross-function calls, no imports. Each fn
//     must be fully self-contained.
//   - No template literals / `${...}` (would collide with the outer template
//     literal in constants.ts). Use string concatenation only.
//   - Plain ES2022 that survives tsc type-stripping unchanged.

/** Build the terminal status line: `model | dir | ctx N% left | 5h X% | 7d Y%`.
 *  Windows with no data are omitted (never rendered as 0%). Context% is derived
 *  from `context_window.remaining_percentage` for parity with the user's global
 *  statusline; absent → the ctx segment is dropped. Always returns a non-empty
 *  string (model falls back to "claude") so a malformed blob still prints a line. */
export function buildUsageStatusText(blob: any): string {
  const parts: string[] = [];
  const model = (blob && blob.model && (blob.model.display_name || blob.model.id)) || 'claude';
  parts.push(String(model));
  const curDir = (blob && blob.workspace && blob.workspace.current_dir) || (blob && blob.cwd) || '';
  if (curDir) {
    const segs = String(curDir).split(/[\\/]+/).filter(Boolean);
    parts.push(segs.length ? segs[segs.length - 1] : String(curDir));
  }
  const remaining = blob && blob.context_window && blob.context_window.remaining_percentage;
  if (typeof remaining === 'number' && isFinite(remaining)) {
    parts.push('ctx ' + Math.round(remaining) + '% left');
  }
  const rl = blob && blob.rate_limits;
  if (rl && rl.five_hour && typeof rl.five_hour.used_percentage === 'number') {
    parts.push('5h ' + Math.round(rl.five_hour.used_percentage) + '%');
  }
  if (rl && rl.seven_day && typeof rl.seven_day.used_percentage === 'number') {
    parts.push('7d ' + Math.round(rl.seven_day.used_percentage) + '%');
  }
  return parts.join(' | ');
}

/** Build the persisted UsageLimitsRawRecord from a statusline blob, or null when
 *  there is nothing worth writing. Returns null if `rate_limits` is absent OR if
 *  no window carries a usable (used_percentage, resets_at) pair — the caller then
 *  prints the line and exits WITHOUT writing, so a good file is never overwritten
 *  with an empty reading. Only observed windows are included (no derived fields). */
export function buildUsageRawRecord(
  blob: any,
  agentId: string | null,
  claudeProjectDir: string | null,
  nowMs: number,
): any {
  const rl = blob && blob.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const rec: any = {
    schema: 1,
    source: 'claude_statusline',
    captured_at: nowMs,
    session_id: (blob && typeof blob.session_id === 'string' && blob.session_id) ? blob.session_id : null,
    agent_id: agentId || null,
    claude_project_dir: claudeProjectDir || null,
  };
  let any = false;
  const fh = rl.five_hour;
  if (fh && typeof fh.used_percentage === 'number' && typeof fh.resets_at === 'number') {
    rec.five_hour = { used_percentage: fh.used_percentage, resets_at: fh.resets_at };
    any = true;
  }
  const sd = rl.seven_day;
  if (sd && typeof sd.used_percentage === 'number' && typeof sd.resets_at === 'number') {
    rec.seven_day = { used_percentage: sd.used_percentage, resets_at: sd.resets_at };
    any = true;
  }
  if (!any) return null;
  return rec;
}
