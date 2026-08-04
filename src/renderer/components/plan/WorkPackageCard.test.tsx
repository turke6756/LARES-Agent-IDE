// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MissionBoardCard } from '../../../shared/types';
import WorkPackageCard from './WorkPackageCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function card(active: boolean): MissionBoardCard {
  return {
    packageId: 'WP-P6C',
    workspaceId: 'ws-1',
    planId: 'plan-1',
    title: 'Mission board renderer',
    acceptanceCondition: 'Activity lights the card without completing it.',
    state: 'ready',
    assigneeAgentId: 'agent-1',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    plannedPaths: [{ path: 'src/renderer/board.tsx', intentKind: 'edit' }],
    liveActivity: [{
      turnId: 'turn-7',
      workspaceId: 'ws-1',
      turnSeq: 7,
      agentId: 'agent-1',
      taskLabel: 'Build board',
      startedAt: 100,
      planId: 'plan-1',
      planItemId: 'WP-P6C',
      planStampSource: 'prompt',
      planStampStatus: 'verified',
      touched: [{ path: 'src/renderer/board.tsx', op: 'write' }],
      association: 'package-stamp',
      isActive: active,
    }],
    durableTurns: [],
    recoveryOperations: [],
  };
}

function renderCard(value: MissionBoardCard, handlers = {
  onOpenFile: vi.fn(),
  onOpenTurnDiff: vi.fn(),
  onRestoreTurn: vi.fn(),
}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<WorkPackageCard card={value} {...handlers} />);
  });
  return handlers;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe('WorkPackageCard', () => {
  it('lights from liveActivity while preserving the independent structured state', () => {
    renderCard(card(true));
    const el = container!.querySelector('[data-testid="work-package-card-WP-P6C"]')!;
    expect(el.getAttribute('data-live-active')).toBe('true');
    expect(el.className).toContain('work-package-card--active');
    expect(el.getAttribute('data-state')).toBe('ready');
    expect(el.textContent).toContain('ready');
    expect(el.querySelector('.work-package-card__state')?.textContent).toBe('ready');
  });

  it('keeps file history primary and turn diff a distinct secondary action', () => {
    const handlers = renderCard(card(true));
    act(() => {
      (container!.querySelector('.work-package-card__file') as HTMLButtonElement).click();
    });
    expect(handlers.onOpenFile).toHaveBeenCalledWith(expect.objectContaining({
      activity: expect.objectContaining({ turnId: 'turn-7' }),
      touch: { path: 'src/renderer/board.tsx', op: 'write' },
    }));
    expect(handlers.onOpenTurnDiff).not.toHaveBeenCalled();

    act(() => {
      (container!.querySelector('[data-testid="turn-diff-turn-7"]') as HTMLButtonElement).click();
    });
    expect(handlers.onOpenTurnDiff).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'turn-7' }));
  });

  it('renders explicit finalization controls inert and never auto-done', () => {
    renderCard(card(true));
    const buttons = [...container!.querySelectorAll('button')];
    const done = buttons.find((button) => button.textContent === 'Mark done') as HTMLButtonElement;
    const commit = buttons.find((button) => button.textContent === 'Commit package') as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    expect(commit.disabled).toBe(true);
    expect(container!.querySelector('[data-state="done"]')).toBeNull();
  });
});
