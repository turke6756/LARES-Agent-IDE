// Pure launch-command resolution — Electron-free and DB-free so it can be unit
// tested under plain Node (no native better-sqlite3 binding to load).
//
// Reconciles three inputs into the command that actually spawns:
//   - the explicit launch input command (if any),
//   - the workspace's stored `default_command`,
//   - the requested provider (claude / codex / gemini).
//
// See resolve-launch-command.test.ts for the matrix, and src/main/supervisor/
// index.ts (launchAgent) for the call site.

import { AgentProvider, PathType } from '../../shared/types';
import { DEFAULT_COMMAND, DEFAULT_COMMAND_WSL, PROVIDER_COMMANDS } from '../../shared/constants';

/**
 * Does a workspace's stored `default_command` represent a framework default
 * (the pristine, un-customized launch command) for either environment?
 *
 * Exact string equality is wrong here: the LEGACY framework default carried a
 * trailing ` --chrome` token that the current DEFAULT_COMMAND / DEFAULT_COMMAND_WSL
 * constants no longer include. A workspace row written under the old default
 * (`claude --dangerously-skip-permissions --chrome` / `ccode ... --chrome`) is
 * still pristine — it was never customized by the user — so it must count as a
 * framework default and yield to the provider override. We strip a
 * trailing/standalone ` --chrome` and trim before comparing.
 *
 * (A genuinely custom wrapper command will not match either constant after the
 * strip, so it is still respected verbatim by the caller.)
 */
export function isFrameworkDefaultCommand(workspaceDefaultCommand: string | null | undefined): boolean {
  if (!workspaceDefaultCommand) return false;
  const normalized = workspaceDefaultCommand.replace(/\s+--chrome\b/g, '').trim();
  return normalized === DEFAULT_COMMAND || normalized === DEFAULT_COMMAND_WSL;
}

/** First token of a command line (the binary), ignoring leading whitespace. */
function commandBinary(command: string): string {
  return command.trim().split(/\s+/)[0] || '';
}

/**
 * The claude provider launches via the `claude` (Windows) or `ccode` (WSL)
 * binary. A command whose binary is one of these is a "claude binary" command —
 * the wrong thing to spawn for a codex/gemini provider.
 */
export function isClaudeBinaryCommand(command: string): boolean {
  const bin = commandBinary(command);
  return bin === 'claude' || bin === 'ccode';
}

/**
 * Resolve the launch command for an agent, reconciling the explicit launch
 * input, the workspace's stored default command, and the requested provider.
 *
 * Two correctness rules live here (see the launch-path bug report):
 *
 *  1. Framework-default normalization. When the workspace command is a pristine
 *     framework default (incl. a legacy ` --chrome` variant), respect the
 *     provider override and use PROVIDER_COMMANDS[provider][pathType] — so a
 *     `codex`/`gemini` launch in a default workspace spawns the correct binary
 *     instead of the stored claude command.
 *
 *  2. Provider-mismatch guard. Even when the workspace command is a genuinely
 *     custom (non-framework) command, a non-claude provider must NEVER be
 *     silently launched as a claude/ccode binary. If the resolved command would
 *     be a claude/ccode command while the requested provider is codex/gemini,
 *     prefer the provider's default command and flag the override so the caller
 *     can warn. (A `claude` provider with a custom wrapper keeps the wrapper —
 *     only non-claude providers trip the guard.)
 */
export function resolveLaunchCommand(opts: {
  inputCommand?: string | null;
  workspaceDefaultCommand?: string | null;
  provider: AgentProvider;
  pathType: PathType;
}): { command: string; providerOverride: { from: string; to: string } | null } {
  const { inputCommand, workspaceDefaultCommand, provider, pathType } = opts;
  const defaultCmd = PROVIDER_COMMANDS[provider][pathType];
  const isFrameworkDefault = isFrameworkDefaultCommand(workspaceDefaultCommand);
  let command = inputCommand || (isFrameworkDefault ? defaultCmd : (workspaceDefaultCommand || defaultCmd));

  // Rule 2: never launch a non-claude provider via a claude/ccode binary.
  let providerOverride: { from: string; to: string } | null = null;
  if (provider !== 'claude' && command && isClaudeBinaryCommand(command)) {
    providerOverride = { from: command, to: defaultCmd };
    command = defaultCmd;
  }

  return { command, providerOverride };
}
