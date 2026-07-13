// Per-agent memory budgets + whole-app owned-process cap (incident-2026-07-11
// §5 full-D5, Wave 4).
//
// These feed the SAME admission layer as the D5-lite global rules
// (canLaunchAgent / canOpenAgentTab) and return the SAME AdmissionDecision shape
// with codes in the same family:
//   • `memory-budget`   — the per-agent CLI-tree budget refusal (new, Wave 4).
//   • `memory-capacity` — the whole-app owned-process-count cap (rev-3 rename
//                          from the Electron-only D5-lite cap; a whole-app count
//                          needs D4 attribution, so it lives here in full-D5).
//
// Pure functions over an attribution snapshot — no telemetry, no electron, no
// native. Fail-OPEN by design: unknown/unmeasured usage never refuses (the
// D5-lite static caps and commit rules remain the fail-closed backstop).

import type { AdmissionDecision } from './types';
import type { AgentMemoryUsage, AppOwnedTotals } from './attribution';

/** Generous default per-agent CLI-tree budget. A healthy `claude` worker tree
 *  runs a few hundred MB; 6 GiB is far above normal and trips only a runaway. */
export const DEFAULT_AGENT_BUDGET_BYTES = 6 * 1024 * 1024 * 1024;

/** Whole-app owned process-count cap: Electron processes + owned CLI trees. Set
 *  above the D5-lite Electron-only static cap (350) since it also counts CLI
 *  trees, but well under the ~360-electron + 65-claude census that preceded the
 *  outage. */
export const DEFAULT_MAX_OWNED_PROCESSES = 420;

export interface BudgetConfig {
  perAgentBudgetBytes: number;
  maxOwnedProcesses: number;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  perAgentBudgetBytes: DEFAULT_AGENT_BUDGET_BYTES,
  maxOwnedProcesses: DEFAULT_MAX_OWNED_PROCESSES,
};

const ALLOWED: AdmissionDecision = { allowed: true };

/**
 * Per-agent budget gate. Refuses when the agent's MEASURED CLI-tree working set
 * is at/over its budget. Fail-open: a null usage (agent unknown to attribution)
 * or an unmeasured tree (`source: 'none'`, e.g. WSL or nothing resolved) never
 * refuses — we only say "no" on a positively-measured overage.
 */
export function checkAgentBudget(
  usage: AgentMemoryUsage | null | undefined,
  cfg: BudgetConfig = DEFAULT_BUDGET_CONFIG,
): AdmissionDecision {
  if (!usage || usage.source === 'none' || usage.pidCount === 0) return ALLOWED;
  if (usage.cliTreeBytes < cfg.perAgentBudgetBytes) return ALLOWED;
  return {
    allowed: false,
    code: 'memory-budget',
    reason:
      `Agent ${usage.agentId} is using ${fmtGiB(usage.cliTreeBytes)} across ` +
      `${usage.pidCount} process(es), at/above its ${fmtGiB(cfg.perAgentBudgetBytes)} ` +
      `budget; refusing new tabs/work for it until it frees memory.`,
  };
}

/**
 * Whole-app owned-process cap. Refuses when Electron + owned-CLI process count
 * is at/over the cap. Fail-open on a null snapshot (attribution unavailable this
 * tick — the D5-lite fail-closed Electron cap still applies in the sampler).
 */
export function checkOwnedProcessCap(
  totals: AppOwnedTotals | null | undefined,
  cfg: BudgetConfig = DEFAULT_BUDGET_CONFIG,
): AdmissionDecision {
  if (!totals) return ALLOWED;
  if (totals.totalOwnedProcessCount < cfg.maxOwnedProcesses) return ALLOWED;
  return {
    allowed: false,
    code: 'memory-capacity',
    reason:
      `App-owned process count ${totals.totalOwnedProcessCount} ` +
      `(Electron ${totals.electronProcessCount} + CLI ${totals.ownedCliProcessCount}) ` +
      `is at/above the cap ${cfg.maxOwnedProcesses}; refusing new agents/tabs.`,
  };
}

function fmtGiB(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
