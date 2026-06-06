// Regression test for the WSL chat-attach bug (2026-06): base-dir resolution
// used to run once per reader constructor; when the WSL home discovery failed
// at app startup (cold WSL VM exceeding the 5 s `wsl.exe` timeout,
// `\\wsl.localhost` share not yet mounted), the reader cached `null` forever
// and chat/log attach was permanently disabled for every WSL-workspace agent
// until an app restart. Resolution is now lazy + self-healing (types.ts
// `resolveWslHomeSubdir`), and each reader retries while its base dir is
// unresolved.
//
//   npm run build:main
//   node dist/main/main/supervisor/log-readers/wsl-base-dir-lazy.test.js

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __setWslHomeDiscovererForTest,
  resolveWslHomeSubdir,
  type ChatLogReaderSession,
} from './types';
import { ClaudeJsonlReader } from './claude-jsonl-reader';
import { CodexRolloutReader } from './codex-rollout-reader';
import { GeminiTranscriptReader } from './gemini-transcript-reader';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

/** Build a throwaway "WSL home" on the local filesystem. The discoverer stub
 *  returns this path in place of a real `\\wsl.localhost\...` UNC home. */
function makeFakeWslHome(subdirs: string[]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-wsl-home-'));
  for (const sub of subdirs) {
    fs.mkdirSync(path.join(home, ...sub.split('/')), { recursive: true });
  }
  return home;
}

function makeSession(overrides: Partial<ChatLogReaderSession> = {}): ChatLogReaderSession {
  return {
    agentId: 'wsl-agent',
    sessionId: crypto.randomUUID(),
    workingDirectory: '/home/test/ws',
    provider: 'claude',
    subscribed: true,
    ...overrides,
  };
}

// ── 1. Claude pollSession self-heals after late WSL availability ──────

test('claude reader attaches to a WSL transcript after initial discovery failure', () => {
  const home = makeFakeWslHome(['.claude/projects']);
  try {
    const session = makeSession();
    // Claude Code slug for /home/test/ws (replaces [/\\:_.] with '-').
    const slugDir = path.join(home, '.claude', 'projects', '-home-test-ws');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(
      path.join(slugDir, `${session.sessionId}.jsonl`),
      JSON.stringify({
        type: 'user',
        uuid: 'u-1',
        timestamp: '2026-06-03T10:00:00.000Z',
        message: { role: 'user', content: 'hello from wsl' },
      }) + '\n',
    );

    // Cold WSL at "app startup": discovery fails.
    __setWslHomeDiscovererForTest(() => null);
    const reader = new ClaudeJsonlReader();
    assert.equal(reader.pollSession(session).length, 0, 'no events while WSL is unreachable');

    // WSL comes up later — SAME reader instance must attach.
    __setWslHomeDiscovererForTest(() => home);
    const events = reader.pollSession(session);
    const userText = events.find(e => e.type === 'user-text') as { text?: string } | undefined;
    assert.ok(userText, 'user-text event emitted after WSL became reachable');
    assert.equal(userText?.text, 'hello from wsl');
  } finally {
    __setWslHomeDiscovererForTest(null);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── 2. sessionFileExists self-heals (resume validation must not see a
//       false "missing" and mint a fresh session id for WSL agents) ────

test('claude sessionFileExists flips false→true once WSL becomes reachable', () => {
  const home = makeFakeWslHome(['.claude/projects']);
  try {
    const sessionId = crypto.randomUUID();
    const slugDir = path.join(home, '.claude', 'projects', '-home-test-ws');
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, `${sessionId}.jsonl`), '{}\n');

    __setWslHomeDiscovererForTest(() => null);
    const reader = new ClaudeJsonlReader();
    assert.equal(reader.sessionFileExists('/home/test/ws', sessionId), false);

    __setWslHomeDiscovererForTest(() => home);
    assert.equal(reader.sessionFileExists('/home/test/ws', sessionId), true);
  } finally {
    __setWslHomeDiscovererForTest(null);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── 3. Throttle: failed discovery must not spawn wsl.exe per poll ──────

test('failed WSL discovery is throttled to one attempt per retry window', () => {
  let calls = 0;
  __setWslHomeDiscovererForTest(() => { calls++; return null; });
  try {
    resolveWslHomeSubdir('.claude/projects');
    resolveWslHomeSubdir('.claude/projects'); // same subpath: subdir-throttled
    resolveWslHomeSubdir('.codex/sessions');  // other subpath: home-throttled
    assert.equal(calls, 1, 'exactly one wsl.exe discovery attempt within the window');
  } finally {
    __setWslHomeDiscovererForTest(null);
  }
});

// ── 4. Successful resolution is cached (no repeat discovery) ──────────

test('successful WSL discovery is cached for subsequent calls', () => {
  const home = makeFakeWslHome(['.claude/projects']);
  let calls = 0;
  __setWslHomeDiscovererForTest(() => { calls++; return home; });
  try {
    const a = resolveWslHomeSubdir('.claude/projects');
    const b = resolveWslHomeSubdir('.claude/projects');
    assert.equal(a, path.join(home, '.claude', 'projects').replace(/\//g, '\\'));
    assert.equal(b, a);
    assert.equal(calls, 1, 'home discovered once, then cached');
  } finally {
    __setWslHomeDiscovererForTest(null);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── 5. Codex candidateBaseDirs self-heals ──────────────────────────────

test('codex candidateBaseDirs picks up the WSL sessions dir after healing', () => {
  const home = makeFakeWslHome(['.codex/sessions']);
  try {
    const expected = path.join(home, '.codex', 'sessions').replace(/\//g, '\\');
    const session = makeSession({ provider: 'codex', workingDirectory: '/home/x' });

    __setWslHomeDiscovererForTest(() => null);
    const reader = new CodexRolloutReader();
    const before = (reader as any).candidateBaseDirs(session) as string[];
    assert.ok(!before.includes(expected), 'WSL dir absent while unreachable');

    __setWslHomeDiscovererForTest(() => home);
    const after = (reader as any).candidateBaseDirs(session) as string[];
    assert.ok(after.includes(expected), 'WSL dir present after healing');
    assert.equal(after[0], expected, 'WSL dir listed first for /-cwd sessions');
  } finally {
    __setWslHomeDiscovererForTest(null);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── 6. Gemini candidateBaseDirs self-heals ─────────────────────────────

test('gemini candidateBaseDirs picks up the WSL tmp dir after healing', () => {
  const home = makeFakeWslHome(['.gemini/tmp']);
  try {
    const expected = path.join(home, '.gemini', 'tmp').replace(/\//g, '\\');
    const session = makeSession({ provider: 'gemini', workingDirectory: '/home/x' });

    __setWslHomeDiscovererForTest(() => null);
    const reader = new GeminiTranscriptReader();
    const before = (reader as any).candidateBaseDirs(session) as string[];
    assert.ok(!before.includes(expected), 'WSL dir absent while unreachable');

    __setWslHomeDiscovererForTest(() => home);
    const after = (reader as any).candidateBaseDirs(session) as string[];
    assert.ok(after.includes(expected), 'WSL dir present after healing');
  } finally {
    __setWslHomeDiscovererForTest(null);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── 7. Tests can still pin base dirs by assigning the private field ────

test('explicitly assigned null base dir is pinned (no re-resolution)', () => {
  const home = makeFakeWslHome(['.codex/sessions']);
  try {
    __setWslHomeDiscovererForTest(() => home);
    const reader = new CodexRolloutReader();
    (reader as any).wslSessionsUncDir = null;   // legacy test idiom: pin absent
    (reader as any).windowsSessionsDir = null;
    const dirs = (reader as any).candidateBaseDirs(
      makeSession({ provider: 'codex', workingDirectory: '/home/x' }),
    ) as string[];
    assert.deepEqual(dirs, [], 'pinned-null dirs are not resurrected by the lazy resolver');
  } finally {
    __setWslHomeDiscovererForTest(null);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── Runner ───────────────────────────────────────────────────────────

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
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
})();
