import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Icons from 'lucide-react';
import type {
  PathType,
  PlanGalleryRow,
  PlanGalleryResult,
} from '../../../shared/types';
import ProposalReader from './ProposalReader';
import ProposalReaderPane from './ProposalReaderPane';

// WP-P2D — the Plans GALLERY pane. Edward's binding UX ruling: this is a STABLE
// TOP-LEVEL center pane (peer of Dashboard / Files / Browser), never the legacy
// modal popup. It unions the three durable row kinds from the WP-P2C
// `plan-gallery:list` projection — filesystem proposals, folder-per-plan
// `structured` plans, and legacy `format='html'` plans (md rows are NEVER
// projected) — date-grouped with type / state / owner chips.
//
// Row-open dispatch (by type):
//   • proposal  → read inline via `proposal:read` in the right-hand reader pane;
//                 a Promote button is shown. Promotion BEHAVIOR is P3C — the
//                 button is an inert stub here (no plan/registry row minted).
//   • structured (hasFolder) → open the WP-P1B folder view (ProposalReaderPane),
//                 which drills the plan folder read-only via `planning-reader`.
//   • legacy    → open the legacy HTML plan surface in its own tab.
//
// The archived / promoted toggle re-queries the projection (both hidden by
// default). This pane renders inline in the center slot — it is NOT a portal /
// overlay; the only overlay it can spawn is the reused WP-P1B folder reader.

interface PlanGalleryPaneProps {
  workspaceId: string | null;
  workspaceRoot: string | null;
  pathType: PathType;
  /** Open a legacy HTML plan in its tab (the legacy plan surface). */
  onOpenLegacyPlan: (planId: string, title: string, workspaceId: string) => void;
}

interface ReadState {
  rowId: string;
  name: string;
  content: string | null;
  truncated: boolean;
  error: string | null;
  loading: boolean;
}

/** Group rows by their projection-supplied `dateGroup` (YYYY-MM-DD), newest day
 *  first, title-sorted within a day. */
function groupByDay(rows: PlanGalleryRow[]): Array<{ day: string; rows: PlanGalleryRow[] }> {
  const byDay = new Map<string, PlanGalleryRow[]>();
  for (const r of rows) {
    const bucket = byDay.get(r.dateGroup);
    if (bucket) bucket.push(r);
    else byDay.set(r.dateGroup, [r]);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([day, dayRows]) => ({
      day,
      rows: [...dayRows].sort((a, b) => a.title.localeCompare(b.title)),
    }));
}

function TypeChip({ row }: { row: PlanGalleryRow }): React.ReactElement {
  const tone =
    row.type === 'proposal'
      ? 'bg-accent-blue/20 text-accent-blue'
      : row.type === 'structured'
        ? 'bg-accent-green/20 text-accent-green'
        : 'bg-surface-2 text-gray-400';
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${tone}`}
      data-testid="gallery-type-chip"
      data-row-type={row.type}
    >
      {row.typeLabel}
    </span>
  );
}

export default function PlanGalleryPane({
  workspaceId,
  workspaceRoot,
  pathType,
  onOpenLegacyPlan,
}: PlanGalleryPaneProps): React.ReactElement {
  const [result, setResult] = useState<PlanGalleryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [includePromoted, setIncludePromoted] = useState(false);
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [read, setRead] = useState<ReadState | null>(null);
  // The reused WP-P1B folder reader overlay, opened for a structured row.
  const [folderReaderOpen, setFolderReaderOpen] = useState(false);

  const refresh = useCallback(() => {
    setError(null);
    setResult(null);
    if (!workspaceId) {
      setResult({ rows: [], warnings: [] });
      return;
    }
    window.api.plans
      .gallery(workspaceId, { includeArchived, includePromoted })
      .then((res) => setResult(res))
      .catch(() => setError('Could not load the plan gallery'));
  }, [workspaceId, includeArchived, includePromoted]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Read a proposal's markdown into the right-hand reader pane.
  const openProposal = useCallback((row: PlanGalleryRow) => {
    setRead({ rowId: row.id, name: row.title, content: null, truncated: false, error: null, loading: true });
    window.api.plans
      .readProposal(row.id)
      .then((res) => {
        if ('error' in res) {
          setRead({ rowId: row.id, name: row.title, content: null, truncated: false, error: res.error, loading: false });
          return;
        }
        setRead({ rowId: row.id, name: res.name, content: res.content, truncated: res.truncated, error: null, loading: false });
      })
      .catch(() => {
        setRead({ rowId: row.id, name: row.title, content: null, truncated: false, error: 'Could not read proposal', loading: false });
      });
  }, []);

  const selectRow = useCallback(
    (row: PlanGalleryRow) => {
      setSelectedRowId(row.id);
      if (row.type === 'legacy') {
        // Legacy HTML plan → its own tab (the legacy plan surface).
        setRead(null);
        if (workspaceId) onOpenLegacyPlan(row.id, row.title, workspaceId);
        return;
      }
      if (row.type === 'structured') {
        // Folder-per-plan → the WP-P1B folder view (drills `planning-reader`).
        setRead(null);
        setFolderReaderOpen(true);
        return;
      }
      openProposal(row);
    },
    [workspaceId, onOpenLegacyPlan, openProposal],
  );

  // Promote — proposals only. Behavior lands in P3C; this is an inert stub that
  // mints NO plan / registry row. Kept disabled so the affordance is visible but
  // cannot be exercised before the promotion service exists.
  const onPromote = useCallback((_row: PlanGalleryRow) => {
    // Intentionally no-op (P3C).
  }, []);

  const rows = result?.rows ?? null;
  const groups = useMemo(() => (rows ? groupByDay(rows) : []), [rows]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface-0" data-testid="plan-gallery-pane">
      {/* Toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/10 px-3">
        <Icons.Map className="h-4 w-4 text-gray-400" />
        <span className="text-[13px] font-semibold text-gray-200">Plans</span>
        <button
          onClick={refresh}
          className="ml-2 rounded px-2 py-0.5 text-[11px] text-gray-400 hover:bg-white/10 hover:text-gray-100"
          data-testid="gallery-refresh"
          title="Reload the gallery from disk"
        >
          Refresh
        </button>
        <label
          className="ml-auto flex cursor-pointer items-center gap-1 text-[11px] text-gray-400"
          data-testid="gallery-toggle-archived"
        >
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Archived
        </label>
        <label
          className="flex cursor-pointer items-center gap-1 text-[11px] text-gray-400"
          data-testid="gallery-toggle-promoted"
        >
          <input
            type="checkbox"
            checked={includePromoted}
            onChange={(e) => setIncludePromoted(e.target.checked)}
          />
          Promoted
        </label>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Left: date-grouped row list */}
        <aside className="flex w-80 shrink-0 flex-col border-r border-white/10 bg-surface-0/60">
          <div className="min-h-0 flex-1 overflow-auto" data-testid="gallery-list">
            {error ? (
              <div className="px-3 py-3 text-[12px] text-accent-red" data-testid="gallery-error">
                {error}
              </div>
            ) : rows === null ? (
              <div className="px-3 py-3 text-[12px] text-gray-400">Loading…</div>
            ) : rows.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-gray-500" data-testid="gallery-empty">
                {workspaceId ? 'No proposals or plans in this workspace' : 'No workspace selected'}
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.day} className="mb-1">
                  <div className="sticky top-0 bg-surface-0/90 px-3 py-1 text-[10px] uppercase tracking-[0.1em] text-gray-500">
                    {g.day}
                  </div>
                  {g.rows.map((row) => {
                    const selected = row.id === selectedRowId;
                    return (
                      <div
                        key={row.id}
                        className={`flex flex-col gap-1 border-b border-white/[0.04] px-3 py-2 text-left ${
                          selected ? 'bg-white/[0.08]' : ''
                        }`}
                        data-testid="gallery-row"
                        data-row-type={row.type}
                        data-has-folder={row.hasFolder ? 'true' : 'false'}
                      >
                        <button
                          onClick={() => selectRow(row)}
                          className="flex items-center gap-2 text-left text-[12px] hover:text-gray-100"
                          data-testid="gallery-row-open"
                        >
                          {row.type === 'structured' ? (
                            <Icons.FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent-green" />
                          ) : row.type === 'legacy' ? (
                            <Icons.FileCode className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                          ) : (
                            <Icons.FileText className="h-3.5 w-3.5 shrink-0 text-accent-blue" />
                          )}
                          <span
                            className={`truncate ${selected ? 'text-gray-100' : 'text-gray-300'}`}
                            title={row.title}
                          >
                            {row.title}
                          </span>
                        </button>
                        <div className="flex flex-wrap items-center gap-1 pl-5">
                          <TypeChip row={row} />
                          {row.state && (
                            <span
                              className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-gray-400"
                              data-testid="gallery-state-chip"
                            >
                              {row.state}
                            </span>
                          )}
                          {row.owner?.display && (
                            <span
                              className="shrink-0 rounded bg-accent-purple/20 px-1.5 py-0.5 text-[9px] text-accent-purple"
                              data-testid="gallery-owner-chip"
                              title={`Responsible supervisor (owner) — ${row.owner.display}`}
                            >
                              ● {row.owner.display}
                            </span>
                          )}
                          {row.type === 'proposal' && row.author.display && (
                            <span
                              className="shrink-0 text-[9px] text-gray-500"
                              data-testid="gallery-author-chip"
                              title={`Author (${row.author.role})`}
                            >
                              by {row.author.display}
                            </span>
                          )}
                        </div>
                        {row.type === 'proposal' && (
                          <div className="pl-5">
                            <button
                              onClick={() => onPromote(row)}
                              disabled
                              className="flex items-center gap-1 rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-gray-500 opacity-60"
                              data-testid="gallery-promote"
                              title="Promote this proposal to a plan — arrives in P3C"
                            >
                              <Icons.ArrowUpCircle className="h-3 w-3" />
                              Promote
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Right: read-only reader pane (proposals read inline here) */}
        <div className="min-w-0 flex-1">
          <ProposalReader
            name={read?.name ?? null}
            content={read?.content ?? null}
            truncated={read?.truncated ?? false}
            error={read?.error ?? null}
            loading={read?.loading ?? false}
          />
        </div>
      </div>

      {/* Structured-row drill: the reused WP-P1B folder reader (overlay). */}
      {folderReaderOpen && (
        <ProposalReaderPane
          workspaceRoot={workspaceRoot}
          pathType={pathType}
          workspaceId={workspaceId}
          onClose={() => setFolderReaderOpen(false)}
        />
      )}
    </div>
  );
}
