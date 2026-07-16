import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Scissors, PlusCircle, SlidersHorizontal, RefreshCw, AlertTriangle, ShieldAlert,
  Flame, EyeOff, FileText, Quote, Coins, CheckCircle2, Loader2, Info,
  ChevronRight, ChevronDown, ExternalLink,
} from 'lucide-react';
import type {
  ContextOptimizerResult, ContextOptimizerProposal, ContextOptimizerLever,
  BehaviorEvidenceTier, FileHeatRollupEntry, AgentRoleLane,
  MarkOptimizerActionAppliedRequest,
} from '../../../shared/types';
import {
  isProposalDefaultSurfaced, proposalHasActionableContent,
} from '../../../shared/context-optimizer-policy';
import { useDashboardStore } from '../../stores/dashboard-store';

// Context Optimizer (master WP6b) — the behavior-grounded proposal surface. Read-only
// analysis; the ONLY writes are human-gated "Mark applied" intent rows. NO auto-apply
// anywhere. Proposals are grouped by LEVER (Subtract / Add / Tune·Relocate) and, within
// each lever, by HARD confidence-tier headers — never blended. Every card carries its
// citations, cost evidence (A8), phrase-gap terms (A9), and — for gate-governed
// unverified proposals — a "candidate (unverified)" ribbon (§4.6).

const TIER_ORDER: BehaviorEvidenceTier[] = ['observed-safe', 'observed', 'inferred', 'heuristic'];
const TIER_LABEL: Record<BehaviorEvidenceTier, string> = {
  'observed-safe': 'Observed · safe',
  'observed': 'Observed',
  'inferred': 'Inferred',
  'heuristic': 'Heuristic',
};
const TIER_COLOR: Record<BehaviorEvidenceTier, string> = {
  'observed-safe': '#22c55e',
  'observed': '#84cc16',
  'inferred': '#f59e0b',
  'heuristic': '#6b7280',
};

interface LeverGroup { key: string; label: string; levers: ContextOptimizerLever[]; icon: React.ReactNode; }
const LEVER_GROUPS: LeverGroup[] = [
  { key: 'subtract', label: 'Subtract', levers: ['subtract'], icon: <Scissors size={15} className="text-red-400" /> },
  { key: 'add', label: 'Add', levers: ['add'], icon: <PlusCircle size={15} className="text-emerald-400" /> },
  { key: 'tune', label: 'Tune · Relocate', levers: ['tune', 'relocate'], icon: <SlidersHorizontal size={15} className="text-cyan-400" /> },
];

function fmtNum(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(Math.round(n));
}
function fmtSigned(n: number): string { return (n > 0 ? '+' : '') + fmtNum(n); }

export default function ContextOptimizerPanel(): JSX.Element {
  const [result, setResult] = useState<ContextOptimizerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [applied, setApplied] = useState<Record<string, 'pending' | 'done' | string>>({});
  // WP-B1: default view shows the agent-actionable / default-surfaced set (parity with
  // the MCP default page). Hidden (non-default, e.g. hash-only / no-target) rows live
  // behind this toggle rather than dominating page 1.
  const [showHidden, setShowHidden] = useState(false);
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const workspaces = useDashboardStore((s) => s.workspaces);
  const openTab = useDashboardStore((s) => s.openTab);

  // WP6.5 — open a proposal's CLAUDE.md target in source mode at its exact span
  // (WP4). We resolve the root + pathType from the selected workspace so the file
  // opens the same way the tree opens it. Only offered when the target has a span.
  const openTarget = useCallback((p: ContextOptimizerProposal) => {
    if (!p.target.absPath || p.target.lineStart == null) return;
    const ws = workspaces.find((w) => w.id === selectedWorkspaceId);
    if (!ws) return;
    openTab(p.target.absPath, ws.path, ws.pathType, undefined, selectedWorkspaceId ?? undefined, {
      lineStart: p.target.lineStart,
      lineEnd: p.target.lineEnd ?? p.target.lineStart,
      mode: 'source',
      nonce: Date.now(),
    });
  }, [workspaces, selectedWorkspaceId, openTab]);

  const load = useCallback(async () => {
    // WP6.1: the panel used to call analyze({}) with no workspace, so the IPC handler
    // resolved workspaceId → undefined → the honest EMPTY result forever ("panel shows
    // nothing"). Pass the selected workspace so the live pipeline actually runs.
    if (!selectedWorkspaceId) { setResult(null); setError(null); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await window.api.contextOptimizer.analyze({ workspaceId: selectedWorkspaceId });
      if (res.ok) setResult(res.data);
      else { setResult(null); setError(res.error); }
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedWorkspaceId]);

  useEffect(() => { void load(); }, [load]);

  const markApplied = useCallback(async (p: ContextOptimizerProposal) => {
    const unverified = p.actionability === 'candidate-unverified';
    const warn = unverified
      ? '\n\nThis proposal is CANDIDATE (UNVERIFIED) — the derivation gate has not cleared. It will be stamped unverified_at_apply.'
      : '';
    const ok = window.confirm(
      `Mark "${p.title}" as applied?\n\nThis records an intent row only — it does NOT edit any file. You still make the actual edit yourself.${warn}`,
    );
    if (!ok) return;
    setApplied((s) => ({ ...s, [p.id]: 'pending' }));
    const watchLane: AgentRoleLane = p.attribution.lane ?? p.target.lane ?? 'worker';
    const req: MarkOptimizerActionAppliedRequest = {
      proposalId: p.id,
      kind: p.kind,
      lane: watchLane,
      target: p.target,
      proposedEdit: { summary: p.proposedEdit?.summary ?? p.title },
      watchLanes: [watchLane],
      // Bug-4: subagent basis MUST match the verdict — toolset grants pool subagents.
      includeSubagents: p.kind === 'subtract-unused-toolset',
      unverifiedAtApply: unverified,
    };
    try {
      const res = await window.api.contextOptimizer.markApplied(req);
      setApplied((s) => ({ ...s, [p.id]: res.ok ? 'done' : res.error }));
    } catch (e) {
      setApplied((s) => ({ ...s, [p.id]: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  const byLeverGroup = useMemo(() => {
    const map = new Map<string, ContextOptimizerProposal[]>();
    for (const g of LEVER_GROUPS) map.set(g.key, []);
    for (const p of result?.proposals ?? []) {
      // WP-B1: default view = the default-surfaced set (same predicate the MCP list
      // filter uses, so the two surfaces show the same rows). Hidden rows only when the
      // toggle is on.
      if (!showHidden && !isProposalDefaultSurfaced(p)) continue;
      const g = LEVER_GROUPS.find((lg) => lg.levers.includes(p.lever));
      if (g) map.get(g.key)!.push(p);
    }
    // WP-B1: within each lever group, agent-actionable proposals rank first — the same
    // primary sort key as the DTO page. Array.sort is stable, so the existing per-tier
    // ordering within a hasActionableContent bucket is preserved.
    for (const arr of map.values()) {
      arr.sort((a, b) =>
        (proposalHasActionableContent(b) ? 1 : 0) - (proposalHasActionableContent(a) ? 1 : 0));
    }
    return map;
  }, [result, showHidden]);

  const hasProposals = (result?.proposals.length ?? 0) > 0;
  const hiddenCount = useMemo(
    () => (result?.proposals ?? []).filter((p) => !isProposalDefaultSurfaced(p)).length,
    [result],
  );

  return (
    <div className="h-full overflow-auto bg-surface-0 text-[13px]">
      <div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2.5 bg-surface-0/95 backdrop-blur border-b dark:border-white/10 light:border-black/10">
        <SlidersHorizontal size={16} className="text-accent-blue-bright shrink-0" />
        <span className="font-medium">Context Optimizer</span>
        {result && (
          <span className="text-[11px] text-gray-400">
            {result.proposals.length} proposals · {result.modelStats.behaviorEvents} events · deterministic
            {result.meta.unverifiedSuppressedCount > 0 && (
              <> · {result.meta.unverifiedSuppressedCount} suppressed from agent surface</>
            )}
          </span>
        )}
        <button
          onClick={() => void load()}
          disabled={loading || !selectedWorkspaceId}
          className="ml-auto flex items-center gap-1.5 px-2 py-1 rounded text-[12px] hover:bg-white/10 disabled:opacity-50"
          title={selectedWorkspaceId ? 'Run analysis' : 'Select a workspace to analyze'}
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Run analysis
        </button>
      </div>

      <div className="p-4 space-y-4">
        <HowThisWorks />
        <div className="flex items-start gap-2 text-[11px] text-gray-500">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>Behavior-grounded suggestions only. Nothing here edits a file automatically — “Mark applied” records intent so outcomes can be reconciled later.</span>
        </div>

        {result && hasProposals && (
          <HiddenRowsToggle showHidden={showHidden} hiddenCount={hiddenCount} onToggle={setShowHidden} />
        )}

        {!selectedWorkspaceId && (
          <div className="ui-card p-4 text-gray-400">
            <div className="font-medium text-gray-300 mb-1">Select a workspace to analyze</div>
            <p className="text-[12px]">
              The optimizer analyzes one workspace's behavior corpus and resident config. Pick a workspace
              in the sidebar, then press <span className="text-gray-300">Run analysis</span>.
            </p>
          </div>
        )}

        {loading && !result && <div className="flex items-center gap-2 text-gray-400"><Loader2 size={14} className="animate-spin" /> Analyzing corpus…</div>}
        {error && (
          <div className="flex items-start gap-2 text-red-400">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>Analysis failed: {error}</span>
          </div>
        )}

        {result && !hasProposals && !loading && (
          <div className="ui-card p-4 text-gray-400">
            <div className="font-medium text-gray-300 mb-1">No proposals yet</div>
            <p className="text-[12px]">
              The optimizer produced no ranked proposals for the current corpus. This is the honest empty
              state — either the behavior corpus has insufficient exposure, or the per-lane inputs have not
              been assembled for this run. See “Not analyzable” below for sections the engine could see but
              could not score.
            </p>
          </div>
        )}

        {result && hasProposals && LEVER_GROUPS.map((g) => {
          const proposals = byLeverGroup.get(g.key) ?? [];
          if (proposals.length === 0) return null;
          return (
            <LeverSection
              key={g.key}
              group={g}
              proposals={proposals}
              applied={applied}
              onMarkApplied={markApplied}
              onOpenTarget={openTarget}
            />
          );
        })}

        {result && result.fileHeat.length > 0 && <FileHeatSection fileHeat={result.fileHeat} />}
        {result && result.modelStats.notAnalyzable.length > 0 && (
          <NotAnalyzableSection rows={result.modelStats.notAnalyzable} />
        )}
        {result && <ModelStatsFooter result={result} />}
      </div>
    </div>
  );
}

function LeverSection({ group, proposals, applied, onMarkApplied, onOpenTarget }: {
  group: LeverGroup;
  proposals: ContextOptimizerProposal[];
  applied: Record<string, 'pending' | 'done' | string>;
  onMarkApplied: (p: ContextOptimizerProposal) => void;
  onOpenTarget: (p: ContextOptimizerProposal) => void;
}): JSX.Element {
  // Hard tier grouping WITHIN the lever — never blended across tiers (§7.3).
  const byTier = useMemo(() => {
    const m = new Map<BehaviorEvidenceTier, ContextOptimizerProposal[]>();
    for (const p of proposals) {
      if (!m.has(p.confidence)) m.set(p.confidence, []);
      m.get(p.confidence)!.push(p);
    }
    return m;
  }, [proposals]);

  return (
    <div className="ui-card overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b dark:border-white/10 light:border-black/10">
        {group.icon}
        <span className="font-medium">{group.label}</span>
        <span className="text-[11px] text-gray-500">({proposals.length})</span>
      </div>
      <div className="p-3 space-y-4">
        {TIER_ORDER.filter((t) => byTier.has(t)).map((tier) => (
          <div key={tier}>
            <div className="flex items-center gap-2 mb-2">
              <span
                className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded"
                style={{ color: TIER_COLOR[tier], backgroundColor: TIER_COLOR[tier] + '22' }}
              >
                {TIER_LABEL[tier]}
              </span>
              <span className="text-[10px] text-gray-500">{byTier.get(tier)!.length}</span>
            </div>
            <div className="space-y-2.5">
              {byTier.get(tier)!.map((p) => (
                <ProposalCard key={p.id} p={p} applied={applied[p.id]} onMarkApplied={onMarkApplied} onOpenTarget={onOpenTarget} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProposalCard({ p, applied, onMarkApplied, onOpenTarget }: {
  p: ContextOptimizerProposal;
  applied?: 'pending' | 'done' | string;
  onMarkApplied: (p: ContextOptimizerProposal) => void;
  onOpenTarget: (p: ContextOptimizerProposal) => void;
}): JSX.Element {
  const unverified = p.actionability === 'candidate-unverified';
  const hasSpan = !!p.target.absPath && p.target.lineStart != null;
  return (
    <div className="rounded border dark:border-white/10 light:border-black/10 overflow-hidden">
      {unverified && (
        <div className="flex items-center gap-1.5 px-3 py-1 bg-amber-500/15 text-amber-400 text-[10px]">
          <ShieldAlert size={12} className="shrink-0" />
          Unverified candidate — derivation gate not cleared; relay with an explicit caveat.
        </div>
      )}
      <div className="p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-gray-200 text-[12.5px] truncate" title={p.title}>{p.title}</div>
            <p className="text-[11.5px] text-gray-400 mt-0.5">{p.rationale}</p>
            {p.target.rollup && (
              // WP-B2 seam: a hash-only cluster rollup — one row standing in for
              // `count` bare-hash clusters along `dimension`. Per-cluster exemplar
              // rendering (a representative command) is a documented downstream seam,
              // NOT built here (exemplar is null upstream — no fabricated example).
              <p className="text-[10.5px] text-amber-300/80 mt-1">
                Rollup of {p.target.rollup.count} hash-only clusters ({p.target.rollup.dimension}) — drill for exemplars.
              </p>
            )}
          </div>
          <MarkAppliedButton p={p} applied={applied} onMarkApplied={onMarkApplied} />
        </div>

        <div className="flex flex-wrap gap-1.5 mt-2 text-[10px]">
          <Chip title="proposal kind">{p.kind}</Chip>
          <Chip title="observed occurrence classification">{p.occurrence}</Chip>
          <Chip title="epoch birth confidence (intra-tier down-rank)">epoch: {p.epochConfidence}</Chip>
          <Chip title="resident token delta (cl100k proxy)">
            {fmtSigned(p.residentTokenDelta.estimate)} tok · {p.residentTokenDelta.basis}
          </Chip>
          <Chip title="tokenTurnsWeight = residentTokens × exposureTurns (ranking)">
            weight {fmtNum(p.tokenTurnsWeight)}
          </Chip>
          <Chip title="exposure denominator">
            {p.exposure.turns} turns · {p.exposure.streams} streams · {p.exposure.slugs} slugs
          </Chip>
          <Chip title="edit-target mutability class">{p.target.mutable}</Chip>
        </div>

        {(p.attribution.sharedCwdRisk !== 'none' || p.attribution.caveat) && (
          <div className="mt-2 text-[10.5px] text-amber-300/80 flex items-start gap-1.5">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
            <span>
              shared-cwd risk: {p.attribution.sharedCwdRisk}
              {p.attribution.caveat ? ` — ${p.attribution.caveat}` : ''}
            </span>
          </div>
        )}

        {p.costEvidence && <CostEvidenceLine ev={p.costEvidence} />}
        {p.phraseGap && p.phraseGap.terms.length > 0 && <PhraseGapLine gap={p.phraseGap} />}

        {p.target.absPath && (
          <div className="mt-2 text-[10.5px] text-gray-500 flex items-center gap-1.5">
            <FileText size={11} className="shrink-0" />
            <span className="truncate" title={p.target.absPath}>
              {p.target.absPath}
              {p.target.lineStart != null && `:${p.target.lineStart}${p.target.lineEnd != null ? `–${p.target.lineEnd}` : ''}`}
            </span>
            {hasSpan && (
              <button
                onClick={() => onOpenTarget(p)}
                className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border dark:border-white/15 light:border-black/15 text-gray-300 hover:bg-white/10"
                title="Open the CLAUDE.md target in source mode, scrolled to this span (you make the edit)"
              >
                <ExternalLink size={10} /> Open in CLAUDE.md
              </button>
            )}
          </div>
        )}

        {p.citations.length > 0 && <Citations citations={p.citations} />}

        {p.proposedEdit && (
          <div className="mt-2 text-[10.5px] text-gray-400">
            <span className="text-gray-500">Proposed edit: </span>{p.proposedEdit.summary}
          </div>
        )}
        {typeof applied === 'string' && applied !== 'done' && applied !== 'pending' && (
          <div className="mt-1.5 text-[10.5px] text-red-400">Mark-applied failed: {applied}</div>
        )}
      </div>
    </div>
  );
}

function MarkAppliedButton({ p, applied, onMarkApplied }: {
  p: ContextOptimizerProposal;
  applied?: 'pending' | 'done' | string;
  onMarkApplied: (p: ContextOptimizerProposal) => void;
}): JSX.Element {
  if (applied === 'done') {
    return (
      <span className="shrink-0 flex items-center gap-1 text-[10.5px] text-emerald-400">
        <CheckCircle2 size={13} /> Marked applied
      </span>
    );
  }
  return (
    <button
      onClick={() => onMarkApplied(p)}
      disabled={applied === 'pending'}
      className="shrink-0 px-2 py-1 rounded text-[10.5px] border dark:border-white/15 light:border-black/15 hover:bg-white/10 disabled:opacity-50"
      title="Record an intent row (does not edit any file)"
    >
      {applied === 'pending' ? 'Marking…' : 'Mark applied'}
    </button>
  );
}

function CostEvidenceLine({ ev }: { ev: NonNullable<ContextOptimizerProposal['costEvidence']> }): JSX.Element {
  const parts: string[] = [];
  if (ev.improvisedPathTokensPer100Turns != null) parts.push(`improvised ${fmtNum(ev.improvisedPathTokensPer100Turns)} tok/100 turns`);
  if (ev.skillPathTokensPerInvocation != null) parts.push(`skill ${fmtNum(ev.skillPathTokensPerInvocation)} tok/invoke`);
  if (ev.residentTokensTimesExposure != null) parts.push(`resident×exposure ${fmtNum(ev.residentTokensTimesExposure)}`);
  if (parts.length === 0 && !ev.note) return <></>;
  return (
    <div className="mt-2 text-[10.5px] text-gray-400 flex items-start gap-1.5">
      <Coins size={11} className="mt-0.5 shrink-0 text-amber-400/70" />
      <span>{parts.join(' · ')}{ev.note ? `${parts.length ? ' — ' : ''}${ev.note}` : ''}</span>
    </div>
  );
}

function PhraseGapLine({ gap }: { gap: NonNullable<ContextOptimizerProposal['phraseGap']> }): JSX.Element {
  return (
    <div className="mt-2 text-[10.5px]">
      <div className="flex items-center gap-1.5 text-gray-500 mb-1">
        <Quote size={11} className="shrink-0" /> Phrase gap (bypass vs. invocation triggers)
      </div>
      <div className="flex flex-wrap gap-1">
        {gap.terms.slice(0, 12).map((t, i) => (
          <span
            key={i}
            className="px-1 rounded bg-white/5 text-gray-300 tabular-nums"
            title={`gap ${t.gapBps}bps · lift ${t.liftBps}bps`}
          >
            {t.term} <span className="text-gray-500">{t.bypassCount}/{t.invocationCount}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Citations({ citations }: { citations: ContextOptimizerProposal['citations'] }): JSX.Element {
  return (
    <div className="mt-2 text-[10px] text-gray-500">
      <span className="text-gray-600">Citations: </span>
      {citations.slice(0, 6).map((c, i) => (
        <span key={i} className="inline-flex items-center gap-1 mr-2">
          <span className={c.source === 'staticOverheadModel' ? 'text-cyan-400/70' : 'text-violet-400/70'}>
            {c.source === 'staticOverheadModel' ? 'static' : 'chatlog'}
          </span>
          {c.absPath && <span className="text-gray-500" title={c.absPath}>{c.absPath.split(/[\\/]/).pop()}{c.line != null ? `:${c.line}` : ''}</span>}
          {c.streamId && <span className="text-gray-600" title={c.streamId}>stream {c.streamId.slice(0, 8)}</span>}
        </span>
      ))}
      {citations.length > 6 && <span className="text-gray-600">+{citations.length - 6} more</span>}
    </div>
  );
}

function FileHeatSection({ fileHeat }: { fileHeat: FileHeatRollupEntry[] }): JSX.Element {
  return (
    <div className="ui-card overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b dark:border-white/10 light:border-black/10">
        <Flame size={15} className="text-orange-400" />
        <span className="font-medium">File heat</span>
        <span className="text-[11px] text-gray-500">({fileHeat.length}) · redacted paths</span>
      </div>
      <div className="p-3 overflow-x-auto">
        <table className="w-full text-[11px] min-w-[560px]">
          <thead className="text-gray-400 text-left">
            <tr className="border-b dark:border-white/5 light:border-black/5">
              <th className="px-2 py-1 font-normal">Path</th>
              <th className="px-2 py-1 font-normal">Lane</th>
              <th className="px-2 py-1 font-normal">Coverage</th>
              <th className="px-2 py-1 font-normal text-right">R / W / X</th>
              <th className="px-2 py-1 font-normal text-right">Streams</th>
              <th className="px-2 py-1 font-normal">Match</th>
            </tr>
          </thead>
          <tbody>
            {fileHeat.map((h, i) => (
              <tr key={i} className={`border-b dark:border-white/5 light:border-black/5 last:border-0 ${h.uncovered ? 'bg-orange-500/5' : ''}`}>
                <td className="px-2 py-1 truncate max-w-[220px]" title={h.pathDisplay}>
                  {h.uncovered && <Flame size={10} className="inline mr-1 text-orange-400" />}
                  {h.pathDisplay}
                </td>
                <td className="px-2 py-1 text-gray-400">{h.lane}</td>
                <td className="px-2 py-1 text-gray-400">{h.coverage}{h.uncovered ? ' · uncovered' : ''}</td>
                <td className="px-2 py-1 text-right tabular-nums text-gray-400">{h.reads} / {h.writes} / {h.executes}</td>
                <td className="px-2 py-1 text-right tabular-nums text-gray-400">{h.distinctStreams}</td>
                <td className="px-2 py-1 text-gray-500">{h.matchConfidence ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NotAnalyzableSection({ rows }: { rows: ContextOptimizerResult['modelStats']['notAnalyzable'] }): JSX.Element {
  return (
    <div className="ui-card overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b dark:border-white/10 light:border-black/10">
        <EyeOff size={15} className="text-gray-400" />
        <span className="font-medium">Not analyzable</span>
        <span className="text-[11px] text-gray-500">({rows.length}) · unobservable + insufficient exposure</span>
      </div>
      <ul className="p-3 space-y-1 text-[11px]">
        {rows.map((r, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="px-1 rounded bg-white/5 text-gray-400 shrink-0">{r.label}</span>
            {r.lane && <span className="text-gray-500 shrink-0">{r.lane}</span>}
            <span className="text-gray-500 truncate" title={r.absPath}>{r.absPath}:{r.line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ModelStatsFooter({ result }: { result: ContextOptimizerResult }): JSX.Element {
  return (
    <div className="ui-card p-3 text-[11px] text-gray-400 space-y-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span>events: <span className="tabular-nums text-gray-300">{result.modelStats.behaviorEvents}</span></span>
        <span>attribution warnings: <span className="tabular-nums text-gray-300">{result.modelStats.attributionWarnings}</span></span>
        <span>suppressed from agent surface: <span className="tabular-nums text-gray-300">{result.meta.unverifiedSuppressedCount}</span></span>
        <span className="text-gray-500">generated {new Date(result.generatedAtIso).toLocaleString()}</span>
      </div>
      {result.modelStats.residentTokensByLane.length > 0 && (
        <div className="overflow-x-auto">
          <table className="text-[10.5px] min-w-[520px]">
            <thead className="text-gray-500 text-left">
              <tr>
                <th className="px-2 py-0.5 font-normal">Lane</th>
                <th className="px-2 py-0.5 font-normal text-right">Resident</th>
                <th className="px-2 py-0.5 font-normal text-right">Claude</th>
                <th className="px-2 py-0.5 font-normal text-right">MCP</th>
                <th className="px-2 py-0.5 font-normal text-right">Skill hdrs</th>
                <th className="px-2 py-0.5 font-normal text-right">Exposure turns</th>
              </tr>
            </thead>
            <tbody>
              {result.modelStats.residentTokensByLane.map((r, i) => (
                <tr key={i}>
                  <td className="px-2 py-0.5">{r.lane}</td>
                  <td className="px-2 py-0.5 text-right tabular-nums">{fmtNum(r.total)}</td>
                  <td className="px-2 py-0.5 text-right tabular-nums">{fmtNum(r.claude)}</td>
                  <td className="px-2 py-0.5 text-right tabular-nums">{fmtNum(r.mcp)}</td>
                  <td className="px-2 py-0.5 text-right tabular-nums">{fmtNum(r.skillHeaders)}</td>
                  <td className="px-2 py-0.5 text-right tabular-nums">{r.exposureTurns}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Chip({ children, title }: { children: React.ReactNode; title?: string }): JSX.Element {
  return <span className="px-1 rounded bg-white/5 text-gray-400" title={title}>{children}</span>;
}

// WP-B1 — segmented control for the default vs. all view. The default view mirrors the
// MCP default page (the default-surfaced set); "All" reveals the non-default rows
// (hash-only clusters, no-target / zero-cost proposals) that would otherwise crowd out
// the actionable insights.
function HiddenRowsToggle({ showHidden, hiddenCount, onToggle }: {
  showHidden: boolean;
  hiddenCount: number;
  onToggle: (v: boolean) => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <div className="inline-flex rounded border dark:border-white/10 light:border-black/10 overflow-hidden">
        <button
          onClick={() => onToggle(false)}
          className={`px-2.5 py-1 ${!showHidden ? 'bg-white/10 text-gray-200' : 'text-gray-400 hover:bg-white/5'}`}
          title="Show only the default-surfaced, agent-actionable proposals (matches the MCP default page)"
        >
          Default view
        </button>
        <button
          onClick={() => onToggle(true)}
          disabled={hiddenCount === 0 && !showHidden}
          className={`px-2.5 py-1 border-l dark:border-white/10 light:border-black/10 flex items-center gap-1 ${showHidden ? 'bg-white/10 text-gray-200' : 'text-gray-400 hover:bg-white/5 disabled:opacity-50'}`}
          title="Also show hidden non-default rows (hash-only clusters, no-target / zero-cost proposals)"
        >
          <EyeOff size={11} /> Show hidden{hiddenCount > 0 ? ` (${hiddenCount})` : ''}
        </button>
      </div>
      {hiddenCount === 0 && (
        <span className="text-gray-500">No hidden rows — every proposal is on the default surface.</span>
      )}
    </div>
  );
}

// WP6.2 — the explainer that answers "no idea how this works". States the verified
// pipeline and renders the explicit stage strip: data → insight → proposed edit →
// your gate → applied. Collapsible so it stays out of the way once understood.
const STAGES = ['data', 'insight', 'proposed edit', 'your gate', 'applied'];
function HowThisWorks(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="ui-card overflow-hidden">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 text-left">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Info size={14} className="text-accent-blue-bright shrink-0" />
        <span className="font-medium text-[12.5px]">How this works</span>
        <div className="ml-auto flex items-center gap-1 text-[10px] text-gray-500">
          {STAGES.map((s, i) => (
            <React.Fragment key={s}>
              <span className="px-1.5 py-0.5 rounded bg-white/5 text-gray-400">{s}</span>
              {i < STAGES.length - 1 && <ChevronRight size={10} className="text-gray-600" />}
            </React.Fragment>
          ))}
        </div>
      </button>
      {open && (
        <div className="px-3 py-2.5 text-[11.5px] text-gray-400 space-y-2 border-t dark:border-white/10 light:border-black/10">
          <p>
            Proposals are generated <span className="text-gray-300">on demand</span> when you open this panel or press
            <span className="text-gray-300"> Run analysis</span> — there is no background job. The engine reads
            (1) the <span className="text-gray-300">behavior corpus</span> (every tool / skill / file event parsed
            from agent transcripts), (2) each lane's <span className="text-gray-300">resident config</span>
            (CLAUDE.md / skills / MCP), and (3) <span className="text-gray-300">toolset grants vs. the live registry</span>.
            It cross-joins them deterministically (no LLM) into ranked, human-gated suggestions.
          </p>
          <p>
            Nothing here edits a file — <span className="text-gray-300">“Mark applied” records intent only</span>. Use
            <span className="text-gray-300"> “Open in CLAUDE.md”</span> to jump to the exact span and make the edit yourself.
          </p>
        </div>
      )}
    </div>
  );
}
