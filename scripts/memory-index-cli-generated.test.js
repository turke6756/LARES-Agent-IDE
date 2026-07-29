// WP-A1 — stale-artifact drift check for the generated memory-index CLI bundle.
//
// Regenerates the esbuild bundle from the CURRENT core + CLI entry sources and
// asserts byte-identity with the committed
// src/shared/generated/memory-index-cli.generated.ts. This FAILS if
// memory-index-core.ts or memory-index-cli-entry.ts changed without rerunning
// `node scripts/generate-memory-index-cli.mjs` (i.e. without `build:main`), so
// the shipped scaffold can never silently lag the in-process core.
//
// Runs as plain Node; registered in scripts/run-main-tests.mjs.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const url = require('url');

const repoRoot = path.resolve(__dirname, '..');
const committedPath = path.join(repoRoot, 'src', 'shared', 'generated', 'memory-index-cli.generated.ts');

(async () => {
  const genUrl = url.pathToFileURL(path.join(repoRoot, 'scripts', 'generate-memory-index-cli.mjs')).href;
  const { generateBundleSource } = await import(genUrl);

  let passed = 0;
  let failed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed++; }
    catch (err) {
      console.error(`  FAIL ${name}`);
      console.error('       ', err && err.stack ? err.stack : err);
      failed++;
    }
  };

  await test('committed generated bundle exists', () => {
    assert.ok(fs.existsSync(committedPath), `${committedPath} must be committed`);
  });

  await test('regenerated bundle is byte-identical to the committed file', async () => {
    const fresh = await generateBundleSource();
    const committed = fs.readFileSync(committedPath, 'utf8');
    assert.equal(
      fresh,
      committed,
      'generated bundle is stale — run `node scripts/generate-memory-index-cli.mjs` (or `npm run build:main`) and commit the result',
    );
  });

  await test('regeneration is deterministic (same source → identical bytes twice)', async () => {
    const a = await generateBundleSource();
    const b = await generateBundleSource();
    assert.equal(a, b, 'esbuild output must be deterministic for a fixed source + version');
  });

  await test('committed bundle carries the exported constant and no fs import', () => {
    const committed = fs.readFileSync(committedPath, 'utf8');
    assert.match(committed, /export const MEMORY_INDEX_MJS: string = /, 'exports the string constant');
    // The generated .ts is a plain string constant — it must not itself import fs.
    assert.ok(!/^import .*['"](node:)?fs['"]/m.test(committed), 'generated .ts must not import fs');
  });

  console.log(`\nmemory-index CLI drift: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
