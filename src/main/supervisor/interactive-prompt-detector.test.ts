// WP4 tests — the strict hook-unavailable PTY prompt classifier.
//
// One fixture per recognized kind, plus ANSI, wrapped-line, and the explicit
// FORBIDDEN (false-positive-prose) cases the classifier must reject.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/interactive-prompt-detector.test.js

import assert from 'node:assert/strict';
import {
  detectInteractivePrompt,
  InteractivePromptKind,
} from './interactive-prompt-detector';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

function expectKind(tail: string, kind: InteractivePromptKind): void {
  const m = detectInteractivePrompt(tail);
  assert.ok(m, `expected a ${kind} match; got null for:\n${tail}`);
  assert.equal(m!.kind, kind, `expected kind ${kind}; got ${m!.kind}`);
  assert.ok(m!.label.length > 0, 'a label must be present');
  assert.ok(m!.excerpt.length > 0, 'an excerpt must be present');
}

function expectNull(tail: string): void {
  const m = detectInteractivePrompt(tail);
  assert.equal(m, null, `expected NO match; got ${JSON.stringify(m)} for:\n${tail}`);
}

// ── One fixture per kind ──────────────────────────────────────────────

test('trust-dialog: workspace trust box', () => {
  const tail = [
    '╭──────────────────────────────────────────╮',
    '│  Do you trust the files in this folder?    │',
    '│  Claude Code may read and execute them.    │',
    '│  ❯ 1. Yes, proceed                          │',
    '│    2. No, exit                              │',
    '╰──────────────────────────────────────────╯',
  ].join('\n');
  expectKind(tail, 'trust-dialog');
  const m = detectInteractivePrompt(tail)!;
  assert.ok(/do you trust the files/i.test(m.excerpt), `excerpt names the dialog; got: ${m.excerpt}`);
  assert.ok(!/[│╭╮╰╯─]/.test(m.excerpt), `excerpt strips box chrome; got: ${m.excerpt}`);
});

test('hook-trust: codex hook trust-review prompt', () => {
  const tail = [
    'A hook wants to run for this session.',
    'Do you trust this hook and allow it to execute?',
    '  [y] trust   [n] skip',
  ].join('\n');
  expectKind(tail, 'hook-trust');
});

test('sign-in: select login method menu', () => {
  const tail = [
    'Select login method:',
    '  ❯ Log in with your Claude account',
    '    Use an API key',
  ].join('\n');
  expectKind(tail, 'sign-in');
});

test('sign-in: OAuth paste-code gate', () => {
  const tail = [
    'Visit https://example.com/device to authenticate',
    'Paste the code here: ',
  ].join('\n');
  expectKind(tail, 'sign-in');
});

test('sign-in: agy captured signed-out startup screen', () => {
  const tail = [
    'Welcome to the Antigravity CLI. You are currently not signed in.',
    '⣷ Signing in…',
  ].join('\n');
  expectKind(tail, 'sign-in');
  const match = detectInteractivePrompt(tail)!;
  assert.match(match.excerpt, /currently not signed in/i);
});

test('approval: do you want to proceed box', () => {
  const tail = [
    'Bash(rm -rf build/)',
    'Do you want to proceed?',
    '  ❯ 1. Yes',
    '    2. No, tell Claude what to do differently',
  ].join('\n');
  expectKind(tail, 'approval');
});

test('yes-no: explicit (y/n) affordance', () => {
  const tail = 'Overwrite the existing file? (y/n) ';
  expectKind(tail, 'yes-no');
});

test('yes-no: [Y/n] bracket form', () => {
  const tail = 'Continue with the migration [Y/n] ';
  expectKind(tail, 'yes-no');
});

test('choice: numbered menu WITH selection chrome', () => {
  const tail = [
    'Pick an environment:',
    '  ❯ 1. staging',
    '    2. production',
    '    3. local',
  ].join('\n');
  expectKind(tail, 'choice');
});

test('press-enter: press Enter to continue', () => {
  const tail = 'Setup complete.\nPress Enter to continue...';
  expectKind(tail, 'press-enter');
});

// ── ANSI handling ─────────────────────────────────────────────────────

test('ANSI: colored + cursor sequences are stripped before matching', () => {
  const esc = '\x1b';
  const tail =
    `${esc}[2J${esc}[H${esc}[1;33m Do you trust the files in this folder? ${esc}[0m\n` +
    `${esc}[36m ❯ 1. Yes ${esc}[0m`;
  expectKind(tail, 'trust-dialog');
  const m = detectInteractivePrompt(tail)!;
  assert.ok(!m.excerpt.includes(esc), 'excerpt must carry no escape bytes');
});

// ── Wrapped-line handling ─────────────────────────────────────────────

test('wrapped-line: a signature split across two terminal rows still matches', () => {
  // The trust phrase wrapped mid-sentence by a narrow terminal.
  const tail = 'Do you trust the files in this\nfolder? (this cannot be undone)';
  expectKind(tail, 'trust-dialog');
});

// ── FORBIDDEN — false-positive prose the classifier must REJECT ────────

test('forbidden: a bare trailing question mark is NOT a prompt', () => {
  expectNull('Have you considered refactoring this module?');
  expectNull('What should the timeout be?');
});

test('forbidden: a bare numbered list with NO selection chrome is NOT a choice', () => {
  const tail = [
    'Here are the steps I will take:',
    '  1. read the file',
    '  2. edit the handler',
    '  3. run the tests',
  ].join('\n');
  expectNull(tail);
});

test('forbidden: the substring "Sign in" inside prose is NOT a sign-in prompt', () => {
  expectNull('I will sign in to the dashboard and check the logs for you.');
  expectNull('Sign in was successful earlier, so the token should be cached.');
});

test('forbidden: prose mentioning trust/hook without the dialog wording does not match', () => {
  expectNull('I trust that the hook configuration is correct now.');
});

test('empty / whitespace tail → null', () => {
  expectNull('');
  expectNull('   \n  \n');
  assert.equal(detectInteractivePrompt(null), null);
  assert.equal(detectInteractivePrompt(undefined), null);
});

// ── Priority — a permission box carrying a (y/n) reads as approval ─────

test('priority: an approval box that also contains (y/n) classifies as approval', () => {
  const tail = 'Do you want to proceed? (y/n)';
  expectKind(tail, 'approval');
});

// ── Runner ─────────────────────────────────────────────────────────────
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
