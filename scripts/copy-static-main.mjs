#!/usr/bin/env node
// Copies the plain-JS main-process helpers that `tsc` does not emit.
//
// `tsconfig.main.json` has no `allowJs`, so a `.js` file living under `src/main/`
// is invisible to the compiler. `pty-host.js` is deliberately kept as CommonJS
// JavaScript (plan §5.1: do not convert a working file), so it needs this dumb,
// idempotent copy step to land beside the compiled output.
//
// Why it must live in `dist/` at all: the helper does a bare
// `require('node-pty')`. From `dist/main/main/` (and therefore from inside
// `app.asar` when packaged) that resolves through the application's own module
// tree, and Electron's asar layer transparently redirects the native binding to
// `app.asar.unpacked`. From `resources/scripts/` there is no `node_modules` on
// the resolution path at all and the require dies (ground truth F5).

import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** [source relative to repo root, destination relative to repo root] */
const FILES = [
  ['src/main/pty-host.js', 'dist/main/main/pty-host.js'],
]

for (const [from, to] of FILES) {
  const src = join(repoRoot, from)
  const dest = join(repoRoot, to)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  console.log(`copy-static-main: ${from} -> ${to}`)
}
