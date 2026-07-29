// @vitest-environment jsdom
//
// WP-8 (terminal-log retention) — the first-sweep app-chrome banner.
//
// Acceptance:
//   1. shows only while `firstSweepNotice && !acknowledgedAt`, reporting the
//      ACTUAL agents/bytes (never a plan/estimate);
//   2. a renderer that mounts AFTER the sweep completed still sees it via the
//      `getState` PULL (no push would ever arrive for it);
//   3. hidden when there is no notice, and when it is already acknowledged;
//   4. dismiss calls `acknowledgeNotice` and clears the banner;
//   5. a later `onStateChanged` push updates the banner live.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import LogRetentionNotice from './LogRetentionNotice';
import type { LogRetentionState } from '../../../shared/types';

let container: HTMLDivElement;
let root: Root;

let state: LogRetentionState;
let stateListener: ((s: LogRetentionState) => void) | null = null;
const getStateSpy = vi.fn();
const ackSpy = vi.fn();

function notice(over?: Partial<NonNullable<LogRetentionState['firstSweepNotice']>>): LogRetentionState {
  return {
    lastFullScanAt: '2026-07-27T00:00:00.000Z',
    firstSweepNotice: { completedAt: '2026-07-27T00:00:00.000Z', agents: 3, bytes: 4096, acknowledgedAt: null, ...over },
  };
}

function installApi() {
  stateListener = null;
  (window as any).api = {
    logRetention: {
      getState: vi.fn(async () => { getStateSpy(); return state; }),
      onStateChanged: (cb: (s: LogRetentionState) => void) => {
        stateListener = cb;
        return () => { stateListener = null; };
      },
      acknowledgeNotice: vi.fn(async () => {
        ackSpy();
        state = notice({ acknowledgedAt: '2026-07-27T12:00:00.000Z' });
        return state;
      }),
    },
  };
}

async function render() {
  await act(async () => {
    root = createRoot(container);
    root.render(<LogRetentionNotice />);
  });
  // Flush the getState() microtask.
  await act(async () => { await Promise.resolve(); });
}

async function click(el: Element | null | undefined) {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  state = notice();
  getStateSpy.mockClear();
  ackSpy.mockClear();
  installApi();
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container.remove();
});

describe('LogRetentionNotice', () => {
  it('shows the banner with ACTUAL agents/bytes when an unacknowledged notice exists (pull path)', async () => {
    await render();
    expect(getStateSpy).toHaveBeenCalled(); // the mount PULL — covers a post-completion mount
    const text = container.textContent ?? '';
    expect(text).toContain('Terminal history reclaimed');
    expect(text).toContain('3'); // actual agent count
    expect(text).toContain('KB'); // 4096 bytes → "4.0 KB"
  });

  it('renders nothing when there is no notice', async () => {
    state = { lastFullScanAt: '2026-07-27T00:00:00.000Z', firstSweepNotice: null };
    await render();
    expect(container.textContent).toBe('');
  });

  it('renders nothing when the notice is already acknowledged', async () => {
    state = notice({ acknowledgedAt: '2026-07-27T11:00:00.000Z' });
    await render();
    expect(container.textContent).toBe('');
  });

  it('dismiss calls acknowledgeNotice and clears the banner', async () => {
    await render();
    const dismiss = container.querySelector('button[aria-label="Dismiss"]');
    await click(dismiss);
    expect(ackSpy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('');
  });

  it('a later onStateChanged push surfaces a notice that was not present at mount', async () => {
    state = { lastFullScanAt: null, firstSweepNotice: null };
    await render();
    expect(container.textContent).toBe('');
    // The sweep completes after mount → push arrives.
    await act(async () => {
      stateListener?.(notice({ agents: 5, bytes: 2 * 1024 * 1024 }));
      await Promise.resolve();
    });
    const text = container.textContent ?? '';
    expect(text).toContain('Terminal history reclaimed');
    expect(text).toContain('5');
    expect(text).toContain('MB');
  });
});
