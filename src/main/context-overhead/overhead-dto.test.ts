// overhead-dto.test — analytics-export plan §6 tests 4 (redaction) and 5
// (generationId stability), plus the §2.3 "no bodies on OverheadSource" assertion.
//   npm run build:main
//   node dist/main/main/context-overhead/overhead-dto.test.js

import assert from 'node:assert/strict';
import type {
  AgentContextOverhead, ConfigWeightRollup, McpServerOverhead, OverheadModel,
  OverheadSource, SectionWeightClass, TokenEstimate,
} from '../../shared/types';
import type { RedactionRoots } from '../context-optimizer/agent-dto';
import {
  buildOverheadSnapshot, computeOverheadGenerationId, redactOverheadModel,
  SYSTEM_BASELINE_NOTE, scrubPaths,
} from './overhead-dto';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// ── fixture ───────────────────────────────────────────────────────────────────

// A deliberately distinctive username so the "no fixture username anywhere"
// assertion cannot pass by coincidence.
const USER = 'zqfixtureuser';
const WS_ROOT = `C:\\Users\\${USER}\\Projects\\Demo`;
const DASH_ROOT = `${WS_ROOT}\\.dashboard`;
const HOME = `C:\\Users\\${USER}`;
const SKILL_ROOT = `${WS_ROOT}\\.claude\\skills\\lares`;

const ROOTS: RedactionRoots = {
  workspaceRoot: WS_ROOT,
  dashboardRoot: DASH_ROOT,
  homeDir: HOME,
  skillRoots: [{ root: SKILL_ROOT, skillName: 'lares' }],
};

function est(tokens: number): TokenEstimate {
  return { tokens, bytes: tokens * 4, chars: tokens * 4, method: 'tiktoken-approx', approximate: true };
}

function src(id: string, resolvedPath: string | null, extra: Partial<OverheadSource> = {}): OverheadSource {
  return {
    id,
    kind: 'inherited-claude',
    label: id,
    resolvedPath,
    dedupeKey: resolvedPath ?? `synthetic:${id}`,
    sourceScope: 'workspace-ancestor',
    openable: resolvedPath != null,
    exists: true,
    inherited: true,
    estimate: est(100),
    origin: 'walk-up',
    disclosureTier: 'resident',
    mutable: 'user-owned',
    ...extra,
  };
}

function rollup(sourcePath: string): ConfigWeightRollup {
  const tokensByClass = {
    live: 0, dead: 0, 'structurally-broken': 12,
    'insufficient-evidence': 0, unobservable: 0, 'not-analyzed': 0,
  } as Record<SectionWeightClass, number>;
  return {
    sections: [{
      sourcePath,
      sourceLabel: 'CLAUDE.md',
      scope: 'workspace-ancestor',
      heading: 'Build & run',
      startLine: 12,
      endLine: 30,
      tokens: 12,
      weightClass: 'structurally-broken',
      evidence: [`references ${WS_ROOT}\\missing.md — file not found`],
    }],
    tokensByClass,
  };
}

function server(): McpServerOverhead {
  return {
    id: 'agent-dashboard',
    displayName: 'agent-dashboard',
    source: 'dashboard-injected',
    configPath: `${HOME}\\.claude.json`,
    grantedToAgent: true,
    excludedByStrictMode: false,
    schemaSourced: true,
    total: est(900),
    tools: [{
      name: 'read_agent_chat',
      descriptionTokens: 20,
      inputSchemaTokens: 40,
      estimate: est(60),
      schemaSource: 'dashboard-module',
    }],
    warnings: [`schema loaded from ${WS_ROOT}\\scripts\\mcp-tools-observability.js`],
  };
}

function strictExcludedServer(): McpServerOverhead {
  return {
    ...server(),
    id: 'external-thing',
    displayName: 'external-thing',
    source: 'user-global',
    excludedByStrictMode: true,
    total: est(0),
    tools: [],
    warnings: [],
  };
}

function agent(id: string, overrides: Partial<AgentContextOverhead> = {}): AgentContextOverhead {
  const sources: OverheadSource[] = [
    src('ws-claude', `${WS_ROOT}\\CLAUDE.md`),
    src('dash-claude', `${DASH_ROOT}\\workers\\claude\\CLAUDE.md`, { sourceScope: 'agent' }),
    src('skill-hdr', `${SKILL_ROOT}\\SKILL.md`, { kind: 'skill-header' }),
    src('home-claude', `${HOME}\\.claude\\CLAUDE.md`, { kind: 'user-claude', sourceScope: 'user' }),
    src('ssh-cfg', `${HOME}\\.ssh\\keys\\deploy\\id_rsa`, { kind: 'unknown' }),
    src('wsl-claude', '/home/' + USER + '/wslproj/CLAUDE.md', { kind: 'unknown' }),
    src('external', 'D:\\Elsewhere\\notes.md', { kind: 'unknown' }),
    src('baseline', null, { kind: 'system-baseline', openable: false }),
  ];
  return {
    id,
    name: `agent-${id}`,
    kind: 'builtin-worker',
    lane: 'worker',
    workingDir: `${DASH_ROOT}\\workers\\claude`,
    pathType: 'windows',
    sidecarPath: `${DASH_ROOT}\\workers\\claude\\AGENT.md`,
    inheritanceChain: [{
      dir: WS_ROOT,
      scope: 'workspace-ancestor',
      distanceFromAgentCwd: 3,
      included: true,
      sources,
    }],
    mcpServers: [server(), strictExcludedServer()],
    flatSources: sources,
    total: est(1000),
    totalHeaderView: est(800),
    residentTotal: est(700),
    onDemandTotal: est(300),
    configWeight: rollup(`${WS_ROOT}\\CLAUDE.md`),
    exactness: 'estimated',
    warnings: [`could not read ${HOME}\\.claude\\settings.json`],
    ...overrides,
  };
}

function model(overrides: Partial<OverheadModel> = {}): OverheadModel {
  return {
    workspaceId: 'ws-1',
    workspaceRoot: WS_ROOT,
    pathType: 'windows',
    generatedAt: '2026-07-19T18:44:55.123Z',
    estimatorMethod: 'tiktoken-approx',
    systemBaseline: undefined,
    agents: [agent('a1'), agent('a2', { lane: 'supervisor', id: 'a2' })],
    workspaceConfigWeight: rollup(`${WS_ROOT}\\CLAUDE.md`),
    globalWarnings: [`persona scan skipped ${WS_ROOT}\\.dashboard\\personas`],
    ...overrides,
  };
}

// ── test 4: redaction ─────────────────────────────────────────────────────────

test('every emitted artifact is free of drives, backslashes, usernames, and the workspace root', () => {
  const emitted = JSON.stringify(buildOverheadSnapshot(model(), ROOTS));

  assert.equal(/[A-Za-z]:[\\/]/.test(emitted), false, 'a drive prefix survived redaction');
  // JSON escapes a literal backslash as `\\`; assert on the decoded form too.
  assert.equal(emitted.includes('\\\\'), false, 'a windows path separator survived redaction');
  assert.equal(emitted.includes(USER), false, 'the fixture username survived redaction');
  assert.equal(emitted.toLowerCase().includes('projects/demo'), false, 'the absolute workspace root survived redaction');
  // A sensitive-home path collapses to `~/<dir>/<basename>` — the intervening
  // directories (which can name projects or hosts) must be gone.
  assert.equal(emitted.includes('keys/deploy'), false, 'a sensitive-home parent path survived redaction');
  assert.ok(emitted.includes('~/.ssh/id_rsa'), 'the collapsed sensitive-home form should still be emitted');
  assert.equal(emitted.toLowerCase().includes('elsewhere'), false, 'an external path parent survived redaction');
});

test('scope prefixes and stable pathHash survive', () => {
  const red = redactOverheadModel(model(), ROOTS);
  const flat = red.agents[0].flatSources;
  const display = (i: number): string => flat[i].source?.pathDisplay ?? '';

  // NOTE: the shared redactor lower-cases the relative segment (it matches roots
  // case-insensitively via the file-coverage `normPath` convention). That is
  // pre-existing production behavior and is asserted here as-is, not worked around.
  assert.equal(display(0), '$WORKSPACE/claude.md');
  assert.equal(display(1), '$DASHBOARD/workers/claude/claude.md');
  assert.equal(display(2), '$SKILL/lares/skill.md');
  assert.equal(display(3), '~/.claude/claude.md');
  assert.equal(display(4), '~/.ssh/id_rsa');
  assert.equal(flat[6].source?.pathScope, 'external');
  assert.equal(display(6), 'external/notes.md');
  assert.equal(flat[7].source, null, 'a synthetic source has no path');

  // pathHash is content-derived and identical across two independent redactions.
  const again = redactOverheadModel(model(), ROOTS);
  assert.equal(flat[0].source?.pathHash, again.agents[0].flatSources[0].source?.pathHash);
  assert.equal(typeof flat[0].source?.pathHash, 'string');
  assert.equal(red.workspaceRootDisplay, '$WORKSPACE');
});

test('structure survives redaction verbatim — lines, kinds, counts, estimates, exactness, flags', () => {
  const red = redactOverheadModel(model(), ROOTS);
  const a = red.agents[0];
  assert.equal(a.exactness, 'estimated');
  assert.equal(a.total.tokens, 1000);
  assert.equal(a.residentTotal?.tokens, 700);
  assert.equal(a.onDemandTotal?.tokens, 300);
  assert.equal(a.flatSources[0].estimate.bytes, 400);
  assert.equal(a.flatSources[0].kind, 'inherited-claude');
  assert.equal(a.flatSources[0].inherited, true);
  assert.equal(a.inheritanceChain[0].distanceFromAgentCwd, 3);
  assert.equal(a.inheritanceChain[0].included, true);
  assert.equal(a.configWeight?.sections[0].startLine, 12);
  assert.equal(a.configWeight?.sections[0].endLine, 30);
  assert.equal(a.configWeight?.sections[0].weightClass, 'structurally-broken');
  assert.equal(a.mcpServers[0].tools[0].name, 'read_agent_chat');
  assert.equal(a.mcpServers[0].tools[0].inputSchemaTokens, 40);
  assert.equal(a.mcpServers[1].excludedByStrictMode, true);
  assert.ok(a.warnings.length > 0, 'warnings are preserved (scrubbed, not dropped)');
});

test('OverheadSource carries no file bodies — asserted, not trusted', () => {
  const red = redactOverheadModel(model(), ROOTS);
  for (const s of red.agents[0].flatSources) {
    for (const banned of ['content', 'body', 'text', 'snippet', 'raw']) {
      assert.equal(banned in (s as unknown as Record<string, unknown>), false,
        `OverheadSource gained a '${banned}' field — it would cross the redaction boundary unfiltered`);
    }
  }
});

test('scrubPaths replaces absolute path tokens but keeps surrounding structure', () => {
  assert.equal(scrubPaths('references C:\\Users\\bob\\x.md — file not found'),
    'references <path> — file not found');
  assert.equal(scrubPaths('references /home/bob/x.md — file not found'),
    'references <path> — file not found');
  assert.equal(scrubPaths('references ./local.md — resolves'), 'references ./local.md — resolves');
});

test('systemBaseline is null when unmeasured — never coerced to a zero estimate', () => {
  const red = redactOverheadModel(model(), ROOTS);
  assert.equal(red.systemBaseline, null);
  assert.equal(red.systemBaselineNote, SYSTEM_BASELINE_NOTE);
  assert.ok(red.systemBaselineNote.includes('floor, not a total'));

  const measured = redactOverheadModel(model({ systemBaseline: est(29000) }), ROOTS);
  assert.equal(measured.systemBaseline?.tokens, 29000);
});

test('measuredMcpInventory reports what the scan measured, split from strict-excluded', () => {
  const red = redactOverheadModel(model(), ROOTS);
  const worker = red.measuredMcpInventory.find((r) => r.lane === 'worker');
  assert.deepEqual(worker?.countedServers, ['agent-dashboard']);
  assert.deepEqual(worker?.excludedByStrictMode, ['external-thing']);
  assert.equal(worker?.toolCount, 1);
  assert.equal(worker?.countedTokens, 900);
  // It is inventory, NOT the configured grant — no toolset/grant field may appear here.
  assert.equal('toolsets' in (worker as unknown as Record<string, unknown>), false);
  assert.equal('strictMcp' in (worker as unknown as Record<string, unknown>), false);
});

// ── test 5: generationId stability ────────────────────────────────────────────

test('two scans of an unchanged workspace produce an identical generationId', () => {
  assert.equal(computeOverheadGenerationId(model()), computeOverheadGenerationId(model()));
});

test('generationId does NOT vary with generatedAt', () => {
  const a = computeOverheadGenerationId(model({ generatedAt: '2026-07-19T18:44:55.123Z' }));
  const b = computeOverheadGenerationId(model({ generatedAt: '2027-01-01T00:00:00.000Z' }));
  assert.equal(a, b, 'a timestamp leaked into generationId — drift detection would be impossible');
});

test("changing one agent's token total changes the generationId", () => {
  const base = computeOverheadGenerationId(model());
  const changed = computeOverheadGenerationId(model({
    agents: [agent('a1', { total: est(1001) }), agent('a2', { lane: 'supervisor', id: 'a2' })],
  }));
  assert.notEqual(base, changed);
});

test('the envelope carries the same generationId and an honest empty state', () => {
  const res = buildOverheadSnapshot(model(), ROOTS);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.meta.generationId, computeOverheadGenerationId(model()));
  assert.equal(res.meta.dataState, 'ready');
  // A scan has no parity reference; that structural absence is reported as such,
  // never as a graded confidence.
  assert.equal(res.meta.parityStatus.state, 'unverified-no-reference');

  const empty = buildOverheadSnapshot(model({ agents: [] }), ROOTS);
  assert.equal(empty.ok && empty.meta.dataState, 'empty');
});

// ── runner ────────────────────────────────────────────────────────────────────

let failed = 0;
for (const t of tests) {
  try { t.run(); console.log(`  ok  ${t.name}`); }
  catch (e) { failed += 1; console.error(`  FAIL  ${t.name}\n`, e); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
