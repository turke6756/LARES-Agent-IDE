// WP-G §G6 — hook harness for the research-store PreToolUse(Write) guard.
//
// Materializes the scaffolded RESEARCH_WRITE_GUARD_MJS to a temp file and drives
// it with fake Claude PreToolUse stdin payloads, asserting the block/allow
// outcome AND the block shape.
//
// Block shape (per §5 Q7) is PENDING empirical verification against the installed
// Claude Code build. The guard emits BOTH mechanisms, so this harness asserts
// BOTH: a permissionDecision:"deny" JSON on stdout AND exit code 2 with the
// reason on stderr. Whichever the real build honors, the guard blocks.
//
// Run via: node scripts/research-write-guard.test.js  (after npm run build:main)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { RESEARCH_WRITE_GUARD_MJS } = require('../dist/main/shared/constants.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Materialize the guard once.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-guard-'));
const guardPath = path.join(tmpDir, 'research-write-guard.mjs');
fs.writeFileSync(guardPath, RESEARCH_WRITE_GUARD_MJS, 'utf-8');

function runGuard(payload) {
  const res = spawnSync(process.execPath, [guardPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function writePayload(filePath, content) {
  return { tool_name: 'Write', tool_input: { file_path: filePath, content } };
}

const WS = '/tmp/ws';
const INBOX = `${WS}/.dashboard/research/inbox`;
const VALID_PATH = `${INBOX}/my-topic/2026-06-14T120000-findings.md`;

function artifact(over) {
  over = over || {};
  const trust = over.trust || 'untrusted';
  const lines = [
    '---',
    `id: ${over.id || 'r-2026-06-14-abc123'}`,
    `topic: ${over.topic || 'Some research topic'}`,
    `created: ${over.created || '2026-06-14T12:00:00Z'}`,
  ];
  if (over.sourceUrls !== null) {
    lines.push('source_urls:');
    for (const u of over.sourceUrls || ['https://example.com/a', 'https://example.org/b']) {
      lines.push(`  - ${u}`);
    }
  }
  lines.push(`trust: ${trust}`, 'summary: A one-line summary.', '---', '', 'Body.', '');
  return lines.join('\n');
}

/** A block must surface the reason via BOTH channels the guard emits. */
function assertBlocked(res, reasonRe) {
  assert.equal(res.status, 2, `expected exit 2 (block); got ${res.status}. stderr: ${res.stderr}`);
  assert.match(res.stderr, reasonRe, `stderr must carry the reason; got: ${res.stderr}`);
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch {
    assert.fail(`stdout must be deny JSON; got: ${res.stdout}`);
  }
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, reasonRe);
}

function assertAllowed(res) {
  assert.equal(res.status, 0, `expected exit 0 (allow); got ${res.status}. stderr: ${res.stderr}`);
  assert.equal(res.stdout.trim(), '', `allow must emit no deny JSON; got: ${res.stdout}`);
}

// ── Allow paths ──────────────────────────────────────────────────────

test('valid artifact in inbox/ is allowed', () => {
  assertAllowed(runGuard(writePayload(VALID_PATH, artifact())));
});

test('write outside the research store is blocked (default-deny containment)', () => {
  assertBlocked(
    runGuard(writePayload(`${WS}/src/foo.ts`, 'export const x = 1;\n')),
    /confined to \.dashboard\/research\/inbox\/ \(path is outside the research store\)/,
  );
});

test('non-Write tool is allowed', () => {
  const res = runGuard({ tool_name: 'Edit', tool_input: { file_path: VALID_PATH } });
  assertAllowed(res);
});

test('unparseable stdin does not block unrelated calls', () => {
  const res = spawnSync(process.execPath, [guardPath], { input: 'not json', encoding: 'utf-8' });
  assert.equal(res.status, 0, `unparseable stdin must allow; got ${res.status}`);
});

// ── Block paths ──────────────────────────────────────────────────────

test('missing frontmatter is blocked', () => {
  assertBlocked(
    runGuard(writePayload(VALID_PATH, '# No frontmatter here\n')),
    /missing leading --- frontmatter block/,
  );
});

test('missing source_urls is blocked', () => {
  assertBlocked(
    runGuard(writePayload(VALID_PATH, artifact({ sourceUrls: null }))),
    /missing frontmatter key: source_urls/,
  );
});

test('non-http source_urls is blocked', () => {
  assertBlocked(
    runGuard(writePayload(VALID_PATH, artifact({ sourceUrls: ['ftp://example.com/x'] }))),
    /source_urls must be a non-empty list of http\(s\) URLs/,
  );
});

test('trust: cleared in inbox is blocked with the WP-F pointer', () => {
  assertBlocked(
    runGuard(writePayload(VALID_PATH, artifact({ trust: 'cleared' }))),
    /only the review gate \(WP-F\) may set trust: cleared/,
  );
});

test('write under research/ but outside inbox/ is blocked', () => {
  const clearedPath = `${WS}/.dashboard/research/cleared/my-topic/2026-06-14T120000-findings.md`;
  assertBlocked(
    runGuard(writePayload(clearedPath, artifact())),
    /researcher may only write under \.dashboard\/research\/inbox\//,
  );
});

test('write directly under research/ root is blocked (outside inbox)', () => {
  assertBlocked(
    runGuard(writePayload(`${WS}/.dashboard/research/notes.md`, artifact())),
    /researcher may only write under \.dashboard\/research\/inbox\//,
  );
});

test('malformed filename (no timestamp prefix) is blocked', () => {
  assertBlocked(
    runGuard(writePayload(`${INBOX}/my-topic/findings.md`, artifact())),
    /filename must be <timestamp>-<slug>\.md/,
  );
});

test('Windows-style backslash path is normalized and validated', () => {
  const winPath = 'C:\\ws\\.dashboard\\research\\inbox\\my-topic\\2026-06-14T120000-findings.md';
  assertAllowed(runGuard(writePayload(winPath, artifact())));
});

// ── Runner ───────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const t of tests) {
  try { t.fn(); console.log(`  ok  ${t.name}`); passed++; }
  catch (err) {
    console.error(`  FAIL ${t.name}`);
    console.error('       ', err && err.stack ? err.stack : err);
    failed++;
  }
}
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
