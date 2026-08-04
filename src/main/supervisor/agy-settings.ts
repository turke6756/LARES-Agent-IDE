import fs from 'node:fs';
import path from 'node:path';

/** Antigravity 1.1.9 permissions only enter pattern mode when the target starts
 * with `regex:`. Bare command(...) targets are exact-full-command matches and
 * therefore cannot protect argument-bearing git discard forms (Phase-0 probes
 * 0.3, 0.5c, and 0.6). Keep these anchored and verb-specific: a broad `git.*`
 * deny would block harmless work and is not an acceptable safety seed. */
const AGY_GIT_COMMAND_PREFIX =
  String.raw`^((env\s+)?[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*git(\.exe)?(\s+(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)\s+\S+|\s+--(git-dir|work-tree|namespace|exec-path)=\S+)*\s+`;

// Removed during merge because agy's native matcher does not support the
// negative lookahead and therefore fails open on the commands it was meant to deny.
const AGY_BROKEN_STASH_LOOKAHEAD_RULE =
  `command(regex:${AGY_GIT_COMMAND_PREFIX}stash\\s+(?!(?:-\\S+\\s+)*(?:list|show)(?:\\s|$)).+$)`;

// agy matches the complete shell string. Keep the optional chain prefix here
// so a destructive stash command cannot escape by following another command.
const AGY_STASH_MUTATION_DENY_RULE = String.raw`command(regex:^(?:.*(?:;|&&|\|\|)\s*)?((env\s+)?[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*git(\.exe)?(\s+(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)\s+\S+|\s+--(git-dir|work-tree|namespace|exec-path)=\S+)*\s+stash\s+((?:-\S+\s+)*(?:push|save|apply|drop|clear|pop|branch|store|create)(?:\s+.*)?|(?:-\S+\s*)+)$)`;

export const AGY_GIT_DISCARD_DENY_RULES = [
  `command(regex:${AGY_GIT_COMMAND_PREFIX}reset\\s+.*--(hard|merge|keep)(\\s+.*)?$)`,
  `command(regex:${AGY_GIT_COMMAND_PREFIX}checkout(\\s+.*)?$)`,
  `command(regex:${AGY_GIT_COMMAND_PREFIX}restore(\\s+.*)?$)`,
  `command(regex:${AGY_GIT_COMMAND_PREFIX}clean(\\s+.*)?$)`,
  `command(regex:${AGY_GIT_COMMAND_PREFIX}stash$)`,
  AGY_STASH_MUTATION_DENY_RULE,
] as const;

const AGY_GIT_DISCARD_DENY_RULE_SET = new Set<string>(AGY_GIT_DISCARD_DENY_RULES);

export type AgySettingsMerge =
  | { action: 'write'; content: string }
  | { action: 'unchanged' }
  | { action: 'invalid'; reason: string };

export type EnsureAgySettingsResult =
  | { action: 'written'; settingsPath: string }
  | { action: 'unchanged'; settingsPath: string }
  | { action: 'invalid'; settingsPath: string; reason: string };

function parseSettings(existing: string | null):
  | { root: Record<string, unknown> }
  | { reason: string } {
  if (existing === null) return { root: {} };
  try {
    const parsed: unknown = JSON.parse(existing);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { reason: 'root must be a JSON object' };
    }
    return { root: parsed as Record<string, unknown> };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Produce the exact key spelling agy persists: absolute, backslash-separated,
 * case-preserved, with no realpath/git-root/home normalization. Unsafe broad
 * roots are refused rather than granting trust beyond a concrete workspace. */
export function agyTrustPathKey(dir: string, pathType: string, home?: string): string | null {
  if (pathType !== 'windows' || !dir) return null;
  const key = dir.replace(/\//g, '\\').replace(/\\+$/, '');
  if (!path.win32.isAbsolute(key)) return null;
  const root = path.win32.parse(key).root.replace(/\\+$/, '');
  if (!root || key.toLowerCase() === root.toLowerCase()) return null;
  const homeKey = (home || process.env.USERPROFILE || process.env.HOME || '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '');
  if (homeKey && key.toLowerCase() === homeKey.toLowerCase()) return null;
  return key;
}

/** Add exact raw launch-cwd keys to trustedWorkspaces. Foreign top-level keys
 * and every existing trust entry survive; malformed/ambiguous shapes fail to
 * an explicit no-write result. */
export function mergeAgyTrust(existing: string | null, keys: string[]): AgySettingsMerge {
  const parsed = parseSettings(existing);
  if ('reason' in parsed) return { action: 'invalid', reason: parsed.reason };
  const current = parsed.root.trustedWorkspaces;
  if (current !== undefined && (!Array.isArray(current) || current.some(v => typeof v !== 'string'))) {
    return { action: 'invalid', reason: 'trustedWorkspaces must be an array of strings' };
  }
  const trusted = (current ?? []) as string[];
  const present = new Set(trusted);
  let changed = false;
  for (const key of keys) {
    if (!key || present.has(key)) continue;
    trusted.push(key);
    present.add(key);
    changed = true;
  }
  if (!changed) return { action: 'unchanged' };
  parsed.root.trustedWorkspaces = trusted;
  return { action: 'write', content: `${JSON.stringify(parsed.root, null, 2)}\n` };
}

/** Add only the fixed, reviewed git-discard deny set and remove the known-broken
 * stash lookahead rule. The optional argument is
 * a testable safety seam: any unreviewed/broad pattern is refused wholesale.
 * permissions.allow and permissions.ask are never assigned or normalized. */
export function mergeAgyPermissions(
  existing: string | null,
  rules: readonly string[] = AGY_GIT_DISCARD_DENY_RULES,
): AgySettingsMerge {
  if (rules.some(rule => !AGY_GIT_DISCARD_DENY_RULE_SET.has(rule))) {
    return { action: 'invalid', reason: 'deny seed contains an unreviewed or unsafe broad pattern' };
  }
  const parsed = parseSettings(existing);
  if ('reason' in parsed) return { action: 'invalid', reason: parsed.reason };
  const currentPermissions = parsed.root.permissions;
  if (
    currentPermissions !== undefined
    && (currentPermissions === null || typeof currentPermissions !== 'object' || Array.isArray(currentPermissions))
  ) {
    return { action: 'invalid', reason: 'permissions must be a JSON object' };
  }
  const permissions = (currentPermissions ?? {}) as Record<string, unknown>;
  const currentDeny = permissions.deny;
  if (currentDeny !== undefined && (!Array.isArray(currentDeny) || currentDeny.some(v => typeof v !== 'string'))) {
    return { action: 'invalid', reason: 'permissions.deny must be an array of strings' };
  }
  const originalDeny = (currentDeny ?? []) as string[];
  const deny = originalDeny.filter(rule => rule !== AGY_BROKEN_STASH_LOOKAHEAD_RULE);
  const present = new Set(deny);
  let changed = deny.length !== originalDeny.length;
  for (const rule of rules) {
    if (present.has(rule)) continue;
    deny.push(rule);
    present.add(rule);
    changed = true;
  }
  if (!changed) return { action: 'unchanged' };
  permissions.deny = deny;
  parsed.root.permissions = permissions;
  return { action: 'write', content: `${JSON.stringify(parsed.root, null, 2)}\n` };
}

function ensureAgySettings(
  home: string | undefined,
  merge: (existing: string | null) => AgySettingsMerge,
): EnsureAgySettingsResult {
  if (!home) throw new Error('USERPROFILE/HOME is unavailable');
  const settingsDir = path.join(home, '.gemini', 'antigravity-cli');
  const settingsPath = path.join(settingsDir, 'settings.json');
  const existing = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf-8') : null;
  const merged = merge(existing);
  if (merged.action === 'unchanged') return { action: 'unchanged', settingsPath };
  if (merged.action === 'invalid') return { ...merged, settingsPath };

  fs.mkdirSync(settingsDir, { recursive: true });
  const tmp = `${settingsPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, merged.content, 'utf-8');
  try {
    fs.renameSync(tmp, settingsPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort temp cleanup */ }
    throw err;
  }
  return { action: 'written', settingsPath };
}

export function ensureAgyTrust(
  home: string | undefined,
  dirs: string[],
  pathType: string,
): EnsureAgySettingsResult {
  const keys = dirs
    .map(dir => agyTrustPathKey(dir, pathType, home))
    .filter((key): key is string => key !== null);
  return ensureAgySettings(home, existing => mergeAgyTrust(existing, keys));
}

export function ensureAgyPermissions(home: string | undefined): EnsureAgySettingsResult {
  return ensureAgySettings(home, existing => mergeAgyPermissions(existing));
}
