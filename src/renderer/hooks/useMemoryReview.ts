// useMemoryReview — WP-H1 renderer state for the memory review surface.
//
// Pulls the per-workspace review summary over the renderer-only IPC
// (`window.api.memoryReview.listReview`). A pull-on-mount + pull-on-workspace-
// change model (no push channel exists for WP-H1): the summary reflects what
// WP-C persisted at the last supervisor launch, so a manual `reload()` after a
// relaunch is the way to refresh. Every fetch is guarded against a stale
// workspace (the id is captured and re-checked before committing state) so a
// fast workspace switch can never land an old workspace's summary.

import { useCallback, useEffect, useState } from 'react';
import type { MemoryReviewSummaryDto } from '../../shared/types';

export interface MemoryReviewState {
  summary: MemoryReviewSummaryDto | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const EMPTY: MemoryReviewSummaryDto = {
  pendingCount: 0,
  capPressure: false,
  capPercent: null,
  hardInvalid: false,
  lastRuntimeError: null,
  lastRuntimeErrorAt: null,
  items: [],
};

export function useMemoryReview(workspaceId: string | null): MemoryReviewState {
  const [summary, setSummary] = useState<MemoryReviewSummaryDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped by reload() to re-run the effect without threading a promise around.
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    // No workspace selected → a quiet, empty surface, no fetch.
    if (!workspaceId) {
      setSummary(EMPTY);
      setError(null);
      setLoading(false);
      return;
    }
    let live = true;
    const ws = workspaceId;
    setLoading(true);
    setError(null);
    window.api.memoryReview
      .listReview(ws)
      .then((s) => {
        // Guard against a workspace switch mid-flight: only the latest id commits.
        if (live && ws === workspaceId) setSummary(s);
      })
      .catch((e) => {
        if (live && ws === workspaceId) { setError(String(e)); setSummary(null); }
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [workspaceId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { summary, loading, error, reload };
}
