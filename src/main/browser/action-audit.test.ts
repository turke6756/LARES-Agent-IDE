// WP2-A acceptance tests — M16 audit-line shape (pure formatter) + the
// append-only JSONL writer (plain node fs, NO Electron objects).
//
//   npm run build:main
//   node dist/main/main/browser/action-audit.test.js

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ActionAudit,
  formatAuditLine,
  hashArgs,
  type AuditEntry,
} from './action-audit';

interface TestCase { name: string; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, run: fn });
}

const ENTRY: AuditEntry = {
  ts: '2026-06-11T12:00:00.000Z',
  partition: 'persist:agent',
  url: 'https://example.com/page',
  verb: 'click',
  argsHash: hashArgs({ tabId: 't1', ref: 4 }),
  outcome: 'ok',
};

// ── audit-line shape (the acceptance case) ──────────────────────────────────

test('formatAuditLine: single JSONL line with the exact spec field set', () => {
  const line = formatAuditLine(ENTRY);
  assert.ok(!line.includes('\n'), 'one line, no embedded newline');
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ['ts', 'partition', 'url', 'verb', 'argsHash', 'outcome']);
  assert.equal(parsed.ts, ENTRY.ts);
  assert.equal(parsed.partition, 'persist:agent');
  assert.equal(parsed.url, 'https://example.com/page');
  assert.equal(parsed.verb, 'click');
  assert.equal(parsed.argsHash, ENTRY.argsHash);
  assert.equal(parsed.outcome, 'ok');
});

test('formatAuditLine: agentId included when present, after ts', () => {
  const line = formatAuditLine({ ...ENTRY, agentId: 'agent-42' });
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(parsed),
    ['ts', 'agentId', 'partition', 'url', 'verb', 'argsHash', 'outcome'],
  );
  assert.equal(parsed.agentId, 'agent-42');
});

test('formatAuditLine: newlines in values stay escaped (line integrity)', () => {
  const line = formatAuditLine({ ...ENTRY, outcome: 'error:line1\nline2' });
  assert.ok(!line.includes('\n'));
  assert.equal((JSON.parse(line) as AuditEntry).outcome, 'error:line1\nline2');
});

test('formatAuditLine: denial outcomes carry the policy code', () => {
  const line = formatAuditLine({ ...ENTRY, outcome: 'denied:actions-disabled' });
  assert.equal((JSON.parse(line) as AuditEntry).outcome, 'denied:actions-disabled');
});

// ── hashArgs ────────────────────────────────────────────────────────────────

test('hashArgs: deterministic sha256 hex; distinct args differ; raw args never appear', () => {
  const a = hashArgs({ url: 'https://example.com', forHuman: true });
  const b = hashArgs({ url: 'https://example.com', forHuman: true });
  const c = hashArgs({ url: 'https://example.com', forHuman: false });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.ok(!a.includes('example.com'));
  // undefined args (verbs with none) still hash.
  assert.match(hashArgs(undefined), /^[0-9a-f]{64}$/);
});

// ── append-only writer ──────────────────────────────────────────────────────

test('ActionAudit: record() appends JSONL lines, never truncates', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-test-'));
  const file = path.join(dir, 'browser-action-audit.jsonl');
  try {
    const audit = new ActionAudit(() => file);
    audit.record({
      partition: 'persist:agent',
      url: 'https://a.example/',
      verb: 'openUrl',
      argsHash: hashArgs({ url: 'https://a.example/' }),
      outcome: 'ok',
    });
    audit.record({
      partition: 'persist:user',
      url: 'https://b.example/',
      verb: 'click',
      argsHash: hashArgs({ ref: 1 }),
      outcome: 'denied:user-partition-denied',
    });
    // fs.appendFile is async fire-and-forget — give it a beat.
    await new Promise((r) => setTimeout(r, 200));

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'two records → two lines (append, not overwrite)');
    const first = JSON.parse(lines[0]) as AuditEntry;
    const second = JSON.parse(lines[1]) as AuditEntry;
    assert.equal(first.verb, 'openUrl');
    assert.equal(first.outcome, 'ok');
    assert.ok(!Number.isNaN(Date.parse(first.ts)), 'ts is a real timestamp');
    assert.equal(second.outcome, 'denied:user-partition-denied');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Run (supports async cases) ──────────────────────────────────────────────

void (async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(err instanceof Error ? err.stack : String(err));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} action-audit tests passed`);
})();
