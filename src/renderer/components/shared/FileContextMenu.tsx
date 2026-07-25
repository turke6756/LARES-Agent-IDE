import React, { useRef, useEffect, useLayoutEffect, useState } from 'react';
import {
  Check,
  Code2,
  Copy,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  History,
  ListTree,
  Pencil,
  Trash2,
} from 'lucide-react';
import type { PathType } from '../../../shared/types';
import { positionFloating } from '../../lib/floating/positionFloating';

export type TreeSortMode = 'name' | 'modified' | 'created';

export const SORT_OPTIONS: { mode: TreeSortMode; label: string }[] = [
  { mode: 'name', label: 'Name' },
  { mode: 'modified', label: 'Last Edited' },
  { mode: 'created', label: 'Created' },
];

interface Props {
  x: number;
  y: number;
  filePath: string;
  workingDirectory: string;
  pathType: PathType;
  isDirectory: boolean;
  showRevealInTree?: boolean;
  onClose: () => void;
  onRevealInTree?: () => void;
  /** WP-G3.1 — file right-click → History. When provided (files only), a "History"
   *  item opens the per-turn/per-agent version list (view/diff/restore one path). */
  onShowHistory?: () => void;
  onCreateFile?: () => void;
  onCreateFolder?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  sortMode?: TreeSortMode;
  onSortModeChange?: (mode: TreeSortMode) => void;
}

function getRelativePath(filePath: string, workingDirectory: string): string {
  const normFile = filePath.replace(/\\/g, '/');
  const normDir = workingDirectory.replace(/\\/g, '/').replace(/\/$/, '');
  if (normFile.startsWith(normDir + '/')) {
    return normFile.substring(normDir.length + 1);
  }
  return normFile;
}

export default function FileContextMenu({
  x, y, filePath, workingDirectory, pathType, isDirectory, showRevealInTree, onClose, onRevealInTree,
  onShowHistory,
  onCreateFile, onCreateFolder, onRename, onDelete,
  sortMode, onSortModeChange,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() =>
    positionFloating(
      { x, y, width: 0, height: 0 },
      { width: 220, height: 420 },
      { width: window.innerWidth, height: window.innerHeight },
      { placement: 'below', gap: 0 },
    ),
  );

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setPos(positionFloating(
      { x, y, width: 0, height: 0 },
      { width: box.width || 220, height: box.height || 420 },
      { width: window.innerWidth, height: window.innerHeight },
      { placement: 'below', gap: 0 },
    ));
  }, [x, y]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleCopyPath = () => {
    navigator.clipboard.writeText(filePath);
    onClose();
  };

  const handleCopyRelativePath = () => {
    const rel = getRelativePath(filePath, workingDirectory);
    navigator.clipboard.writeText(rel);
    onClose();
  };

  const handleOpenInVSCode = () => {
    window.api.system.openFileInWorkspace(filePath, workingDirectory, pathType);
    onClose();
  };

  const handleRevealInExplorer = async () => {
    onClose();
    const result = await window.api.files.reveal(filePath, pathType);
    if (!result.ok) window.alert(result.error);
  };

  const handleRevealInTree = () => {
    onRevealInTree?.();
    onClose();
  };

  const runAction = (action?: () => void) => {
    action?.();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="ui-menu fixed z-50 overflow-y-auto"
      style={{ left: pos.left, top: pos.top, minWidth: 220, maxHeight: 'calc(100vh - 16px)' }}
    >
      <div className="ui-menu-header">
        File Operations
      </div>
      <button onClick={handleCopyPath} className="ui-menu-item">
        <Copy className="ui-menu-icon" aria-hidden="true" />
        Copy Path
      </button>
      <button onClick={handleCopyRelativePath} className="ui-menu-item">
        <Copy className="ui-menu-icon" aria-hidden="true" />
        Copy Relative Path
      </button>
      {!isDirectory && onShowHistory && (
        <button onClick={() => runAction(onShowHistory)} className="ui-menu-item" data-testid="ctx-history">
          <History className="ui-menu-icon" aria-hidden="true" />
          History
        </button>
      )}
      <div className="ui-menu-divider" />
      {isDirectory && (
        <>
          <button onClick={() => runAction(onCreateFile)} className="ui-menu-item">
            <FilePlus2 className="ui-menu-icon" aria-hidden="true" />
            New File...
          </button>
          <button onClick={() => runAction(onCreateFolder)} className="ui-menu-item">
            <FolderPlus className="ui-menu-icon" aria-hidden="true" />
            New Folder...
          </button>
          <div className="ui-menu-divider" />
        </>
      )}
      {isDirectory && sortMode && onSortModeChange && (
        <>
          <div className="ui-menu-header">
            Sort Files By
          </div>
          {SORT_OPTIONS.map(({ mode, label }) => (
            <button
              key={mode}
              onClick={() => runAction(() => onSortModeChange(mode))}
              className="ui-menu-item"
            >
              <span className="ui-menu-icon" aria-hidden="true">
                {sortMode === mode && <Check className="w-3.5 h-3.5" />}
              </span>
              {label}
            </button>
          ))}
          <div className="ui-menu-divider" />
        </>
      )}
      {(onRename || onDelete) && (
        <>
          {onRename && (
            <button onClick={() => runAction(onRename)} className="ui-menu-item">
              <Pencil className="ui-menu-icon" aria-hidden="true" />
              Rename...
            </button>
          )}
          {onDelete && (
            <button onClick={() => runAction(onDelete)} className="ui-menu-item text-accent-red">
              <Trash2 className="ui-menu-icon" aria-hidden="true" />
              Delete...
            </button>
          )}
          <div className="ui-menu-divider" />
        </>
      )}
      <button onClick={handleOpenInVSCode} className="ui-menu-item">
        <Code2 className="ui-menu-icon" aria-hidden="true" />
        Open in VS Code
      </button>
      <button onClick={handleRevealInExplorer} className="ui-menu-item">
        <FolderOpen className="ui-menu-icon" aria-hidden="true" />
        Reveal in Explorer
      </button>
      {showRevealInTree && onRevealInTree && (
        <>
          <div className="ui-menu-divider" />
          <button onClick={handleRevealInTree} className="ui-menu-item">
            <ListTree className="ui-menu-icon" aria-hidden="true" />
            Reveal in Tree
          </button>
        </>
      )}
    </div>
  );
}
