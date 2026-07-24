// git-runtime.ts — dual git resolution + workspace capability probe
// (Git-Native WP-G0.2). MAIN-PROCESS ONLY.
//
// TWO INDEPENDENT RESOLUTIONS, one probe. Lares drives git for its own
// checkpointing (the "internal" resolution) AND its agents run git in their PTY
// shells (the "agent-shell" resolution). Those are NOT the same choice:
//
//   • internal  — what LARES uses. First COMPATIBLE (semver ≥ MIN_GIT_VERSION)
//                 system git, else the compatible bundled MinGit. We refuse to
//                 checkpoint through a too-old git.
//   • agentShell — what the agent's SHELL resolves. The PTY searches the
//                 existing PATH first (any version), with the bundled shim dir
//                 appended, so a user's own git — even an old one — wins there.
//
// When those diverge (e.g. an old system git the shell will still use, while
// Lares falls back to bundled internally) we flag it so the prerequisite row can
// say so instead of pretending one git serves both.
//
// EVERYTHING that shells out goes through an injectable seam so the unit tests
// never touch a real git: discovery via `ResolveDeps`, the workspace probe via
// `ProbeDeps.runGit`. The classification logic (`parseGitVersion`,
// `pickInternalGit`, `describeAgentShellGit`, the repo-state/path predicates) is
// pulled out as pure functions so the matrix is testable without any exec.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type {
  GitCapability,
  GitCapabilityReason,
  GitRepoState,
  GitResolution,
  GitSource,
} from '../../shared/types';
import { MIN_GIT_VERSION } from '../../shared/constants';
import { loadMinGitManifest } from './mingit-manifest';

// Discovery + probe budget. Generous for `--version`/`rev-parse` on a warm
// machine, short enough that a worst-case hung git degrades one probe not the app.
const GIT_PROBE_TIMEOUT_MS = 2000;

export interface GitSemver {
  major: number;
  minor: number;
  patch: number;
}

/** A discovered git executable, before compatibility is decided. `semver` is
 *  null when `git --version` output could not be parsed. */
export interface GitCandidate {
  source: GitSource;
  execPath: string;
  semver: GitSemver | null;
}

// ── Version parsing + compatibility ──────────────────────────────────────────

/** Best-effort parse of a `git --version` line into a semver, e.g.
 *  `git version 2.45.2.windows.1` → {2,45,2}. Returns null when nothing
 *  parseable is present. Mirrors `parseNodeMajor`: an unparseable version is
 *  never, by itself, treated as "too old" — callers that need a concrete
 *  version simply skip such a candidate rather than assuming it fails the floor. */
export function parseGitVersion(line: string | undefined | null): GitSemver | null {
  if (!line) return null;
  const m = String(line).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  const major = Number.parseInt(m[1], 10);
  const minor = Number.parseInt(m[2], 10);
  const patch = m[3] !== undefined ? Number.parseInt(m[3], 10) : 0;
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/** True when `semver` meets the MIN_GIT_VERSION floor (major then minor;
 *  MIN_GIT_VERSION carries no patch). */
export function isGitVersionCompatible(
  semver: GitSemver,
  min: { major: number; minor: number } = MIN_GIT_VERSION,
): boolean {
  if (semver.major !== min.major) return semver.major > min.major;
  return semver.minor >= min.minor;
}

// ── Pure resolution logic (no exec) ──────────────────────────────────────────

/** Pick the git Lares uses internally: first COMPATIBLE system candidate, else
 *  the compatible bundled candidate, else null. A candidate with an unparseable
 *  version (`semver === null`) is skipped for internal use — we cannot confirm
 *  it clears the floor and the DTO requires a concrete semver. */
export function pickInternalGit(
  system: GitCandidate[],
  bundled: GitCandidate | null,
): GitResolution['internal'] {
  for (const c of system) {
    if (c.semver && isGitVersionCompatible(c.semver)) {
      return { source: 'system', execPath: c.execPath, semver: c.semver };
    }
  }
  if (bundled && bundled.semver && isGitVersionCompatible(bundled.semver)) {
    return { source: 'bundled', execPath: bundled.execPath, semver: bundled.semver };
  }
  return null;
}

/** Describe what the agent SHELL resolves and whether it diverges from Lares'
 *  internal choice. The PTY resolves the existing PATH first (system git, any
 *  version), with the bundled shim dir appended — so agent-shell git is the
 *  first system candidate when one exists, else bundled, else none. */
export function describeAgentShellGit(
  system: GitCandidate[],
  bundled: GitCandidate | null,
  internal: GitResolution['internal'],
): GitResolution['agentShell'] {
  const source: GitSource | null =
    system.length > 0 ? 'system' : bundled ? 'bundled' : null;

  if (source === null) {
    return { source: null, note: 'No git resolves on the agent shell PATH.' };
  }
  if (!internal) {
    return {
      source,
      note: `Agent shell uses ${source} git, but Lares found no git meeting the ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor} floor for checkpointing.`,
    };
  }
  if (internal.source !== source) {
    return {
      source,
      note: `Divergent: the agent shell resolves ${source} git first, while Lares uses ${internal.source} git (${internal.execPath}) internally.`,
    };
  }
  return { source, note: `Agent shell and Lares both resolve ${source} git.` };
}

// ── Discovery (the ONLY place we shell out to find git) ───────────────────────

export interface ResolveDeps {
  discoverSystem(): Promise<GitCandidate[]>;
  discoverBundled(): Promise<GitCandidate | null>;
}

/** `where git` (Windows) / `which -a git` (POSIX dev) → absolute git paths,
 *  filtering the Store-alias stubs like the launcher's `whichWindows` does. */
function whereGit(platform: NodeJS.Platform): Promise<string[]> {
  return new Promise((resolve) => {
    const [cmd, args] =
      platform === 'win32'
        ? [process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'cmd.exe') : 'cmd.exe', ['/c', 'where', 'git']]
        : ['/usr/bin/which', ['-a', 'git']];
    try {
      const child = execFile(
        cmd,
        args,
        { encoding: 'utf-8', timeout: GIT_PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
        (err, stdout) => {
          if (err && !stdout) {
            resolve([]);
            return;
          }
          const lines = String(stdout || '')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean)
            .filter((l) => !/\\Microsoft\\WindowsApps\\/i.test(l));
          resolve(lines);
        },
      );
      child.on('error', () => resolve([]));
    } catch {
      resolve([]);
    }
  });
}

/** `<git> --version` via a direct execFile (absolute path → no cmd.exe needed).
 *  Uses the sanitized read env so an inherited CLAUDECODE/routing var cannot
 *  perturb the answer. */
function probeExeVersion(execPath: string): Promise<GitSemver | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        execPath,
        ['--version'],
        {
          encoding: 'utf-8',
          timeout: GIT_PROBE_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 64 * 1024,
          env: buildGitEnv(process.env, { mode: 'read' }),
        },
        (err, stdout) => {
          if (err && !stdout) {
            resolve(null);
            return;
          }
          const line = String(stdout || '')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find(Boolean);
          resolve(parseGitVersion(line));
        },
      );
      child.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

async function defaultDiscoverSystem(platform: NodeJS.Platform = process.platform): Promise<GitCandidate[]> {
  const paths = await whereGit(platform);
  const out: GitCandidate[] = [];
  for (const execPath of paths) {
    out.push({ source: 'system', execPath, semver: await probeExeVersion(execPath) });
  }
  return out;
}

/** Absolute path to the bundled MinGit `git.exe`, or null when the payload is
 *  not present (the common dev case — the archive is fetched only in release CI).
 *  Packaged: `<resourcesPath>/mingit/<packagedGitExeRelPath>`. */
function bundledGitExePath(): string | null {
  try {
    const manifest = loadMinGitManifest();
    const rel = manifest.packagedGitExeRelPath || 'cmd/git.exe';
    if (process.resourcesPath) {
      const exe = path.join(process.resourcesPath, 'mingit', rel);
      if (fs.existsSync(exe)) return exe;
    }
    // Dev fallback: the fetch-mingit staging dir (WP-G0.5). Best-effort — absent
    // until the payload is fetched, in which case bundled resolution is null.
    const staging = path.resolve(__dirname, '..', '..', '..', '..', 'third_party', 'git-for-windows', '.staging', 'mingit', rel);
    if (fs.existsSync(staging)) return staging;
    return null;
  } catch {
    return null;
  }
}

async function defaultDiscoverBundled(): Promise<GitCandidate | null> {
  const exe = bundledGitExePath();
  if (!exe) return null;
  return { source: 'bundled', execPath: exe, semver: await probeExeVersion(exe) };
}

function defaultResolveDeps(): ResolveDeps {
  return { discoverSystem: () => defaultDiscoverSystem(), discoverBundled: defaultDiscoverBundled };
}

/** Discover both candidate sets and return the full two-resolution DTO. */
export async function resolveGitResolution(deps: ResolveDeps = defaultResolveDeps()): Promise<GitResolution> {
  const [system, bundled] = await Promise.all([deps.discoverSystem(), deps.discoverBundled()]);
  const internal = pickInternalGit(system, bundled);
  const agentShell = describeAgentShellGit(system, bundled, internal);
  return { agentShell, internal };
}

/** The git Lares uses internally (the compatible pick), or null. */
export async function resolveInternalGit(
  deps: ResolveDeps = defaultResolveDeps(),
): Promise<GitResolution['internal']> {
  const [system, bundled] = await Promise.all([deps.discoverSystem(), deps.discoverBundled()]);
  return pickInternalGit(system, bundled);
}

// ── Environment + arg-prefix construction ────────────────────────────────────

export type GitEnvMode = 'read' | 'commit';

/** Repo-routing vars an inherited environment could use to redirect our ops.
 *  All deleted before every git invocation (our own snapshot GIT_INDEX_FILE is
 *  passed per-op explicitly, never inherited). `GIT_CONFIG_KEY_*` /
 *  `GIT_CONFIG_VALUE_*` are matched by prefix separately. Note this list does
 *  NOT include GIT_CONFIG_GLOBAL/SYSTEM/NOSYSTEM — those must stay as the user
 *  left them so their real config (safe.directory, filters, autocrlf, longpaths)
 *  loads normally (invariant #5). */
const GIT_ROUTING_VARS: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
];

const LARES_CHECKPOINT_IDENTITY = {
  name: 'Lares Checkpoints',
  email: 'checkpoints@lares.local',
} as const;

/** Build the env for a Lares git invocation. Clones `base`, then:
 *   - deletes every repo-routing var (incl. all GIT_CONFIG_KEY_ / VALUE_ prefixes);
 *   • strips CLAUDECODE / CLAUDE_CODE_ENTRYPOINT / ELECTRON_RUN_AS_NODE;
 *   • sets GIT_TERMINAL_PROMPT=0 and GIT_OPTIONAL_LOCKS=0;
 *   • sets author/committer identity ONLY in `mode:'commit'`;
 *   • leaves GIT_CONFIG_GLOBAL/SYSTEM/NOSYSTEM untouched (never set by us).
 */
export function buildGitEnv(
  base: NodeJS.ProcessEnv,
  opts: { mode: GitEnvMode },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };

  for (const key of GIT_ROUTING_VARS) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG_KEY_') || key.startsWith('GIT_CONFIG_VALUE_')) {
      delete env[key];
    }
  }

  // Mirror probeVersion: these make a child git/node misbehave when inherited.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.ELECTRON_RUN_AS_NODE;

  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';

  if (opts.mode === 'commit') {
    env.GIT_AUTHOR_NAME = LARES_CHECKPOINT_IDENTITY.name;
    env.GIT_AUTHOR_EMAIL = LARES_CHECKPOINT_IDENTITY.email;
    env.GIT_COMMITTER_NAME = LARES_CHECKPOINT_IDENTITY.name;
    env.GIT_COMMITTER_EMAIL = LARES_CHECKPOINT_IDENTITY.email;
  }

  return env;
}

export type GitOpKind = 'read' | 'commit' | 'diff';

/** Invocation-scoped `-c` overrides and per-subcommand flags for an op kind.
 *  Placement contract for the caller: the `-c <k>=<v>` pairs are TOP-LEVEL
 *  options (they must precede the git subcommand); `--no-ext-diff`/
 *  `--no-textconv` are `git diff` subcommand flags (they follow `diff`). This
 *  helper returns them together in spec order; the command builder (WP-G1.1) is
 *  responsible for correct placement.
 *   • Windows, all kinds → `-c core.longpaths=true`
 *   • commit             → `-c commit.gpgsign=false`
 *   • diff               → `--no-ext-diff --no-textconv`
 */
export function gitArgsPrefix(kind: GitOpKind, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = [];
  if (platform === 'win32') out.push('-c', 'core.longpaths=true');
  if (kind === 'commit') out.push('-c', 'commit.gpgsign=false');
  if (kind === 'diff') out.push('--no-ext-diff', '--no-textconv');
  return out;
}

// ── Workspace capability probe ────────────────────────────────────────────────

export interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Injectable git-exec seam for the probe. Runs an argument vector against the
 *  internal git in the workspace dir; never throws (spawn/timeout failures are
 *  reported as a non-zero `code` / `timedOut`). */
export type RunGit = (args: string[]) => Promise<GitExecResult>;

export interface ProbeDeps {
  runGit: RunGit;
  /** The internal git (defaults to a fresh resolution). */
  internal?: GitResolution['internal'];
  /** The full two-resolution DTO for the capability (defaults to a fresh resolution). */
  resolution?: GitResolution;
  platform: NodeJS.Platform;
  homedir(): string;
  /** Canonical paths of the protected shell folders (Desktop/Documents/Downloads). */
  shellFolders: string[];
  /** Canonicalize a path (real path); best-effort, may echo the input. */
  realpath(p: string): string;
  /** Does a path exist on disk (for `.gitmodules` etc.). */
  fileExists(p: string): boolean;
  /** Does the workspace directly contain a nested git boundary (a `.git` in an
   *  immediate child dir — a nested repo or an in-tree submodule)? */
  hasNestedGitInside(workspaceDir: string): boolean;
}

function toComparable(p: string, platform: NodeJS.Platform): string {
  let n = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (platform === 'win32') n = n.toLowerCase();
  return n;
}

/** Native-separator canonical form of a git-emitted path (git prints forward
 *  slashes on Windows). realpath best-effort; falls back to the normalized form. */
function toNative(p: string, deps: Pick<ProbeDeps, 'platform' | 'realpath'>): string {
  const native = deps.platform === 'win32' ? p.replace(/\//g, '\\') : p;
  try {
    return deps.realpath(native);
  } catch {
    return native;
  }
}

function isAncestorOrEqual(ancestor: string, descendant: string, platform: NodeJS.Platform): boolean {
  const a = toComparable(ancestor, platform);
  const d = toComparable(descendant, platform);
  return d === a || d.startsWith(a + '/');
}

/** POSIX, top-anchored prefix of `ws` under `root` (assumes ws is under root).
 *  '' when they are the same directory. */
function posixRelPrefix(root: string, ws: string): string {
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const w = ws.replace(/\\/g, '/').replace(/\/+$/, '');
  if (w.toLowerCase() === r.toLowerCase()) return '';
  return w.slice(r.length).replace(/^\/+/, '');
}

/** A Linux/WSL path with no verified Windows-accessible form — MinGit is a
 *  Windows exe and cannot operate there. Matches `\\wsl$\…`/`\\wsl.localhost\…`
 *  UNC roots and bare POSIX-absolute paths (`/home/…`). */
export function isWslPath(p: string): boolean {
  const f = p.replace(/\\/g, '/');
  if (/^\/\/wsl(\$|\.localhost)\//i.test(f)) return true; // //wsl$/... UNC
  if (/^\/(?!\/)/.test(f)) return true; // /home/... POSIX absolute (single leading slash)
  return false;
}

/** Is the canonical dir a protected root we must never checkpoint (agenda §8):
 *  a drive/filesystem root, a UNC share root, the OS home dir, or a known shell
 *  folder. "is or is directly" → equality, not containment. */
export function isProtectedRoot(
  dir: string,
  deps: Pick<ProbeDeps, 'platform' | 'homedir' | 'shellFolders'>,
): boolean {
  const d = toComparable(dir, deps.platform);
  if (d === '') return true; // filesystem root '/'
  if (/^[a-z]:$/.test(d)) return true; // drive root C:\ (trailing slash stripped)
  if (/^\/\/[^/]+\/[^/]+$/.test(d)) return true; // UNC share root //server/share
  if (d === toComparable(deps.homedir(), deps.platform)) return true;
  for (const folder of deps.shellFolders) {
    if (d === toComparable(folder, deps.platform)) return true;
  }
  return false;
}

function defaultShellFolders(home: string): string[] {
  return ['Desktop', 'Documents', 'Downloads'].map((f) => path.join(home, f));
}

function defaultHasNestedGitInside(workspaceDir: string): boolean {
  try {
    const entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === '.git') continue; // the workspace's own repo dir, not "nested"
      if (fs.existsSync(path.join(workspaceDir, e.name, '.git'))) return true;
    }
  } catch {
    /* unreadable dir → treat as no nested boundary detected */
  }
  return false;
}

function makeRealRunGit(execPath: string, cwd: string, platform: NodeJS.Platform): RunGit {
  return (args) =>
    new Promise((resolve) => {
      try {
        const child = execFile(
          execPath,
          [...gitArgsPrefix('read', platform), ...args],
          {
            cwd,
            encoding: 'utf-8',
            timeout: GIT_PROBE_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 1 << 20,
            env: buildGitEnv(process.env, { mode: 'read' }),
          },
          (err, stdout, stderr) => {
            if (err) {
              const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
              const timedOut = e.killed === true || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
              const numericCode = typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
              resolve({ code: numericCode, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut });
              return;
            }
            resolve({ code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
          },
        );
        child.on('error', () => resolve({ code: 127, stdout: '', stderr: 'spawn error' }));
      } catch {
        resolve({ code: 127, stdout: '', stderr: 'spawn error' });
      }
    });
}

async function gitConfigGet(runGit: RunGit, key: string): Promise<string | null> {
  const r = await runGit(['config', '--get', key]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function gitConfigBool(runGit: RunGit, key: string): Promise<boolean> {
  return (await gitConfigGet(runGit, key)) === 'true';
}

/** Probe the workspace's git capability with the internal git. All exec routes
 *  through `deps.runGit` (injected in tests) so no real git runs under test.
 *  Order: protected-root flag → WSL guard → internal-present → rev-parse
 *  probes → repo-state classification → diagnostic layout probes. */
export async function probeWorkspaceGit(
  canonicalWorkspaceDir: string,
  depsIn?: Partial<ProbeDeps>,
): Promise<GitCapability> {
  const resolution = depsIn?.resolution ?? (await resolveGitResolution());
  const internal = depsIn?.internal ?? resolution.internal;
  const home = depsIn?.homedir ? depsIn.homedir() : os.homedir();
  const deps: ProbeDeps = {
    runGit:
      depsIn?.runGit ??
      (internal
        ? makeRealRunGit(internal.execPath, canonicalWorkspaceDir, depsIn?.platform ?? process.platform)
        : async () => ({ code: 127, stdout: '', stderr: 'no internal git' })),
    internal,
    resolution,
    platform: depsIn?.platform ?? process.platform,
    homedir: depsIn?.homedir ?? (() => home),
    shellFolders: depsIn?.shellFolders ?? defaultShellFolders(home),
    realpath: depsIn?.realpath ?? ((p) => fs.realpathSync.native(p)),
    fileExists: depsIn?.fileExists ?? ((p) => fs.existsSync(p)),
    hasNestedGitInside: depsIn?.hasNestedGitInside ?? defaultHasNestedGitInside,
  };

  const base: GitCapability = {
    resolution,
    repoState: null,
    commonDir: null,
    commonDirQueueKey: null,
    repoRoot: null,
    workspacePrefix: null,
    protectedRoot: isProtectedRoot(canonicalWorkspaceDir, deps),
    reason: 'ok',
    detail: null,
  };

  // WSL guard — a Windows exe cannot operate on a Linux path. Short-circuits.
  if (isWslPath(canonicalWorkspaceDir)) {
    return {
      ...base,
      repoState: 'unsupported-wsl',
      reason: 'unsupported-path',
      detail: 'Workspace is a WSL/Linux path; the bundled Git is a Windows executable and cannot operate there.',
    };
  }

  if (!internal) {
    return { ...base, reason: 'missing', detail: 'No Git meeting the version floor was found.' };
  }

  const { runGit } = deps;

  // Is this a work tree at all? This first call also surfaces dubious-ownership.
  const inside = await runGit(['rev-parse', '--is-inside-work-tree']);
  if (inside.timedOut) {
    return { ...base, reason: 'timeout', detail: 'git rev-parse timed out.' };
  }
  if (inside.code !== 0) {
    const err = inside.stderr || '';
    if (/dubious ownership/i.test(err)) {
      return {
        ...base,
        reason: 'unsafe-directory',
        detail: 'Git refuses to operate here (detected dubious ownership). Add the workspace to safe.directory to enable checkpoints.',
      };
    }
    if (/not a git repository/i.test(err)) {
      // Git itself is fine (reason stays 'ok'); it's just not a repo. The G1.3a
      // capability gate rejects on repoState, not reason — an ordinary folder
      // still shows git as available in the prerequisite row.
      return { ...base, repoState: 'non-repo', reason: 'ok', detail: 'Not a Git repository.' };
    }
    return { ...base, reason: 'broken', detail: (err.trim() || 'git rev-parse failed.').slice(0, 300) };
  }

  const [topRes, commonRes, headRes] = await Promise.all([
    runGit(['rev-parse', '--show-toplevel']),
    runGit(['rev-parse', '--git-common-dir']),
    runGit(['rev-parse', '--verify', 'HEAD']),
  ]);

  if (topRes.code !== 0 || !topRes.stdout.trim()) {
    return { ...base, reason: 'broken', detail: 'Could not resolve the repository root.' };
  }

  const repoRoot = toNative(topRes.stdout.trim(), deps);

  // common dir may be relative ('.git') → resolve against repoRoot, then canonicalize.
  let commonDir: string | null = null;
  let commonDirQueueKey: string | null = null;
  const commonRaw = commonRes.code === 0 ? commonRes.stdout.trim() : '';
  if (commonRaw) {
    const nativeCommon = deps.platform === 'win32' ? commonRaw.replace(/\//g, '\\') : commonRaw;
    const resolved = path.isAbsolute(nativeCommon) ? nativeCommon : path.resolve(repoRoot, nativeCommon);
    commonDir = toNative(resolved, deps);
    commonDirQueueKey = deps.platform === 'win32' ? commonDir.toLowerCase() : commonDir;
  }

  const unborn = headRes.code !== 0;

  // ── Repo-state classification ──
  let repoState: GitRepoState;
  let workspacePrefix: string | null = null;
  let reason: GitCapabilityReason = 'ok';

  if (!isAncestorOrEqual(repoRoot, canonicalWorkspaceDir, deps.platform)) {
    // show-toplevel resolved outside the workspace subtree — boundary crossed.
    repoState = 'spans-boundary';
    reason = 'unsupported-layout';
  } else {
    workspacePrefix = posixRelPrefix(repoRoot, canonicalWorkspaceDir);
    if (deps.hasNestedGitInside(canonicalWorkspaceDir)) {
      repoState = 'nested';
      reason = 'unsupported-layout';
    } else if (unborn) {
      repoState = 'unborn'; // supported — seeded empty in G1
    } else {
      repoState = 'repo'; // repo root ('' prefix) or inside a larger repo (non-empty prefix)
    }
  }

  // ── Diagnostic layout probes (never reject; recorded in detail) ──
  const notes: string[] = [];
  {
    const submoduleCfg = await runGit(['config', '--get-regexp', '^submodule\\.']);
    const hasSubmodules = (submoduleCfg.code === 0 && !!submoduleCfg.stdout.trim()) || deps.fileExists(path.join(repoRoot, '.gitmodules'));
    if (hasSubmodules) notes.push('submodules');

    const sparse = (await gitConfigBool(runGit, 'core.sparseCheckout')) || (await gitConfigBool(runGit, 'core.sparseCheckoutCone'));
    if (sparse) notes.push('sparse-checkout');

    const partialRes = await runGit(['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)']);
    if (partialRes.code === 0 && partialRes.stdout.trim()) notes.push('partial-clone');

    if (await gitConfigBool(runGit, 'core.longpaths')) notes.push('core.longpaths');
  }

  let detail: string | null = null;
  if (repoState === 'nested') {
    detail = 'The workspace contains a nested Git repository or in-tree submodule; checkpointing this layout is not supported.';
  } else if (repoState === 'spans-boundary') {
    detail = 'The repository root resolves outside the workspace; this layout is not supported.';
  } else if (notes.length) {
    detail = `layout: ${notes.join(', ')}`;
  }

  return {
    ...base,
    repoState,
    commonDir,
    commonDirQueueKey,
    repoRoot,
    workspacePrefix,
    reason,
    detail,
  };
}
