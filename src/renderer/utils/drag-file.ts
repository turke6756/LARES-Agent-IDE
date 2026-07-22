/**
 * Utilities for dragging file paths from UI elements into the terminal.
 */

/** Characters that are safe to leave unquoted in a shell path */
const SAFE_PATH_RE = /^[a-zA-Z0-9._/:\-]+$/;

/**
 * Shell-escape a file path for safe pasting into a terminal.
 * Clean paths pass through unchanged; paths with spaces or special
 * characters get single-quote wrapped with internal `'` escaped.
 */
export function shellEscapePath(path: string): string {
  if (SAFE_PATH_RE.test(path)) return path;
  // Wrap in single quotes, escaping any internal single quotes as '\''
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

/**
 * onDragStart handler — sets the file path on the drag event's dataTransfer.
 * Attach to any element that represents a file the user might want to
 * drop into the terminal.
 */
export function fileDragStart(e: React.DragEvent, filePath: string): void {
  e.dataTransfer.setData('application/x-file-path', filePath);
  e.dataTransfer.setData('text/plain', filePath);
  e.dataTransfer.effectAllowed = 'copy';
}

export const TREE_ENTRY_MIME = 'application/x-tree-entry';

/**
 * onDragStart handler for directory-tree rows. Sets both the tree-internal
 * payload (used to move entries between folders) and the legacy file-path
 * keys so the row can still be dragged into the terminal or chat input.
 */
export function treeEntryDragStart(
  e: React.DragEvent,
  filePath: string,
  isDirectory: boolean,
): void {
  e.dataTransfer.setData(TREE_ENTRY_MIME, JSON.stringify({ path: filePath, isDirectory }));
  e.dataTransfer.setData('application/x-file-path', filePath);
  e.dataTransfer.setData('text/plain', filePath);
  e.dataTransfer.effectAllowed = 'copyMove';
}

/**
 * True when the drag originated from a directory-tree row inside the app.
 * Check this BEFORE external-file handling: internal tree drags also carry
 * legacy text/plain + file-path keys that could otherwise be misrouted.
 */
export function isInternalTreeDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(TREE_ENTRY_MIME);
}

/** True when the drag carries OS files (e.g. from Windows Explorer) and is
 *  not an internal tree drag. Plain-text and other drags don't qualify. */
export function isExternalFileDrop(dataTransfer: DataTransfer): boolean {
  return !dataTransfer.types.includes(TREE_ENTRY_MIME) && dataTransfer.types.includes('Files');
}

/**
 * Early renderer-side detection of folder drops, which aren't supported.
 * Best-effort via webkitGetAsEntry() — the main process re-checks every
 * source with stat and is the source of truth. Must be called synchronously
 * inside the drop handler (dataTransfer.items is neutered after an await).
 */
export function hasDroppedDirectory(dataTransfer: DataTransfer): boolean {
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) return true;
  }
  return false;
}

/**
 * Resolve the native filesystem paths of dropped OS files via the preload
 * webUtils bridge (Electron 41 removed File.path). Must be called
 * synchronously inside the drop handler, before any await.
 */
export function getDroppedNativePaths(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.files)
    .map((file) => window.api.files.getPathForFile(file))
    .filter(Boolean);
}

export const SUPPORTED_IMAGE_MIMES = ['image/png', 'image/jpeg'] as const;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // mirror of main; early reject

/** Prefer PNG, then JPEG; null if no supported image type present. */
export function pickSupportedImageMime(types: readonly string[]): string | null {
  if (types.includes('image/png')) return 'image/png';
  if (types.includes('image/jpeg')) return 'image/jpeg';
  return null;
}

async function blobToImage(
  blob: Blob, mime: string,
): Promise<{ bytes: Uint8Array; mime: string } | { error: string }> {
  if (blob.size === 0) return { error: 'Image was empty.' };
  if (blob.size > MAX_IMAGE_BYTES) return { error: 'Image too large (max 25 MB).' };
  const buf = await blob.arrayBuffer();
  return { bytes: new Uint8Array(buf), mime };
}

/** For xterm's keyboard handler (no ClipboardEvent available). Returns:
 *  - {bytes,mime} on a supported image
 *  - null when there is no image at all (→ caller does text fallback)
 *  - {error} when an image exists but is unsupported/too-large (→ surface it) */
export async function readClipboardImage():
  Promise<{ bytes: Uint8Array; mime: string } | { error: string } | null> {
  try {
    if (!navigator.clipboard?.read) return null;
    const items = await navigator.clipboard.read();
    let sawImage = false;
    for (const item of items) {
      if (item.types.some((t) => t.startsWith('image/'))) sawImage = true;
      const mime = pickSupportedImageMime(item.types);
      if (!mime) continue;
      return await blobToImage(await item.getType(mime), mime);
    }
    return sawImage ? { error: 'Only PNG and JPEG images are supported.' } : null;
  } catch { return null; }
}

/** For chat's onPaste — consume the Blob already on the ClipboardEvent (no
 *  second navigator.clipboard.read(), avoiding a permission/race window). */
export async function imageFromClipboardEvent(
  e: React.ClipboardEvent,
): Promise<{ bytes: Uint8Array; mime: string } | { error: string } | null> {
  const items = Array.from(e.clipboardData.items);
  const anyImage = items.some((i) => i.type.startsWith('image/'));
  const supported = items.find((i) =>
    (SUPPORTED_IMAGE_MIMES as readonly string[]).includes(i.type));
  if (!supported) return anyImage ? { error: 'Only PNG and JPEG images are supported.' } : null;
  const file = supported.getAsFile();
  if (!file) return { error: 'Could not read the pasted image.' };
  return blobToImage(file, supported.type);
}
