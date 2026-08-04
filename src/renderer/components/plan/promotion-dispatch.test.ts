import { describe, expect, it, vi } from 'vitest';
import type { Agent, Workspace } from '../../../shared/types';
import { buildProposalToPlanInstruction, dispatchProposalPromotion } from './promotion-dispatch';

const workspace = { id: 'ws-1', path: 'C:\\work', pathType: 'windows', title: 'Work' } as Workspace;
const agent = (over: Partial<Agent>): Agent => ({
  id: 'super-1', workspaceId: 'ws-1', title: 'Supervisor One', status: 'idle', isSupervisor: true,
  ...over,
} as Agent);

describe('proposal promotion dispatch', () => {
  it('names the proposal path and proposal-to-plan skill in the instruction', () => {
    const instruction = buildProposalToPlanInstruction('C:\\work\\.lares\\proposals\\idea.md');
    expect(instruction).toContain('C:\\work\\.lares\\proposals\\idea.md');
    expect(instruction).toContain('proposal-to-plan');
  });

  it('messages a live supervisor', async () => {
    const sendInput = vi.fn(async () => undefined);
    const result = await dispatchProposalPromotion({
      workspace, proposalFilePath: 'C:\\work\\.lares\\proposals\\idea.md', selectedAgent: agent({}), newSupervisorTitle: '',
      deps: { sendInput, launch: vi.fn(), revive: vi.fn() },
    });
    expect(result.path).toBe('live');
    expect(sendInput).toHaveBeenCalledWith('super-1', expect.stringContaining('proposal-to-plan'));
  });

  it('revives a terminal supervisor with the instruction queued atomically', async () => {
    const revive = vi.fn(async () => undefined);
    const result = await dispatchProposalPromotion({
      workspace, proposalFilePath: 'C:\\work\\.lares\\proposals\\idea.md', selectedAgent: agent({ status: 'done' }), newSupervisorTitle: '',
      deps: { sendInput: vi.fn(), launch: vi.fn(), revive },
    });
    expect(result.path).toBe('revived');
    expect(revive).toHaveBeenCalledWith('super-1', expect.stringContaining('C:\\work\\.lares\\proposals\\idea.md'));
  });

  it('launches a new structural supervisor with the instruction as its initial user prompt', async () => {
    const launch = vi.fn(async (input) => agent({ id: 'new-1', title: input.title }));
    const result = await dispatchProposalPromotion({
      workspace, proposalFilePath: 'C:\\work\\.lares\\proposals\\idea.md', selectedAgent: null, newSupervisorTitle: 'Plan owner',
      deps: { sendInput: vi.fn(), launch, revive: vi.fn() },
    });
    expect(result.path).toBe('new');
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Plan owner', isSupervisor: true, workingDirectory: 'C:\\work',
      initialUserPrompt: expect.stringContaining('proposal-to-plan'),
    }));
  });
});
