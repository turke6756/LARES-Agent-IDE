// Tests for the launch-command resolver (src/main/supervisor/launch-command.ts).
//
// Covers the two correctness rules behind the codex/gemini "launched as Claude"
// bug:
//   1. isFrameworkDefaultCommand() — a stored default that equals a framework
//      default except for a trailing/standalone ` --chrome` token still counts
//      as a framework default (so the provider override applies).
//   2. resolveLaunchCommand() — framework-default normalization + the
//      provider-mismatch guard (a non-claude provider is never launched via a
//      claude/ccode binary, even for a custom workspace command).
//
// Pure module — no DB, no Electron — so it runs under plain Node:
//   npm run build:main
//   node dist/main/main/supervisor/resolve-launch-command.test.js

import assert from 'node:assert/strict';
import { DEFAULT_COMMAND, DEFAULT_COMMAND_WSL, PROVIDER_COMMANDS } from '../../shared/constants';
import { isFrameworkDefaultCommand, isClaudeBinaryCommand, resolveLaunchCommand } from './launch-command';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

const LEGACY_DEFAULT = `${DEFAULT_COMMAND} --chrome`;
const LEGACY_DEFAULT_WSL = `${DEFAULT_COMMAND_WSL} --chrome`;

// ── isFrameworkDefaultCommand ───────────────────────────────────────────

test('current framework defaults are recognized', () => {
  assert.equal(isFrameworkDefaultCommand(DEFAULT_COMMAND), true);
  assert.equal(isFrameworkDefaultCommand(DEFAULT_COMMAND_WSL), true);
});

test('legacy --chrome framework defaults are recognized (the bug)', () => {
  assert.equal(isFrameworkDefaultCommand(LEGACY_DEFAULT), true);
  assert.equal(isFrameworkDefaultCommand(LEGACY_DEFAULT_WSL), true);
});

test('trailing whitespace / extra --chrome spacing still normalizes', () => {
  assert.equal(isFrameworkDefaultCommand(`${DEFAULT_COMMAND}   --chrome  `), true);
});

test('a genuinely custom command is NOT a framework default', () => {
  assert.equal(isFrameworkDefaultCommand('my-wrapper claude --foo'), false);
  assert.equal(isFrameworkDefaultCommand('claude --dangerously-skip-permissions --model opus'), false);
});

test('empty / null default command is not a framework default', () => {
  assert.equal(isFrameworkDefaultCommand(null), false);
  assert.equal(isFrameworkDefaultCommand(undefined), false);
  assert.equal(isFrameworkDefaultCommand(''), false);
});

// ── isClaudeBinaryCommand ───────────────────────────────────────────────

test('claude / ccode binaries are detected, codex / gemini are not', () => {
  assert.equal(isClaudeBinaryCommand('claude --dangerously-skip-permissions'), true);
  assert.equal(isClaudeBinaryCommand('  ccode --dangerously-skip-permissions'), true);
  assert.equal(isClaudeBinaryCommand('codex --dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(isClaudeBinaryCommand('gemini --yolo'), false);
});

// ── resolveLaunchCommand: framework-default normalization ───────────────

test('codex launch in a legacy-default workspace uses the codex binary, not claude', () => {
  const { command, providerOverride } = resolveLaunchCommand({
    inputCommand: undefined,
    workspaceDefaultCommand: LEGACY_DEFAULT,
    provider: 'codex',
    pathType: 'windows',
  });
  assert.equal(command, PROVIDER_COMMANDS.codex.windows);
  // Normalization handled it; the guard had nothing to override.
  assert.equal(providerOverride, null);
});

test('gemini launch in a current-default workspace uses the gemini binary', () => {
  const { command, providerOverride } = resolveLaunchCommand({
    inputCommand: undefined,
    workspaceDefaultCommand: DEFAULT_COMMAND,
    provider: 'gemini',
    pathType: 'windows',
  });
  assert.equal(command, PROVIDER_COMMANDS.gemini.windows);
  assert.equal(providerOverride, null);
});

test('WSL codex launch in a legacy-default WSL workspace uses ccodex', () => {
  const { command } = resolveLaunchCommand({
    inputCommand: undefined,
    workspaceDefaultCommand: LEGACY_DEFAULT_WSL,
    provider: 'codex',
    pathType: 'wsl',
  });
  assert.equal(command, PROVIDER_COMMANDS.codex.wsl);
});

test('claude launch in a framework-default workspace uses the claude default', () => {
  const { command, providerOverride } = resolveLaunchCommand({
    inputCommand: undefined,
    workspaceDefaultCommand: LEGACY_DEFAULT,
    provider: 'claude',
    pathType: 'windows',
  });
  assert.equal(command, PROVIDER_COMMANDS.claude.windows);
  assert.equal(providerOverride, null);
});

// ── resolveLaunchCommand: provider-mismatch guard (custom commands) ──────

test('codex launch in a CUSTOM claude-wrapper workspace is guarded to the codex binary', () => {
  const { command, providerOverride } = resolveLaunchCommand({
    inputCommand: undefined,
    workspaceDefaultCommand: 'claude --dangerously-skip-permissions --model opus',
    provider: 'codex',
    pathType: 'windows',
  });
  assert.equal(command, PROVIDER_COMMANDS.codex.windows);
  assert.ok(providerOverride);
  assert.equal(providerOverride!.from, 'claude --dangerously-skip-permissions --model opus');
  assert.equal(providerOverride!.to, PROVIDER_COMMANDS.codex.windows);
});

test('claude provider with a custom wrapper KEEPS the custom command (no guard)', () => {
  const custom = 'claude --dangerously-skip-permissions --model opus';
  const { command, providerOverride } = resolveLaunchCommand({
    inputCommand: undefined,
    workspaceDefaultCommand: custom,
    provider: 'claude',
    pathType: 'windows',
  });
  assert.equal(command, custom);
  assert.equal(providerOverride, null);
});

test('codex launch with a custom NON-claude wrapper is respected verbatim', () => {
  const custom = 'codex --dangerously-bypass-approvals-and-sandbox --profile foo';
  const { command, providerOverride } = resolveLaunchCommand({
    inputCommand: undefined,
    workspaceDefaultCommand: custom,
    provider: 'codex',
    pathType: 'windows',
  });
  assert.equal(command, custom);
  assert.equal(providerOverride, null);
});

test('explicit non-claude provider with an explicit claude input command is still guarded', () => {
  const { command, providerOverride } = resolveLaunchCommand({
    inputCommand: 'ccode --dangerously-skip-permissions',
    workspaceDefaultCommand: 'codex --dangerously-bypass-approvals-and-sandbox',
    provider: 'codex',
    pathType: 'wsl',
  });
  assert.equal(command, PROVIDER_COMMANDS.codex.wsl);
  assert.ok(providerOverride);
  assert.equal(providerOverride!.to, PROVIDER_COMMANDS.codex.wsl);
});

test('explicit input command for matching provider is used verbatim', () => {
  const explicit = 'codex --dangerously-bypass-approvals-and-sandbox --extra';
  const { command, providerOverride } = resolveLaunchCommand({
    inputCommand: explicit,
    workspaceDefaultCommand: DEFAULT_COMMAND,
    provider: 'codex',
    pathType: 'windows',
  });
  assert.equal(command, explicit);
  assert.equal(providerOverride, null);
});

// ── resolveLaunchCommand: grok (plan §1.8) ──────────────────────────────

test('grok launch in a framework-default workspace resolves to the grok binary', () => {
  const { command, providerOverride } = resolveLaunchCommand({
    inputCommand: undefined,
    workspaceDefaultCommand: DEFAULT_COMMAND,
    provider: 'grok',
    pathType: 'windows',
  });
  assert.equal(command, PROVIDER_COMMANDS.grok.windows);
  assert.equal(command, 'grok');
  assert.equal(providerOverride, null);
});

test('grok launch in a legacy --chrome default workspace still resolves to grok', () => {
  const { command } = resolveLaunchCommand({
    inputCommand: undefined,
    workspaceDefaultCommand: LEGACY_DEFAULT,
    provider: 'grok',
    pathType: 'windows',
  });
  assert.equal(command, PROVIDER_COMMANDS.grok.windows);
});

test('a CUSTOM claude/ccode command can NOT silently launch grok — guarded to the grok binary', () => {
  // Genuinely custom (non-framework) claude AND ccode wrappers: the guard, not
  // framework-default normalization, is what must catch these — a bare
  // `ccode --dangerously-skip-permissions` IS the WSL framework default and would
  // be normalized instead, so add a flag to make each a real custom command.
  for (const claudeish of ['claude --dangerously-skip-permissions --model opus', 'ccode --dangerously-skip-permissions --model opus']) {
    const { command, providerOverride } = resolveLaunchCommand({
      inputCommand: undefined,
      workspaceDefaultCommand: claudeish,
      provider: 'grok',
      pathType: 'windows',
    });
    assert.equal(command, PROVIDER_COMMANDS.grok.windows, `grok must not launch via "${claudeish}"`);
    assert.ok(providerOverride, 'the claude→grok mismatch must be flagged');
    assert.equal(providerOverride!.from, claudeish);
    assert.equal(providerOverride!.to, PROVIDER_COMMANDS.grok.windows);
  }
});

test('an explicit claude input command with a grok provider is still guarded to grok', () => {
  const { command, providerOverride } = resolveLaunchCommand({
    inputCommand: 'claude --dangerously-skip-permissions',
    workspaceDefaultCommand: 'grok',
    provider: 'grok',
    pathType: 'windows',
  });
  assert.equal(command, PROVIDER_COMMANDS.grok.windows);
  assert.ok(providerOverride);
  assert.equal(providerOverride!.to, PROVIDER_COMMANDS.grok.windows);
});

test('a genuine custom grok wrapper is respected verbatim (not clobbered)', () => {
  const custom = 'my-grok-wrapper --flag';
  const { command, providerOverride } = resolveLaunchCommand({
    inputCommand: undefined,
    workspaceDefaultCommand: custom,
    provider: 'grok',
    pathType: 'windows',
  });
  assert.equal(command, custom);
  assert.equal(providerOverride, null);
});

// ── runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ok  ${t.name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${t.name}`);
    console.error('       ', err instanceof Error ? err.stack || err.message : err);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
