// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import DownloadsShelf from './DownloadsShelf';
import {
  useBrowserStore,
  type BrowserDownload,
  type BrowserDownloadPrompt,
} from '../../stores/browser-store';

// Slice 13 acceptance (the shelf):
//   • renders records from the store + a lifecycle-event upsert updates
//     progress/state in place;
//   • the USER-download confirm affordance calls downloadConfirm with the
//     one-shot prompt token;
//   • the four row actions call the matching store/api methods;
//   • the shelf is hidden when there are no records AND no pending prompt.

function dl(over: Partial<BrowserDownload> & { id: string }): BrowserDownload {
  return {
    url: 'https://files.example/report.pdf',
    filename: 'report.pdf',
    savePath: '/dl/report.pdf',
    partition: 'user',
    workspaceId: 'ws-A',
    origin: 'https://files.example',
    bytesReceived: 0,
    totalBytes: 0,
    state: 'in-progress',
    startedAt: 1,
    endedAt: null,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(DownloadsShelf));
  });
}

function buttonByLabel(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === label,
  ) as HTMLButtonElement | undefined;
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').trim().toLowerCase().includes(text.toLowerCase()),
  ) as HTMLButtonElement | undefined;
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  useBrowserStore.setState({
    downloads: [],
    pendingDownloadPrompt: null,
    downloadsShelfCollapsed: false,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  delete (window as unknown as { api?: unknown }).api;
});

describe('DownloadsShelf — visibility', () => {
  it('is hidden when there are no records and no pending prompt', () => {
    render();
    expect(container.querySelector('[data-testid="downloads-shelf"]')).toBeNull();
  });

  it('renders a row per record from the store', () => {
    useBrowserStore.setState({
      downloads: [
        dl({ id: 'd1', filename: 'a.pdf', state: 'completed', bytesReceived: 2048, totalBytes: 2048 }),
        dl({ id: 'd2', filename: 'b.zip', state: 'in-progress', bytesReceived: 512, totalBytes: 4096 }),
      ],
    });
    render();
    expect(container.querySelector('[data-testid="downloads-shelf"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="download-row"]').length).toBe(2);
    expect(container.textContent).toContain('a.pdf');
    expect(container.textContent).toContain('b.zip');
  });
});

describe('DownloadsShelf — lifecycle-event upsert', () => {
  it('updates progress/state in place keyed by id', () => {
    useBrowserStore.setState({
      downloads: [dl({ id: 'd1', filename: 'big.iso', state: 'in-progress', bytesReceived: 0, totalBytes: 1024 })],
    });
    render();

    // A progress push for the same id patches the existing record (no new row).
    act(() => {
      useBrowserStore.getState().handleDownloadEvent(
        dl({ id: 'd1', filename: 'big.iso', state: 'in-progress', bytesReceived: 512, totalBytes: 1024 }),
      );
    });
    expect(container.querySelectorAll('[data-testid="download-row"]').length).toBe(1);
    const bar = container.querySelector('[data-testid="download-progress-bar"]') as HTMLElement;
    expect(bar.style.width).toBe('50%');

    // A done push flips the state — the Open-file action now appears.
    act(() => {
      useBrowserStore.getState().handleDownloadEvent(
        dl({ id: 'd1', filename: 'big.iso', state: 'completed', bytesReceived: 1024, totalBytes: 1024, endedAt: 9 }),
      );
    });
    expect(container.querySelectorAll('[data-testid="download-row"]').length).toBe(1);
    expect(buttonByLabel('Open file')).toBeTruthy();
  });
});

describe('DownloadsShelf — confirm affordance', () => {
  it('calls downloadConfirm with the one-shot prompt token', () => {
    const downloadConfirm = vi.fn();
    (window as unknown as { api: unknown }).api = { browser: { downloadConfirm } };
    const prompt: BrowserDownloadPrompt = {
      id: 'tok-42',
      url: 'https://files.example/secret.bin',
      filename: 'secret.bin',
      origin: 'https://files.example',
      workspaceId: 'ws-A',
    };
    useBrowserStore.setState({ pendingDownloadPrompt: prompt });
    render();

    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull();
    const go = buttonByText('Download');
    expect(go).toBeTruthy();
    click(go!);
    expect(downloadConfirm).toHaveBeenCalledWith('tok-42');
    // The slot is cleared after confirming.
    expect(useBrowserStore.getState().pendingDownloadPrompt).toBeNull();
  });

  it('Decline clears the prompt without confirming', () => {
    const downloadConfirm = vi.fn();
    (window as unknown as { api: unknown }).api = { browser: { downloadConfirm } };
    useBrowserStore.setState({
      pendingDownloadPrompt: {
        id: 'tok-1',
        url: 'https://x/y',
        filename: 'y',
        origin: 'https://x',
        workspaceId: null,
      },
    });
    render();
    click(buttonByText('Decline')!);
    expect(downloadConfirm).not.toHaveBeenCalled();
    expect(useBrowserStore.getState().pendingDownloadPrompt).toBeNull();
  });
});

describe('DownloadsShelf — row actions', () => {
  it('the four row actions call the matching api methods', () => {
    const downloadOpenFile = vi.fn();
    const downloadShowInFolder = vi.fn();
    const downloadRetry = vi.fn();
    const downloadRemove = vi.fn();
    (window as unknown as { api: unknown }).api = {
      browser: { downloadOpenFile, downloadShowInFolder, downloadRetry, downloadRemove },
    };
    // A completed row (Open file + Show in folder + Remove) and a failed row
    // (Retry + Show in folder + Remove).
    useBrowserStore.setState({
      downloads: [
        dl({ id: 'done', filename: 'done.pdf', state: 'completed', bytesReceived: 1, totalBytes: 1 }),
      ],
    });
    render();

    click(buttonByLabel('Open file')!);
    expect(downloadOpenFile).toHaveBeenCalledWith('done');

    click(buttonByLabel('Show in folder')!);
    expect(downloadShowInFolder).toHaveBeenCalledWith('done');

    // Swap in a failed record so the Retry action is present.
    act(() => {
      useBrowserStore.setState({ downloads: [dl({ id: 'bad', filename: 'bad.zip', state: 'failed' })] });
    });
    click(buttonByLabel('Retry')!);
    expect(downloadRetry).toHaveBeenCalledWith('bad');

    click(buttonByLabel('Remove')!);
    expect(downloadRemove).toHaveBeenCalledWith('bad');
    // Remove is optimistic — the record is dropped locally too.
    expect(useBrowserStore.getState().downloads.find((d) => d.id === 'bad')).toBeUndefined();
  });
});
