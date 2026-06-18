// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import BrowserTabStrip from './BrowserTabStrip';
import { useBrowserStore, type BrowserTabState } from '../../stores/browser-store';

// Slice 10/11 acceptance: a FROZEN tab (restored snapshot / discarded) renders
// dimmed; a DISCARDED tab additionally carries the MoonStar "suspended to save
// memory" glyph + tooltip. Rendered against the real store + jsdom (no preload —
// getBrowserApi() is null, so the strip's suspension hooks no-op safely).

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

function render() {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(BrowserTabStrip));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  useBrowserStore.setState({
    tabs: [],
    activeTabId: null,
    selectedWorkspaceId: null,
    attentionTabIds: {},
    handedTabIds: {},
    snapshot: [],
    accessRules: [],
    openGroupId: null,
    groupCollapsed: { agent: true, user: false },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('frozen / discarded tab rendering', () => {
  it('a discarded tab renders dimmed with the MoonStar suspended glyph + tooltip', () => {
    useBrowserStore.setState({
      tabs: [tab({ tabId: 't1', title: 'Suspended page', frozen: true, discarded: true })],
    });
    render();

    const pill = container.querySelector<HTMLElement>('.browser-tab')!;
    expect(pill).toBeTruthy();
    // Dimmed.
    expect(pill.className).toContain('opacity-60');
    expect(pill.getAttribute('data-discarded')).toBe('true');
    // MoonStar suspended glyph + tooltip.
    const glyph = container.querySelector<HTMLElement>('[title="Suspended to save memory"]');
    expect(glyph).toBeTruthy();
    expect(glyph!.getAttribute('aria-label')).toBe('Suspended to save memory');
    expect(container.querySelector('.lucide-moon-star')).toBeTruthy();
  });

  it('a frozen-but-not-discarded tab dims WITHOUT the suspended glyph', () => {
    useBrowserStore.setState({
      tabs: [tab({ tabId: 't1', title: 'Restored page', frozen: true })],
    });
    render();

    const pill = container.querySelector<HTMLElement>('.browser-tab')!;
    expect(pill.className).toContain('opacity-60');
    expect(pill.getAttribute('data-frozen')).toBe('true');
    expect(pill.getAttribute('data-discarded')).toBeNull();
    expect(container.querySelector('[title="Suspended to save memory"]')).toBeNull();
  });

  it('a live tab is neither dimmed nor marked', () => {
    useBrowserStore.setState({ tabs: [tab({ tabId: 't1', title: 'Live page' })] });
    render();
    const pill = container.querySelector<HTMLElement>('.browser-tab')!;
    expect(pill.className).not.toContain('opacity-60');
    expect(pill.getAttribute('data-frozen')).toBeNull();
    expect(container.querySelector('[title="Suspended to save memory"]')).toBeNull();
  });
});
