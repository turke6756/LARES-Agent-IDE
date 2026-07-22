// Context Window Warning — settings persistence, sanitization, and the
// role-key/cap resolution helpers.
//
//   npm run build:main
//   node dist/main/main/context-gauge/context-gauge-settings.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadContextGaugeSettings,
  saveContextGaugeSettings,
  sanitizeContextGaugeSettings,
  contextGaugeSettingsPath,
} from './context-gauge-settings';
import {
  capForRoleKey,
  clampGaugeCap,
  contextGaugeRoleKeyOf,
  resolveContextGaugeCap,
  setContextGaugeCapResolver,
} from './context-gauge-cap';
import {
  CONTEXT_GAUGE_CAP_TOKENS,
  CONTEXT_GAUGE_CAP_MIN_TOKENS,
  CONTEXT_GAUGE_CAP_MAX_TOKENS,
  DEFAULT_CONTEXT_GAUGE_SETTINGS,
} from '../../shared/constants';
import type { ContextGaugeSettings } from '../../shared/types';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-gauge-'));
}

// ── Persistence ───────────────────────────────────────────────────────────────

test('first run (no file) → defaults', () => {
  const dir = tmpDir();
  assert.deepEqual(loadContextGaugeSettings(dir), DEFAULT_CONTEXT_GAUGE_SETTINGS);
});

test('save → load round-trips, atomically (no .tmp left behind)', () => {
  const dir = tmpDir();
  const settings: ContextGaugeSettings = {
    contextWindowCaps: { worker: 400_000, supervisor: 200_000, researcher: 100_000, personas: { historian: 750_000 } },
  };
  const saved = saveContextGaugeSettings(settings, dir);
  assert.deepEqual(saved, settings);
  assert.deepEqual(loadContextGaugeSettings(dir), settings);
  assert.deepEqual(fs.readdirSync(dir), ['context-gauge-settings.json'], 'temp staging file renamed, never left');
});

test('malformed file falls back to defaults', () => {
  const dir = tmpDir();
  for (const junk of ['', 'not-json', '[]', '42', '{"contextWindowCaps": "nope"}']) {
    fs.writeFileSync(contextGaugeSettingsPath(dir), junk, 'utf8');
    assert.deepEqual(loadContextGaugeSettings(dir), DEFAULT_CONTEXT_GAUGE_SETTINGS, `junk: ${junk}`);
  }
});

test('partial file keeps the valid fields, defaults the rest', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    contextGaugeSettingsPath(dir),
    JSON.stringify({ contextWindowCaps: { supervisor: 500_000 } }),
    'utf8',
  );
  const loaded = loadContextGaugeSettings(dir);
  assert.equal(loaded.contextWindowCaps.supervisor, 500_000);
  assert.equal(loaded.contextWindowCaps.worker, CONTEXT_GAUGE_CAP_TOKENS);
  assert.deepEqual(loaded.contextWindowCaps.personas, {});
});

// ── Sanitization / clamping ───────────────────────────────────────────────────

test('sanitize clamps out-of-range and drops invalid persona entries', () => {
  const s = sanitizeContextGaugeSettings({
    contextWindowCaps: {
      worker: 1,                       // below MIN → clamped up
      supervisor: 99_999_999,          // above MAX → clamped down
      researcher: 'huge',              // wrong type → default
      personas: {
        'good-name': 300_000,
        'Bad Name!': 300_000,          // invalid persona name → dropped
        'nanCap': NaN,                 // non-finite → dropped
      },
    },
  });
  assert.equal(s.contextWindowCaps.worker, CONTEXT_GAUGE_CAP_MIN_TOKENS);
  assert.equal(s.contextWindowCaps.supervisor, CONTEXT_GAUGE_CAP_MAX_TOKENS);
  assert.equal(s.contextWindowCaps.researcher, CONTEXT_GAUGE_CAP_TOKENS);
  assert.deepEqual(s.contextWindowCaps.personas, { 'good-name': 300_000 });
});

test('clampGaugeCap: non-numeric → default; range enforced', () => {
  assert.equal(clampGaugeCap(undefined), CONTEXT_GAUGE_CAP_TOKENS);
  assert.equal(clampGaugeCap(Infinity), CONTEXT_GAUGE_CAP_TOKENS);
  assert.equal(clampGaugeCap(0), CONTEXT_GAUGE_CAP_MIN_TOKENS);
  assert.equal(clampGaugeCap(2_000_000), CONTEXT_GAUGE_CAP_MAX_TOKENS);
  assert.equal(clampGaugeCap(300_000), 300_000);
});

// ── Role-key resolution ───────────────────────────────────────────────────────

test('capForRoleKey resolves fixed roles, personas, and falls back on unknowns', () => {
  const settings: ContextGaugeSettings = {
    contextWindowCaps: { worker: 250_000, supervisor: 600_000, researcher: 150_000, personas: { historian: 900_000 } },
  };
  assert.equal(capForRoleKey(settings, 'worker'), 250_000);
  assert.equal(capForRoleKey(settings, 'supervisor'), 600_000);
  assert.equal(capForRoleKey(settings, 'researcher'), 150_000);
  assert.equal(capForRoleKey(settings, 'persona:historian'), 900_000);
  assert.equal(capForRoleKey(settings, 'persona:unknown'), CONTEXT_GAUGE_CAP_TOKENS, 'unlisted persona → default');
  assert.equal(capForRoleKey(settings, undefined), CONTEXT_GAUGE_CAP_TOKENS, 'no role → default');
});

test('contextGaugeRoleKeyOf classifies by flags then cwd layout', () => {
  assert.equal(contextGaugeRoleKeyOf({ isSupervisor: true, workingDirectory: 'C:\\ws\\.lares\\supervisor' }), 'supervisor');
  assert.equal(contextGaugeRoleKeyOf({ isResearcher: true, workingDirectory: '/home/me/ws/.lares/researcher' }), 'researcher');
  assert.equal(contextGaugeRoleKeyOf({ workingDirectory: 'C:\\ws\\.lares\\workers\\claude' }), 'worker');
  // Personas — live, legacy .dashboard, and pre-relocation .claude layouts, both separators.
  assert.equal(contextGaugeRoleKeyOf({ workingDirectory: 'C:\\ws\\.lares\\agents\\historian' }), 'persona:historian');
  assert.equal(contextGaugeRoleKeyOf({ workingDirectory: '/home/me/ws/.dashboard/agents/scribe/' }), 'persona:scribe');
  assert.equal(contextGaugeRoleKeyOf({ workingDirectory: '/home/me/ws/.claude/agents/oldster' }), 'persona:oldster');
  // Supervisor-privilege persona NOT launched from a persona dir → supervisor cap.
  assert.equal(contextGaugeRoleKeyOf({ privilegeLane: 'supervisor', workingDirectory: 'C:\\ws' }), 'supervisor');
  // A persona dir wins over privilegeLane (its own row configures it).
  assert.equal(
    contextGaugeRoleKeyOf({ privilegeLane: 'supervisor', workingDirectory: 'C:\\ws\\.lares\\agents\\boss' }),
    'persona:boss',
  );
  // Plain workspace cwd → worker.
  assert.equal(contextGaugeRoleKeyOf({ workingDirectory: 'C:\\ws' }), 'worker');
});

// ── Injectable resolver (reader seam) ────────────────────────────────────────

test('resolveContextGaugeCap: default 200K without a resolver; resolver output is clamped', () => {
  setContextGaugeCapResolver(null);
  assert.equal(resolveContextGaugeCap('worker'), CONTEXT_GAUGE_CAP_TOKENS);
  try {
    setContextGaugeCapResolver(() => 2_000_000);
    assert.equal(resolveContextGaugeCap('worker'), CONTEXT_GAUGE_CAP_MAX_TOKENS, 'resolver output clamped');
    setContextGaugeCapResolver((role) => (role === 'supervisor' ? 800_000 : 100_000));
    assert.equal(resolveContextGaugeCap('supervisor'), 800_000);
    assert.equal(resolveContextGaugeCap('worker'), 100_000);
  } finally {
    setContextGaugeCapResolver(null);
  }
});

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
