import React from 'react';
import ProposalCardGallery from './ProposalCardGallery';
import PromotedPlansList from './PromotedPlansList';
import { usePlansPaneState } from './plans-pane-state';

/** First-class Plans center pane. WP-UX-B/C populate the two reserved regions. */
export default function PlansPane(): React.ReactElement {
  const proposalExpanded = usePlansPaneState((state) => state.expandedProposalId !== null);
  return (
    <div
      className={`flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface-0 scrollbar-thin ${proposalExpanded ? '' : 'gap-4 p-6'}`}
      data-testid="plans-pane"
      data-proposal-expanded={proposalExpanded ? 'true' : 'false'}
    >
      <ProposalCardGallery />
      {!proposalExpanded && <PromotedPlansList />}
    </div>
  );
}
