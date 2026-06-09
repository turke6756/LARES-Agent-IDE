import { OrchestrationDescriptor } from './types';

export const ORCHESTRATIONS: Record<string, OrchestrationDescriptor> = {
  groupthink: {
    name: 'groupthink',
    title: 'GroupThink',
    description: 'Two-planner deliberation that writes a worker-ready plan. ' +
      'serial = lead drafts / reviewer reviews / lead finalizes; ' +
      'parallel = fan-out + cross-pollination + synthesis (3 rounds).',
    modes: ['serial', 'parallel'],
    params: {
      mode:             { type: 'string', default: 'serial', description: 'serial | parallel' },
      topic:            { type: 'string', required: true, description: 'One-line deliberation topic' },
      planPath:         { type: 'string', default: 'plans/new-plan.md', description: 'Output plan path, relative to workspace root' },
      leadProvider:     { type: 'string', default: 'claude', description: 'Lead (serial) / synthesizer (parallel). Keep claude — only it writes plan files reliably.' },
      reviewerProvider: { type: 'string', default: 'codex',  description: 'Reviewer (serial) / peer planner (parallel)' },
      turnTimeoutMs:    { type: 'number', default: 600000,   description: 'Per-turn stall timeout (ms)' },
    },
  },
};
