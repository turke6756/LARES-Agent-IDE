import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useThemeStore } from '../../stores/theme-store';
import { useDashboardStore } from '../../stores/dashboard-store';

// Match relative or absolute file paths with at least one separator and a file
// extension. Examples that match:
//   plans/notes-canvas-implementation.md
//   src/main/database.ts
//   ./docs/ORCHESTRATION_SPIKE.md
//   node_modules/@scope/pkg/index.ts   (@ allowed for scoped packages)
//   C:\Users\foo\bar.txt
//   /home/user/file.py
// Trailing sentence punctuation (".", ",", ")", etc.) is naturally excluded
// because [\w.@\-] doesn't include them and the regex engine backtracks the
// extension off the end.
//
// This regex intentionally OVER-captures: its intermediate-directory group
// accepts any token — including a full `filename.ext` — as a directory segment.
// So a run like `README.md/index.ts` (two files an agent joined with a slash as
// shorthand) is captured whole here, then trimmed by truncateAtFirstFile()
// below. Keep the trimming as a post-step rather than encoding it in the regex:
// a lookahead that forbade extension-bearing intermediate segments could not
// distinguish `foo.bar/` (a real dotted directory) from `foo.md/` (a file) —
// only a known-extension check can, and that is far clearer as a helper.
const FILE_PATH_RE = /((?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|~\/)?(?:[\w.@\-]+[\\/])+[\w.@\-]+\.[A-Za-z0-9]{1,8})/g;

// Common file extensions used to decide whether an INTERMEDIATE path segment is
// really a file (so the path must stop there) rather than a directory. The crux
// the detector must get right: `src/foo.bar/baz.ts` — `foo.bar` is a directory,
// so the path keeps going — versus `README.md/index.ts` — `README.md` is a
// file, so the path must stop at it. Both `.bar` and `.md` are short alphabetic
// suffixes, so no length/char-class heuristic can separate them; only a bounded
// known-extension list can. A suffix NOT in this set (`foo.bar`, `.github`) is
// treated as a directory and left intact. The set is deliberately generous —
// missing an exotic extension only means an over-capture survives (today's
// behavior), never that a legit path stops early.
const KNOWN_FILE_EXTENSIONS = new Set([
  // code
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'json5', 'py', 'pyi', 'rb', 'go',
  'rs', 'java', 'kt', 'kts', 'scala', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh',
  'cs', 'php', 'swift', 'm', 'mm', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'lua', 'pl', 'r', 'sql', 'dart', 'ex', 'exs', 'clj', 'edn', 'elm', 'hs',
  // web / styles
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
  // docs / config / data
  'md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'csv', 'tsv', 'xml', 'yml', 'yaml',
  'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'lock', 'log', 'gitignore',
  // notebooks / office
  'ipynb', 'pynb', 'docx', 'doc', 'pdf', 'xlsx', 'xls', 'pptx', 'ppt', 'rtf',
  // images / media (rare as intermediate segments)
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff', 'mp4', 'mov',
  'webm', 'mp3', 'wav',
]);

// True when a single path segment "looks like a file" — i.e. its final dotted
// component is a known file extension. A leading-dot dotfile like `.github` or
// `.env` (lastIndexOf('.') === 0) is treated as a directory/dotfile, NOT a
// file, so config-dir paths keep matching.
function segmentLooksLikeFile(segment: string): boolean {
  const dot = segment.lastIndexOf('.');
  if (dot <= 0) return false;
  return KNOWN_FILE_EXTENSIONS.has(segment.slice(dot + 1).toLowerCase());
}

// Trim an over-captured path run so it ends at its FIRST file-like segment. An
// extension-bearing token can no longer masquerade as an intermediate directory:
//   README.md/index.ts   -> README.md
//   CLAUDE.md/AGENTS.md   -> CLAUDE.md
//   -wiring.ts/.test.ts   -> -wiring.ts
// while legit dotted directories are preserved because their suffix is unknown:
//   src/foo.bar/baz.ts            -> src/foo.bar/baz.ts   (bar ∉ known)
//   .github/workflows/ci.yml      -> .github/workflows/ci.yml
//   node_modules/@scope/pkg/x.ts  -> node_modules/@scope/pkg/x.ts
// Only NON-terminal segments are tested; the leaf keeps whatever extension it
// has (the regex already required it to end in `.ext`).
export function truncateAtFirstFile(candidate: string): string {
  // Iterate "<segment><separator>" prefixes; the trailing leaf (no separator)
  // is never inspected, so a normal single path is returned untouched.
  const segRe = /([^\\/]+)[\\/]/g;
  let m: RegExpExecArray | null;
  while ((m = segRe.exec(candidate)) !== null) {
    if (segmentLooksLikeFile(m[1])) {
      return candidate.slice(0, m.index + m[1].length);
    }
  }
  return candidate;
}

// Extract the clickable file paths from a chunk of text, in order, each already
// trimmed by truncateAtFirstFile(). Exported for unit testing the detector.
export function extractFilePaths(text: string): string[] {
  const re = new RegExp(FILE_PATH_RE.source, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = truncateAtFirstFile(m[1]);
    out.push(path);
    // Resume scanning right after the trimmed path so the dropped tail (e.g.
    // `/index.ts` in `README.md/index.ts`) is re-examined rather than skipped.
    re.lastIndex = m.index + path.length;
  }
  return out;
}

function renderTextWithPaths(
  text: string,
  onPathClick: (path: string) => void,
  linkClass: string,
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(FILE_PATH_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    const path = truncateAtFirstFile(m[1]);
    const start = m.index;
    const end = start + path.length;
    // Trimmed captures leave a tail (e.g. `/index.ts`); rewind so it can be
    // re-scanned as its own link candidate instead of being skipped.
    re.lastIndex = end;
    if (start > lastIndex) parts.push(text.slice(lastIndex, start));
    parts.push(
      <span
        key={`${start}-${path}`}
        role="link"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          onPathClick(path);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onPathClick(path);
          }
        }}
        className={`underline underline-offset-2 cursor-pointer hover:opacity-80 ${linkClass}`}
        title={`Open ${path}`}
      >
        {path}
      </span>,
    );
    lastIndex = end;
  }
  if (parts.length === 0) return text;
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function transformStringChildren(
  children: React.ReactNode,
  onPathClick: ((path: string) => void) | null,
  linkClass: string,
): React.ReactNode {
  if (!onPathClick) return children;
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') {
      return renderTextWithPaths(child, onPathClick, linkClass);
    }
    return child;
  });
}

export default function AgentMarkdown({ content, agentId }: { content: string; agentId?: string }) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const openFileViewer = useDashboardStore((s) => s.openFileViewer);
  const onPathClick = agentId ? (path: string) => openFileViewer(path, agentId) : null;
  const linkClass = isLight ? 'text-[#0969da]' : 'text-[#79c0ff]';
  const linkify = (children: React.ReactNode) => transformStringChildren(children, onPathClick, linkClass);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => (
          <p className={`mb-2 last:mb-0 text-[13px] leading-[1.6] ${isLight ? 'text-[#1f2328]' : 'text-gray-100'}`}>
            {linkify(children)}
          </p>
        ),
        h1: ({ children }) => (
          <h1 className={`text-[15px] font-bold mt-3 mb-1.5 ${isLight ? 'text-[#1f2328]' : 'text-gray-50'}`}>{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className={`text-[14px] font-bold mt-3 mb-1.5 ${isLight ? 'text-[#1f2328]' : 'text-gray-50'}`}>{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className={`text-[13px] font-bold mt-2 mb-1 ${isLight ? 'text-[#1f2328]' : 'text-gray-100'}`}>{children}</h3>
        ),
        ul: ({ children }) => (
          <ul className="list-disc pl-5 mb-2 space-y-0.5 text-[13px] leading-[1.55]">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="list-decimal pl-5 mb-2 space-y-0.5 text-[13px] leading-[1.55]">{children}</ol>
        ),
        li: ({ children }) => (
          <li className={isLight ? 'text-[#1f2328]' : 'text-gray-100'}>{linkify(children)}</li>
        ),
        strong: ({ children }) => (
          <strong className={`font-semibold ${isLight ? 'text-[#1f2328]' : 'text-white'}`}>{linkify(children)}</strong>
        ),
        em: ({ children }) => <em className="italic">{linkify(children)}</em>,
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className={`underline underline-offset-2 ${isLight ? 'text-[#0969da]' : 'text-[#79c0ff]'}`}
          >
            {children}
          </a>
        ),
        blockquote: ({ children }) => (
          <blockquote
            className={`border-l-2 pl-3 my-2 italic ${
              isLight ? 'border-[#d0d7de] text-[#57606a]' : 'border-gray-700 text-gray-400'
            }`}
          >
            {children}
          </blockquote>
        ),
        code: ({ className, children, ...props }) => {
          const match = /language-(\w+)/.exec(className || '');
          const inline = !className;
          if (inline) {
            // Linkify file paths inside inline code too — agents overwhelmingly
            // wrap paths in backticks (`src/main/foo.ts`), so without this the
            // path-link feature almost never fires. Fenced code blocks (below)
            // are intentionally left untouched.
            return (
              <code
                className={`px-1 py-[1px] rounded text-[12px] font-mono ${
                  isLight ? 'bg-[#eaeef2] text-[#cf222e]' : 'bg-[#161b22] text-[#ff7b72]'
                }`}
                {...props}
              >
                {linkify(children)}
              </code>
            );
          }
          return (
            <div
              className={`my-2 rounded-md border overflow-hidden ${
                isLight ? 'border-[#d0d7de] bg-[#f6f8fa]' : 'border-gray-800 bg-[#0d1117]'
              }`}
            >
              <SyntaxHighlighter
                language={match?.[1] || 'text'}
                style={isLight ? vs : vscDarkPlus}
                customStyle={{
                  margin: 0,
                  padding: '0.625rem 0.75rem',
                  background: 'transparent',
                  fontSize: '12px',
                  lineHeight: '1.5',
                  // Long lines scroll inside the code block, never the chat pane.
                  overflowX: 'auto',
                  maxWidth: '100%',
                }}
              >
                {String(children).replace(/\n$/, '')}
              </SyntaxHighlighter>
            </div>
          );
        },
        table: ({ children }) => (
          <div className="overflow-x-auto my-2">
            <table
              className={`text-[12px] border-collapse ${
                isLight ? 'border border-[#d0d7de]' : 'border border-gray-800'
              }`}
            >
              {children}
            </table>
          </div>
        ),
        th: ({ children }) => (
          <th
            className={`px-2 py-1 text-left font-semibold ${
              isLight ? 'bg-[#f6f8fa] border border-[#d0d7de]' : 'bg-[#161b22] border border-gray-800'
            }`}
          >
            {linkify(children)}
          </th>
        ),
        td: ({ children }) => (
          <td
            className={`px-2 py-1 ${isLight ? 'border border-[#d0d7de]' : 'border border-gray-800'}`}
          >
            {linkify(children)}
          </td>
        ),
        hr: () => <hr className={isLight ? 'border-[#d0d7de] my-3' : 'border-gray-800 my-3'} />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
