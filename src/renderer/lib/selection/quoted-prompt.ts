// Builds the locked [SELECTION COMMENT] prompt format.
// plans/selection-to-agent-primitive-plan.md §4 — every surface emits this
// one format; multi-item support exists so canvas "send all" (slice 2) needs
// no second template.

import type { SelectionContext, QuoteItem } from './selection-types';

// The builder only needs the source identity, not the live quotedText —
// quotes arrive via `items` so multi-item sends don't pretend one selection.
export type QuotedPromptSource = Pick<SelectionContext, 'targetType' | 'sourceLabel'> &
  Partial<Pick<SelectionContext, 'file'>>;

const HEADER = '[SELECTION COMMENT]';

function sourceLine(ctx: QuotedPromptSource): string {
  // File surfaces pass the bare path as sourceLabel; the format shows
  // `Source: file C:\...\doc.md`. Chat/note surfaces bake their own phrasing
  // into sourceLabel (`agent chat with "Builder"`, `note "ideas.md"`).
  if (ctx.targetType === 'file') return `Source: file ${ctx.sourceLabel}`;
  return `Source: ${ctx.sourceLabel}`;
}

function linesLine(ctx: QuotedPromptSource): string | null {
  // Files only, when known; omit otherwise.
  if (ctx.targetType !== 'file' || !ctx.file) return null;
  const { lineStart, lineEnd } = ctx.file;
  if (lineStart == null) return null;
  if (lineEnd == null || lineEnd === lineStart) return `Lines: ${lineStart}`;
  return `Lines: ${lineStart}-${lineEnd}`;
}

function blockquote(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? `> ${line}` : `${indent}> ${line}`))
    .join('\n');
}

export function buildQuotedPrompt(ctx: QuotedPromptSource, items: QuoteItem[]): string {
  if (items.length === 0) {
    throw new Error('buildQuotedPrompt: items must be non-empty');
  }

  const head: string[] = [HEADER, sourceLine(ctx)];
  const lines = linesLine(ctx);
  if (lines) head.push(lines);

  // Single item, no comment → collapse: header + Source(+Lines) + bare
  // blockquote, no numbering, no parenthetical.
  if (items.length === 1 && !items[0].comment) {
    return `${head.join('\n')}\n\n${blockquote(items[0].quote, '')}`;
  }

  const rendered = items.map((item, idx) => {
    const num = `${idx + 1}) `;
    const indent = ' '.repeat(num.length);
    const quote = `${num}${blockquote(item.quote, indent)}`;
    const tail = item.comment
      ? `${indent}Comment: ${item.comment}`
      : `${indent}(no comment — act on this text directly)`;
    return `${quote}\n${tail}`;
  });

  return `${head.join('\n')}\n\n${rendered.join('\n\n')}`;
}
