// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import LiveAgentsPanel from './LiveAgentsPanel';
import { useDashboardStore } from '../../stores/dashboard-store';
import type {
  BulkStopResult,
  LifecycleSettings,
  LiveAgentMemoryRowDto,
  StaleIdlePreview,
  SystemMemoryViewDto,
} from '../../../shared/types';

// §B8 acceptance, migrated from StopStaleIdlePanel.test.tsx (Part 5):
//   1. nothing is stopped without a preview;
//   2. a preview computed for a DIFFERENT threshold cannot be acted on;
//   3. excluded agents are listed with human copy, not silently dropped;
//   4. a `failed` item is reported as a failure, never as "stopped".
// Plus the merged live-agent table: registry titles (not raw ids), "—" for
// unattributable memory, per-row sweep badges pinned to a CURRENT preview,
// and keyboard-accessible expansion with the three last-active states.

let container: HTMLDivElement;
let root: Root;

let settings: LifecycleSettings;
let preview: StaleIdlePreview;
let stopResult: BulkStopResult;
let settingsListener: ((s: LifecycleSettings) => void) | null = null;

const previewSpy = vi.fn();
const stopSpy = vi.fn();
const setSettingsSpy = vi.fn();
const afterStopSpy = vi.fn();

function installApi() {
  settingsListener = null;
  (window as any).api = {
    lifecycle: {
      getSettings: vi.fn(async () => settings),
      setSettings: vi.fn(async (s: LifecycleSettings) => {
        setSettingsSpy(s);
        settings = s;
        return s;
      }),
      onSettingsChanged: (cb: (s: LifecycleSettings) => void) => {
        settingsListener = cb;
        return () => { settingsListener = null; };
      },
    },
    agents: {
      previewStaleIdle: vi.fn(async () => { previewSpy(); return preview; }),
      stopStaleIdle: vi.fn(async () => { stopSpy(); return stopResult; }),
    },
  };
}

const GiB = 1024 * 1024 * 1024;

function liveRow(over: Partial<LiveAgentMemoryRowDto> & { agentId: string; title: string }): LiveAgentMemoryRowDto {
  return {
    status: 'idle',
    idleSince: '2026-07-19 00:00:00',
    transport: 'conpty',
    source: 'job',
    workingSetBytes: 2 * GiB,
    commitBytes: 1 * GiB,
    commitComplete: true,
    pidCount: 3,
    ...over,
  };
}

function makeView(rows: LiveAgentMemoryRowDto[], over: Partial<SystemMemoryViewDto> = {}): SystemMemoryViewDto {
  return {
    liveAgents: rows,
    liveAgentCount: rows.length,
    unregisteredTrees: [],
    breakdown: {
      commitChargeBytes: null, electron: null, liveAgents: null,
      unattributedLiveAgentCount: 0, otherSystemBytes: null, approximate: false,
      attributionAt: null, sampleAt: null,
    },
    at: 1,
    ...over,
  };
}

let view: SystemMemoryViewDto;

async function render() {
  await act(async () => {
    root = createRoot(container);
    root.render(<LiveAgentsPanel view={view} onAfterStop={afterStopSpy} />);
  });
}

async function click(el: Element | null | undefined) {
  expect(el, 'element to click').toBeTruthy();
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes(text),
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  settings = { autoStopIdleThreshold: '24h' };
  preview = {
    thresholdLabel: '24h',
    eligible: [{ agentId: 'a1', idleSince: '2026-07-19 00:00:00' }],
    excluded: [{ agentId: 'a2', codes: ['browser_lease', 'not_idle'] }],
    estimatedReclaimBytes: null,
    reclaimEstimateComplete: null,
  };
  stopResult = { items: [{ agentId: 'a1', result: 'stopped', codes: [] }] };
  view = makeView([
    liveRow({ agentId: 'a1', title: 'Alpha' }),
    liveRow({ agentId: 'a2', title: 'Beta', workingSetBytes: 1 * GiB }),
  ]);
  previewSpy.mockClear();
  stopSpy.mockClear();
  setSettingsSpy.mockClear();
  afterStopSpy.mockClear();
  installApi();
  useDashboardStore.setState({
    agents: [
      { id: 'a1', title: 'Alpha' },
      { id: 'a2', title: 'Beta' },
    ] as any,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('LiveAgentsPanel — §B8 sweep invariants (migrated)', () => {
  it('will not stop before a preview has been run', async () => {
    await render();
    const stop = buttonByText('Stop');
    expect(stop!.disabled).toBe(true);
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('previews, then stops the previewed agents', async () => {
    await render();
    await click(buttonByText('Preview'));
    expect(previewSpy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).toContain('1 agent would be stopped');

    const stop = buttonByText('Stop 1 idle agent');
    expect(stop!.disabled).toBe(false);
    await click(stop);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Stopped 1');
    expect(afterStopSpy).toHaveBeenCalledTimes(1);
  });

  it('lists excluded agents with their human reason', async () => {
    await render();
    await click(buttonByText('Preview'));
    // Both codes are shown — hiding the second would misreport why it survived.
    expect(container.textContent).toContain('Browser in use');
    expect(container.textContent).toContain('Not idle');
    expect(container.textContent).toContain('Beta');
    expect(container.textContent).toContain('1 agent left running');
  });

  it('invalidates the preview when the threshold changes', async () => {
    await render();
    await click(buttonByText('Preview'));
    expect(buttonByText('Stop 1 idle agent')!.disabled).toBe(false);

    const select = container.querySelector('#stale-idle-threshold') as HTMLSelectElement;
    await act(async () => {
      select.value = '7d';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(setSettingsSpy).toHaveBeenCalledWith({ autoStopIdleThreshold: '7d' });
    // The stale 24h preview is gone, not left sitting under the 7d selector.
    expect(container.textContent).not.toContain('would be stopped');
    expect(buttonByText('Stop')!.disabled).toBe(true);
  });

  it('blocks the action when a broadcast moves the threshold under a live preview', async () => {
    await render();
    await click(buttonByText('Preview'));
    await act(async () => { settingsListener!({ autoStopIdleThreshold: '7d' }); });
    expect(container.textContent).toContain('Preview again before stopping');
    expect(buttonByText('Stop')!.disabled).toBe(true);
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('disables preview and stop when the threshold is never', async () => {
    settings = { autoStopIdleThreshold: 'never' };
    await render();
    expect(buttonByText('Preview')!.disabled).toBe(true);
    expect(buttonByText('Stop')!.disabled).toBe(true);
    expect(container.textContent).toContain('Automatic stopping is off');
  });

  it('reports a failed stop as a failure, never as stopped', async () => {
    stopResult = {
      items: [
        { agentId: 'a1', result: 'failed', codes: [], outcome: 'failed' },
        { agentId: 'a2', result: 'skipped', codes: ['browser_lease'] },
      ],
    };
    await render();
    await click(buttonByText('Preview'));
    await click(buttonByText('Stop 1 idle agent'));
    expect(container.textContent).toContain('Stopped 0');
    expect(container.textContent).toContain('failed 1');
    expect(container.textContent).toContain('may still be running');
    // The skipped agent is named with its copy, not dropped.
    expect(container.textContent).toContain('Browser in use');
  });

  it('surfaces a preview error instead of silently showing nothing', async () => {
    (window as any).api.agents.previewStaleIdle = vi.fn(async () => { throw new Error('boom'); });
    await render();
    await click(buttonByText('Preview'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('boom');
    expect(buttonByText('Stop')!.disabled).toBe(true);
  });
});

describe('LiveAgentsPanel — reclaim estimate copy', () => {
  it('renders the exact reclaim line when the estimate is complete', async () => {
    preview = { ...preview, estimatedReclaimBytes: 2 * GiB, reclaimEstimateComplete: true };
    await render();
    await click(buttonByText('Preview'));
    expect(container.textContent).toContain('≈2.0 GB would be reclaimed');
    expect(container.textContent).not.toContain('At least');
  });

  it('qualifies a partial estimate with "at least" + unmeasured note', async () => {
    preview = { ...preview, estimatedReclaimBytes: 1 * GiB, reclaimEstimateComplete: false };
    await render();
    await click(buttonByText('Preview'));
    expect(container.textContent).toContain('At least ≈1.0 GB would be reclaimed (some agents unmeasured)');
  });
});

describe('LiveAgentsPanel — live-agent table', () => {
  it('renders registry titles, not raw ids, as the primary agent cell', async () => {
    await render();
    expect(container.textContent).toContain('Alpha');
    expect(container.textContent).toContain('Beta');
    // The raw id lives in the tooltip, not the visible cell text.
    const alphaCell = Array.from(container.querySelectorAll('td span[title="a1"]'));
    expect(alphaCell.length).toBe(1);
    expect(alphaCell[0].textContent).toBe('Alpha');
  });

  it('renders "—" for unattributable (null) memory, never 0 B', async () => {
    view = makeView([
      liveRow({
        agentId: 'w1', title: 'WSL worker', transport: 'wsl', source: 'none',
        workingSetBytes: null, commitBytes: null, commitComplete: false, pidCount: 0,
      }),
    ]);
    await render();
    const dashes = Array.from(container.querySelectorAll('td span[title="unattributable (WSL / no resolved tree)"]'));
    expect(dashes.length).toBe(2); // working set + commit
    for (const d of dashes) expect(d.textContent).toBe('—');
    expect(container.textContent).not.toContain('0 B');
  });

  it('shows the live-agent count from the DTO in the header', async () => {
    await render();
    expect(container.textContent).toContain('2 live agents');
  });

  it('marks eligible rows "would stop" only under a CURRENT preview', async () => {
    await render();
    expect(container.textContent).not.toContain('would stop');
    await click(buttonByText('Preview'));
    expect(container.textContent).toContain('would stop');
    // Excluded row gets its human summary as a badge; the count is 2 rows total.
    expect(container.textContent).toContain('Browser in use');
  });

  it('drops the badges the moment the preview goes stale', async () => {
    await render();
    await click(buttonByText('Preview'));
    expect(container.textContent).toContain('would stop');
    await act(async () => { settingsListener!({ autoStopIdleThreshold: '7d' }); });
    expect(container.textContent).not.toContain('would stop');
  });

  it('mentions prior-run trees when unregistered trees exist', async () => {
    view = makeView(
      [liveRow({ agentId: 'a1', title: 'Alpha' })],
      {
        unregisteredTrees: [
          { agentId: 'old-1', transport: 'conpty', workingSetBytes: 3 * GiB, commitBytes: 2 * GiB, pidCount: 2, source: 'tree-walk' },
        ],
      },
    );
    await render();
    expect(container.textContent).toContain('1 process tree from prior runs holding 3.0 GB');
    expect(container.textContent).toContain('Orphaned-processes sweep');
  });
});

describe('LiveAgentsPanel — row expansion', () => {
  function expandButton(agentTitle: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button[aria-expanded]')).find((b) =>
      (b.getAttribute('aria-label') ?? '').includes(agentTitle),
    ) as HTMLButtonElement | undefined;
  }

  it('expands via the accessible button and shows the idle last-active state', async () => {
    await render();
    const btn = expandButton('Alpha')!;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    await click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const detail = container.querySelector(`#${btn.getAttribute('aria-controls')}`);
    expect(detail).toBeTruthy();
    expect(detail!.textContent).toContain('idle ');
    expect(detail!.textContent).toContain('since ');
    expect(detail!.textContent).toContain('a1'); // raw id in the detail row
  });

  it('shows "Currently active" for a non-idle agent', async () => {
    view = makeView([
      liveRow({ agentId: 'g1', title: 'Gamma', status: 'working', idleSince: null }),
    ]);
    await render();
    await click(expandButton('Gamma'));
    expect(container.textContent).toContain('Currently active');
  });

  it('shows "Last-active time unavailable" for idle with a null or invalid idleSince', async () => {
    view = makeView([
      liveRow({ agentId: 'n1', title: 'NullIdle', status: 'idle', idleSince: null }),
      liveRow({ agentId: 'n2', title: 'BadIdle', status: 'idle', idleSince: 'not-a-date' }),
    ]);
    await render();
    await click(expandButton('NullIdle'));
    await click(expandButton('BadIdle'));
    const matches = (container.textContent!.match(/Last-active time unavailable/g) ?? []).length;
    expect(matches).toBe(2);
  });

  it('explains attribution limits for WSL / source-none rows in the detail', async () => {
    view = makeView([
      liveRow({
        agentId: 'w1', title: 'WSL worker', transport: 'wsl', source: 'none',
        workingSetBytes: null, commitBytes: null, commitComplete: false, pidCount: 0,
      }),
    ]);
    await render();
    await click(expandButton('WSL worker'));
    expect(container.textContent).toContain('cannot be attributed');
    expect(container.textContent).toContain('no Win32 PID');
  });
});
