import React from 'react';
import * as Icons from 'lucide-react';
import { useDashboardStore } from '../../stores/dashboard-store';

interface PlansMenuProps {
  compact: boolean;
  detached?: boolean;
  onDragStart?: (event: React.DragEvent) => void;
  onDragEnd?: (event: React.DragEvent) => void;
}

/**
 * The Plans navigation control. Despite the historical filename, this is no
 * longer a menu: it selects the same inline center-view state used by the other
 * top-level navigation buttons.
 */
export default function PlansMenu({
  compact,
  detached = false,
  onDragStart,
  onDragEnd,
}: PlansMenuProps): React.ReactElement {
  const plansOpen = useDashboardStore((state) => state.plansOpen);
  const showPlans = useDashboardStore((state) => state.showPlans);

  return (
    <div className="relative flex-1">
      <button
        data-testid="view-btn-plans"
        draggable={!detached}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={() => { if (!detached) showPlans(); }}
        aria-disabled={detached}
        aria-pressed={plansOpen && !detached}
        className={`ui-btn ui-btn-outline w-full whitespace-nowrap px-3 py-1.5 text-[13px] font-medium ${
          detached
            ? 'opacity-40 cursor-not-allowed'
            : plansOpen ? 'ui-btn-success is-active' : ''
        }`}
        style={detached ? { borderStyle: 'dashed' } : undefined}
        title={detached
          ? 'Plans is open in a separate window — close it to restore'
          : 'Open Plans — drag out to open in its own window'}
      >
        <Icons.Map className="h-4 w-4 shrink-0" />
        {!compact && 'Plans'}
      </button>
    </div>
  );
}
