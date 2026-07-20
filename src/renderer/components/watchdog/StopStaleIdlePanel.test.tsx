// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import StopStaleIdlePanel from './StopStaleIdlePanel';
import { useDashboardStore } from '../../stores/dashboard-store';
import type { BulkStopResult, LifecycleSettings, StaleIdlePreview } from '../../../shared/types';

// §B8 acceptance for the stale-idle panel:
//   1. nothing is stopped without a preview;
//   2. a preview computed for a DIFFERENT threshold cannot be acted on;
//   3. excluded agents are listed with human copy, not silently dropped;
//   4. a `failed` item is reported as a failure, never as "stopped".

let container: HTMLDivElement;
let root: Root;

let settings: LifecycleSettings;
let preview: StaleIdlePreview;
let stopResult: BulkStopResult;
let settingsListener: ((s: LifecycleSettings) => void) | null = null;

const previewSpy = vi.fn();
const stopSpy = vi.fn();
const setSettingsSpy = vi.fn();

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

async function render() {
  await act(async () => {
    root = createRoot(container);
    root.render(<StopStaleIdlePanel />);
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
  };
  stopResult = { items: [{ agentId: 'a1', result: 'stopped', codes: [] }] };
  previewSpy.mockClear();
  stopSpy.mockClear();
  setSettingsSpy.mockClear();
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

describe('StopStaleIdlePanel', () => {
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
    expect(container.textContent).not.toContain('Alpha');
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
