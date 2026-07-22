// analytics-snapshot-cli.ts — the headless Electron-main entry point (plan §2.7).
//
// Constructs NO BrowserWindow, supervisor, API server, file watcher, parse manager,
// or browser manager. It runs under Electron only so `better-sqlite3` gets the
// correct native ABI (database.ts) while the UI is closed.
//
// There is deliberately NO surface selector, NO raw mode, NO lane/scope flag, and
// NO mutation, sign, or apply action. `mark-applied` and `sign-derivation` stay
// IPC-only and human-gated.
//
// Exit codes:
//   0  complete
//   1  usage error or core-surface failure  (nothing published)
//   2  partial — published, with ≥1 per-item failure
//   4  cold-start indexing incomplete and --allow-cold not given (nothing published)

import * as fs from 'fs';
import * as nodePath from 'path';
import { initDatabaseReadOnly, closeDatabase, getWorkspaces } from '../database';
import {
  captureAnalyticsSnapshot, writeAnalyticsSnapshot, readSnapshotFrom,
  resolveWorkspace, snapshotHasPartialFailure, ExporterError,
  diffAnalyticsSnapshots, renderDiffMarkdown, SnapshotDiffError,
} from './analytics-exporter';
import { canonicalJson } from './analytics-types';
import { flushStdio } from './analytics-snapshot-argv';

const USAGE = `
analytics:snapshot export
  --workspace <id-or-exact-path>   default $AGENT_DASHBOARD_WORKSPACE_ID
  --keep <N>                       default 10
  --no-prune
  --allow-cold                     snapshot despite incomplete indexing (marks degraded)
  --window <days>                  restrict time-filterable queries to the last N days
                                   (against the snapshot anchor); surfaces that cannot
                                   honor it export their TRUE window in provenance
  --output-root <path>             test/diagnostic override
  --json                           print the manifest summary to stdout

analytics:snapshot diff <before> <after>
  [--output <path>]                default stdout
  [--format json|markdown]         default markdown
`.trim();

interface ExportArgs {
  action: 'export';
  workspace?: string;
  keep: number;
  prune: boolean;
  allowCold: boolean;
  /** WP8 — `--window <days>`, applied uniformly against the snapshot anchor. */
  windowDays?: number;
  outputRoot?: string;
  json: boolean;
}

interface DiffArgs {
  action: 'diff';
  before: string;
  after: string;
  output?: string;
  format: 'json' | 'markdown';
}

export type ParsedArgs = ExportArgs | DiffArgs;

class UsageError extends Error {}

/** Strict parser: unknown flags and duplicated mutually exclusive arguments are
 *  refused rather than silently ignored. */
export function parseArgs(argv: string[]): ParsedArgs {
  const action = argv[0];
  const seen = new Set<string>();
  const once = (flag: string): void => {
    if (seen.has(flag)) throw new UsageError(`duplicate flag: ${flag}`);
    seen.add(flag);
  };
  const valueOf = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} requires a value`);
    return v;
  };

  if (action === 'export') {
    const out: ExportArgs = { action: 'export', keep: 10, prune: true, allowCold: false, json: false };
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      switch (a) {
        case '--workspace': once(a); out.workspace = valueOf(i, a); i++; break;
        case '--keep': {
          once(a);
          const raw = valueOf(i, a); i++;
          const n = Number.parseInt(raw, 10);
          if (!Number.isInteger(n) || n < 1) throw new UsageError(`--keep must be a positive integer, got '${raw}'`);
          out.keep = n;
          break;
        }
        case '--no-prune': once(a); out.prune = false; break;
        case '--allow-cold': once(a); out.allowCold = true; break;
        case '--window': {
          once(a);
          const raw = valueOf(i, a); i++;
          const n = Number.parseInt(raw, 10);
          if (!Number.isInteger(n) || n < 1) throw new UsageError(`--window must be a positive integer of days, got '${raw}'`);
          out.windowDays = n;
          break;
        }
        case '--output-root': once(a); out.outputRoot = valueOf(i, a); i++; break;
        case '--json': once(a); out.json = true; break;
        default: throw new UsageError(`unknown argument: ${a}`);
      }
    }
    return out;
  }

  if (action === 'diff') {
    const positional: string[] = [];
    const out: Partial<DiffArgs> = { action: 'diff', format: 'markdown' };
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--output') { once(a); out.output = valueOf(i, a); i++; continue; }
      if (a === '--format') {
        once(a);
        const f = valueOf(i, a); i++;
        if (f !== 'json' && f !== 'markdown') throw new UsageError(`--format must be json or markdown, got '${f}'`);
        out.format = f;
        continue;
      }
      if (a.startsWith('--')) throw new UsageError(`unknown argument: ${a}`);
      positional.push(a);
    }
    if (positional.length !== 2) throw new UsageError('diff requires exactly two snapshot paths');
    return { ...(out as DiffArgs), before: positional[0], after: positional[1] };
  }

  throw new UsageError(action ? `unknown action: ${action}` : 'no action given');
}

// ── actions ───────────────────────────────────────────────────────────────────

async function runExport(args: ExportArgs): Promise<number> {
  initDatabaseReadOnly();
  // Resolve the workspace BEFORE capture so the default output root is known even
  // if capture later aborts.
  const ws = resolveWorkspace(getWorkspaces(), args.workspace);

  const snapshot = await captureAnalyticsSnapshot({
    workspace: args.workspace,
    keep: args.keep,
    prune: args.prune,
    allowCold: args.allowCold,
    windowDays: args.windowDays,
    outputRoot: args.outputRoot,
  });
  // captureAnalyticsSnapshot closed the database as its last step (plan §2.6
  // step 12) — publication below touches only the filesystem.

  const dir = await writeAnalyticsSnapshot(snapshot, {
    keep: args.keep,
    prune: args.prune,
    allowCold: args.allowCold,
    outputRoot: args.outputRoot,
    workspaceRoot: ws.path,
  });

  const partial = snapshotHasPartialFailure(snapshot);
  if (args.json) {
    process.stdout.write(canonicalJson({
      snapshotId: snapshot.snapshotId,
      directory: dir,
      captureStartedAtIso: snapshot.captureStartedAtIso,
      captureCompletedAtIso: snapshot.captureCompletedAtIso,
      indexState: snapshot.provenance.indexState,
      surfaces: Object.fromEntries(
        Object.entries(snapshot.surfaces).map(([k, v]) => [k, { status: v.status, errors: v.errors.length }])),
      blockingCaveats: snapshot.caveats.filter((c) => c.severity === 'blocking').map((c) => c.id),
      partial,
    }) + '\n');
  } else {
    process.stdout.write(`published ${dir}\n`);
    process.stdout.write(`snapshotId ${snapshot.snapshotId}\n`);
    for (const [k, v] of Object.entries(snapshot.surfaces)) {
      process.stdout.write(`  ${k}: ${v.status}${v.errors.length ? ` (${v.errors.length} item errors)` : ''}\n`);
    }
    process.stdout.write('Read SUMMARY.md — it leads with the blocking caveats.\n');
  }
  return partial ? 2 : 0;
}

function runDiff(args: DiffArgs): number {
  // NEVER opens the database (plan §5).
  const before = readSnapshotFrom(args.before);
  const after = readSnapshotFrom(args.after);
  const diff = diffAnalyticsSnapshots(before, after);
  const text = args.format === 'json' ? canonicalJson(diff) + '\n' : renderDiffMarkdown(diff);
  if (args.output) {
    fs.mkdirSync(nodePath.dirname(nodePath.resolve(args.output)), { recursive: true });
    fs.writeFileSync(args.output, text, 'utf8');
  } else {
    process.stdout.write(text);
  }
  return 0;
}

// ── entry ─────────────────────────────────────────────────────────────────────

/** The whole CLI as one exported call: parse argv, run the action, return the
 *  process exit code (0 ok / 1 usage or core failure / 2 partial / 4 cold
 *  index). Both entrypoints — the direct `electron <this file>` invocation
 *  below (npm scripts, source-mode descriptor) and the `--analytics-snapshot`
 *  argv branch in src/main/index.ts (packaged binary) — call this and pass the
 *  code through to `app.exit(code)` verbatim (WP1/G1). */
export async function runSnapshotCli(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`analytics-snapshot: ${(err as Error).message}\n\n${USAGE}\n`);
    return 1;
  }

  try {
    return args.action === 'export' ? await runExport(args) : runDiff(args);
  } catch (err) {
    if (err instanceof ExporterError || err instanceof SnapshotDiffError) {
      process.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    process.stderr.write(`analytics-snapshot: unexpected failure: ${(err as Error).message}\n`);
    return 1;
  } finally {
    // Idempotent belt — capture already closes on the success path, and an abort
    // before that must not leave a handle open.
    try { closeDatabase(); } catch { /* already closed */ }
  }
}

// ── Electron lifecycle ────────────────────────────────────────────────────────
//
// Guarded so the module can be imported by tests under plain Node without
// requiring Electron or quitting the test process.
//
// `require.main === module` alone is NOT a usable guard here: Electron loads the
// entry script through its own internal loader, so in the main process
// `require.main` is the `electron` module and the comparison is always false —
// the CLI would sit idle forever with no output and never quit. Compare the
// resolved entry path instead, and keep the plain-Node form for tests.
function isDirectInvocation(): boolean {
  if (require.main === module) return true;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const norm = (p: string): string => nodePath.resolve(p).toLowerCase();
    return norm(entry) === norm(__filename);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron');
  // `electron <script> export --keep 2` → argv is [electron, script, ...ours].
  const argv = process.argv.slice(2);
  // `app.quit()` ignores `process.exitCode` and always exits 0, which would
  // silently erase the cold-start refusal (4) and the partial-snapshot code (2).
  // `app.exit(code)` is the only path that propagates it.
  const finish = (code: number): void => {
    process.exitCode = code;
    void flushStdio().then(() => app.exit(code));
  };
  app.whenReady()
    .then(() => runSnapshotCli(argv))
    .then(finish)
    .catch((err: Error) => {
      process.stderr.write(`analytics-snapshot: fatal: ${err.message}\n`);
      finish(1);
    });
}
