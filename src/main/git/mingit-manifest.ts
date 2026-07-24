// mingit-manifest.ts — the single source of truth for the bundled MinGit pin
// (Git-Native WP-G0.1). MAIN-PROCESS ONLY: shared code is renderer-bundled and
// cannot read the filesystem, so the manifest is loaded here rather than
// dynamically imported from `src/shared`.
//
// Two runtime locations, one schema:
//   dev/build   → <repoRoot>/third_party/git-for-windows/mingit-manifest.json
//                 (checked in; the file WP-G0.5 pins once Edward chooses a version)
//   packaged    → <process.resourcesPath>/mingit/mingit-manifest.json
//                 (copied in beside the extracted MinGit payload by the packager)
//
// `version`/`archiveUrl`/`sha256`/`archiveName` are placeholders (empty strings)
// until WP-G0.5; `packagedGitExeRelPath` carries the standard MinGit layout
// value now. Shape is validated on load so a malformed/partial manifest fails
// loudly at the seam rather than as an undefined field deep in git-runtime.

import * as fs from 'fs';
import * as path from 'path';

export interface MinGitManifest {
  /** git-for-windows release, e.g. "2.45.2" — empty until WP-G0.5 pins it. */
  version: string;
  /** Download URL for the MinGit archive — empty until WP-G0.5. */
  archiveUrl: string;
  /** Hex SHA-256 of the archive, verified before extraction — empty until WP-G0.5. */
  sha256: string;
  /** Basename of the archive on disk — empty until WP-G0.5. */
  archiveName: string;
  /** git.exe path INSIDE the extracted MinGit tree. Standard layout: "cmd/git.exe". */
  packagedGitExeRelPath: string;
}

const REQUIRED_KEYS: readonly (keyof MinGitManifest)[] = [
  'version',
  'archiveUrl',
  'sha256',
  'archiveName',
  'packagedGitExeRelPath',
];

/** Validate + narrow an untrusted parsed value into a MinGitManifest. Every
 *  required key must be present and a string (placeholders are the empty
 *  string, still a string). Throws with an actionable message otherwise. */
export function validateMinGitManifest(raw: unknown): MinGitManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('mingit-manifest: expected a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    if (!(key in obj)) {
      throw new Error(`mingit-manifest: missing required key '${key}'`);
    }
    if (typeof obj[key] !== 'string') {
      throw new Error(`mingit-manifest: key '${key}' must be a string`);
    }
  }
  return {
    version: obj.version as string,
    archiveUrl: obj.archiveUrl as string,
    sha256: obj.sha256 as string,
    archiveName: obj.archiveName as string,
    packagedGitExeRelPath: obj.packagedGitExeRelPath as string,
  };
}

/** Read + validate a manifest from an explicit path. Separated from path
 *  resolution so tests can exercise the real checked-in file (and validation)
 *  under plain node, without Electron. */
export function loadMinGitManifestFrom(filePath: string): MinGitManifest {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `mingit-manifest: cannot read '${filePath}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `mingit-manifest: invalid JSON in '${filePath}': ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return validateMinGitManifest(parsed);
}

/** Compute the manifest path for the current runtime. Inputs injected so the
 *  computation is testable without Electron. Dev/build resolves the repo-root
 *  checked-in copy; packaged resolves the payload beside the extracted MinGit. */
export function resolveMinGitManifestPath(opts: {
  isPackaged: boolean;
  resourcesPath?: string;
  repoRoot?: string;
}): string {
  if (opts.isPackaged) {
    if (!opts.resourcesPath) {
      throw new Error('mingit-manifest: resourcesPath is required in a packaged runtime');
    }
    return path.join(opts.resourcesPath, 'mingit', 'mingit-manifest.json');
  }
  // __dirname at runtime is <repoRoot>/dist/main/main/git → four levels up.
  const repoRoot = opts.repoRoot ?? path.resolve(__dirname, '..', '..', '..', '..');
  return path.join(repoRoot, 'third_party', 'git-for-windows', 'mingit-manifest.json');
}

/** Convenience loader for the live main process. Reads Electron's packaging
 *  state lazily so this module stays importable under plain-node tests. */
export function loadMinGitManifest(): MinGitManifest {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as { app: { isPackaged: boolean } };
  const filePath = resolveMinGitManifestPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  return loadMinGitManifestFrom(filePath);
}
