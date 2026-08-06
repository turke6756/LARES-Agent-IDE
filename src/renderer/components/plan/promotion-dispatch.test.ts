import { describe, expect, it, vi } from 'vitest';
import type { Agent, Workspace } from '../../../shared/types';
import {
  buildProposalToPlanInstruction,
  dispatchProposalPromotion,
  isSafeProposalRelPath,
  isValidProposalArtifactId,
} from './promotion-dispatch';

const workspace = { id: 'ws-1', path: 'C:\\work', pathType: 'windows', title: 'Work' } as Workspace;
const agent = (over: Partial<Agent>): Agent => ({
  id: 'super-1', workspaceId: 'ws-1', title: 'Supervisor One', status: 'idle', isSupervisor: true,
  ...over,
} as Agent);

describe('proposal promotion dispatch', () => {
  it('binds the exact proposal path and artifact id to the promotion-only lifecycle instruction', () => {
    const instruction = buildProposalToPlanInstruction(
      '.lares/proposals/idea.md',
      'prop_0e1425af',
    );
    expect(instruction).toContain('Proposal path: .lares/proposals/idea.md');
    expect(instruction).toContain('Proposal artifact_id: prop_0e1425af');
    expect(instruction).toContain('proposal-to-plan');
    expect(instruction).toContain('Do NOT run capture');
    expect(instruction).toContain('scope -> promote -> deliberate -> integrate -> package');
    expect(instruction).not.toContain('capture/scope/promote as applicable');
  });

  it('validates the portable proposal artifact id format after trimming', () => {
    expect(isValidProposalArtifactId(' prop_0e1425af ')).toBe(true);
    expect(isValidProposalArtifactId('plan_0e1425af')).toBe(false);
    expect(isValidProposalArtifactId(null)).toBe(false);
  });

  it('accepts only canonical server-relative proposal paths', () => {
    expect(isSafeProposalRelPath('.lares/proposals/idea.md')).toBe(true);
    expect(isSafeProposalRelPath('.dashboard/proposals/idea.md')).toBe(true);
    expect(isSafeProposalRelPath('C:\\work\\.lares\\proposals\\idea.md')).toBe(false);
    expect(isSafeProposalRelPath('.lares/proposals/../idea.md')).toBe(false);
    expect(isSafeProposalRelPath('idea.md')).toBe(false);
  });

  it('messages a live supervisor', async () => {
    const sendInput = vi.fn(async () => undefined);
    const result = await dispatchProposalPromotion({
      workspace, proposalRelPath: '.lares/proposals/idea.md', planArtifactId: 'plan_0e1425af',
      selectedAgent: agent({}), newSupervisorTitle: '',
      deps: { sendInput, launch: vi.fn(), revive: vi.fn() },
    });
    expect(result.path).toBe('live');
    expect(sendInput).toHaveBeenCalledWith('super-1', expect.stringContaining('proposal-to-plan'));
  });

  it('revives a terminal supervisor with the instruction queued atomically', async () => {
    const revive = vi.fn(async () => undefined);
    const result = await dispatchProposalPromotion({
      workspace, proposalRelPath: '.lares/proposals/idea.md', planArtifactId: 'plan_0e1425af',
      selectedAgent: agent({ status: 'done' }), newSupervisorTitle: '',
      deps: { sendInput: vi.fn(), launch: vi.fn(), revive },
    });
    expect(result.path).toBe('revived');
    expect(revive).toHaveBeenCalledWith('super-1', expect.stringContaining('.lares/proposals/idea.md'));
  });

  it('launches a new structural supervisor with the instruction as its initial user prompt', async () => {
    const launch = vi.fn(async (input) => agent({ id: 'new-1', title: input.title }));
    const result = await dispatchProposalPromotion({
      workspace, proposalRelPath: '.lares/proposals/idea.md', planArtifactId: 'plan_0e1425af',
      selectedAgent: null, newSupervisorTitle: 'Plan owner',
      deps: { sendInput: vi.fn(), launch, revive: vi.fn() },
    });
    expect(result.path).toBe('new');
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Plan owner', isSupervisor: true, workingDirectory: 'C:\\work',
      initialUserPrompt: expect.stringContaining('proposal-to-plan'),
    }));
  });

  it('rejects an invalid artifact id before any side effect', async () => {
    const launch = vi.fn();
    const sendInput = vi.fn();
    const revive = vi.fn();

    await expect(dispatchProposalPromotion({
      workspace,
      proposalRelPath: '.lares/proposals/idea.md',
      planArtifactId: 'plan_NOTVALID',
      selectedAgent: agent({}),
      newSupervisorTitle: '',
      deps: { launch, sendInput, revive },
    })).rejects.toThrow('server preflight returned an invalid plan identity');

    expect(launch).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
    expect(revive).not.toHaveBeenCalled();
  });
});
