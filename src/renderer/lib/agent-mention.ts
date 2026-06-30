import type { Agent } from '../../shared/types';

// Single source of truth for the inline "@"-mention wire token.
//
// The token shows the human-readable title but embeds the agent's FULL id so a
// recipient resolves it unambiguously (no 6-char-prefix collisions). The title
// is JSON-escaped via JSON.stringify so quotes / backslashes / newlines survive
// a future parser. Agent.title is typed `string`, so JSON.stringify always
// returns a string here (it only returns undefined for undefined/function
// inputs) — no need to guard the return.
export function formatAgentToken(agent: Pick<Agent, 'id' | 'title'>): string {
  return `[dashboard agent ${JSON.stringify(agent.title)} #${agent.id}]`;
}

export interface MentionContext {
  query: string;
  atIndex: number;
}

// Detect an in-progress "@" mention ending at the caret. Returns the query text
// (the run between '@' and the caret) plus the index of the '@', or null if the
// caret is not inside a fresh mention.
//
// Rules (plan Slice A):
//  - Scan left from caret-1 to the first whitespace or string start; that
//    contiguous non-whitespace run is the candidate.
//  - Trigger only if the run starts with '@'. Because the scan stops at
//    whitespace/start, the char before '@' is implicitly whitespace or
//    string-start — which suppresses emails like `a@b`.
//  - query = text between '@' and the caret. Return null if the query contains
//    whitespace (the mention has ended) or any '[' / ']' (the caret sits inside
//    an already-inserted token).
//  - No Markdown / backtick handling (deferred — plan decision 5).
export function detectMention(value: string, caret: number): MentionContext | null {
  if (caret < 0 || caret > value.length) return null;

  // Walk left over the non-whitespace run ending immediately before the caret.
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(value[i])) i--;
  const atIndex = i + 1;

  // Run must start with '@'. (When the char just before the caret is itself
  // whitespace, the run is empty and value[atIndex] is that whitespace / out of
  // range — either way not '@', so we correctly return null.)
  if (value[atIndex] !== '@') return null;

  const query = value.slice(atIndex + 1, caret);
  // The scan guarantees no whitespace, but keep the guard explicit per the spec.
  if (/\s/.test(query)) return null;
  if (query.includes('[') || query.includes(']')) return null;

  return { query, atIndex };
}

// Case-insensitive `title.includes(query)`, preserving the input order. An empty
// query matches everything (so `@` alone lists all candidates).
export function filterAgents(agents: Agent[], query: string): Agent[] {
  const q = query.toLowerCase();
  if (!q) return agents.slice();
  return agents.filter((a) => a.title.toLowerCase().includes(q));
}
