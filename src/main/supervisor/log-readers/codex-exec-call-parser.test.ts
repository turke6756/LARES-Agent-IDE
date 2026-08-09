// Self-contained tests for the Codex 0.144+ exec-payload parser.
//
//   npm run build:main
//   node dist/main/main/supervisor/log-readers/codex-exec-call-parser.test.js
//
// The parser NEVER evaluates the source; these tests pin the literal shapes it
// extracts and, critically, the shapes it deliberately leaves uncaptured.

import assert from 'node:assert/strict';
import { parseCodexExecCalls, classifyExecOutcome } from './codex-exec-call-parser';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

// ── shell_command extraction ──────────────────────────────────────────

test('single tools.shell_command object literal → one shell call', () => {
  const src = `const r = await tools.shell_command({command:"Get-Content -Raw 'C:\\\\ws\\\\a.ts'","workdir":"C:\\\\ws\\\\codex"});\ntext(r);\n`;
  const { calls, uncaptured } = parseCodexExecCalls(src);
  assert.equal(uncaptured, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'shell_command');
  assert.equal((calls[0] as any).command, "Get-Content -Raw 'C:\\ws\\a.ts'");
  assert.equal((calls[0] as any).workdir, 'C:\\ws\\codex');
});

test('pretty-printed object with spaces after colon', () => {
  const src = `const r = await tools.shell_command({\n  command: "rg --files",\n  workdir: "C:\\\\ws\\\\codex"\n});\ntext(r);\n`;
  const { calls } = parseCodexExecCalls(src);
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as any).command, 'rg --files');
  assert.equal((calls[0] as any).workdir, 'C:\\ws\\codex');
});

test('Promise.all with two nested shell_command calls → two calls in order', () => {
  const src = `const results = await Promise.all([\n  tools.shell_command({command:"cat a", workdir:"/w"}),\n  tools.shell_command({command:"cat b", workdir:"/w"})\n]);\nfor (const x of results) text(x);\n`;
  const { calls } = parseCodexExecCalls(src);
  assert.equal(calls.length, 2);
  assert.equal((calls[0] as any).command, 'cat a');
  assert.equal((calls[1] as any).command, 'cat b');
});

test('workdir absent → workdir null, command still captured', () => {
  const src = `const r = await tools.shell_command({command:"cat a"});\n`;
  const { calls } = parseCodexExecCalls(src);
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as any).workdir, null);
});

// ── apply_patch extraction ────────────────────────────────────────────

test('apply_patch via const string variable → patch resolved & newlines decoded', () => {
  const src = `const patch = "*** Begin Patch\\n*** Update File: src/b.ts\\n@@\\n-old\\n+new\\n*** End Patch";\ntext(await tools.apply_patch(patch));\n`;
  const { calls, uncaptured } = parseCodexExecCalls(src);
  assert.equal(uncaptured, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'apply_patch');
  const patch = (calls[0] as any).patch as string;
  assert.ok(patch.includes('*** Update File: src/b.ts'));
  assert.ok(patch.includes('\n'), 'escaped \\n decoded to a real newline');
});

test('apply_patch with a direct string literal argument', () => {
  const src = `tools.apply_patch("*** Begin Patch\\n*** Add File: x.ts\\n+hi\\n*** End Patch");\n`;
  const { calls } = parseCodexExecCalls(src);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'apply_patch');
});

test('mixed shell_command + apply_patch in one exec', () => {
  const src = `const patch = "*** Begin Patch\\n*** Update File: a\\n*** End Patch";\nawait tools.shell_command({command:"cat a", workdir:"/w"});\nawait tools.apply_patch(patch);\n`;
  const { calls } = parseCodexExecCalls(src);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, 'shell_command');
  assert.equal(calls[1].kind, 'apply_patch');
});

// ── dynamic / adversarial shapes: degrade to uncaptured, never guess ───

test('computed command (variable) → uncaptured, no call', () => {
  const src = `const c = getCmd();\nconst r = await tools.shell_command({command:c});\ntext(r);\n`;
  const { calls, uncaptured } = parseCodexExecCalls(src);
  assert.equal(calls.length, 0);
  assert.equal(uncaptured, 1);
});

test('apply_patch(unknownVar) with no matching literal binding → uncaptured', () => {
  const src = `tools.apply_patch(somethingElse);\n`;
  const { calls, uncaptured } = parseCodexExecCalls(src);
  assert.equal(calls.length, 0);
  assert.equal(uncaptured, 1);
});

test('template literal with interpolation → dynamic, uncaptured', () => {
  const src = 'const r = await tools.shell_command({command:`cat ${name}`, workdir:"/w"});\n';
  const { calls, uncaptured } = parseCodexExecCalls(src);
  assert.equal(calls.length, 0);
  assert.equal(uncaptured, 1);
});

test('literal call text INSIDE a patch/string body is not a real call', () => {
  // The patch body literally contains `tools.shell_command(...)` and
  // `tools.apply_patch(...)` as data — a string-blind scanner would double-count.
  const src = `const patch = "*** Begin Patch\\n*** Update File: doc.md\\n+call tools.shell_command({command:'rm -rf /'}) and tools.apply_patch(x)\\n*** End Patch";\nawait tools.apply_patch(patch);\n`;
  const { calls } = parseCodexExecCalls(src);
  assert.equal(calls.length, 1, 'only the real apply_patch call, none from inside the string');
  assert.equal(calls[0].kind, 'apply_patch');
});

test('call inside a // line comment is ignored', () => {
  const src = `// await tools.shell_command({command:"cat secret"})\nawait tools.shell_command({command:"cat real", workdir:"/w"});\n`;
  const { calls } = parseCodexExecCalls(src);
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as any).command, 'cat real');
});

test('malformed / truncated source does not throw', () => {
  const src = `const r = await tools.shell_command({command:"cat a", workdir:`;
  assert.doesNotThrow(() => parseCodexExecCalls(src));
});

test('non-string / empty input → empty result', () => {
  assert.deepEqual(parseCodexExecCalls(''), { calls: [], uncaptured: 0 });
  assert.deepEqual(parseCodexExecCalls(undefined as any), { calls: [], uncaptured: 0 });
});

test('a non-shell/patch tools call (update_plan) is not captured or counted', () => {
  const src = `const p = await tools.update_plan({plan:[{step:"x",status:"pending"}]});\ntext(p);\n`;
  const { calls, uncaptured } = parseCodexExecCalls(src);
  assert.equal(calls.length, 0);
  assert.equal(uncaptured, 0);
});

// ── classifyExecOutcome ───────────────────────────────────────────────

test('classifyExecOutcome: deferred cell', () => {
  const o = classifyExecOutcome('Script running with cell ID 14\nWall time 11.0 seconds\nOutput:\n');
  assert.deepEqual(o, { kind: 'deferred', cellId: '14' });
});

test('classifyExecOutcome: success on exit 0', () => {
  assert.deepEqual(classifyExecOutcome('Script completed\nOutput:\nExit code: 0\nOutput:\nx'), { kind: 'success' });
});

test('classifyExecOutcome: apply_patch success with no exit-code prefix', () => {
  assert.deepEqual(classifyExecOutcome('Script completed\nOutput:\nSuccess. Updated the following files:\nM a'), { kind: 'success' });
});

test('classifyExecOutcome: failure on Script failed prefix even without exit code', () => {
  assert.deepEqual(classifyExecOutcome('Script failed\nWall time 0.0 seconds\nOutput:\nScript error:\n'), { kind: 'failure' });
});

test('classifyExecOutcome: any nonzero nested exit → failure', () => {
  assert.deepEqual(classifyExecOutcome('Script completed\nExit code: 0\n...\nExit code: 2\n'), { kind: 'failure' });
});

test('classifyExecOutcome: empty content → success', () => {
  assert.deepEqual(classifyExecOutcome(''), { kind: 'success' });
});

(async () => {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.message : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
