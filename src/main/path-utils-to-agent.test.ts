// toAgentPath tests — strict Windows-native → agent-path-space conversion used
// by the image-paste feature. Native-Windows agents keep the path; WSL agents
// get the /mnt or /home form; unmappable paths and a missing working directory
// are rejected instead of emitting a bad path.
//
//   npm run build:main
//   node dist/main/main/path-utils-to-agent.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAgentPath } from './path-utils';

test('windows agent keeps a Windows path unchanged', () => {
  const res = toAgentPath('C:\\Users\\me\\AppData\\Local\\Temp\\x.png', 'C:\\Users\\me\\Projects');
  assert.deepEqual(res, { ok: true, path: 'C:\\Users\\me\\AppData\\Local\\Temp\\x.png' });
});

test('wsl agent maps a C: temp path into /mnt/c space', () => {
  const res = toAgentPath('C:\\Users\\me\\AppData\\Local\\Temp\\x.png', '/home/me/project');
  assert.deepEqual(res, { ok: true, path: '/mnt/c/Users/me/AppData/Local/Temp/x.png' });
});

test('wsl agent rejects an unmappable path (no drive/UNC)', () => {
  const res = toAgentPath('foo', '/home/me/project');
  assert.equal(res.ok, false);
});

test('a missing working directory is rejected (no silent windows fallback)', () => {
  const res = toAgentPath('C:\\Users\\me\\x.png', '');
  assert.equal(res.ok, false);
});
