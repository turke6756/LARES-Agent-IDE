// @vitest-environment jsdom
//
// WP-G3.1 — the file context menu's "History" item (file right-click → History).
// The item appears ONLY for files and ONLY when an onShowHistory handler is wired,
// and it invokes the handler then closes the menu.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FileContextMenu from './FileContextMenu';

let container: HTMLDivElement;
let root: Root | null;

async function render(props: Partial<React.ComponentProps<typeof FileContextMenu>> = {}) {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <FileContextMenu
        x={10}
        y={10}
        filePath="src/config.ts"
        workingDirectory="/ws"
        pathType="windows"
        isDirectory={false}
        onClose={() => {}}
        {...props}
      />,
    );
  });
}

const historyItem = () => container.querySelector('[data-testid="ctx-history"]') as HTMLButtonElement | null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = null;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});

describe('FileContextMenu — WP-G3.1 History item', () => {
  it('shows History for a file when onShowHistory is provided, and fires it + closes', async () => {
    const onShowHistory = vi.fn();
    const onClose = vi.fn();
    await render({ onShowHistory, onClose });
    const item = historyItem();
    expect(item).toBeTruthy();
    expect(item?.textContent).toContain('History');
    await act(async () => { item!.click(); });
    expect(onShowHistory).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides History when no handler is wired', async () => {
    await render({ onShowHistory: undefined });
    expect(historyItem()).toBeNull();
  });

  it('hides History for a directory even when a handler is wired', async () => {
    await render({ isDirectory: true, onShowHistory: vi.fn() });
    expect(historyItem()).toBeNull();
  });
});
