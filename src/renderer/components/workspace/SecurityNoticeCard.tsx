// P0.2 — legacy `launch.vbs` security notice (EDR-safety hardening plan).
//
// Corner card (same ambient surface pattern as PressureNotification) shown when
// main's first-touch workspace sweep flags a legacy launcher: a `launch.vbs`
// whose CONTENT spawns a hidden cmd via WScript.Shell — a known EDR
// false-positive trigger from early builds. The card shows the path + SHA-256
// and offers the ONE explicit action, "Remove legacy launcher", which asks main
// to move the file to the Recycle Bin (shell.trashItem — never a hard delete).
// Dismissing keeps the file untouched (it may be wanted as incident evidence);
// main re-flags it on the next app start while it still exists.
//
// Seeded by a mount-time pull (`getSecurityNotices`) so notices raised during
// startup — before this component existed — still surface, then kept live via
// the `workspace:security-notice` push (workspace registration).

import React, { useEffect, useState } from 'react';
import * as Icons from 'lucide-react';
import type { WorkspaceSecurityNotice } from '../../../shared/types';

export default function SecurityNoticeCard() {
  const [notices, setNotices] = useState<WorkspaceSecurityNotice[]>([]);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [errorByPath, setErrorByPath] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    window.api.workspaces.getSecurityNotices()
      .then((list) => { if (live && list) setNotices(list); })
      .catch(() => { /* best effort — the push below still surfaces new ones */ });
    const unsub = window.api.workspaces.onSecurityNotice((notice) => {
      setNotices((prev) =>
        prev.some((n) => n.filePath === notice.filePath) ? prev : [...prev, notice]);
    });
    return () => { live = false; unsub(); };
  }, []);

  const dismiss = (filePath: string) =>
    setNotices((prev) => prev.filter((n) => n.filePath !== filePath));

  const remove = async (notice: WorkspaceSecurityNotice) => {
    setBusyPath(notice.filePath);
    try {
      const res = await window.api.workspaces.removeLegacyLauncher(notice.filePath);
      if (res.removed) {
        dismiss(notice.filePath);
      } else {
        setErrorByPath((prev) => ({
          ...prev,
          [notice.filePath]: res.reason ?? 'Removal was refused.',
        }));
      }
    } catch (err) {
      setErrorByPath((prev) => ({
        ...prev,
        [notice.filePath]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusyPath(null);
    }
  };

  if (notices.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-4 z-[130] app-no-drag flex flex-col gap-2">
      {notices.map((notice) => (
        <div
          key={notice.filePath}
          role="alert"
          className="w-[360px] rounded-lg border shadow-xl overflow-hidden bg-accent-red/15 border-accent-red/60"
        >
          <div className="flex items-start gap-2.5 p-3">
            <Icons.ShieldAlert className="w-4 h-4 mt-0.5 shrink-0 text-accent-red" />
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-accent-red">{notice.title}</div>
              <div className="text-[11px] text-gray-300 mt-0.5 break-all" title={notice.filePath}>
                {notice.filePath}
              </div>
              <div className="text-[10px] text-gray-400 mt-0.5 font-mono truncate" title={notice.sha256}>
                SHA-256 {notice.sha256}
              </div>
              <div className="text-[11px] text-gray-300 mt-1">
                This file spawns a hidden cmd via WScript.Shell. Lares no longer uses it and
                never runs it. Remove it (Recycle Bin), or dismiss to keep it as evidence.
              </div>
              {notice.inertBackups.length > 0 && (
                <div className="text-[10px] text-gray-400 mt-1">
                  Also found {notice.inertBackups.length} inert scaffold backup file
                  {notice.inertBackups.length === 1 ? '' : 's'} quoting the old launch recipe
                  (text only, never executed) — safe to delete manually.
                </div>
              )}
              {errorByPath[notice.filePath] && (
                <div className="text-[10px] text-accent-red mt-1">
                  {errorByPath[notice.filePath]}
                </div>
              )}
            </div>
            <button
              onClick={() => dismiss(notice.filePath)}
              className="text-gray-400 hover:text-gray-100 shrink-0"
              aria-label="Dismiss"
            >
              <Icons.X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex justify-end px-3 pb-2.5">
            <button
              onClick={() => remove(notice)}
              disabled={busyPath === notice.filePath}
              className="ui-btn px-2.5 py-1 text-[11px]"
            >
              {busyPath === notice.filePath ? 'Removing…' : 'Remove legacy launcher'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
