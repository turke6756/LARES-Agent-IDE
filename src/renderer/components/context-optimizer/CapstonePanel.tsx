import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Layers, RefreshCw, AlertTriangle, Loader2, ArrowRightCircle, Info } from 'lucide-react';
import type { ContextOptimizerResult, ContextOptimizerProposal } from '../../../shared/types';
// Capstone reuses the ONE source registry (master D4) — the lever/category map and the
// safety-route function live in the engine; this panel is MAPPING ONLY and never
// re-derives proposal logic.
import {
  CAPSTONE_KIND_MAP,
  safetyRouteFor,
  type CapstoneSafetyRoute,
} from '../../../main/context-optimizer/capstone-map';

// CapstonePanel (WP6a, base plan P4) — the capstone view over the SAME optimizer result,
// projected through CAPSTONE_KIND_MAP (lever + category) and safetyRouteFor (P4.2 routing
// by mutability class). It groups proposals by capstone category and surfaces the safe
// route for each; it does not compute or apply anything.

const ROUTE_LABEL: Record<CapstoneSafetyRoute, string> = {
  'propose-source-constant-edit': 'Propose a source-constant edit — never patch the generated artifact',
  'route-to-constants-version-bump': 'Edit src/shared/constants.ts + bump version / previousHashes',
  'consider-only': 'Consider only — user-owned; surface as a suggestion',
};
const ROUTE_COLOR: Record<CapstoneSafetyRoute, string> = {
  'propose-source-constant-edit': '#f59e0b',
  'route-to-constants-version-bump': '#22d3ee',
  'consider-only': '#a3a3a3',
};

interface CapstoneCard {
  proposal: ContextOptimizerProposal;
  category: string;
  route: CapstoneSafetyRoute;
}

export default function CapstonePanel(): JSX.Element {
  const [result, setResult] = useState<ContextOptimizerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.api.contextOptimizer.analyze({});
      if (res.ok) setResult(res.data);
      else { setResult(null); setError(res.error); }
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Project each proposal through the shared registry, grouped by capstone category.
  const groups = useMemo(() => {
    const m = new Map<string, CapstoneCard[]>();
    for (const p of result?.proposals ?? []) {
      const mapping = CAPSTONE_KIND_MAP[p.kind];
      if (!mapping) continue;
      const card: CapstoneCard = {
        proposal: p,
        category: mapping.category,
        route: safetyRouteFor(p.target.mutable),
      };
      if (!m.has(mapping.category)) m.set(mapping.category, []);
      m.get(mapping.category)!.push(card);
    }
    return [...m.entries()];
  }, [result]);

  const hasCards = groups.length > 0;

  return (
    <div className="h-full overflow-auto bg-surface-0 text-[13px]">
      <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2.5 bg-surface-0/95 backdrop-blur border-b dark:border-white/10 light:border-black/10">
        <Layers size={16} className="text-accent-blue-bright shrink-0" />
        <span className="font-medium">Optimizer Capstone</span>
        {result && (
          <span className="text-[11px] text-gray-400">
            {result.proposals.length} proposals · {groups.length} categories
          </span>
        )}
        <button
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 px-2 py-1 rounded text-[12px] hover:bg-white/10 disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="p-4 space-y-4">
        <div className="flex items-start gap-2 text-[11px] text-gray-500">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>Capstone view of the behavior-grounded proposals. Each card shows the P4.2 safe route derived from the target’s mutability — never an automatic edit.</span>
        </div>

        {loading && !result && <div className="flex items-center gap-2 text-gray-400"><Loader2 size={14} className="animate-spin" /> Loading capstone…</div>}
        {error && (
          <div className="flex items-start gap-2 text-red-400">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>Analysis failed: {error}</span>
          </div>
        )}
        {result && !hasCards && !loading && (
          <div className="ui-card p-4 text-gray-400">
            <div className="font-medium text-gray-300 mb-1">No capstone cards</div>
            <p className="text-[12px]">The optimizer produced no ranked proposals to project into the capstone view.</p>
          </div>
        )}

        {groups.map(([category, cards]) => (
          <div key={category} className="ui-card overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b dark:border-white/10 light:border-black/10">
              <span className="font-medium">{category}</span>
              <span className="text-[11px] text-gray-500">({cards.length})</span>
            </div>
            <div className="p-3 space-y-2">
              {cards.map((c) => (
                <div key={c.proposal.id} className="rounded border dark:border-white/10 light:border-black/10 p-2.5">
                  <div className="font-medium text-gray-200 text-[12px] truncate" title={c.proposal.title}>{c.proposal.title}</div>
                  <p className="text-[11px] text-gray-400 mt-0.5">{c.proposal.rationale}</p>
                  <div className="flex flex-wrap items-center gap-2 mt-2 text-[10px]">
                    <span className="px-1 rounded bg-white/5 text-gray-400">{c.proposal.lever}</span>
                    <span className="px-1 rounded bg-white/5 text-gray-400">{c.proposal.target.mutable}</span>
                    {c.proposal.actionability === 'candidate-unverified' && (
                      <span className="px-1 rounded bg-amber-500/15 text-amber-400">candidate (unverified)</span>
                    )}
                  </div>
                  <div
                    className="mt-2 flex items-start gap-1.5 text-[10.5px]"
                    style={{ color: ROUTE_COLOR[c.route] }}
                  >
                    <ArrowRightCircle size={12} className="mt-0.5 shrink-0" />
                    <span>{ROUTE_LABEL[c.route]}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
