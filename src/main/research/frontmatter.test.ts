// Research frontmatter validator tests — WP-G §G6
// (plans/groupthink/browser-parity-and-research-store.md).
//
// Compile via the main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/research/frontmatter.test.js

import assert from 'node:assert/strict';
import { validateResearchFrontmatter, REQUIRED_FRONTMATTER_KEYS } from './frontmatter';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

/** Build a valid untrusted artifact, optionally dropping or overriding keys. */
function artifact(over: Partial<Record<string, string>> = {}, opts: { trust?: string } = {}): string {
  const fields: Record<string, string> = {
    id: 'r-2026-06-14-abc123',
    topic: 'Some research topic',
    created: '2026-06-14T12:00:00Z',
    summary: 'A one-line summary of the findings.',
    ...over,
  };
  const trust = opts.trust ?? 'untrusted';
  const lines = [
    '---',
    `id: ${fields.id}`,
    `topic: ${fields.topic}`,
    `created: ${fields.created}`,
    'source_urls:',
    '  - https://example.com/a',
    '  - https://example.org/b',
    `trust: ${trust}`,
    `summary: ${fields.summary}`,
    '---',
    '',
    'Body text goes here.',
    '',
  ];
  return lines.join('\n');
}

// ── Happy paths ──────────────────────────────────────────────────────

test('valid untrusted artifact accepted', () => {
  const r = validateResearchFrontmatter(artifact(), { expectTrust: 'untrusted' });
  assert.equal(r.ok, true);
});

test('expectTrust:cleared accepts a cleared artifact (WP-F forward-compat)', () => {
  const r = validateResearchFrontmatter(artifact({}, { trust: 'cleared' }), { expectTrust: 'cleared' });
  assert.equal(r.ok, true);
});

test('CRLF line endings accepted', () => {
  const crlf = artifact().replace(/\n/g, '\r\n');
  const r = validateResearchFrontmatter(crlf, { expectTrust: 'untrusted' });
  assert.equal(r.ok, true);
});

// ── Missing-key rejections (one per required key, by name) ────────────

for (const key of REQUIRED_FRONTMATTER_KEYS) {
  test(`missing key "${key}" rejected with its name`, () => {
    // Drop the named key from the rendered frontmatter.
    let body = artifact();
    if (key === 'source_urls') {
      body = body
        .replace('source_urls:\n', '')
        .replace('  - https://example.com/a\n', '')
        .replace('  - https://example.org/b\n', '');
    } else {
      body = body.replace(new RegExp(`^${key}: .*\\n`, 'm'), '');
    }
    const r = validateResearchFrontmatter(body, { expectTrust: 'untrusted' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, new RegExp(`missing frontmatter key: ${key}`));
      assert.match(r.reason, /^Research artifact rejected:/);
    }
  });
}

// ── Field-shape rejections ───────────────────────────────────────────

test('non-http URL in source_urls rejected', () => {
  const body = artifact().replace('  - https://example.org/b', '  - ftp://example.org/b');
  const r = validateResearchFrontmatter(body, { expectTrust: 'untrusted' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /source_urls must be a non-empty list of http\(s\) URLs/);
});

test('empty source_urls list rejected', () => {
  const body = artifact()
    .replace('  - https://example.com/a\n', '')
    .replace('  - https://example.org/b\n', '');
  const r = validateResearchFrontmatter(body, { expectTrust: 'untrusted' });
  assert.equal(r.ok, false);
  // No list items remain → source_urls key present but empty.
  if (!r.ok) assert.match(r.reason, /source_urls must be a non-empty list of http\(s\) URLs/);
});

test('non-ISO created rejected', () => {
  const body = artifact({ created: 'last tuesday' });
  const r = validateResearchFrontmatter(body, { expectTrust: 'untrusted' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /ISO-8601/);
});

test('trust: cleared in inbox (expectTrust untrusted) rejected with WP-F pointer', () => {
  const body = artifact({}, { trust: 'cleared' });
  const r = validateResearchFrontmatter(body, { expectTrust: 'untrusted' });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /only the review gate \(WP-F\) may set trust: cleared/);
    assert.match(r.reason, /use trust: untrusted in inbox\//);
  }
});

test('non-frontmatter body rejected', () => {
  const r = validateResearchFrontmatter('# Just a heading\n\nNo frontmatter here.\n', { expectTrust: 'untrusted' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /missing leading --- frontmatter block/);
});

test('opening fence without a closing fence rejected', () => {
  const r = validateResearchFrontmatter('---\nid: x\ntopic: y\n\nbody but no close', { expectTrust: 'untrusted' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /missing leading --- frontmatter block/);
});

test('all reason strings are human-readable (prefixed, non-empty)', () => {
  const bad = validateResearchFrontmatter('nonsense', { expectTrust: 'untrusted' });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.reason.length > 20);
    assert.match(bad.reason, /^Research artifact rejected: /);
  }
});

// ── Runner ───────────────────────────────────────────────────────────
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
