export type IntentArchitectureCounter =
  | 'predicted'
  | 'observed'
  | 'classified'
  | 'resolved'
  | 'promoted'
  | 'recovered';

export type IntentArchitectureTelemetrySnapshot = Readonly<Record<IntentArchitectureCounter, number>>;

const counters: Record<IntentArchitectureCounter, number> = {
  predicted: 0,
  observed: 0,
  classified: 0,
  resolved: 0,
  promoted: 0,
  recovered: 0,
};

/** Privacy-lean process counters: no paths, ids, messages, or repository data. */
export function recordIntentArchitectureEvent(
  counter: IntentArchitectureCounter,
  amount = 1,
): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) return;
  counters[counter] += amount;
}

export function readIntentArchitectureTelemetry(): IntentArchitectureTelemetrySnapshot {
  return Object.freeze({ ...counters });
}

/** Test seam only; production never resets monotonic process counters. */
export function resetIntentArchitectureTelemetryForTests(): void {
  for (const key of Object.keys(counters) as IntentArchitectureCounter[]) counters[key] = 0;
}
