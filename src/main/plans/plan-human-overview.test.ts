// WP-D: strict human-overview parser and exact-byte filesystem observer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface TestCase { name: string; run(): Promise<void> | void; }
const tests: TestCase[] = [];
function test(name: string, run: TestCase['run']): void { tests.push({ name, run }); }

type Module = typeof import('./plan-human-overview');
let hov: Module;

function document(over: {
  newline?: '\n' | '\r\n'; frontmatter?: string; index?: string; sections?: string; suffix?: string;
} = {}): string {
  const nl = over.newline ?? '\n';
  const frontmatter = over.frontmatter ?? [
    '---', 'plan_artifact_id: plan_test', 'kind: human-overview', 'schema_version: 1', '---', '',
  ].join('\n');
  const index = over.index ?? `<!--PLAN-TAB-OVERVIEWS:v1
{
  "schema_version": 1,
  "plan_artifact_id": "plan_test",
  "sections": [
    { "tab": "overview", "heading": "What changes" },
    { "tab": "packages", "heading": "Work packages" }
  ]
}
-->`;
  const sections = over.sections ?? `<!--PLAN-TAB-SECTION:overview:BEGIN-->
## What changes

First line.

\`\`\`md
## fenced heading
<!--PLAN-TAB-SECTION:packages:END-->
\`\`\`

## ordinary nested heading
Still overview.
<!--PLAN-TAB-SECTION:overview:END-->

<!--PLAN-TAB-SECTION:packages:BEGIN-->
## Work packages

Package prose.
<!--PLAN-TAB-SECTION:packages:END-->`;
  return `${frontmatter}\n${index}\n\n${sections}${over.suffix ?? ''}`.replace(/\n/g, nl);
}

test('LF and CRLF parse identically; fenced headings and delimiters stay in the body', () => {
  const lf = hov.parsePlanHumanOverview(document(), 'plan_test');
  const crlf = hov.parsePlanHumanOverview(document({ newline: '\r\n' }), 'plan_test');
  assert.equal(lf.ok, true); assert.equal(crlf.ok, true);
  if (!lf.ok || !crlf.ok) return;
  assert.deepEqual([...lf.projection.bodies], [...crlf.projection.bodies]);
  assert.match(lf.projection.bodies.get('overview')!.body, /## fenced heading/);
  assert.match(lf.projection.bodies.get('overview')!.body, /## ordinary nested heading/);
});

test('an index-shaped comment inside a fence is ignored', () => {
  const suffix = `\n\n\`\`\`json\n<!--PLAN-TAB-OVERVIEWS:v1\n{"bad":true}\n-->\n\`\`\``;
  assert.equal(hov.parsePlanHumanOverview(document({ suffix }), 'plan_test').ok, true);
});

test('duplicate JSON keys and duplicate frontmatter keys reject', () => {
  const duplicateJson = document({ index: `<!--PLAN-TAB-OVERVIEWS:v1
{"schema_version":1,"schema_version":1,"plan_artifact_id":"plan_test","sections":[]}
-->` });
  assert.equal(hov.parsePlanHumanOverview(duplicateJson, 'plan_test').ok, false);
  const duplicateFrontmatter = document({ frontmatter: [
    '---', 'plan_artifact_id: plan_test', 'kind: human-overview', 'kind: human-overview',
    'schema_version: 1', '---', '',
  ].join('\n') });
  assert.equal(hov.parsePlanHumanOverview(duplicateFrontmatter, 'plan_test').ok, false);
});

test('arrow text in JSON strings, duplicate headings, and delimiter ambiguity reject', () => {
  const arrow = document({ index: `<!--PLAN-TAB-OVERVIEWS:v1
{"schema_version":1,"plan_artifact_id":"plan_test","sections":[{"tab":"overview","heading":"bad --> value"}]}
-->` });
  assert.equal(hov.parsePlanHumanOverview(arrow, 'plan_test').ok, false);
  const duplicateHeading = document({ index: `<!--PLAN-TAB-OVERVIEWS:v1
{"schema_version":1,"plan_artifact_id":"plan_test","sections":[
{"tab":"overview","heading":"Same"},{"tab":"packages","heading":"Same"}]}
-->` });
  assert.equal(hov.parsePlanHumanOverview(duplicateHeading, 'plan_test').ok, false);
  assert.equal(hov.parsePlanHumanOverview(document({ suffix: '\n<!--PLAN-TAB-SECTION:overview:END-->' }), 'plan_test').ok, false);
});

test('frontmatter identity, indexed heading, nonempty body, and the 1 MiB bound are enforced', () => {
  assert.equal(hov.parsePlanHumanOverview(document(), 'plan_other').ok, false);
  assert.equal(hov.parsePlanHumanOverview(document({ sections: `<!--PLAN-TAB-SECTION:overview:BEGIN-->
## Wrong
body
<!--PLAN-TAB-SECTION:overview:END-->
<!--PLAN-TAB-SECTION:packages:BEGIN-->
## Work packages
body
<!--PLAN-TAB-SECTION:packages:END-->` }), 'plan_test').ok, false);
  assert.equal(hov.parsePlanHumanOverview(`${document()}${'x'.repeat(hov.PLAN_HUMAN_OVERVIEW_MAX_BYTES)}`, 'plan_test').ok, false);
});

test('the plan dogfood OVERVIEW.md satisfies the frozen parser contract', () => {
  const source = path.join(process.cwd(), '.lares', 'plans',
    '2026-08-05-bridge-the-proposal-to-plan-skill-and-the-planni-e0001372', 'OVERVIEW.md');
  const parsed = hov.parsePlanHumanOverview(fs.readFileSync(source, 'utf8'), 'plan_e0001372');
  assert.equal(parsed.ok, true, parsed.ok ? undefined : JSON.stringify(parsed.diagnostics));
});

test('observer hashes exact bytes and hashes an oversized source without retaining it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-observer-'));
  try {
    const source = path.join(dir, 'OVERVIEW.md');
    const bytes = Buffer.from('a\r\nb\n', 'utf8');
    fs.writeFileSync(source, bytes);
    let observed = hov.observeOverviewSource(dir);
    assert.equal(observed.token, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    assert.deepEqual(observed.bytes, bytes);
    const oversized = Buffer.alloc(hov.PLAN_HUMAN_OVERVIEW_MAX_BYTES + 1, 0x61);
    fs.writeFileSync(source, oversized);
    observed = hov.observeOverviewSource(dir);
    assert.equal(observed.token, `sha256:${createHash('sha256').update(oversized).digest('hex')}`);
    assert.equal(observed.oversized, true);
    assert.equal(observed.bytes, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native Windows junction escape is unsafe; POSIX symlink case skips with reason', () => {
  if (process.platform !== 'win32') {
    console.log('  skip POSIX host: Windows junction test not applicable; POSIX symlink is covered conditionally by platform owners');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-junction-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-outside-'));
  try {
    fs.symlinkSync(outside, path.join(dir, 'OVERVIEW.md'), 'junction');
    const observed = hov.observeOverviewSource(dir);
    assert.equal(observed.token, 'unsafe');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('native Windows read-only observation runs for real (permission denial is environment-dependent)', () => {
  if (process.platform !== 'win32') {
    console.log('  skip POSIX host: Windows read-only test not applicable');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-readonly-'));
  const source = path.join(dir, 'OVERVIEW.md');
  try {
    fs.writeFileSync(source, document());
    fs.chmodSync(source, 0o444);
    const observed = hov.observeOverviewSource(dir);
    assert.ok(observed.token.startsWith('sha256:'), 'read-only regular files remain readable and hashable');
  } finally {
    try { fs.chmodSync(source, 0o666); } catch { /* cleanup */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(async () => {
  // The parser imports the DB module for its reconciler exports; no DB is opened in this pure suite.
  const resolved = require.resolve('better-sqlite3');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true,
    exports: class FakeDatabase {} } as unknown as NodeJS.Module;
  hov = require('./plan-human-overview') as Module;
  let passed = 0; let failed = 0;
  for (const item of tests) {
    try { await item.run(); console.log(`  ok  ${item.name}`); passed += 1; }
    catch (err) { console.error(`  FAIL ${item.name}\n`, err); failed += 1; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
