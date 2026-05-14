import React, { useEffect, useCallback, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useResize } from '../../hooks/useResize';
import FileViewerHeader from './FileViewerHeader';
import FileContentArea from './FileContentArea';
import FileTabBar from './FileTabBar';
import DirectoryTree from './DirectoryTree';
import ResizeDivider from '../layout/ResizeDivider';
import CollapseButton from '../layout/CollapseButton';
import { evictTabCache } from './useFileContentCache';
import { ArrowLeft } from 'lucide-react';

function useSwipeRight(onSwipe: () => void) {
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') {
      startRef.current = null;
      return;
    }
    startRef.current = { x: e.clientX, y: e.clientY };
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') {
      startRef.current = null;
      return;
    }
    if (!startRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const dy = Math.abs(e.clientY - startRef.current.y);
    startRef.current = null;
    if (window.getSelection()?.toString()) return;
    if (dx > 80 && dy < 60) onSwipe();
  }, [onSwipe]);
  return { onPointerDown, onPointerUp };
}

export default function FileViewerPanel() {
  const { openTabs, activeTabId, panelLayout, selectedWorkspaceId, tabEditState } = useDashboardStore(
    useShallow((s) => ({
      openTabs: s.openTabs,
      activeTabId: s.activeTabId,
      panelLayout: s.panelLayout,
      selectedWorkspaceId: s.selectedWorkspaceId,
      tabEditState: s.tabEditState,
    })),
  );
  const closeTab = useDashboardStore((s) => s.closeTab);
  const setActiveTab = useDashboardStore((s) => s.setActiveTab);
  const hideFileViewer = useDashboardStore((s) => s.hideFileViewer);
  const openTab = useDashboardStore((s) => s.openTab);
  const togglePanelCollapsed = useDashboardStore((s) => s.togglePanelCollapsed);
  const saveTab = useDashboardStore((s) => s.saveTab);

  const swipeToAgents = useSwipeRight(hideFileViewer);

  // Filter tabs to only show those belonging to the current workspace
  const visibleTabs = useMemo(
    () => openTabs.filter((t) => t.workspaceId === selectedWorkspaceId),
    [openTabs, selectedWorkspaceId],
  );

  const activeTab = openTabs.find((t) => t.id === activeTabId);
  // activeTab may briefly belong to another workspace during transitions; fall back
  // to the first visible tab so tree root and header reflect the current workspace.
  const effectiveTab = activeTab && activeTab.workspaceId === selectedWorkspaceId
    ? activeTab
    : visibleTabs[0];

  // Use the effective tab's rootDirectory for the tree
  const treeRoot = effectiveTab?.rootDirectory || '';
  const treePathType = effectiveTab?.pathType || 'wsl';

  // Directory tree resize
  const treeResize = useResize({
    direction: 'horizontal',
    initialSize: panelLayout.directoryTreeWidth,
    min: 150,
    max: 500,
    storageKey: 'panel-tree-width',
  });

  const treeCollapsed = panelLayout.directoryTreeCollapsed;

  // Keyboard shortcuts — close the tab currently displayed in this workspace's viewer
  const displayedTabId = effectiveTab?.id;
  const handleCloseTab = useCallback((tabId: string) => {
    const editState = tabEditState[tabId];
    if (editState?.dirty && !window.confirm('Discard unsaved changes?')) {
      return;
    }
    evictTabCache(tabId);
    closeTab(tabId);
  }, [closeTab, tabEditState]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        const editState = displayedTabId ? tabEditState[displayedTabId] : null;
        if (displayedTabId && editState?.mode === 'edit') {
          e.preventDefault();
          void saveTab(displayedTabId);
        }
      } else if (e.key === 'Escape') {
        if (displayedTabId) {
          handleCloseTab(displayedTabId);
        }
      } else if (e.key === 'w' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (displayedTabId) {
          handleCloseTab(displayedTabId);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [displayedTabId, handleCloseTab, saveTab, tabEditState]);

  // Clicking a file in the tree opens it as a new tab (or focuses existing)
  const handleFileSelect = useCallback((filePath: string) => {
    openTab(filePath, treeRoot, treePathType, effectiveTab?.agentId, selectedWorkspaceId ?? undefined);
  }, [openTab, treeRoot, treePathType, effectiveTab?.agentId, selectedWorkspaceId]);

  const handleBreadcrumbNavigate = useCallback((_dirPath: string) => {
    // Could navigate tree in future
  }, []);

  if (!effectiveTab) return null;

  // Only show file header + content for tabs that have a file (not directory-only tabs)
  const hasFile = !!effectiveTab.filePath;

  // Extract directory name for display
  const dirName = treeRoot.split('/').filter(Boolean).pop() || treeRoot;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-surface-0" {...swipeToAgents}>
      {/* Persistent Back Bar — always visible */}
      <div className="flex items-center gap-3 px-4 py-2 border-b dark:border-white/10 light:border-black/10 bg-surface-1/60 backdrop-blur-md shrink-0">
        <button
          onClick={hideFileViewer}
          className="flex items-center gap-1.5 text-gray-400 hover:text-white transition-colors text-[13px] font-sans shrink-0 group"
          title="Back to agents"
        >
          <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
          <span>Back</span>
        </button>
        <div className="h-4 w-px bg-accent-blue/20 shrink-0" />
        <span className="text-[13px] font-sans text-gray-300 truncate">{dirName}</span>
      </div>

      {/* Tab Bar */}
      <FileTabBar
        tabs={visibleTabs}
        activeTabId={effectiveTab.id}
        onSelectTab={setActiveTab}
        onCloseTab={handleCloseTab}
      />

      {/* File Header — only for file tabs */}
      {hasFile && (
        <FileViewerHeader
          tabId={effectiveTab.id}
          filePath={effectiveTab.filePath}
          pathType={effectiveTab.pathType}
          fileSize={0}
          workingDirectory={effectiveTab.rootDirectory}
          onNavigate={handleBreadcrumbNavigate}
        />
      )}

      <div className="flex-1 flex min-h-0">
        {/* Directory Tree Sidebar */}
        {treeCollapsed ? (
          <div className="shrink-0 bg-surface-0/40 border-r dark:border-white/10 light:border-black/10 flex flex-col items-center py-2" style={{ width: 32 }}>
            <CollapseButton collapsed direction="left" onClick={() => togglePanelCollapsed('directoryTreeCollapsed')} />
            <div className="mt-2 text-[13px] font-sans text-gray-400" style={{ writingMode: 'vertical-rl' }}>
              Files
            </div>
          </div>
        ) : (
          <>
            <div className="shrink-0 relative" style={{ width: treeResize.size }}>
              <div className="absolute top-1 right-1 z-10">
                <CollapseButton collapsed={false} direction="left" onClick={() => togglePanelCollapsed('directoryTreeCollapsed')} />
              </div>
              <DirectoryTree
                rootPath={treeRoot}
                pathType={treePathType}
                activeFilePath={effectiveTab.filePath}
                onFileSelect={handleFileSelect}
              />
            </div>
            <ResizeDivider
              direction="horizontal"
              isResizing={treeResize.isResizing}
              onMouseDown={treeResize.handleMouseDown}
            />
          </>
        )}

        {/* File Content */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {hasFile ? (
            <FileContentArea
              tabId={effectiveTab.id}
              filePath={effectiveTab.filePath}
              pathType={effectiveTab.pathType}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-gray-400 font-sans text-sm  ">
                Select a file to view
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
