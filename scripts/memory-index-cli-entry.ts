// Node CLI entry for the memory-index core (WP-A1).
//
// This is the ONLY layer allowed `fs`/`realpath`; it holds argv parsing, file
// read, realpath resolution, and exit-code mapping — NO domain logic. It lives
// under scripts/ (NOT src/shared) so the renderer-wide shared compilation never
// absorbs a Node-only `fs` entry. esbuild bundles this file (inlining the pure
// core verbatim) into src/shared/generated/memory-index-cli.generated.ts as
// MEMORY_INDEX_MJS, which is scaffolded to .lares/scripts/memory-index.mjs.
//
// Exit-code mapping (severity → exit):
//   0  clean or advisory-only        (never HARD; index is injectable)
//   1  one or more HARD findings     (never injected)
//   2  RUNTIME: read/parse threw
//
// WP-A2 extends the `validate` command with the I/O-only HARD classes.

import * as fs from 'fs';
import * as path from 'path';
import { parseIndex, validateParsed, projectParsed, type Finding } from '../src/shared/memory-index-core';
import { validateIO, deriveWorkspaceRootFromIndexPath } from '../src/main/memory-index/io';

const EXIT_OK = 0;
const EXIT_HARD = 1;
const EXIT_RUNTIME = 2;

interface CliArgs {
  command: string;
  file: string | null;
  nowISO: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const command = argv[0] ?? '';
  let file: string | null = null;
  let nowISO: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--now') {
      nowISO = argv[++i] ?? null;
    } else if (a.startsWith('--now=')) {
      nowISO = a.slice('--now='.length);
    } else if (!a.startsWith('-')) {
      file = a;
    }
  }
  return { command, file, nowISO };
}

/** Resolve + realpath-contain the input file, then read its bytes. Throws
 *  (→ RUNTIME exit 2) on any read failure. */
function readIndexFile(file: string): string {
  const resolved = path.resolve(file);
  const real = fs.realpathSync(resolved);
  return fs.readFileSync(real, 'utf8');
}

function printFindings(findings: Finding[]): void {
  for (const f of findings) {
    const where = f.id ? ` [${f.id}]` : '';
    process.stderr.write(`${f.severity.toUpperCase()} ${f.cls}${where}: ${f.message}\n`);
  }
}

function main(): number {
  const { command, file, nowISO } = parseArgs(process.argv.slice(2));

  if (command !== 'validate' && command !== 'project') {
    process.stderr.write(`usage: memory-index.mjs <validate|project> [--now <ISO>] <index-file>\n`);
    return EXIT_RUNTIME;
  }
  if (!file) {
    process.stderr.write(`error: no index file given\n`);
    return EXIT_RUNTIME;
  }

  let text: string;
  try {
    text = readIndexFile(file);
  } catch (err) {
    process.stderr.write(`RUNTIME read error: ${(err as Error).message}\n`);
    return EXIT_RUNTIME;
  }

  let parsed;
  try {
    parsed = parseIndex(text);
  } catch (err) {
    process.stderr.write(`RUNTIME parse error: ${(err as Error).message}\n`);
    return EXIT_RUNTIME;
  }

  const pure = validateParsed(parsed);

  // I/O validation (WP-A2): layer the filesystem-dependent HARD classes on top,
  // but ONLY when the index sits in the canonical .lares/supervisor/memory
  // layout — a stray fixture elsewhere gets pure-only validation, exactly as
  // before WP-A2, so it never fails on detail files it was never meant to have.
  const workspaceRoot = deriveWorkspaceRootFromIndexPath(file);
  const ioHard: Finding[] = workspaceRoot ? validateIO(parsed, workspaceRoot).hard : [];

  const hard: Finding[] = [...pure.hard, ...ioHard];
  const advisory = pure.advisory;

  if (command === 'validate') {
    process.stdout.write(JSON.stringify({ hard, advisory }, null, 2) + '\n');
    printFindings([...hard, ...advisory]);
    return hard.length > 0 ? EXIT_HARD : EXIT_OK;
  }

  // command === 'project'
  const now = nowISO ?? new Date().toISOString();
  const projection = projectParsed(parsed, { nowISO: now });
  if (projection.hard.length > 0) {
    printFindings(projection.hard);
    process.stderr.write(`refusing to project a HARD-invalid index\n`);
    return EXIT_HARD;
  }
  // injectText on stdout (byte-exact); lifecycle findings on stderr.
  process.stdout.write(projection.injectText);
  process.stderr.write(
    JSON.stringify({
      dropped: projection.dropped,
      conditionReview: projection.conditionReview,
      staleActive: projection.staleActive,
      budget: projection.budget,
      advisory,
    }) + '\n',
  );
  return EXIT_OK;
}

process.exit(main());
