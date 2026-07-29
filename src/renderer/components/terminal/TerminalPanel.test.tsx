// @vitest-environment jsdom
//
// WP-7 TerminalPanel overlay tests. Two invariants the plan names explicitly:
//   1. the reclaimed-history banner is CLEARED on an agent switch — no bleed
//      between agents (the third overlay state joins truncation + history-warn);
//   2. banner text is NEVER written into the xterm stream — disclosure travels
//      only through the overlay deps (showReclaimedBanner / showHistoryUnavailable),
//      so every byte the component hands to xterm's write is real log content.
//
// The heavy xterm + cache machinery is mocked to a thin recorder; the REAL
// rehydrate orchestrator runs, so the surfacing path under test is exercised
// end-to-end from a mocked attach() DTO through to the rendered overlay.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Records every byte the component writes to "xterm" (via the cache's queueWrite
// and the terminal.write coordinator). Banner text must never appear here.
const xtermWrites = vi.hoisted(() => [] as string[]);

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('@xterm/xterm', () => {
  class Terminal {
    element = document.createElement('div');
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = { active: { viewportY: 0, baseY: 0 } };
    loadAddon(): void {}
    open(): void {}
    onData(): void {}
    onScroll(): void {}
    attachCustomKeyEventHandler(): void {}
    scrollToBottom(): void {}
    focus(): void {}
    clear(): void {}
    getSelection(): string { return ''; }
    clearSelection(): void {}
    write(data: string | Uint8Array): void {
      xtermWrites.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
    }
    dispose(): void {}
  }
  return { Terminal };
});

vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { onContextLoss(): void {} dispose(): void {} } }));
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class { serialize(): string { return ''; } } }));

vi.mock('./terminal-cache', () => {
  const terminalCache = new Map<string, any>();
  return {
    terminalCache,
    disposeCachedTerminalLocal: () => { terminalCache.clear(); },
    reapOnLeave: (id: string) => { terminalCache.delete(id); },
    createCacheEntry: (terminal: any, fitAddon: any, serialize: any, unsub: any) => ({
      terminal, fitAddon, serialize, unsub, appliedOffset: 0, logOffsetsReliable: true, epoch: '', evicting: false,
    }),
    queueWrite: (_entry: any, data: string | Uint8Array) => {
      xtermWrites.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
      return Promise.resolve();
    },
    awaitTerminalEviction: () => Promise.resolve(),
    touchTerminal: () => {},
    enforceLiveTerminalBound: () => {},
  };
});

import TerminalPanel from './TerminalPanel';
import { useDashboardStore } from '../../stores/dashboard-store';

// Per-agent attach DTOs. Agent 'A' carries a reclaimed marker; 'B' does not.
const RECLAIMED_AT = '2026-07-27T00:00:00Z';
const attachByAgent: Record<string, any> = {
  A: { ok: true, live: false, snapshotCutoff: 0, degraded: false, terminalEpoch: 'eA', historyNotice: { kind: 'retention-reclaimed', reclaimedAt: RECLAIMED_AT } },
  B: { ok: true, live: false, snapshotCutoff: 0, degraded: false, terminalEpoch: 'eB' },
};

let container: HTMLDivElement;
let root: Root;

function installApi() {
  (window as any).api = {
    terminal: {
      attach: vi.fn(async (id: string) => attachByAgent[id]),
      loadCheckpoint: vi.fn(async () => null),
      readLogRange: vi.fn(async () => ({ bytes: new Uint8Array(0), startOffset: 0, endOffset: 0, fileSize: 0 })),
      readLogTail: vi.fn(async () => ({ bytes: new Uint8Array(0), startOffset: 0, endOffset: 0, truncated: false })),
      getRingSnapshot: vi.fn(async () => null),
      readDeadAgentSnapshot: vi.fn(async () => ({ text: '', truncated: false, retainedBytes: 0, missing: false })),
      onData: vi.fn(() => () => {}),
      onRebound: vi.fn(() => () => {}),
      write: vi.fn(),
      resize: vi.fn(),
    },
    files: { writeImageTemp: vi.fn(async () => ({ ok: false, error: 'no' })) },
  };
}

function setAgent(id: string) {
  useDashboardStore.setState({
    terminalAgentId: id,
    terminalPinned: false,
    panelLayout: { terminalCollapsed: false } as any,
    agents: [{ id, title: `Agent ${id}`, status: 'crashed', workingDirectory: 'C:/ws', isSupervisor: false }] as any,
  });
}

/** Flush microtasks + the mount setTimeouts so async rehydrate + setState land. */
async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  xtermWrites.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  // jsdom has no ResizeObserver.
  (globalThis as any).ResizeObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {}
  };
  installApi();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const RECLAIMED_TEXT = 'Terminal history was reclaimed to free disk space';

describe('TerminalPanel — WP-7 reclaimed banner', () => {
  it('shows the reclaimed banner for a marked agent and CLEARS it on switch (no bleed)', async () => {
    setAgent('A');
    await act(async () => { root = createRoot(container); root.render(<TerminalPanel height={300} />); });
    await flush();
    expect(container.textContent).toContain(RECLAIMED_TEXT);

    // Switch to agent B (no marker). The mount effect re-runs and must clear the
    // prior agent's banner so it never bleeds onto B.
    await act(async () => { setAgent('B'); });
    await flush();
    expect(container.textContent).not.toContain(RECLAIMED_TEXT);
  });

  it('NEVER writes banner text into the xterm stream — disclosure is overlay-only', async () => {
    setAgent('A');
    await act(async () => { root = createRoot(container); root.render(<TerminalPanel height={300} />); });
    await flush();
    // The overlay rendered (proving the reclaimed path ran)…
    expect(container.textContent).toContain(RECLAIMED_TEXT);
    // …yet not a single byte of banner text reached xterm.
    const all = xtermWrites.join('');
    expect(all).not.toContain('🗑');
    expect(all).not.toContain('reclaimed');
    expect(all).not.toContain(RECLAIMED_AT);
  });
});
