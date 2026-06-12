// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendSelectionToAgent } from './selection-dispatch';
import { loadStaging } from '../prompt-staging';
import { buildQuotedPrompt } from './quoted-prompt';
import { showSelectionToast } from './selection-toast';
import { onStagingExternalChange } from './staging-events';

// Dispatch reads agents from the dashboard store; feed it a controllable list.
const mockAgents: Array<{ id: string; workspaceId: string; title: string; status: string }> = [];
vi.mock('../../stores/dashboard-store', () => ({
  useDashboardStore: { getState: () => ({ agents: mockAgents }) },
}));

vi.mock('./selection-toast', () => ({ showSelectionToast: vi.fn() }));

const sendInput = vi.fn<(agentId: string, text: string) => Promise<void>>();
const launch = vi.fn<(input: unknown) => Promise<unknown>>();

const ctx = {
  targetType: 'chat-message' as const,
  workspaceId: 'ws-1',
  sourceLabel: 'agent chat with "Builder"',
};
const items = [{ quote: 'selected text' }];
const expectedPrompt = buildQuotedPrompt(ctx, items);

function setAgents(...agents: Array<{ id: string; workspaceId: string; title: string; status: string }>) {
  mockAgents.length = 0;
  mockAgents.push(...agents);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sendInput.mockResolvedValue(undefined);
  launch.mockResolvedValue({ id: 'new-agent' });
  (window as unknown as { api: unknown }).api = { agents: { sendInput, launch } };
  setAgents();
});

describe('sendSelectionToAgent — existing agent, input-accepting', () => {
  it.each(['idle', 'waiting', 'done', 'crashed'])(
    'sends directly via IPC when status is %s',
    async (status) => {
      setAgents({ id: 'a1', workspaceId: 'ws-1', title: 'Builder', status });
      const result = await sendSelectionToAgent({ kind: 'existing', agentId: 'a1' }, ctx, items);
      expect(result).toEqual({ outcome: 'sent', agentId: 'a1' });
      expect(sendInput).toHaveBeenCalledExactlyOnceWith('a1', expectedPrompt);
      expect(launch).not.toHaveBeenCalled();
      // Nothing parked in staging on the direct path.
      expect(loadStaging('a1').slots.filter((s) => s.kind === 'note')).toHaveLength(0);
    },
  );

  it('surfaces an IPC rejection as an error toast, never throws', async () => {
    setAgents({ id: 'a1', workspaceId: 'ws-1', title: 'Builder', status: 'idle' });
    sendInput.mockRejectedValue(new Error('pty gone'));
    const result = await sendSelectionToAgent({ kind: 'existing', agentId: 'a1' }, ctx, items);
    expect(result).toEqual({ outcome: 'error', error: 'pty gone' });
    expect(showSelectionToast).toHaveBeenCalledWith(
      expect.stringContaining('pty gone'),
      'error',
    );
  });
});

describe('sendSelectionToAgent — existing agent, busy', () => {
  it.each(['working', 'launching', 'receiving', 'restarting'])(
    'appends to prompt staging when status is %s (never reject-and-lose)',
    async (status) => {
      setAgents({ id: 'a1', workspaceId: 'ws-1', title: 'Builder', status });
      const result = await sendSelectionToAgent({ kind: 'existing', agentId: 'a1' }, ctx, items);
      expect(result).toEqual({ outcome: 'staged', agentId: 'a1' });
      expect(sendInput).not.toHaveBeenCalled();
      const notes = loadStaging('a1').slots.filter((s) => s.kind === 'note');
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ text: expectedPrompt });
      expect(showSelectionToast).toHaveBeenCalledWith(
        'Agent "Builder" is busy — saved to its prompt staging',
      );
    },
  );

  it('appends after existing staged notes rather than replacing them', async () => {
    setAgents({ id: 'a1', workspaceId: 'ws-1', title: 'Builder', status: 'working' });
    await sendSelectionToAgent({ kind: 'existing', agentId: 'a1' }, ctx, [{ quote: 'first' }]);
    await sendSelectionToAgent({ kind: 'existing', agentId: 'a1' }, ctx, [{ quote: 'second' }]);
    const notes = loadStaging('a1').slots.filter((s) => s.kind === 'note');
    expect(notes).toHaveLength(2);
    expect((notes[0] as { text: string }).text).toContain('> first');
    expect((notes[1] as { text: string }).text).toContain('> second');
    // The bar slot survives the appends (staging invariant: exactly one bar).
    expect(loadStaging('a1').slots.filter((s) => s.kind === 'bar')).toHaveLength(1);
  });

  it('signals the external staging change so a mounted PromptStaging re-reads (WP-P3 race fix)', async () => {
    setAgents({ id: 'a1', workspaceId: 'ws-1', title: 'Builder', status: 'working' });
    // The listener reads staging at fire time: proves the save lands BEFORE
    // the signal, so a reload-on-signal subscriber (PromptStaging) is lossless.
    const notesSeenAtFireTime: number[] = [];
    const onChangeA1 = vi.fn(() => {
      notesSeenAtFireTime.push(loadStaging('a1').slots.filter((s) => s.kind === 'note').length);
    });
    const onChangeOther = vi.fn();
    const offA1 = onStagingExternalChange('a1', onChangeA1);
    const offOther = onStagingExternalChange('someone-else', onChangeOther);
    try {
      await sendSelectionToAgent({ kind: 'existing', agentId: 'a1' }, ctx, items);
      expect(onChangeA1).toHaveBeenCalledTimes(1);
      expect(onChangeOther).not.toHaveBeenCalled();
      expect(notesSeenAtFireTime).toEqual([1]);
    } finally {
      offA1();
      offOther();
    }
  });

  it('does not signal an external staging change on the direct-send path', async () => {
    setAgents({ id: 'a1', workspaceId: 'ws-1', title: 'Builder', status: 'idle' });
    const onChange = vi.fn();
    const off = onStagingExternalChange('a1', onChange);
    try {
      await sendSelectionToAgent({ kind: 'existing', agentId: 'a1' }, ctx, items);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('errors when the agent id is unknown', async () => {
    const result = await sendSelectionToAgent({ kind: 'existing', agentId: 'ghost' }, ctx, items);
    expect(result.outcome).toBe('error');
    expect(sendInput).not.toHaveBeenCalled();
    expect(showSelectionToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });
});

describe('sendSelectionToAgent — new agent', () => {
  it('launches a claude worker with initialUserPrompt', async () => {
    const result = await sendSelectionToAgent({ kind: 'new' }, ctx, items);
    expect(result).toEqual({ outcome: 'launched' });
    expect(launch).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'ws-1',
      title: 'Selection task',
      provider: 'claude',
      isWorker: true,
      initialUserPrompt: expectedPrompt,
    });
    expect(showSelectionToast).toHaveBeenCalledWith('Launching agent…');
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('surfaces a launch rejection as an error toast', async () => {
    launch.mockRejectedValue(new Error('no workspace'));
    const result = await sendSelectionToAgent({ kind: 'new' }, ctx, items);
    expect(result).toEqual({ outcome: 'error', error: 'no workspace' });
    expect(showSelectionToast).toHaveBeenCalledWith(
      expect.stringContaining('no workspace'),
      'error',
    );
  });
});
