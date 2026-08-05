import {
  LAUNCHABLE_AGENT_PROVIDERS,
  PROVIDER_AVAILABILITY_REASON_ORDER,
  type LaunchableAgentProvider,
  type ProviderAvailability,
  type ProviderAvailabilityEvidence,
  type ProviderAvailabilityReason,
  type ProviderAvailabilityStatus,
  type ProviderQuotaNote,
  type RuntimePrerequisiteReport,
  type UsageLimitsReading,
  type UsageWindowReading,
} from '../shared/types';
import { detectRuntimePrerequisites } from './runtime-prerequisites';
import {
  getProviderObservations,
  type ProviderRuntimeObservation,
} from './supervisor/provider-runtime-observations';

const REASON_INDEX = new Map(
  PROVIDER_AVAILABILITY_REASON_ORDER.map((reason, index) => [reason, index]),
);

type ClaudeWindow = { label: '5-hour' | '7-day'; reading: UsageWindowReading };

function formatClaudeQuotaNote(window: ClaudeWindow, stale?: boolean): ProviderQuotaNote {
  return {
    source: 'claude_statusline',
    note: `${window.label} ${Math.round(window.reading.used_percentage)}% used`,
    observedAt: window.reading.captured_at,
    ...(stale ? { stale: true } : {}),
    resetsAt: window.reading.resets_at_ms,
  };
}

function selectHighestWindow(windows: ClaudeWindow[]): ClaudeWindow | undefined {
  return windows.reduce<ClaudeWindow | undefined>((selected, candidate) => {
    if (!selected || candidate.reading.used_percentage > selected.reading.used_percentage) {
      return candidate;
    }
    if (
      candidate.reading.used_percentage === selected.reading.used_percentage
      && candidate.label === '7-day'
    ) {
      return candidate;
    }
    return selected;
  }, undefined);
}

function statusForReasons(reasons: ProviderAvailabilityReason[]): ProviderAvailabilityStatus {
  if (reasons.some(reason => reason !== 'quota-near-limit')) return 'unavailable';
  return reasons.includes('quota-near-limit') ? 'degraded' : 'available';
}

/** Pure projection: no I/O and no clock reads. */
export function resolveProviderAvailability(input: {
  prerequisiteReport: RuntimePrerequisiteReport;
  usageLimits: UsageLimitsReading;
  observations: Map<LaunchableAgentProvider, ProviderRuntimeObservation[]>;
  now: number;
}): ProviderAvailability[] {
  return LAUNCHABLE_AGENT_PROVIDERS.map((provider): ProviderAvailability => {
    const prerequisite = input.prerequisiteReport.providers.find(row => row.id === provider);
    const installed = prerequisite?.status === 'available';
    if (!installed) {
      return {
        provider,
        status: 'unavailable',
        installed: false,
        reasons: ['not-detected'],
        evidence: [{
          reason: 'not-detected',
          detail: prerequisite?.detail ?? `${provider} launch binary was not detected`,
          observedAt: input.prerequisiteReport.checkedAt,
          source: 'static',
        }],
      };
    }

    const evidence: ProviderAvailabilityEvidence[] = [];
    let quota: ProviderQuotaNote | undefined;
    for (const observation of input.observations.get(provider) ?? []) {
      if (observation.resetsAt !== undefined && observation.resetsAt <= input.now) continue;
      evidence.push({
        reason: observation.reason,
        detail: observation.detail,
        observedAt: observation.observedAt,
        source: 'runtime_observation',
      });
      if (observation.reason === 'free-usage-limit') {
        quota = {
          source: 'runtime_observation',
          note: observation.detail,
          observedAt: observation.observedAt,
          ...(observation.resetsAt === undefined ? {} : { resetsAt: observation.resetsAt }),
        };
      }
    }

    if (provider === 'claude') {
      const windows: ClaudeWindow[] = [];
      if (input.usageLimits.five_hour) windows.push({ label: '5-hour', reading: input.usageLimits.five_hour });
      if (input.usageLimits.seven_day) windows.push({ label: '7-day', reading: input.usageLimits.seven_day });
      const fresh = windows.filter(window => window.reading.stale === false);
      const selectedFresh = selectHighestWindow(fresh);
      if (selectedFresh) {
        quota = formatClaudeQuotaNote(selectedFresh);
        const percentage = selectedFresh.reading.used_percentage;
        if (percentage >= 100) {
          evidence.push({
            reason: 'quota-exhausted',
            detail: quota.note,
            observedAt: selectedFresh.reading.captured_at,
            source: 'claude_statusline',
          });
        } else if (percentage >= 95) {
          evidence.push({
            reason: 'quota-near-limit',
            detail: quota.note,
            observedAt: selectedFresh.reading.captured_at,
            source: 'claude_statusline',
          });
        }
      } else {
        const selectedStale = selectHighestWindow(windows);
        if (selectedStale) quota = formatClaudeQuotaNote(selectedStale, true);
      }
    }

    evidence.sort((a, b) => REASON_INDEX.get(a.reason)! - REASON_INDEX.get(b.reason)!);
    const reasons = evidence.map(item => item.reason);
    return {
      provider,
      status: statusForReasons(reasons),
      installed: true,
      reasons,
      evidence,
      ...(quota ? { quota } : {}),
    };
  });
}

/** Process-global acquisition seam; prerequisite detection supplies its own TTL cache. */
export async function getAvailableProviders(
  deps: { getUsageLimits(): UsageLimitsReading },
): Promise<ProviderAvailability[]> {
  const now = Date.now();
  const prerequisiteReport = await detectRuntimePrerequisites();
  return resolveProviderAvailability({
    prerequisiteReport,
    usageLimits: deps.getUsageLimits(),
    observations: getProviderObservations(now),
    now,
  });
}
