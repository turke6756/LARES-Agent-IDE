// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BlameToIntentResult } from '../../shared/types';
import {
  useBlameToIntent,
  type BlameToIntentHookResult,
  type BlameToIntentQuery,
} from './blame-to-intent-hook';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function result(filePath: string): BlameToIntentResult {
  return {
    workspaceId: 'ws-1', path: filePath, confidence: 'low', contributors: [],
    conflictingContributors: [], ledgerStrengthening: 'unavailable',
    framing: 'These plans and turns contributed to this file.', warnings: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('useBlameToIntent', () => {
  let container: HTMLDivElement;
  let root: Root;
  let observed: BlameToIntentHookResult | null;

  function Probe(props: { filePath?: string | null; enabled?: boolean; query: BlameToIntentQuery }) {
    observed = useBlameToIntent('ws-1', props.filePath, props.enabled, props.query);
    return null;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    observed = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('queries the selected file and exposes the conservative projection', async () => {
    const query = vi.fn<BlameToIntentQuery>().mockResolvedValue(result('src/a.ts'));
    await act(async () => { root.render(<Probe filePath="src/a.ts" query={query} />); });
    expect(query).toHaveBeenCalledWith({ workspaceId: 'ws-1', path: 'src/a.ts' });
    expect(observed?.attribution?.framing).toContain('contributed');
    expect(observed?.loading).toBe(false);
  });

  it('does not query while disabled or without a selected file', async () => {
    const query = vi.fn<BlameToIntentQuery>();
    await act(async () => { root.render(<Probe filePath={null} query={query} />); });
    expect(query).not.toHaveBeenCalled();
    expect(observed).toEqual({ attribution: null, loading: false, error: null });
  });

  it('drops a response from the previous file selection', async () => {
    const first = deferred<BlameToIntentResult | null>();
    const query = vi.fn<BlameToIntentQuery>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(result('src/new.ts'));
    await act(async () => { root.render(<Probe filePath="src/old.ts" query={query} />); });
    await act(async () => { root.render(<Probe filePath="src/new.ts" query={query} />); });
    expect(observed?.attribution?.path).toBe('src/new.ts');
    await act(async () => { first.resolve(result('src/old.ts')); await first.promise; });
    expect(observed?.attribution?.path).toBe('src/new.ts');
  });
});
