// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ReadingModeView from './ReadingModeView';
import { __resetSuspendCount, __getSuspendCount } from './useBrowserSuspension';
import { useBrowserStore, type ReaderArticle } from '../../stores/browser-store';

// React 18 only flushes effects synchronously inside act() when this flag is set.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Slice-14 acceptance (reading mode — the reader overlay):
//   REQUIRED: while the reader overlay is open it must SUSPEND the live
//   WebContentsView (setVisible(false)), and resume it on close — the overlay
//   occludes the host area. We also cover: title/byline/sanitized html render;
//   the theme/font/serif toggles apply; reading-time derives from textLength;
//   and find-in-reader highlights matches in the rendered article.

let setVisibleCalls: boolean[] = [];

function article(over: Partial<ReaderArticle> = {}): ReaderArticle {
  return {
    title: 'My Article',
    byline: 'By Jane Doe',
    html: '<p>Hello reader world. The quick brown fox jumps over the lazy dog.</p>',
    textLength: 3000,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(ReadingModeView));
  });
}

function flush() {
  act(() => {
    // Let mount effects (suspension, find-highlight pass) run.
  });
}

function byLabel(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => (b.getAttribute('aria-label') ?? '') === label,
  ) as HTMLButtonElement | undefined;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  __resetSuspendCount();
  setVisibleCalls = [];
  (window as unknown as { api: unknown }).api = {
    browser: {
      setVisible: (v: boolean) => {
        setVisibleCalls.push(v);
      },
    },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  useBrowserStore.setState({ readerArticle: article(), readerLoading: false });
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  delete (window as unknown as { api?: unknown }).api;
  useBrowserStore.setState({ readerArticle: null, readerLoading: false });
});

describe('ReadingModeView (Slice 14)', () => {
  it('REQUIRED: suspends the WebContentsView while open and resumes on close', () => {
    render();
    flush();

    // The pane is suspended for the overlay's lifetime.
    expect(setVisibleCalls).toContain(false);
    expect(__getSuspendCount()).toBe(1);

    // Closing the reader (readerArticle → null) unmounts the inner overlay and
    // resumes the pane exactly once (ref-count back to 0).
    act(() => {
      useBrowserStore.setState({ readerArticle: null });
    });
    expect(__getSuspendCount()).toBe(0);
    expect(setVisibleCalls.filter((v) => v === true).length).toBe(1);
  });

  it('renders the title, byline and sanitized article html', () => {
    render();
    flush();
    expect(container.textContent).toContain('My Article');
    expect(container.textContent).toContain('By Jane Doe');
    expect(container.textContent).toContain('The quick brown fox');
    // The sanitized html is injected as real DOM (a <p>, not escaped text).
    expect(container.querySelector('.reader-content p')).toBeTruthy();
  });

  it('derives reading-time from textLength', () => {
    render();
    flush();
    // 3000 chars ÷ ~1000 chars/min → "3 min read".
    expect(container.textContent).toContain('3 min read');
  });

  it('applies the font-size and serif/sans toggles', () => {
    render();
    flush();

    const articleEl = container.querySelector('article') as HTMLElement;
    expect(articleEl.style.fontSize).toBe('19px'); // default index 2
    expect(articleEl.style.fontFamily.toLowerCase()).toContain('georgia'); // serif default

    click(byLabel('Increase font size')!);
    expect((container.querySelector('article') as HTMLElement).style.fontSize).toBe('22px');

    // Serif → Sans flips the family AND the toggle label.
    const serifToggle = byLabel('Toggle serif font')!;
    expect(serifToggle.textContent).toContain('Serif');
    click(serifToggle);
    const sansEl = container.querySelector('article') as HTMLElement;
    expect(sansEl.style.fontFamily.toLowerCase()).toContain('system-ui');
    expect(byLabel('Toggle serif font')!.textContent).toContain('Sans');
  });

  it('applies the theme toggle (light → dark)', () => {
    render();
    flush();

    const overlay = () => container.querySelector('[data-reader-theme]') as HTMLElement;
    expect(overlay().getAttribute('data-reader-theme')).toBe('light');

    click(byLabel('Dark theme')!);
    expect(overlay().getAttribute('data-reader-theme')).toBe('dark');
  });

  it('find-in-reader highlights matches in the rendered article', () => {
    render();
    flush();

    // No highlights before searching.
    expect(container.querySelectorAll('mark[data-reader-find]').length).toBe(0);

    // Open the find bar and type a query present in the article.
    click(byLabel('Find in article')!);
    const input = container.querySelector('input[aria-label="Find in article"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    // React tracks controlled-input values, so set through the native setter so
    // its onChange fires (a direct `input.value = …` is swallowed by the tracker).
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    act(() => {
      nativeSetter.call(input, 'fox');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const marks = container.querySelectorAll('mark[data-reader-find]');
    expect(marks.length).toBe(1);
    expect(marks[0].textContent).toBe('fox');
    // Match count surfaces in the find bar.
    expect(container.textContent).toContain('1 match');
  });
});
