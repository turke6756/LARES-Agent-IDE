// Provider directory-trust seeding tests (BUG-25 family).
//
// Exercises the pure merge helpers behind ensureProviderDirTrust:
//   - codexTrustPathVariants: Windows exact-case / lowercase / \\?\ forms.
//   - mergeCodexProjectTrust: append-only [projects.'<path>'] blocks, never
//     rewriting existing content, idempotent.
//   - mergeClaudeProjectTrust: hasTrustDialogAccepted merge into ~/.claude.json
//     project entries, preserving unrelated fields, refusing unparseable input.
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/supervisor/provider-dir-trust.test.js

import assert from 'node:assert/strict';
import {
  codexTrustPathVariants,
  mergeCodexProjectTrust,
  mergeClaudeProjectTrust,
} from './index';

interface TestCase {
  name: string;
  run(): void;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

// ── codexTrustPathVariants ───────────────────────────────────────────────

test('windows dir yields exact-case, lowercase, and \\\\?\\ variants', () => {
  const variants = codexTrustPathVariants('C:\\Users\\Turke\\Projects\\UAP_Phenomina', 'windows');
  assert.deepEqual(variants, [
    'C:\\Users\\Turke\\Projects\\UAP_Phenomina',
    'c:\\users\\turke\\projects\\uap_phenomina',
    '\\\\?\\C:\\Users\\Turke\\Projects\\UAP_Phenomina',
  ]);
});

test('windows variants normalize forward slashes and trailing separators', () => {
  const variants = codexTrustPathVariants('C:/Users/turke/ws/', 'windows');
  assert.ok(variants.includes('C:\\Users\\turke\\ws'), `got: ${JSON.stringify(variants)}`);
  assert.ok(variants.every(v => !v.endsWith('\\') || v.startsWith('\\\\?\\')), 'no trailing separators');
});

test('already-lowercase windows dir dedupes to two variants', () => {
  const variants = codexTrustPathVariants('c:\\users\\turke\\ws', 'windows');
  assert.equal(variants.length, 2, `got: ${JSON.stringify(variants)}`);
});

test('wsl dir passes through as a single posix variant', () => {
  assert.deepEqual(codexTrustPathVariants('/home/turke/ws', 'wsl'), ['/home/turke/ws']);
});

// ── mergeCodexProjectTrust ───────────────────────────────────────────────

test('empty config gains one block per dir', () => {
  const merged = mergeCodexProjectTrust(null, ['C:\\ws', 'C:\\ws\\.dashboard\\workers\\codex']);
  assert.ok(merged !== null);
  assert.ok(merged.includes(`[projects.'C:\\ws']`));
  assert.ok(merged.includes(`[projects.'C:\\ws\\.dashboard\\workers\\codex']`));
  assert.equal((merged.match(/trust_level = "trusted"/g) || []).length, 2);
});

test('existing content is preserved byte-for-byte as a prefix', () => {
  const existing = 'model = "gpt-5.5"\n\n[projects.\'C:\\old\']\ntrust_level = "trusted"\n';
  const merged = mergeCodexProjectTrust(existing, ['C:\\new']);
  assert.ok(merged !== null);
  assert.ok(merged.startsWith(existing), 'merge must be append-only');
  assert.ok(merged.includes(`[projects.'C:\\new']`));
});

test('already-present keys are skipped (idempotent → null)', () => {
  const existing = `[projects.'C:\\ws']\ntrust_level = "trusted"\n`;
  assert.equal(mergeCodexProjectTrust(existing, ['C:\\ws']), null);
});

test('double-quoted existing keys are also recognized', () => {
  const existing = `[projects."C:/Users/turke/ws"]\ntrust_level = "trusted"\n`;
  assert.equal(mergeCodexProjectTrust(existing, ['C:/Users/turke/ws']), null);
});

test('escaped double-quoted (basic-string) windows keys are recognized (idempotent → null)', () => {
  // On-disk codex form for a Windows path in a TOML basic string:
  // [projects."C:\\Users\\turke\\ws"] — every backslash escaped. The dedup
  // must UNESCAPE before comparing, or this never matches the
  // single-backslash dir and the merge appends [projects.'C:\Users\turke\ws']
  // — the SAME key semantically → duplicate table → codex rejects the whole
  // config.
  const existing = `[projects."C:\\\\Users\\\\turke\\\\ws"]\ntrust_level = "trusted"\n`;
  assert.equal(mergeCodexProjectTrust(existing, ['C:\\Users\\turke\\ws']), null);
});

test('escaped quotes inside basic-string keys are unescaped too', () => {
  // \" inside a basic-string key must survive the capture and unescape to ".
  const existing = `[projects."C:\\\\ws\\\\say \\"hi\\""]\ntrust_level = "trusted"\n`;
  assert.equal(mergeCodexProjectTrust(existing, ['C:\\ws\\say "hi"']), null);
});

test('missing trailing newline gets a separator before the appended block', () => {
  const merged = mergeCodexProjectTrust('model = "gpt-5.5"', ['C:\\ws']);
  assert.ok(merged !== null);
  assert.ok(merged.startsWith('model = "gpt-5.5"\n\n[projects.'), `got: ${JSON.stringify(merged)}`);
});

test('dirs containing a single quote are refused (TOML literal-key limit)', () => {
  assert.equal(mergeCodexProjectTrust('', ["C:\\it's-a-trap"]), null);
});

// ── mergeClaudeProjectTrust ──────────────────────────────────────────────

test('missing file: creates projects map with trusted entries', () => {
  const merged = mergeClaudeProjectTrust(null, ['C:/ws', 'C:/ws/.dashboard/workers/claude']);
  assert.ok(merged !== null);
  const parsed = JSON.parse(merged);
  assert.equal(parsed.projects['C:/ws'].hasTrustDialogAccepted, true);
  assert.equal(parsed.projects['C:/ws/.dashboard/workers/claude'].hasTrustDialogAccepted, true);
});

test('existing entry fields are preserved; only trust flag is added', () => {
  const existing = JSON.stringify({
    numStartups: 42,
    projects: { 'C:/ws': { allowedTools: ['Bash'], hasTrustDialogAccepted: false } },
  });
  const merged = mergeClaudeProjectTrust(existing, ['C:/ws']);
  assert.ok(merged !== null);
  const parsed = JSON.parse(merged);
  assert.equal(parsed.numStartups, 42, 'top-level fields preserved');
  assert.deepEqual(parsed.projects['C:/ws'].allowedTools, ['Bash'], 'entry fields preserved');
  assert.equal(parsed.projects['C:/ws'].hasTrustDialogAccepted, true);
});

test('already-trusted entries need no write (idempotent → null)', () => {
  const existing = JSON.stringify({ projects: { 'C:/ws': { hasTrustDialogAccepted: true } } });
  assert.equal(mergeClaudeProjectTrust(existing, ['C:/ws']), null);
});

test('unparseable JSON is never clobbered (→ null)', () => {
  assert.equal(mergeClaudeProjectTrust('{ not json', ['C:/ws']), null);
});

test('non-object root is never clobbered (→ null)', () => {
  assert.equal(mergeClaudeProjectTrust('[1,2,3]', ['C:/ws']), null);
});

// ── Runner ───────────────────────────────────────────────────────────────

let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  ok  ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${t.name}`);
    console.error(err);
  }
}
console.log(`${tests.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
