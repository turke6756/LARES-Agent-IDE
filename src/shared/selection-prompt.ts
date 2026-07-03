// Canonical [SELECTION COMMENT] prompt builder, shared between processes.
// plans/selection-to-agent-primitive-plan.md §4 — every surface emits this one
// format; multi-item support exists so "send all" (slice 2) needs no second
// template.
//
// WP-P5-A: this is a byte-identical port of the slice-1 builder in
// src/renderer/lib/selection/quoted-prompt.ts, hoisted here because the
// main-process `comments:send` path builds prompts next to the DB. The
// renderer module keeps its own import path; WP-P5-B may flip it to a
// re-export of this file (renderer files are B's to edit, not A's).
// Until then any semantic change MUST land in both files.

export type SelectionPromptTargetType = 'file' | 'chat-message' | 'note';

// One quote+comment pair. A send of N persisted comments produces N items in
// a single prompt.
export interface QuoteItem {
  quote: string;
  comment?: string;
}

// The builder only needs the source identity, not a live selection — quotes
// arrive via `items` so multi-item sends don't pretend one selection.
export interface QuotedPromptSource {
  targetType: SelectionPromptTargetType;
  // Human line for the prompt, e.g. the file path or `agent chat with "Builder"`.
  sourceLabel: string;
  file?: { filePath: string; lineStart?: number; lineEnd?: number };
  // Set when the quoted text was selected from a PRIOR (out-of-context) chat
  // session so the Source: line can attribute the quote to that specific
  // session. `generation` is a display label that may repeat across a `/clear`;
  // `sessionId` is the real disambiguator (shortened in the rendered line).
  priorSession?: { generation: number; sessionId: string };
}

const HEADER = '[SELECTION COMMENT]';

// Short, human-scannable slice of a session id for the Source: line — mirrors
// the divider caption in ChatPane so provenance reads consistently.
function shortSessionId(sessionId: string): string {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

function sourceLine(ctx: QuotedPromptSource): string {
  // File surfaces pass the bare path as sourceLabel; the format shows
  // `Source: file C:\...\doc.md`. Chat/note surfaces bake their own phrasing
  // into sourceLabel (`agent chat with "Builder"`, `note "ideas.md"`).
  if (ctx.targetType === 'file') return `Source: file ${ctx.sourceLabel}`;
  const base = `Source: ${ctx.sourceLabel}`;
  // A quote lifted from a prior session gets an explicit out-of-context tag so
  // the receiving (live) agent knows it is not quoting its current transcript.
  if (ctx.priorSession) {
    const { generation, sessionId } = ctx.priorSession;
    return `${base} — PREVIOUS SESSION (gen ${generation}, session ${shortSessionId(sessionId)}, not in current context)`;
  }
  return base;
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
