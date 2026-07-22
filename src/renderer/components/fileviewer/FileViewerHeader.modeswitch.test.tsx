// @vitest-environment jsdom
/**
 * D2 — both-direction dirty-draft carry (plans/markdown-editor-edit-loss-
 * implementation.md §1.4). The header's mode switch carries a dirty draft in
 * BOTH directions between the two edit modes: wysiwyg → source (CodeMirror
 * shows the spliced draft — pre-existing) and source → wysiwyg (the canvas
 * mounts from the draft since Phase 1). A source → wysiwyg carry sniffs THE
 * DRAFT via sniffWysiwygCompatibility(draftContent); an incompatible draft
 * stays in source mode with a window.alert explanation — never a confirm
 * prompt that can discard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import FileViewerHeader from './FileViewerHeader';
import { useDashboardStore } from '../../stores/dashboard-store';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TAB = 'tab-modeswitch';
const FILE = 'C:\\ws\\doc.md';
const DIR = 'C:\\ws';

const ORIGINAL = '# Title\r\n\r\nSecond paragraph to edit.\r\n';
const DIRTY_DRAFT = '# Title\r\n\r\nEDITED Second paragraph to edit.\r\n';
// Frontmatter is a §6.3 exclusion — sniffWysiwygCompatibility rejects it.
const INCOMPATIBLE_DRAFT = '---\r\ntitle: x\r\n---\r\n\r\nEDITED body.\r\n';

let confirmSpy: ReturnType<typeof vi.spyOn>;
let alertSpy: ReturnType<typeof vi.spyOn>;

function seedTab(editState: Record<string, unknown>) {
  useDashboardStore.setState({
    openTabs: [
      {
        id: TAB,
        filePath: FILE,
        rootDirectory: DIR,
        pathType: 'windows',
        label: 'doc.md',
        workspaceId: 'ws1',
      } as never,
    ],
    activeTabId: TAB,
    selectedWorkspaceId: 'ws1',
    tabEditState: {
      [TAB]: {
        mode: 'source',
        draftContent: ORIGINAL,
        originalContent: ORIGINAL,
        dirty: false,
        saving: false,
        error: null,
        ...editState,
      } as never,
    },
  });
}

interface Mounted {
  host: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

async function mountHeader(): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <FileViewerHeader
        tabId={TAB}
        filePath={FILE}
        pathType="windows"
        fileSize={0}
        workingDirectory={DIR}
        onNavigate={() => {}}
      />,
    );
  });
  return {
    host,
    root,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function findButton(scope: ParentNode, label: string): HTMLButtonElement {
  const btn = Array.from(scope.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  expect(btn, `button "${label}" should exist`).toBeTruthy();
  return btn as HTMLButtonElement;
}

async function click(btn: HTMLButtonElement) {
  act(() => {
    btn.click();
  });
  await flush();
}

beforeEach(() => {
  (window as unknown as { api: unknown }).api = {
    files: {
      readFile: vi.fn(async (path: string) => ({
        path,
        content: ORIGINAL,
        encoding: 'utf8',
        size: ORIGINAL.length,
      })),
    },
    system: {
      openFile: vi.fn(async () => {}),
      openFileInWorkspace: vi.fn(async () => {}),
    },
  };
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  confirmSpy.mockRestore();
  alertSpy.mockRestore();
  useDashboardStore.setState({ openTabs: [], activeTabId: null, tabEditState: {} });
});

describe('D2 — dirty-draft carry across the markdown mode switch', () => {
  it('source → wysiwyg carries a compatible dirty draft (no confirm, no alert, draft intact)', async () => {
    seedTab({ mode: 'source', draftContent: DIRTY_DRAFT, dirty: true });
    const mounted = await mountHeader();

    await click(findButton(mounted.host, 'Edit'));

    const es = useDashboardStore.getState().tabEditState[TAB];
    expect(es?.mode).toBe('wysiwyg');
    expect(es?.draftContent).toBe(DIRTY_DRAFT);
    expect(es?.dirty).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();

    await mounted.unmount();
  });

  it('wysiwyg → source carries a dirty draft (regression lock for the pre-existing direction)', async () => {
    seedTab({ mode: 'wysiwyg', draftContent: DIRTY_DRAFT, dirty: true });
    const mounted = await mountHeader();

    await click(findButton(mounted.host, 'Source'));

    const es = useDashboardStore.getState().tabEditState[TAB];
    expect(es?.mode).toBe('source');
    expect(es?.draftContent).toBe(DIRTY_DRAFT);
    expect(es?.dirty).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();

    await mounted.unmount();
  });

  it('an INCOMPATIBLE dirty draft stays in source mode with an alert — never a prompt that can discard', async () => {
    seedTab({ mode: 'source', draftContent: INCOMPATIBLE_DRAFT, dirty: true });
    const mounted = await mountHeader();

    await click(findButton(mounted.host, 'Edit'));

    // Explained via SNIFF_REASON_LABELS ('it has frontmatter')…
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(String(alertSpy.mock.calls[0][0])).toContain('frontmatter');
    // …no discard-capable confirm was ever offered…
    expect(confirmSpy).not.toHaveBeenCalled();
    // …and the edit session is untouched: still source, draft intact.
    const es = useDashboardStore.getState().tabEditState[TAB];
    expect(es?.mode).toBe('source');
    expect(es?.draftContent).toBe(INCOMPATIBLE_DRAFT);
    expect(es?.dirty).toBe(true);

    await mounted.unmount();
  });

  it('a dirty switch to View still asks before discarding (declined confirm changes nothing)', async () => {
    seedTab({ mode: 'source', draftContent: DIRTY_DRAFT, dirty: true });
    const mounted = await mountHeader();

    await click(findButton(mounted.host, 'View'));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const es = useDashboardStore.getState().tabEditState[TAB];
    expect(es?.mode).toBe('source');
    expect(es?.draftContent).toBe(DIRTY_DRAFT);
    expect(es?.dirty).toBe(true);

    await mounted.unmount();
  });
});
