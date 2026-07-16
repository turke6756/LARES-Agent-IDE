// Planning surface WP1 — launch-env injection parity test (§7 risk 1: the dual
// env-injection trap). AGENT_DASHBOARD_PLAN_ID / _PLAN_SECTION must be injected
// at BOTH launch sites in src/main/supervisor/index.ts:
//   1. the native `extraEnv` record (launchWindowsAgent), and
//   2. the WSL `wslEnvPrefix` array (launchWslAgent) — which re-declares every
//      var itself, so a var added only at the extraEnv site NEVER reaches WSL
//      agents.
//
// Both injection sites live deep inside large process-spawning private launch
// methods, so a behavioral unit test would have to spawn real agents. Instead
// this test asserts, structurally over the source, that BOTH plan vars are
// injected within BOTH enclosing methods — the exact regression the risk warns
// about (someone edits one site, forgets the other). If the launch methods are
// ever refactored to a shared env helper, replace this with a call-level unit
// test of that helper.
//
//   npm run build:main
//   node dist/main/main/supervisor-plan-env.test.js

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// Read the TS SOURCE (not the compiled dist) so the assertion pins the authored
// injection idiom at each site, independent of transpilation.
const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'src', 'main', 'supervisor', 'index.ts'),
  'utf8',
);

// `extraEnv` is the record local to launchWindowsAgent; `wslEnvPrefix` is the
// array local to launchWslAgent. Each identifier is declared exactly once, so its
// presence with a plan var unambiguously pins that specific injection site — no
// method-body slicing needed. This is the whole point of the parity test: catch a
// change that touches one site but not the other.

test('native site: extraEnv injects AGENT_DASHBOARD_PLAN_ID', () => {
  assert.match(SRC, /extraEnv\.AGENT_DASHBOARD_PLAN_ID\s*=\s*agent\.planId/);
});

test('native site: extraEnv injects AGENT_DASHBOARD_PLAN_SECTION', () => {
  assert.match(SRC, /extraEnv\.AGENT_DASHBOARD_PLAN_SECTION\s*=\s*agent\.planSection/);
});

test('WSL site: wslEnvPrefix.push injects AGENT_DASHBOARD_PLAN_ID', () => {
  assert.match(SRC, /wslEnvPrefix\.push\(`AGENT_DASHBOARD_PLAN_ID=\$\{[^}]*agent\.planId[^}]*\}`\)/);
});

test('WSL site: wslEnvPrefix.push injects AGENT_DASHBOARD_PLAN_SECTION', () => {
  assert.match(SRC, /wslEnvPrefix\.push\(`AGENT_DASHBOARD_PLAN_SECTION=\$\{[^}]*agent\.planSection[^}]*\}`\)/);
});

test('exactly one launchWindowsAgent and one launchWslAgent method (identifiers stay unique)', () => {
  assert.equal((SRC.match(/private async launchWindowsAgent\(/g) || []).length, 1);
  assert.equal((SRC.match(/private async launchWslAgent\(/g) || []).length, 1);
});

// ── Run ─────────────────────────────────────────────────────────────────────

let failed = 0;
for (const t of tests) {
  try {
    t.run();
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
console.log(`\nAll ${tests.length} supervisor-plan-env tests passed`);
