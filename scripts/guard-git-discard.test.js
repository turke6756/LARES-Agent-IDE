// Unit + harness tests for the shared PreToolUse git-discard guard
// (GUARD_GIT_DISCARD_MJS, scaffolded to .lares/scripts/guard-git-discard.mjs and
// wired into BOTH worker scaffolds).
//
// The guard exports its pure predicate (analyzeGitDiscard / extractCandidateCommand),
// so the decision table is tested by importing the materialized script directly —
// NO process spawn, zero drift (the shipped bytes ARE the code under test). A
// small end-to-end section spawns the script to assert the PER-PROVIDER deny
// shape AND exit code: NON-Codex callers get hookSpecificOutput + a top-level
// {"decision":"deny"} (Grok) + stderr AND exit 2 (Claude 2.1.220 does not honor
// an exit-0 hookSpecificOutput deny for Bash — only exit 2 blocks); a CODEX
// caller (turn_id in the payload) gets hookSpecificOutput ONLY (no top-level key,
// no stderr) AND exit 0 (Codex fails OPEN on any nonzero exit or extra top-level
// key). Also covers the fail-OPEN paths and the isCodexPayload discriminator.
//
// Run via: node scripts/guard-git-discard.test.js  (after npm run build:main)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const { spawnSync } = require('child_process');

const { GUARD_GIT_DISCARD_MJS } = require('../dist/main/shared/constants.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Materialize the guard once, exactly as the scaffolder would.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-git-'));
const guardPath = path.join(tmpDir, 'guard-git-discard.mjs');
fs.writeFileSync(guardPath, GUARD_GIT_DISCARD_MJS, 'utf-8');

// ── Pure-predicate table (no spawn) ──────────────────────────────────────
//
// Every DENIED form (checkout pathspec/`.`/`--`, restore, clean, stash mutations,
// reset --hard/--merge/--keep), the wrapped/compound + -C/global-option variants,
// and an explicit allow-list of non-destructive git that must NOT be denied.

// [command, expectDeny]
const TABLE = [
  // ── checkout: unconditional discards (no ref resolution needed) → DENY ──
  // The single-bare-positional forms (branch-vs-pathspec, e.g. `git checkout
  // index.ts` vs `git checkout v0.82.0`) require ref resolution and are tested
  // separately below with an INJECTED resolver — they never hit the default
  // (real-git) resolver from this table.
  ['git checkout -- src/foo.ts', true],
  ['git checkout .', true],                      // whole-worktree pathspec
  ['git checkout HEAD -- .', true],              // explicit pathspec separator
  ['git checkout main src/foo.ts', true],        // <ref> <pathspec> — multiple positionals
  ['git checkout', true],                        // bare/ambiguous → deny
  // ── checkout: branch creation → ALLOW (never discards, never resolves) ──
  ['git checkout -b feature', false],
  ['git checkout -B feature origin/main', false],
  // ── restore: ALL forms → DENY ──
  ['git restore src/foo.ts', true],
  ['git restore .', true],
  ['git restore --staged foo', true],            // still denied (treat all restore as denied)
  ['git restore --source=HEAD~1 foo', true],
  // ── clean: any form → DENY ──
  ['git clean -fd', true],
  ['git clean -fdx', true],
  ['git clean', true],
  // ── stash: mutating forms → DENY; read-only subcommands → ALLOW ──
  ['git stash', true],                           // bare == push, discards worktree
  ['git stash push -m wip', true],
  ['git stash pop', true],
  ['git stash apply', true],
  ['git stash drop', true],
  ['git stash clear', true],
  ['git stash list', false],
  ['git stash show', false],
  // ── reset: worktree-overwriting variants → DENY; others → ALLOW ──
  ['git reset --hard', true],
  ['git reset --hard HEAD~1', true],
  ['git reset --merge', true],
  ['git reset --keep origin/main', true],
  ['git reset --soft HEAD~1', false],
  ['git reset HEAD src/foo.ts', false],          // unstage (mixed) → allow
  ['git reset', false],
  // ── wrapped / compound / substitution ──
  ['cd src && git clean -fd', true],
  ['git status; git checkout -- a', true],
  ['echo hi | git restore foo', true],
  ['true && git stash pop', true],
  ['git checkout $(cat branchfile)', true],      // substituted pathspec → ambiguous, deny
  // ── leading env assignments + global options ──
  ['FOO=bar git checkout -- a', true],
  ['FOO=1 BAR=2 git clean -fd', true],
  ['env GIT_PAGER=cat git restore foo', true],
  ['git -C /tmp/repo clean -fd', true],
  ['git --git-dir=/x/.git checkout -- a', true],
  ['git --git-dir /x/.git --work-tree /x reset --hard', true],
  ['git   checkout   --   a', true],             // extra whitespace
  // ── non-destructive git: MUST NOT be denied ──
  ['git status', false],
  ['git status --porcelain', false],
  ['git diff', false],
  ['git diff --staged', false],
  ['git log --oneline', false],
  ['git show HEAD', false],
  ['git add -A', false],
  ['git add src/foo.ts', false],
  ['git commit -m "wip"', false],
  ['git switch main', false],
  ['git switch -c feature', false],
  ['git fetch origin', false],
  ['git pull', false],
  ['git push origin main', false],
  ['git branch -a', false],
  ['git -C /tmp/repo status', false],
  // ── not git at all → ALLOW ──
  ['ls -la', false],
  ['rm -rf build', false],
  ['npm run build', false],
];

// mod is loaded in the async runner below.
let mod;

for (const [cmd, expectDeny] of TABLE) {
  test(`predicate: ${expectDeny ? 'DENY ' : 'allow'} ${cmd}`, () => {
    const v = mod.analyzeGitDiscard(cmd);
    assert.equal(v.deny, expectDeny, `analyzeGitDiscard(${JSON.stringify(cmd)}).deny should be ${expectDeny}`);
    if (expectDeny) {
      assert.match(v.reason, /discards uncommitted work/, 'a deny must carry the reason');
    } else {
      assert.equal(v.reason, null, 'an allow must carry no reason');
    }
  });
}

// ── checkout ref-resolution seam (injected resolver) ────────────────────
//
// A bare "git checkout <arg>" with no "--" is branch-vs-pathspec ambiguous; the
// guard resolves <arg> via an injected resolver: resolves to a commit →
// branch/tag switch (ALLOW); does not resolve → pathspec checkout of a file
// (DENY); resolver throws / times out / no git → fail OPEN (ALLOW).
// analyzeGitDiscard takes the resolver as its 2nd arg so these run without
// touching a real repo.
const RESOLVES = () => true;             // every arg is a real ref
const NO_RESOLVE = () => false;          // no arg resolves → pure pathspec
const THROWS = () => { throw new Error('git unavailable'); };

test('resolver: resolvable single arg → branch/tag switch → ALLOW', () => {
  for (const cmd of ['git checkout main', 'git checkout v0.82.0', 'git checkout feature/x']) {
    assert.equal(mod.analyzeGitDiscard(cmd, RESOLVES).deny, false, `${cmd} resolves → allow`);
  }
});
test('resolver: unresolvable single arg → pathspec file → DENY', () => {
  for (const cmd of ['git checkout index.ts', 'git checkout src/foo.ts', 'git checkout README']) {
    const v = mod.analyzeGitDiscard(cmd, NO_RESOLVE);
    assert.equal(v.deny, true, `${cmd} does not resolve → deny`);
    assert.match(v.reason, /discards uncommitted work/);
  }
});
test('resolver: throw / timeout / missing git → fail OPEN (allow)', () => {
  assert.equal(mod.analyzeGitDiscard('git checkout anything', THROWS).deny, false);
});
test('resolver: unconditional denies never consult the resolver', () => {
  // A resolver that resolves everything must NOT rescue a "--" / "." / multi-
  // positional form — those deny before any resolution.
  let called = false;
  const spy = () => { called = true; return true; };
  assert.equal(mod.analyzeGitDiscard('git checkout -- a', spy).deny, true);
  assert.equal(mod.analyzeGitDiscard('git checkout .', spy).deny, true);
  assert.equal(mod.analyzeGitDiscard('git checkout main src/foo.ts', spy).deny, true);
  assert.equal(called, false, 'resolver must not be consulted for unconditional denies');
});
test('resolver: -C <dir> is threaded so vendored clones resolve in-repo', () => {
  let seenArg = null, seenDir = null;
  const spy = (arg, cDir) => { seenArg = arg; seenDir = cDir; return true; };
  // The vendored-clone workflow: version-switch a read-only nested repo by tag.
  assert.equal(mod.analyzeGitDiscard('git -C vendor/pi checkout v0.82.0', spy).deny, false);
  assert.equal(seenArg, 'v0.82.0', 'the bare ref is passed to the resolver');
  assert.equal(seenDir, 'vendor/pi', 'the -C dir is threaded to the resolver');
});

// ── extractCandidateCommand: provider-shape tolerance ───────────────────
test('extract: Claude Bash tool_input.command string', () => {
  assert.equal(mod.extractCandidateCommand({ tool_name: 'Bash', tool_input: { command: 'git clean -fd' } }), 'git clean -fd');
});
test('extract: argv array under tool_input.cmd is joined', () => {
  assert.equal(mod.extractCandidateCommand({ tool_input: { cmd: ['git', 'stash', 'pop'] } }), 'git stash pop');
});
test('extract: top-level command field', () => {
  assert.equal(mod.extractCandidateCommand({ command: 'git restore foo' }), 'git restore foo');
});
test('extract: nothing command-shaped → null (fails open)', () => {
  assert.equal(mod.extractCandidateCommand({ tool_name: 'Read', tool_input: { file_path: '/x' } }), null);
  assert.equal(mod.extractCandidateCommand(null), null);
  assert.equal(mod.extractCandidateCommand('a string'), null);
});

// ── isCodexPayload: per-provider discriminator ──────────────────────────
test('isCodexPayload: true only for a Codex payload (turn_id present)', () => {
  assert.equal(mod.isCodexPayload({ turn_id: 't1', model: 'gpt-5.6-sol', tool_name: 'Bash' }), true);
  assert.equal(mod.isCodexPayload({ turn_id: '019fac02-4553-7712-ab8f-7ef27e7f4f8e' }), true);
});
test('isCodexPayload: false for a Claude payload (prompt_id/effort, no turn_id)', () => {
  assert.equal(mod.isCodexPayload({ prompt_id: 'p1', effort: { level: 'medium' }, tool_name: 'Bash' }), false);
  assert.equal(mod.isCodexPayload({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'git status' } }), false);
});
test('isCodexPayload: fail-safe (non-object / empty turn_id → NOT Codex)', () => {
  assert.equal(mod.isCodexPayload(null), false);
  assert.equal(mod.isCodexPayload('x'), false);
  assert.equal(mod.isCodexPayload({}), false);
  assert.equal(mod.isCodexPayload({ turn_id: '' }), false);
  assert.equal(mod.isCodexPayload({ turn_id: 123 }), false);
});

// ── End-to-end spawn: deny shape, exit codes, fail-OPEN ─────────────────
function runGuard(input) {
  const res = spawnSync(process.execPath, [guardPath], { input, encoding: 'utf-8' });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('spawn: NON-Codex discard is DENIED via both shapes + exit 2', () => {
  // A Claude-shaped payload (prompt_id present, NO turn_id) → belt-and-braces:
  // hookSpecificOutput PLUS the top-level {decision:"deny"} Grok reads, stderr,
  // AND exit 2. Exit 2 is load-bearing on the Claude lane: Claude 2.1.220 does
  // NOT honor an exit-0 hookSpecificOutput deny for Bash (verified — the command
  // still runs), so exit 0 here would leave the guard UNENFORCING.
  const res = runGuard(JSON.stringify({
    prompt_id: 'p1', effort: { level: 'medium' },
    tool_name: 'Bash', tool_input: { command: 'git clean -fd' },
  }));
  assert.equal(res.status, 2, `expected exit 2 for a non-Codex deny; got ${res.status}. stderr: ${res.stderr}`);
  assert.match(res.stderr, /discards uncommitted work/, 'non-Codex stderr must carry the reason');
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /git switch/);
  // Top-level decision shape present for non-Codex (Grok's documented deny key;
  // Claude tolerates it). Value is "deny" — Grok's documented shape.
  assert.equal(parsed.decision, 'deny');
  assert.match(parsed.reason, /unrecoverable/);
});

test('spawn: CODEX discard is DENIED via hookSpecificOutput ONLY + exit 0', () => {
  // A Codex-shaped payload (turn_id present) MUST receive the byte-exact verified
  // block shape: hookSpecificOutput on stdout, NO top-level decision key, NO
  // stderr, exit 0. Any extra top-level key or nonzero exit makes Codex 0.145.0
  // fail OPEN, so the per-provider exit(codex ? 0 : 2) MUST keep exit 0 here even
  // as the non-Codex lane moved to exit 2.
  const res = runGuard(JSON.stringify({
    turn_id: 't1', model: 'gpt-5.6-sol',
    tool_name: 'Bash', tool_input: { command: 'git reset --hard HEAD' },
  }));
  assert.equal(res.status, 0, `codex path must exit 0; got ${res.status}. stderr: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny', 'codex still gets the deny object');
  assert.equal('decision' in parsed, false, 'codex output must NOT carry a top-level decision key');
  assert.equal('reason' in parsed, false, 'codex output must NOT carry a top-level reason key');
  assert.equal(Object.keys(parsed).length, 1, `codex output must be hookSpecificOutput ONLY; got: ${res.stdout}`);
  assert.equal(res.stderr.trim(), '', `codex path must emit no stderr; got: ${res.stderr}`);
});

test('spawn: a non-destructive command is ALLOWED (exit 0, no output)', () => {
  const res = runGuard(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' } }));
  assert.equal(res.status, 0, `expected exit 0; got ${res.status}. stderr: ${res.stderr}`);
  assert.equal(res.stdout.trim(), '', `allow must emit no deny JSON; got: ${res.stdout}`);
});

test('spawn: Codex-style argv array is still caught (deny, exit 0)', () => {
  const res = runGuard(JSON.stringify({ turn_id: 't2', tool_name: 'shell', tool_input: { command: ['git', 'stash'] } }));
  assert.equal(res.status, 0, `codex argv discard must be denied at exit 0; got ${res.status}`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal('decision' in parsed, false, 'codex argv path must not carry a top-level decision key');
});

test('spawn: unparseable stdin fails OPEN (exit 0)', () => {
  assert.equal(runGuard('not json at all').status, 0, 'unparseable stdin must allow');
});
test('spawn: payload with no command fails OPEN (exit 0)', () => {
  assert.equal(runGuard(JSON.stringify({ hook_event_name: 'PreToolUse', weird: true })).status, 0, 'no command → allow');
});
test('spawn: empty stdin fails OPEN (exit 0)', () => {
  assert.equal(runGuard('').status, 0, 'empty stdin must allow');
});

// ── Runner ───────────────────────────────────────────────────────────────
(async () => {
  mod = await import(url.pathToFileURL(guardPath).href);
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { t.fn(); passed++; }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err && err.stack ? err.stack : err);
      failed++;
    }
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`\nguard-git-discard: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
