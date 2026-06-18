/**
 * Canonical comparison key for a file path, used by the detached-window
 * ownership registry (src/main/detached-windows.ts) so the same file opened
 * via different path spellings maps to one owner.
 *
 * Mirrors the normalization behind `pathMatches` in the renderer store
 * (dashboard-store.ts) but is case-aware: Windows-native paths (drive-letter
 * `C:\...`) are case-insensitive, so they are lowercased; WSL / unix paths are
 * case-sensitive and kept verbatim (only slash-normalized + trailing-slash
 * stripped). Shared so both main and renderer agree on the key shape.
 */
export function normalizeFileKey(filePath: string): string {
  const fwd = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  // Drive-letter paths (C:/Users/...) are the only reliably case-insensitive
  // form; everything else (POSIX /home/..., \\wsl.localhost UNC) stays verbatim.
  const isWindowsDriveLetter = /^[A-Za-z]:\//.test(fwd);
  return isWindowsDriveLetter ? fwd.toLowerCase() : fwd;
}
