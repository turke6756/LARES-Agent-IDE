// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AtMentionDropdown, { type MentionRailWorkspace } from './AtMentionDropdown';
import type { Agent } from '../../../shared/types';

// Presentational component test (createRoot-on-jsdom probe pattern; RTL is
// intentionally not a dependency — see ChatInputBar.test.tsx). Exercises the
// WP5.2 rail + agent pane and its loading / empty-workspace / no-match states,
// plus mouse commit and foreign-workspace disambiguation.

function mkAgent(id: string, title: string, workspaceId: string): Agent {
  return { id, workspaceId, title, status: 'idle' } as Agent;
}

const LOCAL_A = mkAgent('a-1', 'Alice', 'ws-1');
const LOCAL_B = mkAgent('a-2', 'Bob', 'ws-1');
const REMOTE = mkAgent('a-3', 'Alice', 'ws-2'); // same title as LOCAL_A → needs disambiguation

const RAIL: MentionRailWorkspace[] = [
  { id: 'ws-1', title: 'Local WS', agentCount: 2, matchCount: 2 },
  { id: 'ws-2', title: 'Remote WS', agentCount: 1, matchCount: 1 },
];

let container: HTMLDivElement;
let root: Root;

const BASE = {
  workspaces: RAIL,
  activeWorkspaceId: 'ws-1' as string | null,
  selectedWorkspaceId: 'ws-1' as string | null,
  onSelectWorkspace: () => {},
  candidates: [LOCAL_A, LOCAL_B] as Agent[],
  highlighted: 0,
  loading: false,
  activeWorkspaceHasAgents: true,
  onPick: () => {},
  onHover: () => {},
  position: null,
};

function render(props: Partial<React.ComponentProps<typeof AtMentionDropdown>> = {}) {
  act(() => {
    root = createRoot(container);
    root.render(<AtMentionDropdown {...BASE} {...props} />);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('AtMentionDropdown rail + pane', () => {
  it('renders the workspace rail with per-workspace match counts', () => {
    render();
    const rail = container.querySelector('[role="tablist"]')!;
    expect(rail.textContent).toContain('Local WS');
    expect(rail.textContent).toContain('Remote WS');
    expect(rail.textContent).toContain('2'); // Local match count
    expect(rail.textContent).toContain('1'); // Remote match count
  });

  it('renders the active workspace\'s candidates as options', () => {
    render();
    const options = container.querySelectorAll('[role="option"]');
    expect(options.length).toBe(2);
    expect(options[0].textContent).toContain('Alice');
    expect(options[1].textContent).toContain('Bob');
  });

  it('marks the active rail workspace with aria-selected', () => {
    render({ activeWorkspaceId: 'ws-2' });
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    const active = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
    expect(active?.textContent).toContain('Remote WS');
  });

  it('shows the LOADING state when loading and no candidates are cached', () => {
    render({ loading: true, candidates: [] });
    expect(container.textContent).toContain('Loading agents…');
    expect(container.textContent).not.toContain('No agents');
  });

  it('keeps cached candidates visible during a refresh (loading does not flash over them)', () => {
    render({ loading: true }); // candidates still populated
    expect(container.querySelectorAll('[role="option"]').length).toBe(2);
    expect(container.textContent).not.toContain('Loading agents…');
  });

  it('shows the EMPTY-WORKSPACE state distinctly from no-match', () => {
    render({ candidates: [], activeWorkspaceHasAgents: false });
    expect(container.textContent).toContain('No agents in this workspace');
    expect(container.textContent).not.toContain('No agents match');
  });

  it('shows the NO-MATCH state when the workspace has agents but none match', () => {
    render({ candidates: [], activeWorkspaceHasAgents: true });
    expect(container.textContent).toContain('No agents match');
    expect(container.textContent).not.toContain('No agents in this workspace');
  });

  it('keeps rail entries visible under a no-match pane', () => {
    render({ candidates: [], activeWorkspaceHasAgents: true });
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(tabs.length).toBe(2); // both workspaces still listed
    expect(container.textContent).toContain('No agents match');
  });

  it('labels a FOREIGN active workspace to disambiguate duplicate agent titles', () => {
    // Active workspace ws-2 differs from the selected ws-1 → show its title.
    render({ activeWorkspaceId: 'ws-2', selectedWorkspaceId: 'ws-1', candidates: [REMOTE] });
    const pane = container.querySelector('[role="listbox"] > div:last-child')!;
    expect(pane.textContent).toContain('Remote WS'); // header labels the foreign pane
    // The agent title alone ("Alice") would collide with the local one; the
    // workspace label is what disambiguates it.
    expect(container.textContent).toContain('Alice');
  });

  it('does NOT show a workspace label when the active workspace is the selected one', () => {
    // ws-1 is both active and selected → the pane header label is omitted.
    render({ activeWorkspaceId: 'ws-1', selectedWorkspaceId: 'ws-1' });
    const pane = container.querySelector('[role="listbox"] > div:last-child')!;
    // The pane shows the option rows but no workspace-title header (the rail,
    // a sibling, still carries "Local WS").
    expect(pane.textContent).toContain('Alice');
    expect(pane.textContent).not.toContain('Local WS');
  });

  it('commits an agent on mousedown (mouse selection)', () => {
    const onPick = vi.fn();
    render({ onPick });
    const firstOption = container.querySelector('[role="option"]') as HTMLButtonElement;
    act(() => {
      firstOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(LOCAL_A);
  });

  it('switches workspace on a rail mousedown', () => {
    const onSelectWorkspace = vi.fn();
    render({ onSelectWorkspace });
    const tabs = container.querySelectorAll('[role="tab"]');
    act(() => {
      tabs[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(onSelectWorkspace).toHaveBeenCalledWith('ws-2');
  });

  it('renders nothing when the catalog is empty and not loading', () => {
    render({ workspaces: [], candidates: [], loading: false });
    expect(container.querySelector('[role="listbox"]')).toBeNull();
  });
});
