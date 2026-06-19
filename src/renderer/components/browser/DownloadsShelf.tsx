import React from 'react';
import * as Icons from 'lucide-react';
import {
  useBrowserStore,
  type BrowserDownload,
  type BrowserDownloadState,
} from '../../stores/browser-store';

// ── Downloads shelf (Slice 13 — user-only downloads) ─────────────────────────
// A slim strip in the browser chrome zone (BrowserPanel renders it below the
// host) listing download records: filename + origin + progress/state, with
// per-row actions (Open file / Show in folder / Retry / Remove). A USER
// download is blocked in main pending a trusted-chrome confirmation — when
// `pendingDownloadPrompt` is set we surface a confirm affordance whose Download
// button calls confirmDownload (→ downloadConfirm with the one-shot token).
//
// Occlusion note: like the DenialToast, this lives in the chrome zone (a flex
// sibling OUTSIDE the WebContentsView host bounds), so it needs no pane
// suspension — it never overlaps the live page. The shelf hides entirely when
// there's nothing to show (no records AND no pending prompt).

/** Human-readable byte size (1023 B, 4.2 KB, 12.0 MB, …). */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** Progress / state summary line for one record. */
function progressLabel(d: BrowserDownload): string {
  switch (d.state) {
    case 'in-progress':
      return d.totalBytes > 0
        ? `${formatBytes(d.bytesReceived)} of ${formatBytes(d.totalBytes)}`
        : `${formatBytes(d.bytesReceived)} downloaded`;
    case 'completed':
      return formatBytes(d.bytesReceived || d.totalBytes);
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return '';
  }
}

const STATE_ICON: Record<BrowserDownloadState, keyof typeof Icons> = {
  'in-progress': 'Loader',
  completed: 'CheckCircle2',
  failed: 'AlertCircle',
  cancelled: 'XCircle',
};

const STATE_TINT: Record<BrowserDownloadState, string> = {
  'in-progress': 'text-accent-blue',
  completed: 'text-accent-green',
  failed: 'text-accent-red',
  cancelled: 'text-fg-muted',
};

function DownloadRow({ d }: { d: BrowserDownload }) {
  const openDownloadFile = useBrowserStore((s) => s.openDownloadFile);
  const showDownloadInFolder = useBrowserStore((s) => s.showDownloadInFolder);
  const retryDownload = useBrowserStore((s) => s.retryDownload);
  const removeDownload = useBrowserStore((s) => s.removeDownload);

  const StateIcon = Icons[STATE_ICON[d.state]] as React.ComponentType<{ className?: string }>;
  const pct =
    d.state === 'in-progress' && d.totalBytes > 0
      ? Math.min(100, Math.round((d.bytesReceived / d.totalBytes) * 100))
      : null;
  const canRetry = d.state === 'failed' || d.state === 'cancelled';
  const canOpen = d.state === 'completed';

  return (
    <div
      data-testid="download-row"
      className="browser-chip w-full min-w-0 gap-2.5 px-3 py-2"
    >
      <StateIcon className={`w-4 h-4 shrink-0 ${STATE_TINT[d.state]}`} />
      <div className="flex-1 min-w-0 flex flex-col">
        <span
          className="text-[12px] text-[var(--color-fg-primary)] truncate"
          title={`${d.filename}\n${d.url}`}
        >
          {d.filename}
        </span>
        <span className="text-[10px] text-[var(--color-fg-secondary)] truncate">
          {d.origin || '—'} · {progressLabel(d)}
        </span>
        {pct !== null && (
          <span className="mt-1 h-1 w-full rounded-full bg-[var(--color-browser-chrome-1)] overflow-hidden">
            <span
              data-testid="download-progress-bar"
              className="block h-full bg-accent-blue transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        {canOpen && (
          <button
            onClick={() => openDownloadFile(d.id)}
            className="ui-btn ui-btn-ghost p-1"
            title="Open file"
            aria-label="Open file"
          >
            <Icons.FileText className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={() => showDownloadInFolder(d.id)}
          className="ui-btn ui-btn-ghost p-1"
          title="Show in folder"
          aria-label="Show in folder"
        >
          <Icons.FolderOpen className="w-3.5 h-3.5" />
        </button>
        {canRetry && (
          <button
            onClick={() => retryDownload(d.id)}
            className="ui-btn ui-btn-ghost p-1"
            title="Retry"
            aria-label="Retry"
          >
            <Icons.RefreshCw className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={() => removeDownload(d.id)}
          className="ui-btn ui-btn-ghost p-1"
          title="Remove from list (keeps the file)"
          aria-label="Remove"
        >
          <Icons.X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

/** USER-download confirm affordance — main blocked the write pending human
 *  approval (never auto-allowed). Download calls confirmDownload (one-shot
 *  token → downloadConfirm); Decline just clears the prompt. */
function ConfirmPrompt() {
  const prompt = useBrowserStore((s) => s.pendingDownloadPrompt);
  const confirmDownload = useBrowserStore((s) => s.confirmDownload);
  const dismissDownloadPrompt = useBrowserStore((s) => s.dismissDownloadPrompt);
  if (!prompt) return null;
  return (
    <div
      role="alertdialog"
      aria-label="Confirm download"
      className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-accent-blue/10 border border-accent-blue/30 min-w-0"
    >
      <Icons.Download className="w-4 h-4 text-accent-blue shrink-0" />
      <div className="flex-1 min-w-0 flex flex-col">
        <span className="text-[12px] text-[var(--color-fg-primary)] truncate" title={prompt.url}>
          Download <span className="font-semibold">{prompt.filename}</span>?
        </span>
        <span className="text-[10px] text-[var(--color-fg-secondary)] truncate">
          {prompt.origin || '—'}
        </span>
      </div>
      <button
        onClick={() => confirmDownload()}
        className="ui-btn ui-btn-primary px-2.5 py-0.5 text-[11px] shrink-0"
      >
        Download
      </button>
      <button
        onClick={() => dismissDownloadPrompt()}
        className="ui-btn ui-btn-ghost px-2 py-0.5 text-[11px] shrink-0"
      >
        Decline
      </button>
    </div>
  );
}

export default function DownloadsShelf() {
  const downloads = useBrowserStore((s) => s.downloads);
  const pendingDownloadPrompt = useBrowserStore((s) => s.pendingDownloadPrompt);
  const collapsed = useBrowserStore((s) => s.downloadsShelfCollapsed);
  const toggle = useBrowserStore((s) => s.toggleDownloadsShelf);

  // Hidden entirely when there's nothing to show.
  if (downloads.length === 0 && !pendingDownloadPrompt) return null;

  const activeCount = downloads.filter((d) => d.state === 'in-progress').length;

  return (
    <div
      data-testid="downloads-shelf"
      className="border-t border-browser-divider bg-[var(--color-browser-chrome-1)] shrink-0"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <Icons.Download className="w-3.5 h-3.5 text-[var(--color-fg-secondary)] shrink-0" />
        <span className="text-[11px] font-semibold text-[var(--color-fg-primary)]">
          Downloads
          {downloads.length > 0 && (
            <span className="ml-1 text-[var(--color-fg-secondary)] font-normal">
              ({downloads.length}
              {activeCount > 0 ? `, ${activeCount} active` : ''})
            </span>
          )}
        </span>
        <button
          onClick={() => toggle()}
          className="ui-btn ui-btn-ghost p-0.5 ml-auto shrink-0"
          title={collapsed ? 'Expand' : 'Collapse'}
          aria-label={collapsed ? 'Expand downloads' : 'Collapse downloads'}
        >
          {collapsed ? (
            <Icons.ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <Icons.ChevronDown className="w-3.5 h-3.5" />
          )}
        </button>
      </div>

      {!collapsed && (
        <div className="flex flex-col gap-1.5 px-3 pb-2 max-h-48 overflow-y-auto">
          <ConfirmPrompt />
          {downloads.map((d) => (
            <DownloadRow key={d.id} d={d} />
          ))}
        </div>
      )}
    </div>
  );
}
