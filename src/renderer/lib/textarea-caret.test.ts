// @vitest-environment node
//
// getCaretCoordinates needs a real layout engine to produce meaningful
// geometry, and the test environment has none (node has no DOM; jsdom reports
// every offset as 0). So per the plan (Slice D/E) these tests assert ONLY the
// behaviors the module owns independent of layout:
//   - offset composition arithmetic (offset - scroll),
//   - the lineHeight → offsetHeight height fallback,
//   - the finally-block cleanup contract (no leaked mirror node, even on throw).
// Mirror-div horizontal tracking / upward-open / viewport-clipping are
// manual/visual checks in the running app.

import { describe, it, expect } from 'vitest';
import { getCaretCoordinates } from './textarea-caret';

// ---- Minimal DOM stub --------------------------------------------------------
// A hand-built element/document graph just rich enough for getCaretCoordinates.
// span offsets are injectable so we can drive the arithmetic deterministically
// without any layout engine.

interface FakeSpan {
  textContent: string;
  offsetTop: number;
  offsetLeft: number;
  offsetHeight: number;
}

function makeFakeDom(opts: {
  spanOffsetTop: number;
  spanOffsetLeft: number;
  spanOffsetHeight: number;
  scrollTop: number;
  scrollLeft: number;
  lineHeight: string;
  throwOnOffsetRead?: boolean;
}) {
  const appended: any[] = [];
  let removed = 0;

  const span: FakeSpan = {
    textContent: '',
    get offsetTop() {
      if (opts.throwOnOffsetRead) throw new Error('measurement boom');
      return opts.spanOffsetTop;
    },
    get offsetLeft() {
      return opts.spanOffsetLeft;
    },
    get offsetHeight() {
      return opts.spanOffsetHeight;
    },
  };

  const div: any = {
    style: {},
    textContent: '',
    parentNode: null as any,
    appendChild: (_child: any) => {},
  };

  const body: any = {
    appendChild: (el: any) => {
      el.parentNode = body;
      appended.push(el);
    },
    removeChild: (el: any) => {
      el.parentNode = null;
      removed += 1;
    },
  };

  // Every copied style resolves to a concrete px string; lineHeight is the one
  // the test varies.
  const computed: any = new Proxy(
    { lineHeight: opts.lineHeight },
    {
      get: (target, prop) =>
        prop in target ? (target as any)[prop] : '0px',
    },
  );

  const doc: any = {
    body,
    defaultView: { getComputedStyle: () => computed },
    createElement: (tag: string) => (tag === 'span' ? span : div),
  };

  const textarea: any = {
    value: 'hello world',
    scrollTop: opts.scrollTop,
    scrollLeft: opts.scrollLeft,
    ownerDocument: doc,
  };

  return { textarea, get appendedCount() { return appended.length; }, get removedCount() { return removed; } };
}

describe('getCaretCoordinates', () => {
  it('composes offsets as offset minus scroll', () => {
    const dom = makeFakeDom({
      spanOffsetTop: 40,
      spanOffsetLeft: 70,
      spanOffsetHeight: 16,
      scrollTop: 10,
      scrollLeft: 25,
      lineHeight: '18px',
    });

    const { top, left, height } = getCaretCoordinates(dom.textarea, 5);

    expect(top).toBe(40 - 10);
    expect(left).toBe(70 - 25);
    expect(height).toBe(18); // parsed straight from lineHeight
  });

  it('falls back to span.offsetHeight when lineHeight is non-numeric ("normal")', () => {
    const dom = makeFakeDom({
      spanOffsetTop: 0,
      spanOffsetLeft: 0,
      spanOffsetHeight: 21,
      scrollTop: 0,
      scrollLeft: 0,
      lineHeight: 'normal', // parseInt → NaN → falsy → fall back
    });

    const { height } = getCaretCoordinates(dom.textarea, 0);

    expect(height).toBe(21);
  });

  it('removes the mirror div even when measurement throws (no leaked node)', () => {
    const dom = makeFakeDom({
      spanOffsetTop: 0,
      spanOffsetLeft: 0,
      spanOffsetHeight: 0,
      scrollTop: 0,
      scrollLeft: 0,
      lineHeight: '18px',
      throwOnOffsetRead: true,
    });

    expect(() => getCaretCoordinates(dom.textarea, 3)).toThrow('measurement boom');

    // The finally block must have torn down the mirror it appended.
    expect(dom.appendedCount).toBe(1);
    expect(dom.removedCount).toBe(1);
  });
});
