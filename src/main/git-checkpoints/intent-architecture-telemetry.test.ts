import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readIntentArchitectureTelemetry,
  recordIntentArchitectureEvent,
  resetIntentArchitectureTelemetryForTests,
} from './intent-architecture-telemetry';

test('intent architecture telemetry exposes six payload-free monotonic counters', () => {
  resetIntentArchitectureTelemetryForTests();
  recordIntentArchitectureEvent('predicted', 2);
  for (const key of ['observed', 'classified', 'resolved', 'promoted', 'recovered'] as const) {
    recordIntentArchitectureEvent(key);
  }
  assert.deepEqual(readIntentArchitectureTelemetry(), {
    predicted: 2, observed: 1, classified: 1, resolved: 1, promoted: 1, recovered: 1,
  });
});
