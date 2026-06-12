// Claude Code child-session env sanitization.
//
// When the Electron app is launched from inside a Claude Code session (e.g.
// `npm run restart` typed into a claude terminal), process.env carries the
// markers Claude Code stamps on its tool subprocesses. Every claude.exe the
// dashboard then spawns inherits them and behaves as a *nested child session*:
// it stops persisting its transcript .jsonl (writes only an ai-title stub),
// which kills chat streaming, context stats, and resumability for every
// Windows claude agent. Root cause analysis:
// docs/BUG_claude-child-session-env-poisoning.md
//
// NOT in this list (deliberately):
//  - CLAUDE_CODE_GIT_BASH_PATH — needed for Git Bash discovery.
//  - CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS — the user's choice for their own
//    sessions, configured in ~/.claude/settings.json; harmless without the
//    child-session markers above.

export const CLAUDE_CHILD_SESSION_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
] as const;

/**
 * Pure: returns a copy of `env` with the child-session marker keys removed.
 * Every other key — including CLAUDE_CODE_GIT_BASH_PATH — is preserved.
 */
export function sanitizeClaudeChildEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of CLAUDE_CHILD_SESSION_ENV_KEYS) {
    delete out[key];
  }
  return out;
}

/**
 * In-place variant for `process.env` at app startup. Returns the names of the
 * keys that were actually present (callers use a non-empty result to log the
 * "launched from inside a Claude Code session" warning).
 */
export function stripClaudeChildEnvInPlace(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const key of CLAUDE_CHILD_SESSION_ENV_KEYS) {
    if (env[key] !== undefined) {
      removed.push(key);
      delete env[key];
    }
  }
  return removed;
}
