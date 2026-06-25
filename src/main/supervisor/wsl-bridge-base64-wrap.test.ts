// L-A: verify the base64 envelope rendering at wsl-bridge:tmuxNewSession.
//
// The wrap delivers a payload through two shell layers — the outer wsl-bash
// (`wsl.exe bash -lc <cmd>`) and the inner `bash -lic`. The base64 envelope
// makes the payload opaque to both layers; this test checks the rendered
// command shape and round-trips the encoded body for a payload containing
// every shell-special character class.
//
// Run via:
//   npm run build:main
//   node dist/main/main/supervisor/wsl-bridge-base64-wrap.test.js

import assert from 'node:assert/strict';
import { buildTmuxNewSessionCommand } from '../wsl-bridge';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

function extractInnerPayload(rendered: string): string {
  // Two-layer peel. New outer shape (quote-free wsl.exe boundary envelope):
  //   printf %s <OUTER_B64> | base64 -d | bash
  // decoding OUTER_B64 yields the tmux script, which itself ends with the inner
  //   -- bash -lic "$(echo <INNER_B64> | base64 -d)"
  // Allow zero-length inner base64 for the empty-payload case.
  const m = rendered.match(/^printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| bash$/);
  assert.ok(m, `outer command must be the piped base64 envelope: ${rendered}`);
  const tmuxScript = Buffer.from(m[1], 'base64').toString('utf8');
  const inner = tmuxScript.match(/"\$\(echo\s+([A-Za-z0-9+/=]*)\s*\|\s*base64\s+-d\)"\s*$/);
  assert.ok(inner, `decoded tmux script must end with the inner envelope: ${tmuxScript}`);
  return inner[1];
}

test('outer command crosses the wsl.exe boundary with NO quote of any class', () => {
  const out = buildTmuxNewSessionCommand('s', '/wd', `claude --mcp-config '{"a":1}'`);
  assert.ok(!/["']/.test(out), `no single OR double quote may cross the boundary: ${out}`);
  assert.match(out, /^printf %s [A-Za-z0-9+/=]+ \| base64 -d \| bash$/);
});

test('decoded tmux script has the expected new-session shape', () => {
  const out = buildTmuxNewSessionCommand('NAME', '/DIR', 'echo hi');
  const tmuxScript = Buffer.from(out.match(/^printf %s ([A-Za-z0-9+/=]+) /)![1], 'base64').toString('utf8');
  assert.match(tmuxScript, /^setsid tmux set-option -g history-limit \d+ \\; new-session -d -s 'NAME' -c '\/DIR' -- bash -lic /);
});

test('single-quote in workDir is shQuote-escaped, not broken', () => {
  const out = buildTmuxNewSessionCommand('s', "/wd/it's", 'echo hi');
  const tmuxScript = Buffer.from(out.match(/^printf %s ([A-Za-z0-9+/=]+) /)![1], 'base64').toString('utf8');
  assert.match(tmuxScript, /-c '\/wd\/it'\\''s'/);
});

test('L-A: payload with single quote round-trips intact', () => {
  const payload = "echo 'hello world'";
  const rendered = buildTmuxNewSessionCommand('s', '/wd', payload);
  const decoded = Buffer.from(extractInnerPayload(rendered), 'base64').toString('utf8');
  assert.equal(decoded, payload);
});

test('L-A: payload with double quote round-trips intact', () => {
  const payload = 'echo "hello"';
  const rendered = buildTmuxNewSessionCommand('s', '/wd', payload);
  assert.equal(Buffer.from(extractInnerPayload(rendered), 'base64').toString('utf8'), payload);
});

test('L-A: payload with $, backtick, backslash, newline, $(cat ...) round-trips intact', () => {
  const payload = [
    "cd /workspace",
    "SYSPROMPT=$(cat /path/with spaces/SYSTEM_PROMPT.md)",
    "echo \"$SYSPROMPT\" \\",
    "  | head -n 1",
    "exec ccode '--' '\"weird\"'",
    "VAR=`whoami`",
    "echo $$",
  ].join('\n');
  const rendered = buildTmuxNewSessionCommand('s', '/wd', payload);
  const decoded = Buffer.from(extractInnerPayload(rendered), 'base64').toString('utf8');
  assert.equal(decoded, payload, 'every byte must round-trip — no quoting class to break');
});

test('L-A: empty payload round-trips to empty string (no garbage in envelope)', () => {
  const rendered = buildTmuxNewSessionCommand('s', '/wd', '');
  const decoded = Buffer.from(extractInnerPayload(rendered), 'base64').toString('utf8');
  assert.equal(decoded, '');
});

test('L-A: base64 alphabet contains no shell-special chars (outer shell safety)', () => {
  // The whole point of the envelope: nothing between `echo` and `|` can be
  // interpreted by the outer shell. Verify the base64 substring has only
  // A-Z, a-z, 0-9, +, /, = — no spaces, no quotes, no $, no \.
  const tricky = "'\"$\\`\n\t$(echo hi)";
  const rendered = buildTmuxNewSessionCommand('s', '/wd', tricky);
  const b64 = extractInnerPayload(rendered);
  assert.match(b64, /^[A-Za-z0-9+/=]+$/, `base64 body must be shell-safe: ${b64}`);
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
