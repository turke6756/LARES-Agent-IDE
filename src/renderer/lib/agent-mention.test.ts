import { describe, it, expect } from 'vitest';
import { formatAgentToken, detectMention, filterAgents } from './agent-mention';
import type { Agent } from '../../shared/types';

// Minimal Agent factory — only the fields these pure helpers read.
function agent(partial: Partial<Agent> & { id: string; title: string }): Agent {
  return {
    workspaceId: 'ws',
    status: 'idle',
    ...partial,
  } as Agent;
}

describe('formatAgentToken', () => {
  it('embeds the FULL id (not a 6-char prefix) and JSON-escapes the title', () => {
    expect(formatAgentToken({ id: 'abc-123', title: 'Re"v' })).toBe(
      '[dashboard agent "Re\\"v" #abc-123]',
    );
  });

  it('keeps the full id for a long uuid', () => {
    const id = '01234567-89ab-cdef-0123-456789abcdef';
    expect(formatAgentToken({ id, title: 'Worker' })).toBe(
      `[dashboard agent "Worker" #${id}]`,
    );
  });

  it('escapes backslashes and newlines in the title', () => {
    expect(formatAgentToken({ id: 'x', title: 'a\\b\nc' })).toBe(
      '[dashboard agent "a\\\\b\\nc" #x]',
    );
  });
});

describe('detectMention', () => {
  it('returns query + atIndex for a mention after whitespace', () => {
    expect(detectMention('hi @res', 7)).toEqual({ query: 'res', atIndex: 3 });
  });

  it('returns an empty query for a bare "@" at string start', () => {
    expect(detectMention('@', 1)).toEqual({ query: '', atIndex: 0 });
  });

  it('suppresses emails — "@" not at start/after-whitespace', () => {
    expect(detectMention('a@b', 3)).toBeNull();
  });

  it('returns null once the mention ends with a trailing space', () => {
    expect(detectMention('@res ', 5)).toBeNull();
  });

  it('returns null when the query contains a "]" (caret inside a token)', () => {
    expect(detectMention('@foo]', 5)).toBeNull();
  });

  it('returns null when the query contains a "[" (caret inside a token)', () => {
    expect(detectMention('@foo[', 5)).toBeNull();
  });

  it('detects a mention mid-string with the caret partway through the query', () => {
    // "hello @wo|rker" — caret after "@wo"
    expect(detectMention('hello @worker', 9)).toEqual({ query: 'wo', atIndex: 6 });
  });

  it('triggers when "@" follows a newline (whitespace boundary)', () => {
    expect(detectMention('line1\n@res', 10)).toEqual({ query: 'res', atIndex: 6 });
  });

  it('returns null when the caret sits on whitespace right after a word', () => {
    expect(detectMention('hello ', 6)).toBeNull();
  });

  it('handles only the run ending at the caret, ignoring earlier text', () => {
    // Two mentions; caret in the second.
    expect(detectMention('@a done @bc', 11)).toEqual({ query: 'bc', atIndex: 8 });
  });

  it('returns null for out-of-range carets', () => {
    expect(detectMention('@x', -1)).toBeNull();
    expect(detectMention('@x', 99)).toBeNull();
  });
});

describe('filterAgents', () => {
  const agents = [
    agent({ id: '1', title: 'Researcher' }),
    agent({ id: '2', title: 'Supervisor' }),
    agent({ id: '3', title: 'researcher-2' }),
  ];

  it('matches case-insensitively on title.includes and preserves order', () => {
    const out = filterAgents(agents, 'res');
    expect(out.map((a) => a.id)).toEqual(['1', '3']);
  });

  it('returns all agents (a copy) for an empty query', () => {
    const out = filterAgents(agents, '');
    expect(out).toHaveLength(3);
    expect(out).not.toBe(agents);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterAgents(agents, 'zzz')).toEqual([]);
  });
});
