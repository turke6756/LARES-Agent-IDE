// Routes a built [SELECTION COMMENT] prompt to its destination agent.
// plans/selection-to-agent-primitive-plan.md §7 WP-P1, decisions §1.5/§1.6:
//   idle-ish existing agent → direct sendInput
//   busy existing agent    → append to its prompt staging (never reject-and-lose)
//   new agent              → launch with initialUserPrompt (delivered by WP-P2 seam)

import { useDashboardStore } from '../../stores/dashboard-store';
import { loadStaging, saveStaging, newNoteId } from '../prompt-staging';
import { buildQuotedPrompt, type QuotedPromptSource } from './quoted-prompt';
import type { QuoteItem, SelectionAgentTarget } from './selection-types';
import { showSelectionToast } from './selection-toast';
import { notifyStagingExternalChange } from './staging-events';

// Statuses where the agent's input bar accepts a message directly.
const INPUT_ACCEPTING = new Set(['idle', 'waiting', 'done', 'crashed']);

export type SendSelectionResult =
  | { outcome: 'sent'; agentId: string }
  | { outcome: 'staged'; agentId: string }
  | { outcome: 'launched' }
  | { outcome: 'error'; error: string };

export interface SendSelectionContext extends QuotedPromptSource {
  workspaceId: string;
}

export async function sendSelectionToAgent(
  target: SelectionAgentTarget,
  ctx: SendSelectionContext,
  items: QuoteItem[],
): Promise<SendSelectionResult> {
  const prompt = buildQuotedPrompt(ctx, items);

  if (target.kind === 'new') {
    try {
      await window.api.agents.launch({
        workspaceId: ctx.workspaceId,
        title: 'Selection task',
        provider: 'claude',
        isWorker: true,
        initialUserPrompt: prompt,
      });
      showSelectionToast('Launching agent…');
      return { outcome: 'launched' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      showSelectionToast(`Failed to launch agent: ${error}`, 'error');
      return { outcome: 'error', error };
    }
  }

  const agent = useDashboardStore.getState().agents.find((a) => a.id === target.agentId);
  if (!agent) {
    const error = 'Agent not found — it may have been removed';
    showSelectionToast(error, 'error');
    return { outcome: 'error', error };
  }

  if (INPUT_ACCEPTING.has(agent.status)) {
    try {
      await window.api.agents.sendInput(agent.id, prompt);
      showSelectionToast(`Sent to "${agent.title}"`);
      return { outcome: 'sent', agentId: agent.id };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      showSelectionToast(`Failed to send to "${agent.title}": ${error}`, 'error');
      return { outcome: 'error', error };
    }
  }

  // Busy: park the prompt as a note in that agent's staging panel.
  const staging = loadStaging(agent.id);
  saveStaging(agent.id, {
    ...staging,
    slots: [...staging.slots, { kind: 'note', id: newNoteId(), text: prompt }],
  });
  // A mounted PromptStaging panel must re-read, or its next persist would
  // clobber the note we just appended behind its back.
  notifyStagingExternalChange(agent.id);
  showSelectionToast(`Agent "${agent.title}" is busy — saved to its prompt staging`);
  return { outcome: 'staged', agentId: agent.id };
}
