// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ChatInputBar from './ChatInputBar';
import { useDashboardStore } from '../../stores/dashboard-store';
import { formatAgentToken } from '../../lib/agent-mention';
import type { Agent, SendOutcome, Workspace } from '../../../shared/types';
import { TERMINAL_CHECK_SENTENCE } from '../../../shared/send-outcome-copy';

// Component test via the createRoot-on-jsdom probe pattern (React Testing
// Library is intentionally NOT a dependency of this repo — see
// useOwnerExpand.test.tsx). Imports AtMentionDropdown + textarea-caret (W2's
// modules), so this file runs at integration time once those exist.

const WS = 'ws-1';
const WS2 = 'ws-2';

function mkAgent(id: string, title: string, workspaceId = WS): Agent {
  return {
    id,
    workspaceId,
    title,
    status: 'idle',
  } as Agent;
}

function mkWorkspace(id: string, title: string): Workspace {
  return { id, title } as Workspace;
}

const RESEARCHER = mkAgent('id-researcher-001', 'Researcher');
const SUPERVISOR = mkAgent('id-supervisor-002', 'Supervisor');
// A second workspace + an agent that shares RESEARCHER's title, so the picker
// must disambiguate by workspace label (WP5.2).
const FOREIGN = mkAgent('id-foreign-003', 'Researcher', WS2);
const WORKSPACES = [mkWorkspace(WS, 'Local WS'), mkWorkspace(WS2, 'Remote WS')];

let container: HTMLDivElement;
let root: Root;
let sendInput: ReturnType<typeof vi.fn>;
let listAll: ReturnType<typeof vi.fn>;

function render(agentId = 'me', status: Agent['status'] = 'idle') {
  act(() => {
    root = createRoot(container);
    root.render(<ChatInputBar agentId={agentId} agentStatus={status} />);
  });
}

function textarea(): HTMLTextAreaElement {
  const ta = container.querySelector('textarea');
  if (!ta) throw new Error('textarea not found');
  return ta;
}

// Drive the controlled textarea: set value via the native setter, place the
// caret, and dispatch a bubbling input event so React's onChange fires.
function type(text: string, caret = text.length) {
  const ta = textarea();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(ta, text);
    ta.selectionStart = ta.selectionEnd = caret;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(k: string) {
  const ta = textarea();
  act(() => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

// keydown + keyup as a real keypress does. The keyup matters: it fires the
// caret-sync handler, which must NOT reset the arrow-driven highlight.
function press(k: string) {
  const ta = textarea();
  act(() => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    ta.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  sendInput = vi.fn().mockResolvedValue(undefined);
  listAll = vi.fn().mockResolvedValue([RESEARCHER, SUPERVISOR, FOREIGN]);
  (window as unknown as { api: unknown }).api = {
    agents: {
      sendInput,
      listAll,
      onSendInputError: vi.fn(() => () => {}),
      onSendInputResult: vi.fn(() => () => {}),
    },
  };
  useDashboardStore.setState({
    agents: [RESEARCHER, SUPERVISOR],
    workspaces: WORKSPACES,
    selectedWorkspaceId: WS,
    // Pre-seed the mention catalog so the picker renders synchronously in tests;
    // opening it fires loadMentionCatalog() (mocked listAll) which refreshes it.
    mentionCatalog: { agents: [RESEARCHER, SUPERVISOR, FOREIGN], workspaces: WORKSPACES, loading: false },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('ChatInputBar "@"-mention', () => {
  it('opens the dropdown listing workspace agents when "@" is typed', () => {
    render();
    type('@');
    expect(document.body.textContent).toContain('Researcher');
    expect(document.body.textContent).toContain('Supervisor');
  });

  it('ArrowDown + Enter inserts the highlighted agent\'s FULL token + trailing space', () => {
    render();
    type('@'); // both candidates; highlight clamps to 0 (Researcher)
    key('ArrowDown'); // → highlight 1 (Supervisor)
    key('Enter'); // pick Supervisor
    expect(textarea().value).toBe(`${formatAgentToken(SUPERVISOR)} `);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('keeps the arrow-driven highlight after keyup (caret-sync must not reset it)', () => {
    render();
    type('@'); // both candidates; highlight clamps to 0 (Researcher)
    press('ArrowDown'); // keydown→1, then keyup fires caret-sync
    key('Enter'); // must still pick Supervisor (index 1), not the reset-to-0 Researcher
    expect(textarea().value).toBe(`${formatAgentToken(SUPERVISOR)} `);
  });

  it('Enter narrows-then-picks: a matching query inserts that token and does NOT send', () => {
    render();
    type('@res'); // matches Researcher only
    key('Enter');
    expect(textarea().value).toBe(`${formatAgentToken(RESEARCHER)} `);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('Enter with NO dropdown open sends the token-bearing text verbatim', () => {
    render();
    const text = `ping ${formatAgentToken(RESEARCHER)}`;
    type(text); // caret after ']' → no active mention
    key('Enter');
    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledWith('me', text);
  });

  it('a non-matching query keeps the dropdown open and swallows Enter (no send, no insert)', () => {
    render();
    type('@zzz'); // no candidate matches
    key('Enter');
    expect(sendInput).not.toHaveBeenCalled();
    expect(textarea().value).toBe('@zzz');
  });

  it('Escape closes the dropdown so Enter sends again', () => {
    render();
    type('@res');
    key('Escape');
    key('Enter');
    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledWith('me', '@res');
  });
});

describe('ChatInputBar WP5 cross-workspace picker', () => {
  it('loads the mention catalog on open, refreshes on reopen, and never mutates the agents slice', () => {
    render();
    type('@'); // open → load 1
    expect(listAll).toHaveBeenCalledTimes(1);
    type('x '); // trailing space ends the mention → picker closes
    type('@'); // reopen → load 2
    expect(listAll).toHaveBeenCalledTimes(2);
    // The selected-workspace-only `agents` slice must be untouched by the catalog.
    expect(useDashboardStore.getState().agents).toEqual([RESEARCHER, SUPERVISOR]);
  });

  it('shows the workspace rail with both workspaces and the active workspace\'s agents', () => {
    render();
    type('@');
    expect(document.body.textContent).toContain('Local WS');
    expect(document.body.textContent).toContain('Remote WS');
    // Active workspace defaults to the selected one (ws-1): its agents show.
    expect(document.body.textContent).toContain('Researcher');
    expect(document.body.textContent).toContain('Supervisor');
  });

  it('→ cycles to the foreign workspace and Enter commits that workspace\'s agent', () => {
    render();
    type('@'); // active = ws-1
    key('ArrowRight'); // rail [Local, Remote] → Remote (ws-2)
    key('Enter'); // commit the ws-2 agent (FOREIGN)
    expect(textarea().value).toBe(`${formatAgentToken(FOREIGN)} `);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('Tab cycles the workspace rail and NO LONGER commits (only Enter commits)', () => {
    render();
    type('@');
    key('Tab'); // → ws-2, must NOT insert a token
    expect(textarea().value).toBe('@');
    expect(sendInput).not.toHaveBeenCalled();
    key('Enter'); // now commit the foreign agent
    expect(textarea().value).toBe(`${formatAgentToken(FOREIGN)} `);
  });

  it('Shift+Tab cycles backward through the rail', () => {
    render();
    type('@'); // active = ws-1 (index 0)
    act(() => {
      textarea().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
      );
    });
    // Backward from index 0 wraps to the last rail entry (ws-2).
    key('Enter');
    expect(textarea().value).toBe(`${formatAgentToken(FOREIGN)} `);
  });

  it('filters candidates within the active workspace only', () => {
    render();
    type('@sup'); // matches Supervisor in ws-1; the ws-2 "Researcher" is not in scope
    key('Enter');
    expect(textarea().value).toBe(`${formatAgentToken(SUPERVISOR)} `);
    expect(sendInput).not.toHaveBeenCalled();
  });
});

describe('ChatInputBar WP8 send-outcome banner', () => {
  function captureResultCallback(): (o: SendOutcome) => void {
    let cb: ((o: SendOutcome) => void) | null = null;
    (window as unknown as { api: { agents: { onSendInputResult: unknown } } }).api.agents.onSendInputResult =
      vi.fn((callback: (o: SendOutcome) => void) => { cb = callback; return () => {}; });
    return (o: SendOutcome) => { if (cb) act(() => cb!(o)); };
  }

  it('delivered-unconfirmed renders an amber banner with the mandatory terminal-check sentence (never "Send failed")', () => {
    const fire = captureResultCallback();
    render('me');
    fire({ disposition: 'delivered-unconfirmed', agentId: 'me', delivered: true, reason: 'confirmation-timeout', completedAt: 0 });
    expect(container.textContent).toContain(TERMINAL_CHECK_SENTENCE);
    expect(container.textContent).not.toContain('Send failed');
  });

  it('a detected prompt is named in the banner', () => {
    const fire = captureResultCallback();
    render('me');
    fire({
      disposition: 'delivered-unconfirmed', agentId: 'me', delivered: true, reason: 'interactive-prompt',
      prompt: { kind: 'trust-dialog', label: 'workspace trust dialog', excerpt: 'Do you trust the files in this folder?' },
      completedAt: 0,
    });
    expect(container.textContent).toContain('workspace trust dialog');
    expect(container.textContent).toContain(TERMINAL_CHECK_SENTENCE);
  });

  it('failed renders the same terminal-check sentence', () => {
    const fire = captureResultCallback();
    render('me');
    fire({ disposition: 'failed', agentId: 'me', delivered: false, reason: 'delivery-failed', completedAt: 0 });
    expect(container.textContent).toContain(TERMINAL_CHECK_SENTENCE);
  });

  it('an outcome for a DIFFERENT agent is ignored', () => {
    const fire = captureResultCallback();
    render('me');
    fire({ disposition: 'failed', agentId: 'someone-else', delivered: false, reason: 'delivery-failed', completedAt: 0 });
    expect(container.textContent).not.toContain(TERMINAL_CHECK_SENTENCE);
  });
});
