// Shared types for the select-text → "Send to agent" primitive.
// See plans/selection-to-agent-primitive-plan.md §2.

export type SelectionTargetType = 'file' | 'chat-message' | 'note';

export interface SelectionContext {
  targetType: SelectionTargetType;
  workspaceId: string;
  // Human line for the prompt, e.g. the file path or `agent chat with "Builder"`.
  sourceLabel: string;
  quotedText: string;
  file?: { filePath: string; lineStart?: number; lineEnd?: number };
  chat?: { agentId: string; agentName: string };
  note?: { notePath: string };
  // Present when the selection was made inside a PRIOR (out-of-context) chat
  // session; carried through to buildQuotedPrompt so the Source: line names the
  // originating session. `sessionId` disambiguates same-generation /clear siblings.
  priorSession?: { generation: number; sessionId: string };
  // Persist/comment available on this surface (no surface sets it in slice 1).
  capabilities: { comment: boolean };
}

// What the agent picker emits when the user chooses a destination.
export type SelectionAgentTarget =
  | { kind: 'new' }
  | { kind: 'existing'; agentId: string };

// One quote+comment pair for the prompt builder. Slice 1 sends a single
// comment-less item; slice 2's "send all" passes several.
export interface QuoteItem {
  quote: string;
  comment?: string;
}
