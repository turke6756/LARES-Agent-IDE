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
  it('derives H1 title, summary, and a partial declared byline from proposal markdown', () => {
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
      declaredAuthor: {
        title: 'Edward',
        role: null,
        agentId: null,
        provider: null,
        dateLabel: null,
      },
      witnessedAuthor: null,
      authorshipMismatch: false,
      artifactId: null,
      promotedTo: null,
      promotedAt: null,
      dateLabel: 'Aug 1, 2026',
    });
  });

  it('carries fixture-stamped promotion metadata without depending on the promote path', () => {
    const card = deriveProposalCardMetadata(document('2026-08-05-promoted.md'), `---
artifact_id: prop_0e1425af
author: Planning supervisor
promoted_to: 2026-08-05-split-the-proposal-lifecycle-an-authoring-skill--0e1425af
promoted_at: 2026-08-05
---
# Promoted proposal

History remains discoverable.
`);

    expect(card).toMatchObject({
      declaredAuthor: expect.objectContaining({ title: 'Planning supervisor' }),
      artifactId: 'prop_0e1425af',
      promotedTo: '2026-08-05-split-the-proposal-lifecycle-an-authoring-skill--0e1425af',
      promotedAt: '2026-08-05',
    });
  });

  it('returns null when artifact_id is absent', () => {
    const card = deriveProposalCardMetadata(document('2026-08-05-unstamped.md'), '# Unstamped');
    expect(card.artifactId).toBeNull();
  });

  it('accepts creator as author and falls back to mtime for an undated filename', () => {
    const mtime = Date.UTC(2026, 6, 4);
    const card = deriveProposalCardMetadata(document('idea.md', mtime), `---\ncreator: Ada\n---\n# Idea`);
    expect(card.declaredAuthor?.title).toBe('Ada');
    expect(card.dateLabel).toBe('Jul 4, 2026');
    expect(formatProposalDate('idea.md', mtime)).toBe('Jul 4, 2026');
  });

  it('falls back to the first body paragraph and omits a missing author', () => {
    const card = deriveProposalCardMetadata(document('2026-08-01-clean-fallback.md'), `# Clean fallback

This is the **first** paragraph with a [useful link](https://example.com).

Later text.
`);

    expect(card.description).toBe('This is the first paragraph with a useful link.');
    expect(card.declaredAuthor).toBeNull();
  });

  it('keeps the specific self-declared and witnessed registers separate', () => {
    const card = deriveProposalCardMetadata(document('2026-08-05-authored.md'), `---
author: "Save Card Execution" (supervisor, AgentDashboard)
author_agent_id: f57ca63c-1111-2222-3333-444444444444
author_role: supervisor
author_provider: claude
authored_at: 2026-08-05T23:55:00Z
---
# Authored
`, false, {
      role: 'worker',
      display: 'P6 mission-board worker',
      agentId: 'abcd1234-1111-2222-3333-444444444444',
    });

    expect(card.declaredAuthor).toEqual({
      title: 'Save Card Execution',
      role: 'supervisor',
      agentId: 'f57ca63c-1111-2222-3333-444444444444',
      provider: 'claude',
      dateLabel: 'Aug 5, 2026',
    });
    expect(card.witnessedAuthor).toEqual({
      role: 'worker',
      display: 'P6 mission-board worker',
      agentId: 'abcd1234-1111-2222-3333-444444444444',
    });
    expect(card.authorshipMismatch).toBe(true);
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
