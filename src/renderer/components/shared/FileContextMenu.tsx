import React, { useRef, useEffect } from 'react';
import type { PathType } from '../../../shared/types';

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
  onCreateFile?: () => void;
  onCreateMarkdownFile?: () => void;
  onCreateFolder?: () => void;
  onCreateNotebook?: () => void;
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
  onCreateFile, onCreateMarkdownFile, onCreateFolder, onCreateNotebook, onRename, onDelete,
  sortMode, onSortModeChange,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

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
      className="ui-menu fixed z-50"
      style={{ left: x, top: y }}
    >
      <div className="ui-menu-header">
        File Operations
      </div>
      <button onClick={handleCopyPath} className="ui-menu-item">
        Copy Path
      </button>
      <button onClick={handleCopyRelativePath} className="ui-menu-item">
        Copy Relative Path
      </button>
      <div className="ui-menu-divider" />
      {isDirectory && (
        <>
          <button onClick={() => runAction(onCreateFile)} className="ui-menu-item">
            New File...
          </button>
          <button onClick={() => runAction(onCreateMarkdownFile)} className="ui-menu-item">
            New Markdown File...
          </button>
          <button onClick={() => runAction(onCreateNotebook)} className="ui-menu-item">
            New Notebook...
          </button>
          <button onClick={() => runAction(onCreateFolder)} className="ui-menu-item">
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
              <span className="inline-block w-3.5">{sortMode === mode ? '✓' : ''}</span>
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
              Rename...
            </button>
          )}
          {onDelete && (
            <button onClick={() => runAction(onDelete)} className="ui-menu-item text-accent-red">
              Delete...
            </button>
          )}
          <div className="ui-menu-divider" />
        </>
      )}
      <button onClick={handleOpenInVSCode} className="ui-menu-item">
        Open in VS Code
      </button>
      <button onClick={handleRevealInExplorer} className="ui-menu-item">
        Reveal in Explorer
      </button>
      {showRevealInTree && onRevealInTree && (
        <>
          <div className="ui-menu-divider" />
          <button onClick={handleRevealInTree} className="ui-menu-item">
            Reveal in Tree
          </button>
        </>
      )}
    </div>
  );
}
