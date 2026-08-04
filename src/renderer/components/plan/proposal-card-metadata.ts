import type { PlanningReaderDocument } from '../../../shared/types';

export interface ProposalCardMetadata {
  docId: string;
  fileName: string;
  title: string;
  description: string;
  author: string | null;
  content: string;
  truncated: boolean;
  mtimeMs: number;
  timelineMs: number;
}

const DESCRIPTION_LIMIT = 180;

function parseFrontmatter(markdown: string): { fields: Record<string, string>; body: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(markdown);
  if (!match) return { fields: {}, body: markdown };

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    let value = pair[2].trim().replace(/\s+#.*$/, '').trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    fields[pair[1].toLowerCase()] = value;
  }
  return { fields, body: markdown.slice(match[0].length) };
}

function plainText(markdown: string): string {
  return markdown
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncateDescription(value: string, limit = DESCRIPTION_LIMIT): string {
  const clean = plainText(value);
  if (clean.length <= limit) return clean;
  const candidate = clean.slice(0, limit + 1);
  const wordBoundary = candidate.lastIndexOf(' ');
  const cut = wordBoundary >= Math.floor(limit * 0.6) ? wordBoundary : limit;
  return `${candidate.slice(0, cut).replace(/[\s,;:.-]+$/, '')}…`;
}

function firstBodyParagraph(body: string): string {
  const withoutFences = body.replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm, '');
  for (const block of withoutFences.split(/\r?\n\s*\r?\n/)) {
    const trimmed = block.trim();
    if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^<!--[\s\S]*-->$/.test(trimmed)) continue;
    const clean = plainText(trimmed.replace(/^>\s?/gm, '').replace(/^[-*+]\s+/gm, ''));
    if (clean) return clean;
  }
  return '';
}

function fallbackTitle(fileName: string): string {
  return fileName
    .replace(/\.md$/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function proposalTimelineMs(fileName: string, mtimeMs: number): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:-|$)/.exec(fileName);
  if (!match) return mtimeMs;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(timestamp) ? mtimeMs : timestamp;
}

export function deriveProposalCardMetadata(
  document: PlanningReaderDocument,
  content: string,
  truncated = false,
): ProposalCardMetadata {
  const { fields, body } = parseFrontmatter(content);
  const heading = /^ {0,3}#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1];
  const title = plainText(heading ?? fields.title ?? '') || fallbackTitle(document.name);
  const descriptionSource = fields.summary || firstBodyParagraph(body);

  return {
    docId: document.docId,
    fileName: document.name,
    title,
    description: truncateDescription(descriptionSource) || 'No description provided.',
    author: fields.author?.trim() || null,
    content,
    truncated,
    mtimeMs: document.mtimeMs,
    timelineMs: proposalTimelineMs(document.name, document.mtimeMs),
  };
}

export function orderProposalCards(cards: ProposalCardMetadata[]): ProposalCardMetadata[] {
  return [...cards].sort((a, b) =>
    b.timelineMs - a.timelineMs
    || b.mtimeMs - a.mtimeMs
    || a.title.localeCompare(b.title),
  );
}
