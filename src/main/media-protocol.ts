import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { resolveConfined } from './security/path-confinement';

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

type ByteRange = { start: number; end: number };

export interface MediaProtocolOptions {
  workspaceRoots: string[];
  platform?: NodeJS.Platform;
  translateWslPath?: (filePath: string) => string;
  onRejected?: (requestUrl: string) => void;
}

/**
 * The one method of Electron's `Session.protocol` we depend on. Declared
 * structurally so this module stays Electron-free (and node-testable) while the
 * same registration can be installed on ANY session — the default session today
 * (index.ts), or a dedicated PDF-viewer session for Candidate B (plan 1.11 / 3).
 */
export interface MediaProtocolTarget {
  handle(scheme: string, handler: (request: Request) => Promise<Response> | Response): void;
}

/**
 * Install the `media://` handler on a session's protocol. SECURITY: install
 * ONLY on sessions that should resolve confined workspace files — never on
 * browser partitions. Behavior (realpath confinement / WSL / range / HEAD) is
 * identical regardless of session; only the host session differs.
 */
export function registerMediaProtocol(
  protocol: MediaProtocolTarget,
  options: MediaProtocolOptions,
): void {
  protocol.handle('media', (request) => handleMediaProtocolRequest(request, options));
}

/** Parse one RFC 7233 byte range. Multiple and unsatisfiable ranges are rejected. */
export function parseSingleByteRange(value: string, size: number): ByteRange | null {
  if (!Number.isSafeInteger(size) || size < 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (match[1] === '' && match[2] === '') || size === 0) return null;

  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start >= size) return null;

  const requestedEnd = match[2] === '' ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function mediaHeaders(filePath: string, size: number, modifiedAt: Date): Headers {
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Content-Length': String(size),
    'Last-Modified': modifiedAt.toUTCString(),
  });
  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()];
  if (contentType) headers.set('Content-Type', contentType);
  return headers;
}

/** Build a stream response for a path that has already passed realpath confinement. */
export async function createMediaFileResponse(
  filePath: string,
  method: string,
  rangeHeader: string | null,
): Promise<Response> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return new Response('File not found', { status: 404 });
  }
  if (!stat.isFile()) return new Response('File not found', { status: 404 });

  const headers = mediaHeaders(filePath, stat.size, stat.mtime);
  if (method.toUpperCase() === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }

  let start = 0;
  let end = Math.max(0, stat.size - 1);
  let status = 200;
  if (rangeHeader !== null) {
    const range = parseSingleByteRange(rangeHeader, stat.size);
    if (range === null) {
      headers.set('Content-Range', `bytes */${stat.size}`);
      headers.set('Content-Length', '0');
      return new Response(null, { status: 416, headers });
    }
    ({ start, end } = range);
    status = 206;
    headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    headers.set('Content-Length', String(end - start + 1));
  }

  const nodeStream = fs.createReadStream(filePath, status === 206 ? { start, end } : undefined);
  const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers });
}

/**
 * Handle media:// only after translating WSL paths and realpath-confining the
 * result to an open workspace. Keeping this pure-Node makes protocol semantics
 * and the security boundary testable without booting Electron.
 */
export async function handleMediaProtocolRequest(
  request: Request,
  options: MediaProtocolOptions,
): Promise<Response> {
  let filePath: string;
  try {
    const url = new URL(request.url);
    filePath = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return new Response('File not found', { status: 404 });
  }

  const platform = options.platform ?? process.platform;
  if (platform === 'win32' && filePath.startsWith('/')) {
    if (!options.translateWslPath) return new Response('File not found', { status: 404 });
    filePath = options.translateWslPath(filePath);
  }

  const confined = resolveConfined(filePath, options.workspaceRoots);
  if (confined === null) {
    options.onRejected?.(request.url);
    return new Response('File not found', { status: 404 });
  }

  return createMediaFileResponse(confined, request.method, request.headers.get('range'));
}
