import { describe, expect, it } from 'vitest';
import type { PlanningReaderDocument } from '../../../shared/types';
import {
  deriveProposalCardMetadata,
  orderProposalCards,
  proposalTimelineMs,
  formatProposalDate,
} from './proposal-card-metadata';

function document(name: string, mtimeMs = 10): PlanningReaderDocument {
  return { docId: name, name, category: 'proposal', sizeBytes: 100, mtimeMs };
}

describe('proposal card metadata', () => {
  it('derives H1 title, summary, and author from proposal markdown', () => {
    const card = deriveProposalCardMetadata(document('2026-08-01-example.md'), `---
title: Frontmatter title
summary: "A short human-readable summary."
author: Edward
---
# Heading wins

Body paragraph.
`);

    expect(card).toMatchObject({
      title: 'Heading wins',
      description: 'A short human-readable summary.',
      author: 'Edward',
      dateLabel: 'Aug 1, 2026',
    });
  });

  it('accepts creator as author and falls back to mtime for an undated filename', () => {
    const mtime = Date.UTC(2026, 6, 4);
    const card = deriveProposalCardMetadata(document('idea.md', mtime), `---\ncreator: Ada\n---\n# Idea`);
    expect(card.author).toBe('Ada');
    expect(card.dateLabel).toBe('Jul 4, 2026');
    expect(formatProposalDate('idea.md', mtime)).toBe('Jul 4, 2026');
  });

  it('falls back to the first body paragraph and omits a missing author', () => {
    const card = deriveProposalCardMetadata(document('2026-08-01-clean-fallback.md'), `# Clean fallback

This is the **first** paragraph with a [useful link](https://example.com).

Later text.
`);

    expect(card.description).toBe('This is the first paragraph with a useful link.');
    expect(card.author).toBeNull();
  });

  it('truncates descriptions at a readable word boundary', () => {
    const paragraph = Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ');
    const card = deriveProposalCardMetadata(document('plain.md'), `# Long\n\n${paragraph}`);
    expect(card.description.length).toBeLessThanOrEqual(181);
    expect(card.description).toMatch(/…$/);
    expect(card.description).not.toMatch(/word\d…$/);
  });
});

describe('proposal timeline ordering', () => {
  it('uses filename dates first and falls back to mtime for undated names', () => {
    const oldDated = deriveProposalCardMetadata(document('2026-07-01-old.md', 999), '# Old');
    const newDated = deriveProposalCardMetadata(document('2026-08-03-new.md', 1), '# New');
    const undated = deriveProposalCardMetadata(document('notes.md', Date.UTC(2026, 7, 2)), '# Notes');

    expect(proposalTimelineMs('notes.md', 42)).toBe(42);
    expect(orderProposalCards([oldDated, newDated, undated]).map((card) => card.title))
      .toEqual(['New', 'Notes', 'Old']);
  });
});
