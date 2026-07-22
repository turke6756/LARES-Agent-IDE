import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { AgentProvider, ContextGaugeRoleKey } from '../../../shared/types';
import type { SessionEvent } from '../../../shared/session-events';

export interface ChatLogReaderSession {
  agentId: string;
  sessionId: string;
  workingDirectory: string;
  provider: AgentProvider;
  startedAt?: string;
  /** True when the chat pane is open for this agent — readers may use this to do aggressive path re-resolution after N empty ticks. */
  subscribed: boolean;
  /** Gauge-cap role key (Context Window Warning): which per-role cap this
   *  agent's context gauge reads 100% against. Absent (internally-synthesized
   *  sessions, tests) ⇒ the flat 200K default. */
  role?: ContextGaugeRoleKey;
}

export interface ChatLogReader {
  readonly provider: AgentProvider;
  /** Tail the on-disk session log and return any new events since the last call. Stateful: tracks byte offsets internally. */
  pollSession(session: ChatLogReaderSession): SessionEvent[];
  /** Drop cached path/offsets for an agent. Called when resumeSessionId changes. */
  invalidatePath(agentId: string): void;
  /** Drain the session-pinned stale signals accumulated since the last call;
   *  the dispatcher re-emits these as `'session-stale'`. Optional — only the
   *  Claude reader implements /clear-rotation detection. */
  drainStaleSignals?(): Array<{
    agentId: string;
    staleSessionId: string;
    workingDirectory: string;
    observedAt: number;
  }>;
  /** Validate that an already-agent-bound candidate session id is a genuine
   *  `/clear` successor of `currentSessionId` within `workingDirectory`. Does
   *  NOT discover a successor by scanning — the candidate must be supplied (it
   *  comes from the hook). Optional — Claude only. */
  validateClearSuccessor?(
    workingDirectory: string,
    currentSessionId: string,
    candidateSessionId: string,
    startedAt?: string
  ): boolean;
  /** Re-read the full content of a previously-truncated tool_result. Returns null if the reader doesn't track this agent or tool result. */
  getFullToolResult?(agentId: string, toolUseId: string): Promise<string | null>;
}

export const TOOL_RESULT_TRUNCATE_BYTES = 20_000;

/**
 * Flatten a tool-result `content` field into a single string.
 *
 * Handles the union of shapes seen across providers:
 *   - Claude: `string` or `Array<{type:'text', text:string}>`
 *   - Codex:  `string`, or structured `{output, metadata}` (function_call_output),
 *             or array of `{type:'output_text'|'text', text}` blocks
 *   - Gemini: `Array<{functionResponse:{response:{output|text|error: string}}}>`
 */
export function flattenToolResultContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (typeof b.text === 'string') parts.push(b.text);
      else if (typeof b.output === 'string') parts.push(b.output);
      else if (b.functionResponse && typeof b.functionResponse === 'object') {
        const fr = b.functionResponse as Record<string, unknown>;
        const resp = fr.response;
        if (resp && typeof resp === 'object') {
          const r = resp as Record<string, unknown>;
          if (typeof r.output === 'string') parts.push(r.output);
          else if (typeof r.text === 'string') parts.push(r.text);
          else if (typeof r.error === 'string') parts.push(r.error);
        }
      }
    }
    return parts.join('\n');
  }
  if (typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.output === 'string') return c.output;
    if (typeof c.text === 'string') return c.text;
    if (Array.isArray(c.content)) return flattenToolResultContent(c.content);
  }
  return '';
}

export function truncateForChat(text: string): { content: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes <= TOOL_RESULT_TRUNCATE_BYTES) return { content: text, truncated: false };
  const sliced = text.slice(0, TOOL_RESULT_TRUNCATE_BYTES);
  return { content: sliced, truncated: true };
}

// ── Home-dir resolution (Windows host + WSL) ──────────────────────────
//
// WSL discovery used to run once per reader constructor and cache `null`
// forever when it failed. A cold WSL VM at app startup (the boot can exceed
// the 5 s `wsl.exe` timeout, and the `\\wsl.localhost` share isn't mounted
// until the VM is up) therefore permanently disabled chat/log attach for
// every WSL-workspace agent until an app restart. The resolver below is
// shared across all readers, lazy, and self-healing: a failed attempt is
// retried — throttled to once per `WSL_RESOLVE_RETRY_MS` so polls never
// stack synchronous `wsl.exe` spawns on the Electron main process — the
// next time any caller asks, so chat attaches as soon as WSL is reachable.

export const WSL_RESOLVE_RETRY_MS = 30_000;

/** Discover the Windows-visible UNC form of the WSL `$HOME` (e.g.
 *  `\\wsl.localhost\Ubuntu\home\me`). Returns null when WSL is unavailable. */
export type WslHomeDiscoverer = () => string | null;

function defaultDiscoverWslUncHome(): string | null {
  try {
    // `wslpath -w` asks WSL itself for the UNC form, so the distro name and
    // UNC host (`wsl.localhost` vs legacy `wsl$`) are no longer hardcoded.
    // The `|| echo "##$HOME"` arm covers ancient WSL builds without wslpath:
    // we then fall back to constructing the legacy hardcoded-Ubuntu UNC.
    const out = execFileSync(
      'wsl.exe',
      ['bash', '-lc', 'wslpath -w "$HOME" 2>/dev/null || echo "##$HOME"'],
      { encoding: 'utf-8', timeout: 5000, windowsHide: true },
    ).trim();
    if (out.startsWith('\\\\')) return out.replace(/[\\/]+$/, '');
    if (out.startsWith('##') && out.length > 2) {
      return `\\\\wsl.localhost\\Ubuntu${out.slice(2).replace(/\//g, '\\')}`;
    }
  } catch {
    // WSL not available (or a cold boot exceeded the timeout) — retry later.
  }
  return null;
}

let discoverWslUncHome: WslHomeDiscoverer = defaultDiscoverWslUncHome;
let wslUncHome: string | null = null;
let wslHomeLastAttemptMs = 0;
let wslHomeWarned = false;
const wslSubdirCache = new Map<string, { dir: string | null; lastAttemptMs: number }>();

/** Test hook: swap the `wsl.exe` discovery and reset all cached/throttle
 *  state. Pass null to restore the default discoverer. */
export function __setWslHomeDiscovererForTest(fn: WslHomeDiscoverer | null): void {
  discoverWslUncHome = fn ?? defaultDiscoverWslUncHome;
  wslUncHome = null;
  wslHomeLastAttemptMs = 0;
  wslHomeWarned = false;
  wslSubdirCache.clear();
}

function resolveWslUncHome(): string | null {
  if (wslUncHome) return wslUncHome;
  const now = Date.now();
  if (wslHomeLastAttemptMs && now - wslHomeLastAttemptMs < WSL_RESOLVE_RETRY_MS) return null;
  wslHomeLastAttemptMs = now;
  wslUncHome = discoverWslUncHome();
  if (!wslUncHome && !wslHomeWarned) {
    wslHomeWarned = true;
    console.warn(
      `[log-readers] WSL home discovery failed — retrying every ${WSL_RESOLVE_RETRY_MS / 1000}s until WSL is reachable`,
    );
  } else if (wslUncHome && wslHomeWarned) {
    console.log(`[log-readers] WSL home discovered after earlier failure: ${wslUncHome}`);
  }
  return wslUncHome;
}

/**
 * Lazily resolve `~/<subpath>` inside WSL as a Windows UNC dir
 * (e.g. `.claude/projects` → `\\wsl.localhost\Ubuntu\home\me\.claude\projects`).
 *
 * Returns null while WSL (or the dir) is unavailable; later calls retry,
 * throttled per subpath. A successful resolution is cached for the process
 * lifetime.
 */
export function resolveWslHomeSubdir(subpath: string): string | null {
  const cached = wslSubdirCache.get(subpath);
  if (cached?.dir) return cached.dir;
  const now = Date.now();
  if (cached && now - cached.lastAttemptMs < WSL_RESOLVE_RETRY_MS) return null;
  const entry = { dir: null as string | null, lastAttemptMs: now };
  wslSubdirCache.set(subpath, entry);
  const home = resolveWslUncHome();
  if (home) {
    const candidate = `${home}\\${subpath.split('/').filter(Boolean).join('\\')}`;
    try {
      if (fs.existsSync(candidate)) entry.dir = candidate;
    } catch {
      // unreachable share — retry on a later call
    }
  }
  return entry.dir;
}

/** Resolve `~/<subpath>` under the Windows `USERPROFILE`. Null when missing
 *  (cheap local check — callers may simply re-ask). */
export function resolveWindowsHomeSubdir(subpath: string): string | null {
  const userProfile = process.env.USERPROFILE || '';
  if (!userProfile) return null;
  const candidate = path.join(userProfile, ...subpath.split('/').filter(Boolean));
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Resolve a per-home subdirectory across both Windows host and WSL.
 *
 * Returns `{windowsDir, wslUncDir}` — either may be null if the dir doesn't
 * exist on that side. The WSL side delegates to the lazy/self-healing
 * resolver above, so repeated calls are cheap and a transient WSL outage at
 * one call site doesn't poison later ones.
 *
 * Example:
 *   resolveHomeSubdir('.codex/sessions')
 *     → { windowsDir: 'C:\\Users\\me\\.codex\\sessions',
 *         wslUncDir:  '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex\\sessions' }
 *
 * `subpath` is a forward-slash relative path under `~`. Both segments are
 * joined with the platform-appropriate separator.
 */
export function resolveHomeSubdir(subpath: string): {
  windowsDir: string | null;
  wslUncDir: string | null;
} {
  return {
    windowsDir: resolveWindowsHomeSubdir(subpath),
    wslUncDir: resolveWslHomeSubdir(subpath),
  };
}
