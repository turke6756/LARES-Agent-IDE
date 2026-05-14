import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useThemeStore } from '../../stores/theme-store';
import WorkspaceCreateDialog from '../workspace/WorkspaceCreateDialog';
import CollapseButton from './CollapseButton';
import * as Icons from 'lucide-react';
import DirectoryTreeNode from '../fileviewer/DirectoryTreeNode';
import type { DirectoryEntry, PathType } from '../../../shared/types';
import logoImg from '../../assets/logo.png';
import { useNamePrompt } from '../../hooks/useNamePrompt';
import { detectSyncFolder } from '../../../shared/sync-folder-detection';

function InlineWorkspaceTree({ rootPath, pathType, workspaceId }: { rootPath: string; pathType: PathType; workspaceId: string }) {
  const [rootEntries, setRootEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const cache = useRef(new Map<string, DirectoryEntry[]>());
  const openTab = useDashboardStore((s) => s.openTab);
  const checkHealth = useDashboardStore((s) => s.checkHealth);
  // Collapse to the active filePath primitive — only re-renders when that exact path changes.
  const activeFilePath = useDashboardStore(
    (s) => s.openTabs.find((t) => t.id === s.activeTabId)?.filePath ?? null
  );
  const { theme } = useThemeStore();
  const isLight = theme === 'light';
  const { prompt: promptName, modal: namePromptModal } = useNamePrompt();

  const reloadRoot = useCallback(async () => {
    setLoading(true);
    cache.current.delete(rootPath);
    const entries = await window.api.files.listDirectory(rootPath, pathType);
    cache.current.set(rootPath, entries);
    setRootEntries(entries);
    setLoading(false);
    if (pathType === 'wsl') {
      void checkHealth();
    }
  }, [rootPath, pathType, checkHealth]);

  const invalidateDir = useCallback((dirPath: string) => {
    cache.current.delete(dirPath);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    cache.current.clear();
    window.api.files.listDirectory(rootPath, pathType).then((entries) => {
      if (!cancelled) {
        cache.current.set(rootPath, entries);
        setRootEntries(entries);
        setLoading(false);
        if (pathType === 'wsl') {
          void checkHealth();
        }
      }
    });
    return () => { cancelled = true; };
  }, [rootPath, pathType, checkHealth]);

  const loadChildren = useCallback(async (dirPath: string): Promise<DirectoryEntry[]> => {
    const cached = cache.current.get(dirPath);
    if (cached) return cached;
    const entries = await window.api.files.listDirectory(dirPath, pathType);
    cache.current.set(dirPath, entries);
    if (pathType === 'wsl') {
      void checkHealth();
    }
    return entries;
  }, [pathType, checkHealth]);

  const handleFileSelect = useCallback((filePath: string) => {
    openTab(filePath, rootPath, pathType, undefined, workspaceId);
  }, [openTab, rootPath, pathType, workspaceId]);

  return (
    <div className={`pl-3 py-1 shadow-inner ${isLight ? 'bg-black/5' : 'bg-black/40'}`}>
      {loading ? (
        <div className="px-4 py-2 text-[13px] text-gray-300 font-sans animate-pulse">Loading...</div>
      ) : rootEntries.length === 0 ? (
        <div className="px-4 py-2 text-[13px] text-gray-300 font-sans">Empty directory</div>
      ) : (
        rootEntries.map((entry) => (
          <DirectoryTreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            activeFilePath={activeFilePath}
            pathType={pathType}
            workingDirectory={rootPath}
            onFileSelect={handleFileSelect}
            loadChildren={loadChildren}
            onTreeChanged={invalidateDir}
            onSiblingsChanged={reloadRoot}
            promptName={promptName}
          />
        ))
      )}
      {namePromptModal}
    </div>
  );
}

function HeatDot({ activeCount, workingCount }: { activeCount: number; workingCount: number }) {
  let colorClass = 'bg-gray-700';
  let pulse = false;

  if (activeCount === 0) {
    colorClass = 'bg-gray-700';
  } else if (workingCount === 0) {
    colorClass = 'bg-accent-blue';
  } else if (workingCount === 1) {
    colorClass = 'bg-accent-yellow';
  } else if (workingCount === 2) {
    colorClass = 'bg-accent-orange';
    pulse = true;
  } else {
    colorClass = 'bg-accent-red';
    pulse = true;
  }

  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${colorClass} ${pulse ? 'animate-pulse-fast' : ''}`}
    />
  );
}

interface SidebarProps {
  width: number;
}

export default function Sidebar({ width }: SidebarProps) {
  const workspaces = useDashboardStore((s) => s.workspaces);
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const health = useDashboardStore((s) => s.health);
  const healthChecking = useDashboardStore((s) => s.healthChecking);
  const workspaceHeat = useDashboardStore((s) => s.workspaceHeat);
  const panelLayout = useDashboardStore((s) => s.panelLayout);
  const selectWorkspace = useDashboardStore((s) => s.selectWorkspace);
  const loadWorkspaces = useDashboardStore((s) => s.loadWorkspaces);
  const deleteWorkspace = useDashboardStore((s) => s.deleteWorkspace);
  const togglePanelCollapsed = useDashboardStore((s) => s.togglePanelCollapsed);
  const resetLayout = useDashboardStore((s) => s.resetLayout);
  const checkHealth = useDashboardStore((s) => s.checkHealth);
  const { theme, toggleTheme } = useThemeStore();
  const [showCreate, setShowCreate] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; wsId: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());
  const menuRef = useRef<HTMLDivElement>(null);
  const collapsed = panelLayout.sidebarCollapsed;
  const wslState = health?.wslStatus?.state;
  const wslLabel = healthChecking
    ? 'Checking...'
    : wslState === 'running'
      ? 'WSL Running'
      : wslState === 'stopped'
        ? 'WSL Stopped'
        : wslState === 'no-distro'
          ? 'No WSL distro'
          : wslState === 'unavailable'
            ? 'WSL Unavailable'
            : 'WSL Unknown';
  const wslStatusClass = healthChecking
    ? 'text-accent-blue animate-pulse'
    : wslState === 'running'
      ? 'text-accent-green'
      : wslState === 'stopped'
        ? 'text-gray-500'
        : wslState === 'no-distro'
          ? 'text-accent-orange'
          : 'text-accent-red';

  const toggleWorkspace = (wsId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setExpandedWorkspaces(prev => {
      const next = new Set(prev);
      if (next.has(wsId)) next.delete(wsId);
      else next.add(wsId);
      return next;
    });
  };

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
        setConfirmDelete(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextMenu]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);

    const files = e.dataTransfer.files;
    if (!files.length) return;

    const folderPath = (files[0] as any).path as string;
    if (!folderPath) return;

    const pathType = folderPath.startsWith('/') ? 'wsl' as const : 'windows' as const;
    const segments = folderPath.replace(/\\/g, '/').split('/').filter(Boolean);
    const title = segments[segments.length - 1] || 'Workspace';

    const syncHit = detectSyncFolder(folderPath);
    if (syncHit) {
      console.warn(
        `[workspace] ${folderPath} is inside ${syncHit.provider} — ` +
        `per-workspace state may tear across syncs. See docs/PERSISTENCE_HARDENING.md`
      );
    }

    try {
      const ws = await window.api.workspaces.create({ title, path: folderPath, pathType });
      await loadWorkspaces();
      selectWorkspace(ws.id);
    } catch (err) {
      console.error('Failed to create workspace from drop:', err);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, wsId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setConfirmDelete(null);
    setContextMenu({ x: e.clientX, y: e.clientY, wsId });
  };

  const handleDelete = async (wsId: string) => {
    setContextMenu(null);
    setConfirmDelete(null);
    await deleteWorkspace(wsId);
  };

  // Collapsed sidebar: thin strip with expand button
  if (collapsed) {
    return (
      <div
        className="panel-shell flex flex-col items-center z-20 py-2"
        style={{ width }}
      >
        <CollapseButton collapsed direction="left" onClick={() => togglePanelCollapsed('sidebarCollapsed')} />
        <div className="mt-2 text-[13px] font-sans text-accent-blue writing-mode-vertical" style={{ writingMode: 'vertical-rl' }}>
          Workspaces
        </div>
      </div>
    );
  }

  return (
    <div
      className="panel-shell flex flex-col z-20"
      style={{ width }}
    >
      {/* Header */}
      <div className="panel-header p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src={logoImg} alt="Logo" className="h-10 object-contain" />
            <span className="text-[13px] font-medium dark:text-gray-300 text-gray-700">Agent Dashboard</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={resetLayout}
              className="ui-btn ui-btn-ghost min-h-0 px-2 py-1 text-[12px]"
              title="Reset all panel sizes to defaults"
            >
              Reset
            </button>
            <button
              onClick={toggleTheme}
              className="ui-btn ui-btn-ghost min-h-0 px-2 py-1 text-[12px]"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? 'Light' : 'Dark'}
            </button>
            <CollapseButton collapsed={false} direction="left" onClick={() => togglePanelCollapsed('sidebarCollapsed')} />
          </div>
        </div>
      </div>

      {/* Workspaces */}
      <div
        className={`flex-1 overflow-y-auto p-2 transition-colors scrollbar-hide ${
          dragOver ? 'bg-accent-blue/10 border-2 border-dashed border-accent-blue/40' : ''
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex items-center justify-between px-2 py-2 mb-1 border-b border-surface-3">
          <span className="ui-section-header">
            Workspaces
          </span>
          <button
            onClick={() => setShowCreate(true)}
            className="ui-btn ui-btn-primary h-8 w-8 p-0"
            title="Add Workspace"
          >
            <Icons.Plus className="w-5 h-5 stroke-[2.5]" />
          </button>
        </div>

        <div className="space-y-1">
          {workspaces.map((ws) => {
            const heat = workspaceHeat[ws.id];
            const isSelected = selectedWorkspaceId === ws.id;
            const isExpanded = expandedWorkspaces.has(ws.id);

            return (
              <div key={ws.id}>
                <button
                  onClick={() => selectWorkspace(ws.id)}
                  onDoubleClick={(e) => toggleWorkspace(ws.id, e)}
                  onContextMenu={(e) => handleContextMenu(e, ws.id)}
                  className={`w-full text-left px-3 py-2 group transition-colors flex flex-col border-l-2 ${
                    isSelected
                      ? 'border-l-accent-blue-bright tree-row-selected'
                      : 'border-l-transparent hover:bg-white/[0.04]'
                  }`}
                  style={!isSelected ? { color: 'var(--color-fg-primary)' } : undefined}
                >
                  <div className="flex items-center gap-1 w-full mb-0.5">
                    <div
                      className="p-0.5 shrink-0 cursor-pointer transition-colors"
                      style={{ color: isSelected ? 'var(--color-fg-bright)' : 'var(--color-fg-secondary)' }}
                      onClick={(e) => toggleWorkspace(ws.id, e)}
                    >
                      {isExpanded ? <Icons.ChevronDown className="w-3.5 h-3.5" /> : <Icons.ChevronRight className="w-3.5 h-3.5" />}
                    </div>
                    <span className="flex-1 text-[13px] font-medium truncate">
                      {ws.title}
                    </span>
                    {detectSyncFolder(ws.path) && (
                      <span
                        className="ml-1 inline-block rounded bg-yellow-500/15 px-1 text-[10px] text-yellow-300"
                        title={`Inside ${detectSyncFolder(ws.path)!.provider} — sync may tear agent files`}
                      >
                        ⚠
                      </span>
                    )}
                    {heat && <HeatDot activeCount={heat.activeCount} workingCount={heat.workingCount} />}
                  </div>

                  <div
                    className="flex items-center text-[11px] pl-5"
                    style={{ color: isSelected ? 'rgba(255,255,255,0.75)' : 'var(--color-fg-secondary)' }}
                  >
                    <span className={`mr-2 ${ws.pathType === 'wsl' ? 'text-accent-orange' : 'text-accent-blue-bright'}`}>
                      {ws.pathType}
                    </span>
                    <span className="truncate max-w-[120px]">{ws.path}</span>
                  </div>
                </button>
                {isExpanded && (
                  <InlineWorkspaceTree rootPath={ws.path} pathType={ws.pathType} workspaceId={ws.id} />
                )}
              </div>
            );
          })}
        </div>

        {dragOver && (
          <div className="mt-4 px-3 py-4 text-center border border-dashed border-accent-blue text-accent-blue/70 text-[13px] font-sans animate-pulse">
            Drop folder here to add workspace
          </div>
        )}

        {workspaces.length === 0 && !dragOver && (
          <div className="px-3 py-12 text-center text-gray-400 text-[13px] font-sans">
            No workspaces found
            <br />
            <button
              onClick={() => setShowCreate(true)}
              className="ui-btn ui-btn-primary mt-4"
            >
              Add Workspace
            </button>
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="ui-menu fixed z-50"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="ui-menu-header">
            Workspace Options
          </div>
          {confirmDelete === contextMenu.wsId ? (
            <div className="px-3 py-2">
              <p className="text-[13px] text-accent-red mb-2">Confirm delete?</p>
              <div className="flex gap-2">
                <button
                  onClick={() => handleDelete(contextMenu.wsId)}
                  className="ui-btn ui-btn-danger px-3 py-1.5 text-[13px]"
                >
                  Yes
                </button>
                <button
                  onClick={() => { setConfirmDelete(null); setContextMenu(null); }}
                  className="ui-btn ui-btn-ghost px-3 py-1.5 text-[13px]"
                >
                  No
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                onClick={() => {
                  window.api.workspaces.openInVSCode(contextMenu.wsId);
                  setContextMenu(null);
                }}
                className="ui-menu-item"
              >
                Open VS Code
              </button>
              <div className="ui-menu-divider" />
              <button
                onClick={() => setConfirmDelete(contextMenu.wsId)}
                className="ui-menu-item text-accent-red"
              >
                Delete Workspace
              </button>
            </>
          )}
        </div>
      )}

      {/* Footer Status Ticker */}
      <div className="panel-header p-2 text-[13px] font-sans text-gray-300 flex justify-between items-center gap-2">
        {health ? (
          <>
            <div className="flex gap-2 min-w-0">
              <span className={health.claudeWindowsAvailable ? 'text-accent-green' : 'text-gray-700'}>Win</span>
              <span className={health.wslStatus.state === 'running' ? 'text-accent-green' : 'text-gray-700'}>WSL</span>
              <span className={health.tmuxAvailable ? 'text-accent-green' : 'text-gray-700'}>Tmux</span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <span className={`truncate max-w-[120px] ${wslStatusClass}`} title={health.wslStatus.error || wslLabel}>
                {wslLabel}
              </span>
              <button
                onClick={() => void checkHealth()}
                disabled={healthChecking}
                className="p-1 rounded text-gray-500 hover:text-accent-blue hover:bg-white/5 transition-colors disabled:opacity-50"
                title="Refresh WSL status"
              >
                <Icons.RefreshCw className={`w-3.5 h-3.5 ${healthChecking ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-between w-full">
            <span className="text-accent-blue animate-pulse">Checking...</span>
            <button
              onClick={() => void checkHealth()}
              disabled={healthChecking}
              className="p-1 rounded text-gray-500 hover:text-accent-blue hover:bg-white/5 transition-colors disabled:opacity-50"
              title="Refresh WSL status"
            >
              <Icons.RefreshCw className={`w-3.5 h-3.5 ${healthChecking ? 'animate-spin' : ''}`} />
            </button>
          </div>
        )}
      </div>

      {showCreate && <WorkspaceCreateDialog onClose={() => setShowCreate(false)} />}
    </div>
  );
}
