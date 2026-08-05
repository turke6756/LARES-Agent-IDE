import { describe, expect, it, vi } from 'vitest';
import {
  WHEEL_DELTA_LINE,
  WHEEL_DELTA_PAGE,
  WHEEL_DELTA_PIXEL,
  applyHorizontalWheelScroll,
  getHorizontalWheelDelta,
} from './horizontal-wheel';

describe('horizontal-wheel', () => {
  it('uses pixel deltaX directly', () => {
    expect(
      getHorizontalWheelDelta(
        { deltaX: 24, deltaY: 0, deltaMode: WHEEL_DELTA_PIXEL, shiftKey: false },
        300,
      ),
    ).toBe(24);
  });

  it('maps Shift+vertical wheel in both default and opt-out modes', () => {
    const event = { deltaX: 0, deltaY: 3, deltaMode: WHEEL_DELTA_LINE, shiftKey: true };

    expect(getHorizontalWheelDelta(event, 300)).toBe(48);
    expect(
      getHorizontalWheelDelta(event, 300, undefined, { translateVerticalWheel: false }),
    ).toBe(48);
  });

  it('scales page deltas by the viewport width', () => {
    expect(
      getHorizontalWheelDelta(
        { deltaX: 1, deltaY: 0, deltaMode: WHEEL_DELTA_PAGE, shiftKey: false },
        320,
      ),
    ).toBe(320);
  });

  it('scrolls and prevents default when horizontal movement is available', () => {
    const preventDefault = vi.fn();
    const el = { clientWidth: 100, scrollWidth: 300, scrollLeft: 25 };

    const handled = applyHorizontalWheelScroll(el, {
      deltaX: 50,
      deltaY: 0,
      deltaMode: WHEEL_DELTA_PIXEL,
      shiftKey: false,
      preventDefault,
    });

    expect(handled).toBe(true);
    expect(el.scrollLeft).toBe(75);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('translates plain vertical wheel movement by default', () => {
    const preventDefault = vi.fn();
    const el = { clientWidth: 100, scrollWidth: 300, scrollLeft: 25 };

    const handled = applyHorizontalWheelScroll(el, {
      deltaX: 0,
      deltaY: 50,
      deltaMode: WHEEL_DELTA_PIXEL,
      shiftKey: false,
      preventDefault,
    });

    expect(handled).toBe(true);
    expect(el.scrollLeft).toBe(75);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('can opt out of plain vertical wheel translation', () => {
    const preventDefault = vi.fn();
    const el = { clientWidth: 100, scrollWidth: 300, scrollLeft: 25 };

    const handled = applyHorizontalWheelScroll(el, {
      deltaX: 0,
      deltaY: 50,
      deltaMode: WHEEL_DELTA_PIXEL,
      shiftKey: false,
      preventDefault,
    }, { translateVerticalWheel: false });

    expect(handled).toBe(false);
    expect(el.scrollLeft).toBe(25);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('does not prevent default when the strip cannot scroll further', () => {
    const preventDefault = vi.fn();
    const el = { clientWidth: 100, scrollWidth: 300, scrollLeft: 200 };

    const handled = applyHorizontalWheelScroll(el, {
      deltaX: 50,
      deltaY: 0,
      deltaMode: WHEEL_DELTA_PIXEL,
      shiftKey: false,
      preventDefault,
    });

    expect(handled).toBe(false);
    expect(el.scrollLeft).toBe(200);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
