// Idle-agent lifecycle §B8 — "Stop stale idle agents" section of the System
// Memory view.
//
// Three deliberate properties:
//
//   1. PREVIEW BEFORE ACTION. `previewStaleIdle()` is always run first and its
//      result is what the Stop button acts on the description of. Nothing is
//      stopped from a bare click.
//   2. THE PREVIEW IS PINNED TO A THRESHOLD. Main computes the preview against
//      the PERSISTED threshold, so changing the selector invalidates the
//      on-screen preview rather than leaving a 24h result sitting under a "7d"
//      selector — the panel compares `preview.thresholdLabel` to the live
//      setting and refuses to act on a mismatch.
//   3. EXCLUSIONS ARE SHOWN, NOT HIDDEN. Every agent the sweep would leave
//      alone is listed with its reason (via `stop-exclusion-copy`), so "3 of 11"
//      never reads as "the other 8 don't exist".
//
// Results are reported honestly: a `failed` item means the process was NOT
// confirmed gone, and it is rendered as a failure, never folded into a count of
// "stopped".

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as Icons from 'lucide-react';
import type {
  AutoStopThreshold,
  BulkStopResult,
  LifecycleSettings,
  StaleIdlePreview,
} from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import { groupExclusionsByCode, summarizeStopExclusions } from '../../lib/stop-exclusion-copy';
import { formatBytes } from './format';

/** Selector options. Order and values mirror `AutoStopThreshold` exactly. */
const THRESHOLD_OPTIONS: Array<{ value: AutoStopThreshold; label: string }> = [
  { value: 'never', label: 'Never (off)' },
  { value: '6h', label: 'After 6 hours idle' },
  { value: '12h', label: 'After 12 hours idle' },
  { value: '24h', label: 'After 24 hours idle' },
  { value: '3d', label: 'After 3 days idle' },
  { value: '7d', label: 'After 7 days idle' },
];

const THRESHOLD_PHRASE: Record<AutoStopThreshold, string> = {
  never: 'never',
  '6h': '6 hours',
  '12h': '12 hours',
  '24h': '24 hours',
  '3d': '3 days',
  '7d': '7 days',
};

function idleFor(idleSince: string): string {
  // SQLite `datetime('now')` has no zone marker and must not be read as local.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(idleSince)
    ? `${idleSince.replace(' ', 'T')}Z`
    : idleSince;
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) return 'unknown';
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / 1440)}d`;
}

export default function StopStaleIdlePanel() {
  const agents = useDashboardStore((s) => s.agents);
  const [settings, setSettings] = useState<LifecycleSettings | null>(null);
  const [preview, setPreview] = useState<StaleIdlePreview | null>(null);
  const [busy, setBusy] = useState<null | 'preview' | 'stop' | 'settings'>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkStopResult | null>(null);

  const titleOf = useCallback(
    (agentId: string) => agents.find((a) => a.id === agentId)?.title ?? agentId,
    [agents],
  );

  // Load once, then ride the main-process broadcast. A second window (or the
  // sweep's own settings read) changing the threshold must not leave this panel
  // acting on a stale one.
  useEffect(() => {
    let live = true;
    window.api.lifecycle
      .getSettings()
      .then((s) => { if (live) setSettings(s); })
      .catch((e) => { if (live) setError(String(e)); });
    const unsub = window.api.lifecycle.onSettingsChanged((s) => {
      if (!live) return;
      setSettings(s);
    });
    return () => { live = false; unsub(); };
  }, []);

  const threshold = settings?.autoStopIdleThreshold ?? null;

  // A preview computed against a DIFFERENT threshold than the one now in force
  // describes a sweep that will not happen. Surface it and block the action.
  const previewStale = preview !== null && threshold !== null && preview.thresholdLabel !== threshold;

  const onThresholdChange = useCallback(async (value: AutoStopThreshold) => {
    setBusy('settings');
    setError(null);
    try {
      const saved = await window.api.lifecycle.setSettings({ autoStopIdleThreshold: value });
      setSettings(saved);
      // The old preview described the old threshold — drop it rather than let
      // it sit under the new selector looking current.
      setPreview(null);
      setResult(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const runPreview = useCallback(async () => {
    setBusy('preview');
    setError(null);
    setResult(null);
    try {
      setPreview(await window.api.agents.previewStaleIdle());
    } catch (e) {
      setError(String(e));
      setPreview(null);
    } finally {
      setBusy(null);
    }
  }, []);

  const runStop = useCallback(async () => {
    setBusy('stop');
    setError(null);
    try {
      const r = await window.api.agents.stopStaleIdle();
      setResult(r);
      // The world just changed; the old preview is history. Re-preview so the
      // panel shows what is left rather than what was.
      setPreview(await window.api.agents.previewStaleIdle().catch(() => null));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const grouped = useMemo(
    () => (preview ? groupExclusionsByCode(preview.excluded) : []),
    [preview],
  );

  const tally = useMemo(() => {
    if (!result) return null;
    const counts = { stopped: 0, skipped: 0, failed: 0, not_found: 0 };
    for (const item of result.items) counts[item.result] += 1;
    return counts;
  }, [result]);

  const eligibleCount = preview?.eligible.length ?? 0;
  const canStop =
    preview !== null && !previewStale && eligibleCount > 0 && threshold !== 'never' && busy === null;

  return (
    <section className="ui-card p-0 overflow-hidden" data-testid="stop-stale-idle-panel">
      <header className="flex items-center gap-2 px-4 py-2.5 border-b border-white/10">
        <Icons.MoonStar className="w-4 h-4 text-accent-blue" />
        <h3 className="text-[13px] font-semibold text-gray-100">Stale idle agents</h3>
        <span className="ml-auto text-[11px] text-gray-500">
          Reclaim memory from agents that have been idle a long time.
        </span>
      </header>

      <div className="p-4 space-y-3">
        {/* Threshold — persisted main-side; the sweep reads the same value. */}
        <div className="flex items-center gap-3 flex-wrap">
          <label htmlFor="stale-idle-threshold" className="text-[12px] text-gray-400">
            Auto-stop agents idle longer than
          </label>
          <select
            id="stale-idle-threshold"
            className="ui-input text-[12px] px-2 py-1"
            value={threshold ?? '24h'}
            disabled={settings === null || busy !== null}
            onChange={(e) => void onThresholdChange(e.target.value as AutoStopThreshold)}
          >
            {THRESHOLD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          {busy === 'settings' && <span className="text-[11px] text-gray-500">Saving…</span>}
        </div>

        {threshold === 'never' ? (
          <p className="text-[11px] text-accent-yellow">
            Automatic stopping is off. No agent is stopped for being idle, by the background sweep
            or from this panel — pick a threshold to enable it.
          </p>
        ) : (
          <p className="text-[11px] text-gray-500">
            A background sweep applies this threshold on its own schedule. Previewing here shows
            what that sweep would do right now, and lets you run it immediately.
          </p>
        )}

        <div className="flex items-center gap-2">
          <button
            className="ui-btn px-3 py-1.5 text-[12px]"
            disabled={settings === null || busy !== null || threshold === 'never'}
            onClick={() => void runPreview()}
          >
            {busy === 'preview' ? 'Checking…' : 'Preview'}
          </button>
          <button
            className="ui-btn ui-btn-danger px-3 py-1.5 text-[12px]"
            disabled={!canStop}
            onClick={() => void runStop()}
            title={
              preview === null
                ? 'Preview first'
                : previewStale
                  ? 'The threshold changed — preview again'
                  : undefined
            }
          >
            {busy === 'stop'
              ? 'Stopping…'
              : `Stop ${eligibleCount} idle agent${eligibleCount === 1 ? '' : 's'}`}
          </button>
        </div>

        {error && (
          <div className="text-[11px] text-accent-red" role="alert">{error}</div>
        )}

        {previewStale && (
          <div className="text-[11px] text-accent-yellow" role="alert">
            This preview was computed for {THRESHOLD_PHRASE[preview!.thresholdLabel]}, but the
            threshold is now {THRESHOLD_PHRASE[threshold!]}. Preview again before stopping.
          </div>
        )}

        {preview && !previewStale && (
          <div className="space-y-3 pt-1">
            <div className="text-[11px] text-gray-400">
              {eligibleCount === 0
                ? 'No agent currently meets the threshold with every safety check clear.'
                : `${eligibleCount} agent${eligibleCount === 1 ? '' : 's'} would be stopped.`}
              {preview.estimatedReclaimBytes != null && eligibleCount > 0 && (
                <> ≈{formatBytes(preview.estimatedReclaimBytes)} would be reclaimed.</>
              )}
            </div>

            {eligibleCount > 0 && (
              <ul className="space-y-1">
                {preview.eligible.map((e) => (
                  <li key={e.agentId} className="flex items-center gap-2 text-[12px]">
                    <Icons.Dot className="w-3 h-3 text-accent-green shrink-0" />
                    <span className="text-gray-200 truncate">{titleOf(e.agentId)}</span>
                    <span className="text-[11px] text-gray-600 tabular-nums shrink-0">
                      idle {idleFor(e.idleSince)}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {grouped.length > 0 && (
              <div className="border-t border-white/5 pt-2 space-y-2">
                <div className="text-[11px] text-gray-500">
                  {preview.excluded.length} agent{preview.excluded.length === 1 ? '' : 's'} left
                  running:
                </div>
                {grouped.map((g) => (
                  <div key={g.code} className="text-[11px]">
                    <div className="text-gray-300">
                      {g.copy.label}
                      <span className="text-gray-600"> — {g.copy.explanation}</span>
                    </div>
                    <div className="text-gray-500 pl-3 truncate">
                      {g.agentIds.map(titleOf).join(', ')}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {result && tally && (
          <div className="border-t border-white/5 pt-2 space-y-1" role="status">
            <div className="text-[12px] text-gray-300">
              Stopped {tally.stopped}
              {tally.skipped > 0 && <>, skipped {tally.skipped}</>}
              {tally.not_found > 0 && <>, already gone {tally.not_found}</>}
              {tally.failed > 0 && (
                <span className="text-accent-red">, failed {tally.failed}</span>
              )}
            </div>
            {/* Every non-stopped item is named. A failure is a live process we
                could not confirm we killed — it must never read as success. */}
            {result.items
              .filter((i) => i.result !== 'stopped')
              .map((i) => (
                <div key={i.agentId} className="text-[11px] pl-1">
                  <span className={i.result === 'failed' ? 'text-accent-red' : 'text-gray-500'}>
                    {titleOf(i.agentId)} — {i.result === 'failed'
                      ? 'could not be confirmed stopped; it may still be running'
                      : summarizeStopExclusions(i.codes) ?? i.result.replace('_', ' ')}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
    </section>
  );
}
