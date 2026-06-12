import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { throttle } from './throttle';

// WP1-B acceptance: bounds-throttle unit test. The BrowserViewHost streams
// setBounds at most ~once per frame (16ms), leading edge immediate, trailing
// edge always delivering the LAST bounds of a burst.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('throttle', () => {
  it('fires immediately on the leading edge', () => {
    const fn = vi.fn();
    const t = throttle(fn, 16);
    t(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it('collapses a burst into one trailing call with the latest args', () => {
    const fn = vi.fn();
    const t = throttle(fn, 16);
    t(1);
    t(2);
    t(3);
    t(4);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(16);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(4);
  });

  it('never exceeds one call per window during a sustained stream', () => {
    const fn = vi.fn();
    const t = throttle(fn, 16);
    // 100ms of calls every 4ms.
    for (let elapsed = 0; elapsed <= 100; elapsed += 4) {
      t(elapsed);
      vi.advanceTimersByTime(4);
    }
    vi.advanceTimersByTime(16);
    // 104ms / 16ms window → at most ceil(104/16)+1 = 8 calls; must be well
    // below the 27 raw calls, and the final value must have landed.
    expect(fn.mock.calls.length).toBeLessThanOrEqual(8);
    expect(fn).toHaveBeenLastCalledWith(100);
  });

  it('allows an immediate call again after the window has passed idle', () => {
    const fn = vi.fn();
    const t = throttle(fn, 16);
    t(1);
    vi.advanceTimersByTime(20);
    t(2);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(2);
  });

  it('cancel drops the pending trailing call', () => {
    const fn = vi.fn();
    const t = throttle(fn, 16);
    t(1);
    t(2);
    t.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });
});
