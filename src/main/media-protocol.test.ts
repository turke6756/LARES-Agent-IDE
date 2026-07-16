import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handleMediaProtocolRequest, parseSingleByteRange } from './media-protocol';

type Test = { name: string; run: () => void | Promise<void> };
const tests: Test[] = [];
function test(name: string, run: Test['run']): void { tests.push({ name, run }); }

const CONTENT = '0123456789abcdef';

function mediaUrl(filePath: string): string {
  return `media://file/${encodeURIComponent(filePath)}`;
}

function fixture(): { root: string; file: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-media-'));
  const file = path.join(root, 'sample.pdf');
  fs.writeFileSync(file, CONTENT);
  return { root, file, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function requestFile(
  filePath: string,
  root: string,
  init: RequestInit = {},
  translateWslPath?: (value: string) => string,
): Promise<Response> {
  return handleMediaProtocolRequest(new Request(mediaUrl(filePath), init), {
    workspaceRoots: [root],
    platform: 'win32',
    translateWslPath,
  });
}

test('full fetch streams the complete file with metadata', async () => {
  const f = fixture();
  try {
    const response = await requestFile(f.file, f.root);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-length'), String(CONTENT.length));
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.equal(await response.text(), CONTENT);
  } finally { f.cleanup(); }
});

test('HEAD returns full-file metadata and no body', async () => {
  const f = fixture();
  try {
    const response = await requestFile(f.file, f.root, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(CONTENT.length));
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(await response.text(), '');
  } finally { f.cleanup(); }
});

for (const [name, range, expected, contentRange] of [
  ['prefix', 'bytes=0-3', '0123', 'bytes 0-3/16'],
  ['suffix', 'bytes=-4', 'cdef', 'bytes 12-15/16'],
  ['open-ended', 'bytes=12-', 'cdef', 'bytes 12-15/16'],
] as const) {
  test(`${name} range returns an exact bounded 206 stream`, async () => {
    const f = fixture();
    try {
      const response = await requestFile(f.file, f.root, { headers: { Range: range } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), contentRange);
      assert.equal(response.headers.get('content-length'), String(expected.length));
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.equal(await response.text(), expected);
    } finally { f.cleanup(); }
  });
}

test('end positions beyond EOF are clipped to the file boundary', () => {
  assert.deepEqual(parseSingleByteRange('bytes=12-999', 16), { start: 12, end: 15 });
});

for (const range of ['items=0-1', 'bytes=', 'bytes=-', 'bytes=8-4', 'bytes=16-', 'bytes=0-1,4-5']) {
  test(`malformed or out-of-bounds range ${range} returns 416`, async () => {
    const f = fixture();
    try {
      const response = await requestFile(f.file, f.root, { headers: { Range: range } });
      assert.equal(response.status, 416);
      assert.equal(response.headers.get('content-range'), `bytes */${CONTENT.length}`);
      assert.equal(response.headers.get('content-length'), '0');
      assert.equal(await response.text(), '');
    } finally { f.cleanup(); }
  });
}

test('traversal to an existing file outside the workspace is rejected', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-media-parent-'));
  try {
    const root = path.join(parent, 'root');
    fs.mkdirSync(root);
    const secret = path.join(parent, 'secret.pdf');
    fs.writeFileSync(secret, 'secret');
    const response = await requestFile(path.join(root, '..', 'secret.pdf'), root);
    assert.equal(response.status, 404);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('junction/symlink escape outside the workspace is rejected', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'lares-media-link-'));
  try {
    const root = path.join(parent, 'root');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.pdf'), 'secret');
    const link = path.join(root, 'link');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch {
      console.log('    (skipped: cannot create junction/symlink in this environment)');
      return;
    }
    const response = await requestFile(path.join(link, 'secret.pdf'), root);
    assert.equal(response.status, 404);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('an encoded Windows path resolves inside its Windows workspace root', async () => {
  const f = fixture();
  try {
    const response = await requestFile(f.file, f.root);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), CONTENT);
  } finally { f.cleanup(); }
});

test('a WSL-form path is translated before the same realpath confinement check', async () => {
  const f = fixture();
  try {
    let translated = '';
    const response = await requestFile('/mnt/c/work/sample.pdf', f.root, {}, (value) => {
      translated = value;
      return f.file;
    });
    assert.equal(translated, '/mnt/c/work/sample.pdf');
    assert.equal(response.status, 200);
    assert.equal(await response.text(), CONTENT);
  } finally { f.cleanup(); }
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.run();
      console.log(`  \u2713 ${t.name}`);
    } catch (error) {
      failed++;
      console.error(`  \u2717 ${t.name}`);
      console.error(error instanceof Error ? error.stack : String(error));
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} media protocol test(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${tests.length} media protocol tests passed`);
})();
