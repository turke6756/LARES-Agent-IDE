import * as fs from 'fs';
import * as path from 'path';
import mammoth from 'mammoth';
import type { FileMutationResult, PathType } from '../shared/types';
import { ensureWindowsPath, ensureWslPath } from './path-utils';
import {
  assertInsideRoot,
  normalizeWindowsPath,
  normalizeWslPath,
} from './security/path-confinement';
import { wslExecCommand } from './wsl-bridge';

const MAX_DOCX_SIZE = 25 * 1024 * 1024;
const WSL_TIMEOUT = 10000;
const WSL_MAX_BUFFER = 1024 * 1024;
const DANGEROUS_CHARS = /[$`;&|]/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

type UnifiedModule = typeof import('unified');
type RehypeSanitizeModule = typeof import('rehype-sanitize');

const dynamicImport = new Function('specifier', 'return import(specifier)') as <T>(specifier: string) => Promise<T>;

async function importEsm<T>(specifier: string): Promise<T> {
  return dynamicImport<T>(specifier);
}

function sanitizeShellPath(p: string): string {
  if (DANGEROUS_CHARS.test(p)) {
    throw new Error('Path contains disallowed shell characters');
  }
  if (CONTROL_CHARS.test(p)) {
    throw new Error('Path contains control characters');
  }
  return p;
}

function shellQuote(p: string): string {
  const sanitized = sanitizeShellPath(p);
  return `'${sanitized.replace(/'/g, `'\\''`)}'`;
}

async function runWsl(command: string, input?: string): Promise<string> {
  const result = await wslExecCommand(command, {
    input,
    timeout: WSL_TIMEOUT,
    maxBuffer: WSL_MAX_BUFFER,
    throwOnError: true,
    trimOutput: false,
  });
  return result.stdout;
}

function docxReadPath(filePath: string, pathType: PathType): string {
  return pathType === 'wsl' ? ensureWindowsPath(filePath, pathType) : filePath;
}

function assertDocxSize(readPath: string): number {
  const stat = fs.statSync(readPath);
  if (stat.size > MAX_DOCX_SIZE) {
    throw new Error(`Word document is too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Open in VS Code instead.`);
  }
  return stat.size;
}

function formatMammothMessages(messages: Array<{ type: string; message: string }>): string[] {
  return messages
    .filter((message) => message.type === 'warning' || message.type === 'error')
    .map((message) => message.message);
}

async function docxToHtmlUnsafe(filePath: string, pathType: PathType): Promise<{ html: string; size: number; warnings: string[] }> {
  const readPath = docxReadPath(filePath, pathType);
  const size = assertDocxSize(readPath);
  const result = await mammoth.convertToHtml(
    { path: readPath },
    {
      externalFileAccess: false,
      convertImage: mammoth.images.imgElement(async (image) => ({
        src: `data:${image.contentType};base64,${await image.readAsBase64String()}`,
      })),
    },
  );
  return {
    html: result.value,
    size,
    warnings: formatMammothMessages(result.messages),
  };
}

async function htmlPipeline() {
  const [
    { unified },
    { default: rehypeParse },
    sanitizeModule,
    { default: rehypeStringify },
  ] = await Promise.all([
    importEsm<UnifiedModule>('unified'),
    importEsm<typeof import('rehype-parse')>('rehype-parse'),
    importEsm<RehypeSanitizeModule>('rehype-sanitize'),
    importEsm<typeof import('rehype-stringify')>('rehype-stringify'),
  ]);

  const { default: rehypeSanitize, defaultSchema } = sanitizeModule;
  const docxSanitizeSchema = {
    ...defaultSchema,
    attributes: {
      ...defaultSchema.attributes,
      img: [
        ...((defaultSchema.attributes?.img ?? []) as unknown[]),
        'alt',
      ],
    },
    protocols: {
      ...defaultSchema.protocols,
      src: ['http', 'https', 'data'],
    },
  };
  return unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeSanitize as any, docxSanitizeSchema)
    .use(rehypeStringify);
}

export async function sanitizeDocxHtml(html: string): Promise<string> {
  const processor = await htmlPipeline();
  return String(await processor.process(html));
}

export async function readDocxAsHtml(filePath: string, pathType: PathType) {
  const converted = await docxToHtmlUnsafe(filePath, pathType);
  return {
    path: filePath,
    content: await sanitizeDocxHtml(converted.html),
    encoding: 'utf-8',
    size: converted.size,
    contentKind: 'html' as const,
    warnings: converted.warnings,
  };
}

export async function docxHtmlToMarkdown(html: string): Promise<string> {
  const [
    { unified },
    { default: rehypeParse },
    sanitizeModule,
    { default: rehypeRemark },
    { default: remarkGfm },
    { default: remarkStringify },
    { default: stringWidth },
  ] = await Promise.all([
    importEsm<UnifiedModule>('unified'),
    importEsm<typeof import('rehype-parse')>('rehype-parse'),
    importEsm<RehypeSanitizeModule>('rehype-sanitize'),
    importEsm<typeof import('rehype-remark')>('rehype-remark'),
    importEsm<typeof import('remark-gfm')>('remark-gfm'),
    importEsm<typeof import('remark-stringify')>('remark-stringify'),
    importEsm<typeof import('string-width')>('string-width'),
  ]);

  const { default: rehypeSanitize, defaultSchema } = sanitizeModule;
  const docxSanitizeSchema = {
    ...defaultSchema,
    protocols: {
      ...defaultSchema.protocols,
      src: ['http', 'https', 'data'],
    },
  };
  const file = await unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeSanitize as any, docxSanitizeSchema)
    .use(rehypeRemark)
    .use(remarkGfm, { stringLength: stringWidth })
    .use(remarkStringify, {
      bullet: '-',
      fences: true,
      listItemIndent: 'one',
      resourceLink: true,
    })
    .process(html);

  return String(file).trimEnd() + '\n';
}

function siblingMarkdownPath(filePath: string, pathType: PathType, suffix = ''): string {
  if (pathType === 'wsl') {
    const wslPath = normalizeWslPath(ensureWslPath(filePath, pathType));
    const dir = path.posix.dirname(wslPath);
    const base = path.posix.basename(wslPath, path.posix.extname(wslPath));
    return `${dir}/${base}${suffix}.md`;
  }

  const resolved = normalizeWindowsPath(filePath);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved, path.extname(resolved));
  return path.join(dir, `${base}${suffix}.md`);
}

async function pathExists(filePath: string, pathType: PathType): Promise<boolean> {
  if (pathType === 'wsl') {
    try {
      await runWsl(`test -e ${shellQuote(filePath)}`);
      return true;
    } catch {
      return false;
    }
  }
  return fs.existsSync(filePath);
}

async function uniqueSiblingMarkdownPath(filePath: string, rootDirectory: string, pathType: PathType): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const candidate = siblingMarkdownPath(filePath, pathType, i === 0 ? '' : `-${i}`);
    assertInsideRoot(candidate, rootDirectory, pathType);
    if (!await pathExists(candidate, pathType)) return candidate;
  }
  throw new Error('Could not find an available Markdown filename next to the Word document');
}

export async function createMarkdownFromDocx(
  filePath: string,
  rootDirectory: string,
  pathType: PathType,
): Promise<FileMutationResult> {
  try {
    assertInsideRoot(filePath, rootDirectory, pathType);
    const converted = await docxToHtmlUnsafe(filePath, pathType);
    const markdown = await docxHtmlToMarkdown(converted.html);
    const targetPath = await uniqueSiblingMarkdownPath(filePath, rootDirectory, pathType);

    if (pathType === 'wsl') {
      await runWsl(`cat > ${shellQuote(targetPath)}`, markdown);
      return { ok: true, path: targetPath };
    }

    fs.writeFileSync(targetPath, markdown, { encoding: 'utf-8', flag: 'wx' });
    return { ok: true, path: targetPath };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message || 'Failed to convert Word document' : 'Failed to convert Word document',
    };
  }
}
