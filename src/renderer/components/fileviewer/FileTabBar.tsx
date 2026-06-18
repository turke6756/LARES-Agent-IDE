import React, { useRef, useEffect, useState } from 'react';
import type { FileTab } from '../../../shared/types';
import { fileDragStart } from '../../utils/drag-file';
import { useDashboardStore, type ColoredFileTab } from '../../stores/dashboard-store';

interface Props {
  tabs: ColoredFileTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
}

// Preset palette for tab color-coding (right-click → Tab Color)
const TAB_COLORS = [
  { name: 'Red', value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Purple', value: '#a855f7' },
];

function getDisplayLabel(tab: FileTab, allTabs: FileTab[]): string {
  if (!tab.filePath) return tab.label; // directory-only tab

  const name = tab.label;
  // Check for duplicate filenames — show parent dir for disambiguation
  const dupes = allTabs.filter((t) => t.label === name && t.id !== tab.id);
  if (dupes.length > 0) {
    const normalized = tab.filePath.replace(/\\/g, '/');
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length >= 2) {
      return `${name} (${segments[segments.length - 2]})`;
    }
  }
  return name;
}

function getRelativePath(filePath: string, workingDirectory: string): string {
  const normFile = filePath.replace(/\\/g, '/');
  const normDir = workingDirectory.replace(/\\/g, '/').replace(/\/$/, '');
  if (normFile.startsWith(normDir + '/')) {
    return normFile.substring(normDir.length + 1);
  }
  return normFile;
}

function TabContextMenu({ x, y, tab, onClose }: { x: number; y: number; tab: ColoredFileTab; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const setTabColor = useDashboardStore((s) => s.setTabColor);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const pickColor = (color: string | null) => {
    setTabColor(tab.id, color);
    onClose();
  };

  const handleCopyPath = () => {
    navigator.clipboard.writeText(tab.filePath);
    onClose();
  };

  const handleCopyRelativePath = () => {
    navigator.clipboard.writeText(getRelativePath(tab.filePath, tab.rootDirectory));
    onClose();
  };

  const handleOpenInVSCode = () => {
    window.api.system.openFileInWorkspace(tab.filePath, tab.rootDirectory, tab.pathType);
    onClose();
  };

  return (
    <div ref={menuRef} className="ui-menu fixed z-50" style={{ left: x, top: y }}>
      <div className="ui-menu-header">Tab Color</div>
      <div className="flex items-center gap-1.5 px-3 py-2">
        {TAB_COLORS.map((c) => (
          <button
            key={c.value}
            title={c.name}
            onClick={() => pickColor(c.value)}
            className="w-4 h-4 rounded-full shrink-0 transition-transform hover:scale-125"
            style={{
              backgroundColor: c.value,
              outline: tab.color === c.value ? '2px solid var(--color-fg-secondary)' : 'none',
              outlineOffset: 1,
            }}
          />
        ))}
        <button
          title="Clear color"
          onClick={() => pickColor(null)}
          className="w-4 h-4 rounded-full shrink-0 flex items-center justify-center border transition-transform hover:scale-125"
          style={{ borderColor: 'var(--color-fg-muted)', color: 'var(--color-fg-muted)' }}
        >
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor">
            <path d="M1 9L9 1" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
      {tab.filePath && (
        <>
          <div className="ui-menu-divider" />
          <button onClick={handleCopyPath} className="ui-menu-item">
            Copy Path
          </button>
          <button onClick={handleCopyRelativePath} className="ui-menu-item">
            Copy Relative Path
          </button>
          <button onClick={handleOpenInVSCode} className="ui-menu-item">
            Open in VS Code
          </button>
        </>
      )}
    </div>
  );
}

export default function FileTabBar({ tabs, activeTabId, onSelectTab, onCloseTab }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabEditState = useDashboardStore((state) => state.tabEditState);
  const moveTab = useDashboardStore((state) => state.moveTab);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tab: ColoredFileTab } | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  // True when the in-progress drag has already reordered tabs in-strip — used
  // by handleDragEnd to distinguish a reorder (no tear-off) from a drag-out
  // onto empty desktop (detach). Reset at the end of every drag.
  const reorderHappenedRef = useRef(false);

  // Scroll active tab into view
  useEffect(() => {
    if (!scrollRef.current || !activeTabId) return;
    const activeEl = scrollRef.current.querySelector(`[data-tab-id="${activeTabId}"]`);
    if (activeEl) {
      activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [activeTabId]);

  const handleMouseDown = (e: React.MouseEvent, tabId: string) => {
    // Middle-click to close
    if (e.button === 1) {
      e.preventDefault();
      onCloseTab(tabId);
    }
  };

  const handleDragStart = (e: React.DragEvent, tab: ColoredFileTab) => {
    if (tab.filePath) {
      // Keep file-path payload so the tab can still be dropped into the terminal
      fileDragStart(e, tab.filePath);
    } else {
      e.dataTransfer.setData('text/plain', tab.label);
    }
    e.dataTransfer.effectAllowed = 'copyMove';
    setDraggedTabId(tab.id);
  };

  // Live reorder: while dragging, swap once the cursor crosses the midpoint of
  // the hovered tab (in the direction of travel) so tabs slide past each other
  // without oscillating when widths differ.
  const handleDragOver = (e: React.DragEvent, tab: ColoredFileTab) => {
    if (!draggedTabId || draggedTabId === tab.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;
    const fromIdx = tabs.findIndex((t) => t.id === draggedTabId);
    const toIdx = tabs.findIndex((t) => t.id === tab.id);
    if (fromIdx === -1 || toIdx === -1) return;
    if ((fromIdx < toIdx && e.clientX > midpoint) || (fromIdx > toIdx && e.clientX < midpoint)) {
      reorderHappenedRef.current = true;
      moveTab(draggedTabId, tab.id);
    }
  };

  // Tear-off detection (detachable-file-tabs-plan §4 1.6). A drag that ends with
  // no accepting drop target (dropEffect 'none') and was NOT a reorder, on a
  // file tab, spawns a detached window at the cursor. Save-before-detach guards
  // against losing an unsaved source-tab draft (the detached window seeds from
  // disk). screenX/Y and dropEffect are read SYNCHRONOUSLY — the event is
  // neutered after the first await.
  const handleDragEnd = async (e: React.DragEvent, tab: ColoredFileTab) => {
    const accepted = e.dataTransfer.dropEffect !== 'none';
    const capturedX = e.screenX;
    const capturedY = e.screenY;
    setDraggedTabId(null);
    const isReorder = reorderHappenedRef.current;
    reorderHappenedRef.current = false;
    if (accepted || isReorder || !tab.filePath) return;

    const store = useDashboardStore.getState();
    const workspaceId = tab.workspaceId ?? store.selectedWorkspaceId;
    if (!workspaceId) return; // no workspace context → can't seed the detached window

    // SAVE-BEFORE-DETACH: never lose a source-tab draft (Reviewer #1). On
    // cancel/failure, abort the detach and keep the dirty tab in the strip.
    const dirty = !!store.tabEditState[tab.id]?.dirty;
    if (dirty) {
      const saved = await store.saveTab(tab.id);
      if (!saved) return;
    }

    const res = await window.api.tabs.detach({
      filePath: tab.filePath,
      rootDirectory: tab.rootDirectory,
      pathType: tab.pathType,
      workspaceId,
      label: tab.label,
      x: capturedX,
      y: capturedY,
    });
    if (res.ok && !res.focusedExisting) {
      useDashboardStore.getState().detachTab(tab.id); // remove from main strip
    }
  };

  return (
    <div className="flex items-stretch tab-bar shrink-0 overflow-hidden">
      <div
        ref={scrollRef}
        className="flex items-stretch overflow-x-auto scrollbar-hide flex-1"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isDragging = tab.id === draggedTabId;
          const displayLabel = getDisplayLabel(tab, tabs);
          const dirty = !!tabEditState[tab.id]?.dirty;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              onClick={() => onSelectTab(tab.id)}
              onMouseDown={(e) => handleMouseDown(e, tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, tab });
              }}
              draggable
              onDragStart={(e) => handleDragStart(e, tab)}
              onDragEnd={(e) => handleDragEnd(e, tab)}
              onDragOver={(e) => handleDragOver(e, tab)}
              onDrop={(e) => {
                if (draggedTabId) e.preventDefault();
              }}
              className={`ui-tab shrink-0 max-w-[180px] group ${isActive ? 'ui-tab-active tab-active' : ''}`}
              style={{
                // Color-code marker: inset left border avoids layout shift
                boxShadow: tab.color ? `inset 3px 0 0 0 ${tab.color}` : undefined,
                opacity: isDragging ? 0.5 : undefined,
              }}
            >
              <span className="text-[13px] truncate select-none">
                {displayLabel}
              </span>
              {dirty && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-accent-blue-bright shrink-0"
                  title="Unsaved changes"
                />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
                className={`leading-none px-0.5 shrink-0 transition-colors hover:bg-white/10 ${
                  isActive ? '' : 'opacity-0 group-hover:opacity-100'
                }`}
                style={{ color: isActive ? 'var(--color-fg-secondary)' : 'var(--color-fg-muted)' }}
                title="Close tab"
              >
                <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor">
                  <path d="M1 1L9 9M9 1L1 9" strokeWidth="2" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
      {contextMenu && (
        <TabContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          tab={contextMenu.tab}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
