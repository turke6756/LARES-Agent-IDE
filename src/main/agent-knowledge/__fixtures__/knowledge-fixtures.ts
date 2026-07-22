// Fixtures for the deterministic knowledge extractor (WP4 / P3.1).
//
// Kept as TS constants (not on-disk .md) so they compile into `dist/` and the
// node:assert suite reads them without dist-vs-src path juggling. Content is
// intentionally realistic — headings, positive/negative imperatives, a numbered
// workflow, a MEMORY ref, a backticked path, and an `@import` — so each
// extraction rule is exercised by a single stable corpus.

import type {
  AgentContextOverhead,
  InheritanceFrame,
  InheritanceScope,
  McpServerOverhead,
  OverheadSource,
  OverheadSourceKind,
  TokenEstimate,
} from '../../../shared/types';

export const WS_ROOT = '/ws';
export const AGENT_CLAUDE = '/ws/.lares/workers/claude/CLAUDE.md';
export const WS_CLAUDE = '/ws/CLAUDE.md';
export const IMPORTED = '/ws/behavioral-notes.md';
export const SKILL = '/ws/.lares/workers/claude/.claude/skills/deep-research/SKILL.md';

// Agent-level CLAUDE.md: one positive imperative, one prohibition, a workflow
// heading with a numbered step, a MEMORY reference, and a backticked path.
export const AGENT_CLAUDE_MD = [
  '# Worker Agent',                                              // L1 capability
  '',
  'You are a generic worker launched by the supervisor.',       // synopsis
  '',
  '## How to ask questions',                                    // L5 workflow (how to)
  '',
  '- Use absolute paths for Read / Edit / Glob.',               // L7 capability (Use)
  "- Never invoke AskUserQuestion or blocking dialogs.",        // L8 constraint (Never)
  '',
  '1. Draft the change first.',                                 // L10 workflow (numbered)
  '',
  'Your memory lives in `memory/MEMORY.md` — read it first.',   // L12 memory + file-ref
].join('\n');

// Workspace-root CLAUDE.md: adds an `@import` to a shared notes file.
export const WS_CLAUDE_MD = [
  '# AgentDashboard',                                           // L1 capability
  '',
  'Workspace-centric orchestration.',                          // synopsis
  '',
  'See @behavioral-notes.md for shared habits.',               // L5 file-reference (@import)
].join('\n');

export const IMPORTED_MD = [
  '# Shared habits',                                            // L1 capability
  '',
  '- Prefer small, reversible commits.',                       // L3 capability (Prefer)
].join('\n');

// A SKILL.md with frontmatter + a numbered procedure in the body.
export const SKILL_MD = [
  '---',
  'name: deep-research',
  'description: Fan-out web research with adversarial verification.',
  '---',
  '',
  '# Deep research',                                           // L6 capability
  '',
  '1. Fan out search queries.',                                // L8 workflow (numbered)
].join('\n');

export const FILES: Record<string, string> = {
  [AGENT_CLAUDE]: AGENT_CLAUDE_MD,
  [WS_CLAUDE]: WS_CLAUDE_MD,
  [IMPORTED]: IMPORTED_MD,
  [SKILL]: SKILL_MD,
};

// ── minimal model builders ─────────────────────────────────────────────────────

const est: TokenEstimate = { tokens: 1, bytes: 1, chars: 1, method: 'chars-heuristic', approximate: false };

function mkSource(
  kind: OverheadSourceKind,
  resolvedPath: string,
  label: string,
  scope: InheritanceScope,
  children: OverheadSource[] = [],
): OverheadSource {
  return {
    id: `${resolvedPath}#${kind}`,
    kind,
    label,
    resolvedPath,
    dedupeKey: resolvedPath,
    sourceScope: scope,
    openable: true,
    exists: true,
    inherited: scope !== 'agent',
    estimate: est,
    origin: 'walk-up',
    mutable: 'user-owned',
    children,
    warnings: [],
  };
}

function mkMcp(
  id: string,
  displayName: string,
  toolCount: number,
  opts: { granted?: boolean; excluded?: boolean; schemaSourced?: boolean; configPath?: string | null } = {},
): McpServerOverhead {
  return {
    id,
    displayName,
    source: 'dashboard-injected',
    configPath: opts.configPath ?? null,
    grantedToAgent: opts.granted ?? true,
    excludedByStrictMode: opts.excluded ?? false,
    schemaSourced: opts.schemaSourced ?? true,
    total: est,
    tools: Array.from({ length: toolCount }, (_, i) => ({
      name: `${id}_tool_${i}`,
      descriptionTokens: 1,
      inputSchemaTokens: 1,
      estimate: est,
      schemaSource: 'dashboard-module' as const,
    })),
    warnings: [],
  };
}

/** Build a representative analyzed agent: agent-level CLAUDE.md + a skill
 *  (header/body pair sharing a path) in the agent frame, an ancestor workspace
 *  CLAUDE.md that `@import`s a shared notes file, and three MCP servers
 *  (granted, strict-excluded, not-granted). */
export function buildFixtureAgent(): AgentContextOverhead {
  const importChild = mkSource('import', IMPORTED, '@behavioral-notes.md', 'workspace-ancestor');

  const agentFrame: InheritanceFrame = {
    dir: '/ws/.lares/workers/claude',
    scope: 'agent',
    distanceFromAgentCwd: 0,
    included: true,
    sources: [
      mkSource('agent-claude', AGENT_CLAUDE, 'CLAUDE.md', 'agent'),
      // Skill emitted as header + body sharing the same resolvedPath (walk-up P1.1).
      mkSource('skill-header', SKILL, '.claude/skills/deep-research/SKILL.md', 'agent'),
      mkSource('skill-body', SKILL, '.claude/skills/deep-research/SKILL.md', 'agent'),
    ],
  };

  const ancestorFrame: InheritanceFrame = {
    dir: '/ws',
    scope: 'workspace-ancestor',
    distanceFromAgentCwd: 2,
    included: true,
    sources: [mkSource('inherited-claude', WS_CLAUDE, 'CLAUDE.md', 'workspace-ancestor', [importChild])],
  };

  // An excluded (gated-out) frame that must be IGNORED by the extractor.
  const excludedFrame: InheritanceFrame = {
    dir: '/other',
    scope: 'additional-dir',
    distanceFromAgentCwd: 0,
    included: false,
    sources: [mkSource('inherited-claude', '/other/CLAUDE.md', 'CLAUDE.md', 'additional-dir')],
  };

  return {
    id: 'builtin:.lares/workers/claude',
    name: 'Worker (claude)',
    kind: 'builtin-worker',
    lane: 'worker',
    workingDir: '/ws/.lares/workers/claude',
    pathType: 'wsl',
    inheritanceChain: [agentFrame, ancestorFrame, excludedFrame],
    mcpServers: [
      mkMcp('dashboard', 'agent-dashboard', 3, { granted: true, configPath: '/ws/.mcp.json' }),
      mkMcp('teams', 'agent-teams', 2, { granted: true, excluded: true }),
      mkMcp('ungranted', 'not-mine', 1, { granted: false }),
    ],
    flatSources: [],
    total: est,
    totalHeaderView: est,
    exactness: 'estimated',
    warnings: [],
  };
}
