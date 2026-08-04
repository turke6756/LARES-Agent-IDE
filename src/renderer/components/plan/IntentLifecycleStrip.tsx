import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  PlanDocumentRef,
  PlanDocumentsModel,
  PlanIntentOutputProjection,
  PlanIntentProjection,
  PlanIntentRung,
  PlanIntentsProjection,
  PlanTabKey,
} from '../../../shared/types';

// WP-P4F — the intent-lifecycle strip. A persistent, compact strip mounted ABOVE
// the plan tab body (not a document tab). It consumes the EXISTING P2L projection
// IPC `plan:intents:list` (`plans.listIntents`) — it mints no channel and never
// extends P2L. Each intent shows its rung ladder (marked → ran → returned →
// folded-in) and expands IN PLACE to per-output detail; there is one UI shape, no
// separate tab.
//
// Load-bearing rulings encoded here:
//   • Each output is listed INDEPENDENTLY (§R1) — a folded rerun never hides
//     another pending result; missing rows are never collapsed away.
//   • An unfolded, present, `active` output is OPEN, never silently complete
//     (ruling 12) — see `outputStatus`.
//   • `ran` is authoritative ONLY from the ledger orchestration join
//     (`intent.ran`); a self-declared orchestration id on an output is never
//     treated as authority. Pre-ledger reads show "ran: unavailable".
//   • The confidence/compute readout is DERIVED (ruling 14) — rendered from the
//     projection's derived counts, never self-asserted.
//   • Deep-link: an output's `relPath` is cross-indexed against the CURRENT
//     WP-P4A manifest (`model`); a match opens that manifest id in its tab, a
//     miss (missing / history-only) stays visible but non-clickable.

/** The ordered rungs of the lifecycle ladder. */
const RUNG_LADDER: readonly PlanIntentRung[] = ['marked', 'ran', 'returned', 'folded-in'];

export interface DeepLinkTarget {
  key: PlanTabKey;
  ref: PlanDocumentRef;
}

/** Cross-index a ledger output `relPath` (a folder-relative POSIX-ish path, never
 *  a manifest id) against the CURRENT WP-P4A manifest. The projected manifest
 *  document carries only its basename + tab, so we match on basename and, when a
 *  basename is ambiguous across tabs, prefer the tab whose key equals the path's
 *  leading segment (`deliberations/…` → the `deliberations` tab). Returns null for
 *  a missing / history-only output — the caller renders it non-clickable. */
export function crossIndexOutput(
  model: PlanDocumentsModel | null,
  relPath: string,
): DeepLinkTarget | null {
  if (!model || !relPath) return null;
  const posix = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const base = posix.split('/').pop() ?? posix;
  if (!base) return null;
  const seg = posix.includes('/') ? posix.split('/')[0] : null;
  const matches: DeepLinkTarget[] = [];
  for (const tab of model.tabs) {
    for (const doc of tab.documents) {
      if (doc.name === base) matches.push({ key: tab.key, ref: doc.ref });
    }
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  return matches.find((m) => m.key === seg) ?? matches[0];
}

export type OutputStatus = 'open' | 'folded-in' | 'missing' | 'superseded' | 'withdrawn';

/** Ruling 12 — an unfolded, present, `active` output is OPEN, never silently
 *  complete. Disposition (withdrawn / superseded) and disk-absence are surfaced
 *  first; only a present, active, folded output reads as folded-in. */
export function outputStatus(o: PlanIntentOutputProjection): OutputStatus {
  if (o.disposition === 'withdrawn') return 'withdrawn';
  if (o.disposition === 'superseded') return 'superseded';
  if (!o.presentOnDisk) return 'missing';
  if (o.foldedIn) return 'folded-in';
  return 'open';
}

/** The `ran` readout is driven STRICTLY by the authoritative ledger join
 *  (`intent.ran`) — never by a self-declared orchestration id on an output. */
function ranReadout(intent: PlanIntentProjection): string {
  if (!intent.ran) return 'ran: unavailable';
  const running = intent.runs.some((r) => r.state === 'running' || r.state === 'dispatched');
  return running ? 'ran: in service of this marked part' : 'ran';
}

const STATUS_LABEL: Record<OutputStatus, string> = {
  open: 'open',
  'folded-in': 'folded in',
  missing: 'missing',
  superseded: 'superseded',
  withdrawn: 'withdrawn',
};

function IntentRow({
  intent,
  model,
  expanded,
  onToggle,
  onOpenDocument,
}: {
  intent: PlanIntentProjection;
  model: PlanDocumentsModel | null;
  expanded: boolean;
  onToggle: () => void;
  onOpenDocument: (key: PlanTabKey, ref: PlanDocumentRef) => void;
}): React.ReactElement {
  const currentRung = RUNG_LADDER.indexOf(intent.rung);
  const lifecycleTag = intent.withdrawn ? 'withdrawn' : intent.superseded ? 'superseded' : null;

  return (
    <div
      className="border-b border-white/5 last:border-b-0"
      data-testid="intent-row"
      data-intent-id={intent.intentId}
      data-rung={intent.rung}
      data-status={intent.status}
      data-open={intent.open ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        data-testid="intent-expand"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[0.04]"
      >
        <span className="text-[10px] text-gray-500">{expanded ? '▾' : '▸'}</span>
        {/* Rung ladder — reached rungs are highlighted; the ladder is the intent's
            lifecycle at a glance. */}
        <span className="flex items-center gap-1" data-testid="intent-rungs" data-current-rung={intent.rung}>
          {RUNG_LADDER.map((rung, i) => (
            <React.Fragment key={rung}>
              {i > 0 && <span className="text-[9px] text-gray-600">→</span>}
              <span
                data-testid="intent-rung"
                data-rung={rung}
                data-reached={i <= currentRung ? 'true' : 'false'}
                className={`text-[10px] ${i <= currentRung ? 'text-accent-blue' : 'text-gray-600'}`}
              >
                {rung}
              </span>
            </React.Fragment>
          ))}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {lifecycleTag && (
            <span
              className="rounded bg-surface-2 px-1 text-[9px] uppercase text-amber-400"
              data-testid="intent-lifecycle-tag"
            >
              {lifecycleTag}
            </span>
          )}
          {intent.open && (
            <span className="rounded bg-surface-2 px-1 text-[9px] uppercase text-emerald-400" data-testid="intent-open-tag">
              open
            </span>
          )}
          <span className="text-[10px] text-gray-500" data-testid="intent-ran">
            {ranReadout(intent)}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-2 pl-8" data-testid="intent-outputs">
          {intent.integrationNote && (
            <div className="mb-1 text-[11px] text-gray-400" data-testid="intent-integration-note">
              {intent.integrationNote}
            </div>
          )}
          {intent.outputs.length === 0 ? (
            <div className="text-[11px] italic text-gray-500" data-testid="intent-no-outputs">
              no results yet
            </div>
          ) : (
            <ul className="space-y-0.5">
              {intent.outputs.map((o, idx) => {
                const status = outputStatus(o);
                const target = crossIndexOutput(model, o.relPath);
                return (
                  <li
                    key={`${o.relPath}:${idx}`}
                    className="flex items-center gap-2 text-[11px]"
                    data-testid="intent-output"
                    data-status={status}
                    data-present={o.presentOnDisk ? 'true' : 'false'}
                    data-folded={o.foldedIn ? 'true' : 'false'}
                  >
                    <span
                      className={`shrink-0 rounded px-1 text-[9px] uppercase ${
                        status === 'open'
                          ? 'bg-emerald-500/15 text-emerald-400'
                          : status === 'folded-in'
                            ? 'bg-surface-2 text-gray-400'
                            : 'bg-surface-2 text-amber-400'
                      }`}
                    >
                      {STATUS_LABEL[status]}
                    </span>
                    {target ? (
                      <button
                        type="button"
                        onClick={() => onOpenDocument(target.key, target.ref)}
                        data-testid="intent-output-link"
                        data-tab-key={target.key}
                        className="truncate text-left text-accent-blue hover:underline"
                        title={o.relPath}
                      >
                        {o.relPath}
                      </button>
                    ) : (
                      <span className="truncate text-gray-400" data-testid="intent-output-static" title={o.relPath}>
                        {o.relPath}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function IntentLifecycleStrip({
  planId,
  model,
  onOpenDocument,
}: {
  planId: string;
  /** The current WP-P4A manifest, for the deep-link cross-index. */
  model: PlanDocumentsModel | null;
  /** Controlled-selection seam: switch to `key` and open `ref` (manifest id). */
  onOpenDocument: (key: PlanTabKey, ref: PlanDocumentRef) => void;
}): React.ReactElement | null {
  const [data, setData] = useState<PlanIntentsProjection | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let active = true;
    setData(null);
    setExpanded(new Set());
    // Consume the EXISTING P2L IPC. If the binding is absent (older preload, or a
    // test harness that doesn't wire it) treat it as "no strip" rather than
    // throwing — the strip is additive and must never break the document home.
    const fn = window.api?.plans?.listIntents;
    if (typeof fn !== 'function') {
      return () => {
        active = false;
      };
    }
    void Promise.resolve(fn(planId))
      .then((res) => {
        if (active) setData(res ?? null);
      })
      .catch(() => {
        if (active) setData(null);
      });
    return () => {
      active = false;
    };
  }, [planId]);

  const toggle = useCallback((intentId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(intentId)) next.delete(intentId);
      else next.add(intentId);
      return next;
    });
  }, []);

  const confidence = data?.confidence;
  const confidenceText = useMemo(() => {
    if (!confidence) return null;
    return `marked ${confidence.markedIntents} · satisfied ${confidence.satisfiedIntents} · open ${confidence.openIntents} · deliberations ${confidence.deliberationsRun} · final plan ${confidence.finalPlanExists ? 'yes' : 'no'}`;
  }, [confidence]);

  // No projection at all (pre-P2L / IPC absent) → render nothing, so the document
  // home is untouched. An EMPTY-but-present projection still shows the strip (its
  // derived confidence readout is meaningful pre-ledger).
  if (!data) return null;

  return (
    <div
      className="shrink-0 border-b border-white/10 bg-surface-1/30"
      data-testid="intent-strip"
      role="region"
      aria-label="Intent lifecycle"
    >
      <div className="flex items-center justify-between px-3 py-1">
        <span className="text-[10px] uppercase tracking-wide text-gray-500">Intent lifecycle</span>
        {confidenceText && (
          <span className="text-[10px] text-gray-500" data-testid="intent-confidence" title="Derived from the ledger, orchestration join, and disk — never self-asserted">
            <span className="mr-1 rounded bg-surface-2 px-1 text-[8px] uppercase text-gray-500">derived</span>
            {confidenceText}
          </span>
        )}
      </div>
      {data.intents.length === 0 ? (
        <div className="px-3 pb-1.5 text-[11px] italic text-gray-500" data-testid="intent-empty">
          no intents marked yet
        </div>
      ) : (
        <div className="max-h-48 overflow-y-auto">
          {data.intents.map((intent) => (
            <IntentRow
              key={intent.intentId}
              intent={intent}
              model={model}
              expanded={expanded.has(intent.intentId)}
              onToggle={() => toggle(intent.intentId)}
              onOpenDocument={onOpenDocument}
            />
          ))}
        </div>
      )}
    </div>
  );
}
