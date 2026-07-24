// Git-Native WP-G1.3a — ref-encoding: deterministic checkpoint/recovery refs +
// check-ref-format validation.
//
//   npm run build:main
//   node dist/main/main/git-checkpoints/ref-encoding.test.js
//
// The encode/decode/assemble/parse layer is pure and always tested. The
// check-ref-format validation is exercised against a REAL git when one is
// resolvable, and against a fake runner otherwise, so the exit-code contract is
// covered on every machine.

import assert from 'node:assert/strict';
import * as os from 'node:os';

import {
  checkpointRef,
  decodeIdComponent,
  encodeIdComponent,
  parseCheckpointRef,
  parseRecoveryRef,
  recoveryRef,
  validateRefFormat,
  type RefFormatRunner,
} from './ref-encoding';
import { runGit } from './git-command';
import { resolveInternalGit } from '../git/git-runtime';

interface TestCase { name: string; realGit?: boolean; run(): void | Promise<void>; }
const tests: TestCase[] = [];
function test(name: string, fn: () => void | Promise<void>): void { tests.push({ name, run: fn }); }
function testGit(name: string, fn: () => void | Promise<void>): void { tests.push({ name, realGit: true, run: fn }); }

let EXE = '';

// ── pure encode / decode / round-trip ─────────────────────────────────────────

test('base64url component round-trips arbitrary ids, incl. unicode + specials', () => {
  const ids = [
    'ws-123',
    'agent/with/slashes',            // a raw slash would break ref structure — encoding hides it
    'turn with spaces',
    'op..dotdot',                    // '..' is ref-illegal raw — encoding neutralizes it
    'ünïcödé-文件-🚀',
    'a@{b}c',                        // '@{' is ref-illegal raw
    '.hidden.lock',
  ];
  for (const id of ids) {
    const enc = encodeIdComponent(id);
    assert.match(enc, /^[A-Za-z0-9_-]+$/, `encoding must be ref-safe: ${enc}`);
    assert.equal(decodeIdComponent(enc), id, `round-trip must recover: ${id}`);
  }
});

test('decodeIdComponent rejects non-base64url tokens', () => {
  assert.equal(decodeIdComponent(''), null);
  assert.equal(decodeIdComponent('has/slash'), null);
  assert.equal(decodeIdComponent('has space'), null);
  assert.equal(decodeIdComponent('pad='), null);         // base64url is unpadded here
});

test('checkpoint ref assembles + parses both edges (deterministic)', () => {
  const parts = { workspaceId: 'ws-1', agentId: 'agent-α', turnId: 'turn-7' } as const;
  for (const edge of ['before', 'after'] as const) {
    const ref = checkpointRef({ ...parts, edge });
    // deterministic: same inputs → same ref
    assert.equal(ref, checkpointRef({ ...parts, edge }));
    assert.ok(ref.startsWith('refs/lares/checkpoints/'));
    assert.ok(ref.endsWith(`/${edge}`));
    const parsed = parseCheckpointRef(ref);
    assert.deepEqual(parsed, { ...parts, edge });
  }
});

test('recovery ref assembles + parses (deterministic)', () => {
  const parts = { workspaceId: 'ws-1', operationId: 'op-xyz' };
  const ref = recoveryRef(parts);
  assert.equal(ref, recoveryRef(parts));
  assert.ok(ref.startsWith('refs/lares/recovery/'));
  assert.ok(ref.endsWith('/pre'));
  assert.deepEqual(parseRecoveryRef(ref), parts);
});

test('parsers reject foreign / malformed refs', () => {
  assert.equal(parseCheckpointRef('refs/heads/main'), null);
  assert.equal(parseCheckpointRef('refs/lares/checkpoints/a/b/c/sideways'), null); // bad edge
  assert.equal(parseCheckpointRef('refs/lares/checkpoints/a/b'), null);            // too short
  assert.equal(parseRecoveryRef('refs/lares/recovery/a/b/post'), null);           // not /pre
  assert.equal(parseRecoveryRef(checkpointRef({ workspaceId: 'w', agentId: 'a', turnId: 't', edge: 'before' })), null);
});

test('namespaces do not cross-parse', () => {
  const cp = checkpointRef({ workspaceId: 'w', agentId: 'a', turnId: 't', edge: 'after' });
  const rc = recoveryRef({ workspaceId: 'w', operationId: 'o' });
  assert.equal(parseRecoveryRef(cp), null);
  assert.equal(parseCheckpointRef(rc), null);
});

// ── check-ref-format validation (fake runner — deterministic contract) ─────────

test('validateRefFormat: exit 0 → valid + normalized; non-zero → invalid', async () => {
  const okRunner: RefFormatRunner = async (args) => {
    assert.deepEqual(args.slice(0, 2), ['check-ref-format', '--normalize']);
    return { code: 0, stdout: `${args[2]}\n`, stderr: '' };
  };
  const ref = checkpointRef({ workspaceId: 'w', agentId: 'a', turnId: 't', edge: 'before' });
  assert.deepEqual(await validateRefFormat(ref, okRunner), { valid: true, normalized: ref });

  const badRunner: RefFormatRunner = async () => ({ code: 1, stdout: '', stderr: 'bad' });
  assert.deepEqual(await validateRefFormat('refs/lares/@{bad}', badRunner), { valid: false, normalized: null });
});

// ── check-ref-format validation (REAL git) ─────────────────────────────────────

testGit('real git accepts every assembled ref and rejects a malformed one', async () => {
  const run: RefFormatRunner = (args) =>
    runGit(os.tmpdir(), args, { maxBytes: 1 << 20, gitExe: EXE, allowNonzero: true });

  // Encoded ids that include ref-hostile raw characters must still validate.
  const hostileIds = ['ws/../x', 'agent @{now}', 'turn~^:?*[', 'file.lock'];
  const ref = checkpointRef({
    workspaceId: hostileIds[0],
    agentId: hostileIds[1],
    turnId: hostileIds[2],
    edge: 'after',
  });
  const good = await validateRefFormat(ref, run);
  assert.equal(good.valid, true, `real git must accept the assembled ref: ${ref}`);
  assert.equal(good.normalized, ref, 'a canonical ref normalizes to itself');

  const rec = recoveryRef({ workspaceId: hostileIds[3], operationId: 'op-1' });
  assert.equal((await validateRefFormat(rec, run)).valid, true);

  // Hand-built malformed refs that even `--normalize` cannot rescue (it only
  // collapses slashes / trims — it never fixes illegal chars or a `.lock` tail):
  // a `..` component, a `~` char, and a trailing `.lock` must all be rejected.
  assert.equal((await validateRefFormat('refs/lares/a..b', run)).valid, false);
  assert.equal((await validateRefFormat('refs/lares/bad~name', run)).valid, false);
  assert.equal((await validateRefFormat('refs/lares/foo.lock', run)).valid, false);
});

// ── runner ────────────────────────────────────────────────────────────────────

(async () => {
  const internal = await resolveInternalGit();
  EXE = internal?.execPath ?? '';

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const t of tests) {
    if (t.realGit && !EXE) {
      console.log(`  skip ${t.name} (no compatible git resolved)`);
      skipped++;
      continue;
    }
    try {
      await t.run();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error('       ', err instanceof Error ? err.stack || err.message : err);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed === 0 ? 0 : 1);
})();
