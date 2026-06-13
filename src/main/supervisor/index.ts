import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFileSync, execFile, spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { Agent, AgentStatus, ContextStats, LaunchAgentInput, QueryResult, Team } from '../../shared/types';
import {
  TMUX_SESSION_PREFIX, DEFAULT_COMMAND, DEFAULT_COMMAND_WSL, PROVIDER_COMMANDS,
  SUPERVISOR_AGENT_NAME, SUPERVISOR_AGENT_MD, SUPERVISOR_MEMORY_MD,
  SUPERVISOR_CLAUDE_SETTINGS_JSON, SUPERVISOR_CLAUDE_SETTINGS_JSON_V1,
  SUPERVISOR_RUN_ORCHESTRATION_SKILL, SUPERVISOR_ORCHESTRATION_SPIKE_SKILL,
  SCRIPT_READ_AGENT_LOG, SCRIPT_LIST_AGENTS, SCRIPT_SEND_MESSAGE, SCRIPT_GET_CONTEXT_STATS,
  WORKER_CLAUDE_MD, WORKER_CLAUDE_SETTINGS_JSON, WORKER_CLAUDE_SETTINGS_JSON_V2, WORKER_CLAUDE_SETTINGS_JSON_V3,
  WORKER_CLAUDE_SETTINGS_JSON_V4,
  WORKER_CODEX_CONFIG_TOML, WORKER_CODEX_CONFIG_TOML_V1, WORKER_CODEX_CONFIG_TOML_V2,
  DASHBOARD_STATUS_SCRIPT_MJS, DASHBOARD_STATUS_SCRIPT_MJS_V3, DASHBOARD_STATUS_SCRIPT_MJS_V4, DASHBOARD_STATUS_SCRIPT_MJS_V5,
  DASHBOARD_STATUS_SCRIPT_MJS_V6,
  CODEX_WORKER_PROFILE_NAME, CODEX_WORKER_PROFILE_TOML, HOOK_CANARY_WINDOW_MS,
  MAX_SUBMIT_RETRIES, HANDSHAKE_CONFIRM_WINDOW_MS, HANDSHAKE_CONFIRM_POLL_MS,
  TMUX_OPTION_MAX_AGE_MS, TMUX_OPTION_LAUNCH_SKEW_MS, STATUS_POLL_INTERVAL_MS,
} from '../../shared/constants';
import { getApiToken } from '../security/api-auth';
import { EventBridge, EventBridgeDeps } from './event-bridge';
import { TeamMessageDeliveryEngine } from './team-delivery';
import { WindowsRunner } from './windows-runner';
import { WslRunner, WslLaunchDiagnostics } from './wsl-runner';
import { StatusMonitor } from './status-monitor';
import type { StatusChangedEvent } from './status-events';
import { ContextStatsMonitor, JsonlFileActivity } from './context-stats-monitor';
import { SessionLogReader } from './session-log-reader';
import { ClaudeJsonlReader } from './log-readers/claude-jsonl-reader';
import { CodexRolloutReader } from './log-readers/codex-rollout-reader';
import { GeminiTranscriptReader } from './log-readers/gemini-transcript-reader';
import { AgentChatService } from './agent-chat-service';
import {
  snapshotCodexSessions,
  discoverNewCodexSession,
  findCodexSessionIdByCwd,
  ensureCodexResumeSessionId,
  shouldDiscoverCodexSession,
  selectFreshCodexRollouts,
  type DiscoveryResult,
} from './session-id-discovery';
import { listCodexRolloutFiles } from './log-readers/codex-rollout-reader';
import { FileActivityTracker } from './file-activity-tracker';
import {
  createAgent, getAgent, getActiveAgents, getAllAgents, getSupervisorAgent, getWorkspace, updateAgentStatus, updateAgentPid,
  updateAgentExitCode, incrementRestartCount, updateAgentLastOutput,
  updateAgentAttached, addEvent, deleteAgent as dbDeleteAgent,
  updateAgentResumeSessionId, addFileActivity, getTeamMembership, getAgentTemplate,
  getFileActivities, deleteFileActivitiesForAgent, updateAgentHookStatus,
  updateAgentLastSendError,
} from '../database';
import { detectPathType, windowsToWslPath, uncToWslPath, wslToWindowsPath } from '../path-utils';
import { getScriptPath } from './paths';
import { tmuxListSessions, tmuxSendInput, tmuxSendSubmit, tmuxReadStatusOptions, shQuote } from '../wsl-bridge';
import { getWindowsSubmitSequence } from './send-input-encoders';
import { HookSpoolTailer, resolveSpoolReadPath, canonicalSpoolKey } from './hook-spool-tailer';

// ── Codex hook-trust seeding (B8; docs/HOOK_SYSTEM_DESIGN.md §8.5) ──────
//
// Codex gates every hook behind a per-hook trust check keyed by a content hash
// of the hook command. When `ensureCodexHookProfile` rewrites the shared profile
// it must seed that trust itself, or every app restart re-gates Codex workers at
// the interactive trust-review panel (and `--dangerously-bypass-hook-trust` can
// only run *already-trusted* hooks, never a newly-added one). The hash recipe
// below was confirmed byte-for-byte against the values Codex 0.135 persisted when
// a user pressed `t` (the three ground-truth hashes in §8.5).

/** The verb each `[[hooks.<Event>]]` TOML table maps to in Codex's trust key
 *  (lower-snake event id used in the `[hooks.state]` key). */
const CODEX_HOOK_EVENT_IDS: Record<string, string> = {
  Stop: 'stop',
  UserPromptSubmit: 'user_prompt_submit',
  SessionStart: 'session_start',
};

interface CodexProfileHook { event: string; command: string }

/** Recursively sort object keys and drop null/undefined fields, so the result
 *  serializes to the compact, key-sorted JSON Codex hashes. */
function codexNormalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(codexNormalizeForHash);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === null || v === undefined) continue;
      out[k] = codexNormalizeForHash(v);
    }
    return out;
  }
  return value;
}

/** Compute Codex's `trusted_hash` for one hook command. The hashed identity is
 *  `{ event_name, hooks: [{ type:'command', command, timeout, async:false }] }`
 *  serialized as compact JSON with recursively-sorted keys. Verified against the
 *  real persisted hashes (§8.5). `timeout` defaults to 30 — the value the
 *  profile installs (Codex's own default would be 600). */
export function codexHookTrustHash(eventName: string, command: string, timeout = 30): string {
  const identity = {
    event_name: eventName,
    hooks: [{ type: 'command', command, timeout, async: false }],
  };
  const json = JSON.stringify(codexNormalizeForHash(identity));
  return 'sha256:' + crypto.createHash('sha256').update(json, 'utf-8').digest('hex');
}

/** Parse the substituted profile TOML for the hooks it installs, in document
 *  order, pairing each `[[hooks.<Event>.hooks]]` command with its event id.
 *  Reads the ACTUAL command strings (post `__SCRIPT__` substitution) so the
 *  seeded hashes can never drift from what Codex will hash at load time. */
export function parseCodexProfileHooks(profileToml: string): CodexProfileHook[] {
  const hooks: CodexProfileHook[] = [];
  let currentEvent: string | null = null;
  for (const raw of profileToml.split(/\r?\n/)) {
    const line = raw.trim();
    const hdr = line.match(/^\[\[hooks\.([A-Za-z]+)\]\]$/);
    if (hdr) { currentEvent = CODEX_HOOK_EVENT_IDS[hdr[1]] ?? null; continue; }
    const cmd = line.match(/^command\s*=\s*'(.*)'$/);
    if (cmd && currentEvent) hooks.push({ event: currentEvent, command: cmd[1] });
  }
  return hooks;
}

/** Build the `[hooks.state]` section pre-trusting every hook the profile
 *  installs, keyed exactly as Codex keys it: `<config-abs-path>:<event>:0:0`
 *  (one hook block / one command each ⇒ position is always 0:0). Only
 *  `trusted_hash` is written — that alone is what pressing `t` persists and is
 *  sufficient for hooks to fire (§8.5). `configAbsPath` must match the on-disk
 *  path form Codex sees: native backslashes on Windows, posix in WSL. */
export function buildCodexHooksStateSection(configAbsPath: string, hooks: CodexProfileHook[]): string {
  let out = '\n[hooks.state]\n';
  for (const h of hooks) {
    const hash = codexHookTrustHash(h.event, h.command);
    out += `\n[hooks.state.'${configAbsPath}:${h.event}:0:0']\n`;
    out += `trusted_hash = "${hash}"\n`;
  }
  return out;
}

/** A profile + seeded-trust write can be skipped iff the on-disk file already
 *  has the identical hook body AND every trusted_hash we'd seed. That makes a
 *  plain restart non-destructive (it never wipes a user's manual `t`) while
 *  still re-seeding when the body changes (new/edited hook ⇒ new command hash)
 *  or when trust is missing (a prior clobber wiped it). */
export function codexProfileTrustIntact(
  existing: string | null,
  profileBody: string,
  hooks: CodexProfileHook[],
): boolean {
  if (!existing) return false;
  const existingBody = existing.split(/\n?\[hooks\.state\]/)[0];
  if (existingBody.trimEnd() !== profileBody.trimEnd()) return false;
  return hooks.every(h => existing.includes(codexHookTrustHash(h.event, h.command)));
}

// ── Provider directory trust (BUG-25 family) ────────────────────────────
//
// Both CLIs gate startup on a per-directory trust list in user-global config:
//   - Codex: `~/.codex/config.toml` `[projects."<abs path>"] trust_level = "trusted"`.
//     In an untrusted dir Codex either prints the "add ... as a trusted project"
//     banner and skips project-local config (BUG-25), or — observed live in the
//     UAP_Phenomina workspace, codex 0.136 — dies silently the moment the
//     kickoff prompt arrives, with an empty log.
//   - Claude: `~/.claude.json` `projects["<abs path>"].hasTrustDialogAccepted`.
//     Untrusted dirs pop the interactive "Do you trust the files in this
//     folder?" dialog, which a headless worker can never answer.
// The dashboard knows every directory it launches agents into, so it seeds
// these entries at launch time. Gemini runs `--yolo` and has no equivalent
// gate today, so it is skipped.

/** The path-key variants Codex may match a Windows trusted project by.
 *  Codex 0.136 was observed rejecting a lowercase-only entry and accepting the
 *  exact-case / `\\?\`-extended forms; older entries on real machines are
 *  lowercase. Write all three so the trust survives codex version drift. */
export function codexTrustPathVariants(dir: string, pathType: string): string[] {
  if (pathType !== 'windows') return [dir.replace(/\/+$/, '') || dir];
  const exact = dir.replace(/\//g, '\\').replace(/\\+$/, '');
  return [...new Set([exact, exact.toLowerCase(), `\\\\?\\${exact}`])];
}

/** Append-only merge of `[projects.'<path>'] trust_level = "trusted"` blocks
 *  into the user-global codex config. Never rewrites existing content — new
 *  tables are appended at EOF, which is valid TOML regardless of what table
 *  the file currently ends in. Returns the new file content, or null when
 *  every path is already present (no write needed). */
export function mergeCodexProjectTrust(existing: string | null, dirs: string[]): string | null {
  const body = existing ?? '';
  const present = new Set<string>();
  // Literal (single-quoted) keys carry their bytes as-is; basic (double-quoted)
  // keys may contain backslash escapes, so the alternation must let `\"` pass
  // through the capture instead of terminating it.
  const keyRe = /^\s*\[projects\.(?:'([^']+)'|"((?:[^"\\]|\\.)+)")\]\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body)) !== null) {
    if (m[1] !== undefined) {
      // TOML literal string — byte-for-byte, no escapes.
      present.add(m[1]);
    } else {
      // TOML basic string — unescape before comparing, or an existing
      // escaped Windows key like [projects."C:\\Users\\x"] never matches the
      // single-backslash dir string and the merge appends a SEMANTICALLY
      // duplicate [projects.'C:\Users\x'] table, which makes the whole codex
      // config invalid (codex stops loading config entirely). Minimum
      // unescapes for path keys: `\\` → `\` and `\"` → `"`; other escapes
      // (\t, \n, \uXXXX) can't appear in real directory keys and are left raw.
      present.add(m[2].replace(/\\([\\"])/g, '$1'));
    }
  }
  let appended = '';
  for (const d of dirs) {
    if (present.has(d) || d.includes("'")) continue;  // single quote can't appear in a TOML literal key
    appended += `\n[projects.'${d}']\ntrust_level = "trusted"\n`;
    present.add(d);
  }
  if (!appended) return null;
  const sep = body.length > 0 && !body.endsWith('\n') ? '\n' : '';
  return body + sep + appended;
}

/** Merge `hasTrustDialogAccepted: true` into `~/.claude.json` project entries.
 *  Keys use Claude's observed on-disk form (forward slashes, exact case).
 *  Preserves every other field in an existing entry; refuses to touch a file
 *  it can't parse (never clobber the user's global Claude state). Returns the
 *  new file content, or null when nothing needs writing. */
export function mergeClaudeProjectTrust(existingJson: string | null, dirs: string[]): string | null {
  let root: Record<string, unknown> = {};
  if (existingJson && existingJson.trim().length > 0) {
    try {
      const parsed = JSON.parse(existingJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      root = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const projects = (root.projects && typeof root.projects === 'object' && !Array.isArray(root.projects))
    ? root.projects as Record<string, Record<string, unknown>>
    : {};
  root.projects = projects;
  let changed = false;
  for (const dir of dirs) {
    const entry = projects[dir];
    if (entry && typeof entry === 'object' && (entry as Record<string, unknown>).hasTrustDialogAccepted === true) continue;
    projects[dir] = {
      ...(entry && typeof entry === 'object' ? entry : {}),
      hasTrustDialogAccepted: true,
    };
    changed = true;
  }
  return changed ? JSON.stringify(root, null, 2) : null;
}

// ── Scaffold versioning (plans/scaffold-version-migration.md) ──────────

/** A managed scaffold-map entry. Per-file `version` is hand-bumped when the
 *  bundled `content` changes; `previousHashes` maps old version numbers to
 *  SHA-256 hex of the exact bundled content shipped at that version. Lets
 *  writeScaffoldMap distinguish "user-modified file" from "known managed
 *  v(n-1) file that just needs a silent upgrade." */
export interface ScaffoldFile {
  content: string;
  executable?: boolean;
  version: number;
  previousHashes?: Record<number, string>;
}

/** C1 — raised by `_doSendInput` when synchronous confirm-and-retry exhausts
 *  for a contract provider: the body was delivered but no turn ever started
 *  (every submit Enter was dropped). The chat-bar IPC path surfaces this via
 *  `onSendInputError`; fire-and-forget callers read the persisted
 *  `agent.lastSendError` instead. */
export class SubmitNotConfirmedError extends Error {
  readonly agentId: string;
  constructor(message: string, agentId: string) {
    super(message);
    this.name = 'SubmitNotConfirmedError';
    this.agentId = agentId;
  }
}

// WP-P2 — how long a pending `initialUserPrompt` (LaunchAgentInput) stays
// deliverable after launch. An agent that never reaches an input-accepting
// status inside this window (stuck launch, crash loop) must not receive a
// stale selection prompt minutes later.
const INITIAL_USER_PROMPT_TTL_MS = 10 * 60_000;

// ── P1 multi-transport hook delivery (plans/p1-hook-spool-multi-transport.md §2) ──

/** Which channel delivered a hook event to the central applier. */
export type HookTransport = 'http' | 'spool' | 'tmux-option';

/** One hook event record, normalized from any transport. The v7 hook script
 *  writes the SAME record to the spool, the HTTP POST body, and the tmux pane
 *  option, so the dedupe key `{ts, hookEventName, turnId}` is byte-identical
 *  across channels. `legacy: true` marks a v≤6 HTTP body (no
 *  hookEventName/turnId meta) — those bypass dedupe/freshness/ordering and get
 *  exactly today's behavior. */
export interface ParsedHookEvent {
  v?: number;
  /** Self-reported agent id (validated against the addressed agent when present). */
  agentId?: string;
  state: 'idle' | 'working' | 'active';
  /** Original hook source: 'hook-stop' | 'hook-start' | 'hook-session-start'.
   *  Kept for diagnostics; the source passed to the status flip is
   *  transport-determined (see applyHookStatusEvent step 8). */
  source?: string;
  /** Script-side Date.now() — the dedupe/ordering clock. NEVER used for
   *  stamping (the applier stamps with its own host-clock receivedAt). */
  ts: number;
  hookEventName?: string;
  turnId?: string;
  sessionId?: string;
  /** v≤6 HTTP body — bypass dedupe/freshness/ordering (steps 3–5). */
  legacy?: boolean;
}

export type HookApplyResult = 'applied' | 'duplicate' | 'stale' | 'invalid';

/** LRU cap for the per-agent applied-event dedupe registry. */
const APPLIED_HOOK_EVENTS_MAX = 200;

/** Sidecar tracks the on-disk version of every managed scaffold file in a
 *  workspace. Keyed by path relative to `.dashboard/`, no leading slash,
 *  forward slashes always. */
export const SCAFFOLD_SIDECAR_REL = '.dashboard/.scaffold-versions.json';
export const SCAFFOLD_LOCK_REL = '.dashboard/.scaffold-versions.lock';
const SCAFFOLD_LOCK_STALE_MS = 60_000;
const SCAFFOLD_LOCK_POLL_MS = 100;
const SCAFFOLD_LOCK_TIMEOUT_MS = 5_000;

/** SHA-256 hex of the pre-DASHBOARD_HOST `dashboard-status.mjs` shipped in
 *  every workspace scaffolded before the WSL-status fix landed. That script
 *  hardcoded `http://127.0.0.1:${port}` and swallowed `catch {}` — the
 *  WSL2 NAT-mode bug that motivates this migration. Used as the v1 entry
 *  in the v2 script's previousHashes so old workspaces upgrade silently
 *  instead of triggering a noisy `.bak.<ts>` backup. */
export const DASHBOARD_STATUS_SCRIPT_V1_HASH = '56df727b34103b7f4f206095a06ff3c5979209c872658c67a6d69021f761381f';

/** SHA-256 hex of the pre-UserPromptSubmit `dashboard-status.mjs` (the v2
 *  content with DASHBOARD_HOST + pending-status.jsonl logging, but the
 *  hard-coded `state: 'idle'` body). v3 reads state from argv[2] so a start
 *  hook can post `'working'`. Used in the v3 script's previousHashes for
 *  silent v2→v3 upgrade. */
export const DASHBOARD_STATUS_SCRIPT_V2_HASH = 'a6e27a1330e7cd499ed5be2b7b3a68ea902e5305afc2506b21393ef63aa0627e';

/** SHA-256 hex of the pre-UserPromptSubmit `.claude/settings.json` (Stop +
 *  SubagentStop only). v2 adds the UserPromptSubmit hook entry. Used in the
 *  v2 settings file's previousHashes for silent v1→v2 upgrade. */
export const WORKER_CLAUDE_SETTINGS_JSON_V1_HASH = 'a0dc44c8e6c086219a15a1e6799d02cf8abe5f24f07acb8c7dc011e6e4216c46';

/** SHA-256 hex of the v1 `.dashboard/supervisor/CLAUDE.md` (pre-GroupThink-v2
 *  references + pre-"Online research" section). v2 adds the v2 groupthink
 *  references in two places and the new "Online research" section. Used in
 *  the v2 file's previousHashes for silent v1→v2 upgrade. */
export const SUPERVISOR_AGENT_MD_V1_HASH = '2a18afb8be96fd6aa8589a351979b30786a303649d4247983a6826fd53b2be4d';

/** SHA-256 hex of the v1 `.dashboard/supervisor/.claude/skills/run-orchestration/SKILL.md`
 *  (pre-GroupThink-v2 catalog row). v2 adds the `groupthink-v2` row alongside
 *  the existing v1 row. Used in the v2 file's previousHashes for silent
 *  v1→v2 upgrade. */
export const SUPERVISOR_RUN_ORCHESTRATION_SKILL_V1_HASH = '90d7334faa42b08129a810db54c740796264143c5e10a4d2b469b7fb6040ab71';

/** SHA-256 hex of the v2 `.dashboard/supervisor/CLAUDE.md` (GroupThink-as-script
 *  references). v3 rewrites the "Multi-agent orchestration" Path 1 to the
 *  in-process `run_orchestration` MCP tool. Used in the v3 file's previousHashes
 *  for silent v2→v3 upgrade. */
export const SUPERVISOR_AGENT_MD_V2_HASH = '85993687d0bd2b17f94b95d8db45585ccbeca9477f0009151faa97bb8cb04723';

/** SHA-256 hex of the v2 `.dashboard/supervisor/.claude/skills/run-orchestration/SKILL.md`
 *  (script-launch playbook). v3 rewrites it MCP-first (run_orchestration /
 *  get_orchestration_run / abort_orchestration; legacy_command resume). Used in
 *  the v3 file's previousHashes for silent v2→v3 upgrade. */
export const SUPERVISOR_RUN_ORCHESTRATION_SKILL_V2_HASH = 'a8f79058f73df5a3aa2e17a1d0f66f100086413083a7b911b99daad06200cd74';

/** SHA-256 hex of the v3 `.dashboard/supervisor/CLAUDE.md` (pre-browser-tools).
 *  v4 appends the `<!-- section:browser-tools v1 -->` section (WP2-B, embedded
 *  browser MCP tools + for-human-action pattern + untrusted-content rule).
 *  Used in the v4 file's previousHashes for silent v3→v4 upgrade. */
export const SUPERVISOR_AGENT_MD_V3_HASH = 'd5b3e5fc2cc2c652b793ca390f948ed055b285f013a09df45f16b01b90c49114';

export function sha256Hex(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** B2 (HOOK_SYSTEM_DESIGN.md §C) — ensure a worker-lane codex command carries
 *  the dashboard hook profile + bypass flag so its turn-boundary hooks fire.
 *
 *  The pre-B2 code only instrumented the pristine framework-default command
 *  (`command === defaultCmd`); a workspace-customized or caller-supplied codex
 *  command ran hookless yet stayed worker-lane (PTY inference disabled) →
 *  permanently blind. This broadens to ANY recognizably-codex command:
 *  detect whether `--profile dashboard-worker` and
 *  `--dangerously-bypass-hook-trust` are present and inject whichever is
 *  missing immediately after the `codex` / `ccodex` launcher token (so the
 *  flags bind to codex itself, ahead of any subcommand like `resume`),
 *  preserving the rest of the command verbatim.
 *
 *  Returns `{ instrumented: false }` when the command can't be safely
 *  instrumented — it isn't recognizably codex (no `codex`/`ccodex` token), or
 *  it already pins a DIFFERENT `--profile` we must not clobber. The caller
 *  marks the agent hook_status='degraded' and warns rather than launch a
 *  worker-lane codex silently hookless. */
export function instrumentCodexWorkerCommand(
  command: string,
): { command: string; instrumented: boolean } {
  // Locate the codex launcher token (`codex` or `ccodex`) as a whole word,
  // tolerating a path prefix (`/usr/bin/ccodex`) but not a substring match
  // inside an unrelated token.
  const tokenMatch = command.match(/(^|\s)((?:[^\s]*[/\\])?c?codex)(?=\s|$)/);
  if (!tokenMatch) return { command, instrumented: false };

  // A foreign `--profile X` (X !== dashboard-worker) means the command is
  // pinned to another layered config we can't safely override — degrade.
  const profileMatch = command.match(/--profile(?:\s+|=)(\S+)/);
  const hasOurProfile = profileMatch?.[1] === CODEX_WORKER_PROFILE_NAME;
  if (profileMatch && !hasOurProfile) return { command, instrumented: false };

  const hasBypass = /--dangerously-bypass-hook-trust(?=\s|$)/.test(command);
  if (hasOurProfile && hasBypass) return { command, instrumented: true };

  const additions: string[] = [];
  if (!hasOurProfile) additions.push(`--profile ${CODEX_WORKER_PROFILE_NAME}`);
  if (!hasBypass) additions.push('--dangerously-bypass-hook-trust');

  const tokenEnd = tokenMatch.index! + tokenMatch[1].length + tokenMatch[2].length;
  const head = command.slice(0, tokenEnd);
  const tail = command.slice(tokenEnd);
  return { command: `${head} ${additions.join(' ')}${tail}`, instrumented: true };
}

/** Strip the leading `.dashboard/` segment from a scaffold-map relPath so
 *  the sidecar key is stable across map reshuffles. `\` is normalized to
 *  `/` to keep Windows and WSL keys identical. */
export function normalizeManagedKey(relPath: string): string {
  let s = relPath.replace(/\\/g, '/');
  if (s.startsWith('.dashboard/')) s = s.slice('.dashboard/'.length);
  return s.replace(/^\/+/, '');
}

function timestampForFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
         `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${process.pid}`;
}

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const WINDOWS_SEND_INPUT_ENTER_DELAY_MS = 80;
const WINDOWS_CODEX_TYPING_DELAY_MS = 8;
// Chars per PTY write in the codex/gemini Windows send loop. Was 1 (per-char).
// Empirically, codex's paste-burst detector does not trip up to at least 512
// chars per write so long as writes are separated by WINDOWS_CODEX_TYPING_DELAY_MS;
// 64 is a conservative choice that gives a ~30× speedup on multi-KB sends
// (e.g. GroupThink relays) while keeping a wide safety margin.
const WINDOWS_CODEX_TYPING_CHUNK_SIZE = 64;

// Win32 Input Mode CSI sequence for a VK_RETURN keypress (down + up).
// Codex/gemini on Windows enable mode ?9001h and expect submit as a real
// key event, not the auto-converted single KEY_DOWN ConPTY emits for raw '\r'.
// Format: ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _
const WIN32_KEY_ENTER_DOWN = '\x1b[13;28;13;1;0;1_';
const WIN32_KEY_ENTER_UP = '\x1b[13;28;13;0;0;1_';
// Shift+Enter — inserts a newline in codex's prompt without submitting.
// Cs=16 = SHIFT_PRESSED.
const WIN32_KEY_SHIFT_ENTER_DOWN = '\x1b[13;28;13;1;16;1_';
const WIN32_KEY_SHIFT_ENTER_UP = '\x1b[13;28;13;0;16;1_';

/** Recover the workspace root from an agent whose cwd is a persona subdirectory.
 *  Matches both legacy `.claude/agents/<name>` (still used by persona-scanner) and
 *  the new `.dashboard/supervisor` layout. */
function getEffectiveWorkspaceRoot(agent: Agent): string {
  const unixDashboardMatch = agent.workingDirectory.match(/^(.+)\/\.dashboard\/supervisor\/?$/);
  if (unixDashboardMatch) return unixDashboardMatch[1];
  const winDashboardMatch = agent.workingDirectory.match(/^(.+)\\\.dashboard\\supervisor\\?$/);
  if (winDashboardMatch) return winDashboardMatch[1];
  const unixWorkerMatch = agent.workingDirectory.match(/^(.+)\/\.dashboard\/workers\/[^/]+\/?$/);
  if (unixWorkerMatch) return unixWorkerMatch[1];
  const winWorkerMatch = agent.workingDirectory.match(/^(.+)\\\.dashboard\\workers\\[^\\]+\\?$/);
  if (winWorkerMatch) return winWorkerMatch[1];
  const unixMatch = agent.workingDirectory.match(/^(.+)\/\.claude\/agents\/[^/]+\/?$/);
  if (unixMatch) return unixMatch[1];
  const winMatch = agent.workingDirectory.match(/^(.+)\\\.claude\\agents\\[^\\]+\\?$/);
  if (winMatch) return winMatch[1];
  return agent.workingDirectory;
}

function formatBracketedPaste(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const body = normalized
    .replaceAll(BRACKETED_PASTE_START, '')
    .replaceAll(BRACKETED_PASTE_END, '');
  return `${BRACKETED_PASTE_START}${body}${BRACKETED_PASTE_END}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Grace window before lazy cwd-match recovery is allowed to fire for a codex
// agent with a null resumeSessionId. Must exceed the authoritative SQL
// discovery timeout (DEFAULT_SQL_POLL_TIMEOUT_MS = 35 s in
// session-id-discovery.ts) plus slack for the async DB write + dispatcher
// pickup, so recovery never hijacks a still-resolving live launch (BUG-29).
const CODEX_DISCOVERY_GRACE_MS = 45_000;

// Stale-rollout hardening (sibling bug in
// docs/BUG_claude-child-session-env-poisoning.md): when recovery finds no
// rollout fresher than the agent's launch, it polls for one on this cadence
// instead of binding a pre-existing (stale) rollout. Window sized for codex's
// observed slow starts (interactive update prompt, ~1 s startup race).
const CODEX_SID_RECOVERY_POLL_INTERVAL_MS = 2_000;
const CODEX_SID_RECOVERY_POLL_WINDOW_MS = 60_000;

/**
 * Parse a SQLite `datetime('now')` timestamp ("YYYY-MM-DD HH:MM:SS", UTC, no
 * zone marker) to epoch ms. `Date.parse` treats the bare space-form as LOCAL
 * time, which would skew an age computation by the full timezone offset, so we
 * normalize to ISO-UTC first. Falls through to plain `Date.parse` for any
 * already-ISO value; returns null when unparseable.
 */
function parseSqliteUtcMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const ms = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)
    ? Date.parse(s.replace(' ', 'T') + 'Z')
    : Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeCodexArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--full-auto') {
      out.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (arg === '--ask-for-approval' || arg === '-a') {
      i++;
    } else if (arg.startsWith('--ask-for-approval=')) {
      continue;
    } else {
      out.push(arg);
    }
  }
  return out;
}

function buildCodexResumeArgs(baseArgs: string[], sessionId: string): string[] {
  const args = normalizeCodexArgs(baseArgs).filter((arg) => arg !== 'resume');
  return ['resume', ...args, sessionId];
}

/** Matches a bash command-prefix variable assignment like `AGENT_ID=value`.
 *  Bash treats these as env-var assignments only when they appear *unquoted*
 *  at the start of a simple command — single-quoting the whole token turns
 *  it into a literal command name (`AGENT_ID=...: command not found`). */
const SHELL_ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Build the WSL bash command string for `codex resume <session-id>`.
 *
 *  The input `command` may have one or more leading bash command-prefix env
 *  assignments (e.g. `AGENT_ID=… DASHBOARD_PORT=… DASHBOARD_HOST=… ccodex …`).
 *  Those tokens MUST stay unquoted and at the front of the rendered string so
 *  bash parses them as variable assignments for the codex invocation; we only
 *  single-quote the codex executable and its args. The `resume` subcommand
 *  and the session-id positional are inserted in the right place relative to
 *  the codex executable (NOT in front of the env vars). */
export function buildCodexResumeCommand(command: string, sessionId: string): string {
  const parts = command.split(/\s+/).filter(Boolean);
  let envEnd = 0;
  while (envEnd < parts.length && SHELL_ENV_ASSIGNMENT_RE.test(parts[envEnd])) envEnd++;
  const envPrefix = parts.slice(0, envEnd);
  const cmd = parts[envEnd] || 'codex';
  const args = buildCodexResumeArgs(parts.slice(envEnd + 1), sessionId);
  const cmdAndArgs = [cmd, ...args].map(shellSingleQuote).join(' ');
  return envPrefix.length > 0 ? `${envPrefix.join(' ')} ${cmdAndArgs}` : cmdAndArgs;
}

function parseQueryResponse(stdout: string): QueryResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { result: '', sessionId: '', isError: false };
  }

  // Try parsing the whole output as JSON first (works for Windows/clean stdout)
  try {
    const parsed = JSON.parse(trimmed);
    return {
      result: parsed.result || trimmed,
      sessionId: parsed.session_id || '',
      isError: false,
    };
  } catch {
    // WSL: login shell profile scripts may print to stdout before the JSON.
    // Scan backwards for the last line that looks like JSON.
    const lines = trimmed.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('{')) {
        try {
          const parsed = JSON.parse(line);
          return {
            result: parsed.result || line,
            sessionId: parsed.session_id || '',
            isError: false,
          };
        } catch {
          continue;
        }
      }
    }
    // No JSON found — return raw output as the result
    return { result: trimmed, sessionId: '', isError: false };
  }
}

function formatQueryError(err: Error | null, stdout: string, stderr: string): QueryResult {
  const parts = [stderr.trim(), stdout.trim(), err?.message || ''].filter(Boolean);
  return {
    result: parts.join('\n') || 'Query failed',
    sessionId: '',
    isError: true,
  };
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function getWindowsSystemPath(...parts: string[]): string {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', ...parts);
}

function findWindowsClaudePath(_env: NodeJS.ProcessEnv): Promise<string> {
  // Use known install path directly — avoids all PATH/shell resolution issues in Electron
  const knownPath = path.join(process.env.USERPROFILE || 'C:\\Users\\turke', '.local', 'bin', 'claude.exe');
  if (fs.existsSync(knownPath)) {
    return Promise.resolve(knownPath);
  }

  // Fallback: try where.exe through cmd.exe
  return new Promise<string>((resolve, reject) => {
    execFile(getWindowsSystemPath('cmd.exe'), ['/c', 'where', 'claude'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message || 'Failed to locate claude'));
        return;
      }

      const match = stdout
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => /claude(\.exe)?$/i.test(line));

      if (!match) {
        reject(new Error('Failed to locate claude'));
        return;
      }

      resolve(match);
    });
  });
}

export class AgentSupervisor extends EventEmitter {
  private windowsRunners = new Map<string, WindowsRunner>();
  private wslRunners = new Map<string, WslRunner>();
  private fileTrackers = new Map<string, FileActivityTracker>();
  private monitor: StatusMonitor;
  private contextStatsMonitor: ContextStatsMonitor;
  private sessionLogReader: SessionLogReader;
  private chatService: AgentChatService;
  private logsDir: string;

  // Class IV — the actually-bound API server port, injected as DASHBOARD_PORT
  // into supervised-worker process env so their Stop hook can POST to the
  // right port (handles api-server.ts EADDRINUSE auto-increment).
  // src/main/index.ts calls setApiServerPort after apiServer.start().
  private apiServerPort: number = 24678;

  // L-C — cached WSL→Windows-host gateway IP. WSL2's default NAT mode means
  // 127.0.0.1 inside the distro is the distro's loopback, NOT the Windows
  // host's, so a Class IV supervised-worker hook fired from WSL needs the
  // Windows host's address to reach the dashboard ApiServer. Resolved once
  // via `wsl.exe ip route show default` (same pattern used by
  // ensureMcpConfig around lines 786-825) and reused across all subsequent
  // WSL launches in this supervisor instance. Null until first resolve.
  private wslGatewayIp: string | null = null;
  /** Per-runtime guard so the codex hook profile is (re)written at most once
   *  per process per pathType — see ensureCodexHookProfile. */
  private codexHookProfileEnsured = new Set<string>();
  /** Directories already trust-seeded this app run, keyed by
   *  `pathType|provider|dirs` — avoids re-reading user-global config on every
   *  launch into an already-provisioned workspace. */
  private providerTrustEnsured = new Set<string>();

  /** Gap between agent respawns in reconcile() so N claude.exe startup
   *  write-bursts against the shared ~/.claude.json don't synchronize.
   *  Env-overridable for tuning during verification without rebuild loops.
   *  See plans/claude-json-corruption-mitigation-v2.md. */
  private static readonly RECONCILE_STAGGER_MS =
    Number(process.env.DASHBOARD_RECONCILE_STAGGER_MS ?? 2500);

  /** Set by drainForShutdown(). Suppresses auto-restart and keeps drained
   *  agents at their pre-quit status (not 'done') so reconcile() respawns
   *  them with --continue at next startup. */
  private shuttingDown = false;

  // Event bridge — supervisor notification, cooldown, queue, drain state lives here.
  private bridge: EventBridge;

  // Team message delivery
  private teamDeliveryEngine: TeamMessageDeliveryEngine;

  // Per-agent serial input queue. The Windows codex/gemini path types one
  // character at a time at WINDOWS_CODEX_TYPING_DELAY_MS to dodge the
  // paste-burst dialog, so a single send can take 30+ seconds for a few KB
  // of text. We chain sends per agent so two callers can't interleave their
  // typing into a single prompt buffer, and we expose `isInputInFlight` so
  // the HTTP layer can both reject concurrent sends and report status as
  // 'working' while typing is in progress (the status monitor cannot infer
  // 'working' on its own here — typed-char echoes do not count as a
  // "meaningful burst", so it would otherwise read 'idle' the entire time).
  private inputQueues = new Map<string, Promise<unknown>>();
  private inputInFlight = new Set<string>();

  // BUG-11: epoch-ms of the last user-initiated PTY write per agent. Bumped
  // in `writeToAgent` (the only entrypoint for user-driven bytes — xterm
  // keystrokes, paste, file-drop, query-injection). NOT bumped by
  // `_doSendInput`, which writes through `runner.write` / `tmuxSendInput`
  // directly. The event bridge reads this via `getLastUserPtyWriteAt` to
  // defer auto-submitting events while the user is actively typing.
  private lastUserPtyWriteAt = new Map<string, number>();

  // ── P1 multi-transport hook state (plans/p1-hook-spool-multi-transport.md §2) ──
  // Applied-event dedupe registry: agentId → insertion-ordered Set of
  // `${ts}:${hookEventName}:${turnId}` keys, LRU-capped at
  // APPLIED_HOOK_EVENTS_MAX per agent. ONLY applyHookStatusEvent touches it —
  // no transport dedupes on its own.
  private appliedHookEvents = new Map<string, Set<string>>();
  // Ordering guard: highest event `ts` applied per agent. An event with an
  // older ts than this is 'stale' (a laggy spool/tmux read must not flap a
  // newer HTTP-applied state).
  private lastAppliedHookTs = new Map<string, number>();
  // §2 step 4a current-launch guard — wallclock stamped IMMEDIATELY BEFORE the
  // actual runner launch (both lanes). A tmux-option event older than this
  // launch (minus TMUX_OPTION_LAUNCH_SKEW_MS) belongs to a previous run of the
  // pane and is rejected as 'stale'. Distinct from the monitor's BUG-23
  // `launchedAt`, which is cleared on promotion and therefore not durable.
  private launchStartedAt = new Map<string, number>();
  // Stale-rollout hardening: agent ids with an active bounded poll waiting for
  // a fresh-enough codex rollout (see startCodexSidRecoveryPoll). Guards
  // against stacking concurrent polls when chat reads retrigger recovery.
  private codexSidRecoveryPolls = new Set<string>();
  // Rate limiter for invalid-event warnings (per agent, 60 s).
  private lastInvalidHookWarnAt = new Map<string, number>();
  // §3 — spool tailers, keyed by CANONICAL spool read path (the resolved
  // Windows-side path the tailer actually opens — UNC form for WSL
  // workspaces), NOT by workspace id: the same logical workspace reached via
  // Windows and WSL path forms must never spawn two tailers on one file.
  // Created on the first worker-lane launch resolving to that path, disposed
  // when the last worker using it stops.
  private spoolTailers = new Map<string, HookSpoolTailer>();
  // spool key → agent ids currently using it (drives disposal).
  private spoolUsers = new Map<string, Set<string>>();
  // agent id → its spool key (reverse index for release on exit/delete).
  private agentSpoolKey = new Map<string, string>();
  // §4 — counts transport-poller invocations so the tmux pane-option poll
  // runs every 4th tick (~6 s at the 1.5 s poll cadence).
  private hookTransportTick = 0;
  // §4 — guards against overlapping async tmux polls on slow wsl.exe.
  private tmuxOptionPollInFlight = false;

  // WP-P2 (plans/selection-to-agent-primitive-plan.md §7) — pending initial
  // USER prompts for freshly-launched agents, delivered exactly once on the
  // FIRST persisted transition into an input-accepting status
  // (idle|waiting|done) while a live runner exists. Deliberately separate
  // from the launch-time positional-arg agentMdPrompt path (§1.6): the
  // prompt must arrive as a clean user message on every provider, with zero
  // risk of duplicating or reordering launch instructions. Entries expire
  // after INITIAL_USER_PROMPT_TTL_MS and are cleared on agent stop/delete.
  private pendingInitialPrompts = new Map<string, { text: string; expiresAt: number }>();

  constructor() {
    super();
    const appData = process.env.APPDATA || path.join(process.env.HOME || '', '.config');
    this.logsDir = path.join(appData, 'AgentDashboard', 'logs');
    if (!fs.existsSync(this.logsDir)) fs.mkdirSync(this.logsDir, { recursive: true });

    this.monitor = new StatusMonitor(
      (agent) => this.checkAlive(agent),
      (agentId) => this.getLastMeaningfulBurstTime(agentId),
      (agentId) => getAgent(agentId),
      () => Date.now(),
      // P2-02: PTY ring tail for PromptPatternDetector. Falls back through
      // both runner maps; empty string when no runner exists (terminal /
      // not-yet-launched). The runners' ring buffers are advanced in the
      // same data handler that advances `_lastMeaningfulBurst`.
      (agentId) => {
        const win = this.windowsRunners.get(agentId);
        if (win) return win.getOutputRingTail();
        const wsl = this.wslRunners.get(agentId);
        if (wsl) return wsl.getOutputRingTail();
        return '';
      },
      // BUG-09 §3.5 — raw PTY-byte timestamp keeps a `working` agent alive
      // during Coalescing / spinner-only phases.
      (agentId) => this.getLastRawOutputTime(agentId),
    );

    // BUG-10 — give the monitor a way to replay a dropped submit keystroke.
    this.monitor.setResubmitHandler((agentId) => this.resubmitEnter(agentId));
    // Submit-confirmation (plan §coordination) — centralize the contract-vs-
    // fallback matrix in `usesSubmitConfirmation` and share it with the monitor
    // so the reactive resend poller skips contract providers (the synchronous
    // path owns their re-press; reactive stays the fallback for the rest).
    this.monitor.setSubmitConfirmationPredicate((agent) => this.usesSubmitConfirmation(agent));
    // Handoff handshake — route the stalled-worker watchdog to the workspace
    // supervisor as a worker_stalled [DASHBOARD EVENT]. The bridge re-gates
    // on isSupervised, so plain (unsupervised) workers stay console-only.
    this.monitor.setWorkerStalledHandler((agent, stalledForMs) => {
      void this.bridge.onWorkerStalled({ agent, stalledForMs });
    });
    // P1 §3 — single hook-transport poller: StatusMonitor.poll() invokes this
    // exactly once at the top of every tick, before any per-agent
    // watchdog/canary work. Drains all spool tailers synchronously and fires
    // the (async) tmux pane-option poll every 4th tick.
    this.monitor.setHookTransportPoller(() => this.pollHookTransports());

    const bridgeDeps: EventBridgeDeps = {
      getAgent: (id) => getAgent(id),
      getSupervisorForWorker: (worker) => getSupervisorAgent(worker.workspaceId),
      sendInput: async (supervisorId, text) => { await this.sendInput(supervisorId, text); },
      addAuditEvent: (agentId, type, payload) => { addEvent(agentId, type, payload); },
      getAgentLog: (agentId, lines) => this.getAgentLog(agentId, lines),
      getContextStats: (agentId) => this.contextStatsMonitor.getStats(agentId),
      now: () => Date.now(),
      scheduleDrain: (ms, fn) => {
        const handle = setTimeout(fn, ms);
        return { cancel: () => clearTimeout(handle) };
      },
      statusMonitor: {
        forceIdle: (agentId, source) => this.monitor.forceIdle(agentId, source),
        forceWaiting: (agentId, kind, excerpt) => this.monitor.forceWaiting(agentId, kind, excerpt),
        forceWorking: (agentId, opts) => this.monitor.forceWorking(agentId, opts),
      },
      getLastUserPtyWriteAt: (id) => this.lastUserPtyWriteAt.get(id),
      // BUG-20: feed the bridge the clean assistant chat message + recent
      // file activities so idle events render real prose instead of Claude
      // Code TUI footer chrome, and surface what the agent just touched.
      getLastAssistantMessage: async (id) => {
        const messages = await this.chatService.getMessages(id, {
          limit: 1,
          role: 'assistant',
        });
        return messages[0]?.content;
      },
      getFileActivities: (id) => getFileActivities(id),
    };
    this.bridge = new EventBridge(bridgeDeps);

    // Monitor-sourced status changes: forward on the supervisor's public emitter
    // (so IPC handlers, ws-server, and team-delivery still receive them) and
    // feed the bridge with a 'monitor' source tag.
    this.monitor.on('statusChanged', (data) => {
      this.emit('statusChanged', { ...data, source: 'monitor' });
      // Handle auto-restart on crash
      const agent = getAgent(data.agentId);
      if (agent && data.status === 'crashed' && agent.autoRestartEnabled) {
        this.handleAutoRestart(agent);
      }
      void this.bridge.onStatusChanged({ ...data, source: 'monitor' });
    });

    // Direct emits from this supervisor (runner-exit / launch / restart / stop /
    // restart-failed) still need to reach the bridge — those paths bypass
    // StatusMonitor. Dedup against the monitor listener above by skipping
    // events whose source is 'monitor' (or missing, for legacy callers).
    this.on('statusChanged', (data: StatusChangedEvent | undefined) => {
      if (data && data.source && data.source !== 'monitor') {
        void this.bridge.onStatusChanged(data);
      }
    });

    // WP-P2 — every persisted status transition flows through a
    // supervisor-level 'statusChanged' emission (monitor-sourced ones are
    // re-emitted above; runner-exit / launch / restart / stop emit directly),
    // so this listener is the single choke-point for delivering a pending
    // initial user prompt on the first input-accepting transition.
    this.on('statusChanged', (data: StatusChangedEvent | undefined) => {
      if (data) this.maybeDeliverInitialUserPrompt(data.agentId, data.status);
    });

    // Typed session-event reader — single source of truth for JSONL tailing.
    // ContextStatsMonitor consumes its 'usage' + 'tool-use' events.
    this.sessionLogReader = new SessionLogReader(() => {
      const agents = getActiveAgents();
      return agents
        .filter(a => a.resumeSessionId || a.provider === 'codex' || a.provider === 'gemini')
        .map(a => ({
          agentId: a.id,
          sessionId: a.resumeSessionId || '',
          workingDirectory: a.workingDirectory,
          provider: a.provider,
          startedAt: a.createdAt,
        }));
    });
    this.sessionLogReader.register(new ClaudeJsonlReader());
    this.sessionLogReader.register(new CodexRolloutReader());
    this.sessionLogReader.register(new GeminiTranscriptReader());
    this.sessionLogReader.on('chat-events', (batch) => {
      this.emit('chatEvents', batch);
      this.bridge.onChatEvents(batch);
    });

    this.contextStatsMonitor = new ContextStatsMonitor(this.sessionLogReader);
    this.chatService = new AgentChatService(this.sessionLogReader);

    this.contextStatsMonitor.on('statsChanged', (stats: ContextStats) => {
      this.emit('contextStatsChanged', stats);
      // Event bridge: check context thresholds for supervised agents
      this.bridge.onContextStatsChanged(stats);
    });

    // JSONL-based file activity tracking (reliable for both Windows and WSL agents)
    this.contextStatsMonitor.on('fileActivity', (activity: JsonlFileActivity) => {
      const dbActivity = addFileActivity(activity.agentId, activity.filePath, activity.operation);
      if (dbActivity) {
        this.emit('fileActivity', dbActivity);
      }
    });

    // BUG-26 Layer 2 + 3: when chat-layer `rebindAgent` fires for an agent
    // whose pre-binding events were misattributed under the cwd fallback,
    // drop both downstream caches that derive from those events but don't
    // subscribe to chat events directly. The dispatcher already cleared
    // its own ring buffer; this listener owns the parts it doesn't reach:
    //   - `ContextStatsMonitor` per-agent maps (`stats`, `seenUuids`,
    //     `seenFiles`, `pendingShellActivity[agentId:*]`) so cached
    //     context% / token-count snapshots stop showing the wrong
    //     rollout's numbers between rebind and the agent's next usage tick.
    //   - The `file_activities` DB table, which is INSERT-only at the
    //     producer side and otherwise persists wrong-attribution rows
    //     into every future `idle` event's `Files touched:` list.
    // `fileActivitiesPurged` notifies the dashboard UI so any cached
    // per-agent file-list view can clear (matches the behavior on agent
    // deletion).
    this.sessionLogReader.on('agent-rebound', ({ agentId }) => {
      this.contextStatsMonitor.invalidateAgent(agentId);
      deleteFileActivitiesForAgent(agentId);
      this.emit('fileActivitiesPurged', agentId);
    });

    // Update registry whenever any status changes
    this.on('statusChanged', () => this.writeAgentRegistry());
    this.on('agentDeleted', () => this.writeAgentRegistry());

    // Team message delivery engine
    this.teamDeliveryEngine = new TeamMessageDeliveryEngine(this);
  }

  start(): void {
    this.monitor.start();
    this.contextStatsMonitor.start();
    this.sessionLogReader.start();
    this.teamDeliveryEngine.start();
  }

  stop(): void {
    this.monitor.stop();
    this.contextStatsMonitor.stop();
    this.sessionLogReader.stop();
    this.teamDeliveryEngine.stop();
  }

  /** Graceful pre-quit drain. Windows claude.exe processes share
   *  ~/.claude.json and die mid-write under tree-kill; ask each to /exit
   *  SEQUENTIALLY (parallel exits would herd their final config flushes —
   *  the same race this drains). Non-claude providers get a plain kill():
   *  they don't write ~/.claude.json and /exit into their TUIs is undefined.
   *  WSL runners are only detached: their claude writes the distro's own
   *  ~/.claude.json, and tmux sessions outlive Electron by design. */
  async drainForShutdown(perAgentTimeoutMs = 4000, totalBudgetMs = 15000): Promise<void> {
    this.shuttingDown = true;
    const deadline = Date.now() + totalBudgetMs;
    for (const [id, runner] of [...this.windowsRunners]) {
      const provider = getAgent(id)?.provider;
      const remaining = deadline - Date.now();
      if (provider !== 'claude' || remaining <= 0) {
        if (provider === 'claude') console.warn(`[shutdown] drain budget exhausted — hard-killing ${id}`);
        runner.kill();
        this.windowsRunners.delete(id);
        continue;
      }
      const clean = await runner.gracefulExit(Math.min(perAgentTimeoutMs, remaining));
      if (!clean) console.warn(`[shutdown] ${id} did not /exit within budget — killed`);
      this.windowsRunners.delete(id);
    }
    for (const [, runner] of [...this.wslRunners]) {
      runner.detachHost();
    }
  }

  getContextStats(agentId: string): ContextStats | null {
    return this.contextStatsMonitor.getStats(agentId);
  }

  getSessionLogReader(): SessionLogReader {
    return this.sessionLogReader;
  }

  getChatService(): AgentChatService {
    return this.chatService;
  }

  getSupervisorAgent(workspaceId: string): Agent | null {
    return getSupervisorAgent(workspaceId);
  }

  /** Write ~/.claude/agent-registry.json so other Claude instances can discover agents */
  private writeAgentRegistry(): void {
    try {
      const agents = getAllAgents();
      const registry = {
        updatedAt: new Date().toISOString(),
        agents: agents
          .filter(a => a.resumeSessionId && a.status !== 'done')
          .map(a => ({
            id: a.id,
            title: a.title,
            status: a.status,
            sessionId: a.resumeSessionId,
            workingDirectory: getEffectiveWorkspaceRoot(a),
            roleDescription: a.roleDescription || '',
          })),
      };
      const registryPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'agent-registry.json');
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    } catch (err) {
      console.error('[registry] Failed to write agent registry:', err);
    }
  }

  async launchAgent(input: LaunchAgentInput): Promise<Agent> {
    const workspace = getWorkspace(input.workspaceId);
    if (!workspace) throw new Error('Workspace not found');

    // Resolve template defaults if launching from a template
    let resolvedInput = { ...input };
    if (input.templateId) {
      const template = getAgentTemplate(input.templateId);
      if (template) {
        resolvedInput = {
          ...resolvedInput,
          roleDescription: input.roleDescription || template.roleDescription || undefined,
          provider: input.provider || template.provider,
          command: input.command || template.command || undefined,
          autoRestartEnabled: input.autoRestartEnabled ?? template.autoRestart,
          isSupervisor: input.isSupervisor ?? template.isSupervisor,
          isSupervised: input.isSupervised ?? template.isSupervised,
          isWorker: input.isWorker ?? template.isWorker,
          systemPrompt: input.systemPrompt || template.systemPrompt || undefined,
        };
        console.log(`[supervisor] Resolved template "${template.name}" (${template.id}) for agent "${input.title}"`);
      }
    }

    // Prevent duplicate supervisors per workspace
    if (resolvedInput.isSupervisor) {
      const existing = getSupervisorAgent(resolvedInput.workspaceId);
      if (existing && !['done', 'crashed'].includes(existing.status)) {
        throw new Error(`Supervisor already running for this workspace (${existing.id})`);
      }
    }

    let workDir = resolvedInput.workingDirectory || workspace.path;
    const pathType = detectPathType(workDir);
    // Convert UNC WSL paths (\\wsl.localhost\...) to Linux paths (/home/...)
    if (pathType === 'wsl' && workDir.startsWith('\\\\')) {
      workDir = uncToWslPath(workDir);
    }
    const provider = resolvedInput.provider || 'claude';
    const defaultCmd = PROVIDER_COMMANDS[provider][pathType];
    // The "worker lane": hook-based status + .dashboard/workers/<provider>/ cwd +
    // hook scaffold. A supervised worker is a worker that also notifies a
    // supervisor, so isSupervised implies the lane; isWorker alone is the default
    // for user-launched claude/codex agents (no supervisor notification).
    const isWorkerLane = !!resolvedInput.isSupervised || !!resolvedInput.isWorker;
    // If the workspace's defaultCommand is one of the framework defaults
    // (Windows or WSL), respect the provider override. Otherwise the workspace
    // has a customized launch command and we use it verbatim.
    const isFrameworkDefault =
      workspace.defaultCommand === DEFAULT_COMMAND || workspace.defaultCommand === DEFAULT_COMMAND_WSL;
    let command = resolvedInput.command || (isFrameworkDefault ? defaultCmd : workspace.defaultCommand);
    // Class IV codex hooks: codex never loads the worker-cwd .codex/config.toml
    // (it's not a trusted project), so turn-boundary hooks must ride a
    // `--profile` file in CODEX_HOME instead. `--dangerously-bypass-hook-trust`
    // removes the per-hook trust gate so an automated launch never stalls on an
    // interactive trust prompt. B2 (HOOK_SYSTEM_DESIGN.md §C): inject these
    // flags into ANY worker-lane codex command (not just the pristine default);
    // if the command can't be safely instrumented, remember to mark the agent
    // hook_status='degraded' (set below, once the agent row exists).
    let codexHookDegraded = false;
    if (isWorkerLane && provider === 'codex') {
      const instrumented = instrumentCodexWorkerCommand(command);
      if (instrumented.instrumented) {
        command = instrumented.command;
      } else {
        codexHookDegraded = true;
        console.warn(
          `[hook-b2] worker-lane codex command could not be safely instrumented ` +
          `with --profile ${CODEX_WORKER_PROFILE_NAME} --dangerously-bypass-hook-trust ` +
          `(command: ${JSON.stringify(command)}). Marking hook_status='degraded' — ` +
          `this worker runs hookless and its status will be stale.`,
        );
      }
    }
    const agentId = uuidv4().substring(0, 8);
    const logPath = path.join(this.logsDir, `${agentId}.log`);

    let tmuxSessionName: string | null = null;

    if (pathType === 'wsl') {
      const slug = resolvedInput.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 20);
      tmuxSessionName = `${TMUX_SESSION_PREFIX}${slug}__${agentId}`;
    }

    // Set cwd so Claude Code discovers the agent's CLAUDE.md natively as system
    // instructions (not sent as a user message). Scaffold and MCP config are
    // written using the workspace root (workDir) first.
    //   - persona agents (legacy): .claude/agents/<name>/
    //   - supervisor (new layout per docs/PERSISTENT_AGENT_LAUNCH_CONTRACT.md): .dashboard/supervisor/
    //   - worker agents (class IV, plans/class-iv-worker-hook-scaffold.md) —
    //     supervised OR plain user-launched workers (isWorkerLane):
    //     .dashboard/workers/<provider>/ — shared cwd for N workers, by design.
    //     Read-only template; hook in settings.json fires on Stop.
    //   - unsupervised, non-worker user-launched agents: workDir (legacy lane).
    let agentCwd = workDir;
    if (resolvedInput.persona) {
      agentCwd = pathType === 'windows'
        ? path.join(workDir, '.claude', 'agents', resolvedInput.persona)
        : `${workDir}/.claude/agents/${resolvedInput.persona}`;
    } else if (resolvedInput.isSupervisor) {
      agentCwd = pathType === 'windows'
        ? path.join(workDir, '.dashboard', 'supervisor')
        : `${workDir}/.dashboard/supervisor`;
    } else if (isWorkerLane) {
      agentCwd = pathType === 'windows'
        ? path.join(workDir, '.dashboard', 'workers', provider)
        : `${workDir}/.dashboard/workers/${provider}`;
    }

    // Path-injection guard for explicit `working_directory` from MCP
    // `launch_agent` (the only caller-controlled input that flows into
    // agentCwd). Internally-derived cwds — supervisor `.dashboard/supervisor/`,
    // persona `.claude/agents/<name>/`, supervised `.dashboard/workers/<provider>/`
    // — are all rooted at `workspace.path` and pass naturally; only a hostile
    // or typo'd `working_directory` could escape the workspace via `..` or an
    // unrelated absolute path.
    {
      const root = workspace.path;
      const normalize = (p: string) => pathType === 'windows'
        ? path.resolve(p).toLowerCase().replace(/[\\/]+$/, '')
        : p.replace(/\/+$/, '');
      const sep = pathType === 'windows' ? path.sep : '/';
      const normRoot = normalize(root);
      const normCwd = normalize(agentCwd);
      if (normCwd !== normRoot && !normCwd.startsWith(normRoot + sep)) {
        throw new Error(
          `agentCwd '${agentCwd}' resolves outside workspace root '${root}'`,
        );
      }
    }

    // Ensure agentCwd exists before handing it to the runner. Without this,
    // Windows `CreateProcess` with a non-existent cwd silently fails (pid:
    // null, log stays 0 bytes); WSL's leading `cd '${dir}'` exits before the
    // provider CLI runs. The claude case self-heals as a side effect of
    // `ensureWorkerScaffold` writing files under `.dashboard/workers/claude/`,
    // but codex/gemini have empty file maps and their per-provider dir would
    // never be created. Provider-agnostic mkdir here closes the gap once for
    // every cwd resolution branch (supervisor, persona, supervised, explicit).
    if (pathType === 'windows') {
      fs.mkdirSync(agentCwd, { recursive: true });
    } else {
      execFileSync('wsl.exe', ['bash', '-lc', `mkdir -p '${agentCwd}'`], { timeout: 5000 });
    }

    const agent = createAgent({
      workspaceId: resolvedInput.workspaceId,
      title: resolvedInput.title,
      roleDescription: resolvedInput.roleDescription || '',
      workingDirectory: agentCwd,
      command,
      provider,
      isSupervisor: resolvedInput.isSupervisor,
      isSupervised: resolvedInput.isSupervised,
      isWorker: isWorkerLane,
      tmuxSessionName,
      autoRestartEnabled: resolvedInput.autoRestartEnabled ?? true,
      logPath,
      templateId: resolvedInput.templateId || null,
      systemPrompt: resolvedInput.systemPrompt || null,
    });

    // B2 (HOOK_SYSTEM_DESIGN.md §C) — a worker-lane codex command we couldn't
    // safely instrument runs hookless; surface that as hook_status='degraded'
    // now that the agent row exists. The launch canary below will NOT override
    // a degraded status (it only acts on 'unknown').
    if (codexHookDegraded) {
      updateAgentHookStatus(agent.id, 'degraded');
    } else if (isWorkerLane) {
      // Arm the launch-time hook canary: if no hook event reaches the dashboard
      // within HOOK_CANARY_WINDOW_MS and hook_status is still 'unknown', the
      // StatusMonitor flips it to 'broken'. See StatusMonitor.checkHookCanary.
      this.monitor.recordHookCanary(agent.id);
    }

    // Assign a session ID for resume/fork/query support (Claude only)
    let sessionId: string | undefined;
    if (provider === 'claude') {
      sessionId = uuidv4();
      updateAgentResumeSessionId(agent.id, sessionId);
      this.sessionLogReader.invalidatePath(agent.id);
    }

    addEvent(agent.id, 'launched');

    // Auto-create .dashboard/supervisor/ scaffold if this is a supervisor launch
    if (resolvedInput.isSupervisor) {
      this.ensureSupervisorScaffold(workDir, pathType);
    } else if (isWorkerLane && !resolvedInput.persona) {
      // Class IV (plans/class-iv-worker-hook-scaffold.md): worker agent
      // (supervised or plain) — scaffold the per-provider template + shared
      // hook script so turn-boundary status hooks fire.
      this.ensureWorkerScaffold(workDir, provider, pathType);
      // Codex turn-boundary hooks ride a CODEX_HOME profile, not the worker-cwd
      // config (see CODEX_WORKER_PROFILE_TOML). Ensure it exists for this runtime.
      if (provider === 'codex') this.ensureCodexHookProfile(pathType);
    }
    // Pre-trust the workspace root + agent cwd in the provider's user-global
    // config (every lane — worker, supervisor, persona, legacy root-cwd). A
    // fresh workspace otherwise hits the CLI's directory-trust gate: Claude
    // blocks on the interactive "Do you trust the files in this folder?"
    // dialog; Codex skips its hook config (BUG-25) or dies silently at the
    // first prompt (observed live, codex 0.136 at an untrusted workspace root).
    this.ensureProviderDirTrust(workDir, agentCwd, provider, pathType);
    // Write .mcp.json to workspace root and agent subdir (if persona or supervisor)
    if (resolvedInput.isSupervisor || resolvedInput.persona) {
      this.ensureMcpConfig(workDir, pathType);
      if (agentCwd !== workDir) {
        this.ensureMcpConfig(agentCwd, pathType);
      }
    }

    // If this agent is a member of an active team, inject team MCP config
    const teamMembership = getTeamMembership(agent.id);
    if (teamMembership) {
      this.ensureTeamMcpConfig(agent.id, teamMembership.teamId, workDir, pathType);
      console.log(`[supervisor] Agent ${agent.title} (${agent.id}) is in team ${teamMembership.teamId} — team MCP injected`);
    }

    // Auto-load agent.md/AGENT.md if present (from workspace root, not agent subdir)
    let agentMdPrompt = this.loadAgentMd(workDir, pathType);

    // For non-supervisor agents with a custom systemPrompt (from template or direct), send as initial message
    if (!resolvedInput.isSupervisor && resolvedInput.systemPrompt && provider === 'claude') {
      agentMdPrompt = agentMdPrompt
        ? `${resolvedInput.systemPrompt}\n\n---\n\n${agentMdPrompt}`
        : resolvedInput.systemPrompt;
      console.log(`[supervisor] Custom system prompt (${resolvedInput.systemPrompt.length} chars) — will send as initial message`);
    }

    // BUG-08: freshSession is a launch-time hint for codex agents to skip
    // post-launch session-id discovery so the new agent isn't bound to any
    // pre-existing rollout in this cwd. No-op for non-codex providers.
    const freshSession = resolvedInput.freshSession === true;

    // WP-P2 (selection→agent primitive, §1.6): a clean initial USER message,
    // delivered post-launch on the first input-accepting status transition
    // (see maybeDeliverInitialUserPrompt). Never merged into agentMdPrompt
    // above — that positional-arg path mixes content into launch framing and
    // is claude-only.
    if (resolvedInput.initialUserPrompt) {
      this.pendingInitialPrompts.set(agent.id, {
        text: resolvedInput.initialUserPrompt,
        expiresAt: Date.now() + INITIAL_USER_PROMPT_TTL_MS,
      });
    }

    if (pathType === 'windows') {
      await this.launchWindowsAgent(agent, false, agentMdPrompt, sessionId, undefined, freshSession);
    } else {
      await this.launchWslAgent(agent, false, agentMdPrompt, undefined, sessionId, freshSession);
    }

    return getAgent(agent.id)!;
  }

  /** Scaffold file map: relative path → content + version.
   *  Scripts get +x on WSL. Layout per docs/PERSISTENT_AGENT_LAUNCH_CONTRACT.md.
   *  Versioning per plans/scaffold-version-migration.md — bumping a file's
   *  `version` triggers managed-upgrade-on-launch in old workspaces. */
  private static SUPERVISOR_FILES: Record<string, ScaffoldFile> = {
    [`.dashboard/supervisor/CLAUDE.md`]:                                              {
      content: SUPERVISOR_AGENT_MD,
      version: 4,
      previousHashes: { 1: SUPERVISOR_AGENT_MD_V1_HASH, 2: SUPERVISOR_AGENT_MD_V2_HASH, 3: SUPERVISOR_AGENT_MD_V3_HASH },
    },
    [`.dashboard/supervisor/.claude/settings.json`]:                                  {
      content: SUPERVISOR_CLAUDE_SETTINGS_JSON,
      version: 2,
      previousHashes: { 1: sha256Hex(SUPERVISOR_CLAUDE_SETTINGS_JSON_V1) },
    },
    [`.dashboard/supervisor/.claude/skills/run-orchestration/SKILL.md`]:              {
      content: SUPERVISOR_RUN_ORCHESTRATION_SKILL,
      version: 3,
      previousHashes: { 1: SUPERVISOR_RUN_ORCHESTRATION_SKILL_V1_HASH, 2: SUPERVISOR_RUN_ORCHESTRATION_SKILL_V2_HASH },
    },
    [`.dashboard/supervisor/.claude/skills/orchestration-spike/SKILL.md`]:            { content: SUPERVISOR_ORCHESTRATION_SPIKE_SKILL, version: 1 },
    [`.dashboard/supervisor/memory/MEMORY.md`]:                                       { content: SUPERVISOR_MEMORY_MD,                 version: 1 },
    [`.dashboard/supervisor/scripts/read-agent-log.sh`]:                              { content: SCRIPT_READ_AGENT_LOG,                version: 1, executable: true },
    [`.dashboard/supervisor/scripts/list-agents.sh`]:                                 { content: SCRIPT_LIST_AGENTS,                   version: 1, executable: true },
    [`.dashboard/supervisor/scripts/send-message.sh`]:                                { content: SCRIPT_SEND_MESSAGE,                  version: 1, executable: true },
    [`.dashboard/supervisor/scripts/get-context-stats.sh`]:                           { content: SCRIPT_GET_CONTEXT_STATS,             version: 1, executable: true },
  };

  /** Class IV — workspace-shared hook script. Written on first supervised
   *  worker launch of any provider; lives at .dashboard/scripts/ so a single
   *  copy serves every per-provider worker template.
   *
   *  v2 added DASHBOARD_HOST support + pending-status.jsonl failure logging.
   *  v3 reads `state` from argv[2] so the UserPromptSubmit hook can post
   *  `'working'`. v4 adds the `session-start` argv → state 'active' branch
   *  (launch canary, HOOK_SYSTEM_DESIGN.md §A). v5 raises the POST self-abort
   *  1500ms → 2500ms so a slow hook POST isn't cancelled before the synchronous
   *  submit-confirm window (plan §2.4). v6 ignores SubagentStop so a Task-tool
   *  subagent finishing mid-turn can't flip the still-working main agent idle.
   *  v7 (P1, plans/p1-hook-spool-multi-transport.md §1) reads stdin meta,
   *  always-writes the spool (DASHBOARD_SPOOL_PATH env), and adds the tmux
   *  pane-option transport — one record, three channels.
   *  All previous hashes are recorded for silent upgrade. */
  private static WORKSPACE_SCRIPT_FILES: Record<string, ScaffoldFile> = {
    [`.dashboard/scripts/dashboard-status.mjs`]: {
      content: DASHBOARD_STATUS_SCRIPT_MJS,
      version: 7,
      executable: true,
      previousHashes: {
        1: DASHBOARD_STATUS_SCRIPT_V1_HASH,
        2: DASHBOARD_STATUS_SCRIPT_V2_HASH,
        3: sha256Hex(DASHBOARD_STATUS_SCRIPT_MJS_V3),
        4: sha256Hex(DASHBOARD_STATUS_SCRIPT_MJS_V4),
        5: sha256Hex(DASHBOARD_STATUS_SCRIPT_MJS_V5),
        6: sha256Hex(DASHBOARD_STATUS_SCRIPT_MJS_V6),
      },
    },
  };

  /** Class IV — Claude worker template files. Shared cwd for N supervised
   *  workers, by design (see plans/class-iv-worker-hook-scaffold.md §2). Read-only
   *  by convention — nothing per-agent ever writes here.
   *
   *  settings.json v2 adds the UserPromptSubmit hook (paste-race fix).
   *  v3 adds the SessionStart hook (launch canary, HOOK_SYSTEM_DESIGN.md §A).
   *  v4 drops the SubagentStop hook — it POSTed idle whenever a Task-tool
   *  subagent finished while the main agent was still mid-turn.
   *  v5 adds autoCompactEnabled: false — workers must not silently
   *  auto-compact mid-task regardless of user-level Claude settings. */
  private static WORKER_FILES_CLAUDE: Record<string, ScaffoldFile> = {
    [`.dashboard/workers/claude/CLAUDE.md`]:                       { content: WORKER_CLAUDE_MD,             version: 1 },
    [`.dashboard/workers/claude/.claude/settings.json`]:           {
      content: WORKER_CLAUDE_SETTINGS_JSON,
      version: 5,
      previousHashes: {
        1: WORKER_CLAUDE_SETTINGS_JSON_V1_HASH,
        2: sha256Hex(WORKER_CLAUDE_SETTINGS_JSON_V2),
        3: sha256Hex(WORKER_CLAUDE_SETTINGS_JSON_V3),
        4: sha256Hex(WORKER_CLAUDE_SETTINGS_JSON_V4),
      },
    },
  };

  /** Shared file-map writer used by both supervisor and worker scaffold paths.
   *  Returns the number of files written or upgraded (managed upgrades count
   *  as writes). Behavior per plans/scaffold-version-migration.md §Algorithm:
   *
   *  - Missing file → write bundled content, record version in sidecar.
   *  - Sidecar says current version → skip.
   *  - Disk content matches current bundled content (sidecar drift) → update
   *    sidecar only, no write or backup.
   *  - Disk content matches a known old managed hash → silent upgrade.
   *  - Disk content differs and no hash matches → back up to `.bak.<ts>` then
   *    overwrite (treat as user-modified — preserves the edit but takes the
   *    file off the user's hands).
   *  - Sidecar says future version (> bundled) → leave unchanged, warn.
   *
   *  Atomic per-file replacement (write-to-tmp + rename) on both platforms.
   *  Workspace-scoped lock (`.dashboard/.scaffold-versions.lock`) serializes
   *  concurrent ensureWorkerScaffold calls so two writers can't race the
   *  sidecar read/modify/write. */
  private writeScaffoldMap(
    workDir: string,
    files: Record<string, ScaffoldFile>,
    pathType: string,
  ): number {
    const lockReleased = this.acquireScaffoldLock(workDir, pathType);
    try {
      const sidecar = this.readScaffoldSidecar(workDir, pathType);
      let changed = 0;

      for (const [relPath, file] of Object.entries(files)) {
        const managedKey = normalizeManagedKey(relPath);
        const bundledVersion = file.version;
        const diskVersion = Number.isInteger(sidecar[managedKey]) ? sidecar[managedKey] : 0;

        try {
          if (!this.scaffoldFileExists(workDir, relPath, pathType)) {
            this.atomicWriteScaffoldText(workDir, relPath, file.content, !!file.executable, pathType);
            sidecar[managedKey] = bundledVersion;
            changed++;
            continue;
          }

          if (diskVersion === bundledVersion) {
            continue;
          }

          if (diskVersion > bundledVersion) {
            console.warn(`[supervisor] Scaffold file ${managedKey} has future version ${diskVersion}; leaving unchanged (bundled v${bundledVersion})`);
            continue;
          }

          const diskContent = this.readScaffoldText(workDir, relPath, pathType);
          if (diskContent === null) {
            // File reported exists but unreadable — treat as missing and write.
            this.atomicWriteScaffoldText(workDir, relPath, file.content, !!file.executable, pathType);
            sidecar[managedKey] = bundledVersion;
            changed++;
            continue;
          }
          const diskHash = sha256Hex(diskContent);

          // Sidecar drift safety: if the file content is already the current
          // bundled content, just record the version and move on — no write,
          // no backup. Covers "user deleted sidecar but didn't touch files."
          if (diskHash === sha256Hex(file.content)) {
            sidecar[managedKey] = bundledVersion;
            changed++;
            continue;
          }

          const knownOldHash = file.previousHashes?.[diskVersion] ?? file.previousHashes?.[1];
          const matchesKnownManagedOld = !!knownOldHash && diskHash === knownOldHash;

          if (matchesKnownManagedOld) {
            this.atomicWriteScaffoldText(workDir, relPath, file.content, !!file.executable, pathType);
            sidecar[managedKey] = bundledVersion;
            console.log(`[supervisor] Scaffold file ${managedKey} upgraded ${diskVersion} → ${bundledVersion} (matched known managed hash)`);
            changed++;
            continue;
          }

          // User-modified (or unknown previous version we don't have a hash
          // for). Back up before overwrite so the edit is recoverable.
          const bakRel = `${relPath}.bak.${timestampForFilename()}`;
          this.copyScaffoldForBackup(workDir, relPath, bakRel, pathType);
          console.warn(
            `[supervisor] Scaffold file ${managedKey} differed from known managed content; ` +
            `backed up to ${bakRel} and upgraded to v${bundledVersion}`,
          );
          this.atomicWriteScaffoldText(workDir, relPath, file.content, !!file.executable, pathType);
          sidecar[managedKey] = bundledVersion;
          changed++;
        } catch (err) {
          console.error(`[supervisor] Failed to upgrade scaffold file ${relPath}:`, err);
        }
      }

      if (changed > 0) {
        try {
          this.writeScaffoldSidecar(workDir, sidecar, pathType);
        } catch (err) {
          console.error(`[supervisor] Failed to persist scaffold sidecar:`, err);
        }
      }

      return changed;
    } finally {
      lockReleased();
    }
  }

  // ── Scaffold IO primitives ────────────────────────────────────────────

  /** Resolve a workspace-relative path to its absolute form for the given
   *  pathType. Windows uses path.join (handles backslashes); WSL/Linux uses
   *  forward slashes throughout. */
  private scaffoldFullPath(workDir: string, relPath: string, pathType: string): string {
    if (pathType === 'wsl') return `${workDir}/${relPath}`;
    return path.join(workDir, relPath);
  }

  private scaffoldFileExists(workDir: string, relPath: string, pathType: string): boolean {
    const full = this.scaffoldFullPath(workDir, relPath, pathType);
    if (pathType === 'wsl') {
      try {
        execFileSync('wsl.exe', ['bash', '-lc', `test -f '${full}'`], { timeout: 5000, stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }
    return fs.existsSync(full);
  }

  private readScaffoldText(workDir: string, relPath: string, pathType: string): string | null {
    const full = this.scaffoldFullPath(workDir, relPath, pathType);
    if (pathType === 'wsl') {
      try {
        const b64 = execFileSync('wsl.exe', ['bash', '-lc', `base64 -w0 '${full}'`], {
          encoding: 'utf-8', timeout: 5000,
        });
        return Buffer.from(b64.trim(), 'base64').toString('utf-8');
      } catch {
        return null;
      }
    }
    try {
      return fs.readFileSync(full, 'utf-8');
    } catch {
      return null;
    }
  }

  /** Write `content` atomically: write to `<target>.tmp.<pid>.<ts>`, then
   *  rename over the target. `executable=true` adds chmod +x (WSL only —
   *  Windows ignores +x). Creates parent dirs as needed. */
  private atomicWriteScaffoldText(
    workDir: string,
    relPath: string,
    content: string,
    executable: boolean,
    pathType: string,
  ): void {
    const full = this.scaffoldFullPath(workDir, relPath, pathType);
    if (pathType === 'wsl') {
      const dir = full.substring(0, full.lastIndexOf('/'));
      const tmp = `${full}.tmp.${process.pid}.${Date.now()}`;
      const b64 = Buffer.from(content, 'utf-8').toString('base64');
      const chmod = executable ? ` && chmod +x '${tmp}'` : '';
      const cmd = `mkdir -p '${dir}' && echo '${b64}' | base64 -d > '${tmp}'${chmod} && mv -f '${tmp}' '${full}'`;
      execFileSync('wsl.exe', ['bash', '-lc', cmd], { timeout: 5000 });
      return;
    }
    const dir = path.dirname(full);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${full}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, content, 'utf-8');
    try {
      fs.renameSync(tmp, full);
    } catch (err) {
      // Windows can fail to rename over an open file. Fall back to copy + unlink.
      try { fs.copyFileSync(tmp, full); } finally {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      }
      if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'EEXIST' && (err as NodeJS.ErrnoException).code !== 'EPERM' && (err as NodeJS.ErrnoException).code !== 'EACCES') {
        throw err;
      }
    }
  }

  private copyScaffoldForBackup(workDir: string, srcRel: string, dstRel: string, pathType: string): void {
    const src = this.scaffoldFullPath(workDir, srcRel, pathType);
    const dst = this.scaffoldFullPath(workDir, dstRel, pathType);
    if (pathType === 'wsl') {
      execFileSync('wsl.exe', ['bash', '-lc', `cp -p '${src}' '${dst}'`], { timeout: 5000 });
      return;
    }
    fs.copyFileSync(src, dst);
  }

  /** Read the workspace sidecar. Missing file or unparseable JSON both yield
   *  an empty record; corrupt content also logs a warning so users can see
   *  the migration treated their sidecar as missing. */
  private readScaffoldSidecar(workDir: string, pathType: string): Record<string, number> {
    const raw = this.readScaffoldText(workDir, SCAFFOLD_SIDECAR_REL, pathType);
    if (raw === null) return {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === 'number' && Number.isInteger(v)) out[k] = v;
        }
        return out;
      }
      console.warn(`[supervisor] Scaffold sidecar at ${SCAFFOLD_SIDECAR_REL} is not an object; treating as empty`);
      return {};
    } catch {
      console.warn(`[supervisor] Scaffold sidecar at ${SCAFFOLD_SIDECAR_REL} is unparseable JSON; treating as empty`);
      return {};
    }
  }

  private writeScaffoldSidecar(workDir: string, sidecar: Record<string, number>, pathType: string): void {
    const sorted: Record<string, number> = {};
    for (const key of Object.keys(sidecar).sort()) sorted[key] = sidecar[key];
    const content = JSON.stringify(sorted, null, 2) + '\n';
    this.atomicWriteScaffoldText(workDir, SCAFFOLD_SIDECAR_REL, content, false, pathType);
  }

  /** Acquire the workspace-scoped scaffold lock. Returns a release function
   *  that callers MUST invoke in a finally. Falls back to a no-op release if
   *  the lock can't be acquired within the timeout (worst case: two writers
   *  race the sidecar — atomic writes still keep individual files intact). */
  private acquireScaffoldLock(workDir: string, pathType: string): () => void {
    const lockFull = this.scaffoldFullPath(workDir, SCAFFOLD_LOCK_REL, pathType);
    const dashboardDir = this.scaffoldFullPath(workDir, '.dashboard', pathType);
    const start = Date.now();

    while (Date.now() - start < SCAFFOLD_LOCK_TIMEOUT_MS) {
      if (this.tryAcquireScaffoldLock(dashboardDir, lockFull, pathType)) {
        return () => this.releaseScaffoldLock(lockFull, pathType);
      }
      const ageMs = this.scaffoldLockAgeMs(lockFull, pathType);
      if (ageMs !== null && ageMs > SCAFFOLD_LOCK_STALE_MS) {
        console.warn(`[supervisor] Scaffold lock at ${lockFull} is stale (${Math.round(ageMs / 1000)}s); clearing`);
        try { this.releaseScaffoldLock(lockFull, pathType); } catch { /* best effort */ }
      }
      const waitMs = SCAFFOLD_LOCK_POLL_MS + Math.floor(Math.random() * SCAFFOLD_LOCK_POLL_MS);
      // Synchronous sleep — writeScaffoldMap is a sync method.
      const wakeAt = Date.now() + waitMs;
      while (Date.now() < wakeAt) { /* spin briefly */ }
    }
    console.warn(`[supervisor] Could not acquire scaffold lock at ${lockFull} within ${SCAFFOLD_LOCK_TIMEOUT_MS}ms; proceeding without lock`);
    return () => { /* no-op */ };
  }

  private tryAcquireScaffoldLock(dashboardDir: string, lockFull: string, pathType: string): boolean {
    if (pathType === 'wsl') {
      try {
        execFileSync('wsl.exe', ['bash', '-lc', `mkdir -p '${dashboardDir}' && mkdir '${lockFull}'`], {
          timeout: 5000, stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    }
    try {
      fs.mkdirSync(dashboardDir, { recursive: true });
      fs.mkdirSync(lockFull);
      return true;
    } catch {
      return false;
    }
  }

  private releaseScaffoldLock(lockFull: string, pathType: string): void {
    if (pathType === 'wsl') {
      try {
        execFileSync('wsl.exe', ['bash', '-lc', `rmdir '${lockFull}'`], { timeout: 5000, stdio: 'ignore' });
      } catch { /* best effort */ }
      return;
    }
    try { fs.rmdirSync(lockFull); } catch { /* best effort */ }
  }

  private scaffoldLockAgeMs(lockFull: string, pathType: string): number | null {
    if (pathType === 'wsl') {
      try {
        const out = execFileSync('wsl.exe', ['bash', '-lc', `stat -c %Y '${lockFull}'`], {
          encoding: 'utf-8', timeout: 5000,
        });
        const epochS = Number.parseInt(out.trim(), 10);
        if (!Number.isFinite(epochS)) return null;
        return Date.now() - epochS * 1000;
      } catch {
        return null;
      }
    }
    try {
      const stat = fs.statSync(lockFull);
      return Date.now() - stat.mtimeMs;
    } catch {
      return null;
    }
  }

  /** Create the full .dashboard/supervisor/ scaffold in a workspace.
   *  Only writes files that don't already exist — never overwrites user edits. */
  private ensureSupervisorScaffold(workDir: string, pathType: string): void {
    const created = this.writeScaffoldMap(workDir, AgentSupervisor.SUPERVISOR_FILES, pathType);
    if (created > 0) {
      console.log(`[supervisor] Scaffolded ${created} files in ${workDir}/.dashboard/supervisor/`);
      addEvent('system', 'supervisor_scaffold_created', JSON.stringify({ workDir, filesCreated: created }));
    } else {
      console.log(`[supervisor] Scaffold already exists in ${workDir}`);
    }
  }

  /** Class IV — create the .dashboard/workers/<provider>/ template plus the
   *  shared .dashboard/scripts/dashboard-status.mjs on first supervised worker
   *  launch. Idempotent: existing files are never overwritten. Gemini has no
   *  hook scaffold yet — it gets the shared-script write but no provider-
   *  specific config (tracked as follow-up in plan §12). */
  private ensureWorkerScaffold(workDir: string, provider: string, pathType: string): void {
    const scriptCreated = this.writeScaffoldMap(workDir, AgentSupervisor.WORKSPACE_SCRIPT_FILES, pathType);
    let providerCreated = 0;
    if (provider === 'claude') {
      providerCreated = this.writeScaffoldMap(workDir, AgentSupervisor.WORKER_FILES_CLAUDE, pathType);
    } else if (provider === 'codex') {
      // Codex hooks have no ${CLAUDE_PROJECT_DIR} analog, so materialize the
      // absolute script path at write time. The path is read by the runtime
      // that actually executes the hook (Windows Node for windows agents, WSL
      // Node for wsl agents) — pick the form that runtime can resolve. WSL
      // Node cannot read `C:/...` style paths; `windowsToWslPath` converts
      // drive-letter paths to /mnt/<lc>/..., UNC WSL paths (\\wsl.localhost\...)
      // to /home/..., and leaves already-posix WSL paths unchanged.
      const posixWorkspaceRoot = pathType === 'wsl'
        ? windowsToWslPath(workDir)
        : workDir.replace(/\\/g, '/');
      const codexConfig = WORKER_CODEX_CONFIG_TOML.replace(
        /\$\{WORKSPACE_ROOT\}/g,
        posixWorkspaceRoot,
      );
      // v1/v2 content with the same materialized workspace root, so an old
      // workspace's on-disk file hashes match and upgrade silently. v1 = Stop
      // only; v2 = Stop + UserPromptSubmit; v3 (current) adds SessionStart.
      const codexConfigV1 = WORKER_CODEX_CONFIG_TOML_V1.replace(
        /\$\{WORKSPACE_ROOT\}/g,
        posixWorkspaceRoot,
      );
      const codexConfigV2 = WORKER_CODEX_CONFIG_TOML_V2.replace(
        /\$\{WORKSPACE_ROOT\}/g,
        posixWorkspaceRoot,
      );
      const codexFiles: Record<string, ScaffoldFile> = {
        [`.dashboard/workers/codex/.codex/config.toml`]: {
          content: codexConfig,
          version: 3,
          previousHashes: {
            1: sha256Hex(codexConfigV1),
            2: sha256Hex(codexConfigV2),
          },
        },
      };
      providerCreated = this.writeScaffoldMap(workDir, codexFiles, pathType);
    }
    const total = scriptCreated + providerCreated;
    if (total > 0) {
      console.log(`[supervisor] Worker scaffold: ${total} files in ${workDir}/.dashboard/ (provider=${provider})`);
      addEvent('system', 'worker_scaffold_created', JSON.stringify({ workDir, provider, filesCreated: total }));
    }
  }

  /** Class IV — write the codex hook profile + shared status script into the
   *  runtime's CODEX_HOME so `codex --profile dashboard-worker` loads turn-
   *  boundary hooks. Unlike the worker-cwd config.toml (which codex only reads
   *  for a trusted project), a profile file layers onto the base config
   *  unconditionally. The in-memory guard avoids re-touching it on every launch.
   *
   *  B8 (§8.5): the profile body alone is not enough — Codex gates each hook
   *  behind a per-hook trust hash, so the writer SEEDS `[hooks.state]` with the
   *  correct `trusted_hash` for every hook it installs (Stop / UserPromptSubmit /
   *  SessionStart), pre-trusting them with zero user interaction. The write is
   *  also NON-CLOBBERING: if the on-disk file already has the identical body and
   *  all the trust hashes, it is left untouched — so a plain restart (and a
   *  user's manual `t`) survive instead of being wiped every launch. Best-effort:
   *  a failure here just means hooks don't fire and status falls back to
   *  inference. */
  private ensureCodexHookProfile(pathType: string): void {
    if (this.codexHookProfileEnsured.has(pathType)) return;
    try {
      const profileFile = `${CODEX_WORKER_PROFILE_NAME}.config.toml`;
      if (pathType === 'windows') {
        const codexHome = process.env.CODEX_HOME
          || path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex');
        fs.mkdirSync(codexHome, { recursive: true });
        const scriptPath = path.join(codexHome, 'dashboard-status.mjs');
        fs.writeFileSync(scriptPath, DASHBOARD_STATUS_SCRIPT_MJS);
        // Command path uses forward slashes (matches the profile + the hashed
        // command); the config-file key path Codex stores uses native backslashes.
        const profileBody = CODEX_WORKER_PROFILE_TOML.replace(/__SCRIPT__/g, scriptPath.replace(/\\/g, '/'));
        const profilePath = path.join(codexHome, profileFile);
        const hooks = parseCodexProfileHooks(profileBody);
        const existing = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf-8') : null;
        if (codexProfileTrustIntact(existing, profileBody, hooks)) {
          console.log(`[supervisor] Codex hook profile trust intact, left untouched: ${profilePath}`);
        } else {
          const full = profileBody + buildCodexHooksStateSection(profilePath, hooks);
          fs.writeFileSync(profilePath, full);
          console.log(`[supervisor] Codex hook profile written + trust seeded: ${profilePath} (${hooks.length} hooks)`);
        }
      } else {
        // WSL: the distro has its own CODEX_HOME. Resolve it AND read any
        // existing profile in one round-trip so we can apply the same
        // trust-intact / non-clobber guard as the Windows branch.
        const DELIM = '===B8-CODEX-HOME-DELIM===';
        const probe = execFileSync(
          'wsl.exe',
          ['bash', '-lc',
            `H="\${CODEX_HOME:-$HOME/.codex}"; printf %s "$H"; printf '%s' '${DELIM}'; `
            + `cat "$H/${profileFile}" 2>/dev/null || true`],
          { encoding: 'utf-8', timeout: 8000 },
        );
        const di = probe.indexOf(DELIM);
        const codexHome = (di >= 0 ? probe.slice(0, di) : probe).trim() || '$HOME/.codex';
        const existing = di >= 0 ? probe.slice(di + DELIM.length) : '';
        const scriptPosix = `${codexHome}/dashboard-status.mjs`;
        const profilePath = `${codexHome}/${profileFile}`;
        const profileBody = CODEX_WORKER_PROFILE_TOML.replace(/__SCRIPT__/g, scriptPosix);
        const hooks = parseCodexProfileHooks(profileBody);
        if (codexProfileTrustIntact(existing || null, profileBody, hooks)) {
          // Profile already current + trusted: only (re)write the script, which
          // carries no trust hash, so a content bump still propagates.
          const b64Script = Buffer.from(DASHBOARD_STATUS_SCRIPT_MJS, 'utf-8').toString('base64');
          execFileSync(
            'wsl.exe',
            ['bash', '-lc',
              `mkdir -p "${codexHome}" && printf %s '${b64Script}' | base64 -d > "${scriptPosix}"`],
            { timeout: 8000 },
          );
          console.log(`[supervisor] Codex hook profile trust intact, left untouched: ${profilePath} (wsl)`);
        } else {
          const full = profileBody + buildCodexHooksStateSection(profilePath, hooks);
          const b64Script = Buffer.from(DASHBOARD_STATUS_SCRIPT_MJS, 'utf-8').toString('base64');
          const b64Profile = Buffer.from(full, 'utf-8').toString('base64');
          execFileSync(
            'wsl.exe',
            ['bash', '-lc',
              `mkdir -p "${codexHome}" `
              + `&& printf %s '${b64Script}' | base64 -d > "${scriptPosix}" `
              + `&& printf %s '${b64Profile}' | base64 -d > "${profilePath}"`],
            { timeout: 8000 },
          );
          console.log(`[supervisor] Codex hook profile written + trust seeded: ${profilePath} (wsl, ${hooks.length} hooks)`);
        }
      }
      this.codexHookProfileEnsured.add(pathType);
    } catch (err) {
      console.warn('[supervisor] ensureCodexHookProfile failed (codex hooks may not fire):', err);
    }
  }

  /** Seed the provider's user-global directory-trust list for the workspace
   *  root + the agent's cwd, so a fresh workspace's first launch never hits an
   *  interactive trust gate (Claude) or a silent trust-kill / skipped hook
   *  config (Codex — BUG-25 family). Idempotent and append/merge-only: existing
   *  entries and unrelated config are never rewritten. Best-effort — a failure
   *  here degrades to today's behavior (the CLI prompts or refuses). */
  private ensureProviderDirTrust(workDir: string, agentCwd: string, provider: string, pathType: string): void {
    if (provider !== 'claude' && provider !== 'codex') return;  // gemini --yolo has no trust gate today
    const dirs = agentCwd && agentCwd !== workDir ? [workDir, agentCwd] : [workDir];
    const cacheKey = `${pathType}|${provider}|${dirs.join('|')}`;
    if (this.providerTrustEnsured.has(cacheKey)) return;
    try {
      if (provider === 'codex') {
        this.ensureCodexProjectTrust(dirs, pathType);
      } else {
        this.ensureClaudeProjectTrust(dirs, pathType);
      }
      this.providerTrustEnsured.add(cacheKey);
    } catch (err) {
      console.warn(
        `[supervisor] ensureProviderDirTrust failed — ${provider} may hit a trust prompt or die at launch in ${agentCwd}:`,
        err,
      );
    }
  }

  private ensureCodexProjectTrust(dirs: string[], pathType: string): void {
    if (pathType === 'windows') {
      const codexHome = process.env.CODEX_HOME
        || path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex');
      const configPath = path.join(codexHome, 'config.toml');
      const variants = dirs.flatMap(d => codexTrustPathVariants(d, pathType));
      const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
      const merged = mergeCodexProjectTrust(existing, variants);
      if (merged === null) return;
      fs.mkdirSync(codexHome, { recursive: true });
      const tmp = `${configPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, merged);
      fs.renameSync(tmp, configPath);
      console.log(`[supervisor] Codex project trust seeded for ${dirs.join(', ')} in ${configPath}`);
      return;
    }
    // WSL: the distro has its own CODEX_HOME / config.toml. Probe + read in
    // one round-trip (mirrors ensureCodexHookProfile), merge here, write back
    // via base64 (the config is small — a handful of trust/hook entries).
    const DELIM = '===TRUST-CODEX-DELIM===';
    const probe = execFileSync(
      'wsl.exe',
      ['bash', '-lc',
        `H="\${CODEX_HOME:-$HOME/.codex}"; printf %s "$H"; printf '%s' '${DELIM}'; `
        + `cat "$H/config.toml" 2>/dev/null || true`],
      { encoding: 'utf-8', timeout: 8000 },
    );
    const di = probe.indexOf(DELIM);
    const codexHome = (di >= 0 ? probe.slice(0, di) : probe).trim() || '$HOME/.codex';
    const existing = di >= 0 ? probe.slice(di + DELIM.length) : '';
    const merged = mergeCodexProjectTrust(existing || null, dirs.flatMap(d => codexTrustPathVariants(d, pathType)));
    if (merged === null) return;
    const b64 = Buffer.from(merged, 'utf-8').toString('base64');
    execFileSync(
      'wsl.exe',
      ['bash', '-lc', `mkdir -p "${codexHome}" && printf %s '${b64}' | base64 -d > "${codexHome}/config.toml"`],
      { timeout: 8000 },
    );
    console.log(`[supervisor] Codex project trust seeded for ${dirs.join(', ')} in ${codexHome}/config.toml (wsl)`);
  }

  private ensureClaudeProjectTrust(dirs: string[], pathType: string): void {
    if (pathType === 'windows') {
      // Claude keys ~/.claude.json projects by forward-slash exact-case paths.
      const keys = dirs.map(d => d.replace(/\\/g, '/'));
      const claudeJsonPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude.json');
      const existing = fs.existsSync(claudeJsonPath) ? fs.readFileSync(claudeJsonPath, 'utf-8') : null;
      const merged = mergeClaudeProjectTrust(existing, keys);
      if (merged === null) return;
      // Running Claude instances rewrite this file themselves; keep the
      // read-modify-write window tight and the replacement atomic. We only
      // get here when an entry is actually missing (first launch into a
      // fresh workspace), so collisions are rare by construction.
      const tmp = `${claudeJsonPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, merged);
      fs.renameSync(tmp, claudeJsonPath);
      console.log(`[supervisor] Claude folder trust seeded for ${keys.join(', ')} in ${claudeJsonPath}`);
      return;
    }
    // WSL: ~/.claude.json lives in the distro and can be multi-MB (it carries
    // per-project history), so it can't round-trip through argv as base64.
    // Read with a raised maxBuffer; write by staging to a Windows temp file
    // the distro reads back via /mnt/<drive>, then stage-then-rename in-distro
    // (`mv` within one filesystem is an atomic rename) so a concurrent claude
    // reader never sees a half-written file.
    const existing = execFileSync(
      'wsl.exe',
      ['bash', '-lc', 'cat "$HOME/.claude.json" 2>/dev/null || true'],
      { encoding: 'utf-8', timeout: 8000, maxBuffer: 64 * 1024 * 1024 },
    );
    const merged = mergeClaudeProjectTrust(existing.trim().length > 0 ? existing : null, dirs);
    if (merged === null) return;
    const stage = path.join(this.logsDir, `.claude-trust-stage-${process.pid}.json`);
    fs.writeFileSync(stage, merged);
    try {
      const stageWsl = windowsToWslPath(stage);
      execFileSync(
        'wsl.exe',
        ['bash', '-lc', `cat '${stageWsl}' > "$HOME/.claude.json.tmp-$$" && mv "$HOME/.claude.json.tmp-$$" "$HOME/.claude.json"`],
        { timeout: 8000 },
      );
    } finally {
      try { fs.unlinkSync(stage); } catch { /* best effort */ }
    }
    console.log(`[supervisor] Claude folder trust seeded for ${dirs.join(', ')} in ~/.claude.json (wsl)`);
  }

  /** Write .mcp.json in the workspace so Claude Code auto-discovers the MCP server.
   *  This enables the supervisor agent to use native MCP tools (list_agents, send_message, etc.)
   *  instead of bash scripts. */
  /** L-C — resolve the WSL→Windows-host gateway IP once and cache. Mirrors
   *  the inline logic in ensureMcpConfig (`wsl.exe ip route show default`
   *  → `default via X.X.X.X`). In WSL "mirrored" networking mode there is
   *  no separate gateway and 127.0.0.1 works directly — the fallback below
   *  covers that case. Returns '127.0.0.1' on any failure so a worker on
   *  mirrored-mode WSL or a misconfigured distro keeps the prior behavior. */
  private resolveWslGatewayIp(): string {
    if (this.wslGatewayIp) return this.wslGatewayIp;
    let ip = '127.0.0.1';
    try {
      const route = execFileSync('wsl.exe', ['ip', 'route', 'show', 'default'], {
        encoding: 'utf-8', timeout: 5000,
      });
      const match = route.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)/);
      if (match) ip = match[1];
    } catch { /* fall back to 127.0.0.1 */ }
    this.wslGatewayIp = ip;
    return ip;
  }

  private ensureMcpConfig(workDir: string, pathType: string): void {
    const mcpScriptPath = getScriptPath('mcp-supervisor.js');
    const mcpConfig = {
      mcpServers: {
        'agent-dashboard': {
          command: 'node',
          args: [mcpScriptPath.replace(/\\/g, '/')],
          env: {
            // Real bound port (EADDRINUSE can increment past 24678) + the
            // per-launch bearer token — WP0.2; proxies fail closed without it.
            AGENT_DASHBOARD_API_PORT: String(this.apiServerPort),
            AGENT_DASHBOARD_API_TOKEN: getApiToken(),
          },
        },
      },
    };

    const configJson = JSON.stringify(mcpConfig, null, 2);

    if (pathType === 'wsl') {
      try {
        // Convert the Windows script path to a WSL-accessible path
        const wslScriptPath = mcpScriptPath.replace(/\\/g, '/');
        // For WSL, use the Windows path via /mnt/c/... since node runs in WSL
        const driveLetter = wslScriptPath.charAt(0).toLowerCase();
        const restOfPath = wslScriptPath.substring(2); // skip "C:"
        const linuxScriptPath = `/mnt/${driveLetter}${restOfPath}`;

        // Get the Windows host IP that WSL routes to. We want the DEFAULT GATEWAY
        // ("ip route show default" → "default via X.X.X.X dev eth0"), NOT the DNS
        // nameserver in /etc/resolv.conf — those can differ when the user has
        // custom DNS (e.g. nameserver=10.255.255.254 but actual gateway=172.22.208.1).
        // In WSL "mirrored" networking mode there is no separate gateway and 127.0.0.1
        // works directly — the fallback below covers that case.
        //
        // We invoke `ip route show default` rather than piping through awk because
        // wsl.exe pre-processes args and mangles `$2` in `awk '{print $2}'`, which
        // historically caused this code to silently fall back to 127.0.0.1.
        let windowsHostIp = '127.0.0.1';
        try {
          const route = execFileSync('wsl.exe', ['ip', 'route', 'show', 'default'], {
            encoding: 'utf-8', timeout: 5000,
          });
          const match = route.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)/);
          if (match) windowsHostIp = match[1];
        } catch { /* fall back to 127.0.0.1 */ }
        console.log(`[supervisor] WSL → Windows host IP: ${windowsHostIp}`);

        const wslMcpConfig = {
          mcpServers: {
            'agent-dashboard': {
              command: 'node',
              args: [linuxScriptPath],
              env: {
                AGENT_DASHBOARD_API_PORT: String(this.apiServerPort),
                AGENT_DASHBOARD_API_HOST: windowsHostIp,
                AGENT_DASHBOARD_API_TOKEN: getApiToken(),
              },
            },
          },
        };

        const b64 = Buffer.from(JSON.stringify(wslMcpConfig, null, 2), 'utf-8').toString('base64');
        execFileSync('wsl.exe', ['bash', '-lc', `echo '${b64}' | base64 -d > '${workDir}/.mcp.json'`], { timeout: 5000 });
        console.log(`[supervisor] Wrote .mcp.json in WSL workspace: ${workDir}`);
      } catch (err) {
        console.error('[supervisor] Failed to write .mcp.json in WSL:', err);
      }
    } else {
      try {
        const fullPath = path.join(workDir, '.mcp.json');
        fs.writeFileSync(fullPath, configJson, 'utf-8');
        console.log(`[supervisor] Wrote .mcp.json in workspace: ${workDir}`);
      } catch (err) {
        console.error('[supervisor] Failed to write .mcp.json:', err);
      }
    }
  }

  /** Write/merge team MCP config into .mcp.json for a team member agent.
   *  Works for all providers (Claude, Gemini, Codex) — they all auto-discover .mcp.json.
   *  If .mcp.json already exists, merges the team server entry without overwriting others. */
  ensureTeamMcpConfig(agentId: string, teamId: string, workDir: string, pathType: string): void {
    const mcpTeamScriptPath = getScriptPath('mcp-team.js');
    const teamServerKey = 'agent-dashboard-team';

    if (pathType === 'wsl') {
      try {
        const wslScriptPath = mcpTeamScriptPath.replace(/\\/g, '/');
        const driveLetter = wslScriptPath.charAt(0).toLowerCase();
        const restOfPath = wslScriptPath.substring(2);
        const linuxScriptPath = `/mnt/${driveLetter}${restOfPath}`;

        // See ensureMcpConfig for why we read the default gateway, not resolv.conf.
        let windowsHostIp = '127.0.0.1';
        try {
          const route = execFileSync('wsl.exe', ['ip', 'route', 'show', 'default'], {
            encoding: 'utf-8', timeout: 5000,
          });
          const match = route.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)/);
          if (match) windowsHostIp = match[1];
        } catch { /* fall back to 127.0.0.1 */ }

        // Read existing .mcp.json to merge
        let existing: any = { mcpServers: {} };
        try {
          const content = execFileSync('wsl.exe', ['bash', '-lc', `cat '${workDir}/.mcp.json'`], {
            encoding: 'utf-8', timeout: 5000,
          });
          existing = JSON.parse(content);
        } catch { /* file doesn't exist or parse error, start fresh */ }

        existing.mcpServers[teamServerKey] = {
          command: 'node',
          args: [linuxScriptPath],
          env: {
            AGENT_ID: agentId,
            TEAM_ID: teamId,
            AGENT_DASHBOARD_API_PORT: String(this.apiServerPort),
            AGENT_DASHBOARD_API_HOST: windowsHostIp,
            AGENT_DASHBOARD_API_TOKEN: getApiToken(),
          },
        };

        const b64 = Buffer.from(JSON.stringify(existing, null, 2), 'utf-8').toString('base64');
        execFileSync('wsl.exe', ['bash', '-lc', `echo '${b64}' | base64 -d > '${workDir}/.mcp.json'`], { timeout: 5000 });
        console.log(`[supervisor] Wrote team MCP config for agent ${agentId} in WSL: ${workDir}`);
      } catch (err) {
        console.error('[supervisor] Failed to write team MCP config in WSL:', err);
      }
    } else {
      try {
        const fullPath = path.join(workDir, '.mcp.json');

        // Read existing .mcp.json to merge
        let existing: any = { mcpServers: {} };
        try {
          if (fs.existsSync(fullPath)) {
            existing = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
          }
        } catch { /* parse error, start fresh */ }

        existing.mcpServers[teamServerKey] = {
          command: 'node',
          args: [mcpTeamScriptPath.replace(/\\/g, '/')],
          env: {
            AGENT_ID: agentId,
            TEAM_ID: teamId,
            AGENT_DASHBOARD_API_PORT: String(this.apiServerPort),
            AGENT_DASHBOARD_API_TOKEN: getApiToken(),
          },
        };

        fs.writeFileSync(fullPath, JSON.stringify(existing, null, 2), 'utf-8');
        console.log(`[supervisor] Wrote team MCP config for agent ${agentId} in: ${workDir}`);
      } catch (err) {
        console.error('[supervisor] Failed to write team MCP config:', err);
      }
    }
  }

  /** Build --mcp-config JSON for a team member agent (used at launch time).
   *  Returns the JSON string to pass via --mcp-config flag. */
  buildTeamMcpConfigArg(agentId: string, teamId: string, pathType: string): string {
    const mcpTeamScriptPath = getScriptPath('mcp-team.js');

    if (pathType === 'wsl') {
      const wslScriptPath = mcpTeamScriptPath.replace(/\\/g, '/');
      const driveLetter = wslScriptPath.charAt(0).toLowerCase();
      const restOfPath = wslScriptPath.substring(2);
      const linuxScriptPath = `/mnt/${driveLetter}${restOfPath}`;

      // See ensureMcpConfig for why we read the default gateway, not resolv.conf.
      let windowsHostIp = '127.0.0.1';
      try {
        const route = execFileSync('wsl.exe', ['ip', 'route', 'show', 'default'], {
          encoding: 'utf-8', timeout: 5000,
        });
        const match = route.match(/default\s+via\s+(\d+\.\d+\.\d+\.\d+)/);
        if (match) windowsHostIp = match[1];
      } catch { /* fall back */ }

      return JSON.stringify({
        mcpServers: {
          'agent-dashboard-team': {
            command: 'node',
            args: [linuxScriptPath],
            env: {
              AGENT_ID: agentId,
              TEAM_ID: teamId,
              AGENT_DASHBOARD_API_PORT: String(this.apiServerPort),
              AGENT_DASHBOARD_API_HOST: windowsHostIp,
              AGENT_DASHBOARD_API_TOKEN: getApiToken(),
            },
          },
        },
      });
    }

    return JSON.stringify({
      mcpServers: {
        'agent-dashboard-team': {
          command: 'node',
          args: [mcpTeamScriptPath.replace(/\\/g, '/')],
          env: {
            AGENT_ID: agentId,
            TEAM_ID: teamId,
            AGENT_DASHBOARD_API_PORT: String(this.apiServerPort),
            AGENT_DASHBOARD_API_TOKEN: getApiToken(),
          },
        },
      },
    });
  }

  private loadAgentMd(workDir: string, pathType: string): string | null {
    const candidates = ['agent.md', 'AGENT.md'];
    const MAX_SIZE = 10 * 1024; // 10KB cap

    if (pathType === 'wsl') {
      for (const name of candidates) {
        try {
          const content = execFileSync('wsl.exe', ['bash', '-lc', `cat '${workDir}/${name}'`], {
            encoding: 'utf-8',
            timeout: 5000,
          });
          if (content && content.trim()) {
            const trimmed = content.substring(0, MAX_SIZE);
            addEvent('system', 'agent_md_loaded', `${workDir}/${name}`);
            return trimmed;
          }
        } catch {
          // File doesn't exist, try next
        }
      }
    } else {
      for (const name of candidates) {
        const fullPath = path.join(workDir, name);
        if (fs.existsSync(fullPath)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            if (content && content.trim()) {
              const trimmed = content.substring(0, MAX_SIZE);
              addEvent('system', 'agent_md_loaded', fullPath);
              return trimmed;
            }
          } catch {
            // Read error, skip
          }
        }
      }
    }
    return null;
  }

  private setupFileTracker(agent: Agent, workingDirectory: string): FileActivityTracker | null {
    // PTY scraping is Claude-specific (matches the `⏺ Read(path)` TUI syntax).
    // Non-Claude providers' file activity comes from their structured JSONL via
    // ContextStatsMonitor; running this tracker on them produces comma-blob junk.
    if (agent.provider !== 'claude') return null;
    const tracker = new FileActivityTracker(agent.id, workingDirectory);
    this.fileTrackers.set(agent.id, tracker);
    tracker.on('activity', (activity) => {
      this.emit('fileActivity', activity);
    });
    return tracker;
  }

  private async launchWindowsAgent(agent: Agent, resume = false, agentMdPrompt?: string | null, sessionId?: string, overrideArgs?: string[], freshSession = false): Promise<void> {
    const runner = new WindowsRunner();
    this.windowsRunners.set(agent.id, runner);

    // Parse command into executable and args
    const parts = agent.command.split(/\s+/);
    const cmd = parts[0];
    let args = overrideArgs || parts.slice(1);

    if (!overrideArgs) {
      const isClaude = agent.provider === 'claude';

      // Supervisor: prompt now goes via positional argument (set in launchAgent).
      // Only inject MCP config via --mcp-config flag here.
      if (agent.isSupervisor && isClaude) {
        const mcpScriptPath = getScriptPath('mcp-supervisor.js').replace(/\\/g, '/');
        const mcpConfig = JSON.stringify({
          mcpServers: {
            'agent-dashboard': {
              command: 'node',
              args: [mcpScriptPath],
              env: {
                AGENT_DASHBOARD_API_PORT: String(this.apiServerPort),
                AGENT_DASHBOARD_API_TOKEN: getApiToken(),
              },
            },
          },
        });
        args.push('--mcp-config', mcpConfig);
        console.log(`[Windows] Supervisor MCP config injected via --mcp-config`);
      }

      // Workspace-root contract (see docs/PERSISTENT_AGENT_LAUNCH_CONTRACT.md):
      //   --add-dir extends file scope to the workspace and surfaces workspace-shared skills.
      //   --append-system-prompt tells the agent where the workspace is, since
      //   --add-dir's value isn't otherwise visible to the agent's context.
      // Applies to both supervisors and supervised workers (class IV): both cwd
      // into a .dashboard/ subfolder, so neither would see the workspace
      // naturally without these flags.
      if ((agent.isSupervisor || agent.isSupervised) && isClaude) {
        const workspaceRoot = getEffectiveWorkspaceRoot(agent);
        const sysPrompt = `Workspace root: ${workspaceRoot}. cd there for project shell work. Use absolute paths for Read/Edit/Glob.`;
        args.push('--add-dir', workspaceRoot);
        // CLI v2.1.156 regression: inline `--append-system-prompt "<string>"`
        // makes claude exit immediately in INTERACTIVE mode. Write the prompt to
        // a file and pass `--append-system-prompt-file <path>` instead, which
        // still works interactively. (Mirrors the WSL path below.)
        const sysFile = path.join(agent.workingDirectory, '.claude', `.sysprompt-${agent.id}.txt`);
        try {
          fs.mkdirSync(path.dirname(sysFile), { recursive: true });
          fs.writeFileSync(sysFile, sysPrompt, 'utf-8');
          args.push('--append-system-prompt-file', sysFile);
          const role = agent.isSupervisor ? 'Supervisor' : 'Worker';
          console.log(`[Windows] ${role} --add-dir + --append-system-prompt-file: ${workspaceRoot}`);
        } catch (err) {
          // File write failed — launch without the textual preamble rather than
          // re-introduce the crashing inline flag. --add-dir already scopes the
          // workspace; only the workspace-root sentence is lost.
          console.warn(`[Windows] Failed to write sysprompt file ${sysFile}; launching without --append-system-prompt:`, err);
        }
      }

      // Add session ID on fresh launch (Claude only)
      if (!resume && sessionId && isClaude) {
        args.push('--session-id', sessionId);
        console.log(`[Windows] Fresh launch ${agent.title} (${agent.id}) with session-id: ${sessionId}`);
      }

      // Resume by explicit session ID. Never fall back to --continue here:
      // when multiple agents share a workdir, --continue picks the most recent
      // session in cwd and silently cross-contaminates restarts. If the ID is
      // missing, treat as a hard error so the supervisor surfaces a 'crashed'.
      //
      // BUG-21 Option 1: validate the JSONL exists on disk before trusting
      // `resumeSessionId`. See the WSL counterpart for the full rationale.
      if (resume && isClaude && !args.includes('--continue') && !args.includes('-c')) {
        const latest = getAgent(agent.id);
        if (!latest?.resumeSessionId) {
          throw new Error(`Cannot resume ${agent.title} (${agent.id}): no resumeSessionId on record`);
        }
        const existsOnDisk = this.sessionLogReader.sessionFileExists(
          'claude',
          agent.workingDirectory,
          latest.resumeSessionId,
        );
        if (existsOnDisk) {
          args.push('--resume', latest.resumeSessionId);
          console.log(`[Windows] Resuming ${agent.title} (${agent.id}) with session: ${latest.resumeSessionId}`);
        } else {
          const missingId = latest.resumeSessionId;
          const newId = uuidv4();
          updateAgentResumeSessionId(agent.id, newId);
          this.sessionLogReader.invalidatePath(agent.id);
          args.push('--session-id', newId);
          console.warn(`[Windows] Resume session not found on disk for ${agent.id} (${missingId}); falling back to fresh launch with new session-id ${newId}`);
        }
      }

      // Gemini resume: bare --resume picks the most recent session for this user.
      // Caveat: not scoped to cwd or to this specific agent — if multiple Gemini
      // agents are running, the wrong one's session can be picked. Acceptable for
      // single-Gemini-agent workflows; named-session (--resume <name> via /chat
      // save) is the proper fix and can be layered on later.
      if (resume && agent.provider === 'gemini' && !args.includes('--resume') && !args.includes('-r')) {
        args.push('--resume');
        console.log(`[Windows] Resuming ${agent.title} (${agent.id}) with gemini --resume (most-recent session)`);
      }

      if (resume && agent.provider === 'codex') {
        // BUG-04: `discoverNewCodexSession`'s 10 s post-launch poll often
        // misses the codex `session_meta` flush. Self-heal by falling back to
        // a cwd-match rollout scan the first time we actually need the sid.
        const sid = this.resolveCodexResumeSessionId(agent);
        if (!sid) {
          throw new Error(`Cannot resume ${agent.title} (${agent.id}): no Codex resumeSessionId on record and no cwd-matching rollout found`);
        }
        args = buildCodexResumeArgs(args, sid);
        console.log(`[Windows] Resuming ${agent.title} (${agent.id}) with codex resume ${sid}`);
      }

      // Append agent.md content as final positional argument (Claude only)
      if (agentMdPrompt && !resume && isClaude) {
        args.push(agentMdPrompt);
      }
    }

    // Setup file activity tracker (claude-only; non-claude get null)
    const tracker = this.setupFileTracker(agent, getEffectiveWorkspaceRoot(agent));

    runner.on('data', (data: string) => {
      updateAgentLastOutput(agent.id);
      if (tracker) tracker.processData(data);
    });

    runner.on('exit', (exitCode: number) => {
      // Drain-time exits must NOT flip status to 'done'/'crashed' — keeping
      // the agent 'working'/'idle' in the DB is what makes reconcile()
      // respawn it with --continue at next startup.
      if (this.shuttingDown) { this.windowsRunners.delete(agent.id); return; }
      updateAgentExitCode(agent.id, exitCode);
      this.windowsRunners.delete(agent.id);
      const status: AgentStatus = exitCode === 0 ? 'done' : 'crashed';
      const prior = getAgent(agent.id)?.status;
      updateAgentStatus(agent.id, status);
      addEvent(agent.id, status, JSON.stringify({ exitCode }));
      this.emit('statusChanged', { agentId: agent.id, status, fromStatus: prior, source: 'runner-exit' } satisfies StatusChangedEvent);
      // BUG-23 — terminal exit invalidates any pending settle timer.
      this.monitor.clearLaunch(agent.id);
      // P1 §3 — drop this worker's spool-tailer claim (a relaunch re-claims).
      this.releaseSpoolTailer(agent.id);

      // Auto-restart
      const latest = getAgent(agent.id);
      if (latest && status === 'crashed' && latest.autoRestartEnabled) {
        this.handleAutoRestart(latest);
      }
    });

    // Use directSpawn when we have a multiline positional argument (prompt text)
    // or when launching a persistent agent (supervisor OR supervised worker —
    // both pass an --append-system-prompt value with spaces at line 987 that
    // cmd.exe argument parsing would shred). Without directSpawn, pty-host's
    // cmd.exe wrap now quotes args with whitespace, but persistent-agent launches
    // still prefer direct-spawn so the load-bearing system prompt never
    // round-trips through cmd.exe parsing at all. (Matches the WSL path's
    // `(isSupervisor || isSupervised)` gate at line 1234.)
    const hasPromptArg = !!agentMdPrompt && !resume && agent.provider === 'claude';
    const persistentAgentDirectSpawn = !!(agent.isSupervisor || agent.isSupervised) && agent.provider === 'claude' && !overrideArgs;
    const needsDirectSpawn = hasPromptArg || persistentAgentDirectSpawn;
    let launchCmd = cmd;
    if (needsDirectSpawn) {
      try {
        launchCmd = await findWindowsClaudePath(process.env as NodeJS.ProcessEnv);
        console.log(`[Windows] Using direct spawn with: ${launchCmd} (hasPromptArg=${hasPromptArg}, supervisor=${agent.isSupervisor}, supervised=${agent.isSupervised})`);
      } catch (err) {
        console.warn(`[Windows] Could not resolve claude.exe path, falling back to cmd.exe:`, err);
      }
    }
    const useDirectSpawn = needsDirectSpawn && launchCmd !== cmd;

    // BUG-26: every non-resume codex launch (including freshSession=true)
    // runs post-launch discovery so the new agent record gets bound to the
    // codex-minted session id via the race-resistant SQLite path
    // (cwd + created_at + first_user_message_prefix). The pre-BUG-26
    // freshSession opt-out left `resumeSessionId` null and forced
    // CodexRolloutReader to fall back to cwd-as-identity proxy, which
    // mis-attributed events under concurrent same-cwd launches.
    const codexSnapshot = shouldDiscoverCodexSession({ provider: agent.provider, resume, freshSession })
      ? await snapshotCodexSessions('windows')
      : null;
    const codexLaunchStartedAt = Date.now();

    // BUG-13 Path A: disable Claude Code's next-prompt ghost-text suggestion
    // rendering. The grey suggestion bytes (a) flap PTY-fallback status
    // idle↔working and (b) leak verbatim into the supervisor event's `Last
    // output:` field. Documented disable knob:
    // https://code.claude.com/docs/en/interactive-mode
    //
    // Class IV (plans/class-iv-worker-hook-scaffold.md): the full worker lane
    // (isSupervised OR isWorker) gets AGENT_ID + DASHBOARD_PORT so the Stop hook
    // can identify this agent and POST to the actually-bound dashboard port.
    // Must match the launch-flag and PTY-disable gates (isWorkerLane): a plain
    // worker loads the same hooks, and PTY inference is disabled for it, so
    // without AGENT_ID the Stop hook no-ops and the agent stays stuck "working".
    const extraEnv: Record<string, string> = {};
    if (agent.provider === 'claude') {
      extraEnv.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = 'false';
    }
    if (agent.isSupervised || agent.isWorker) {
      extraEnv.AGENT_ID = agent.id;
      extraEnv.DASHBOARD_PORT = String(this.apiServerPort);
      // P1 §3 — spool path for the v7 hook script's always-write transport.
      // Env-provided (NOT script-dir-relative): the CODEX_HOME copy of the
      // script would otherwise spool to ~/, invisible to the tailer.
      extraEnv.DASHBOARD_SPOOL_PATH = path.join(
        getEffectiveWorkspaceRoot(agent), '.dashboard', 'pending-status.jsonl');
      // Tail the same file from the dashboard side.
      this.ensureSpoolTailer(agent);
    }
    const extraEnvArg = Object.keys(extraEnv).length > 0 ? extraEnv : undefined;
    // P1 §2 step 4a(iii) — current-launch stamp for the tmux-option freshness
    // gate. Set IMMEDIATELY BEFORE the actual runner launch so no event this
    // launch produces can predate the stamp.
    this.launchStartedAt.set(agent.id, Date.now());
    runner.launch(agent.workingDirectory, launchCmd, args, agent.logPath || '', useDirectSpawn, extraEnvArg);
    updateAgentPid(agent.id, runner.pid);
    // BUG-23 — write `'launching'` (was `'working'`) and stamp the settle
    // timer. `StatusMonitor.poll()` will promote `'launching' → 'idle'` once
    // `LAUNCH_SETTLE_TIMEOUT_MS[provider]` has elapsed, or a Stop hook
    // arriving inside the window can short-circuit the wallclock via
    // `forceIdleFromHook → promoteFromLaunching('stop-hook')`.
    const priorWinLaunch = getAgent(agent.id)?.status;
    updateAgentStatus(agent.id, 'launching');
    this.monitor.recordLaunch(agent.id);
    this.emit('statusChanged', { agentId: agent.id, status: 'launching', fromStatus: priorWinLaunch, source: 'launch' } satisfies StatusChangedEvent);

    if (codexSnapshot) {
      this.captureCodexSessionId(
        agent.id,
        codexSnapshot,
        agent.workingDirectory,
        codexLaunchStartedAt,
        agentMdPrompt ?? ''
      );
    }
  }

  /**
   * Retroactive recovery for codex agents whose `resumeSessionId` was never
   * persisted at launch time — e.g. the app was killed inside the 10 s
   * `discoverNewCodexSession` window, or codex flushed `session_meta` later
   * than the polling timeout. Scans the codex rollout dir for the most recent
   * rollout whose cwd matches and persists its id to the DB.
   *
   * Returns the recovered id, or null when no rollout matches.
   */
  private recoverCodexResumeSessionId(agent: Agent): string | null {
    const result = this.scanForFreshCodexRollout(agent);
    if (!result) {
      // Stale-rollout hardening: codex may simply not have written its new
      // rollout yet (interactive update prompt, ~1 s startup race — see
      // docs/BUG_claude-child-session-env-poisoning.md sibling bug). Binding
      // the newest PRE-EXISTING rollout attaches the agent to a dead chat, so
      // bind nothing now and poll for a fresh-enough rollout instead.
      this.startCodexSidRecoveryPoll(agent.id);
      return null;
    }
    updateAgentResumeSessionId(agent.id, result.sessionId);
    // BUG-26: rebind drops any provisional/wrong events the reader may have
    // emitted under the stale (empty) sessionId. invalidatePath alone only
    // clears file offsets; the dispatcher ring buffer is the load-bearing
    // surface `AgentChatService.getMessages` returns to the UI.
    this.sessionLogReader.rebindAgent(agent.id);
    console.log(
      `[Codex] Recovered session id ${result.sessionId} for agent ${agent.id} via cwd-match (${result.path})`
    );
    return result.sessionId;
  }

  /**
   * One cwd-match scan that only accepts rollouts whose session timestamp
   * (UUIDv7 / filename) is at/after the agent's launch and that no other
   * agent record already owns. Launch floor: this boot's launch stamp when
   * present, else the DB `created_at` (covers resume-after-app-restart, where
   * the agent's own older rollout is legitimately pre-boot but never predates
   * the record's creation).
   */
  private scanForFreshCodexRollout(agent: Agent): DiscoveryResult | null {
    const home: 'windows' | 'wsl' =
      detectPathType(agent.workingDirectory) === 'windows' ? 'windows' : 'wsl';
    const launchedAtMs =
      this.launchStartedAt.get(agent.id) ?? parseSqliteUtcMs(agent.createdAt);
    const ownedByOthers = new Set<string>();
    for (const other of getAllAgents()) {
      if (other.id !== agent.id && other.resumeSessionId) {
        ownedByOthers.add(other.resumeSessionId);
      }
    }
    return findCodexSessionIdByCwd({
      home,
      workingDirectory: agent.workingDirectory,
      listFiles: (h) => selectFreshCodexRollouts(
        listCodexRolloutFiles({ home: h, daysBack: 'all' }),
        { launchedAtMs, excludeSessionIds: ownedByOthers }
      ),
    });
  }

  /**
   * Bounded retry for the no-fresh-rollout-yet case: rescan every
   * CODEX_SID_RECOVERY_POLL_INTERVAL_MS for up to
   * CODEX_SID_RECOVERY_POLL_WINDOW_MS. On a hit, persist + rebind via the
   * same path as recoverCodexResumeSessionId; on expiry, warn loudly and
   * leave resumeSessionId unset (a later recovery pass, e.g. the next chat
   * read, starts a new window). Timers are unref'd so they never hold the
   * process open.
   */
  private startCodexSidRecoveryPoll(agentId: string): void {
    if (this.codexSidRecoveryPolls.has(agentId)) return;
    this.codexSidRecoveryPolls.add(agentId);
    const deadline = Date.now() + CODEX_SID_RECOVERY_POLL_WINDOW_MS;
    const tick = (): void => {
      const latest = getAgent(agentId);
      if (!latest || latest.provider !== 'codex' || latest.resumeSessionId) {
        // Gone, or bound meanwhile (post-launch SQL discovery won the race).
        this.codexSidRecoveryPolls.delete(agentId);
        return;
      }
      const result = this.scanForFreshCodexRollout(latest);
      if (result) {
        this.codexSidRecoveryPolls.delete(agentId);
        updateAgentResumeSessionId(agentId, result.sessionId);
        this.sessionLogReader.rebindAgent(agentId);
        console.log(
          `[Codex] Recovered session id ${result.sessionId} for agent ${agentId} via fresh-rollout poll (${result.path})`
        );
        return;
      }
      if (Date.now() >= deadline) {
        this.codexSidRecoveryPolls.delete(agentId);
        console.warn(
          `[Codex] sid recovery gave up for agent ${agentId}: no rollout newer than launch appeared within ` +
          `${CODEX_SID_RECOVERY_POLL_WINDOW_MS / 1000}s — leaving resumeSessionId unset rather than binding a stale rollout`
        );
        return;
      }
      const t = setTimeout(tick, CODEX_SID_RECOVERY_POLL_INTERVAL_MS);
      t.unref?.();
    };
    const t = setTimeout(tick, CODEX_SID_RECOVERY_POLL_INTERVAL_MS);
    t.unref?.();
  }

  /**
   * Read `resumeSessionId` for a Codex agent, lazy-recovering if it's null.
   * Use this at every site that needs the sid so BUG-04 (post-launch
   * discovery missed the `session_meta` flush) is self-healing instead of
   * requiring a manual recovery call.
   *
   * Returns null only when neither the persisted record nor a cwd-matching
   * rollout produced an id — i.e. the agent truly has no recoverable session.
   */
  private resolveCodexResumeSessionId(agent: Agent): string | null {
    const current = getAgent(agent.id)?.resumeSessionId ?? null;
    return ensureCodexResumeSessionId({
      current,
      recover: () => this.recoverCodexResumeSessionId(agent),
    });
  }

  /**
   * Public wrapper around resolveCodexResumeSessionId for the API layer.
   * No-op for non-codex agents or codex agents that already have a sid.
   * Called from chat-read endpoints so a Codex agent whose post-launch
   * discovery race lost still gets its rollout reader bound on the first
   * chat read. See BUG-28 in .dashboard/supervisor/memory/open-bugs.md.
   */
  public maybeRecoverCodexSid(agentId: string): void {
    const agent = getAgent(agentId);
    if (!agent || agent.provider !== 'codex') return;
    if (agent.resumeSessionId) return;
    // Do NOT pre-empt the authoritative post-launch SQL discovery
    // (`discoverNewCodexSession`, DEFAULT_SQL_POLL_TIMEOUT_MS = 35 s). While
    // that window is open a null `resumeSessionId` is expected, not a failure.
    // `recoverCodexResumeSessionId` falls back to `findCodexSessionIdByCwd`,
    // which is identity-blind (newest cwd-matching rollout — no created_at /
    // first_user_message tiebreaker) — firing it inside the window binds a
    // sibling or stale-prior rollout (BUG-29), and discovery's null-guard then
    // locks the wrong sid in permanently. Only self-heal once discovery has
    // had time to give up; genuine race-losses recover, live launches don't
    // get hijacked. See BUG-28/BUG-29 in open-bugs.md.
    const launchedAtMs = parseSqliteUtcMs(agent.createdAt);
    if (launchedAtMs !== null && Date.now() - launchedAtMs < CODEX_DISCOVERY_GRACE_MS) {
      return;
    }
    this.resolveCodexResumeSessionId(agent);
  }

  private captureCodexSessionId(
    agentId: string,
    before: Awaited<ReturnType<typeof snapshotCodexSessions>>,
    workingDirectory: string,
    launchedAfterMs: number,
    // T1-C: per-launch tiebreaker matched against threads.first_user_message in
    // ~/.codex/state_5.sqlite. Empty/undefined makes the SQL filter a no-op so
    // we still benefit from cwd + created_at scoping on launch paths that
    // don't yet know the launch prompt.
    firstUserMessagePrefix?: string | null
  ): void {
    void discoverNewCodexSession(before, {
      workingDirectory,
      launchedAfterMs,
      firstUserMessagePrefix: firstUserMessagePrefix ?? '',
      // Default timeout (DEFAULT_SQL_POLL_TIMEOUT_MS = 35 s) lives in
      // session-id-discovery.ts. It's sized for codex's deferred threads-row
      // INSERT (~25-26 s after launch); see the comment on that constant.
    }).then((result) => {
      if (!result) return;
      const latest = getAgent(agentId);
      if (!latest || latest.resumeSessionId) return; // null-guard: don't overwrite a later restart
      updateAgentResumeSessionId(agentId, result.sessionId);
      // BUG-26: see recoverCodexResumeSessionId — drop any provisional ring
      // events emitted while sessionId was empty so they can't survive into
      // the chat the user/supervisor reads.
      this.sessionLogReader.rebindAgent(agentId);
      console.log(`[Codex] Captured session id ${result.sessionId} for agent ${agentId}`);
    }).catch((err) => {
      console.warn(`[Codex] session-id discovery failed for ${agentId}:`, err);
    });
  }

  private async launchWslAgent(agent: Agent, resume = false, agentMdPrompt?: string | null, overrideCommand?: string, sessionId?: string, freshSession = false): Promise<void> {
    if (!agent.tmuxSessionName) throw new Error('No tmux session name');

    const runner = new WslRunner(agent.tmuxSessionName);
    this.wslRunners.set(agent.id, runner);

    // Do not convert log path to WSL; WslRunner runs in Windows Node.js and needs a native path.
    const nativeLogPath = agent.logPath || '';
    const wslWorkDir = agent.workingDirectory; // Already a WSL path

    let command = overrideCommand || agent.command;
    const isClaude = agent.provider === 'claude';

    // BUG-13 Path A: disable Claude Code's next-prompt ghost-text suggestion
    // rendering. The grey suggestion bytes (a) flap PTY-fallback status
    // idle↔working and (b) leak verbatim into the supervisor event's `Last
    // output:` field. Documented disable knob:
    // https://code.claude.com/docs/en/interactive-mode
    // Use bash's native command-prefix assignment (`VAR=value cmd`) rather than
    // `env VAR=value cmd` / `exec`: on WSL the user's `ccode`/`ccodex` are bash
    // functions in .bashrc, and `env`/`exec` only do PATH lookups so they fail
    // with "No such file or directory". The bash command-prefix is parsed by
    // the shell, so the lookup goes through normal function/alias resolution.
    //
    // Class IV (plans/class-iv-worker-hook-scaffold.md): the full worker lane
    // (isSupervised OR isWorker) gets AGENT_ID + DASHBOARD_PORT so the Stop hook
    // can identify this agent and POST to the dashboard. Must match the
    // launch-flag and PTY-disable gates — a plain worker loads the same hooks
    // with PTY inference disabled, so without AGENT_ID the Stop hook no-ops and
    // the agent stays stuck "working".
    //
    // L-C (plans/windows-wsl-issues-review-2026-05-23.md §T1-B): WSL2 default
    // NAT mode means 127.0.0.1 inside the distro is the distro's loopback,
    // NOT the Windows host's. Inject DASHBOARD_HOST=<gateway-ip> here so the
    // dashboard-status.mjs hook script reaches the actual ApiServer running
    // on the Windows host. Windows path (launchWindowsAgent above) does NOT
    // set DASHBOARD_HOST — the script's '127.0.0.1' fallback works there.
    const wslEnvPrefix: string[] = [];
    if (isClaude) {
      wslEnvPrefix.push('CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false');
    }
    if (agent.isSupervised || agent.isWorker) {
      wslEnvPrefix.push(`AGENT_ID=${agent.id}`);
      wslEnvPrefix.push(`DASHBOARD_PORT=${this.apiServerPort}`);
      wslEnvPrefix.push(`DASHBOARD_HOST=${this.resolveWslGatewayIp()}`);
      // P1 §3 — spool path (WSL-native form) for the v7 hook script's
      // always-write transport. shQuote'd: workspace paths can contain
      // spaces, and bash command-prefix assignments word-split otherwise.
      wslEnvPrefix.push(
        `DASHBOARD_SPOOL_PATH=${shQuote(`${getEffectiveWorkspaceRoot(agent)}/.dashboard/pending-status.jsonl`)}`);
      // Tail the same file from the dashboard side (UNC form).
      this.ensureSpoolTailer(agent);
    }
    if (wslEnvPrefix.length > 0) {
      command = `${wslEnvPrefix.join(' ')} ${command}`;
    }

    // Persistent-agent workspace-root contract (see docs/PERSISTENT_AGENT_LAUNCH_CONTRACT.md).
    // Computed up here so it's available both for the bare-command case and for the
    // wrap-with-prompt case below. Fires for supervisors AND supervised workers
    // (class IV): both cwd into a .dashboard/ subfolder, so neither would see
    // the workspace naturally without --add-dir + --append-system-prompt.
    let sysPromptText: string | null = null;
    let persistentWorkspaceRoot: string | null = null;
    if ((agent.isSupervisor || agent.isSupervised) && isClaude && !overrideCommand) {
      persistentWorkspaceRoot = getEffectiveWorkspaceRoot(agent);
      sysPromptText = `Workspace root: ${persistentWorkspaceRoot}. cd there for project shell work. Use absolute paths for Read/Edit/Glob.`;
    }

    if (!overrideCommand) {
      // Supervisor MCP config: rely on .mcp.json file (written by ensureMcpConfig in launchAgent).
      // No --mcp-config flag needed — Claude Code auto-discovers .mcp.json in the workspace.
      if (agent.isSupervisor && isClaude) {
        console.log(`[WSL] Supervisor MCP: relying on .mcp.json auto-discovery in ${wslWorkDir}`);
      }

      // Append --add-dir on the bare command. The --append-system-prompt-file
      // flag is added inside the wrap below, alongside the sysprompt file written
      // there, so its single-quoted path stays intact through the outer wrap.
      if ((agent.isSupervisor || agent.isSupervised) && isClaude && persistentWorkspaceRoot) {
        command += ` --add-dir '${persistentWorkspaceRoot}'`;
        const role = agent.isSupervisor ? 'Supervisor' : 'Worker';
        console.log(`[WSL] ${role} --add-dir: ${persistentWorkspaceRoot}`);
      }

      // Add session ID on fresh launch (Claude only)
      if (!resume && sessionId && isClaude) {
        command += ` --session-id ${sessionId}`;
        console.log(`[WSL] Fresh launch ${agent.title} (${agent.id}) with session-id: ${sessionId}`);
      }

      // Resume by explicit session ID. Never fall back to --continue here:
      // when multiple agents share a workdir, --continue picks the most recent
      // session in cwd and silently cross-contaminates restarts. If the ID is
      // missing, treat as a hard error so the supervisor surfaces a 'crashed'.
      //
      // BUG-21 Option 1: validate the JSONL exists on disk before trusting
      // `resumeSessionId`. `launchAgent` pre-populates the column before the
      // first launch proves Claude wrote the session file (index.ts:535-540);
      // if Claude crashed before flushing the JSONL, every restart attempt
      // would emit `--resume <uuid>` and hit "No conversation found" forever.
      if (resume && isClaude && !command.includes('--continue') && !command.includes('-c ')) {
        const latest = getAgent(agent.id);
        if (!latest?.resumeSessionId) {
          throw new Error(`Cannot resume ${agent.title} (${agent.id}): no resumeSessionId on record`);
        }
        const existsOnDisk = this.sessionLogReader.sessionFileExists(
          'claude',
          wslWorkDir,
          latest.resumeSessionId,
        );
        if (existsOnDisk) {
          command += ` --resume ${latest.resumeSessionId}`;
          console.log(`[WSL] Resuming ${agent.title} (${agent.id}) with session: ${latest.resumeSessionId}`);
        } else {
          const missingId = latest.resumeSessionId;
          const newId = uuidv4();
          updateAgentResumeSessionId(agent.id, newId);
          this.sessionLogReader.invalidatePath(agent.id);
          command += ` --session-id ${newId}`;
          console.warn(`[WSL] Resume session not found on disk for ${agent.id} (${missingId}); falling back to fresh launch with new session-id ${newId}`);
        }
      }

      // Gemini resume: bare --resume picks the most recent session for this user.
      // Caveat: not scoped to cwd or to this specific agent — if multiple Gemini
      // agents are running, the wrong one's session can be picked. Acceptable for
      // single-Gemini-agent workflows; named-session (/chat save <name> + --resume
      // <name>) is the proper fix and can be layered on later.
      if (resume && agent.provider === 'gemini' && !command.includes('--resume') && !command.includes(' -r ')) {
        command += ' --resume';
        console.log(`[WSL] Resuming ${agent.title} (${agent.id}) with gemini --resume (most-recent session)`);
      }

      if (resume && agent.provider === 'codex') {
        // BUG-04: lazy fallback — see launchWindowsAgent for the rationale.
        const sid = this.resolveCodexResumeSessionId(agent);
        if (!sid) {
          throw new Error(`Cannot resume ${agent.title} (${agent.id}): no Codex resumeSessionId on record and no cwd-matching rollout found`);
        }
        command = buildCodexResumeCommand(command, sid);
        console.log(`[WSL] Resuming ${agent.title} (${agent.id}) with codex resume ${sid}`);
      }

      // Wrap the command to load any of:
      //   - agentMdPrompt (workspace agent.md content) → final positional argument
      //   - sysPromptText (supervisor workspace-root preamble) → --append-system-prompt-file path
      // via $(cat tmpfile) substitutions inside the wrap. Required because the outer
      // ${command} "$PROMPT" word-splits the unquoted ${command} substitution
      // without re-interpreting embedded quote characters, so quoted values placed
      // directly in the bare command string would be broken into pieces.
      // No `exec`: on WSL the command may be a bash function (`ccode`/`ccodex`),
      // and `exec` only does PATH lookups so it would fail to resolve it. Cost
      // is one extra shell process in the tree; not worth the breakage.
      if ((agentMdPrompt || sysPromptText) && !resume && isClaude) {
        const writeWslFile = (relName: string, content: string): string | null => {
          const file = `${wslWorkDir}/.claude/${relName}`;
          try {
            const b64 = Buffer.from(content, 'utf-8').toString('base64');
            execFileSync('wsl.exe', ['bash', '-lc',
              `mkdir -p '${wslWorkDir}/.claude' && echo '${b64}' | base64 -d > '${file}'`
            ], { timeout: 5000 });
            return file;
          } catch (err) {
            console.warn(`[WSL] Failed to write ${relName}:`, err);
            return null;
          }
        };

        const exports: string[] = [];
        const flagSuffix: string[] = [];
        let promptArg = '';

        if (sysPromptText) {
          const sysFile = writeWslFile(`.sysprompt-${agent.id}.txt`, sysPromptText);
          if (sysFile) {
            // CLI v2.1.156 regression: inline `--append-system-prompt "<string>"`
            // makes claude exit immediately in INTERACTIVE mode. Pass the same
            // file directly via `--append-system-prompt-file`, which works
            // interactively and drops the SYSPROMPT shell-var round-trip.
            flagSuffix.push(`--append-system-prompt-file '${sysFile}'`);
          }
        }

        if (agentMdPrompt) {
          const promptFile = writeWslFile(`.prompt-${agent.id}.txt`, agentMdPrompt);
          if (promptFile) {
            exports.push(`PROMPT="$(cat '${promptFile}')"`);
            promptArg = ` "$PROMPT"`;
          } else {
            // Fallback: embed agent.md directly with single-quote escaping
            const escaped = agentMdPrompt.replace(/'/g, "'\\''");
            promptArg = ` '${escaped}'`;
          }
        }

        const exportPrefix = exports.length > 0 ? `${exports.join(' && ')} && ` : '';
        const flags = flagSuffix.length > 0 ? ` ${flagSuffix.join(' ')}` : '';
        command = `cd '${wslWorkDir}' && ${exportPrefix}${command}${flags}${promptArg}`;
        console.log(`[WSL] Wrapped command — sysprompt:${!!sysPromptText} agentMd:${!!agentMdPrompt}`);
      }
    }

    // Setup file activity tracker (claude-only; non-claude get null)
    const tracker = this.setupFileTracker(agent, getEffectiveWorkspaceRoot(agent));

    runner.on('data', (data: string) => {
      updateAgentLastOutput(agent.id);
      if (tracker) tracker.processData(data);
    });

    runner.on('exit', (exitCode: number) => {
      // See the Windows runner-exit handler: shutdown-time exits keep the
      // agent's pre-quit status so reconcile() picks it up next startup.
      if (this.shuttingDown) { this.wslRunners.delete(agent.id); return; }
      updateAgentExitCode(agent.id, exitCode);
      this.wslRunners.delete(agent.id);
      const status: AgentStatus = exitCode === 0 ? 'done' : 'crashed';
      const prior = getAgent(agent.id)?.status;
      updateAgentStatus(agent.id, status);
      addEvent(agent.id, status, JSON.stringify({ exitCode }));
      this.emit('statusChanged', { agentId: agent.id, status, fromStatus: prior, source: 'runner-exit' } satisfies StatusChangedEvent);
      // BUG-23 — terminal exit invalidates any pending settle timer.
      this.monitor.clearLaunch(agent.id);
      // P1 §3 — drop this worker's spool-tailer claim (a relaunch re-claims).
      this.releaseSpoolTailer(agent.id);

      const latest = getAgent(agent.id);
      if (latest && status === 'crashed' && latest.autoRestartEnabled) {
        this.handleAutoRestart(latest);
      }
    });

    console.log(`[WSL] Launching agent '${agent.tmuxSessionName}' in ${wslWorkDir}`);
    console.log(`[WSL] Command: ${command}`);

    // BUG-22 Step 1 diagnostic: assemble metadata so the runner can append one
    // structured JSONL record per launch attempt to
    // `<workspace>/.dashboard/launches.log`. Replaces the prior one-line
    // plain-text write. Workspace-relative so the log travels with the failing
    // workspace and is easy to inspect beside the scaffold.
    const launchStartedAtIso = new Date().toISOString();
    let launchesLogPath: string | null = null;
    try {
      const workspace = getWorkspace(agent.workspaceId);
      if (workspace && workspace.path) {
        // Node runs on Windows; a WSL workspace's `path` is the POSIX form
        // (`/home/...`), which `path.join` would resolve drive-relative on the
        // current Windows drive and `fs.appendFileSync` would ENOENT on. Convert
        // to a Windows-accessible UNC (`\\wsl$\Ubuntu\home\...`) so the write
        // lands at the corresponding `/home/.../launches.log` from inside WSL.
        const winPath = detectPathType(workspace.path) === 'wsl'
          ? wslToWindowsPath(workspace.path)
          : workspace.path;
        launchesLogPath = path.join(winPath, '.dashboard', 'launches.log');
      }
    } catch { /* best-effort */ }
    const diagnostics: WslLaunchDiagnostics = {
      launchStartedAt: launchStartedAtIso,
      launchesLogPath,
      agentId: agent.id,
      agentTitle: agent.title,
      workspaceId: agent.workspaceId,
      provider: agent.provider,
      isSupervisor: !!agent.isSupervisor,
      isSupervised: !!agent.isSupervised,
      resume,
      freshSession,
    };

    // BUG-22 Step 1 diagnostic: surface a distinct `tmux_new_session_failed`
    // lifecycle event (audit row + supervisor notification) when the runner
    // detects tmuxNewSession returning non-zero. Distinct from the
    // crashed-status event that follows when `tmux attach` exits — that one
    // looks like a generic worker crash; this one points at the upstream
    // structural cause.
    runner.on('tmuxNewSessionFailed', (failure: {
      tmuxSessionName: string;
      command: string;
      tmuxExitCode: number | null;
      tmuxStderr: string;
      tmuxCommand: string;
    }) => {
      addEvent(agent.id, 'tmux_new_session_failed', JSON.stringify(failure));
      void this.bridge.onTmuxNewSessionFailed({
        agent,
        tmuxSessionName: failure.tmuxSessionName,
        command: failure.command,
        tmuxExitCode: failure.tmuxExitCode,
        tmuxStderr: failure.tmuxStderr,
        tmuxCommand: failure.tmuxCommand,
      });
    });

    // BUG-26: every non-resume codex launch (including freshSession=true)
    // runs post-launch discovery so the new agent record gets bound to the
    // codex-minted session id via the race-resistant SQLite path. See the
    // longer rationale on the Windows path above.
    const codexSnapshot = shouldDiscoverCodexSession({ provider: agent.provider, resume, freshSession })
      ? await snapshotCodexSessions('wsl')
      : null;
    const codexLaunchStartedAt = Date.now();

    // P1 §2 step 4a(iii) — current-launch stamp for the tmux-option freshness
    // gate. Set IMMEDIATELY BEFORE the actual runner launch so no event this
    // launch produces can predate the stamp.
    this.launchStartedAt.set(agent.id, Date.now());
    await runner.launch(wslWorkDir, command, nativeLogPath, diagnostics);
    // BUG-23 — write `'launching'` (was `'working'`) and stamp the settle
    // timer. See the Windows path above for the lifecycle description; the
    // promotion mechanism is provider-neutral.
    const priorWslLaunch = getAgent(agent.id)?.status;
    updateAgentStatus(agent.id, 'launching');
    this.monitor.recordLaunch(agent.id);
    this.emit('statusChanged', { agentId: agent.id, status: 'launching', fromStatus: priorWslLaunch, source: 'launch' } satisfies StatusChangedEvent);

    if (codexSnapshot) {
      this.captureCodexSessionId(
        agent.id,
        codexSnapshot,
        wslWorkDir,
        codexLaunchStartedAt,
        agentMdPrompt ?? ''
      );
    }
  }

  private async handleAutoRestart(agent: Agent): Promise<void> {
    // Single choke point for all three auto-restart triggers (both runner-exit
    // handlers + the StatusMonitor statusChanged listener): never respawn an
    // agent the shutdown drain just exited.
    if (this.shuttingDown) return;
    if (agent.restartCount >= 5) {
      addEvent(agent.id, 'restart_limit_reached');
      return;
    }

    // BUG-09 §3.7 — drop the latch before transitioning to `restarting` so a
    // mid-tool crash does not leave a tool-pending latch alive for 15 min.
    this.monitor.forgetAgent(agent.id);

    const priorRestart = getAgent(agent.id)?.status;
    updateAgentStatus(agent.id, 'restarting');
    addEvent(agent.id, 'restarting');
    this.emit('statusChanged', { agentId: agent.id, status: 'restarting', fromStatus: priorRestart, source: 'restart' } satisfies StatusChangedEvent);
    incrementRestartCount(agent.id);

    setTimeout(async () => {
      const latest = getAgent(agent.id);
      if (!latest || latest.status !== 'restarting') return;

      try {
        const pathType = detectPathType(latest.workingDirectory);
        if (pathType === 'windows') {
          await this.launchWindowsAgent(latest, true);
        } else {
          await this.launchWslAgent(latest, true);
        }
      } catch (err) {
        const priorRestartFail = getAgent(agent.id)?.status;
        updateAgentStatus(agent.id, 'crashed');
        addEvent(agent.id, 'restart_failed', String(err));
        this.emit('statusChanged', { agentId: agent.id, status: 'crashed', fromStatus: priorRestartFail, source: 'restart-failed' } satisfies StatusChangedEvent);
      }
    }, 2000);
  }

  async forkAgent(sourceAgentId: string): Promise<Agent> {
    const source = getAgent(sourceAgentId);
    if (!source) throw new Error('Source agent not found');
    if (source.provider !== 'claude') throw new Error('Fork is only supported for Claude agents');
    if (!source.resumeSessionId) throw new Error('Source agent has no session ID — cannot fork');

    const workspace = getWorkspace(source.workspaceId);
    if (!workspace) throw new Error('Workspace not found');

    const newSessionId = uuidv4();
    const logPath = path.join(this.logsDir, `${uuidv4().substring(0, 8)}.log`);

    let tmuxSessionName: string | null = null;
    const pathType = detectPathType(source.workingDirectory);
    if (pathType === 'wsl') {
      const slug = (source.title + ' fork').toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 20);
      tmuxSessionName = `${TMUX_SESSION_PREFIX}${slug}__${uuidv4().substring(0, 8)}`;
    }

    const newAgent = createAgent({
      workspaceId: source.workspaceId,
      title: source.title + ' (fork)',
      roleDescription: source.roleDescription,
      workingDirectory: source.workingDirectory,
      command: source.command,
      provider: source.provider,
      // Preserve the worker status lane so the fork (which inherits source's
      // .dashboard/workers/<provider>/ cwd) keeps deriving status from hooks
      // rather than reverting to PTY/chat-stream inference. Supervision is not
      // inherited by a fork (existing behavior).
      isWorker: source.isWorker,
      tmuxSessionName,
      autoRestartEnabled: source.autoRestartEnabled,
      logPath,
    });

    updateAgentResumeSessionId(newAgent.id, newSessionId);
    this.sessionLogReader.invalidatePath(newAgent.id);
    addEvent(newAgent.id, 'forked', JSON.stringify({ sourceAgentId, sourceSessionId: source.resumeSessionId }));

    if (pathType === 'windows') {
      const parts = source.command.split(/\s+/);
      const cmd = parts[0];
      const forkArgs = [...parts.slice(1), '--resume', source.resumeSessionId, '--fork-session', '--session-id', newSessionId];
      await this.launchWindowsAgent(newAgent, false, null, undefined, forkArgs);
    } else {
      const forkCommand = `${source.command} --resume ${source.resumeSessionId} --fork-session --session-id ${newSessionId}`;
      await this.launchWslAgent(newAgent, false, null, forkCommand);
    }

    return getAgent(newAgent.id)!;
  }

  async queryAgent(targetAgentId: string, question: string, sourceAgentId?: string): Promise<QueryResult> {
    const target = getAgent(targetAgentId);
    if (!target) throw new Error('Target agent not found');
    if (target.provider !== 'claude') throw new Error('Inter-agent query is only supported for Claude agents');
    if (!target.resumeSessionId) throw new Error('Target agent has no session ID — cannot query');

    const source = sourceAgentId ? getAgent(sourceAgentId) : null;

    // Strong identity-anchored prompt to prevent history pattern-matching
    const sourceRef = source ? ` ("${source.title}")` : '';
    const prefixedQuestion = [
      `You are "${target.title}" — a Claude Code agent being consulted by another agent${sourceRef} in the same workspace.`,
      '',
      'This is NOT a task. Do NOT perform actions, use tools, run commands, or delegate work.',
      '',
      'You are being asked a question. Answer it directly from what you already know — your conversation history, the files you have read, the context you have built up. Everything you need is already in your memory.',
      '',
      'NOTE: Your conversation history may contain previous /query-agent skill invocations where you queried OTHER agents. Ignore those patterns. You are not running a query right now — you are ANSWERING one.',
      '',
      `Question: ${question}`,
    ].join('\n');

    const pathType = detectPathType(target.workingDirectory);

    const runQuery = (resumeArgs: string[]): Promise<QueryResult> => {
      return new Promise<QueryResult>((resolve) => {
        // Build a clean env: inherit everything but remove vars that block Claude
        const env = { ...process.env };
        delete env.CLAUDECODE;
        delete env.ELECTRON_RUN_AS_NODE;
        // Ensure the env vars are truly absent, not empty strings
        if ('CLAUDECODE' in env) delete env.CLAUDECODE;

        const mode = resumeArgs[0] === '--resume' ? 'resume' : 'continue';
        const resumeValue = resumeArgs[1] || '';

        if (pathType === 'windows') {
          const claudePath = path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe');
          const args = ['-p', prefixedQuestion];
          if (mode === 'resume') {
            args.push('--resume', resumeValue);
          } else {
            args.push('--continue');
          }
          args.push('--fork-session', '--dangerously-skip-permissions', '--max-turns', '1', '--output-format', 'json');

          console.log('[query] Spawning:', claudePath, args.join(' '), 'cwd:', target.workingDirectory);

          // Use spawn so we can close stdin — claude -p hangs if stdin stays open
          const child = spawn(claudePath, args, {
            cwd: target.workingDirectory,
            windowsHide: true,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
          child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

          const timer = setTimeout(() => { child.kill(); }, 60000);

          child.on('close', (code: number | null) => {
            clearTimeout(timer);
            if (code !== 0) {
              console.error('[query] Windows exit code:', code, 'stderr:', stderr, 'stdout:', stdout.substring(0, 200));
              resolve(formatQueryError(new Error(`Exit code ${code}`), stdout, stderr));
              return;
            }
            resolve(parseQueryResponse(stdout));
          });

          child.on('error', (err: Error) => {
            clearTimeout(timer);
            console.error('[query] Windows spawn error:', err.message);
            resolve(formatQueryError(err, '', ''));
          });
        } else {
          // Use spawn with stdin closed — same fix as Windows.
          // claude -p hangs if stdin stays open (execFile keeps it open as a pipe).
          const script = [
            'set -e',
            'cd "$AGENT_DASHBOARD_WORKDIR"',
            'args=(-p "$AGENT_DASHBOARD_QUERY")',
            'if [ "$AGENT_DASHBOARD_RESUME_MODE" = "resume" ]; then',
            '  args+=(--resume "$AGENT_DASHBOARD_RESUME_VALUE")',
            'else',
            '  args+=(--continue)',
            'fi',
            'args+=(--fork-session --dangerously-skip-permissions --max-turns 1 --output-format json)',
            'claude "${args[@]}"',
          ].join('\n');

          // Declare WSLENV so custom env vars reliably propagate into WSL
          // (default sharing can be disabled via /etc/wsl.conf interop settings)
          const queryVars = 'AGENT_DASHBOARD_WORKDIR:AGENT_DASHBOARD_QUERY:AGENT_DASHBOARD_RESUME_MODE:AGENT_DASHBOARD_RESUME_VALUE';
          const currentWslenv = env.WSLENV || '';
          const wslenv = currentWslenv ? `${currentWslenv}:${queryVars}` : queryVars;

          const child = spawn(getWindowsSystemPath('wsl.exe'), ['bash', '-lc', script], {
            windowsHide: true,
            env: {
              ...env,
              WSLENV: wslenv,
              AGENT_DASHBOARD_WORKDIR: target.workingDirectory,
              AGENT_DASHBOARD_QUERY: prefixedQuestion,
              AGENT_DASHBOARD_RESUME_MODE: mode,
              AGENT_DASHBOARD_RESUME_VALUE: resumeValue,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          let stdout = '';
          let stderr = '';
          child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
          child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

          const timer = setTimeout(() => { child.kill(); }, 60000);

          child.on('close', (code: number | null) => {
            clearTimeout(timer);
            if (code !== 0) {
              console.error('[query] WSL exit code:', code, 'stderr:', stderr, 'stdout:', stdout.substring(0, 200));
              resolve(formatQueryError(new Error(`Exit code ${code}`), stdout, stderr));
              return;
            }
            resolve(parseQueryResponse(stdout));
          });

          child.on('error', (err: Error) => {
            clearTimeout(timer);
            console.error('[query] WSL spawn error:', err.message);
            resolve(formatQueryError(err, '', ''));
          });
        }
      });
    };

    // Try --resume first; fall back to --continue if session not found
    let result = await runQuery(['--resume', target.resumeSessionId!]);
    if (result.isError && /conversation|session|not found/i.test(result.result)) {
      console.log('[query] --resume failed, falling back to --continue for', target.title);
      result = await runQuery(['--continue']);
    }

    // Auto-inject response into the source agent's terminal so it has context
    if (source && !result.isError && result.result) {
      const injection = `[INTER-AGENT RESPONSE from "${target.title}"]: ${result.result}`;
      const winRunner = this.windowsRunners.get(sourceAgentId!);
      if (winRunner) {
        winRunner.write(injection + '\n');
        console.log('[query] Injected response into', source.title);
      }
      const wslRunner = this.wslRunners.get(sourceAgentId!);
      if (wslRunner) {
        wslRunner.write(injection + '\n');
        console.log('[query] Injected response into', source.title, '(WSL)');
      }
    }

    return result;
  }

  async stopAgent(agentId: string): Promise<void> {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      winRunner.kill();
      this.windowsRunners.delete(agentId);
    }

    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      await wslRunner.kill();
      this.wslRunners.delete(agentId);
    }

    this.fileTrackers.delete(agentId);
    // WP-P2 — a stopped agent must never receive its pending initial prompt
    // (clear BEFORE the 'done' emission below; 'done' is input-accepting).
    this.pendingInitialPrompts.delete(agentId);
    const priorStop = getAgent(agentId)?.status;
    updateAgentStatus(agentId, 'done');
    updateAgentExitCode(agentId, 0);
    addEvent(agentId, 'stopped');
    this.emit('statusChanged', { agentId, status: 'done', fromStatus: priorStop, source: 'stop' } satisfies StatusChangedEvent);
  }

  async deleteAgent(agentId: string): Promise<void> {
    // Stop process if running
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      winRunner.kill();
      this.windowsRunners.delete(agentId);
    }

    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      await wslRunner.kill();
      this.wslRunners.delete(agentId);
    }

    this.fileTrackers.delete(agentId);
    this.bridge.forgetAgent(agentId);
    // BUG-09 §3.7 — drop the latch + hold-until entries so a 15-min
    // tool-pending latch can't survive into a future agent record reusing this id.
    this.monitor.forgetAgent(agentId);
    // BUG-11: drop user-typing timestamp so a reused agent id doesn't
    // inherit a stale "user is typing" gate.
    this.lastUserPtyWriteAt.delete(agentId);
    // P1 — drop the multi-transport hook state so a reused agent id doesn't
    // inherit a stale dedupe registry / ordering watermark / launch stamp.
    this.appliedHookEvents.delete(agentId);
    this.lastAppliedHookTs.delete(agentId);
    this.launchStartedAt.delete(agentId);
    this.lastInvalidHookWarnAt.delete(agentId);
    this.releaseSpoolTailer(agentId);
    // WP-P2 — drop any undelivered initial prompt with the agent record.
    this.pendingInitialPrompts.delete(agentId);
    dbDeleteAgent(agentId);
    this.emit('agentDeleted', { agentId });
  }

  async restartAgent(agentId: string): Promise<void> {
    await this.stopAgent(agentId);
    const agent = getAgent(agentId);
    if (!agent) return;

    // BUG-09 §3.7 — a runner crash mid-tool would otherwise leave a
    // tool-pending latch in place for the full 15-min TTL. Clear it before
    // we transition to `restarting`.
    this.monitor.forgetAgent(agentId);

    const priorRestart = getAgent(agentId)?.status;
    updateAgentStatus(agentId, 'restarting');
    incrementRestartCount(agentId);
    this.emit('statusChanged', { agentId, status: 'restarting', fromStatus: priorRestart, source: 'restart' } satisfies StatusChangedEvent);

    setTimeout(async () => {
      const latest = getAgent(agentId);
      if (!latest) return;
      try {
        const pathType = detectPathType(latest.workingDirectory);
        if (pathType === 'windows') {
          await this.launchWindowsAgent(latest, true);
        } else {
          await this.launchWslAgent(latest, true);
        }
      } catch (err) {
        const priorRestartFail = getAgent(agentId)?.status;
        updateAgentStatus(agentId, 'crashed');
        this.emit('statusChanged', { agentId, status: 'crashed', fromStatus: priorRestartFail, source: 'restart-failed' } satisfies StatusChangedEvent);
      }
    }, 1000);
  }

  attachAgent(agentId: string): { write: (data: string) => void; resize: (cols: number, rows: number) => void; onData: (cb: (data: string) => void) => void } {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      // P1B-03: suppress meaningful-burst advances briefly so the TUI redraw
      // triggered by the new output channel does not flip the agent to
      // 'working' purely from terminal repaint bytes.
      winRunner.markInteractionIgnoreWindow(750);
      updateAgentAttached(agentId, true);
      return {
        write: (data) => winRunner.write(data),
        resize: (cols, rows) => winRunner.resize(cols, rows),
        onData: (cb) => winRunner.on('data', cb),
      };
    }

    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      // P1B-03: same rationale as the Windows branch above.
      wslRunner.markInteractionIgnoreWindow(750);
      wslRunner.attach();
      updateAgentAttached(agentId, true);
      return {
        write: (data) => wslRunner.write(data),
        resize: (cols, rows) => wslRunner.resize(cols, rows),
        onData: (cb) => wslRunner.on('data', cb),
      };
    }

    throw new Error('Agent not found or not running');
  }

  hasRunner(agentId: string): boolean {
    return this.windowsRunners.has(agentId) || this.wslRunners.has(agentId);
  }

  /** WP-P2 (plans/selection-to-agent-primitive-plan.md §7) — deliver a
   *  pending `initialUserPrompt` on the FIRST persisted transition into an
   *  input-accepting status (idle|waiting|done) for an agent with a live
   *  runner. Exactly-once by construction: the entry is deleted BEFORE the
   *  async send, so a second accepting transition during delivery finds no
   *  entry. Async delivery failures ride the existing
   *  'agent:send-input-error' renderer flow via the 'sendInputError'
   *  supervisor event (forwarded in ipc-handlers.ts). */
  private maybeDeliverInitialUserPrompt(agentId: string, status: AgentStatus): void {
    if (status !== 'idle' && status !== 'waiting' && status !== 'done') return;
    const pending = this.pendingInitialPrompts.get(agentId);
    if (!pending) return;
    if (Date.now() > pending.expiresAt) {
      this.pendingInitialPrompts.delete(agentId);
      console.warn(`[initial-prompt] Pending initial prompt for ${agentId} expired undelivered`);
      return;
    }
    // No live runner (e.g. a runner-exit 'done') — keep the entry; a restart
    // inside the TTL window can still deliver it, and stop/delete clear it.
    if (!this.hasRunner(agentId)) return;
    this.pendingInitialPrompts.delete(agentId);
    this.sendInput(agentId, pending.text).catch((err: Error) => {
      console.error(`[initial-prompt] Delivery to ${agentId} failed:`, err);
      this.emit('sendInputError', { agentId, error: err.message });
    });
  }

  /** Class IV — called by src/main/index.ts after apiServer.start() so the
   *  supervisor can inject the actually-bound port into supervised-worker env
   *  (handles api-server.ts EADDRINUSE auto-increment). */
  setApiServerPort(port: number): void {
    this.apiServerPort = port;
  }

  /** P1 (plans/p1-hook-spool-multi-transport.md §2) — the ONE place where
   *  hook-event validation, dedupe, freshness, ordering, ALL timestamp/health
   *  stamping, and status dispatch happen. HTTP (api-server.ts), the spool
   *  tailer, and the tmux pane-option poll all funnel here; nothing else
   *  dedupes or stamps.
   *
   *  Returns:
   *    'applied'   — event flipped status / stamped health.
   *    'duplicate' — key already applied this process (any transport). No
   *                  timestamp advance; the ONLY side effect is the
   *                  healthy-when-unknown promotion + canary disarm (a
   *                  duplicate matched a key we applied, so it IS proof the
   *                  scaffold loaded).
   *    'stale'     — older than an applied event, or rejected by the
   *                  tmux-option freshness gate. NO side effects at all (a
   *                  stale option proves nothing about THIS launch).
   *    'invalid'   — failed validation (rate-limited warn). */
  applyHookStatusEvent(agentId: string, event: ParsedHookEvent, transport: HookTransport): HookApplyResult {
    // 1. Single ownership of timestamps: receivedAt is captured ONCE, here,
    //    host clock. Applied events stamp with it — never with the event's own
    //    ts (preserves today's host-clock submit-confirmation comparison and
    //    is immune to WSL clock skew).
    const receivedAt = Date.now();

    // 2. Validation.
    const agent = getAgent(agentId);
    if (!agent) return this.invalidHookEvent(agentId, transport, 'unknown agent');
    if (event.agentId !== undefined && event.agentId !== agentId) {
      return this.invalidHookEvent(agentId, transport, `agentId mismatch (event says ${event.agentId})`);
    }
    if (typeof event.ts !== 'number' || !Number.isFinite(event.ts)) {
      return this.invalidHookEvent(agentId, transport, `non-finite ts ${JSON.stringify(event.ts)}`);
    }
    if (event.state !== 'idle' && event.state !== 'working' && event.state !== 'active') {
      return this.invalidHookEvent(agentId, transport, `unknown state ${JSON.stringify(event.state)}`);
    }
    // hookEventName fallback: argv-style name derived from state, so records
    // missing the field (defensive) still dedupe consistently.
    const hookEventName = event.hookEventName
      || (event.state === 'working' ? 'UserPromptSubmit' : event.state === 'active' ? 'SessionStart' : 'Stop');
    if (hookEventName.length === 0) {
      return this.invalidHookEvent(agentId, transport, 'empty hookEventName');
    }

    if (!event.legacy) {
      // 3. Dedupe — key is byte-identical across transports by construction.
      const key = `${event.ts}:${hookEventName}:${event.turnId ?? ''}`;
      const seen = this.appliedHookEvents.get(agentId);
      if (seen?.has(key)) {
        // No timestamp advance — a re-read of an already-applied event must
        // never become a fresh heartbeat that masks hook silence. The only
        // side effect: a duplicate proves the scaffold loaded, so promote a
        // still-'unknown' hook_status to healthy (WITHOUT a timestamp) and
        // disarm the canary.
        if ((agent.hookStatus ?? 'unknown') === 'unknown') {
          updateAgentHookStatus(agentId, 'healthy');
          this.monitor.clearHookCanary(agentId);
        }
        return 'duplicate';
      }

      // 4a. Tmux-option freshness gate — tmux-option ONLY. The pane option
      //     survives tmux-side across dashboard restarts while the dedupe
      //     registry and lastAppliedHookTs are in-memory and start empty, so
      //     a tmux-option event must additionally pass ALL THREE gates. A
      //     'stale' here gets NO side effects (unlike a duplicate): a stale
      //     option proves nothing about this launch's scaffold.
      if (transport === 'tmux-option') {
        // (i) Bounded age vs the applier's host clock.
        if (event.ts < receivedAt - TMUX_OPTION_MAX_AGE_MS) return 'stale';
        // (ii) Persisted last-hook guard — read from the Agent ROW (survives
        //      restarts; DB column from P0 §8.2), not the in-memory monitor
        //      maps. NO skew tolerance here — this is what prevents an old
        //      option from resurrecting after an HTTP/spool event already
        //      landed in a previous process. Do not soften.
        if (agent.lastHookEventAt !== undefined && event.ts <= agent.lastHookEventAt) return 'stale';
        // (iii) Current-launch guard — events older than this launch belong
        //       to a previous pane occupant. Small skew tolerance allowed on
        //       THIS guard only.
        const launchedAt = this.launchStartedAt.get(agentId);
        if (launchedAt !== undefined && event.ts < launchedAt - TMUX_OPTION_LAUNCH_SKEW_MS) return 'stale';
      }

      // 5. Ordering guard — equal ts with a different key is allowed (applied
      //    in arrival order); strictly-older is stale. Same no-timestamp-
      //    advance rule as duplicates; no healthy side effect (the newer
      //    applied event already stamped it).
      const lastTs = this.lastAppliedHookTs.get(agentId);
      if (lastTs !== undefined && event.ts < lastTs) return 'stale';

      // 6. Record the key + advance the ordering watermark.
      let set = seen;
      if (!set) {
        set = new Set<string>();
        this.appliedHookEvents.set(agentId, set);
      }
      set.add(key);
      while (set.size > APPLIED_HOOK_EVENTS_MAX) {
        // Set preserves insertion order — evict the oldest.
        const oldest = set.values().next().value as string;
        set.delete(oldest);
      }
      this.lastAppliedHookTs.set(agentId, event.ts);
    }

    // 7. Stamp (applied events only), centrally, with receivedAt — the
    //    low-level flip helpers below have no stamping rights.
    this.monitor.recordHookEventAt(agentId, receivedAt);
    if (event.state === 'working') this.monitor.recordStartHookEventAt(agentId, receivedAt);
    updateAgentHookStatus(agentId, 'healthy', receivedAt);
    this.monitor.clearHookCanary(agentId);

    // 8. Dispatch. Provenance (design §5.1): the flip source is
    //    transport-determined — HTTP keeps the original hook source
    //    (byte-identical to pre-P1 behavior); spool → 'hook-spool';
    //    tmux → 'tmux-pane-option'.
    const flipSource = transport === 'spool'
      ? 'hook-spool'
      : transport === 'tmux-option'
        ? 'tmux-pane-option'
        : (event.source && event.source.length > 0
            ? event.source
            : event.state === 'working' ? 'hook-start' : event.state === 'active' ? 'hook-session-start' : 'hook-stop');

    if (event.state === 'idle') {
      this.forceIdleFromHook(agentId, flipSource);
    } else if (event.state === 'working') {
      this.forceWorkingFromHook(agentId, flipSource);
    }
    // state === 'active' (SessionStart): health/canary already handled in
    // step 7; MUST NOT change status (HOOK_SYSTEM_DESIGN.md §A).
    return 'applied';
  }

  /** Rate-limited (60 s/agent) warn helper for applyHookStatusEvent. */
  private invalidHookEvent(agentId: string, transport: HookTransport, reason: string): 'invalid' {
    const now = Date.now();
    const lastWarn = this.lastInvalidHookWarnAt.get(agentId) ?? 0;
    if (now - lastWarn >= 60_000) {
      this.lastInvalidHookWarnAt.set(agentId, now);
      console.warn(`[hook-apply] invalid hook event for ${agentId} via ${transport}: ${reason}`);
    }
    return 'invalid';
  }

  /** P1 — pure status-flip helper (demoted from public hook entry point; all
   *  stamping moved into applyHookStatusEvent step 7, which is the only
   *  caller).
   *
   *  BUG-23 §C-supplement — if the agent is currently in `'launching'`, the
   *  regular `forceIdle` no-ops on the transitional guard and the wallclock
   *  settle timer would eventually flip the agent. That's strictly worse
   *  than honoring the hook itself: the hook signal carries authoritative
   *  end-of-turn information that the wallclock can't reproduce. Route
   *  through `promoteFromLaunching('stop-hook')`, the one surgical bypass,
   *  so the hook's information is preserved and the agent doesn't sit
   *  falsely-launching for the rest of the settle window. */
  private forceIdleFromHook(agentId: string, source: string): void {
    const agent = getAgent(agentId);
    if (agent && agent.status === 'launching') {
      this.monitor.promoteFromLaunching(agentId, 'stop-hook');
      return;
    }
    this.monitor.forceIdle(agentId, source);
  }

  /** P1 — pure status-flip helper for the UserPromptSubmit arm (state
   *  'working'). The start-hook is the supervised lane's sole authority for
   *  idle→working (paste-race fix). Stamping lives in applyHookStatusEvent. */
  private forceWorkingFromHook(agentId: string, source: string): void {
    this.monitor.forceWorking(agentId, source);
  }

  // ── P1 §3/§4 — hook-transport polling (spool tailers + tmux options) ────

  /** The single per-tick transport drain, registered with
   *  `StatusMonitor.setHookTransportPoller`. Spool drains are synchronous —
   *  they complete before the monitor's per-agent canary/watchdog checks run
   *  this tick. The tmux pane-option poll (a `wsl.exe` round-trip) is async:
   *  fired every 4th tick (~6 s), results applied on completion — a tick of
   *  latency is fine for a backstop channel. */
  private pollHookTransports(): void {
    for (const tailer of this.spoolTailers.values()) {
      tailer.drain(); // never throws
    }
    this.hookTransportTick++;
    if (this.hookTransportTick % 4 === 0) {
      void this.pollTmuxStatusOptions();
    }
  }

  /** §3 — ensure a spool tailer exists for the workspace this worker-lane
   *  agent spools into, keyed by the CANONICAL read path. Registers the agent
   *  as a user of that tailer for disposal accounting. Best-effort: a path
   *  that can't resolve (wsl.exe down) just means no spool channel this run. */
  private ensureSpoolTailer(agent: Agent): void {
    if (!(agent.isSupervised || agent.isWorker)) return;
    let readPath: string;
    try {
      readPath = resolveSpoolReadPath(getEffectiveWorkspaceRoot(agent));
    } catch (err) {
      console.warn(`[hook-spool] could not resolve spool read path for ${agent.id}:`, err);
      return;
    }
    const key = canonicalSpoolKey(readPath);
    this.agentSpoolKey.set(agent.id, key);
    let users = this.spoolUsers.get(key);
    if (!users) {
      users = new Set<string>();
      this.spoolUsers.set(key, users);
    }
    users.add(agent.id);
    if (!this.spoolTailers.has(key)) {
      this.spoolTailers.set(key, new HookSpoolTailer(readPath, {
        onRecord: (record) => this.applySpoolRecord(record),
      }));
      console.log(`[hook-spool] tailer started for ${readPath}`);
    }
  }

  /** §3 — drop an agent's claim on its spool tailer; dispose the tailer when
   *  the last worker using that spool stops. */
  private releaseSpoolTailer(agentId: string): void {
    const key = this.agentSpoolKey.get(agentId);
    if (!key) return;
    this.agentSpoolKey.delete(agentId);
    const users = this.spoolUsers.get(key);
    if (!users) return;
    users.delete(agentId);
    if (users.size === 0) {
      this.spoolUsers.delete(key);
      this.spoolTailers.delete(key);
      console.log(`[hook-spool] tailer disposed (last worker stopped) for key ${key}`);
    }
  }

  /** §3 — sink for spool records: resolve the agent (drop if unknown / no
   *  live runner), then hand to the central applier. The tailer never
   *  dedupes; applyHookStatusEvent owns dedupe/freshness/ordering. */
  private applySpoolRecord(record: ParsedHookEvent): void {
    const agentId = typeof record.agentId === 'string' ? record.agentId : '';
    if (!agentId) return;
    if (!getAgent(agentId)) return;       // unknown agent — drop silently
    if (!this.hasRunner(agentId)) return; // no live runner — historical record
    this.applyHookStatusEvent(agentId, record, 'spool');
  }

  /** §4 — tmux pane-option poll (third channel, WSL only). Reads
   *  @agentdashboard-status for every worker-lane WSL agent whose last hook
   *  event (any transport) is older than one poll tick; zero `wsl.exe` cost
   *  when no such agent exists. Events pass to the central applier unchanged —
   *  the §2 step-4a freshness gate lives there, not here, so any future
   *  caller of the tmux transport inherits it. The option is never cleared;
   *  dedupe + ordering + freshness + the no-timestamp-advance rule make
   *  re-reads completely inert. */
  private async pollTmuxStatusOptions(): Promise<void> {
    if (this.tmuxOptionPollInFlight) return;

    const now = Date.now();
    const candidates: Array<{ agentId: string; session: string }> = [];
    for (const [agentId, runner] of this.wslRunners) {
      if (!runner.isAlive) continue;
      const agent = getAgent(agentId);
      if (!agent || !(agent.isSupervised || agent.isWorker)) continue;
      if (!agent.tmuxSessionName) continue;
      const lastHookAt = this.monitor.getLastHookEventAt(agentId);
      // Skip agents with a fresh hook signal — the backstop is only for
      // silence.
      if (lastHookAt !== undefined && now - lastHookAt <= STATUS_POLL_INTERVAL_MS) continue;
      candidates.push({ agentId, session: agent.tmuxSessionName });
    }
    if (candidates.length === 0) return;

    this.tmuxOptionPollInFlight = true;
    try {
      const values = await tmuxReadStatusOptions(candidates.map((c) => c.session));
      for (const { agentId, session } of candidates) {
        const raw = (values.get(session) ?? '').trim();
        if (!raw) continue;
        let record: unknown;
        try {
          record = JSON.parse(raw);
        } catch {
          this.invalidHookEvent(agentId, 'tmux-option', 'malformed @agentdashboard-status JSON');
          continue;
        }
        if (record === null || typeof record !== 'object') continue;
        this.applyHookStatusEvent(agentId, record as ParsedHookEvent, 'tmux-option');
      }
    } catch (err) {
      console.warn('[tmux-option] status-option poll failed (treated as no data):', err);
    } finally {
      this.tmuxOptionPollInFlight = false;
    }
  }

  /** Contract-vs-fallback predicate (plan §SCOPE, Q6). Decides, per agent,
   *  whether a submit goes through the THROWING synchronous confirm-and-retry
   *  (true) or stays on the existing best-effort reactive Enter-resend (false).
   *  Centralizes the provider-applicability matrix so the send path and the
   *  reactive poller agree on exactly one set of agents.
   *
   *    - Claude worker (hooked) → true. Proven live; settings.json hooks just
   *      run. A 'broken' canary verdict means the scaffold never loaded for this
   *      launch, so we fall back rather than throw on an agent that can't ever
   *      confirm.
   *    - Codex worker → true ONLY once its UserPromptSubmit hook has provably
   *      fired for THIS launch (`hasObservedStartHook`). Per §2.2 Codex gates
   *      each hook behind per-command trust, and the bypass flag's existence in
   *      the installed binary is unconfirmed (Q5) — so the bypass-in-effect is
   *      necessary but not sufficient. We require the empirical self-test and
   *      otherwise fall back to the reactive resend (never throw for Codex
   *      pre-proof). Bootstraps safely: turn 1 uses the reactive fallback;
   *      subsequent turns use the contract once the start hook is seen.
   *    - Gemini, non-hook, bare-Windows-without-a-turn-start marker → false.
   *      No authoritative start marker exists (§2.3/Q2/G5); never throw — they
   *      stay on the reactive fallback / PTY inference. */
  usesSubmitConfirmation(agent: Agent): boolean {
    if (!(agent.isSupervised || agent.isWorker)) return false;
    if (agent.provider === 'claude') {
      return agent.hookStatus !== 'broken';
    }
    if (agent.provider === 'codex') {
      return this.monitor.hasObservedStartHook(agent.id);
    }
    return false;
  }

  /** BUG-10 — replay ONLY the submit keystroke (no body) to recover a dropped
   *  Enter. Called by StatusMonitor.checkStartHookResend AND the synchronous
   *  confirm-and-retry (the C2 submit-only re-press). Uses the same
   *  per-platform submit mechanism as `_doSendInput` so the bytes are
   *  known-good: WSL goes through `tmux send-keys -H <kitty enter>`; Windows
   *  writes the provider's Win32/CR submit sequence to the ConPTY. Never
   *  touches the input queue — this is a single keystroke, not a body send. */
  resubmitEnter(agentId: string): void {
    const agent = getAgent(agentId);
    if (!agent) return;

    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      if (!agent.tmuxSessionName || !wslRunner.isAlive) return;
      void tmuxSendSubmit(agent.tmuxSessionName).catch((err) => {
        console.warn(`[bug-10] tmuxSendSubmit failed for ${agent.title}:`, err);
      });
      return;
    }

    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      winRunner.write(getWindowsSubmitSequence(agent.provider));
    }
  }

  writeToAgent(agentId: string, data: string): void {
    // BUG-11: every byte reaching this path is user-initiated (the
    // `terminal:write` IPC handler is the sole caller, and its renderer-side
    // origins are all user actions — xterm `onData` keystrokes, clipboard
    // paste, file-path drop, the Query Agent dialog injecting a result).
    // Stamping here lets the event bridge defer auto-submits while typing
    // is active. `_doSendInput` goes through `runner.write`/`tmuxSendInput`
    // directly and intentionally does NOT update this map.
    if (data.length > 0) this.lastUserPtyWriteAt.set(agentId, Date.now());

    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) { winRunner.write(data); return; }
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) { wslRunner.write(data); }
  }

  /**
   * Returns true while a send to this agent is queued or actively typing.
   * The HTTP layer uses this to (a) override the agent's reported status to
   * 'working' so callers don't poll a stale 'idle' between enqueue and the
   * agent's first response burst, and (b) reject concurrent POST /input
   * requests with 409. See the inputQueues field comment for context.
   */
  isInputInFlight(agentId: string): boolean {
    return this.inputInFlight.has(agentId);
  }

  /**
   * Public entry point for sending input. Serializes per-agent: if a previous
   * send is still typing, this one waits its turn. Resolves once delivery
   * completes (so internal callers can still `await` for ordering), with
   * `_doSendInput`'s delivered boolean threaded through the queue chain —
   * `false` means NO runner accepted the bytes (dead WSL runner, no runner),
   * i.e. nothing was typed. Callers that need delivery proof (the handoff
   * handshake) must check it; fire-and-forget callers can ignore it.
   *
   * Callers that want fire-and-forget semantics (i.e. the HTTP layer) should
   * not `await` the returned promise — it stays pending until typing is done.
   * Synchronous validation (agent exists, has a runner) happens before the
   * promise is even chained, so missing-runner errors still throw eagerly.
   *
   * `opts.submit` defaults to true. Set it to false to leave the text in the
   * agent's prompt buffer without pressing Enter (BUG-01: launch_agent's
   * `submit:false` flag).
   */
  sendInput(agentId: string, text: string, opts: { submit?: boolean } = {}): Promise<boolean> {
    if (!this.windowsRunners.get(agentId) && !this.wslRunners.get(agentId)) {
      return Promise.reject(new Error(`No runner for agent ${agentId}`));
    }
    const submit = opts.submit !== false;
    this.inputInFlight.add(agentId);
    const previous = this.inputQueues.get(agentId) || Promise.resolve();
    const ours: Promise<boolean> = previous
      .catch(() => undefined) // a prior failed send must not poison the queue
      .then(() => this._doSendInput(agentId, text, submit))
      .then((delivered) => {
        if (submit && delivered) {
          // P2-03: if the agent was waiting on user input, the send just
          // answered the prompt — clear the latch so status flips back to
          // working immediately. Bridge filters the resulting waiting→working
          // emission so the supervisor doesn't get a noise notification.
          // Skip when submit:false — without an Enter the prompt is still
          // unanswered, so the waiting latch must stay set.
          //
          // notifyUserInputDelivered must run FIRST: if the agent was in
          // `waiting`, this clears the waiting latch and emits the specific
          // waiting→working transition with source 'user-input'. Seeding the
          // working latch before would no-op that path.
          this.bridge.notifyUserInputDelivered(agentId);
          // (The BUG-23 delivered-input timestamp is stamped inside
          // `_doSendInput` the moment the body+Enter is written — BEFORE the
          // synchronous confirm-and-retry wait — so it can never land after
          // the observed UserPromptSubmit hook timestamp. See the comment
          // there.)
          // No optimistic working-latch seed here. A send that *reports*
          // delivery (WSL `_doSendInput` returns true unconditionally once
          // send-keys are issued) does not prove the prompt was actually
          // submitted — when the kitty-CSI Enter is dropped the prompt sits
          // unentered, yet the old seed flipped status to `working` anyway.
          // That false-working signature is exactly what the hook scaffold
          // exists to avoid, so every lane now derives `working` from a real
          // signal instead of a delivery guess:
          //   - claude/codex workers (supervised or plain): UserPromptSubmit
          //     hook → forceWorkingFromHook.
          //   - gemini + non-worker unsupervised agents: chat-stream events /
          //     PTY inference in status-monitor.
          // The seed predated the worker-lane broadening and only ever masked
          // missing-submit / missing-hook failures, so it is removed entirely.
        }
        return delivered;
      });
    this.inputQueues.set(agentId, ours);
    // Clear in-flight only when the chain has fully drained for this agent.
    // If more sends queued behind us, they own the cleanup. The trailing
    // `.catch` keeps this bookkeeping chain from surfacing as an unhandled
    // rejection when a send rejects (e.g. a SubmitNotConfirmedError from the
    // synchronous confirm-and-retry); the rejection is still delivered to the
    // returned `ours` for the caller to observe/handle.
    void ours
      .finally(() => {
        if (this.inputQueues.get(agentId) === ours) {
          this.inputQueues.delete(agentId);
          this.inputInFlight.delete(agentId);
        }
      })
      .catch(() => undefined);
    return ours;
  }

  /**
   * Handoff handshake — confirmed delivery for supervisor → worker prompts
   * (POST /input { confirm: true }; the MCP `send_message_to_agent` /
   * `launch_agent` tools). Resolves only once there is PROOF the worker's
   * turn started, so an orchestrating caller can treat success as "the worker
   * is now working" instead of "bytes were typed somewhere".
   *
   * Proof, in order of authority:
   *   1. 'hook'        — a UserPromptSubmit hook arrived after our pre-send
   *                      baseline. For contract providers `sendInput`'s
   *                      synchronous confirm-and-retry guarantees this before
   *                      it resolves, so the first poll iteration hits.
   *   2. 'status-poll' — the agent's status flipped to 'working' (gemini
   *                      workers ride chat-stream events; non-workers ride
   *                      PTY inference — neither emits hooks).
   *   3. 'unconfirmed' — neither signal within HANDSHAKE_CONFIRM_WINDOW_MS.
   *                      NOT proof of failure (a provider without hooks can
   *                      start a turn invisibly) — the caller decides how
   *                      loudly to react.
   *
   * Definitive failures REJECT instead: `SubmitNotConfirmedError` from the
   * contract confirm-and-retry (re-pressed Enter, turn provably never
   * started — a handoff_failed event is also emitted), eager no-runner
   * errors from `sendInput`, and a `delivery-failed`-coded Error when
   * `sendInput` resolves `delivered: false` (no runner accepted the bytes —
   * e.g. the WSL dead-runner guard — so NOTHING was typed and there is no
   * point polling for a turn start).
   */
  async sendInputConfirmed(
    agentId: string,
    text: string,
  ): Promise<{ delivered: boolean; confirmed: boolean; mode: 'hook' | 'status-poll' | 'unconfirmed' }> {
    const baselineStartHookAt = this.monitor.getLastStartHookEventAt(agentId) ?? 0;
    const delivered = await this.sendInput(agentId, text);
    if (!delivered) {
      const err = new Error(
        `Input delivery to agent ${agentId} failed — no runner accepted the ` +
        `bytes (dead or missing runner); NO bytes were typed.`,
      );
      (err as Error & { code?: string }).code = 'delivery-failed';
      throw err;
    }

    const deadline = Date.now() + HANDSHAKE_CONFIRM_WINDOW_MS;
    for (;;) {
      const startHookAt = this.monitor.getLastStartHookEventAt(agentId) ?? 0;
      if (startHookAt > baselineStartHookAt) {
        return { delivered: true, confirmed: true, mode: 'hook' };
      }
      const agent = getAgent(agentId);
      if (agent?.status === 'working') {
        return { delivered: true, confirmed: true, mode: 'status-poll' };
      }
      if (Date.now() >= deadline) {
        return { delivered: true, confirmed: false, mode: 'unconfirmed' };
      }
      await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_CONFIRM_POLL_MS));
    }
  }

  /**
   * Deliver a terminal [DASHBOARD EVENT] to a supervisor, retrying while it is
   * busy. In-process port of groupthink-v2.js:270–329 (the orchestration runner
   * used to do this over HTTP): poll the supervisor's status until idle/waiting,
   * gate on `isInputInFlight` (the in-process equivalent of the HTTP 409 latch),
   * then `sendInputConfirmed`. Retries on a busy supervisor or a
   * `SubmitNotConfirmedError`/delivery failure up to `maxAttempts` times,
   * `intervalMs` apart. There is no sentinel file — on persistent failure this
   * resolves `{ ok: false }` and the OrchestrationService records a durable
   * `delivery_failed` event instead.
   */
  async deliverToSupervisor(
    supervisorId: string,
    text: string,
    opts: { maxAttempts?: number; intervalMs?: number } = {},
  ): Promise<{ ok: boolean }> {
    const READY = new Set<string>(['idle', 'waiting']);
    const maxAttempts = opts.maxAttempts ?? 12;
    const intervalMs = opts.intervalMs ?? 5_000;
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const status = getAgent(supervisorId)?.status;
      // Wait out a busy supervisor (or an in-flight send) before attempting a
      // delivery — mirrors the script's READY_STATUSES + 409 gate.
      if ((status && !READY.has(status)) || this.isInputInFlight(supervisorId)) {
        if (attempt < maxAttempts) { await sleep(intervalMs); continue; }
        return { ok: false };
      }
      try {
        const result = await this.sendInputConfirmed(supervisorId, text);
        if (!result.confirmed) {
          // H4: bytes delivered but no proof the supervisor's turn started —
          // retryable; on exhaustion return ok:false so the OrchestrationService
          // writes a durable delivery_failed row instead of silently losing the event.
          if (attempt < maxAttempts) { await sleep(intervalMs); continue; }
          console.warn(`[orchestration] deliverToSupervisor: unconfirmed (mode=${result.mode}) after ${attempt} attempts`);
          return { ok: false };
        }
        if (attempt > 1) {
          console.log(`[orchestration] deliverToSupervisor succeeded on attempt ${attempt}/${maxAttempts}`);
        }
        return { ok: true };
      } catch (err) {
        if (attempt < maxAttempts) { await sleep(intervalMs); continue; }
        console.warn(
          `[orchestration] deliverToSupervisor failed after ${attempt} attempts: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
        return { ok: false };
      }
    }
    return { ok: false };
  }

  private async _doSendInput(agentId: string, text: string, submit: boolean = true): Promise<boolean> {
    const agent = getAgent(agentId);
    // §2.3 PRE-SEND BASELINE — capture the start-hook timestamp BEFORE sending
    // the body+Enter. Confirmation later requires the hook to advance PAST this
    // value, so a fast hook that POSTs before our send is recorded can't be
    // mistaken for a stale prior hook (which would falsely time out and
    // re-press after a real submit). This is a real Date.now-based value, so the
    // comparison in `confirmSubmission` is host-clock-vs-host-clock.
    const priorStartHookAt = this.monitor.getLastStartHookEventAt(agentId) ?? 0;
    let delivered = false;

    // For WSL agents, dispatch by provider. All three providers enable the
    // kitty keyboard protocol on Linux, so a bare `\r` from `tmux send-keys
    // Enter` is dropped — submit must be the kitty CSI form `\x1b[13u`.
    // The body is delivered as a tmux buffer paste (`load-buffer -` from
    // stdin + `paste-buffer`) so large relays never hit tmux's or
    // CreateProcess's command-length limits; claude's paste is additionally
    // bracketed-paste-wrapped so multi-line content renders without
    // submitting. See `tmuxSendInput` for the encoding.
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      if (agent?.tmuxSessionName) {
        // Guard: don't send input if the runner reports the agent as dead.
        // This prevents typing event payloads into a bare bash shell after Claude Code exits.
        if (!wslRunner.isAlive) {
          console.warn(`[sendInput] Skipping send to ${agent.title} — runner not alive`);
          return false;
        }
        const provider = agent.provider === 'claude' || agent.provider === 'codex' || agent.provider === 'gemini'
          ? agent.provider
          : 'unknown';
        await tmuxSendInput(agent.tmuxSessionName, text, provider, submit);
        this.emitSyntheticUserEcho(agent, text);
        delivered = true;
      }
    }
    // For Windows agents, bracketed-paste the body into Claude Code,
    // then send Enter as a separate PTY write. Sending text + '\r' (or '\n') as
    // one chunk leaves the message typed but unsubmitted in Claude Code v2.x's
    // prompt buffer — the trailing newline is absorbed as part of the paste,
    // so Enter must be delivered as its own input event.
    const winRunner = delivered ? undefined : this.windowsRunners.get(agentId);
    if (winRunner) {
      if (agent?.provider === 'claude') {
        // Claude Code treats a raw text + Enter chunk as pasted text without a
        // submit, so wrap in bracketed-paste markers and deliver Enter as a
        // separate PTY write.
        winRunner.write(formatBracketedPaste(text));
        if (submit) {
          await new Promise((resolve) => setTimeout(resolve, WINDOWS_SEND_INPUT_ENTER_DELAY_MS));
          winRunner.write(getWindowsSubmitSequence('claude'));
        }
      } else if (agent?.provider === 'codex' || agent?.provider === 'gemini') {
        // Codex/gemini enable Win32 Input Mode (ESC[?9001h). In this mode the
        // TUI expects key events as CSI sequences with both KEY_DOWN and
        // KEY_UP. ConPTY auto-converts incoming bytes into a single KEY_DOWN
        // event, which is enough to render typed characters but not enough to
        // trigger Enter (submit). Send the body in chunks separated by
        // WINDOWS_CODEX_TYPING_DELAY_MS so the cumulative write rate stays
        // below codex's paste-burst threshold (which would otherwise route
        // the input through codex's paste-confirm flow). Empirically codex
        // tolerates writes up to 512 chars with this gap; we use
        // WINDOWS_CODEX_TYPING_CHUNK_SIZE (currently 64) for safety margin.
        // Even chunked, codex still collapses multi-line input to a
        // "[Pasted Content N chars]" placeholder visually — that's expected.
        // After the body, send a real VK_RETURN down+up pair to submit;
        // embedded '\n' becomes Shift+Enter (newline-without-submit) so the
        // final plain Enter still triggers submit instead of inserting
        // another line in multi-line input mode.
        const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const lines = normalized.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          for (let j = 0; j < line.length; j += WINDOWS_CODEX_TYPING_CHUNK_SIZE) {
            winRunner.write(line.slice(j, j + WINDOWS_CODEX_TYPING_CHUNK_SIZE));
            await new Promise((resolve) => setTimeout(resolve, WINDOWS_CODEX_TYPING_DELAY_MS));
          }
          if (i < lines.length - 1) {
            winRunner.write(WIN32_KEY_SHIFT_ENTER_DOWN + WIN32_KEY_SHIFT_ENTER_UP);
            await new Promise((resolve) => setTimeout(resolve, WINDOWS_CODEX_TYPING_DELAY_MS));
          }
        }
        if (submit) {
          await new Promise((resolve) => setTimeout(resolve, WINDOWS_SEND_INPUT_ENTER_DELAY_MS));
          winRunner.write(getWindowsSubmitSequence(agent.provider));
        }
        this.emitSyntheticUserEcho(agent, text);
      } else {
        winRunner.write(submit ? `${text}\r` : text);
      }
      delivered = true;
    }

    if (!delivered) return false;

    // BUG-23 §watchdog reframe — record the delivered-input timestamp so the
    // reframed Class IV watchdog can detect a scaffold-broken supervised
    // Claude worker (input went in, no hook ever came back).
    //
    // ORDERING IS LOAD-BEARING: this MUST be stamped here, the moment the
    // body+Enter has actually been written, and BEFORE the synchronous
    // confirm-and-retry block below. `confirmSubmission` can wait multiple
    // seconds and the UserPromptSubmit hook lands DURING that wait — the old
    // post-resolve stamp (in `sendInput`'s queue chain) therefore recorded
    // `lastInputDeliveredAt` AFTER the observed hook timestamp, making
    // `StatusMonitor.checkStartHookSilence` see `lastStartHookEventAt <
    // lastInputDeliveredAt` and emit a false "input went in but no start hook
    // came back" warning for a turn that was actually confirmed. Non-contract
    // providers skip the confirm block entirely, so for them this is the same
    // instant the old post-resolve stamp observed. Gated on `submit` exactly
    // like the old call site (an unsubmitted body can't start a turn, so the
    // start-hook watchdogs must not arm).
    if (submit) this.monitor.recordInputDelivered(agentId);

    // Synchronous confirm-and-retry (plan §1 part 1). For contract providers,
    // the dashboard's send path — not the caller — owns the guarantee that the
    // prompt actually submitted. Re-press the submit-only keystroke until the
    // UserPromptSubmit hook proves a turn started; on exhaustion raise a real
    // error and surface it via `lastSendError`. Non-contract providers
    // (Gemini / unconfirmable-Codex / non-hook) skip this and stay on the
    // reactive resend / PTY inference — never throw for them.
    if (submit && agent && this.usesSubmitConfirmation(agent)) {
      const confirmed = await this.monitor.confirmSubmission(agentId, priorStartHookAt);
      if (!confirmed) {
        const message =
          `Submit not confirmed for ${agent.provider} agent ${agentId} after ` +
          `${MAX_SUBMIT_RETRIES} re-press attempts — no UserPromptSubmit hook ` +
          `fired (prompt delivered but turn never started).`;
        updateAgentLastSendError(agentId, { message, ts: Date.now() });
        console.error(`[confirm-submit] ${message}`);
        // Handoff handshake — wake the workspace supervisor with a
        // handoff_failed [DASHBOARD EVENT] regardless of how this send was
        // initiated. Fire-and-forget callers (UI chat bar, /input without
        // confirm, orchestration scripts) never observe the throw below, and
        // a worker whose turn never started will never emit the Stop-hook
        // idle event the supervisor is waiting on. The bridge gates on
        // isSupervised, so this is a no-op for plain workers.
        void this.bridge.onHandoffFailed({
          agent,
          attempts: MAX_SUBMIT_RETRIES,
          message,
        });
        throw new SubmitNotConfirmedError(message, agentId);
      }
      // Confirmed turn start — clear any stale failure surface from a prior send.
      if (agent.lastSendError) updateAgentLastSendError(agentId, null);
    }
    return true;
  }


  private emitSyntheticUserEcho(agent: Agent, text: string): void {
    if (agent.provider !== 'codex' && agent.provider !== 'gemini') return;
    this.sessionLogReader.appendSyntheticUserText(agent.id, text);
  }

  removeAgentListener(agentId: string, listener: (data: string) => void): void {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      winRunner.off('data', listener);
      return;
    }
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      wslRunner.off('data', listener);
      return;
    }
  }

  resizeAgent(agentId: string, cols: number, rows: number): void {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) { winRunner.resize(cols, rows); return; }
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) { wslRunner.resize(cols, rows); }
  }

  detachAgent(agentId: string): void {
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      wslRunner.detach();
    }
    // Windows runners don't need detach - we just stop forwarding
    updateAgentAttached(agentId, false);
  }

  /**
   * BUG-15: return the entire PTY ring buffer for an agent. The terminal
   * viewer calls this on mount to paint scrollback. For live agents it pulls
   * from the runner's in-memory ring; for `done` agents it falls back to the
   * `.scrollback` file the runner wrote on exit.
   *
   * Distinct from `getAgentLog` which targets MCP / chat consumers — that
   * path reads the raw `.log` file for big history requests, but the raw log
   * replays alt-screen toggles and ends up visually empty in xterm for
   * exited agents. The ring buffer is the same raw bytes, but bounded so we
   * can persist a useful snapshot.
   */
  async getAgentRingBuffer(agentId: string): Promise<string> {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) return winRunner.getFullRing();
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) return wslRunner.getFullRing();

    // Runner is gone (agent stopped / done). Fall back to the persisted
    // scrollback file. The runner writes this on its exit handler / kill().
    const agent = getAgent(agentId);
    if (agent?.logPath) {
      const scrollbackPath = `${agent.logPath}.scrollback`;
      if (fs.existsSync(scrollbackPath)) {
        try {
          return fs.readFileSync(scrollbackPath, 'utf-8');
        } catch (err) {
          console.error(`[getAgentRingBuffer] Failed to read scrollback for ${agentId}:`, err);
        }
      }
      // Last-resort: tail of the raw log file. Same content the old
      // TerminalPanel path used — alt-screen quirks and all — but at least
      // shows *something* for pre-BUG-15 agents that have no .scrollback yet.
      if (fs.existsSync(agent.logPath)) {
        try {
          const content = fs.readFileSync(agent.logPath, 'utf-8');
          if (content.length > 1_000_000) {
            return content.slice(content.length - 1_000_000);
          }
          return content;
        } catch (err) {
          console.error(`[getAgentRingBuffer] Failed to read log for ${agentId}:`, err);
        }
      }
    }
    return '';
  }

  async getAgentLog(agentId: string, lines = 50): Promise<string> {
    const agent = getAgent(agentId);
    if (!agent) return '';

    // If requesting a large history (like TerminalPanel does with 500+ lines),
    // always prefer the raw log file on disk. The log file contains the full,
    // persistent history with all raw ANSI color codes intact.
    // tmux capture-pane strips colors and is limited by the pane buffer.
    // Windows in-memory ring buffer is also limited.
    if (lines >= 500 && agent.logPath && fs.existsSync(agent.logPath)) {
      try {
        const content = fs.readFileSync(agent.logPath, 'utf-8');
        const allLines = content.split('\n');
        return allLines.slice(-lines).join('\n');
      } catch (err) {
        console.error(`[getAgentLog] Failed to read large log from disk for agent ${agentId}:`, err);
      }
    }

    // For WSL agents, try tmux capture first (always current)
    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) {
      try {
        return await wslRunner.captureOutput(lines);
      } catch {
        // Fall through to log file
      }
    }

    // For Windows agents, use in-memory ring buffer (instant, avoids file flush delays)
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) {
      return winRunner.captureOutput(lines);
    }

    // Fallback: read from log file
    if (agent.logPath && fs.existsSync(agent.logPath)) {
      const content = fs.readFileSync(agent.logPath, 'utf-8');
      const allLines = content.split('\n');
      return allLines.slice(-lines).join('\n');
    }

    return '';
  }

  private async checkAlive(agent: Agent): Promise<boolean> {
    if (agent.tmuxSessionName) {
      const wslRunner = this.wslRunners.get(agent.id);
      if (!wslRunner) return false;
      return wslRunner.isStillAlive();
    } else {
      return this.windowsRunners.has(agent.id);
    }
  }

  /** BUG-09 §3.5 — meaningful-burst signal (200 B / 3 s gate). Used to
   *  promote `idle → working` in `inferStatus`. */
  private getLastMeaningfulBurstTime(agentId: string): number {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) return winRunner.lastMeaningfulBurstTime;

    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) return wslRunner.lastMeaningfulBurstTime;

    return 0;
  }

  /** BUG-09 §3.5 — raw PTY-byte timestamp. Used to keep an already-working
   *  agent from being downgraded by `inferStatus` during spinner-only
   *  Coalescing windows. */
  private getLastRawOutputTime(agentId: string): number {
    const winRunner = this.windowsRunners.get(agentId);
    if (winRunner) return winRunner.lastRawOutputTime;

    const wslRunner = this.wslRunners.get(agentId);
    if (wslRunner) return wslRunner.lastRawOutputTime;

    return 0;
  }

  async reconcile(): Promise<void> {
    // Relaunch agents that were running before the app was closed
    const activeAgents = getActiveAgents();
    for (const agent of activeAgents) {
      // These agents were "working"/"idle" when the app closed but their
      // processes are gone. Relaunch with --continue to resume conversations.
      const hasRunner = this.windowsRunners.has(agent.id) || this.wslRunners.has(agent.id);
      if (!hasRunner) {
        const agentForReconnect = getAgent(agent.id);
        console.log(`Reconnecting agent: ${agent.title} (${agent.id}) sessionId=${agentForReconnect?.resumeSessionId || 'NONE'}`);
        try {
          const pathType = detectPathType(agent.workingDirectory);
          const ws = getWorkspace(agent.workspaceId);

          // Refresh .mcp.json for supervisors and persona-backed agents.
          // launchAgent() runs ensureMcpConfig() on first launch, but reconcile
          // bypasses that path — so the .mcp.json on disk persists from whenever
          // the agent was originally created. That's how stale script paths
          // (e.g. release/win-unpacked/...) survive past a switch from packaged
          // to dev builds, and how new MCP tools fail to surface to existing
          // supervisors. Rewriting on every reconcile makes this self-healing.
          if (agent.isSupervisor && ws) {
            this.ensureMcpConfig(ws.path, pathType);
            if (agent.workingDirectory && agent.workingDirectory !== ws.path) {
              this.ensureMcpConfig(agent.workingDirectory, pathType);
            }
          }

          // Scaffold refresh on reconcile — same self-healing rationale as the
          // ensureMcpConfig block above: launchAgent() scaffolds on creation, but
          // reconcile bypasses launchAgent, so template version bumps never reach
          // workspaces whose agents only ever respawn via app restart. Writes are
          // version-gated and sidecar-short-circuited, so this is cheap when current.
          // NOTE: do NOT add ensureProviderDirTrust here — it writes ~/.claude.json,
          // which would add a dashboard writer inside the startup herd window.
          if (ws) {
            if (agent.isSupervisor) {
              this.ensureSupervisorScaffold(ws.path, pathType);
            } else if (agent.isWorker) {
              this.ensureWorkerScaffold(ws.path, agent.provider, pathType);
              if (agent.provider === 'codex') this.ensureCodexHookProfile(pathType);
            }
          }

          if (pathType === 'windows') {
            await this.launchWindowsAgent(agent, true);
          } else {
            await this.launchWslAgent(agent, true);
          }
          addEvent(agent.id, 'reconnected');
        } catch (err) {
          console.error(`Failed to reconnect agent ${agent.id}:`, err);
          const priorReconnect = getAgent(agent.id)?.status;
          updateAgentStatus(agent.id, 'crashed');
          addEvent(agent.id, 'reconnect_failed', String(err));
          this.emit('statusChanged', { agentId: agent.id, status: 'crashed', fromStatus: priorReconnect, source: 'restart-failed' } satisfies StatusChangedEvent);
        }
        await new Promise(r => setTimeout(r, AgentSupervisor.RECONCILE_STAGGER_MS));
      }
    }

    // Check for orphaned tmux sessions
    try {
      const sessions = await tmuxListSessions();
      const cadSessions = sessions.filter(s => s.name.startsWith(TMUX_SESSION_PREFIX));
      for (const session of cadSessions) {
        console.log(`Found existing tmux session: ${session.name}`);
      }
    } catch {
      // WSL might not be available
    }

    // Now that agents are active, do an immediate context stats poll
    // so data is available before the first interval tick.
    this.contextStatsMonitor.pollNow();
    this.sessionLogReader.pollNow();
  }
}
