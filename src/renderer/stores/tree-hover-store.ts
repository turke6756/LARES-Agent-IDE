import { create } from 'zustand';

/**
 * Tracks which sidebar tree row the mouse is over, plus the space-bar
 * "hold" state, so window-level hotkeys (Sidebar) can act on the row a
 * DirectoryTreeNode is rendering without prop-drilling callbacks.
 *
 * Only trees that opt in (hoverHotkeys prop) register here — the file
 * viewer's directory tree is unaffected.
 */
export interface HoveredTreeRow {
  path: string;
  isDirectory: boolean;
  /** Workspace root the row belongs to — identifies which tree to collapse. */
  rootPath: string;
  /** Ref so the hotkey handler always invokes the row's latest toggle. */
  toggleRef: { current: () => void };
}

interface TreeHoverState {
  hovered: HoveredTreeRow | null;
  /** True while the space bar is held past the tap threshold. */
  spaceHold: boolean;
  setHovered: (row: HoveredTreeRow) => void;
  clearHovered: (path: string) => void;
  setSpaceHold: (held: boolean) => void;
}

export const useTreeHoverStore = create<TreeHoverState>((set, get) => ({
  hovered: null,
  spaceHold: false,
  setHovered: (row) => set({ hovered: row }),
  clearHovered: (path) => {
    if (get().hovered?.path === path) set({ hovered: null });
  },
  setSpaceHold: (spaceHold) => set({ spaceHold }),
}));

/** Age of the newest bracket (anything fresher renders at full brightness). */
const HEAT_MIN_AGE_MS = 5 * 60_000; // 5 minutes
/** Age at (or past) which a timestamp renders at its dimmest. */
const HEAT_MAX_AGE_MS = 7 * 24 * 3_600_000; // 1 week

/**
 * Heat color for a modification timestamp: newer → brighter, older → darker.
 * Interpolates lightness AND saturation on a log-age scale across a tight
 * 5-minute → 1-week window, so minutes-old files separate visibly
 * (25 min vs 45 min) and anything past a week reads uniformly cold/dark.
 */
export function timeHeatColor(ms: number | undefined, now: number): string {
  if (!ms) return 'var(--color-fg-secondary)';
  const age = Math.max(now - ms, 0);
  const t = age <= HEAT_MIN_AGE_MS
    ? 0
    : Math.min(
        (Math.log(age) - Math.log(HEAT_MIN_AGE_MS)) /
          (Math.log(HEAT_MAX_AGE_MS) - Math.log(HEAT_MIN_AGE_MS)),
        1,
      );
  const lightness = Math.round(80 - t * 55); // 80% (≤5 min) → 25% (≥1 week)
  const saturation = Math.round(100 - t * 55); // vivid (new) → muted (old)
  return `hsl(205 ${saturation}% ${lightness}%)`;
}
