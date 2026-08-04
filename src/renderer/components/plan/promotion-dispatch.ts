import type { Agent, LaunchAgentInput, Workspace } from '../../../shared/types';

export const NEW_SUPERVISOR_ID = '__new_supervisor__';
export const TERMINAL_AGENT_STATUSES = new Set(['done', 'crashed']);

export function buildProposalToPlanInstruction(proposalFilePath: string): string {
  return [
    'Promote this proposal into a plan.',
    `Proposal path: ${proposalFilePath}`,
    'Run the `proposal-to-plan` skill on it and carry it through capture/scope/promote as applicable under that skill.',
    'You are the responsible supervisor for the resulting plan folder.',
  ].join('\n');
}

export interface PromotionDispatchDeps {
  launch: (input: LaunchAgentInput) => Promise<Agent>;
  sendInput: (agentId: string, text: string) => Promise<unknown>;
  revive: (agentId: string, text: string) => Promise<unknown>;
}

export interface PromotionDispatchResult {
  supervisorId: string;
  supervisorTitle: string;
  path: 'live' | 'revived' | 'new';
  instruction: string;
}

export async function reviveSupervisorViaApi(agentId: string, instruction: string): Promise<unknown> {
  const token = await window.api.system.getApiToken();
  const response = await fetch(`http://127.0.0.1:24678/api/agents/${encodeURIComponent(agentId)}/revive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: instruction }),
  });
  if (!response.ok) {
    let detail = `Revival failed (${response.status})`;
    try {
      const body = await response.json() as { error?: string; message?: string };
      detail = body.error ?? body.message ?? detail;
    } catch { /* use status fallback */ }
    throw new Error(detail);
  }
  return response.json();
}

export async function dispatchProposalPromotion(input: {
  workspace: Workspace;
  proposalFilePath: string;
  selectedAgent: Agent | null;
  newSupervisorTitle: string;
  deps?: Partial<PromotionDispatchDeps>;
}): Promise<PromotionDispatchResult> {
  const instruction = buildProposalToPlanInstruction(input.proposalFilePath);
  const deps: PromotionDispatchDeps = {
    launch: (launchInput) => window.api.agents.launch(launchInput),
    sendInput: (agentId, text) => window.api.agents.sendInput(agentId, text),
    revive: reviveSupervisorViaApi,
    ...input.deps,
  };

  if (!input.selectedAgent) {
    const title = input.newSupervisorTitle.trim() || 'Planning supervisor';
    const created = await deps.launch({
      workspaceId: input.workspace.id,
      title,
      roleDescription: 'Responsible supervisor for a promoted proposal plan.',
      provider: 'claude',
      isSupervisor: true,
      workingDirectory: input.workspace.path,
      initialUserPrompt: instruction,
    });
    return { supervisorId: created.id, supervisorTitle: created.title, path: 'new', instruction };
  }

  if (TERMINAL_AGENT_STATUSES.has(input.selectedAgent.status)) {
    await deps.revive(input.selectedAgent.id, instruction);
    return {
      supervisorId: input.selectedAgent.id,
      supervisorTitle: input.selectedAgent.title,
      path: 'revived',
      instruction,
    };
  }

  await deps.sendInput(input.selectedAgent.id, instruction);
  return {
    supervisorId: input.selectedAgent.id,
    supervisorTitle: input.selectedAgent.title,
    path: 'live',
    instruction,
  };
}
