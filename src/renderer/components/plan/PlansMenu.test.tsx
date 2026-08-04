// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PlansMenu from './PlansMenu';
import { useDashboardStore } from '../../stores/dashboard-store';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useDashboardStore.setState({
    fileViewerOpen: false,
    browserOpen: false,
    saveCardOpen: false,
    plansOpen: false,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: Partial<React.ComponentProps<typeof PlansMenu>> = {}): HTMLButtonElement {
  act(() => root.render(<PlansMenu compact={false} {...props} />));
  return container.querySelector('[data-testid="view-btn-plans"]') as HTMLButtonElement;
}

describe('Plans navigation button', () => {
  it('opens Plans through the shared center-pane state and has no popup', () => {
    const button = render();
    act(() => button.click());

    const state = useDashboardStore.getState();
    expect(state.plansOpen).toBe(true);
    expect(state.fileViewerOpen).toBe(false);
    expect(state.browserOpen).toBe(false);
    expect(state.saveCardOpen).toBe(false);
    expect(document.querySelector('[data-testid="plans-gallery"]')).toBeNull();
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('is inert while the Plans view is detached', () => {
    const button = render({ detached: true });
    act(() => button.click());
    expect(useDashboardStore.getState().plansOpen).toBe(false);
    expect(button.getAttribute('draggable')).toBe('false');
    expect(button.getAttribute('aria-disabled')).toBe('true');
  });

  it('supports the compact icon-only toolbar state', () => {
    const button = render({ compact: true });
    expect(button.textContent).not.toContain('Plans');
    expect(button.title).toContain('Open Plans');
  });
});
