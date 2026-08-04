import { useEffect } from 'react';
import { create } from 'zustand';
import type { MissionBoardCard } from '../../shared/types';

/** WP-P6B-transport: the single, named cadence for mission-board reads. */
export const MISSION_BOARD_POLL_INTERVAL_MS = 5_000;

export type MissionBoardList = (
  planId: string,
) => Promise<MissionBoardCard[] | null>;

interface MissionBoardSnapshot {
  cards: MissionBoardCard[];
  error: string | null;
  loading: boolean;
}

interface MissionBoardStoreState {
  boards: Record<string, MissionBoardSnapshot>;
  setLoading: (planId: string) => void;
  setCards: (planId: string, cards: MissionBoardCard[]) => void;
  setError: (planId: string, error: string) => void;
}

const EMPTY_CARDS: MissionBoardCard[] = [];

export const useMissionBoardStore = create<MissionBoardStoreState>((set) => ({
  boards: {},
  setLoading: (planId) => set((state) => ({
    boards: {
      ...state.boards,
      [planId]: {
        cards: state.boards[planId]?.cards ?? EMPTY_CARDS,
        error: null,
        loading: true,
      },
    },
  })),
  setCards: (planId, cards) => set((state) => ({
    boards: {
      ...state.boards,
      [planId]: { cards, error: null, loading: false },
    },
  })),
  setError: (planId, error) => set((state) => ({
    boards: {
      ...state.boards,
      [planId]: {
        cards: state.boards[planId]?.cards ?? EMPTY_CARDS,
        error,
        loading: false,
      },
    },
  })),
}));

export interface MissionBoardPollingResult {
  cards: MissionBoardCard[];
  error: string | null;
  loading: boolean;
}

/**
 * Poll the one-shot `plan:board:list` transport while its pane is visible.
 *
 * `listCards` is injected because WP-P6C owns the preload bridge. A sequence is
 * allocated for every request; only the newest request may publish, and effect
 * cleanup advances the sequence so responses arriving after hide/unmount or a
 * plan change are inert.
 */
export function useMissionBoardPolling(
  planId: string | null | undefined,
  paneVisible: boolean,
  listCards: MissionBoardList,
): MissionBoardPollingResult {
  const snapshot = useMissionBoardStore((state) =>
    planId ? state.boards[planId] : undefined);

  useEffect(() => {
    if (!planId || !paneVisible) return;

    let requestSequence = 0;
    let active = true;
    const { setLoading, setCards, setError } = useMissionBoardStore.getState();

    const pollMissionBoard = () => {
      const sequence = ++requestSequence;
      setLoading(planId);
      void listCards(planId).then(
        (cards) => {
          if (!active || sequence !== requestSequence) return;
          setCards(planId, cards ?? []);
        },
        (error: unknown) => {
          if (!active || sequence !== requestSequence) return;
          setError(planId, error instanceof Error ? error.message : String(error));
        },
      );
    };

    pollMissionBoard();
    const missionBoardPollInterval = window.setInterval(
      pollMissionBoard,
      MISSION_BOARD_POLL_INTERVAL_MS,
    );

    return () => {
      active = false;
      requestSequence += 1;
      window.clearInterval(missionBoardPollInterval);
    };
  }, [listCards, paneVisible, planId]);

  return snapshot ?? { cards: EMPTY_CARDS, error: null, loading: false };
}
