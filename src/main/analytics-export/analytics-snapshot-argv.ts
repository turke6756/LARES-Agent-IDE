// analytics-snapshot-argv.ts — the pure argv gate for the in-binary snapshot
// CLI mode (WP1/G1, plans/context-analytics-implementation-plan.md).
//
// Deliberately import-free (beyond Node process types) and side-effect-free so
// src/main/index.ts can evaluate the branch BEFORE the single-instance lock,
// auto-update, and any BrowserWindow construction — and so the decision is
// unit-testable under plain node without loading any Electron or exporter code.

/** The argv flag that switches the app binary into headless snapshot-CLI mode:
 *  `<binary> --analytics-snapshot export --json …`. */
export const ANALYTICS_SNAPSHOT_FLAG = '--analytics-snapshot';

/** Pure decision over argv: when the flag is present, return everything after
 *  it (the CLI's own argv — action + flags); otherwise null. Scanning the whole
 *  argv (not a fixed position) makes the branch shape-agnostic across packaged
 *  (`Lares.exe --analytics-snapshot …`) and dev (`electron . --analytics-snapshot …`)
 *  invocations, where Electron/Chromium may inject switches before ours. */
export function parseAnalyticsSnapshotArgv(argv: string[]): string[] | null {
  const i = argv.indexOf(ANALYTICS_SNAPSHOT_FLAG);
  return i === -1 ? null : argv.slice(i + 1);
}

/** Resolve once stdout/stderr have drained — `app.exit()` terminates the process
 *  without draining, which can truncate a large `--json` manifest. Shared by the
 *  direct-invocation entry in analytics-snapshot-cli.ts and the argv branch in
 *  index.ts. */
export function flushStdio(): Promise<void> {
  const drain = (s: NodeJS.WriteStream): Promise<void> =>
    s.writableLength === 0 ? Promise.resolve() : new Promise((res) => s.once('drain', () => res()));
  return Promise.all([drain(process.stdout), drain(process.stderr)]).then(() => undefined);
}
