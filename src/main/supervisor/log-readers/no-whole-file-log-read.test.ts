// WP-2 (B) reintroduction guard.
//
//   npm run build:main
//   node dist/main/main/supervisor/log-readers/no-whole-file-log-read.test.js
//
// After WP-2 no main-process code may read a whole PTY `.log` into memory with a
// synchronous `fs.readFileSync(<logPath var>, ...)`. Those whole-file reads were
// the acute heap path (≈3× file size of transient allocation on a 46.9 MB log).
// This test greps the real `src/main/**/*.ts` tree (excluding *.test.ts) and
// asserts ZERO `readFileSync(` calls whose first argument is a `logPath`-style
// variable. Bounded readers (tail-file.ts) are the only sanctioned path.
//
// NOTE: reading the bounded `.scrollback` sidecar (variable `scrollbackPath`) is
// intentionally still allowed — it is a ring-bounded file, not the uncapped log.

import * as fs from 'fs';
import * as path from 'path';
import assert from 'node:assert/strict';

declare const __dirname: string;

// Any first-argument identifier ending in a `logPath`-style name:
//   fs.readFileSync(agent.logPath, …)   this._logPath   logPath   logpath
const OFFENDER = /readFileSync\s*\(\s*[\w.]*log_?path/i;

function findSrcMain(): string {
  const candidates = [path.join(process.cwd(), 'src', 'main')];
  let d = __dirname;
  for (let i = 0; i < 12; i++) { candidates.push(path.join(d, 'src', 'main')); d = path.dirname(d); }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('no-whole-file-log-read: could not locate src/main');
}

function walkTs(dir: string, out: string[]): void {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { walkTs(full, out); continue; }
    if (!ent.name.endsWith('.ts')) continue;
    if (ent.name.endsWith('.test.ts')) continue;
    out.push(full);
  }
}

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void { tests.push({ name, run: fn }); }

test('no main-process readFileSync( on a logPath variable remains in src/main', () => {
  const srcMain = findSrcMain();
  const files: string[] = [];
  walkTs(srcMain, files);
  assert.ok(files.length > 0, 'walked at least one source file');

  const offenders: string[] = [];
  for (const file of files) {
    const linesArr = fs.readFileSync(file, 'utf8').split('\n');
    linesArr.forEach((line, i) => {
      // Strip line comments so prose describing the OLD pattern (e.g. this WP's
      // own header) isn't flagged; a real call before a trailing `//` still is.
      const code = line.split('//')[0];
      if (OFFENDER.test(code)) offenders.push(`${path.relative(srcMain, file)}:${i + 1}: ${line.trim()}`);
    });
  }

  assert.equal(
    offenders.length,
    0,
    `whole-file .log readFileSync reintroduced:\n${offenders.join('\n')}`,
  );
});

// Self-check: the OFFENDER regex actually matches the pattern it guards against,
// and does NOT match the sanctioned `.scrollback` read or bounded readers.
test('OFFENDER regex matches logPath reads but not scrollbackPath / jsonlPath', () => {
  assert.ok(OFFENDER.test('const c = fs.readFileSync(agent.logPath, "utf-8");'), 'matches agent.logPath');
  assert.ok(OFFENDER.test('return fs.readFileSync(logPath, "utf-8");'), 'matches logPath');
  assert.ok(OFFENDER.test('fs.readFileSync(this._logPath)'), 'matches this._logPath');
  assert.ok(!OFFENDER.test('return fs.readFileSync(scrollbackPath, "utf-8");'), 'ignores scrollbackPath');
  assert.ok(!OFFENDER.test('raw = fs.readFileSync(jsonlPath, "utf-8");'), 'ignores jsonlPath');
});

(async () => {
  let passed = 0; let failed = 0;
  for (const t of tests) {
    try { await t.run(); console.log(`  ok  ${t.name}`); passed++; }
    catch (err) { console.error(`  FAIL ${t.name}`); console.error('       ', err instanceof Error ? err.stack : err); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
