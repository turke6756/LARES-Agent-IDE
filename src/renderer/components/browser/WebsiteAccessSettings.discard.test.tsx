// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WebsiteAccessSettings from './WebsiteAccessSettings';
import { useBrowserStore } from '../../stores/browser-store';

// Slice 11 acceptance: the idle-discard threshold control (15 / 30 / 60 min /
// Never) flips setDiscardThreshold with the right ms / null and reflects the
// current selection. Rendered against the real store + a stubbed api so the
// store action's getBrowserApi()?.setDiscardThreshold(...) call is observable.

let container: HTMLDivElement;
let root: Root;
const setDiscardThreshold = vi.fn();

function installApi() {
  (window as unknown as { api?: unknown }).api = {
    browser: {
      // useBrowserSuspension reads setVisible/setActiveTab; keep them as no-ops.
      setVisible: vi.fn(),
      setActiveTab: vi.fn(),
      setDiscardThreshold,
    },
  };
}

function render() {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(WebsiteAccessSettings));
  });
}

// Phase 3 (§D line 262): the idle-discard control now lives behind the
// collapsed-by-default "Advanced & Activity" disclosure — expand it before
// querying the radiogroup.
function expandAdvanced() {
  // Match the title via getAttribute (not a CSS attribute selector — jsdom's
  // selector engine mishandles the literal "&" in the title string).
  const btn = [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('title') === 'Expand Advanced & Activity',
  );
  if (!btn) throw new Error('Advanced & Activity disclosure toggle not found');
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

// Scope to the idle-discard radiogroup specifically — the settings pane now also
// renders the WI-8 "Sign-in hold timeout" radiogroup, so a pane-wide role="radio"
// query would mix the two controls' options together.
function discardRadios(): HTMLButtonElement[] {
  const group = container.querySelector(
    '[role="radiogroup"][aria-label="Suspend idle tabs after"]',
  );
  if (!group) throw new Error('idle-discard radiogroup not found');
  return Array.from(group.querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
}

function clickOption(label: string) {
  const btn = discardRadios().find((b) => (b.textContent ?? '').trim() === label);
  if (!btn) throw new Error(`discard option not found: ${label}`);
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  setDiscardThreshold.mockClear();
  installApi();
  container = document.createElement('div');
  document.body.appendChild(container);
  useBrowserStore.setState({
    accessViewOpen: true,
    accessRules: [],
    accessRequests: [],
    discardThresholdMs: 30 * 60 * 1000,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('idle-discard threshold control', () => {
  it('renders the four options with the current selection checked', () => {
    render();
    expandAdvanced();
    const radios = discardRadios();
    expect(radios.map((r) => r.textContent?.trim())).toEqual(['15 min', '30 min', '60 min', 'Never']);
    const checked = radios.find((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked?.textContent?.trim()).toBe('30 min'); // default mirror
  });

  it('selecting 15 min forwards 900000 ms and updates the selection', () => {
    render();
    expandAdvanced();
    clickOption('15 min');
    expect(setDiscardThreshold).toHaveBeenLastCalledWith(900_000);
    expect(useBrowserStore.getState().discardThresholdMs).toBe(900_000);
  });

  it('selecting 60 min forwards 3600000 ms', () => {
    render();
    expandAdvanced();
    clickOption('60 min');
    expect(setDiscardThreshold).toHaveBeenLastCalledWith(3_600_000);
  });

  it('selecting Never forwards null', () => {
    render();
    expandAdvanced();
    clickOption('Never');
    expect(setDiscardThreshold).toHaveBeenLastCalledWith(null);
    expect(useBrowserStore.getState().discardThresholdMs).toBeNull();
  });
});
