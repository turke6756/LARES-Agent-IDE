import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import type {
  SessionEvent,
  ChatEventBatch,
  ToolUseEvent,
  ToolResultEvent,
} from '../../../shared/session-events';
import type { AgentStatus, AgentSessionRow } from '../../../shared/types';
import { Copy, Check, Send } from 'lucide-react';
import { useThemeStore } from '../../stores/theme-store';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useSelectionActions } from '../../lib/selection/useSelectionActions';
import { sendSelectionToAgent } from '../../lib/selection/selection-dispatch';
import { showSelectionToast } from '../../lib/selection/selection-toast';
import { findQuoteInDom } from '../../lib/selection/comment-anchors';
import AgentMarkdown from '../shared/AgentMarkdown';
import ChatInputBar from './ChatInputBar';
import PromptStaging from './PromptStaging';
import ToolBlock from './chat/blocks/ToolBlock';
import ContextUsageBar from './chat/ContextUsageBar';
import WatchGlass from './WatchGlass';

// A staged comment: a quote pulled from the transcript plus the note the user
// typed. These accumulate in-memory (per pane) until the airplane sends the
// whole batch to the current agent as one message. prefix/suffix are the ~32
// chars either side of the quote at capture time — used to re-locate the exact
// DOM range for the highlight + blue-dot decoration after re-renders.
interface StagedComment {
  id: string;
  quote: string;
  comment: string;
  prefix: string;
  suffix: string;
  // Provenance if this quote came from a prior (out-of-context) session.
  priorSession?: { generation: number; sessionId: string };
}

interface Props {
  agentId: string;
  agentStatus: AgentStatus;
  agentName?: string;
  stagingOpen?: boolean;
  watchGlass?: boolean;
}

// Per-agent chat scroll memory (module-level, in-memory) so switching away from
// an agent's chat — a workspace change, a detail-pane toggle — and coming back
// restores the exact scroll spot instead of snapping to the bottom. We remember
// distance-from-bottom (not raw scrollTop) plus a "pinned to bottom" flag, the
// same invariant the prepend-anchor uses: messages hydrate async so total height
// isn't known at mount, but anchoring to the bottom survives that height change.
const chatScrollMemory = new Map<string, { distanceFromBottom: number; nearBottom: boolean }>();

function captureChatScroll(agentId: string, el: HTMLDivElement) {
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  chatScrollMemory.set(agentId, { distanceFromBottom, nearBottom: distanceFromBottom < 80 });
}

// Per-session out-of-context stamp. A RenderItem drawn from a PRIOR session
// carries `outOfContext` + its session identity so bubbles can dim/accent and so
// (Phase 3) a selection can attribute its Source: line to the specific prior
// session. Identity is per-SESSION (`sessionId`) — `generation` is a label that
// may repeat across a `/clear`, never a disambiguator.
interface OutOfContextStamp {
  outOfContext?: boolean;
  session?: { sessionRowId: number; sessionId: string; generation: number };
}

type RenderItem =
  | ({ kind: 'user'; uuid: string; text: string } & OutOfContextStamp)
  | ({ kind: 'assistant'; uuid: string; text: string } & OutOfContextStamp)
  | ({ kind: 'thinking'; uuid: string; text: string } & OutOfContextStamp)
  | ({
      kind: 'tool';
      uuid: string;
      toolUseId: string;
      toolName: string;
      input: unknown;
      result?: { content: string; truncated: boolean; isError?: boolean };
    } & OutOfContextStamp)
  | ({ kind: 'system'; uuid: string; text: string } & OutOfContextStamp)
  // A dashboard notification injected into a supervisor's terminal. Claude Code
  // records it in the session JSONL as an ordinary `user` message, so the only
  // signal left by the time the renderer sees it is the text prefix.
  | ({ kind: 'dashboard-event'; uuid: string; text: string; label: string; agentName?: string } & OutOfContextStamp)
  // A session-labeled divider drawn above each loaded prior session. Labeled
  // with SESSION identity, never `gen N` alone (generations repeat across /clear).
  | { kind: 'divider'; uuid: string; sessionRowId: number; sessionId: string; generation: number; unavailable?: boolean };

// The content (non-divider) items — what pairEvents produces and what a prior
// session gets stamped out-of-context. Dividers are synthesized only when
// assembling the combined list.
type ChatContentItem = Exclude<RenderItem, { kind: 'divider' }>;

// A single loaded prior session: its identity + paired render items (empty when
// the JSONL was pruned, in which case `unavailable` drives the divider caption).
interface PriorSessionBlock {
  meta: { sessionRowId: number; sessionId: string; generation: number };
  items: ChatContentItem[];
  unavailable?: boolean;
}

// Cache wrapped result objects so identity is stable across pairEvents calls — without this,
// React.memo on ToolBlock is mostly cosmetic because `result` would be a fresh literal each render.
const resultWrappers = new WeakMap<ToolResultEvent, { content: string; truncated: boolean; isError?: boolean }>();
function wrapResult(res: ToolResultEvent) {
  let w = resultWrappers.get(res);
  if (!w) {
    w = { content: res.content, truncated: res.truncated, isError: res.isError };
    resultWrappers.set(res, w);
  }
  return w;
}

export const DASHBOARD_EVENT_PREFIX = '[DASHBOARD EVENT]';

export interface DashboardEventHeader {
  /** First line with the `[DASHBOARD EVENT] ` prefix stripped, e.g. "Agent status changed". */
  label: string;
  /** Quoted title from the `Agent: "<title>" (<id>)` second line, when present. */
  agentName?: string;
}

/**
 * Classify + parse a dashboard notification out of a raw `user-text` payload.
 * Returns null for anything a human actually typed.
 *
 * Prefix-sniffing is the only signal available: the supervisor's notifications
 * are injected as terminal text and land in the JSONL indistinguishable from a
 * human turn (payload shapes live in
 * src/main/supervisor/event-payload-builder.ts). Parsing is deliberately
 * defensive — orchestration payloads (src/main/orchestration/service.ts) carry
 * NO `Agent:` line, so the agent name is optional and we never render a
 * placeholder for it.
 */
export function parseDashboardEvent(text: string): DashboardEventHeader | null {
  const body = text.trimStart();
  if (!body.startsWith(DASHBOARD_EVENT_PREFIX)) return null;
  const lines = body.split('\n');
  const label = lines[0].slice(DASHBOARD_EVENT_PREFIX.length).trim() || 'Dashboard event';
  // Greedy inner group so a title containing quotes still ends at the ` (<id>)`.
  const match = lines[1]?.match(/^Agent:\s*"(.*)"\s*\([^)]*\)\s*$/);
  const agentName = match && match[1].trim().length > 0 ? match[1] : undefined;
  return { label, agentName };
}

/**
 * Pair tool-use ↔ tool-result by `toolUseId`, then flatten into a render list.
 * Usage events are consumed by ContextUsageBar and dropped from the list.
 */
function pairEvents(events: SessionEvent[]): ChatContentItem[] {
  // Map tool_use_id -> result
  const resultById = new Map<string, ToolResultEvent>();
  for (const e of events) {
    if (e.type === 'tool-result' && e.toolUseId) {
      resultById.set(e.toolUseId, e);
    }
  }

  const consumedResults = new Set<string>();
  const items: ChatContentItem[] = [];

  for (const e of events) {
    switch (e.type) {
      case 'user-text': {
        // Dashboard notifications arrive as `user` turns but are not human
        // messages — split them out so they render as telemetry.
        const dashboardEvent = parseDashboardEvent(e.text);
        items.push(
          dashboardEvent
            ? { kind: 'dashboard-event', uuid: e.uuid, text: e.text, ...dashboardEvent }
            : { kind: 'user', uuid: e.uuid, text: e.text },
        );
        break;
      }
      case 'assistant-text':
        items.push({ kind: 'assistant', uuid: e.uuid, text: e.text });
        break;
      case 'thinking':
        items.push({ kind: 'thinking', uuid: e.uuid, text: e.text });
        break;
      case 'tool-use': {
        const res = e.toolUseId ? resultById.get(e.toolUseId) : undefined;
        if (res) consumedResults.add(res.uuid);
        items.push({
          kind: 'tool',
          uuid: e.uuid,
          toolUseId: e.toolUseId,
          toolName: (e as ToolUseEvent).toolName,
          input: (e as ToolUseEvent).input,
          result: res ? wrapResult(res) : undefined,
        });
        break;
      }
      case 'tool-result':
        // If this result was not paired with any tool_use (orphan), surface it as a system note.
        if (!consumedResults.has(e.uuid)) {
          items.push({
            kind: 'tool',
            uuid: e.uuid,
            toolUseId: e.toolUseId,
            toolName: 'Result',
            input: undefined,
            result: wrapResult(e),
          });
        }
        break;
      case 'system-init':
        items.push({ kind: 'system', uuid: e.uuid, text: `Session started · ${e.model}` });
        break;
      case 'usage':
        // consumed by ContextUsageBar
        break;
    }
  }

  return items;
}

function SenderLabel({ name, color, align }: { name: string; color: string; align: 'left' | 'right' }) {
  return (
    <div
      className={`text-[10px] font-semibold uppercase tracking-[0.12em] mb-1 ${align === 'right' ? 'text-right' : 'text-left'}`}
      style={{ color }}
    >
      {name}
    </div>
  );
}

const UserBubble = React.memo(function UserBubble({ text }: { text: string }) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  return (
    <div className="flex flex-col items-end my-3">
      <SenderLabel name="You" color={isLight ? '#005e9e' : '#79c0ff'} align="right" />
      <div
        className={`max-w-[88%] px-3 py-2 rounded-2xl rounded-tr-sm whitespace-pre-wrap break-words text-[13px] leading-[1.55] select-text cursor-text ${
          isLight
            ? 'bg-[#d5e7fa] text-[#16395c] shadow-[0_1px_2px_rgba(72,60,38,0.10)]'
            : 'bg-[#1f6feb] text-white shadow-[0_1px_2px_rgba(0,0,0,0.3)]'
        }`}
      >
        {text}
      </div>
    </div>
  );
});

// Hover-revealed clean-text copy button. Copies the raw markdown source (what
// the model actually emitted), not the rendered DOM, so it survives paste as
// clean text.
function CopyButton({ text, isLight }: { text: string; isLight: boolean }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  const onCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1200);
    });
  }, [text]);
  return (
    <button
      onClick={onCopy}
      title={copied ? 'Copied' : 'Copy message as clean text'}
      aria-label="Copy message"
      className={`rounded p-1 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity ${
        isLight
          ? 'bg-white/90 text-[#57606a] hover:bg-[#eaeef2] border border-[#d0d7de]'
          : 'bg-[#0d1117]/80 text-gray-400 hover:text-gray-200 hover:bg-[#0d1117] border border-gray-700/60'
      }`}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

// Appears next to the copy icon only once ≥1 comment is staged in this pane.
// It is the sole way to send staged comments, and always sends the whole
// batch to the current agent. The badge shows how many are queued.
function SendStagedButton({
  count,
  agentName,
  onSend,
}: {
  count: number;
  agentName: string;
  onSend: () => void;
}) {
  return (
    <button
      onClick={onSend}
      title={`Send ${count} staged comment${count === 1 ? '' : 's'} to "${agentName}"`}
      aria-label="Send staged comments"
      className="relative rounded p-1 bg-[#1f6feb] text-white hover:bg-[#2a7bff] transition-colors"
    >
      <Send size={13} />
      {count > 1 && (
        <span className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-[3px] rounded-full bg-red-500 text-white text-[9px] font-semibold leading-[15px] text-center">
          {count}
        </span>
      )}
    </button>
  );
}

const AssistantBubble = React.memo(function AssistantBubble({
  text,
  agentName,
  agentId,
  stagedCount = 0,
  onSendStaged,
}: {
  text: string;
  agentName: string;
  agentId: string;
  stagedCount?: number;
  onSendStaged?: () => void;
}) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  return (
    <div className="group flex flex-col items-start my-3 w-full">
      <SenderLabel name={agentName} color={isLight ? '#6639ba' : '#c586c0'} align="left" />
      <div
        className={`relative max-w-full px-3 py-2 rounded-2xl rounded-tl-sm select-text cursor-text ${
          isLight
            ? 'bg-white border border-[#d0d7de] shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
            : 'bg-[#1a1d23] border border-gray-800/60'
        }`}
        style={{ width: '100%' }}
      >
        <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
          {stagedCount > 0 && onSendStaged && (
            <SendStagedButton count={stagedCount} agentName={agentName} onSend={onSendStaged} />
          )}
          <CopyButton text={text} isLight={isLight} />
        </div>
        <AgentMarkdown content={text} agentId={agentId} />
      </div>
    </div>
  );
});

const ThinkingNote = React.memo(function ThinkingNote({ text }: { text: string }) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  return (
    <div
      className={`my-1.5 flex items-start gap-1.5 text-[11px] italic select-text cursor-text ${
        isLight ? 'text-[#6639ba]/80' : 'text-purple-300/70'
      }`}
    >
      <span className="text-[10px] mt-[2px] select-none">✻</span>
      <span className="whitespace-pre-wrap break-words min-w-0">{text}</span>
    </div>
  );
});

const SystemNote = React.memo(function SystemNote({ text }: { text: string }) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  return (
    <div className={`my-1 text-[10px] font-mono whitespace-pre-wrap break-words select-text cursor-text ${isLight ? 'text-[#8b949e]' : 'text-gray-600'}`}>
      {text}
    </div>
  );
});

// A dashboard notification, rendered as collapsed telemetry rather than as a
// human turn. The summary row is a real <button> (keyboard-accessible, with a
// chevron affordance); expanding reveals the raw payload verbatim — never
// through the markdown renderer, since payloads carry quotes, JSON and log
// tails. Expansion is local state: one bubble's toggle is nobody else's
// business, so no store plumbing.
const DashboardEventNote = React.memo(function DashboardEventNote({
  text,
  label,
  agentName,
}: {
  text: string;
  label: string;
  agentName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="dash-evt">
      <button
        type="button"
        className="dash-evt__summary"
        aria-expanded={expanded}
        title={expanded ? 'Collapse dashboard event' : 'Expand dashboard event'}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="dash-evt__chevron" aria-hidden>{expanded ? '▼' : '▶'}</span>
        <span className="dash-evt__badge">Dashboard event</span>
        {agentName && (
          <>
            <span className="dash-evt__agent">{agentName}</span>
            <span className="dash-evt__sep" aria-hidden>·</span>
          </>
        )}
        <span className="dash-evt__label">{label}</span>
      </button>
      {expanded && (
        <pre className="dash-evt__body select-text cursor-text">{text}</pre>
      )}
    </div>
  );
});

// Short, human-scannable slice of a session id for the divider caption.
function shortSessionId(sessionId: string): string {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

// Inspect the current DOM selection (still live when getContext runs, inside the
// contextmenu handler) and, if its start lands inside a prior-session block,
// return that block's identity from the `.oo-content` data-* attributes. Live
// selections return null. Keyed on the selection START so quoting from a prior
// bubble attributes to it even if the range drifts into adjacent content.
function readSelectionPriorSession(): { generation: number; sessionId: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.getRangeAt(0).startContainer;
  const start = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const oo = start?.closest('.oo-content[data-oo-session-id]');
  if (!oo) return null;
  const sessionId = oo.getAttribute('data-oo-session-id');
  if (!sessionId) return null;
  const gen = oo.getAttribute('data-oo-generation');
  return { sessionId, generation: gen ? Number(gen) : 0 };
}

// Session-labeled divider marking the boundary above a prior session's messages.
// Carries session identity (badge + gen + short id) + an explicit out-of-context
// note, using the shared `.oo-*` visual language (legible in both themes).
const SessionDivider = React.memo(function SessionDivider({
  generation,
  sessionId,
  unavailable,
}: {
  generation: number;
  sessionId: string;
  unavailable?: boolean;
}) {
  return (
    <div className="oo-divider" role="separator">
      <span className="oo-divider__label">
        <span aria-hidden>◤</span>
        <span className="oo-badge">Previous session</span>
        <span>
          gen {generation} · {shortSessionId(sessionId)} ·{' '}
          {unavailable ? 'unavailable — session log pruned' : 'not in current context'}
        </span>
      </span>
    </div>
  );
});

// Render one non-divider item to an element (no key — the caller keys + wraps).
// A prior-session bubble suppresses the live-only staged-send button.
function renderChatItem(
  item: Exclude<RenderItem, { kind: 'divider' }>,
  displayName: string,
  agentId: string,
  stagedCount: number,
  onSendStaged?: () => void,
): React.ReactNode {
  switch (item.kind) {
    case 'user':
      return <UserBubble text={item.text} />;
    case 'assistant':
      return (
        <AssistantBubble
          text={item.text}
          agentName={displayName}
          agentId={agentId}
          stagedCount={item.outOfContext ? 0 : stagedCount}
          onSendStaged={item.outOfContext ? undefined : onSendStaged}
        />
      );
    case 'thinking':
      return <ThinkingNote text={item.text} />;
    case 'tool':
      return (
        <ToolBlock
          toolUseId={item.toolUseId}
          toolName={item.toolName}
          input={item.input}
          result={item.result}
          agentId={agentId}
        />
      );
    case 'system':
      return <SystemNote text={item.text} />;
    case 'dashboard-event':
      return <DashboardEventNote text={item.text} label={item.label} agentName={item.agentName} />;
  }
}

function ChatItems({
  items,
  displayName,
  agentId,
  stagedCount = 0,
  onSendStaged,
}: {
  items: RenderItem[];
  displayName: string;
  agentId: string;
  stagedCount?: number;
  onSendStaged?: () => void;
}) {
  return (
    <>
      {items.map((item) => {
        if (item.kind === 'divider') {
          return (
            <SessionDivider
              key={item.uuid}
              generation={item.generation}
              sessionId={item.sessionId}
              unavailable={item.unavailable}
            />
          );
        }
        const el = renderChatItem(item, displayName, agentId, stagedCount, onSendStaged);
        // Prior-session content is muted/desaturated via the shared wrapper so
        // it never reads as live context; live items render bare. The session
        // identity rides on data-* so a selection inside this block can attribute
        // its Source: line to the originating prior session (Phase 3).
        return item.outOfContext ? (
          <div
            key={item.uuid}
            className="oo-content"
            data-oo-session-id={item.session?.sessionId}
            data-oo-generation={item.session?.generation}
          >
            {el}
          </div>
        ) : (
          <React.Fragment key={item.uuid}>{el}</React.Fragment>
        );
      })}
    </>
  );
}

export default function ChatPane({ agentId, agentStatus, agentName, stagingOpen = false, watchGlass = false }: Props) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [hydrated, setHydrated] = useState(false);
  // True when the agent is dead AND its history could not be recovered from
  // disk — a provider whose log reader has no one-shot session read, or a
  // pruned/missing session file. Distinct from "no messages yet": the chat
  // existed, we just can't show it. Never set for a live agent.
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const setScrollRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);
  const isNearBottomRef = useRef(true);
  const skipAnimateOnceRef = useRef(true);

  // ── Prior-session (out-of-context) chat ──────────────────────────────────
  // The live thread is `events`. Prior sessions are frozen, read-only, and
  // re-read from disk on demand (a rebind wiped the live ring). `lineage` is the
  // cheap DB ordering; the NEWEST row is the current live session, so its
  // predecessors are the prior sessions to walk back through, one at a time.
  const [lineage, setLineage] = useState<AgentSessionRow[]>([]);
  const [priorBlocks, setPriorBlocks] = useState<PriorSessionBlock[]>([]);
  const [loadedPriorCount, setLoadedPriorCount] = useState(0);
  const [loadingPrior, setLoadingPrior] = useState(false);
  // Refs mirror the load state so the scroll-to-top trigger reads fresh values
  // without re-subscribing the scroll handler on every load.
  const loadingPriorRef = useRef(false);
  const priorRowsRef = useRef<AgentSessionRow[]>([]);
  const loadedPriorCountRef = useRef(0);
  // Scroll-anchor delta captured before a prepend, restored after, so inserting
  // older messages above the viewport does not jump the reader's position.
  const pendingAnchorRef = useRef<number | null>(null);

  const displayName = agentName || 'Agent';
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);

  // Staged comments (in-memory, per chat pane): the user right-clicks a quote,
  // picks "Add comment", and it lands here instead of firing immediately. They
  // accumulate several, then send the whole batch as one message to this agent.
  const [stagedComments, setStagedComments] = useState<StagedComment[]>([]);
  const commentIdRef = useRef(0);

  // Select text → right-click → "Send to agent" / "Comment & send" (one-shot)
  // or "Add comment" (stages here). One handler on the scroll container covers
  // user bubbles, assistant markdown, thinking notes, and tool blocks.
  const { menuElement } = useSelectionActions({
    containerRef: scrollRef,
    getContext: () => ({
      targetType: 'chat-message',
      workspaceId: selectedWorkspaceId ?? '',
      sourceLabel: `agent chat with "${displayName}"`,
      chat: { agentId, agentName: displayName },
      // When the selection sits in a prior session, attribute it so the Source:
      // line reads "… — PREVIOUS SESSION (gen N, session <shortId>, …)".
      priorSession: readSelectionPriorSession() ?? undefined,
      // Enables "Add comment" (staged draft). Chat has no DB gutter, so the
      // handler below stages in-memory rather than persisting a row.
      capabilities: { comment: true },
    }),
    onSaveComment: (detail) => {
      setStagedComments((prev) => [
        ...prev,
        {
          id: `c${commentIdRef.current++}`,
          quote: detail.context.quotedText,
          comment: detail.body,
          prefix: detail.prefix,
          suffix: detail.suffix,
          priorSession: detail.context.priorSession,
        },
      ]);
      showSelectionToast('Comment staged');
    },
  });

  const sendStagedComments = useCallback(async () => {
    if (stagedComments.length === 0) return;
    const items = stagedComments.map((c) => ({ quote: c.quote, comment: c.comment }));
    // A batch shares one Source: line, so only attribute a prior session when
    // every staged quote came from the SAME one — a mixed batch stays neutral
    // rather than mislabel some quotes.
    const sessions = new Set(stagedComments.map((c) => c.priorSession?.sessionId ?? ''));
    const unanimousPrior =
      sessions.size === 1 ? stagedComments[0].priorSession : undefined;
    setStagedComments([]);
    await sendSelectionToAgent(
      { kind: 'existing', agentId },
      {
        targetType: 'chat-message',
        workspaceId: selectedWorkspaceId ?? '',
        sourceLabel: `agent chat with "${displayName}"`,
        priorSession: unanimousPrior,
      },
      items,
    );
  }, [stagedComments, agentId, selectedWorkspaceId, displayName]);

  // Hydrate + subscribe (live session only — prior sessions never subscribe)
  useEffect(() => {
    let mounted = true;
    setEvents([]);
    setHydrated(false);
    setHistoryUnavailable(false);
    setStagedComments([]);
    setPriorBlocks([]);
    setLoadedPriorCount(0);
    setLineage([]);
    loadingPriorRef.current = false;
    priorRowsRef.current = [];
    loadedPriorCountRef.current = 0;
    pendingAnchorRef.current = null;
    skipAnimateOnceRef.current = true;

    (async () => {
      await window.api.agents.chatSubscribe(agentId);
      const initial = await window.api.agents.getChatEvents(agentId);
      if (!mounted) return;
      setEvents(initial.events);
      setHistoryUnavailable(initial.source === 'unavailable');
      setHydrated(true);
      // Cheap DB lineage (no JSONL read) so we know whether prior sessions
      // exist and which row ids to lazily walk back to.
      try {
        const rows = await window.api.agents.getAgentSessions(agentId);
        if (!mounted) return;
        setLineage(rows);
        // Everything but the newest row (the live session) is a prior session,
        // ordered oldest→newest; we load them newest-first on demand.
        priorRowsRef.current = rows.slice(0, -1);
      } catch {
        // Lineage unavailable (e.g. pre-Phase-1 agent) — no prior-session UI.
      }
    })();

    const unsub = window.api.agents.onChatEvents((batch: ChatEventBatch) => {
      if (batch.agentId !== agentId) return;
      setEvents(prev => [...prev, ...batch.events]);
    });

    return () => {
      mounted = false;
      // Persist the scroll spot for this agent before we unmount, so returning
      // to this chat (workspace switch-back, pane toggle) restores it.
      const el = scrollRef.current;
      if (el) captureChatScroll(agentId, el);
      window.api.agents.chatUnsubscribe(agentId).catch(() => {});
      unsub();
    };
  }, [agentId]);

  const renderItems = useMemo(() => pairEvents(events), [events]);

  // Full render list: loaded prior sessions (oldest first, each under its own
  // session-labeled divider, stamped out-of-context) then the live thread.
  const combinedItems = useMemo(() => {
    if (priorBlocks.length === 0) return renderItems;
    const out: RenderItem[] = [];
    for (const block of priorBlocks) {
      out.push({
        kind: 'divider',
        uuid: `oo-divider:${block.meta.sessionId}`,
        sessionRowId: block.meta.sessionRowId,
        sessionId: block.meta.sessionId,
        generation: block.meta.generation,
        unavailable: block.unavailable,
      });
      for (const it of block.items) {
        // Namespace prior uuids by session so React keys never collide with the
        // live thread; stamp out-of-context + session identity for styling.
        out.push({ ...it, uuid: `${block.meta.sessionId}:${it.uuid}`, outOfContext: true, session: block.meta });
      }
    }
    for (const it of renderItems) out.push(it);
    return out;
  }, [priorBlocks, renderItems]);

  const canLoadMorePrior = hydrated && lineage.length - 1 - loadedPriorCount > 0;

  // Lazy-load the next-older prior session and prepend it. Walks back by lineage
  // row id (newest prior first). Preserves the scroll anchor across the prepend.
  const loadPreviousSession = useCallback(async () => {
    if (loadingPriorRef.current) return;
    const priorRows = priorRowsRef.current;
    const nextIdx = priorRows.length - 1 - loadedPriorCountRef.current;
    if (nextIdx < 0) return;
    const row = priorRows[nextIdx];

    loadingPriorRef.current = true;
    setLoadingPrior(true);
    // Capture (contentHeight - scrollTop): the distance from the current
    // scrollTop to the bottom stays constant, so restoring it after the taller
    // list mounts keeps the same content pinned under the viewport.
    const el = scrollRef.current;
    pendingAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;

    try {
      const res = await window.api.agents.getPriorSessionChat(agentId, row.id);
      let block: PriorSessionBlock | null = null;
      if ('atHead' in res) {
        block = null; // no earlier session (shouldn't happen for a known row)
      } else if ('unavailable' in res) {
        block = {
          meta: { sessionRowId: row.id, sessionId: res.sessionId, generation: row.generation },
          items: [],
          unavailable: true,
        };
      } else {
        block = {
          meta: { sessionRowId: res.sessionRowId, sessionId: res.sessionId, generation: res.generation },
          items: pairEvents(res.events),
        };
      }
      if (block) setPriorBlocks((prev) => [block as PriorSessionBlock, ...prev]);
      loadedPriorCountRef.current += 1;
      setLoadedPriorCount(loadedPriorCountRef.current);
    } catch {
      pendingAnchorRef.current = null; // nothing prepended — drop the anchor
    } finally {
      loadingPriorRef.current = false;
      setLoadingPrior(false);
    }
  }, [agentId]);

  // Restore the scroll anchor synchronously after a prepend (before paint) so
  // older messages inserted above the viewport don't visually jump the reader.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pendingAnchorRef.current != null) {
      el.scrollTop = el.scrollHeight - pendingAnchorRef.current;
      pendingAnchorRef.current = null;
    }
  }, [priorBlocks]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 80;
    // Keep the per-agent scroll memory fresh on every scroll (user drag or
    // programmatic autoscroll both fire this) so restore-on-return is accurate
    // even if the unmount cleanup misses.
    chatScrollMemory.set(agentId, { distanceFromBottom, nearBottom: distanceFromBottom < 80 });
    // Scroll-to-top auto-loads the next-older prior session (guarded by refs so
    // this never re-enters mid-load).
    if (el.scrollTop <= 4 && !loadingPriorRef.current) {
      const remaining = priorRowsRef.current.length - loadedPriorCountRef.current;
      if (remaining > 0) void loadPreviousSession();
    }
  }, [loadPreviousSession, agentId]);

  // Autoscroll on new content when near bottom. On the first paint after mount
  // we restore the remembered scroll spot for this agent instead of forcing the
  // bottom — but only once there is real content to anchor against (messages
  // hydrate async, so an empty first paint has ~zero height and nothing to
  // restore to). skipAnimateOnceRef stays set until that content arrives.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (skipAnimateOnceRef.current) {
      if (renderItems.length === 0) {
        // Nothing to anchor to yet — sit at the bottom and wait for hydration,
        // keeping the skip flag set so the real restore happens next paint.
        el.scrollTop = el.scrollHeight;
        return;
      }
      const saved = chatScrollMemory.get(agentId);
      if (saved && !saved.nearBottom) {
        // Restore the exact spot: same gap from the bottom as when we left.
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - saved.distanceFromBottom);
        // We're intentionally scrolled up now, so incoming content must not yank
        // the viewport back to the bottom until the user returns there.
        isNearBottomRef.current = false;
      } else {
        // Fresh chat, or the user was pinned to the bottom — stay pinned.
        el.scrollTop = el.scrollHeight;
      }
      skipAnimateOnceRef.current = false;
      return;
    }
    if (isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [renderItems, agentId]);

  // Paint staged-comment decorations: a subtle highlight over each staged quote
  // (via the CSS Custom Highlight API — no DOM mutation, so it survives React
  // re-renders) plus a small blue dot pinned to the end of the highlighted
  // span. Recomputed whenever the transcript or the staged set changes, or the
  // pane resizes (rewrap moves the anchor). The dots live in content-space
  // coordinates so they scroll with the text.
  const [stagedDots, setStagedDots] = useState<{ id: string; top: number; left: number }[]>([]);
  useEffect(() => {
    const el = scrollEl;
    const HL_NAME = 'chat-staged-comment';
    const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    const supportsHighlight = !!highlights && !!HighlightCtor;

    if (!el || stagedComments.length === 0) {
      if (supportsHighlight) highlights!.delete(HL_NAME);
      setStagedDots([]);
      return;
    }

    const repaint = () => {
      const ranges: Range[] = [];
      const dots: { id: string; top: number; left: number }[] = [];
      const base = el.getBoundingClientRect();
      for (const c of stagedComments) {
        const match = findQuoteInDom(el, c.quote, c.prefix, c.suffix);
        if (!match) continue;
        ranges.push(match.range);
        const rects = match.range.getClientRects();
        const last = rects[rects.length - 1];
        if (last) {
          dots.push({
            id: c.id,
            top: last.top - base.top + el.scrollTop + last.height / 2,
            left: last.right - base.left + el.scrollLeft,
          });
        }
      }
      if (supportsHighlight) {
        if (ranges.length) highlights!.set(HL_NAME, new HighlightCtor!(...ranges));
        else highlights!.delete(HL_NAME);
      }
      setStagedDots(dots);
    };

    repaint();
    const ro = new ResizeObserver(repaint);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (supportsHighlight) highlights!.delete(HL_NAME);
    };
    // combinedItems (not just live) so a prior-session prepend repositions dots.
  }, [stagedComments, combinedItems, scrollEl]);

  // Show the "no messages" placeholder only when there's nothing to render AND
  // nothing older to load; otherwise fall through so the load affordance shows.
  const empty = hydrated && combinedItems.length === 0 && !canLoadMorePrior;

  return (
    <div className={`flex-1 flex flex-col overflow-hidden ${isLight ? 'bg-[#f6f8fa]' : 'bg-[#0d1117]'}`}>
      <div className="flex-1 relative overflow-hidden">
        <div
          ref={setScrollRef}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-y-auto overflow-x-hidden px-3 pt-2 pb-3"
        >
          {empty ? (
            <div className={`h-full flex items-center justify-center px-6 ${isLight ? 'text-[#8b949e]' : 'text-gray-500'}`}>
              {historyUnavailable ? (
                // Dead agent whose transcript can't be read back. Say so
                // explicitly — a silent "No messages yet" would read as "this
                // agent never said anything," which is a lie.
                <div className="text-center">
                  <div className="text-[13px] mb-1">Chat history not available</div>
                  <div className="text-[11px]">
                    This agent has stopped, and its transcript can&rsquo;t be read back
                    from disk for this provider.
                  </div>
                </div>
              ) : (
                <div className="text-center">
                  <div className="text-[13px] mb-1">No messages yet</div>
                  <div className="text-[11px]">Send a message below to start the conversation.</div>
                </div>
              )}
            </div>
          ) : (
            <>
              {canLoadMorePrior && (
                <button
                  type="button"
                  className="oo-load-btn"
                  onClick={() => void loadPreviousSession()}
                  disabled={loadingPrior}
                  title="Load the previous session's chat (read-only, out of current context)"
                >
                  {loadingPrior ? 'Loading previous session…' : '▲ Load previous session'}
                </button>
              )}
              <ChatItems
                items={combinedItems}
                displayName={displayName}
                agentId={agentId}
                stagedCount={stagedComments.length}
                onSendStaged={sendStagedComments}
              />
            </>
          )}
          {stagedDots.map((d) => (
            <span
              key={d.id}
              aria-hidden
              title="Staged comment"
              className="pointer-events-none absolute z-10 w-2 h-2 rounded-full bg-[#1f6feb] ring-2 ring-[#1f6feb]/25"
              style={{ top: d.top, left: d.left + 3, transform: 'translateY(-50%)' }}
            />
          ))}
        </div>
        {watchGlass && !empty && (
          <WatchGlass chatScrollEl={scrollEl} isLight={isLight}>
            <ChatItems items={renderItems} displayName={displayName} agentId={agentId} />
          </WatchGlass>
        )}
      </div>
      {menuElement}
      <ContextUsageBar agentId={agentId} events={events} />
      {stagingOpen ? (
        <PromptStaging agentId={agentId} agentStatus={agentStatus} />
      ) : (
        <ChatInputBar agentId={agentId} agentStatus={agentStatus} />
      )}
    </div>
  );
}
