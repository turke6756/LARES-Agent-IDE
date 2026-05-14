import { useCallback, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useThemeStore } from '../../stores/theme-store';
import CollapseButton from '../layout/CollapseButton';

interface Props {
  content: string;
}

interface MarkdownHeading {
  id: string;
  level: number;
  text: string;
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function slugifyHeading(value: string, index: number): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `md-heading-${index}-${slug || 'section'}`;
}

function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let inFence = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (/^ {0,3}(```+|~~~+)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;

    const text = stripInlineMarkdown(match[2]);
    if (!text) continue;

    headings.push({
      id: slugifyHeading(text, headings.length),
      level: match[1].length,
      text,
    });
  }

  return headings;
}

export default function MarkdownRenderer({ content }: Props) {
  const theme = useThemeStore((s) => s.theme);
  const isLight = theme === 'light';
  const outline = useMemo(() => extractMarkdownHeadings(content), [content]);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  let renderedHeadingIndex = 0;

  const scrollToHeading = useCallback((headingId: string) => {
    const target = scrollRef.current?.querySelector<HTMLElement>(`#${CSS.escape(headingId)}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const nextHeadingId = () => {
    const id = outline[renderedHeadingIndex]?.id;
    renderedHeadingIndex += 1;
    return id;
  };

  const hasOutline = outline.length > 0;

  return (
    <div className="h-full min-w-0 flex bg-surface-0">
      <div ref={scrollRef} className="flex-1 min-w-0 overflow-auto p-6">
        <div className="max-w-3xl mx-auto prose-custom">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => (
              <h1 id={nextHeadingId()} className="scroll-mt-6 text-2xl font-bold font-sans text-gray-50 mb-4 mt-6 pb-2 border-b border-accent-blue/30">
                {children}
              </h1>
            ),
            h2: ({ children }) => (
              <h2 id={nextHeadingId()} className="scroll-mt-6 text-xl font-bold font-sans text-gray-50 mb-3 mt-5 pb-1 border-b dark:border-white/10 light:border-black/10">
                {children}
              </h2>
            ),
            h3: ({ children }) => (
              <h3 id={nextHeadingId()} className="scroll-mt-6 text-lg font-bold font-sans text-gray-200 mb-2 mt-4">{children}</h3>
            ),
            h4: ({ children }) => (
              <h4 id={nextHeadingId()} className="scroll-mt-6 text-base font-bold font-sans text-gray-300 mb-2 mt-3">{children}</h4>
            ),
            h5: ({ children }) => (
              <h5 id={nextHeadingId()} className="scroll-mt-6 text-sm font-bold font-sans text-gray-300 mb-2 mt-3">{children}</h5>
            ),
            h6: ({ children }) => (
              <h6 id={nextHeadingId()} className="scroll-mt-6 text-[13px] font-bold font-sans text-gray-400 mb-2 mt-3">{children}</h6>
            ),
            p: ({ children }) => (
              <p className="text-gray-300 mb-3 leading-relaxed text-sm">{children}</p>
            ),
            a: ({ href, children }) => (
              <a href={href} className="text-accent-blue hover:text-accent-blue/80 underline underline-offset-2">
                {children}
              </a>
            ),
            ul: ({ children }) => (
              <ul className="list-disc list-inside mb-3 text-gray-300 text-sm space-y-1">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="list-decimal list-inside mb-3 text-gray-300 text-sm space-y-1">{children}</ol>
            ),
            li: ({ children }) => <li className="text-gray-300">{children}</li>,
            blockquote: ({ children }) => (
              <blockquote className="border-l-2 border-accent-blue/50 pl-4 my-3 text-gray-400 italic">
                {children}
              </blockquote>
            ),
            table: ({ children }) => (
              <div className="overflow-x-auto mb-3">
                <table className="w-full text-sm border border-accent-blue/20">{children}</table>
              </div>
            ),
            thead: ({ children }) => (
              <thead className="bg-surface-2 text-gray-300 font-sans text-[13px]  ">
                {children}
              </thead>
            ),
            th: ({ children }) => (
              <th className="px-3 py-2 text-left border-b dark:border-white/10 light:border-black/10">{children}</th>
            ),
            td: ({ children }) => (
              <td className="px-3 py-2 text-gray-400 border-b border-surface-2">{children}</td>
            ),
            hr: () => <hr className="border-accent-blue/20 my-6" />,
            code: ({ className, children, ...props }) => {
              const match = /language-(\w+)/.exec(className || '');
              const inline = !className;
              if (inline) {
                return (
                  <code className={`px-1.5 py-0.5 rounded text-[13px] font-sans ${isLight ? 'bg-[#e5e7eb] text-[#ab3f11]' : 'bg-surface-2 text-accent-orange'}`}>
                    {children}
                  </code>
                );
              }
              return (
                <div className={`my-3 rounded border overflow-hidden ${isLight ? 'border-gray-300 bg-[#f3f4f6]' : 'border-surface-2 bg-[rgba(0,0,0,0.3)]'}`}>
                  <SyntaxHighlighter
                    language={match?.[1] || 'text'}
                    style={isLight ? vs : vscDarkPlus}
                    customStyle={{
                      margin: 0,
                      padding: '1rem',
                      background: 'transparent',
                      fontSize: '0.8125rem',
                    }}
                  >
                    {String(children).replace(/\n$/, '')}
                  </SyntaxHighlighter>
                </div>
              );
            },
          }}
        >
          {content}
        </ReactMarkdown>
        </div>
      </div>
      {hasOutline && (
        outlineCollapsed ? (
          <div className="shrink-0 bg-surface-0/40 border-l dark:border-white/10 light:border-black/10 flex flex-col items-center py-2" style={{ width: 32 }}>
            <CollapseButton collapsed direction="right" onClick={() => setOutlineCollapsed(false)} />
            <div className="mt-2 text-[13px] font-sans text-gray-400" style={{ writingMode: 'vertical-rl' }}>
              Outline
            </div>
          </div>
        ) : (
          <aside className="shrink-0 w-60 max-w-[34%] bg-surface-0/40 border-l dark:border-white/10 light:border-black/10 overflow-hidden flex flex-col">
            <div className="h-8 px-2 flex items-center justify-between border-b dark:border-white/10 light:border-black/10">
              <span className="text-[11px] uppercase tracking-[0.1em] font-semibold text-gray-400">Outline</span>
              <CollapseButton collapsed={false} direction="right" onClick={() => setOutlineCollapsed(true)} />
            </div>
            <div className="flex-1 min-h-0 overflow-auto py-1">
              {outline.map((heading) => (
                <button
                  key={heading.id}
                  onClick={() => scrollToHeading(heading.id)}
                  className="w-full text-left flex items-center py-[4px] pr-2 text-[12px] font-sans text-gray-400 hover:text-gray-100 hover:bg-white/[0.06] transition-colors"
                  style={{ paddingLeft: `${Math.max(heading.level - 1, 0) * 10 + 8}px` }}
                  title={heading.text}
                >
                  <span className="truncate">{heading.text}</span>
                </button>
              ))}
            </div>
          </aside>
        )
      )}
    </div>
  );
}
