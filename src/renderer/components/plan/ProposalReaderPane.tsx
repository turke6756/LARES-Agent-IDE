import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Icons from 'lucide-react';
import type {
  PathType,
  PlanningReaderEntry,
  PlanningReaderListResult,
  PlanningReaderDocument,
  PlanningIntentView,
} from '../../../shared/types';
import { suspendBrowserPane, resumeBrowserPane } from '../browser/useBrowserSuspension';
import ProposalReader from './ProposalReader';

// WP-P1B — the read-only proposal / plan reader surface. A split screen: a
// grouped (by day, then title) list of bare proposals + §R0 plan folders on the
// left, and a read-only markdown pane on the right. Selecting a plan-folder row
// enters a FOLDER VIEW: `plan.md` in the read pane, a sibling document list
// (deliberations / research / supplements), and a disk-derived intent lifecycle
// strip.
//
// STRICTLY read-only and STRICTLY gesture-instrumented:
//   • `planning-reader:list` runs on mount + manual refresh and is NEVER an
//     "open" — it emits no demand-probe.
//   • A `reader_open` demand-probe fires ONLY from a user click that opens a
//     document (an entry row or a sibling), never on mount / initial render /
//     refresh, and never on the automatic first read.
// There are no edit / promote affordances here — those belong to later stages.

interface ProposalReaderPaneProps {
  /** Absolute workspace root path — the handle `planning-reader:list` needs. */
  workspaceRoot: string | null;
  pathType: PathType;
  /** Selects the demand-probe sink; a `reader_open` needs it. */
  workspaceId: string | null;
  /** Close the overlay. */
  onClose: () => void;
}

interface DocReadState {
  docId: string;
  name: string;
  content: string | null;
  truncated: boolean;
  error: string | null;
  loading: boolean;
}

/** Group entries by calendar day (newest first), title-sorted within a day. */
function groupByDay(entries: PlanningReaderEntry[]): Array<{ day: string; rows: PlanningReaderEntry[] }> {
  const byDay = new Map<string, PlanningReaderEntry[]>();
  for (const e of entries) {
    const day = new Date(e.mtimeMs).toISOString().slice(0, 10);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(e);
    else byDay.set(day, [e]);
  }
  return [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([day, rows]) => ({
      day,
      rows: [...rows].sort((a, b) => a.title.localeCompare(b.title)),
    }));
}

/** The plan.md document of a folder entry (category 'plan'), else the first. */
function primaryDocOf(entry: PlanningReaderEntry): PlanningReaderDocument | null {
  if (entry.documents.length === 0) return null;
  return entry.documents.find((d) => d.category === 'plan' || d.category === 'proposal')
    ?? entry.documents[0];
}

/** Non-primary documents of a folder, for the sibling list. */
function siblingDocsOf(entry: PlanningReaderEntry, primary: PlanningReaderDocument | null): PlanningReaderDocument[] {
  return entry.documents.filter((d) => d.docId !== primary?.docId);
}

function IntentLifecycleStrip({ intents }: { intents: PlanningIntentView[] }): React.ReactElement {
  return (
    <div className="border-t border-white/10 px-3 py-2" data-testid="lifecycle-strip">
      <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-gray-500">
        Intent lifecycle
      </div>
      <div className="flex flex-col gap-2">
        {intents.map((it) => (
          <div key={it.intentId} className="flex flex-col gap-1" data-testid="lifecycle-intent">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[11px] font-semibold text-gray-300" title={it.intentId}>
                {it.kind}
                {it.part ? ` · ${it.part}` : ''}
              </span>
              {it.status !== 'active' && (
                <span className="rounded bg-surface-2 px-1 text-[9px] uppercase text-gray-400">
                  {it.status}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              <Rung label="marked" on={it.marked} />
              {/* `ran` is NOT derivable from disk pre-ledger. Never presents the
                  self-declared orchestration id as a ran rung — it stays an
                  explicit "unavailable" chip. */}
              <span
                className="rounded border border-dashed border-white/15 px-1.5 py-0.5 text-[10px] text-gray-500"
                data-testid="rung-ran"
                title="Whether this intent ran is not recorded on disk before the ledger"
              >
                ran: unavailable (pre-ledger)
              </span>
              <Rung label="returned" on={it.returned} />
              <Rung label="folded-in" on={it.fullyFoldedIn} />
            </div>
            {it.returned && (
              <div className="text-[10px] italic text-gray-500">
                a returned artifact implies work occurred
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Rung({ label, on }: { label: string; on: boolean }): React.ReactElement {
  return (
    <span
      data-testid={`rung-${label}`}
      data-on={on ? 'true' : 'false'}
      className={`rounded px-1.5 py-0.5 text-[10px] ${
        on ? 'bg-accent-blue/20 text-accent-blue' : 'bg-surface-2 text-gray-500'
      }`}
    >
      {on ? '✓ ' : '· '}
      {label}
    </span>
  );
}

export default function ProposalReaderPane({
  workspaceRoot,
  pathType,
  workspaceId,
  onClose,
}: ProposalReaderPaneProps): React.ReactElement | null {
  const [list, setList] = useState<PlanningReaderListResult | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocReadState | null>(null);

  // Mount + manual refresh read. This is NOT an open: no demand-probe here.
  const refresh = useCallback(() => {
    setListError(null);
    setList(null);
    if (!workspaceRoot) {
      setList({ entries: [], warnings: [] });
      return;
    }
    window.api.planningReader
      .list(workspaceRoot, pathType)
      .then((res) => setList(res))
      .catch(() => setListError('Could not load proposals'));
  }, [workspaceRoot, pathType]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Native WebContentsView panes composite above renderer DOM; hide the plan
  // pane (visibility only, no reload) and suspend the browser pane while the
  // reader overlay is up, mirroring the Plans gallery precedent.
  useEffect(() => {
    void window.api.plans.paneSetVisible(false);
    suspendBrowserPane();
    return () => {
      void window.api.plans.paneSetVisible(true);
      resumeBrowserPane();
    };
  }, []);

  // Escape closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const entries = list?.entries ?? null;
  const selectedEntry = useMemo(
    () => entries?.find((e) => e.entryId === selectedEntryId) ?? null,
    [entries, selectedEntryId],
  );

  // Read a document by opaque id AND record the voluntary open. Called ONLY from
  // a user click (entry row or sibling) — never on mount / render / refresh.
  const openDocument = useCallback(
    (docMeta: PlanningReaderDocument) => {
      // Voluntary open → demand-probe (user gesture only). Fire-and-forget; a
      // probe failure must never block the read.
      if (workspaceId) {
        void window.api.demandProbe
          .record({ workspaceId, kind: 'reader_open', feature_exercise: true })
          .catch(() => {});
      }
      setDoc({
        docId: docMeta.docId,
        name: docMeta.name,
        content: null,
        truncated: false,
        error: null,
        loading: true,
      });
      window.api.planningReader
        .read(docMeta.docId, pathType)
        .then((res) => {
          if ('error' in res) {
            setDoc({
              docId: docMeta.docId,
              name: docMeta.name,
              content: null,
              truncated: false,
              error: res.error,
              loading: false,
            });
            return;
          }
          setDoc({
            docId: res.docId,
            name: res.name,
            content: res.content,
            truncated: res.truncated,
            error: null,
            loading: false,
          });
        })
        .catch(() => {
          setDoc({
            docId: docMeta.docId,
            name: docMeta.name,
            content: null,
            truncated: false,
            error: 'Could not read document',
            loading: false,
          });
        });
    },
    [workspaceId, pathType],
  );

  // User clicked an entry row: select it and open its primary document.
  const selectEntry = useCallback(
    (entry: PlanningReaderEntry) => {
      setSelectedEntryId(entry.entryId);
      const primary = primaryDocOf(entry);
      if (primary) openDocument(primary);
      else setDoc(null);
    },
    [openDocument],
  );

  const groups = useMemo(() => (entries ? groupByDay(entries) : []), [entries]);

  const selectedPrimary = selectedEntry ? primaryDocOf(selectedEntry) : null;
  const siblings =
    selectedEntry && selectedEntry.kind === 'plan-folder'
      ? siblingDocsOf(selectedEntry, selectedPrimary)
      : [];
  const intents = selectedEntry?.intents ?? [];

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-surface-0"
      role="dialog"
      aria-label="Proposal and plan reader"
      data-testid="proposal-reader-pane"
    >
      {/* Header / toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/10 px-3">
        <Icons.BookOpen className="h-4 w-4 text-gray-400" />
        <span className="text-[13px] font-semibold text-gray-200">Proposals &amp; Plans</span>
        <button
          onClick={refresh}
          className="ml-2 rounded px-2 py-0.5 text-[11px] text-gray-400 hover:bg-white/10 hover:text-gray-100"
          data-testid="reader-refresh"
          title="Reload the list from disk"
        >
          Refresh
        </button>
        <button
          onClick={onClose}
          className="ml-auto rounded p-1 text-gray-400 hover:bg-white/10 hover:text-gray-100"
          data-testid="reader-close"
          aria-label="Close reader"
        >
          <Icons.X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Left: grouped list + (folder) siblings + lifecycle strip */}
        <aside className="flex w-72 shrink-0 flex-col border-r border-white/10 bg-surface-0/60">
          <div className="min-h-0 flex-1 overflow-auto" data-testid="reader-list">
            {listError ? (
              <div className="px-3 py-3 text-[12px] text-accent-red">{listError}</div>
            ) : entries === null ? (
              <div className="px-3 py-3 text-[12px] text-gray-400">Loading…</div>
            ) : entries.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-gray-500" data-testid="reader-empty">
                {workspaceRoot
                  ? 'No proposals or plans in this workspace'
                  : 'No workspace selected'}
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.day} className="mb-1">
                  <div className="sticky top-0 bg-surface-0/90 px-3 py-1 text-[10px] uppercase tracking-[0.1em] text-gray-500">
                    {g.day}
                  </div>
                  {g.rows.map((entry) => (
                    <button
                      key={entry.entryId}
                      onClick={() => selectEntry(entry)}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-white/[0.06] ${
                        entry.entryId === selectedEntryId
                          ? 'bg-white/[0.08] text-gray-100'
                          : 'text-gray-300'
                      }`}
                      data-testid="reader-entry"
                      data-entry-kind={entry.kind}
                    >
                      {entry.kind === 'plan-folder' ? (
                        <Icons.FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent-blue" />
                      ) : (
                        <Icons.FileText className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                      )}
                      <span className="truncate" title={entry.title}>
                        {entry.title}
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>

          {/* Folder view: sibling documents (opened read-only by manifest id). */}
          {selectedEntry?.kind === 'plan-folder' && siblings.length > 0 && (
            <div className="border-t border-white/10 px-1 py-2" data-testid="reader-siblings">
              <div className="px-2 pb-1 text-[10px] uppercase tracking-[0.1em] text-gray-500">
                Documents
              </div>
              {siblings.map((s) => (
                <button
                  key={s.docId}
                  onClick={() => openDocument(s)}
                  className={`flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-white/[0.06] ${
                    s.docId === doc?.docId ? 'text-accent-blue' : 'text-gray-400'
                  }`}
                  data-testid="reader-sibling"
                  data-category={s.category}
                >
                  <span className="shrink-0 rounded bg-surface-2 px-1 text-[9px] uppercase text-gray-500">
                    {s.category}
                  </span>
                  <span className="truncate" title={s.name}>
                    {s.name}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Folder view: disk-derived intent lifecycle strip. */}
          {selectedEntry?.kind === 'plan-folder' && intents.length > 0 && (
            <IntentLifecycleStrip intents={intents} />
          )}
        </aside>

        {/* Right: read-only markdown pane */}
        <div className="min-w-0 flex-1">
          <ProposalReader
            name={doc?.name ?? null}
            content={doc?.content ?? null}
            truncated={doc?.truncated ?? false}
            error={doc?.error ?? null}
            loading={doc?.loading ?? false}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
