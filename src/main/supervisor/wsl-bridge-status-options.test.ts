// §1 (plans/wsl-parity-impl-strategy.md File 8): tmuxReadStatusOptions must
// route its status-poll script through the quote-free wslBashEnvelope so the
// inner `"$s"` / `"$p"` / `"$(tmux show-options …)"` double quotes never cross
// the Node→wsl.exe argv boundary (where they would be stripped, corrupting the
// poll). This test injects the exec stub, captures the rendered command, and
// asserts: (a) no quote of any class crosses the boundary; (b) the outer
// envelope shape; (c) decoding the outer base64 reproduces the original
// `for s in … done` script with shQuote'd names and the inner double quotes
// intact.
//
// Run via:
//   npm run build:main
//   node dist/main/main/supervisor/wsl-bridge-status-options.test.js

import assert from 'node:assert/strict';
import { tmuxReadStatusOptions, WslExecResult } from '../wsl-bridge';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void { tests.push({ name, run: fn }); }

async function captureCommand(sessionNames: string[]): Promise<string> {
  let captured = '';
  const exec = async (cmd: string, _timeout: number): Promise<WslExecResult> => {
    captured = cmd;
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  await tmuxReadStatusOptions(sessionNames, exec);
  return captured;
}

test('status-poll command carries NO quote of any class across the boundary', async () => {
  const cmd = await captureCommand(['cad__sup__abc', 'cad__worker__def']);
  assert.ok(!/["']/.test(cmd), `no single OR double quote may cross the boundary: ${cmd}`);
});

test('status-poll command is the quote-free base64 envelope', async () => {
  const cmd = await captureCommand(['cad__sup__abc']);
  assert.match(cmd, /^printf %s [A-Za-z0-9+/=]+ \| base64 -d \| bash$/);
});

test('decoding the envelope reproduces the original for-loop status script', async () => {
  const cmd = await captureCommand(['cad__sup__abc', 'cad__worker__def']);
  const m = cmd.match(/^printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| bash$/);
  assert.ok(m, `command must be the base64 envelope: ${cmd}`);
  const script = Buffer.from(m[1], 'base64').toString('utf8');

  // shQuote'd session names appear in the `for s in …` list.
  assert.match(script, /^for s in 'cad__sup__abc' 'cad__worker__def'; do /);
  // inner double-quoted expansions survive intact inside the decoded script.
  assert.match(script, /tmux display-message -p -t "\$s" '#\{pane_id\}' 2>\/dev\/null\) \|\| continue/);
  assert.match(script, /tmux show-options -pqv -t "\$p" @agentdashboard-status 2>\/dev\/null/);
  assert.match(script, /printf '%s\\t%s\\n' "\$s"/);
  assert.match(script, /done$/);
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
