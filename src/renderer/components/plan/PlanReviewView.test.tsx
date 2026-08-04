// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanReviewProjection } from '../../../shared/types';

const { sharedPreview } = vi.hoisted(() => ({ sharedPreview: vi.fn() }));

vi.mock('../save/CandidatePreview', () => ({
  default: (props: { showCommitAction?: boolean }) => {
    sharedPreview(props);
    return (
      <div
        data-testid="shared-candidate-preview"
        data-commit-action={String(props.showCommitAction)}
      />
    );
  },
}));

import PlanReviewView from './PlanReviewView';

function projection(): PlanReviewProjection {
  return {
    workspaceId: 'ws-1',
    planId: 'plan-1',
    baselineDiff: {
      executionRunId: 'run-1',
      baseline: { kind: 'head', ref: 'refs/lares/plans/plan-1/run-1', headOid: 'a'.repeat(40) },
      witnessedPaths: ['src/alpha.ts'],
      repositoryPaths: ['src/alpha.ts'],
      patch: 'diff --git a/src/alpha.ts b/src/alpha.ts\n+reviewed change',
    },
    scObject: {
      componentIds: ['component-1'],
      selectedUnattributedEntryIds: [],
      members: [],
      eligibility: { eligible: false, reason: 'package-not-finalized' },
    },
    annotations: {
      mixedAuthorship: [{
        componentId: 'component-1',
        planIds: ['plan-1', 'plan-2'],
        otherPlanIds: ['plan-2'],
        contributingTurnIds: ['turn-1', 'turn-2'],
        reasons: ['multiple-plans', 'multiple-agents'],
        currentBytesMayContainMixedAuthorship: true,
      }],
      captureGaps: [{
        source: 'component-capture',
        componentId: 'component-1',
        turnIds: ['turn-2'],
        pathsWithoutFinalizationEdge: ['c3JjL2FscGhhLnRz'],
        reasons: ['incomplete-edge'],
      }],
    },
    evidenceSemantics: 'activity-only-never-completion',
  };
}

describe('PlanReviewView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    sharedPreview.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the baseline projection, honest annotations, and the shared SC preview', () => {
    act(() => root.render(<PlanReviewView projection={projection()} />));

    expect(container.querySelector('[data-testid="plan-review-patch"]')?.textContent)
      .toContain('+reviewed change');
    expect(container.textContent).toContain('src/alpha.ts');
    expect(container.querySelector('[data-testid="plan-review-mixed-authorship"]')?.textContent)
      .toMatch(/Mixed authorship may be present/);
    expect(container.querySelector('[data-testid="plan-review-capture-gap"]')?.textContent)
      .toMatch(/Capture gap/);
    expect(container.textContent).toMatch(/do not imply completion/i);

    expect(sharedPreview).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="shared-candidate-preview"]')).not.toBeNull();
    expect(container.querySelector('[data-commit-action="false"]')).not.toBeNull();
    expect(sharedPreview.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-1',
      selection: {
        selectedComponentIds: ['component-1'],
        selectedUnattributedEntryIds: [],
        finalizationIds: [],
      },
      showCommitAction: false,
    });
  });
});
