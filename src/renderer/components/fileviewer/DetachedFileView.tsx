import React, { useEffect, useMemo, useState } from 'react';
import type { PathType } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import FileViewerHeader from './FileViewerHeader';
import FileContentArea from './FileContentArea';
import { hasUnsavedWork, requestSave } from './saveCoordinator';

// Minimal single-tab file viewer for a detached (tear-off) window
// (detachable-file-tabs-plan §4 1.8). NO Sidebar / MainContent grid / Terminal /
// DetailPanel / DirectoryTree — just the header + content for the one file this
// window owns. Read / edit / save / dirty / fs-watch (per-sender routed in main)
// are reused unchanged via the shared store + FileContentArea.
interface Props {
  params: URLSearchParams;
}

export default function DetachedFileView({ params }: Props) {
  // Parse the launch params once. createDetachedWindow encodes these into the
  // query string (index.ts / detached-windows.ts).
  const meta = useMemo(() => {
    const pathType = (params.get('pathType') as PathType) || 'windows';
    return {
      filePath: params.get('filePath') ?? '',
      rootDirectory: params.get('rootDirectory') ?? '',
      pathType,
      workspaceId: params.get('workspaceId') ?? '',
      label: params.get('label') ?? '',
    };
  }, [params]);

  // Seed the store atomically on mount: workspace + single tab + open flags in
  // one update (seedDetachedTab; never selectWorkspace, which closes the viewer).
  useEffect(() => {
    useDashboardStore.getState().seedDetachedTab(meta);
    if (meta.label) document.title = meta.label;
  }, [meta]);

  const tabId = `detached:${meta.filePath}`;

  // Phase 2 dirty-on-close (plan §2.1): main intercepts the window close and
  // sends a close-query. If the tab is clean we reply 'discard' immediately and
  // the window closes; if dirty we show the Save/Discard/Cancel modal and reply
  // with the user's decision (saving first on 'save'). This replaces the Phase 1
  // beforeunload guard.
  const [closeRequest, setCloseRequest] = useState<{ requestId: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = window.api.tabs.onCloseQuery(({ requestId }) => {
      // Coordinator probe, not bare store dirty (edit-loss Phase 2): a live
      // canvas edit still inside the ~200ms debounce hasn't reached the store
      // yet — hasUnsavedWork() flushes it synchronously so it raises the
      // modal instead of being silently discarded.
      if (!hasUnsavedWork(tabId)) {
        void window.api.tabs.closeReply(requestId, 'discard');
        return;
      }
      setSaveError(null);
      setCloseRequest({ requestId });
    });
    return unsub;
  }, [tabId]);

  const handleSaveAndClose = async () => {
    if (!closeRequest) return;
    const ok = await requestSave(tabId);
    if (ok) {
      void window.api.tabs.closeReply(closeRequest.requestId, 'save');
      setCloseRequest(null);
    } else {
      setSaveError('Save failed. Fix the problem and try again, or discard your changes.');
    }
  };
  const handleDiscardAndClose = () => {
    if (!closeRequest) return;
    void window.api.tabs.closeReply(closeRequest.requestId, 'discard');
    setCloseRequest(null);
  };
  const handleCancelClose = () => {
    if (!closeRequest) return;
    void window.api.tabs.closeReply(closeRequest.requestId, 'cancel');
    setCloseRequest(null);
  };

  // Ctrl/Cmd-S saves the in-window edits (no menu chrome in a detached window).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        const editState = useDashboardStore.getState().tabEditState[tabId];
        if (editState && editState.mode !== 'view') {
          e.preventDefault();
          // Coordinator routing (edit-loss Phase 2); the canvas Ctrl+S
          // handler stopPropagation()s before this window handler fires.
          void requestSave(tabId);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tabId]);

  // Re-read the seeded tab so the view reflects the live store (the seed runs in
  // an effect, so the first render has no tab yet).
  const activeTab = useDashboardStore((s) => s.openTabs.find((t) => t.id === s.activeTabId));

  if (!activeTab || !activeTab.filePath) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface-0 text-gray-400 font-sans text-sm">
        Loading {meta.label}…
      </div>
    );
  }

  return (
    <div className="relative flex flex-col h-screen bg-surface-0 text-gray-100 overflow-hidden">
      <FileViewerHeader
        tabId={activeTab.id}
        filePath={activeTab.filePath}
        pathType={activeTab.pathType}
        fileSize={0}
        workingDirectory={activeTab.rootDirectory}
        onNavigate={() => { /* no breadcrumb navigation in a detached window */ }}
      />
      <div className="flex-1 min-h-0 overflow-hidden">
        <FileContentArea
          tabId={activeTab.id}
          filePath={activeTab.filePath}
          pathType={activeTab.pathType}
        />
      </div>

      {closeRequest && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[400px] rounded-lg border border-white/10 bg-surface-1 p-5 shadow-xl">
            <h2 className="text-sm font-semibold text-gray-100">Unsaved changes</h2>
            <p className="mt-2 text-sm text-gray-400">
              You have unsaved changes in <span className="text-gray-200">{meta.label}</span>.
              Save before closing?
            </p>
            {saveError && (
              <p className="mt-2 text-sm text-red-400">{saveError}</p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={handleCancelClose}
                className="rounded px-3 py-1.5 text-sm text-gray-300 hover:bg-white/10"
              >
                Cancel
              </button>
              <button
                onClick={handleDiscardAndClose}
                className="rounded px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/15"
              >
                Discard
              </button>
              <button
                onClick={handleSaveAndClose}
                className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
