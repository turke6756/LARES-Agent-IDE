// @vitest-environment jsdom
//
// The read-only markdown pane: renders fetched document text, a truncated
// badge, read errors, and an empty state — and NEVER navigates on a link click
// (this stage is strictly read-only).
import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ProposalReader from './ProposalReader';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(el: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(el); });
  return container;
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

describe('ProposalReader', () => {
  it('renders an empty state when nothing is selected', async () => {
    const c = await render(<ProposalReader name={null} content={null} />);
    expect(c.querySelector('[data-testid="proposal-reader-empty"]')).not.toBeNull();
  });

  it('renders markdown content and the document name', async () => {
    const c = await render(
      <ProposalReader name="proposal.md" content={'# Title\n\nBody text here.'} />,
    );
    expect(c.querySelector('h1')?.textContent).toContain('Title');
    expect(c.textContent).toContain('Body text here.');
    expect(c.textContent).toContain('proposal.md');
  });

  it('shows a truncated badge when the source was capped', async () => {
    const c = await render(
      <ProposalReader name="big.md" content={'hello'} truncated />,
    );
    expect(c.querySelector('[data-testid="proposal-reader-truncated"]')).not.toBeNull();
  });

  it('shows a read error', async () => {
    const c = await render(
      <ProposalReader name="gone.md" content={null} error="not found" />,
    );
    expect(c.querySelector('[data-testid="proposal-reader-error"]')?.textContent).toContain('not found');
  });

  it('renders links inert (no navigation on click)', async () => {
    const c = await render(
      <ProposalReader name="x.md" content={'[link](https://example.com)'} />,
    );
    const link = c.querySelector('a') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => { link.dispatchEvent(ev); });
    // The inline handler calls preventDefault — the click is cancelled.
    expect(ev.defaultPrevented).toBe(true);
  });
});
