// Codex-worker standing-instructions parity tests.
//
// The Codex worker's AGENTS.md (WORKER_CODEX_AGENTS_MD) is DERIVED from the
// Claude worker's CLAUDE.md (WORKER_CLAUDE_MD) via a documented `.split().join()`
// chain so the two provider bodies carry the SAME standing instructions and
// cannot drift when someone edits one of them. These tests are the anti-drift
// guard: they assert the derivation transformed exactly the provider-specific
// tokens and left everything else — crucially the "Never use git to discard
// uncommitted work" section — byte-identical.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/codex-worker-parity.test.js

import assert from 'node:assert/strict';
import {
  WORKER_CLAUDE_MD,
  WORKER_CODEX_AGENTS_MD,
  WORKER_BEHAVIORAL_MD,
  WORKER_CODEX_BEHAVIORAL_MD,
} from '../../shared/constants';

interface TestCase {
  name: string;
  run(): Promise<void> | void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, run: fn });
}

/** Return the text of a `## ` section (header line through the byte just before
 *  the next `## ` header, or end of body). Null if the header is absent. */
function section(body: string, header: string): string | null {
  const i = body.indexOf(header);
  if (i < 0) return null;
  const j = body.indexOf('\n## ', i + header.length);
  return body.slice(i, j < 0 ? body.length : j);
}

// ── Anti-drift: the load-bearing git-discard section is byte-identical ──────
//
// This is the assertion that stops future drift and the immediate reason this
// file exists: if a worker only learned the git-discard rule at block time, a
// Codex worker could still destroy a shared file. The rule must reach it via
// standing instructions, and must stay in lockstep with the Claude copy.

test('parity: the "Never use git to discard uncommitted work" section is present in BOTH and byte-identical', () => {
  const header = '## Never use git to discard uncommitted work';
  const claudeSection = section(WORKER_CLAUDE_MD, header);
  assert.ok(claudeSection, 'WORKER_CLAUDE_MD must contain the git-discard section');
  assert.ok(
    claudeSection!.length > 200,
    `git-discard section unexpectedly short (${claudeSection!.length} bytes) — extraction likely broke`,
  );

  const codexSection = section(WORKER_CODEX_AGENTS_MD, header);
  assert.ok(codexSection, 'WORKER_CODEX_AGENTS_MD must contain the git-discard section');

  // Byte-identical: the derivation transforms none of the tokens in this section,
  // so it must pass through verbatim. If a future edit to WORKER_CLAUDE_MD (or the
  // transform) diverges the two, this fails loudly.
  assert.equal(
    codexSection,
    claudeSection,
    'the git-discard section must be byte-identical in the Claude and Codex worker bodies',
  );

  // Spot-check the load-bearing sentences actually survived (guards against a
  // future transform that mangles this section while keeping the header).
  assert.ok(
    codexSection!.includes('git checkout -- <file>') &&
      codexSection!.includes('git restore') &&
      codexSection!.includes('git clean') &&
      codexSection!.includes('git stash'),
    'the git-discard section must still enumerate the four forbidden commands',
  );
});

// ── Section parity: no rule silently dropped ────────────────────────────────

test('parity: every `## ` section header from the Claude body is present in the Codex body', () => {
  const headers = WORKER_CLAUDE_MD.match(/^## .*$/gm) || [];
  assert.ok(headers.length >= 7, `expected the Claude body to have several sections; got ${headers.length}`);
  for (const h of headers) {
    assert.ok(
      WORKER_CODEX_AGENTS_MD.includes(h),
      `Codex body is missing the "${h}" section — a standing-instruction rule was dropped in derivation`,
    );
  }
});

// ── Provider-specific tokens WERE transformed ───────────────────────────────

test('derivation: cwd references point at the codex worker lane, not the claude lane', () => {
  assert.ok(
    WORKER_CODEX_AGENTS_MD.includes('.lares/workers/codex/'),
    'Codex body must reference its own `.lares/workers/codex/` cwd',
  );
  assert.ok(
    !WORKER_CODEX_AGENTS_MD.includes('.lares/workers/claude/'),
    'Codex body must NOT reference the claude worker cwd',
  );
});

test('derivation: Claude-Code-specific blocking-dialog names are gone but the INTENT is preserved', () => {
  // The Claude-specific tool/mode names must not survive into the Codex body.
  assert.ok(
    !WORKER_CODEX_AGENTS_MD.includes('AskUserQuestion'),
    'Codex body must not name the Claude-Code-specific AskUserQuestion tool',
  );
  assert.ok(
    !WORKER_CODEX_AGENTS_MD.includes('plan-mode approval prompts'),
    'Codex body must not name Claude-Code plan-mode approval prompts',
  );
  // But the intent — never invoke an interactive blocking dialog; end the turn
  // with the question in plain text — must remain.
  assert.ok(WORKER_CODEX_AGENTS_MD.includes('**Never invoke**'), 'intent: never invoke a blocking dialog');
  assert.ok(WORKER_CODEX_AGENTS_MD.includes('blocking dialog. They will hang forever.'), 'intent: hang-forever warning');
  assert.ok(
    WORKER_CODEX_AGENTS_MD.includes('end your turn with the question in plain text'),
    'intent: end the turn with the question in plain text',
  );
});

test('derivation: WP-G retired the promote-lessons pointer; neither constant name survives in AGENTS.md', () => {
  // memory-lessons v2 (WP-G) dropped the worker CLAUDE.md `behavioral.md`
  // durable-exception paragraph, which carried the "promote to the
  // `WORKER_CLAUDE_MD` constant" pointer. The derived AGENTS.md therefore carries
  // NEITHER constant name (transform #3 is now a harmless no-op), and instead
  // carries the new memory-lessons section.
  assert.ok(
    !WORKER_CODEX_AGENTS_MD.includes('`WORKER_CLAUDE_MD` constant'),
    'the retired promote-lessons pointer (Claude constant) must be gone from AGENTS.md',
  );
  assert.ok(
    !WORKER_CODEX_AGENTS_MD.includes('`WORKER_CODEX_AGENTS_MD` constant'),
    'the retired promote-lessons pointer (Codex constant) must be gone from AGENTS.md too',
  );
  assert.ok(
    WORKER_CODEX_AGENTS_MD.includes('## Memory & lessons') && WORKER_CODEX_AGENTS_MD.includes('recall_memory'),
    'AGENTS.md must carry the new memory-lessons section (recall_memory / remember)',
  );
});

// ── behavioral.md derivation ────────────────────────────────────────────────

test('derivation: WORKER_CODEX_BEHAVIORAL_MD mirrors WORKER_BEHAVIORAL_MD for the Codex lane', () => {
  assert.ok(WORKER_CODEX_BEHAVIORAL_MD.includes('Codex worker'), 'behavioral seed must address the Codex worker');
  assert.ok(
    !WORKER_CODEX_BEHAVIORAL_MD.includes('Claude worker'),
    'behavioral seed must not still address the Claude worker',
  );
  assert.ok(
    WORKER_CODEX_BEHAVIORAL_MD.includes('`WORKER_CODEX_AGENTS_MD` constant'),
    'behavioral promote pointer must name the Codex constant',
  );
  // Structural parity: same header + same rule scaffold as the Claude seed.
  assert.ok(WORKER_CODEX_BEHAVIORAL_MD.includes('# Worker Behavioral Memory'), 'same seed header');
  assert.ok(WORKER_CODEX_BEHAVIORAL_MD.includes('Behavioral, not project'), 'same behavioral-not-project rule');
  // Same length shape as the source apart from the token swaps (cheap drift guard).
  assert.ok(
    Math.abs(WORKER_CODEX_BEHAVIORAL_MD.length - WORKER_BEHAVIORAL_MD.length) < 40,
    'behavioral seeds should differ only by the small token swaps',
  );
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
