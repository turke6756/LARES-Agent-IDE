#!/usr/bin/env node
// Build step (WP-A1): esbuild-bundle the memory-index CLI entry into a single
// self-contained ESM string, written to
// src/shared/generated/memory-index-cli.generated.ts as MEMORY_INDEX_MJS.
//
// esbuild inlines the pure core (src/shared/memory-index-core.ts) verbatim, so
// there is exactly ONE source of the logic — the scaffolded .lares/scripts/
// memory-index.mjs is generated from the same TS main imports in-process.
//
// Wired into package.json `build:main` BEFORE `tsc` (the generated .ts must
// exist when the compiler and supervisor/index.ts reference MEMORY_INDEX_MJS).
//
// The stale-artifact drift test (scripts/memory-index-cli-generated.test.js)
// imports generateBundleSource() and asserts byte-identity with the committed
// generated file, so any change to the core or the CLI entry that is not
// regenerated FAILS the suite.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(repoRoot, 'scripts', 'memory-index-cli-entry.ts');
const OUT_TS = join(repoRoot, 'src', 'shared', 'generated', 'memory-index-cli.generated.ts');

/** Bundle the CLI entry and return the full text of the generated `.ts` file.
 *  Deterministic for a fixed esbuild version + fixed source inputs. */
export async function generateBundleSource() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
    logLevel: 'silent',
    // Keep output stable and readable; no minification so drift diffs are legible.
    minify: false,
    legalComments: 'none',
  });
  const bundled = result.outputFiles[0].text;
  const header =
    '// GENERATED FILE — DO NOT EDIT BY HAND.\n' +
    '//\n' +
    '// Produced by scripts/generate-memory-index-cli.mjs (esbuild bundle of\n' +
    '// scripts/memory-index-cli-entry.ts + src/shared/memory-index-core.ts).\n' +
    '// Regenerate with `node scripts/generate-memory-index-cli.mjs` (runs inside\n' +
    '// `npm run build:main`). The drift test guards byte-identity.\n' +
    '\n' +
    'export const MEMORY_INDEX_MJS: string = ' +
    JSON.stringify(bundled) +
    ';\n';
  return header;
}

async function run() {
  const source = await generateBundleSource();
  mkdirSync(dirname(OUT_TS), { recursive: true });
  writeFileSync(OUT_TS, source, 'utf8');
  console.log(`generate-memory-index-cli: wrote ${OUT_TS} (${source.length} bytes)`);
}

// Run when invoked directly (not when imported by the drift test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((err) => {
    console.error('generate-memory-index-cli failed:', err);
    process.exit(1);
  });
}
