import assert from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import {
  NON_WINDOWS_OUTBOX_SKIP_MARKER,
  OUTBOX_AUDIT_MARKER,
  prepareRestrictedOutboxLaunch,
} from './outbox-launcher';

test('non-Windows callers get a loud skip marker', () => {
  assert.throws(
    () => prepareRestrictedOutboxLaunch({ command: 'x', args: [], cwd: '.', outbox: '.' }, { platform: 'linux' }),
    new RegExp(NON_WINDOWS_OUTBOX_SKIP_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
});

test('token-establishment failure fails closed before returning a launch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-outbox-fail-'));
  const outbox = path.join(root, 'outbox');
  try {
    assert.throws(
      () => prepareRestrictedOutboxLaunch(
        { command: process.execPath, args: [], cwd: root, outbox },
        { platform: 'win32', runPreflight: () => { throw new Error('synthetic probe failure'); } },
      ),
      /FAIL_CLOSED.*restricted token could not be established.*synthetic probe failure/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shipping Windows researcher seam calls the restricted outbox launcher', () => {
  const supervisorSource = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'supervisor', 'index.ts'), 'utf8');
  assert.match(supervisorSource, /roleLaneOf\(agent\) === 'researcher'[\s\S]*prepareRestrictedOutboxLaunch\(\{/,
    'the production researcher branch must invoke restricted-token preparation');
  assert.match(supervisorSource, /runner\.launch\(agent\.workingDirectory, runnerCommand, runnerArgs/,
    'the prepared wrapper command must reach the production runner');
});

test('real Windows restricted token writes only inside the declared outbox and reports audit', { timeout: 60_000 }, (t) => {
  if (process.platform !== 'win32') {
    t.diagnostic(`${NON_WINDOWS_OUTBOX_SKIP_MARKER} real restricted-token integration test`);
    t.skip('Windows restricted tokens are unavailable on this platform');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-outbox-real-'));
  const outbox = path.join(root, 'outbox');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const insideFile = path.join(outbox, 'inside.txt');
  const outsideFile = path.join(outside, 'outside.txt');
  const childScript = [
    `const fs = require('fs')`,
    `let inside = false, outsideDenied = false`,
    `try { fs.writeFileSync(${JSON.stringify(insideFile)}, 'inside-ok'); inside = true } catch {}`,
    `try { fs.writeFileSync(${JSON.stringify(outsideFile)}, 'outside-bad') } catch { outsideDenied = true }`,
    `console.log(JSON.stringify({ inside, outsideDenied }))`,
    `process.exit(inside && outsideDenied ? 0 : 9)`,
  ].join(';');

  try {
    const prepared = prepareRestrictedOutboxLaunch({
      command: process.execPath,
      args: ['-e', childScript],
      cwd: root,
      outbox,
      auditRoots: [root],
    });
    const result = spawnSync(prepared.command, prepared.args, {
      cwd: root,
      env: { ...process.env, ...prepared.env },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 45_000,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stdout, /"inside":true/);
    assert.match(result.stdout, /"outsideDenied":true/);
    assert.match(result.stderr, new RegExp(OUTBOX_AUDIT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(result.stderr, /"worldWritable":\[\]/);
    assert.equal(fs.readFileSync(insideFile, 'utf8'), 'inside-ok');
    assert.equal(fs.existsSync(outsideFile), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
