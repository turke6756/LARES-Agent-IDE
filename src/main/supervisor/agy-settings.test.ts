import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGY_GIT_DISCARD_DENY_RULES,
  agyTrustPathKey,
  ensureAgyPermissions,
  ensureAgyTrust,
  mergeAgyPermissions,
  mergeAgyTrust,
} from './agy-settings';

interface TestCase { name: string; run(): void }
const tests: TestCase[] = [];
function test(name: string, run: () => void): void { tests.push({ name, run }); }

function writtenContent(result: ReturnType<typeof mergeAgyTrust>): string {
  assert.equal(result.action, 'write');
  return result.content;
}

test('trust key uses the raw launch spelling: separator-only normalization, exact case, no git-root collapse', () => {
  const input = 'C:/Users/Turke/Projects/MixedCase/.lares/workers/agy/';
  assert.equal(
    agyTrustPathKey(input, 'windows', 'C:\\Users\\Turke'),
    'C:\\Users\\Turke\\Projects\\MixedCase\\.lares\\workers\\agy',
  );
});

test('trust key refuses non-Windows, relative, filesystem-root, and home-wide trust', () => {
  assert.equal(agyTrustPathKey('/home/turke/ws', 'wsl', 'C:\\Users\\turke'), null);
  assert.equal(agyTrustPathKey('relative\\ws', 'windows', 'C:\\Users\\turke'), null);
  assert.equal(agyTrustPathKey('C:\\', 'windows', 'C:\\Users\\turke'), null);
  assert.equal(agyTrustPathKey('c:\\users\\TURKE\\', 'windows', 'C:\\Users\\turke'), null);
});

test('trust merge appends exact keys and preserves every foreign setting and trust entry', () => {
  const existing = JSON.stringify({
    theme: 'human-owned',
    trustedWorkspaces: ['C:\\foreign'],
    permissions: { allow: ['command(echo)'], ask: ['command(curl)'], deny: ['foreign-deny'] },
  });
  const content = writtenContent(mergeAgyTrust(existing, ['C:\\RawCase\\worker']));
  const parsed = JSON.parse(content);
  assert.equal(parsed.theme, 'human-owned');
  assert.deepEqual(parsed.trustedWorkspaces, ['C:\\foreign', 'C:\\RawCase\\worker']);
  assert.deepEqual(parsed.permissions, {
    allow: ['command(echo)'], ask: ['command(curl)'], deny: ['foreign-deny'],
  });
  assert.equal(mergeAgyTrust(content, ['C:\\RawCase\\worker']).action, 'unchanged');
});

test('trust merge refuses malformed JSON and malformed trustedWorkspaces without producing content', () => {
  assert.equal(mergeAgyTrust('{ malformed', ['C:\\ws']).action, 'invalid');
  assert.equal(mergeAgyTrust('{"trustedWorkspaces":"C:\\\\ws"}', ['C:\\ws']).action, 'invalid');
});

test('deny seed is regex-opted-in, anchored, verb-scoped, and contains no bare prefix protection', () => {
  assert.equal(AGY_GIT_DISCARD_DENY_RULES.length, 5);
  for (const rule of AGY_GIT_DISCARD_DENY_RULES) {
    assert.match(rule, /^command\(regex:\^/);
    assert.match(rule, /\$\)$/);
    assert.ok(!/^command\(git/.test(rule), `bare exact matcher shipped: ${rule}`);
  }
  const joined = AGY_GIT_DISCARD_DENY_RULES.join('\n');
  for (const fragment of ['reset', 'hard', 'merge', 'keep', 'checkout', 'restore', 'clean', 'stash', 'drop', 'clear', 'pop']) {
    assert.ok(joined.includes(fragment), `missing protected form: ${fragment}`);
  }
});

test('deny regex families cover destructive forms while leaving read-only git forms outside the seed', () => {
  const regexes = AGY_GIT_DISCARD_DENY_RULES.map(rule => new RegExp(rule.slice('command(regex:'.length, -1)));
  const denied = [
    'git reset --hard',
    'git reset HEAD~1 --merge',
    'git -C . reset --keep HEAD',
    'FOO=bar git.exe checkout HEAD -- file.txt',
    'git checkout file.txt',
    'git restore --staged --worktree file.txt',
    'git clean -fdx',
    'git stash drop stash@{0}',
    'git stash clear',
    'git stash pop --index',
  ];
  for (const command of denied) {
    assert.ok(regexes.some(regex => regex.test(command)), `discard form escaped deny set: ${command}`);
  }
  for (const command of ['git status', 'git reset --soft HEAD~1', 'git stash list', 'git stash show', 'git stash push']) {
    assert.ok(regexes.every(regex => !regex.test(command)), `read-only/non-dropping form was overblocked: ${command}`);
  }
});

test('permissions merge is ADD-only and never mutates allow, ask, or foreign deny entries', () => {
  const allow = [{ command: 'human-shape-survives' }, 'command(echo)'];
  const ask = ['command(curl)'];
  const existing = JSON.stringify({
    foreign: { nested: true },
    permissions: { allow, ask, deny: ['human-deny'] },
  });
  const result = mergeAgyPermissions(existing);
  assert.equal(result.action, 'write');
  const parsed = JSON.parse(result.content);
  assert.deepEqual(parsed.foreign, { nested: true });
  assert.deepEqual(parsed.permissions.allow, allow);
  assert.deepEqual(parsed.permissions.ask, ask);
  assert.equal(parsed.permissions.deny[0], 'human-deny');
  assert.deepEqual(parsed.permissions.deny.slice(1), AGY_GIT_DISCARD_DENY_RULES);
  assert.equal(mergeAgyPermissions(result.content).action, 'unchanged');
});

test('permissions merge refuses unsafe broad additions and malformed settings', () => {
  assert.equal(mergeAgyPermissions(null, ['command(regex:^git.*$)']).action, 'invalid');
  assert.equal(mergeAgyPermissions('{ malformed').action, 'invalid');
  assert.equal(mergeAgyPermissions('{"permissions":{"deny":"nope"}}').action, 'invalid');
});

test('filesystem wrappers share the exact settings path, merge sequentially, and re-run without a write', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-settings-'));
  try {
    const trust = ensureAgyTrust(home, ['C:\\RawCase\\worker'], 'windows');
    assert.equal(trust.action, 'written');
    const permissions = ensureAgyPermissions(home);
    assert.equal(permissions.action, 'written');
    assert.equal(permissions.settingsPath, trust.settingsPath);
    const first = fs.readFileSync(trust.settingsPath, 'utf-8');
    const parsed = JSON.parse(first);
    assert.deepEqual(parsed.trustedWorkspaces, ['C:\\RawCase\\worker']);
    assert.deepEqual(parsed.permissions.deny, AGY_GIT_DISCARD_DENY_RULES);

    assert.equal(ensureAgyTrust(home, ['C:\\RawCase\\worker'], 'windows').action, 'unchanged');
    assert.equal(ensureAgyPermissions(home).action, 'unchanged');
    assert.equal(fs.readFileSync(trust.settingsPath, 'utf-8'), first);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('filesystem wrappers never clobber a malformed existing settings file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-settings-malformed-'));
  const settingsPath = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  const malformed = '{ human-owned malformed settings';
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, malformed, 'utf-8');
    assert.equal(ensureAgyTrust(home, ['C:\\RawCase\\worker'], 'windows').action, 'invalid');
    assert.equal(ensureAgyPermissions(home).action, 'invalid');
    assert.equal(fs.readFileSync(settingsPath, 'utf-8'), malformed);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

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
