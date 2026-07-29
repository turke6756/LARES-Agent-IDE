// @vitest-environment jsdom
//
// WP-H1 — the review detail panel (presentational).
//
// Acceptance:
//   1. renders one row per pending item with a human label + the raw entry id;
//   2. surfaces a condition-review's exit condition ("Re-check: …");
//   3. shows the persisted hard-invalid + runtime-error callouts from WP-C;
//   4. an unknown finding kind falls back to the raw kind string (never blank);
//   5. an empty queue reads "No entries pending review".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MemoryReviewPanel from './MemoryReviewPanel';
import type { MemoryReviewSummaryDto } from '../../../shared/types';

let container: HTMLDivElement;
let root: Root;

function summary(over: Partial<MemoryReviewSummaryDto> = {}): MemoryReviewSummaryDto {
  return {
    pendingCount: 0,
    capPressure: false,
    capPercent: null,
    hardInvalid: false,
    lastRuntimeError: null,
    lastRuntimeErrorAt: null,
    items: [],
    ...over,
  };
}

async function render(s: MemoryReviewSummaryDto) {
  await act(async () => {
    root = createRoot(container);
    root.render(<MemoryReviewPanel summary={s} />);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container.remove();
});

describe('MemoryReviewPanel', () => {
  it('renders one labeled row per pending item with the entry id', async () => {
    await render(summary({
      pendingCount: 2,
      items: [
        { findingId: 'f1', kind: 'stale-active', entryId: 'mb-2026-06-01-a', reason: 'untouched 30d', exitCondition: null, firstSeen: 't', lastSeen: 't' },
        { findingId: 'f2', kind: 'never-recalled', entryId: 'mb-2026-05-01-b', reason: 'never recalled', exitCondition: null, firstSeen: 't', lastSeen: 't' },
      ],
    }));
    const rows = container.querySelectorAll('[data-testid="memory-review-item"]');
    expect(rows.length).toBe(2);
    const text = container.textContent ?? '';
    expect(text).toContain('Stale active entry');
    expect(text).toContain('mb-2026-06-01-a');
    expect(text).toContain('Never recalled');
    expect(text).toContain('mb-2026-05-01-b');
  });

  it('surfaces a condition-review exit condition', async () => {
    await render(summary({
      pendingCount: 1,
      items: [{ findingId: 'f', kind: 'condition-review', entryId: 'mb-2026-07-01-c', reason: null, exitCondition: 'pi-integration lands', firstSeen: 't', lastSeen: 't' }],
    }));
    const text = container.textContent ?? '';
    expect(text).toContain('Condition to re-check');
    expect(text).toContain('pi-integration lands');
  });

  it('shows the persisted hard-invalid and runtime-error callouts', async () => {
    await render(summary({
      hardInvalid: true,
      lastRuntimeError: 'ENOENT MEMORY.md',
      lastRuntimeErrorAt: '2026-07-28T00:00:00Z',
    }));
    const alerts = container.querySelectorAll('[role="alert"]');
    expect(alerts.length).toBe(2);
    const text = container.textContent ?? '';
    expect(text).toContain('failed validation');
    expect(text).toContain('ENOENT MEMORY.md');
    expect(text).toContain('2026-07-28T00:00:00Z');
  });

  it('falls back to the raw kind for an unknown class', async () => {
    await render(summary({
      pendingCount: 1,
      items: [{ findingId: 'f', kind: 'some-future-kind', entryId: null, reason: 'x', exitCondition: null, firstSeen: 't', lastSeen: 't' }],
    }));
    expect(container.textContent ?? '').toContain('some-future-kind');
  });

  it('reads "No entries pending review" on an empty queue', async () => {
    await render(summary());
    expect(container.textContent ?? '').toContain('No entries pending review');
  });
});
