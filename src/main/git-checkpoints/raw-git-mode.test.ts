import assert from 'node:assert/strict';

import { deriveRawGitMode, type RawGitModeLstat } from './raw-git-mode';

const regular = (mode: number): RawGitModeLstat => ({
  isFile: true,
  isSymbolicLink: false,
  mode,
});

assert.equal(deriveRawGitMode('100755', null, 'win32'), '100755', 'tracked seed wins');
assert.equal(deriveRawGitMode(null, { isFile: false, isSymbolicLink: true, mode: 0 }, 'linux'), '120000');
assert.equal(deriveRawGitMode(null, regular(0o100755), 'linux'), '100755');
assert.equal(deriveRawGitMode(null, regular(0o100644), 'linux'), '100644');
assert.equal(deriveRawGitMode(null, regular(0o100755), 'win32'), '100644');
assert.equal(deriveRawGitMode(null, null, 'linux'), null, 'unreadable fails closed');
assert.equal(
  deriveRawGitMode(null, { isFile: false, isSymbolicLink: false, mode: 0 }, 'linux'),
  null,
  'unsupported entry type fails closed',
);

console.log('All raw Git mode tests passed');
