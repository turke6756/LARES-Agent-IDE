import React from 'react';
import ProposalCardGallery from './ProposalCardGallery';
import PromotedPlansList from './PromotedPlansList';

/** First-class Plans center pane. WP-UX-B/C populate the two reserved regions. */
export default function PlansPane(): React.ReactElement {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-surface-0 p-6 scrollbar-thin"
      data-testid="plans-pane"
    >
      <ProposalCardGallery />
      <PromotedPlansList />
    </div>
  );
}
