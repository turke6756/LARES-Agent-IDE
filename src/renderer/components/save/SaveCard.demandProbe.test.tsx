// @vitest-environment jsdom
/**
 * WP-P1S — Save-card voluntary-open demand probe.
 *
 * The Save card emits exactly one `savecard_open` demand-probe event when a user
 * OPENS it via the toolbar gesture (`showSaveCard()` sets the store's one-shot
 * `saveCardOpenGesture` flag), and emits NOTHING on a bare mount / session-restore
 * reopen or on a Refresh/Try-again re-fetch. The event is voluntary-eligible: the
 * renderer never sets `feature_exercise`, and `source` is stamped in main.
 *
 * The store hook and `window.api` bridge are mocked; the component renders against
 * real DOM in jsdom.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import SaveCard from './SaveCard';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ── store mock ───────────────────────────────────────────────────────────────
// SaveCard reads selectedWorkspaceId, workspaces, saveCardOpenGesture, and the
// consumeSaveCardGesture action. `consume` flips the flag off, matching the real
// store's one-shot semantics.
const storeState = {
  selectedWorkspaceId: 'ws-1' as string | null,
  workspaces: [{ id: 'ws-1', title: 'AgentDashboard', path: '/ws', pathType: 'windows' }],
  saveCardOpenGesture: false,
  consumeSaveCardGesture: () => {
    storeState.saveCardOpenGesture = false;
  },
};
vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: (selector: (s: typeof storeState) => unknown) => selector(storeState),
}));

// ── render harness ───────────────────────────────────────────────────────────
let container: HTMLDivElement;
let root: Root;
let getInventory: ReturnType<typeof vi.fn>;
let record: ReturnType<typeof vi.fn>;

async function render() {
  await act(async () => {
    root.render(React.createElement(SaveCard));
  });
  // Flush the async load + probe microtask chains.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  storeState.selectedWorkspaceId = 'ws-1';
  storeState.saveCardOpenGesture = false;
  // A clean tree so the card lands in its empty state with a Refresh button.
  getInventory = vi.fn().mockResolvedValue({ bundles: [], quotaWeakening: null });
  record = vi.fn().mockResolvedValue({ appended: true, duplicate: false });
  (window as unknown as { api: unknown }).api = {
    saveCard: { getInventory },
    demandProbe: { record },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SaveCard demand probe (WP-P1S)', () => {
  it('emits exactly one voluntary-eligible savecard_open when opened by a user gesture', async () => {
    storeState.saveCardOpenGesture = true; // the toolbar gesture set it before mount
    await render();

    expect(record).toHaveBeenCalledTimes(1);
    const payload = record.mock.calls[0][0];
    expect(payload).toMatchObject({ workspaceId: 'ws-1', kind: 'savecard_open' });
    // Voluntary-eligible: the renderer must NOT flag the event as an exercise.
    expect(payload.feature_exercise).not.toBe(true);
    // The gesture flag is consumed so a re-render can't re-fire it.
    expect(storeState.saveCardOpenGesture).toBe(false);
  });

  it('emits nothing on a bare mount / session-restore reopen (no gesture)', async () => {
    storeState.saveCardOpenGesture = false; // restore-driven mount, not a gesture
    await render();

    expect(record).not.toHaveBeenCalled();
  });

  it('does not re-emit when the card is refreshed after a gesture open', async () => {
    storeState.saveCardOpenGesture = true;
    await render();
    expect(record).toHaveBeenCalledTimes(1);

    // Click Refresh (empty state) — a re-fetch, not a remount, and it flows
    // through no demand-probe path.
    const refresh = container.querySelector<HTMLButtonElement>('[data-testid="save-card-retry"]');
    expect(refresh).not.toBeNull();
    await act(async () => { refresh!.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(record).toHaveBeenCalledTimes(1);
  });

  it('emits nothing on a remount that was not gesture-driven', async () => {
    storeState.saveCardOpenGesture = true;
    await render();
    expect(record).toHaveBeenCalledTimes(1);

    // Unmount, then remount as a plain restore (flag already consumed to false).
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await render();

    // Still just the single gesture-driven emit from the first open.
    expect(record).toHaveBeenCalledTimes(1);
  });
});
