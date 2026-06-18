// WP2-A acceptance tests — M16 audit-line shape (pure formatter) + the
// append-only JSONL writer (plain node fs, NO Electron objects).
//
//   npm run build:main
//   node dist/main/main/browser/action-audit.test.js

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// ── Slice-3: identity/scope payload + onRecord tap + getRecent ──────────────

test('formatAuditLine: Slice-3 identity/scope fields ordered after ts, before partition', () => {
  const line = formatAuditLine({
    ...ENTRY,
    agentId: 'agent-7',
    agentTitle: 'Research bot',
    workspaceId: 'ws-A',
    tabId: 'tab-9',
  });
  const parsed = JSON.parse(line) as Record<string, unknown>;
  // The payload carries workspaceId + agentId (+ agentTitle/tabId) in the fixed
  // key order: ts, agentId?, agentTitle?, workspaceId?, tabId?, then the base set.
  assert.deepEqual(Object.keys(parsed), [
    'ts', 'agentId', 'agentTitle', 'workspaceId', 'tabId',
    'partition', 'url', 'verb', 'argsHash', 'outcome',
  ]);
  assert.equal(parsed.agentId, 'agent-7');
  assert.equal(parsed.agentTitle, 'Research bot');
  assert.equal(parsed.workspaceId, 'ws-A');
  assert.equal(parsed.tabId, 'tab-9');
});

test('formatAuditLine: Slice-3 fields omitted when absent (legacy line shape preserved)', () => {
  const parsed = JSON.parse(formatAuditLine(ENTRY)) as Record<string, unknown>;
  for (const k of ['agentId', 'agentTitle', 'workspaceId', 'tabId']) {
    assert.ok(!(k in parsed), `${k} must be omitted when undefined`);
  }
});

test('ActionAudit: onRecord tap receives the full entry with stamped ts + workspaceId/agentId', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-tap-'));
  const file = path.join(dir, 'browser-action-audit.jsonl');
  try {
    const seen: AuditEntry[] = [];
    const audit = new ActionAudit(() => file, (e) => seen.push(e));
    audit.record({
      partition: 'persist:agent',
      url: 'https://denied.example/',
      verb: 'openUrl',
      argsHash: hashArgs({ url: 'https://denied.example/' }),
      outcome: 'denied:agent-allowlist-denied',
      workspaceId: 'ws-A',
      agentId: 'agent-7',
      agentTitle: 'Research bot',
      tabId: 'tab-3',
    });
    assert.equal(seen.length, 1, 'tap fires once per record()');
    assert.equal(seen[0].workspaceId, 'ws-A');
    assert.equal(seen[0].agentId, 'agent-7');
    assert.equal(seen[0].agentTitle, 'Research bot');
    assert.equal(seen[0].tabId, 'tab-3');
    assert.equal(seen[0].outcome, 'denied:agent-allowlist-denied');
    assert.ok(!Number.isNaN(Date.parse(seen[0].ts)), 'tap entry carries the stamped ts');
    // Let the fire-and-forget appendFile land before the dir is removed.
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ActionAudit: a throwing onRecord listener never takes record() down (audit still writes)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-throw-'));
  const file = path.join(dir, 'browser-action-audit.jsonl');
  try {
    const audit = new ActionAudit(() => file, () => {
      throw new Error('listener boom');
    });
    assert.doesNotThrow(() =>
      audit.record({
        partition: 'persist:agent',
        url: 'https://a.example/',
        verb: 'click',
        argsHash: hashArgs({}),
        outcome: 'ok',
      }),
    );
    await new Promise((r) => setTimeout(r, 150));
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'the JSONL line is written despite the listener throwing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ActionAudit.getRecent: returns the last `limit` valid entries oldest→newest with identity intact', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-recent-'));
  const file = path.join(dir, 'browser-action-audit.jsonl');
  try {
    // Write deterministically in file order: getRecent tail-parses by line, and
    // fs.appendFile is async fire-and-forget (no ordering guarantee under rapid
    // calls), so the line order is fixed here rather than via record().
    const lines = [0, 1, 2, 3, 4].map((i) =>
      formatAuditLine({
        ts: `2026-06-11T12:00:0${i}.000Z`,
        partition: 'persist:agent',
        url: `https://x${i}.example/`,
        verb: 'openUrl',
        argsHash: hashArgs({ i }),
        outcome: 'ok',
        workspaceId: 'ws-A',
        agentId: `agent-${i}`,
      }),
    );
    writeFileSync(file, lines.join('\n') + '\n');
    const audit = new ActionAudit(() => file);
    const recent = audit.getRecent(3);
    assert.equal(recent.length, 3, 'limit honored — last 3');
    assert.deepEqual(
      recent.map((e) => e.url),
      ['https://x2.example/', 'https://x3.example/', 'https://x4.example/'],
      'oldest→newest within the tail',
    );
    // The Slice-3 identity/scope payload survives the tail-parse round-trip.
    assert.equal(recent[2].workspaceId, 'ws-A');
    assert.equal(recent[2].agentId, 'agent-4');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ActionAudit.getRecent: skips malformed/blank lines; missing file → []', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'audit-recent2-'));
  const file = path.join(dir, 'browser-action-audit.jsonl');
  try {
    const good1 = formatAuditLine({ ...ENTRY, url: 'https://ok1.example/' });
    const good2 = formatAuditLine({ ...ENTRY, url: 'https://ok2.example/' });
    writeFileSync(file, `${good1}\nnot-json{\n\n${good2}\n`);
    const recent = new ActionAudit(() => file).getRecent();
    assert.equal(recent.length, 2, 'malformed + blank lines skipped, never thrown');
    assert.deepEqual(recent.map((e) => e.url), ['https://ok1.example/', 'https://ok2.example/']);
    // A missing file is best-effort empty, not an error.
    assert.deepEqual(new ActionAudit(() => path.join(dir, 'absent.jsonl')).getRecent(), []);
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
