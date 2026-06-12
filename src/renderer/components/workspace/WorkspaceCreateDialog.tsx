import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useBrowserSuspension } from '../browser/useBrowserSuspension';
import type { PathType } from '../../../shared/types';
import { detectSyncFolder } from '../../../shared/sync-folder-detection';

function uncToLinuxPath(p: string): string | null {
  const match = p.match(/^\\\\wsl[\.\$][^\\]*\\[^\\]+(\\.*)/i);
  if (!match) return null;
  return match[1].replace(/\\/g, '/');
}

export default function WorkspaceCreateDialog({ onClose }: { onClose: () => void }) {
  // The browser WebContentsView paints above this dialog — hide it while open.
  useBrowserSuspension();
  const { loadWorkspaces, selectWorkspace } = useDashboardStore();
  const [title, setTitle] = useState('');
  const [dirPath, setDirPath] = useState('');
  const [pathType, setPathType] = useState<PathType>('windows');
  const [description, setDescription] = useState('');

  const handlePickDir = async () => {
    const dir = await window.api.system.pickDirectory(pathType === 'wsl');
    if (dir) {
      const linuxPath = uncToLinuxPath(dir);
      if (linuxPath) {
        setDirPath(linuxPath);
        setPathType('wsl');
      } else if (dir.startsWith('/')) {
        setDirPath(dir);
        setPathType('wsl');
      } else {
        setDirPath(dir);
        setPathType('windows');
      }
      if (!title) {
        const name = dir.split(/[/\\]/).filter(Boolean).pop() || '';
        setTitle(name);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !dirPath.trim()) return;

    let finalPath = dirPath.trim();
    const linuxPath = uncToLinuxPath(finalPath);
    const finalPathType = linuxPath ? 'wsl' as PathType : pathType;
    if (linuxPath) finalPath = linuxPath;

    const ws = await window.api.workspaces.create({
      title: title.trim(),
      path: finalPath,
      pathType: finalPathType,
      description: description.trim() || undefined,
    });
    await loadWorkspaces();
    selectWorkspace(ws.id);
    onClose();
  };

  const syncHit = detectSyncFolder(dirPath);

  return createPortal(
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="panel-shell w-[440px] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[13px] font-semibold mb-3">New Workspace</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Directory</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={dirPath}
                onChange={(e) => {
                  const val = e.target.value;
                  setDirPath(val);
                  if (val.startsWith('/') || /^\\\\wsl[\.\$]/i.test(val)) {
                    setPathType('wsl');
                  } else if (/^[A-Za-z]:/.test(val)) {
                    setPathType('windows');
                  }
                }}
                onBlur={() => {
                  const linuxPath = uncToLinuxPath(dirPath);
                  if (linuxPath) {
                    setDirPath(linuxPath);
                    setPathType('wsl');
                  }
                }}
                className="ui-input flex-1 text-[13px]"
                placeholder={pathType === 'wsl' ? '/home/user/project' : 'C:\\Projects\\myapp'}
              />
              <button
                type="button"
                onClick={handlePickDir}
                className="ui-btn text-[13px]"
                title={pathType === 'wsl' ? 'Browse (opens at \\\\wsl.localhost)' : 'Browse for directory'}
              >
                Browse
              </button>
            </div>
            {pathType === 'wsl' && (
              <p className="text-[11px] text-gray-500 mt-1">
                Paste a UNC path (\\wsl.localhost\...) or type a Linux path (/home/...)
              </p>
            )}
          </div>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Path Type</label>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setPathType('windows')}
                className={`ui-btn flex-1 text-[13px] ${
                  pathType === 'windows'
                    ? 'bg-accent-blue/15 text-accent-blue border-accent-blue/40'
                    : ''
                }`}
              >
                Windows
              </button>
              <button
                type="button"
                onClick={() => setPathType('wsl')}
                className={`ui-btn flex-1 text-[13px] ${
                  pathType === 'wsl'
                    ? 'bg-accent-orange/15 text-accent-orange border-accent-orange/40'
                    : ''
                }`}
              >
                WSL
              </button>
            </div>
          </div>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Title *</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="ui-input text-[13px]"
              placeholder="My Project"
            />
          </div>

          <div>
            <label className="block text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="ui-input text-[13px]"
              placeholder="Optional description"
            />
          </div>

          {syncHit && (
            <div className="rounded border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-[12px] text-yellow-200">
              This folder is inside {syncHit.provider}. The dashboard's own database is
              stored under <code>%APPDATA%</code> and is safe. But per-workspace agent
              state and supervisor files written here may be uploaded mid-write by{' '}
              {syncHit.provider}, leading to torn syncs across machines. Recommended:
              use a workspace outside synced folders for active agent work.
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="ui-btn ui-btn-ghost px-3 py-1.5 text-[13px]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || !dirPath.trim()}
              className="ui-btn ui-btn-primary px-3 py-1.5 text-[13px]"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
