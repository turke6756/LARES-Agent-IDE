// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useOwnerExpand, pruneOwnerExpandKeys } from './useOwnerExpand';

// Hook test via the createRoot-on-jsdom probe pattern (no React Testing Library),
// mirroring src/renderer/components/browser/*.test.tsx.

let container: HTMLDivElement;
let root: Root;

function Probe({ id, count }: { id: string; count: number }) {
  const [expanded, toggle] = useOwnerExpand(id, count);
  return React.createElement(
    'div',
    null,
    React.createElement('span', { 'data-testid': 'state' }, expanded ? 'open' : 'closed'),
    React.createElement('button', { onClick: toggle }, 'toggle'),
  );
}

function render(id: string, count: number) {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(Probe, { id, count }));
  });
}

function unmount() {
  act(() => root?.unmount());
}

function state(): string | null | undefined {
  return container.querySelector('[data-testid="state"]')?.textContent;
}

function clickToggle() {
  const btn = container.querySelector('button');
  if (!btn) throw new Error('toggle button not found');
  act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  unmount();
  container.remove();
  localStorage.clear();
});

describe('useOwnerExpand', () => {
  it('falls back to defaultOwnerExpanded (always collapsed) when no preference is stored', () => {
    render('o-small', 3);
    expect(state()).toBe('closed'); // default is collapsed regardless of count
    unmount();

    render('o-big', 10);
    expect(state()).toBe('closed');
  });

  it('toggle flips the state and persists it to localStorage', () => {
    render('o-toggle', 3);
    expect(state()).toBe('closed'); // starts collapsed

    clickToggle();
    expect(state()).toBe('open');
    expect(localStorage.getItem('owner-expand:o-toggle')).toBe('1');

    clickToggle();
    expect(state()).toBe('closed');
    expect(localStorage.getItem('owner-expand:o-toggle')).toBe('0');
  });

  it('a persisted value overrides the fallback on remount', () => {
    // Stored '1' (expanded) must win even though the default is collapsed.
    localStorage.setItem('owner-expand:o-persist', '1');
    render('o-persist', 3);
    expect(state()).toBe('open');
  });

  it('persists a toggle across an unmount/remount cycle', () => {
    render('o-cycle', 3);
    expect(state()).toBe('closed');
    clickToggle();
    expect(state()).toBe('open');
    unmount();

    render('o-cycle', 3);
    expect(state()).toBe('open'); // persisted expand survived remount
  });
});

describe('pruneOwnerExpandKeys', () => {
  it('removes owner-expand entries for ids not in the live set, keeping live ones', () => {
    localStorage.setItem('owner-expand:alive', '1');
    localStorage.setItem('owner-expand:dead', '0');
    localStorage.setItem('panelLayout', 'unrelated'); // must be left untouched

    const removed = pruneOwnerExpandKeys(new Set(['alive']));

    expect(removed).toBe(1);
    expect(localStorage.getItem('owner-expand:alive')).toBe('1');
    expect(localStorage.getItem('owner-expand:dead')).toBeNull();
    expect(localStorage.getItem('panelLayout')).toBe('unrelated');
  });

  it('removes all owner-expand keys when the live set is empty', () => {
    localStorage.setItem('owner-expand:a', '1');
    localStorage.setItem('owner-expand:b', '0');

    const removed = pruneOwnerExpandKeys(new Set());

    expect(removed).toBe(2);
    expect(localStorage.getItem('owner-expand:a')).toBeNull();
    expect(localStorage.getItem('owner-expand:b')).toBeNull();
  });
});
