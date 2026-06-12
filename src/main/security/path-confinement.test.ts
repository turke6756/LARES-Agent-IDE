// WP0.4 (plans/embedded-browser-implementation-tasks.md) — tests for the
// path-confinement helpers extracted from file-writer.ts in WP0.3. These are
// the decision functions behind the media:// protocol gate (M8) and the
// Phase-3 surface protocol, plus the file IPC path that always used them.
// Maps to safety-spec §5 acceptance test #4 (path logic half).
//
// Compile via the existing main tsconfig and run with:
//   npm run build:main
//   node dist/main/main/security/path-confinement.test.js

import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isWindowsPathInside,
  isWslPathInside,
  assertInsideRoot,
  resolveConfined,
} from './path-confinement';

interface TestCase { name: string; run(): void; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, run: fn });
}

// ── Windows predicate ───────────────────────────────────────────────────────

test('windows: nested path is inside', () => {
  assert.equal(isWindowsPathInside('C:\\work\\proj\\src\\a.ts', 'C:\\work\\proj'), true);
});

test('windows: the root itself is inside', () => {
  assert.equal(isWindowsPathInside('C:\\work\\proj', 'C:\\work\\proj'), true);
});

test('windows: sibling with shared name prefix is NOT inside', () => {
  assert.equal(isWindowsPathInside('C:\\work\\projX\\a.ts', 'C:\\work\\proj'), false);
});

test('windows: .. traversal escaping the root is NOT inside', () => {
  assert.equal(isWindowsPathInside('C:\\work\\proj\\..\\secret.txt', 'C:\\work\\proj'), false);
});

test('windows: deep .. traversal to another drive-root path is NOT inside', () => {
  assert.equal(
    isWindowsPathInside('C:\\work\\proj\\a\\..\\..\\..\\Users\\x\\.ssh\\id_rsa', 'C:\\work\\proj'),
    false,
  );
});

test('windows: .. segments that stay inside the root are inside', () => {
  assert.equal(isWindowsPathInside('C:\\work\\proj\\a\\..\\b.txt', 'C:\\work\\proj'), true);
});

test('windows: unrelated absolute path is NOT inside', () => {
  assert.equal(isWindowsPathInside('D:\\other\\a.ts', 'C:\\work\\proj'), false);
});

// ── WSL predicate ───────────────────────────────────────────────────────────

test('wsl: nested path is inside', () => {
  assert.equal(isWslPathInside('/home/user/proj/src/a.ts', '/home/user/proj'), true);
});

test('wsl: the root itself is inside', () => {
  assert.equal(isWslPathInside('/home/user/proj', '/home/user/proj'), true);
});

test('wsl: sibling with shared name prefix is NOT inside', () => {
  assert.equal(isWslPathInside('/home/user/projX/a.ts', '/home/user/proj'), false);
});

test('wsl: .. traversal escaping the root is NOT inside', () => {
  assert.equal(isWslPathInside('/home/user/proj/../.ssh/id_rsa', '/home/user/proj'), false);
});

test('wsl: trailing slashes and duplicate separators normalize', () => {
  assert.equal(isWslPathInside('/home/user/proj//src///a.ts', '/home/user/proj/'), true);
});

test('wsl: root "/" admits any absolute path', () => {
  assert.equal(isWslPathInside('/etc/passwd', '/'), true);
});

// ── assertInsideRoot ────────────────────────────────────────────────────────

test('assertInsideRoot: throws on windows escape, passes inside', () => {
  assert.throws(() => assertInsideRoot('C:\\work\\proj\\..\\x', 'C:\\work\\proj', 'windows'));
  assert.doesNotThrow(() => assertInsideRoot('C:\\work\\proj\\x', 'C:\\work\\proj', 'windows'));
});

test('assertInsideRoot: throws on wsl escape, passes inside', () => {
  assert.throws(() => assertInsideRoot('/home/u/proj/../x', '/home/u/proj', 'wsl'));
  assert.doesNotThrow(() => assertInsideRoot('/home/u/proj/x', '/home/u/proj', 'wsl'));
});

// ── resolveConfined (real filesystem: realpath, traversal, links) ───────────

function makeTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wp0-confine-${label}-`));
}

test('resolveConfined: file inside a root resolves to its realpath', () => {
  const root = makeTmpDir('root');
  try {
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'x');
    const resolved = resolveConfined(file, [root]);
    assert.equal(resolved, fs.realpathSync.native(file));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveConfined: .. traversal escaping the root → null', () => {
  const parent = makeTmpDir('parent');
  try {
    const root = path.join(parent, 'root');
    fs.mkdirSync(root);
    const secret = path.join(parent, 'secret.txt');
    fs.writeFileSync(secret, 'top secret');
    // The file EXISTS — realpath succeeds — but lands outside the root.
    assert.equal(resolveConfined(path.join(root, '..', 'secret.txt'), [root]), null);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('resolveConfined: nonexistent path → null (no throw)', () => {
  const root = makeTmpDir('root');
  try {
    assert.equal(resolveConfined(path.join(root, 'missing.txt'), [root]), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveConfined: arbitrary absolute path outside every root → null', () => {
  const root = makeTmpDir('root');
  try {
    // os.homedir() always exists, and is never inside a fresh tmp dir.
    assert.equal(resolveConfined(os.homedir(), [root]), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveConfined: second root admits what the first rejects', () => {
  const rootA = makeTmpDir('rootA');
  const rootB = makeTmpDir('rootB');
  try {
    const file = path.join(rootB, 'b.txt');
    fs.writeFileSync(file, 'x');
    assert.equal(resolveConfined(file, [rootA, rootB]), fs.realpathSync.native(file));
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test('resolveConfined: missing/unreadable root admits nothing (and no throw)', () => {
  const root = makeTmpDir('root');
  try {
    const file = path.join(root, 'a.txt');
    fs.writeFileSync(file, 'x');
    const ghost = path.join(root, 'no-such-root');
    assert.equal(resolveConfined(file, [ghost]), null);
    // ...but a later valid root still admits it.
    assert.equal(resolveConfined(file, [ghost, root]), fs.realpathSync.native(file));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveConfined: directory-link escape (junction) → null where creatable', () => {
  const parent = makeTmpDir('parent');
  try {
    const root = path.join(parent, 'root');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'leak.txt'), 'escaped');
    const link = path.join(root, 'link');
    try {
      // 'junction' works on Windows without admin/Developer Mode; on POSIX
      // node falls back to a regular dir symlink.
      fs.symlinkSync(outside, link, 'junction');
    } catch {
      console.log('    (skipped: cannot create dir links in this environment)');
      return;
    }
    // The path LOOKS inside the root but realpath-resolves outside it.
    assert.equal(resolveConfined(path.join(link, 'leak.txt'), [root]), null);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// ── Run ────────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(err instanceof Error ? err.stack : String(err));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} path-confinement tests passed`);
})();
