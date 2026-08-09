// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SaveCardPlanningActivityDto } from '../../../shared/types';
import PlanMergeBack from './PlanMergeBack';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const activity: SaveCardPlanningActivityDto = {
  executionRunId: 'run-b', planId: 'plan-b', planTitle: 'Plan B', status: 'merge-conflicted',
  promotedHeadOid: null, latestAttemptId: 'attempt-b', failureCode: null,
  conflicts: [{
    pathBytesBase64: Buffer.from('conflicted/path.ts').toString('base64'),
    displayPath: 'conflicted/path.ts', baseBlobOid: 'a'.repeat(40),
    primaryBlobOid: 'b'.repeat(40), activityBlobOid: 'c'.repeat(40), resolution: null,
  }],
};

describe('PlanMergeBack content-conflict UI', () => {
  let host: HTMLDivElement;
  let root: Root;
  const resolveActivityMerge = vi.fn();
  beforeEach(() => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    resolveActivityMerge.mockReset().mockResolvedValue({ status: 'promoted', attemptId: 'attempt-b', primaryHeadOid: 'd'.repeat(40) });
    (window as any).api = { saveCard: { resolveActivityMerge } };
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it('offers path-level main/activity/manual choices and never whole-file Commit together', async () => {
    await act(async () => { root.render(<PlanMergeBack activity={activity} />); });
    expect(host.textContent).toContain('Plan B is saved in its activity worktree but cannot yet be promoted.');
    expect(host.textContent).toContain('conflicted/path.ts');
    expect(host.textContent).toContain('Keep current main');
    expect(host.textContent).toContain('Take this plan');
    expect(host.textContent).toContain('Open merge editor');
    expect(host.textContent).not.toContain('Commit together');
  });

  it('submits only after every path has an explicit disposition', async () => {
    await act(async () => { root.render(<PlanMergeBack activity={activity} />); });
    const buttons = [...host.querySelectorAll('button')];
    const submit = buttons.find((button) => button.textContent?.includes('Apply resolutions'))!;
    expect(submit.disabled).toBe(true);
    await act(async () => { buttons.find((button) => button.textContent === 'Take this plan')!.click(); });
    expect(submit.disabled).toBe(false);
    await act(async () => { submit.click(); });
    expect(resolveActivityMerge).toHaveBeenCalledWith({
      attemptId: 'attempt-b',
      resolutions: [{ pathBytesBase64: activity.conflicts[0].pathBytesBase64, resolution: 'take-activity' }],
    });
    expect(host.textContent).toContain('Promoted to main.');
  });
});
