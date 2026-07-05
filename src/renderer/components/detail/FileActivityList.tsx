import React, { useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { FileActivity, PathType } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import FileContextMenu from '../shared/FileContextMenu';
import { fileDragStart } from '../../utils/drag-file';

interface Props {
  activities: FileActivity[];
  pathType?: PathType;
  agentId?: string;
  title?: string;
  embedded?: boolean;
}

interface GroupedActivity {
  activity: FileActivity;
  count: number;
  // True when this row belongs to a PRIOR session (session_id != the agent's
  // live session). Drives the shared out-of-context dim + "previous session"
  // badge so retained history reads as history, not live context.
  prior: boolean;
}

function timeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp + 'Z').getTime();
  const diffMs = now - then;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function fileName(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

function dirPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return '';
  return normalized.substring(0, lastSlash);
}

function operationBadge(op: string): { label: string; className: string } {
  switch (op) {
    case 'read':
      return { label: 'read', className: 'bg-blue-500/20 text-blue-400' };
    case 'create':
      return { label: 'created', className: 'bg-green-500/20 text-green-400' };
    case 'write':
      return { label: 'modified', className: 'bg-yellow-500/20 text-yellow-400' };
    default:
      return { label: op, className: 'bg-gray-500/20 text-gray-400' };
  }
}

// Group activities by file, keeping the most recent per file + op and counting
// duplicates. Activities arrive newest-first, so the first row encountered per
// key is the most recent. The key folds in session_id AND generation so a prior
// read and a current read of the SAME file stay distinct rows rather than
// collapsing — the whole point of retaining prior-session activity. Rows whose
// session differs from `liveSessionId` are marked `prior` (legacy NULL-session
// rows are treated as current so a one-time migration doesn't dim everything).
// Current rows sort above prior ones, recency preserved within each band.
export function groupByFile(activities: FileActivity[], liveSessionId: string | null): GroupedActivity[] {
  const seen = new Map<string, GroupedActivity>();
  for (const a of activities) {
    const key = `${a.filePath}:${a.operation}:${a.sessionId ?? ''}:${a.generation}`;
    const existing = seen.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      const prior = a.sessionId != null && a.sessionId !== liveSessionId;
      seen.set(key, { activity: a, count: 1, prior });
    }
  }
  const groups = Array.from(seen.values());
  // Stable partition: current band first, prior band after.
  return [...groups.filter((g) => !g.prior), ...groups.filter((g) => g.prior)];
}

export default function FileActivityList({ activities, pathType, agentId, title, embedded }: Props) {
  const openFileViewer = useDashboardStore((s) => s.openFileViewer);
  // Narrow to just this agent + its workspace — re-renders only when those specific entries change.
  const { agent, workspace } = useDashboardStore(
    useShallow((s) => {
      const a = agentId ? s.agents.find((x) => x.id === agentId) ?? null : null;
      const w = a ? s.workspaces.find((x) => x.id === a.workspaceId) ?? null : null;
      return { agent: a, workspace: w };
    }),
  );
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; filePath: string } | null>(null);
  // The agent's live session is its current resume session id; any activity
  // stamped under a different session is prior (out-of-context) history.
  const liveSessionId = agent?.resumeSessionId ?? null;
  const grouped = useMemo(() => groupByFile(activities, liveSessionId), [activities, liveSessionId]);

  const workingDirectory = agent?.workingDirectory || '';
  const resolvedPathType = workspace?.pathType || pathType || 'wsl';

  if (grouped.length === 0) {
    if (embedded) return null;
    return (
      <div className="px-4 py-8 text-center text-gray-400 text-sm">
        No file activity yet...
      </div>
    );
  }

  const openInWorkspaceVSCode = (filePath: string) => {
    if (workingDirectory) {
      window.api.system.openFileInWorkspace(filePath, workingDirectory, resolvedPathType);
    } else {
      window.api.system.openFile(filePath, resolvedPathType);
    }
  };

  const handleClick = (filePath: string) => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
      return; // double-click already fired
    }
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      if (agentId) {
        openFileViewer(filePath, agentId);
      } else {
        window.api.system.openFile(filePath, resolvedPathType);
      }
    }, 250);
  };

  const handleDoubleClick = (filePath: string) => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    openInWorkspaceVSCode(filePath);
  };

  const handleContextMenu = (e: React.MouseEvent, filePath: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, filePath });
  };

  const handleRevealInTree = () => {
    if (agentId && contextMenu) {
      openFileViewer(contextMenu.filePath, agentId);
    }
  };

  const handleVSCode = (e: React.MouseEvent, filePath: string) => {
    e.stopPropagation();
    openInWorkspaceVSCode(filePath);
  };

  const outerClass = embedded ? '' : 'flex-1 overflow-y-auto';

  return (
    <div className={outerClass}>
      {title && (
        <div className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide uppercase text-gray-400">
          {title}
        </div>
      )}
      {grouped.map(({ activity, count, prior }) => {
        const badge = operationBadge(activity.operation);
        return (
          <button
            key={`${activity.filePath}-${activity.operation}-${activity.id}`}
            onClick={() => handleClick(activity.filePath)}
            onDoubleClick={() => handleDoubleClick(activity.filePath)}
            onContextMenu={(e) => handleContextMenu(e, activity.filePath)}
            draggable
            onDragStart={(e) => fileDragStart(e, activity.filePath)}
            className={`w-full text-left px-4 py-2 hover:bg-surface-2 transition-colors flex items-start gap-2 group${
              prior ? ' oo-content' : ''
            }`}
          >
            <span className="text-gray-300 text-sm mt-0.5 shrink-0">
              {activity.operation === 'read' ? '📖' : activity.operation === 'create' ? '📝' : '✏️'}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-200 truncate group-hover:text-white">
                  {fileName(activity.filePath)}
                </span>
                {count > 1 && (
                  <span className="text-[11px] text-gray-400 shrink-0" title={`${count} ${activity.operation} events`}>
                    ×{count}
                  </span>
                )}
                <span className={`text-[11px] px-1.5 py-0.5 shrink-0 ${badge.className}`}>
                  {badge.label}
                </span>
                {prior && (
                  <span
                    className="oo-badge shrink-0"
                    title={`Touched in a previous session (gen ${activity.generation}) — not in the current context`}
                  >
                    previous session
                  </span>
                )}
              </div>
              <div className="text-[13px] text-gray-400 truncate">{dirPath(activity.filePath)}</div>
            </div>
            <span
              onClick={(e) => handleVSCode(e, activity.filePath)}
              className="text-[11px] text-gray-600 hover:text-accent-blue opacity-0 group-hover:opacity-100 transition-all shrink-0 mt-0.5 px-1 cursor-pointer"
              title="Open in VS Code"
            >
              VS
            </span>
            <span className="text-[13px] text-gray-400 shrink-0 mt-1">
              {timeAgo(activity.timestamp)}
            </span>
          </button>
        );
      })}

      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          filePath={contextMenu.filePath}
          workingDirectory={workingDirectory}
          pathType={resolvedPathType}
          isDirectory={false}
          showRevealInTree={!!agentId}
          onClose={() => setContextMenu(null)}
          onRevealInTree={handleRevealInTree}
        />
      )}
    </div>
  );
}
