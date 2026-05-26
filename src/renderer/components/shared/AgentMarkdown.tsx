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
//   C:\Users\foo\bar.txt
//   /home/user/file.py
// Trailing sentence punctuation (".", ",", ")", etc.) is naturally excluded
// because [\w.\-] doesn't include them and the regex engine backtracks the
// extension off the end.
const FILE_PATH_RE = /((?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/]|~\/)?(?:[\w.\-]+[\\/])+[\w.\-]+\.[A-Za-z0-9]{1,8})/g;

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
    const path = m[1];
    const start = m.index;
    const end = start + path.length;
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
            return (
              <code
                className={`px-1 py-[1px] rounded text-[12px] font-mono ${
                  isLight ? 'bg-[#eaeef2] text-[#cf222e]' : 'bg-[#161b22] text-[#ff7b72]'
                }`}
                {...props}
              >
                {children}
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
