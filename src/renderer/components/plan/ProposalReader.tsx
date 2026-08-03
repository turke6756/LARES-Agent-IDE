import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// WP-P1B — the read-only markdown pane on the right of the proposal/plan reader.
// Deliberately minimal and self-contained: NO edit affordances, no comment
// gutter, no selection surface, no file-open side effects. It renders whatever
// document text `ProposalReaderPane` fetched via `planning-reader:read` and does
// nothing else. Links are rendered inert (no navigation) to keep the surface
// strictly read-only for this stage — tabs/overviews/opening come in P4.

interface ProposalReaderProps {
  /** Basename of the currently-shown document (header label). */
  name: string | null;
  /** Fetched document body, or null while nothing is selected / still loading. */
  content: string | null;
  /** True when the source file exceeded main's per-file byte cap. */
  truncated?: boolean;
  /** Set when the read failed (containment / unreadable / gone). */
  error?: string | null;
  /** True while a read is in flight. */
  loading?: boolean;
}

export default function ProposalReader({
  name,
  content,
  truncated = false,
  error = null,
  loading = false,
}: ProposalReaderProps): React.ReactElement {
  return (
    <div className="flex h-full min-w-0 flex-col bg-surface-0" data-testid="proposal-reader">
      {name && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-white/10 px-3">
          <span className="truncate text-[12px] font-semibold text-gray-300" title={name}>
            {name}
          </span>
          {truncated && (
            <span
              className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent-orange"
              title="This document exceeded the read cap and was truncated"
              data-testid="proposal-reader-truncated"
            >
              truncated
            </span>
          )}
          <span className="ml-auto text-[10px] uppercase tracking-[0.1em] text-gray-500">
            read-only
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-6" data-testid="proposal-reader-body">
        {error ? (
          <div className="text-[13px] text-accent-red" data-testid="proposal-reader-error">
            {error}
          </div>
        ) : loading ? (
          <div className="text-[13px] text-gray-400">Loading…</div>
        ) : content === null ? (
          <div className="text-[13px] text-gray-500" data-testid="proposal-reader-empty">
            Select a proposal or plan to read it here.
          </div>
        ) : (
          <div className="prose-custom mx-auto max-w-3xl">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => (
                  <h1 className="mb-4 mt-6 border-b border-accent-blue/30 pb-2 text-2xl font-bold text-gray-50">
                    {children}
                  </h1>
                ),
                h2: ({ children }) => (
                  <h2 className="mb-3 mt-5 border-b border-white/10 pb-1 text-xl font-bold text-gray-50">
                    {children}
                  </h2>
                ),
                h3: ({ children }) => (
                  <h3 className="mb-2 mt-4 text-lg font-bold text-gray-200">{children}</h3>
                ),
                p: ({ children }) => (
                  <p className="mb-3 text-sm leading-relaxed text-gray-300">{children}</p>
                ),
                // Inert links — this stage is strictly read-only, so a click must
                // not navigate anywhere. `preventDefault` keeps the affordance
                // visible without opening a tab / browser pane.
                a: ({ href, children }) => (
                  <a
                    href={href}
                    onClick={(e) => e.preventDefault()}
                    className="text-accent-blue underline underline-offset-2"
                  >
                    {children}
                  </a>
                ),
                ul: ({ children }) => (
                  <ul className="mb-3 list-inside list-disc space-y-1 text-sm text-gray-300">
                    {children}
                  </ul>
                ),
                ol: ({ children }) => (
                  <ol className="mb-3 list-inside list-decimal space-y-1 text-sm text-gray-300">
                    {children}
                  </ol>
                ),
                li: ({ children }) => <li className="text-gray-300">{children}</li>,
                blockquote: ({ children }) => (
                  <blockquote className="my-3 border-l-2 border-accent-blue/50 pl-4 italic text-gray-400">
                    {children}
                  </blockquote>
                ),
                table: ({ children }) => (
                  <div className="mb-3 overflow-x-auto">
                    <table className="w-full border border-accent-blue/20 text-sm">{children}</table>
                  </div>
                ),
                th: ({ children }) => (
                  <th className="border-b border-white/10 px-3 py-2 text-left">{children}</th>
                ),
                td: ({ children }) => (
                  <td className="border-b border-surface-2 px-3 py-2 text-gray-400">{children}</td>
                ),
                hr: () => <hr className="my-6 border-accent-blue/20" />,
                code: ({ className, children }) => {
                  const inline = !className;
                  if (inline) {
                    return (
                      <code className="rounded bg-surface-2 px-1.5 py-0.5 text-[13px] text-accent-orange">
                        {children}
                      </code>
                    );
                  }
                  return (
                    <pre className="my-3 overflow-x-auto rounded border border-surface-2 bg-black/30 p-4 text-[13px] text-gray-200">
                      <code>{children}</code>
                    </pre>
                  );
                },
              }}
            >
              {content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
