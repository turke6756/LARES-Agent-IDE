// Advisory hint only — substring match on the path. False-negatives are
// possible via junctions, symlinks, or subst-mapped drive letters. Do not
// use as a gate; resolve via fs.realpathSync first if you ever do.
const SYNC_PATTERNS: ReadonlyArray<{ name: string; needle: string }> = [
  { name: 'OneDrive',     needle: '\\onedrive' },
  { name: 'OneDrive',     needle: '/onedrive' },
  { name: 'Dropbox',      needle: '\\dropbox' },
  { name: 'Dropbox',      needle: '/dropbox' },
  { name: 'Google Drive', needle: '\\google drive' },
  { name: 'Google Drive', needle: '/google drive' },
  { name: 'iCloud Drive', needle: '\\icloud drive' },
  { name: 'iCloud Drive', needle: '/icloud drive' },
];

export interface SyncFolderHit {
  provider: string;
}

export function detectSyncFolder(workspacePath: string | null | undefined): SyncFolderHit | null {
  if (!workspacePath) return null;
  const lower = workspacePath.toLowerCase();
  for (const { name, needle } of SYNC_PATTERNS) {
    if (lower.includes(needle)) return { provider: name };
  }
  return null;
}
