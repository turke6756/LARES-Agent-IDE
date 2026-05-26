import React, { useRef, useEffect, useState } from 'react';
import type { FileTab } from '../../../shared/types';
import { fileDragStart } from '../../utils/drag-file';
import { useDashboardStore } from '../../stores/dashboard-store';
import FileContextMenu from '../shared/FileContextMenu';

interface Props {
  tabs: FileTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
}

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

export default function FileTabBar({ tabs, activeTabId, onSelectTab, onCloseTab }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabEditState = useDashboardStore((state) => state.tabEditState);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tab: FileTab } | null>(null);

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

  return (
    <div className="flex items-stretch tab-bar shrink-0 overflow-hidden">
      <div
        ref={scrollRef}
        className="flex items-stretch overflow-x-auto scrollbar-hide flex-1"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const displayLabel = getDisplayLabel(tab, tabs);
          const dirty = !!tabEditState[tab.id]?.dirty;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              onClick={() => onSelectTab(tab.id)}
              onMouseDown={(e) => handleMouseDown(e, tab.id)}
              onContextMenu={(e) => {
                if (!tab.filePath) return;
                e.preventDefault();
                setContextMenu({ x: e.clientX, y: e.clientY, tab });
              }}
              draggable={!!tab.filePath}
              onDragStart={(e) => { if (tab.filePath) fileDragStart(e, tab.filePath); }}
              className={`ui-tab shrink-0 max-w-[180px] group ${isActive ? 'ui-tab-active tab-active' : ''}`}
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
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          filePath={contextMenu.tab.filePath}
          workingDirectory={contextMenu.tab.rootDirectory}
          pathType={contextMenu.tab.pathType}
          isDirectory={false}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
