// Stale-rollout hardening tests (sibling bug in
// docs/BUG_claude-child-session-env-poisoning.md): codex session-id recovery
// must never bind a rollout whose session timestamp predates the agent's
// launch, and must never steal a rollout another agent record already owns.
//
// Compile + run:
//   npm run build:main
//   node dist/main/main/supervisor/codex-rollout-freshness.test.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  codexRolloutSessionTimestampMs,
  selectFreshCodexRollouts,
  findCodexSessionIdByCwd,
} from './session-id-discovery';
import type { CodexRolloutFile } from './log-readers/codex-rollout-reader';

interface TestCase {
  name: string;
  run(): void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

/** Build a UUIDv7 whose first 48 bits encode `ms` (the codex session-id shape). */
function uuid7At(ms: number, tail = '1234567890ab'): string {
  const hex = ms.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-${tail}`;
}

/** Filename stamp in LOCAL time, matching how codex names rollout files. */
function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function makeFile(sessionId: string, sessionMs: number, mtimeMs: number): CodexRolloutFile {
  const filename = `rollout-${localStamp(sessionMs)}-${sessionId}.jsonl`;
  return {
    path: `/sessions/${filename}`,
    filename,
    sessionId,
    home: 'windows',
    mtimeMs,
  };
}

// Anchor all times to a fixed "now" so the tests are deterministic.
const NOW = Date.parse('2026-06-12T08:28:00Z');
const LAUNCH = NOW - 60_000; // agent launched one minute ago

// ── codexRolloutSessionTimestampMs ───────────────────────────────────

test('uuid7 decode: first 48 bits are the session ms timestamp', () => {
  const ms = 1_770_000_000_000;
  const ts = codexRolloutSessionTimestampMs(`rollout-x-${uuid7At(ms)}.jsonl`, uuid7At(ms));
  assert.equal(ts, ms);
});

test('uuid7 decode wins over a contradictory filename timestamp', () => {
  const ms = NOW - 5_000;
  // Filename claims an ancient date; the uuid7 is authoritative.
  const ts = codexRolloutSessionTimestampMs(`rollout-2020-01-01T00-00-00-${uuid7At(ms)}.jsonl`, uuid7At(ms));
  assert.equal(ts, ms);
});

test('non-v7 uuid falls back to the filename timestamp (parsed as LOCAL time)', () => {
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // version nibble c, not 7
  const ts = codexRolloutSessionTimestampMs(`rollout-2026-06-12T08-28-11-${sid}.jsonl`, sid);
  assert.equal(ts, new Date(2026, 5, 12, 8, 28, 11).getTime());
});

test('neither uuid7 nor filename parseable → null', () => {
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.equal(codexRolloutSessionTimestampMs('rollout-garbage.jsonl', sid), null);
});

// ── selectFreshCodexRollouts ─────────────────────────────────────────

test('stale rollout (session predates launch) is rejected — the 2026-06-12 incident shape', () => {
  // One agent bound a June 4 rollout, another one from 8 hours before launch.
  const june4 = makeFile(uuid7At(NOW - 8 * 24 * 3_600_000), NOW - 8 * 24 * 3_600_000, NOW - 8 * 24 * 3_600_000);
  const eightHrs = makeFile(uuid7At(LAUNCH - 8 * 3_600_000, 'aaaaaaaaaaaa'), LAUNCH - 8 * 3_600_000, LAUNCH - 8 * 3_600_000);
  const out = selectFreshCodexRollouts([june4, eightHrs], { launchedAtMs: LAUNCH });
  assert.deepEqual(out, [], 'no pre-launch rollout may survive the filter');
});

test('fresh rollout (session at/after launch) is kept', () => {
  const fresh = makeFile(uuid7At(LAUNCH + 1_000), LAUNCH + 1_000, LAUNCH + 1_000);
  const out = selectFreshCodexRollouts([fresh], { launchedAtMs: LAUNCH });
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, fresh.sessionId);
});

test('slack: a rollout stamped just under 2 s before launch still passes (clock granularity)', () => {
  const nearMiss = makeFile(uuid7At(LAUNCH - 1_500), LAUNCH - 1_500, LAUNCH);
  const wellBefore = makeFile(uuid7At(LAUNCH - 10_000, 'bbbbbbbbbbbb'), LAUNCH - 10_000, LAUNCH);
  const out = selectFreshCodexRollouts([nearMiss, wellBefore], { launchedAtMs: LAUNCH });
  assert.deepEqual(out.map((f) => f.sessionId), [nearMiss.sessionId]);
});

test('a fresh rollout owned by a sibling agent is excluded', () => {
  const fresh = makeFile(uuid7At(LAUNCH + 1_000), LAUNCH + 1_000, LAUNCH + 1_000);
  const out = selectFreshCodexRollouts([fresh], {
    launchedAtMs: LAUNCH,
    excludeSessionIds: new Set([fresh.sessionId]),
  });
  assert.deepEqual(out, [], 'sibling-owned rollouts must never be candidates');
});

test('launchedAtMs null disables the freshness floor but ownership exclusion still applies', () => {
  const old = makeFile(uuid7At(NOW - 30 * 24 * 3_600_000), NOW - 30 * 24 * 3_600_000, NOW);
  const owned = makeFile(uuid7At(LAUNCH + 1_000, 'cccccccccccc'), LAUNCH + 1_000, NOW);
  const out = selectFreshCodexRollouts([old, owned], {
    launchedAtMs: null,
    excludeSessionIds: new Set([owned.sessionId]),
  });
  assert.deepEqual(out.map((f) => f.sessionId), [old.sessionId]);
});

test('a rollout with an unverifiable timestamp is rejected when a launch floor is set', () => {
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const unverifiable: CodexRolloutFile = {
    path: '/sessions/rollout-garbage.jsonl',
    filename: 'rollout-garbage.jsonl',
    sessionId: sid,
    home: 'windows',
    mtimeMs: NOW,
  };
  assert.deepEqual(selectFreshCodexRollouts([unverifiable], { launchedAtMs: LAUNCH }), []);
});

// ── composition with findCodexSessionIdByCwd (the production wiring) ─

function writeRollout(root: string, sessionId: string, sessionMs: number, cwd: string): CodexRolloutFile {
  const dir = path.join(root, '2026', '06', '12');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `rollout-${localStamp(sessionMs)}-${sessionId}.jsonl`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, JSON.stringify({
    timestamp: new Date(sessionMs).toISOString(),
    type: 'session_meta',
    payload: { id: sessionId, cwd, model_provider: 'openai', cli_version: '0.136.0' },
  }) + '\n');
  return {
    path: filePath,
    filename,
    sessionId,
    home: 'windows',
    mtimeMs: fs.statSync(filePath).mtimeMs,
  };
}

test('recovery composition: stale cwd-match with newest mtime loses to the fresh rollout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fresh-compose-'));
  try {
    const cwd = 'C:\\Users\\fixture';
    const stale = writeRollout(root, uuid7At(LAUNCH - 8 * 3_600_000), LAUNCH - 8 * 3_600_000, cwd);
    const fresh = writeRollout(root, uuid7At(LAUNCH + 2_000, 'dddddddddddd'), LAUNCH + 2_000, cwd);
    // Make the STALE file the newest by mtime — the pre-fix selection
    // ("newest cwd-match wins") would bind it.
    fs.utimesSync(stale.path, new Date(), new Date(fresh.mtimeMs + 60_000));
    stale.mtimeMs = fs.statSync(stale.path).mtimeMs;
    const result = findCodexSessionIdByCwd({
      home: 'windows',
      workingDirectory: cwd,
      listFiles: () => selectFreshCodexRollouts([stale, fresh], { launchedAtMs: LAUNCH }),
    });
    assert.ok(result, 'fresh rollout must be found');
    assert.equal(result.sessionId, fresh.sessionId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery composition: ONLY stale rollouts on disk → null (never bind stale)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fresh-none-'));
  try {
    const cwd = 'C:\\Users\\fixture';
    const stale = writeRollout(root, uuid7At(LAUNCH - 8 * 3_600_000), LAUNCH - 8 * 3_600_000, cwd);
    const result = findCodexSessionIdByCwd({
      home: 'windows',
      workingDirectory: cwd,
      listFiles: () => selectFreshCodexRollouts([stale], { launchedAtMs: LAUNCH }),
    });
    assert.equal(result, null, 'no fresh rollout → bind nothing (poll handles the wait)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recovery composition: the only fresh rollout belongs to a sibling → null', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fresh-sibling-'));
  try {
    const cwd = 'C:\\Users\\fixture';
    const siblings = writeRollout(root, uuid7At(LAUNCH + 1_000), LAUNCH + 1_000, cwd);
    const result = findCodexSessionIdByCwd({
      home: 'windows',
      workingDirectory: cwd,
      listFiles: () => selectFreshCodexRollouts([siblings], {
        launchedAtMs: LAUNCH,
        excludeSessionIds: new Set([siblings.sessionId]),
      }),
    });
    assert.equal(result, null, 'a sibling-owned rollout must not be stolen');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
