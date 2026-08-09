// Tests for `buildCodexResumeCommand` (src/main/supervisor/index.ts).
//
// Guards the codex-only WSL launch bug surfaced by the BUG-22 launches.log
// diagnostic: when the WSL launch path prepends bash command-prefix env-var
// assignments (`AGENT_ID=… DASHBOARD_PORT=… DASHBOARD_HOST=… ccodex …`) to
// the codex command, the resume-builder used to whole-string single-quote
// every token. That turned `AGENT_ID=…` into a literal command name and bash
// would refuse to run it — output_tail in launches.log showed lines like
// `AGENT_ID=…: command not found`. The fix keeps env-var tokens unquoted at
// the front and only single-quotes the codex executable + its args, while
// also ensuring `resume` is placed immediately after the codex executable
// (not floating between env vars).
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/codex-resume-command-builder.test.js

import assert from 'node:assert/strict';
import { buildCodexResumeCommand, normalizeCodexArgs } from './index';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

const SID = '019e6787-dcdb-7193-8a27-71083315fc8e';

test('normalizeCodexArgs maps --full-auto to bypass mode on native Windows', () => {
  assert.deepEqual(
    normalizeCodexArgs(['--full-auto'], 'win32'),
    ['--dangerously-bypass-approvals-and-sandbox'],
  );
});

test('normalizeCodexArgs preserves workspace-write mode off Windows', () => {
  assert.deepEqual(
    normalizeCodexArgs(['--full-auto'], 'linux'),
    ['--sandbox', 'workspace-write', '--ask-for-approval', 'never'],
  );
});

test('resume path maps --full-auto to bypass mode on native Windows', () => {
  const out = buildCodexResumeCommand('ccodex --full-auto', SID, 'win32');
  assert.equal(
    out,
    `'ccodex' 'resume' '--dangerously-bypass-approvals-and-sandbox' '${SID}'`,
  );
});

test('resume path preserves workspace-write mode off Windows', () => {
  const out = buildCodexResumeCommand('ccodex --full-auto', SID, 'linux');
  assert.equal(
    out,
    `'ccodex' 'resume' '--sandbox' 'workspace-write' '--ask-for-approval' 'never' '${SID}'`,
  );
});

// ── Bare command (no env prefix) ─────────────────────────────────────

test('bare ccodex command: builds resume <args> <sid> with single-quoted tokens', () => {
  const out = buildCodexResumeCommand('ccodex --dangerously-bypass-approvals-and-sandbox', SID);
  // Order: ccodex, resume, <args>, sid
  assert.equal(
    out,
    `'ccodex' 'resume' '--dangerously-bypass-approvals-and-sandbox' '${SID}'`,
    `unexpected rendered command: ${out}`,
  );
});

test('bare command default-codex fallback when empty', () => {
  const out = buildCodexResumeCommand('', SID);
  assert.equal(out, `'codex' 'resume' '${SID}'`);
});

test('bare command strips a stray standalone `resume` arg before re-inserting it', () => {
  // buildCodexResumeArgs filters out a positional `resume` from the
  // existing arg list so we never double it up. Smoke-test that path
  // still works after the env-prefix refactor.
  const out = buildCodexResumeCommand('ccodex resume --dangerously-bypass-approvals-and-sandbox', SID);
  // `resume` should appear exactly once.
  const resumeCount = (out.match(/(^|\s)'resume'(\s|$)/g) || []).length;
  assert.equal(resumeCount, 1, `expected exactly one 'resume' token; got: ${out}`);
});

// ── With env-var prefix (the bug) ────────────────────────────────────

test('env-prefixed command: env-var assignments must NOT be single-quoted', () => {
  const cmd = `AGENT_ID=835a1128 DASHBOARD_PORT=24678 DASHBOARD_HOST=172.22.208.1 ccodex --dangerously-bypass-approvals-and-sandbox`;
  const out = buildCodexResumeCommand(cmd, SID);
  // No single-quoted env assignments — bash would treat those as command names.
  assert.ok(
    !/'AGENT_ID=/.test(out),
    `AGENT_ID= must not be single-quoted; got: ${out}`,
  );
  assert.ok(
    !/'DASHBOARD_PORT=/.test(out),
    `DASHBOARD_PORT= must not be single-quoted; got: ${out}`,
  );
  assert.ok(
    !/'DASHBOARD_HOST=/.test(out),
    `DASHBOARD_HOST= must not be single-quoted; got: ${out}`,
  );
  // Env vars stay unquoted at the start, in original order.
  assert.ok(
    /^AGENT_ID=835a1128 DASHBOARD_PORT=24678 DASHBOARD_HOST=172\.22\.208\.1\b/.test(out),
    `env vars must lead the command unquoted and in order; got: ${out}`,
  );
});

test('env-prefixed command: `resume` is placed immediately after `ccodex`, not between env vars', () => {
  const cmd = `AGENT_ID=835a1128 DASHBOARD_PORT=24678 DASHBOARD_HOST=172.22.208.1 ccodex --dangerously-bypass-approvals-and-sandbox`;
  const out = buildCodexResumeCommand(cmd, SID);
  // Specifically guard against the bug shape from launches.log:
  //   'AGENT_ID=…' 'resume' 'DASHBOARD_PORT=…' …
  // i.e. `resume` floating between env-var tokens.
  assert.ok(
    !/'resume'\s+'DASHBOARD_/.test(out),
    `'resume' must NOT appear before DASHBOARD_* tokens; got: ${out}`,
  );
  // ccodex appears, immediately followed by 'resume'.
  const ccodexIdx = out.indexOf(`'ccodex'`);
  const resumeIdx = out.indexOf(`'resume'`);
  assert.ok(ccodexIdx > 0, `expected 'ccodex' token; got: ${out}`);
  assert.ok(resumeIdx > ccodexIdx, `'resume' must follow 'ccodex'; got: ${out}`);
  // And nothing should be between them except whitespace.
  const between = out.slice(ccodexIdx + `'ccodex'`.length, resumeIdx);
  assert.match(between, /^\s+$/, `'ccodex' must be immediately followed by 'resume'; got between=${JSON.stringify(between)}, full=${out}`);
});

test('env-prefixed command: full expected shape', () => {
  const cmd = `AGENT_ID=835a1128 DASHBOARD_PORT=24678 DASHBOARD_HOST=172.22.208.1 ccodex --dangerously-bypass-approvals-and-sandbox`;
  const out = buildCodexResumeCommand(cmd, SID);
  assert.equal(
    out,
    `AGENT_ID=835a1128 DASHBOARD_PORT=24678 DASHBOARD_HOST=172.22.208.1 'ccodex' 'resume' '--dangerously-bypass-approvals-and-sandbox' '${SID}'`,
    `unexpected rendered command: ${out}`,
  );
});

test('env-prefixed command with claude-style CLAUDE_CODE_* env var still untouched (sanity)', () => {
  // Not a real codex case (claude doesn't go through this builder), but the
  // env-prefix detector must accept arbitrary `WORD=value` shapes.
  const cmd = `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false AGENT_ID=x ccodex`;
  const out = buildCodexResumeCommand(cmd, SID);
  assert.ok(
    /^CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false AGENT_ID=x\s/.test(out),
    `both env-var tokens must remain unquoted at the front; got: ${out}`,
  );
  assert.ok(
    !/'CLAUDE_CODE_/.test(out) && !/'AGENT_ID=/.test(out),
    `neither env-var assignment may be wrapped in single quotes; got: ${out}`,
  );
});

// ── Defensive: env-detection regex must not eat real args ────────────

test('an arg that looks like `--flag=value` is NOT mistaken for an env assignment', () => {
  // The env-detection regex anchors on `[A-Za-z_][A-Za-z0-9_]*=`, so
  // `--ask-for-approval=on-failure` shouldn't match (starts with `-`).
  const out = buildCodexResumeCommand('ccodex --some-flag=value', SID);
  assert.match(out, /'--some-flag=value'/, `--flag=value must be single-quoted as a normal arg; got: ${out}`);
});

// ── §3c: single-quote / backslash-aware tokenizer ────────────────────
//
// `buildCodexResumeCommand` tokenizes via `tokenizeShell`, which is
// DELIBERATELY NOT a general bash parser. It handles exactly two constructs
// the generated WSL Codex command uses: leading env-prefix assignments and
// single-quoted values (including shellSingleQuote's `'\''` splice form).
// Double quotes, `$(...)`, variable expansion, and comments are out of scope
// by design. The cases below pin that scope so nobody "upgrades" the tokenizer
// into a general shell parser.

test('§3c: env value with a SPACE (single-quoted) survives intact, unquoted at front', () => {
  // A naive command.split(/\s+/) would shred this env value on its internal
  // space, producing a broken `…spaces/.dashboard…` second token.
  const envTok = `DASHBOARD_SPOOL_PATH='/path with spaces/.dashboard/pending-status.jsonl'`;
  const out = buildCodexResumeCommand(`${envTok} ccodex --dangerously-bypass-approvals-and-sandbox`, SID);
  assert.equal(
    out,
    `${envTok} 'ccodex' 'resume' '--dangerously-bypass-approvals-and-sandbox' '${SID}'`,
    `quoted env value with a space must stay one unquoted prefix token; got: ${out}`,
  );
});

test('§3c: env value with BOTH a space and an apostrophe (shellSingleQuote splice form) survives intact', () => {
  // shellSingleQuote('/home/it\'s dir/…') renders the splice form
  // `'/home/it'\''s dir/…'`. A naive single-quote toggle mis-reads the `\'`
  // after the closing quote as re-opening a quoted span, then splits on the
  // following space — shredding the value AND swallowing ccodex/args into the
  // wrong token. The backslash-aware consume fixes both.
  const spliceVal = `'/home/it'\\''s dir/.dashboard/pending-status.jsonl'`;
  const envTok = `DASHBOARD_SPOOL_PATH=${spliceVal}`;
  const out = buildCodexResumeCommand(`${envTok} ccodex --dangerously-bypass-approvals-and-sandbox`, SID);
  assert.equal(
    out,
    `${envTok} 'ccodex' 'resume' '--dangerously-bypass-approvals-and-sandbox' '${SID}'`,
    `splice-form env value must survive tokenizeShell intact; got: ${out}`,
  );
  // And `resume` must still land immediately after ccodex, not floating in the
  // (now space-containing) env prefix.
  assert.ok(!/'resume'\s+DASHBOARD_/.test(out), `'resume' must not precede the env prefix; got: ${out}`);
});

test('§3c (scope pin): double quotes are NOT special — tokenizer is not a general bash parser', () => {
  // A double-quoted span with a space is split (double quotes are out of
  // scope). Asserting this documents the intentional non-generality: callers
  // must never feed double-quoted constructs through this builder.
  const out = buildCodexResumeCommand('ccodex --foo="a b"', SID);
  assert.match(out, /'--foo="a'/, `--foo="a should split at the space (double quotes not honored); got: ${out}`);
  assert.match(out, /'b"'/, `the dangling b" must be its own single-quoted token; got: ${out}`);
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
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
