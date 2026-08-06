import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Icons from 'lucide-react';
import { installHorizontalWheelScroll } from '../../lib/horizontal-wheel';
import { useDashboardStore } from '../../stores/dashboard-store';
import EmbeddedMarkdownDocument from './EmbeddedMarkdownDocument';
import PromoteToPlanPanel from './PromoteToPlanPanel';
import { usePlansPaneState } from './plans-pane-state';
import {
  deriveProposalCardMetadata,
  orderProposalCards,
  type ProposalCardMetadata,
} from './proposal-card-metadata';

function proposalPath(workspacePath: string, fileName: string, pathType: 'windows' | 'wsl'): string {
  const separator = pathType === 'windows' ? '\\' : '/';
  return [workspacePath.replace(/[\\/]+$/, ''), '.lares', 'proposals', fileName].join(separator);
}

function ProposalCard({
  card,
  onSelect,
}: {
  card: ProposalCardMetadata;
  onSelect: (docId: string) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => onSelect(card.docId)}
      className="flex w-72 shrink-0 flex-col rounded-lg border border-white/10 bg-surface-0 p-4 text-left transition-colors hover:border-accent-blue/40 hover:bg-white/[0.04]"
      data-testid="proposal-card"
    >
      <span className="line-clamp-2 text-[14px] font-semibold leading-5 text-gray-100">{card.title}</span>
      <span className="mt-2 line-clamp-4 text-[12px] leading-5 text-gray-400">{card.description}</span>
      <span className="mt-auto pt-3 text-[11px] text-gray-500" data-testid="proposal-card-date">
        {card.dateLabel}
      </span>
      {card.author && (
        <span className="pt-1 text-[11px] text-gray-500" data-testid="proposal-card-author">
          by {card.author}
        </span>
      )}
    </button>
  );
}

export default function ProposalCardGallery(): React.ReactElement {
  const selectedWorkspaceId = useDashboardStore((state) => state.selectedWorkspaceId);
  const workspace = useDashboardStore((state) =>
    state.workspaces.find((candidate) => candidate.id === selectedWorkspaceId),
  );
  const openTab = useDashboardStore((state) => state.openTab);
  const showFileViewer = useDashboardStore((state) => state.showFileViewer);
  const [cards, setCards] = useState<ProposalCardMetadata[] | null>(null);
  const selectedDocId = usePlansPaneState((state) => state.expandedProposalId);
  const setSelectedDocId = usePlansPaneState((state) => state.setExpandedProposalId);
  const [error, setError] = useState<string | null>(null);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promotedOpen, setPromotedOpen] = useState(false);
  const [cardRow, setCardRow] = useState<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setCards(null);
    setError(null);
    setSelectedDocId(null);
    setPromoteOpen(false);
    setPromotedOpen(false);
    if (!workspace) {
      setCards([]);
      return;
    }

    try {
      const result = await window.api.planningReader.list(workspace.path, workspace.pathType);
      const proposalDocuments = result.entries
        .filter((entry) => entry.kind === 'proposal')
        .map((entry) => entry.documents.find((document) => document.category === 'proposal'))
        .filter((document): document is NonNullable<typeof document> => Boolean(document));
      const reads = await Promise.all(proposalDocuments.map(async (document) => {
        const read = await window.api.planningReader.read(document.docId, workspace.pathType);
        if ('error' in read) return null;
        return deriveProposalCardMetadata(document, read.content, read.truncated);
      }));
      setCards(orderProposalCards(reads.filter((card): card is ProposalCardMetadata => card !== null)));
    } catch {
      setError('Could not load proposals from this workspace.');
      setCards([]);
    }
  }, [workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!cardRow) return;
    return installHorizontalWheelScroll(cardRow);
  }, [cardRow]);

  const selected = useMemo(
    () => cards?.find((card) => card.docId === selectedDocId) ?? null,
    [cards, selectedDocId],
  );
  const activeCards = useMemo(() => cards?.filter((card) => !card.promotedTo) ?? [], [cards]);
  const promotedCards = useMemo(() => cards?.filter((card) => card.promotedTo) ?? [], [cards]);

  if (selected) {
    return (
      <section
        className="flex min-h-0 flex-1 flex-col rounded-lg border border-white/10 bg-surface-1"
        aria-labelledby="proposal-reader-title"
        data-testid="plans-proposals-region"
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-3">
          <button
            type="button"
            onClick={() => { setSelectedDocId(null); setPromoteOpen(false); }}
            className="ui-btn flex items-center gap-1 px-2 py-1 text-[11px]"
            data-testid="proposal-collapse"
          >
            <Icons.ChevronLeft className="h-3.5 w-3.5" />
            Proposals
          </button>
          <h2 id="proposal-reader-title" className="min-w-0 flex-1 truncate text-[13px] font-semibold text-gray-200">
            {selected.title}
          </h2>
          {selected.truncated && <span className="text-[10px] text-accent-orange">truncated</span>}
          <button
            type="button"
            onClick={() => setPromoteOpen((open) => !open)}
            className="ui-btn flex items-center gap-1 px-2 py-1 text-[11px]"
            data-testid="proposal-promote"
          >
            <Icons.ArrowUpCircle className="h-3.5 w-3.5" />
            Promote to plan
          </button>
          <button
            type="button"
            onClick={() => {
              if (!workspace) return;
              openTab(
                proposalPath(workspace.path, selected.fileName, workspace.pathType),
                workspace.path,
                workspace.pathType,
                undefined,
                workspace.id,
              );
              showFileViewer();
            }}
            className="ui-btn flex items-center gap-1 px-2 py-1 text-[11px]"
            data-testid="proposal-open-files"
            title="Open this proposal in the full file viewer to edit or comment"
          >
            <Icons.ExternalLink className="h-3.5 w-3.5" />
            Open in Files
          </button>
        </div>
        {promoteOpen && workspace && (
          <PromoteToPlanPanel
            workspace={workspace}
            proposalFilePath={proposalPath(workspace.path, selected.fileName, workspace.pathType)}
            onClose={() => setPromoteOpen(false)}
          />
        )}
        <div className="min-h-0 flex-1" data-testid="proposal-expanded-reader">
          {workspace && (
            <EmbeddedMarkdownDocument
              content={selected.content}
              filePath={proposalPath(workspace.path, selected.fileName, workspace.pathType)}
              rootDirectory={workspace.path}
              pathType={workspace.pathType}
              workspaceId={workspace.id}
            />
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      className="flex min-h-0 flex-1 flex-col rounded-lg border border-white/10 bg-surface-1"
      aria-labelledby="plans-proposals-title"
      data-testid="plans-proposals-region"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-4">
        <Icons.LayoutGrid className="h-4 w-4 text-accent-blue" />
        <h2 id="plans-proposals-title" className="text-[13px] font-semibold text-gray-200">Proposals</h2>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-auto rounded px-2 py-1 text-[11px] text-gray-400 hover:bg-white/10 hover:text-gray-100"
        >
          Refresh
        </button>
      </div>
      {error ? (
        <div className="flex min-h-24 flex-1 items-center justify-center p-6 text-[12px] text-accent-red">{error}</div>
      ) : cards === null ? (
        <div className="flex min-h-24 flex-1 items-center justify-center p-6 text-[12px] text-gray-500">Loading proposals…</div>
      ) : cards.length === 0 ? (
        <div className="flex min-h-24 flex-1 items-center justify-center p-6 text-[12px] text-gray-500">
          {workspace ? 'No proposals yet.' : 'Select a workspace to view proposals.'}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {activeCards.length > 0 ? (
            <div
              ref={setCardRow}
              className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto overflow-y-hidden p-4 scrollbar-thin"
              data-testid="proposal-card-row"
            >
              {activeCards.map((card) => (
                <ProposalCard key={card.docId} card={card} onSelect={setSelectedDocId} />
              ))}
            </div>
          ) : (
            <div className="flex min-h-24 flex-1 items-center justify-center p-6 text-[12px] text-gray-500">
              No active proposals.
            </div>
          )}
          {promotedCards.length > 0 && (
            <section className="shrink-0 border-t border-white/10" data-testid="proposal-promoted-group">
              <button
                type="button"
                className="flex w-full items-center gap-2 px-4 py-3 text-left text-[12px] font-medium text-gray-400 hover:bg-white/[0.03] hover:text-gray-200"
                aria-expanded={promotedOpen}
                onClick={() => setPromotedOpen((open) => !open)}
                data-testid="proposal-promoted-toggle"
              >
                <Icons.ChevronRight className={`h-3.5 w-3.5 transition-transform${promotedOpen ? ' rotate-90' : ''}`} />
                Promoted ({promotedCards.length})
              </button>
              {promotedOpen && (
                <div className="flex items-stretch gap-3 overflow-x-auto px-4 pb-4 scrollbar-thin" data-testid="proposal-promoted-card-row">
                  {promotedCards.map((card) => (
                    <ProposalCard key={card.docId} card={card} onSelect={setSelectedDocId} />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
