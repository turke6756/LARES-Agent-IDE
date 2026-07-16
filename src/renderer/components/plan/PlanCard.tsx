import React from 'react';
import * as Icons from 'lucide-react';
import type { PlanListItem } from '../../../shared/types';

// A single plan-surface card for the Plans gallery. Visually consistent with the
// agent cards (ui-card, left accent border, hover lift/tint) but pared down to
// what a plan needs: title/slug, a description snippet, and an updated time.

export function planLabel(p: PlanListItem): string {
  if (p.slug) return p.slug;
  const base = p.path.split(/[\\/]/).pop() || p.path;
  return base.replace(/\.html?$/i, '');
}

/** SQLite `datetime('now')` is `YYYY-MM-DD HH:MM:SS` in UTC (no zone) — normalize
 *  before parsing so "x ago" isn't off by the local offset. Tolerates an already
 *  ISO-formatted string. */
function parseTs(s: string): number {
  const norm = /[TZ]/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  return new Date(norm).getTime();
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - parseTs(iso);
  if (Number.isNaN(diff)) return '';
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function PlanCard({
  plan,
  onOpen,
}: {
  plan: PlanListItem;
  onOpen: (plan: PlanListItem) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => onOpen(plan)}
      className="ui-card group text-left p-3 w-full border-l-[3px] border-l-accent-blue/40
        hover:border-l-accent-blue hover:bg-white/[0.03] transition-colors cursor-pointer"
      title={plan.path}
      role="menuitem"
      data-testid="plan-card"
    >
      <div className="flex items-center gap-1.5 mb-1.5 min-w-0">
        <Icons.Map className="w-3.5 h-3.5 text-accent-blue shrink-0" />
        <h4 className="font-semibold text-[13px] text-gray-200 group-hover:text-gray-100 truncate">
          {planLabel(plan)}
        </h4>
      </div>
      <p className="text-[12px] text-gray-400 leading-snug line-clamp-3 min-h-[3em]">
        {plan.snippet ? (
          plan.snippet
        ) : (
          <span className="italic opacity-60">No description yet</span>
        )}
      </p>
      <div className="mt-2 flex items-center justify-between text-[11px] text-gray-500">
        <span className="truncate max-w-[55%]">{plan.path.split(/[\\/]/).pop()}</span>
        <span>Updated {timeAgo(plan.updatedAt)}</span>
      </div>
    </button>
  );
}
