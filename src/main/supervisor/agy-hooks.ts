import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

/** Global named-hook id owned by Lares. Antigravity 1.1.9 discovers executable
 * handlers only from ~/.gemini/config/hooks.json using the named+nested shape
 * produced by its /hooks UI. Project .agents/hooks.json and plugin delivery are
 * conclusively inert (agy Phase-0 probes 0.5/0.6). */
export const AGY_STATUS_HOOK_NAME = 'lares-dashboard-status';

/** cmd.exe-safe and workspace-independent: agy runs the hook from its launch
 * cwd (.lares/workers/agy), so this quote-free relative path reaches the shared
 * workspace script without baking one workspace into the global config. The
 * explicit event env keeps dashboard-status.mjs's dedupe/provenance vocabulary
 * honest while its argv state remains `working`. */
export const AGY_STATUS_HOOK_COMMAND =
  'if defined AGENT_ID set CLAUDE_HOOK_EVENT_NAME=PreInvocation&& node ..\\..\\scripts\\dashboard-status.mjs working';

export const AGY_STATUS_HOOK_ENTRY = {
  SessionStart: null,
  PreInvocation: [
    {
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command: AGY_STATUS_HOOK_COMMAND,
        },
      ],
    },
  ],
  PostInvocation: null,
  Stop: null,
  PreToolUse: null,
  PostToolUse: null,
} as const;

export type AgyStatusHookMerge =
  | { action: 'write'; content: string }
  | { action: 'unchanged' }
  | { action: 'invalid'; reason: string };

/** Merge only Lares's named entry into the user-global hooks file. Foreign
 * named hooks survive untouched; malformed/non-object input fails closed to a
 * no-write result instead of clobbering user configuration. */
export function mergeAgyStatusHook(existing: string | null): AgyStatusHookMerge {
  let root: Record<string, unknown>;
  if (existing === null || existing.trim() === '') {
    root = {};
  } else {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { action: 'invalid', reason: 'root must be a JSON object' };
      }
      root = parsed as Record<string, unknown>;
    } catch (err) {
      return {
        action: 'invalid',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (isDeepStrictEqual(root[AGY_STATUS_HOOK_NAME], AGY_STATUS_HOOK_ENTRY)) {
    return { action: 'unchanged' };
  }

  root[AGY_STATUS_HOOK_NAME] = AGY_STATUS_HOOK_ENTRY;
  return { action: 'write', content: `${JSON.stringify(root, null, 2)}\n` };
}

export type EnsureAgyStatusHookResult =
  | { action: 'written'; configPath: string }
  | { action: 'unchanged'; configPath: string }
  | { action: 'invalid'; configPath: string; reason: string };

/** Filesystem wrapper for the merge above. Writes atomically and only when the
 * managed named entry differs; callers own best-effort logging policy. */
export function ensureAgyStatusHook(home: string | undefined): EnsureAgyStatusHookResult {
  if (!home) throw new Error('USERPROFILE/HOME is unavailable');
  const configDir = path.join(home, '.gemini', 'config');
  const configPath = path.join(configDir, 'hooks.json');
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  const merged = mergeAgyStatusHook(existing);
  if (merged.action === 'unchanged') return { action: 'unchanged', configPath };
  if (merged.action === 'invalid') return { ...merged, configPath };

  fs.mkdirSync(configDir, { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, merged.content, 'utf-8');
  fs.renameSync(tmp, configPath);
  return { action: 'written', configPath };
}
