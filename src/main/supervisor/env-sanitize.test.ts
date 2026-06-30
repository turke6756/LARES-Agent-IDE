// Unit tests for the Claude child-session env sanitizer
// (docs/BUG_claude-child-session-env-poisoning.md).
//
// Compile + run:
//   npm run build:main
//   node dist/main/main/supervisor/env-sanitize.test.js

import assert from 'node:assert/strict';
import {
  CLAUDE_CHILD_SESSION_ENV_KEYS,
  sanitizeClaudeChildEnv,
  stripClaudeChildEnvInPlace,
} from './env-sanitize';

interface TestCase {
  name: string;
  run(): void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

/** The poisoned env observed live on 2026-06-12 plus innocent bystanders. */
function makePoisonedEnv(): Record<string, string | undefined> {
  return {
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SSE_PORT: '57281',
    CLAUDE_CODE_SESSION_ID: '0a82a07f-1111-2222-3333-444444444444',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    // Must SURVIVE sanitization:
    CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    PATH: 'C:\\Windows\\system32',
    USERPROFILE: 'C:\\Users\\fixture',
    AGENT_ID: 'agent-123',
    DASHBOARD_PORT: '4040',
    // PHASE 0 (agent-ownership): the dashboard API credential injected into the
    // agent process env must SURVIVE sanitization so the agent's Bash children
    // inherit it (env-sanitize is a denylist, not an allowlist).
    AGENT_DASHBOARD_API_TOKEN: 'tok-abc',
    AGENT_DASHBOARD_API_PORT: '4040',
    AGENT_DASHBOARD_API_HOST: '127.0.0.1',
    AGENT_DASHBOARD_SELF_ID: 'agent-123',
  };
}

const POISON_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
];

test('key list matches the documented poison set exactly', () => {
  assert.deepEqual([...CLAUDE_CHILD_SESSION_ENV_KEYS].sort(), [...POISON_KEYS].sort());
});

test('sanitizeClaudeChildEnv removes exactly the poison keys', () => {
  const out = sanitizeClaudeChildEnv(makePoisonedEnv());
  for (const key of POISON_KEYS) {
    assert.equal(key in out, false, `${key} must be removed`);
  }
});

test('sanitizeClaudeChildEnv preserves every innocent key, including CLAUDE_CODE_GIT_BASH_PATH', () => {
  const input = makePoisonedEnv();
  const out = sanitizeClaudeChildEnv(input);
  assert.equal(out.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(out.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1');
  assert.equal(out.PATH, 'C:\\Windows\\system32');
  assert.equal(out.USERPROFILE, 'C:\\Users\\fixture');
  assert.equal(out.AGENT_ID, 'agent-123');
  assert.equal(out.DASHBOARD_PORT, '4040');
  const expectedKeys = Object.keys(input).filter((k) => !POISON_KEYS.includes(k));
  assert.deepEqual(Object.keys(out).sort(), expectedKeys.sort(), 'no extra removals, no additions');
});

test('sanitizeClaudeChildEnv preserves the PHASE 0 AGENT_DASHBOARD_* credential keys', () => {
  const out = sanitizeClaudeChildEnv(makePoisonedEnv());
  assert.equal(out.AGENT_DASHBOARD_API_TOKEN, 'tok-abc', 'token must survive sanitization');
  assert.equal(out.AGENT_DASHBOARD_API_PORT, '4040');
  assert.equal(out.AGENT_DASHBOARD_API_HOST, '127.0.0.1');
  assert.equal(out.AGENT_DASHBOARD_SELF_ID, 'agent-123');
});

test('sanitizeClaudeChildEnv is pure — the input object is not mutated', () => {
  const input = makePoisonedEnv();
  sanitizeClaudeChildEnv(input);
  assert.equal(input.CLAUDECODE, '1', 'input must be untouched');
  assert.equal(input.CLAUDE_CODE_SSE_PORT, '57281');
});

test('sanitizeClaudeChildEnv on a clean env is a no-op copy', () => {
  const clean = { PATH: '/usr/bin', CLAUDE_CODE_GIT_BASH_PATH: '/bin/bash' };
  const out = sanitizeClaudeChildEnv(clean);
  assert.deepEqual(out, clean);
});

test('stripClaudeChildEnvInPlace deletes poison keys in place and reports them', () => {
  const env = makePoisonedEnv() as NodeJS.ProcessEnv;
  const removed = stripClaudeChildEnvInPlace(env);
  assert.deepEqual([...removed].sort(), [...POISON_KEYS].sort(), 'all present poison keys reported');
  for (const key of POISON_KEYS) {
    assert.equal(env[key], undefined, `${key} must be deleted in place`);
  }
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Program Files\\Git\\bin\\bash.exe');
});

test('stripClaudeChildEnvInPlace on a clean env returns an empty list', () => {
  const env = { PATH: '/usr/bin' } as NodeJS.ProcessEnv;
  const removed = stripClaudeChildEnvInPlace(env);
  assert.deepEqual(removed, []);
  assert.equal(env.PATH, '/usr/bin');
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ok  ${t.name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${t.name}`);
    console.error('       ', err instanceof Error ? err.message : err);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
