// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommitBreakdownBar } from './SystemMemoryView';
import type { CommitBreakdownDto } from '../../../shared/types';

// Direct renderer tests for the commit-charge breakdown bar (review item N3).
// Pins the three render modes the compositor DTO can produce:
//   • full/exact — stacked segments + legend with exact figures & percentages;
//   • partial attribution — remainder labeled "Other/system + unattributed"
//     with NO percentage, footnote gated on unattributedLiveAgentCount and on
//     an unknown Electron share (N1);
//   • unknown total — no bar, no percentages, "≥" / "—" qualifiers only.
// Plus "≈" propagation when `approximate` is set (including the N2 remainder).

let container: HTMLDivElement;
let root: Root;

const GiB = 1024 * 1024 * 1024;

/** Full/exact-mode defaults: 8 GiB charge = 2 App + 2 agents + 4 other. */
function bd(over: Partial<CommitBreakdownDto> = {}): CommitBreakdownDto {
  return {
    commitChargeBytes: 8 * GiB,
    electron: { bytes: 2 * GiB, complete: true },
    liveAgents: { bytes: 2 * GiB, complete: true },
    unattributedLiveAgentCount: 0,
    otherSystemBytes: 4 * GiB,
    approximate: false,
    attributionAt: 1,
    sampleAt: 1,
    ...over,
  };
}

/** Partial-attribution defaults: remainder = 8 − 2 − 1 = 5 GiB. */
function partial(over: Partial<CommitBreakdownDto> = {}): CommitBreakdownDto {
  return bd({
    liveAgents: { bytes: 1 * GiB, complete: false },
    unattributedLiveAgentCount: 2,
    otherSystemBytes: null,
    ...over,
  });
}

async function render(breakdown: CommitBreakdownDto | null) {
  await act(async () => {
    root = createRoot(container);
    root.render(<CommitBreakdownBar breakdown={breakdown} />);
  });
}

function barEl(): HTMLElement | null {
  return container.querySelector('.h-3');
}

/** The innermost legend span whose text contains `label`. */
function legendSpan(label: string): HTMLElement {
  const matches = Array.from(container.querySelectorAll('span')).filter(
    (s) => (s.textContent ?? '').includes(label),
  );
  expect(matches.length, `legend span containing "${label}"`).toBeGreaterThan(0);
  return matches[matches.length - 1] as HTMLElement;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('CommitBreakdownBar — full/exact mode', () => {
  it('renders three stacked segments sized from raw bytes', async () => {
    await render(bd());
    const bar = barEl()!;
    expect(bar).toBeTruthy();
    const widths = Array.from(bar.children).map((c) => (c as HTMLElement).style.width);
    expect(widths).toEqual(['25%', '25%', '50%']);
  });

  it('legends every category with exact figure and percentage', async () => {
    await render(bd());
    expect(legendSpan('App (Electron)').textContent).toContain('2.0 GB · 25.0%');
    expect(legendSpan('Live agent CLIs').textContent).toContain('2.0 GB · 25.0%');
    const other = legendSpan('Other/system');
    expect(other.textContent).toContain('4.0 GB · 50.0%');
    // Exact mode: remainder is genuinely other processes, no qualifiers.
    expect(container.textContent).not.toContain('unattributed');
    expect(container.textContent).not.toContain('≥');
    expect(container.textContent).not.toContain('≈');
    expect(container.textContent).not.toContain('unattributable');
  });
});

describe('CommitBreakdownBar — partial attribution', () => {
  it('labels the remainder "Other/system + unattributed" with NO percentage', async () => {
    await render(partial());
    const rem = legendSpan('Other/system + unattributed');
    expect(rem.textContent).toContain('5.0 GB');
    expect(rem.textContent).not.toContain('%');
    // The attributed segments still carry their percentages.
    expect(legendSpan('App (Electron)').textContent).toContain('25.0%');
    // Incomplete category sum is "≥"-qualified, never presented as exact.
    expect(legendSpan('Live agent CLIs').textContent).toContain('≥1.0 GB');
  });

  it('footnotes unattributable live agents when the count is positive', async () => {
    await render(partial());
    expect(container.textContent).toContain('2 live agents unattributable');
    expect(container.textContent).toContain('their memory is inside the remainder');
    // Electron IS attributed here — no unknown-app copy.
    expect(container.textContent).not.toContain('share unknown');
  });

  it('omits the footnote when every live agent is attributed and App is known', async () => {
    await render(partial({ unattributedLiveAgentCount: 0 }));
    expect(container.textContent).not.toContain('unattributable');
    expect(container.textContent).not.toContain('share unknown');
  });

  it('N1: says the app share is unknown when electron is null with a known charge', async () => {
    await render(partial({ electron: null, unattributedLiveAgentCount: 0 }));
    // App legend renders "—", never 0 B.
    expect(legendSpan('App (Electron)').textContent).toContain('—');
    expect(legendSpan('App (Electron)').textContent).not.toContain('0 B');
    // Footnote widens: the remainder is never implied to be agents-only.
    expect(container.textContent).toContain('App (Electron) share unknown');
    expect(container.textContent).toContain('also inside the remainder');
  });

  it('N1: combines both footnote sentences when agents AND the app share are unknown', async () => {
    await render(partial({ electron: null }));
    expect(container.textContent).toContain('2 live agents unattributable');
    expect(container.textContent).toContain('App (Electron) share unknown');
  });
});

describe('CommitBreakdownBar — unknown total', () => {
  it('renders no bar and no percentages, with "≥" / "—" qualified figures', async () => {
    await render(bd({
      commitChargeBytes: null,
      electron: { bytes: 2 * GiB, complete: false },
      liveAgents: null,
      otherSystemBytes: null,
    }));
    expect(barEl()).toBeNull();
    expect(container.textContent).not.toContain('%');
    expect(container.textContent).toContain('system total unknown');
    // Incomplete sum → "≥"; unknown category → "—", never a false 0 B.
    expect(container.textContent).toContain('App ≥2.0 GB');
    expect(container.textContent).toContain('Live agents —');
    expect(container.textContent).not.toContain('0 B');
  });
});

describe('CommitBreakdownBar — "≈" propagation when approximate', () => {
  it('prefixes exact-mode figures and percentages with "≈"', async () => {
    await render(bd({ approximate: true }));
    expect(legendSpan('App (Electron)').textContent).toContain('≈2.0 GB · ≈25.0%');
    expect(legendSpan('Other/system').textContent).toContain('≈4.0 GB · ≈50.0%');
  });

  it('N2: prefixes the partial-mode remainder figure with "≈"', async () => {
    await render(partial({ approximate: true }));
    const rem = legendSpan('Other/system + unattributed');
    expect(rem.textContent).toContain('≈5.0 GB');
    expect(rem.textContent).not.toContain('%');
  });
});

describe('CommitBreakdownBar — loading', () => {
  it('shows the loading line when the breakdown is null', async () => {
    await render(null);
    expect(container.textContent).toContain('attribution loading…');
  });
});
