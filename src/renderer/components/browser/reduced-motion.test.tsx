// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import BrowserTabStrip from './BrowserTabStrip';
import { useBrowserStore, type BrowserTabState } from '../../stores/browser-store';

// Slice 16 acceptance: ALL browser motion is gated behind
// `@media (prefers-reduced-motion: no-preference)` so reduced-motion users get
// no animation. Two layers of evidence:
//   1. globals.css defines every browser motion class/keyframe INSIDE the
//      no-preference media block (and nowhere at the top level).
//   2. A component honours the OS setting at runtime: BrowserTabStrip closes a
//      tab synchronously (no animation defer) when reduced-motion is requested,
//      but defers the store close to play the collapse animation otherwise.

// ── 1. CSS gating ────────────────────────────────────────────────────────────

const css = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/styles/globals.css'),
  'utf8',
);

/** Extract the body of the first `@media (prefers-reduced-motion: no-preference)`
 *  block by brace-matching from its opening brace. */
function noPreferenceBlock(source: string): string {
  // Match the at-rule WITH its opening brace so a mention inside a comment
  // (which isn't followed by `{`) doesn't get picked up.
  const marker = '@media (prefers-reduced-motion: no-preference) {';
  const head = source.indexOf(marker);
  expect(head).toBeGreaterThan(-1);
  const open = head + marker.length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('unterminated no-preference media block');
}

describe('Slice 16 — motion is gated behind prefers-reduced-motion: no-preference', () => {
  const block = noPreferenceBlock(css);

  // Every animation-bearing browser class + keyframe must live in the gated block.
  const GATED = [
    '.browser-tab-opening',
    '.browser-tab-closing',
    '.browser-overlay-anim',
    '.browser-drawer-anim',
    '.browser-popover-anim',
    '@keyframes browser-tab-open',
    '@keyframes browser-overlay-in',
    '@keyframes browser-drawer-in',
    '@keyframes browser-popover-in',
    '@keyframes browser-skeleton-sweep',
  ];

  for (const sel of GATED) {
    it(`defines ${sel} inside the no-preference block`, () => {
      expect(block).toContain(sel);
    });
  }

  it('does not define the animated popover/overlay classes at the top level', () => {
    const outside = css.replace(block, '');
    // The `animation:` shorthand for these classes must never appear ungated.
    expect(outside).not.toContain('.browser-overlay-anim {');
    expect(outside).not.toContain('.browser-drawer-anim {');
    expect(outside).not.toContain('.browser-popover-anim {');
    expect(outside).not.toContain('@keyframes browser-popover-in');
  });
});

// ── 2. Runtime honouring of the OS setting ───────────────────────────────────

function tab(over: Partial<BrowserTabState> & { tabId: string }): BrowserTabState {
  return {
    url: 'https://a.example/',
    title: 'A',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    partition: 'user',
    workspaceId: null,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

function setMatchMedia(reducedMotion: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: /prefers-reduced-motion: reduce/.test(query) ? reducedMotion : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function render() {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(BrowserTabStrip));
  });
}

describe('BrowserTabStrip close honours reduced-motion', () => {
  let closeTab: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    closeTab = vi.fn();
    useBrowserStore.setState({
      tabs: [tab({ tabId: 't1', title: 'Closable' })],
      activeTabId: 't1',
      selectedWorkspaceId: null,
      attentionTabIds: {},
      handedTabIds: {},
      snapshot: [],
      accessRules: [],
      openGroupId: null,
      groupCollapsed: { agent: true, user: false },
      closeTab,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function clickClose() {
    const btn = container.querySelector<HTMLButtonElement>('button[title="Close tab"]')!;
    expect(btn).toBeTruthy();
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('reduced-motion: closes the tab synchronously, no animation class', () => {
    setMatchMedia(true);
    render();
    clickClose();
    // Closed immediately — no deferred timer, no collapse animation class.
    expect(closeTab).toHaveBeenCalledWith('t1');
    const pill = container.querySelector<HTMLElement>('.browser-tab')!;
    expect(pill.className).not.toContain('browser-tab-closing');
  });

  it('no-preference: defers the close to play the collapse animation', () => {
    setMatchMedia(false);
    render();
    clickClose();
    // The store close is deferred until the animation finishes; the pill is
    // marked with the (gated) collapse class in the meantime.
    expect(closeTab).not.toHaveBeenCalled();
    const pill = container.querySelector<HTMLElement>('.browser-tab')!;
    expect(pill.className).toContain('browser-tab-closing');
    act(() => {
      vi.advanceTimersByTime(140);
    });
    expect(closeTab).toHaveBeenCalledWith('t1');
  });
});
