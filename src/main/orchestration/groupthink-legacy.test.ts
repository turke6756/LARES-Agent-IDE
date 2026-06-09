// Legacy groupthink command parser tests (plan §7).
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/orchestration/groupthink-legacy.test.js

import assert from 'node:assert/strict';
import { parseLegacyGroupthinkCommand } from './groupthink-legacy';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

test('--key=value form maps resume ids + mode + timeout', () => {
  const out = parseLegacyGroupthinkCommand(
    'node scripts/groupthink-v2.js --mode=serial --resume-lead-id=abc123 ' +
    '--resume-reviewer-id=def456 --turn-timeout-ms=120000',
  );
  assert.equal(out.mode, 'serial');
  assert.equal(out.resumeLeadId, 'abc123');
  assert.equal(out.resumeReviewerId, 'def456');
  assert.equal(out.turnTimeoutMs, 120000);
});

test('--key value (space) form is honored', () => {
  const out = parseLegacyGroupthinkCommand(
    'node scripts/groupthink-v2.js --mode parallel --resume-lead-id lead9',
  );
  assert.equal(out.mode, 'parallel');
  assert.equal(out.resumeLeadId, 'lead9');
});

test('quoted multi-word --topic stays a single value with quotes stripped', () => {
  const out = parseLegacyGroupthinkCommand(
    'node scripts/groupthink-v2.js --topic="Plan the migration carefully" --planPath="plans/x.md"',
  );
  assert.equal(out.topic, 'Plan the migration carefully');
  assert.equal(out.planPath, 'plans/x.md');
});

test('single-quoted values work too', () => {
  const out = parseLegacyGroupthinkCommand("node scripts/groupthink-v2.js --topic='hello world'");
  assert.equal(out.topic, 'hello world');
});

test('an invalid mode is dropped (not forwarded)', () => {
  const out = parseLegacyGroupthinkCommand('node scripts/groupthink-v2.js --mode=banana');
  assert.equal(out.mode, undefined);
});

test('non-positive / non-numeric turn timeout is dropped', () => {
  assert.equal(parseLegacyGroupthinkCommand('x --turn-timeout-ms=0').turnTimeoutMs, undefined);
  assert.equal(parseLegacyGroupthinkCommand('x --turn-timeout-ms=abc').turnTimeoutMs, undefined);
});

test('lead/reviewer provider overrides are captured', () => {
  const out = parseLegacyGroupthinkCommand('x --leadProvider=gemini --reviewerProvider=claude');
  assert.equal(out.leadProvider, 'gemini');
  assert.equal(out.reviewerProvider, 'claude');
});

test('workspaceId/supervisorId from the stale string are NOT forwarded', () => {
  const out = parseLegacyGroupthinkCommand(
    'x --workspaceId=stale-ws --supervisorId=stale-sup --mode=serial',
  ) as Record<string, unknown>;
  assert.equal(out.workspaceId, undefined);
  assert.equal(out.supervisorId, undefined);
});

// ── Runner ───────────────────────────────────────────────────────────
(() => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
