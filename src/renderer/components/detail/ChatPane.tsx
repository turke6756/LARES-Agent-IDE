import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type {
  SessionEvent,
  ChatEventBatch,
  ToolUseEvent,
  ToolResultEvent,
} from '../../../shared/session-events';
import type { AgentStatus } from '../../../shared/types';
import { useThemeStore } from '../../stores/theme-store';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useSelectionActions } from '../../lib/selection/useSelectionActions';
import AgentMarkdown from '../shared/AgentMarkdown';
import ChatInputBar from './ChatInputBar';
import PromptStaging from './PromptStaging';
import ToolBlock from './chat/blocks/ToolBlock';
import ContextUsageBar from './chat/ContextUsageBar';
import WatchGlass from './WatchGlass';

interface Props {
  agentId: string;
  agentStatus: AgentStatus;
  agentName?: string;
  stagingOpen?: boolean;
  watchGlass?: boolean;
}

type RenderItem =
  | { kind: 'user'; uuid: string; text: string }
  | { kind: 'assistant'; uuid: string; text: string }
  | { kind: 'thinking'; uuid: string; text: string }
  | {
      kind: 'tool';
      uuid: string;
      toolUseId: string;
      toolName: string;
      input: unknown;
      result?: { content: string; truncated: boolean; isError?: boolean };
    }
  | { kind: 'system'; uuid: string; text: string };

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

/**
 * Pair tool-use ↔ tool-result by `toolUseId`, then flatten into a render list.
 * Usage events are consumed by ContextUsageBar and dropped from the list.
 */
function pairEvents(events: SessionEvent[]): RenderItem[] {
  // Map tool_use_id -> result
  const resultById = new Map<string, ToolResultEvent>();
  for (const e of events) {
    if (e.type === 'tool-result' && e.toolUseId) {
      resultById.set(e.toolUseId, e);
    }
  }

  const consumedResults = new Set<string>();
  const items: RenderItem[] = [];

  for (const e of events) {
    switch (e.type) {
      case 'user-text':
        items.push({ kind: 'user', uuid: e.uuid, text: e.text });
        break;
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

const AssistantBubble = React.memo(function AssistantBubble({
  text,
  agentName,
  agentId,
}: {
  text: string;
  agentName: string;
  agentId: string;
}) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  return (
    <div className="flex flex-col items-start my-3 w-full">
      <SenderLabel name={agentName} color={isLight ? '#6639ba' : '#c586c0'} align="left" />
      <div
        className={`max-w-full px-3 py-2 rounded-2xl rounded-tl-sm select-text cursor-text ${
          isLight
            ? 'bg-white border border-[#d0d7de] shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
            : 'bg-[#1a1d23] border border-gray-800/60'
        }`}
        style={{ width: '100%' }}
      >
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

function ChatItems({
  items,
  displayName,
  agentId,
}: {
  items: RenderItem[];
  displayName: string;
  agentId: string;
}) {
  return (
    <>
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return <UserBubble key={item.uuid} text={item.text} />;
          case 'assistant':
            return <AssistantBubble key={item.uuid} text={item.text} agentName={displayName} agentId={agentId} />;
          case 'thinking':
            return <ThinkingNote key={item.uuid} text={item.text} />;
          case 'tool':
            return (
              <ToolBlock
                key={item.uuid}
                toolUseId={item.toolUseId}
                toolName={item.toolName}
                input={item.input}
                result={item.result}
                agentId={agentId}
              />
            );
          case 'system':
            return <SystemNote key={item.uuid} text={item.text} />;
        }
      })}
    </>
  );
}

export default function ChatPane({ agentId, agentStatus, agentName, stagingOpen = false, watchGlass = false }: Props) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const setScrollRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);
  const isNearBottomRef = useRef(true);
  const skipAnimateOnceRef = useRef(true);

  const displayName = agentName || 'Agent';
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);

  // Select text → right-click → "Send to agent". One handler on the scroll
  // container covers user bubbles, assistant markdown, thinking notes, and
  // tool blocks. Right-click without a selection (and all left-click /
  // drag-to-input behavior) falls through untouched.
  const { menuElement } = useSelectionActions({
    containerRef: scrollRef,
    getContext: () => ({
      targetType: 'chat-message',
      workspaceId: selectedWorkspaceId ?? '',
      sourceLabel: `agent chat with "${displayName}"`,
      chat: { agentId, agentName: displayName },
      capabilities: { comment: false },
    }),
  });

  // Hydrate + subscribe
  useEffect(() => {
    let mounted = true;
    setEvents([]);
    setHydrated(false);
    skipAnimateOnceRef.current = true;

    (async () => {
      await window.api.agents.chatSubscribe(agentId);
      const initial = await window.api.agents.getChatEvents(agentId);
      if (!mounted) return;
      setEvents(initial.events);
      setHydrated(true);
    })();

    const unsub = window.api.agents.onChatEvents((batch: ChatEventBatch) => {
      if (batch.agentId !== agentId) return;
      setEvents(prev => [...prev, ...batch.events]);
    });

    return () => {
      mounted = false;
      window.api.agents.chatUnsubscribe(agentId).catch(() => {});
      unsub();
    };
  }, [agentId]);

  const renderItems = useMemo(() => pairEvents(events), [events]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 80;
  }, []);

  // Autoscroll on new content when near bottom. Skip first paint (hydration) animation.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (skipAnimateOnceRef.current) {
      el.scrollTop = el.scrollHeight;
      skipAnimateOnceRef.current = false;
      return;
    }
    if (isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [renderItems]);

  const empty = hydrated && renderItems.length === 0;

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
              <div className="text-center">
                <div className="text-[13px] mb-1">No messages yet</div>
                <div className="text-[11px]">Send a message below to start the conversation.</div>
              </div>
            </div>
          ) : (
            <ChatItems items={renderItems} displayName={displayName} agentId={agentId} />
          )}
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
