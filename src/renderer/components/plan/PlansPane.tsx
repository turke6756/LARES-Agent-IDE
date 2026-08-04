import React from 'react';
import * as Icons from 'lucide-react';

function ReservedRegion({
  icon,
  title,
  description,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  testId: string;
}): React.ReactElement {
  return (
    <section
      className="flex min-h-0 flex-1 flex-col rounded-lg border border-white/10 bg-surface-1"
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 px-4">
        {icon}
        <h2 id={`${testId}-title`} className="text-[13px] font-semibold text-gray-200">
          {title}
        </h2>
      </div>
      <div className="flex min-h-24 flex-1 items-center justify-center p-6 text-center">
        <p className="max-w-md text-[12px] leading-5 text-gray-500">{description}</p>
      </div>
    </section>
  );
}

/** First-class Plans center pane. WP-UX-B/C populate the two reserved regions. */
export default function PlansPane(): React.ReactElement {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto bg-surface-0 p-6 scrollbar-thin"
      data-testid="plans-pane"
    >
      <ReservedRegion
        icon={<Icons.LayoutGrid className="h-4 w-4 text-accent-blue" />}
        title="Proposals"
        description="Proposal cards will appear here."
        testId="plans-proposals-region"
      />
      <ReservedRegion
        icon={<Icons.Map className="h-4 w-4 text-accent-green" />}
        title="Promoted plans"
        description="Promoted plans will appear here."
        testId="plans-promoted-region"
      />
    </div>
  );
}
