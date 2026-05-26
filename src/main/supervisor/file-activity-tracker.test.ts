// Self-contained smoke test for FileActivityTracker path filtering.
//
//   npm run build:main
//   node dist/main/main/supervisor/file-activity-tracker.test.js

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { FileActivityTracker, isPlausibleFileActivityPath } from './file-activity-tracker';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

function resolveVia(tracker: FileActivityTracker, rawPath: string): string | null {
  return (tracker as unknown as { resolvePath(p: string): string | null }).resolvePath(rawPath);
}

function withStubbedHome<T>(home: string, fn: () => T): T {
  const original = os.homedir;
  (os as { homedir: () => string }).homedir = () => home;
  try {
    return fn();
  } finally {
    (os as { homedir: () => string }).homedir = original;
  }
}

test('allows path-shaped relative and absolute files', () => {
  assert.equal(isPlausibleFileActivityPath('package.json'), true);
  assert.equal(isPlausibleFileActivityPath('src/main/index.ts'), true);
  assert.equal(isPlausibleFileActivityPath('C:\\repo\\src\\main.ts'), true);
  assert.equal(isPlausibleFileActivityPath('/home/me/repo/README.md'), true);
});

test('rejects Claude aggregate context summaries', () => {
  assert.equal(isPlausibleFileActivityPath('3 files, listed 1 directory'), false);
  assert.equal(isPlausibleFileActivityPath('1 file, recalled 2 memories'), false);
  assert.equal(isPlausibleFileActivityPath('2 files, recalled 4 memories'), false);
});

test('rejects non-path prose', () => {
  assert.equal(isPlausibleFileActivityPath('the current task'), false);
  assert.equal(isPlausibleFileActivityPath('listed 1 directory'), false);
});

test('resolvePath expands ~/foo to home-rooted path', () => {
  const tracker = new FileActivityTracker('agent-1', 'C:\\repo\\cwd');
  withStubbedHome('C:\\Users\\test', () => {
    const resolved = resolveVia(tracker, '~/foo/bar');
    assert.equal(resolved, path.join('C:\\Users\\test', 'foo/bar'));
  });
});

test('resolvePath expands ~\\foo (backslash form) to home-rooted path', () => {
  const tracker = new FileActivityTracker('agent-1', 'C:\\repo\\cwd');
  withStubbedHome('C:\\Users\\test', () => {
    const resolved = resolveVia(tracker, '~\\foo');
    assert.equal(resolved, path.join('C:\\Users\\test', 'foo'));
  });
});

test('resolvePath returns null for bare ~ (filtered by length-2 guard)', () => {
  // The home-expansion branch handles `rawPath === '~'` defensively, but the
  // upstream `rawPath.length < 2` guard rejects bare `~` before the branch
  // is reached. PTY regexes only ever capture longer matches, so this is fine
  // in practice — documented here so the next reader doesn't move the guard.
  const tracker = new FileActivityTracker('agent-1', 'C:\\repo\\cwd');
  withStubbedHome('C:\\Users\\test', () => {
    assert.equal(resolveVia(tracker, '~'), null);
  });
});

test('resolvePath leaves absolute POSIX paths unchanged', () => {
  const tracker = new FileActivityTracker('agent-1', 'C:\\repo\\cwd');
  withStubbedHome('C:\\Users\\test', () => {
    assert.equal(resolveVia(tracker, '/abs/path/file.ts'), '/abs/path/file.ts');
  });
});

test('resolvePath joins relative paths against the agent cwd', () => {
  const tracker = new FileActivityTracker('agent-1', 'C:\\repo\\cwd');
  withStubbedHome('C:\\Users\\test', () => {
    const resolved = resolveVia(tracker, 'src/main/index.ts');
    assert.equal(resolved, path.resolve('C:\\repo\\cwd', 'src/main/index.ts'));
  });
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
