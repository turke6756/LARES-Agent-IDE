import { useEffect, useState } from 'react';

import type {
  BlameToIntentRequest,
  BlameToIntentResult,
} from '../../shared/types';

export type BlameToIntentQuery = (
  request: BlameToIntentRequest,
) => Promise<BlameToIntentResult | null>;

export interface BlameToIntentHookResult {
  attribution: BlameToIntentResult | null;
  loading: boolean;
  error: string | null;
}

/**
 * WP-P7C attribution-view wiring point. Components opt in with a selected file;
 * this hook performs one bounded IPC read per selection and suppresses stale
 * responses. It intentionally renders nothing and makes no authorship claim.
 */
export function useBlameToIntent(
  workspaceId: string | null | undefined,
  filePath: string | null | undefined,
  enabled = true,
  query: BlameToIntentQuery = (request) => window.api.plans.blameToIntent(request),
): BlameToIntentHookResult {
  const [state, setState] = useState<BlameToIntentHookResult>({
    attribution: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!enabled || !workspaceId || !filePath) {
      setState({ attribution: null, loading: false, error: null });
      return;
    }
    let active = true;
    setState((current) => ({ ...current, loading: true, error: null }));
    void query({ workspaceId, path: filePath }).then(
      (attribution) => {
        if (active) setState({ attribution, loading: false, error: null });
      },
      (error: unknown) => {
        if (active) setState({
          attribution: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => { active = false; };
  }, [enabled, filePath, query, workspaceId]);

  return state;
}
