/** Minimal lstat facts needed to project a raw Git tree mode. */
export interface RawGitModeLstat {
  isFile: boolean;
  isSymbolicLink: boolean;
  mode: number;
}

/** Tracked paths keep their seeded mode; new paths derive from lstat facts. */
export function deriveRawGitMode(
  seededMode: string | null,
  stat: RawGitModeLstat | null,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (seededMode !== null) return seededMode;
  if (!stat) return null;
  if (stat.isSymbolicLink) return '120000';
  if (!stat.isFile) return null;
  if (platform === 'win32') return '100644';
  return (stat.mode & 0o100) !== 0 ? '100755' : '100644';
}
