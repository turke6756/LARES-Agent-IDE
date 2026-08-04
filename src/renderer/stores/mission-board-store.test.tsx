// @vitest-environment jsdom
// WP-P6B-transport — bounded polling over the one-shot plan:board:list read.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MissionBoardCard } from '../../shared/types';
import {
  MISSION_BOARD_POLL_INTERVAL_MS,
  useMissionBoardPolling,
  useMissionBoardStore,
  type MissionBoardList,
  type MissionBoardPollingResult,
} from './mission-board-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function card(packageId: string): MissionBoardCard {
  return {
    packageId,
    workspaceId: 'workspace-1',
    planId: 'plan-1',
    title: packageId,
    acceptanceCondition: null,
    state: 'ready',
    assigneeAgentId: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    plannedPaths: [],
    liveActivity: [],
    durableTurns: [],
    recoveryOperations: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useMissionBoardPolling', () => {
  let container: HTMLDivElement;
  let root: Root;
  let observed: MissionBoardPollingResult | null;

  function Probe(props: {
    planId?: string | null;
    visible: boolean;
    listCards: MissionBoardList;
  }) {
    observed = useMissionBoardPolling(
      props.planId ?? 'plan-1',
      props.visible,
      props.listCards,
    );
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    useMissionBoardStore.setState({ boards: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    observed = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('fires immediately and at the named interval while visible', async () => {
    const listCards = vi.fn<MissionBoardList>().mockResolvedValue([card('wp-1')]);

    await act(async () => {
      root.render(<Probe visible listCards={listCards} />);
    });
    expect(listCards).toHaveBeenCalledTimes(1);
    expect(observed?.cards.map((item) => item.packageId)).toEqual(['wp-1']);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MISSION_BOARD_POLL_INTERVAL_MS * 2);
    });
    expect(listCards).toHaveBeenCalledTimes(3);
  });

  it('does not start while hidden and cancels its interval when hidden', async () => {
    const listCards = vi.fn<MissionBoardList>().mockResolvedValue([]);

    await act(async () => {
      root.render(<Probe visible={false} listCards={listCards} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MISSION_BOARD_POLL_INTERVAL_MS);
    });
    expect(listCards).not.toHaveBeenCalled();

    await act(async () => {
      root.render(<Probe visible listCards={listCards} />);
    });
    expect(listCards).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<Probe visible={false} listCards={listCards} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MISSION_BOARD_POLL_INTERVAL_MS * 2);
    });
    expect(listCards).toHaveBeenCalledTimes(1);
  });

  it('drops an older response that arrives after a newer response', async () => {
    const first = deferred<MissionBoardCard[] | null>();
    const second = deferred<MissionBoardCard[] | null>();
    const listCards = vi.fn<MissionBoardList>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    await act(async () => {
      root.render(<Probe visible listCards={listCards} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MISSION_BOARD_POLL_INTERVAL_MS);
      second.resolve([card('newer')]);
      await second.promise;
    });
    expect(observed?.cards.map((item) => item.packageId)).toEqual(['newer']);

    await act(async () => {
      first.resolve([card('stale')]);
      await first.promise;
    });
    expect(observed?.cards.map((item) => item.packageId)).toEqual(['newer']);
  });

  it('drops an in-flight response after the pane is hidden', async () => {
    const pending = deferred<MissionBoardCard[] | null>();
    const listCards = vi.fn<MissionBoardList>().mockReturnValue(pending.promise);

    await act(async () => {
      root.render(<Probe visible listCards={listCards} />);
    });
    await act(async () => {
      root.render(<Probe visible={false} listCards={listCards} />);
    });
    await act(async () => {
      pending.resolve([card('after-hide')]);
      await pending.promise;
    });

    expect(useMissionBoardStore.getState().boards['plan-1']?.cards).toEqual([]);
  });
});
