// @vitest-environment jsdom
/**
 * SC-WP-2L — quota-weakening banner render contract.
 *
 * The banner is the ONLY retention voice on the Save card (Amendment 4:
 * "protect, don't nag"). It must appear iff the WP-2K policy actually released a
 * still-dirty recovery edge, stay silent otherwise, and never leak a raw path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SaveCardQuotaWeakening } from '../../../shared/commit-candidates';
import QuotaWeakeningBanner from './QuotaWeakeningBanner';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(warning: SaveCardQuotaWeakening | null): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(React.createElement(QuotaWeakeningBanner, { warning }));
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const weakening: SaveCardQuotaWeakening = {
  quotaBytes: 536_870_912,
  usedBytes: 536_870_912,
  releasedEdges: [{ turnId: 't-1', edge: 'after' }, { turnId: 't-2', edge: 'before' }],
  willWeakenPaths: ['entry-a', 'entry-b'],
};

describe('QuotaWeakeningBanner', () => {
  it('renders the single honest "time to save" line when an edge is released', () => {
    render(weakening);
    const banner = container.querySelector('[data-testid="save-card-quota-weakening"]');
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain('Uncommitted work is eating recovery space — time to save.');
    expect(banner?.getAttribute('role')).toBe('status');
  });

  it('summarizes the affected change count without exposing raw entry identities or paths', () => {
    render(weakening);
    const banner = container.querySelector('[data-testid="save-card-quota-weakening"]');
    expect(banner?.textContent).toContain('2 changes');
    expect(banner?.textContent).not.toContain('entry-a');
    expect(banner?.textContent).not.toContain('t-1');
    // No filesystem path fragment ever appears in the surfaced copy.
    expect(banner?.textContent).not.toMatch(/[/\\]/);
  });

  it('uses the singular form for a single affected change', () => {
    render({ ...weakening, willWeakenPaths: ['only-one'] });
    const banner = container.querySelector('[data-testid="save-card-quota-weakening"]');
    expect(banner?.textContent).toContain('1 change');
    expect(banner?.textContent).not.toContain('1 changes');
  });

  it('renders nothing when there is no warning', () => {
    render(null);
    expect(container.querySelector('[data-testid="save-card-quota-weakening"]')).toBeFalsy();
    expect(container.textContent).toBe('');
  });

  it('renders nothing when the warning released no still-dirty edge', () => {
    render({ ...weakening, releasedEdges: [] });
    expect(container.querySelector('[data-testid="save-card-quota-weakening"]')).toBeFalsy();
  });
});
