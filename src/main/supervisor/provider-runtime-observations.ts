import type { LaunchableAgentProvider } from '../../shared/types';

export interface ProviderRuntimeObservation {
  reason: 'auth-banner' | 'free-usage-limit';
  detail: string;
  observedAt: number;
  resetsAt?: number;
}

const observations = new Map<
  LaunchableAgentProvider,
  Map<ProviderRuntimeObservation['reason'], ProviderRuntimeObservation>
>();

export function noteProviderObservation(
  provider: LaunchableAgentProvider,
  reason: ProviderRuntimeObservation['reason'],
  detail: string,
  observedAt: number,
  resetsAt?: number,
): void {
  let providerObservations = observations.get(provider);
  if (!providerObservations) {
    providerObservations = new Map();
    observations.set(provider, providerObservations);
  }
  providerObservations.set(reason, { reason, detail, observedAt, resetsAt });
}

export function clearProviderObservation(
  provider: LaunchableAgentProvider,
  reason: ProviderRuntimeObservation['reason'],
): void {
  const providerObservations = observations.get(provider);
  if (!providerObservations) return;
  providerObservations.delete(reason);
  if (providerObservations.size === 0) observations.delete(provider);
}

export function getProviderObservations(
  now: number,
): Map<LaunchableAgentProvider, ProviderRuntimeObservation[]> {
  const result = new Map<LaunchableAgentProvider, ProviderRuntimeObservation[]>();
  for (const [provider, providerObservations] of observations) {
    for (const [reason, observation] of providerObservations) {
      if (observation.resetsAt !== undefined && observation.resetsAt <= now) {
        providerObservations.delete(reason);
        continue;
      }
      const list = result.get(provider) ?? [];
      list.push({ ...observation });
      result.set(provider, list);
    }
    if (providerObservations.size === 0) observations.delete(provider);
  }
  return result;
}

export function __resetProviderObservationsForTest(): void {
  observations.clear();
}
