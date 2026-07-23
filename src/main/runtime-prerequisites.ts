/** Honest prerequisite detection (packaging plan §6).
 *
 *  THE PROBLEM THIS SOLVES. Lares can bundle its own JS runtime (Phase 3), but
 *  it cannot bundle Claude Code / Codex / Gemini — those are separate programs
 *  it drives on the user's behalf. A real person installed Lares, had none of
 *  them, and got an app where "Launch Agent" simply did nothing legible. This
 *  module is the answer to that: find out what is actually there, and say so.
 *
 *  THREE RULES IT FOLLOWS.
 *
 *  1. It does NOT do its own path lookup. Every provider probe goes through
 *     `supervisor/provider-resolver`, i.e. the exact code the launcher runs. A
 *     detector that reports "installed" when the launcher can't find the binary
 *     is worse than no detector — the user would be told the problem is
 *     somewhere else. (Electron inherits the LOGIN-time PATH, not the shell
 *     PATH, so a bare `execFileSync('claude')` — which the old health check did
 *     — genuinely disagrees with the launcher on npm-shim installs.)
 *
 *  2. It never throws and never hangs. Every probe has its own short timeout
 *     and resolves to a status; a broken probe degrades one row, not the app.
 *
 *  3. WSL is passive and conditional. On a Windows-only machine `wsl.exe` can
 *     raise Windows' "install WSL" dialog. We only touch WSL when the user
 *     actually has a WSL workspace, and only via `getPassiveWslStatus`, which
 *     caches an absent result for the process lifetime (regression guard for
 *     commit 8eaa103). Everything else in the WSL group stays `not-checked`,
 *     which is deliberately NOT the same as `missing`. */
import { execFile } from 'child_process';
import { app } from 'electron';
import type {
  HealthCheck,
  PrerequisiteCheck,
  RuntimePrerequisiteReport,
  WslStatus,
} from '../shared/types';
import { PROVIDER_INSTALL_HINTS, OPTIONAL_TOOL_HINTS } from '../shared/constants';
import { getWindowsSystemPath, probeWindowsProvider } from './supervisor/provider-resolver';
import { getPassiveWslStatus, wslExec } from './wsl-bridge';

/** Per-probe budget. The plan says 2s; that is generous for a `--version` on a
 *  warm machine and short enough that the worst case (every probe times out)
 *  still returns well inside a second-or-two of wall clock, since they run
 *  concurrently. */
const PROBE_TIMEOUT_MS = 2000;

/** The report is requested on startup AND on every workspace select / Sidebar
 *  mount (see the `system:health-check` handler). Re-spawning six `--version`
 *  probes each time would be gratuitous, so hold the last answer briefly.
 *  "Recheck" in the UI passes force:true and bypasses this entirely — that is
 *  the whole point of the button. */
const REPORT_TTL_MS = 60_000;
let cachedReport: RuntimePrerequisiteReport | null = null;
let cachedAt = 0;
let inFlight: Promise<RuntimePrerequisiteReport> | null = null;

type ProviderId = 'claude' | 'codex' | 'gemini';
const PROVIDER_IDS: ProviderId[] = ['claude', 'codex', 'gemini'];

/** Run `<binary> --version` and return the first non-empty output line.
 *
 *  Everything here is about surviving Windows reality. Most provider installs
 *  are `.cmd` shims, which cannot be exec'd directly — they need cmd.exe. And
 *  the resolved path routinely contains spaces (`C:\Program Files\…`), which is
 *  precisely where naive quoting breaks. `cmd.exe /d /s /c ""<path>" --version"`
 *  with windowsVerbatimArguments is the documented form that survives both.
 *
 *  Best-effort by design: a missing version never downgrades an `available`
 *  result. Knowing WHERE the binary is is what matters; the version is a nicety.
 */
function probeVersion(binaryPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    // A provider CLI that sees these inherited from Lares misbehaves: CLAUDECODE
    // makes claude think it is nested inside another session, and the Electron
    // marker makes anything that re-execs node run as Electron instead.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.ELECTRON_RUN_AS_NODE;

    let settled = false;
    const done = (value?: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const child = execFile(
        getWindowsSystemPath('cmd.exe'),
        ['/d', '/s', '/c', `""${binaryPath}" --version"`],
        {
          encoding: 'utf-8',
          timeout: PROBE_TIMEOUT_MS,
          windowsHide: true,
          windowsVerbatimArguments: true,
          env,
          maxBuffer: 64 * 1024,
        },
        (err, stdout) => {
          if (err && !stdout) {
            done(undefined);
            return;
          }
          const line = String(stdout || '')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find(Boolean);
          done(line ? line.slice(0, 120) : undefined);
        },
      );
      child.on('error', () => done(undefined));
    } catch {
      done(undefined);
    }
  });
}

/** `where <name>` through cmd.exe — the same mechanism the launcher's fallback
 *  uses, so an "available" here means the same thing it does there.
 *
 *  The WindowsApps filter is not paranoia: Windows ships zero-byte "app
 *  execution alias" stubs for `python.exe` and `python3.exe` that exist on PATH
 *  and, when run, open the Microsoft Store instead of a Python. Reporting that
 *  as "Python is installed" would be a lie with a very confusing failure. */
function whichWindows(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        getWindowsSystemPath('cmd.exe'),
        ['/c', 'where', name],
        { encoding: 'utf-8', timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          const match = String(stdout || '')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .find((l) => !/\\Microsoft\\WindowsApps\\/i.test(l));
          resolve(match || null);
        },
      );
      child.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

async function checkProvider(id: ProviderId): Promise<PrerequisiteCheck> {
  const hint = PROVIDER_INSTALL_HINTS[id];
  const base = {
    id,
    label: hint.label,
    tier: 'agent-cli' as const,
    docsUrl: hint.docsUrl,
    installCommand: hint.installCommand,
    installShell: hint.installShell,
    altCommand: hint.altCommand,
    installNote: hint.installNote,
    verifiedOn: hint.verifiedOn,
  };

  let resolved: string | null = null;
  try {
    resolved = await probeWindowsProvider(id);
  } catch {
    resolved = null;
  }

  if (!resolved) {
    return {
      ...base,
      status: 'missing',
      impact: `Lares cannot launch ${hint.label} agents.`,
      remediation:
        `Install ${hint.label}, then fully quit and restart Lares so it picks up your updated PATH.`,
    };
  }

  const version = await probeVersion(resolved);
  return {
    ...base,
    status: 'available',
    path: resolved,
    version,
    impact: '',
    remediation: '',
  };
}

async function checkOptional(
  id: 'git' | 'python' | 'node',
  impact: string,
): Promise<PrerequisiteCheck> {
  const hint = OPTIONAL_TOOL_HINTS[id];
  // `py` is the Windows Python launcher and is the more reliable of the two;
  // try it first, then the plain name.
  const names = id === 'python' ? ['py', 'python'] : [id];
  let resolved: string | null = null;
  for (const name of names) {
    resolved = await whichWindows(name);
    if (resolved) break;
  }

  const base = {
    id,
    label: hint.label,
    tier: 'optional' as const,
    docsUrl: hint.docsUrl,
    installCommand: hint.installCommand,
  };

  if (!resolved) {
    return {
      ...base,
      status: 'missing',
      impact,
      remediation: `Optional — install ${hint.label} only if you need the features above.`,
    };
  }
  return {
    ...base,
    status: 'available',
    path: resolved,
    version: await probeVersion(resolved),
    impact: '',
    remediation: '',
  };
}

/** WSL group. `probe` false means we deliberately did not look — every entry
 *  comes back `not-checked` and the UI must say "not checked", never "missing". */
async function checkWslGroup(
  probe: boolean,
): Promise<{ checks: PrerequisiteCheck[]; status: WslStatus }> {
  const wslHint = OPTIONAL_TOOL_HINTS.wsl;
  const tmuxHint = OPTIONAL_TOOL_HINTS.tmux;

  const notChecked = (
    id: string,
    label: string,
    impact: string,
    docsUrl?: string,
  ): PrerequisiteCheck => ({
    id,
    label,
    status: 'not-checked',
    tier: 'wsl-feature',
    impact,
    remediation:
      'Not checked — Lares only probes WSL when you have a WSL-backed workspace, so it never triggers Windows’ "install WSL" prompt on a Windows-only machine.',
    docsUrl,
  });

  const wslImpact = 'WSL-backed workspaces and persistent WSL terminals are unavailable. Windows-native workspaces are unaffected.';
  const nodeImpact = 'Dashboard MCP tools inside a WSL workspace will not start (Lares’ bundled runtime is Windows-side and cannot run inside the distro).';
  const tmuxImpact = 'WSL terminals will not survive closing and reopening the pane.';
  const wslClaudeImpact = 'WSL-backed workspaces cannot launch Claude agents. Your Windows-side install is separate and unaffected.';

  if (!probe) {
    return {
      status: { state: 'unknown', distros: [] },
      checks: [
        notChecked('wsl', wslHint.label, wslImpact, wslHint.docsUrl),
        notChecked('wsl-node', 'Node.js (inside WSL)', nodeImpact, OPTIONAL_TOOL_HINTS.node.docsUrl),
        notChecked('tmux', tmuxHint.label, tmuxImpact, tmuxHint.docsUrl),
        notChecked('wsl-claude', 'Claude Code (inside WSL)', wslClaudeImpact, PROVIDER_INSTALL_HINTS.claude.docsUrl),
      ],
    };
  }

  let status: WslStatus;
  try {
    status = await getPassiveWslStatus();
  } catch (err) {
    status = {
      state: 'unavailable',
      distros: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const running = status.state === 'running';
  const wslCheck: PrerequisiteCheck = {
    id: 'wsl',
    label: wslHint.label,
    tier: 'wsl-feature',
    status: running ? 'available' : status.state === 'stopped' ? 'stopped' : 'missing',
    version: status.defaultDistro ? `default distro: ${status.defaultDistro}` : undefined,
    impact: running ? '' : wslImpact,
    remediation: running
      ? ''
      : status.state === 'stopped'
        ? 'WSL is installed but no distribution is running. Open your distribution once, then choose Recheck.'
        : `Install WSL with \`${wslHint.installCommand}\` in an elevated terminal, or use Windows-native workspaces instead.`,
    docsUrl: wslHint.docsUrl,
    installCommand: wslHint.installCommand,
    detail: status.error,
  };

  // Only reach INTO the distro when one is actually running — `wslExec` on a
  // stopped/absent WSL is exactly the invocation that raises the install popup.
  if (!running) {
    return {
      status,
      checks: [
        wslCheck,
        notChecked('wsl-node', 'Node.js (inside WSL)', nodeImpact, OPTIONAL_TOOL_HINTS.node.docsUrl),
        notChecked('tmux', tmuxHint.label, tmuxImpact, tmuxHint.docsUrl),
        notChecked('wsl-claude', 'Claude Code (inside WSL)', wslClaudeImpact, PROVIDER_INSTALL_HINTS.claude.docsUrl),
      ],
    };
  }

  const inDistro = async (
    id: string,
    label: string,
    command: string,
    impact: string,
    remediation: string,
    docsUrl?: string,
    installCommand?: string,
  ): Promise<PrerequisiteCheck> => {
    try {
      const result = await wslExec(command, PROBE_TIMEOUT_MS);
      const ok = result.exitCode === 0;
      return {
        id,
        label,
        tier: 'wsl-feature',
        status: ok ? 'available' : 'missing',
        version: ok ? result.stdout.split(/\r?\n/)[0]?.trim() || undefined : undefined,
        impact: ok ? '' : impact,
        remediation: ok ? '' : remediation,
        docsUrl,
        installCommand,
      };
    } catch (err) {
      return {
        id,
        label,
        tier: 'wsl-feature',
        status: 'not-checked',
        impact,
        remediation: 'The check could not be completed. Choose Recheck to try again.',
        docsUrl,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const [wslNode, tmux, wslClaude] = await Promise.all([
    inDistro(
      'wsl-node',
      'Node.js (inside WSL)',
      'node --version',
      nodeImpact,
      'Install Node.js inside your WSL distribution (for example `sudo apt install nodejs`).',
      OPTIONAL_TOOL_HINTS.node.docsUrl,
    ),
    inDistro(
      'tmux',
      tmuxHint.label,
      'tmux -V',
      tmuxImpact,
      `Install tmux inside your WSL distribution: \`${tmuxHint.installCommand}\`.`,
      tmuxHint.docsUrl,
      tmuxHint.installCommand,
    ),
    // The in-distro provider CLI is a SEPARATE install from the Windows-side
    // one — having claude on Windows tells you nothing about a WSL workspace.
    inDistro(
      'wsl-claude',
      'Claude Code (inside WSL)',
      'which claude',
      'WSL-backed workspaces cannot launch Claude agents. Your Windows-side install is separate and unaffected.',
      `Install Claude Code inside your WSL distribution: \`curl -fsSL ${'https://claude.ai/install.sh'} | bash\`.`,
      PROVIDER_INSTALL_HINTS.claude.docsUrl,
    ),
  ]);

  return { status, checks: [wslCheck, wslNode, tmux, wslClaude] };
}

export interface DetectOptions {
  /** True when the user has at least one wsl-typed workspace. Gates ALL WSL
   *  probing — see the module header. */
  hasWslWorkspace?: boolean;
  /** Bypass the TTL cache. The Recheck button sets this. */
  force?: boolean;
}

/** Build the report. Never throws. */
export async function detectRuntimePrerequisites(
  opts: DetectOptions = {},
): Promise<RuntimePrerequisiteReport> {
  const now = Date.now();
  if (!opts.force && cachedReport && now - cachedAt < REPORT_TTL_MS) {
    // Don't serve a cached WSL-less report to a caller that wants WSL probed.
    if (!opts.hasWslWorkspace || cachedReport.wslChecked) return cachedReport;
  }
  if (!opts.force && inFlight) return inFlight;

  const run = (async (): Promise<RuntimePrerequisiteReport> => {
    const [providers, optional, wslGroup] = await Promise.all([
      Promise.all(PROVIDER_IDS.map(checkProvider)),
      Promise.all([
        checkOptional(
          'git',
          'Git-specific features (history, diffs) are unavailable. Lares opens ordinary folders as workspaces without it.',
        ),
        checkOptional(
          'python',
          'Jupyter notebooks and Python-based workspace tooling will not run.',
        ),
        checkOptional(
          'node',
          'Lares itself does not need this — it ships its own runtime. Some agent CLIs, hooks and workspace scripts do.',
        ),
      ]),
      checkWslGroup(Boolean(opts.hasWslWorkspace)),
    ]);

    const report: RuntimePrerequisiteReport = {
      appVersion: safeAppVersion(),
      checkedAt: Date.now(),
      providers,
      anyProviderAvailable: providers.some((p) => p.status === 'available'),
      optional,
      wsl: wslGroup.checks,
      wslChecked: Boolean(opts.hasWslWorkspace),
      wslStatus: wslGroup.status,
    };
    cachedReport = report;
    cachedAt = Date.now();
    return report;
  })();

  inFlight = run;
  try {
    return await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

function safeAppVersion(): string {
  // `app` is undefined under the plain-node test runner.
  try {
    return app?.getVersion?.() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Derive the legacy `HealthCheck` shape from the report.
 *
 *  This is the whole point of extending rather than forking: the Sidebar ticker
 *  and the first-run dialog are now two renderings of ONE detection pass, so
 *  they cannot contradict each other. `claudeWindowsAvailable` in particular is
 *  now resolver-derived instead of a bare PATH exec, which is a behavior FIX —
 *  an npm-shim claude that the launcher finds no longer shows as unavailable. */
export function toHealthCheck(report: RuntimePrerequisiteReport): HealthCheck {
  const find = (list: PrerequisiteCheck[], id: string) => list.find((c) => c.id === id);
  return {
    wslAvailable: report.wslStatus.state === 'running',
    tmuxAvailable: find(report.wsl, 'tmux')?.status === 'available',
    claudeWindowsAvailable: find(report.providers, 'claude')?.status === 'available',
    claudeWslAvailable: find(report.wsl, 'wsl-claude')?.status === 'available',
    wslStatus: report.wslStatus,
    prerequisites: report,
  };
}

/** Test seam: drop the TTL cache. */
export function __resetPrerequisiteCache(): void {
  cachedReport = null;
  cachedAt = 0;
  inFlight = null;
}
