// Stale-idle sweep controller (§B8, extracted from StopStaleIdlePanel in the
// System-Memory polish Part 5). The three deliberate §B8 properties live HERE,
// unchanged:
//
//   1. PREVIEW BEFORE ACTION. `previewStaleIdle()` is always run first and its
//      result is what the Stop button acts on the description of. Nothing is
//      stopped from a bare click.
//   2. THE PREVIEW IS PINNED TO A THRESHOLD. Main computes the preview against
//      the PERSISTED threshold, so changing the selector invalidates the
//      on-screen preview rather than leaving a 24h result sitting under a "7d"
//      selector — `previewStale` compares `preview.thresholdLabel` to the live
//      setting and `canStop` refuses to act on a mismatch.
//   3. EXCLUSIONS ARE SHOWN, NOT HIDDEN — `grouped` carries every agent the
//      sweep would leave alone, with its reason codes.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AutoStopThreshold,
  BulkStopResult,
  LifecycleSettings,
  StaleIdlePreview,
} from '../../../shared/types';
import { groupExclusionsByCode } from '../../lib/stop-exclusion-copy';

export interface StaleIdleSweep {
  settings: LifecycleSettings | null;
  threshold: AutoStopThreshold | null;
  preview: StaleIdlePreview | null;
  /** True when the on-screen preview was computed for a DIFFERENT threshold
   *  than the one now in force — it describes a sweep that will not happen. */
  previewStale: boolean;
  busy: null | 'preview' | 'stop' | 'settings';
  error: string | null;
  result: BulkStopResult | null;
  grouped: ReturnType<typeof groupExclusionsByCode>;
  tally: { stopped: number; skipped: number; failed: number; not_found: number } | null;
  eligibleCount: number;
  canStop: boolean;
  onThresholdChange: (value: AutoStopThreshold) => Promise<void>;
  runPreview: () => Promise<void>;
  runStop: () => Promise<void>;
}

export function useStaleIdleSweep(opts?: { onAfterStop?: () => void }): StaleIdleSweep {
  const onAfterStop = opts?.onAfterStop;
  const [settings, setSettings] = useState<LifecycleSettings | null>(null);
  const [preview, setPreview] = useState<StaleIdlePreview | null>(null);
  const [busy, setBusy] = useState<null | 'preview' | 'stop' | 'settings'>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkStopResult | null>(null);

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
      onAfterStop?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [onAfterStop]);

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

  return {
    settings, threshold, preview, previewStale, busy, error, result,
    grouped, tally, eligibleCount, canStop,
    onThresholdChange, runPreview, runStop,
  };
}
