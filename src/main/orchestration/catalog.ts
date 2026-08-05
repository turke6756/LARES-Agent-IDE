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
      leadProvider:     { type: 'string', default: 'claude', description: 'Writer slot (lead in serial; synthesizer in parallel): creates a fresh plan with Write or updates a native plan section with Edit. Any of claude|codex|grok|agy; default claude.' },
      reviewerProvider: { type: 'string', default: 'codex',  description: 'Reviewer slot (reviewer in serial; peer planner in parallel). Any of claude|codex|grok|agy; default codex.' },
      turnTimeoutMs:    { type: 'number', default: 600000,   description: 'Per-turn stall timeout (ms)' },
    },
  },
};
