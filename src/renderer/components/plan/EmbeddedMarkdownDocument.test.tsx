// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EmbeddedMarkdownDocument from './EmbeddedMarkdownDocument';

vi.mock('../fileviewer/MilkdownEditor', () => ({
  default: ({ embeddedPersistence }: { embeddedPersistence: {
    draftContent: string;
    onDraftChange: (value: string) => void;
    onSave: (value: string) => Promise<boolean>;
    onUnmountFlush: (value: string) => void;
    registerSaveHandler: (save: () => Promise<boolean>) => (() => void) | void;
  } }) => {
    const persistenceRef = React.useRef(embeddedPersistence);
    persistenceRef.current = embeddedPersistence;
    React.useEffect(() => persistenceRef.current.registerSaveHandler(
      () => persistenceRef.current.onSave(persistenceRef.current.draftContent),
    ), []);
    React.useEffect(() => () => persistenceRef.current.onUnmountFlush(persistenceRef.current.draftContent), []);
    return <textarea data-testid="milkdown-canvas" value={embeddedPersistence.draftContent} onChange={(event) => embeddedPersistence.onDraftChange(event.currentTarget.value)} />;
  },
}));
vi.mock('../selection/SelectionSurface', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../fileviewer/MarkdownRenderer', () => ({
  default: ({ content }: { content: string }) => <article>{content}</article>,
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const props = {
  content: '# bounded',
  filePath: 'C:\\work\\.lares\\proposals\\proposal.md',
  rootDirectory: 'C:\\work',
  pathType: 'windows' as const,
  workspaceId: 'ws-1',
};

describe('EmbeddedMarkdownDocument', () => {
  let root: Root;
  let host: HTMLDivElement;
  const writeFile = vi.fn(async () => ({ ok: true }));

  beforeEach(async () => {
    writeFile.mockClear();
    (window as unknown as { api: unknown }).api = {
      files: {
        readFile: vi.fn(async () => ({ path: props.filePath, content: '# complete', size: 10 })),
        writeFile,
      },
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root.render(<EmbeddedMarkdownDocument {...props} />); });
  });

  afterEach(() => {
    try { act(() => root.unmount()); } catch { /* already unmounted */ }
    host.remove();
  });

  function click(testId: string): void {
    act(() => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.click());
  }

  function edit(value: string): void {
    const input = host.querySelector<HTMLTextAreaElement>('[data-testid="milkdown-canvas"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  it('loads the complete file and persists edits through the normal file writer', async () => {
    expect(host.textContent).toContain('# complete');
    click('proposal-edit');
    expect(host.querySelector('[data-testid="milkdown-canvas"]')).not.toBeNull();
    edit('# edited in plans');
    click('proposal-save');
    await act(async () => {});
    expect(writeFile).toHaveBeenCalledWith(props.filePath, props.rootDirectory, props.pathType, '# edited in plans', expect.any(String));
  });

  it('flushes a dirty draft when pane navigation unmounts the editor', async () => {
    click('proposal-edit');
    edit('# saved while switching panes');
    act(() => root.unmount());
    await act(async () => {});
    expect(writeFile).toHaveBeenCalledWith(props.filePath, props.rootDirectory, props.pathType, '# saved while switching panes', expect.any(String));
  });
});
