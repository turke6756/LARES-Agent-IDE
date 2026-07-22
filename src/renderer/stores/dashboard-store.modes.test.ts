// @vitest-environment jsdom
/**
 * WP1-A mode-model migration tests for the dashboard store: the
 * 'view' | 'wysiwyg' | 'source' union, the three enter-mode actions, and
 * saveTab's write-generation token recording.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDashboardStore } from './dashboard-store';
import { matchRecentWrite } from '../components/fileviewer/useFileContentCache';
import { contentHash } from '../components/fileviewer/markdownSplice';

const TAB = 'tab-modes-1';

function editState() {
  return useDashboardStore.getState().tabEditState[TAB];
}

beforeEach(() => {
  useDashboardStore.setState({ openTabs: [], activeTabId: null, tabEditState: {} });
});

describe('enterSourceMode (the old enterEditMode)', () => {
  it('creates a clean source-mode session', () => {
    useDashboardStore.getState().enterSourceMode(TAB, 'disk bytes');
    expect(editState()).toMatchObject({
      mode: 'source',
      draftContent: 'disk bytes',
      originalContent: 'disk bytes',
      dirty: false,
      saving: false,
      error: null,
    });
  });

  it('preserves a dirty draft when re-entered (regression of old edit-mode behavior, and the wysiwyg → source carry)', () => {
    const store = useDashboardStore.getState();
    store.enterWysiwygMode(TAB, 'original');
    store.setDraftContent(TAB, 'spliced draft');
    expect(editState().dirty).toBe(true);
    store.enterSourceMode(TAB, 'original');
    expect(editState()).toMatchObject({
      mode: 'source',
      draftContent: 'spliced draft',
      originalContent: 'original',
      dirty: true,
    });
  });
});

describe('enterWysiwygMode', () => {
  it('creates a clean wysiwyg session (state creation happens here, never in the editor component)', () => {
    useDashboardStore.getState().enterWysiwygMode(TAB, 'doc bytes');
    expect(editState()).toMatchObject({
      mode: 'wysiwyg',
      draftContent: 'doc bytes',
      originalContent: 'doc bytes',
      dirty: false,
      saving: false,
      error: null,
    });
  });

  it('refreshes the baseline when re-entered clean, preserving reload/external-change bookkeeping', () => {
    const store = useDashboardStore.getState();
    store.enterSourceMode(TAB, 'old');
    useDashboardStore.setState((s) => ({
      tabEditState: { ...s.tabEditState, [TAB]: { ...s.tabEditState[TAB], reloadVersion: 3 } },
    }));
    store.enterWysiwygMode(TAB, 'newer disk bytes');
    expect(editState()).toMatchObject({
      mode: 'wysiwyg',
      originalContent: 'newer disk bytes',
      draftContent: 'newer disk bytes',
      dirty: false,
      reloadVersion: 3,
    });
  });

  it('only flips the mode when a dirty draft is present (callers discard or carry explicitly)', () => {
    const store = useDashboardStore.getState();
    store.enterSourceMode(TAB, 'original');
    store.setDraftContent(TAB, 'edited');
    store.enterWysiwygMode(TAB, 'ignored');
    expect(editState()).toMatchObject({
      mode: 'wysiwyg',
      draftContent: 'edited',
      originalContent: 'original',
      dirty: true,
    });
  });
});

describe('enterViewMode / exitEditMode', () => {
  it('enterViewMode pins an explicit view session when none exists (overrides the markdown wysiwyg default)', () => {
    useDashboardStore.getState().enterViewMode(TAB, 'doc bytes');
    expect(editState()).toMatchObject({
      mode: 'view',
      originalContent: 'doc bytes',
      dirty: false,
    });
  });

  it('enterViewMode and exitEditMode return an existing session to view without touching content', () => {
    const store = useDashboardStore.getState();
    store.enterWysiwygMode(TAB, 'doc');
    store.enterViewMode(TAB, 'should be ignored');
    expect(editState()).toMatchObject({ mode: 'view', originalContent: 'doc' });

    store.enterSourceMode(TAB, 'doc');
    store.exitEditMode(TAB);
    expect(editState()).toMatchObject({ mode: 'view', originalContent: 'doc' });
  });

  it('discardTabChanges drops the draft and lands in view', () => {
    const store = useDashboardStore.getState();
    store.enterWysiwygMode(TAB, 'doc');
    store.setDraftContent(TAB, 'draft');
    store.discardTabChanges(TAB);
    expect(editState()).toMatchObject({
      mode: 'view',
      draftContent: 'doc',
      dirty: false,
    });
  });
});

describe('saveTab', () => {
  beforeEach(() => {
    useDashboardStore.setState({
      openTabs: [
        {
          id: TAB,
          filePath: 'C:/ws/doc.md',
          rootDirectory: 'C:/ws',
          pathType: 'windows',
          label: 'doc.md',
        } as never,
      ],
    });
    (window as unknown as { api: unknown }).api = {
      files: { writeFile: vi.fn(async () => ({ ok: true })) },
    };
  });

  it('records the draft in the recent-writes map before writing, and stays in the current mode', async () => {
    const store = useDashboardStore.getState();
    store.enterWysiwygMode(TAB, 'original');
    store.setDraftContent(TAB, 'spliced save payload');

    const ok = await store.saveTab(TAB);
    expect(ok).toBe(true);

    const api = (window as unknown as { api: { files: { writeFile: ReturnType<typeof vi.fn> } } }).api;
    expect(api.files.writeFile).toHaveBeenCalledWith(
      'C:/ws/doc.md',
      'C:/ws',
      'windows',
      'spliced save payload',
    );
    // Write ledger: the fs-watcher echo of this save must be recognizable
    // even before originalContent updates — and the token is committed.
    expect(matchRecentWrite(TAB, contentHash('spliced save payload'))).toMatchObject({
      state: 'committed',
    });
    expect(editState()).toMatchObject({
      mode: 'wysiwyg',
      originalContent: 'spliced save payload',
      dirty: false,
      saving: false,
    });
  });

  it('surfaces write errors without leaving the mode', async () => {
    (window as unknown as { api: unknown }).api = {
      files: { writeFile: vi.fn(async () => ({ ok: false, error: 'disk full' })) },
    };
    const store = useDashboardStore.getState();
    store.enterSourceMode(TAB, 'original');
    store.setDraftContent(TAB, 'draft');

    const ok = await store.saveTab(TAB);
    expect(ok).toBe(false);
    expect(editState()).toMatchObject({
      mode: 'source',
      error: 'disk full',
      dirty: true,
      saving: false,
    });
  });
});
